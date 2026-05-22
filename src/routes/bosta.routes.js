const express = require("express");

const {
  syncLocations,
  listCities,
  listDistricts,
} = require("../controllers/bostaLocations.controller");

const router = express.Router();

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

/** Governorates (cities) — same shape as Bosta GET /v2/cities, from our DB. */
router.get("/cities", listCities);

/** Districts for a city — same shape as Bosta GET /v2/cities/:cityId/districts, from our DB. */
router.get("/cities/:cityId/districts", listDistricts);

module.exports = router;
