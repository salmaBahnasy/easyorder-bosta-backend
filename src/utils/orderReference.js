const { egyptLocalToUtc } = require("./dateRange");

/** أول رقم معرف طلب */
const ORDER_REFERENCE_START = Number(
  process.env.ORDER_REFERENCE_START || 1001,
);

/** بداية التسلسل: 24 مايو 00:00 بتوقيت مصر (افتراضي 2026) */
const ORDER_REFERENCE_EGYPT_START_YMD =
  process.env.ORDER_REFERENCE_EGYPT_START_DATE || "2026-05-24";

function parseYmd(ymd) {
  const m = String(ymd).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    throw new Error(
      `Invalid ORDER_REFERENCE_EGYPT_START_DATE: ${ymd} (use YYYY-MM-DD)`,
    );
  }
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
  };
}

const ORDER_REFERENCE_EGYPT_START = (() => {
  const { year, month, day } = parseYmd(ORDER_REFERENCE_EGYPT_START_YMD);
  return egyptLocalToUtc(year, month, day, 0, 0, 0, 0);
})();

function readOrderReferenceFromRow(row) {
  if (!row) return null;
  if (row.order_reference != null) {
    const n = Number(row.order_reference);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  const raw =
    row.raw_data && typeof row.raw_data === "object" && !Array.isArray(row.raw_data)
      ? row.raw_data
      : {};
  for (const key of ["order_reference", "orderReference", "order_ref", "orderRef"]) {
    const n = Number(raw[key]);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return null;
}

function shouldAssignOrderReference(createdAt = new Date()) {
  const t = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(t.getTime())) return false;
  return t.getTime() >= ORDER_REFERENCE_EGYPT_START.getTime();
}

function applyOrderReferenceToRawData(raw_data, reference) {
  if (reference == null) return raw_data;
  const n = Math.trunc(Number(reference));
  if (!Number.isFinite(n) || n <= 0) return raw_data;
  return {
    ...raw_data,
    order_reference: n,
    orderReference: n,
    order_ref: String(n),
    orderRef: String(n),
  };
}

module.exports = {
  ORDER_REFERENCE_START,
  ORDER_REFERENCE_EGYPT_START,
  ORDER_REFERENCE_EGYPT_START_YMD,
  readOrderReferenceFromRow,
  shouldAssignOrderReference,
  applyOrderReferenceToRawData,
};
