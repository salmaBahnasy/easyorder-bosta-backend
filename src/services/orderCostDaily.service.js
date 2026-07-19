const supabase = require("../config/supabase");
const {
  getEgyptDayRange,
  getEgyptTrendBucketKey,
  listEgyptTrendBucketKeys,
} = require("../utils/dateRange");
const {
  computeOrderCostBucketMapsForRange,
  computeCostPerOrder,
  roundMoney,
} = require("./webhookOrders.service");

const ORDER_COST_DAILY_TABLE =
  process.env.SUPABASE_ORDER_COST_DAILY_TABLE || "order_cost_daily";

function parseCostDateYmd(value) {
  const m = String(value ?? "")
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) {
    const err = new Error('date must be "YYYY-MM-DD"');
    err.code = "INVALID_DATE";
    throw err;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function emptySeriesPoint() {
  return {
    totalOrders: 0,
    totalSales: 0,
    costPerOrder: 0,
  };
}

function seriesPointFromCounts(expense, totalOrders, totalSales) {
  return {
    totalOrders,
    totalSales: roundMoney(totalSales),
    costPerOrder: computeCostPerOrder(expense, totalOrders),
  };
}

function chartPointFromDailyRow(row) {
  const expense = Number(row.expense) || 0;
  const date =
    typeof row.cost_date === "string"
      ? row.cost_date.slice(0, 10)
      : String(row.cost_date).slice(0, 10);

  const ordersPoint = seriesPointFromCounts(
    expense,
    row.total_orders,
    row.total_sales,
  );
  const shippedPoint = seriesPointFromCounts(
    expense,
    row.shipped_orders,
    row.shipped_sales,
  );
  const deliveredPoint = seriesPointFromCounts(
    expense,
    row.successful_orders,
    row.successful_sales,
  );

  return {
    date,
    expense: roundMoney(expense),
    expenseEntered: expense > 0,
    orders: ordersPoint,
    shipped: shippedPoint,
    delivered: deliveredPoint,
    successful: deliveredPoint,
  };
}

function chartPointFromLiveDay(date, ordersMap, shippedMap, deliveredMap) {
  const orders = ordersMap.get(date) || { totalOrders: 0, totalSales: 0 };
  const shipped = shippedMap.get(date) || { totalOrders: 0, totalSales: 0 };
  const delivered = deliveredMap.get(date) || { totalOrders: 0, totalSales: 0 };

  return {
    date,
    expense: 0,
    expenseEntered: false,
    orders: seriesPointFromCounts(0, orders.totalOrders, orders.totalSales),
    shipped: seriesPointFromCounts(0, shipped.totalOrders, shipped.totalSales),
    delivered: seriesPointFromCounts(
      0,
      delivered.totalOrders,
      delivered.totalSales,
    ),
    successful: seriesPointFromCounts(
      0,
      delivered.totalOrders,
      delivered.totalSales,
    ),
  };
}

function buildDayChartPoint(date, storedRow, ordersMap, shippedMap, deliveredMap) {
  // Prefer fully stored daily row (expense + counts) — avoid live overrides
  if (storedRow) {
    return chartPointFromDailyRow(storedRow);
  }
  return chartPointFromLiveDay(date, ordersMap, shippedMap, deliveredMap);
}

function aggregateDailyChartPoints(dailyPoints, bucketKey, granularity) {
  const inBucket = dailyPoints.filter((p) => {
    const bucket = getEgyptTrendBucketKey(
      new Date(`${p.date}T12:00:00.000Z`),
      granularity,
    );
    return bucket === bucketKey;
  });

  let expense = 0;
  let expenseEntered = false;
  let totalOrders = 0;
  let totalSales = 0;
  let shippedOrders = 0;
  let shippedSales = 0;
  let deliveredOrders = 0;
  let deliveredSales = 0;

  for (const p of inBucket) {
    expense += Number(p.expense) || 0;
    if (p.expenseEntered) expenseEntered = true;
    totalOrders += p.orders.totalOrders;
    totalSales += Number(p.orders.totalSales) || 0;
    shippedOrders += p.shipped.totalOrders;
    shippedSales += Number(p.shipped.totalSales) || 0;
    deliveredOrders += p.delivered.totalOrders;
    deliveredSales += Number(p.delivered.totalSales) || 0;
  }

  const deliveredPoint = seriesPointFromCounts(
    expense,
    deliveredOrders,
    deliveredSales,
  );

  return {
    date: bucketKey,
    expense: roundMoney(expense),
    expenseEntered,
    orders: seriesPointFromCounts(expense, totalOrders, totalSales),
    shipped: seriesPointFromCounts(expense, shippedOrders, shippedSales),
    delivered: deliveredPoint,
    successful: deliveredPoint,
  };
}

function summarizeChartPoints(points) {
  let summaryExpense = 0;
  const summaryOrders = emptySeriesPoint();
  const summaryShipped = emptySeriesPoint();
  const summaryDelivered = emptySeriesPoint();

  for (const p of points) {
    summaryExpense += Number(p.expense) || 0;
    summaryOrders.totalOrders += p.orders.totalOrders;
    summaryOrders.totalSales += Number(p.orders.totalSales) || 0;
    summaryShipped.totalOrders += p.shipped.totalOrders;
    summaryShipped.totalSales += Number(p.shipped.totalSales) || 0;
    summaryDelivered.totalOrders += p.delivered.totalOrders;
    summaryDelivered.totalSales += Number(p.delivered.totalSales) || 0;
  }

  summaryOrders.costPerOrder = computeCostPerOrder(
    summaryExpense,
    summaryOrders.totalOrders,
  );
  summaryShipped.costPerOrder = computeCostPerOrder(
    summaryExpense,
    summaryShipped.totalOrders,
  );
  summaryDelivered.costPerOrder = computeCostPerOrder(
    summaryExpense,
    summaryDelivered.totalOrders,
  );
  summaryOrders.totalSales = roundMoney(summaryOrders.totalSales);
  summaryShipped.totalSales = roundMoney(summaryShipped.totalSales);
  summaryDelivered.totalSales = roundMoney(summaryDelivered.totalSales);

  return {
    expense: roundMoney(summaryExpense),
    orders: summaryOrders,
    shipped: summaryShipped,
    delivered: summaryDelivered,
    successful: summaryDelivered,
  };
}

/**
 * حفظ يوم واحد: يحسب الطلبات من orders ثم يخزن المصروفات + الأعداد.
 */
async function saveOrderCostDailyEntry({
  date,
  expense,
  dateBasis = "created",
}) {
  const costDate = parseCostDateYmd(date);
  const expenseAmount = Number(expense);
  if (!Number.isFinite(expenseAmount) || expenseAmount < 0) {
    const err = new Error("expense must be a non-negative number");
    err.code = "INVALID_EXPENSE";
    throw err;
  }

  const { from, to } = getEgyptDayRange(costDate);
  const { ordersMap, shippedMap, deliveredMap } =
    await computeOrderCostBucketMapsForRange({
      from,
      to,
      dateBasis,
      granularity: "day",
      useEgyptBuckets: true,
    });

  const orders = ordersMap.get(costDate) || { totalOrders: 0, totalSales: 0 };
  const shipped = shippedMap.get(costDate) || { totalOrders: 0, totalSales: 0 };
  const delivered =
    deliveredMap.get(costDate) || { totalOrders: 0, totalSales: 0 };

  const payload = {
    cost_date: costDate,
    expense: expenseAmount,
    total_orders: orders.totalOrders,
    shipped_orders: shipped.totalOrders,
    successful_orders: delivered.totalOrders,
    total_sales: orders.totalSales,
    shipped_sales: shipped.totalSales,
    successful_sales: delivered.totalSales,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from(ORDER_COST_DAILY_TABLE)
    .upsert(payload, { onConflict: "cost_date" })
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  try {
    const { clearDashboardCache } = require("./dashboardCache.service");
    clearDashboardCache();
  } catch {
    // ignore cache clear failures
  }

  return {
    saved: data,
    chartPoint: chartPointFromDailyRow(data),
  };
}

async function fetchOrderCostDailyRows(from, to) {
  const fromDate = getEgyptTrendBucketKey(from, "day");
  const toDate = getEgyptTrendBucketKey(to, "day");
  if (!fromDate || !toDate) {
    const err = new Error("Invalid date range for order cost daily fetch");
    err.code = "INVALID_DATE";
    throw err;
  }

  const { data, error } = await supabase
    .from(ORDER_COST_DAILY_TABLE)
    .select("*")
    .gte("cost_date", fromDate)
    .lte("cost_date", toDate)
    .order("cost_date", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return data || [];
}

/**
 * جراف التكلفة:
 * - لو اليوم موجود في order_cost_daily → مصروفات + أعداد من التخزين (سريع)
 * - الأيام الناقصة فقط → live scan من orders
 */
async function getOrderCostChartFromStorage({
  from,
  to,
  granularity = "day",
  dateBasis = "created",
}) {
  const gran =
    granularity === "week" || granularity === "month" ? granularity : "day";

  const dayKeys = listEgyptTrendBucketKeys(from, to, "day");
  const bucketKeys = listEgyptTrendBucketKeys(from, to, gran);

  const dailyRows = await fetchOrderCostDailyRows(from, to);
  const byDate = new Map();
  for (const row of dailyRows) {
    const dateStr =
      typeof row.cost_date === "string"
        ? row.cost_date.slice(0, 10)
        : String(row.cost_date).slice(0, 10);
    byDate.set(dateStr, row);
  }

  const missingDays = dayKeys.filter((d) => !byDate.has(d));
  let ordersMap = new Map();
  let shippedMap = new Map();
  let deliveredMap = new Map();
  let liveTruncated = false;

  if (missingDays.length > 0) {
    const live = await computeOrderCostBucketMapsForRange({
      from,
      to,
      dateBasis,
      granularity: "day",
      useEgyptBuckets: true,
    });
    ordersMap = live.ordersMap;
    shippedMap = live.shippedMap;
    deliveredMap = live.deliveredMap;
    liveTruncated = Boolean(live.truncated);
  }

  const dailyPoints = dayKeys.map((date) =>
    buildDayChartPoint(date, byDate.get(date), ordersMap, shippedMap, deliveredMap),
  );

  const points =
    gran === "day"
      ? dailyPoints
      : bucketKeys.map((bucketKey) =>
          aggregateDailyChartPoints(dailyPoints, bucketKey, gran),
        );

  const summary = summarizeChartPoints(points);

  return {
    source: missingDays.length === 0 ? "database" : "database+live",
    from: from.toISOString(),
    to: to.toISOString(),
    granularity: gran,
    dateBasis,
    formulaAr:
      "تكلفة الطلب = المصروفات ÷ عدد الطلبات. الأيام المخزّنة من order_cost_daily؛ الأيام الناقصة تُحسب live من الطلبات.",
    points,
    summary,
    storedDaysCount: dailyRows.length,
    liveFilledDaysCount: missingDays.length,
    daysInRange: dayKeys.length,
    bucketsInRange: bucketKeys.length,
    truncated: liveTruncated,
  };
}

module.exports = {
  saveOrderCostDailyEntry,
  getOrderCostChartFromStorage,
  parseCostDateYmd,
};
