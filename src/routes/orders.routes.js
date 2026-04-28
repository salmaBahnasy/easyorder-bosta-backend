const express = require("express");
const router = express.Router();

const {
  createOrder,
  updateOrder,
  getOrders,
  changeOrderStatus,
  sendOrderToBosta,
  getEasyOrderDetails,
  getOrdersStats,
} = require("../controllers/orders.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

router.get("/stats", getOrdersStats);
router.post("/", createOrder);
router.patch("/:orderId", requireAuth, updateOrder);
router.get("/", getOrders);
router.patch("/:orderId/status", requireAuth, changeOrderStatus);
router.get("/:orderId", getEasyOrderDetails);

router.post("/:orderId/send-to-bosta", sendOrderToBosta);

module.exports = router;
