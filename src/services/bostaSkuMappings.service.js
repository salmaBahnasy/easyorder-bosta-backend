const supabase = require("../config/supabase");
const {
  productIdLookupCandidates,
  canonicalProductNameKey,
  productNamesMatch,
  resolveCatalogTwinIds,
} = require("./products.service");

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

/** SKU chosen by user on create/edit order or send-to-bosta body. */
function pickLineSelectedBostaSku(line) {
  const variant =
    line?.variant && typeof line.variant === "object" ? line.variant : {};
  const candidates = [
    line?.bosta_sku,
    line?.bostaSku,
    line?.bostaSkuCode,
    line?.skuCode,
    variant?.bosta_sku,
    variant?.bostaSku,
    variant?.sku,
    line?.sku,
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value && /^bo-/i.test(value)) {
      return value;
    }
  }

  return null;
}

function normalizeBostaSkuCode(value) {
  const sku = String(value || "").trim();
  if (!sku || !/^bo-/i.test(sku)) return null;
  return sku;
}

/** Parse SKU overrides from send-to-bosta request body → Map<lineIndex, skuCode>. */
function parseLineSkuOverrides(body = {}) {
  const src =
    body?.overrides && typeof body.overrides === "object" ? body.overrides : body;
  const skuByIndex = new Map();
  const priceByIndex = new Map();

  const rootSku = normalizeBostaSkuCode(
    src.skuCode ?? src.sku ?? src.bosta_sku ?? src.bostaSku,
  );
  if (rootSku) {
    skuByIndex.set(0, rootSku);
  }

  const listSources = [
    src.lineSkus,
    src.line_skus,
    src.items,
    src.skus,
    src.cart_items,
    src.cartItems,
  ];

  for (const list of listSources) {
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      if (entry == null) continue;

      if (typeof entry === "string") {
        const sku = normalizeBostaSkuCode(entry);
        if (sku) skuByIndex.set(i, sku);
        continue;
      }

      if (typeof entry !== "object") continue;

      const lineIndex = Number(
        entry.lineIndex ?? entry.line_index ?? entry.index ?? i,
      );
      if (!Number.isFinite(lineIndex) || lineIndex < 0) continue;

      const sku = normalizeBostaSkuCode(
        entry.skuCode ??
          entry.sku ??
          entry.bosta_sku ??
          entry.bostaSku ??
          entry.bostaSkuCode,
      );
      if (sku) {
        skuByIndex.set(lineIndex, sku);
      }

      const priceRaw = entry.price;
      if (priceRaw != null && priceRaw !== "") {
        const price = Number(priceRaw);
        if (Number.isFinite(price) && price >= 0) {
          priceByIndex.set(lineIndex, price);
        }
      }
    }
  }

  return { skuByIndex, priceByIndex };
}

function applyLineSkuOverridesToOrder(
  localOrder,
  lineSkuOverrides,
  priceByIndex,
) {
  if (!localOrder || typeof localOrder !== "object") return localOrder;

  const hasSkuOverrides =
    lineSkuOverrides &&
    lineSkuOverrides instanceof Map &&
    lineSkuOverrides.size > 0;
  const hasPriceOverrides =
    priceByIndex && priceByIndex instanceof Map && priceByIndex.size > 0;
  if (!hasSkuOverrides && !hasPriceOverrides) {
    return localOrder;
  }

  const cartKey = Array.isArray(localOrder.cart_items)
    ? "cart_items"
    : Array.isArray(localOrder.cartItems)
      ? "cartItems"
      : null;
  if (!cartKey) return localOrder;

  const lines = [...localOrder[cartKey]];

  if (hasSkuOverrides) {
    for (const [index, sku] of lineSkuOverrides.entries()) {
      if (!lines[index] || typeof lines[index] !== "object") continue;
      const line = { ...lines[index] };
      const variant =
        line.variant && typeof line.variant === "object"
          ? { ...line.variant }
          : {};

      line.bosta_sku = sku;
      line.bostaSku = sku;
      line.skuCode = sku;
      variant.sku = sku;
      variant.bosta_sku = sku;
      line.variant = variant;
      lines[index] = line;
    }
  }

  if (hasPriceOverrides) {
    for (const [index, price] of priceByIndex.entries()) {
      if (!lines[index] || typeof lines[index] !== "object") continue;
      const line = { ...lines[index] };
      const n = Number(price);
      if (Number.isFinite(n) && n >= 0) {
        line.price = n;
        line.unit_price = n;
        line.unitPrice = n;
      }
      lines[index] = line;
    }
  }

  return {
    ...localOrder,
    [cartKey]: normalizeCartItemsBostaFields(lines),
  };
}

function normalizeCartItemsBostaFields(cartItems) {
  if (!Array.isArray(cartItems)) return cartItems;

  return cartItems.map((line) => {
    if (!line || typeof line !== "object") return line;

    const selectedSku = pickLineSelectedBostaSku(line);
    const variant =
      line.variant && typeof line.variant === "object"
        ? { ...line.variant }
        : {};
    const bostaName = String(
      line.bosta_name ??
        line.bostaName ??
        variant.bosta_name ??
        variant.bostaName ??
        variant.name ??
        "",
    ).trim();

    if (!selectedSku && !bostaName) return line;

    const out = { ...line, variant };
    if (selectedSku) {
      out.bosta_sku = selectedSku;
      out.bostaSku = selectedSku;
      variant.sku = selectedSku;
      variant.bosta_sku = selectedSku;
    }
    if (bostaName) {
      out.bosta_name = bostaName;
      out.bostaName = bostaName;
      if (!variant.name) variant.name = bostaName;
    }
    out.variant = variant;
    return out;
  });
}

function resolveLineSkuForBosta(line, maps, inventoryMap, requiredQty) {
  const requiredQuantity = Math.max(1, Number(requiredQty) || 1);
  const resolved = resolveMappedSkuCandidatesForLine(line, maps);
  const userSku = pickLineSelectedBostaSku(line);

  if (userSku) {
    const candidateSkus = normalizeSkus(resolved.skus);
    if (candidateSkus.length && !candidateSkus.includes(userSku)) {
      return {
        ok: false,
        reason: "invalid_selected_sku",
        productName: resolved.productName,
        requiredQuantity,
        selectedSku: userSku,
        candidateSkus,
        mappingType: resolved.mappingType,
        entityId: resolved.entityId,
      };
    }

    const availableQuantity = Number(inventoryMap.get(userSku) || 0);
    if (availableQuantity < requiredQuantity) {
      return {
        ok: false,
        reason: "out_of_stock",
        productName: resolved.productName,
        requiredQuantity,
        selectedSku: userSku,
        candidateSkus: candidateSkus.length ? candidateSkus : [userSku],
        availableQuantity,
        mappingType: resolved.mappingType,
        entityId: resolved.entityId,
      };
    }

    return {
      ok: true,
      skuCode: userSku,
      availableQuantity,
      productName: resolved.productName,
      requiredQuantity,
      source: "user_selected",
      mappingType: resolved.mappingType,
      entityId: resolved.entityId,
    };
  }

  if (!resolved.skus.length) {
    return {
      ok: false,
      reason: "no_sku_mapping",
      productName: resolved.productName,
      requiredQuantity,
      candidateSkus: [],
      availableQuantity: 0,
      mappingType: resolved.mappingType,
      entityId: resolved.entityId,
    };
  }

  const picked = pickAvailableSkuFromCandidates(
    resolved.skus,
    requiredQuantity,
    inventoryMap,
  );

  if (!picked) {
    return {
      ok: false,
      reason: "out_of_stock",
      productName: resolved.productName,
      requiredQuantity,
      candidateSkus: resolved.skus,
      availableQuantity: Math.max(
        ...resolved.skus.map((sku) => Number(inventoryMap.get(sku) || 0)),
        0,
      ),
      mappingType: resolved.mappingType,
      entityId: resolved.entityId,
    };
  }

  return {
    ok: true,
    skuCode: picked.skuCode,
    availableQuantity: picked.availableQuantity,
    productName: resolved.productName,
    requiredQuantity,
    source: "auto_inventory",
    mappingType: resolved.mappingType,
    entityId: resolved.entityId,
  };
}

function normalizeSizeKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const digits = raw.match(/\d+/);
  return digits ? digits[0] : raw;
}

function lookupMapEntryByIdOrName(mapObj, productId, name) {
  const ids = productIdLookupCandidates(productId);
  for (const id of ids) {
    if (id && mapObj[id]) {
      return { entityId: id, entry: mapObj[id] };
    }
  }

  if (!canonicalProductNameKey(name)) return null;
  for (const [entityId, entry] of Object.entries(mapObj || {})) {
    if (productNamesMatch(entry?.name, name)) {
      return { entityId, entry };
    }
  }
  return null;
}

function resolveMappedSkuCandidatesForLine(line, maps) {
  const variantId = pickLineVariantId(line);
  const productId = pickLineProductId(line);
  const size = pickLineSize(line);
  const normalizedSize = normalizeSizeKey(size);
  const displayName = pickLineDisplayName(line);

  if (variantId && maps.variantSkuMap[variantId]) {
    const entry = maps.variantSkuMap[variantId];
    return {
      productName: pickLineDisplayName(line, entry.name),
      skus: normalizeSkus(entry.skus),
      mappingType: "variant",
      entityId: variantId,
    };
  }

  const sizeMatch = lookupMapEntryByIdOrName(
    maps.sizeSkuMap,
    productId,
    displayName,
  );
  if (sizeMatch) {
    const entry = sizeMatch.entry;
    const sizes = entry.sizes || {};

    if (normalizedSize && sizes[normalizedSize]) {
      return {
        productName: pickLineDisplayName(line, entry.name),
        skus: normalizeSkus(sizes[normalizedSize]),
        mappingType: "size",
        entityId: sizeMatch.entityId,
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
            entityId: sizeMatch.entityId,
            size: sizeKey,
          };
        }
      }
    }
  }

  const productMatch = lookupMapEntryByIdOrName(
    maps.productSkuMap,
    productId,
    displayName,
  );
  if (productMatch) {
    const entry = productMatch.entry;
    return {
      productName: pickLineDisplayName(line, entry.name),
      skus: normalizeSkus(entry.skus),
      mappingType: "product",
      entityId: productMatch.entityId,
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
  const hasInvalidSku = unavailableProducts.some(
    (p) => p.reason === "invalid_selected_sku",
  );
  const messageAr = hasInvalidSku
    ? `الـ SKU المختار غير صالح للمنتج (${names.join("، ")})`
    : names.length === 1
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

  const lineResult = resolveLineSkuForBosta(
    line,
    data,
    inventory,
    requiredQty,
  );

  if (!lineResult.ok) {
    throw buildInventoryUnavailableError([
      {
        productName: lineResult.productName,
        requiredQuantity: lineResult.requiredQuantity,
        candidateSkus: lineResult.candidateSkus || [],
        availableQuantity: lineResult.availableQuantity ?? 0,
        selectedSku: lineResult.selectedSku || null,
        mappingType: lineResult.mappingType,
        entityId: lineResult.entityId,
        reason: lineResult.reason,
      },
    ]);
  }

  return lineResult.skuCode;
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
    const lineResult = resolveLineSkuForBosta(line, maps, inventoryMap, requiredQty);

    if (!lineResult.ok) {
      unavailableProducts.push({
        productName: lineResult.productName,
        requiredQuantity: lineResult.requiredQuantity,
        candidateSkus: lineResult.candidateSkus || [],
        availableQuantity: lineResult.availableQuantity ?? 0,
        selectedSku: lineResult.selectedSku || null,
        mappingType: lineResult.mappingType,
        entityId: lineResult.entityId,
        reason: lineResult.reason,
      });
      continue;
    }

    items.push({
      lineIndex: index,
      skuCode: lineResult.skuCode,
      availableQuantity: lineResult.availableQuantity,
      productName: lineResult.productName,
      requiredQuantity: lineResult.requiredQuantity,
      source: lineResult.source,
    });
  }

  if (unavailableProducts.length) {
    throw buildInventoryUnavailableError(unavailableProducts);
  }

  return { items, inventoryMap, maps };
}

function buildSkusWithInventory(skus, inventoryDetailsMap, requiredQuantity = 1) {
  const qtyNeeded = Math.max(1, Number(requiredQuantity) || 1);
  return normalizeSkus(skus).map((skuCode) => {
    const info = inventoryDetailsMap.get(skuCode);
    const availableQuantity = Number(info?.availableQuantity || 0);
    return {
      skuCode,
      name: info?.name || "",
      availableQuantity,
      inStock: availableQuantity >= qtyNeeded,
    };
  });
}

function pickRecommendedSku(skusWithInventory, requiredQuantity = 1) {
  const qtyNeeded = Math.max(1, Number(requiredQuantity) || 1);
  for (const item of skusWithInventory) {
    if (item.availableQuantity >= qtyNeeded) {
      return item;
    }
  }
  return null;
}

function buildOptionBase(row, inventoryDetailsMap, requiredQuantity, extra = {}) {
  const mappingName = String(row.name || "").trim();
  const skus = buildSkusWithInventory(row.skus, inventoryDetailsMap, requiredQuantity);
  const recommended = pickRecommendedSku(skus, requiredQuantity);
  return {
    mappingType: row.mapping_type,
    entityId: row.entity_id,
    productId: row.product_id || row.entity_id,
    name: mappingName,
    label: mappingName,
    size: row.size || null,
    skus,
    recommendedSku: recommended?.skuCode ?? null,
    recommendedName: recommended?.name ?? null,
    recommendedAvailableQuantity: recommended?.availableQuantity ?? 0,
    inStock: Boolean(recommended),
    ...extra,
  };
}

function buildOptionsFromSizeRow(row, inventoryDetailsMap, requiredQuantity) {
  const sizes = normalizeSizes(row.sizes) || {};
  const baseName = String(row.name || "").trim();
  return Object.entries(sizes).map(([sizeKey, skus]) => {
    const mappingName = `${baseName}${sizeKey ? ` - ${sizeKey}` : ""}`.trim();
    const skusWithInventory = buildSkusWithInventory(
      skus,
      inventoryDetailsMap,
      requiredQuantity,
    );
    const recommended = pickRecommendedSku(skusWithInventory, requiredQuantity);
    return {
      mappingType: "size",
      entityId: row.entity_id,
      productId: row.entity_id,
      name: mappingName,
      label: mappingName,
      size: sizeKey,
      skus: skusWithInventory,
      recommendedSku: recommended?.skuCode ?? null,
      recommendedName: recommended?.name ?? null,
      recommendedAvailableQuantity: recommended?.availableQuantity ?? 0,
      inStock: Boolean(recommended),
    };
  });
}

async function resolveMappingProductIds(productId) {
  return resolveCatalogTwinIds(productId);
}

async function fetchMappingRowsForProduct(productId) {
  const ids = await resolveMappingProductIds(productId);
  if (!ids.length) {
    return { products: [], variants: [], sizes: [], unmapped: null };
  }

  const [productRes, variantRes, sizeRes, unmappedRes] = await Promise.all([
    supabase
      .from(MAPPINGS_TABLE)
      .select("*")
      .eq("mapping_type", "product")
      .in("entity_id", ids),
    supabase
      .from(MAPPINGS_TABLE)
      .select("*")
      .eq("mapping_type", "variant")
      .in("product_id", ids)
      .order("name", { ascending: true }),
    supabase
      .from(MAPPINGS_TABLE)
      .select("*")
      .eq("mapping_type", "size")
      .in("entity_id", ids),
    supabase.from(UNMAPPED_TABLE).select("*").in("product_id", ids),
  ]);

  for (const res of [productRes, variantRes, sizeRes, unmappedRes]) {
    if (res.error) {
      throw new Error(res.error.message);
    }
  }

  return {
    products: productRes.data || [],
    variants: variantRes.data || [],
    sizes: sizeRes.data || [],
    unmapped: (unmappedRes.data || [])[0] || null,
  };
}

/**
 * Product id (EasyOrder) → Bosta mapping options + live inventory per sku.
 * User picks variant/option and optional skuCode when sending to Bosta.
 */
async function getBostaSkuOptionsForProduct(productId, options = {}) {
  const id = String(productId || "").trim();
  if (!id) {
    const err = new Error("productId is required");
    err.code = "INVALID_PRODUCT_ID";
    throw err;
  }

  const requiredQuantity = Math.max(1, Number(options.requiredQuantity) || 1);
  const rows = await fetchMappingRowsForProduct(id);
  const { fetchBostaInventoryDetailsMap } = require("./bostaFulfillment.service");
  const inventoryDetailsMap = await fetchBostaInventoryDetailsMap();

  const mappingOptions = [];

  for (const product of rows.products) {
    mappingOptions.push(
      buildOptionBase(product, inventoryDetailsMap, requiredQuantity),
    );
  }

  for (const variant of rows.variants) {
    mappingOptions.push(
      buildOptionBase(variant, inventoryDetailsMap, requiredQuantity),
    );
  }

  for (const size of rows.sizes) {
    mappingOptions.push(
      ...buildOptionsFromSizeRow(size, inventoryDetailsMap, requiredQuantity),
    );
  }

  if (!mappingOptions.length) {
    const err = new Error(
      rows.unmapped
        ? "Product is marked as unmapped for Bosta"
        : "No Bosta SKU mapping found for this product",
    );
    err.code = rows.unmapped ? "PRODUCT_UNMAPPED" : "PRODUCT_NOT_MAPPED";
    err.productId = id;
    if (rows.unmapped) {
      err.unmapped = {
        productId: id,
        name: rows.unmapped.name || "",
        reason: rows.unmapped.reason || "",
      };
    }
    throw err;
  }

  mappingOptions.sort((a, b) => {
    if (a.inStock !== b.inStock) return Number(b.inStock) - Number(a.inStock);
    return String(a.label).localeCompare(String(b.label), "ar");
  });

  const productName =
    rows.products[0]?.name ||
    rows.variants[0]?.name?.split(" - ")[0] ||
    rows.sizes[0]?.name ||
    "";

  return {
    productId: id,
    productName,
    requiredQuantity,
    options: mappingOptions,
    summary: {
      totalOptions: mappingOptions.length,
      inStockOptions: mappingOptions.filter((o) => o.inStock).length,
      outOfStockOptions: mappingOptions.filter((o) => !o.inStock).length,
    },
  };
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
  getBostaSkuOptionsForProduct,
  pickLineSelectedBostaSku,
  parseLineSkuOverrides,
  applyLineSkuOverridesToOrder,
  normalizeCartItemsBostaFields,
  resolveMappedSkuCandidatesForLine,
  resolveMappedBostaSkuForLine,
  validateOrderLinesInventory,
  pickPrimarySku,
};
