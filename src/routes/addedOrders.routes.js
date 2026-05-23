const express = require("express");
const {
  postAddedOrder,
  getAddedOrders,
} = require("../controllers/addedOrders.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

const router = express.Router();

router.post("/", requireAuth, postAddedOrder);
router.get("/", getAddedOrders);

module.exports = router;
