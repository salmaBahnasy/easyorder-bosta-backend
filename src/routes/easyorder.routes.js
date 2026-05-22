const express = require("express");

const { login } = require("../controllers/employees.controller");
const { getOrdersStats, getOrdersAnalytics } = require("../controllers/orders.controller");
const ordersRoutes = require("./orders.routes");
const employeesRoutes = require("./employees.routes");
const productsRoutes = require("./products.routes");
const sallaRoutes = require("./salla.routes");
const bostaRoutes = require("./bosta.routes");

const router = express.Router();

/**
 * Frontend base: /api/easyorder/… mirrors the same handlers as /api/orders, /api/employees, /api/products, /api/salla.
 * Uses the same router modules (mounted again) so paths stay in sync without duplicating handler wiring.
 */
router.post("/auth/login", login);

/** Some clients use /api/easyorder/stats instead of /api/easyorder/orders/stats */
router.get("/stats", getOrdersStats);
router.get("/analytics", getOrdersAnalytics);

router.use("/orders", ordersRoutes);
router.use("/employees", employeesRoutes);
router.use("/products", productsRoutes);
router.use("/salla", sallaRoutes);
router.use("/bosta", bostaRoutes);

module.exports = router;
