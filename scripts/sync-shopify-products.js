#!/usr/bin/env node
/**
 * Pull Shopify products into the same `products` table as EasyOrders.
 *
 *   node scripts/sync-shopify-products.js
 *
 * Requires SHOPIFY_SHOP_DOMAIN and SHOPIFY_ACCESS_TOKEN (Admin API, read_products).
 */
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const {
  syncProductsFromShopify,
} = require("../src/services/products.service");

async function main() {
  const result = await syncProductsFromShopify();
  console.log(
    `done synced=${result.synced} skipped=${result.skippedNoId} totalFromApi=${result.totalFromApi}`,
  );
}

main().catch((error) => {
  console.error("FAILED", error.message);
  process.exit(1);
});
