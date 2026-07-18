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

function pickEasyConfirmEventHeader(headers = {}) {
  if (!headers || typeof headers !== "object") return "";
  return (
    headers["x-easyconfirm-event"] ||
    headers["X-EasyConfirm-Event"] ||
    headers["x-easyconfirm-event".toLowerCase()] ||
    ""
  );
}

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
  const eventHeader = String(pickEasyConfirmEventHeader(headers) || "").trim();

  // Prefer body.event; fall back to X-EasyConfirm-Event header
  if (!payload.event && eventHeader) {
    payload.event = eventHeader;
  }

  console.log(
    JSON.stringify(
      {
        source: "easyconfirm-webhook",
        timestamp: receivedAt,
        event: payload.event || eventHeader || null,
        headers: headers || {},
        body: payload,
      },
      null,
      2,
    ),
  );

  try {
    const order = await applyEasyConfirmCustomerStatus(payload, {
      eventHeader,
    });
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
          event: payload?.event || eventHeader || null,
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
          event: payload?.event || eventHeader || null,
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
  pickEasyConfirmEventHeader,
};
