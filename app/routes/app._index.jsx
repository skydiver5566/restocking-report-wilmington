// app/routes/app._index.jsx
import {
  Page,
  Card,
  Layout,
  BlockStack,
  Text,
  Button,
  TextField,
  Spinner,
} from "@shopify/polaris";
import { useState } from "react";
import { useActionData, useNavigation, Form } from "react-router-dom";
import { authenticate } from "../shopify.server";

/* -------------------------------------------------------------------------- */
/*                             Helper: TZ Mapping                             */
/* -------------------------------------------------------------------------- */

// Map Shopify Rails timezones -> IANA (US only, per your choice)
const RAILS_TZ_TO_IANA = {
  "Eastern Time (US & Canada)": "America/New_York",
  "Central Time (US & Canada)": "America/Chicago",
  "Mountain Time (US & Canada)": "America/Denver",
  "Pacific Time (US & Canada)": "America/Los_Angeles",
};

/**
 * Parse a datetime-local string (e.g. "2025-11-16T18:50")
 * and convert it from local time in `timeZone` to a UTC Date.
 *
 * This avoids relying on server local timezone and is DST-safe.
 */
function zonedDateTimeToUtc(datetimeStr, timeZone) {
  if (!datetimeStr) return null;

  const [datePart, timePart] = datetimeStr.split("T");
  if (!datePart || !timePart) return null;

  const [yearStr, monthStr, dayStr] = datePart.split("-");
  const [hourStr, minuteStr = "0"] = timePart.split(":");

  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);

  if (
    [year, month, day, hour, minute].some(
      (n) => Number.isNaN(n) || !Number.isFinite(n)
    )
  ) {
    return null;
  }

  // 1) Create a "naive" UTC date from the local wall time components
  const naiveUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

  // 2) Use Intl.DateTimeFormat to see what local time that naive UTC instant
  //    corresponds to in the target time zone
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = dtf.formatToParts(naiveUtc);
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      map[p.type] = p.value;
    }
  }

  // Local time (in the given zone) that corresponds to `naiveUtc`
  const localAsIfUtcMs = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );

  // Offset between that zone's local time and naiveUtc
  const offsetMs = localAsIfUtcMs - naiveUtc.getTime();

  // Actual UTC instant for the user-entered wall clock
  const actualUtcMs = naiveUtc.getTime() - offsetMs;
  return new Date(actualUtcMs);
}

/* -------------------------------------------------------------------------- */
/*                               SERVER ACTION                                */
/* -------------------------------------------------------------------------- */
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const startDateStr = formData.get("startDate"); // datetime-local string
  const endDateStr = formData.get("endDate");

  /* ------------------------------------------------------------------------ */
  /*                      1) Fetch Store Timezone from Shopify                */
  /* ------------------------------------------------------------------------ */
  const SHOP_TZ_QUERY = `
    query ShopTimezone {
      shop {
        timezone
      }
    }
  `;

  let storeRailsTz = "Eastern Time (US & Canada)";
  let storeIanaTz = "America/New_York";

  try {
    const shopResp = await admin.graphql(SHOP_TZ_QUERY);
    const shopJson = await shopResp.json();
    const tz = shopJson?.data?.shop?.timezone;
    if (tz && typeof tz === "string") {
      storeRailsTz = tz;
      storeIanaTz = RAILS_TZ_TO_IANA[tz] || "UTC";
    }
  } catch (err) {
    console.error("Error fetching shop timezone:", err);
  }

  /* ------------------------------------------------------------------------ */
  /*              2) Convert user-entered local times -> UTC Dates            */
  /* ------------------------------------------------------------------------ */
  const startUTC = zonedDateTimeToUtc(startDateStr, storeIanaTz);
  const endUTC = zonedDateTimeToUtc(endDateStr, storeIanaTz);

  if (!startUTC || !endUTC) {
    return {
      rows: [],
      locationNames: [],
      timestamp: new Date().toLocaleString("en-US", {
        timeZone: storeIanaTz,
      }),
      startDate: startDateStr,
      endDate: endDateStr,
      error: "Invalid date input",
      shopTimezone: storeRailsTz,
    };
  }

  // Make end inclusive for that minute
  endUTC.setSeconds(59, 999);

  /* ------------------------------------------------------------------------ */
  /*                          3) GraphQL Orders Query                         */
  /* ------------------------------------------------------------------------ */
  const ORDERS_QUERY = `
    query RestockingReportOrders($cursor: String) {
      orders(
        first: 50
        after: $cursor
        sortKey: CREATED_AT
        reverse: true
      ) {
        edges {
          cursor
          node {
            createdAt
            lineItems(first: 50) {
              edges {
                node {
                  quantity
                  product { title vendor productType }
                  variant {
                    title
                    sku
                    inventoryItem {
                      inventoryLevels(first: 5) {
                        edges {
                          node {
                            quantities(names: "available") {
                              name
                              quantity
                            }
                            location { name }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  /* ------------------------------------------------------------------------ */
  /*                 4) Pagination + Rate-Limit Safe Loop                     */
  /* ------------------------------------------------------------------------ */
  let allOrders = [];
  let cursor = null;
  let hasNextPage = true;
  let pageCount = 0;

  while (hasNextPage) {
    const response = await admin.graphql(ORDERS_QUERY, { variables: { cursor } });
    const data = await response.json();

    if (data.errors) {
      console.error("GraphQL errors:", data.errors);
      break;
    }

    const connection = data?.data?.orders;
    if (!connection) break;

    const edges = connection.edges || [];

    // Filter orders by createdAt in UTC
    for (const edge of edges) {
      const createdUTC = new Date(edge.node.createdAt); // Shopify returns UTC
      if (createdUTC >= startUTC && createdUTC <= endUTC) {
        allOrders.push(edge);
      }
    }

    // Cost-aware throttling (avoid GraphQL "Throttled" errors)
    const cost = data.extensions?.cost;
    if (cost) {
      const remaining = cost.throttleStatus.currentlyAvailable;
      const requested = cost.requestedQueryCost;
      const restoreRate = cost.throttleStatus.restoreRate;

      if (remaining < requested) {
        const wait = restoreRate * 1000;
        console.log(`Throttled → waiting ${wait} ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    cursor = connection.pageInfo.endCursor;
    hasNextPage = connection.pageInfo.hasNextPage;

    // Safety caps for live stores
    pageCount++;
    if (pageCount > 20) break;        // max 20 pages (~1000 orders)
    if (allOrders.length > 500) break; // enough for any small time window
  }

  /* ------------------------------------------------------------------------ */
  /*                         5) Build Raw Rows from Orders                    */
  /* ------------------------------------------------------------------------ */
  const rawRows = [];
  const locationNames = new Set();

  for (const order of allOrders) {
    for (const li of order.node.lineItems.edges) {
      const n = li.node;
      const p = n.product;
      const v = n.variant;
      const qty = n.quantity;

      const levels = v?.inventoryItem?.inventoryLevels?.edges || [];
      const locData = {};

      for (const lvl of levels) {
        const locName = lvl.node.location?.name || "Unknown";
        const available = lvl.node.quantities?.find(
          (q) => q.name === "available"
        );
        locationNames.add(locName);
        locData[locName] = available ? available.quantity : "-";
      }

      rawRows.push({
        productTitle: p?.title || "N/A",
        productVariantTitle: v?.title || "N/A",
        sku: v?.sku || "N/A",
        vendor: p?.vendor || "N/A",
        productType: p?.productType || "N/A",
        netItemsSold: qty,
        locations: locData,
      });
    }
  }

  /* ------------------------------------------------------------------------ */
  /*                  6) Group By Product + Variant + SKU                     */
  /* ------------------------------------------------------------------------ */
  const grouped = {};

  for (const r of rawRows) {
    const key = `${r.productTitle}||${r.productVariantTitle}||${r.sku}`;

    if (!grouped[key]) {
      grouped[key] = {
        productTitle: r.productTitle,
        productVariantTitle: r.productVariantTitle,
        sku: r.sku,
        vendor: r.vendor,
        productType: r.productType,
        netItemsSold: 0,
        locations: {},
      };
    }

    grouped[key].netItemsSold += r.netItemsSold;

    for (const loc of Object.keys(r.locations)) {
      grouped[key].locations[loc] = r.locations[loc];
    }
  }

  const finalRows = Object.values(grouped).sort((a, b) =>
    a.sku.localeCompare(b.sku)
  );

  /* ------------------------------------------------------------------------ */
  /*                                7) Return                                 */
  /* ------------------------------------------------------------------------ */
  return {
    rows: finalRows,
    locationNames: Array.from(locationNames),
    timestamp: new Date().toLocaleString("en-US", {
      timeZone: storeIanaTz,
    }),
    startDate: startDateStr,
    endDate: endDateStr,
    shopTimezone: storeRailsTz,
  };
};

/* -------------------------------------------------------------------------- */
/*                           CLIENT-SIDE COMPONENT                            */
/* -------------------------------------------------------------------------- */
export default function RestockingReport() {
  const data = useActionData();
  const navigation = useNavigation();
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const loading = navigation.state === "submitting";

  return (
    <Page title="Restocking Report Wilmington">
      <style>
        {`
          table {
            border-collapse: collapse;
            width: 100%;
          }
          th, td {
            border: 1px solid #000;
            padding: 6px;
            text-align: left;
            vertical-align: top;
            word-break: break-word;
          }
          th {
            background: #f2f2f2;
            font-weight: bold;
          }
        `}
      </style>

      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingLg">Restocking Report</Text>

              <Form method="post">
                <BlockStack gap="200">
                  <TextField
                    label="Start Date"
                    type="datetime-local"
                    name="startDate"
                    value={startDate}
                    onChange={setStartDate}
                    required
                  />
                  <TextField
                    label="End Date"
                    type="datetime-local"
                    name="endDate"
                    value={endDate}
                    onChange={setEndDate}
                    required
                  />
                  <Button submit primary>
                    Run Report
                  </Button>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        {loading && (
          <Layout.Section>
            <Card>
              <Spinner accessibilityLabel="Loading" size="large" />
              <Text>Fetching data…</Text>
            </Card>
          </Layout.Section>
        )}

        {data && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd">
                  Results ({data.startDate} → {data.endDate})
                </Text>
                <Text>
                  Generated at: {data.timestamp}
                  {data.shopTimezone
                    ? ` (Store timezone: ${data.shopTimezone})`
                    : ""}
                </Text>

                <div style={{ marginTop: "1rem" }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Product Title</th>
                        <th>Variant Title</th>
                        <th>SKU</th>
                        <th>Vendor</th>
                        <th>Product Type</th>
                        <th>Net Items Sold</th>
                        {data.locationNames.map((loc) => (
                          <th key={loc}>{loc}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((r, idx) => (
                        <tr key={idx}>
                          <td>{r.productTitle}</td>
                          <td>{r.productVariantTitle}</td>
                          <td>{r.sku}</td>
                          <td>{r.vendor}</td>
                          <td>{r.productType}</td>
                          <td>{r.netItemsSold}</td>
                          {data.locationNames.map((loc) => (
                            <td key={loc}>{r.locations[loc] ?? "-"}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
