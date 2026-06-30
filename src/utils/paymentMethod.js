const PAYMENT_METHOD_COD = "cod";
const PAYMENT_METHOD_INSTAPAY = "instapay";

function normalizePaymentMethodKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

/** يقبل cod / COD و instapay / Instapay ويخزّن cod أو instapay */
function normalizePaymentMethod(value) {
  const key = normalizePaymentMethodKey(value);
  if (!key) return "";
  if (key === PAYMENT_METHOD_INSTAPAY) return PAYMENT_METHOD_INSTAPAY;
  if (key === PAYMENT_METHOD_COD) return PAYMENT_METHOD_COD;
  return String(value).trim();
}

function isInstapayPaymentMethod(value) {
  return normalizePaymentMethodKey(value) === PAYMENT_METHOD_INSTAPAY;
}

function isCodPaymentMethod(value) {
  const key = normalizePaymentMethodKey(value);
  return !key || key === PAYMENT_METHOD_COD;
}

module.exports = {
  PAYMENT_METHOD_COD,
  PAYMENT_METHOD_INSTAPAY,
  normalizePaymentMethod,
  normalizePaymentMethodKey,
  isInstapayPaymentMethod,
  isCodPaymentMethod,
};
