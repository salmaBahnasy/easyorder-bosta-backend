const path = require("path");
const express = require("express");
const cors = require("cors");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const ordersRoutes = require("./routes/orders.routes");
const webhooksRoutes = require("./routes/webhooks.routes");
const easyconfirmRoutes = require("./routes/easyconfirm.routes");
const employeesRoutes = require("./routes/employees.routes");
const productsRoutes = require("./routes/products.routes");
const sallaRoutes = require("./routes/salla.routes");
const easyorderRoutes = require("./routes/easyorder.routes");
const bostaRoutes = require("./routes/bosta.routes");
const addedOrdersRoutes = require("./routes/addedOrders.routes");
const {
  handleEasyConfirmWebhook,
} = require("./controllers/easyconfirm.controller");

const app = express();
const port = process.env.PORT || 5050;

app.use(cors());

/**
 * EasyConfirm webhook MUST use raw body for HMAC verification.
 * Registered BEFORE express.json() so the body is not parsed first.
 * Does not affect any other routes.
 */
app.post(
  "/webhooks/easyconfirm",
  express.raw({ type: "application/json", limit: "10mb" }),
  handleEasyConfirmWebhook,
);

// All other routes use normal JSON parsing
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.json({
    message: "EasyOrder Bosta Backend is running",
  });
});

app.use("/api/orders", ordersRoutes);
app.use("/webhooks", webhooksRoutes);
// EasyConfirm debug GETs only (POST is registered above with express.raw)
app.use("/webhooks", easyconfirmRoutes);
app.use("/api/employees", employeesRoutes);
app.use("/api/easyorder", easyorderRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/salla", sallaRoutes);
app.use("/api/bosta", bostaRoutes);
app.use("/api/added-orders", addedOrdersRoutes);

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
