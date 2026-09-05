const easyorderService = require("../services/easyorder.service");
const {
  addWebhookOrder,
  getWebhookOrders,
  getWebhookOrdersForExport,
  updateOrderStatus,
  editOrder,
  getOrdersStatistics,
  getOrdersStatsTimeSeries,
  getOrdersAnalyticsReport,
  getProductSalesChart,
  getOrderCostMetrics,
  getWebhookOrderByReference,
  getWebhookOrderById,
  ALLOWED_ORDER_STATUSES,
  ORDER_SOURCES,
  ORDER_TYPES,
  SHIPPING_STATUSES,
  CUSTOMER_STATUSES,
  getOrdersFilterLists,
  normalizeOrderStatusInput,
  normalizeCustomerStatusInput,
  normalizeProductIdList,
  normalizeOrderPlatformInput,
  normalizeUtmSourceFilter,
  ORDER_PLATFORMS,
} = require("../services/webhookOrders.service");
const { toPresentation, withCustomerConfirmation } = require("../services/easyorderPresentation.service");
const { isShopifyOrder } = require("../services/shopify.service");

/**
 * Sync WhatsApp confirmation status from EasyOrders API (order.status).
 */
async function enrichOrderCustomerConfirmation(order, options = {}) {
  if (!order) {
    return { order: null, easyOrdersConfirm: null };
  }

  const eo = await easyorderService.enrichOrderWithEasyOrdersCustomerStatus(
    order,
    options,
  );
  return {
    order: eo.order,
    easyOrdersConfirm: eo.easyOrdersConfirm,
  };
}
const {
  resolveEasyOrderDateRange,
  getEgyptDayRange,
  getEgyptCalendarDateKey,
  getEgyptMonthToDateRange,
  isEasyOrderApiRequest,
  resolveSingleDayFromQueryValue,
  TREND_GRANULARITY_OPTIONS,
  TREND_GRANULARITY_VALUES,
  normalizeTrendGranularity,
  resolveSelectedTrendDateRange,
} = require("../utils/dateRange");
const {
  saveOrderCostDailyEntry,
  getOrderCostChartFromStorage,
} = require("../services/orderCostDaily.service");
const { withCache } = require("../services/dashboardCache.service");
const {
  buildOrdersExcelBuffer,
  buildOrdersTrendExcelBuffer,
} = require("../services/ordersExport.service");

/** مثال لجسم POST /api/orders — الحقول الاختيارية: order_source (افتراضي store)، order_type (افتراضي new)، shipping_status (افتراضي in_progress)، status (افتراضي new). */
const POST_ORDER_MANUAL_EXAMPLE = {
  id: "12345",
  full_name: "اسم العميل",
  phone: "01000000000",
  phone2: "01098765432",
  address: "العنوان",
  city: "القاهرة",
  is_manual: true,
  customerStatus: "confirmed",
  customer_status: "confirmed",
  cart_items: [
    {
      product_id: 101,
      quantity: 1,
      product: { name: "منتج", sku: "SKU-001" },
    },
  ],
};

function publicRequestUrl(req) {
  const host = req.get("x-forwarded-host") || req.get("host") || "localhost";
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  return `${proto}://${host}${req.originalUrl}`;
}

/** إعادة بناء رابط القائمة من المعاملات المفسَّرة (أوضح من originalUrl خلف البروكسي، ويُظهر employee_id وغيره). */
function buildCanonicalOrdersListUrl(req) {
  const host = req.get("x-forwarded-host") || req.get("host") || "localhost";
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  const pathPart = `${req.baseUrl || ""}${req.path === "/" ? "" : req.path}`;

  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(req.query || {})) {
    if (raw === undefined || raw === null) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values) {
      if (v === undefined || v === null) continue;
      const s = String(v).trim();
      if (s === "") continue;
      params.append(key, s);
    }
  }

  const qs = params.toString();
  return `${proto}://${host}${pathPart}${qs ? `?${qs}` : ""}`;
}

function shallowQueryEcho(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.query || {})) {
    if (Array.isArray(v)) out[k] = [...v];
    else out[k] = v;
  }
  return out;
}

function postOrdersAbsoluteUrl(req) {
  const host = req.get("x-forwarded-host") || req.get("host") || "localhost";
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  return `${proto}://${host}/api/orders`;
}

/** معامل استعلام فارغ أو مسافات فقط = لا فلتر (undefined) */
function optionalQueryParam(value) {
  if (value == null) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  const s = String(raw).trim();
  return s === "" ? undefined : s;
}

function readTrendGranularityParam(req) {
  return optionalQueryParam(
    req.query.granularity ||
      req.query.period ||
      req.query.interval ||
      req.query.trend,
  );
}

function resolveTrendGranularityOrReply(req, res) {
  const granRaw = readTrendGranularityParam(req);
  const granularity = normalizeTrendGranularity(granRaw);
  if (!granularity) {
    res.status(400).json({
      success: false,
      message: "Invalid granularity filter",
      allowedGranularities: TREND_GRANULARITY_VALUES,
      options: TREND_GRANULARITY_OPTIONS,
    });
    return null;
  }
  return granularity;
}

function trendFilterLists() {
  return {
    ...getOrdersFilterLists(),
    granularity: {
      key: "granularity",
      aliases: ["period", "interval"],
      labelAr: "الفترة",
      options: TREND_GRANULARITY_OPTIONS,
    },
  };
}

function getDefaultDateRange() {
  const now = new Date();

  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  from.setHours(0, 0, 0, 0);

  const to = new Date();
  to.setHours(23, 59, 59, 999);

  return { from, to };
}

function resolveOrdersListDateRange(req) {
  if (isEasyOrderApiRequest(req)) {
    return resolveEasyOrderDateRange(req);
  }
  const defaultRange = getDefaultDateRange();
  return {
    from: req.query.from ? new Date(req.query.from) : defaultRange.from,
    to: req.query.to ? new Date(req.query.to) : defaultRange.to,
  };
}

function resolveOrdersStatsDateRange(req) {
  if (isEasyOrderApiRequest(req)) {
    return resolveEasyOrderDateRange(req);
  }

  let from = null;
  let to = null;

  if (req.query.from) {
    from = new Date(req.query.from);
    if (Number.isNaN(from.getTime())) {
      const err = new Error("Invalid from date");
      err.code = "INVALID_FROM";
      throw err;
    }
  }

  if (req.query.to) {
    to = new Date(req.query.to);
    if (Number.isNaN(to.getTime())) {
      const err = new Error("Invalid to date");
      err.code = "INVALID_TO";
      throw err;
    }
  }

  return { from, to };
}

function resolveOrdersTrendDateRange(req) {
  return resolveSelectedTrendDateRange(mergeOrdersFilterSource(req), {
    useEgypt: isEasyOrderApiRequest(req),
  });
}

function resolveOrderCostsDateRange(req) {
  const dateParam = optionalQueryParam(req.query.date);
  if (dateParam) {
    if (isEasyOrderApiRequest(req)) {
      return getEgyptDayRange(dateParam);
    }
    const d = new Date(dateParam);
    if (Number.isNaN(d.getTime())) {
      const err = new Error('date must be "YYYY-MM-DD" or a valid ISO date');
      err.code = "INVALID_DATE";
      throw err;
    }
    const from = new Date(d);
    from.setHours(0, 0, 0, 0);
    const to = new Date(d);
    to.setHours(23, 59, 59, 999);
    return { from, to };
  }
  return resolveOrdersTrendDateRange(req);
}

/** افتراضي جراف التكلفة: من بداية الشهر (مصر) — مطابق لـ /stats */
function resolveOrderCostChartDateRange(req) {
  const dateParam = optionalQueryParam(req.query.date);
  if (dateParam) {
    if (isEasyOrderApiRequest(req)) {
      return getEgyptDayRange(dateParam);
    }
    const d = new Date(dateParam);
    if (Number.isNaN(d.getTime())) {
      const err = new Error('date must be "YYYY-MM-DD" or a valid ISO date');
      err.code = "INVALID_DATE";
      throw err;
    }
    const from = new Date(d);
    from.setHours(0, 0, 0, 0);
    const to = new Date(d);
    to.setHours(23, 59, 59, 999);
    return { from, to };
  }

  const fromRaw = req.query?.from;
  const toRaw = req.query?.to;
  const hasFrom =
    fromRaw != null &&
    String(Array.isArray(fromRaw) ? fromRaw[0] : fromRaw).trim() !== "";
  const hasTo =
    toRaw != null &&
    String(Array.isArray(toRaw) ? toRaw[0] : toRaw).trim() !== "";

  if (isEasyOrderApiRequest(req)) {
    if (hasFrom && !hasTo) {
      return resolveSingleDayFromQueryValue(fromRaw);
    }
    if (!hasFrom && hasTo) {
      return resolveSingleDayFromQueryValue(toRaw);
    }
    if (hasFrom && hasTo) {
      const fromStr = String(
        Array.isArray(fromRaw) ? fromRaw[0] : fromRaw,
      ).trim();
      const toStr = String(Array.isArray(toRaw) ? toRaw[0] : toRaw).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(fromStr) && fromStr === toStr) {
        return getEgyptDayRange(fromStr);
      }
    }
  }

  if (!hasFrom && !hasTo) {
    if (isEasyOrderApiRequest(req)) {
      return getEgyptMonthToDateRange();
    }
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - 29);
    from.setHours(0, 0, 0, 0);
    return { from, to: now };
  }

  return resolveOrdersTrendDateRange(req);
}

function parseProductIdsFromRequest(req) {
  const source = mergeOrdersFilterSource(req);
  return normalizeProductIdList(
    source.product_ids,
    source["product_ids[]"],
    source.productIds,
    source.easyorder_ids,
    source.easyorderIds,
    source.product_id,
    source.productId,
    source.easyorder_id,
    source.easyorderId,
  );
}

function mergeOrdersFilterSource(req) {
  const query =
    req.query && typeof req.query === "object" && !Array.isArray(req.query)
      ? req.query
      : {};
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
  const method = String(req.method || "GET").toUpperCase();
  // GET: query only. Merging body let axios leftover product_ids/from/to
  // re-apply on trend and made the dashboard scan huge JSONB filters.
  if (method === "GET" || method === "HEAD") {
    return { ...query };
  }
  return { ...query, ...body };
}

function pickStatusFilter(source) {
  if (!source || typeof source !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(source, "status")) {
    return optionalQueryParam(source.status);
  }
  return (
    optionalQueryParam(source.orderStatus) ??
    optionalQueryParam(source.order_status)
  );
}

/** Treat UI sentinels like "all" / "كل الموظفين" value as no filter. */
function optionalSentinelFilter(value) {
  const s = optionalQueryParam(value);
  if (!s) return undefined;
  const lower = s.toLowerCase();
  if (
    lower === "all" ||
    lower === "any" ||
    lower === "*" ||
    lower === "everyone" ||
    lower === "none" ||
    lower === "null" ||
    lower === "undefined"
  ) {
    return undefined;
  }
  return s;
}

/** @deprecated alias */
function optionalEnumFilter(value) {
  return optionalSentinelFilter(value);
}

function buildOrdersListFilters(req, pagination = {}) {
  const source = mergeOrdersFilterSource(req);
  const page = Number(pagination.page ?? source.page) || 1;
  const limit = Number(pagination.limit ?? source.limit) || 50;

  const filterReq = {
    ...req,
    query: source,
    originalUrl: req.originalUrl,
    baseUrl: req.baseUrl,
  };

  const range = resolveOrdersListDateRange(filterReq);
  let from = range.from;
  let to = range.to;

  if (from && !to) {
    to = new Date();
  }
  if (!from && to) {
    from = getEgyptMonthToDateRange().from;
  }

  if (
    !from ||
    !to ||
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime())
  ) {
    const err = new Error("Invalid from or to date");
    err.code = "INVALID_DATE_RANGE";
    throw err;
  }

  const statusRaw = pickStatusFilter(source);
  const status = statusRaw ? normalizeOrderStatusInput(statusRaw) : undefined;
  const employeeId = optionalSentinelFilter(
    source.employeeId || source.employee_id || source.userId,
  );
  const order_source = optionalSentinelFilter(
    source.order_source || source.orderSource,
  );
  const order_type = optionalSentinelFilter(source.order_type || source.orderType);
  const shipping_status = optionalSentinelFilter(
    source.shipping_status || source.shippingStatus,
  );
  const customerStatusRaw = optionalSentinelFilter(
    source.customer_status || source.customerStatus,
  );
  const customer_status = customerStatusRaw
    ? normalizeCustomerStatusInput(customerStatusRaw)
    : undefined;
  const easyorder_id = optionalSentinelFilter(
    source.easyorder_id || source.easyorderId,
  );
  const product_id =
    optionalSentinelFilter(source.product_id || source.productId) ||
    easyorder_id;
  const product_sku = optionalQueryParam(
    source.product_sku || source.productSku,
  );
  const phone = optionalQueryParam(
    source.phone ||
      source.mobile ||
      source.customerPhone ||
      source.customer_phone,
  );
  const customer_name = optionalQueryParam(
    source.customer_name ||
      source.customerName ||
      source.full_name ||
      source.fullName ||
      source.name,
  );
  const employee_scope = optionalQueryParam(
    source.employee_scope || source.employeeScope,
  );
  const ignoreEmployeeLogDateRange =
    employee_scope === "all" ||
    employee_scope === "any" ||
    employee_scope === "all_time";
  const platformRaw = optionalSentinelFilter(
    source.platform || source.order_platform || source.orderPlatform,
  );
  const platform = platformRaw
    ? normalizeOrderPlatformInput(platformRaw)
    : undefined;
  const utm_source =
    normalizeUtmSourceFilter(
      source.utm_source || source.utmSource || source.utm,
    ) || undefined;

  if (status && !ALLOWED_ORDER_STATUSES.includes(status)) {
    const err = new Error(
      `Invalid status filter${statusRaw ? `: ${statusRaw}` : ""}`,
    );
    err.code = "INVALID_STATUS";
    throw err;
  }

  if (order_source && !ORDER_SOURCES.includes(String(order_source).trim())) {
    const err = new Error("Invalid order_source filter");
    err.code = "INVALID_ORDER_SOURCE";
    throw err;
  }

  if (order_type && !ORDER_TYPES.includes(String(order_type).trim())) {
    const err = new Error("Invalid order_type filter");
    err.code = "INVALID_ORDER_TYPE";
    throw err;
  }

  if (
    shipping_status &&
    !SHIPPING_STATUSES.includes(String(shipping_status).trim())
  ) {
    const err = new Error("Invalid shipping_status filter");
    err.code = "INVALID_SHIPPING_STATUS";
    throw err;
  }

  if (
    customer_status &&
    !CUSTOMER_STATUSES.includes(String(customer_status).trim())
  ) {
    const err = new Error("Invalid customer_status filter");
    err.code = "INVALID_CUSTOMER_STATUS";
    throw err;
  }

  if (platformRaw && !platform) {
    const err = new Error("Invalid platform filter");
    err.code = "INVALID_PLATFORM";
    throw err;
  }

  const filters = {
    page,
    limit,
    from,
    to,
    status,
    employeeId,
    order_source,
    order_type,
    shipping_status,
    customer_status,
    product_id,
    product_sku,
    phone,
    customer_name,
    platform,
    utm_source,
    ignoreEmployeeLogDateRange,
  };

  const appliedFilters = {
    from: from.toISOString(),
    to: to.toISOString(),
    status,
    employeeId,
    employee_id: employeeId,
    employee_scope: employee_scope || undefined,
    ignoreEmployeeLogDateRange: ignoreEmployeeLogDateRange || undefined,
    order_source,
    order_type,
    shipping_status,
    customer_status,
    product_id,
    easyorder_id: easyorder_id || undefined,
    product_sku,
    phone,
    customer_name,
    platform: platform || null,
    utm_source: utm_source || null,
    page,
    limit,
  };

  return { filters, appliedFilters, employee_scope };
}

async function getOrders(req, res) {
  try {
    let filters;
    let appliedFilters;
    try {
      ({ filters, appliedFilters } = buildOrdersListFilters(req));
    } catch (error) {
      if (error.code === "INVALID_FROM" || error.code === "INVALID_TO") {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      if (error.code === "INVALID_DATE_RANGE") {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      if (error.code === "INVALID_STATUS") {
        res.status(400).json({
          success: false,
          message: error.message,
          allowedStatuses: ALLOWED_ORDER_STATUSES,
        });
        return;
      }
      if (error.code === "INVALID_ORDER_SOURCE") {
        res.status(400).json({
          success: false,
          message: error.message,
          allowedOrderSources: ORDER_SOURCES,
        });
        return;
      }
      if (error.code === "INVALID_ORDER_TYPE") {
        res.status(400).json({
          success: false,
          message: error.message,
          allowedOrderTypes: ORDER_TYPES,
        });
        return;
      }
      if (error.code === "INVALID_SHIPPING_STATUS") {
        res.status(400).json({
          success: false,
          message: error.message,
          allowedShippingStatuses: SHIPPING_STATUSES,
        });
        return;
      }
      if (error.code === "INVALID_CUSTOMER_STATUS") {
        res.status(400).json({
          success: false,
          message: error.message,
          allowedCustomerStatuses: CUSTOMER_STATUSES,
        });
        return;
      }
      if (error.code === "INVALID_PLATFORM") {
        res.status(400).json({
          success: false,
          message: error.message,
          allowedPlatforms: ORDER_PLATFORMS,
        });
        return;
      }
      throw error;
    }

    const result = await getWebhookOrders(filters);

    res.json({
      success: true,
      appliedRequest: {
        method: "GET",
        url: buildCanonicalOrdersListUrl(req),
        originalUrl: publicRequestUrl(req),
        queryReceived: shallowQueryEcho(req),
      },
      appliedFilters,
      filterLists: getOrdersFilterLists(),
      listOrdersQueryReference:
        "GET /api/orders?... utm_source|utmSource (exact match on raw_data, e.g. ig|fb|tiktok). phone|mobile|customer_phone and customer_name|customerName|full_name|fullName|name (partial match on customer name in raw_data). employeeId|employee_id (UUID or email). employee_scope=all|any|all_time: with employee, from/to apply to activity logs only. Without employee_scope: from/to on order_status_logs.changed_at. Without employee: from/to on orders.created_at. product_id or easyorder_id (UUID): cart match via @> (no SKU required).",
      ...result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
      error:
        error?.message ||
        error?.cause?.message ||
        String(error) ||
        "Unknown error",
    });
  }
}

/**
 * GET /api/orders/export
 * GET /api/easyorder/orders/export
 * Same query filters as GET /orders — returns Excel (.xlsx).
 */
async function exportOrders(req, res) {
  try {
    let filters;
    try {
      ({ filters } = buildOrdersListFilters(req));
    } catch (error) {
      if (
        error.code === "INVALID_FROM" ||
        error.code === "INVALID_TO" ||
        error.code === "INVALID_DATE_RANGE"
      ) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      if (error.code === "INVALID_STATUS") {
        res.status(400).json({
          success: false,
          message: error.message,
          allowedStatuses: ALLOWED_ORDER_STATUSES,
        });
        return;
      }
      if (error.code === "INVALID_ORDER_SOURCE") {
        res.status(400).json({
          success: false,
          message: error.message,
          allowedOrderSources: ORDER_SOURCES,
        });
        return;
      }
      if (error.code === "INVALID_ORDER_TYPE") {
        res.status(400).json({
          success: false,
          message: error.message,
          allowedOrderTypes: ORDER_TYPES,
        });
        return;
      }
      if (error.code === "INVALID_SHIPPING_STATUS") {
        res.status(400).json({
          success: false,
          message: error.message,
          allowedShippingStatuses: SHIPPING_STATUSES,
        });
        return;
      }
      if (error.code === "INVALID_CUSTOMER_STATUS") {
        res.status(400).json({
          success: false,
          message: error.message,
          allowedCustomerStatuses: CUSTOMER_STATUSES,
        });
        return;
      }
      if (error.code === "INVALID_PLATFORM") {
        res.status(400).json({
          success: false,
          message: error.message,
          allowedPlatforms: ORDER_PLATFORMS,
        });
        return;
      }
      throw error;
    }

    const maxRows = Math.min(
      Math.max(
        1,
        Number(
          mergeOrdersFilterSource(req).maxRows ??
            mergeOrdersFilterSource(req).max_rows,
        ) || 10000,
      ),
      20000,
    );

    const exportResult = await getWebhookOrdersForExport(filters, { maxRows });
    const buffer = buildOrdersExcelBuffer(exportResult.data);
    const dateKey = getEgyptCalendarDateKey(new Date()) || "export";
    const filename = `orders-${dateKey}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.setHeader("X-Export-Total", String(exportResult.total));
    res.setHeader("X-Export-Rows", String(exportResult.exported));
    if (exportResult.truncated) {
      res.setHeader("X-Export-Truncated", "true");
    }

    res.send(buffer);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to export orders",
      error: error.message,
    });
  }
}

async function changeOrderStatus(req, res) {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    if (!status) {
      res.status(400).json({
        success: false,
        message: "status is required",
        allowedStatuses: ALLOWED_ORDER_STATUSES,
      });
      return;
    }

    const changedBy = req.user?.id;
    const updatedOrder = await updateOrderStatus(orderId, status, changedBy);

    res.json({
      success: true,
      message: "Order status updated successfully",
      data: updatedOrder,
    });
  } catch (error) {
    if (error.code === "INVALID_STATUS") {
      res.status(400).json({
        success: false,
        message: "Invalid status value",
        allowedStatuses: ALLOWED_ORDER_STATUSES,
      });
      return;
    }

    if (error.code === "ORDER_NOT_FOUND") {
      res.status(404).json({
        success: false,
        message: "Order not found",
      });
      return;
    }

    if (error.code === "UNAUTHORIZED") {
      res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to update order status",
      error: error.message,
    });
  }
}

async function createOrder(req, res) {
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({
        success: false,
        message: "Order payload is required",
      });
      return;
    }

    const actor =
      req.user?.id != null && String(req.user.id).trim() !== ""
        ? { id: req.user.id, email: req.user.email }
        : null;
    const createdOrder = await addWebhookOrder(req.body, {
      fromWebhook: false,
      actor,
    });

    res.status(201).json({
      success: true,
      message: "Order created successfully",
      appliedRequest: {
        method: "POST",
        url: postOrdersAbsoluteUrl(req),
        headers: { "Content-Type": "application/json" },
        notes: {
          ar: "إنشاء يدوي من POST /api/orders: يُعلَّم تلقائيًا is_manual=true و customerStatus=confirmed (بغض النظر عن القيمة المرسلة). افتراضيًا: مصدر متجر، نوع جديد، شحن in_progress، حالة الطلب new. طلبات EasyOrders عبر الويب هوك تظل تتحدّث customerStatus من status عاديًا.",
          manualRequiredFields: [],
          manualOptionalMeta: [
            "order_source",
            "order_type",
            "shipping_status",
            "status",
            "orderStatus",
            "is_manual",
            "customerStatus",
            "customer_status",
          ],
          allowedOrderSources: ORDER_SOURCES,
          allowedOrderTypes: ORDER_TYPES,
          allowedShippingStatuses: SHIPPING_STATUSES,
        },
      },
      createOrderBodyExample: POST_ORDER_MANUAL_EXAMPLE,
      data: createdOrder,
    });
  } catch (error) {
    if (error.code === "INVALID_ORDER_META") {
      res.status(400).json({
        success: false,
        message: error.message,
        allowedOrderSources: ORDER_SOURCES,
        allowedOrderTypes: ORDER_TYPES,
        allowedShippingStatuses: SHIPPING_STATUSES,
      });
      return;
    }

    if (error.code === "INVALID_STATUS") {
      res.status(400).json({
        success: false,
        message: "Invalid status value",
        allowedStatuses: ALLOWED_ORDER_STATUSES,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to create order",
      error: error.message,
    });
  }
}

async function updateOrder(req, res) {
  try {
    const { orderId } = req.params;
    const updates = req.body;

    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      res.status(400).json({
        success: false,
        message: "Order updates payload is required",
      });
      return;
    }

    const actor =
      req.user?.id != null && String(req.user.id).trim() !== ""
        ? { id: req.user.id, email: req.user.email }
        : null;
    const updatedOrder = await editOrder(orderId, updates, actor);

    res.json({
      success: true,
      message: "Order updated successfully",
      data: updatedOrder,
    });
  } catch (error) {
    if (error.code === "INVALID_UPDATES") {
      res.status(400).json({
        success: false,
        message: "Invalid updates payload",
      });
      return;
    }

    if (error.code === "INVALID_STATUS") {
      res.status(400).json({
        success: false,
        message: "Invalid status value",
        allowedStatuses: ALLOWED_ORDER_STATUSES,
      });
      return;
    }

    if (error.code === "ORDER_NOT_FOUND") {
      res.status(404).json({
        success: false,
        message: "Order not found",
      });
      return;
    }

    if (error.code === "UNAUTHORIZED") {
      res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
      return;
    }

    if (error.code === "INVALID_ORDER_META") {
      res.status(400).json({
        success: false,
        message: error.message,
        allowedOrderSources: ORDER_SOURCES,
        allowedOrderTypes: ORDER_TYPES,
        allowedShippingStatuses: SHIPPING_STATUSES,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to update order",
      error: error.message,
    });
  }
}

/**
 * GET /api/orders/reference/:orderReference
 * GET /api/orders/reference?order_reference=1001
 * Returns order from our DB by sequential order_reference (1001+).
 */
async function getOrderByReference(req, res) {
  try {
    const rawRef =
      req.params.orderReference ??
      req.query.order_reference ??
      req.query.orderReference;

    if (rawRef == null || String(rawRef).trim() === "") {
      res.status(400).json({
        success: false,
        message: "order_reference is required",
      });
      return;
    }

    const order = await getWebhookOrderByReference(rawRef);
    const { order: enrichedOrder, easyOrdersConfirm } =
      await enrichOrderCustomerConfirmation(order);

    if (req.query.presented === "true") {
      const presented = withCustomerConfirmation(
        toPresentation(enrichedOrder) || enrichedOrder,
        { easyOrdersConfirm },
      );
      res.json({
        success: true,
        order_reference:
          enrichedOrder.order_reference ?? enrichedOrder.orderReference,
        data: presented,
      });
      return;
    }

    res.json({
      success: true,
      order_reference:
        enrichedOrder.order_reference ?? enrichedOrder.orderReference,
      data: {
        ...enrichedOrder,
        customer_status: enrichedOrder.customer_status,
        customerStatus: enrichedOrder.customerStatus,
        easyOrdersConfirm,
      },
    });
  } catch (error) {
    if (error.code === "INVALID_ORDER_REFERENCE") {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error.code === "ORDER_NOT_FOUND") {
      res.status(404).json({
        success: false,
        message: "Order not found",
        order_reference: req.params.orderReference ?? req.query.order_reference,
      });
      return;
    }
    if (error.code === "ORDER_REFERENCE_AMBIGUOUS") {
      res.status(409).json({
        success: false,
        message: error.message,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to fetch order by reference",
      error: error.message,
    });
  }
}

async function getEasyOrderDetails(req, res) {
  try {
    const { orderId } = req.params;

    let localOrder = null;
    try {
      localOrder = await getWebhookOrderById(orderId);
    } catch (error) {
      if (error.code !== "ORDER_NOT_FOUND") {
        throw error;
      }
    }

    if (localOrder) {
      const { order: enrichedOrder, easyOrdersConfirm } =
        await enrichOrderCustomerConfirmation(localOrder);

      if (req.query.raw === "true") {
        res.json({
          success: true,
          data: {
            ...enrichedOrder,
            easyOrdersConfirm,
          },
        });
        return;
      }

      const presented = withCustomerConfirmation(
        toPresentation(enrichedOrder) || enrichedOrder,
        { easyOrdersConfirm },
      );
      res.json({
        success: true,
        data: presented,
      });
      return;
    }

    if (isShopifyOrder({ id: orderId, sourceOrderId: orderId })) {
      res.status(404).json({
        success: false,
        message: "Order not found",
        orderId,
      });
      return;
    }

    const orderDetails = await easyorderService.getOrderById(orderId);
    const remoteBase =
      orderDetails?.data && typeof orderDetails.data === "object"
        ? { ...orderDetails, ...orderDetails.data }
        : orderDetails;

    const customerFromEo = easyorderService.mapEasyOrdersStatusToCustomerStatus(
      remoteBase?.status,
    );
    const enrichedRemote = {
      ...remoteBase,
      customer_status: customerFromEo || "pending",
      customerStatus: customerFromEo || "pending",
      easyorders_status: remoteBase?.status ?? null,
    };

    const easyOrdersConfirm = {
      id: remoteBase?.id ?? null,
      shortId: remoteBase?.short_id ?? remoteBase?.shortId ?? null,
      status: remoteBase?.status ?? null,
      customerStatus: customerFromEo || "pending",
      source: "easyorders",
    };

    if (req.query.raw === "true") {
      res.json({
        success: true,
        data: {
          ...enrichedRemote,
          easyOrdersConfirm,
        },
      });
      return;
    }

    const presented = withCustomerConfirmation(toPresentation(enrichedRemote), {
      easyOrdersConfirm,
    });

    if (!presented) {
      res.status(502).json({
        success: false,
        message: "EasyOrders response could not be mapped to an order shape",
        data: orderDetails,
      });
      return;
    }

    res.json({
      success: true,
      data: presented,
    });
    return;
  } catch (error) {
    if (error.code === "ORDER_NOT_FOUND") {
      res.status(404).json({
        success: false,
        message: "Order not found",
        orderId: req.params.orderId,
      });
      return;
    }
    res.status(error.response?.status || 500).json({
      success: false,
      message: "Failed to fetch order details",
      error: error.response?.data || error.message,
    });
  }
}

/**
 * POST /api/orders/:orderId/refresh-customer-status
 * UI button «إظهار الحالة»: fetch EasyOrders status and update customerStatus.
 */
async function refreshCustomerStatus(req, res) {
  try {
    const orderId = String(req.params.orderId || "").trim();
    if (!orderId) {
      res.status(400).json({
        success: false,
        message: "orderId is required",
      });
      return;
    }

    const result =
      await easyorderService.refreshCustomerStatusFromEasyOrders(orderId);

    const presented = withCustomerConfirmation(
      toPresentation(result.order) || result.order,
      { easyOrdersConfirm: result.easyOrdersConfirm },
    );
    const source = result.source || result.easyOrdersConfirm?.source || "easyorders";
    const sourceLabel =
      source === "easyconfirm"
        ? "EasyConfirm"
        : source === "shopify"
          ? "Shopify"
          : "EasyOrders";

    res.json({
      success: true,
      message: result.changed
        ? `تم تحديث حالة العميل من ${sourceLabel}`
        : "حالة العميل محدّثة (بدون تغيير)",
      data: {
        orderId,
        previousCustomerStatus: result.previousCustomerStatus,
        customerStatus: result.customerStatus,
        customer_status: result.customerStatus,
        easyordersStatus: result.easyOrdersConfirm?.status ?? null,
        changed: result.changed,
        source,
        easyOrdersConfirm: result.easyOrdersConfirm,
        order: presented,
      },
    });
  } catch (error) {
    if (error.code === "ORDER_NOT_FOUND" || error.code === "INVALID_ORDER_ID") {
      res.status(error.statusCode || 404).json({
        success: false,
        message: error.message || "Order not found",
        orderId: req.params.orderId,
      });
      return;
    }

    if (error.code === "MANUAL_ORDER_NO_REFRESH") {
      res.status(error.statusCode || 400).json({
        success: false,
        message: error.message,
        code: error.code,
        orderId: req.params.orderId,
      });
      return;
    }

    const isShopifyOrderId = String(req.params.orderId || "")
      .toLowerCase()
      .startsWith("shopify-");
    const isShopifyError = String(error.code || "").startsWith("SHOPIFY_");
    const sourceLabel =
      isShopifyOrderId || isShopifyError ? "Shopify" : "EasyOrders";
    const status = error.statusCode || error.status || error.response?.status || 500;
    res.status(status >= 400 && status < 600 ? status : 502).json({
      success: false,
      message: `Failed to refresh customer status from ${sourceLabel}`,
      error: error.response?.data || error.message,
      code: error.code || null,
      orderId: req.params.orderId,
    });
  }
}

function normalizeQueryId(value) {
  if (value == null) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  const s = String(raw).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (
    lower === "all" ||
    lower === "any" ||
    lower === "*" ||
    lower === "everyone" ||
    lower === "none" ||
    lower === "null" ||
    lower === "undefined"
  ) {
    return null;
  }
  return s;
}

async function getOrdersStats(req, res) {
  try {
    const employeeId = normalizeQueryId(
      req.query.employeeId || req.query.userId || req.query.employee_id,
    );

    const employee_scope = normalizeQueryId(
      req.query.employee_scope || req.query.employeeScope,
    );
    const ignoreEmployeeLogDateRange =
      employee_scope === "all" ||
      employee_scope === "any" ||
      employee_scope === "all_time";

    const status = optionalQueryParam(req.query.status);
    const order_source = optionalQueryParam(
      req.query.order_source || req.query.orderSource,
    );
    const order_type = optionalQueryParam(
      req.query.order_type || req.query.orderType,
    );
    const shipping_status = optionalQueryParam(
      req.query.shipping_status || req.query.shippingStatus,
    );
    const easyorder_id = optionalQueryParam(
      req.query.easyorder_id || req.query.easyorderId,
    );
    const product_id =
      optionalQueryParam(req.query.product_id || req.query.productId) ||
      easyorder_id;
    const product_sku = optionalQueryParam(
      req.query.product_sku || req.query.productSku,
    );
    const utm_source =
      normalizeUtmSourceFilter(
        req.query.utm_source || req.query.utmSource || req.query.utm,
      ) || undefined;

    if (status && !ALLOWED_ORDER_STATUSES.includes(status)) {
      res.status(400).json({
        success: false,
        message: "Invalid status filter",
        allowedStatuses: ALLOWED_ORDER_STATUSES,
      });
      return;
    }

    if (order_source && !ORDER_SOURCES.includes(String(order_source).trim())) {
      res.status(400).json({
        success: false,
        message: "Invalid order_source filter",
        allowedOrderSources: ORDER_SOURCES,
      });
      return;
    }

    if (order_type && !ORDER_TYPES.includes(String(order_type).trim())) {
      res.status(400).json({
        success: false,
        message: "Invalid order_type filter",
        allowedOrderTypes: ORDER_TYPES,
      });
      return;
    }

    if (
      shipping_status &&
      !SHIPPING_STATUSES.includes(String(shipping_status).trim())
    ) {
      res.status(400).json({
        success: false,
        message: "Invalid shipping_status filter",
        allowedShippingStatuses: SHIPPING_STATUSES,
      });
      return;
    }

    let from;
    let to;
    try {
      ({ from, to } = resolveOrdersStatsDateRange(req));
    } catch (error) {
      if (error.code === "INVALID_FROM" || error.code === "INVALID_TO") {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      throw error;
    }

    const stats = await withCache(
      "orders-stats",
      {
        employeeId,
        ignoreEmployeeLogDateRange,
        from: from?.toISOString() || null,
        to: to?.toISOString() || null,
        order_source,
        order_type,
        shipping_status,
        status,
        product_id,
        product_sku,
        utm_source,
      },
      () =>
        getOrdersStatistics({
          employeeId,
          from,
          to,
          ignoreEmployeeLogDateRange,
          order_source,
          order_type,
          shipping_status,
          status,
          product_id,
          product_sku,
          utm_source,
        }),
    ).then((r) => r.value);

    const statsWithLegacyKeys = {
      ...stats,
      newOrders: stats.new,
      confirmedOrders: stats.Confirmed,
      shippedOrders: stats.Shipped,
      canceledOrders: stats.canceled,
      noReplyOrders: stats.no_replay,
      followUpOrders: stats.follow_up,
      repeaterOrders: stats.repeater,
    };

    res.json({
      success: true,
      filters: {
        employeeId,
        employee_scope: employee_scope || null,
        ignoreEmployeeLogDateRange,
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
        status: status || null,
        order_source: order_source || null,
        order_type: order_type || null,
        shipping_status: shipping_status || null,
        product_id: product_id || null,
        easyorder_id: easyorder_id || null,
        product_sku: product_sku || null,
        utm_source: utm_source || null,
      },
      stats: statsWithLegacyKeys,
      filterLists: getOrdersFilterLists(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to get stats",
      error: error.message,
    });
  }
}

/**
 * GET /api/orders/analytics — aggregated report: required product (UUID), optional
 * employee, optional created_at range.
 */
async function resolveOrdersTrendContext(req, res) {
  const employeeId = normalizeQueryId(
    req.query.employeeId || req.query.userId || req.query.employee_id,
  );
  const employee_scope = normalizeQueryId(
    req.query.employee_scope || req.query.employeeScope,
  );
  const ignoreEmployeeLogDateRange =
    employee_scope === "all" ||
    employee_scope === "any" ||
    employee_scope === "all_time";

  const status = optionalQueryParam(req.query.status);
  const order_source = optionalQueryParam(
    req.query.order_source || req.query.orderSource,
  );
  const order_type = optionalQueryParam(
    req.query.order_type || req.query.orderType,
  );
  const shipping_status = optionalQueryParam(
    req.query.shipping_status || req.query.shippingStatus,
  );
  const productIds = parseProductIdsFromRequest(req);
  const easyorder_id = productIds[0] || null;
  const product_id = productIds[0] || null;
  const product_sku = optionalQueryParam(
    req.query.product_sku || req.query.productSku,
  );
  const utm_source =
    normalizeUtmSourceFilter(
      req.query.utm_source || req.query.utmSource || req.query.utm,
    ) || undefined;

  const granularity = resolveTrendGranularityOrReply(req, res);
  if (!granularity) return null;

  if (status && !ALLOWED_ORDER_STATUSES.includes(status)) {
    res.status(400).json({
      success: false,
      message: "Invalid status filter",
      allowedStatuses: ALLOWED_ORDER_STATUSES,
    });
    return null;
  }

  if (order_source && !ORDER_SOURCES.includes(String(order_source).trim())) {
    res.status(400).json({
      success: false,
      message: "Invalid order_source filter",
      allowedOrderSources: ORDER_SOURCES,
    });
    return null;
  }

  if (order_type && !ORDER_TYPES.includes(String(order_type).trim())) {
    res.status(400).json({
      success: false,
      message: "Invalid order_type filter",
      allowedOrderTypes: ORDER_TYPES,
    });
    return null;
  }

  if (
    shipping_status &&
    !SHIPPING_STATUSES.includes(String(shipping_status).trim())
  ) {
    res.status(400).json({
      success: false,
      message: "Invalid shipping_status filter",
      allowedShippingStatuses: SHIPPING_STATUSES,
    });
    return null;
  }

  let from;
  let to;
  try {
    ({ from, to } = resolveOrdersTrendDateRange(req));
  } catch (error) {
    if (
      error.code === "INVALID_FROM" ||
      error.code === "INVALID_TO" ||
      error.code === "INVALID_DATE_RANGE"
    ) {
      res.status(400).json({ success: false, message: error.message });
      return null;
    }
    throw error;
  }

  const useEgyptBuckets = isEasyOrderApiRequest(req);
  const chart = await withCache(
    "orders-stats-trend",
    {
      employeeId,
      ignoreEmployeeLogDateRange,
      from: from.toISOString(),
      to: to.toISOString(),
      granularity,
      order_source,
      order_type,
      shipping_status,
      status,
      product_id: [...productIds].sort(),
      product_sku,
      utm_source,
      useEgyptBuckets,
    },
    () =>
      getOrdersStatsTimeSeries({
        from,
        to,
        granularity,
        employeeId,
        ignoreEmployeeLogDateRange,
        order_source,
        order_type,
        shipping_status,
        status,
        product_id: productIds,
        product_sku,
        utm_source,
        useEgyptBuckets,
      }),
    180_000,
  ).then((r) => r.value);

  return {
    chart,
    granularity,
    filters: {
      employeeId,
      employee_scope: employee_scope || null,
      ignoreEmployeeLogDateRange,
      from: from.toISOString(),
      to: to.toISOString(),
      granularity,
      status: status || null,
      order_source: order_source || null,
      order_type: order_type || null,
      shipping_status: shipping_status || null,
      product_id: product_id || null,
      product_ids: productIds,
      easyorder_id: easyorder_id || null,
      product_sku: product_sku || null,
      utm_source: utm_source || null,
      period: granularity,
    },
  };
}

/**
 * GET /api/orders/stats/trend — time-series for charts (5 KPIs per bucket).
 * Default from/to: current calendar month. Same filters as /stats (employee, product, meta).
 */
async function getOrdersStatsTrend(req, res) {
  try {
    const result = await resolveOrdersTrendContext(req, res);
    if (!result) return;

    res.json({
      success: true,
      filters: result.filters,
      chart: result.chart,
      filterLists: trendFilterLists(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to build orders stats trend",
      error: error.message,
    });
  }
}

/**
 * GET /api/orders/stats/trend/export
 * GET /api/easyorder/orders/stats/trend/export
 * Same query filters as /stats/trend — returns Excel (.xlsx).
 */
async function exportOrdersStatsTrend(req, res) {
  try {
    const result = await resolveOrdersTrendContext(req, res);
    if (!result) return;

    const buffer = buildOrdersTrendExcelBuffer(
      result.chart,
      result.granularity,
    );
    const dateKey = getEgyptCalendarDateKey(new Date()) || "export";
    const filename = `orders-trend-${result.granularity}-${dateKey}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.setHeader(
      "X-Export-Rows",
      String(Array.isArray(result.chart?.points) ? result.chart.points.length : 0),
    );
    res.setHeader("X-Export-Granularity", result.granularity);

    res.send(buffer);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to export orders stats trend",
      error: error.message,
    });
  }
}

async function getOrdersAnalytics(req, res) {
  try {
    const easyorder_id = optionalQueryParam(
      req.query.easyorder_id || req.query.easyorderId,
    );
    const product_id =
      optionalQueryParam(req.query.product_id || req.query.productId) ||
      easyorder_id;
    const product_sku = optionalQueryParam(
      req.query.product_sku || req.query.productSku,
    );

    if (!product_id && !product_sku) {
      res.status(400).json({
        success: false,
        message:
          "product_id or easyorder_id is required (catalog UUID). product_sku is optional.",
      });
      return;
    }

    const employeeId = normalizeQueryId(
      req.query.employeeId || req.query.userId || req.query.employee_id,
    );

    const employee_scope = normalizeQueryId(
      req.query.employee_scope || req.query.employeeScope,
    );
    const ignoreEmployeeLogDateRange =
      employee_scope === "all" ||
      employee_scope === "any" ||
      employee_scope === "all_time";

    let from = null;
    let to = null;

    if (req.query.from) {
      from = new Date(req.query.from);
      if (Number.isNaN(from.getTime())) {
        res.status(400).json({
          success: false,
          message: "Invalid from date",
        });
        return;
      }
    }

    if (req.query.to) {
      to = new Date(req.query.to);
      if (Number.isNaN(to.getTime())) {
        res.status(400).json({
          success: false,
          message: "Invalid to date",
        });
        return;
      }
    }

    const report = await getOrdersAnalyticsReport({
      product_id,
      product_sku,
      employeeId,
      from,
      to,
      ignoreEmployeeLogDateRange,
    });

    res.json({
      success: true,
      filters: {
        product_id: product_id || null,
        easyorder_id: easyorder_id || null,
        product_sku: product_sku || null,
        employeeId,
        employee_scope: employee_scope || null,
        ignoreEmployeeLogDateRange,
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
      },
      summary: {
        totalCost: report.totalCost,
        totalOrders: report.totalOrders,
        totalProductUnits: report.totalProductUnits,
        averageUnitsPerOrder: report.averageUnitsPerOrder,
        averageOrderValue: report.averageOrderValue,
      },
      byOrderSource: report.byOrderSource,
      byOrderType: report.byOrderType,
      byOrderStatus: report.byOrderStatus,
      byShippingStatus: report.byShippingStatus,
      meta: {
        truncated: report.truncated,
        maxRowsCap: report.maxRowsCap,
        note: "Bucket key __unset is used when a value is missing in raw_data or status.",
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to build orders analytics",
      error: error.message,
    });
  }
}

/**
 * GET /api/orders/charts/product-sales
 * GET /api/easyorder/charts/product-sales
 *
 * Sales chart data per product (orders / units / revenue per day|week|month).
 * Default: all products, current calendar month (Egypt TZ on /api/easyorder/*).
 * Optional product_id (or easyorder_id) narrows to one product for the graph.
 */
async function getProductSalesChartHandler(req, res) {
  try {
    const productIds = parseProductIdsFromRequest(req);
    const product_id = productIds.length === 1 ? productIds[0] : null;
    const easyorder_id = productIds[0] || null;

    const granularity = resolveTrendGranularityOrReply(req, res);
    if (!granularity) return;

    let from;
    let to;
    try {
      ({ from, to } = resolveOrdersTrendDateRange(req));
    } catch (error) {
      if (
        error.code === "INVALID_FROM" ||
        error.code === "INVALID_TO" ||
        error.code === "INVALID_DATE_RANGE"
      ) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      throw error;
    }

    const chart = await getProductSalesChart({
      from,
      to,
      granularity,
      product_id: productIds,
      product_ids: productIds,
      useEgyptBuckets: isEasyOrderApiRequest(req),
    });

    res.json({
      success: true,
      filters: {
        from: from.toISOString(),
        to: to.toISOString(),
        granularity,
        product_id: product_id || null,
        product_ids: productIds,
        easyorder_id: easyorder_id || null,
      },
      chart,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to build product sales chart",
      error: error.message,
    });
  }
}

/**
 * GET /api/orders/costs
 * GET /api/easyorder/costs
 *
 * Order cost = expense ÷ all orders in range (any status). expense optional → cost 0.
 */
async function getOrderCosts(req, res) {
  try {
    const expenseRaw = req.query.expense ?? req.query.spent ?? req.query.spend;

    if (
      expenseRaw != null &&
      String(expenseRaw).trim() !== "" &&
      (!Number.isFinite(Number(expenseRaw)) || Number(expenseRaw) < 0)
    ) {
      res.status(400).json({
        success: false,
        message: "expense must be a non-negative number",
      });
      return;
    }

    let from;
    let to;
    try {
      ({ from, to } = resolveOrderCostsDateRange(req));
    } catch (error) {
      if (
        error.code === "INVALID_FROM" ||
        error.code === "INVALID_TO" ||
        error.code === "INVALID_DATE"
      ) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      throw error;
    }

    const dateBasisRaw = optionalQueryParam(
      req.query.date_basis || req.query.dateBasis,
    );
    const dateBasis = dateBasisRaw === "activity" ? "activity" : "created";

    const metrics = await getOrderCostMetrics({
      expense: expenseRaw,
      from,
      to,
      dateBasis,
    });

    res.json({
      success: true,
      filters: {
        expense:
          expenseRaw != null && String(expenseRaw).trim() !== ""
            ? Number(expenseRaw)
            : null,
        date: optionalQueryParam(req.query.date) || null,
        from: from.toISOString(),
        to: to.toISOString(),
        date_basis: dateBasis,
      },
      metrics,
    });
  } catch (error) {
    if (error.code === "INVALID_EXPENSE") {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to compute order costs",
      error: error.message,
    });
  }
}

/**
 * POST /api/easyorder/charts/order-cost
 * Body: { date: "YYYY-MM-DD", expense: number }
 */
async function saveOrderCostDailyHandler(req, res) {
  try {
    const dateRaw = req.body?.date ?? req.query.date ?? req.body?.cost_date;
    const expenseRaw =
      req.body?.expense ??
      req.query.expense ??
      req.body?.spent ??
      req.query.spent;

    if (dateRaw == null || String(dateRaw).trim() === "") {
      res.status(400).json({
        success: false,
        message: "date is required (YYYY-MM-DD)",
      });
      return;
    }

    if (expenseRaw == null || String(expenseRaw).trim() === "") {
      res.status(400).json({
        success: false,
        message: "expense is required (non-negative number)",
      });
      return;
    }

    const expense = Number(expenseRaw);
    if (!Number.isFinite(expense) || expense < 0) {
      res.status(400).json({
        success: false,
        message: "expense must be a non-negative number",
      });
      return;
    }

    const dateBasisRaw = optionalQueryParam(
      req.body?.date_basis ||
        req.body?.dateBasis ||
        req.query.date_basis ||
        req.query.dateBasis,
    );
    const dateBasis = dateBasisRaw === "activity" ? "activity" : "created";

    const result = await saveOrderCostDailyEntry({
      date: dateRaw,
      expense,
      dateBasis,
    });

    res.status(201).json({
      success: true,
      message: "Daily order cost saved",
      data: result.saved,
      chartPoint: result.chartPoint,
    });
  } catch (error) {
    if (error.code === "INVALID_DATE" || error.code === "INVALID_EXPENSE") {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to save daily order cost",
      error: error.message,
    });
  }
}

/**
 * GET /api/easyorder/charts/order-cost — مصروفات مخزنة + أعداد live للأيام غير المسجّلة.
 * فترة: from+to، أو يوم واحد عبر date=YYYY-MM-DD أو from=YYYY-MM-DD (بدون to).
 */
async function getOrderCostChartHandler(req, res) {
  try {
    const granularity = resolveTrendGranularityOrReply(req, res);
    if (!granularity) return;

    const dateBasisRaw = optionalQueryParam(
      req.query.date_basis || req.query.dateBasis,
    );
    const dateBasis = dateBasisRaw === "activity" ? "activity" : "created";

    let from;
    let to;
    try {
      ({ from, to } = resolveOrderCostChartDateRange(req));
    } catch (error) {
      if (
        error.code === "INVALID_FROM" ||
        error.code === "INVALID_TO" ||
        error.code === "INVALID_DATE"
      ) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      throw error;
    }

    const chart = await withCache(
      "order-cost-chart",
      {
        from: from.toISOString(),
        to: to.toISOString(),
        granularity,
        dateBasis,
      },
      () =>
        getOrderCostChartFromStorage({
          from,
          to,
          granularity,
          dateBasis,
        }),
    ).then((r) => r.value);

    const singleDayKey =
      getEgyptCalendarDateKey(from) === getEgyptCalendarDateKey(to)
        ? getEgyptCalendarDateKey(from)
        : null;

    res.json({
      success: true,
      filters: {
        date: optionalQueryParam(req.query.date) || singleDayKey,
        from: from.toISOString(),
        to: to.toISOString(),
        granularity,
        date_basis: dateBasis,
      },
      chart,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to build order cost chart",
      error: error.message,
    });
  }
}

module.exports = {
  createOrder,
  updateOrder,
  getOrders,
  exportOrders,
  getOrderByReference,
  changeOrderStatus,
  getEasyOrderDetails,
  refreshCustomerStatus,
  getOrdersStats,
  getOrdersStatsTrend,
  exportOrdersStatsTrend,
  getOrdersAnalytics,
  getProductSalesChartHandler,
  getOrderCosts,
  getOrderCostChartHandler,
  saveOrderCostDailyHandler,
};
