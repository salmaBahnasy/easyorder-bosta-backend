const express = require("express");
const router = express.Router();

const {
  handleEasyConfirmWebhook,
} = require("../controllers/easyconfirm.controller");

/**
 * EasyConfirm WhatsApp confirmation / cancellation webhooks.
 * Mounted at /webhooks — fully isolated from EasyOrders / Bosta webhook handlers.
 *
 * POST /webhooks/easyconfirm
 */
router.post("/easyconfirm", handleEasyConfirmWebhook);

module.exports = router;
