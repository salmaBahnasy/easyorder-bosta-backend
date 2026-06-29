const {
  MAPPING_TYPES,
  getBostaSkuMappings,
  getBostaSkuMapping,
  addBostaSkuMapping,
  updateBostaSkuMapping,
  deleteBostaSkuMapping,
  deleteUnmappedProduct,
  importBostaSkuMappings,
  getBostaSkuOptionsForProduct,
} = require("../services/bostaSkuMappings.service");

function mapRowResponse(row) {
  if (!row) return null;
  if (row.mapping_type === "product") {
    return {
      mappingType: "product",
      entityId: row.entity_id,
      name: row.name,
      skus: row.skus || [],
    };
  }
  if (row.mapping_type === "variant") {
    return {
      mappingType: "variant",
      entityId: row.entity_id,
      productId: row.product_id,
      name: row.name,
      size: row.size,
      skus: row.skus || [],
    };
  }
  return {
    mappingType: "size",
    entityId: row.entity_id,
    name: row.name,
    sizes: row.sizes || {},
  };
}

async function listBostaSkuMappings(req, res) {
  try {
    const data = await getBostaSkuMappings();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch Bosta SKU mappings",
      error: error.message,
    });
  }
}

async function getBostaSkuMappingHandler(req, res) {
  try {
    const { mappingType, entityId } = req.params;
    const row = await getBostaSkuMapping(mappingType, entityId);
    res.json({ success: true, data: mapRowResponse(row) });
  } catch (error) {
    if (
      error.code === "INVALID_MAPPING_TYPE" ||
      error.code === "INVALID_ENTITY_ID"
    ) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    if (error.code === "MAPPING_NOT_FOUND") {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to fetch Bosta SKU mapping",
      error: error.message,
    });
  }
}

async function addBostaSkuMappingHandler(req, res) {
  try {
    const row = await addBostaSkuMapping(req.body || {});
    res.status(201).json({
      success: true,
      message: "Bosta SKU mapping created",
      data: mapRowResponse(row),
    });
  } catch (error) {
    if (
      error.code === "INVALID_MAPPING_TYPE" ||
      error.code === "INVALID_ENTITY_ID" ||
      error.code === "INVALID_NAME" ||
      error.code === "INVALID_SKUS" ||
      error.code === "INVALID_SIZES" ||
      error.code === "INVALID_PRODUCT_ID"
    ) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    if (error.code === "MAPPING_EXISTS") {
      res.status(409).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to create Bosta SKU mapping",
      error: error.message,
    });
  }
}

async function updateBostaSkuMappingHandler(req, res) {
  try {
    const { mappingType, entityId } = req.params;
    const row = await updateBostaSkuMapping(
      mappingType,
      entityId,
      req.body || {},
    );
    res.json({
      success: true,
      message: "Bosta SKU mapping updated",
      data: mapRowResponse(row),
    });
  } catch (error) {
    if (
      error.code === "INVALID_MAPPING_TYPE" ||
      error.code === "INVALID_ENTITY_ID" ||
      error.code === "INVALID_UPDATES"
    ) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    if (error.code === "MAPPING_NOT_FOUND") {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to update Bosta SKU mapping",
      error: error.message,
    });
  }
}

async function deleteBostaSkuMappingHandler(req, res) {
  try {
    const { mappingType, entityId } = req.params;
    const result = await deleteBostaSkuMapping(mappingType, entityId);
    res.json({
      success: true,
      message: "Bosta SKU mapping deleted",
      data: result,
    });
  } catch (error) {
    if (
      error.code === "INVALID_MAPPING_TYPE" ||
      error.code === "INVALID_ENTITY_ID"
    ) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    if (error.code === "MAPPING_NOT_FOUND") {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to delete Bosta SKU mapping",
      error: error.message,
    });
  }
}

async function deleteUnmappedProductHandler(req, res) {
  try {
    const productId = req.params.productId ?? req.params.entityId;
    const result = await deleteUnmappedProduct(productId);
    res.json({
      success: true,
      message: "Unmapped product removed",
      data: result,
    });
  } catch (error) {
    if (error.code === "INVALID_ENTITY_ID") {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    if (error.code === "MAPPING_NOT_FOUND") {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to delete unmapped product",
      error: error.message,
    });
  }
}

async function getBostaSkuOptionsByProductHandler(req, res) {
  try {
    const productId =
      req.params.productId ??
      req.params.product_id ??
      req.query.product_id ??
      req.query.productId;

    const quantityRaw = req.query.quantity ?? req.query.qty;
    const requiredQuantity =
      quantityRaw != null && String(quantityRaw).trim() !== ""
        ? Number(quantityRaw)
        : 1;

    const data = await getBostaSkuOptionsForProduct(productId, {
      requiredQuantity,
    });

    res.json({ success: true, data });
  } catch (error) {
    if (error.code === "INVALID_PRODUCT_ID") {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    if (
      error.code === "PRODUCT_NOT_MAPPED" ||
      error.code === "PRODUCT_UNMAPPED"
    ) {
      res.status(404).json({
        success: false,
        message: error.message,
        code: error.code,
        productId: error.productId,
        unmapped: error.unmapped || null,
      });
      return;
    }
    if (error.code === "BOSTA_API_KEY_MISSING" || error.code === "BOSTA_FULFILLMENT_API_KEY_MISSING") {
      res.status(400).json({
        success: false,
        message: error.message,
        code: error.code,
      });
      return;
    }
    if (error.code === "BOSTA_API_ERROR") {
      res.status(error.status || 502).json({
        success: false,
        message: error.message,
        code: error.code,
        details: error.details || null,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to fetch Bosta SKU options for product",
      error: error.message,
    });
  }
}

async function importBostaSkuMappingsHandler(req, res) {
  try {
    const data = await importBostaSkuMappings(req.body || {});
    res.json({
      success: true,
      message: "Bosta SKU mappings imported",
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to import Bosta SKU mappings",
      error: error.message,
    });
  }
}

module.exports = {
  MAPPING_TYPES,
  listBostaSkuMappings,
  getBostaSkuMappingHandler,
  getBostaSkuOptionsByProductHandler,
  addBostaSkuMappingHandler,
  updateBostaSkuMappingHandler,
  deleteBostaSkuMappingHandler,
  deleteUnmappedProductHandler,
  importBostaSkuMappingsHandler,
};
