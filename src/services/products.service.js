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

function pickExistingRaw(row) {
  return row?.raw_data && typeof row.raw_data === "object" && !Array.isArray(row.raw_data)
    ? row.raw_data
    : {};
}

function pickShopifyProductIdFromRow(row) {
  const raw = pickExistingRaw(row);
  const candidates = [
    raw.shopify_product_id,
    raw.shopify_id,
    raw.shopify?.shopify_product_id,
    raw.shopify?.id,
    String(row?.easyorder_id || "").toLowerCase().startsWith("shopify-")
      ? String(row.easyorder_id).slice("shopify-".length)
      : "",
  ];
  for (const candidate of candidates) {
    const numeric = String(candidate || "")
      .replace(/^shopify-/i, "")
      .trim();
    if (/^\d+$/.test(numeric)) return numeric;
  }
  return "";
}

function preserveShopifyFields(nextRaw, previousRow) {
  const prev = pickExistingRaw(previousRow);
  const shopifyProductId =
    pickShopifyProductIdFromRow({ raw_data: nextRaw }) ||
    pickShopifyProductIdFromRow(previousRow);
  const out = { ...nextRaw };
  if (shopifyProductId) {
    out.shopify_product_id = shopifyProductId;
    out.shopify_id = `shopify-${shopifyProductId}`;
  }
  if (prev.shopify && typeof prev.shopify === "object") {
    out.shopify = prev.shopify;
  }
  return out;
}

function mergeEasyOrderRowWithShopify(easyRow, shopifyRow, numericId) {
  const easyRaw = pickExistingRaw(easyRow);
  const shopifyRaw = pickExistingRaw(shopifyRow);
  const shopifyProductId =
    numericId ||
    pickShopifyProductIdFromRow(shopifyRow) ||
    pickShopifyProductIdFromRow(easyRow);

  return {
    easyorder_id: easyRow.easyorder_id,
    name: easyRow.name || shopifyRow.name || null,
    sku: easyRow.sku || shopifyRow.sku || null,
    raw_data: {
      ...easyRaw,
      platform: easyRaw.platform || "easyorder",
      shopify_product_id: shopifyProductId || undefined,
      shopify_id: shopifyProductId ? `shopify-${shopifyProductId}` : undefined,
      shopify: shopifyRaw,
    },
    synced_at: new Date().toISOString(),
  };
}

async function fetchAllCatalogRows() {
  const { data, error } = await supabase.from(PRODUCTS_TABLE).select("*");
  if (error) throw new Error(error.message);
  return data || [];
}

async function deleteCatalogRowsByIds(ids) {
  const unique = [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!unique.length) return 0;
  const { error } = await supabase
    .from(PRODUCTS_TABLE)
    .delete()
    .in("easyorder_id", unique);
  if (error) throw new Error(error.message);
  return unique.length;
}

/** One catalog row per product: EasyOrder UUID + Shopify id on the same row. */
async function unifyDuplicateCatalogRows() {
  const rows = await fetchAllCatalogRows();
  const easyByName = new Map();
  const shopifyRows = [];

  for (const row of rows) {
    const id = String(row?.easyorder_id || "").trim();
    if (!id) continue;
    if (id.toLowerCase().startsWith("shopify-")) {
      shopifyRows.push(row);
      continue;
    }
    const key = canonicalProductNameKey(row.name);
    if (key && !easyByName.has(key)) easyByName.set(key, row);
  }

  const toUpsert = [];
  const toDelete = [];

  for (const shopifyRow of shopifyRows) {
    const twin = easyByName.get(canonicalProductNameKey(shopifyRow.name));
    if (!twin) continue;
    toUpsert.push(
      mergeEasyOrderRowWithShopify(
        twin,
        shopifyRow,
        pickShopifyProductIdFromRow(shopifyRow),
      ),
    );
    if (shopifyRow.easyorder_id !== twin.easyorder_id) {
      toDelete.push(shopifyRow.easyorder_id);
    }
  }

  if (toUpsert.length) await upsertProductRows(toUpsert);
  const deletedDuplicates = await deleteCatalogRowsByIds(toDelete);

  return {
    merged: toUpsert.length,
    deletedDuplicates,
    shopifyOnly: shopifyRows.length - deletedDuplicates,
  };
}

async function syncProductsFromEasyOrder(easyOrderPayload) {
  const items = normalizeProductsPayload(easyOrderPayload);

  if (!items.length) {
    return { inserted: 0, updated: 0, skipped: 0, total: 0 };
  }

  const existingById = new Map(
    (await fetchAllCatalogRows()).map((row) => [String(row.easyorder_id), row]),
  );
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
      raw_data: preserveShopifyFields(rawData, existingById.get(easyorderId)),
      synced_at: new Date().toISOString(),
    });
  }

  await upsertProductRows(rows);
  const unify = await unifyDuplicateCatalogRows();

  return {
    synced: rows.length,
    skippedNoId: skipped,
    totalFromApi: items.length,
    source: "easyorder",
    unify,
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
  const shopifyProductId = pickShopifyProductIdFromRow(row);
  const easyorderId = String(row?.easyorder_id || "");
  const isShopifyPrimary = easyorderId.toLowerCase().startsWith("shopify-");
  if (shopifyProductId && !isShopifyPrimary && easyorderId) return "both";
  if (isShopifyPrimary || shopifyProductId) return "shopify";
  const fromRaw = String(
    row?.raw_data?.platform || row?.raw_data?.order_platform || "",
  )
    .trim()
    .toLowerCase();
  if (fromRaw === "shopify") return "shopify";
  if (fromRaw === "easyorder" || fromRaw === "easyorders") return "easyorder";
  return "easyorder";
}

function decorateProductRow(row) {
  if (!row || typeof row !== "object") return row;
  const shopifyProductId = pickShopifyProductIdFromRow(row) || null;
  const platform = resolveProductPlatform(row);
  const platforms = platform === "both" ? ["easyorder", "shopify"] : [platform];
  return {
    ...row,
    shopify_product_id: shopifyProductId,
    shopify_id: shopifyProductId ? `shopify-${shopifyProductId}` : null,
    platforms,
    platform,
  };
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

async function loadProductIdentityIndex() {
  const rows = await fetchAllCatalogRows();
  const aliasToCanonical = new Map();
  const metaByCanonical = new Map();

  function addAlias(alias, canonical) {
    const key = String(alias || "").trim();
    if (!key || !canonical) return;
    aliasToCanonical.set(key, canonical);
    aliasToCanonical.set(key.toLowerCase(), canonical);
  }

  for (const row of rows) {
    const canonical = String(row?.easyorder_id || "").trim();
    if (!canonical) continue;
    const shopifyProductId = pickShopifyProductIdFromRow(row);
    addAlias(canonical, canonical);
    for (const candidate of productIdLookupCandidates(canonical)) {
      addAlias(candidate, canonical);
    }
    if (shopifyProductId) {
      addAlias(shopifyProductId, canonical);
      addAlias(`shopify-${shopifyProductId}`, canonical);
    }
    metaByCanonical.set(canonical, {
      name: row.name ?? null,
      sku: row.sku ?? null,
      shopify_product_id: shopifyProductId || null,
    });
  }

  return { aliasToCanonical, metaByCanonical };
}

function canonicalizeProductId(productId, index) {
  const id = String(productId || "").trim();
  if (!id || !index) return id;
  return (
    index.aliasToCanonical.get(id) ||
    index.aliasToCanonical.get(id.toLowerCase()) ||
    id
  );
}

function expandProductAliasIds(productIds, index) {
  const values = Array.isArray(productIds) ? productIds : [productIds];
  const out = new Set();
  for (const raw of values) {
    const id = String(raw || "").trim();
    if (!id) continue;
    out.add(id);
    const canonical = canonicalizeProductId(id, index);
    if (canonical) out.add(canonical);
    const meta = index?.metaByCanonical?.get(canonical);
    if (meta?.shopify_product_id) {
      out.add(meta.shopify_product_id);
      out.add(`shopify-${meta.shopify_product_id}`);
    }
    for (const candidate of productIdLookupCandidates(canonical || id)) {
      out.add(candidate);
    }
  }
  return [...out];
}

async function resolveCatalogTwinIds(productId) {
  const candidates = new Set(productIdLookupCandidates(productId));
  if (!candidates.size) return [];

  const index = await loadProductIdentityIndex();
  const canonical = canonicalizeProductId(productId, index);
  if (canonical) {
    candidates.add(canonical);
    const meta = index.metaByCanonical.get(canonical);
    if (meta?.shopify_product_id) {
      candidates.add(meta.shopify_product_id);
      candidates.add(`shopify-${meta.shopify_product_id}`);
    }
  }

  const rows = await fetchAllCatalogRows();
  const seedKeys = new Set();
  for (const row of rows) {
    const id = String(row?.easyorder_id || "").trim();
    if (!candidates.has(id) && pickShopifyProductIdFromRow(row) !== String(productId || "").replace(/^shopify-/i, "")) {
      continue;
    }
    const key = canonicalProductNameKey(row?.name);
    if (key) seedKeys.add(key);
  }

  if (seedKeys.size) {
    for (const row of rows) {
      const key = canonicalProductNameKey(row?.name);
      if (!key || !seedKeys.has(key)) continue;
      const id = String(row?.easyorder_id || "").trim();
      if (id) candidates.add(id);
      const shopifyProductId = pickShopifyProductIdFromRow(row);
      if (shopifyProductId) {
        candidates.add(shopifyProductId);
        candidates.add(`shopify-${shopifyProductId}`);
      }
    }
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
  const unify = await unifyDuplicateCatalogRows();

  return {
    synced: rows.length,
    skippedNoId: skipped,
    totalFromApi: items.length,
    source: "shopify",
    unify,
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
      "easyorder_id.ilike.shopify-%,raw_data->>shopify_product_id.not.is.null",
    );
  } else if (
    platformFilter === "easyorder" ||
    platformFilter === "easyorders"
  ) {
    query = query.not("easyorder_id", "ilike", "shopify-%");
  } else if (platformFilter === "both") {
    query = query
      .not("easyorder_id", "ilike", "shopify-%")
      .not("raw_data->>shopify_product_id", "is", null);
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

  if (Array.isArray(data) && data.length) {
    return decorateProductRow(data[0]);
  }

  const numeric = candidates.find((id) => /^\d+$/.test(id));
  if (numeric) {
    const { data: byShopify, error: shopifyError } = await supabase
      .from(PRODUCTS_TABLE)
      .select("*")
      .eq("raw_data->>shopify_product_id", numeric)
      .limit(1);
    if (shopifyError) throw new Error(shopifyError.message);
    if (Array.isArray(byShopify) && byShopify.length) {
      return decorateProductRow(byShopify[0]);
    }
  }

  const index = await loadProductIdentityIndex();
  const canonical = canonicalizeProductId(productId, index);
  if (canonical && !candidates.includes(canonical)) {
    const { data: byCanonical, error: canonicalError } = await supabase
      .from(PRODUCTS_TABLE)
      .select("*")
      .eq("easyorder_id", canonical)
      .limit(1);
    if (canonicalError) throw new Error(canonicalError.message);
    if (Array.isArray(byCanonical) && byCanonical.length) {
      return decorateProductRow(byCanonical[0]);
    }
  }

  return null;
}

module.exports = {
  syncProductsFromEasyOrder,
  syncProductsFromShopify,
  unifyDuplicateCatalogRows,
  getProductsFromDb,
  getProductFromDbById,
  productIdLookupCandidates,
  canonicalProductNameKey,
  productNamesMatch,
  resolveCatalogTwinIds,
  loadProductIdentityIndex,
  canonicalizeProductId,
  expandProductAliasIds,
  PRODUCTS_TABLE,
};
