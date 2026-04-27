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

router.get("/stats", getOrdersStats);
router.post("/", createOrder);
router.patch("/:orderId", updateOrder);
router.get("/", getOrders);
router.patch("/:orderId/status", changeOrderStatus);
router.get("/:orderId", getEasyOrderDetails);

router.post("/:orderId/send-to-bosta", sendOrderToBosta);

module.exports = router;
