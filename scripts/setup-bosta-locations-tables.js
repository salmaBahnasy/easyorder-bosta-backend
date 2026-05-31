#!/usr/bin/env node
/**
 * Prints the SQL to create bosta_cities / bosta_districts.
 * Tables must be created in Supabase SQL Editor (service role cannot run DDL via REST).
 *
 * Usage: node scripts/setup-bosta-locations-tables.js
 */
const fs = require("fs");
const path = require("path");

const sqlPath = path.join(
  __dirname,
  "..",
  "supabase",
  "bosta_locations_schema.sql",
);
const sql = fs.readFileSync(sqlPath, "utf8");

console.log(`
=== Bosta locations — one-time Supabase setup ===

1. Open: https://supabase.com/dashboard → your project → SQL → New query
2. Paste the SQL below and click RUN (success = no error)
3. In Postman (POST, not GET):
   https://easyorder-bosta-backend.onrender.com/api/easyorder/bosta/locations/sync
4. Then GET:
   /api/easyorder/bosta/cities

--- SQL (copy from supabase/bosta_locations_schema.sql) ---

${sql}

--- end SQL ---
`);
