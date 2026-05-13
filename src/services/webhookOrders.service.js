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
    { cart_items: [{ id: id }] },
    { cart_items: [{ easyorder_id: id }] },
    { cart_items: [{ product: { id: id } }] },
    { cart_items: [{ product: { easyorder_id: id } }] },
    { cartItems: [{ product_id: id }] },
    { cartItems: [{ id: id }] },
    { cartItems: [{ easyorder_id: id }] },
    { cartItems: [{ product: { id: id } }] },
    { cartItems: [{ product: { easyorder_id: id } }] },
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
            `raw_data->>updated_by_email.ilike.${p},raw_data->>user_email.ilike.${p}`,
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
    ...(order && typeof order === "object" && !Array.isArray(order)
      ? order
      : {}),
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

function applyRawDataMetaContains(query, { order_source, order_type, shipping_status }) {
  const rawContains = {};
  if (order_source) rawContains.order_source = order_source;
  if (order_type) rawContains.order_type = order_type;
  if (shipping_status) rawContains.shipping_status = shipping_status;
  if (!Object.keys(rawContains).length) return query;
  return query.contains("raw_data", rawContains);
}

function applyProductCartIlikeFilters(query, { product_id, product_sku }) {
  const pidNeedle = parseProductFilterInput(product_id);
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
    orderIdsByEmployee = [...new Set([...fromLogs, ...fromRawMarkers])];
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
      paths: ["raw_data->>phone", "raw_data->>mobile"],
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

  function applyBaseListFiltersAndPhone(q) {
    let x = applyBaseListFilters(q);
    if (phoneOrderIds) {
      x = applyOrderIdMembershipFilter(x, phoneOrderIds);
    }
    return x;
  }

  const pidForProduct = parseProductFilterInput(product_id);
  const skuForProduct = parseProductFilterInput(product_sku);

  let productCartByUuidOrderIds = null;
  if (pidForProduct && UUID_LIKE.test(pidForProduct) && !skuForProduct) {
    productCartByUuidOrderIds =
      await collectOrderIdsUnionContainsCartProductUuid(
        pidForProduct,
        applyBaseListFiltersAndPhone,
      );
    if (!productCartByUuidOrderIds.length) {
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
  query = applyBaseListFilters(query);
  if (phoneOrderIds) {
    query = applyOrderIdMembershipFilter(query, phoneOrderIds);
  }

  if (productCartByUuidOrderIds) {
    query = applyOrderIdMembershipFilter(query, productCartByUuidOrderIds);
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
 * from/to on orders.created_at unless employee resolution uses log dates only for the id set.
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
  let filterOrdersByCreatedAtInRange = true;

  const employeeKey =
    typeof employeeId === "string" ? employeeId.trim() : employeeId;

  if (employeeKey) {
    const changedByKey = await resolveEmployeeToIdForLogs(employeeKey);
    if (String(employeeKey).includes("@") && !changedByKey) {
      return buildEmptyStatsBreakdownResponse();
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
    const rawContains = {};
    if (breakdownDim === "order_source") {
      rawContains.order_source = breakdownValue;
    } else if (order_source) {
      rawContains.order_source = order_source;
    }
    if (breakdownDim === "order_type") {
      rawContains.order_type = breakdownValue;
    } else if (order_type) {
      rawContains.order_type = order_type;
    }
    if (breakdownDim === "shipping_status") {
      rawContains.shipping_status = breakdownValue;
    } else if (shipping_status) {
      rawContains.shipping_status = shipping_status;
    }
    if (!Object.keys(rawContains).length) return query;
    return query.contains("raw_data", rawContains);
  }

  async function countAggregatedOrders(breakdownDim, breakdownValue) {
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
      q = applyStatsRawContains(q, breakdownDim, breakdownValue);
      q = applyProductCartIlikeFilters(q, { product_id, product_sku });
      if (listStatusFilterNorm != null) {
        q = q.eq("status", listStatusFilterNorm);
      }

      const { count, error } = await q;
      if (error) throw new Error(error.message);
      sum += count || 0;
    }
    return sum;
  }

  async function countWithChunks(dbStatusForKey) {
    if (
      listStatusFilterNorm != null &&
      listStatusFilterNorm !== dbStatusForKey
    ) {
      return 0;
    }

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
      q = applyStatsRawContains(q, null, null);
      q = applyProductCartIlikeFilters(q, { product_id, product_sku });
      q = q.eq("status", dbStatusForKey);

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
    q = applyStatsRawContains(q, null, null);
    q = applyProductCartIlikeFilters(q, { product_id, product_sku });
    if (listStatusFilterNorm != null) {
      q = q.eq("status", listStatusFilterNorm);
    }

    const { count, error } = await q;
    if (error) throw new Error(error.message);
    totalOrders += count || 0;
  }

  const byOrderSource = {};
  for (const src of ORDER_SOURCES) {
    byOrderSource[src] = await countAggregatedOrders("order_source", src);
  }

  const byOrderType = {};
  for (const typ of ORDER_TYPES) {
    byOrderType[typ] = await countAggregatedOrders("order_type", typ);
  }

  const byShippingStatus = {};
  for (const sh of SHIPPING_STATUSES) {
    byShippingStatus[sh] = await countAggregatedOrders(
      "shipping_status",
      sh,
    );
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

  return {
    totalOrders,
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

function sumLineQuantitiesFromRaw(raw) {
  return parseCartItemsArray(raw).reduce(
    (s, line) => s + (Number(line?.quantity) || 0),
    0,
  );
}

/** مبيعات الطلب: total_cost ثم cost كبديل */
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

function aggregateOrdersAnalyticsRows(rows) {
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
    totalProductUnits += sumLineQuantitiesFromRaw(raw);

    const orderSource = analyticsFirstNonEmpty(
      raw.order_source,
      raw.orderSource,
    );
    const orderType = analyticsFirstNonEmpty(raw.order_type, raw.orderType);
    const shippingStatus = analyticsFirstNonEmpty(
      raw.shipping_status,
      raw.shippingStatus,
    );
    const orderStatus =
      row.status != null && String(row.status).trim() !== ""
        ? String(row.status).trim()
        : "";

    incrementAnalyticsBucket(byOrderSource, orderSource || "__unset");
    incrementAnalyticsBucket(byOrderType, orderType || "__unset");
    incrementAnalyticsBucket(byShippingStatus, shippingStatus || "__unset");
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
    const changedByKey = await resolveEmployeeToIdForLogs(employeeId);
    if (String(employeeId).trim().includes("@") && !changedByKey) {
      return { rows: [], truncated: false };
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
    orderIdsByEmployee = [...new Set([...fromLogs, ...fromRawMarkers])];

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

  const pidNeedle = parseProductFilterInput(product_id);
  const skuNeedle = parseProductFilterInput(product_sku);

  let orderIdsByProductUuid = null;
  if (pidNeedle && UUID_LIKE.test(pidNeedle) && !skuNeedle) {
    orderIdsByProductUuid = await collectOrderIdsUnionContainsCartProductUuid(
      pidNeedle,
      applyNonProductFilters,
    );
    if (!orderIdsByProductUuid.length) {
      return { rows: [], truncated: false };
    }
  }

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
    if (orderIdsByProductUuid) {
      q = applyOrderIdMembershipFilter(q, orderIdsByProductUuid);
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
  const agg = aggregateOrdersAnalyticsRows(rows);
  return { ...agg, truncated, maxRowsCap: MAX_ANALYTICS_ROWS };
}

module.exports = {
  addWebhookOrder,
  getWebhookOrders,
  updateOrderStatus,
  editOrder,
  getOrdersStatistics,
  getOrdersAnalyticsReport,
  ALLOWED_ORDER_STATUSES,
  ORDER_SOURCES,
  ORDER_TYPES,
  SHIPPING_STATUSES,
};
