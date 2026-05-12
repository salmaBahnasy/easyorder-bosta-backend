const crypto = require("crypto");

const supabase = require("../config/supabase");

const ALLOWED_ORDER_STATUSES = [
  "canceled",
  "new",
  "no_replay",
  "follow up",
  "repeater",
  "Confirmed",
  "Shipped",
];

/** مصدر الطلب: store=المتجر (تلقائي من الويب هوك), messenger, whatsapp, lost_order=طلب مفقود */
const ORDER_SOURCES = ["store", "messenger", "whatsapp", "lost_order"];

/** نوع الطلب: new=جديد (افتراضي), replacement=استبدال, return=استرجاع */
const ORDER_TYPES = ["new", "replacement", "return"];

/** حالة الشحن: in_progress=قيد التنفيذ, delivered=تم بنجاح, failed=فشل التوصيل */
const SHIPPING_STATUSES = ["in_progress", "delivered", "failed"];

function pickMetaField(payload, snakeKey, camelKey) {
  if (!payload || typeof payload !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(payload, snakeKey)) {
    return payload[snakeKey];
  }
  if (camelKey && Object.prototype.hasOwnProperty.call(payload, camelKey)) {
    return payload[camelKey];
  }
  return undefined;
}

function normalizeMetaString(value) {
  if (value == null) return "";
  return String(value).trim();
}

/** يزيل أحرف تكسر LIKE أو ilike(all) في PostgREST */
function sanitizeIlikeNeedle(value) {
  const s = String(value).trim().slice(0, 200);
  if (!s) return "";
  return s.replace(/[%_\\,(){}]/g, "");
}

/** قيمة آمنة للبحث؛ إن أصبحت فارغة بعد التنقية يُهمَل الفلتر (لا 400). */
function parseProductFilterInput(raw) {
  if (raw == null || String(raw).trim() === "") return "";
  const s = sanitizeIlikeNeedle(raw);
  return s || "";
}

/**
 * @param {object} payload - جسم الطلب (ويب هوك أو إنشاء يدوي)
 * @param {{ fromWebhook?: boolean }} options - من الويب هوك: مصدر المتجر إلزاميًا
 */
function resolveOrderMeta(payload, options = {}) {
  const fromWebhook = Boolean(options.fromWebhook);

  let order_source = normalizeMetaString(
    pickMetaField(payload, "order_source", "orderSource"),
  );
  let order_type = normalizeMetaString(
    pickMetaField(payload, "order_type", "orderType"),
  );
  let shipping_status = normalizeMetaString(
    pickMetaField(payload, "shipping_status", "shippingStatus"),
  );

  if (fromWebhook) {
    order_source = "store";
  } else {
    if (!order_source) {
      const err = new Error(
        "order_source is required (store | messenger | whatsapp | lost_order)",
      );
      err.code = "INVALID_ORDER_META";
      throw err;
    }
    if (!ORDER_SOURCES.includes(order_source)) {
      const err = new Error("Invalid order_source");
      err.code = "INVALID_ORDER_META";
      throw err;
    }
  }

  if (!order_type) order_type = "new";
  if (!ORDER_TYPES.includes(order_type)) {
    const err = new Error("Invalid order_type");
    err.code = "INVALID_ORDER_META";
    throw err;
  }

  if (!shipping_status) shipping_status = "in_progress";
  if (!SHIPPING_STATUSES.includes(shipping_status)) {
    const err = new Error("Invalid shipping_status");
    err.code = "INVALID_ORDER_META";
    throw err;
  }

  return { order_source, order_type, shipping_status };
}

const ORDERS_TABLE = process.env.SUPABASE_ORDERS_TABLE || "orders";
const ORDER_STATUS_LOGS_TABLE =
  process.env.SUPABASE_ORDER_STATUS_LOGS_TABLE || "order_status_logs";

async function insertOrderStatusLog({
  orderId,
  oldStatus,
  newStatus,
  changedBy,
}) {
  const { error } = await supabase.from(ORDER_STATUS_LOGS_TABLE).insert({
    order_id: orderId,
    old_status: oldStatus,
    new_status: newStatus,
    changed_by: changedBy,
    changed_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(error.message);
  }
}

function resolveSourceOrderId(order) {
  const idCandidates = [
    order?.id,
    order?.order_id,
    order?.orderId,
    order?.data?.id,
    order?.data?.order_id,
    order?.data?.orderId,
  ];

  for (const candidate of idCandidates) {
    if (candidate == null) continue;
    const value = String(candidate).trim();
    if (value) return value;
  }

  const fingerprint = crypto
    .createHash("sha1")
    .update(JSON.stringify(order || {}))
    .digest("hex");

  return `webhook-${fingerprint}`;
}

async function addWebhookOrder(order, options = {}) {
  const sourceOrderId = resolveSourceOrderId(order);
  const meta = resolveOrderMeta(order, { fromWebhook: options.fromWebhook });
  const raw_data = {
    ...(order && typeof order === "object" && !Array.isArray(order) ? order : {}),
    ...meta,
  };

  const payload = {
    order_id: sourceOrderId,
    status: "new",
    raw_data,
    created_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from(ORDERS_TABLE)
    .upsert(payload, { onConflict: "order_id" })
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return {
    ...(data.raw_data || {}),
    sourceOrderId: data.order_id,
    orderStatus: data.status,
    receivedAt: data.created_at,
  };
}

async function getWebhookOrders({
  page = 1,
  limit = 20,
  from,
  to,
  status,
  employeeId,
  order_source,
  order_type,
  shipping_status,
  product_id,
  product_sku,
}) {
  const fromIndex = (page - 1) * limit;
  const toIndex = fromIndex + limit - 1;
  let orderIdsByEmployee = null;

  if (employeeId) {
    const { data: logs, error: logsError } = await supabase
      .from(ORDER_STATUS_LOGS_TABLE)
      .select("order_id")
      .eq("changed_by", employeeId);

    if (logsError) {
      throw new Error(logsError.message);
    }

    orderIdsByEmployee = [...new Set((logs || []).map((x) => x.order_id))];

    if (!orderIdsByEmployee.length) {
      return {
        page,
        limit,
        total: 0,
        totalPages: 1,
        data: [],
      };
    }
  }

  let query = supabase
    .from(ORDERS_TABLE)
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(fromIndex, toIndex);

  if (from) query = query.gte("created_at", from.toISOString());
  if (to) query = query.lte("created_at", to.toISOString());
  if (status) query = query.eq("status", status);

  const rawContains = {};
  if (order_source) rawContains.order_source = order_source;
  if (order_type) rawContains.order_type = order_type;
  if (shipping_status) rawContains.shipping_status = shipping_status;
  if (Object.keys(rawContains).length) {
    query = query.contains("raw_data", rawContains);
  }

  if (orderIdsByEmployee) query = query.in("order_id", orderIdsByEmployee);

  const pidNeedle = parseProductFilterInput(product_id);
  const skuNeedle = parseProductFilterInput(product_sku);
  const jsonTextCol = '"raw_data"::text';

  if (pidNeedle && skuNeedle) {
    query = query.ilikeAllOf(jsonTextCol, [
      `%${pidNeedle}%`,
      `%${skuNeedle}%`,
    ]);
  } else if (pidNeedle) {
    query = query.ilike(jsonTextCol, `%${pidNeedle}%`);
  } else if (skuNeedle) {
    query = query.ilike(jsonTextCol, `%${skuNeedle}%`);
  }

  const { data, count, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  const rows = data || [];
  const total = count || 0;

  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
    data: rows.map((entry) => ({
      ...(entry.raw_data || {}),
      sourceOrderId: entry.order_id,
      orderStatus: entry.status,
      receivedAt: entry.created_at,
    })),
  };
}

async function updateOrderStatus(orderId, status, changedBy) {
  if (!ALLOWED_ORDER_STATUSES.includes(status)) {
    const error = new Error("Invalid status value");
    error.code = "INVALID_STATUS";
    throw error;
  }

  if (!changedBy) {
    const error = new Error("Unauthorized");
    error.code = "UNAUTHORIZED";
    throw error;
  }

  const { data: existingOrder, error: existingError } = await supabase
    .from(ORDERS_TABLE)
    .select("order_id,status")
    .eq("order_id", orderId)
    .single();

  if (existingError || !existingOrder) {
    const notFoundError = new Error("Order not found");
    notFoundError.code = "ORDER_NOT_FOUND";
    throw notFoundError;
  }

  const oldStatus = existingOrder.status;

  const { data, error } = await supabase
    .from(ORDERS_TABLE)
    .update({ status: status })
    .eq("order_id", orderId)
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  await insertOrderStatusLog({
    orderId: data.order_id,
    oldStatus,
    newStatus: data.status,
    changedBy,
  });

  return {
    ...(data.raw_data || {}),
    sourceOrderId: data.order_id,
    orderStatus: data.status,
    receivedAt: data.created_at,
  };
}

async function editOrder(orderId, updates, changedBy) {
  const normalizedUpdates =
    updates && typeof updates === "object" && !Array.isArray(updates)
      ? updates
      : null;

  if (!normalizedUpdates) {
    const error = new Error("Invalid order updates payload");
    error.code = "INVALID_UPDATES";
    throw error;
  }

  const { data: existingOrder, error: existingError } = await supabase
    .from(ORDERS_TABLE)
    .select("order_id,status,raw_data,created_at")
    .eq("order_id", orderId)
    .single();

  if (existingError || !existingOrder) {
    const notFoundError = new Error("Order not found");
    notFoundError.code = "ORDER_NOT_FOUND";
    throw notFoundError;
  }

  let nextStatus = existingOrder.status;
  let shouldLogStatusChange = false;
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, "status")) {
    if (!ALLOWED_ORDER_STATUSES.includes(normalizedUpdates.status)) {
      const invalidStatusError = new Error("Invalid status value");
      invalidStatusError.code = "INVALID_STATUS";
      throw invalidStatusError;
    }
    if (!changedBy) {
      const authError = new Error("Unauthorized");
      authError.code = "UNAUTHORIZED";
      throw authError;
    }
    nextStatus = normalizedUpdates.status;
    shouldLogStatusChange = nextStatus !== existingOrder.status;
  }

  const normalizedIncomingUpdates = { ...normalizedUpdates };

  // Keep common aliases in sync so list/detail pages read same values.
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "firstName")) {
    normalizedIncomingUpdates.full_name = normalizedIncomingUpdates.firstName;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "full_name")) {
    normalizedIncomingUpdates.firstName = normalizedIncomingUpdates.full_name;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "mobile")) {
    normalizedIncomingUpdates.phone = normalizedIncomingUpdates.mobile;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "phone")) {
    normalizedIncomingUpdates.mobile = normalizedIncomingUpdates.phone;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "orderSource")) {
    normalizedIncomingUpdates.order_source = normalizedIncomingUpdates.orderSource;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "orderType")) {
    normalizedIncomingUpdates.order_type = normalizedIncomingUpdates.orderType;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "shippingStatus")) {
    normalizedIncomingUpdates.shipping_status = normalizedIncomingUpdates.shippingStatus;
  }

  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "order_source")) {
    const v = normalizeMetaString(normalizedIncomingUpdates.order_source);
    if (!ORDER_SOURCES.includes(v)) {
      const invalidStatusError = new Error("Invalid order_source");
      invalidStatusError.code = "INVALID_ORDER_META";
      throw invalidStatusError;
    }
    normalizedIncomingUpdates.order_source = v;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "order_type")) {
    const v = normalizeMetaString(normalizedIncomingUpdates.order_type);
    if (!ORDER_TYPES.includes(v)) {
      const invalidStatusError = new Error("Invalid order_type");
      invalidStatusError.code = "INVALID_ORDER_META";
      throw invalidStatusError;
    }
    normalizedIncomingUpdates.order_type = v;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "shipping_status")) {
    const v = normalizeMetaString(normalizedIncomingUpdates.shipping_status);
    if (!SHIPPING_STATUSES.includes(v)) {
      const invalidStatusError = new Error("Invalid shipping_status");
      invalidStatusError.code = "INVALID_ORDER_META";
      throw invalidStatusError;
    }
    normalizedIncomingUpdates.shipping_status = v;
  }

  const mergedRawData = {
    ...(existingOrder.raw_data || {}),
    ...normalizedIncomingUpdates,
  };

  const { data, error } = await supabase
    .from(ORDERS_TABLE)
    .update({
      raw_data: mergedRawData,
      status: nextStatus,
    })
    .eq("order_id", orderId)
    .select()
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to update order");
  }

  if (shouldLogStatusChange) {
    await insertOrderStatusLog({
      orderId: data.order_id,
      oldStatus: existingOrder.status,
      newStatus: data.status,
      changedBy,
    });
  }

  return {
    ...(data.raw_data || {}),
    sourceOrderId: data.order_id,
    orderStatus: data.status,
    receivedAt: data.created_at,
  };
}

const STATS_STATUS_KEYS = {
  canceled: "canceled",
  no_replay: "no_replay",
  follow_up: "follow up",
  repeater: "repeater",
  Confirmed: "Confirmed",
  Shipped: "Shipped",
  new: "new",
};

const IN_CHUNK_SIZE = 120;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Order counts by status. Optional employeeId = only orders that appear in
 * order_status_logs for that employee (same semantics as GET /api/orders?employeeId=).
 * Optional from/to filter on orders.created_at (inclusive).
 */
async function getOrdersStatistics({ employeeId, from, to }) {
  let orderIds = null;

  const employeeKey =
    typeof employeeId === "string" ? employeeId.trim() : employeeId;

  if (employeeKey) {
    const { data: logs, error: logsError } = await supabase
      .from(ORDER_STATUS_LOGS_TABLE)
      .select("order_id")
      .eq("changed_by", employeeKey);

    if (logsError) {
      throw new Error(logsError.message);
    }

    orderIds = [...new Set((logs || []).map((r) => r.order_id).filter(Boolean))];

    if (!orderIds.length) {
      return {
        totalOrders: 0,
        canceled: 0,
        no_replay: 0,
        follow_up: 0,
        repeater: 0,
        Confirmed: 0,
        Shipped: 0,
        new: 0,
      };
    }
  }

  const chunks =
    orderIds == null ? [null] : chunkArray(orderIds, IN_CHUNK_SIZE);

  async function countWithChunks(status) {
    let sum = 0;
    for (const chunk of chunks) {
      let q = supabase
        .from(ORDERS_TABLE)
        .select("*", { count: "exact", head: true });

      if (chunk) q = q.in("order_id", chunk);
      if (from) q = q.gte("created_at", from.toISOString());
      if (to) q = q.lte("created_at", to.toISOString());
      if (status) q = q.eq("status", status);

      const { count, error } = await q;
      if (error) throw new Error(error.message);
      sum += count || 0;
    }
    return sum;
  }

  const byStatus = {};
  for (const [key, dbStatus] of Object.entries(STATS_STATUS_KEYS)) {
    byStatus[key] = await countWithChunks(dbStatus);
  }

  let totalOrders = 0;
  for (const chunk of chunks) {
    let q = supabase
      .from(ORDERS_TABLE)
      .select("*", { count: "exact", head: true });

    if (chunk) q = q.in("order_id", chunk);
    if (from) q = q.gte("created_at", from.toISOString());
    if (to) q = q.lte("created_at", to.toISOString());

    const { count, error } = await q;
    if (error) throw new Error(error.message);
    totalOrders += count || 0;
  }

  return {
    totalOrders,
    canceled: byStatus.canceled,
    no_replay: byStatus.no_replay,
    follow_up: byStatus.follow_up,
    repeater: byStatus.repeater,
    Confirmed: byStatus.Confirmed,
    Shipped: byStatus.Shipped,
    new: byStatus.new,
  };
}

module.exports = {
  addWebhookOrder,
  getWebhookOrders,
  updateOrderStatus,
  editOrder,
  getOrdersStatistics,
  ALLOWED_ORDER_STATUSES,
  ORDER_SOURCES,
  ORDER_TYPES,
  SHIPPING_STATUSES,
};
