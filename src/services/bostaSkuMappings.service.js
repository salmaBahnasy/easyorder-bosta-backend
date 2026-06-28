const supabase = require("../config/supabase");

const MAPPINGS_TABLE =
  process.env.SUPABASE_BOSTA_SKU_MAPPINGS_TABLE || "bosta_sku_mappings";
const UNMAPPED_TABLE =
  process.env.SUPABASE_BOSTA_UNMAPPED_PRODUCTS_TABLE ||
  "bosta_unmapped_products";

const MAPPING_TYPES = ["product", "variant", "size"];

function normalizeSkus(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((s) => String(s || "").trim()).filter(Boolean))];
}

function normalizeSizes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const out = {};
  for (const [sizeKey, skus] of Object.entries(value)) {
    const normalized = normalizeSkus(skus);
    if (normalized.length) {
      out[String(sizeKey).trim()] = normalized;
    }
  }
  return Object.keys(out).length ? out : null;
}

function pickPrimarySku(skus) {
  const list = normalizeSkus(skus);
  return list[0] || null;
}

function rowToProductEntry(row) {
  return {
    name: row.name || "",
    skus: normalizeSkus(row.skus),
  };
}

function rowToVariantEntry(row) {
  return {
    productId: row.product_id || null,
    name: row.name || "",
    size: row.size || null,
    skus: normalizeSkus(row.skus),
  };
}

function rowToSizeEntry(row) {
  return {
    name: row.name || "",
    sizes: normalizeSizes(row.sizes) || {},
  };
}

function buildAggregatedMaps(rows, unmappedRows) {
  const productSkuMap = {};
  const variantSkuMap = {};
  const sizeSkuMap = {};

  for (const row of rows || []) {
    if (row.mapping_type === "product") {
      productSkuMap[row.entity_id] = rowToProductEntry(row);
    } else if (row.mapping_type === "variant") {
      variantSkuMap[row.entity_id] = rowToVariantEntry(row);
    } else if (row.mapping_type === "size") {
      sizeSkuMap[row.entity_id] = rowToSizeEntry(row);
    }
  }

  return {
    productSkuMap,
    variantSkuMap,
    sizeSkuMap,
    unmappedProducts: (unmappedRows || []).map((row) => ({
      productId: row.product_id,
      name: row.name || "",
      reason: row.reason || "",
    })),
  };
}

async function fetchAllMappingRows() {
  const { data, error } = await supabase
    .from(MAPPINGS_TABLE)
    .select("*")
    .order("mapping_type", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return data || [];
}

async function fetchUnmappedRows() {
  const { data, error } = await supabase
    .from(UNMAPPED_TABLE)
    .select("*")
    .order("name", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return data || [];
}

async function getBostaSkuMappings() {
  const [rows, unmappedRows] = await Promise.all([
    fetchAllMappingRows(),
    fetchUnmappedRows(),
  ]);
  return buildAggregatedMaps(rows, unmappedRows);
}

async function getBostaSkuMapping(mappingType, entityId) {
  const type = String(mappingType || "").trim();
  const id = String(entityId || "").trim();

  if (!MAPPING_TYPES.includes(type)) {
    const err = new Error('mappingType must be "product", "variant", or "size"');
    err.code = "INVALID_MAPPING_TYPE";
    throw err;
  }
  if (!id) {
    const err = new Error("entityId is required");
    err.code = "INVALID_ENTITY_ID";
    throw err;
  }

  const { data, error } = await supabase
    .from(MAPPINGS_TABLE)
    .select("*")
    .eq("mapping_type", type)
    .eq("entity_id", id)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    const err = new Error("Mapping not found");
    err.code = "MAPPING_NOT_FOUND";
    throw err;
  }

  return data;
}

function validateMappingPayload(input, { forUpdate = false } = {}) {
  const mappingType = String(input.mappingType || input.mapping_type || "")
    .trim()
    .toLowerCase();

  if (!forUpdate && !MAPPING_TYPES.includes(mappingType)) {
    const err = new Error('mappingType must be "product", "variant", or "size"');
    err.code = "INVALID_MAPPING_TYPE";
    throw err;
  }

  const entityId = String(
    input.entityId ?? input.entity_id ?? input.productId ?? input.variantId ?? "",
  ).trim();

  if (!forUpdate && !entityId) {
    const err = new Error("entityId is required");
    err.code = "INVALID_ENTITY_ID";
    throw err;
  }

  const name = String(input.name ?? "").trim();
  if (!forUpdate && !name) {
    const err = new Error("name is required");
    err.code = "INVALID_NAME";
    throw err;
  }

  const payload = {
    mapping_type: mappingType,
    entity_id: entityId,
    updated_at: new Date().toISOString(),
  };

  if (name) payload.name = name;

  if (mappingType === "product") {
    const skus = normalizeSkus(input.skus);
    if (!forUpdate && !skus.length) {
      const err = new Error("skus must be a non-empty array for product mappings");
      err.code = "INVALID_SKUS";
      throw err;
    }
    if (input.skus !== undefined) payload.skus = skus;
    payload.product_id = null;
    payload.size = null;
    payload.sizes = null;
  }

  if (mappingType === "variant") {
    const productId = String(input.productId ?? input.product_id ?? "").trim();
    if (!forUpdate && !productId) {
      const err = new Error("productId is required for variant mappings");
      err.code = "INVALID_PRODUCT_ID";
      throw err;
    }
    const skus = normalizeSkus(input.skus);
    if (!forUpdate && !skus.length) {
      const err = new Error("skus must be a non-empty array for variant mappings");
      err.code = "INVALID_SKUS";
      throw err;
    }
    if (productId) payload.product_id = productId;
    if (input.size != null) payload.size = String(input.size).trim();
    if (input.skus !== undefined) payload.skus = skus;
    payload.sizes = null;
  }

  if (mappingType === "size") {
    const sizes = normalizeSizes(input.sizes);
    if (!forUpdate && !sizes) {
      const err = new Error("sizes must be a non-empty object for size mappings");
      err.code = "INVALID_SIZES";
      throw err;
    }
    if (input.sizes !== undefined) payload.sizes = sizes;
    payload.product_id = null;
    payload.size = null;
    payload.skus = [];
  }

  return payload;
}

async function addBostaSkuMapping(input) {
  const payload = validateMappingPayload(input);

  const { data, error } = await supabase
    .from(MAPPINGS_TABLE)
    .insert(payload)
    .select()
    .single();

  if (error) {
    if (String(error.code) === "23505") {
      const dup = new Error("Mapping already exists for this type and entityId");
      dup.code = "MAPPING_EXISTS";
      throw dup;
    }
    throw new Error(error.message);
  }

  return data;
}

async function updateBostaSkuMapping(mappingType, entityId, input) {
  const type = String(mappingType || "").trim();
  const id = String(entityId || "").trim();

  if (!MAPPING_TYPES.includes(type)) {
    const err = new Error('mappingType must be "product", "variant", or "size"');
    err.code = "INVALID_MAPPING_TYPE";
    throw err;
  }
  if (!id) {
    const err = new Error("entityId is required");
    err.code = "INVALID_ENTITY_ID";
    throw err;
  }

  await getBostaSkuMapping(type, id);

  const patch = validateMappingPayload(
    { ...input, mappingType: type, entityId: id },
    { forUpdate: true },
  );
  delete patch.mapping_type;
  delete patch.entity_id;

  if (!Object.keys(patch).length) {
    const err = new Error("No fields to update");
    err.code = "INVALID_UPDATES";
    throw err;
  }

  const { data, error } = await supabase
    .from(MAPPINGS_TABLE)
    .update(patch)
    .eq("mapping_type", type)
    .eq("entity_id", id)
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function deleteBostaSkuMapping(mappingType, entityId) {
  const type = String(mappingType || "").trim();
  const id = String(entityId || "").trim();

  if (!MAPPING_TYPES.includes(type)) {
    const err = new Error('mappingType must be "product", "variant", or "size"');
    err.code = "INVALID_MAPPING_TYPE";
    throw err;
  }
  if (!id) {
    const err = new Error("entityId is required");
    err.code = "INVALID_ENTITY_ID";
    throw err;
  }

  await getBostaSkuMapping(type, id);

  const { error } = await supabase
    .from(MAPPINGS_TABLE)
    .delete()
    .eq("mapping_type", type)
    .eq("entity_id", id);

  if (error) {
    throw new Error(error.message);
  }

  return { mappingType: type, entityId: id, deleted: true };
}

async function deleteUnmappedProduct(productId) {
  const id = String(productId || "").trim();
  if (!id) {
    const err = new Error("productId is required");
    err.code = "INVALID_ENTITY_ID";
    throw err;
  }

  const { data, error } = await supabase
    .from(UNMAPPED_TABLE)
    .delete()
    .eq("product_id", id)
    .select()
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    const err = new Error("Unmapped product not found");
    err.code = "MAPPING_NOT_FOUND";
    throw err;
  }

  return {
    productId: data.product_id,
    name: data.name,
    deleted: true,
  };
}

async function replaceUnmappedProducts(unmappedProducts) {
  await supabase.from(UNMAPPED_TABLE).delete().neq("product_id", "");

  const rows = (unmappedProducts || [])
    .map((item) => ({
      product_id: String(item.productId ?? item.product_id ?? "").trim(),
      name: String(item.name ?? "").trim(),
      reason: String(item.reason ?? "").trim(),
      updated_at: new Date().toISOString(),
    }))
    .filter((row) => row.product_id);

  if (!rows.length) {
    return [];
  }

  const { data, error } = await supabase
    .from(UNMAPPED_TABLE)
    .upsert(rows, { onConflict: "product_id" })
    .select();

  if (error) {
    throw new Error(error.message);
  }

  return data || [];
}

async function replaceAllMappingRows() {
  const { error } = await supabase
    .from(MAPPINGS_TABLE)
    .delete()
    .neq("entity_id", "");

  if (error) {
    throw new Error(error.message);
  }
}

async function importBostaSkuMappings(payload) {
  const productSkuMap = payload?.productSkuMap || {};
  const variantSkuMap = payload?.variantSkuMap || {};
  const sizeSkuMap = payload?.sizeSkuMap || {};
  const unmappedProducts = payload?.unmappedProducts || [];

  const rows = [];

  for (const [entityId, entry] of Object.entries(productSkuMap)) {
    rows.push({
      mapping_type: "product",
      entity_id: entityId,
      name: entry?.name || "",
      skus: normalizeSkus(entry?.skus),
      sizes: null,
      product_id: null,
      size: null,
      updated_at: new Date().toISOString(),
    });
  }

  for (const [entityId, entry] of Object.entries(variantSkuMap)) {
    rows.push({
      mapping_type: "variant",
      entity_id: entityId,
      product_id: entry?.productId ?? entry?.product_id ?? null,
      name: entry?.name || "",
      size: entry?.size != null ? String(entry.size) : null,
      skus: normalizeSkus(entry?.skus),
      sizes: null,
      updated_at: new Date().toISOString(),
    });
  }

  for (const [entityId, entry] of Object.entries(sizeSkuMap)) {
    rows.push({
      mapping_type: "size",
      entity_id: entityId,
      name: entry?.name || "",
      sizes: normalizeSizes(entry?.sizes),
      skus: [],
      product_id: null,
      size: null,
      updated_at: new Date().toISOString(),
    });
  }

  await replaceAllMappingRows();

  if (rows.length) {
    const { error } = await supabase.from(MAPPINGS_TABLE).insert(rows);

    if (error) {
      throw new Error(error.message);
    }
  }

  await replaceUnmappedProducts(unmappedProducts);

  return getBostaSkuMappings();
}

function pickLineProductId(line) {
  const product =
    line?.product && typeof line.product === "object" ? line.product : {};
  return (
    String(
      line?.variant?.productId ??
        line?.variant?.product_id ??
        line?.product_id ??
        line?.productId ??
        product?.id ??
        product?.product_id ??
        product?.easyorder_id ??
        "",
    ).trim() || null
  );
}

function pickLineVariantId(line) {
  const variant =
    line?.variant && typeof line.variant === "object" ? line.variant : {};
  return (
    String(
      variant?.id ??
        variant?.variant_id ??
        variant?.variantId ??
        line?.variant_id ??
        line?.variantId ??
        "",
    ).trim() || null
  );
}

function pickLineSize(line) {
  const variant =
    line?.variant && typeof line.variant === "object" ? line.variant : {};
  const size = variant?.size ?? line?.size ?? variant?.options?.size;
  return size != null ? String(size).trim() : null;
}

function pickLineDisplayName(line, mappingName = "") {
  const product =
    line?.product && typeof line.product === "object" ? line.product : {};
  return (
    String(mappingName || "").trim() ||
    String(line?.name || line?.product_name || product?.name || "").trim() ||
    "منتج"
  );
}

function normalizeSizeKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const digits = raw.match(/\d+/);
  return digits ? digits[0] : raw;
}

function resolveMappedSkuCandidatesForLine(line, maps) {
  const variantId = pickLineVariantId(line);
  const productId = pickLineProductId(line);
  const size = pickLineSize(line);
  const normalizedSize = normalizeSizeKey(size);

  if (variantId && maps.variantSkuMap[variantId]) {
    const entry = maps.variantSkuMap[variantId];
    return {
      productName: pickLineDisplayName(line, entry.name),
      skus: normalizeSkus(entry.skus),
      mappingType: "variant",
      entityId: variantId,
    };
  }

  if (productId && maps.sizeSkuMap[productId]) {
    const entry = maps.sizeSkuMap[productId];
    const sizes = entry.sizes || {};

    if (normalizedSize && sizes[normalizedSize]) {
      return {
        productName: pickLineDisplayName(line, entry.name),
        skus: normalizeSkus(sizes[normalizedSize]),
        mappingType: "size",
        entityId: productId,
        size: normalizedSize,
      };
    }

    if (normalizedSize) {
      for (const [sizeKey, skus] of Object.entries(sizes)) {
        if (
          normalizeSizeKey(sizeKey) === normalizedSize ||
          String(sizeKey).includes(normalizedSize)
        ) {
          return {
            productName: pickLineDisplayName(line, entry.name),
            skus: normalizeSkus(skus),
            mappingType: "size",
            entityId: productId,
            size: sizeKey,
          };
        }
      }
    }
  }

  if (productId && maps.productSkuMap[productId]) {
    const entry = maps.productSkuMap[productId];
    return {
      productName: pickLineDisplayName(line, entry.name),
      skus: normalizeSkus(entry.skus),
      mappingType: "product",
      entityId: productId,
    };
  }

  const product =
    line?.product && typeof line.product === "object" ? line.product : {};
  const variant =
    line?.variant && typeof line.variant === "object" ? line.variant : {};

  return {
    productName: pickLineDisplayName(line),
    skus: normalizeSkus([
      variant.sku,
      variant.taager_code,
      line.sku,
      product.sku,
      line.product_sku,
    ]),
    mappingType: null,
    entityId: productId || variantId || null,
  };
}

function pickAvailableSkuFromCandidates(skus, requiredQty, inventoryMap) {
  const qtyNeeded = Math.max(1, Number(requiredQty) || 1);

  for (const sku of normalizeSkus(skus)) {
    const available = Number(inventoryMap.get(sku) || 0);
    if (available >= qtyNeeded) {
      return { skuCode: sku, availableQuantity: available };
    }
  }

  return null;
}

function buildInventoryUnavailableError(unavailableProducts) {
  const names = unavailableProducts.map((p) => p.productName).filter(Boolean);
  const messageAr =
    names.length === 1
      ? `المنتج (${names[0]}) غير متوفر في المخزن`
      : `المنتجات (${names.join("، ")}) غير متوفرة في المخزن`;

  const err = new Error(messageAr);
  err.code = "BOSTA_INVENTORY_UNAVAILABLE";
  err.messageAr = messageAr;
  err.unavailableProducts = unavailableProducts;
  return err;
}

/**
 * Resolve Bosta skuCode from mappings + inventory availability.
 */
async function resolveMappedBostaSkuForLine(
  line,
  maps = null,
  inventoryMap = null,
) {
  const data = maps || (await getBostaSkuMappings());
  const inventory =
    inventoryMap || (await require("./bostaFulfillment.service").fetchBostaInventoryAvailabilityMap());

  const requiredQty = Math.max(
    1,
    Number(line?.quantity ?? line?.variant?.quantity ?? 1) || 1,
  );
  const resolved = resolveMappedSkuCandidatesForLine(line, data);

  if (!resolved.skus.length) {
    throw buildInventoryUnavailableError([
      {
        productName: resolved.productName,
        requiredQuantity: requiredQty,
        candidateSkus: [],
        availableQuantity: 0,
        mappingType: resolved.mappingType,
        entityId: resolved.entityId,
        reason: "no_sku_mapping",
      },
    ]);
  }

  const picked = pickAvailableSkuFromCandidates(
    resolved.skus,
    requiredQty,
    inventory,
  );

  if (!picked) {
    throw buildInventoryUnavailableError([
      {
        productName: resolved.productName,
        requiredQuantity: requiredQty,
        candidateSkus: resolved.skus,
        availableQuantity: Math.max(
          ...resolved.skus.map((sku) => Number(inventory.get(sku) || 0)),
          0,
        ),
        mappingType: resolved.mappingType,
        entityId: resolved.entityId,
        reason: "out_of_stock",
      },
    ]);
  }

  return picked.skuCode;
}

async function validateOrderLinesInventory(localOrder) {
  const { fetchBostaInventoryAvailabilityMap } = require("./bostaFulfillment.service");
  const cartLines = Array.isArray(localOrder?.cart_items ?? localOrder?.cartItems)
    ? (localOrder.cart_items ?? localOrder.cartItems)
    : [];

  if (!cartLines.length) {
    return { items: [], inventoryMap: new Map(), maps: await getBostaSkuMappings() };
  }

  const [maps, inventoryMap] = await Promise.all([
    getBostaSkuMappings(),
    fetchBostaInventoryAvailabilityMap(),
  ]);

  const unavailableProducts = [];
  const items = [];

  for (let index = 0; index < cartLines.length; index += 1) {
    const line = cartLines[index];
    const requiredQty = Math.max(1, Number(line?.quantity) || 1);
    const resolved = resolveMappedSkuCandidatesForLine(line, maps);

    if (!resolved.skus.length) {
      unavailableProducts.push({
        productName: resolved.productName,
        requiredQuantity: requiredQty,
        candidateSkus: [],
        availableQuantity: 0,
        mappingType: resolved.mappingType,
        entityId: resolved.entityId,
        reason: "no_sku_mapping",
      });
      continue;
    }

    const picked = pickAvailableSkuFromCandidates(
      resolved.skus,
      requiredQty,
      inventoryMap,
    );

    if (!picked) {
      unavailableProducts.push({
        productName: resolved.productName,
        requiredQuantity: requiredQty,
        candidateSkus: resolved.skus,
        availableQuantity: Math.max(
          ...resolved.skus.map((sku) => Number(inventoryMap.get(sku) || 0)),
          0,
        ),
        mappingType: resolved.mappingType,
        entityId: resolved.entityId,
        reason: "out_of_stock",
      });
      continue;
    }

    items.push({
      lineIndex: index,
      skuCode: picked.skuCode,
      availableQuantity: picked.availableQuantity,
      productName: resolved.productName,
      requiredQuantity: requiredQty,
    });
  }

  if (unavailableProducts.length) {
    throw buildInventoryUnavailableError(unavailableProducts);
  }

  return { items, inventoryMap, maps };
}

module.exports = {
  MAPPING_TYPES,
  getBostaSkuMappings,
  getBostaSkuMapping,
  addBostaSkuMapping,
  updateBostaSkuMapping,
  deleteBostaSkuMapping,
  deleteUnmappedProduct,
  importBostaSkuMappings,
  resolveMappedSkuCandidatesForLine,
  resolveMappedBostaSkuForLine,
  validateOrderLinesInventory,
  pickPrimarySku,
};
