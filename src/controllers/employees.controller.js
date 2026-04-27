const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const supabase = require("../config/supabase");

const EMPLOYEES_TABLE = process.env.SUPABASE_EMPLOYEES_TABLE || "employees";
const ALLOWED_ROLES = ["senior", "agent", "employee", "junior"];

function buildSafeEmployee(employee) {
  if (!employee) return null;

  const { password, ...safeEmployee } = employee;
  return safeEmployee;
}

async function loginSenior(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({
        success: false,
        message: "email and password are required",
      });
      return;
    }

    const { data: employee, error } = await supabase
      .from(EMPLOYEES_TABLE)
      .select("*")
      .eq("email", email)
      .single();

    if (error || !employee) {
      res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
      return;
    }

    const isValidPassword = await bcrypt.compare(password, employee.password);
    if (!isValidPassword) {
      res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
      return;
    }

    if (employee.role !== "senior") {
      res.status(403).json({
        success: false,
        message: "Access denied. Senior role required.",
      });
      return;
    }

    const token = jwt.sign(
      {
        employeeId: employee.id,
        role: employee.role,
        email: employee.email,
      },
      process.env.JWT_SECRET || "dev-secret-change-me",
      { expiresIn: "7d" },
    );

    res.json({
      success: true,
      message: "Senior login successful",
      token,
      data: buildSafeEmployee(employee),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to login senior",
      error: error.message,
    });
  }
}

async function getEmployees(req, res) {
  try {
    const { data, error } = await supabase
      .from(EMPLOYEES_TABLE)
      .select("id,name,email,role,created_at")
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    res.json({
      success: true,
      total: data.length,
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch employees",
      error: error.message,
    });
  }
}

async function addEmployee(req, res) {
  try {
    const { name, email, password, role = "employee" } = req.body;

    if (!name || !email || !password) {
      res.status(400).json({
        success: false,
        message: "name, email and password are required",
      });
      return;
    }

    if (!ALLOWED_ROLES.includes(role)) {
      res.status(400).json({
        success: false,
        message: "Invalid role",
        allowedRoles: ALLOWED_ROLES,
      });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const { data, error } = await supabase
      .from(EMPLOYEES_TABLE)
      .insert({
        name,
        email,
        password: hashedPassword,
        role,
      })
      .select("id,name,email,role,created_at")
      .single();

    if (error) {
      throw new Error(error.message);
    }

    res.status(201).json({
      success: true,
      message: "Employee added successfully",
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to add employee",
      error: error.message,
    });
  }
}

async function deleteEmployee(req, res) {
  try {
    const { employeeId } = req.params;

    const { data, error } = await supabase
      .from(EMPLOYEES_TABLE)
      .delete()
      .eq("id", employeeId)
      .select("id")
      .single();

    if (error || !data) {
      res.status(404).json({
        success: false,
        message: "Employee not found",
      });
      return;
    }

    res.json({
      success: true,
      message: "Employee deleted successfully",
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete employee",
      error: error.message,
    });
  }
}

async function editEmployee(req, res) {
  try {
    const { employeeId } = req.params;
    const { name, email, phone, password, role, is_active } = req.body;

    const updates = {};

    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email;
    if (phone !== undefined) updates.phone = phone;
    if (is_active !== undefined) updates.is_active = Boolean(is_active);

    if (role !== undefined) {
      if (!ALLOWED_ROLES.includes(role)) {
        res.status(400).json({
          success: false,
          message: "Invalid role",
          allowedRoles: ALLOWED_ROLES,
        });
        return;
      }
      updates.role = role;
    }

    if (password !== undefined) {
      updates.password = await bcrypt.hash(password, 10);
    }

    if (!Object.keys(updates).length) {
      res.status(400).json({
        success: false,
        message:
          "No fields to update. Send at least one of: name, email, phone, password, role, is_active",
      });
      return;
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from(EMPLOYEES_TABLE)
      .update(updates)
      .eq("id", employeeId)
      .select("id,name,email,phone,role,is_active,created_at,updated_at")
      .single();

    if (error || !data) {
      res.status(404).json({
        success: false,
        message: "Employee not found",
      });
      return;
    }

    res.json({
      success: true,
      message: "Employee updated successfully",
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to update employee",
      error: error.message,
    });
  }
}

module.exports = {
  loginSenior,
  getEmployees,
  addEmployee,
  deleteEmployee,
  editEmployee,
};
