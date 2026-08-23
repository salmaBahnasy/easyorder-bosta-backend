#!/usr/bin/env node
/**
 * Pull recent Shopify orders into the same `orders` table as webhooks.
 *
 *   node scripts/sync-shopify-orders.js
 *   node scripts/sync-shopify-orders.js --since=2026-08-01 --limit=100
 *
 * Requires SHOPIFY_SHOP_DOMAIN and SHOPIFY_ACCESS_TOKEN (Admin API).
 */
const path = require("path");
const axios = require("axios");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const { mapShopifyOrderToLocal } = require("../src/services/shopify.service");
const { addWebhookOrder } = require("../src/services/webhookOrders.service");

function readArg(name, fallback) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length).trim() || fallback;
}

function shopDomain() {
  return String(process.env.SHOPIFY_SHOP_DOMAIN || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

async function fetchShopifyOrdersPage({ since, pageInfo, limit }) {
  const shop = shopDomain();
  const token = String(process.env.SHOPIFY_ACCESS_TOKEN || "").trim();
  if (!shop) throw new Error("SHOPIFY_SHOP_DOMAIN is not set");
  if (!token) throw new Error("SHOPIFY_ACCESS_TOKEN is not set");

  const url = pageInfo
    ? `https://${shop}/admin/api/2024-10/orders.json?limit=${limit}&page_info=${encodeURIComponent(pageInfo)}`
    : `https://${shop}/admin/api/2024-10/orders.json`;

  const response = await axios.get(url, {
    headers: {
      "X-Shopify-Access-Token": token,
      Accept: "application/json",
    },
    params: pageInfo
      ? undefined
      : {
          status: "any",
          limit,
          created_at_min: since,
        },
    timeout: 60000,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    throw new Error(
      response.data?.errors ||
        response.data?.error ||
        `Shopify API returned ${response.status}`,
    );
  }

  const link = String(response.headers.link || response.headers.Link || "");
  const nextMatch = link.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>; rel="next"/);
  return {
    orders: Array.isArray(response.data?.orders) ? response.data.orders : [],
    nextPageInfo: nextMatch ? decodeURIComponent(nextMatch[1]) : "",
  };
}

async function main() {
  const since = readArg("--since", new Date(Date.now() - 7 * 86400000).toISOString());
  const limit = Math.min(250, Math.max(1, Number(readArg("--limit", "100")) || 100));

  let imported = 0;
  let skipped = 0;
  let pageInfo = "";
  let pages = 0;

  for (;;) {
    const page = await fetchShopifyOrdersPage({ since, pageInfo, limit });
    pages += 1;
    for (const remote of page.orders) {
      const mapped = mapShopifyOrderToLocal(remote, { topic: "orders/create" });
      if (!mapped) {
        skipped += 1;
        continue;
      }
      await addWebhookOrder(mapped, { fromWebhook: true });
      imported += 1;
      console.log(`saved ${mapped.id} ${mapped.short_id || ""} ${mapped.full_name || ""}`);
    }
    if (!page.nextPageInfo || pages >= 20) break;
    pageInfo = page.nextPageInfo;
  }

  console.log(`done imported=${imported} skipped=${skipped} since=${since}`);
}

main().catch((error) => {
  console.error("FAILED", error.message);
  process.exit(1);
});
