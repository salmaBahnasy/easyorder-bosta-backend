const {
  toEasyConfirmWebhookPayload,
} = require("../dto/easyconfirmWebhook.dto");
const {
  applyEasyConfirmCustomerStatus,
} = require("./webhookOrders.service");

/**
 * EasyConfirm webhook service.
 *
 * Handles WhatsApp confirmation / cancellation callbacks:
 * - Logs the full request for inspection
 * - Persists customer_status (حالة العميل) on the matching ERP order
 *
 * Does NOT change ERP order status (حالة الطلب) — that stays employee-driven.
 */

/**
 * Receive EasyConfirm webhook: log + update customer_status.
 *
 * @param {Object} params
 * @param {Object} params.headers - Incoming HTTP headers
 * @param {Object} [params.body] - Raw JSON body from EasyConfirm
 * @returns {Promise<{ receivedAt: string, payload: Object, order: Object|null, warning?: string }>}
 */
async function receiveEasyConfirmWebhook({ headers, body }) {
  const receivedAt = new Date().toISOString();
  const payload = toEasyConfirmWebhookPayload(body);

  console.log(
    JSON.stringify(
      {
        source: "easyconfirm-webhook",
        timestamp: receivedAt,
        headers: headers || {},
        body: payload,
      },
      null,
      2,
    ),
  );

  try {
    const order = await applyEasyConfirmCustomerStatus(payload);
    return {
      receivedAt,
      payload,
      order,
    };
  } catch (error) {
    if (error.code === "ORDER_NOT_FOUND") {
      console.warn(
        JSON.stringify({
          source: "easyconfirm-webhook",
          timestamp: new Date().toISOString(),
          level: "warn",
          message: "Order not found for EasyConfirm payload",
          event: payload?.event ?? null,
          externalOrderId:
            payload?.data?.externalOrderId ??
            payload?.data?.external_order_id ??
            payload?.externalOrderId ??
            null,
          orderId: payload?.data?.orderId ?? payload?.orderId ?? null,
          shortId:
            payload?.data?.short_id ??
            payload?.data?.shortId ??
            payload?.short_id ??
            null,
          easyconfirmId: payload?.data?.id ?? payload?.id ?? null,
        }),
      );
      return {
        receivedAt,
        payload,
        order: null,
        warning: "Order not found",
      };
    }

    if (error.code === "INVALID_CUSTOMER_STATUS") {
      console.warn(
        JSON.stringify({
          source: "easyconfirm-webhook",
          timestamp: new Date().toISOString(),
          level: "warn",
          message: error.message,
          event: payload?.event ?? null,
        }),
      );
      return {
        receivedAt,
        payload,
        order: null,
        warning: error.message,
      };
    }

    throw error;
  }
}

module.exports = {
  receiveEasyConfirmWebhook,
};
