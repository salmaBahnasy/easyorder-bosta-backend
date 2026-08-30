const crypto = require("crypto");

const supabase = require("../config/supabase");
const {
  fetchAllShopifyProducts,
  mapShopifyProductToCatalogRow,
} = require("./shopify.service");

const PRODUCTS_TABLE =
  process.env.SUPABASE_PRODUCTS_TABLE || "products";
const UPSERT_CHUNK_SIZE = 100;

function normalizeProductsPayload(apiBody) {
  if (!apiBody) return [];

  if (Array.isArray(apiBody)) return apiBody;

  const candidates = [
    apiBody.data,
    apiBody.products,
    apiBody.items,
    apiBody.results,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }

  return [];
}

function resolveEasyorderProductId(item) {
  if (!item || typeof item !== "object") return null;

  const id =
    item.id ??
    item.product_id ??
    item.productId ??
    item.sku ??
    item.code;

  if (id == null) return null;

  const s = String(id).trim();
  return s || null;
}

async function syncProductsFromEasyOrder(easyOrderPayload) {
  const items = normalizeProductsPayload(easyOrderPayload);

  if (!items.length) {
    return { inserted: 0, updated: 0, skipped: 0, total: 0 };
  }

  const rows = [];
  let skipped = 0;

  for (const item of items) {
    let easyorderId = resolveEasyorderProductId(item);

    if (!easyorderId) {
      easyorderId = `hash-${crypto
        .createHash("sha1")
        .update(JSON.stringify(item))
        .digest("hex")}`;
      skipped += 1;
    }

    const name =
      item.name ??
      item.title ??
      item.product_name ??
      null;

    const rawData =
      item && typeof item === "object" ? { ...item } : { value: item };
    if (!rawData.platform) rawData.platform = "easyorder";

    rows.push({
      easyorder_id: easyorderId,
      name,
      sku: item.sku ?? item.variant_sku ?? null,
      raw_data: rawData,
      synced_at: new Date().toISOString(),
    });
  }

  await upsertProductRows(rows);

  return {
    synced: rows.length,
    skippedNoId: skipped,
    totalFromApi: items.length,
    source: "easyorder",
  };
}

async function upsertProductRows(rows) {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
    const { error } = await supabase.from(PRODUCTS_TABLE).upsert(chunk, {
      onConflict: "easyorder_id",
    });
    if (error) {
      throw new Error(error.message);
    }
  }
}

function resolveProductPlatform(row) {
  const fromRaw = String(
    row?.raw_data?.platform || row?.raw_data?.order_platform || "",
  )
    .trim()
    .toLowerCase();
  if (fromRaw === "shopify") return "shopify";
  if (fromRaw === "easyorder" || fromRaw === "easyorders") return "easyorder";
  if (String(row?.easyorder_id || "").startsWith("shopify-")) return "shopify";
  return "easyorder";
}

function decorateProductRow(row) {
  if (!row || typeof row !== "object") return row;
  return { ...row, platform: resolveProductPlatform(row) };
}

function productIdLookupCandidates(productId) {
  const id = String(productId || "").trim();
  if (!id) return [];
  const candidates = [id];
  if (/^\d+$/.test(id)) candidates.push(`shopify-${id}`);
  if (id.toLowerCase().startsWith("shopify-")) {
    candidates.push(id.slice("shopify-".length));
  }
  return [...new Set(candidates)];
}

/** Known catalog twins whose titles differ by more than punctuation. */
const PRODUCT_NAME_ALIAS_GROUPS = [
  ["مخدة ميموري فوم - رويال فندقية", "مخدة ميموري فوم - رويال ملكية"],
];

function normalizeProductNameKey(name) {
  return String(name || "")
    .normalize("NFC")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[إأآٱا]/g, "ا")
    .replace(/[ىي]/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/(^|\s)طبيه(\s|$)/g, " ")
    .replace(/[x×*]/gi, "")
    .replace(/[^\u0600-\u06FFa-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalProductNameKey(name) {
  const key = normalizeProductNameKey(name);
  if (!key) return "";
  for (const group of PRODUCT_NAME_ALIAS_GROUPS) {
    const keys = group.map(normalizeProductNameKey);
    if (keys.includes(key)) return keys[0];
  }
  return key;
}

function productNamesMatch(left, right) {
  const a = canonicalProductNameKey(left);
  const b = canonicalProductNameKey(right);
  return Boolean(a && b && a === b);
}

async function resolveCatalogTwinIds(productId) {
  const candidates = new Set(productIdLookupCandidates(productId));
  if (!candidates.size) return [];

  const { data, error } = await supabase
    .from(PRODUCTS_TABLE)
    .select("easyorder_id,name");
  if (error) throw new Error(error.message);

  const rows = data || [];
  const seedKeys = new Set();
  for (const row of rows) {
    const id = String(row?.easyorder_id || "").trim();
    if (!candidates.has(id)) continue;
    const key = canonicalProductNameKey(row?.name);
    if (key) seedKeys.add(key);
  }

  if (!seedKeys.size) return [...candidates];

  for (const row of rows) {
    const key = canonicalProductNameKey(row?.name);
    if (!key || !seedKeys.has(key)) continue;
    const id = String(row?.easyorder_id || "").trim();
    if (id) candidates.add(id);
  }

  return [...candidates];
}

async function syncProductsFromShopify() {
  const items = await fetchAllShopifyProducts();
  const rows = [];
  let skipped = 0;

  for (const item of items) {
    const row = mapShopifyProductToCatalogRow(item);
    if (!row) {
      skipped += 1;
      continue;
    }
    rows.push(row);
  }

  if (rows.length) {
    await upsertProductRows(rows);
  }

  return {
    synced: rows.length,
    skippedNoId: skipped,
    totalFromApi: items.length,
    source: "shopify",
  };
}

async function getProductsFromDb({ page = 1, limit = 50, search, platform }) {
  const fromIndex = (page - 1) * limit;
  const toIndex = fromIndex + limit - 1;

  let query = supabase
    .from(PRODUCTS_TABLE)
    .select("*", { count: "exact" })
    .order("synced_at", { ascending: false })
    .range(fromIndex, toIndex);

  const q = search && String(search).trim();
  if (q) {
    const pattern = `%${q}%`;
    query = query.or(
      `name.ilike.${pattern},sku.ilike.${pattern},easyorder_id.ilike.${pattern}`,
    );
  }

  const platformFilter = String(platform || "")
    .trim()
    .toLowerCase();
  if (platformFilter === "shopify") {
    query = query.or(
      "easyorder_id.ilike.shopify-%,raw_data->>platform.eq.shopify",
    );
  } else if (
    platformFilter === "easyorder" ||
    platformFilter === "easyorders"
  ) {
    query = query.not("easyorder_id", "ilike", "shopify-%");
  }

  const { data, count, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  const total = count || 0;

  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
    data: (data || []).map(decorateProductRow),
  };
}

async function getProductFromDbById(productId) {
  const candidates = productIdLookupCandidates(productId);
  if (!candidates.length) return null;

  const { data, error } = await supabase
    .from(PRODUCTS_TABLE)
    .select("*")
    .in("easyorder_id", candidates)
    .limit(1);

  if (error) {
    throw new Error(error.message);
  }

  const row = Array.isArray(data) && data.length ? data[0] : null;
  return row ? decorateProductRow(row) : null;
}

module.exports = {
  syncProductsFromEasyOrder,
  syncProductsFromShopify,
  getProductsFromDb,
  getProductFromDbById,
  productIdLookupCandidates,
  canonicalProductNameKey,
  productNamesMatch,
  resolveCatalogTwinIds,
  PRODUCTS_TABLE,
};
