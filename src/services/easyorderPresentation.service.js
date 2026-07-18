function unwrapOrder(payload) {
  if (!payload || typeof payload !== "object") return null;

  const candidates = [
    payload,
    payload.data,
    payload.order,
    payload.data?.data,
    payload.data?.order,
  ].filter((x) => x && typeof x === "object");

  for (const obj of candidates) {
    if (obj.id) {
      return obj;
    }
  }

  return null;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const s = String(value).trim();
    if (s) return s;
  }
  return "";
}

function resolveLineSku(line, product) {
  const meta =
    line.metadata && typeof line.metadata === "object" ? line.metadata : {};
  const pMeta =
    product.metadata && typeof product.metadata === "object"
      ? product.metadata
      : {};
  const variant =
    line.variant && typeof line.variant === "object" ? line.variant : {};
  const vMeta =
    variant.metadata && typeof variant.metadata === "object"
      ? variant.metadata
      : {};

  return firstNonEmptyString(
    product.sku,
    line.sku,
    variant.sku,
    variant.taager_code,
    meta.sku,
    pMeta.sku,
    vMeta.sku,
    product.variant_sku,
    line.variant_sku,
    product.taager_code,
    product.code,
    line.product_sku,
  );
}

function resolveLineName(line, product) {
  return firstNonEmptyString(
    product.name,
    line.name,
    line.product_name,
    metaNameFromLine(line),
  );
}

function metaNameFromLine(line) {
  const meta = line.metadata;
  if (!meta || typeof meta !== "object") return "";
  return firstNonEmptyString(meta.name, meta.product_name, meta.title);
}

function formatLineItems(cartItems) {
  if (!Array.isArray(cartItems)) return [];

  return cartItems.map((line) => {
    const product =
      line.product && typeof line.product === "object" ? line.product : {};
    const variant =
      line.variant && typeof line.variant === "object" ? line.variant : {};
    const quantity = Number(line.quantity) || 0;
    const unitPrice =
      line.price ??
      variant.sale_price ??
      variant.price ??
      product.sale_price ??
      product.price ??
      0;
    const name = resolveLineName(line, product);
    const sku = resolveLineSku(line, product);

    return {
      id: line.id,
      productId: line.product_id,
      name,
      sku,
      slug: firstNonEmptyString(product.slug, line.slug),
      quantity,
      unitPrice,
      lineTotal: unitPrice * quantity,
      isUpsell: Boolean(line.is_upsell),
      thumbnail: firstNonEmptyString(product.thumb, line.thumb) || null,
    };
  });
}

function formatTracking(metadata) {
  const tracking = metadata?.tracking;
  if (!tracking || typeof tracking !== "object") return null;

  return {
    firstOrderAt: tracking.first_order_at || null,
    firstVisitAt: tracking.first_visit_at || null,
    ordersCount: tracking.orders_count,
    sessionsCount: tracking.sessions_count,
    visitDurationSeconds: tracking.visit_duration_seconds,
    referrer: tracking.referrer || null,
    pagesVisited: Array.isArray(tracking.pages_visited)
      ? tracking.pages_visited
      : [],
  };
}

function toPresentation(payload) {
  const order = unwrapOrder(payload);
  if (!order || !order.id) return null;

  const cartLines = order.cart_items ?? order.cartItems;
  const lineItems = formatLineItems(Array.isArray(cartLines) ? cartLines : []);

  const orderSource = firstNonEmptyString(
    payload.order_source,
    order.order_source,
  );
  const orderType = firstNonEmptyString(payload.order_type, order.order_type);
  const shippingStatus = firstNonEmptyString(
    payload.shipping_status,
    order.shipping_status,
    payload.shippingStatus,
    order.shippingStatus,
  );
  const customerStatus = firstNonEmptyString(
    payload.customer_status,
    order.customer_status,
    payload.customerStatus,
    order.customerStatus,
  ) || "pending";

  return {
    id: order.id,
    shortId: order.short_id,
    status: order.status,
    customerStatus,
    timeline: {
      createdAt: order.created_at,
      updatedAt: order.updated_at,
      createdDay: order.created_day,
    },
    customer: {
      fullName: order.full_name,
      phone: order.phone,
      phone2:
        firstNonEmptyString(
          order.phone2,
          order.phone_2,
          order.secondaryPhone,
          order.secondary_phone,
        ) || null,
      governorate: (order.government || "").trim(),
      address: (order.address || "").trim(),
    },
    totals: {
      subtotal: order.cost,
      shipping: order.shipping_cost,
      total: order.total_cost,
      expense: order.expense,
      paymentMethod: firstNonEmptyString(
        order.payment_method,
        order.paymentMethod,
      ),
    },
    marketing: {
      utmSource: order.utm_source,
      utmCampaign: order.utm_campaign,
    },
    flags: {
      isLowQuality: order.is_low_quality,
      isSeen: order.is_seen,
      ip: order.ip,
      ipCountry: order.ip_country,
    },
    lineItems,
    lineItemsSummary: lineItems
      .map((item) => {
        const suffix = item.sku ? ` (${item.sku})` : "";
        return `${item.quantity}× ${item.name}${suffix}`;
      })
      .join(" · "),
    tracking: formatTracking(order.metadata),
    storeId: order.store_id,
    guestId: order.guest_id,
    orderMeta: {
      orderSource: orderSource || null,
      orderType: orderType || null,
      shippingStatus: shippingStatus || null,
      customerStatus,
    },
  };
}

module.exports = {
  unwrapOrder,
  toPresentation,
};
