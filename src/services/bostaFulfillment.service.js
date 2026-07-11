const axios = require("axios");
const { bosta } = require("../config/env");
const { isInstapayPaymentMethod } = require("../utils/paymentMethod");

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
  let url;
  if (explicit) {
    url = explicit;
  } else {
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

    url = `${base}/webhooks/bosta/order-status`;
  }

  const secret = (process.env.BOSTA_WEBHOOK_SECRET || "").trim();
  if (secret && !/[?&]secret=/.test(url)) {
    const sep = url.includes("?") ? "&" : "?";
    url = `${url}${sep}secret=${encodeURIComponent(secret)}`;
  }

  return url;
}

function normalizeFulfillmentApiKey(apiKey) {
  let trimmed = String(apiKey || "").trim();
  if (!trimmed) return "";
  trimmed = trimmed.replace(/^bearer\s+/i, "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isFulfillmentApiKey(apiKey) {
  return /^boost_/i.test(normalizeFulfillmentApiKey(apiKey));
}

function resolveFulfillmentApiKey() {
  const fulfillmentKey = normalizeFulfillmentApiKey(
    process.env.BOSTA_FULFILLMENT_API_KEY,
  );
  if (fulfillmentKey) return fulfillmentKey;

  const shippingKey = normalizeFulfillmentApiKey(bosta.apiKey);
  if (isFulfillmentApiKey(shippingKey)) return shippingKey;

  return "";
}

function fulfillmentHeaders() {
  const key = resolveFulfillmentApiKey();

  if (!key) {
    const err = new Error(
      "Set BOSTA_FULFILLMENT_API_KEY (boost_...) for send-to-bosta",
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

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function pickUserEnteredLineUnitPrice(line, priceOverride) {
  if (priceOverride != null && priceOverride !== "") {
    const fromOverride = Number(priceOverride);
    if (Number.isFinite(fromOverride) && fromOverride >= 0) {
      return roundMoney(fromOverride);
    }
  }
  if (!line || typeof line !== "object") return null;

  const candidates = [line.price, line.unit_price, line.unitPrice];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 0) return roundMoney(n);
  }
  return null;
}

function pickLineUnitPrice(line) {
  if (!line || typeof line !== "object") return 0;
  const product =
    line.product && typeof line.product === "object" ? line.product : {};
  const variant =
    line.variant && typeof line.variant === "object" ? line.variant : {};
  const quantity = pickLineQuantity(line);

  const lineTotalCandidates = [
    line.line_total,
    line.lineTotal,
    line.total_price,
    line.totalPrice,
  ];
  for (const candidate of lineTotalCandidates) {
    const total = Number(candidate);
    if (Number.isFinite(total) && total >= 0) {
      return roundMoney(total / quantity);
    }
  }

  const candidates = [
    line.final_price,
    line.finalPrice,
    line.discounted_price,
    line.discountedPrice,
    line.discounted_unit_price,
    line.discountedUnitPrice,
    line.price,
    line.unit_price,
    line.unitPrice,
    variant.final_price,
    variant.finalPrice,
    variant.sale_price,
    variant.price,
    product.sale_price,
    product.price,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 0) return roundMoney(n);
  }
  return 0;
}

/** subtotal المنتجات بعد تعديل الموظف */
function pickEmployeeEditedProductsSubtotal(raw) {
  if (!raw || typeof raw !== "object") return null;

  const shipping = Number(
    firstNonEmpty(raw.shipping_cost, raw.shippingCost, raw.shipping),
  );
  const shippingAmount =
    Number.isFinite(shipping) && shipping >= 0 ? shipping : 0;

  const total = Number(
    firstNonEmpty(raw.total_cost, raw.totalCost, raw.total),
  );
  let impliedFromTotal = null;
  if (Number.isFinite(total) && total >= 0) {
    impliedFromTotal = roundMoney(Math.max(0, total - shippingAmount));
  }

  const cost = Number(raw.cost);
  const hasCost = Number.isFinite(cost) && cost >= 0;

  if (hasCost && impliedFromTotal != null) {
    // الموظف عدّل الإجمالي (خصم) من غير cost → نستخدم total_cost − shipping
    if (impliedFromTotal < cost - 0.01) return impliedFromTotal;
    return roundMoney(cost);
  }
  if (hasCost) return roundMoney(cost);
  if (impliedFromTotal != null) return impliedFromTotal;

  return null;
}

/**
 * أسعار المنتجات المرسلة لبوسطا = السعر اللي عدّله الموظف (cost / total_cost)
 * وليس سعر الكatalog القديم في cart_items.
 */
function resolveEmployeeEditedLineUnitPrices(localOrder, cartLines) {
  if (!cartLines.length) return [];

  const quantities = cartLines.map((line) => pickLineQuantity(line));
  const linePrices = cartLines.map((line) => pickLineUnitPrice(line));
  const linesSubtotal = linePrices.reduce(
    (sum, price, index) => sum + price * quantities[index],
    0,
  );

  const editedSubtotal = pickEmployeeEditedProductsSubtotal(localOrder);

  if (editedSubtotal == null) {
    return linePrices;
  }

  if (cartLines.length === 1) {
    return [roundMoney(editedSubtotal / quantities[0])];
  }

  if (linesSubtotal > 0 && Math.abs(linesSubtotal - editedSubtotal) < 0.01) {
    return linePrices;
  }

  if (linesSubtotal <= 0) {
    const even = roundMoney(editedSubtotal / quantities.reduce((a, b) => a + b, 0));
    return quantities.map(() => even);
  }

  const factor = editedSubtotal / linesSubtotal;
  return linePrices.map((price) => roundMoney(price * factor));
}

function mapLineToBostaItem(line, index, mappedSku = null, unitPriceOverride = null) {
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

  const unitPrice = pickUserEnteredLineUnitPrice(line, unitPriceOverride);
  if (unitPrice == null) {
    const err = new Error(`سعر المنتج مطلوب للسطر ${index + 1}`);
    err.statusCode = 400;
    throw err;
  }

  return {
    skuCode: String(skuCode),
    quantity: pickLineQuantity(line),
    price: unitPrice,
  };
}

async function buildBostaItemsFromOrder(localOrder, overrides = {}) {
  const {
    validateOrderLinesInventory,
    applyLineSkuOverridesToOrder,
  } = require("./bostaSkuMappings.service");
  const cartLines = parseCartItems(localOrder);

  if (!cartLines.length) {
    return [
      {
        skuCode: firstNonEmpty(
          overrides.defaultSkuCode,
          overrides.lineSkuOverrides?.get?.(0),
          "order-items",
        ),
        quantity: 1,
        price: Number(pickOrderCodAmount(localOrder, overrides)) || 0,
      },
    ];
  }

  const orderForSku = applyLineSkuOverridesToOrder(
    localOrder,
    overrides.lineSkuOverrides,
    overrides.linePriceOverrides,
  );
  const cartForPricing = parseCartItems(orderForSku);
  const priceOverrides = overrides.linePriceOverrides;
  const { items: resolvedItems } =
    await validateOrderLinesInventory(orderForSku);

  return resolvedItems.map((resolved, index) => {
    const lineIndex = resolved.lineIndex ?? index;
    const line = cartForPricing[lineIndex];
    const priceOverride = priceOverrides?.get?.(lineIndex);
    return mapLineToBostaItem(
      line,
      lineIndex,
      resolved.skuCode,
      priceOverride,
    );
  });
}

function resolvePaymentMethod(raw) {
  return firstNonEmpty(raw?.payment_method, raw?.paymentMethod);
}

function pickOrderCodAmount(raw, overrides = {}) {
  if (
    overrides.codAmount != null &&
    String(overrides.codAmount).trim() !== ""
  ) {
    return String(overrides.codAmount);
  }

  const paymentMethod = firstNonEmpty(
    overrides.paymentMethod,
    overrides.payment_method,
    resolvePaymentMethod(raw),
  );
  if (isInstapayPaymentMethod(paymentMethod)) {
    return "0";
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

const BOSTA_MIN_FIRST_LINE_LENGTH = 10;

function resolveShippingFirstLine(localOrder, overrides = {}) {
  const parts = [
    overrides.firstLine,
    localOrder.address,
    localOrder.firstLine,
    localOrder.shipping_address,
    localOrder.street,
    localOrder.building,
    localOrder.landmark,
    localOrder.district,
    localOrder.area,
    localOrder.zone,
    localOrder.neighborhood,
    overrides.cityName,
    localOrder.city,
    localOrder.government,
    localOrder.cityName,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  const firstLine = [...new Set(parts)].join("، ").trim();

  if (!firstLine) {
    throw buildValidationError(
      "shipping address firstLine is required (عنوان الشحن مطلوب)",
    );
  }

  if (firstLine.length >= BOSTA_MIN_FIRST_LINE_LENGTH) {
    return firstLine;
  }

  throw buildValidationError(
    `shipping address must be at least ${BOSTA_MIN_FIRST_LINE_LENGTH} characters (عنوان الشحن قصير جداً — أضيفي تفاصيل أكثر)`,
  );
}

function resolveShipmentNote(localOrder, overrides = {}) {
  const note = firstNonEmpty(overrides.note, localOrder.note, localOrder.notes);
  return note || null;
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

  const firstLine = resolveShippingFirstLine(localOrder, overrides);

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

  const shipmentNote = resolveShipmentNote(localOrder, overrides);

  const payload = {
    orderAlias: String(orderAlias),
    items,
    shippingAddress,
    shipment: {
      codAmount: pickOrderCodAmount(localOrder, overrides),
      ...(shipmentNote ? { note: shipmentNote } : {}),
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

/** skuCode → { availableQuantity, name, description } */
async function fetchBostaInventoryDetailsMap() {
  const pageSize = Math.min(
    Number(process.env.BOSTA_INVENTORY_PAGE_SIZE) || 100,
    500,
  );
  const details = new Map();
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
      const existing = details.get(sku);
      if (existing) {
        existing.availableQuantity += available;
        if (!existing.name && row?.name) {
          existing.name = String(row.name).trim();
        }
      } else {
        details.set(sku, {
          availableQuantity: available,
          name: String(row?.name || "").trim(),
          description: String(row?.description || "").trim(),
        });
      }
    }

    if (rows.length < pageSize) break;
    page += 1;
    if (page > 100) break;
  }

  return details;
}

/** skuCode → availableQuantity (مجموع لو نفس SKU في أكثر من hub) */
async function fetchBostaInventoryAvailabilityMap() {
  const details = await fetchBostaInventoryDetailsMap();
  const availability = new Map();
  for (const [sku, info] of details) {
    availability.set(sku, info.availableQuantity);
  }
  return availability;
}

function getFulfillmentKeyDiagnostics() {
  const fulfillmentEnv = normalizeFulfillmentApiKey(
    process.env.BOSTA_FULFILLMENT_API_KEY,
  );
  const bostaApiEnv = normalizeFulfillmentApiKey(bosta.apiKey);
  const resolved = resolveFulfillmentApiKey();

  let resolvedSource = "none";
  if (fulfillmentEnv) resolvedSource = "BOSTA_FULFILLMENT_API_KEY";
  else if (isFulfillmentApiKey(bostaApiEnv)) resolvedSource = "BOSTA_API_KEY";

  return {
    hasFulfillmentEnv: Boolean(fulfillmentEnv),
    hasBostaApiKeyEnv: Boolean(bostaApiEnv),
    resolvedSource,
    keyPrefix: resolved ? `${resolved.slice(0, 8)}...` : null,
    keyLength: resolved ? resolved.length : 0,
    looksLikeBoostKey: isFulfillmentApiKey(resolved),
    looksLikeEasyOrderKey: /^[0-9a-f-]{36}$/i.test(resolved),
  };
}

module.exports = {
  PLATFORM,
  DEFAULT_ORDER_TYPE,
  getWebhookUrl,
  firstNonEmpty,
  mapLocalOrderToBostaPayload,
  mapBostaStatusToShippingStatus,
  createFulfillmentOrder,
  createFulfillmentOrdersBulk,
  fetchBostaInventoryAvailabilityMap,
  fetchBostaInventoryDetailsMap,
  getFulfillment,
  getFulfillmentKeyDiagnostics,
};
