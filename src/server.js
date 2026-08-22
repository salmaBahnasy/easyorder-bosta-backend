const path = require("path");
const express = require("express");
const cors = require("cors");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
});

const ordersRoutes = require("./routes/orders.routes");
const webhooksRoutes = require("./routes/webhooks.routes");
const employeesRoutes = require("./routes/employees.routes");
const productsRoutes = require("./routes/products.routes");
const sallaRoutes = require("./routes/salla.routes");
const easyorderRoutes = require("./routes/easyorder.routes");
const bostaRoutes = require("./routes/bosta.routes");
const addedOrdersRoutes = require("./routes/addedOrders.routes");

const app = express();
const port = process.env.PORT || 5050;

app.use(cors());
app.use(
  express.json({
    limit: "10mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.get("/", (req, res) => {
  res.json({
    message: "EasyOrder Bosta Backend is running",
  });
});

app.use("/api/orders", ordersRoutes);
app.use("/webhooks", webhooksRoutes);
app.use("/api/employees", employeesRoutes);
app.use("/api/easyorder", easyorderRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/salla", sallaRoutes);
app.use("/api/bosta", bostaRoutes);
app.use("/api/added-orders", addedOrdersRoutes);

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
