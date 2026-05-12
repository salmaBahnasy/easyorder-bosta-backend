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

const app = express();
const port = process.env.PORT || 5050;

// middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// health check
app.get("/", (req, res) => {
  res.json({
    message: "EasyOrder Bosta Backend is running",
  });
});

// routes
app.use("/api/orders", ordersRoutes);
app.use("/webhooks", webhooksRoutes);
app.use("/api/employees", employeesRoutes);
app.use("/api/products", productsRoutes);

// start server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
