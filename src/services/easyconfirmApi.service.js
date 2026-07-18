const axios = require("axios");

const EASYCONFIRM_API_BASE =
  process.env.EASYCONFIRM_API_BASE_URL || "https://api.easyconfirm.net/api/v1";

const DEFAULT_CUSTOMER_STATUS = "pending";

function easyconfirmHeaders() {
  const apiKey = process.env.EASYCONFIRM_API_KEY;
  if (!apiKey) {
    const err = new Error("EASYCONFIRM_API_KEY is not set");
    err.code = "EASYCONFIRM_NOT_CONFIGURED";
    throw err;
  }
  return { "X-API-Key": apiKey };
}

function unwrapEasyConfirmOrder(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.id) return payload;
  if (payload.data && typeof payload.data === "object" && payload.data.id) {
    return payload.data;
  }
  if (payload.order && typeof payload.order === "object" && payload.order.id) {
    return payload.order;
  }
  return null;
}

/**
 * GET /api/v1/orders/{id}
 * @param {string} orderId - EasyConfirm order id (e.g. ord_abc123)
 */
async function getOrderById(orderId) {
  const id = String(orderId || "").trim();
  if (!id) {
    const err = new Error("EasyConfirm order id is required");
    err.code = "INVALID_EASYCONFIRM_ORDER_ID";
    throw err;
  }

  const url = `${EASYCONFIRM_API_BASE}/orders/${encodeURIComponent(id)}`;
  try {
    const response = await axios.get(url, {
      headers: easyconfirmHeaders(),
      timeout: 8000,
    });
    const order = unwrapEasyConfirmOrder(response.data);
    if (!order) {
      const err = new Error("EasyConfirm response could not be mapped");
      err.code = "EASYCONFIRM_BAD_RESPONSE";
      throw err;
    }
    return order;
  } catch (error) {
    if (error.code === "EASYCONFIRM_NOT_CONFIGURED") throw error;
    if (error.response?.status === 404) {
      const notFound = new Error("EasyConfirm order not found");
      notFound.code = "EASYCONFIRM_ORDER_NOT_FOUND";
      throw notFound;
    }
    throw error;
  }
}

/**
 * Map EasyConfirm order → ERP customer_status.
 * EasyConfirm status: pending | confirmed | canceled | failed
 * customerAction: approved | canceled | null
 */
function mapEasyConfirmToCustomerStatus(ecOrder) {
  if (!ecOrder || typeof ecOrder !== "object") return null;

  const status = String(ecOrder.status || "")
    .trim()
    .toLowerCase();
  if (status === "confirmed") return "confirmed";
  if (status === "canceled" || status === "cancelled") return "canceled";

  const action = String(
    ecOrder.customerAction ?? ecOrder.customer_action ?? "",
  )
    .trim()
    .toLowerCase();
  if (action === "approved" || action === "confirmed") return "confirmed";
  if (action === "canceled" || action === "cancelled") return "canceled";

  if (status === "pending" || status === "failed" || !status) {
    return DEFAULT_CUSTOMER_STATUS;
  }

  return DEFAULT_CUSTOMER_STATUS;
}

function buildEasyConfirmLookupIds(order = {}) {
  const shortId = order.short_id ?? order.shortId;
  const preferred = [];
  const fallbacks = [];

  const push = (list, raw) => {
    const value = String(raw || "").trim();
    if (!value || list.includes(value)) return;
    list.push(value);
  };

  push(preferred, order.easyconfirm_id);
  push(preferred, order.easyconfirmId);

  for (const raw of [
    order.easyconfirm_id,
    order.easyconfirmId,
    order.id,
    order.sourceOrderId,
  ]) {
    const value = String(raw || "").trim();
    if (/^ord_/i.test(value)) push(preferred, value);
  }

  push(fallbacks, order.easyconfirm_external_order_id);
  push(fallbacks, order.easyconfirmExternalOrderId);
  push(fallbacks, order.externalOrderId);
  push(fallbacks, order.external_order_id);

  if (shortId != null && String(shortId).trim() !== "") {
    const n = String(shortId).trim();
    push(fallbacks, `EO-${n}`);
    push(fallbacks, n);
  }

  // UUID last — only if no EasyConfirm-native id yet
  if (preferred.length === 0) {
    push(fallbacks, order.sourceOrderId);
    push(fallbacks, order.id);
  }

  const out = [];
  const seen = new Set();
  for (const value of [...preferred, ...fallbacks]) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);

    const stripped = value.replace(/^EO-/i, "").trim();
    if (stripped && !seen.has(stripped) && /^\d+$/.test(stripped)) {
      seen.add(stripped);
      out.push(stripped);
    }
  }

  // Cap attempts so order details stay fast
  return out.slice(0, 4);
}

/**
 * Fetch live EasyConfirm confirmation state for a local/presented order.
 * Tries stored easyconfirm_id first, then externalOrderId / EO-short_id fallbacks.
 */
async function fetchEasyConfirmForOrder(order) {
  if (!process.env.EASYCONFIRM_API_KEY) {
    return null;
  }

  const candidates = buildEasyConfirmLookupIds(order);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const ecOrder = await getOrderById(candidate);
      const customerStatus = mapEasyConfirmToCustomerStatus(ecOrder);
      return {
        id: ecOrder.id ?? null,
        externalOrderId:
          ecOrder.externalOrderId ?? ecOrder.external_order_id ?? null,
        status: ecOrder.status ?? null,
        customerAction:
          ecOrder.customerAction ?? ecOrder.customer_action ?? null,
        deliveryStatus:
          ecOrder.deliveryStatus ?? ecOrder.delivery_status ?? null,
        customerStatus: customerStatus || DEFAULT_CUSTOMER_STATUS,
        updatedAt: ecOrder.updatedAt ?? ecOrder.updated_at ?? null,
        source: "easyconfirm",
        lookedUpBy: candidate,
      };
    } catch (error) {
      if (
        error.code === "EASYCONFIRM_ORDER_NOT_FOUND" ||
        error.code === "INVALID_EASYCONFIRM_ORDER_ID"
      ) {
        lastError = error;
        continue;
      }
      if (error.code === "EASYCONFIRM_NOT_CONFIGURED") {
        return null;
      }
      lastError = error;
      break;
    }
  }

  if (lastError && lastError.code !== "EASYCONFIRM_ORDER_NOT_FOUND") {
    console.warn(
      JSON.stringify({
        source: "easyconfirm-api",
        level: "warn",
        message: lastError.message || "EasyConfirm lookup failed",
        orderId: order?.sourceOrderId || order?.id || null,
      }),
    );
  }

  return null;
}

/**
 * Enrich order details with live EasyConfirm status.
 * Optionally syncs confirmed/canceled back to local raw_data when stale.
 */
async function enrichOrderWithEasyConfirm(order, options = {}) {
  if (!order || typeof order !== "object") {
    return { order, easyConfirm: null };
  }

  const syncLocal = options.syncLocal !== false;
  const easyConfirm = await fetchEasyConfirmForOrder(order);

  if (!easyConfirm) {
    return { order, easyConfirm: null };
  }

  const nextStatus = easyConfirm.customerStatus;
  const localStatus = String(
    order.customer_status ?? order.customerStatus ?? "",
  )
    .trim()
    .toLowerCase();

  let enriched = {
    ...order,
    customer_status: nextStatus,
    customerStatus: nextStatus,
  };

  if (
    syncLocal &&
    order.sourceOrderId &&
    (nextStatus === "confirmed" || nextStatus === "canceled") &&
    localStatus !== nextStatus
  ) {
    try {
      const { mergeOrderRawDataPatch } = require("./webhookOrders.service");
      enriched = await mergeOrderRawDataPatch(order.sourceOrderId, {
        customer_status: nextStatus,
        customerStatus: nextStatus,
        easyconfirm_id: easyConfirm.id,
        easyconfirm_external_order_id: easyConfirm.externalOrderId,
        easyconfirm_customer_action: easyConfirm.customerAction,
        easyconfirm_delivery_status: easyConfirm.deliveryStatus,
        easyconfirm_status: easyConfirm.status,
        easyconfirm_last_synced_at: new Date().toISOString(),
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          source: "easyconfirm-api",
          level: "warn",
          message: "Failed to sync EasyConfirm status to local order",
          orderId: order.sourceOrderId,
          error: error.message,
        }),
      );
    }
  }

  return { order: enriched, easyConfirm };
}

module.exports = {
  getOrderById,
  unwrapEasyConfirmOrder,
  mapEasyConfirmToCustomerStatus,
  buildEasyConfirmLookupIds,
  fetchEasyConfirmForOrder,
  enrichOrderWithEasyConfirm,
};
