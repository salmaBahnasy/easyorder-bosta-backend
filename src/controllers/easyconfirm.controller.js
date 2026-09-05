const {
  receiveEasyConfirmWebhook,
} = require("../services/easyconfirm.service");

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
        level: "error",
        message: error?.message || "Unknown EasyConfirm webhook error",
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
