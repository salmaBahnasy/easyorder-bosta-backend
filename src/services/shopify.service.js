const crypto = require("crypto");

const { normalizePaymentMethod } = require("../utils/paymentMethod");

const SHOPIFY_ID_PREFIX = "shopify-";
const SHOPIFY_ORDER_TOPICS = new Set([
  "orders/create",
  "orders/updated",
  "orders/edited",
  "orders/paid",
  "orders/cancelled",
  "orders/canceled",
  "orders/fulfilled",
  "orders/partially_fulfilled",
]);

const SHOPIFY_TOPIC_ALIASES = {
  orders_create: "orders/create",
  orders_updated: "orders/updated",
  orders_edited: "orders/edited",
  orders_paid: "orders/paid",
  orders_cancelled: "orders/cancelled",
  orders_canceled: "orders/cancelled",
  orders_fulfilled: "orders/fulfilled",
  orders_partially_fulfilled: "orders/partially_fulfilled",
};
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

function getWebhookSecrets() {
  return [
    process.env.SHOPIFY_WEBHOOK_SECRET,
    process.env.SHOPIFY_WEBHOOK_SECRET_2,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function getWebhookSecret() {
  return getWebhookSecrets()[0] || "";
}

function normalizeShopifyTopic(topic) {
  const raw = String(topic || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  if (SHOPIFY_ORDER_TOPICS.has(raw)) return raw;
  if (SHOPIFY_TOPIC_ALIASES[raw]) return SHOPIFY_TOPIC_ALIASES[raw];
  const slashed = raw.replace(/_/g, "/");
  if (SHOPIFY_ORDER_TOPICS.has(slashed)) return slashed;
  return raw;
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
  const secrets = getWebhookSecrets();
  if (!secrets.length) {
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

  const matched = secrets.some((secret) => {
    const digest = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("base64");
    return timingSafeEqualString(digest, hmacHeader);
  });

  if (!matched) {
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
  const candidates = [
    payload.order,
    payload.data?.order,
    payload.data?.data?.order,
    payload.payload,
    payload,
  ].filter((item) => item && typeof item === "object" && !Array.isArray(item));

  for (const obj of candidates) {
    if (
      obj.id != null ||
      obj.admin_graphql_api_id != null ||
      obj.adminGraphqlApiId != null ||
      obj.legacyResourceId != null ||
      obj.legacy_resource_id != null ||
      obj.order_number != null ||
      obj.orderNumber != null ||
      obj.name != null ||
      obj.line_items != null ||
      obj.lineItems != null
    ) {
      return obj;
    }
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
    stripShopifyGid(order?.legacyResourceId),
    stripShopifyGid(order?.legacy_resource_id),
    stripShopifyGid(order?.id),
    stripShopifyGid(order?.admin_graphql_api_id),
    stripShopifyGid(order?.adminGraphqlApiId),
    order?.order_number,
    order?.orderNumber,
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

function pickShopifyMoney(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === "object") {
      const nested = pickShopifyMoney(
        value.amount,
        value.shop_money?.amount,
        value.shopMoney?.amount,
      );
      if (nested !== "") return toNumber(nested, NaN);
      continue;
    }
    const n = toNumber(value, NaN);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function mapPaymentMethodFromShopify(order) {
  const names = [
    order?.gateway,
    order?.paymentGateway,
    order?.processing_method,
    order?.processingMethod,
    ...(Array.isArray(order?.payment_gateway_names)
      ? order.payment_gateway_names
      : []),
    ...(Array.isArray(order?.paymentGatewayNames)
      ? order.paymentGatewayNames
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
    Boolean(order?.cancelledAt) ||
    Boolean(order?.cancel_reason) ||
    Boolean(order?.cancelReason) ||
    normalizeShopifyTopic(topic) === "orders/cancelled";
  if (cancelled) return "canceled";

  const financial = String(
    order?.financial_status ||
      order?.displayFinancialStatus ||
      order?.display_financial_status ||
      "",
  )
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
  const fulfilment = String(
    order?.fulfillment_status ||
      order?.displayFulfillmentStatus ||
      order?.display_fulfillment_status ||
      "",
  )
    .trim()
    .toLowerCase();
  if (fulfilment === "fulfilled") return "delivered";
  return "in_progress";
}

function mapErpStatusFromShopify(order, topic) {
  const cancelled =
    Boolean(order?.cancelled_at) ||
    Boolean(order?.cancelledAt) ||
    Boolean(order?.cancel_reason) ||
    Boolean(order?.cancelReason) ||
    normalizeShopifyTopic(topic) === "orders/cancelled";
  return cancelled ? "canceled" : "new";
}

function mapAddress(order) {
  const shipping =
    (order?.shipping_address && typeof order.shipping_address === "object"
      ? order.shipping_address
      : null) ||
    (order?.shippingAddress && typeof order.shippingAddress === "object"
      ? order.shippingAddress
      : {}) ||
    {};
  const billing =
    (order?.billing_address && typeof order.billing_address === "object"
      ? order.billing_address
      : null) ||
    (order?.billingAddress && typeof order.billingAddress === "object"
      ? order.billingAddress
      : {}) ||
    {};
  const customer =
    order?.customer && typeof order.customer === "object" ? order.customer : {};
  const defaultAddr =
    (customer.default_address && typeof customer.default_address === "object"
      ? customer.default_address
      : null) ||
    (customer.defaultAddress && typeof customer.defaultAddress === "object"
      ? customer.defaultAddress
      : {}) ||
    {};

  const fullName = firstNonEmptyString(
    shipping.name,
    joinName(shipping.first_name || shipping.firstName, shipping.last_name || shipping.lastName),
    billing.name,
    joinName(billing.first_name || billing.firstName, billing.last_name || billing.lastName),
    joinName(customer.first_name || customer.firstName, customer.last_name || customer.lastName),
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

function extractLineItems(order) {
  if (Array.isArray(order?.line_items)) return order.line_items;
  if (Array.isArray(order?.lineItems)) return order.lineItems;
  if (Array.isArray(order?.lineItems?.nodes)) return order.lineItems.nodes;
  if (Array.isArray(order?.lineItems?.edges)) {
    return order.lineItems.edges
      .map((edge) => edge?.node)
      .filter((node) => node && typeof node === "object");
  }
  return [];
}

function mapLineItems(order) {
  const lines = extractLineItems(order);
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
  const fromSet = pickShopifyMoney(
    order?.total_shipping_price_set,
    order?.totalShippingPriceSet,
    order?.shipping_cost,
    order?.shippingCost,
  );
  if (Number.isFinite(fromSet)) return fromSet;

  const lines = Array.isArray(order?.shipping_lines)
    ? order.shipping_lines
    : Array.isArray(order?.shippingLines)
      ? order.shippingLines
      : [];
  return lines.reduce((sum, line) => sum + toNumber(line.price ?? line.originalPriceSet?.shopMoney?.amount, 0), 0);
}

function isGdprTopic(topic) {
  return SHOPIFY_GDPR_TOPICS.has(normalizeShopifyTopic(topic));
}

function isOrderTopic(topic) {
  const t = normalizeShopifyTopic(topic);
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

  const topic = normalizeShopifyTopic(options.topic || "");
  const address = mapAddress(order);
  const cartItems = mapLineItems(order);
  const shippingCost = resolveShippingCost(order);
  const subtotal = pickShopifyMoney(
    order.subtotal_price,
    order.subtotalPrice,
    order.current_subtotal_price,
    order.currentSubtotalPrice,
    order.total_line_items_price,
    order.totalLineItemsPrice,
    order.subtotalPriceSet,
    order.currentSubtotalPriceSet,
  );
  const total = pickShopifyMoney(
    order.total_price,
    order.totalPrice,
    order.current_total_price,
    order.currentTotalPrice,
    order.totalPriceSet,
    order.currentTotalPriceSet,
  );
  const customerStatus = mapCustomerStatusFromShopify(order, topic);
  const shippingStatus = mapShippingStatusFromShopify(order);
  const erpStatus = mapErpStatusFromShopify(order, topic);
  const billingPhone = firstNonEmptyString(
    order?.billing_address?.phone,
    order?.billingAddress?.phone,
  );
  const phone2 =
    billingPhone && billingPhone !== address.phone ? billingPhone : "";

  return {
    id: localId,
    short_id: firstNonEmptyString(
      order.name,
      order.order_number,
      order.orderNumber,
      localId,
    ),
    full_name: address.fullName,
    phone: address.phone,
    phone2: phone2 || undefined,
    address: address.address,
    government: address.government,
    city: address.city,
    cost: Number.isFinite(subtotal) ? subtotal : 0,
    shipping_cost: shippingCost,
    total_cost: Number.isFinite(total)
      ? total
      : (Number.isFinite(subtotal) ? subtotal : 0) + shippingCost,
    payment_method: mapPaymentMethodFromShopify(order),
    cart_items: cartItems,
    status: erpStatus,
    customer_status: customerStatus,
    customerStatus,
    shipping_status: shippingStatus,
    shippingStatus,
    order_source: "store",
    order_type: "new",
    created_at: order.created_at || order.createdAt || undefined,
    updated_at: order.updated_at || order.updatedAt || undefined,
    platform: "shopify",
    order_platform: "shopify",
    shopify_order_id: resolveShopifyNumericId(order),
    shopify_order_number: order.order_number ?? order.orderNumber ?? null,
    shopify_name: order.name ?? null,
    shopify_financial_status:
      order.financial_status ?? order.displayFinancialStatus ?? null,
    shopify_fulfillment_status:
      order.fulfillment_status ?? order.displayFulfillmentStatus ?? null,
    shopify_gateway: order.gateway ?? order.paymentGateway ?? null,
    shopify_topic: topic || null,
    shopify_currency:
      order.currency || order.presentment_currency || order.currencyCode || null,
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
  normalizeShopifyTopic,
};
