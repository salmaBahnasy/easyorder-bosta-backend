const crypto = require("crypto");

const axios = require("axios");

const { normalizePaymentMethod } = require("../utils/paymentMethod");

const SHOPIFY_ID_PREFIX = "shopify-";
const SHOPIFY_API_VERSION = "2026-07";
const SHOPIFY_PAGE_LIMIT = 250;
const SHOPIFY_PRODUCTS_QUERY = `
  query ShopifyProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          legacyResourceId
          title
          handle
          status
          vendor
          productType
          tags
          createdAt
          updatedAt
          featuredImage { url }
          images(first: 20) {
            edges { node { url } }
          }
          variants(first: 100) {
            edges {
              node {
                id
                legacyResourceId
                sku
                barcode
                price
                inventoryQuantity
                title
              }
            }
          }
        }
      }
    }
  }
`;
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
  order_create: "orders/create",
  "order/create": "orders/create",
  orders_updated: "orders/updated",
  order_updated: "orders/updated",
  "order/updated": "orders/updated",
  orders_edited: "orders/edited",
  orders_paid: "orders/paid",
  orders_cancelled: "orders/cancelled",
  orders_canceled: "orders/cancelled",
  order_cancelled: "orders/cancelled",
  "order/cancelled": "orders/cancelled",
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
    .map((value) =>
      String(value || "")
        .trim()
        .replace(/^['"]|['"]$/g, ""),
    )
    .filter(Boolean);
}

function normalizeShopDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.myshopify\.com$/, "");
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
  return String(process.env.SHOPIFY_SHOP_DOMAIN || "")
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

  const hmacClean = hmacHeader.trim();
  const matched = secrets.some((secret) => {
    const digestB64 = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("base64");
    const digestHex = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");
    return (
      timingSafeEqualString(digestB64, hmacClean) ||
      timingSafeEqualString(digestHex, hmacClean)
    );
  });

  if (!matched) {
    const err = new Error("Invalid Shopify HMAC");
    err.code = "INVALID_SHOPIFY_HMAC";
    err.statusCode = 401;
    throw err;
  }

  const expectedShop = getConfiguredShopDomain();
  const incomingShop = firstNonEmptyString(
    req.get("x-shopify-shop-domain"),
    req.get("X-Shopify-Shop-Domain"),
  );
  if (
    expectedShop &&
    incomingShop &&
    normalizeShopDomain(incomingShop) !== normalizeShopDomain(expectedShop)
  ) {
    console.warn(
      JSON.stringify({
        source: "shopify-webhook",
        level: "warn",
        message: "Shopify shop domain differs from SHOPIFY_SHOP_DOMAIN",
        incomingShop,
        expectedShop,
      }),
    );
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
    payload.data?.orderCreate?.order,
    payload.data?.ordersCreate?.order,
    payload.data?.data?.order,
    Array.isArray(payload.orders) ? payload.orders[0] : null,
    payload.payload,
    payload.data,
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
  const match = raw.match(/gid:\/\/shopify\/[^/]+\/(\d+)/i);
  if (match) return match[1];
  return raw;
}

function getShopifyAccessToken() {
  return String(process.env.SHOPIFY_ACCESS_TOKEN || "").trim();
}

function parseShopifyNextPageInfo(linkHeader) {
  const link = String(linkHeader || "");
  const nextMatch = link.match(
    /<[^>]*[?&]page_info=([^&>]+)[^>]*>; rel="next"/,
  );
  return nextMatch ? decodeURIComponent(nextMatch[1]) : "";
}

function formatShopifyErrorBody(data) {
  if (data == null) return "";
  if (typeof data === "string") {
    const trimmed = data.trim();
    const titleMatch = trimmed.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) return titleMatch[1].trim();
    return trimmed.slice(0, 300);
  }
  if (typeof data.errors === "string") return data.errors;
  if (Array.isArray(data.errors)) {
    return data.errors
      .map((item) => item?.message || JSON.stringify(item))
      .filter(Boolean)
      .join("; ");
  }
  if (data.errors && typeof data.errors === "object") {
    return JSON.stringify(data.errors);
  }
  if (data.error) return String(data.error);
  return "";
}

function shopifyAdminError(response) {
  const details = formatShopifyErrorBody(response?.data);
  const err = new Error(
    details || `Shopify API returned ${response?.status}`,
  );
  err.code = "SHOPIFY_HTTP_ERROR";
  err.status = response?.status;
  err.statusCode = response?.status;
  err.details = response?.data;
  return err;
}

function isShopifyAuthFailure(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  if (
    error?.code === "MISSING_SHOPIFY_TOKEN" ||
    error?.code === "MISSING_SHOPIFY_SHOP"
  ) {
    return true;
  }
  if (status === 401 || status === 403) return true;
  const text = [
    error?.message,
    formatShopifyErrorBody(error?.details),
    formatShopifyErrorBody(error?.response?.data),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    text.includes("invalid api key") ||
    text.includes("unrecognized login") ||
    text.includes("access token")
  );
}

function assertShopifyAdminConfig() {
  const shop = getConfiguredShopDomain();
  const token = getShopifyAccessToken();
  if (!shop) {
    const err = new Error("SHOPIFY_SHOP_DOMAIN is not set");
    err.code = "MISSING_SHOPIFY_SHOP";
    throw err;
  }
  if (!token) {
    const err = new Error("SHOPIFY_ACCESS_TOKEN is not set");
    err.code = "MISSING_SHOPIFY_TOKEN";
    throw err;
  }
  return { shop, token };
}

function unwrapGraphqlConnection(connection) {
  if (!connection) return [];
  if (Array.isArray(connection.nodes)) return connection.nodes.filter(Boolean);
  if (Array.isArray(connection.edges)) {
    return connection.edges.map((edge) => edge?.node).filter(Boolean);
  }
  return [];
}

function normalizeGraphqlProduct(node) {
  if (!node || typeof node !== "object") return null;
  const variants = unwrapGraphqlConnection(node.variants).map((variant) => ({
    id: variant.legacyResourceId || stripShopifyGid(variant.id),
    sku: variant.sku,
    barcode: variant.barcode,
    price: variant.price,
    inventory_quantity: variant.inventoryQuantity,
    title: variant.title,
    admin_graphql_api_id: variant.id,
  }));
  const images = unwrapGraphqlConnection(node.images).map((image) => ({
    src: image.url || image.src,
    url: image.url || image.src,
  }));
  const featured = firstNonEmptyString(
    node.featuredImage?.url,
    images[0]?.src,
  );

  return {
    id: node.legacyResourceId || stripShopifyGid(node.id),
    admin_graphql_api_id: node.id,
    title: node.title,
    handle: node.handle,
    status: node.status,
    vendor: node.vendor,
    product_type: node.productType,
    tags: node.tags,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    variants,
    images,
    image: featured ? { src: featured } : undefined,
  };
}

async function shopifyGraphql(query, variables = {}) {
  const { shop, token } = assertShopifyAdminConfig();
  const response = await axios.post(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    { query, variables },
    {
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 60000,
      validateStatus: () => true,
    },
  );

  if (response.status >= 400) {
    throw shopifyAdminError(response);
  }

  const graphqlErrors = response.data?.errors;
  if (Array.isArray(graphqlErrors) && graphqlErrors.length) {
    const err = new Error(
      graphqlErrors.map((item) => item?.message || JSON.stringify(item)).join("; "),
    );
    err.code = "SHOPIFY_GRAPHQL_ERROR";
    err.status = 502;
    err.details = graphqlErrors;
    throw err;
  }

  return response.data?.data || {};
}

async function fetchShopifyProductsPage({
  after = null,
  limit = SHOPIFY_PAGE_LIMIT,
} = {}) {
  const pageLimit = Math.min(
    SHOPIFY_PAGE_LIMIT,
    Math.max(1, Number(limit) || SHOPIFY_PAGE_LIMIT),
  );
  const data = await shopifyGraphql(SHOPIFY_PRODUCTS_QUERY, {
    first: pageLimit,
    after,
  });
  const connection = data.products || {};
  const nodes = unwrapGraphqlConnection(connection);
  return {
    products: nodes.map(normalizeGraphqlProduct).filter(Boolean),
    nextCursor: connection.pageInfo?.hasNextPage
      ? connection.pageInfo.endCursor || ""
      : "",
  };
}

/**
 * Pulls every Shopify product page (active, draft, archived) via GraphQL Admin API.
 */
async function fetchAllShopifyProducts({
  limit = SHOPIFY_PAGE_LIMIT,
  maxPages = 100,
} = {}) {
  const products = [];
  let after = null;
  let pages = 0;

  for (;;) {
    const page = await fetchShopifyProductsPage({ after, limit });
    pages += 1;
    products.push(...page.products);
    if (!page.nextCursor || pages >= maxPages) break;
    after = page.nextCursor;
  }

  return products;
}

function resolveShopifyProductId(product) {
  return firstNonEmptyString(
    stripShopifyGid(product?.legacyResourceId),
    stripShopifyGid(product?.legacy_resource_id),
    stripShopifyGid(product?.id),
    stripShopifyGid(product?.admin_graphql_api_id),
    stripShopifyGid(product?.adminGraphqlApiId),
    stripShopifyGid(product?.product_id),
    stripShopifyGid(product?.productId),
  );
}

function pickShopifyVariantSkus(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const skus = [];
  const seen = new Set();
  for (const variant of variants) {
    const sku = firstNonEmptyString(variant?.sku, variant?.barcode);
    if (!sku) continue;
    const key = sku.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    skus.push(sku);
  }
  return skus;
}

function pickShopifyProductImage(product) {
  return firstNonEmptyString(
    product?.image?.src,
    product?.image?.url,
    Array.isArray(product?.images) ? product.images[0]?.src : "",
    Array.isArray(product?.images) ? product.images[0]?.url : "",
    Array.isArray(product?.media) ? product.media[0]?.preview_image?.src : "",
  );
}

/**
 * Maps a Shopify Admin REST product into the local `products` table row.
 * Uses easyorder_id = shopify-{id} so EasyOrder rows are never overwritten.
 */
function mapShopifyProductToCatalogRow(product) {
  if (!product || typeof product !== "object") return null;
  const numericId = resolveShopifyProductId(product);
  if (!numericId) return null;

  const skus = pickShopifyVariantSkus(product);
  const image = pickShopifyProductImage(product);

  return {
    easyorder_id: `${SHOPIFY_ID_PREFIX}${numericId}`,
    name: firstNonEmptyString(product.title, product.name) || null,
    sku: skus[0] || null,
    raw_data: {
      ...product,
      platform: "shopify",
      shopify_product_id: numericId,
      variant_skus: skus,
      thumbnail: image || undefined,
    },
    synced_at: new Date().toISOString(),
  };
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

async function fetchShopifyOrderByNumericId(numericId) {
  const id = stripShopifyGid(numericId);
  if (!id || !/^\d+$/.test(id)) {
    const err = new Error("Invalid Shopify order id");
    err.code = "INVALID_SHOPIFY_ORDER_ID";
    throw err;
  }

  const { shop, token } = assertShopifyAdminConfig();
  const response = await axios.get(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${id}.json`,
    {
      headers: {
        "X-Shopify-Access-Token": token,
        Accept: "application/json",
      },
      timeout: 30000,
      validateStatus: () => true,
    },
  );

  if (response.status >= 400) {
    throw shopifyAdminError(response);
  }

  return response.data?.order || null;
}

function normalizeLocalCustomerStatus(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (raw === "cancelled") return "canceled";
  if (raw === "confirmed" || raw === "canceled" || raw === "pending" || raw === "failed") {
    return raw;
  }
  return "pending";
}

/**
 * UI refresh for Shopify rows: pull live order from Admin API and persist customerStatus.
 * If Admin token is missing, returns the stored status instead of 400.
 */
async function refreshCustomerStatusFromShopify(localOrder) {
  const { mergeOrderRawDataPatch } = require("./webhookOrders.service");
  const previousCustomerStatus = normalizeLocalCustomerStatus(
    localOrder?.customer_status ?? localOrder?.customerStatus,
  );
  const sourceOrderId = String(
    localOrder?.sourceOrderId || localOrder?.id || localOrder?.order_id || "",
  ).trim();
  const numericId = String(
    localOrder?.shopify_order_id ||
      resolveShopifyNumericId({
        id: sourceOrderId,
        legacyResourceId: localOrder?.shopify_order_id,
      }) ||
      "",
  )
    .replace(/^shopify-/i, "")
    .replace(/^gid:\/\/shopify\/Order\//i, "")
    .trim();

  try {
    const {
      lookupEasyConfirmStatus,
    } = require("./easyconfirm.service");
    const fromEasyConfirm = await lookupEasyConfirmStatus({
      ...localOrder,
      sourceOrderId,
      shopify_order_id: numericId || localOrder?.shopify_order_id,
    });
    if (fromEasyConfirm?.customerStatus) {
      const customerStatus = fromEasyConfirm.customerStatus;
      let order = {
        ...localOrder,
        customer_status: customerStatus,
        customerStatus,
      };
      if (sourceOrderId) {
        order = await mergeOrderRawDataPatch(sourceOrderId, {
          customer_status: customerStatus,
          customerStatus,
          confirmation_source: "easyconfirm",
          confirmation_status:
            customerStatus === "canceled" ? "cancelled" : customerStatus,
          easyconfirm_id: fromEasyConfirm.remote?.id || localOrder?.easyconfirm_id,
          easyconfirm_external_order_id: fromEasyConfirm.externalOrderId,
          easyconfirm_customer_synced_at: new Date().toISOString(),
        });
      }
      return {
        order,
        easyOrdersConfirm: {
          id: sourceOrderId,
          shortId: localOrder?.short_id || localOrder?.shortId || null,
          status: customerStatus,
          customerStatus,
          source: "easyconfirm",
        },
        previousCustomerStatus,
        customerStatus,
        changed: previousCustomerStatus !== customerStatus,
        source: "easyconfirm",
      };
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        source: "easyconfirm-api",
        level: "warn",
        message: error.message,
        orderId: sourceOrderId,
      }),
    );
  }

  let remote = null;
  try {
    remote = await fetchShopifyOrderByNumericId(numericId);
  } catch (error) {
    if (isShopifyAuthFailure(error)) {
      return {
        order: localOrder,
        easyOrdersConfirm: {
          id: sourceOrderId,
          shortId: localOrder?.short_id || localOrder?.shortId || null,
          status: previousCustomerStatus,
          customerStatus: previousCustomerStatus,
          source: "shopify",
        },
        previousCustomerStatus,
        customerStatus: previousCustomerStatus,
        changed: false,
        source: "shopify",
        warning:
          error.code === "SHOPIFY_HTTP_ERROR"
            ? "shopify_token_rejected"
            : error.code,
      };
    }
    throw error;
  }

  if (!remote) {
    const err = new Error("Shopify order was not found");
    err.code = "ORDER_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  const mapped = mapShopifyOrderToLocal(remote, { topic: "orders/updated" });
  const customerStatus = normalizeLocalCustomerStatus(
    mapped?.customer_status || mapped?.customerStatus,
  );

  let order = {
    ...localOrder,
    customer_status: customerStatus,
    customerStatus,
    shopify_financial_status: mapped.shopify_financial_status,
    shopify_fulfillment_status: mapped.shopify_fulfillment_status,
  };

  if (sourceOrderId) {
    order = await mergeOrderRawDataPatch(sourceOrderId, {
      customer_status: customerStatus,
      customerStatus,
      confirmation_source: "shopify",
      confirmation_status:
        customerStatus === "canceled" ? "cancelled" : customerStatus,
      shopify_financial_status: mapped.shopify_financial_status,
      shopify_fulfillment_status: mapped.shopify_fulfillment_status,
      shopify_customer_synced_at: new Date().toISOString(),
    });
  }

  return {
    order,
    easyOrdersConfirm: {
      id: sourceOrderId,
      shortId: mapped.short_id || localOrder?.short_id || null,
      status: customerStatus,
      customerStatus,
      source: "shopify",
    },
    previousCustomerStatus,
    customerStatus,
    changed: previousCustomerStatus !== customerStatus,
    source: "shopify",
  };
}

function getShopifyWebhookConfigStatus() {
  return {
    secretsConfigured: getWebhookSecrets().length,
    shopDomain: getConfiguredShopDomain() || null,
    accessTokenConfigured: Boolean(
      String(process.env.SHOPIFY_ACCESS_TOKEN || "").trim(),
    ),
  };
}

module.exports = {
  SHOPIFY_ID_PREFIX,
  SHOPIFY_API_VERSION,
  verifyShopifyWebhook,
  mapShopifyOrderToLocal,
  mapShopifyProductToCatalogRow,
  fetchAllShopifyProducts,
  isShopifyOrder,
  isGdprTopic,
  isOrderTopic,
  unwrapShopifyOrder,
  normalizeShopifyTopic,
  getShopifyWebhookConfigStatus,
  getConfiguredShopDomain,
  getShopifyAccessToken,
  fetchShopifyOrderByNumericId,
  refreshCustomerStatusFromShopify,
};
