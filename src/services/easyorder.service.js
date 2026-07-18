const axios = require("axios");

const EASYORDER_API_BASE =
  process.env.EASYORDER_API_BASE_URL ||
  "https://api.easy-orders.net/api/v1/external-apps";

async function easyorderHeaders() {
  const apiKey = process.env.EASYORDER_API_KEY;
  if (!apiKey) {
    throw new Error("EASYORDER_API_KEY is not set");
  }
  return { "Api-Key": apiKey };
}

async function getOrderById(orderId) {
  const url = `${EASYORDER_API_BASE}/orders/${orderId}`;

  const response = await axios.get(url, {
    headers: await easyorderHeaders(),
  });

  return response.data;
}

/**
 * EasyOrders stores WhatsApp confirmation in `status`
 * (pending | confirmed | canceled | …). Map to ERP customer_status.
 */
function mapEasyOrdersStatusToCustomerStatus(easyOrdersStatus) {
  const raw = String(easyOrdersStatus || "")
    .trim()
    .toLowerCase();
  if (raw === "confirmed" || raw === "approved") return "confirmed";
  if (raw === "canceled" || raw === "cancelled") return "canceled";
  if (raw === "pending" || raw === "waiting") return "pending";
  return null;
}

/**
 * Live-sync customer confirmation from EasyOrders onto a local order.
 * Uses the same order id / short_id shown in the WhatsApp message.
 */
async function enrichOrderWithEasyOrdersCustomerStatus(order, options = {}) {
  if (!order || typeof order !== "object") {
    return { order, easyOrdersConfirm: null };
  }

  const syncLocal = options.syncLocal !== false;
  const orderId = String(
    order.sourceOrderId || order.id || order.order_id || "",
  ).trim();
  if (!orderId) {
    return { order, easyOrdersConfirm: null };
  }

  let remote;
  try {
    remote = await getOrderById(orderId);
  } catch (error) {
    console.warn(
      JSON.stringify({
        source: "easyorder-api",
        level: "warn",
        message: error?.message || "Failed to fetch EasyOrders order",
        orderId,
      }),
    );
    return { order, easyOrdersConfirm: null };
  }

  const remoteOrder =
    remote && typeof remote === "object"
      ? remote.data && typeof remote.data === "object" && remote.data.id
        ? remote.data
        : remote
      : null;

  if (!remoteOrder) {
    return { order, easyOrdersConfirm: null };
  }

  const customerStatus = mapEasyOrdersStatusToCustomerStatus(remoteOrder.status);
  const easyOrdersConfirm = {
    id: remoteOrder.id ?? null,
    shortId: remoteOrder.short_id ?? remoteOrder.shortId ?? null,
    status: remoteOrder.status ?? null,
    customerStatus: customerStatus || "pending",
    source: "easyorders",
  };

  if (!customerStatus || customerStatus === "pending") {
    return { order, easyOrdersConfirm };
  }

  const localStatus = String(
    order.customer_status ?? order.customerStatus ?? "",
  )
    .trim()
    .toLowerCase();

  let enriched = {
    ...order,
    customer_status: customerStatus,
    customerStatus,
    short_id: order.short_id ?? remoteOrder.short_id,
  };

  if (syncLocal && order.sourceOrderId && localStatus !== customerStatus) {
    try {
      const { mergeOrderRawDataPatch } = require("./webhookOrders.service");
      enriched = await mergeOrderRawDataPatch(order.sourceOrderId, {
        customer_status: customerStatus,
        customerStatus,
        easyorders_status: remoteOrder.status,
        easyorders_customer_synced_at: new Date().toISOString(),
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          source: "easyorder-api",
          level: "warn",
          message: "Failed to sync EasyOrders confirmation to local order",
          orderId: order.sourceOrderId,
          error: error.message,
        }),
      );
    }
  }

  return { order: enriched, easyOrdersConfirm };
}

/** Fetches products list from EasyOrders external-apps API. */
async function getProductsFromEasyOrder() {
  const url = `${EASYORDER_API_BASE}/products`;

  const response = await axios.get(url, {
    headers: await easyorderHeaders(),
  });

  return response.data;
}

/** GET /products/:product_id — single product from EasyOrders external-apps API. */
async function getProductById(productId) {
  const id = String(productId || "").trim();
  if (!id) {
    const err = new Error("product_id is required");
    err.code = "INVALID_PRODUCT_ID";
    throw err;
  }

  const url = `${EASYORDER_API_BASE}/products/${encodeURIComponent(id)}`;

  const response = await axios.get(url, {
    headers: await easyorderHeaders(),
  });

  return response.data;
}

module.exports = {
  getOrderById,
  getProductsFromEasyOrder,
  getProductById,
  mapEasyOrdersStatusToCustomerStatus,
  enrichOrderWithEasyOrdersCustomerStatus,
};
