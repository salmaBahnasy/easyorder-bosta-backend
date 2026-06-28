#!/usr/bin/env node
/**
 * Import Bosta SKU mappings from data/bosta-sku-mappings.json
 * Usage: node scripts/import-bosta-sku-mappings.js [path-to-json]
 */
const path = require("path");
const fs = require("fs");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const {
  importBostaSkuMappings,
} = require("../src/services/bostaSkuMappings.service");

async function main() {
  const fileArg = process.argv[2];
  const filePath = path.resolve(
    __dirname,
    "..",
    fileArg || "data/bosta-sku-mappings.json",
  );

  if (!fs.existsSync(filePath)) {
    console.error("File not found:", filePath);
    process.exit(1);
  }

  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const result = await importBostaSkuMappings(payload);

  console.log(
    JSON.stringify(
      {
        success: true,
        counts: {
          products: Object.keys(result.productSkuMap || {}).length,
          variants: Object.keys(result.variantSkuMap || {}).length,
          sizes: Object.keys(result.sizeSkuMap || {}).length,
          unmapped: (result.unmappedProducts || []).length,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
