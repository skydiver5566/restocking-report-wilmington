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
/*                       Helper: Convert Local → UTC                           */
/* -------------------------------------------------------------------------- */

function zonedDateTimeToUtc(datetimeStr, timeZone) {
  if (!datetimeStr) return null;

  const [datePart, timePart] = datetimeStr.split("T");
  if (!datePart || !timePart) return null;

  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute = "0"] = timePart.split(":").map(Number);

  if ([year, month, day, hour, minute].some(Number.isNaN)) return null;

  const naiveUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

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
/*                               LOADER (Store Name)                           */
/* -------------------------------------------------------------------------- */

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);

  const SHOP_NAME_QUERY = `
    query StoreName {
      shop {
        name
      }
    }
  `;

  let shopName = session.shop;

  try {
    const resp = await admin.graphql(SHOP_NAME_QUERY);
    const json = await resp.json();

    if (json?.errors) {
      console.error("Store name GraphQL errors:", JSON.stringify(json.errors, null, 2));
    }

    if (json?.data?.shop?.name) {
      shopName = json.data.shop.name;
    }
  } catch (err) {
    console.error("Error fetching store name:", err);
  }

  return { shopName };
}

/* -------------------------------------------------------------------------- */
/*                               SERVER ACTION                                 */
/* -------------------------------------------------------------------------- */

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const startDateStr = formData.get("startDate");
  const endDateStr = formData.get("endDate");

  /* ------------------------- Get store timezone (FIXED) -------------------- */

  const SHOP_TZ_QUERY = `
    query ShopTimezone {
      shop {
        ianaTimezone
        timezoneAbbreviation
      }
    }
  `;

  let storeIanaTz = "America/New_York";

  try {
    const shopResp = await admin.graphql(SHOP_TZ_QUERY);
    const shopJson = await shopResp.json();

    if (shopJson?.errors) {
      console.error("Shop timezone GraphQL errors:", JSON.stringify(shopJson.errors, null, 2));
    }

    const iana = shopJson?.data?.shop?.ianaTimezone;
    if (iana && typeof iana === "string") {
      storeIanaTz = iana;
    }
  } catch (err) {
    console.error("Error fetching shop timezone:", err);
  }

  /* ------------------------- Convert dates to UTC -------------------------- */

  const startUTC = zonedDateTimeToUtc(startDateStr, storeIanaTz);
  const endUTC = zonedDateTimeToUtc(endDateStr, storeIanaTz);

  if (!startUTC || !endUTC) {
    return {
      rows: [],
      locationNames: [],
      timestamp: new Date().toLocaleString("en-US", { timeZone: storeIanaTz }),
      startDate: startDateStr,
      endDate: endDateStr,
      error: "Invalid date input",
      shopTimezone: storeIanaTz,
    };
  }

  endUTC.setSeconds(59, 999);

  /* ----------------------------- Orders Query ------------------------------ */

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
    const response = await admin.graphql(ORDERS_QUERY, { variables: { cursor } });
    const data = await response.json();

    if (data?.errors) {
      console.error("Orders GraphQL errors:", JSON.stringify(data.errors, null, 2));
      break;
    }

    const connection = data?.data?.orders;
    if (!connection) break;

    for (const edge of connection.edges || []) {
      const createdUTC = new Date(edge.node.createdAt);
      if (createdUTC >= startUTC && createdUTC <= endUTC) {
        allOrders.push(edge);
      }
    }

    const cost = data.extensions?.cost;
    if (cost && cost.throttleStatus.currentlyAvailable < cost.requestedQueryCost) {
      await new Promise((r) => setTimeout(r, cost.throttleStatus.restoreRate * 1000));
    }

    cursor = connection.pageInfo.endCursor;
    hasNextPage = connection.pageInfo.hasNextPage;

    if (++pageCount > 20 || allOrders.length > 500) break;
  }

  /* ------------------------- Transform + Group Data ------------------------ */

  const rawRows = [];
  const locationNames = new Set();

  for (const order of allOrders) {
    for (const li of order.node.lineItems.edges) {
      const n = li.node;
      const p = n.product;
      const v = n.variant;

      const locData = {};
      for (const lvl of v?.inventoryItem?.inventoryLevels?.edges || []) {
        const loc = lvl.node.location?.name || "Unknown";
        const available = lvl.node.quantities?.find((q) => q.name === "available");
        locationNames.add(loc);
        locData[loc] = available ? available.quantity : "-";
      }

      rawRows.push({
        productTitle: p?.title ?? "N/A",
        productVariantTitle: v?.title ?? "N/A",
        sku: v?.sku ?? "N/A",
        vendor: p?.vendor ?? "N/A",
        productType: p?.productType ?? "N/A",
        netItemsSold: n.quantity,
        locations: locData,
      });
    }
  }

  const grouped = {};
  for (const r of rawRows) {
    const key = `${r.productTitle}||${r.productVariantTitle}||${r.sku}`;
    grouped[key] ??= { ...r, netItemsSold: 0, locations: {} };
    grouped[key].netItemsSold += r.netItemsSold;
    Object.assign(grouped[key].locations, r.locations);
  }

  return {
    rows: Object.values(grouped).sort((a, b) => a.sku.localeCompare(b.sku)),
    locationNames: Array.from(locationNames),
    timestamp: new Date().toLocaleString("en-US", { timeZone: storeIanaTz }),
    startDate: startDateStr,
    endDate: endDateStr,
    shopTimezone: storeIanaTz,
  };
};

/* -------------------------------------------------------------------------- */
/*                               CLIENT COMPONENT                              */
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
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingLg">Restocking Report</Text>

              <Form method="post">
                <BlockStack gap="200">
                  <TextField label="Start Date" type="datetime-local" name="startDate" value={startDate} onChange={setStartDate} required />
                  <TextField label="End Date" type="datetime-local" name="endDate" value={endDate} onChange={setEndDate} required />
                  <Button submit primary>Run Report</Button>
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
              <Text>Generated at: {data.timestamp} ({data.shopTimezone})</Text>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
