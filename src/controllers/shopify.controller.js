const {
  addWebhookOrder,
} = require("../services/webhookOrders.service");
const {
  verifyShopifyWebhook,
  mapShopifyOrderToLocal,
  isGdprTopic,
  isOrderTopic,
} = require("../services/shopify.service");

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
  try {
    verifyShopifyWebhook(req);
  } catch (error) {
    const status = error.statusCode || 401;
    res.status(status).json({
      success: false,
      message: error.message || "Unauthorized Shopify webhook",
      code: error.code,
    });
    return;
  }

  const topic = readShopifyTopic(req);

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
      res.status(200).json({
        success: true,
        message: "No Shopify order payload to save",
        topic,
      });
      return;
    }

    const savedOrder = await addWebhookOrder(mapped, { fromWebhook: true });

    res.status(200).json({
      success: true,
      message: "Shopify webhook processed",
      topic,
      data: savedOrder,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to save Shopify webhook order",
      error: error.message,
      topic,
    });
  }
}

module.exports = {
  handleShopifyWebhook,
};
