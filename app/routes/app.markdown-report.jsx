import React, { useEffect, useMemo, useState } from "react";
import {
  Form,
  useActionData,
  useNavigation,
  useFetcher,
  useLocation,
} from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/* =========================
   Helpers
========================= */

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

// Date -> MM/DD/YYYY
function toMMDDYYYY(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function safeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function adminGraphql(admin, query, variables) {
  if (typeof admin?.graphql === "function") {
    const resp = await admin.graphql(query, { variables });
    if (resp?.json) return await resp.json();
    return resp;
  }
  if (typeof admin?.request === "function") {
    return await admin.request(query, { variables });
  }
  throw new Error("No supported GraphQL method found on admin client.");
}

/* =========================
   Shopify: Orders chunk scan -> salesByVariant
========================= */

function mergeSalesMap(existingJson, ordersEdges) {
  const sales =
    existingJson && typeof existingJson === "object" ? existingJson : {};

  for (const edge of ordersEdges ?? []) {
    const createdAt = edge?.node?.createdAt;
    const lineItems = edge?.node?.lineItems?.edges ?? [];

    for (const li of lineItems) {
      const variantId = li?.node?.variant?.id;
      const qty = li?.node?.quantity ?? 0;
      if (!variantId) continue;

      if (!sales[variantId]) {
        sales[variantId] = {
          qtySold: 0,
          firstSoldDate: createdAt || null,
          lastSoldDate: createdAt || null,
        };
      }

      sales[variantId].qtySold =
        Number(sales[variantId].qtySold ?? 0) + Number(qty ?? 0);

      if (createdAt) {
        if (
          !sales[variantId].firstSoldDate ||
          createdAt < sales[variantId].firstSoldDate
        ) {
          sales[variantId].firstSoldDate = createdAt;
        }
        if (
          !sales[variantId].lastSoldDate ||
          createdAt > sales[variantId].lastSoldDate
        ) {
          sales[variantId].lastSoldDate = createdAt;
        }
      }
    }
  }

  return sales;
}

async function fetchOrdersChunk(admin, sinceISO, afterCursor) {
  const query = `
    query OrdersSince($q: String!, $after: String) {
      orders(first: 25, after: $after, query: $q, sortKey: CREATED_AT) {
        edges {
          cursor
          node {
            createdAt
            lineItems(first: 100) {
              edges {
                node {
                  quantity
                  variant { id }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  `;

  const q = `created_at:>=${sinceISO}`;
  const data = await adminGraphql(admin, query, { q, after: afterCursor ?? null });
  const orders = data?.data?.orders ?? data?.body?.data?.orders;

  if (!orders) {
    const msg =
      data?.errors?.[0]?.message ||
      data?.data?.errors?.[0]?.message ||
      "Could not read orders from GraphQL response.";
    throw new Error(msg);
  }

  const edges = orders.edges ?? [];
  const hasNextPage = !!orders.pageInfo?.hasNextPage;
  const nextCursor = hasNextPage ? (edges?.at(-1)?.cursor ?? null) : null;

  return { edges, hasNextPage, nextCursor };
}

/* =========================
   Shopify: Fetch variants
========================= */

async function fetchAllActiveVariants(admin) {
  const query = `
    query AllVariants($after: String, $q: String!) {
      productVariants(first: 100, after: $after, query: $q) {
        edges {
          cursor
          node {
            id
            title
            sku
            inventoryQuantity
            product { title vendor productType }
            inventoryItem {
              sku
              unitCost { amount currencyCode }
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  `;

  const all = [];
  const q = "status:active";
  let after = null;

  const MAX_VARIANTS = 5000;

  while (true) {
    const data = await adminGraphql(admin, query, { after, q });
    const pv = data?.data?.productVariants ?? data?.body?.data?.productVariants;

    if (!pv) {
      const msg =
        data?.errors?.[0]?.message ||
        data?.data?.errors?.[0]?.message ||
        "Could not read productVariants from GraphQL response.";
      throw new Error(msg);
    }

    for (const edge of pv.edges ?? []) {
      if (edge?.node) all.push(edge.node);
      if (all.length >= MAX_VARIANTS) {
        return { variants: all, truncated: true, max: MAX_VARIANTS };
      }
    }

    if (!pv.pageInfo?.hasNextPage) break;
    after = pv.edges?.at(-1)?.cursor ?? null;
    if (!after) break;
  }

  return { variants: all, truncated: false, max: MAX_VARIANTS };
}

/* =========================
   Stocky API (429-safe) + caching helpers
========================= */

async function fetchStockyPurchaseOrdersPage({ shopDomain, stockyApiKey, limit, offset }) {
  const baseUrl = "https://stocky.shopifyapps.com/api/v2/purchase_orders.json";
  const url = new URL(baseUrl);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));

  const MAX_RETRIES = 6;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Store-Name": shopDomain,
        Authorization: `API KEY=${stockyApiKey}`,
        Accept: "application/json",
      },
    });

    if (resp.status === 429) {
      const retryAfterHeader = resp.headers.get("retry-after");
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;

      const baseWaitMs = Number.isFinite(retryAfterSeconds)
        ? Math.max(1000, retryAfterSeconds * 1000)
        : 2000;

      const waitMs = Math.min(30000, baseWaitMs * Math.pow(2, attempt));

      if (attempt === MAX_RETRIES) {
        throw new Error(
          `Stocky API error (429): rate limited. Retried ${MAX_RETRIES + 1} times.`
        );
      }

      await sleep(waitMs);
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Stocky API error (${resp.status}). ${text}`.trim());
    }

    const json = await resp.json();
    const purchaseOrders = json?.purchase_orders ?? [];
    return Array.isArray(purchaseOrders) ? purchaseOrders : [];
  }

  return [];
}

async function upsertReceiptForSku({ shop, sku, receivedAt }) {
  const dt = safeDate(receivedAt);
  if (!dt) return;

  const existing = await prisma.stockySkuReceipt.findUnique({
    where: { shop_sku: { shop, sku } },
    select: { firstReceivedAt: true, lastReceivedAt: true },
  });

  if (!existing) {
    await prisma.stockySkuReceipt.create({
      data: { shop, sku, firstReceivedAt: dt, lastReceivedAt: dt },
    });
    return;
  }

  const first = existing.firstReceivedAt ? new Date(existing.firstReceivedAt) : null;
  const last = existing.lastReceivedAt ? new Date(existing.lastReceivedAt) : null;

  let nextFirst = first;
  let nextLast = last;

  if (!nextFirst || dt < nextFirst) nextFirst = dt;
  if (!nextLast || dt > nextLast) nextLast = dt;

  const changed =
    (first?.getTime?.() ?? null) !== (nextFirst?.getTime?.() ?? null) ||
    (last?.getTime?.() ?? null) !== (nextLast?.getTime?.() ?? null);

  if (changed) {
    await prisma.stockySkuReceipt.update({
      where: { shop_sku: { shop, sku } },
      data: { firstReceivedAt: nextFirst, lastReceivedAt: nextLast },
    });
  }
}

async function stockyQuickSync({ shopDomain, stockyApiKey }) {
  const pages = 1;
  const limit = 100;

  let scannedOrders = 0;
  let itemsProcessed = 0;

  for (let p = 0; p < pages; p++) {
    const offset = p * limit;
    const orders = await fetchStockyPurchaseOrdersPage({
      shopDomain,
      stockyApiKey,
      limit,
      offset,
    });

    if (orders.length === 0) break;
    scannedOrders += orders.length;

    for (const po of orders) {
      const items = po?.purchase_items ?? [];
      for (const item of items) {
        const sku = String(item?.sku ?? "").trim();
        const receivedAt = item?.received_at ?? null;
        if (!sku || !receivedAt) continue;
        await upsertReceiptForSku({ shop: shopDomain, sku, receivedAt });
        itemsProcessed += 1;
      }
    }

    if (orders.length < limit) break;
  }

  return { scannedOrders, itemsProcessed };
}

async function getOrCreateSyncState(shopDomain) {
  return prisma.stockySyncState.upsert({
    where: { shop: shopDomain },
    update: {},
    create: { shop: shopDomain, fullOffset: 0, fullDone: false },
  });
}

async function resetFullSync(shopDomain) {
  await prisma.stockySyncState.upsert({
    where: { shop: shopDomain },
    update: { fullOffset: 0, fullDone: false },
    create: { shop: shopDomain, fullOffset: 0, fullDone: false },
  });
}

async function runFullSyncChunk({ shopDomain, stockyApiKey, startFresh }) {
  const limit = 100;
  const PAGE_DELAY_MS = 800;

  if (startFresh) await resetFullSync(shopDomain);

  const state = await getOrCreateSyncState(shopDomain);
  if (state.fullDone) {
    return { done: true, offset: state.fullOffset, scannedOrders: 0, itemsProcessed: 0, message: "Full Sync already complete.", suggestedNextPollMs: 0 };
  }

  const startedAt = Date.now();
  const MAX_MS = 10000;
  let offset = state.fullOffset;

  let scannedOrders = 0;
  let itemsProcessed = 0;

  while (Date.now() - startedAt < MAX_MS) {
    const orders = await fetchStockyPurchaseOrdersPage({
      shopDomain,
      stockyApiKey,
      limit,
      offset,
    });

    if (orders.length === 0) {
      await prisma.stockySyncState.update({
        where: { shop: shopDomain },
        data: { fullDone: true },
      });
      return { done: true, offset, scannedOrders, itemsProcessed, message: "Full Sync complete.", suggestedNextPollMs: 0 };
    }

    scannedOrders += orders.length;

    for (const po of orders) {
      const items = po?.purchase_items ?? [];
      for (const item of items) {
        const sku = String(item?.sku ?? "").trim();
        const receivedAt = item?.received_at ?? null;
        if (!sku || !receivedAt) continue;
        await upsertReceiptForSku({ shop: shopDomain, sku, receivedAt });
        itemsProcessed += 1;
      }
    }

    offset += orders.length;

    await prisma.stockySyncState.update({
      where: { shop: shopDomain },
      data: { fullOffset: offset },
    });

    if (orders.length < limit) {
      await prisma.stockySyncState.update({
        where: { shop: shopDomain },
        data: { fullDone: true },
      });
      return { done: true, offset, scannedOrders, itemsProcessed, message: "Full Sync complete.", suggestedNextPollMs: 0 };
    }

    await sleep(PAGE_DELAY_MS);
  }

  return { done: false, offset, scannedOrders, itemsProcessed, message: "Full Sync in progress…", suggestedNextPollMs: 1400 };
}

/* =========================
   Report runner (Prisma)
========================= */

async function cleanupOldRuns(shopDomain) {
  const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await prisma.reportRunState.deleteMany({
    where: { shop: shopDomain, createdAt: { lt: cutoff } },
  });
}

async function startReportRun(shopDomain, periodQtySoldLTE, lookBackDays) {
  await cleanupOldRuns(shopDomain);
  const sinceISO = new Date(Date.now() - lookBackDays * 86400000).toISOString();

  return prisma.reportRunState.create({
    data: {
      shop: shopDomain,
      periodQtySoldLTE,
      lookBackDays,
      sinceISO,
      cursor: null,
      done: false,
      processedOrders: 0,
      salesByVariant: {},
      status: "running",
      error: null,
    },
  });
}

async function continueReportRun(admin, shopDomain, runId) {
  const run = await prisma.reportRunState.findUnique({ where: { id: runId } });
  if (!run || run.shop !== shopDomain) throw new Error("Report run not found.");
  if (run.done || run.status === "done") return { ...run, progressMessage: "Report scan complete." };
  if (run.status === "error") throw new Error(run.error || "Report run previously failed.");

  const startedAt = Date.now();
  const MAX_MS = 12000;

  let cursor = run.cursor;
  let processedOrders = Number(run.processedOrders ?? 0);
  let salesByVariant = run.salesByVariant;

  while (Date.now() - startedAt < MAX_MS) {
    const chunk = await fetchOrdersChunk(admin, run.sinceISO, cursor);
    salesByVariant = mergeSalesMap(salesByVariant, chunk.edges);
    processedOrders += chunk.edges.length;
    cursor = chunk.nextCursor;

    await prisma.reportRunState.update({
      where: { id: runId },
      data: { cursor, processedOrders, salesByVariant, status: "running", error: null },
    });

    if (!chunk.hasNextPage) {
      const doneRun = await prisma.reportRunState.update({
        where: { id: runId },
        data: { done: true, status: "done" },
      });
      return { ...doneRun, progressMessage: "Report scan complete." };
    }

    await sleep(200);
  }

  const latest = await prisma.reportRunState.findUnique({ where: { id: runId } });
  return {
    ...latest,
    progressMessage: `Scanning orders… processed ${processedOrders} so far.`,
  };
}

/* =========================
   Action
========================= */

export async function action({ request }) {
  try {
    const { admin, session } = await authenticate.admin(request);

    const reqUrl = new URL(request.url);
    const shopFromUrl = reqUrl.searchParams.get("shop");
    const shopDomain = shopFromUrl || session?.shop || null;

    const stockyApiKey = process.env.STOCKY_API_KEY || "";

    const formData = await request.formData();
    const intent = String(formData.get("intent") || "reportStart");

    const periodQtySoldLTE = toInt(formData.get("periodQtySoldLTE"), 0);
    const lookBackDays = toInt(formData.get("lookBackDays"), 60);

    if (!shopDomain) {
      return { error: "Missing shop domain.", inputs: { periodQtySoldLTE, lookBackDays } };
    }

    if (intent === "stockyFullSync") {
      if (!stockyApiKey) return { error: "STOCKY_API_KEY is not set.", inputs: { periodQtySoldLTE, lookBackDays } };

      const mode = String(formData.get("mode") || "continue");
      const startFresh = mode === "start";

      const chunk = await runFullSyncChunk({ shopDomain, stockyApiKey, startFresh });
      return { inputs: { periodQtySoldLTE, lookBackDays }, fullSync: chunk };
    }

    if (intent === "stockyQuickSync") {
      if (!stockyApiKey) return { error: "STOCKY_API_KEY is not set.", inputs: { periodQtySoldLTE, lookBackDays } };

      const r = await stockyQuickSync({ shopDomain, stockyApiKey });
      return {
        inputs: { periodQtySoldLTE, lookBackDays },
        message: `Quick Sync complete. Scanned ${r.scannedOrders} POs, updated ${r.itemsProcessed} received items.`,
      };
    }

    if (intent === "reportStart") {
      if (periodQtySoldLTE < 0 || lookBackDays <= 0) {
        return { error: "Invalid input values.", inputs: { periodQtySoldLTE, lookBackDays } };
      }

      const run = await startReportRun(shopDomain, periodQtySoldLTE, lookBackDays);
      const progressed = await continueReportRun(admin, shopDomain, run.id);

      return {
        inputs: { periodQtySoldLTE, lookBackDays },
        report: {
          runId: run.id,
          done: progressed.done,
          processedOrders: progressed.processedOrders ?? 0,
          message: progressed.progressMessage ?? "Scanning orders…",
        },
      };
    }

    if (intent === "reportContinue") {
      const runId = String(formData.get("runId") || "");
      if (!runId) return { error: "Missing runId.", inputs: { periodQtySoldLTE, lookBackDays } };

      const progressed = await continueReportRun(admin, shopDomain, runId);

      if (!progressed.done) {
        return {
          inputs: { periodQtySoldLTE, lookBackDays },
          report: {
            runId,
            done: false,
            processedOrders: progressed.processedOrders ?? 0,
            message: progressed.progressMessage ?? `Scanning orders… processed ${progressed.processedOrders ?? 0}.`,
          },
        };
      }

      const allVariantsResult = await fetchAllActiveVariants(admin);

      const wantedSkus = [];
      for (const v of allVariantsResult.variants) {
        const skuFromVariant = String(v?.sku ?? "").trim();
        const skuFromInventoryItem = String(v?.inventoryItem?.sku ?? "").trim();
        const sku = skuFromVariant || skuFromInventoryItem;
        if (sku) wantedSkus.push(sku);
      }

      const receipts = wantedSkus.length
        ? await prisma.stockySkuReceipt.findMany({
            where: { shop: shopDomain, sku: { in: wantedSkus } },
            select: { sku: true, firstReceivedAt: true, lastReceivedAt: true },
          })
        : [];

      const receiptMap = {};
      for (const r of receipts) {
        receiptMap[r.sku] = {
          first: r.firstReceivedAt ? toMMDDYYYY(r.firstReceivedAt) : "",
          last: r.lastReceivedAt ? toMMDDYYYY(r.lastReceivedAt) : "",
        };
      }

      const salesByVariant =
        progressed.salesByVariant && typeof progressed.salesByVariant === "object"
          ? progressed.salesByVariant
          : {};

      const rows = allVariantsResult.variants
        .map((v) => {
          const sales = salesByVariant[v.id] ?? { qtySold: 0, firstSoldDate: null, lastSoldDate: null };

          const cost = v?.inventoryItem?.unitCost?.amount != null ? Number(v.inventoryItem.unitCost.amount) : null;
          const qtyOH = typeof v?.inventoryQuantity === "number" ? v.inventoryQuantity : null;
          const extCost = cost != null && qtyOH != null ? cost * qtyOH : null;

          const skuFromVariant = String(v?.sku ?? "").trim();
          const skuFromInventoryItem = String(v?.inventoryItem?.sku ?? "").trim();
          const sku = skuFromVariant || skuFromInventoryItem;

          const rec = sku ? receiptMap[sku] : null;

          return {
            qtySold: Number(sales.qtySold ?? 0),

            productTitle: v?.product?.title ?? "",
            variantTitle: v?.title ?? "",
            sku,
            vendor: v?.product?.vendor ?? "",
            productType: v?.product?.productType ?? "",
            cost,
            qtyOH,
            extCost,

            firstRecDate: rec?.first ?? "",
            lastRecDate: rec?.last ?? "",

            firstSoldDate: toMMDDYYYY(sales.firstSoldDate),
            lastSoldDate: toMMDDYYYY(sales.lastSoldDate),
          };
        })
        .filter((r) => (r.qtySold ?? 0) <= periodQtySoldLTE)
        .sort((a, b) => {
          const qa = a.qtySold ?? 0;
          const qb = b.qtySold ?? 0;
          if (qa !== qb) return qa - qb;
          return String(a.sku ?? "").localeCompare(String(b.sku ?? ""));
        })
        .map(({ qtySold, ...rest }) => rest);

      return {
        inputs: { periodQtySoldLTE, lookBackDays },
        report: {
          runId,
          done: true,
          processedOrders: progressed.processedOrders ?? 0,
          message: "Report ready.",
        },
        rows,
        rowsCount: rows.length,
        truncated: allVariantsResult.truncated,
        maxVariants: allVariantsResult.max,
      };
    }

    return { error: `Unknown intent: ${intent}`, inputs: { periodQtySoldLTE, lookBackDays } };
  } catch (e) {
    console.error("Markdown Report action failed:", e);

    if (e instanceof Response) return e;
    if (e && typeof e === "object" && e.constructor?.name === "Response") return e;

    return { error: e?.message ?? String(e) };
  }
}

/* =========================
   Page
========================= */

export default function MarkdownReport() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const location = useLocation();
  const actionUrl = location.pathname + location.search; // ✅ preserve embedded params

  const fullSyncFetcher = useFetcher();
  const quickSyncFetcher = useFetcher();
  const reportFetcher = useFetcher();

  const [isFullSyncRunning, setIsFullSyncRunning] = useState(false);
  const [isReportRunning, setIsReportRunning] = useState(false);

  const currentInputs = useMemo(() => {
    return (
      reportFetcher.data?.inputs ||
      fullSyncFetcher.data?.inputs ||
      quickSyncFetcher.data?.inputs ||
      actionData?.inputs || { periodQtySoldLTE: 0, lookBackDays: 60 }
    );
  }, [reportFetcher.data, fullSyncFetcher.data, quickSyncFetcher.data, actionData?.inputs]);

  // Full sync loop (continue)
  useEffect(() => {
    if (fullSyncFetcher.data?.error) setIsFullSyncRunning(false);
  }, [fullSyncFetcher.data]);

  useEffect(() => {
    const d = fullSyncFetcher.data?.fullSync;
    if (!d) return;

    if (d.done) {
      setIsFullSyncRunning(false);
      return;
    }

    const delay = Number(d.suggestedNextPollMs ?? 1500);

    const t = setTimeout(() => {
      fullSyncFetcher.submit(
        {
          intent: "stockyFullSync",
          mode: "continue",
          periodQtySoldLTE: String(currentInputs.periodQtySoldLTE ?? 0),
          lookBackDays: String(currentInputs.lookBackDays ?? 60),
        },
        { method: "post", action: actionUrl } // ✅ keep embedded params
      );
    }, delay);

    return () => clearTimeout(t);
  }, [fullSyncFetcher.data, currentInputs, fullSyncFetcher, actionUrl]);

  // Report loop (continue)
  useEffect(() => {
    const r = reportFetcher.data?.report;
    if (!r) return;

    if (r.done) {
      setIsReportRunning(false);
      return;
    }

    const runId = r.runId;
    if (!runId) return;

    const t = setTimeout(() => {
      reportFetcher.submit(
        {
          intent: "reportContinue",
          runId,
          periodQtySoldLTE: String(currentInputs.periodQtySoldLTE ?? 0),
          lookBackDays: String(currentInputs.lookBackDays ?? 60),
        },
        { method: "post", action: actionUrl } // ✅ keep embedded params
      );
    }, 900);

    return () => clearTimeout(t);
  }, [reportFetcher.data, reportFetcher, currentInputs, actionUrl]);

  const styles = {
    page: { padding: 16 },
    h1: { fontSize: 42, margin: "10px 0 12px", fontWeight: 700 },
    row: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 },
    label: { minWidth: 360 },
    input: { width: 220, padding: "4px 6px", fontSize: 14, border: "1px solid #999" },
    submit: { marginTop: 8 },
    error: {
      marginTop: 10,
      padding: 10,
      border: "1px solid #d72c0d",
      background: "#fff4f4",
      whiteSpace: "pre-wrap",
      maxWidth: 1200,
    },
    info: {
      marginTop: 10,
      padding: 10,
      border: "1px solid #005bd3",
      background: "#f0f7ff",
      whiteSpace: "pre-wrap",
      maxWidth: 1200,
    },
    smallButton: {
      padding: "6px 12px",
      fontSize: 13,
      border: "1px solid #666",
      borderRadius: 2,
      background: "#f3f3f3",
      cursor: "pointer",
    },
    tableWrap: { marginTop: 14, maxWidth: "100%", overflowX: "auto" },
    table: { borderCollapse: "collapse", width: "100%", minWidth: 1200 },
    th: {
      border: "1px solid #000",
      padding: "6px 8px",
      background: "#f0f0f0",
      textAlign: "left",
      fontWeight: 700,
      whiteSpace: "nowrap",
    },
    td: { border: "1px solid #000", padding: "6px 8px", whiteSpace: "nowrap", verticalAlign: "top" },
  };

  const fullSync = fullSyncFetcher.data?.fullSync;
  const fullSyncBusy = isFullSyncRunning || fullSyncFetcher.state === "submitting";
  const quickSyncBusy = quickSyncFetcher.state === "submitting";

  const reportProgress = reportFetcher.data?.report || actionData?.report;
  const reportRows = reportFetcher.data?.rows || actionData?.rows || [];
  const reportError = reportFetcher.data?.error || actionData?.error;

  return (
    <div style={styles.page}>
      {/* Sync buttons at top */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <fullSyncFetcher.Form method="post" action={actionUrl} style={{ margin: 0 }}>
          <input type="hidden" name="intent" value="stockyFullSync" />
          <input type="hidden" name="mode" value="start" />
          <input type="hidden" name="periodQtySoldLTE" value={currentInputs.periodQtySoldLTE ?? 0} />
          <input type="hidden" name="lookBackDays" value={currentInputs.lookBackDays ?? 60} />
          <button
            type="submit"
            style={styles.smallButton}
            onClick={() => setIsFullSyncRunning(true)}
            disabled={busy || fullSyncBusy || isReportRunning}
          >
            {fullSyncBusy ? "Full Sync Running…" : "Full Sync Stocky Cache (run until done)"}
          </button>
        </fullSyncFetcher.Form>

        <quickSyncFetcher.Form method="post" action={actionUrl} style={{ margin: 0 }}>
          <input type="hidden" name="intent" value="stockyQuickSync" />
          <input type="hidden" name="periodQtySoldLTE" value={currentInputs.periodQtySoldLTE ?? 0} />
          <input type="hidden" name="lookBackDays" value={currentInputs.lookBackDays ?? 60} />
          <button type="submit" style={styles.smallButton} disabled={busy || fullSyncBusy || quickSyncBusy || isReportRunning}>
            {quickSyncBusy ? "Quick Sync Running…" : "Quick Sync Stocky Cache"}
          </button>
        </quickSyncFetcher.Form>
      </div>

      {fullSync ? (
        <div style={styles.info}>
          {fullSync.message}
          {"\n"}Offset: {fullSync.offset} • Scanned POs (this chunk): {fullSync.scannedOrders} • Items updated (this chunk):{" "}
          {fullSync.itemsProcessed} • Done: {fullSync.done ? "yes" : "no"}
        </div>
      ) : null}

      {quickSyncFetcher.data?.message ? <div style={styles.info}>{quickSyncFetcher.data.message}</div> : null}

      <h1 style={styles.h1}>Markdown Report</h1>

      <reportFetcher.Form
        method="post"
        action={actionUrl} // ✅ preserve embedded params
        onSubmit={() => setIsReportRunning(true)}
      >
        <input type="hidden" name="intent" value="reportStart" />

        <div style={styles.row}>
          <div style={styles.label}>Period Qty Sold (Less Than or Equal To):</div>
          <input
            style={styles.input}
            type="number"
            name="periodQtySoldLTE"
            defaultValue={currentInputs.periodQtySoldLTE ?? 0}
            min="0"
          />
        </div>

        <div style={styles.row}>
          <div style={styles.label}>Look Back Period (Days):</div>
          <input
            style={styles.input}
            type="number"
            name="lookBackDays"
            defaultValue={currentInputs.lookBackDays ?? 60}
            min="1"
          />
        </div>

        <button style={styles.submit} type="submit" disabled={busy || fullSyncBusy || reportFetcher.state === "submitting"}>
          {reportFetcher.state === "submitting" ? "Running…" : "SUBMIT"}
        </button>
      </reportFetcher.Form>

      {reportError ? <div style={styles.error}>{reportError}</div> : null}

      {reportProgress ? (
        <div style={styles.info}>
          {reportProgress.message}
          {"\n"}Orders processed so far: {reportProgress.processedOrders ?? 0}
          {"\n"}Done: {reportProgress.done ? "yes" : "no"}
        </div>
      ) : null}

      {reportRows && reportRows.length > 0 ? (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Product Title</th>
                <th style={styles.th}>Variant Title</th>
                <th style={styles.th}>SKU</th>
                <th style={styles.th}>Vendor</th>
                <th style={styles.th}>Product Type</th>
                <th style={styles.th}>Cost</th>
                <th style={styles.th}>Qty OH</th>
                <th style={styles.th}>Ext. Cost</th>
                <th style={styles.th}>1st Rec. Date</th>
                <th style={styles.th}>last rec. Date</th>
                <th style={styles.th}>1st Date Sold</th>
                <th style={styles.th}>Last Date Sold</th>
              </tr>
            </thead>
            <tbody>
              {reportRows.map((r, idx) => {
                const cost = r.cost == null ? "" : Number(r.cost).toFixed(2);
                const qty = r.qtyOH == null ? "" : String(r.qtyOH);
                const ext = r.extCost == null ? "" : Number(r.extCost).toFixed(2);

                return (
                  <tr key={idx}>
                    <td style={styles.td}>{r.productTitle}</td>
                    <td style={styles.td}>{r.variantTitle}</td>
                    <td style={styles.td}>{r.sku}</td>
                    <td style={styles.td}>{r.vendor}</td>
                    <td style={styles.td}>{r.productType}</td>
                    <td style={styles.td}>{cost}</td>
                    <td style={styles.td}>{qty}</td>
                    <td style={styles.td}>{ext}</td>
                    <td style={styles.td}>{r.firstRecDate ?? ""}</td>
                    <td style={styles.td}>{r.lastRecDate ?? ""}</td>
                    <td style={styles.td}>{r.firstSoldDate ?? ""}</td>
                    <td style={styles.td}>{r.lastSoldDate ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : reportProgress?.done ? (
        <div style={{ marginTop: 12 }}>No rows matched your filter.</div>
      ) : null}
    </div>
  );
}
