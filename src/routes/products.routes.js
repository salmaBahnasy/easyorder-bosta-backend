const express = require("express");

const {
  syncProducts,
  syncShopifyProducts,
  getProducts,
  getEasyOrderProductById,
} = require("../controllers/products.controller");

const router = express.Router();

router.post("/sync", syncProducts);
router.post("/sync-shopify", syncShopifyProducts);
router.get("/", getProducts);
router.get("/:productId", getEasyOrderProductById);

module.exports = router;
