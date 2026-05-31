const express = require("express");

const {
  login,
  getEmployees,
  addEmployee,
  deleteEmployee,
  editEmployee,
  setEmployeeActive,
} = require("../controllers/employees.controller");

const router = express.Router();

router.post("/login", login);
/** @deprecated استخدم `POST /api/employees/login` */
router.post("/login-senior", login);

router.get("/", getEmployees);
router.post("/", addEmployee);
router.patch("/:employeeId/active", setEmployeeActive);
router.patch("/:employeeId", editEmployee);
router.delete("/:employeeId", deleteEmployee);

module.exports = router;
