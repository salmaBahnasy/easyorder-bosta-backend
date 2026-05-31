const bostaService = require("../services/bosta.service");
const easyorderService = require("../services/easyorder.service");
const {
  addWebhookOrder,
  getWebhookOrders,
  updateOrderStatus,
  editOrder,
  getOrdersStatistics,
  getOrdersStatsTimeSeries,
  getOrdersAnalyticsReport,
  getProductSalesChart,
  getWebhookOrderByReference,
  ALLOWED_ORDER_STATUSES,
  ORDER_SOURCES,
  ORDER_TYPES,
  SHIPPING_STATUSES,
  getOrdersFilterLists,
} = require("../services/webhookOrders.service");
const { toPresentation } = require("../services/easyorderPresentation.service");
const {
  resolveEasyOrderDateRange,
  isEasyOrderApiRequest,
} = require("../utils/dateRange");

/** مثال لجسم POST /api/orders — الحقول الاختيارية: order_source (افتراضي store)، order_type (افتراضي new)، shipping_status (افتراضي in_progress)، status (افتراضي new). */
const POST_ORDER_MANUAL_EXAMPLE = {
  id: "12345",
  full_name: "اسم العميل",
  phone: "01000000000",
  address: "العنوان",
  city: "القاهرة",
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
  if (isEasyOrderApiRequest(req)) {
    return resolveEasyOrderDateRange(req);
  }

  const defaultRange = getDefaultDateRange();
  const from = req.query.from ? new Date(req.query.from) : defaultRange.from;
  const to = req.query.to ? new Date(req.query.to) : defaultRange.to;

  if (Number.isNaN(from.getTime())) {
    const err = new Error("Invalid from date");
    err.code = "INVALID_FROM";
    throw err;
  }
  if (Number.isNaN(to.getTime())) {
    const err = new Error("Invalid to date");
    err.code = "INVALID_TO";
    throw err;
  }

  return { from, to };
}

async function getOrders(req, res) {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 50;

    let from;
    let to;
    try {
      ({ from, to } = resolveOrdersListDateRange(req));
    } catch (error) {
      if (error.code === "INVALID_FROM" || error.code === "INVALID_TO") {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      throw error;
    }

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      res.status(400).json({ success: false, message: "Invalid from or to date" });
      return;
    }

    const status = optionalQueryParam(req.query.status);
    const employeeId = optionalQueryParam(
      req.query.employeeId || req.query.employee_id || req.query.userId,
    );
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
    const phone = optionalQueryParam(
      req.query.phone ||
        req.query.mobile ||
        req.query.customerPhone ||
        req.query.customer_phone,
    );
    const customer_name = optionalQueryParam(
      req.query.customer_name ||
        req.query.customerName ||
        req.query.full_name ||
        req.query.fullName ||
        req.query.name,
    );
    const employee_scope = optionalQueryParam(
      req.query.employee_scope || req.query.employeeScope,
    );
    const ignoreEmployeeLogDateRange =
      employee_scope === "all" ||
      employee_scope === "any" ||
      employee_scope === "all_time";

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

    const result = await getWebhookOrders({
      page,
      limit,
      from,
      to,
      status,
      employeeId,
      order_source,
      order_type,
      shipping_status,
      product_id,
      product_sku,
      phone,
      customer_name,
      ignoreEmployeeLogDateRange,
    });

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
      product_id,
      easyorder_id: easyorder_id || undefined,
      product_sku,
      phone,
      customer_name,
      page,
      limit,
    };

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
        "GET /api/orders?... phone|mobile|customer_phone and customer_name|customerName|full_name|fullName|name (partial match on customer name in raw_data). employeeId|employee_id (UUID or email). employee_scope=all|any|all_time: with employee, from/to apply to activity logs only. Without employee_scope: from/to on order_status_logs.changed_at. Without employee: from/to on orders.created_at. product_id or easyorder_id (UUID): cart match via @> (no SKU required).",
      ...result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
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
          ar: "إنشاء يدوي: افتراضيًا مصدر الطلب متجر (store)، النوع جديد (new)، الشحن قيد التنفيذ (in_progress)، وحالة الطلب new. يمكن تجاوزها بإرسال order_source / order_type / shipping_status / status أو orderStatus (يُفضَّل orderStatus من الواجهة). من الويب هوك: POST /webhooks/easyorders/order-created يضبط المصدر متجرًا. إرسال Authorization: Bearer يملأ created_by_employee_id و user_email في raw_data.",
          manualRequiredFields: [],
          manualOptionalMeta: [
            "order_source",
            "order_type",
            "shipping_status",
            "status",
            "orderStatus",
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

    if (req.query.presented === "true") {
      const presented = toPresentation(order);
      res.json({
        success: true,
        order_reference: order.order_reference ?? order.orderReference,
        data: presented || order,
      });
      return;
    }

    res.json({
      success: true,
      order_reference: order.order_reference ?? order.orderReference,
      data: order,
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

    const orderDetails = await easyorderService.getOrderById(orderId);

    if (req.query.raw === "true") {
      res.json({
        success: true,
        data: orderDetails,
      });
      return;
    }

    const presented = toPresentation(orderDetails);

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
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      message: "Failed to fetch EasyOrders order details",
      error: error.response?.data || error.message,
    });
  }
}

// ـ--------------------
async function sendOrderToBosta(req, res) {
  try {
    const { orderId } = req.params;

    const order = await easyorderService.getOrderById(orderId);

    const shipment = await bostaService.createShipment(order);

    res.json({
      success: true,
      message: "Order sent to Bosta successfully",
      data: shipment,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to send order to Bosta",
      error: error.message,
    });
  }
}

function normalizeQueryId(value) {
  if (value == null) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  const s = String(raw).trim();
  return s || null;
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

    const stats = await getOrdersStatistics({
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
    });

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
/**
 * GET /api/orders/stats/trend — time-series for charts (5 KPIs per bucket).
 * Default from/to: current calendar month. Same filters as /stats (employee, product, meta).
 */
async function getOrdersStatsTrend(req, res) {
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

    const granRaw = optionalQueryParam(req.query.granularity);
    const granularity =
      granRaw === "week" || granRaw === "month" ? granRaw : "day";

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
      ({ from, to } = resolveOrdersTrendDateRange(req));
    } catch (error) {
      if (error.code === "INVALID_FROM" || error.code === "INVALID_TO") {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      throw error;
    }

    const chart = await getOrdersStatsTimeSeries({
      from,
      to,
      granularity,
      employeeId,
      ignoreEmployeeLogDateRange,
      order_source,
      order_type,
      shipping_status,
      status,
      product_id,
      product_sku,
      useEgyptBuckets: isEasyOrderApiRequest(req),
    });

    res.json({
      success: true,
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
        easyorder_id: easyorder_id || null,
        product_sku: product_sku || null,
      },
      chart,
      filterLists: getOrdersFilterLists(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to build orders stats trend",
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
        note:
          "Bucket key __unset is used when a value is missing in raw_data or status.",
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
    const easyorder_id = optionalQueryParam(
      req.query.easyorder_id || req.query.easyorderId,
    );
    const product_id =
      optionalQueryParam(req.query.product_id || req.query.productId) ||
      easyorder_id;

    const granRaw = optionalQueryParam(req.query.granularity);
    const granularity =
      granRaw === "week" || granRaw === "month" ? granRaw : "day";

    let from;
    let to;
    try {
      ({ from, to } = resolveOrdersTrendDateRange(req));
    } catch (error) {
      if (error.code === "INVALID_FROM" || error.code === "INVALID_TO") {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      throw error;
    }

    const chart = await getProductSalesChart({
      from,
      to,
      granularity,
      product_id,
      useEgyptBuckets: isEasyOrderApiRequest(req),
    });

    res.json({
      success: true,
      filters: {
        from: from.toISOString(),
        to: to.toISOString(),
        granularity,
        product_id: product_id || null,
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

module.exports = {
  createOrder,
  updateOrder,
  getOrders,
  getOrderByReference,
  changeOrderStatus,
  sendOrderToBosta,
  getEasyOrderDetails,
  getOrdersStats,
  getOrdersStatsTrend,
  getOrdersAnalytics,
  getProductSalesChartHandler,
};
