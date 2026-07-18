#!/usr/bin/env node
/**
 * Fast LOCAL backfill: copy easyorders_status → customer_status
 * when EasyOrders WhatsApp status was preserved on the order.
 *
 * Does NOT treat ERP status "Confirmed" as WhatsApp confirmation.
 *
 * Usage:
 *   node scripts/backfill-customer-status-from-local.js --yes
 *   node scripts/backfill-customer-status-from-local.js --yes --dry-run
 */
require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
});

const supabase = require("../src/config/supabase");
const {
  mergeOrderRawDataPatch,
  normalizeCustomerStatusInput,
} = require("../src/services/webhookOrders.service");

const ORDERS_TABLE = process.env.SUPABASE_ORDERS_TABLE || "orders";
const PAGE = 500;

function parseArgs(argv) {
  const args = { yes: false, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === "--yes") args.yes = true;
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.yes) {
    console.error(
      "Usage: node scripts/backfill-customer-status-from-local.js --yes [--dry-run]",
    );
    process.exit(1);
  }

  let offset = 0;
  let updated = 0;
  let scanned = 0;

  for (;;) {
    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .select("order_id, raw_data")
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;

    for (const row of data) {
      scanned += 1;
      const raw = row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {};
      const eo = normalizeCustomerStatusInput(
        raw.easyorders_status ?? raw.easyOrdersStatus,
      );
      if (eo !== "confirmed" && eo !== "canceled") continue;

      const cs =
        normalizeCustomerStatusInput(raw.customer_status ?? raw.customerStatus) ||
        "pending";
      if (cs === eo) continue;

      if (args.dryRun) {
        updated += 1;
        console.log(
          JSON.stringify({
            action: "would_update",
            orderId: row.order_id,
            shortId: raw.short_id ?? null,
            from: cs,
            to: eo,
          }),
        );
        continue;
      }

      await mergeOrderRawDataPatch(row.order_id, {
        customer_status: eo,
        customerStatus: eo,
      });
      updated += 1;
      console.log(
        JSON.stringify({
          action: "updated",
          orderId: row.order_id,
          shortId: raw.short_id ?? null,
          customerStatus: eo,
        }),
      );
    }

    if (data.length < PAGE) break;
    offset += PAGE;
  }

  console.log(JSON.stringify({ done: true, scanned, updated, dryRun: args.dryRun }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
