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

const ORDERS_TABLE = process.env.SUPABASE_ORDERS_TABLE || "orders";

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

async function addWebhookOrder(order) {
  const sourceOrderId = resolveSourceOrderId(order);
  const payload = {
    order_id: sourceOrderId,
    status: "new",
    raw_data: order,
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

async function getWebhookOrders({ page = 1, limit = 20, from, to, status }) {
  const fromIndex = (page - 1) * limit;
  const toIndex = fromIndex + limit - 1;

  let query = supabase
    .from(ORDERS_TABLE)
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(fromIndex, toIndex);

  if (from) query = query.gte("created_at", from.toISOString());
  if (to) query = query.lte("created_at", to.toISOString());
  if (status) query = query.eq("status", status);

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

async function updateOrderStatus(orderId, status) {
  if (!ALLOWED_ORDER_STATUSES.includes(status)) {
    const error = new Error("Invalid status value");
    error.code = "INVALID_STATUS";
    throw error;
  }

  const { data, error } = await supabase
    .from(ORDERS_TABLE)
    .update({ status: status })
    .eq("order_id", orderId)
    .select()
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      const notFoundError = new Error("Order not found");
      notFoundError.code = "ORDER_NOT_FOUND";
      throw notFoundError;
    }

    throw new Error(error.message);
  }

  return {
    ...(data.raw_data || {}),
    sourceOrderId: data.order_id,
    orderStatus: data.status,
    receivedAt: data.created_at,
  };
}

async function editOrder(orderId, updates) {
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
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, "status")) {
    if (!ALLOWED_ORDER_STATUSES.includes(normalizedUpdates.status)) {
      const invalidStatusError = new Error("Invalid status value");
      invalidStatusError.code = "INVALID_STATUS";
      throw invalidStatusError;
    }
    nextStatus = normalizedUpdates.status;
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

  return {
    ...(data.raw_data || {}),
    sourceOrderId: data.order_id,
    orderStatus: data.status,
    receivedAt: data.created_at,
  };
}

module.exports = {
  addWebhookOrder,
  getWebhookOrders,
  updateOrderStatus,
  editOrder,
  ALLOWED_ORDER_STATUSES,
};
