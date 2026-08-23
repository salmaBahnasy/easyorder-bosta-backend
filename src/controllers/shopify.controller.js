const {
  addWebhookOrder,
} = require("../services/webhookOrders.service");
const {
  verifyShopifyWebhook,
  mapShopifyOrderToLocal,
  isGdprTopic,
  isOrderTopic,
  normalizeShopifyTopic,
  getShopifyWebhookConfigStatus,
} = require("../services/shopify.service");

const lastShopifyWebhook = {
  at: null,
  topic: null,
  shop: null,
  hmacOk: null,
  savedOrderId: null,
  message: null,
  code: null,
};

function rememberShopifyWebhook(partial) {
  Object.assign(lastShopifyWebhook, {
    at: new Date().toISOString(),
    topic: null,
    shop: null,
    hmacOk: null,
    savedOrderId: null,
    message: null,
    code: null,
    ...partial,
  });
}

function readShopifyTopic(req) {
  return String(
    req.get("x-shopify-topic") || req.get("X-Shopify-Topic") || "",
  ).trim();
}

/**
 * POST /webhooks/shopify
 * POST /webhooks/shopify/orders
 *
 * Shopify Admin webhooks → same `orders` table as EasyOrder.
 * EasyOrder webhook handler is unchanged.
 */
async function handleShopifyWebhook(req, res) {
  const incomingTopic = readShopifyTopic(req);
  const shop = String(
    req.get("x-shopify-shop-domain") || req.get("X-Shopify-Shop-Domain") || "",
  ).trim();

  try {
    verifyShopifyWebhook(req);
  } catch (error) {
    rememberShopifyWebhook({
      topic: incomingTopic || null,
      shop: shop || null,
      hmacOk: false,
      message: error.message,
      code: error.code || null,
    });
    console.warn(
      JSON.stringify({
        source: "shopify-webhook",
        level: "warn",
        message: error.message,
        code: error.code,
        topic: incomingTopic || null,
        shop: shop || null,
        hmacOk: false,
      }),
    );
    const status = error.statusCode || 401;
    res.status(status).json({
      success: false,
      message: error.message || "Unauthorized Shopify webhook",
      code: error.code,
    });
    return;
  }

  const topic = normalizeShopifyTopic(incomingTopic);
  console.log(
    JSON.stringify({
      source: "shopify-webhook",
      topic: topic || incomingTopic || null,
      shop: shop || null,
      hmacOk: true,
    }),
  );

  if (isGdprTopic(topic)) {
    res.status(200).json({ success: true, message: "GDPR webhook acknowledged" });
    return;
  }

  if (!isOrderTopic(topic)) {
    res.status(200).json({
      success: true,
      message: "Webhook ignored",
      topic,
    });
    return;
  }

  try {
    const mapped = mapShopifyOrderToLocal(req.body, { topic });
    if (!mapped) {
      rememberShopifyWebhook({
        topic,
        shop: shop || null,
        hmacOk: true,
        message: "Shopify payload could not be mapped",
        code: "UNMAPPED_PAYLOAD",
      });
      console.warn(
        JSON.stringify({
          source: "shopify-webhook",
          level: "warn",
          message: "Shopify payload could not be mapped",
          topic,
          shop: shop || null,
          bodyKeys:
            req.body && typeof req.body === "object"
              ? Object.keys(req.body)
              : [],
        }),
      );
      res.status(200).json({
        success: true,
        message: "No Shopify order payload to save",
        topic,
      });
      return;
    }

    const savedOrder = await addWebhookOrder(mapped, { fromWebhook: true });
    rememberShopifyWebhook({
      topic,
      shop: shop || null,
      hmacOk: true,
      savedOrderId: savedOrder?.sourceOrderId || mapped.id,
      message: "Shopify order saved",
    });
    console.log(
      JSON.stringify({
        source: "shopify-webhook",
        message: "Shopify order saved",
        topic,
        shop: shop || null,
        orderId: savedOrder?.sourceOrderId || mapped.id,
      }),
    );

    res.status(200).json({
      success: true,
      message: "Shopify webhook processed",
      topic,
      data: savedOrder,
    });
  } catch (error) {
    rememberShopifyWebhook({
      topic,
      shop: shop || null,
      hmacOk: true,
      message: error.message,
      code: "SAVE_FAILED",
    });
    res.status(500).json({
      success: false,
      message: "Failed to save Shopify webhook order",
      error: error.message,
      topic,
    });
  }
}

function getShopifyWebhookStatus(req, res) {
  res.json({
    success: true,
    ...getShopifyWebhookConfigStatus(),
    lastWebhook: lastShopifyWebhook.at ? lastShopifyWebhook : null,
    webhookPaths: [
      "/webhooks/shopify",
      "/webhooks/shopify/orders",
      "/webhooks/shopify/orders/create",
    ],
  });
}

module.exports = {
  handleShopifyWebhook,
  getShopifyWebhookStatus,
};
