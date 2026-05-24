const supabase = require("../config/supabase");

const ADDED_ORDERS_TABLE =
  process.env.SUPABASE_ADDED_ORDERS_TABLE || "added_orders";
const EMPLOYEES_TABLE = process.env.SUPABASE_EMPLOYEES_TABLE || "employees";

const ADDED_ORDERS_SETUP_HINT =
  "Run supabase/added_orders_schema.sql in Supabase SQL editor once.";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function pickString(...values) {
  for (const v of values) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

function sanitizeIlikeNeedle(value) {
  const s = String(value).trim().slice(0, 200);
  if (!s) return "";
  return s.replace(/[%_\\,(){}]/g, "");
}

/** نمط ILIKE لأعمدة text (PostgREST .ilike يستخدم * كبديل %). */
function postgrestIlikeStarWrap(needle) {
  const n = sanitizeIlikeNeedle(needle);
  if (!n) return null;
  return `*${n.replace(/\*/g, "\\*")}*`;
}

/** نمط ILIKE لـ jsonb::text عبر .filter (SQL يستخدم %). */
function postgrestIlikePercentWrap(needle) {
  const n = sanitizeIlikeNeedle(needle);
  if (!n) return null;
  return `%${n}%`;
}

function parseProductNameFilter(productName) {
  const n = pickString(productName);
  if (!n || /^(undefined|null)$/i.test(n)) return null;
  return n;
}

function escapeIlikeLiteral(value) {
  return String(value)
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

async function resolveEmployeeFilter(employeeFilter) {
  const raw = pickString(employeeFilter);
  if (!raw) return null;
  if (!raw.includes("@")) return raw;

  const literal = escapeIlikeLiteral(raw);
  let { data, error } = await supabase
    .from(EMPLOYEES_TABLE)
    .select("id")
    .ilike("email", literal)
    .limit(1);

  if (error) {
    throw enrichAddedOrdersDbError(error);
  }

  let row = Array.isArray(data) && data.length ? data[0] : null;
  if (!row) {
    ({ data, error } = await supabase
      .from(EMPLOYEES_TABLE)
      .select("id")
      .eq("email", raw.toLowerCase())
      .limit(1));
    if (error) {
      throw enrichAddedOrdersDbError(error);
    }
    row = Array.isArray(data) && data.length ? data[0] : null;
  }

  return row?.id != null ? String(row.id) : null;
}

function emptyListResult(page, limit) {
  return {
    page,
    limit,
    total: 0,
    totalPages: 1,
    data: [],
  };
}

function isMissingAddedOrdersTableError(message) {
  const m = String(message || "");
  return m.includes("added_orders") || m.includes("schema cache");
}

function enrichAddedOrdersDbError(error) {
  if (!error?.message || !isMissingAddedOrdersTableError(error.message)) {
    return error;
  }
  const err = new Error(error.message);
  err.code = "ADDED_ORDERS_NOT_CONFIGURED";
  err.setupHint = ADDED_ORDERS_SETUP_HINT;
  return err;
}

function normalizeProductLine(line) {
  if (!line || typeof line !== "object") {
    const err = new Error("Each product must be an object");
    err.code = "INVALID_PRODUCT";
    throw err;
  }

  const name = pickString(line.name, line.productName, line.title);
  if (!name) {
    const err = new Error("Product name is required");
    err.code = "INVALID_PRODUCT";
    throw err;
  }

  const quantity = Number(line.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    const err = new Error("Product quantity must be a positive number");
    err.code = "INVALID_PRODUCT";
    throw err;
  }

  const cost = Number(line.cost ?? line.unitCost ?? line.price);
  if (!Number.isFinite(cost) || cost < 0) {
    const err = new Error("Product cost must be a non-negative number");
    err.code = "INVALID_PRODUCT";
    throw err;
  }

  return {
    name,
    quantity: Math.trunc(quantity),
    cost,
  };
}

function sumProductsTotal(products) {
  return products.reduce((sum, p) => sum + p.quantity * p.cost, 0);
}

function normalizeProductsArray(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => ({
    name: pickString(p?.name),
    quantity: Number(p?.quantity) || 0,
    cost: Number(p?.cost ?? p?.unitCost) || 0,
  }));
}

function formatAddedOrderView(row, employeeById) {
  const employeeId = pickString(row?.added_by_employee_id);
  const employee = employeeId ? employeeById.get(employeeId) : null;
  const products = normalizeProductsArray(row?.products);

  return {
    id: row.id,
    addedBy: {
      id: employeeId || null,
      name: employee?.name ?? row.added_by_name ?? null,
      email: employee?.email ?? row.added_by_email ?? null,
    },
    customerName: row.customer_name,
    phone: row.phone,
    products,
    totalCost: Number(row.total_cost),
    createdAt: row.created_at,
  };
}

async function fetchEmployeesByIds(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const map = new Map();
  if (!unique.length) return map;

  const { data, error } = await supabase
    .from(EMPLOYEES_TABLE)
    .select("id,name,email")
    .in("id", unique);

  if (error) {
    throw enrichAddedOrdersDbError(error);
  }

  for (const row of data || []) {
    if (row?.id != null) {
      map.set(String(row.id), row);
    }
  }
  return map;
}

async function createAddedOrder({ customerName, phone, products, totalCost, actor }) {
  const name = pickString(customerName);
  const phoneValue = pickString(phone);

  if (!name) {
    const err = new Error("customerName is required");
    err.code = "VALIDATION_ERROR";
    throw err;
  }
  if (!phoneValue) {
    const err = new Error("phone is required");
    err.code = "VALIDATION_ERROR";
    throw err;
  }
  if (!Array.isArray(products) || !products.length) {
    const err = new Error("products must be a non-empty array");
    err.code = "VALIDATION_ERROR";
    throw err;
  }
  if (!actor?.id) {
    const err = new Error("Authenticated employee is required");
    err.code = "UNAUTHORIZED";
    throw err;
  }

  const normalizedProducts = products.map((p) => normalizeProductLine(p));
  const computedTotal = sumProductsTotal(normalizedProducts);

  let finalTotal = computedTotal;
  if (totalCost !== undefined && totalCost !== null && String(totalCost).trim() !== "") {
    const n = Number(totalCost);
    if (!Number.isFinite(n) || n < 0) {
      const err = new Error("totalCost must be a non-negative number");
      err.code = "VALIDATION_ERROR";
      throw err;
    }
    finalTotal = n;
  }

  const employeeId = String(actor.id).trim();
  let addedByName = null;
  let addedByEmail = pickString(actor.email) || null;

  const { data: employeeRow, error: employeeError } = await supabase
    .from(EMPLOYEES_TABLE)
    .select("id,name,email")
    .eq("id", employeeId)
    .maybeSingle();

  if (employeeError) {
    throw enrichAddedOrdersDbError(employeeError);
  }

  if (employeeRow?.name) {
    addedByName = String(employeeRow.name).trim();
  }
  if (employeeRow?.email) {
    addedByEmail = String(employeeRow.email).trim();
  }

  const payload = {
    added_by_employee_id: employeeId,
    added_by_name: addedByName,
    added_by_email: addedByEmail,
    customer_name: name,
    phone: phoneValue,
    products: normalizedProducts,
    total_cost: finalTotal,
  };

  const { data, error } = await supabase
    .from(ADDED_ORDERS_TABLE)
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    throw enrichAddedOrdersDbError(error);
  }

  const employeeById = await fetchEmployeesByIds([employeeId]);
  return formatAddedOrderView(data, employeeById);
}

async function listAddedOrders({
  page = 1,
  limit = DEFAULT_LIST_LIMIT,
  from,
  to,
  employeeId,
  productName,
} = {}) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || DEFAULT_LIST_LIMIT, 1),
    MAX_LIST_LIMIT,
  );
  const safePage = Math.max(Number(page) || 1, 1);
  const fromIndex = (safePage - 1) * safeLimit;
  const toIndex = fromIndex + safeLimit - 1;

  const employeeFilterRaw = pickString(employeeId);
  const resolvedEmployeeId = employeeFilterRaw
    ? await resolveEmployeeFilter(employeeFilterRaw)
    : null;
  if (employeeFilterRaw && !resolvedEmployeeId) {
    return emptyListResult(safePage, safeLimit);
  }

  const productPattern = postgrestIlikePercentWrap(
    parseProductNameFilter(productName),
  );

  let query = supabase
    .from(ADDED_ORDERS_TABLE)
    .select("*", { count: "exact" });

  if (resolvedEmployeeId) {
    query = query.eq("added_by_employee_id", resolvedEmployeeId);
  }

  if (productPattern) {
    query = query.filter("products::text", "ilike", productPattern);
  }

  if (from) {
    query = query.gte("created_at", new Date(from).toISOString());
  }
  if (to) {
    query = query.lte("created_at", new Date(to).toISOString());
  }

  query = query.order("created_at", { ascending: false }).range(fromIndex, toIndex);

  const { data, count, error } = await query;
  if (error) {
    throw enrichAddedOrdersDbError(error);
  }

  const rows = data || [];
  const employeeIds = rows.map((row) => pickString(row.added_by_employee_id));
  const employeeById = await fetchEmployeesByIds(employeeIds);

  return {
    page: safePage,
    limit: safeLimit,
    total: count || 0,
    totalPages: Math.ceil((count || 0) / safeLimit) || 1,
    filters: {
      employeeId: resolvedEmployeeId || null,
      productName: parseProductNameFilter(productName),
    },
    data: rows.map((row) => formatAddedOrderView(row, employeeById)),
  };
}

module.exports = {
  createAddedOrder,
  listAddedOrders,
  formatAddedOrderView,
};
