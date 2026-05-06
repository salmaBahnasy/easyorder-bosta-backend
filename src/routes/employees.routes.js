const express = require("express");

const {
  loginSenior,
  getEmployees,
  addEmployee,
  deleteEmployee,
  editEmployee,
  setEmployeeActive,
} = require("../controllers/employees.controller");

const router = express.Router();

router.post("/login-senior", loginSenior);
router.get("/", getEmployees);
router.post("/", addEmployee);
router.patch("/:employeeId/active", setEmployeeActive);
router.patch("/:employeeId", editEmployee);
router.delete("/:employeeId", deleteEmployee);

module.exports = router;
