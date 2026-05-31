const express = require("express");

const {
  sallaAuthLogin,
  sallaGetOrders,
  sallaGetStats,
} = require("../controllers/salla.controller");

function sallaLoginMethodNotAllowed(req, res) {
  res.status(405).json({
    success: false,
    message: "Use POST with optional JSON body { access_token } or set SALLA_ACCESS_TOKEN in env.",
    allow: "POST",
    paths: ["/api/salla/auth/login", "/api/salla/login"],
  });
}

const router = express.Router();

router.post("/auth/login", sallaAuthLogin);
/** Alias if the client calls POST /api/salla/login (same handler). */
router.post("/login", sallaAuthLogin);
router.get("/auth/login", sallaLoginMethodNotAllowed);
router.get("/login", sallaLoginMethodNotAllowed);
router.get("/orders", sallaGetOrders);
router.get("/stats", sallaGetStats);

module.exports = router;
