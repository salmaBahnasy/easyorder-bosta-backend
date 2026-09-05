const axios = require("axios");

const EASYCONFIRM_API_BASE = (
  process.env.EASYCONFIRM_API_BASE_URL || "https://api.easyconfirm.net/api/v1"
).replace(/\/$/, "");

function easyConfirmHeaders() {
  const apiKey = String(process.env.EASYCONFIRM_API_KEY || "").trim();
  if (!apiKey) {
    const err = new Error("EASYCONFIRM_API_KEY is not set");
    err.code = "MISSING_EASYCONFIRM_KEY";
    throw err;
  }
  return {
    "X-API-Key": apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function isEasyConfirmConfigured() {
  return Boolean(String(process.env.EASYCONFIRM_API_KEY || "").trim());
}

function mapEasyConfirmStatus(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (raw === "confirmed" || raw === "approved" || raw === "order.confirmed") {
    return "confirmed";
  }
  if (
    raw === "canceled" ||
    raw === "cancelled" ||
    raw === "order.canceled" ||
    raw === "order.cancelled"
  ) {
    return "canceled";
  }
  if (raw === "failed") return "failed";
  if (raw === "pending" || raw === "waiting" || raw === "sent") return "pending";
  return null;
}

function unwrapEasyConfirmOrder(body) {
  if (!body || typeof body !== "object") return null;
  if (body.data && typeof body.data === "object" && !Array.isArray(body.data)) {
    if (body.data.id || body.data.externalOrderId || body.data.status) {
      return body.data;
    }
    if (body.data.order && typeof body.data.order === "object") {
      return body.data.order;
    }
  }
  if (body.order && typeof body.order === "object") return body.order;
  if (body.id || body.externalOrderId || body.status) return body;
  return null;
}

function toEasyConfirmPhone(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) {
    digits = `20${digits.slice(1)}`;
  } else if (digits.length === 10 && digits.startsWith("1")) {
    digits = `20${digits}`;
  }
  return digits;
}

function easyConfirmExternalIdCandidates(order = {}) {
  const numeric = String(order.shopify_order_id || "")
    .replace(/^shopify-/i, "")
    .trim();
  const localId = String(
    order.sourceOrderId || order.id || order.order_id || "",
  ).trim();
  const name = String(order.shopify_name || order.short_id || order.shortId || "").trim();
  const number = String(order.shopify_order_number || "").trim();
  const stored = String(order.easyconfirm_id || order.easyConfirmId || "").trim();

  return [
    stored,
    localId,
    numeric ? `shopify-${numeric}` : "",
    numeric,
    name,
    name.replace(/^#/, ""),
    name.startsWith("#") ? name : name ? `#${name}` : "",
    number,
    number ? `#${number}` : "",
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

async function fetchEasyConfirmOrderByExternalId(externalId) {
  const id = String(externalId || "").trim();
  if (!id) return null;

  const urls = [
    `${EASYCONFIRM_API_BASE}/orders/${encodeURIComponent(id)}`,
    `${EASYCONFIRM_API_BASE}/orders?externalOrderId=${encodeURIComponent(id)}`,
  ];

  for (const url of urls) {
    const response = await axios.get(url, {
      headers: easyConfirmHeaders(),
      timeout: 20000,
      validateStatus: () => true,
    });
    if (response.status === 404) continue;
    if (response.status >= 400) continue;
    const unwrapped = unwrapEasyConfirmOrder(response.data);
    if (unwrapped) return unwrapped;
    if (Array.isArray(response.data?.data) && response.data.data[0]) {
      return response.data.data[0];
    }
  }

  return null;
}

async function lookupEasyConfirmStatus(order) {
  if (!isEasyConfirmConfigured()) return null;

  for (const candidate of easyConfirmExternalIdCandidates(order)) {
    try {
      const remote = await fetchEasyConfirmOrderByExternalId(candidate);
      if (!remote) continue;
      const customerStatus =
        mapEasyConfirmStatus(remote.status) ||
        mapEasyConfirmStatus(remote.customerAction) ||
        mapEasyConfirmStatus(remote.customer_action) ||
        "pending";
      return {
        remote,
        customerStatus,
        externalOrderId:
          remote.externalOrderId || remote.external_order_id || candidate,
      };
    } catch (error) {
      if (error.code === "MISSING_EASYCONFIRM_KEY") return null;
      console.warn(
        JSON.stringify({
          source: "easyconfirm-api",
          level: "warn",
          message: error.message,
          externalOrderId: candidate,
        }),
      );
    }
  }

  return null;
}

function buildEasyConfirmCreatePayload(order) {
  const lines = Array.isArray(order.cart_items)
    ? order.cart_items
    : Array.isArray(order.cartItems)
      ? order.cartItems
      : [];
  const items = lines
    .map((line) => {
      const quantity = Math.max(1, Number(line?.quantity) || 1);
      const unitPrice = Number(line?.price ?? line?.unit_price ?? 0) || 0;
      return {
        productName: String(
          line?.name || line?.product?.name || line?.product_name || "منتج",
        ).trim(),
        quantity,
        unitPrice,
        totalPrice: quantity * unitPrice,
      };
    })
    .filter((item) => item.productName);

  const phone = toEasyConfirmPhone(order.phone || order.customer_phone);
  const externalOrderId = String(
    order.sourceOrderId || order.id || order.order_id || "",
  ).trim();

  return {
    externalOrderId,
    customerName: String(order.full_name || order.fullName || "عميل").trim(),
    customerPhone: phone,
    customerAddress: String(order.address || "").trim() || undefined,
    subtotal: Number(order.cost) || 0,
    shippingCost: Number(order.shipping_cost ?? order.shippingCost) || 0,
    totalCost: Number(order.total_cost ?? order.totalCost) || 0,
    currency: String(order.shopify_currency || "EGP").trim() || "EGP",
    items,
  };
}

async function ensureEasyConfirmOrder(order) {
  if (!isEasyConfirmConfigured() || !order) return null;
  if (order.easyconfirm_id) return { id: order.easyconfirm_id, created: false };

  const existing = await lookupEasyConfirmStatus(order);
  if (existing?.remote?.id) {
    return { id: existing.remote.id, created: false, existing };
  }

  const payload = buildEasyConfirmCreatePayload(order);
  if (!payload.externalOrderId || !payload.customerPhone) return null;

  const response = await axios.post(`${EASYCONFIRM_API_BASE}/orders`, payload, {
    headers: easyConfirmHeaders(),
    timeout: 20000,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    console.warn(
      JSON.stringify({
        source: "easyconfirm-api",
        level: "warn",
        message: "Failed to create EasyConfirm order",
        status: response.status,
        externalOrderId: payload.externalOrderId,
      }),
    );
    return null;
  }

  const remote = unwrapEasyConfirmOrder(response.data);
  return {
    id: remote?.id || null,
    created: true,
    remote,
  };
}

async function receiveEasyConfirmWebhook({ headers, body }) {
  const { applyEasyConfirmCustomerStatus } = require("./webhookOrders.service");
  const receivedAt = new Date().toISOString();
  const payload = body && typeof body === "object" ? { ...body } : {};

  console.log(
    JSON.stringify({
      source: "easyconfirm-webhook",
      timestamp: receivedAt,
      event: payload.event || null,
      externalOrderId: payload.data?.externalOrderId || null,
    }),
  );

  try {
    const order = await applyEasyConfirmCustomerStatus(payload);
    return { receivedAt, payload, order };
  } catch (error) {
    if (error.code === "ORDER_NOT_FOUND" || error.code === "INVALID_CUSTOMER_STATUS") {
      console.warn(
        JSON.stringify({
          source: "easyconfirm-webhook",
          level: "warn",
          message: error.message,
          code: error.code,
        }),
      );
      return { receivedAt, payload, order: null, warning: error.message };
    }
    throw error;
  }
}

module.exports = {
  isEasyConfirmConfigured,
  mapEasyConfirmStatus,
  easyConfirmExternalIdCandidates,
  lookupEasyConfirmStatus,
  ensureEasyConfirmOrder,
  receiveEasyConfirmWebhook,
};
