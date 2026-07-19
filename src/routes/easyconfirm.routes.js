const express = require("express");
const router = express.Router();

const {
  handleEasyConfirmDebug,
} = require("../controllers/easyconfirm.controller");

/**
 * EasyConfirm diagnostic GETs (JSON-parsed routes).
 * POST /webhooks/easyconfirm is registered in server.js with express.raw
 * BEFORE express.json().
 */
router.get("/easyconfirm/debug/:externalOrderId", handleEasyConfirmDebug);
router.get("/easyconfirm/debug", handleEasyConfirmDebug);

module.exports = router;
