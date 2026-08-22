#!/usr/bin/env node
/**
 * Test Shopify webhook mapping + HMAC.
 *
 *   node scripts/test-shopify-webhook.js
 *   node scripts/test-shopify-webhook.js --send
 *   node scripts/test-shopify-webhook.js --send --url=http://localhost:5050
 *
 * --send posts a signed fake order to POST /webhooks/shopify/orders
 * and will insert a real row in `orders` if the server + Supabase work.
 */
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const {
  mapShopifyOrderToLocal,
  isShopifyOrder,
  verifyShopifyWebhook,
} = require("../src/services/shopify.service");

function hasFlag(name) {
  return process.argv.includes(name);
}

function readArg(name, fallback) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length).trim() || fallback;
}

function buildSampleOrder() {
  const id = Number(readArg("--order-id", "999000111"));
  return {
    id,
    name: `#TEST-${id}`,
    order_number: id,
    email: "shopify-test@example.com",
    created_at: new Date().toISOString(),
    financial_status: "pending",
    fulfillment_status: null,
    gateway: "Cash on Delivery (COD)",
    currency: "EGP",
    subtotal_price: "250.00",
    total_price: "300.00",
    total_shipping_price_set: { shop_money: { amount: "50.00", currency_code: "EGP" } },
    shipping_address: {
      first_name: "تست",
      last_name: "شوبيفاي",
      name: "تست شوبيفاي",
      phone: "01000000000",
      address1: "شارع الاختبار",
      city: "القاهرة",
      province: "Cairo",
    },
    customer: {
      first_name: "تست",
      last_name: "شوبيفاي",
      phone: "01000000000",
    },
    line_items: [
      {
        id: 1,
        product_id: 11,
        variant_id: 22,
        title: "منتج تجريبي",
        sku: "SHOPIFY-TEST-SKU",
        quantity: 2,
        price: "125.00",
        variant_title: "L",
      },
    ],
  };
}

function signBody(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

function requestJson(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runOfflineChecks(sample) {
  const mapped = mapShopifyOrderToLocal(sample, { topic: "orders/create" });
  assert(mapped, "mapper returned null");
  assert(mapped.id === `shopify-${sample.id}`, `unexpected id: ${mapped.id}`);
  assert(mapped.platform === "shopify", "platform is not shopify");
  assert(mapped.full_name.includes("شوبيفاي"), "customer name was not mapped");
  assert(mapped.phone === "01000000000", "phone was not mapped");
  assert(mapped.cart_items.length === 1, "line items were not mapped");
  assert(mapped.total_cost === 300, `total_cost expected 300, got ${mapped.total_cost}`);
  assert(isShopifyOrder(mapped), "isShopifyOrder returned false");

  const secret = (process.env.SHOPIFY_WEBHOOK_SECRET || "").trim();
  assert(secret, "SHOPIFY_WEBHOOK_SECRET is empty in .env");

  const rawBody = Buffer.from(JSON.stringify(sample), "utf8");
  const hmac = signBody(rawBody, secret);
  verifyShopifyWebhook({
    rawBody,
    get: (header) => {
      const key = String(header || "").toLowerCase();
      if (key === "x-shopify-hmac-sha256") return hmac;
      if (key === "x-shopify-shop-domain") {
        return process.env.SHOPIFY_SHOP_DOMAIN || "";
      }
      return "";
    },
  });

  let rejected = false;
  try {
    verifyShopifyWebhook({
      rawBody,
      get: () => "invalid-hmac",
    });
  } catch (error) {
    rejected = error.code === "INVALID_SHOPIFY_HMAC";
  }
  assert(rejected, "invalid HMAC was not rejected");

  return { mapped, hmac, rawBody, secret };
}

async function sendWebhook({ rawBody, hmac, url }) {
  const endpoint = `${url.replace(/\/$/, "")}/webhooks/shopify/orders`;
  const shop = (process.env.SHOPIFY_SHOP_DOMAIN || "").trim();

  const unsigned = await requestJson(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(rawBody),
      "X-Shopify-Topic": "orders/create",
    },
    body: rawBody,
  });

  const signed = await requestJson(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(rawBody),
      "X-Shopify-Topic": "orders/create",
      "X-Shopify-Hmac-Sha256": hmac,
      ...(shop ? { "X-Shopify-Shop-Domain": shop } : {}),
    },
    body: rawBody,
  });

  return { endpoint, unsigned, signed };
}

async function main() {
  const sample = buildSampleOrder();
  const { mapped, hmac, rawBody } = await runOfflineChecks(sample);

  console.log("OK  mapper + HMAC");
  console.log(`    local id: ${mapped.id}`);
  console.log(`    name: ${mapped.full_name}`);
  console.log(`    total: ${mapped.total_cost}`);
  console.log(`    sku: ${mapped.cart_items[0].sku}`);

  if (!hasFlag("--send")) {
    console.log("");
    console.log("Mapper is working. To test the HTTP webhook + database:");
    console.log("  1. npm run dev");
    console.log("  2. node scripts/test-shopify-webhook.js --send");
    console.log("Then open the dashboard Orders page and look for platform=shopify.");
    return;
  }

  const url = readArg("--url", process.env.APP_PUBLIC_BASE_URL || "http://localhost:5050");
  const { endpoint, unsigned, signed } = await sendWebhook({ rawBody, hmac, url });

  console.log("");
  console.log(`POST ${endpoint}`);
  console.log(`    without HMAC: HTTP ${unsigned.status} (expected 401)`);
  console.log(`    with HMAC:    HTTP ${signed.status} (expected 200)`);

  if (unsigned.status !== 401) {
    throw new Error(`Unsigned webhook should be 401, got ${unsigned.status}`);
  }
  if (signed.status !== 200 || !signed.json?.success) {
    throw new Error(
      `Signed webhook failed: HTTP ${signed.status} ${signed.text}`,
    );
  }

  const saved = signed.json.data || {};
  console.log(`    saved order_id: ${saved.sourceOrderId || saved.id}`);
  console.log(`    platform: ${saved.platform || saved.order_platform}`);
  console.log("");
  console.log("Webhook saved. Check GET /api/orders or the dashboard Orders page.");
}

main().catch((error) => {
  console.error("FAILED", error.message);
  process.exit(1);
});
