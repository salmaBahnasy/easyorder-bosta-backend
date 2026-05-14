const express = require("express");

const { login } = require("../controllers/employees.controller");

const router = express.Router();

/**
 * Frontend-friendly alias for employee login (same as POST /api/employees/login).
 */
router.post("/auth/login", login);

module.exports = router;
