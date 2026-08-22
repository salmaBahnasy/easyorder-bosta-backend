const express = require("express");
const router = express.Router();

const {
  createOrder,
  updateOrder,
  getOrders,
  getOrderByReference,
  changeOrderStatus,
  getEasyOrderDetails,
  refreshCustomerStatus,
  getOrdersStats,
  getOrdersStatsTrend,
  exportOrdersStatsTrend,
  getOrdersAnalytics,
  getProductSalesChartHandler,
  getOrderCosts,
  getOrderCostChartHandler,
  saveOrderCostDailyHandler,
  exportOrders,
} = require("../controllers/orders.controller");
const {
  sendOrderToBosta,
  sendOrdersToBostaBulk,
} = require("../controllers/bostaFulfillment.controller");
const { requireAuth, optionalAuth } = require("../middlewares/auth.middleware");

router.get("/stats/trend/export", requireAuth, exportOrdersStatsTrend);
router.post("/stats/trend/export", requireAuth, exportOrdersStatsTrend);
router.get("/stats/trend", getOrdersStatsTrend);
router.get("/stats", getOrdersStats);
router.get("/analytics", getOrdersAnalytics);
router.get("/charts/product-sales", getProductSalesChartHandler);
router.post("/charts/order-cost", saveOrderCostDailyHandler);
router.get("/charts/order-cost", getOrderCostChartHandler);
router.get("/costs", getOrderCosts);
router.get("/export", requireAuth, exportOrders);
router.post("/export", requireAuth, exportOrders);
router.get("/reference/:orderReference", getOrderByReference);
router.get("/reference", getOrderByReference);
router.post("/send-to-bosta/bulk", requireAuth, sendOrdersToBostaBulk);
router.post("/", optionalAuth, createOrder);
router.patch("/:orderId", requireAuth, updateOrder);
router.get("/", getOrders);
router.patch("/:orderId/status", requireAuth, changeOrderStatus);
router.post(
  "/:orderId/refresh-customer-status",
  requireAuth,
  refreshCustomerStatus,
);
router.get("/:orderId", getEasyOrderDetails);

router.post("/:orderId/send-to-bosta", requireAuth, sendOrderToBosta);

module.exports = router;
