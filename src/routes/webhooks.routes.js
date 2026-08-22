const express = require("express");
const router = express.Router();

const {
  addWebhookOrder,
  getWebhookOrders,
} = require("../services/webhookOrders.service");
const {
  handleBostaOrderStatusWebhook,
} = require("../controllers/bostaFulfillment.controller");
const {
  handleShopifyWebhook,
} = require("../controllers/shopify.controller");
const {
  toPresentation,
} = require("../services/easyorderPresentation.service");

router.post("/bosta/order-status", handleBostaOrderStatusWebhook);

router.post("/shopify", handleShopifyWebhook);
router.post("/shopify/orders", handleShopifyWebhook);
router.post("/shopify/orders/create", handleShopifyWebhook);
router.post("/shopify/orders/updated", handleShopifyWebhook);
router.post("/shopify/orders/cancelled", handleShopifyWebhook);

router.post("/easyorders/order-created", async (req, res) => {
  try {
    const savedOrder = await addWebhookOrder(req.body, { fromWebhook: true });

    res.status(200).json({
      success: true,
      message: "Webhook received",
      data: savedOrder,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to save webhook order",
      error: error.message,
    });
  }
});

router.get("/easyorders/orders", async (req, res) => {
  let orders = [];
  try {
    orders = await getWebhookOrders();
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch webhook orders",
      error: error.message,
    });
    return;
  }

  if (req.query.raw === "true") {
    res.json({
      success: true,
      total: orders.length,
      data: orders,
    });
    return;
  }

  const data = orders.map((entry) => {
    const { receivedAt, ...payload } = entry;
    const order = toPresentation(payload);

    if (!order) {
      return {
        receivedAt,
        order: null,
        note:
          "Could not map payload to order; add ?raw=true to see stored body.",
      };
    }

    return { receivedAt, order };
  });

  res.json({
    success: true,
    total: data.length,
    data,
  });
});

module.exports = router;
