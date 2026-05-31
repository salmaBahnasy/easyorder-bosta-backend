const {
  fetchSallaOrders,
  verifySallaLogin,
  fetchAllSallaOrdersForStats,
  computeStatsFromSallaOrders,
} = require("../services/salla.service");

/**
 * POST /api/salla/auth/login
 * Optional body: { "access_token": "..." } to test a token; otherwise uses SALLA_ACCESS_TOKEN from env.
 */
async function sallaAuthLogin(req, res) {
  try {
    const override =
      req.body &&
      typeof req.body === "object" &&
      !Array.isArray(req.body) &&
      typeof req.body.access_token === "string"
        ? req.body.access_token.trim()
        : null;

    await verifySallaLogin(override || undefined);

    res.json({
      success: true,
      message: "Salla authentication OK",
    });
  } catch (error) {
    if (error.code === "MISSING_SALLA_TOKEN") {
      res.status(400).json({
        success: false,
        message: error.message,
        code: error.code,
      });
      return;
    }
    if (error.code === "SALLA_HTTP_ERROR") {
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
      message: "Salla login check failed",
      error: error.message,
    });
  }
}

/**
 * GET /api/salla/orders — proxies to Salla GET .../orders with query string.
 */
async function sallaGetOrders(req, res) {
  try {
    const data = await fetchSallaOrders(req.query || {});
    res.json({
      success: true,
      data,
    });
  } catch (error) {
    if (error.code === "MISSING_SALLA_TOKEN") {
      res.status(400).json({
        success: false,
        message: error.message,
        code: error.code,
      });
      return;
    }
    if (error.code === "SALLA_HTTP_ERROR") {
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
      message: "Failed to fetch Salla orders",
      error: error.message,
    });
  }
}

/**
 * GET /api/salla/stats — aggregates from Salla orders only.
 */
async function sallaGetStats(req, res) {
  try {
    const orders = await fetchAllSallaOrdersForStats();
    const stats = computeStatsFromSallaOrders(orders);
    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    if (error.code === "MISSING_SALLA_TOKEN") {
      res.status(400).json({
        success: false,
        message: error.message,
        code: error.code,
      });
      return;
    }
    if (error.code === "SALLA_HTTP_ERROR") {
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
      message: "Failed to compute Salla stats",
      error: error.message,
    });
  }
}

module.exports = {
  sallaAuthLogin,
  sallaGetOrders,
  sallaGetStats,
};
