#!/usr/bin/env node
/**
 * Prints SQL to create easyconfirm_webhook_events (idempotency table).
 * Run the SQL in Supabase SQL Editor (service role cannot run DDL via REST).
 *
 * Usage: node scripts/setup-easyconfirm-webhook-events.js
 */
const fs = require("fs");
const path = require("path");

const sqlPath = path.join(
  __dirname,
  "..",
  "supabase",
  "easyconfirm_webhook_events_schema.sql",
);
const sql = fs.readFileSync(sqlPath, "utf8");

console.log(`
=== EasyConfirm webhook events — one-time Supabase setup ===

1. Open: https://supabase.com/dashboard → your project → SQL → New query
2. Paste the SQL below and click RUN
3. Optionally set in .env / Render:
   EASYCONFIRM_WEBHOOK_SECRET=<secret from EasyConfirm Dashboard → Webhooks>
   EASYCONFIRM_API_KEY=ek_...
   SUPABASE_EASYCONFIRM_WEBHOOK_EVENTS_TABLE=easyconfirm_webhook_events

--- SQL ---

${sql}

--- end SQL ---
`);
