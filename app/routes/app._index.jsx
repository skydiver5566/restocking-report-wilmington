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
import {
  useActionData,
  useNavigation,
  useLoaderData,
  Form,
} from "react-router-dom";
import { authenticate } from "../shopify.server";

/* -------------------------------------------------------------------------- */
/*                             Helper: TZ Mapping                             */
/* -------------------------------------------------------------------------- */

const RAILS_TZ_TO_IANA = {
  "Eastern Time (US & Canada)": "America/New_York",
  "Central Time (US & Canada)": "America/Chicago",
  "Mountain Time (US & Canada)": "America/Denver",
  "Pacific Time (US & Canada)": "America/Los_Angeles",
};

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

  if ([year, month, day, hour, minute].some((n) => Number.isNaN(n))) {
    return null;
  }

  const naiveUtc = new Date(Date.UTC(year, month - 1, day, hour, minute));

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
    if (p.type !== "literal") map[p.type] = p.value;
  }

  const localAsIfUtcMs = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );

  const offsetMs = localAsIfUtcMs - naiveUtc.getTime();
  return new Date(naiveUtc.getTime() - offsetMs);
}

/* -------------------------------------------------------------------------- */
/*                                   LOADER                                   */
/* -------------------------------------------------------------------------- */

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);

  const SHOP_NAME_QUERY = `
    query {
      shop { name }
    }
  `;

  let shopName = session.shop;
  try {
    const resp = await admin.graphql(SHOP_NAME_QUERY);
    const json = await resp.json();
    if (json?.data?.shop?.name) {
      shopName = json.data.shop.name;
    }
  } catch (err) {
    console.error("Error fetching store name:", err);
  }

  return { shopName };
}

/* -------------------------------------------------------------------------- */
/*                                   ACTION                                   */
/* -------------------------------------------------------------------------- */

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const startDateStr = formData.get("startDate");
  const endDateStr = formData.get("endDate");

  // ✅ FIX: Shop.timezone doesn't exist (in your API version); use ianaTimezone
  const SHOP_TZ_QUERY = `
    query {
      shop { ianaTimezone }
    }
  `;

  // Keep your original defaults (so the report still works even if TZ lookup fails)
  let storeRailsTz = "Eastern Time (US & Canada)";
  let storeIanaTz = "America/New_York";

  try {
    const tzResp = await admin.graphql(SHOP_TZ_QUERY);
    const tzJson = await tzResp.json();
    const iana = tzJson?.data?.shop?.ianaTimezone;

    if (iana && typeof iana === "string") {
      storeIanaTz = iana;
      // Keep this label field for your UI display (you used "shopTimezone")
      storeRailsTz = iana;
    }
  } catch (err) {
    console.error("Timezone fetch error:", err);
  }

  const startUTC = zonedDateTimeToUtc(startDateStr, storeIanaTz);
  const endUTC = zonedDateTimeToUtc(endDateStr, storeIanaTz);
  endUTC.setSeconds(59, 999);

  const ORDERS_QUERY = `
    query RestockingReportOrders($cursor: String) {
      orders(first: 50, after: $cursor, sortKey: CREATED_AT, reverse: true) {
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

  let allOrders = [];
  let cursor = null;
  let hasNextPage = true;
  let pageCount = 0;

  while (hasNextPage) {
    const resp = await admin.graphql(ORDERS_QUERY, { variables: { cursor } });
    const json = await resp.json();
    if (json.errors) break;

    const orders = json?.data?.orders;
    if (!orders) break;

    allOrders.push(...orders.edges);

    cursor = orders.pageInfo.endCursor;
    hasNextPage = orders.pageInfo.hasNextPage;

    pageCount++;
    if (pageCount > 20) break;
  }

  const rawRows = [];
  const locationNames = new Set();

  for (const order of allOrders) {
    for (const li of order.node.lineItems.edges) {
      const n = li.node;
      const p = n.product;
      const v = n.variant;

      // 🚫 Skip Gift Cards, Donations, and no-SKU items
      if (
        !v?.sku ||
        p?.productType === "Gift Cards" ||
        p?.productType === "Donations"
      ) {
        continue;
      }

      const locData = {};
      const levels = v?.inventoryItem?.inventoryLevels?.edges || [];

      for (const lvl of levels) {
        const locName = lvl.node.location?.name || "Unknown";
        const available = lvl.node.quantities?.find(
          (q) => q.name === "available"
        );

        locationNames.add(locName);

        // ✅ Always numeric, never "-"
        locData[locName] = Number.isFinite(available?.quantity)
          ? available.quantity
          : 0;
      }

      rawRows.push({
        productTitle: p?.title || "N/A",
        productVariantTitle: v?.title || "N/A",
        sku: v?.sku || "N/A",
        vendor: p?.vendor || "N/A",
        productType: p?.productType || "N/A",
        netItemsSold: n.quantity,
        locations: locData,
      });
    }
  }

  const grouped = {};
  for (const r of rawRows) {
    const key = `${r.productTitle}||${r.productVariantTitle}||${r.sku}`;
    if (!grouped[key]) {
      grouped[key] = {
        ...r,
        netItemsSold: 0,
        locations: {},
      };
    }

    grouped[key].netItemsSold += r.netItemsSold;
    Object.assign(grouped[key].locations, r.locations);
  }

  return {
    rows: Object.values(grouped),
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
/*                                 COMPONENT                                  */
/* -------------------------------------------------------------------------- */

export default function RestockingReport() {
  const { shopName } = useLoaderData();
  const data = useActionData();
  const navigation = useNavigation();

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const loading = navigation.state === "submitting";

  return (
    <Page title={`Restocking Report (${shopName})`}>
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
            <BlockStack gap="300">
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
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Variant</th>
                      <th>SKU</th>
                      <th>Vendor</th>
                      <th>Type</th>
                      <th>Net Sold</th>
                      {data.locationNames.map((l) => (
                        <th key={l}>{l}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.productTitle}</td>
                        <td>{r.productVariantTitle}</td>
                        <td>{r.sku}</td>
                        <td>{r.vendor}</td>
                        <td>{r.productType}</td>
                        <td>{r.netItemsSold}</td>
                        {data.locationNames.map((l) => (
                          <td key={l}>{r.locations[l] ?? 0}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
