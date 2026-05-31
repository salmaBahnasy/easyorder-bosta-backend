const crypto = require("crypto");

const supabase = require("../config/supabase");

const PRODUCTS_TABLE =
  process.env.SUPABASE_PRODUCTS_TABLE || "products";

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

    rows.push({
      easyorder_id: easyorderId,
      name,
      sku: item.sku ?? item.variant_sku ?? null,
      raw_data: item,
      synced_at: new Date().toISOString(),
    });
  }

  const { error } = await supabase.from(PRODUCTS_TABLE).upsert(rows, {
    onConflict: "easyorder_id",
  });

  if (error) {
    throw new Error(error.message);
  }

  return {
    synced: rows.length,
    skippedNoId: skipped,
    totalFromApi: items.length,
  };
}

async function getProductsFromDb({ page = 1, limit = 50, search }) {
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
    data: data || [],
  };
}

module.exports = {
  syncProductsFromEasyOrder,
  getProductsFromDb,
  PRODUCTS_TABLE,
};
