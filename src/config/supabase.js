const path = require("path");
const { createClient } = require("@supabase/supabase-js");

require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

const supabaseUrl = (process.env.SUPABASE_URL || "").trim();
const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Supabase env missing: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in a .env file at the project root (copy from .env.example).",
  );
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
