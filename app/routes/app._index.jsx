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

  // Keep original form strings for display
  const startDateStr = formData.get("startDate");
  const endDateStr = formData.get("endDate");

  // Parse dates (local timezone – as requested)
  const startDate = new Date(startDateStr);
  const endDate = new Date(endDateStr);
  endDate.setSeconds(59, 999); // Inclusive range

  /* -------------------------------------------------------------------------- */
  /*                           GraphQL Query (Light)                            */
  /* -------------------------------------------------------------------------- */
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
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  /* -------------------------------------------------------------------------- */
  /*                           PAGINATION + THROTTLING                          */
  /* -------------------------------------------------------------------------- */
  let allOrders = [];
  let cursor = null;
  let hasNextPage = true;
  let pageCount = 0;

  while (hasNextPage) {
    const response = await admin.graphql(ORDERS_QUERY, {
      variables: { cursor },
    });

    const data = await response.json();

    if (data.errors) {
      console.error("GraphQL Errors:", data.errors);
      break;
    }

    const ordersConnection = data.data.orders;
    const edges = ordersConnection.edges;

    // FILTER BY DATE RANGE
    for (const edge of edges) {
      const created = new Date(edge.node.createdAt);
      if (created >= startDate && created <= endDate) {
        allOrders.push(edge);
      }
    }

    // COST-AWARE THROTTLING
    const cost = data.extensions?.cost;
    if (cost) {
      const remaining = cost.throttleStatus.currentlyAvailable;
      const requested = cost.requestedQueryCost;
      const restoreRate = cost.throttleStatus.restoreRate;

      if (remaining < requested) {
        const wait = restoreRate * 1000;
        console.log(`Throttled → waiting ${wait}ms`);
        await new Promise((res) => setTimeout(res, wait));
      }
    }

    cursor = ordersConnection.pageInfo.endCursor;
    hasNextPage = ordersConnection.pageInfo.hasNextPage;

    // SAFETY LIMITS for live stores
    pageCount++;
    if (pageCount > 20) break;         // Max 20 pages (≈1000 orders)
    if (allOrders.length > 500) break; // Plenty for any time slice
  }

  /* -------------------------------------------------------------------------- */
  /*                         BUILD ROWS FROM FILTERED ORDERS                    */
  /* -------------------------------------------------------------------------- */
  const rawRows = [];
  const locationNames = new Set();

  for (const orderEdge of allOrders) {
    const orderNode = orderEdge.node;

    for (const liEdge of orderNode.lineItems.edges) {
      const n = liEdge.node;
      const p = n.product;
      const v = n.variant;

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
        netItemsSold: n.quantity,
        locations: locData,
      });
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                     GROUP BY PRODUCT + VARIANT + SKU                       */
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

    for (const loc of Object.keys(r.locations)) {
      grouped[key].locations[loc] = r.locations[loc];
    }
  }

  const finalRows = Object.values(grouped).sort((a, b) =>
    a.sku.localeCompare(b.sku)
  );

  return {
    rows: finalRows,
    locationNames: Array.from(locationNames),
    timestamp: new Date().toLocaleString(),
    startDate: startDateStr,
    endDate: endDateStr,
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

        {/* Loading State */}
        {loading && (
          <Layout.Section>
            <Card>
              <Spinner accessibilityLabel="Loading" size="large" />
              <Text>Fetching data…</Text>
            </Card>
          </Layout.Section>
        )}

        {/* Results */}
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
