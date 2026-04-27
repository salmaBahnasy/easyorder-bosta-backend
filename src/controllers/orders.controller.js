const bostaService = require("../services/bosta.service");
const easyorderService = require("../services/easyorder.service");
const {
  addWebhookOrder,
  getWebhookOrders,
  updateOrderStatus,
  editOrder,
  ALLOWED_ORDER_STATUSES,
} = require("../services/webhookOrders.service");
const { toPresentation } = require("../services/easyorderPresentation.service");

function getDefaultDateRange() {
  const now = new Date();

  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  from.setHours(0, 0, 0, 0);

  const to = new Date();
  to.setHours(23, 59, 59, 999);

  return { from, to };
}

async function getOrders(req, res) {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;

    const defaultRange = getDefaultDateRange();

    const from = req.query.from ? new Date(req.query.from) : defaultRange.from;
    const to = req.query.to ? new Date(req.query.to) : defaultRange.to;

    const status = req.query.status;

    if (status && !ALLOWED_ORDER_STATUSES.includes(status)) {
      res.status(400).json({
        success: false,
        message: "Invalid status filter",
        allowedStatuses: ALLOWED_ORDER_STATUSES,
      });
      return;
    }

    const result = await getWebhookOrders({
      page,
      limit,
      from,
      to,
      status,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
      error: error.message,
    });
  }
}

async function changeOrderStatus(req, res) {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    if (!status) {
      res.status(400).json({
        success: false,
        message: "status is required",
        allowedStatuses: ALLOWED_ORDER_STATUSES,
      });
      return;
    }

    const updatedOrder = await updateOrderStatus(orderId, status);

    res.json({
      success: true,
      message: "Order status updated successfully",
      data: updatedOrder,
    });
  } catch (error) {
    if (error.code === "INVALID_STATUS") {
      res.status(400).json({
        success: false,
        message: "Invalid status value",
        allowedStatuses: ALLOWED_ORDER_STATUSES,
      });
      return;
    }

    if (error.code === "ORDER_NOT_FOUND") {
      res.status(404).json({
        success: false,
        message: "Order not found",
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to update order status",
      error: error.message,
    });
  }
}

async function createOrder(req, res) {
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({
        success: false,
        message: "Order payload is required",
      });
      return;
    }

    const createdOrder = await addWebhookOrder(req.body);

    res.status(201).json({
      success: true,
      message: "Order created successfully",
      data: createdOrder,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to create order",
      error: error.message,
    });
  }
}

async function updateOrder(req, res) {
  try {
    const { orderId } = req.params;
    const updates = req.body;

    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      res.status(400).json({
        success: false,
        message: "Order updates payload is required",
      });
      return;
    }

    const updatedOrder = await editOrder(orderId, updates);

    res.json({
      success: true,
      message: "Order updated successfully",
      data: updatedOrder,
    });
  } catch (error) {
    if (error.code === "INVALID_UPDATES") {
      res.status(400).json({
        success: false,
        message: "Invalid updates payload",
      });
      return;
    }

    if (error.code === "INVALID_STATUS") {
      res.status(400).json({
        success: false,
        message: "Invalid status value",
        allowedStatuses: ALLOWED_ORDER_STATUSES,
      });
      return;
    }

    if (error.code === "ORDER_NOT_FOUND") {
      res.status(404).json({
        success: false,
        message: "Order not found",
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to update order",
      error: error.message,
    });
  }
}

async function getEasyOrderDetails(req, res) {
  try {
    const { orderId } = req.params;

    const orderDetails = await easyorderService.getOrderById(orderId);

    if (req.query.raw === "true") {
      res.json({
        success: true,
        data: orderDetails,
      });
      return;
    }

    const presented = toPresentation(orderDetails);

    if (!presented) {
      res.status(502).json({
        success: false,
        message: "EasyOrders response could not be mapped to an order shape",
        data: orderDetails,
      });
      return;
    }

    res.json({
      success: true,
      data: presented,
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      message: "Failed to fetch EasyOrders order details",
      error: error.response?.data || error.message,
    });
  }
}

// ـ--------------------
async function sendOrderToBosta(req, res) {
  try {
    const { orderId } = req.params;

    const order = await easyorderService.getOrderById(orderId);

    const shipment = await bostaService.createShipment(order);

    res.json({
      success: true,
      message: "Order sent to Bosta successfully",
      data: shipment,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to send order to Bosta",
      error: error.message,
    });
  }
}

async function getOrdersStats(req, res) {
  try {
    const supabase = require("../config/supabase");
    const TABLE = process.env.SUPABASE_ORDERS_TABLE || "orders";

    const { data, error } = await supabase.from(TABLE).select("status,total");

    if (error) throw error;

    const totalOrders = data.length;
    const totalRevenue = data.reduce((sum, o) => sum + Number(o.total || 0), 0);

    const stats = {
      totalOrders,
      newOrders: data.filter((o) => o.status === "new").length,
      confirmedOrders: data.filter((o) => o.status === "Confirmed").length,
      shippedOrders: data.filter((o) => o.status === "Shipped").length,
      canceledOrders: data.filter((o) => o.status === "canceled").length,
      noReplyOrders: data.filter((o) => o.status === "no_replay").length,
      totalRevenue,
      averageOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
    };

    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to get stats",
      error: error.message,
    });
  }
}

module.exports = {
  createOrder,
  updateOrder,
  getOrders,
  changeOrderStatus,
  sendOrderToBosta,
  getEasyOrderDetails,
  getOrdersStats,
};
