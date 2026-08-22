const crypto = require("crypto");

const { normalizePaymentMethod } = require("../utils/paymentMethod");

const SHOPIFY_ID_PREFIX = "shopify-";
const SHOPIFY_ORDER_TOPICS = new Set([
  "orders/create",
  "orders/updated",
  "orders/edited",
  "orders/paid",
  "orders/cancelled",
  "orders/fulfilled",
  "orders/partially_fulfilled",
]);
const SHOPIFY_GDPR_TOPICS = new Set([
  "customers/data_request",
  "customers/redact",
  "shop/redact",
]);

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const s = String(value).trim();
    if (s) return s;
  }
  return "";
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getWebhookSecret() {
  return (process.env.SHOPIFY_WEBHOOK_SECRET || "").trim();
}

function getConfiguredShopDomain() {
  return (process.env.SHOPIFY_SHOP_DOMAIN || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/**
 * Shopify HMAC-SHA256 of the raw JSON body (base64), header X-Shopify-Hmac-Sha256.
 */
function verifyShopifyWebhook(req) {
  const secret = getWebhookSecret();
  if (!secret) {
    const err = new Error("SHOPIFY_WEBHOOK_SECRET is not configured");
    err.code = "MISSING_SHOPIFY_SECRET";
    err.statusCode = 500;
    throw err;
  }

  const hmacHeader = firstNonEmptyString(
    req.get("x-shopify-hmac-sha256"),
    req.get("X-Shopify-Hmac-Sha256"),
  );
  if (!hmacHeader) {
    const err = new Error("Missing Shopify HMAC header");
    err.code = "INVALID_SHOPIFY_HMAC";
    err.statusCode = 401;
    throw err;
  }

  const rawBody = req.rawBody;
  if (!rawBody || !Buffer.isBuffer(rawBody)) {
    const err = new Error("Raw webhook body is required for Shopify HMAC");
    err.code = "MISSING_SHOPIFY_RAW_BODY";
    err.statusCode = 401;
    throw err;
  }

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  if (!timingSafeEqualString(digest, hmacHeader)) {
    const err = new Error("Invalid Shopify HMAC");
    err.code = "INVALID_SHOPIFY_HMAC";
    err.statusCode = 401;
    throw err;
  }

  const expectedShop = getConfiguredShopDomain();
  if (expectedShop) {
    const incomingShop = firstNonEmptyString(
      req.get("x-shopify-shop-domain"),
      req.get("X-Shopify-Shop-Domain"),
    )
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
    if (incomingShop && incomingShop !== expectedShop) {
      const err = new Error("Unexpected Shopify shop domain");
      err.code = "INVALID_SHOPIFY_SHOP";
      err.statusCode = 401;
      throw err;
    }
  }

  return true;
}

function unwrapShopifyOrder(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  if (payload.order && typeof payload.order === "object") {
    return payload.order;
  }
  if (payload.id != null || payload.order_number != null || payload.line_items) {
    return payload;
  }
  return null;
}

function stripShopifyGid(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(/gid:\/\/shopify\/Order\/(\d+)/i);
  if (match) return match[1];
  return raw;
}

function resolveShopifyNumericId(order) {
  return firstNonEmptyString(
    stripShopifyGid(order?.id),
    stripShopifyGid(order?.admin_graphql_api_id),
    order?.order_number,
  );
}

function buildLocalOrderId(order) {
  const numeric = resolveShopifyNumericId(order);
  if (!numeric) return "";
  return `${SHOPIFY_ID_PREFIX}${numeric}`;
}

function isShopifyOrder(order = {}) {
  const platform = firstNonEmptyString(
    order.platform,
    order.order_platform,
    order.orderPlatform,
  ).toLowerCase();
  if (platform === "shopify") return true;
  const id = firstNonEmptyString(
    order.sourceOrderId,
    order.id,
    order.order_id,
    order.orderId,
  );
  return id.startsWith(SHOPIFY_ID_PREFIX);
}

function joinName(first, last) {
  return [first, last]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(" ");
}

function mapPaymentMethodFromShopify(order) {
  const names = [
    order?.gateway,
    order?.processing_method,
    ...(Array.isArray(order?.payment_gateway_names)
      ? order.payment_gateway_names
      : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (names.includes("instapay")) return "instapay";
  if (
    names.includes("cod") ||
    names.includes("cash on delivery") ||
    names.includes("cash_on_delivery") ||
    names.includes("cash-on-delivery")
  ) {
    return "cod";
  }

  const normalized = normalizePaymentMethod(order?.gateway);
  return normalized || "cod";
}

function mapCustomerStatusFromShopify(order, topic) {
  const cancelled =
    Boolean(order?.cancelled_at) ||
    Boolean(order?.cancel_reason) ||
    String(topic || "").toLowerCase() === "orders/cancelled";
  if (cancelled) return "canceled";

  const financial = String(order?.financial_status || "")
    .trim()
    .toLowerCase();
  const paymentMethod = mapPaymentMethodFromShopify(order);
  if (
    paymentMethod !== "cod" &&
    (financial === "paid" || financial === "partially_paid")
  ) {
    return "confirmed";
  }

  return "pending";
}

function mapShippingStatusFromShopify(order) {
  const fulfilment = String(order?.fulfillment_status || "")
    .trim()
    .toLowerCase();
  if (fulfilment === "fulfilled") return "delivered";
  return "in_progress";
}

function mapErpStatusFromShopify(order, topic) {
  const cancelled =
    Boolean(order?.cancelled_at) ||
    Boolean(order?.cancel_reason) ||
    String(topic || "").toLowerCase() === "orders/cancelled";
  return cancelled ? "canceled" : "new";
}

function mapAddress(order) {
  const shipping =
    order?.shipping_address && typeof order.shipping_address === "object"
      ? order.shipping_address
      : {};
  const billing =
    order?.billing_address && typeof order.billing_address === "object"
      ? order.billing_address
      : {};
  const customer =
    order?.customer && typeof order.customer === "object" ? order.customer : {};
  const defaultAddr =
    customer.default_address && typeof customer.default_address === "object"
      ? customer.default_address
      : {};

  const fullName = firstNonEmptyString(
    shipping.name,
    joinName(shipping.first_name, shipping.last_name),
    billing.name,
    joinName(billing.first_name, billing.last_name),
    joinName(customer.first_name, customer.last_name),
    order?.email,
  );

  const phone = firstNonEmptyString(
    shipping.phone,
    billing.phone,
    customer.phone,
    defaultAddr.phone,
  );

  const address = firstNonEmptyString(
    [shipping.address1, shipping.address2].filter(Boolean).join(" ").trim(),
    [billing.address1, billing.address2].filter(Boolean).join(" ").trim(),
    [defaultAddr.address1, defaultAddr.address2].filter(Boolean).join(" ").trim(),
  );

  const government = firstNonEmptyString(
    shipping.province,
    shipping.city,
    billing.province,
    billing.city,
    defaultAddr.province,
    defaultAddr.city,
  );

  const city = firstNonEmptyString(
    shipping.city,
    billing.city,
    defaultAddr.city,
  );

  return { fullName, phone, address, government, city };
}

function mapLineItems(order) {
  const lines = Array.isArray(order?.line_items) ? order.line_items : [];
  return lines.map((line) => {
    const name = firstNonEmptyString(
      line.title,
      line.name,
      line.variant_title,
      "منتج",
    );
    const sku = firstNonEmptyString(line.sku, line.variant_id);
    const quantity = toNumber(line.quantity, 0);
    const unitPrice = toNumber(line.price, 0);
    const image = firstNonEmptyString(
      line.image,
      Array.isArray(line.properties)
        ? line.properties.find((p) => /image|img/i.test(String(p?.name)))
            ?.value
        : "",
    );

    return {
      id: line.id,
      product_id: line.product_id,
      quantity,
      price: unitPrice,
      sku,
      name,
      product: {
        id: line.product_id,
        name,
        sku,
        thumbnail: image || undefined,
      },
      variant: {
        id: line.variant_id,
        sku,
        title: firstNonEmptyString(line.variant_title),
        size: firstNonEmptyString(line.variant_title),
      },
    };
  });
}

function resolveShippingCost(order) {
  const fromSet = toNumber(
    order?.total_shipping_price_set?.shop_money?.amount,
    NaN,
  );
  if (Number.isFinite(fromSet)) return fromSet;

  const lines = Array.isArray(order?.shipping_lines) ? order.shipping_lines : [];
  return lines.reduce((sum, line) => sum + toNumber(line.price, 0), 0);
}

function isGdprTopic(topic) {
  return SHOPIFY_GDPR_TOPICS.has(String(topic || "").trim().toLowerCase());
}

function isOrderTopic(topic) {
  const t = String(topic || "").trim().toLowerCase();
  if (!t) return true;
  return SHOPIFY_ORDER_TOPICS.has(t);
}

/**
 * Convert a Shopify Admin REST order webhook into the EasyOrder-shaped
 * payload that addWebhookOrder / the dashboard already understand.
 */
function mapShopifyOrderToLocal(payload, options = {}) {
  const order = unwrapShopifyOrder(payload);
  if (!order) return null;

  const localId = buildLocalOrderId(order);
  if (!localId) return null;

  const topic = options.topic || "";
  const address = mapAddress(order);
  const cartItems = mapLineItems(order);
  const shippingCost = resolveShippingCost(order);
  const subtotal = toNumber(order.subtotal_price, toNumber(order.total_line_items_price));
  const total = toNumber(order.total_price, subtotal + shippingCost);
  const customerStatus = mapCustomerStatusFromShopify(order, topic);
  const shippingStatus = mapShippingStatusFromShopify(order);
  const erpStatus = mapErpStatusFromShopify(order, topic);
  const phone2 = firstNonEmptyString(
    order?.billing_address?.phone &&
      order.billing_address.phone !== address.phone
      ? order.billing_address.phone
      : "",
  );

  return {
    id: localId,
    short_id: firstNonEmptyString(order.name, order.order_number, localId),
    full_name: address.fullName,
    phone: address.phone,
    phone2: phone2 || undefined,
    address: address.address,
    government: address.government,
    city: address.city,
    cost: subtotal,
    shipping_cost: shippingCost,
    total_cost: total,
    payment_method: mapPaymentMethodFromShopify(order),
    cart_items: cartItems,
    status: erpStatus,
    customer_status: customerStatus,
    customerStatus,
    shipping_status: shippingStatus,
    shippingStatus,
    order_source: "store",
    order_type: "new",
    created_at: order.created_at || undefined,
    updated_at: order.updated_at || undefined,
    platform: "shopify",
    order_platform: "shopify",
    shopify_order_id: resolveShopifyNumericId(order),
    shopify_order_number: order.order_number ?? null,
    shopify_name: order.name ?? null,
    shopify_financial_status: order.financial_status ?? null,
    shopify_fulfillment_status: order.fulfillment_status ?? null,
    shopify_gateway: order.gateway ?? null,
    shopify_topic: topic || null,
    shopify_currency: order.currency || order.presentment_currency || null,
  };
}

module.exports = {
  SHOPIFY_ID_PREFIX,
  verifyShopifyWebhook,
  mapShopifyOrderToLocal,
  isShopifyOrder,
  isGdprTopic,
  isOrderTopic,
  unwrapShopifyOrder,
};
