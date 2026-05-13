const crypto = require("crypto");

const supabase = require("../config/supabase");

const ALLOWED_ORDER_STATUSES = [
  "canceled",
  "new",
  "no_replay",
  "follow up",
  "repeater",
  "Confirmed",
  "Shipped",
];

/** مصدر الطلب: store=المتجر (تلقائي من الويب هوك), messenger, whatsapp, lost_order=طلب مفقود */
const ORDER_SOURCES = ["store", "messenger", "whatsapp", "lost_order"];

/** نوع الطلب: new=جديد (افتراضي), replacement=استبدال, return=استرجاع */
const ORDER_TYPES = ["new", "replacement", "return"];

/** حالة الشحن: in_progress=قيد التنفيذ, delivered=تم بنجاح, failed=فشل التوصيل */
const SHIPPING_STATUSES = ["in_progress", "delivered", "failed"];

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
 * PostgREST يقسّم `col.op.val` على أول `.`؛ `raw_data->>phone.ilike…` يُفسَّر كعمود
 * `raw_data` فيُطبَّق ILIKE على jsonb → `operator does not exist: jsonb ~~*`.
 * اقتباس المسار الكامل يجبر النص المستخرج `->>`.
 */
function postgrestQuoteJsonTextPath(pathExpr) {
  const s = String(pathExpr || "").trim();
  if (!s) return '""';
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** قيمة آمنة للبحث؛ إن أصبحت فارغة بعد التنقية يُهمَل الفلتر (لا 400). */
function parseProductFilterInput(raw) {
  if (raw == null || String(raw).trim() === "") return "";
  const s = sanitizeIlikeNeedle(raw);
  return s || "";
}

/**
 * @param {object} payload - جسم الطلب (ويب هوك أو إنشاء يدوي)
 * @param {{ fromWebhook?: boolean }} options - من الويب هوك: مصدر المتجر إلزاميًا
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
      const err = new Error(
        "order_source is required (store | messenger | whatsapp | lost_order)",
      );
      err.code = "INVALID_ORDER_META";
      throw err;
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
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * طلبات يظهر في raw_data أن هذا الموظف عالجها (PATCH) — حقول من الواجهة مثل
 * modifier_employee_id / updated_by_employee_id / الإيميلات.
 * يُكمّل order_status_logs التي تُسجَّل فقط عند تغيير status.
 */
async function fetchOrderIdsFromRawDataEmployeeMarkers({
  employeeKey,
  employeeRawInput,
}) {
  const ids = new Set();

  async function addAllOrderIdsEqJsonKey(jsonKey, value) {
    let offset = 0;
    for (;;) {
      const col = `raw_data->>${jsonKey}`;
      const { data, error } = await supabase
        .from(ORDERS_TABLE)
        .select("order_id")
        .eq(col, value)
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
    await addAllOrderIdsEqJsonKey("modifier_employee_id", employeeKey);
    await addAllOrderIdsEqJsonKey("updated_by_employee_id", employeeKey);
    await addAllOrderIdsEqJsonKey("created_by_employee_id", employeeKey);
    await addAllOrderIdsEqJsonKey("assigned_employee_id", employeeKey);
  }

  const raw = String(employeeRawInput || "").trim();
  if (raw.includes("@")) {
    const p = postgrestIlikeStarWrap(raw);
    if (p) {
      let offset = 0;
      for (;;) {
        const { data, error } = await supabase
          .from(ORDERS_TABLE)
          .select("order_id")
          .or(
            `${postgrestQuoteJsonTextPath("raw_data->>updated_by_email")}.ilike.${p},${postgrestQuoteJsonTextPath("raw_data->>user_email")}.ilike.${p}`,
          )
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

async function addWebhookOrder(order, options = {}) {
  const sourceOrderId = resolveSourceOrderId(order);
  const meta = resolveOrderMeta(order, { fromWebhook: options.fromWebhook });
  const raw_data = {
    ...(order && typeof order === "object" && !Array.isArray(order) ? order : {}),
    ...meta,
  };

  const payload = {
    order_id: sourceOrderId,
    status: "new",
    raw_data,
    created_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from(ORDERS_TABLE)
    .upsert(payload, { onConflict: "order_id" })
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return {
    ...(data.raw_data || {}),
    sourceOrderId: data.order_id,
    orderStatus: data.status,
    receivedAt: data.created_at,
  };
}

async function getWebhookOrders({
  page = 1,
  limit = 20,
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
  ignoreEmployeeLogDateRange = false,
}) {
  const fromIndex = (page - 1) * limit;
  const toIndex = fromIndex + limit - 1;
  let orderIdsByEmployee = null;
  /** عند فلتر الموظف: لا نفلتر orders.created_at (الفترة تُطبَّق على سجلات النشاط فقط). */
  let skipOrderCreatedAtRange = false;

  if (employeeId) {
    const changedByKey = await resolveEmployeeToIdForLogs(employeeId);
    if (String(employeeId).trim().includes("@") && !changedByKey) {
      return {
        page,
        limit,
        total: 0,
        totalPages: 1,
        data: [],
      };
    }

    const keyForLogs = changedByKey || String(employeeId).trim();

    const fromLogs = await fetchDistinctOrderIdsFromLogs({
      changedByKey: keyForLogs,
      from,
      to,
      ignoreDateRange: ignoreEmployeeLogDateRange,
    });
    const fromRawMarkers = await fetchOrderIdsFromRawDataEmployeeMarkers({
      employeeKey: keyForLogs,
      employeeRawInput: String(employeeId).trim(),
    });
    orderIdsByEmployee = [
      ...new Set([...fromLogs, ...fromRawMarkers]),
    ];
    skipOrderCreatedAtRange = true;

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

  let query = supabase.from(ORDERS_TABLE).select("*", { count: "exact" });

  if (from && !skipOrderCreatedAtRange) {
    query = query.gte("created_at", from.toISOString());
  }
  if (to && !skipOrderCreatedAtRange) {
    query = query.lte("created_at", to.toISOString());
  }
  if (status) query = query.eq("status", status);

  const rawContains = {};
  if (order_source) rawContains.order_source = order_source;
  if (order_type) rawContains.order_type = order_type;
  if (shipping_status) rawContains.shipping_status = shipping_status;
  if (Object.keys(rawContains).length) {
    query = query.contains("raw_data", rawContains);
  }

  if (orderIdsByEmployee) {
    query = applyOrderIdMembershipFilter(query, orderIdsByEmployee);
  }

  const pidNeedle = parseProductFilterInput(product_id);
  const skuNeedle = parseProductFilterInput(product_sku);
  const phoneNeedle = parseProductFilterInput(phone);

  if (phoneNeedle) {
    const p = postgrestIlikeStarWrap(phoneNeedle);
    if (p) {
      query = query.or(
        [
          "raw_data->>phone",
          "raw_data->>mobile",
          "raw_data->>customer_phone",
          "raw_data->>telephone",
        ]
          .map((path) => `${postgrestQuoteJsonTextPath(path)}.ilike.${p}`)
          .join(","),
      );
    }
  }

  if (pidNeedle && skuNeedle) {
    const p1 = postgrestIlikeStarWrap(pidNeedle);
    const p2 = postgrestIlikeStarWrap(skuNeedle);
    if (p1 && p2) {
      query = query.ilikeAllOf(
        postgrestQuoteJsonTextPath("raw_data->>cart_items"),
        [p1, p2],
      );
    }
  } else if (pidNeedle) {
    const p = postgrestIlikeStarWrap(pidNeedle);
    if (p) {
      query = query.or(
        `${postgrestQuoteJsonTextPath("raw_data->>cart_items")}.ilike.${p},${postgrestQuoteJsonTextPath("raw_data->>cartItems")}.ilike.${p}`,
      );
    }
  } else if (skuNeedle) {
    const p = postgrestIlikeStarWrap(skuNeedle);
    if (p) {
      query = query.or(
        `${postgrestQuoteJsonTextPath("raw_data->>cart_items")}.ilike.${p},${postgrestQuoteJsonTextPath("raw_data->>cartItems")}.ilike.${p}`,
      );
    }
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
    data: rows.map((entry) => ({
      ...(entry.raw_data || {}),
      sourceOrderId: entry.order_id,
      orderStatus: entry.status,
      receivedAt: entry.created_at,
    })),
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

  return {
    ...(data.raw_data || {}),
    sourceOrderId: data.order_id,
    orderStatus: data.status,
    receivedAt: data.created_at,
  };
}

async function editOrder(orderId, updates, changedBy) {
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
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, "status")) {
    if (!ALLOWED_ORDER_STATUSES.includes(normalizedUpdates.status)) {
      const invalidStatusError = new Error("Invalid status value");
      invalidStatusError.code = "INVALID_STATUS";
      throw invalidStatusError;
    }
    if (!changedBy) {
      const authError = new Error("Unauthorized");
      authError.code = "UNAUTHORIZED";
      throw authError;
    }
    nextStatus = normalizedUpdates.status;
    shouldLogStatusChange = nextStatus !== existingOrder.status;
  }

  const normalizedIncomingUpdates = { ...normalizedUpdates };

  // Keep common aliases in sync so list/detail pages read same values.
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "firstName")) {
    normalizedIncomingUpdates.full_name = normalizedIncomingUpdates.firstName;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "full_name")) {
    normalizedIncomingUpdates.firstName = normalizedIncomingUpdates.full_name;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "mobile")) {
    normalizedIncomingUpdates.phone = normalizedIncomingUpdates.mobile;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "phone")) {
    normalizedIncomingUpdates.mobile = normalizedIncomingUpdates.phone;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "orderSource")) {
    normalizedIncomingUpdates.order_source = normalizedIncomingUpdates.orderSource;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "orderType")) {
    normalizedIncomingUpdates.order_type = normalizedIncomingUpdates.orderType;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "shippingStatus")) {
    normalizedIncomingUpdates.shipping_status = normalizedIncomingUpdates.shippingStatus;
  }

  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "order_source")) {
    const v = normalizeMetaString(normalizedIncomingUpdates.order_source);
    if (!ORDER_SOURCES.includes(v)) {
      const invalidStatusError = new Error("Invalid order_source");
      invalidStatusError.code = "INVALID_ORDER_META";
      throw invalidStatusError;
    }
    normalizedIncomingUpdates.order_source = v;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "order_type")) {
    const v = normalizeMetaString(normalizedIncomingUpdates.order_type);
    if (!ORDER_TYPES.includes(v)) {
      const invalidStatusError = new Error("Invalid order_type");
      invalidStatusError.code = "INVALID_ORDER_META";
      throw invalidStatusError;
    }
    normalizedIncomingUpdates.order_type = v;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedIncomingUpdates, "shipping_status")) {
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

  return {
    ...(data.raw_data || {}),
    sourceOrderId: data.order_id,
    orderStatus: data.status,
    receivedAt: data.created_at,
  };
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
    ...new Set(
      (orderIds || [])
        .map((x) => String(x).trim())
        .filter(Boolean),
    ),
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

/**
 * Order counts by status. Optional employeeId = orders that appear in
 * order_status_logs for that employee (changed_by) with from/to on logs.changed_at,
 * OR orders whose raw_data carries that employee (modifier/updated/created/assigned id
 * or email markers), merged and deduped. Unless ignoreEmployeeLogDateRange, logs use
 * the date window; raw_data marker matches are not date-scoped. Without employeeId,
 * from/to apply to orders.created_at.
 */
async function getOrdersStatistics({
  employeeId,
  from,
  to,
  ignoreEmployeeLogDateRange = false,
}) {
  let orderIds = null;
  let filterOrdersByCreatedAtInRange = true;

  const employeeKey =
    typeof employeeId === "string" ? employeeId.trim() : employeeId;

  if (employeeKey) {
    const changedByKey = await resolveEmployeeToIdForLogs(employeeKey);
    if (String(employeeKey).includes("@") && !changedByKey) {
      return {
        totalOrders: 0,
        canceled: 0,
        no_replay: 0,
        follow_up: 0,
        repeater: 0,
        Confirmed: 0,
        Shipped: 0,
        new: 0,
      };
    }

    const keyForLogs = changedByKey || String(employeeKey);

    const fromLogs = await fetchDistinctOrderIdsFromLogs({
      changedByKey: keyForLogs,
      from,
      to,
      ignoreDateRange: ignoreEmployeeLogDateRange,
    });
    const fromRawMarkers = await fetchOrderIdsFromRawDataEmployeeMarkers({
      employeeKey: keyForLogs,
      employeeRawInput: String(employeeKey).trim(),
    });
    orderIds = [...new Set([...fromLogs, ...fromRawMarkers])];
    filterOrdersByCreatedAtInRange = false;

    if (!orderIds.length) {
      return {
        totalOrders: 0,
        canceled: 0,
        no_replay: 0,
        follow_up: 0,
        repeater: 0,
        Confirmed: 0,
        Shipped: 0,
        new: 0,
      };
    }
  }

  const chunks =
    orderIds == null ? [null] : chunkArray(orderIds, IN_CHUNK_SIZE);

  async function countWithChunks(status) {
    let sum = 0;
    for (const chunk of chunks) {
      let q = supabase
        .from(ORDERS_TABLE)
        .select("*", { count: "exact", head: true });

      if (chunk) q = q.in("order_id", chunk);
      if (from && filterOrdersByCreatedAtInRange) {
        q = q.gte("created_at", from.toISOString());
      }
      if (to && filterOrdersByCreatedAtInRange) {
        q = q.lte("created_at", to.toISOString());
      }
      if (status) q = q.eq("status", status);

      const { count, error } = await q;
      if (error) throw new Error(error.message);
      sum += count || 0;
    }
    return sum;
  }

  const byStatus = {};
  for (const [key, dbStatus] of Object.entries(STATS_STATUS_KEYS)) {
    byStatus[key] = await countWithChunks(dbStatus);
  }

  let totalOrders = 0;
  for (const chunk of chunks) {
    let q = supabase
      .from(ORDERS_TABLE)
      .select("*", { count: "exact", head: true });

    if (chunk) q = q.in("order_id", chunk);
    if (from && filterOrdersByCreatedAtInRange) {
      q = q.gte("created_at", from.toISOString());
    }
    if (to && filterOrdersByCreatedAtInRange) {
      q = q.lte("created_at", to.toISOString());
    }

    const { count, error } = await q;
    if (error) throw new Error(error.message);
    totalOrders += count || 0;
  }

  return {
    totalOrders,
    canceled: byStatus.canceled,
    no_replay: byStatus.no_replay,
    follow_up: byStatus.follow_up,
    repeater: byStatus.repeater,
    Confirmed: byStatus.Confirmed,
    Shipped: byStatus.Shipped,
    new: byStatus.new,
  };
}

module.exports = {
  addWebhookOrder,
  getWebhookOrders,
  updateOrderStatus,
  editOrder,
  getOrdersStatistics,
  ALLOWED_ORDER_STATUSES,
  ORDER_SOURCES,
  ORDER_TYPES,
  SHIPPING_STATUSES,
};
