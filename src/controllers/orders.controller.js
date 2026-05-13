const bostaService = require("../services/bosta.service");
const easyorderService = require("../services/easyorder.service");
const {
  addWebhookOrder,
  getWebhookOrders,
  updateOrderStatus,
  editOrder,
  getOrdersStatistics,
  ALLOWED_ORDER_STATUSES,
  ORDER_SOURCES,
  ORDER_TYPES,
  SHIPPING_STATUSES,
} = require("../services/webhookOrders.service");
const { toPresentation } = require("../services/easyorderPresentation.service");

/** مثال لجسم POST /api/orders (إنشاء يدوي — ليس من الويب هوك) */
const POST_ORDER_MANUAL_EXAMPLE = {
  id: "12345",
  full_name: "اسم العميل",
  phone: "01000000000",
  address: "العنوان",
  city: "القاهرة",
  order_source: "whatsapp",
  order_type: "new",
  shipping_status: "in_progress",
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

async function getOrders(req, res) {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;

    const defaultRange = getDefaultDateRange();

    const from = req.query.from ? new Date(req.query.from) : defaultRange.from;
    const to = req.query.to ? new Date(req.query.to) : defaultRange.to;

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
    const product_id = optionalQueryParam(
      req.query.product_id || req.query.productId,
    );
    const product_sku = optionalQueryParam(
      req.query.product_sku || req.query.productSku,
    );
    const phone = optionalQueryParam(
      req.query.phone ||
        req.query.mobile ||
        req.query.customerPhone ||
        req.query.customer_phone,
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
      product_sku,
      phone,
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
      listOrdersQueryReference:
        "GET /api/orders?... phone|mobile|customer_phone — بحث في raw_data. employeeId|employee_id (uuid أو إيميل). employee_scope=all|any|all_time — مع موظف: تجاهل from/to على سجلات النشاط وجلب كل الطلبات التي غيّرها الموظف. بدون employee_scope: from/to على order_status_logs.changed_at. بدون موظف: from/to على orders.created_at.",
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

    const createdOrder = await addWebhookOrder(req.body, { fromWebhook: false });

    res.status(201).json({
      success: true,
      message: "Order created successfully",
      appliedRequest: {
        method: "POST",
        url: postOrdersAbsoluteUrl(req),
        headers: { "Content-Type": "application/json" },
        notes: {
          ar: "إنشاء يدوي: order_source إلزامي. من الويب هوك يُستخدم POST /webhooks/easyorders/order-created ويُضبط المصدر تلقائياً على المتجر.",
          manualRequiredFields: ["order_source"],
          manualOptionalMeta: ["order_type", "shipping_status"],
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

    const changedBy = req.user?.id;
    const updatedOrder = await editOrder(orderId, updates, changedBy);

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

    const stats = await getOrdersStatistics({
      employeeId,
      from,
      to,
      ignoreEmployeeLogDateRange,
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
      },
      stats: statsWithLegacyKeys,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to get stats",
      error: error.message,
    });
  }
}

module.exports = {
  createOrder,
  updateOrder,
  getOrders,
  changeOrderStatus,
  sendOrderToBosta,
  getEasyOrderDetails,
  getOrdersStats,
};
