const {
  receiveEasyConfirmWebhook,
} = require("../services/easyconfirm.service");

/**
 * POST /webhooks/easyconfirm
 *
 * EasyConfirm calls this when a customer confirms or cancels an order via WhatsApp.
 *
 * - Logs headers + body
 * - Updates customer_status (حالة العميل) on the matched order
 * - Returns 200 immediately (even if order was not found — logged as warning)
 */
async function handleEasyConfirmWebhook(req, res) {
  try {
    const result = await receiveEasyConfirmWebhook({
      headers: req.headers,
      body: req.body,
    });

    res.status(200).json({
      success: true,
      ...(result.warning ? { warning: result.warning } : {}),
      ...(result.order
        ? {
            data: {
              sourceOrderId: result.order.sourceOrderId,
              customer_status: result.order.customer_status,
              customerStatus: result.order.customerStatus,
            },
          }
        : {}),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        source: "easyconfirm-webhook",
        timestamp: new Date().toISOString(),
        level: "error",
        message: error?.message || "Unknown EasyConfirm webhook error",
        stack: error?.stack,
      }),
    );

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
