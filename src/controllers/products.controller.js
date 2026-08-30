const easyorderService = require("../services/easyorder.service");
const {
  syncProductsFromEasyOrder,
  syncProductsFromShopify,
  getProductsFromDb,
  getProductFromDbById,
} = require("../services/products.service");

function errorPayload(error) {
  return error.response?.data || error.message;
}

function isShopifyNotConfigured(error) {
  return (
    error?.code === "MISSING_SHOPIFY_TOKEN" ||
    error?.code === "MISSING_SHOPIFY_SHOP"
  );
}

function isShopifyProductId(productId) {
  return String(productId || "")
    .trim()
    .toLowerCase()
    .startsWith("shopify-");
}

async function runEasyOrderSync() {
  const payload = await easyorderService.getProductsFromEasyOrder();
  return syncProductsFromEasyOrder(payload);
}

async function runShopifySync() {
  return syncProductsFromShopify();
}

/**
 * POST /api/products/sync
 * Syncs EasyOrders + Shopify (when configured) into the same `products` table.
 * Query/body `source=easyorder|shopify|all` (default: all).
 */
async function syncProducts(req, res) {
  const source = String(req.query.source || req.body?.source || "all")
    .trim()
    .toLowerCase();
  const wantEasyorder = source === "all" || source === "easyorder" || source === "easyorders";
  const wantShopify = source === "all" || source === "shopify";

  if (!wantEasyorder && !wantShopify) {
    res.status(400).json({
      success: false,
      message: "source must be all, easyorder, or shopify",
    });
    return;
  }

  const data = {};

  if (wantEasyorder) {
    try {
      data.easyorder = await runEasyOrderSync();
    } catch (error) {
      data.easyorder = { error: errorPayload(error) };
    }
  }

  if (wantShopify) {
    try {
      data.shopify = await runShopifySync();
    } catch (error) {
      if (isShopifyNotConfigured(error) && source === "all") {
        data.shopify = { skipped: true, reason: error.message };
      } else {
        data.shopify = { error: errorPayload(error) };
      }
    }
  }

  const easyorderOk = Boolean(data.easyorder && !data.easyorder.error);
  const shopifyOk = Boolean(
    data.shopify && !data.shopify.error && !data.shopify.skipped,
  );
  const anyOk = easyorderOk || shopifyOk;

  if (!anyOk) {
    res.status(500).json({
      success: false,
      message: "Failed to sync products",
      data,
    });
    return;
  }

  const payload = {
    easyorder: data.easyorder || null,
    shopify: data.shopify || null,
  };
  if (easyorderOk) {
    Object.assign(payload, data.easyorder);
  } else if (shopifyOk) {
    Object.assign(payload, data.shopify);
  }

  res.json({
    success: true,
    message: "Products synced to database",
    data: payload,
  });
}

/**
 * POST /api/products/sync-shopify
 */
async function syncShopifyProducts(req, res) {
  try {
    const result = await runShopifySync();
    res.json({
      success: true,
      message: "Products synced from Shopify to database",
      data: result,
    });
  } catch (error) {
    const status =
      error.status ||
      error.response?.status ||
      (isShopifyNotConfigured(error) ? 400 : 500);
    res.status(status).json({
      success: false,
      message: "Failed to sync products from Shopify",
      error: errorPayload(error),
    });
  }
}

async function getProducts(req, res) {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 50;
    const search = req.query.search;
    const platform = req.query.platform;

    const result = await getProductsFromDb({ page, limit, search, platform });

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch products",
      error: error.message,
    });
  }
}

/**
 * GET /api/products/:productId
 * GET /api/easyorder/products/:productId
 * Local catalog first (EasyOrder + Shopify), then EasyOrders API.
 */
async function getEasyOrderProductById(req, res) {
  try {
    const productId =
      req.params.productId ??
      req.params.product_id ??
      req.query.product_id ??
      req.query.productId;

    if (productId == null || String(productId).trim() === "") {
      res.status(400).json({
        success: false,
        message: "product_id is required",
      });
      return;
    }

    const id = String(productId).trim();
    const local = await getProductFromDbById(id);
    if (local) {
      res.json({
        success: true,
        product_id: id,
        source: local.platform || "local",
        data: local,
      });
      return;
    }

    if (isShopifyProductId(id)) {
      res.status(404).json({
        success: false,
        message: "Shopify product not found. Sync products first.",
      });
      return;
    }

    const product = await easyorderService.getProductById(id);

    res.json({
      success: true,
      product_id: id,
      source: "easyorder",
      data: product,
    });
  } catch (error) {
    if (error.code === "INVALID_PRODUCT_ID") {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    res.status(error.response?.status || 500).json({
      success: false,
      message: "Failed to fetch product from EasyOrders",
      error: error.response?.data || error.message,
    });
  }
}

module.exports = {
  syncProducts,
  syncShopifyProducts,
  getProducts,
  getEasyOrderProductById,
};
