/**
 * Deletes every row in order_status_logs then orders (same table names as webhookOrders.service).
 * Requires: node scripts/delete-all-orders.js --yes
 *
 * Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from project root .env (via src/config/supabase).
 */

const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const supabase = require("../src/config/supabase");

const ORDERS_TABLE = process.env.SUPABASE_ORDERS_TABLE || "orders";
const ORDER_STATUS_LOGS_TABLE =
  process.env.SUPABASE_ORDER_STATUS_LOGS_TABLE || "order_status_logs";

const EPOCH = "1970-01-01T00:00:00.000Z";

async function countTable(table) {
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function deleteAllInTable(table, timeColumn) {
  const { error } = await supabase
    .from(table)
    .delete()
    .gte(timeColumn, EPOCH);
  if (error) throw new Error(`${table}: ${error.message}`);
}

async function main() {
  const argv = new Set(process.argv.slice(2));
  const force = argv.has("--yes") || argv.has("-y");

  if (!force) {
    console.error(
      "Refusing to run without --yes. This permanently deletes all orders and status logs.",
    );
    console.error("Usage: node scripts/delete-all-orders.js --yes");
    process.exit(1);
  }

  const beforeLogs = await countTable(ORDER_STATUS_LOGS_TABLE);
  const beforeOrders = await countTable(ORDERS_TABLE);

  console.log(
    `Deleting ALL rows in ${ORDER_STATUS_LOGS_TABLE} (${beforeLogs}) then ${ORDERS_TABLE} (${beforeOrders}).`,
  );

  await deleteAllInTable(ORDER_STATUS_LOGS_TABLE, "changed_at");
  await deleteAllInTable(ORDERS_TABLE, "created_at");

  const afterLogs = await countTable(ORDER_STATUS_LOGS_TABLE);
  const afterOrders = await countTable(ORDERS_TABLE);

  console.log("Done.");
  console.log(
    `${ORDER_STATUS_LOGS_TABLE}: ${beforeLogs} -> ${afterLogs}, ${ORDERS_TABLE}: ${beforeOrders} -> ${afterOrders}`,
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
