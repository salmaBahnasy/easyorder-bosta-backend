#!/usr/bin/env node
/**
 * Backfill customer_status from EasyOrders WhatsApp confirmation status.
 *
 * EasyOrders stores confirmation in order.status (confirmed/canceled/pending).
 * Our ERP keeps that separately as customer_status / customerStatus.
 *
 * Usage:
 *   node scripts/backfill-customer-status-from-easyorders.js --yes
 *   node scripts/backfill-customer-status-from-easyorders.js --yes --since=2026-07-01
 *   node scripts/backfill-customer-status-from-easyorders.js --yes --limit=200
 *   node scripts/backfill-customer-status-from-easyorders.js --yes --dry-run
 */
require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
});

const supabase = require("../src/config/supabase");
const {
  mapEasyOrdersStatusToCustomerStatus,
  getOrderById,
} = require("../src/services/easyorder.service");
const {
  mergeOrderRawDataPatch,
  normalizeCustomerStatusInput,
} = require("../src/services/webhookOrders.service");

const ORDERS_TABLE = process.env.SUPABASE_ORDERS_TABLE || "orders";
const PAGE = 100;
const CONCURRENCY = 1;
// EasyOrders rate-limits aggressively — keep this slow and steady
const DELAY_MS = Number(process.env.BACKFILL_DELAY_MS || 1200);
const MAX_RETRIES = 10;

function parseArgs(argv) {
  const args = {
    yes: false,
    dryRun: false,
    since: null,
    limit: null,
  };
  for (const a of argv.slice(2)) {
    if (a === "--yes") args.yes = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--since=")) args.since = a.slice("--since=".length).trim();
    else if (a.startsWith("--limit=")) {
      const n = Number(a.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0) args.limit = Math.trunc(n);
    }
  }
  return args;
}

function localCustomerStatus(row) {
  const raw = row?.raw_data && typeof row.raw_data === "object" ? row.raw_data : {};
  return normalizeCustomerStatusInput(
    raw.customer_status ?? raw.customerStatus,
  ) || "pending";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getOrderByIdWithRetry(orderId) {
  let attempt = 0;
  for (;;) {
    try {
      return await getOrderById(orderId);
    } catch (err) {
      const status = err?.response?.status;
      if (status !== 429 || attempt >= MAX_RETRIES) throw err;
      const wait = Math.min(60000, 2000 * 2 ** attempt);
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "EasyOrders rate limited — backing off",
          orderId,
          attempt: attempt + 1,
          waitMs: wait,
        }),
      );
      await sleep(wait);
      attempt += 1;
    }
  }
}

async function mapPool(items, concurrency, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length || 1) }, () =>
      worker(),
    ),
  );
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.yes) {
    console.error(
      "Usage: node scripts/backfill-customer-status-from-easyorders.js --yes [--since=YYYY-MM-DD] [--limit=N] [--dry-run]",
    );
    process.exit(1);
  }

  if (!process.env.EASYORDER_API_KEY) {
    throw new Error("EASYORDER_API_KEY is not set");
  }

  let offset = 0;
  let scanned = 0;
  let updated = 0;
  let alreadyOk = 0;
  let stillPending = 0;
  let missingRemote = 0;
  let errors = 0;

  console.log(
    JSON.stringify({
      start: true,
      since: args.since,
      limit: args.limit,
      dryRun: args.dryRun,
      concurrency: CONCURRENCY,
    }),
  );

  for (;;) {
    if (args.limit != null && scanned >= args.limit) break;

    let q = supabase
      .from(ORDERS_TABLE)
      .select("order_id, raw_data, created_at")
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE - 1);

    if (args.since) {
      q = q.gte("created_at", new Date(args.since).toISOString());
    }

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data?.length) break;

    const candidates = data.filter((row) => {
      const cs = localCustomerStatus(row);
      return cs === "pending" || !cs;
    });

    const slice =
      args.limit != null
        ? candidates.slice(0, Math.max(0, args.limit - scanned))
        : candidates;

    scanned += slice.length;

    const batchResults = await mapPool(slice, CONCURRENCY, async (row) => {
      await sleep(DELAY_MS);
      try {
        const remote = await getOrderByIdWithRetry(row.order_id);
        const remoteOrder =
          remote?.data && typeof remote.data === "object" && remote.data.id
            ? remote.data
            : remote;
        if (!remoteOrder || typeof remoteOrder !== "object") {
          return { kind: "missing" };
        }

        const next = mapEasyOrdersStatusToCustomerStatus(remoteOrder.status);
        if (!next || next === "pending") {
          return {
            kind: "pending",
            shortId: remoteOrder.short_id ?? null,
            eoStatus: remoteOrder.status ?? null,
          };
        }

        if (args.dryRun) {
          return {
            kind: "would_update",
            orderId: row.order_id,
            shortId: remoteOrder.short_id ?? null,
            next,
            eoStatus: remoteOrder.status,
          };
        }

        await mergeOrderRawDataPatch(row.order_id, {
          customer_status: next,
          customerStatus: next,
          easyorders_status: remoteOrder.status,
          easyorders_customer_synced_at: new Date().toISOString(),
        });

        return {
          kind: "updated",
          orderId: row.order_id,
          shortId: remoteOrder.short_id ?? null,
          next,
          eoStatus: remoteOrder.status,
        };
      } catch (err) {
        const status = err?.response?.status;
        if (status === 404) return { kind: "missing" };
        return {
          kind: "error",
          orderId: row.order_id,
          message: err?.message || String(err),
          status,
        };
      }
    });

    for (const r of batchResults) {
      if (!r) continue;
      if (r.kind === "updated" || r.kind === "would_update") {
        updated += 1;
        console.log(
          JSON.stringify({
            action: r.kind,
            orderId: r.orderId,
            shortId: r.shortId,
            customerStatus: r.next,
            easyOrdersStatus: r.eoStatus,
          }),
        );
      } else if (r.kind === "pending") {
        stillPending += 1;
      } else if (r.kind === "missing") {
        missingRemote += 1;
      } else if (r.kind === "error") {
        errors += 1;
        console.error(JSON.stringify(r));
      }
    }

    // Also count rows already non-pending in this page
    alreadyOk += data.length - candidates.length;

    if (data.length < PAGE) break;
    offset += PAGE;
  }

  console.log(
    JSON.stringify({
      done: true,
      scannedPendingLocal: scanned,
      alreadyHadStatus: alreadyOk,
      updated,
      stillPendingOnEasyOrders: stillPending,
      missingOnEasyOrders: missingRemote,
      errors,
      dryRun: args.dryRun,
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
