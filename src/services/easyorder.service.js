const axios = require("axios");
const { isShopifyOrder } = require("./shopify.service");

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
  if (raw === "failed") return "failed";
  if (raw === "pending" || raw === "waiting") return "pending";
  return null;
}

function isTruthyFlag(value) {
  if (value === true || value === 1) return true;
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/** Manual ERP order (POST /api/orders) — never sync customerStatus from EasyOrders. */
function isManualOrder(order = {}) {
  return isTruthyFlag(order?.is_manual) || isTruthyFlag(order?.isManual);
}

/**
 * Live-sync customer confirmation from EasyOrders onto a local order.
 * Source of truth: EasyOrders GET /orders/:id → status
 *
 * options.forceSync — always write to DB (used by "إظهار الحالة" button)
 */
async function enrichOrderWithEasyOrdersCustomerStatus(order, options = {}) {
  if (!order || typeof order !== "object") {
    return { order, easyOrdersConfirm: null };
  }

  // Manual ERP orders keep customerStatus=confirmed — never overwrite from EasyOrders
  if (isManualOrder(order)) {
    return {
      order: {
        ...order,
        customer_status: "confirmed",
        customerStatus: "confirmed",
        is_manual: true,
        isManual: true,
      },
      easyOrdersConfirm: null,
    };
  }

  // Shopify orders live in the same table but are not EasyOrders records
  if (isShopifyOrder(order)) {
    return { order, easyOrdersConfirm: null };
  }

  const syncLocal = options.syncLocal !== false;
  const forceSync = options.forceSync === true;
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
    if (options.throwOnError) {
      const err = new Error(
        error?.response?.data?.message ||
          error?.message ||
          "Failed to fetch EasyOrders order",
      );
      err.code = "EASYORDERS_FETCH_FAILED";
      err.statusCode = error?.response?.status || 502;
      err.cause = error;
      throw err;
    }
    return { order, easyOrdersConfirm: null };
  }

  const remoteOrder =
    remote && typeof remote === "object"
      ? remote.data && typeof remote.data === "object" && remote.data.id
        ? remote.data
        : remote
      : null;

  if (!remoteOrder) {
    if (options.throwOnError) {
      const err = new Error("EasyOrders order response was empty");
      err.code = "EASYORDERS_EMPTY_RESPONSE";
      err.statusCode = 502;
      throw err;
    }
    return { order, easyOrdersConfirm: null };
  }

  const customerStatus =
    mapEasyOrdersStatusToCustomerStatus(remoteOrder.status) || "pending";
  const easyOrdersConfirm = {
    id: remoteOrder.id ?? null,
    shortId: remoteOrder.short_id ?? remoteOrder.shortId ?? null,
    status: remoteOrder.status ?? null,
    customerStatus,
    source: "easyorders",
  };

  const localStatus = String(
    order.customer_status ?? order.customerStatus ?? "",
  )
    .trim()
    .toLowerCase();
  const localNormalized =
    localStatus === "cancelled" ? "canceled" : localStatus;

  let enriched = {
    ...order,
    customer_status: customerStatus,
    customerStatus,
    short_id: order.short_id ?? remoteOrder.short_id,
    easyorders_status: remoteOrder.status,
    easyOrdersStatus: remoteOrder.status,
  };

  const shouldWrite =
    syncLocal &&
    order.sourceOrderId &&
    (forceSync || localNormalized !== customerStatus);

  if (shouldWrite) {
    const { mergeOrderRawDataPatch } = require("./webhookOrders.service");
    enriched = await mergeOrderRawDataPatch(order.sourceOrderId, {
      customer_status: customerStatus,
      customerStatus,
      easyorders_status: remoteOrder.status,
      easyOrdersStatus: remoteOrder.status,
      confirmation_source: "easyorders",
      confirmation_status:
        customerStatus === "canceled" ? "cancelled" : customerStatus,
      easyorders_customer_synced_at: new Date().toISOString(),
    });
  }

  return { order: enriched, easyOrdersConfirm };
}

/**
 * Explicit refresh for UI button "إظهار الحالة".
 * Always calls EasyOrders and persists customerStatus.
 */
async function refreshCustomerStatusFromEasyOrders(orderId) {
  const id = String(orderId || "").trim();
  if (!id) {
    const err = new Error("order id is required");
    err.code = "INVALID_ORDER_ID";
    err.statusCode = 400;
    throw err;
  }

  const { getWebhookOrderById } = require("./webhookOrders.service");
  let localOrder;
  try {
    localOrder = await getWebhookOrderById(id);
  } catch (error) {
    if (error.code === "ORDER_NOT_FOUND") {
      localOrder = { sourceOrderId: id, id };
    } else {
      throw error;
    }
  }

  if (isManualOrder(localOrder)) {
    const err = new Error(
      "Manual orders keep customerStatus=confirmed and cannot be refreshed from EasyOrders",
    );
    err.code = "MANUAL_ORDER_NO_REFRESH";
    err.statusCode = 400;
    throw err;
  }

  if (isShopifyOrder(localOrder)) {
    const err = new Error(
      "Shopify orders cannot be refreshed from EasyOrders",
    );
    err.code = "SHOPIFY_ORDER_NO_REFRESH";
    err.statusCode = 400;
    throw err;
  }

  const previousStatus =
    localOrder.customer_status ?? localOrder.customerStatus ?? "pending";

  const { order, easyOrdersConfirm } =
    await enrichOrderWithEasyOrdersCustomerStatus(
      {
        ...localOrder,
        sourceOrderId: localOrder.sourceOrderId || id,
      },
      { syncLocal: true, forceSync: true, throwOnError: true },
    );

  return {
    order,
    easyOrdersConfirm,
    previousCustomerStatus:
      String(previousStatus).toLowerCase() === "cancelled"
        ? "canceled"
        : String(previousStatus).toLowerCase() || "pending",
    customerStatus: easyOrdersConfirm.customerStatus,
    changed:
      String(previousStatus).toLowerCase().replace("cancelled", "canceled") !==
      easyOrdersConfirm.customerStatus,
  };
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
  refreshCustomerStatusFromEasyOrders,
};
