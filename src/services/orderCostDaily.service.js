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

function zeroChartPoint(date) {
  const z = emptySeriesPoint();
  return {
    date,
    expense: 0,
    expenseEntered: false,
    orders: { ...z },
    shipped: { ...z },
    delivered: { ...z },
    successful: { ...z },
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

function aggregateDailyRowsIntoBuckets(dailyRows, bucketKeys, granularity) {
  const agg = new Map();

  for (const key of bucketKeys) {
    agg.set(key, {
      expense: 0,
      total_orders: 0,
      shipped_orders: 0,
      successful_orders: 0,
      total_sales: 0,
      shipped_sales: 0,
      successful_sales: 0,
    });
  }

  for (const row of dailyRows) {
    const dateStr =
      typeof row.cost_date === "string"
        ? row.cost_date.slice(0, 10)
        : String(row.cost_date).slice(0, 10);
    const bucketKey = getEgyptTrendBucketKey(
      new Date(`${dateStr}T12:00:00.000Z`),
      granularity,
    );
    if (!bucketKey || !agg.has(bucketKey)) continue;

    const b = agg.get(bucketKey);
    b.expense += Number(row.expense) || 0;
    b.total_orders += Number(row.total_orders) || 0;
    b.shipped_orders += Number(row.shipped_orders) || 0;
    b.successful_orders += Number(row.successful_orders) || 0;
    b.total_sales += Number(row.total_sales) || 0;
    b.shipped_sales += Number(row.shipped_sales) || 0;
    b.successful_sales += Number(row.successful_sales) || 0;
  }

  return agg;
}

/**
 * جراف من البيانات المخزنة — أي يوم بلا سجل = أصفار.
 */
async function getOrderCostChartFromStorage({
  from,
  to,
  granularity = "day",
}) {
  const gran =
    granularity === "week" || granularity === "month" ? granularity : "day";

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

  let points;
  let summaryExpense = 0;
  let summaryOrders = emptySeriesPoint();
  let summaryShipped = emptySeriesPoint();
  let summaryDelivered = emptySeriesPoint();

  if (gran === "day") {
    points = bucketKeys.map((date) => {
      const row = byDate.get(date);
      if (!row) {
        return zeroChartPoint(date);
      }
      return chartPointFromDailyRow(row);
    });

    for (const p of points) {
      summaryExpense += Number(p.expense) || 0;
      summaryOrders.totalOrders += p.orders.totalOrders;
      summaryOrders.totalSales += Number(p.orders.totalSales) || 0;
      summaryShipped.totalOrders += p.shipped.totalOrders;
      summaryShipped.totalSales += Number(p.shipped.totalSales) || 0;
      summaryDelivered.totalOrders += p.delivered.totalOrders;
      summaryDelivered.totalSales += Number(p.delivered.totalSales) || 0;
    }
  } else {
    const agg = aggregateDailyRowsIntoBuckets(dailyRows, bucketKeys, gran);
    points = bucketKeys.map((date) => {
      const b = agg.get(date) || {
        expense: 0,
        total_orders: 0,
        shipped_orders: 0,
        successful_orders: 0,
        total_sales: 0,
        shipped_sales: 0,
        successful_sales: 0,
      };
      return chartPointFromDailyRow({
        cost_date: date,
        expense: b.expense,
        total_orders: b.total_orders,
        shipped_orders: b.shipped_orders,
        successful_orders: b.successful_orders,
        total_sales: b.total_sales,
        shipped_sales: b.shipped_sales,
        successful_sales: b.successful_sales,
      });
    });

    for (const p of points) {
      summaryExpense += Number(p.expense) || 0;
      summaryOrders.totalOrders += p.orders.totalOrders;
      summaryOrders.totalSales += Number(p.orders.totalSales) || 0;
      summaryShipped.totalOrders += p.shipped.totalOrders;
      summaryShipped.totalSales += Number(p.shipped.totalSales) || 0;
      summaryDelivered.totalOrders += p.delivered.totalOrders;
      summaryDelivered.totalSales += Number(p.delivered.totalSales) || 0;
    }
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
    source: "database",
    from: from.toISOString(),
    to: to.toISOString(),
    granularity: gran,
    formulaAr:
      "تكلفة الطلب = المصروفات ÷ عدد الطلبات. الأيام بدون إدخال = 0. البيانات من order_cost_daily.",
    points,
    summary: {
      expense: roundMoney(summaryExpense),
      orders: summaryOrders,
      shipped: summaryShipped,
      delivered: summaryDelivered,
      successful: summaryDelivered,
    },
    storedDaysCount: dailyRows.length,
    daysInRange: bucketKeys.length,
  };
}

module.exports = {
  saveOrderCostDailyEntry,
  getOrderCostChartFromStorage,
  parseCostDateYmd,
};
