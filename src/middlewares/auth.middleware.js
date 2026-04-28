const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      res.status(401).json({
        success: false,
        message: "Unauthorized. Bearer token is required.",
      });
      return;
    }

    const jwtSecret = process.env.JWT_SECRET || "dev-secret-change-me";
    const decoded = jwt.verify(token, jwtSecret);

    req.user = {
      id: decoded.employeeId,
      role: decoded.role,
      email: decoded.email,
    };

    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
}

module.exports = {
  requireAuth,
};
