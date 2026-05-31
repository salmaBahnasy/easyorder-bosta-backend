#!/usr/bin/env node
/**
 * Assign order_reference (1001+) to orders created on/after Egypt start date that lack one.
 * Orders sorted by created_at ascending.
 *
 * Requires: supabase/order_reference_schema.sql (optional column, recommended)
 * Usage: node scripts/backfill-order-references.js --yes
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const supabase = require("../src/config/supabase");
const {
  ORDER_REFERENCE_START,
  ORDER_REFERENCE_EGYPT_START,
  readOrderReferenceFromRow,
  applyOrderReferenceToRawData,
} = require("../src/utils/orderReference");

const ORDERS_TABLE = process.env.SUPABASE_ORDERS_TABLE || "orders";
const PAGE = 500;

async function main() {
  if (!process.argv.includes("--yes")) {
    console.error("Usage: node scripts/backfill-order-references.js --yes");
    process.exit(1);
  }

  let nextRef = ORDER_REFERENCE_START;
  const { data: maxRow } = await supabase
    .from(ORDERS_TABLE)
    .select("order_reference")
    .gte("created_at", ORDER_REFERENCE_EGYPT_START.toISOString())
    .not("order_reference", "is", null)
    .order("order_reference", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (maxRow?.order_reference != null) {
    nextRef = Math.max(Number(maxRow.order_reference) + 1, ORDER_REFERENCE_START);
  }

  let offset = 0;
  let updated = 0;
  let skipped = 0;

  for (;;) {
    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .select("order_id, raw_data, created_at, order_reference")
      .gte("created_at", ORDER_REFERENCE_EGYPT_START.toISOString())
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (error) {
      throw new Error(error.message);
    }
    if (!data?.length) {
      break;
    }

    for (const row of data) {
      if (readOrderReferenceFromRow(row) != null) {
        skipped += 1;
        continue;
      }

      const ref = nextRef++;
      const raw_data = applyOrderReferenceToRawData(row.raw_data || {}, ref);

      const { error: upErr } = await supabase
        .from(ORDERS_TABLE)
        .update({
          order_reference: ref,
          raw_data,
        })
        .eq("order_id", row.order_id);

      if (upErr) {
        console.error("Failed", row.order_id, upErr.message);
        continue;
      }
      updated += 1;
    }

    if (data.length < PAGE) {
      break;
    }
    offset += PAGE;
  }

  console.log(
    JSON.stringify(
      {
        startFrom: ORDER_REFERENCE_START,
        egyptStartUtc: ORDER_REFERENCE_EGYPT_START.toISOString(),
        updated,
        skippedAlreadyHadRef: skipped,
        nextAvailable: nextRef,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
