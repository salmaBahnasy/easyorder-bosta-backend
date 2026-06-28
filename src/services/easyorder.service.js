const axios = require("axios");

const EASYORDER_API_BASE =
  process.env.EASYORDER_API_BASE_URL ||
  "https://api.easy-orders.net/api/v1/external-apps";

async function easyorderHeaders() {
  const apiKey = process.env.EASYORDER_API_KEY;
  if (!apiKey) {
    throw new Error("EASYORDER_API_KEY is not set");
  }
  return { "Api-Key": apiKey };
}

async function getOrderById(orderId) {
  const url = `${EASYORDER_API_BASE}/orders/${orderId}`;

  const response = await axios.get(url, {
    headers: await easyorderHeaders(),
  });

  return response.data;
}

/** Fetches products list from EasyOrders external-apps API. */
async function getProductsFromEasyOrder() {
  const url = `${EASYORDER_API_BASE}/products`;

  const response = await axios.get(url, {
    headers: await easyorderHeaders(),
  });

  return response.data;
}

/** GET /products/:product_id — single product from EasyOrders external-apps API. */
async function getProductById(productId) {
  const id = String(productId || "").trim();
  if (!id) {
    const err = new Error("product_id is required");
    err.code = "INVALID_PRODUCT_ID";
    throw err;
  }

  const url = `${EASYORDER_API_BASE}/products/${encodeURIComponent(id)}`;

  const response = await axios.get(url, {
    headers: await easyorderHeaders(),
  });

  return response.data;
}

module.exports = {
  getOrderById,
  getProductsFromEasyOrder,
  getProductById,
};
