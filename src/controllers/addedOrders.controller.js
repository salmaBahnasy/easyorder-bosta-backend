const {
  createAddedOrder,
  listAddedOrders,
} = require("../services/addedOrders.service");

function pickBodyField(body, ...keys) {
  if (!body || typeof body !== "object") return undefined;
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null) {
      return body[key];
    }
  }
  return undefined;
}

async function postAddedOrder(req, res) {
  try {
    const customerName = pickBodyField(
      req.body,
      "customerName",
      "customer_name",
      "full_name",
      "fullName",
    );
    const phone = pickBodyField(req.body, "phone", "customer_phone", "customerPhone");
    const products = pickBodyField(req.body, "products", "items", "cart_items");
    const totalCost = pickBodyField(
      req.body,
      "totalCost",
      "total_cost",
      "total",
      "cost",
    );

    const data = await createAddedOrder({
      customerName,
      phone,
      products,
      totalCost,
      actor: req.user,
    });

    res.status(201).json({
      success: true,
      message: "Added order registered successfully",
      data,
    });
  } catch (error) {
    if (error.code === "VALIDATION_ERROR" || error.code === "INVALID_PRODUCT") {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }

    if (error.code === "UNAUTHORIZED") {
      res.status(401).json({
        success: false,
        message: error.message,
      });
      return;
    }

    if (error.code === "ADDED_ORDERS_NOT_CONFIGURED") {
      res.status(503).json({
        success: false,
        message: "Added orders table is not configured",
        setupHint: error.setupHint,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to register added order",
      error: error.message,
    });
  }
}

function pickQueryParam(raw) {
  if (raw == null) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = String(value).trim();
  return trimmed || undefined;
}

async function getAddedOrders(req, res) {
  try {
    const fromRaw = req.query?.from;
    const toRaw = req.query?.to;
    const hasFrom =
      fromRaw != null &&
      String(Array.isArray(fromRaw) ? fromRaw[0] : fromRaw).trim() !== "";
    const hasTo =
      toRaw != null &&
      String(Array.isArray(toRaw) ? toRaw[0] : toRaw).trim() !== "";

    const employeeId = pickQueryParam(
      req.query.employee_id ||
        req.query.employeeId ||
        req.query.added_by_employee_id ||
        req.query.employee,
    );
    const productName = pickQueryParam(
      req.query.product ||
        req.query.product_name ||
        req.query.productName ||
        req.query.q ||
        req.query.search,
    );

    const result = await listAddedOrders({
      page: req.query.page,
      limit: req.query.limit,
      from: hasFrom ? new Date(Array.isArray(fromRaw) ? fromRaw[0] : fromRaw) : undefined,
      to: hasTo ? new Date(Array.isArray(toRaw) ? toRaw[0] : toRaw) : undefined,
      employeeId,
      productName,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    if (error.code === "ADDED_ORDERS_NOT_CONFIGURED") {
      res.status(503).json({
        success: false,
        message: "Added orders table is not configured",
        setupHint: error.setupHint,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to fetch added orders",
      error: error.message,
    });
  }
}

module.exports = {
  postAddedOrder,
  getAddedOrders,
};
