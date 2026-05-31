const express = require("express");
const router = express.Router();

const {
  createOrder,
  updateOrder,
  getOrders,
  getOrderByReference,
  changeOrderStatus,
  sendOrderToBosta,
  getEasyOrderDetails,
  getOrdersStats,
  getOrdersStatsTrend,
  getOrdersAnalytics,
  getProductSalesChartHandler,
} = require("../controllers/orders.controller");
const { requireAuth, optionalAuth } = require("../middlewares/auth.middleware");

router.get("/stats/trend", getOrdersStatsTrend);
router.get("/stats", getOrdersStats);
router.get("/analytics", getOrdersAnalytics);
router.get("/charts/product-sales", getProductSalesChartHandler);
router.get("/reference/:orderReference", getOrderByReference);
router.get("/reference", getOrderByReference);
router.post("/", optionalAuth, createOrder);
router.patch("/:orderId", requireAuth, updateOrder);
router.get("/", getOrders);
router.patch("/:orderId/status", requireAuth, changeOrderStatus);
router.get("/:orderId", getEasyOrderDetails);

router.post("/:orderId/send-to-bosta", sendOrderToBosta);

module.exports = router;
