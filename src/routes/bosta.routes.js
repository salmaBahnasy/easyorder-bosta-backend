const express = require("express");

const {
  syncLocations,
  listCities,
  listDistricts,
  listZones,
} = require("../controllers/bostaLocations.controller");
const {
  listBostaSkuMappings,
  getBostaSkuMappingHandler,
  addBostaSkuMappingHandler,
  updateBostaSkuMappingHandler,
  importBostaSkuMappingsHandler,
} = require("../controllers/bostaSkuMappings.controller");
const { requireAuth } = require("../middlewares/auth.middleware");

const router = express.Router();

/** SKU mappings: product / variant / size → Bosta sku codes */
router.get("/sku-mappings", listBostaSkuMappings);
router.get("/sku-mappings/:mappingType/:entityId", getBostaSkuMappingHandler);
router.post("/sku-mappings/import", requireAuth, importBostaSkuMappingsHandler);
router.post("/sku-mappings", requireAuth, addBostaSkuMappingHandler);
router.patch(
  "/sku-mappings/:mappingType/:entityId",
  requireAuth,
  updateBostaSkuMappingHandler,
);

/** Pull cities + districts from Bosta API v2 and upsert into Supabase (same Bosta ids). */
router.post("/locations/sync", syncLocations);
router.get("/locations/sync", (req, res) => {
  res.status(405).json({
    success: false,
    message:
      "Sync requires POST (not GET). In Postman set method to POST, then send again.",
    useMethod: "POST",
    paths: [
      "/api/bosta/locations/sync",
      "/api/easyorder/bosta/locations/sync",
    ],
  });
});

/** Governorates (cities) — optional ?q= or ?search= (Arabic/English name, alias, code). */
router.get("/cities", listCities);

/** Districts for a city — optional ?q= or ?search= (district/zone names AR/EN). */
router.get("/cities/:cityId/districts", listDistricts);

/** Zones grouped with districts (districtId on each item) — optional ?q= */
router.get("/cities/:cityId/zones", listZones);

module.exports = router;
