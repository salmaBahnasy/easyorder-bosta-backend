/**
 * EasyConfirm webhook payload (WhatsApp order confirmation / cancellation).
 *
 * Known events:
 * - order.confirmed — customer taps Approve on WhatsApp
 * - order.canceled  — customer taps Cancel on WhatsApp (or canceled via API)
 *
 * EasyConfirm may send additional fields later, so unknown keys are kept.
 *
 * Future use:
 * - Sync WhatsApp confirmation with ERP customer_status (implemented)
 * - Optionally drive employee workflow from customer confirmation
 *
 * @typedef {Object} EasyConfirmWebhookItem
 * @property {string} [id]
 * @property {string} [productName]
 * @property {string} [variantName]
 * @property {number} [quantity]
 * @property {number} [unitPrice]
 * @property {number} [totalPrice]
 *
 * @typedef {Object} EasyConfirmWebhookOrderData
 * @property {string} [id] - EasyConfirm order UUID
 * @property {string} [externalOrderId] - Merchant / EasyOrders reference (e.g. "EO-12345")
 * @property {string} [status] - e.g. "confirmed" | "canceled"
 * @property {string} [customerAction] - e.g. "approved" | "canceled"
 * @property {string} [deliveryStatus] - WhatsApp delivery state, e.g. "read"
 * @property {string} [customerName]
 * @property {string} [customerPhone]
 * @property {string} [customerAddress]
 * @property {number} [subtotal]
 * @property {number} [shippingCost]
 * @property {number} [totalCost]
 * @property {string} [currency]
 * @property {string|null} [failureReason]
 * @property {string|null} [errorCode]
 * @property {EasyConfirmWebhookItem[]} [items]
 * @property {string} [createdAt]
 * @property {string} [updatedAt]
 *
 * @typedef {Object} EasyConfirmWebhookPayload
 * @property {"order.confirmed"|"order.canceled"|string} [event]
 * @property {string} [timestamp] - Event ISO timestamp
 * @property {EasyConfirmWebhookOrderData} [data]
 */

/**
 * Normalize / pass through the raw webhook body.
 * Keeps unknown fields intact for logging and future mapping.
 *
 * @param {EasyConfirmWebhookPayload|Object|null|undefined} body
 * @returns {EasyConfirmWebhookPayload}
 */
function toEasyConfirmWebhookPayload(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  return { ...body };
}

module.exports = {
  toEasyConfirmWebhookPayload,
};
