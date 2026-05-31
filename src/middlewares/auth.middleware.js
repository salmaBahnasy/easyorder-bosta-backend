const jwt = require("jsonwebtoken");

function readBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }
  return token;
}

function decodeEmployeeFromToken(token) {
  const jwtSecret = process.env.JWT_SECRET || "dev-secret-change-me";
  const decoded = jwt.verify(token, jwtSecret);
  return {
    id: decoded.employeeId,
    role: decoded.role,
    employeeRole: decoded.employeeRole ?? decoded.role,
    email: decoded.email,
  };
}

/**
 * Sets req.user when a valid Bearer token is sent; otherwise continues without req.user.
 * Invalid tokens are ignored (no 401) so unauthenticated clients keep working.
 */
function optionalAuth(req, res, next) {
  const token = readBearerToken(req);
  if (!token) {
    next();
    return;
  }
  try {
    req.user = decodeEmployeeFromToken(token);
  } catch {
    // ignore bad/expired token for optional routes
  }
  next();
}

function requireAuth(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) {
      res.status(401).json({
        success: false,
        message: "Unauthorized. Bearer token is required.",
      });
      return;
    }

    req.user = decodeEmployeeFromToken(token);
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
  optionalAuth,
};
