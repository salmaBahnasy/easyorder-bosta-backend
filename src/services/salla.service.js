const axios = require("axios");

function getBaseUrl() {
  const raw =
    (process.env.SALLA_BASE_URL || "https://api.salla.dev/admin/v2").trim();
  return raw.replace(/\/$/, "");
}

function getAccessToken() {
  return (process.env.SALLA_ACCESS_TOKEN || "").trim();
}

function buildAuthHeaders(tokenOverride) {
  const token = (tokenOverride || getAccessToken()).trim();
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

/**
 * Normalizes list payload from Salla list responses (shape may vary by endpoint version).
 */
function normalizeOrdersArray(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.orders)) return payload.orders;
  if (payload.data && Array.isArray(payload.data.data)) return payload.data.data;
  return [];
}

async function requestSallaOrders(params, tokenOverride) {
  const token = (tokenOverride || getAccessToken()).trim();
  if (!token) {
    const err = new Error("SALLA_ACCESS_TOKEN is not configured");
    err.code = "MISSING_SALLA_TOKEN";
    throw err;
  }

  const url = `${getBaseUrl()}/orders`;
  const response = await axios.get(url, {
    headers: buildAuthHeaders(token),
    params: params || {},
    timeout: 60000,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const err = new Error(
      response.data?.message ||
        response.data?.error ||
        `Salla API returned ${response.status}`,
    );
    err.code = "SALLA_HTTP_ERROR";
    err.status = response.status;
    err.details = response.data;
    throw err;
  }

  return response.data;
}

/**
 * GET orders from Salla (pass-through query params, e.g. page, per_page).
 */
async function fetchSallaOrders(query, tokenOverride) {
  return requestSallaOrders(query || {}, tokenOverride);
}

/**
 * Verifies credentials by calling Salla orders list (minimal page).
 */
async function verifySallaLogin(tokenOverride) {
  return requestSallaOrders({ page: 1, per_page: 1 }, tokenOverride);
}

/**
 * Fetches all orders from Salla (paginated) for stats only.
 */
async function fetchAllSallaOrdersForStats(tokenOverride) {
  const all = [];
  let page = 1;
  const per_page = 50;

  for (;;) {
    const payload = await requestSallaOrders({ page, per_page }, tokenOverride);
    const batch = normalizeOrdersArray(payload);
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < per_page) break;
    page += 1;
    if (page > 500) break;
  }

  return all;
}

function pickOrderStatusKey(order) {
  if (!order || typeof order !== "object") return "unknown";
  if (order.status != null) {
    if (typeof order.status === "object" && order.status !== null) {
      if (order.status.slug != null) return String(order.status.slug);
      if (order.status.name != null) return String(order.status.name);
      if (order.status.id != null) return String(order.status.id);
    }
    return String(order.status);
  }
  if (order.order_status != null) return String(order.order_status);
  if (order.state != null) return String(order.state);
  return "unknown";
}

/**
 * Stats derived only from Salla order payloads (no EasyOrder / Supabase).
 */
function computeStatsFromSallaOrders(orders) {
  const byStatus = {};
  for (const o of orders) {
    const key = pickOrderStatusKey(o);
    byStatus[key] = (byStatus[key] || 0) + 1;
  }
  return {
    totalOrders: orders.length,
    byStatus,
  };
}

module.exports = {
  getBaseUrl,
  getAccessToken,
  fetchSallaOrders,
  verifySallaLogin,
  fetchAllSallaOrdersForStats,
  computeStatsFromSallaOrders,
  normalizeOrdersArray,
};
