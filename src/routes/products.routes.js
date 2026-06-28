const express = require("express");

const {
  syncProducts,
  getProducts,
  getEasyOrderProductById,
} = require("../controllers/products.controller");

const router = express.Router();

router.post("/sync", syncProducts);
router.get("/", getProducts);
router.get("/:productId", getEasyOrderProductById);

module.exports = router;
