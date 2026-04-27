const express = require("express");

const {
  syncProducts,
  getProducts,
} = require("../controllers/products.controller");

const router = express.Router();

router.post("/sync", syncProducts);
router.get("/", getProducts);

module.exports = router;
