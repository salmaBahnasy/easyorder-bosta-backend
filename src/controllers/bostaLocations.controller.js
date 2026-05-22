const {
  syncBostaLocationsFromApi,
  getCitiesFromDb,
  getDistrictsFromDb,
} = require("../services/bostaLocations.service");

async function syncLocations(req, res) {
  try {
    const result = await syncBostaLocationsFromApi();
    res.json({
      success: true,
      message: "Bosta cities and districts synced to database",
      data: result,
    });
  } catch (error) {
    if (error.code === "BOSTA_LOCATIONS_NOT_CONFIGURED") {
      res.status(503).json({
        success: false,
        message: "Bosta locations tables are not set up in Supabase",
        code: error.code,
        error: error.message,
        setupHint: error.setupHint,
      });
      return;
    }
    if (error.code === "BOSTA_HTTP_ERROR") {
      res.status(error.status >= 400 && error.status < 600 ? error.status : 502).json({
        success: false,
        message: error.message,
        code: error.code,
        details: error.details,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to sync Bosta locations",
      error: error.message,
    });
  }
}

async function listCities(req, res) {
  try {
    const payload = await getCitiesFromDb();
    res.json(payload);
  } catch (error) {
    if (error.code === "BOSTA_LOCATIONS_NOT_CONFIGURED") {
      res.status(503).json({
        success: false,
        message: "Bosta locations tables are not set up in Supabase",
        code: error.code,
        error: error.message,
        setupHint: error.setupHint,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to fetch cities",
      error: error.message,
    });
  }
}

async function listDistricts(req, res) {
  try {
    const { cityId } = req.params;
    const payload = await getDistrictsFromDb(cityId);
    res.json(payload);
  } catch (error) {
    if (error.code === "INVALID_CITY_ID") {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error.code === "BOSTA_LOCATIONS_NOT_CONFIGURED") {
      res.status(503).json({
        success: false,
        message: "Bosta locations tables are not set up in Supabase",
        code: error.code,
        error: error.message,
        setupHint: error.setupHint,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to fetch districts",
      error: error.message,
    });
  }
}

module.exports = {
  syncLocations,
  listCities,
  listDistricts,
};
