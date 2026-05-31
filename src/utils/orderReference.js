const supabase = require("../config/supabase");
const { egyptLocalToUtc } = require("./dateRange");

const ORDERS_TABLE = process.env.SUPABASE_ORDERS_TABLE || "orders";
const ADDED_ORDERS_TABLE =
  process.env.SUPABASE_ADDED_ORDERS_TABLE || "added_orders";
const REF_SCAN_PAGE_SIZE = 1000;

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

async function tableHasOrderReferenceColumn(tableName) {
  const { error } = await supabase
    .from(tableName)
    .select("order_reference")
    .limit(1);
  return !error;
}

async function maxOrderReferenceFromTableColumn(tableName) {
  if (!(await tableHasOrderReferenceColumn(tableName))) {
    return null;
  }

  const { data, error } = await supabase
    .from(tableName)
    .select("order_reference")
    .gte("created_at", ORDER_REFERENCE_EGYPT_START.toISOString())
    .not("order_reference", "is", null)
    .order("order_reference", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (data?.order_reference == null) {
    return null;
  }

  const n = Number(data.order_reference);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

async function maxOrderReferenceFromOrdersRawDataScan() {
  if (!(await tableHasOrderReferenceColumn(ORDERS_TABLE))) {
    return null;
  }

  let maxRef = null;
  let offset = 0;

  for (;;) {
    const { data: rows, error } = await supabase
      .from(ORDERS_TABLE)
      .select("raw_data, order_reference")
      .gte("created_at", ORDER_REFERENCE_EGYPT_START.toISOString())
      .range(offset, offset + REF_SCAN_PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message);
    }
    if (!rows?.length) {
      break;
    }

    for (const row of rows) {
      const ref = readOrderReferenceFromRow(row);
      if (ref != null && (maxRef == null || ref > maxRef)) {
        maxRef = ref;
      }
    }

    if (rows.length < REF_SCAN_PAGE_SIZE) {
      break;
    }
    offset += REF_SCAN_PAGE_SIZE;
  }

  return maxRef;
}

/**
 * التالي في التسلسل المشترك: orders + added_orders (من 1001، 24/5 مصر فصاعداً).
 */
async function allocateNextOrderReference() {
  let maxRef = ORDER_REFERENCE_START - 1;

  for (const tableName of [ORDERS_TABLE, ADDED_ORDERS_TABLE]) {
    const fromCol = await maxOrderReferenceFromTableColumn(tableName);
    if (fromCol != null) {
      maxRef = Math.max(maxRef, fromCol);
    }
  }

  const fromOrdersRaw = await maxOrderReferenceFromOrdersRawDataScan();
  if (fromOrdersRaw != null) {
    maxRef = Math.max(maxRef, fromOrdersRaw);
  }

  return Math.max(maxRef + 1, ORDER_REFERENCE_START);
}

module.exports = {
  ORDER_REFERENCE_START,
  ORDER_REFERENCE_EGYPT_START,
  ORDER_REFERENCE_EGYPT_START_YMD,
  readOrderReferenceFromRow,
  shouldAssignOrderReference,
  applyOrderReferenceToRawData,
  allocateNextOrderReference,
};
