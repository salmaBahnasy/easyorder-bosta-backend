const easyorderService = require("../services/easyorder.service");
const {
  syncProductsFromEasyOrder,
  getProductsFromDb,
} = require("../services/products.service");

async function syncProducts(req, res) {
  try {
    const payload = await easyorderService.getProductsFromEasyOrder();
    const result = await syncProductsFromEasyOrder(payload);

    res.json({
      success: true,
      message: "Products synced from EasyOrders to database",
      data: result,
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      message: "Failed to sync products from EasyOrders",
      error: error.response?.data || error.message,
    });
  }
}

async function getProducts(req, res) {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 50;
    const search = req.query.search;

    const result = await getProductsFromDb({ page, limit, search });

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
 * Proxies EasyOrders: GET /external-apps/products/:product_id
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

    const product = await easyorderService.getProductById(productId);

    res.json({
      success: true,
      product_id: String(productId).trim(),
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
  getProducts,
  getEasyOrderProductById,
};
