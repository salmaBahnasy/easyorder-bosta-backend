const {
  receiveEasyConfirmWebhook,
  diagnoseEasyConfirmExternalOrderId,
  verifyEasyConfirmSignature,
} = require("../services/easyconfirm.service");

/**
 * POST /webhooks/easyconfirm
 *
 * Expects req.body as a Buffer from express.raw({ type: 'application/json' }).
 */
async function handleEasyConfirmWebhook(req, res) {
  try {
    const signatureHeader = req.headers["x-easyconfirm-signature"];
    const webhookSecret = process.env.EASYCONFIRM_WEBHOOK_SECRET;

    if (
      !signatureHeader ||
      !webhookSecret ||
      !verifyEasyConfirmSignature(
        req.body,
        String(signatureHeader),
        webhookSecret,
      ).ok
    ) {
      res.status(401).json({
        success: false,
        message: "Invalid signature",
      });
      return;
    }

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(req.body || "");

    let parsed;
    try {
      const text = rawBody.toString("utf8");
      parsed = JSON.parse(text);
    } catch {
      res.status(400).json({
        success: false,
        message: "Invalid JSON",
      });
      return;
    }

    await receiveEasyConfirmWebhook({
      headers: req.headers,
      body: parsed,
      rawBody,
      signatureVerified: true,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error(
      JSON.stringify({
        source: "easyconfirm-webhook",
        timestamp: new Date().toISOString(),
        level: "error",
        message: error?.message || "Unknown EasyConfirm webhook error",
      }),
    );

    res.status(500).json({
      success: false,
      message: "Failed to process EasyConfirm webhook",
    });
  }
}

/**
 * Temporary diagnostic:
 * GET /webhooks/easyconfirm/debug/:externalOrderId
 */
async function handleEasyConfirmDebug(req, res) {
  try {
    const externalOrderId =
      req.params.externalOrderId ||
      req.query.externalOrderId ||
      req.query.external_order_id;
    const result = await diagnoseEasyConfirmExternalOrderId(externalOrderId);
    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
}

module.exports = {
  handleEasyConfirmWebhook,
  handleEasyConfirmDebug,
};
