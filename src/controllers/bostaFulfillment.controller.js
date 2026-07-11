const {
  mapLocalOrderToBostaPayload,
  createFulfillmentOrder,
  createFulfillmentOrdersBulk,
  getWebhookUrl,
  fetchBostaInventoryAvailabilityMap,
  getFulfillmentKeyDiagnostics,
  firstNonEmpty,
} = require("../services/bostaFulfillment.service");
const {
  getWebhookOrderById,
  markOrderSentToBosta,
  applyBostaFulfillmentWebhook,
} = require("../services/webhookOrders.service");

function pickOverrides(body = {}) {
  const src = body.overrides && typeof body.overrides === "object" ? body.overrides : body;
  const { parseLineSkuOverrides } = require("../services/bostaSkuMappings.service");
  const note = firstNonEmpty(src.note, src.notes);
  const { skuByIndex, priceByIndex } = parseLineSkuOverrides(body);
  return {
    orderAlias: src.orderAlias ?? src.order_alias,
    cityId: src.cityId ?? src.city_id ?? src.bosta_city_id,
    districtId: src.districtId ?? src.district_id ?? src.bosta_district_id,
    cityName: src.cityName ?? src.city_name,
    firstLine: src.firstLine ?? src.first_line ?? src.address,
    codAmount: src.codAmount ?? src.cod_amount,
    paymentMethod: src.paymentMethod ?? src.payment_method,
    note: note || undefined,
    allowToOpenPackage:
      src.allowToOpenPackage ?? src.allow_to_open_package ?? undefined,
    firstName: src.firstName ?? src.first_name ?? src.full_name,
    mobile: src.mobile ?? src.phone,
    type: src.type,
    defaultSkuCode: src.defaultSkuCode ?? src.default_sku_code,
    lineSkuOverrides: skuByIndex,
    linePriceOverrides: priceByIndex,
  };
}

function normalizeOrderIds(body = {}) {
  const raw =
    body.orderIds ??
    body.order_ids ??
    body.ids ??
    (Array.isArray(body.orders) ? body.orders : null);

  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return [...new Set(list.map((id) => String(id || "").trim()).filter(Boolean))];
}

function extractBostaResultId(result, index) {
  if (Array.isArray(result?.data) && result.data[index]?.id != null) {
    return result.data[index].id;
  }
  if (result?.data?.id != null) {
    return result.data.id;
  }
  if (result?.id != null) {
    return result.id;
  }
  return null;
}

function inventoryErrorResponse(error) {
  return {
    success: false,
    code: error.code,
    message: error.messageAr || error.message,
    unavailableProducts: error.unavailableProducts || [],
  };
}

/**
 * POST /api/orders/:orderId/send-to-bosta
 * POST /api/easyorder/orders/:orderId/send-to-bosta
 */
async function sendOrderToBosta(req, res) {
  try {
    const { orderId } = req.params;
    const localOrder = await getWebhookOrderById(orderId);
    const overrides = pickOverrides(req.body || {});
    const payload = await mapLocalOrderToBostaPayload(localOrder, overrides);

    const bostaResult = await createFulfillmentOrder(payload);
    const updatedOrder = await markOrderSentToBosta(
      localOrder.sourceOrderId,
      bostaResult,
      payload,
    );

    res.json({
      success: true,
      message: "Order sent to Bosta successfully",
      bosta: bostaResult,
      webhookUrl: getWebhookUrl(),
      data: updatedOrder,
    });
  } catch (error) {
    if (
      error.code === "ORDER_NOT_FOUND" ||
      error.code === "INVALID_ORDER_ID"
    ) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    if (error.code === "BOSTA_INVENTORY_UNAVAILABLE") {
      res.status(409).json(inventoryErrorResponse(error));
      return;
    }
    if (
      error.code === "BOSTA_ORDER_MAPPING_ERROR" ||
      error.code === "BOSTA_WEBHOOK_URL_MISSING" ||
      error.code === "BOSTA_API_KEY_MISSING" ||
      error.code === "BOSTA_FULFILLMENT_API_KEY_MISSING"
    ) {
      res.status(400).json({
        success: false,
        message: error.message,
        code: error.code,
      });
      return;
    }
    if (error.code === "BOSTA_API_ERROR") {
      res.status(error.status || 502).json({
        success: false,
        message: error.message,
        errors: error.details?.errors || [error.message],
        details: error.details,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to send order to Bosta",
      error: error.message,
    });
  }
}

/**
 * POST /api/orders/send-to-bosta/bulk
 * Body: { "orderIds": ["id1", "id2"], "cityId": "...", "districtId": "..." }
 */
async function sendOrdersToBostaBulk(req, res) {
  try {
    const orderIds = normalizeOrderIds(req.body || {});
    if (!orderIds.length) {
      res.status(400).json({
        success: false,
        message: "orderIds is required (non-empty array)",
      });
      return;
    }

    const sharedOverrides = pickOverrides(req.body || {});
    const perOrderOverrides =
      req.body?.perOrderOverrides && typeof req.body.perOrderOverrides === "object"
        ? req.body.perOrderOverrides
        : {};

    const payloads = [];
    const meta = [];
    const failedOrders = [];

    for (let i = 0; i < orderIds.length; i += 1) {
      const orderId = orderIds[i];
      try {
        const localOrder = await getWebhookOrderById(orderId);
        const overrides = {
          ...sharedOverrides,
          ...(perOrderOverrides[orderId] || {}),
        };
        const payload = await mapLocalOrderToBostaPayload(localOrder, overrides);
        payloads.push(payload);
        meta.push({
          orderId: localOrder.sourceOrderId,
          orderAlias: payload.orderAlias,
        });
      } catch (error) {
        failedOrders.push({
          orderId,
          code: error.code || "SEND_TO_BOSTA_FAILED",
          message: error.messageAr || error.message,
          unavailableProducts: error.unavailableProducts || [],
        });
      }
    }

    if (!payloads.length) {
      res.status(409).json({
        success: false,
        message: "No orders were sent to Bosta",
        failedOrders,
      });
      return;
    }

    const bostaResult = await createFulfillmentOrdersBulk(payloads);
    const updatedOrders = [];

    for (let i = 0; i < meta.length; i += 1) {
      const item = meta[i];
      const singleResult = {
        id: extractBostaResultId(bostaResult, i),
        ...(Array.isArray(bostaResult?.data) ? bostaResult.data[i] : bostaResult),
      };
      const updated = await markOrderSentToBosta(
        item.orderId,
        singleResult,
        payloads[i],
      );
      updatedOrders.push({
        orderId: item.orderId,
        orderAlias: item.orderAlias,
        bostaId: singleResult.id ?? null,
        order: updated,
      });
    }

    res.json({
      success: failedOrders.length === 0,
      message:
        failedOrders.length === 0
          ? `${updatedOrders.length} orders processed successfully`
          : `${updatedOrders.length} orders sent, ${failedOrders.length} failed inventory/mapping checks`,
      webhookUrl: getWebhookUrl(),
      bosta: bostaResult,
      data: updatedOrders,
      failedOrders,
    });
  } catch (error) {
    if (error.code === "BOSTA_INVENTORY_UNAVAILABLE") {
      res.status(409).json(inventoryErrorResponse(error));
      return;
    }
    if (
      error.code === "BOSTA_WEBHOOK_URL_MISSING" ||
      error.code === "BOSTA_API_KEY_MISSING" ||
      error.code === "BOSTA_FULFILLMENT_API_KEY_MISSING"
    ) {
      res.status(400).json({
        success: false,
        message: error.message,
        code: error.code,
      });
      return;
    }
    if (error.code === "BOSTA_API_ERROR") {
      res.status(error.status || 502).json({
        success: false,
        message: error.message,
        errors: error.details?.errors || [error.message],
        details: error.details,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to send orders to Bosta",
      error: error.message,
    });
  }
}

/**
 * POST /webhooks/bosta/order-status
 * Bosta callback when fulfillment order status changes.
 */
async function handleBostaOrderStatusWebhook(req, res) {
  try {
    const secret = (process.env.BOSTA_WEBHOOK_SECRET || "").trim();
    if (secret) {
      const incoming =
        req.get("x-bosta-secret") ||
        req.get("x-webhook-secret") ||
        req.query.secret;
      if (String(incoming || "").trim() !== secret) {
        res.status(401).json({ success: false, message: "Unauthorized webhook" });
        return;
      }
    }

    const payload = req.body || {};
    if (
      !payload.orderAlias &&
      !payload.order_alias &&
      !payload.id &&
      !payload.orderId &&
      !payload.order_id
    ) {
      res.status(400).json({
        success: false,
        message:
          "orderAlias or Bosta order id is required in webhook payload",
      });
      return;
    }

    const updatedOrder = await applyBostaFulfillmentWebhook(payload);

    res.status(200).json({
      success: true,
      message: "Bosta webhook processed",
      data: updatedOrder,
    });
  } catch (error) {
    if (error.code === "ORDER_NOT_FOUND") {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to process Bosta webhook",
      error: error.message,
    });
  }
}

/**
 * GET /api/easyorder/bosta/fulfillment/health
 * Quick check: is Bosta x-api-key configured correctly on this server?
 */
async function checkBostaFulfillmentHealth(req, res) {
  const keyInfo = getFulfillmentKeyDiagnostics();

  try {
    const inventory = await fetchBostaInventoryAvailabilityMap();
    res.json({
      success: true,
      message: "Bosta fulfillment API connected",
      key: keyInfo,
      inventorySkuCount: inventory.size,
    });
  } catch (error) {
    res.status(error.status === 401 ? 401 : 502).json({
      success: false,
      message: error.message,
      code: error.code || "BOSTA_HEALTH_CHECK_FAILED",
      key: keyInfo,
      hint:
        keyInfo.looksLikeEasyOrderKey
          ? "BOSTA_FULFILLMENT_API_KEY looks like EasyOrder Api-Key — use boost_... from Bosta Fulfillment"
          : !keyInfo.looksLikeBoostKey
            ? "Set BOSTA_FULFILLMENT_API_KEY=boost_... (same as Postman x-api-key header)"
            : "Key format OK but Bosta rejected it — copy exact x-api-key from Postman to Render env",
      details: error.details || null,
    });
  }
}

module.exports = {
  sendOrderToBosta,
  sendOrdersToBostaBulk,
  handleBostaOrderStatusWebhook,
  checkBostaFulfillmentHealth,
};
