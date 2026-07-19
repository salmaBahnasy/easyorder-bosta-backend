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
      lineTotal: quantity * (Number(unitPrice) || 0),
      image: firstNonEmptyString(
        product.thumbnail,
        product.image,
        line.image,
        variant.image,
      ),
    };
  });
}

function formatTracking(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  return metadata;
}

/**
 * Present an EasyOrders / ERP order for the UI.
 * customerStatus comes from EasyOrders WhatsApp confirmation (order.status).
 */
function toPresentation(payload) {
  const order = unwrapOrder(payload);
  if (!order) return null;

  const lineItems = formatLineItems(order.cart_items || order.cartItems || []);
  const orderSource = firstNonEmptyString(
    order.order_source,
    order.orderSource,
    payload.order_source,
    payload.orderSource,
  );
  const orderType = firstNonEmptyString(
    order.order_type,
    order.orderType,
    payload.order_type,
    payload.orderType,
  );
  const shippingStatus = firstNonEmptyString(
    payload.shipping_status,
    order.shipping_status,
    payload.shippingStatus,
    order.shippingStatus,
  );

  const customerStatusRaw = firstNonEmptyString(
    payload.customer_status,
    order.customer_status,
    payload.customerStatus,
    order.customerStatus,
    // EasyOrders stores WhatsApp confirmation in status
    mapEasyOrdersStatusForDisplay(order.status || payload.status),
  ) || "pending";

  const customerStatus =
    customerStatusRaw === "cancelled" ? "canceled" : customerStatusRaw;

  const easyOrdersConfirm =
    payload.easyOrdersConfirm && typeof payload.easyOrdersConfirm === "object"
      ? payload.easyOrdersConfirm
      : order.easyOrdersConfirm && typeof order.easyOrdersConfirm === "object"
        ? order.easyOrdersConfirm
        : null;

  return {
    id: order.id,
    shortId: order.short_id ?? order.shortId,
    status: order.status,
    customerStatus,
    // Alias for UI badges that still read confirmationStatus
    confirmationStatus:
      customerStatus === "canceled" ? "cancelled" : customerStatus,
    confirmationSource: firstNonEmptyString(
      payload.confirmation_source,
      order.confirmation_source,
      easyOrdersConfirm ? "easyorders" : "",
    ) || null,
    easyOrdersConfirm,
    easyordersStatus: firstNonEmptyString(
      order.easyorders_status,
      order.easyOrdersStatus,
      easyOrdersConfirm?.status,
      order.status,
    ) || null,
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

function mapEasyOrdersStatusForDisplay(status) {
  const raw = String(status || "")
    .trim()
    .toLowerCase();
  if (raw === "confirmed" || raw === "approved") return "confirmed";
  if (raw === "canceled" || raw === "cancelled") return "canceled";
  if (raw === "pending" || raw === "waiting") return "pending";
  if (raw === "failed") return "failed";
  return "";
}

/**
 * Prefer live EasyOrders confirmation on top of a presented order.
 */
function withCustomerConfirmation(presented, { easyOrdersConfirm = null } = {}) {
  if (!presented || typeof presented !== "object") return presented;

  const fromEo = easyOrdersConfirm?.customerStatus;
  const customerStatus =
    firstNonEmptyString(fromEo, presented.customerStatus) || "pending";
  const normalized =
    customerStatus === "cancelled" ? "canceled" : customerStatus;

  return {
    ...presented,
    customerStatus: normalized,
    confirmationStatus:
      normalized === "canceled" ? "cancelled" : normalized,
    confirmationSource: easyOrdersConfirm
      ? "easyorders"
      : presented.confirmationSource || null,
    easyOrdersConfirm: easyOrdersConfirm
      ? {
          id: easyOrdersConfirm.id ?? null,
          shortId: easyOrdersConfirm.shortId ?? null,
          status: easyOrdersConfirm.status ?? null,
          customerStatus: easyOrdersConfirm.customerStatus ?? null,
          source: "easyorders",
        }
      : presented.easyOrdersConfirm || null,
    easyordersStatus:
      easyOrdersConfirm?.status ?? presented.easyordersStatus ?? null,
    orderMeta: {
      ...(presented.orderMeta || {}),
      customerStatus: normalized,
    },
  };
}

module.exports = {
  unwrapOrder,
  toPresentation,
  withCustomerConfirmation,
};
