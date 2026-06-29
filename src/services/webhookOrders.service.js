const crypto = require("crypto");

const supabase = require("../config/supabase");
const {
  getEgyptTrendBucketKey,
  listEgyptTrendBucketKeys,
} = require("../utils/dateRange");
const {
  ORDER_REFERENCE_START,
  ORDER_REFERENCE_EGYPT_START,
  readOrderReferenceFromRow,
  shouldAssignOrderReference,
  applyOrderReferenceToRawData,
  allocateNextOrderReference,
} = require("../utils/orderReference");

const ALLOWED_ORDER_STATUSES = [
  "canceled",
  "new",
  "no_replay",
  "follow up",
  "repeater",
  "Confirmed",
  "Shipped",
];

/** مصدر الطلب — قيم + تسميات للواجهة */
const ORDER_SOURCE_OPTIONS = [
  { value: "store", labelAr: "المتجر" },
  { value: "messenger", labelAr: "ماسنجر" },
  { value: "whatsapp", labelAr: "واتساب" },
  { value: "lost_order", labelAr: "طلب مفقود" },
  { value: "old_customer", labelAr: "عميل قديم" },
];

const ORDER_SOURCES = ORDER_SOURCE_OPTIONS.map((o) => o.value);

/** نوع الطلب */
const ORDER_TYPE_OPTIONS = [
  { value: "new", labelAr: "جديد" },
  { value: "replacement", labelAr: "استبدال" },
  { value: "return", labelAr: "استرجاع" },
];

const ORDER_TYPES = ORDER_TYPE_OPTIONS.map((o) => o.value);

/** حالة الشحن */
const SHIPPING_STATUS_OPTIONS = [
  { value: "in_progress", labelAr: "قيد التنفيذ" },
  { value: "delivered", labelAr: "تم التوصيل" },
  { value: "failed", labelAr: "فشل التوصيل" },
];

const SHIPPING_STATUSES = SHIPPING_STATUS_OPTIONS.map((o) => o.value);

/** delivered أعلى أولوية عند تعارض shipping_status / shippingStatus */
const SHIPPING_STATUS_RANK = {
  in_progress: 1,
  failed: 2,
  delivered: 3,
};

function normalizeShippingStatusInput(value) {
  const raw = normalizeMetaString(value);
  if (!raw) return "";
  if (SHIPPING_STATUSES.includes(raw)) return raw;

  const lower = raw.toLowerCase();
  const aliases = {
    delivered: "delivered",
    success: "delivered",
    successful: "delivered",
    failed: "failed",
    in_progress: "in_progress",
    inprogress: "in_progress",
  };
  if (aliases[lower]) return aliases[lower];

  const arabic = {
    "تم التوصيل": "delivered",
    "تم التسليم": "delivered",
    "فشل التوصيل": "failed",
    "قيد التنفيذ": "in_progress",
  };
  if (arabic[raw]) return arabic[raw];

  return raw;
}

/** حالة الشحن الفعلية — عند التعارض نفضّل delivered ثم failed ثم in_progress */
function resolveEffectiveShippingStatus(raw) {
  if (!raw || typeof raw !== "object") return "";
  const snake = normalizeShippingStatusInput(raw.shipping_status);
  const camel = normalizeShippingStatusInput(raw.shippingStatus);
  if (!snake && !camel) return "";
  if (!snake) return camel;
  if (!camel) return snake;
  if (snake === camel) return snake;
  const rank = (s) => SHIPPING_STATUS_RANK[s] || 0;
  return rank(snake) >= rank(camel) ? snake : camel;
}

/** طلب ناجح = أي من shipping_status أو shippingStatus = delivered */
function isDeliveredShipping(raw) {
  if (!raw || typeof raw !== "object") return false;
  const snake = normalizeShippingStatusInput(raw.shipping_status);
  const camel = normalizeShippingStatusInput(raw.shippingStatus);
  return snake === "delivered" || camel === "delivered";
}

/** تاريخ يُستخدم لفلترة تكلفة الطلبات (آخر تحديث أو إنشاء). */
function pickOrderActivityDate(row, raw) {
  const candidates = [
    raw?.updated_at,
    raw?.updatedAt,
    raw?.created_at,
    raw?.createdAt,
    raw?.created_day,
    row?.created_at,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function isInstantInRange(instant, from, to) {
  if (!instant || Number.isNaN(instant.getTime())) return false;
  const t = instant.getTime();
  if (from && t < from.getTime()) return false;
  if (to && t > to.getTime()) return false;
  return true;
}

/** طلب حالته تم الشحن (عمود orders.status أو raw_data) */
function isShippedOrder(row, raw) {
  if (String(row?.status || "").trim() === "Shipped") {
    return true;
  }
  if (!raw || typeof raw !== "object") {
    return false;
  }
  for (const key of ["orderStatus", "order_status", "status"]) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const normalized = normalizeOrderStatusInput(raw[key]);
    if (normalized === "Shipped") {
      return true;
    }
  }
  return false;
}

/** مطابق لـ GET /stats → stats.Shipped (عمود orders.status فقط) */
function isStatsShippedOrder(row) {
  return String(row?.status || "").trim() === "Shipped";
}

/** مطابق لـ stats.byShippingStatus.delivered بين الطلبات المشحونة */
function isStatsSuccessfulOrder(row, raw) {
  if (!isStatsShippedOrder(row)) return false;
  return resolveEffectiveShippingStatus(raw) === "delivered";
}

function syncShippingStatusAliases(rawData) {
  if (!rawData || typeof rawData !== "object") return rawData;
  const effective = resolveEffectiveShippingStatus(rawData);
  if (effective) {
    rawData.shipping_status = effective;
    rawData.shippingStatus = effective;
  }
  return rawData;
}

/** phone/mobile و phone2/phone_2/secondaryPhone — نفس القيمة في كل المفاتيح */
function syncCustomerPhoneAliases(rawData) {
  if (!rawData || typeof rawData !== "object") return rawData;

  if (Object.prototype.hasOwnProperty.call(rawData, "mobile")) {
    rawData.phone = rawData.mobile;
  }
  if (Object.prototype.hasOwnProperty.call(rawData, "phone")) {
    rawData.mobile = rawData.phone;
  }

  for (const key of [
    "phone2",
    "phone_2",
    "secondaryPhone",
    "secondary_phone",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(rawData, key)) continue;
    const s = String(rawData[key] ?? "").trim();
    if (s) {
      rawData.phone2 = s;
      rawData.phone_2 = s;
      rawData.secondaryPhone = s;
      rawData.secondary_phone = s;
    }
    break;
  }

  return rawData;
}

function syncOrderCartItemsBostaFields(rawData) {
  if (!rawData || typeof rawData !== "object") return rawData;
  const { normalizeCartItemsBostaFields } = require("./bostaSkuMappings.service");

  if (Array.isArray(rawData.cart_items)) {
    rawData.cart_items = normalizeCartItemsBostaFields(rawData.cart_items);
  }
  if (Array.isArray(rawData.cartItems)) {
    rawData.cartItems = normalizeCartItemsBostaFields(rawData.cartItems);
  }

  return rawData;
}

function syncBostaLocationAliases(rawData) {
  if (!rawData || typeof rawData !== "object") return rawData;

  const cityId = String(
    rawData.bosta_city_id ?? rawData.bostaCityId ?? rawData.cityId ?? "",
  ).trim();
  if (cityId) {
    rawData.bosta_city_id = cityId;
    rawData.bostaCityId = cityId;
    rawData.cityId = cityId;
  }

  const districtId = String(
    rawData.bosta_district_id ??
      rawData.bostaDistrictId ??
      rawData.districtId ??
      "",
  ).trim();
  if (districtId) {
    rawData.bosta_district_id = districtId;
    rawData.bostaDistrictId = districtId;
    rawData.districtId = districtId;
  }

  return rawData;
}

const ORDER_STATUS_OPTIONS = [
  { value: "new", labelAr: "جديد" },
  { value: "Confirmed", labelAr: "مؤكد" },
  { value: "Shipped", labelAr: "تم الشحن" },
  { value: "canceled", labelAr: "ملغي" },
  { value: "no_replay", labelAr: "لا رد" },
  { value: "follow up", labelAr: "متابعة" },
  { value: "repeater", labelAr: "مكرر" },
];

/** قوائم الفلاتر للواجهة (قائمة الطلبات / الإحصائيات) */
function getOrdersFilterLists() {
  return {
    orderSource: {
      key: "order_source",
      labelAr: "مصدر الطلب",
      options: ORDER_SOURCE_OPTIONS,
    },
    orderType: {
      key: "order_type",
      labelAr: "نوع الطلب",
      options: ORDER_TYPE_OPTIONS,
    },
    shippingStatus: {
      key: "shipping_status",
      labelAr: "حالة الشحن",
      options: SHIPPING_STATUS_OPTIONS,
    },
    orderStatus: {
      key: "status",
      labelAr: "حالة الطلب",
      options: ORDER_STATUS_OPTIONS,
    },
  };
}

function pickMetaField(payload, snakeKey, camelKey) {
  if (!payload || typeof payload !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(payload, snakeKey)) {
    return payload[snakeKey];
  }
  if (camelKey && Object.prototype.hasOwnProperty.call(payload, camelKey)) {
    return payload[camelKey];
  }
  return undefined;
}

function normalizeMetaString(value) {
  if (value == null) return "";
  return String(value).trim();
}

/** حالة الطلب من الجسم — orderStatus أولاً (الواجهة) ثم order_status ثم status. */
function pickOrderStatusField(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  for (const key of ["orderStatus", "order_status", "status"]) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    const value = normalizeMetaString(payload[key]);
    if (value) return value;
  }
  return undefined;
}

/** توحيد كتابة الحالة (حساسية الأحرف / مرادفات شائعة). */
function normalizeOrderStatusInput(value) {
  const raw = normalizeMetaString(value);
  if (!raw) return "";

  if (ALLOWED_ORDER_STATUSES.includes(raw)) return raw;

  const lower = raw.toLowerCase();
  const aliases = {
    confirmed: "Confirmed",
    shipped: "Shipped",
    canceled: "canceled",
    cancelled: "canceled",
    new: "new",
    no_replay: "no_replay",
    no_reply: "no_replay",
    "no-replay": "no_replay",
    "no-reply": "no_replay",
    noreply: "no_replay",
    "no reply": "no_replay",
    repeater: "repeater",
    "follow up": "follow up",
    followup: "follow up",
  };
  if (aliases[lower]) return aliases[lower];

  const arabic = {
    مؤكد: "Confirmed",
    "تم التأكيد": "Confirmed",
    "تم التاكيد": "Confirmed",
    "تم الشحن": "Shipped",
    جديد: "new",
    ملغي: "canceled",
    "لا رد": "no_replay",
    متابعة: "follow up",
    مكرر: "repeater",
  };
  if (arabic[raw]) return arabic[raw];

  return raw;
}

/** يزيل أحرف تكسر LIKE أو ilike(all) في PostgREST */
function sanitizeIlikeNeedle(value) {
  const s = String(value).trim().slice(0, 200);
  if (!s) return "";
  return s.replace(/[%_\\,(){}]/g, "");
}

/** نمط ILIKE لـ PostgREST على jsonb->>text؛ * بدل % (موصى به في توثيق PostgREST داخل or/قيم معقّدة). */
function postgrestIlikeStarWrap(needle) {
  const n = sanitizeIlikeNeedle(needle);
  if (!n) return null;
  return `*${n.replace(/\*/g, "\\*")}*`;
}

/**
 * OR على أكثر من raw_data->>key: استعلام منفصل لكل مسار مع .ilike على عمود واحد
 * (مفتاح URL = المسار كامل) — يتفادى or=(…) الذي قد يولّد ILIKE على jsonb أو
 * `"raw_data->>phone"` كاسم عمود غير موجود.
 */
async function collectOrderIdsUnionIlikePaths({
  paths,
  ilikePattern,
  applyBaseFilters,
}) {
  const ids = new Set();
  const p = ilikePattern;
  if (!p || !paths?.length) return [];

  for (const col of paths) {
    let offset = 0;
    for (;;) {
      let q = supabase.from(ORDERS_TABLE).select("order_id");
      q = applyBaseFilters(q);
      q = q.ilike(col, p);
      const { data, error } = await q
        .order("created_at", { ascending: false })
        .range(offset, offset + LOG_SELECT_PAGE_SIZE - 1);
      if (error) {
        throw new Error(error.message);
      }
      if (!data || data.length === 0) {
        break;
      }
      for (const row of data) {
        if (row.order_id != null && String(row.order_id).trim() !== "") {
          ids.add(String(row.order_id).trim());
        }
      }
      if (data.length < LOG_SELECT_PAGE_SIZE) {
        break;
      }
      offset += LOG_SELECT_PAGE_SIZE;
    }
  }

  return [...ids];
}

const CUSTOMER_NAME_ILIKE_PATHS = [
  "raw_data->>full_name",
  "raw_data->>fullName",
  "raw_data->>customer_name",
  "raw_data->>customerName",
  "raw_data->>first_name",
  "raw_data->>firstName",
];

/** تقاطع قوائم order_id (AND) — null/undefined = لا فلتر. */
function intersectOrderIdLists(...lists) {
  let result = null;
  for (const list of lists) {
    if (!list) continue;
    if (!result) {
      result = list.map(String);
      continue;
    }
    const set = new Set(list.map(String));
    result = result.filter((id) => set.has(String(id)));
  }
  return result;
}

/** قيمة آمنة للبحث؛ إن أصبحت فارغة بعد التنقية يُهمَل الفلتر (لا 400). */
function parseProductFilterInput(raw) {
  if (raw == null || String(raw).trim() === "") return "";
  const s = sanitizeIlikeNeedle(raw);
  return s || "";
}

/**
 * معرف منتج للفلترة على العربة: trim فقط (لا نستخدم sanitizeIlikeNeedle لأنه يحذف (){} وغيرها).
 * يزيل علامات اقتباس خارجية لو وصلت من JSON مضاعف.
 */
function normalizeProductIdForCartFilter(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * @param {object} payload - جسم الطلب (ويب هوك أو إنشاء يدوي)
 * @param {{ fromWebhook?: boolean }} options - من الويب هوك: المصدر دائمًا متجر.
 *   إنشاء يدوي: إن لم يُرسل المصدر يُفترض `store`؛ النوع يُفترض `new`؛ الشحن `in_progress`.
 *   لا يُحدَّث صف قديم في DB تلقائياً؛ القيم تُكتب عند الإنشاء أو عند upsert/تحديث يدوي لهذا الطلب.
 */
function resolveOrderMeta(payload, options = {}) {
  const fromWebhook = Boolean(options.fromWebhook);

  let order_source = normalizeMetaString(
    pickMetaField(payload, "order_source", "orderSource"),
  );
  let order_type = normalizeMetaString(
    pickMetaField(payload, "order_type", "orderType"),
  );
  let shipping_status = normalizeMetaString(
    pickMetaField(payload, "shipping_status", "shippingStatus"),
  );

  if (fromWebhook) {
    order_source = "store";
  } else {
    if (!order_source) {
      order_source = "store";
    }
    if (!ORDER_SOURCES.includes(order_source)) {
      const err = new Error("Invalid order_source");
      err.code = "INVALID_ORDER_META";
      throw err;
    }
  }

  if (!order_type) order_type = "new";
  if (!ORDER_TYPES.includes(order_type)) {
    const err = new Error("Invalid order_type");
    err.code = "INVALID_ORDER_META";
    throw err;
  }

  if (!shipping_status) shipping_status = "in_progress";
  if (!SHIPPING_STATUSES.includes(shipping_status)) {
    const err = new Error("Invalid shipping_status");
    err.code = "INVALID_ORDER_META";
    throw err;
  }

  return { order_source, order_type, shipping_status };
}

/** حالة orders.status عند الإنشاء — إنشاء يدوي + status مُرسل يتجاوز الحالة المخزنة. */
function resolveInitialOrderStatus(order, existingRow, options = {}) {
  const fromWebhook = Boolean(options.fromWebhook);
  const requestedRaw = pickOrderStatusField(order);
  const hasRequestedStatus = requestedRaw !== undefined && requestedRaw !== "";

  if (hasRequestedStatus) {
    const status = normalizeOrderStatusInput(requestedRaw);
    if (!ALLOWED_ORDER_STATUSES.includes(status)) {
      if (fromWebhook) {
        return existingRow?.status || "new";
      }
      const err = new Error("Invalid status value");
      err.code = "INVALID_STATUS";
      throw err;
    }
    // إنشاء يدوي: احترم الحالة المُرسلة حتى لو الطلب موجود مسبقاً (upsert).
    if (!fromWebhook) {
      return status;
    }
    // ويب هوك: طلب جديد فقط — وإلا احتفظ بالحالة المخزنة.
    if (!existingRow?.status) {
      return status;
    }
    return existingRow.status;
  }

  if (existingRow?.status) {
    return existingRow.status;
  }

  return "new";
}

const ORDERS_TABLE = process.env.SUPABASE_ORDERS_TABLE || "orders";
const ORDER_STATUS_LOGS_TABLE =
  process.env.SUPABASE_ORDER_STATUS_LOGS_TABLE || "order_status_logs";
const EMPLOYEES_TABLE = process.env.SUPABASE_EMPLOYEES_TABLE || "employees";

/** لتطابق إيميل في ILIKE دون اعتبار % أو _ حرفين خاصين */
function escapeIlikeLiteral(value) {
  return String(value)
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/**
 * فلتر الموظف يستخدم order_status_logs.changed_by = id الموظف.
 * إذا مرّرت إيميلاً (يحتوي @) نُحلّه إلى id من جدول employees.
 */
async function resolveEmployeeToIdForLogs(employeeFilter) {
  const raw = String(employeeFilter).trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (
    lower === "all" ||
    lower === "any" ||
    lower === "*" ||
    lower === "everyone"
  ) {
    return null;
  }
  if (!raw.includes("@")) return raw;

  const literal = escapeIlikeLiteral(raw);
  let { data, error } = await supabase
    .from(EMPLOYEES_TABLE)
    .select("id")
    .ilike("email", literal)
    .limit(1);

  if (error) {
    throw new Error(error.message);
  }

  let row = Array.isArray(data) && data.length ? data[0] : null;
  if (!row) {
    ({ data, error } = await supabase
      .from(EMPLOYEES_TABLE)
      .select("id")
      .eq("email", raw.toLowerCase())
      .limit(1));
    if (error) {
      throw new Error(error.message);
    }
    row = Array.isArray(data) && data.length ? data[0] : null;
  }

  return row?.id != null ? String(row.id) : null;
}

const LOG_SELECT_PAGE_SIZE = 1000;

/**
 * يجمع order_id مميزة من order_status_logs حيث changed_by = الموظف.
 * الفترة from/to تُطبَّق على changed_at (وقت تغيير الحالة)، مع جلب كل الصفوف (تجاوز حد الـ 1000 الافتراضي).
 */
async function fetchDistinctOrderIdsFromLogs({
  changedByKey,
  from,
  to,
  ignoreDateRange = false,
}) {
  const ids = new Set();
  let offset = 0;

  for (;;) {
    let q = supabase
      .from(ORDER_STATUS_LOGS_TABLE)
      .select("order_id")
      .eq("changed_by", changedByKey)
      .order("changed_at", { ascending: true });

    if (from && !ignoreDateRange) {
      q = q.gte("changed_at", from.toISOString());
    }
    if (to && !ignoreDateRange) {
      q = q.lte("changed_at", to.toISOString());
    }

    q = q.range(offset, offset + LOG_SELECT_PAGE_SIZE - 1);

    const { data, error } = await q;
    if (error) {
      throw new Error(error.message);
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (row.order_id != null && String(row.order_id).trim() !== "") {
        ids.add(String(row.order_id).trim());
      }
    }

    if (data.length < LOG_SELECT_PAGE_SIZE) break;
    offset += LOG_SELECT_PAGE_SIZE;
  }

  return [...ids];
}

const UUID_LIKE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * طلبات تحتوي العربة على معرف المنتج (UUID) بأحد الأشكال الشائعة في EasyOrder —
 * OR عبر عدة استعلامات contains (أدق من sku / ilike على النص الكامل).
 */
async function collectOrderIdsUnionContainsCartProductUuid(
  productUuid,
  applyBaseFilters,
) {
  const id = String(productUuid || "").trim();
  if (!id || !UUID_LIKE.test(id)) return [];

  const blobs = [
    { cart_items: [{ product_id: id }] },
    { cart_items: [{ productId: id }] },
    { cart_items: [{ id: id }] },
    { cart_items: [{ easyorder_id: id }] },
    { cart_items: [{ easyorderId: id }] },
    { cart_items: [{ product: { id: id } }] },
    { cart_items: [{ product: { easyorder_id: id } }] },
    { cart_items: [{ product: { easyorderId: id } }] },
    { cart_items: [{ product: { product_id: id } }] },
    { cart_items: [{ product: { productId: id } }] },
    { cartItems: [{ product_id: id }] },
    { cartItems: [{ productId: id }] },
    { cartItems: [{ id: id }] },
    { cartItems: [{ easyorder_id: id }] },
    { cartItems: [{ easyorderId: id }] },
    { cartItems: [{ product: { id: id } }] },
    { cartItems: [{ product: { easyorder_id: id } }] },
    { cartItems: [{ product: { easyorderId: id } }] },
    { cartItems: [{ product: { product_id: id } }] },
    { cartItems: [{ product: { productId: id } }] },
  ];

  const ids = new Set();
  for (const blob of blobs) {
    let offset = 0;
    for (;;) {
      let q = supabase.from(ORDERS_TABLE).select("order_id");
      q = applyBaseFilters(q);
      q = q.contains("raw_data", blob);
      const { data, error } = await q
        .order("created_at", { ascending: false })
        .range(offset, offset + LOG_SELECT_PAGE_SIZE - 1);
      if (error) {
        throw new Error(error.message);
      }
      if (!data || data.length === 0) {
        break;
      }
      for (const row of data) {
        if (row.order_id != null && String(row.order_id).trim() !== "") {
          ids.add(String(row.order_id).trim());
        }
      }
      if (data.length < LOG_SELECT_PAGE_SIZE) {
        break;
      }
      offset += LOG_SELECT_PAGE_SIZE;
    }
  }

  return [...ids];
}

/**
 * طلبات يظهر في raw_data أن هذا الموظف عالجها (PATCH) — حقول من الواجهة مثل
 * modifier_employee_id / updated_by_employee_id / الإيميلات.
 * يُكمّل order_status_logs التي تُسجَّل فقط عند تغيير status.
 *
 * مع from/to: نُقيّد بـ orders.created_at لكل حقول الموظف في raw_data
 * (تعديل بدون تغيير status لا يُسجَّل في order_status_logs).
 */
async function fetchOrderIdsFromRawDataEmployeeMarkers({
  employeeKey,
  employeeRawInput,
  from,
  to,
  ignoreDateRange = false,
}) {
  const ids = new Set();
  const boundByCreatedAt = !ignoreDateRange && (from || to);

  function applyCreatedAtBounds(q) {
    let next = q;
    if (boundByCreatedAt) {
      if (from) {
        next = next.gte("created_at", from.toISOString());
      }
      if (to) {
        next = next.lte("created_at", to.toISOString());
      }
    }
    return next;
  }

  async function addAllOrderIdsEqJsonKey(jsonKey, value) {
    let offset = 0;
    for (;;) {
      const col = `raw_data->>${jsonKey}`;
      let q = supabase.from(ORDERS_TABLE).select("order_id").eq(col, value);
      q = applyCreatedAtBounds(q);
      const { data, error } = await q
        .order("created_at", { ascending: false })
        .range(offset, offset + LOG_SELECT_PAGE_SIZE - 1);
      if (error) {
        throw new Error(error.message);
      }
      if (!data || data.length === 0) break;
      for (const row of data) {
        if (row.order_id != null && String(row.order_id).trim() !== "") {
          ids.add(String(row.order_id).trim());
        }
      }
      if (data.length < LOG_SELECT_PAGE_SIZE) break;
      offset += LOG_SELECT_PAGE_SIZE;
    }
  }

  if (UUID_LIKE.test(employeeKey)) {
    for (const jsonKey of EMPLOYEE_RAW_ID_KEYS) {
      await addAllOrderIdsEqJsonKey(jsonKey, employeeKey);
    }
  }

  const raw = String(employeeRawInput || "").trim();
  if (raw.includes("@")) {
    const p = postgrestIlikeStarWrap(raw);
    if (p) {
      let offset = 0;
      for (;;) {
        let q = supabase
          .from(ORDERS_TABLE)
          .select("order_id")
          .or(
            `raw_data->>updated_by_email.ilike.${p},raw_data->>user_email.ilike.${p}`,
          );
        q = applyCreatedAtBounds(q);
        const { data, error } = await q
          .order("created_at", { ascending: false })
          .range(offset, offset + LOG_SELECT_PAGE_SIZE - 1);
        if (error) {
          throw new Error(error.message);
        }
        if (!data || data.length === 0) break;
        for (const row of data) {
          if (row.order_id != null && String(row.order_id).trim() !== "") {
            ids.add(String(row.order_id).trim());
          }
        }
        if (data.length < LOG_SELECT_PAGE_SIZE) break;
        offset += LOG_SELECT_PAGE_SIZE;
      }
    }
  }

  return [...ids];
}

/** مع from/to: نفلتر orders.created_at مع فلتر الموظف (مثل analytics). */
function shouldFilterOrdersByCreatedAtWithEmployee({
  from,
  to,
  employeeId,
  ignoreEmployeeLogDateRange,
}) {
  if (!employeeId) return true;
  if (ignoreEmployeeLogDateRange) return false;
  return Boolean(from || to);
}

async function resolveEmployeeScopedOrderIds({
  employeeId,
  from,
  to,
  ignoreEmployeeLogDateRange = false,
}) {
  const changedByKey = await resolveEmployeeToIdForLogs(employeeId);
  if (String(employeeId).trim().includes("@") && !changedByKey) {
    return {
      orderIds: [],
      logOrderIds: new Set(),
      employeeKey: null,
      employeeEmail: null,
      notFound: true,
    };
  }

  const keyForLogs = changedByKey || String(employeeId).trim();
  const rawInput = String(employeeId).trim();
  const fromLogs = await fetchDistinctOrderIdsFromLogs({
    changedByKey: keyForLogs,
    from,
    to,
    ignoreDateRange: ignoreEmployeeLogDateRange,
  });
  const fromRawMarkers = await fetchOrderIdsFromRawDataEmployeeMarkers({
    employeeKey: keyForLogs,
    employeeRawInput: rawInput,
    from,
    to,
    ignoreDateRange: ignoreEmployeeLogDateRange,
  });

  let employeeEmail = rawInput.includes("@") ? rawInput : null;
  if (!employeeEmail && UUID_LIKE.test(keyForLogs)) {
    const { data: empRow } = await supabase
      .from(EMPLOYEES_TABLE)
      .select("email")
      .eq("id", keyForLogs)
      .maybeSingle();
    if (empRow?.email) {
      employeeEmail = String(empRow.email).trim();
    }
  }

  return {
    orderIds: [...new Set([...fromLogs, ...fromRawMarkers])],
    logOrderIds: new Set(fromLogs),
    employeeKey: keyForLogs,
    employeeEmail,
    notFound: false,
  };
}

async function insertOrderStatusLog({
  orderId,
  oldStatus,
  newStatus,
  changedBy,
}) {
  const { error } = await supabase.from(ORDER_STATUS_LOGS_TABLE).insert({
    order_id: orderId,
    old_status: oldStatus,
    new_status: newStatus,
    changed_by: changedBy,
    changed_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(error.message);
  }
}

function resolveSourceOrderId(order) {
  const idCandidates = [
    order?.id,
    order?.order_id,
    order?.orderId,
    order?.data?.id,
    order?.data?.order_id,
    order?.data?.orderId,
  ];

  for (const candidate of idCandidates) {
    if (candidate == null) continue;
    const value = String(candidate).trim();
    if (value) return value;
  }

  const fingerprint = crypto
    .createHash("sha1")
    .update(JSON.stringify(order || {}))
    .digest("hex");

  return `webhook-${fingerprint}`;
}

let orderReferenceColumnAvailable = null;

async function hasOrderReferenceColumn() {
  if (orderReferenceColumnAvailable != null) {
    return orderReferenceColumnAvailable;
  }
  const { error } = await supabase
    .from(ORDERS_TABLE)
    .select("order_reference")
    .limit(1);
  orderReferenceColumnAvailable = !error;
  return orderReferenceColumnAvailable;
}

async function fetchOrderRowBySourceId(orderId) {
  const id = String(orderId || "").trim();
  if (!id) return null;
  const useRefCol = await hasOrderReferenceColumn();
  const { data, error } = await supabase
    .from(ORDERS_TABLE)
    .select(
      useRefCol
        ? "order_id, order_reference, raw_data, created_at, status"
        : "order_id, raw_data, created_at, status",
    )
    .eq("order_id", id)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return data;
}

function mapStoredOrderToClient(row) {
  const ref = readOrderReferenceFromRow(row);
  const raw =
    row.raw_data && typeof row.raw_data === "object" && !Array.isArray(row.raw_data)
      ? { ...row.raw_data }
      : {};
  syncShippingStatusAliases(raw);
  syncCustomerPhoneAliases(raw);
  return {
    ...raw,
    sourceOrderId: row.order_id,
    status: row.status,
    orderStatus: row.status,
    receivedAt: row.created_at,
    ...(ref != null
      ? {
          order_reference: ref,
          orderReference: ref,
        }
      : {}),
  };
}

function parseOrderReferenceInput(value) {
  const ref = Math.trunc(Number(String(value ?? "").trim()));
  if (!Number.isFinite(ref) || ref <= 0) {
    const err = new Error("order_reference must be a positive number");
    err.code = "INVALID_ORDER_REFERENCE";
    throw err;
  }
  return ref;
}

/** تفاصيل طلب واحد بمعرف الطلب التسلسلي (1001+). */
async function getWebhookOrderByReference(orderReferenceInput) {
  const ref = parseOrderReferenceInput(orderReferenceInput);

  if (await hasOrderReferenceColumn()) {
    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .select("*")
      .eq("order_reference", ref)
      .maybeSingle();
    if (error) {
      throw new Error(error.message);
    }
    if (data) {
      return mapStoredOrderToClient(data);
    }
  }

  const { data: rows, error } = await supabase
    .from(ORDERS_TABLE)
    .select("*")
    .or(
      `raw_data->>order_reference.eq.${ref},raw_data->>orderReference.eq.${ref}`,
    )
    .limit(2);

  if (error) {
    throw new Error(error.message);
  }

  if (!rows?.length) {
    const notFound = new Error("Order not found");
    notFound.code = "ORDER_NOT_FOUND";
    throw notFound;
  }

  if (rows.length > 1) {
    const ambiguous = new Error("Multiple orders match this order_reference");
    ambiguous.code = "ORDER_REFERENCE_AMBIGUOUS";
    throw ambiguous;
  }

  return mapStoredOrderToClient(rows[0]);
}

async function getWebhookOrderById(orderId) {
  const id = String(orderId || "").trim();
  if (!id) {
    const err = new Error("order id is required");
    err.code = "INVALID_ORDER_ID";
    throw err;
  }
  const row = await fetchOrderRowBySourceId(id);
  if (!row) {
    const notFound = new Error("Order not found");
    notFound.code = "ORDER_NOT_FOUND";
    throw notFound;
  }
  return mapStoredOrderToClient(row);
}

async function findOrderByBostaAlias(orderAlias) {
  const alias = String(orderAlias || "").trim();
  if (!alias) {
    const err = new Error("orderAlias is required");
    err.code = "INVALID_ORDER_ALIAS";
    throw err;
  }

  const byIdRow = await fetchOrderRowBySourceId(alias);
  if (byIdRow) {
    return mapStoredOrderToClient(byIdRow);
  }

  if (/^\d+$/.test(alias)) {
    try {
      return await getWebhookOrderByReference(alias);
    } catch (error) {
      if (
        error.code !== "ORDER_NOT_FOUND" &&
        error.code !== "ORDER_REFERENCE_AMBIGUOUS"
      ) {
        throw error;
      }
    }
  }

  const escaped = alias.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const { data: rows, error } = await supabase
    .from(ORDERS_TABLE)
    .select("*")
    .or(
      [
        `raw_data->>bosta_order_alias.eq.${escaped}`,
        `raw_data->>orderAlias.eq.${escaped}`,
      ].join(","),
    )
    .limit(2);

  if (error) {
    throw new Error(error.message);
  }
  if (!rows?.length) {
    const notFound = new Error("Order not found");
    notFound.code = "ORDER_NOT_FOUND";
    throw notFound;
  }
  if (rows.length > 1) {
    const ambiguous = new Error("Multiple orders match this orderAlias");
    ambiguous.code = "ORDER_REFERENCE_AMBIGUOUS";
    throw ambiguous;
  }

  return mapStoredOrderToClient(rows[0]);
}

async function mergeOrderRawDataPatch(orderId, rawPatch, options = {}) {
  const id = String(orderId || "").trim();
  if (!id) {
    const err = new Error("order id is required");
    err.code = "INVALID_ORDER_ID";
    throw err;
  }

  const { data: existingOrder, error: existingError } = await supabase
    .from(ORDERS_TABLE)
    .select("order_id,status,raw_data,created_at")
    .eq("order_id", id)
    .single();

  if (existingError || !existingOrder) {
    const notFound = new Error("Order not found");
    notFound.code = "ORDER_NOT_FOUND";
    throw notFound;
  }

  const mergedRawData = {
    ...(existingOrder.raw_data || {}),
    ...(rawPatch || {}),
  };
  syncCustomerPhoneAliases(mergedRawData);
  syncShippingStatusAliases(mergedRawData);

  let nextStatus = existingOrder.status;
  if (options.status && ALLOWED_ORDER_STATUSES.includes(options.status)) {
    nextStatus = options.status;
  }

  const { data, error } = await supabase
    .from(ORDERS_TABLE)
    .update({
      raw_data: mergedRawData,
      status: nextStatus,
    })
    .eq("order_id", id)
    .select()
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to update order");
  }

  return mapStoredOrderToClient(data);
}

async function markOrderSentToBosta(orderId, bostaResult, bostaPayload) {
  const bostaId =
    bostaResult?.id ??
    bostaResult?.data?.id ??
    bostaResult?.orderId ??
    null;

  return mergeOrderRawDataPatch(
    orderId,
    {
      bosta_fulfillment_id: bostaId,
      bosta_order_id: bostaId,
      bosta_order_alias: bostaPayload?.orderAlias ?? null,
      bosta_sent_at: new Date().toISOString(),
      bosta_last_payload: bostaPayload ?? null,
      shipping_status: "in_progress",
      shippingStatus: "in_progress",
    },
    { status: "Shipped" },
  );
}

function mapBostaStatusToShippingStatus(status) {
  const key = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  if (
    key.includes("deliver") ||
    key === "completed" ||
    key === "success" ||
    key === "successful"
  ) {
    return "delivered";
  }

  if (
    key.includes("fail") ||
    key.includes("cancel") ||
    key.includes("return") ||
    key.includes("reject")
  ) {
    return "failed";
  }

  return "in_progress";
}

async function applyBostaFulfillmentWebhook(payload) {
  const order = await findOrderByBostaAlias(payload?.orderAlias);
  const shippingStatus = mapBostaStatusToShippingStatus(payload?.status);

  return mergeOrderRawDataPatch(order.sourceOrderId, {
    bosta_order_id: payload?.id ?? null,
    bosta_status: payload?.status ?? null,
    bosta_tracking_number: payload?.trackingNumber ?? null,
    bosta_type: payload?.type ?? null,
    bosta_failure_reason: payload?.reason ?? null,
    bosta_last_webhook_at: new Date().toISOString(),
    shipping_status: shippingStatus,
    shippingStatus,
  });
}

async function addWebhookOrder(order, options = {}) {
  const { fromWebhook, actor } = options;
  const sourceOrderId = resolveSourceOrderId(order);
  const meta = resolveOrderMeta(order, { fromWebhook });
  const raw_data = {
    ...(order && typeof order === "object" && !Array.isArray(order)
      ? order
      : {}),
    ...meta,
  };

  raw_data.orderSource = raw_data.order_source;
  raw_data.orderType = raw_data.order_type;
  syncCustomerPhoneAliases(raw_data);
  syncShippingStatusAliases(raw_data);
  syncBostaLocationAliases(raw_data);
  syncOrderCartItemsBostaFields(raw_data);

  if (actor?.id != null) {
    const idStr = String(actor.id).trim();
    if (idStr) {
      raw_data.created_by_employee_id = idStr;
      raw_data.createdByEmployeeId = idStr;
      if (actor.email != null && String(actor.email).trim() !== "") {
        const em = String(actor.email).trim();
        raw_data.created_by_email = em;
        raw_data.user_email = em;
      }
    }
  }

  const existingRow = await fetchOrderRowBySourceId(sourceOrderId);
  const createdAt = existingRow?.created_at
    ? new Date(existingRow.created_at)
    : new Date();

  let orderReference = readOrderReferenceFromRow(existingRow);
  if (orderReference == null && shouldAssignOrderReference(createdAt)) {
    orderReference = await allocateNextOrderReference();
  }

  if (orderReference != null) {
    Object.assign(raw_data, applyOrderReferenceToRawData({}, orderReference));
  }

  const nextStatus = resolveInitialOrderStatus(order, existingRow, {
    fromWebhook,
  });
  raw_data.status = nextStatus;
  raw_data.orderStatus = nextStatus;

  const payload = {
    order_id: sourceOrderId,
    status: nextStatus,
    raw_data,
    created_at: createdAt.toISOString(),
  };
  if (orderReference != null && (await hasOrderReferenceColumn())) {
    payload.order_reference = orderReference;
  }

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .upsert(payload, { onConflict: "order_id" })
      .select()
      .single();

    if (!error) {
      return mapStoredOrderToClient(data);
    }

    const dup =
      String(error.message || "").includes("duplicate") ||
      String(error.code || "") === "23505";
    if (dup && orderReference != null && attempt < 2) {
      orderReference = await allocateNextOrderReference();
      payload.order_reference = orderReference;
      payload.raw_data = applyOrderReferenceToRawData(payload.raw_data, orderReference);
      lastError = error;
      continue;
    }

    throw new Error(error.message);
  }

  if (lastError) {
    throw new Error(lastError.message);
  }
}

/** For embedding a JSON string value inside PostgREST `raw_data.cs.{...}` fragments. */
function escapePostgrestJsonStringForCsFragment(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Some payloads store shipping under `shipping_status`, others under `shippingStatus`.
 * A single `contains(raw_data, { shipping_status, … })` misses the camelCase key; OR two `cs` predicates matches either shape (ANDed with other filters).
 */
function applyRawDataShippingStatusContainsOr(query, shippingValue) {
  const v = String(shippingValue || "").trim();
  if (!v) return query;
  const e = escapePostgrestJsonStringForCsFragment(v);
  return query.or(
    `raw_data.cs.{"shipping_status":"${e}"},raw_data.cs.{"shippingStatus":"${e}"}`,
  );
}

function applyRawDataOrderSourceContainsOr(query, sourceValue) {
  const v = String(sourceValue || "").trim();
  if (!v) return query;
  const e = escapePostgrestJsonStringForCsFragment(v);
  return query.or(
    `raw_data.cs.{"order_source":"${e}"},raw_data.cs.{"orderSource":"${e}"}`,
  );
}

function applyRawDataOrderTypeContainsOr(query, typeValue) {
  const v = String(typeValue || "").trim();
  if (!v) return query;
  const e = escapePostgrestJsonStringForCsFragment(v);
  return query.or(
    `raw_data.cs.{"order_type":"${e}"},raw_data.cs.{"orderType":"${e}"}`,
  );
}

function applyRawDataMetaContains(query, { order_source, order_type, shipping_status }) {
  let q = query;
  if (order_source) {
    q = applyRawDataOrderSourceContainsOr(q, order_source);
  }
  if (order_type) {
    q = applyRawDataOrderTypeContainsOr(q, order_type);
  }
  if (shipping_status) {
    q = applyRawDataShippingStatusContainsOr(q, shipping_status);
  }
  if (!order_source && !order_type && !shipping_status) return query;
  return q;
}

/**
 * فلتر منتج UUID في cart_items / cartItems — استعلام واحد بدل جمع آلاف order_id في URL.
 */
function applyProductUuidCartContainsOr(query, productUuid) {
  const id = normalizeProductIdForCartFilter(productUuid);
  if (!id || !UUID_LIKE.test(id)) return query;
  const e = escapePostgrestJsonStringForCsFragment(id);
  return query.or(
    [
      `raw_data.cs.{"cart_items":[{"product_id":"${e}"}]}`,
      `raw_data.cs.{"cart_items":[{"productId":"${e}"}]}`,
      `raw_data.cs.{"cart_items":[{"id":"${e}"}]}`,
      `raw_data.cs.{"cart_items":[{"easyorder_id":"${e}"}]}`,
      `raw_data.cs.{"cart_items":[{"easyorderId":"${e}"}]}`,
      `raw_data.cs.{"cart_items":[{"product":{"id":"${e}"}}]}`,
      `raw_data.cs.{"cart_items":[{"product":{"product_id":"${e}"}}]}`,
      `raw_data.cs.{"cart_items":[{"product":{"productId":"${e}"}}]}`,
      `raw_data.cs.{"cart_items":[{"product":{"easyorder_id":"${e}"}}]}`,
      `raw_data.cs.{"cart_items":[{"product":{"easyorderId":"${e}"}}]}`,
      `raw_data.cs.{"cartItems":[{"product_id":"${e}"}]}`,
      `raw_data.cs.{"cartItems":[{"productId":"${e}"}]}`,
      `raw_data.cs.{"cartItems":[{"id":"${e}"}]}`,
      `raw_data.cs.{"cartItems":[{"easyorder_id":"${e}"}]}`,
      `raw_data.cs.{"cartItems":[{"easyorderId":"${e}"}]}`,
      `raw_data.cs.{"cartItems":[{"product":{"id":"${e}"}}]}`,
      `raw_data.cs.{"cartItems":[{"product":{"product_id":"${e}"}}]}`,
      `raw_data.cs.{"cartItems":[{"product":{"productId":"${e}"}}]}`,
      `raw_data.cs.{"cartItems":[{"product":{"easyorder_id":"${e}"}}]}`,
      `raw_data.cs.{"cartItems":[{"product":{"easyorderId":"${e}"}}]}`,
    ].join(","),
  );
}

function applyProductCartIlikeFilters(query, { product_id, product_sku }) {
  const pidNeedle = normalizeProductIdForCartFilter(product_id);
  const skuNeedle = parseProductFilterInput(product_sku);
  if (pidNeedle && skuNeedle) {
    const p1 = postgrestIlikeStarWrap(pidNeedle);
    const p2 = postgrestIlikeStarWrap(skuNeedle);
    if (p1 && p2) {
      return query.ilikeAllOf("raw_data->>cart_items", [p1, p2]);
    }
    return query;
  }
  if (pidNeedle) {
    const p = postgrestIlikeStarWrap(pidNeedle);
    if (p) {
      return query.or(
        `raw_data->>cart_items.ilike.${p},raw_data->>cartItems.ilike.${p}`,
      );
    }
    return query;
  }
  if (skuNeedle) {
    const p = postgrestIlikeStarWrap(skuNeedle);
    if (p) {
      return query.or(
        `raw_data->>cart_items.ilike.${p},raw_data->>cartItems.ilike.${p}`,
      );
    }
  }
  return query;
}

async function getWebhookOrders({
  page = 1,
  limit = 50,
  from,
  to,
  status,
  employeeId,
  order_source,
  order_type,
  shipping_status,
  product_id,
  product_sku,
  phone,
  customer_name,
  ignoreEmployeeLogDateRange = false,
}) {
  const fromIndex = (page - 1) * limit;
  const toIndex = fromIndex + limit - 1;
  let orderIdsByEmployee = null;
  const skipOrderCreatedAtRange = !shouldFilterOrdersByCreatedAtWithEmployee({
    from,
    to,
    employeeId,
    ignoreEmployeeLogDateRange,
  });

  let employeeScope = null;

  if (employeeId) {
    const scoped = await resolveEmployeeScopedOrderIds({
      employeeId,
      from,
      to,
      ignoreEmployeeLogDateRange,
    });
    if (scoped.notFound) {
      return {
        page,
        limit,
        total: 0,
        totalPages: 1,
        data: [],
      };
    }

    employeeScope = {
      logOrderIds: scoped.logOrderIds,
      employeeKey: scoped.employeeKey,
      employeeEmail: scoped.employeeEmail,
    };
    orderIdsByEmployee = await filterOrderIdsForEmployeeScope(
      scoped.orderIds,
      employeeScope,
    );

    if (!orderIdsByEmployee.length) {
      return {
        page,
        limit,
        total: 0,
        totalPages: 1,
        data: [],
      };
    }
  }

  function applyBaseListFilters(q) {
    if (from && !skipOrderCreatedAtRange) {
      q = q.gte("created_at", from.toISOString());
    }
    if (to && !skipOrderCreatedAtRange) {
      q = q.lte("created_at", to.toISOString());
    }
    if (status) {
      q = q.eq("status", status);
    }
    q = applyRawDataMetaContains(q, {
      order_source,
      order_type,
      shipping_status,
    });
    if (orderIdsByEmployee) {
      q = applyOrderIdMembershipFilter(q, orderIdsByEmployee);
    }
    return q;
  }

  const phoneNeedle = parseProductFilterInput(phone);
  const pPhone = postgrestIlikeStarWrap(phoneNeedle);

  let phoneOrderIds = null;
  if (pPhone) {
    phoneOrderIds = await collectOrderIdsUnionIlikePaths({
      paths: [
        "raw_data->>phone",
        "raw_data->>mobile",
        "raw_data->>phone2",
        "raw_data->>phone_2",
        "raw_data->>secondaryPhone",
        "raw_data->>secondary_phone",
      ],
      ilikePattern: pPhone,
      applyBaseFilters: applyBaseListFilters,
    });
    if (!phoneOrderIds.length) {
      return {
        page,
        limit,
        total: 0,
        totalPages: 1,
        data: [],
      };
    }
  }

  const customerNameNeedle = parseProductFilterInput(customer_name);
  const pCustomerName = postgrestIlikeStarWrap(customerNameNeedle);

  let customerNameOrderIds = null;
  if (pCustomerName) {
    customerNameOrderIds = await collectOrderIdsUnionIlikePaths({
      paths: CUSTOMER_NAME_ILIKE_PATHS,
      ilikePattern: pCustomerName,
      applyBaseFilters: applyBaseListFilters,
    });
    if (!customerNameOrderIds.length) {
      return {
        page,
        limit,
        total: 0,
        totalPages: 1,
        data: [],
      };
    }
  }

  const scopedOrderIds = intersectOrderIdLists(
    phoneOrderIds,
    customerNameOrderIds,
  );

  function applyBaseListFiltersAndScopedIds(q) {
    let x = applyBaseListFilters(q);
    if (scopedOrderIds) {
      x = applyOrderIdMembershipFilter(x, scopedOrderIds);
    }
    return x;
  }

  const pidForProduct = normalizeProductIdForCartFilter(product_id);
  const skuForProduct = parseProductFilterInput(product_sku);
  const useProductUuidContains =
    pidForProduct && UUID_LIKE.test(pidForProduct) && !skuForProduct;

  let query = supabase.from(ORDERS_TABLE).select("*", { count: "exact" });
  query = applyBaseListFilters(query);
  if (scopedOrderIds) {
    query = applyOrderIdMembershipFilter(query, scopedOrderIds);
  }

  if (useProductUuidContains) {
    query = applyProductUuidCartContainsOr(query, pidForProduct);
  } else {
    query = applyProductCartIlikeFilters(query, { product_id, product_sku });
  }

  query = query
    .order("created_at", { ascending: false })
    .range(fromIndex, toIndex);

  const { data, count, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  const rows = data || [];
  const total = count || 0;

  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
    data: rows.map((entry) => mapStoredOrderToClient(entry)),
  };
}

async function getWebhookOrdersForExport(filters, options = {}) {
  const maxRows = Math.min(
    Math.max(1, Number(options.maxRows) || 10000),
    20000,
  );
  const pageSize = Math.min(
    Math.max(100, Number(options.pageSize) || 500),
    1000,
  );

  const all = [];
  let total = 0;
  let page = 1;

  for (;;) {
    const batch = await getWebhookOrders({
      ...filters,
      page,
      limit: pageSize,
    });

    total = batch.total;
    all.push(...batch.data);

    if (
      batch.data.length < pageSize ||
      all.length >= total ||
      all.length >= maxRows
    ) {
      break;
    }

    page += 1;
    if (page > 500) break;
  }

  const exported = Math.min(all.length, maxRows);
  return {
    data: all.slice(0, maxRows),
    total,
    exported,
    truncated: total > exported,
  };
}

async function updateOrderStatus(orderId, status, changedBy) {
  if (!ALLOWED_ORDER_STATUSES.includes(status)) {
    const error = new Error("Invalid status value");
    error.code = "INVALID_STATUS";
    throw error;
  }

  if (!changedBy) {
    const error = new Error("Unauthorized");
    error.code = "UNAUTHORIZED";
    throw error;
  }

  const { data: existingOrder, error: existingError } = await supabase
    .from(ORDERS_TABLE)
    .select("order_id,status")
    .eq("order_id", orderId)
    .single();

  if (existingError || !existingOrder) {
    const notFoundError = new Error("Order not found");
    notFoundError.code = "ORDER_NOT_FOUND";
    throw notFoundError;
  }

  const oldStatus = existingOrder.status;

  const { data, error } = await supabase
    .from(ORDERS_TABLE)
    .update({ status: status })
    .eq("order_id", orderId)
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  await insertOrderStatusLog({
    orderId: data.order_id,
    oldStatus,
    newStatus: data.status,
    changedBy,
  });

  return mapStoredOrderToClient(data);
}

async function editOrder(orderId, updates, actor) {
  const changedBy =
    actor && typeof actor === "object" && actor.id != null
      ? String(actor.id).trim()
      : typeof actor === "string"
        ? String(actor).trim()
        : "";

  const normalizedUpdates =
    updates && typeof updates === "object" && !Array.isArray(updates)
      ? updates
      : null;

  if (!normalizedUpdates) {
    const error = new Error("Invalid order updates payload");
    error.code = "INVALID_UPDATES";
    throw error;
  }

  const { data: existingOrder, error: existingError } = await supabase
    .from(ORDERS_TABLE)
    .select("order_id,status,raw_data,created_at")
    .eq("order_id", orderId)
    .single();

  if (existingError || !existingOrder) {
    const notFoundError = new Error("Order not found");
    notFoundError.code = "ORDER_NOT_FOUND";
    throw notFoundError;
  }

  let nextStatus = existingOrder.status;
  let shouldLogStatusChange = false;

  const normalizedIncomingUpdates = { ...normalizedUpdates };

  if (
    Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "orderStatus")
  ) {
    normalizedIncomingUpdates.status = normalizedIncomingUpdates.orderStatus;
  }
  if (
    Object.prototype.hasOwnProperty.call(
      normalizedIncomingUpdates,
      "order_status",
    )
  ) {
    normalizedIncomingUpdates.status = normalizedIncomingUpdates.order_status;
  }

  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "status")) {
    const normalizedStatus = normalizeOrderStatusInput(
      normalizedIncomingUpdates.status,
    );
    if (!ALLOWED_ORDER_STATUSES.includes(normalizedStatus)) {
      const invalidStatusError = new Error("Invalid status value");
      invalidStatusError.code = "INVALID_STATUS";
      throw invalidStatusError;
    }
    if (!changedBy) {
      const authError = new Error("Unauthorized");
      authError.code = "UNAUTHORIZED";
      throw authError;
    }
    normalizedIncomingUpdates.status = normalizedStatus;
    normalizedIncomingUpdates.orderStatus = normalizedStatus;
    nextStatus = normalizedStatus;
    shouldLogStatusChange = nextStatus !== existingOrder.status;
  }

  // Keep common aliases in sync so list/detail pages read same values.
  if (
    Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "firstName")
  ) {
    normalizedIncomingUpdates.full_name = normalizedIncomingUpdates.firstName;
  }
  if (
    Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "full_name")
  ) {
    normalizedIncomingUpdates.firstName = normalizedIncomingUpdates.full_name;
  }
  if (
    Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "mobile")
  ) {
    normalizedIncomingUpdates.phone = normalizedIncomingUpdates.mobile;
  }
  if (
    Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "phone")
  ) {
    normalizedIncomingUpdates.mobile = normalizedIncomingUpdates.phone;
  }
  for (const key of [
    "phone2",
    "phone_2",
    "secondaryPhone",
    "secondary_phone",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, key)) {
      continue;
    }
    const s = String(normalizedIncomingUpdates[key] ?? "").trim();
    if (s) {
      normalizedIncomingUpdates.phone2 = s;
      normalizedIncomingUpdates.phone_2 = s;
      normalizedIncomingUpdates.secondaryPhone = s;
      normalizedIncomingUpdates.secondary_phone = s;
    }
    break;
  }
  if (
    Object.prototype.hasOwnProperty.call(
      normalizedIncomingUpdates,
      "orderSource",
    )
  ) {
    normalizedIncomingUpdates.order_source =
      normalizedIncomingUpdates.orderSource;
  }
  if (
    Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "orderType")
  ) {
    normalizedIncomingUpdates.order_type = normalizedIncomingUpdates.orderType;
  }
  if (
    Object.prototype.hasOwnProperty.call(
      normalizedIncomingUpdates,
      "shippingStatus",
    )
  ) {
    normalizedIncomingUpdates.shipping_status =
      normalizedIncomingUpdates.shippingStatus;
  }
  if (
    Object.prototype.hasOwnProperty.call(
      normalizedIncomingUpdates,
      "shipping_status",
    )
  ) {
    normalizedIncomingUpdates.shippingStatus =
      normalizedIncomingUpdates.shipping_status;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      normalizedIncomingUpdates,
      "order_source",
    )
  ) {
    const v = normalizeMetaString(normalizedIncomingUpdates.order_source);
    if (!ORDER_SOURCES.includes(v)) {
      const invalidStatusError = new Error("Invalid order_source");
      invalidStatusError.code = "INVALID_ORDER_META";
      throw invalidStatusError;
    }
    normalizedIncomingUpdates.order_source = v;
  }
  if (
    Object.prototype.hasOwnProperty.call(
      normalizedIncomingUpdates,
      "order_type",
    )
  ) {
    const v = normalizeMetaString(normalizedIncomingUpdates.order_type);
    if (!ORDER_TYPES.includes(v)) {
      const invalidStatusError = new Error("Invalid order_type");
      invalidStatusError.code = "INVALID_ORDER_META";
      throw invalidStatusError;
    }
    normalizedIncomingUpdates.order_type = v;
  }
  if (
    Object.prototype.hasOwnProperty.call(
      normalizedIncomingUpdates,
      "shipping_status",
    )
  ) {
    const v = normalizeMetaString(normalizedIncomingUpdates.shipping_status);
    if (!SHIPPING_STATUSES.includes(v)) {
      const invalidStatusError = new Error("Invalid shipping_status");
      invalidStatusError.code = "INVALID_ORDER_META";
      throw invalidStatusError;
    }
    normalizedIncomingUpdates.shipping_status = v;
  }

  const mergedRawData = {
    ...(existingOrder.raw_data || {}),
    ...normalizedIncomingUpdates,
  };
  syncCustomerPhoneAliases(mergedRawData);
  syncShippingStatusAliases(mergedRawData);
  syncBostaLocationAliases(mergedRawData);
  syncOrderCartItemsBostaFields(mergedRawData);

  if (changedBy) {
    mergedRawData.updated_by_employee_id = changedBy;
    mergedRawData.updatedByEmployeeId = changedBy;
    if (
      actor &&
      typeof actor === "object" &&
      actor.email != null &&
      String(actor.email).trim() !== ""
    ) {
      mergedRawData.updated_by_email = String(actor.email).trim();
    }
  }

  const { data, error } = await supabase
    .from(ORDERS_TABLE)
    .update({
      raw_data: mergedRawData,
      status: nextStatus,
    })
    .eq("order_id", orderId)
    .select()
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to update order");
  }

  if (shouldLogStatusChange) {
    await insertOrderStatusLog({
      orderId: data.order_id,
      oldStatus: existingOrder.status,
      newStatus: data.status,
      changedBy,
    });
  }

  return mapStoredOrderToClient(data);
}

const STATS_STATUS_KEYS = {
  canceled: "canceled",
  no_replay: "no_replay",
  follow_up: "follow up",
  repeater: "repeater",
  Confirmed: "Confirmed",
  Shipped: "Shipped",
  new: "new",
};

/** حالات تُحسب في totalOrders / trend (طلبات المتجر قد تأتي pending قبل new). */
const STATS_COUNTABLE_DB_STATUSES = [...ALLOWED_ORDER_STATUSES, "pending"];

function dbStatusesForStatsBucket(statsKey) {
  const db = STATS_STATUS_KEYS[statsKey];
  if (!db) return [];
  if (statsKey === "new") return ["new", "pending"];
  return [db];
}

const EMPLOYEE_RAW_ID_KEYS = [
  "modifier_employee_id",
  "updated_by_employee_id",
  "updatedByEmployeeId",
  "created_by_employee_id",
  "createdByEmployeeId",
  "assigned_employee_id",
];

function rawDataShowsEmployeeTouch(raw, employeeKey, employeeEmail) {
  if (!raw || typeof raw !== "object") return false;
  const id = String(employeeKey || "").trim();
  if (id) {
    for (const key of EMPLOYEE_RAW_ID_KEYS) {
      if (String(raw[key] || "").trim() === id) return true;
    }
  }
  const email = String(employeeEmail || "").trim().toLowerCase();
  if (!email) return false;
  for (const key of ["updated_by_email", "user_email", "created_by_email"]) {
    if (String(raw[key] || "").trim().toLowerCase() === email) return true;
  }
  return false;
}

function orderRowCountsForEmployeeScope(row, employeeScope) {
  if (!employeeScope) return true;
  const raw =
    row?.raw_data && typeof row.raw_data === "object" && !Array.isArray(row.raw_data)
      ? row.raw_data
      : {};
  const orderId = String(row?.order_id || raw?.id || raw?.sourceOrderId || "").trim();
  if (orderId && employeeScope.logOrderIds.has(orderId)) return true;
  return rawDataShowsEmployeeTouch(
    raw,
    employeeScope.employeeKey,
    employeeScope.employeeEmail,
  );
}

async function filterOrderIdsForEmployeeScope(orderIds, employeeScope) {
  if (!employeeScope || !Array.isArray(orderIds) || !orderIds.length) {
    return orderIds || [];
  }
  const kept = [];
  for (const chunk of chunkArray(orderIds, IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from(ORDERS_TABLE)
      .select("order_id,raw_data")
      .in("order_id", chunk);
    if (error) {
      throw new Error(error.message);
    }
    for (const row of data || []) {
      if (orderRowCountsForEmployeeScope(row, employeeScope)) {
        kept.push(String(row.order_id).trim());
      }
    }
  }
  return kept;
}

const IN_CHUNK_SIZE = 120;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

const ORDER_ID_IN_URL_CHUNK = 80;

const PostgrestReservedCharsRegexp = new RegExp("[,()]");

/** PostgREST يفرض أحرفاً محجوزة داخل in.(...) — نقترب من منطق supabase-js.in */
function encodeOrderIdForInList(id) {
  const s = String(id).trim();
  if (!s) return null;
  if (PostgrestReservedCharsRegexp.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** فلتر order_id.in — يتقسّم إلى or(in1,in2,...) لتجنب URL طويل جداً */
function applyOrderIdMembershipFilter(query, orderIds) {
  const ids = [
    ...new Set((orderIds || []).map((x) => String(x).trim()).filter(Boolean)),
  ];
  if (!ids.length) return query;
  if (ids.length <= ORDER_ID_IN_URL_CHUNK) {
    return query.in("order_id", ids);
  }
  const orParts = [];
  for (let i = 0; i < ids.length; i += ORDER_ID_IN_URL_CHUNK) {
    const inner = ids
      .slice(i, i + ORDER_ID_IN_URL_CHUNK)
      .map(encodeOrderIdForInList)
      .filter(Boolean)
      .join(",");
    if (inner) {
      orParts.push(`order_id.in.(${inner})`);
    }
  }
  if (!orParts.length) return query;
  return query.or(orParts.join(","));
}

function buildEmptyStatsBreakdownResponse() {
  const byOrderSource = Object.fromEntries(ORDER_SOURCES.map((s) => [s, 0]));
  const byOrderType = Object.fromEntries(ORDER_TYPES.map((t) => [t, 0]));
  const byShippingStatus = Object.fromEntries(
    SHIPPING_STATUSES.map((s) => [s, 0]),
  );
  const byOrderStatus = {
    canceled: 0,
    no_replay: 0,
    follow_up: 0,
    repeater: 0,
    Confirmed: 0,
    Shipped: 0,
    new: 0,
    newOrders: 0,
    confirmedOrders: 0,
    shippedOrders: 0,
    canceledOrders: 0,
    noReplyOrders: 0,
    followUpOrders: 0,
    repeaterOrders: 0,
  };
  return {
    totalOrders: 0,
    total: 0,
    totalProductUnits: 0,
    averageUnitsPerOrder: null,
    averageOrderValue: null,
    canceled: 0,
    no_replay: 0,
    follow_up: 0,
    repeater: 0,
    Confirmed: 0,
    Shipped: 0,
    new: 0,
    newOrders: 0,
    confirmedOrders: 0,
    shippedOrders: 0,
    canceledOrders: 0,
    noReplyOrders: 0,
    followUpOrders: 0,
    repeaterOrders: 0,
    byOrderStatus,
    byOrderSource,
    byOrderType,
    byShippingStatus,
  };
}

/**
 * Order counts by orders.status with the same filters as the list (employee, meta,
 * product, optional status). employeeId uses logs + raw_data markers like getWebhookOrders.
 * status filter narrows the universe; other status buckets are zero.
 * from/to on orders.created_at when set (including with employeeId); employee_scope=all_time
 * skips order created_at and uses unbounded logs/markers.
 */
async function getOrdersStatistics({
  employeeId,
  from,
  to,
  ignoreEmployeeLogDateRange = false,
  order_source,
  order_type,
  shipping_status,
  status: listStatusFilter,
  product_id,
  product_sku,
}) {
  let orderIds = null;
  let employeeScope = null;
  const filterOrdersByCreatedAtInRange =
    shouldFilterOrdersByCreatedAtWithEmployee({
      from,
      to,
      employeeId,
      ignoreEmployeeLogDateRange,
    });

  if (employeeId) {
    const scoped = await resolveEmployeeScopedOrderIds({
      employeeId,
      from,
      to,
      ignoreEmployeeLogDateRange,
    });
    if (scoped.notFound) {
      return buildEmptyStatsBreakdownResponse();
    }

    orderIds = scoped.orderIds;
    employeeScope = {
      logOrderIds: scoped.logOrderIds,
      employeeKey: scoped.employeeKey,
      employeeEmail: scoped.employeeEmail,
    };
    orderIds = await filterOrderIdsForEmployeeScope(orderIds, employeeScope);

    if (!orderIds.length) {
      return buildEmptyStatsBreakdownResponse();
    }
  }

  const chunks =
    orderIds == null ? [null] : chunkArray(orderIds, IN_CHUNK_SIZE);

  const listStatusFilterNorm =
    listStatusFilter != null && String(listStatusFilter).trim() !== ""
      ? String(listStatusFilter).trim()
      : null;

  function applyStatsRawContains(query, breakdownDim, breakdownValue) {
    let q = query;

    const effectiveOrderSource =
      breakdownDim === "order_source"
        ? breakdownValue
        : order_source || null;
    const effectiveOrderType =
      breakdownDim === "order_type" ? breakdownValue : order_type || null;
    const effectiveShipping =
      breakdownDim === "shipping_status"
        ? breakdownValue
        : shipping_status || null;

    if (effectiveOrderSource) {
      q = applyRawDataOrderSourceContainsOr(q, effectiveOrderSource);
    }
    if (effectiveOrderType) {
      q = applyRawDataOrderTypeContainsOr(q, effectiveOrderType);
    }
    if (effectiveShipping) {
      q = applyRawDataShippingStatusContainsOr(q, effectiveShipping);
    }

    return q;
  }

  const pidForStats = normalizeProductIdForCartFilter(product_id);
  const skuForStats = parseProductFilterInput(product_sku);
  const useProductUuidContains =
    pidForStats && UUID_LIKE.test(pidForStats) && !skuForStats;

  function applyStatsOrderChunkAndProductFilter(q, chunk) {
    let nextQ = q;
    if (chunk && chunk.length) {
      nextQ = nextQ.in("order_id", chunk);
    }
    if (useProductUuidContains) {
      nextQ = applyProductUuidCartContainsOr(nextQ, pidForStats);
    }
    return { nextQ, skip: false };
  }

  async function countAggregatedOrders(
    breakdownDim,
    breakdownValue,
    options = {},
  ) {
    const { onlyOrderStatus } = options;
    let sum = 0;
    for (const chunk of chunks) {
      let q = supabase.from(ORDERS_TABLE).select("order_id,raw_data,status");

      const scoped = applyStatsOrderChunkAndProductFilter(q, chunk);
      if (scoped.skip) continue;
      q = scoped.nextQ;

      if (from && filterOrdersByCreatedAtInRange) {
        q = q.gte("created_at", from.toISOString());
      }
      if (to && filterOrdersByCreatedAtInRange) {
        q = q.lte("created_at", to.toISOString());
      }
      q = applyStatsRawContains(q, breakdownDim, breakdownValue);
      if (!useProductUuidContains) {
        q = applyProductCartIlikeFilters(q, { product_id, product_sku });
      }
      if (onlyOrderStatus) {
        q = q.eq("status", onlyOrderStatus);
      } else if (listStatusFilterNorm != null) {
        const statuses =
          listStatusFilterNorm === "pending"
            ? ["new", "pending"]
            : [listStatusFilterNorm];
        q = q.in("status", statuses);
      } else {
        q = q.in("status", STATS_COUNTABLE_DB_STATUSES);
      }

      let offset = 0;
      for (;;) {
        const { data, error } = await q.range(
          offset,
          offset + LOG_SELECT_PAGE_SIZE - 1,
        );
        if (error) throw new Error(error.message);
        if (!data?.length) break;

        for (const row of data) {
          if (orderRowCountsForEmployeeScope(row, employeeScope)) {
            sum += 1;
          }
        }

        if (data.length < LOG_SELECT_PAGE_SIZE) break;
        offset += LOG_SELECT_PAGE_SIZE;
      }
    }
    return sum;
  }

  async function countWithChunks(statsKey) {
    const dbStatuses = dbStatusesForStatsBucket(statsKey);
    if (!dbStatuses.length) return 0;

    if (
      listStatusFilterNorm != null &&
      !dbStatuses.includes(listStatusFilterNorm) &&
      !(listStatusFilterNorm === "pending" && statsKey === "new")
    ) {
      return 0;
    }

    let sum = 0;
    for (const chunk of chunks) {
      let q = supabase.from(ORDERS_TABLE).select("order_id,raw_data,status");

      const scoped = applyStatsOrderChunkAndProductFilter(q, chunk);
      if (scoped.skip) continue;
      q = scoped.nextQ;

      if (from && filterOrdersByCreatedAtInRange) {
        q = q.gte("created_at", from.toISOString());
      }
      if (to && filterOrdersByCreatedAtInRange) {
        q = q.lte("created_at", to.toISOString());
      }
      q = applyStatsRawContains(q, null, null);
      if (!useProductUuidContains) {
        q = applyProductCartIlikeFilters(q, { product_id, product_sku });
      }
      q = q.in("status", dbStatuses);

      let offset = 0;
      for (;;) {
        const { data, error } = await q.range(
          offset,
          offset + LOG_SELECT_PAGE_SIZE - 1,
        );
        if (error) throw new Error(error.message);
        if (!data?.length) break;

        for (const row of data) {
          if (orderRowCountsForEmployeeScope(row, employeeScope)) {
            sum += 1;
          }
        }

        if (data.length < LOG_SELECT_PAGE_SIZE) break;
        offset += LOG_SELECT_PAGE_SIZE;
      }
    }
    return sum;
  }

  const byStatus = {};
  for (const key of Object.keys(STATS_STATUS_KEYS)) {
    byStatus[key] = await countWithChunks(key);
  }

  let totalOrders = 0;
  for (const chunk of chunks) {
    let q = supabase.from(ORDERS_TABLE).select("order_id,raw_data,status");

    const scoped = applyStatsOrderChunkAndProductFilter(q, chunk);
    if (scoped.skip) continue;
    q = scoped.nextQ;

    if (from && filterOrdersByCreatedAtInRange) {
      q = q.gte("created_at", from.toISOString());
    }
    if (to && filterOrdersByCreatedAtInRange) {
      q = q.lte("created_at", to.toISOString());
    }
    q = applyStatsRawContains(q, null, null);
    if (!useProductUuidContains) {
      q = applyProductCartIlikeFilters(q, { product_id, product_sku });
    }
    if (listStatusFilterNorm != null) {
      const statuses =
        listStatusFilterNorm === "pending"
          ? ["new", "pending"]
          : [listStatusFilterNorm];
      q = q.in("status", statuses);
    } else {
      q = q.in("status", STATS_COUNTABLE_DB_STATUSES);
    }

    let offset = 0;
    for (;;) {
      const { data, error } = await q.range(
        offset,
        offset + LOG_SELECT_PAGE_SIZE - 1,
      );
      if (error) throw new Error(error.message);
      if (!data?.length) break;

      for (const row of data) {
        if (orderRowCountsForEmployeeScope(row, employeeScope)) {
          totalOrders += 1;
        }
      }

      if (data.length < LOG_SELECT_PAGE_SIZE) break;
      offset += LOG_SELECT_PAGE_SIZE;
    }
  }

  const byOrderSource = {};
  for (const src of ORDER_SOURCES) {
    byOrderSource[src] = await countAggregatedOrders("order_source", src);
  }

  const byOrderType = {};
  for (const typ of ORDER_TYPES) {
    byOrderType[typ] = await countAggregatedOrders("order_type", typ);
  }

  /** حالة الشحن في raw_data تُفترض in_progress عند الإنشاء — نحسبها فقط للطلبات المشحونة (status=Shipped). */
  const byShippingStatus = {};
  if (byStatus.Shipped > 0) {
    for (const sh of SHIPPING_STATUSES) {
      byShippingStatus[sh] = await countAggregatedOrders(
        "shipping_status",
        sh,
        { onlyOrderStatus: "Shipped" },
      );
    }
  } else {
    for (const sh of SHIPPING_STATUSES) {
      byShippingStatus[sh] = 0;
    }
  }

  const byOrderStatus = {
    canceled: byStatus.canceled,
    no_replay: byStatus.no_replay,
    follow_up: byStatus.follow_up,
    repeater: byStatus.repeater,
    Confirmed: byStatus.Confirmed,
    Shipped: byStatus.Shipped,
    new: byStatus.new,
    newOrders: byStatus.new,
    confirmedOrders: byStatus.Confirmed,
    shippedOrders: byStatus.Shipped,
    canceledOrders: byStatus.canceled,
    noReplyOrders: byStatus.no_replay,
    followUpOrders: byStatus.follow_up,
    repeaterOrders: byStatus.repeater,
  };

  const productIdForUnitSum =
    pidForStats && UUID_LIKE.test(pidForStats) ? pidForStats : null;

  let totalProductUnits = 0;
  let total = 0;
  for (const chunk of chunks) {
    let offset = 0;
    for (;;) {
      let q = supabase.from(ORDERS_TABLE).select("raw_data");
      const scoped = applyStatsOrderChunkAndProductFilter(q, chunk);
      if (scoped.skip) break;
      q = scoped.nextQ;

      if (from && filterOrdersByCreatedAtInRange) {
        q = q.gte("created_at", from.toISOString());
      }
      if (to && filterOrdersByCreatedAtInRange) {
        q = q.lte("created_at", to.toISOString());
      }
      q = applyStatsRawContains(q, null, null);
      if (!useProductUuidContains) {
        q = applyProductCartIlikeFilters(q, { product_id, product_sku });
      }
      if (listStatusFilterNorm != null) {
        q = q.eq("status", listStatusFilterNorm);
      }

      q = q.range(offset, offset + LOG_SELECT_PAGE_SIZE - 1);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;

      for (const row of data) {
        if (!orderRowCountsForEmployeeScope(row, employeeScope)) {
          continue;
        }
        const raw =
          row.raw_data &&
          typeof row.raw_data === "object" &&
          !Array.isArray(row.raw_data)
            ? row.raw_data
            : {};
        totalProductUnits += sumLineQuantitiesFromRaw(raw, {
          productIdFilter: productIdForUnitSum,
        });
        total += pickOrderTotalCost(raw);
      }

      if (data.length < LOG_SELECT_PAGE_SIZE) break;
      offset += LOG_SELECT_PAGE_SIZE;
    }
  }

  const averageUnitsPerOrder =
    totalOrders > 0 ? totalProductUnits / totalOrders : null;
  const averageOrderValue = totalOrders > 0 ? total / totalOrders : null;

  return {
    totalOrders,
    total,
    totalProductUnits,
    averageUnitsPerOrder,
    averageOrderValue,
    canceled: byStatus.canceled,
    no_replay: byStatus.no_replay,
    follow_up: byStatus.follow_up,
    repeater: byStatus.repeater,
    Confirmed: byStatus.Confirmed,
    Shipped: byStatus.Shipped,
    new: byStatus.new,
    newOrders: byStatus.new,
    confirmedOrders: byStatus.Confirmed,
    shippedOrders: byStatus.Shipped,
    canceledOrders: byStatus.canceled,
    noReplyOrders: byStatus.no_replay,
    followUpOrders: byStatus.follow_up,
    repeaterOrders: byStatus.repeater,
    byOrderStatus,
    byOrderSource,
    byOrderType,
    byShippingStatus,
  };
}

const MAX_ANALYTICS_ROWS = 50000;

function analyticsFirstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const s = String(value).trim();
    if (s) return s;
  }
  return "";
}

function parseCartItemsArray(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  let c = raw.cart_items ?? raw.cartItems;
  if (c == null) return [];
  if (typeof c === "string") {
    try {
      const p = JSON.parse(c);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(c) ? c : [];
}

/**
 * كمية السطر في الطلب — من السطر أو الـ variant فقط.
 * لا نستخدم product.quantity: في EasyOrder هو مخزون المنتج (stock) وليس كمية الطلب.
 */
function pickLineQuantity(line) {
  if (!line || typeof line !== "object") return 0;
  const variant =
    line.variant && typeof line.variant === "object" ? line.variant : {};
  const candidates = [
    line.quantity,
    line.qty,
    line.count,
    variant.quantity,
    variant.qty,
    variant.count,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (
    line.product_id != null ||
    line.productId != null ||
    (line.product &&
      typeof line.product === "object" &&
      line.product.id != null)
  ) {
    return 1;
  }
  return 0;
}

function lineMatchesProductIdFilter(line, productIdFilter) {
  if (!productIdFilter) return true;
  const needle = String(productIdFilter).trim().toLowerCase();
  if (!needle) return true;
  const product =
    line?.product && typeof line.product === "object" ? line.product : {};
  const candidates = [
    line?.product_id,
    line?.productId,
    line?.id,
    line?.easyorder_id,
    product?.id,
    product?.product_id,
    product?.productId,
    product?.easyorder_id,
    product?.easyorderId,
  ];
  return candidates.some(
    (c) => c != null && String(c).trim().toLowerCase() === needle,
  );
}

/**
 * إجمالي القطع = مجموع quantity لأسطر cart_items (من السطر أو variant، وليس مخزون product).
 * @param {{ productIdFilter?: string }} options — عند فلتر منتج UUID نجمع أسطر ذلك المنتج فقط.
 */
function sumLineQuantitiesFromRaw(raw, options = {}) {
  const { productIdFilter } = options;
  return parseCartItemsArray(raw).reduce((s, line) => {
    if (!lineMatchesProductIdFilter(line, productIdFilter)) return s;
    return s + pickLineQuantity(line);
  }, 0);
}

function resolveLineProductId(line) {
  if (!line || typeof line !== "object") return null;
  const product =
    line.product && typeof line.product === "object" ? line.product : {};
  const candidates = [
    line.product_id,
    line.productId,
    line.easyorder_id,
    line.easyorderId,
    product.id,
    product.product_id,
    product.productId,
    product.easyorder_id,
    product.easyorderId,
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const value = String(candidate).trim();
    if (value) return value;
  }
  const sku = analyticsFirstNonEmpty(
    product.sku,
    line.sku,
    line.variant?.sku,
  );
  if (sku) return `sku:${sku}`;
  return null;
}

function resolveLineProductLabel(line) {
  if (!line || typeof line !== "object") {
    return { name: null, sku: null };
  }
  const product =
    line.product && typeof line.product === "object" ? line.product : {};
  const variant =
    line.variant && typeof line.variant === "object" ? line.variant : {};
  return {
    name:
      analyticsFirstNonEmpty(
        product.name,
        line.name,
        line.product_name,
        product.title,
        line.title,
      ) || null,
    sku:
      analyticsFirstNonEmpty(
        product.sku,
        line.sku,
        variant.sku,
        product.code,
        line.product_sku,
      ) || null,
  };
}

function pickLineUnitPrice(line) {
  if (!line || typeof line !== "object") return 0;
  const product =
    line.product && typeof line.product === "object" ? line.product : {};
  const variant =
    line.variant && typeof line.variant === "object" ? line.variant : {};
  const candidates = [
    line.price,
    line.unit_price,
    line.unitPrice,
    variant.sale_price,
    variant.price,
    product.sale_price,
    product.price,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

function pickLineRevenue(line) {
  return pickLineQuantity(line) * pickLineUnitPrice(line);
}

/** مبيعات الطلب الواحد — نفس منطق `total` في قائمة الطلبات: total_cost ثم cost */
function pickOrderTotalCost(raw) {
  if (!raw || typeof raw !== "object") return 0;
  const total = Number(raw.total_cost);
  if (Number.isFinite(total)) return total;
  const cost = Number(raw.cost);
  if (Number.isFinite(cost)) return cost;
  return 0;
}

function incrementAnalyticsBucket(map, key) {
  const k =
    key != null && String(key).trim() !== ""
      ? String(key).trim()
      : "__unset";
  map[k] = (map[k] || 0) + 1;
}

function aggregateOrdersAnalyticsRows(rows, options = {}) {
  const { productIdFilter = null } = options;
  const byOrderSource = Object.create(null);
  const byOrderType = Object.create(null);
  const byOrderStatus = Object.create(null);
  const byShippingStatus = Object.create(null);
  let totalCost = 0;
  let totalProductUnits = 0;

  for (const row of rows) {
    const raw =
      row.raw_data &&
      typeof row.raw_data === "object" &&
      !Array.isArray(row.raw_data)
        ? row.raw_data
        : {};

    totalCost += pickOrderTotalCost(raw);
    totalProductUnits += sumLineQuantitiesFromRaw(raw, { productIdFilter });

    const orderSource = analyticsFirstNonEmpty(
      raw.order_source,
      raw.orderSource,
    );
    const orderType = analyticsFirstNonEmpty(raw.order_type, raw.orderType);
    const shippingStatus = resolveEffectiveShippingStatus(raw);
    const orderStatus =
      row.status != null && String(row.status).trim() !== ""
        ? String(row.status).trim()
        : "";

    incrementAnalyticsBucket(byOrderSource, orderSource || "__unset");
    incrementAnalyticsBucket(byOrderType, orderType || "__unset");
    if (orderStatus === "Shipped") {
      incrementAnalyticsBucket(byShippingStatus, shippingStatus || "__unset");
    }
    incrementAnalyticsBucket(byOrderStatus, orderStatus || "__unset");
  }

  const totalOrders = rows.length;
  const averageOrderValue =
    totalOrders > 0 ? totalCost / totalOrders : null;
  const averageUnitsPerOrder =
    totalOrders > 0 ? totalProductUnits / totalOrders : null;

  return {
    totalOrders,
    totalCost,
    totalProductUnits,
    averageUnitsPerOrder,
    averageOrderValue,
    byOrderSource,
    byOrderType,
    byOrderStatus,
    byShippingStatus,
  };
}

async function fetchAnalyticsOrderRows({
  product_id,
  product_sku,
  employeeId,
  from,
  to,
  ignoreEmployeeLogDateRange = false,
}) {
  let orderIdsByEmployee = null;

  if (employeeId) {
    const scoped = await resolveEmployeeScopedOrderIds({
      employeeId,
      from,
      to,
      ignoreEmployeeLogDateRange,
    });
    if (scoped.notFound) {
      return { rows: [], truncated: false };
    }

    orderIdsByEmployee = scoped.orderIds;

    if (!orderIdsByEmployee.length) {
      return { rows: [], truncated: false };
    }
  }

  function applyNonProductFilters(q) {
    if (from) {
      q = q.gte("created_at", from.toISOString());
    }
    if (to) {
      q = q.lte("created_at", to.toISOString());
    }
    if (orderIdsByEmployee) {
      q = applyOrderIdMembershipFilter(q, orderIdsByEmployee);
    }
    return q;
  }

  const pidNeedle = normalizeProductIdForCartFilter(product_id);
  const skuNeedle = parseProductFilterInput(product_sku);
  const useProductUuidContains =
    pidNeedle && UUID_LIKE.test(pidNeedle) && !skuNeedle;

  const rows = [];
  let truncated = false;
  let offset = 0;

  for (;;) {
    if (rows.length >= MAX_ANALYTICS_ROWS) {
      truncated = true;
      break;
    }

    const remaining = MAX_ANALYTICS_ROWS - rows.length;
    const pageSize = Math.min(LOG_SELECT_PAGE_SIZE, remaining);

    let q = supabase
      .from(ORDERS_TABLE)
      .select("order_id,status,raw_data")
      .order("created_at", { ascending: false });

    q = applyNonProductFilters(q);
    if (useProductUuidContains) {
      q = applyProductUuidCartContainsOr(q, pidNeedle);
    } else {
      q = applyProductCartIlikeFilters(q, { product_id, product_sku });
    }

    q = q.range(offset, offset + pageSize - 1);

    const { data, error } = await q;
    if (error) {
      throw new Error(error.message);
    }
    if (!data || data.length === 0) {
      break;
    }
    rows.push(...data);
    if (data.length < pageSize) {
      break;
    }
    offset += pageSize;
  }

  return { rows, truncated };
}

/**
 * Aggregated analytics: required product (UUID), optional employee, optional
 * orders.created_at range. Product id in product_id or easyorder_id; cart match
 * uses @> (no SKU). If product_sku is also set, JSON ilike filters are combined.
 * totalCost sums total_cost or cost; averageUnitsPerOrder = line quantities / orders;
 * averageOrderValue = totalCost / totalOrders.
 */
async function getOrdersAnalyticsReport({
  product_id,
  product_sku,
  employeeId,
  from,
  to,
  ignoreEmployeeLogDateRange = false,
}) {
  const { rows, truncated } = await fetchAnalyticsOrderRows({
    product_id,
    product_sku,
    employeeId,
    from,
    to,
    ignoreEmployeeLogDateRange,
  });
  const pid = normalizeProductIdForCartFilter(product_id);
  const productIdForUnitSum =
    pid && UUID_LIKE.test(pid) && !parseProductFilterInput(product_sku)
      ? pid
      : null;
  const agg = aggregateOrdersAnalyticsRows(rows, {
    productIdFilter: productIdForUnitSum,
  });
  return { ...agg, truncated, maxRowsCap: MAX_ANALYTICS_ROWS };
}

const MAX_TREND_ROWS = 50000;

function emptyTrendBucket() {
  return {
    totalOrders: 0,
    shippedOrders: 0,
    successfulOrders: 0,
    total: 0,
    totalProductUnits: 0,
    averageUnitsPerOrder: null,
    averageOrderValue: null,
  };
}

function finalizeTrendBucket(bucket) {
  const averageUnitsPerOrder =
    bucket.totalOrders > 0 ? bucket.totalProductUnits / bucket.totalOrders : null;
  const averageOrderValue =
    bucket.totalOrders > 0 ? bucket.total / bucket.totalOrders : null;
  return {
    totalOrders: bucket.totalOrders,
    shippedOrders: bucket.shippedOrders || 0,
    successfulOrders: bucket.successfulOrders || 0,
    total: bucket.total,
    totalProductUnits: bucket.totalProductUnits,
    averageUnitsPerOrder,
    averageOrderValue,
  };
}

/** YYYY-MM-DD بالتوقيت المحلي — يطابق getDefaultDateRange في الـ controller */
function formatLocalCalendarDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** مفتاح التجميع للرسم البياني: يوم / أسبوع (بداية الاثنين محليًا) / شهر */
function bucketKeyFromDate(date, granularity) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;

  if (granularity === "month") {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  if (granularity === "week") {
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setDate(d.getDate() + diff);
    monday.setHours(0, 0, 0, 0);
    return formatLocalCalendarDateKey(monday);
  }

  return formatLocalCalendarDateKey(d);
}

function listTrendBucketKeys(from, to, granularity) {
  const keys = [];
  const cur = new Date(from);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);

  if (granularity === "day") {
    while (cur <= end) {
      keys.push(formatLocalCalendarDateKey(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return keys;
  }

  if (granularity === "week") {
    while (cur <= end) {
      const k = bucketKeyFromDate(cur, "week");
      if (k && !keys.includes(k)) keys.push(k);
      cur.setDate(cur.getDate() + 7);
    }
    return keys;
  }

  if (granularity === "month") {
    const seen = new Set();
    const walk = new Date(cur);
    while (walk <= end) {
      const k = bucketKeyFromDate(walk, "month");
      if (k && !seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
      walk.setMonth(walk.getMonth() + 1);
    }
    return keys;
  }

  return keys;
}

/**
 * Time-series for charts: same filters as GET /stats, bucketed by day (default), week, or month.
 * Default range when from/to omitted: caller should pass current month (see controller).
 */
async function getOrdersStatsTimeSeries({
  from,
  to,
  granularity = "day",
  employeeId,
  ignoreEmployeeLogDateRange = false,
  order_source,
  order_type,
  shipping_status,
  status: listStatusFilter,
  product_id,
  product_sku,
  useEgyptBuckets = false,
}) {
  const gran =
    granularity === "week" || granularity === "month" ? granularity : "day";

  const bucketKeyForDate = useEgyptBuckets
    ? (date, g) => getEgyptTrendBucketKey(date, g)
    : (date, g) => bucketKeyFromDate(date, g);
  const listBucketKeys = useEgyptBuckets
    ? (f, t, g) => listEgyptTrendBucketKeys(f, t, g)
    : (f, t, g) => listTrendBucketKeys(f, t, g);

  let orderIds = null;
  let employeeScope = null;
  const filterOrdersByCreatedAtInRange =
    shouldFilterOrdersByCreatedAtWithEmployee({
      from,
      to,
      employeeId,
      ignoreEmployeeLogDateRange,
    });

  if (employeeId) {
    const scoped = await resolveEmployeeScopedOrderIds({
      employeeId,
      from,
      to,
      ignoreEmployeeLogDateRange,
    });
    if (scoped.notFound) {
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        granularity: gran,
        points: listBucketKeys(from, to, gran).map((date) => ({
          date,
          ...emptyTrendBucket(),
        })),
        summary: emptyTrendBucket(),
        truncated: false,
      };
    }

    orderIds = scoped.orderIds;
    employeeScope = {
      logOrderIds: scoped.logOrderIds,
      employeeKey: scoped.employeeKey,
      employeeEmail: scoped.employeeEmail,
    };
    orderIds = await filterOrderIdsForEmployeeScope(orderIds, employeeScope);

    if (!orderIds.length) {
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        granularity: gran,
        points: listBucketKeys(from, to, gran).map((date) => ({
          date,
          ...emptyTrendBucket(),
        })),
        summary: emptyTrendBucket(),
        truncated: false,
      };
    }
  }

  const chunks =
    orderIds == null ? [null] : chunkArray(orderIds, IN_CHUNK_SIZE);

  const listStatusFilterNorm =
    listStatusFilter != null && String(listStatusFilter).trim() !== ""
      ? String(listStatusFilter).trim()
      : null;

  function applyStatsRawContains(query, breakdownDim, breakdownValue) {
    let q = query;
    const effectiveOrderSource =
      breakdownDim === "order_source"
        ? breakdownValue
        : order_source || null;
    const effectiveOrderType =
      breakdownDim === "order_type" ? breakdownValue : order_type || null;
    const effectiveShipping =
      breakdownDim === "shipping_status"
        ? breakdownValue
        : shipping_status || null;
    if (effectiveOrderSource) {
      q = applyRawDataOrderSourceContainsOr(q, effectiveOrderSource);
    }
    if (effectiveOrderType) {
      q = applyRawDataOrderTypeContainsOr(q, effectiveOrderType);
    }
    if (effectiveShipping) {
      q = applyRawDataShippingStatusContainsOr(q, effectiveShipping);
    }
    return q;
  }

  const pidForStats = normalizeProductIdForCartFilter(product_id);
  const skuForStats = parseProductFilterInput(product_sku);
  const useProductUuidContainsTrend =
    pidForStats && UUID_LIKE.test(pidForStats) && !skuForStats;

  function applyStatsOrderChunkAndProductFilter(q, chunk) {
    let nextQ = q;
    if (chunk && chunk.length) {
      nextQ = nextQ.in("order_id", chunk);
    }
    if (useProductUuidContainsTrend) {
      nextQ = applyProductUuidCartContainsOr(nextQ, pidForStats);
    }
    return { nextQ, skip: false };
  }

  const productIdForUnitSum =
    pidForStats && UUID_LIKE.test(pidForStats) ? pidForStats : null;

  const bucketMap = new Map();
  let rowCount = 0;
  let truncated = false;

  for (const chunk of chunks) {
    let offset = 0;
    for (;;) {
      if (rowCount >= MAX_TREND_ROWS) {
        truncated = true;
        break;
      }

      let q = supabase
        .from(ORDERS_TABLE)
        .select("order_id,created_at,raw_data,status");
      const scoped = applyStatsOrderChunkAndProductFilter(q, chunk);
      if (scoped.skip) break;
      q = scoped.nextQ;

      if (from && filterOrdersByCreatedAtInRange) {
        q = q.gte("created_at", from.toISOString());
      }
      if (to && filterOrdersByCreatedAtInRange) {
        q = q.lte("created_at", to.toISOString());
      }
      q = applyStatsRawContains(q, null, null);
      if (!useProductUuidContainsTrend) {
        q = applyProductCartIlikeFilters(q, { product_id, product_sku });
      }
      if (listStatusFilterNorm != null) {
        const statuses =
          listStatusFilterNorm === "pending"
            ? ["new", "pending"]
            : [listStatusFilterNorm];
        q = q.in("status", statuses);
      } else {
        q = q.in("status", STATS_COUNTABLE_DB_STATUSES);
      }

      const remaining = MAX_TREND_ROWS - rowCount;
      const pageSize = Math.min(LOG_SELECT_PAGE_SIZE, remaining);
      q = q.range(offset, offset + pageSize - 1);

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;

      for (const row of data) {
        if (!orderRowCountsForEmployeeScope(row, employeeScope)) {
          continue;
        }
        rowCount += 1;
        const key = bucketKeyForDate(row.created_at, gran);
        if (!key) continue;

        if (!bucketMap.has(key)) {
          bucketMap.set(key, {
            totalOrders: 0,
            shippedOrders: 0,
            successfulOrders: 0,
            total: 0,
            totalProductUnits: 0,
          });
        }
        const b = bucketMap.get(key);
        const raw =
          row.raw_data &&
          typeof row.raw_data === "object" &&
          !Array.isArray(row.raw_data)
            ? row.raw_data
            : {};

        b.totalOrders += 1;
        if (isStatsShippedOrder(row)) {
          b.shippedOrders += 1;
        }
        if (isStatsSuccessfulOrder(row, raw)) {
          b.successfulOrders += 1;
        }
        b.total += pickOrderTotalCost(raw);
        b.totalProductUnits += sumLineQuantitiesFromRaw(raw, {
          productIdFilter: productIdForUnitSum,
        });
      }

      if (data.length < pageSize) break;
      offset += pageSize;
    }
    if (truncated) break;
  }

  const points = listBucketKeys(from, to, gran).map((date) => {
    const b = bucketMap.get(date) || {
      totalOrders: 0,
      shippedOrders: 0,
      successfulOrders: 0,
      total: 0,
      totalProductUnits: 0,
    };
    return { date, ...finalizeTrendBucket(b) };
  });

  const summaryRaw = {
    totalOrders: 0,
    shippedOrders: 0,
    successfulOrders: 0,
    total: 0,
    totalProductUnits: 0,
  };
  for (const b of bucketMap.values()) {
    summaryRaw.totalOrders += b.totalOrders;
    summaryRaw.shippedOrders += b.shippedOrders || 0;
    summaryRaw.successfulOrders += b.successfulOrders || 0;
    summaryRaw.total += b.total;
    summaryRaw.totalProductUnits += b.totalProductUnits;
  }
  const summary = finalizeTrendBucket(summaryRaw);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    granularity: gran,
    points,
    summary,
    truncated,
    maxRowsCap: MAX_TREND_ROWS,
  };
}

const MAX_PRODUCT_SALES_ROWS = 50000;
const PRODUCTS_TABLE =
  process.env.SUPABASE_PRODUCTS_TABLE || "products";

function emptyProductSalesBucket() {
  return {
    totalOrders: 0,
    totalUnits: 0,
    totalRevenue: 0,
  };
}

function finalizeProductSalesBucket(bucket) {
  return {
    totalOrders: bucket.totalOrders,
    totalUnits: bucket.totalUnits,
    totalRevenue: Math.round(bucket.totalRevenue * 100) / 100,
  };
}

async function loadProductCatalogMeta(productIds) {
  const ids = [...new Set(productIds.filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;

  for (const chunk of chunkArray(ids, IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from(PRODUCTS_TABLE)
      .select("easyorder_id,name,sku")
      .in("easyorder_id", chunk);
    if (error) continue;
    for (const row of data || []) {
      if (row?.easyorder_id == null) continue;
      map.set(String(row.easyorder_id), {
        name: row.name ?? null,
        sku: row.sku ?? null,
      });
    }
  }

  return map;
}

/**
 * Sales chart per product: time buckets with orders / units / revenue.
 * Default (no product_id): all products in range. Optional product_id narrows to one product.
 */
async function getProductSalesChart({
  from,
  to,
  granularity = "day",
  product_id,
  useEgyptBuckets = false,
}) {
  const gran =
    granularity === "week" || granularity === "month" ? granularity : "day";

  const bucketKeyForDate = useEgyptBuckets
    ? (date, g) => getEgyptTrendBucketKey(date, g)
    : (date, g) => bucketKeyFromDate(date, g);
  const listBucketKeys = useEgyptBuckets
    ? (f, t, g) => listEgyptTrendBucketKeys(f, t, g)
    : (f, t, g) => listTrendBucketKeys(f, t, g);

  const productIdFilter = normalizeProductIdForCartFilter(product_id);
  const bucketKeys = listBucketKeys(from, to, gran);

  const productMap = new Map();
  let rowCount = 0;
  let truncated = false;
  let offset = 0;

  for (;;) {
    if (rowCount >= MAX_PRODUCT_SALES_ROWS) {
      truncated = true;
      break;
    }

    let q = supabase
      .from(ORDERS_TABLE)
      .select("order_id,created_at,raw_data,status");

    if (from) {
      q = q.gte("created_at", from.toISOString());
    }
    if (to) {
      q = q.lte("created_at", to.toISOString());
    }
    q = q.in("status", STATS_COUNTABLE_DB_STATUSES);

    if (productIdFilter && UUID_LIKE.test(productIdFilter)) {
      q = applyProductUuidCartContainsOr(q, productIdFilter);
    } else if (productIdFilter) {
      q = applyProductCartIlikeFilters(q, {
        product_id: productIdFilter,
        product_sku: null,
      });
    }

    const remaining = MAX_PRODUCT_SALES_ROWS - rowCount;
    const pageSize = Math.min(LOG_SELECT_PAGE_SIZE, remaining);
    q = q.range(offset, offset + pageSize - 1);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    for (const row of data) {
      rowCount += 1;
      const bucketDate = bucketKeyForDate(row.created_at, gran);
      if (!bucketDate) continue;

      const raw =
        row.raw_data &&
        typeof row.raw_data === "object" &&
        !Array.isArray(row.raw_data)
          ? row.raw_data
          : {};

      const seenProductsInOrder = new Set();
      for (const line of parseCartItemsArray(raw)) {
        const pid = resolveLineProductId(line);
        if (!pid) continue;
        if (productIdFilter && !lineMatchesProductIdFilter(line, productIdFilter)) {
          continue;
        }

        if (!productMap.has(pid)) {
          const label = resolveLineProductLabel(line);
          productMap.set(pid, {
            product_id: pid,
            name: label.name,
            sku: label.sku,
            buckets: new Map(),
            summary: emptyProductSalesBucket(),
          });
        }

        const productEntry = productMap.get(pid);
        const label = resolveLineProductLabel(line);
        if (!productEntry.name && label.name) productEntry.name = label.name;
        if (!productEntry.sku && label.sku) productEntry.sku = label.sku;

        if (!productEntry.buckets.has(bucketDate)) {
          productEntry.buckets.set(bucketDate, emptyProductSalesBucket());
        }

        const bucket = productEntry.buckets.get(bucketDate);
        const units = pickLineQuantity(line);
        const revenue = pickLineRevenue(line);

        bucket.totalUnits += units;
        bucket.totalRevenue += revenue;
        productEntry.summary.totalUnits += units;
        productEntry.summary.totalRevenue += revenue;

        if (!seenProductsInOrder.has(pid)) {
          seenProductsInOrder.add(pid);
          bucket.totalOrders += 1;
          productEntry.summary.totalOrders += 1;
        }
      }
    }

    if (data.length < pageSize) break;
    offset += pageSize;
  }

  const catalogMeta = await loadProductCatalogMeta([...productMap.keys()]);
  const products = [...productMap.values()]
    .map((entry) => {
      const catalog = catalogMeta.get(entry.product_id);
      const name = catalog?.name || entry.name || entry.product_id;
      const sku = catalog?.sku || entry.sku || null;
      const points = bucketKeys.map((date) => {
        const bucket = entry.buckets.get(date) || emptyProductSalesBucket();
        return { date, ...finalizeProductSalesBucket(bucket) };
      });

      return {
        product_id: entry.product_id,
        name,
        sku,
        points,
        summary: finalizeProductSalesBucket(entry.summary),
      };
    })
    .sort((a, b) => b.summary.totalUnits - a.summary.totalUnits);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    granularity: gran,
    products,
    truncated,
    maxRowsCap: MAX_PRODUCT_SALES_ROWS,
  };
}

const MAX_ORDER_COST_ROWS = 50000;
const SUCCESSFUL_SHIPPING_STATUS = "delivered";

function roundMoney(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function buildOrderCostBucket(expenseAmount, totalOrders, totalSales) {
  const expense = Number(expenseAmount);
  const costPerOrder = computeCostPerOrder(expense, totalOrders);
  const salesPerOrder = totalOrders > 0 ? totalSales / totalOrders : null;
  const salesPerExpense =
    expense > 0 ? totalSales / expense : null;

  return {
    totalOrders,
    totalSales: roundMoney(totalSales),
    salesPerOrder: roundMoney(salesPerOrder),
    costPerOrder,
    salesPerExpense: roundMoney(salesPerExpense),
  };
}

/** تكلفة الطلب = المصروفات ÷ عدد الطلبات؛ بدون مصروفات = 0 */
function computeCostPerOrder(expenseAmount, totalOrders) {
  const expense = Number(expenseAmount);
  if (!Number.isFinite(expense) || expense <= 0 || totalOrders <= 0) {
    return 0;
  }
  return roundMoney(expense / totalOrders);
}

function emptyOrderCostSeriesBucket() {
  return { totalOrders: 0, totalSales: 0 };
}

function finalizeOrderCostChartPoint(expenseAmount, bucket) {
  return {
    totalOrders: bucket.totalOrders,
    totalSales: roundMoney(bucket.totalSales),
    costPerOrder: computeCostPerOrder(expenseAmount, bucket.totalOrders),
  };
}

/**
 * تكلفة اكتساب الطلب: المصروفات ÷ عدد الطلبات.
 * orders = كل الطلبات (أي حالة)
 * shipped = حالة الطلب تم الشحن (Shipped)
 * delivered = حالة الشحن تم التوصيل (delivered)
 */
async function getOrderCostMetrics({
  expense,
  from,
  to,
  dateBasis = "created",
}) {
  const expenseAmount = parseExpenseForCostChart(expense);
  if (
    expense != null &&
    String(expense).trim() !== "" &&
    (!Number.isFinite(Number(expense)) || Number(expense) < 0)
  ) {
    const err = new Error("expense must be a non-negative number");
    err.code = "INVALID_EXPENSE";
    throw err;
  }

  const useCreatedAtColumn = dateBasis === "created";

  let totalOrders = 0;
  let totalSales = 0;
  let shippedOrders = 0;
  let shippedSales = 0;
  let deliveredOrders = 0;
  let deliveredSales = 0;
  let offset = 0;
  let truncated = false;
  let rowsScanned = 0;

  for (;;) {
    if (rowsScanned >= MAX_ORDER_COST_ROWS) {
      truncated = true;
      break;
    }

    let q = supabase
      .from(ORDERS_TABLE)
      .select("order_id,created_at,raw_data,status");

    if (from) {
      if (useCreatedAtColumn) {
        q = q.gte("created_at", from.toISOString());
      } else {
        const wide = new Date(from);
        wide.setUTCDate(wide.getUTCDate() - 120);
        q = q.gte("created_at", wide.toISOString());
      }
    }
    if (to) {
      q = q.lte("created_at", to.toISOString());
    }

    q = q.order("created_at", { ascending: true }).order("order_id", {
      ascending: true,
    });

    const remaining = MAX_ORDER_COST_ROWS - rowsScanned;
    const pageSize = Math.min(LOG_SELECT_PAGE_SIZE, remaining);
    q = q.range(offset, offset + pageSize - 1);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    for (const row of data) {
      rowsScanned += 1;
      const raw =
        row.raw_data &&
        typeof row.raw_data === "object" &&
        !Array.isArray(row.raw_data)
          ? row.raw_data
          : {};

      if (!orderMatchesCostDateRange(row, raw, from, to, dateBasis)) {
        continue;
      }

      const sales = pickOrderTotalCost(raw);
      totalOrders += 1;
      totalSales += sales;

      if (isStatsShippedOrder(row)) {
        shippedOrders += 1;
        shippedSales += sales;
      }

      if (isStatsSuccessfulOrder(row, raw)) {
        deliveredOrders += 1;
        deliveredSales += sales;
      }
    }

    if (data.length < pageSize) break;
    offset += pageSize;
  }

  const dateBasisDescriptionAr =
    useCreatedAtColumn
      ? "الفترة تُطبَّق على تاريخ إنشاء الطلب في النظام (orders.created_at)"
      : "الفترة تُطبَّق على آخر تحديث للطلب (updated_at) أو تاريخ الإنشاء إن لم يوجد تحديث";

  const ordersBucket = buildOrderCostBucket(
    expenseAmount,
    totalOrders,
    totalSales,
  );
  const shippedBucket = buildOrderCostBucket(
    expenseAmount,
    shippedOrders,
    shippedSales,
  );
  const deliveredBucket = buildOrderCostBucket(
    expenseAmount,
    deliveredOrders,
    deliveredSales,
  );

  return {
    expense: roundMoney(expenseAmount),
    expenseEntered: expenseAmount > 0,
    from: from.toISOString(),
    to: to.toISOString(),
    dateBasis: useCreatedAtColumn ? "created" : "activity",
    dateBasisDescriptionAr,
    orders: {
      labelAr: "تكلفة الطلب (كل الطلبات)",
      descriptionAr:
        "المصروفات ÷ عدد كل الطلبات ضمن الفترة (أي حالة طلب)",
      ...ordersBucket,
    },
    shipped: {
      labelAr: "تكلفة الطلب المشحون",
      descriptionAr:
        "المصروفات ÷ عدد الطلبات التي حالتها تم الشحن (Shipped)",
      ...shippedBucket,
    },
    delivered: {
      labelAr: "تكلفة الطلب (تم التوصيل)",
      descriptionAr:
        "المصروفات ÷ عدد الطلبات التي حالة الشحن فيها تم التوصيل (delivered)",
      ...deliveredBucket,
    },
    /** @deprecated استخدم delivered */
    successful: {
      labelAr: "تكلفة الطلب (تم التوصيل)",
      descriptionAr: "نفس delivered",
      ...deliveredBucket,
    },
    successfulShippingStatus: SUCCESSFUL_SHIPPING_STATUS,
    truncated,
    maxRowsCap: MAX_ORDER_COST_ROWS,
    rowsScanned,
  };
}

function orderMatchesCostDateRange(row, raw, from, to, dateBasis) {
  const created = new Date(row.created_at);
  if (Number.isNaN(created.getTime())) return false;

  if (dateBasis === "created") {
    return isInstantInRange(created, from, to);
  }

  const activity = pickOrderActivityDate(row, raw) ?? created;
  return (
    isInstantInRange(activity, from, to) || isInstantInRange(created, from, to)
  );
}

function pickCostChartBucketInstant(row, raw, dateBasis, from, to) {
  const created = new Date(row.created_at);
  if (dateBasis === "created") {
    return created;
  }
  const activity = pickOrderActivityDate(row, raw) ?? created;
  if (isInstantInRange(activity, from, to)) {
    return activity;
  }
  return created;
}

/**
 * جراف تكلفة الطلب الواحد عبر الزمن (يوم / أسبوع / شهر).
 * orders = كل الطلبات | shipped = Shipped | delivered = توصيل ناجح
 * (حساب مباشر من orders — للحفظ اليومي يُستخدم computeOrderCostBucketMapsForRange)
 */
async function computeOrderCostBucketMapsForRange({
  from,
  to,
  dateBasis = "created",
  granularity = "day",
  useEgyptBuckets = false,
}) {
  const gran =
    granularity === "week" || granularity === "month" ? granularity : "day";

  const bucketKeyForDate = useEgyptBuckets
    ? (date, g) => getEgyptTrendBucketKey(date, g)
    : (date, g) => bucketKeyFromDate(date, g);

  const useCreatedAtColumn = dateBasis === "created";
  const bucketKeys = [];
  const bucketKeySet = new Set();

  const ordersMap = new Map();
  const shippedMap = new Map();
  const deliveredMap = new Map();
  let offset = 0;
  let truncated = false;
  let rowsScanned = 0;
  let ordersMatched = 0;

  for (;;) {
    if (rowsScanned >= MAX_ORDER_COST_ROWS) {
      truncated = true;
      break;
    }

    let q = supabase
      .from(ORDERS_TABLE)
      .select("order_id,created_at,raw_data,status");

    if (from) {
      if (useCreatedAtColumn) {
        q = q.gte("created_at", from.toISOString());
      } else {
        const wide = new Date(from);
        wide.setUTCDate(wide.getUTCDate() - 120);
        q = q.gte("created_at", wide.toISOString());
      }
    }
    if (to) {
      q = q.lte("created_at", to.toISOString());
    }

    q = q.order("created_at", { ascending: true }).order("order_id", {
      ascending: true,
    });

    const remaining = MAX_ORDER_COST_ROWS - rowsScanned;
    const pageSize = Math.min(LOG_SELECT_PAGE_SIZE, remaining);
    q = q.range(offset, offset + pageSize - 1);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    for (const row of data) {
      rowsScanned += 1;
      const raw =
        row.raw_data &&
        typeof row.raw_data === "object" &&
        !Array.isArray(row.raw_data)
          ? row.raw_data
          : {};

      if (!orderMatchesCostDateRange(row, raw, from, to, dateBasis)) {
        continue;
      }

      ordersMatched += 1;

      const bucketInstant = pickCostChartBucketInstant(
        row,
        raw,
        dateBasis,
        from,
        to,
      );
      const bucketDate = bucketKeyForDate(bucketInstant, gran);
      if (!bucketDate) continue;

      if (!bucketKeySet.has(bucketDate)) {
        bucketKeySet.add(bucketDate);
        bucketKeys.push(bucketDate);
        bucketKeys.sort();
      }

      const sales = pickOrderTotalCost(raw);

      if (!ordersMap.has(bucketDate)) {
        ordersMap.set(bucketDate, emptyOrderCostSeriesBucket());
      }
      const ordersBucket = ordersMap.get(bucketDate);
      ordersBucket.totalOrders += 1;
      ordersBucket.totalSales += sales;

      if (isStatsShippedOrder(row)) {
        if (!shippedMap.has(bucketDate)) {
          shippedMap.set(bucketDate, emptyOrderCostSeriesBucket());
        }
        const shippedBucket = shippedMap.get(bucketDate);
        shippedBucket.totalOrders += 1;
        shippedBucket.totalSales += sales;
      }

      if (isStatsSuccessfulOrder(row, raw)) {
        if (!deliveredMap.has(bucketDate)) {
          deliveredMap.set(bucketDate, emptyOrderCostSeriesBucket());
        }
        const deliveredBucket = deliveredMap.get(bucketDate);
        deliveredBucket.totalOrders += 1;
        deliveredBucket.totalSales += sales;
      }
    }

    if (data.length < pageSize) break;
    offset += pageSize;
  }

  return {
    ordersMap,
    shippedMap,
    deliveredMap,
    bucketKeys,
    rowsScanned,
    ordersMatched,
    truncated,
  };
}

async function getOrderCostChart({
  expense,
  from,
  to,
  granularity = "day",
  dateBasis = "created",
  useEgyptBuckets = false,
}) {
  const expenseAmount = parseExpenseForCostChart(expense);
  const gran =
    granularity === "week" || granularity === "month" ? granularity : "day";
  const useCreatedAtColumn = dateBasis === "created";

  const {
    ordersMap,
    shippedMap,
    deliveredMap,
    rowsScanned,
    ordersMatched,
    truncated,
  } = await computeOrderCostBucketMapsForRange({
    from,
    to,
    dateBasis,
    granularity: gran,
    useEgyptBuckets,
  });

  const listBucketKeys = useEgyptBuckets
    ? (f, t, g) => listEgyptTrendBucketKeys(f, t, g)
    : (f, t, g) => listTrendBucketKeys(f, t, g);
  const sortedBucketKeys = listBucketKeys(from, to, gran);

  const points = sortedBucketKeys.map((date) => {
    const orders = ordersMap.get(date) || emptyOrderCostSeriesBucket();
    const shipped = shippedMap.get(date) || emptyOrderCostSeriesBucket();
    const delivered = deliveredMap.get(date) || emptyOrderCostSeriesBucket();
    const ordersPoint = finalizeOrderCostChartPoint(expenseAmount, orders);
    const shippedPoint = finalizeOrderCostChartPoint(expenseAmount, shipped);
    const deliveredPoint = finalizeOrderCostChartPoint(expenseAmount, delivered);
    return {
      date,
      orders: ordersPoint,
      shipped: shippedPoint,
      delivered: deliveredPoint,
      successful: deliveredPoint,
    };
  });

  let summaryOrders = emptyOrderCostSeriesBucket();
  let summaryShipped = emptyOrderCostSeriesBucket();
  let summaryDelivered = emptyOrderCostSeriesBucket();
  for (const b of ordersMap.values()) {
    summaryOrders.totalOrders += b.totalOrders;
    summaryOrders.totalSales += b.totalSales;
  }
  for (const b of shippedMap.values()) {
    summaryShipped.totalOrders += b.totalOrders;
    summaryShipped.totalSales += b.totalSales;
  }
  for (const b of deliveredMap.values()) {
    summaryDelivered.totalOrders += b.totalOrders;
    summaryDelivered.totalSales += b.totalSales;
  }

  const summaryOrdersPoint = finalizeOrderCostChartPoint(
    expenseAmount,
    summaryOrders,
  );
  const summaryShippedPoint = finalizeOrderCostChartPoint(
    expenseAmount,
    summaryShipped,
  );
  const summaryDeliveredPoint = finalizeOrderCostChartPoint(
    expenseAmount,
    summaryDelivered,
  );

  const hintAr =
    rowsScanned > 0 && ordersMatched === 0
      ? "لا توجد طلبات داخل الفترة المحددة — جرّبي توسيع from/to أو date."
      : null;

  return {
    source: "live",
    from: from.toISOString(),
    to: to.toISOString(),
    granularity: gran,
    expense: roundMoney(expenseAmount),
    expenseEntered: expenseAmount > 0,
    formulaAr:
      "تكلفة الطلب = المصروفات ÷ عدد الطلبات. بدون مصروفات = 0",
    dateBasis: useCreatedAtColumn ? "created" : "activity",
    dateBasisDescriptionAr: useCreatedAtColumn
      ? "الفترة على orders.created_at"
      : "الفترة على آخر تحديث أو تاريخ الإنشاء",
    points,
    summary: {
      orders: summaryOrdersPoint,
      shipped: summaryShippedPoint,
      delivered: summaryDeliveredPoint,
      successful: summaryDeliveredPoint,
    },
    ordersMatched,
    rowsScanned,
    hintAr,
    truncated,
    maxRowsCap: MAX_ORDER_COST_ROWS,
  };
}

function parseExpenseForCostChart(raw) {
  if (raw == null || String(raw).trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

module.exports = {
  addWebhookOrder,
  getWebhookOrders,
  getWebhookOrdersForExport,
  getWebhookOrderByReference,
  getWebhookOrderById,
  findOrderByBostaAlias,
  markOrderSentToBosta,
  applyBostaFulfillmentWebhook,
  updateOrderStatus,
  editOrder,
  getOrdersStatistics,
  getOrdersStatsTimeSeries,
  getProductSalesChart,
  getOrderCostMetrics,
  getOrderCostChart,
  computeOrderCostBucketMapsForRange,
  computeCostPerOrder,
  roundMoney,
  getOrdersAnalyticsReport,
  ALLOWED_ORDER_STATUSES,
  ORDER_SOURCES,
  ORDER_SOURCE_OPTIONS,
  ORDER_TYPES,
  ORDER_TYPE_OPTIONS,
  SHIPPING_STATUSES,
  SHIPPING_STATUS_OPTIONS,
  ORDER_STATUS_OPTIONS,
  getOrdersFilterLists,
  normalizeOrderStatusInput,
};
