const {
  receiveEasyConfirmWebhook,
} = require("../services/easyconfirm.service");

/**
 * POST /webhooks/easyconfirm
 *
 * EasyConfirm WhatsApp confirmation / cancellation / failure callbacks.
 * Always acknowledges with 2xx when the payload is accepted (except invalid signature).
 */
async function handleEasyConfirmWebhook(req, res) {
  try {
    const result = await receiveEasyConfirmWebhook({
      headers: req.headers,
      body: req.body,
      rawBody: req.rawBody,
    });

    res.status(200).json({
      success: true,
      duplicate: Boolean(result.duplicate),
      ...(result.eventId ? { eventId: result.eventId } : {}),
      ...(result.warning ? { warning: result.warning } : {}),
      ...(result.order
        ? {
            data: {
              sourceOrderId: result.order.sourceOrderId,
              confirmation_status:
                result.order.confirmation_status ??
                result.order.confirmationStatus ??
                null,
              customer_status: result.order.customer_status,
              customerStatus: result.order.customerStatus,
              confirmation_source:
                result.order.confirmation_source ?? "easyconfirm",
              confirmation_updated_at:
                result.order.confirmation_updated_at ?? null,
            },
          }
        : {}),
    });
  } catch (error) {
    if (error.code === "EASYCONFIRM_INVALID_SIGNATURE") {
      console.warn(
        JSON.stringify({
          source: "easyconfirm-webhook",
          timestamp: new Date().toISOString(),
          level: "warn",
          message: error.message,
        }),
      );
      res.status(401).json({
        success: false,
        message: error.message || "Invalid signature",
      });
      return;
    }

    console.error(
      JSON.stringify({
        source: "easyconfirm-webhook",
        timestamp: new Date().toISOString(),
        level: "error",
        message: error?.message || "Unknown EasyConfirm webhook error",
        stack: error?.stack,
      }),
    );

    // Still prefer 200 for unexpected processing errors so EasyConfirm does not
    // hammer retries — except we already returned 401 for bad signatures.
    // For hard failures, return 500 so they can retry.
    res.status(500).json({
      success: false,
      message: "Failed to process EasyConfirm webhook",
      error: error?.message || "Unknown error",
    });
  }
}

module.exports = {
  handleEasyConfirmWebhook,
};
