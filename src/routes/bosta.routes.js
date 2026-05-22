const express = require("express");

const {
  syncLocations,
  listCities,
  listDistricts,
} = require("../controllers/bostaLocations.controller");

const router = express.Router();

/** Pull cities + districts from Bosta API v2 and upsert into Supabase (same Bosta ids). */
router.post("/locations/sync", syncLocations);

/** Governorates (cities) — same shape as Bosta GET /v2/cities, from our DB. */
router.get("/cities", listCities);

/** Districts for a city — same shape as Bosta GET /v2/cities/:cityId/districts, from our DB. */
router.get("/cities/:cityId/districts", listDistricts);

module.exports = router;
