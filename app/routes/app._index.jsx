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
/*                               SERVER ACTION                                */
/* -------------------------------------------------------------------------- */
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const startDate = formData.get("startDate");
  const endDate = formData.get("endDate");

  const shopQuery = `created_at:>=${startDate} created_at:<=${endDate}`;
  const ORDERS_QUERY = `
    query RestockingReportOrders($query: String!, $cursor: String) {
      orders(first: 10, query: $query, after: $cursor) {
        edges {
          cursor
          node {
            createdAt
            lineItems(first: 10) {
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
                            quantities(names: "available") { name quantity }
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
    }`;

  let allOrders = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(ORDERS_QUERY, {
      variables: { query: shopQuery, cursor },
    });
    const data = await response.json();
    const orders = data.data.orders.edges;
    allOrders = allOrders.concat(orders);
    hasNextPage = data.data.orders.pageInfo.hasNextPage;
    cursor = data.data.orders.pageInfo.endCursor;
    if (allOrders.length > 1000) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  const rawRows = [];
  const locationNames = new Set();

  for (const orderEdge of allOrders) {
    for (const liEdge of orderEdge.node.lineItems.edges) {
      const n = liEdge.node;
      const p = n.product;
      const v = n.variant;
      const qty = n.quantity;

      const levels = v?.inventoryItem?.inventoryLevels?.edges || [];

      const locData = {};
      for (const lvlEdge of levels) {
        const lvl = lvlEdge.node;
        const avail = lvl.quantities?.find((q) => q.name === "available");
        const loc = lvl.location?.name || "Unknown";
        locationNames.add(loc);
        locData[loc] = avail ? avail.quantity : "-";
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

  /* -------------------------------------------------------------------------- */
  /*                NEW: GROUP BY PRODUCT + VARIANT + SKU                       */
  /* -------------------------------------------------------------------------- */
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

    // Merge location stock values
    for (const loc of Object.keys(r.locations)) {
      grouped[key].locations[loc] = r.locations[loc];
    }
  }

  /* Sort alphabetically by SKU */
  const finalRows = Object.values(grouped).sort((a, b) =>
    a.sku.localeCompare(b.sku)
  );

  return {
    rows: finalRows,
    locationNames: Array.from(locationNames),
    timestamp: new Date().toLocaleString(),
    startDate,
    endDate,
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
    <Page title="Restocking Report">
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
              <Text as="h2" variant="headingMd">
                Generate Report
              </Text>
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
              <Text>Fetching data...</Text>
            </Card>
          </Layout.Section>
        )}

        {data && (
          <Layout.Section>
            <Card>
              <Text as="h2" variant="headingMd">
                Results ({data.startDate} → {data.endDate})
              </Text>
              <Text>Generated at: {data.timestamp}</Text>

              <div id="results-table" style={{ marginTop: "1rem" }}>
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
                    {data.rows.map((r, i) => (
                      <tr key={i}>
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
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
