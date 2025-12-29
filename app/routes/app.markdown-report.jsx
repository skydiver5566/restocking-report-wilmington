import React, { useEffect, useMemo, useState } from "react";
import {
  useActionData,
  useFetcher,
  useLocation,
  useNavigation,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* =========================
   Shopify helpers
========================= */

async function adminGraphql(admin, query, variables) {
  const resp = await admin.graphql(query, { variables });
  return resp.json();
}

async function fetchOrdersChunk(admin, sinceISO, afterCursor) {
  const query = `
    query OrdersSince($q: String!, $after: String) {
      orders(first: 50, after: $after, query: $q, sortKey: CREATED_AT) {
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
  const data = await adminGraphql(admin, query, {
    q,
    after: afterCursor ?? null,
  });

  const orders = data?.data?.orders;
  if (!orders) throw new Error("Orders query failed");

  const edges = orders.edges ?? [];
  const hasNextPage = orders.pageInfo?.hasNextPage ?? false;
  const nextCursor = hasNextPage ? edges.at(-1)?.cursor ?? null : null;

  return { edges, hasNextPage, nextCursor };
}

/* =========================
   Prisma report runner
========================= */

async function startReportRun(shop, lookBackDays) {
  const sinceISO = new Date(
    Date.now() - lookBackDays * 86400000
  ).toISOString();

  return prisma.reportRunState.create({
    data: {
      shop,
      sinceISO,
      cursor: null,
      processedOrders: 0,
      salesByVariant: {},
      done: false,
    },
  });
}

function mergeSalesMap(existing, edges) {
  const map = existing ?? {};
  for (const e of edges) {
    for (const li of e.node.lineItems.edges) {
      const id = li.node.variant?.id;
      if (!id) continue;
      map[id] = (map[id] ?? 0) + li.node.quantity;
    }
  }
  return map;
}

async function continueReportRun(admin, shop, runId) {
  const run = await prisma.reportRunState.findUnique({ where: { id: runId } });
  if (!run || run.shop !== shop) throw new Error("Invalid run");

  const startedAt = Date.now();
  const MAX_MS = 3000;
  const MAX_LOOPS = 3;

  let cursor = run.cursor;
  let processed = run.processedOrders;
  let sales = run.salesByVariant;
  let loops = 0;

  while (Date.now() - startedAt < MAX_MS && loops < MAX_LOOPS) {
    loops++;

    const chunk = await fetchOrdersChunk(admin, run.sinceISO, cursor);
    sales = mergeSalesMap(sales, chunk.edges);
    processed += chunk.edges.length;
    cursor = chunk.nextCursor;

    await prisma.reportRunState.update({
      where: { id: runId },
      data: { cursor, processedOrders: processed, salesByVariant: sales },
    });

    if (!chunk.hasNextPage) {
      await prisma.reportRunState.update({
        where: { id: runId },
        data: { done: true },
      });
      return { done: true, processed };
    }

    await sleep(150);
  }

  return { done: false, processed };
}

/* =========================
   Action
========================= */

export async function action({ request }) {
  try {
    const auth = await authenticate.admin(request);
    if (auth instanceof Response) return auth;

    const { admin, session } = auth;
    const shop = session.shop;

    const formData = await request.formData();
    const intent = String(formData.get("intent"));

    if (intent === "reportStart") {
      const lookBackDays = toInt(formData.get("lookBackDays"), 60);
      const run = await startReportRun(shop, lookBackDays);
      const progressed = await continueReportRun(admin, shop, run.id);

      return {
        report: {
          runId: run.id,
          done: progressed.done,
          processedOrders: progressed.processed,
          message: "Scanning orders…",
        },
      };
    }

    if (intent === "reportContinue") {
      const runId = String(formData.get("runId"));
      const progressed = await continueReportRun(admin, shop, runId);

      return {
        report: {
          runId,
          done: progressed.done,
          processedOrders: progressed.processed,
          message: progressed.done
            ? "Report complete."
            : "Scanning orders…",
        },
      };
    }

    return { error: "Unknown intent" };
  } catch (err) {
    if (err instanceof Response) return err;
    throw err;
  }
}

/* =========================
   Page
========================= */

export default function MarkdownReport() {
  const actionData = useActionData();
  const reportFetcher = useFetcher();
  const navigation = useNavigation();
  const location = useLocation();

  const [runId, setRunId] = useState(null);

  const actionUrl = useMemo(() => {
    const sp = new URLSearchParams(location.search);
    const keep = new URLSearchParams();
    for (const k of ["shop", "host", "embedded", "locale"]) {
      const v = sp.get(k);
      if (v) keep.set(k, v);
    }
    if (!keep.get("embedded")) keep.set("embedded", "1");
    return `${location.pathname}?${keep.toString()}`;
  }, [location.pathname, location.search]);

  // Restore runId after reload
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = sessionStorage.getItem("markdownReportRunId");
    if (stored) setRunId(stored);
  }, []);

  // Save runId
  useEffect(() => {
    if (typeof window === "undefined") return;
    const r = reportFetcher.data?.report || actionData?.report;
    if (r?.runId) {
      sessionStorage.setItem("markdownReportRunId", r.runId);
      setRunId(r.runId);
    }
    if (r?.done) {
      sessionStorage.removeItem("markdownReportRunId");
      setRunId(null);
    }
  }, [reportFetcher.data, actionData]);

  // Poll loop
  useEffect(() => {
    if (!runId) return;

    const t = setTimeout(() => {
      reportFetcher.submit(
        { intent: "reportContinue", runId },
        { method: "post", action: actionUrl }
      );
    }, 350);

    return () => clearTimeout(t);
  }, [runId, reportFetcher, actionUrl]);

  const report = reportFetcher.data?.report || actionData?.report;

  return (
    <div style={{ padding: 16 }}>
      <h1>Markdown Report</h1>

      {/* IMPORTANT: button + submit, NOT fetcher.Form */}
      <button
        disabled={navigation.state === "submitting"}
        onClick={() => {
          reportFetcher.submit(
            { intent: "reportStart" },
            { method: "post", action: actionUrl }
          );
        }}
      >
        Generate Report
      </button>

      {report ? (
        <pre style={{ marginTop: 12 }}>
          {report.message}
          {"\n"}Processed: {report.processedOrders}
          {"\n"}Done: {String(report.done)}
        </pre>
      ) : null}
    </div>
  );
}
