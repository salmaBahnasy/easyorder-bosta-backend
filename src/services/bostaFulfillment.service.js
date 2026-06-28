const axios = require("axios");
const { bosta } = require("../config/env");

const PLATFORM = "custom_api";
const DEFAULT_ORDER_TYPE = "FORWARD";

function getFulfillmentBaseUrl() {
  return (
    process.env.BOSTA_FULFILLMENT_BASE_URL ||
    "https://api-fulfillment.bosta.co/api/v1"
  ).replace(/\/$/, "");
}

function getWebhookUrl() {
  const explicit = (process.env.BOSTA_WEBHOOK_URL || "").trim();
  if (explicit) return explicit;

  const base = (
    process.env.APP_PUBLIC_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    ""
  )
    .trim()
    .replace(/\/$/, "");

  if (!base) {
    const err = new Error(
      "Set BOSTA_WEBHOOK_URL or APP_PUBLIC_BASE_URL for Bosta webhook callbacks",
    );
    err.code = "BOSTA_WEBHOOK_URL_MISSING";
    throw err;
  }

  return `${base}/webhooks/bosta/order-status`;
}

function normalizeFulfillmentApiKey(apiKey) {
  const trimmed = String(apiKey || "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/^bearer\s+/i, "").trim();
}

function fulfillmentHeaders() {
  const fulfillmentKey = normalizeFulfillmentApiKey(
    process.env.BOSTA_FULFILLMENT_API_KEY,
  );
  const shippingKey = normalizeFulfillmentApiKey(bosta.apiKey);
  const key = fulfillmentKey || shippingKey;

  if (!key) {
    const err = new Error(
      "BOSTA_FULFILLMENT_API_KEY is required for send-to-bosta",
    );
    err.code = "BOSTA_API_KEY_MISSING";
    throw err;
  }

  if (!fulfillmentKey && shippingKey) {
    const err = new Error(
      "BOSTA_FULFILLMENT_API_KEY is required — BOSTA_API_KEY is for shipping only, not fulfillment",
    );
    err.code = "BOSTA_FULFILLMENT_API_KEY_MISSING";
    throw err;
  }

  return {
    "x-api-key": key,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const s = String(value).trim();
    if (s) return s;
  }
  return "";
}

function parseCartItems(raw) {
  const arr = raw?.cart_items ?? raw?.cartItems;
  return Array.isArray(arr) ? arr : [];
}

function pickLineQuantity(line) {
  const n = Number(line?.quantity);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
}

function pickLineUnitPrice(line) {
  if (!line || typeof line !== "object") return 0;
  const product =
    line.product && typeof line.product === "object" ? line.product : {};
  const variant =
    line.variant && typeof line.variant === "object" ? line.variant : {};
  const candidates = [
    line.price,
    line.unit_price,
    line.unitPrice,
    variant.sale_price,
    variant.price,
    product.sale_price,
    product.price,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function mapLineToBostaItem(line, index, mappedSku = null) {
  const product =
    line?.product && typeof line.product === "object" ? line.product : {};
  const variant =
    line?.variant && typeof line.variant === "object" ? line.variant : {};
  const vMeta =
    variant.metadata && typeof variant.metadata === "object"
      ? variant.metadata
      : {};

  const skuCode = firstNonEmpty(
    mappedSku,
    variant.sku,
    variant.taager_code,
    line.variant_sku,
    line.variantSku,
    vMeta.sku,
    line.sku,
    product.sku,
    product.code,
    line.product_sku,
    line.product_id,
    line.productId,
    `item-${index + 1}`,
  );

  return {
    skuCode: String(skuCode),
    quantity: pickLineQuantity(line),
    price: pickLineUnitPrice(line),
  };
}

async function buildBostaItemsFromOrder(localOrder, overrides = {}) {
  const { validateOrderLinesInventory } = require("./bostaSkuMappings.service");
  const cartLines = parseCartItems(localOrder);

  if (!cartLines.length) {
    return [
      {
        skuCode: firstNonEmpty(overrides.defaultSkuCode, "order-items"),
        quantity: 1,
        price: Number(pickOrderCodAmount(localOrder, overrides)) || 0,
      },
    ];
  }

  const { items: resolvedItems } = await validateOrderLinesInventory(localOrder);

  return resolvedItems.map((resolved, index) => {
    const line = cartLines[resolved.lineIndex ?? index];
    return mapLineToBostaItem(line, index, resolved.skuCode);
  });
}

function pickOrderCodAmount(raw, overrides = {}) {
  if (
    overrides.codAmount != null &&
    String(overrides.codAmount).trim() !== ""
  ) {
    return String(overrides.codAmount);
  }
  const candidates = [
    raw?.total_cost,
    raw?.totalCost,
    raw?.total,
    raw?.cost,
    raw?.cod,
    raw?.codAmount,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 0) return String(n);
  }
  return "0";
}

function buildValidationError(message, code = "BOSTA_ORDER_MAPPING_ERROR") {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Map stored order (mapStoredOrderToClient shape) → Bosta fulfillment payload.
 */
async function mapLocalOrderToBostaPayload(localOrder, overrides = {}) {
  if (!localOrder || typeof localOrder !== "object") {
    throw buildValidationError("Invalid order payload");
  }

  const orderAlias = firstNonEmpty(
    overrides.orderAlias,
    localOrder.order_reference,
    localOrder.orderReference,
    localOrder.sourceOrderId,
    localOrder.id,
  );
  if (!orderAlias) {
    throw buildValidationError(
      "orderAlias is required (order reference or id)",
    );
  }

  const cityId = firstNonEmpty(
    overrides.cityId,
    localOrder.bosta_city_id,
    localOrder.bostaCityId,
    localOrder.city_id,
    localOrder.cityId,
  );
  if (!cityId) {
    throw buildValidationError(
      "cityId is required (send in body or save bosta_city_id on the order)",
    );
  }

  const firstLine = firstNonEmpty(
    overrides.firstLine,
    localOrder.address,
    localOrder.firstLine,
    localOrder.shipping_address,
  );
  if (!firstLine) {
    throw buildValidationError("shipping address firstLine is required");
  }

  const districtId = firstNonEmpty(
    overrides.districtId,
    localOrder.bosta_district_id,
    localOrder.bostaDistrictId,
    localOrder.district_id,
    localOrder.districtId,
  );
  const cityName = firstNonEmpty(
    overrides.cityName,
    localOrder.city,
    localOrder.government,
    localOrder.cityName,
  );

  const items = await buildBostaItemsFromOrder(localOrder, overrides);

  const mobile = firstNonEmpty(
    overrides.mobile,
    localOrder.phone,
    localOrder.mobile,
  );
  if (!mobile) {
    throw buildValidationError("customer mobile is required");
  }

  const shippingAddress = {
    firstLine,
    cityId,
    ...(cityName ? { cityName } : {}),
    ...(districtId ? { districtId } : {}),
  };

  const payload = {
    orderAlias: String(orderAlias),
    items,
    shippingAddress,
    shipment: {
      codAmount: pickOrderCodAmount(localOrder, overrides),
      note:
        firstNonEmpty(overrides.note, localOrder.note, localOrder.notes) || "",
      allowToOpenPackage: Boolean(
        overrides.allowToOpenPackage ??
        localOrder.allow_to_open_package ??
        localOrder.allowToOpenPackage ??
        false,
      ),
    },
    customer: {
      firstName: firstNonEmpty(
        overrides.firstName,
        localOrder.full_name,
        localOrder.firstName,
        "Customer",
      ),
      mobile,
    },
    externalPlatform: {
      platform: PLATFORM,
      webhookUrl: getWebhookUrl(),
    },
    type: firstNonEmpty(overrides.type, DEFAULT_ORDER_TYPE),
  };

  return payload;
}

function mapBostaStatusToShippingStatus(status) {
  const key = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  if (
    key.includes("deliver") ||
    key === "completed" ||
    key === "success" ||
    key === "successful"
  ) {
    return "delivered";
  }

  if (
    key.includes("fail") ||
    key.includes("cancel") ||
    key.includes("return") ||
    key.includes("reject")
  ) {
    return "failed";
  }

  return "in_progress";
}

function pickBostaApiErrorMessage(data, fallback) {
  if (!data || typeof data !== "object") return fallback;
  const fromMessages = Array.isArray(data.messages)
    ? data.messages.find((m) => m != null && String(m).trim())
    : null;
  return (
    data.message ||
    data.error ||
    (fromMessages != null ? String(fromMessages) : "") ||
    fallback
  );
}

async function postFulfillment(path, body) {
  const url = `${getFulfillmentBaseUrl()}${path}`;
  const response = await axios.post(url, body, {
    headers: fulfillmentHeaders(),
    timeout: 120000,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const err = new Error(
      pickBostaApiErrorMessage(
        response.data,
        `Bosta fulfillment API returned ${response.status}`,
      ),
    );
    err.code = "BOSTA_API_ERROR";
    err.status = response.status;
    err.details = response.data;
    throw err;
  }

  return response.data;
}

async function createFulfillmentOrder(payload) {
  return postFulfillment("/orders", payload);
}

async function createFulfillmentOrdersBulk(payloads) {
  return postFulfillment("/orders/bulk", payloads);
}

async function getFulfillment(path, params = {}) {
  const url = `${getFulfillmentBaseUrl()}${path}`;
  const response = await axios.get(url, {
    headers: fulfillmentHeaders(),
    params,
    timeout: 120000,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const err = new Error(
      pickBostaApiErrorMessage(
        response.data,
        `Bosta fulfillment API returned ${response.status}`,
      ),
    );
    err.code = "BOSTA_API_ERROR";
    err.status = response.status;
    err.details = response.data;
    throw err;
  }

  return response.data;
}

/** skuCode → availableQuantity (مجموع لو نفس SKU في أكثر من hub) */
async function fetchBostaInventoryAvailabilityMap() {
  const pageSize = Math.min(
    Number(process.env.BOSTA_INVENTORY_PAGE_SIZE) || 100,
    500,
  );
  const availability = new Map();
  let page = 1;

  for (;;) {
    const response = await getFulfillment("/inventory/products", {
      limit: pageSize,
      page,
    });

    const rows = Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response)
        ? response
        : [];

    if (!rows.length) break;

    for (const row of rows) {
      const sku = String(row?.skuCode || "").trim();
      if (!sku) continue;
      const qty = Number(row?.availableQuantity);
      const available = Number.isFinite(qty) && qty > 0 ? qty : 0;
      availability.set(sku, (availability.get(sku) || 0) + available);
    }

    if (rows.length < pageSize) break;
    page += 1;
    if (page > 100) break;
  }

  return availability;
}

module.exports = {
  PLATFORM,
  DEFAULT_ORDER_TYPE,
  getWebhookUrl,
  mapLocalOrderToBostaPayload,
  mapBostaStatusToShippingStatus,
  createFulfillmentOrder,
  createFulfillmentOrdersBulk,
  fetchBostaInventoryAvailabilityMap,
  getFulfillment,
};
