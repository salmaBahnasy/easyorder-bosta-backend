const EGYPT_TIMEZONE = "Africa/Cairo";

function getZonedParts(date, timeZone = EGYPT_TIMEZONE) {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== "literal") {
      parts[p.type] = p.value;
    }
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * Wall-clock in Egypt (Africa/Cairo) → UTC Date.
 */
function egyptLocalToUtc(
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);

  for (let i = 0; i < 5; i++) {
    const zoned = getZonedParts(new Date(utcMs));
    const zonedAsUtc = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
      millisecond,
    );
    const desiredAsUtc = Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      second,
      millisecond,
    );
    utcMs += desiredAsUtc - zonedAsUtc;
  }

  return new Date(utcMs);
}

/**
 * First day of current month 00:00:00 Egypt → now (Egypt), as UTC Date objects.
 */
function getEgyptMonthToDateRange(now = new Date()) {
  const egyptNow = getZonedParts(now);
  const from = egyptLocalToUtc(egyptNow.year, egyptNow.month, 1, 0, 0, 0, 0);
  const to = now;
  return { from, to };
}

/**
 * Full calendar day in Egypt for YYYY-MM-DD → UTC bounds.
 * @param {string} date - e.g. "2026-05-23"
 */
function getEgyptDayRange(date) {
  const m = String(date || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    const err = new Error('date must be "YYYY-MM-DD"');
    err.code = "INVALID_DATE";
    throw err;
  }

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  const from = egyptLocalToUtc(year, month, day, 0, 0, 0, 0);
  const to = egyptLocalToUtc(year, month, day, 23, 59, 59, 999);

  return { from, to };
}

function isEasyOrderApiRequest(req) {
  const original = String(req.originalUrl || req.url || "");
  const base = String(req.baseUrl || "");
  return original.includes("/api/easyorder") || base.includes("/easyorder");
}

/**
 * EasyOrder routes: default = Egypt month-to-date when from & to omitted.
 * Otherwise parse query values as-is.
 */
function resolveEasyOrderDateRange(req) {
  const fromRaw = req.query?.from;
  const toRaw = req.query?.to;
  const hasFrom =
    fromRaw != null && String(Array.isArray(fromRaw) ? fromRaw[0] : fromRaw).trim() !== "";
  const hasTo =
    toRaw != null && String(Array.isArray(toRaw) ? toRaw[0] : toRaw).trim() !== "";

  if (!hasFrom && !hasTo) {
    const { from, to } = getEgyptMonthToDateRange();
    console.log("DATE_FILTER", {
      from: from.toISOString(),
      to: to.toISOString(),
    });
    return { from, to, usedDefault: true };
  }

  let from = null;
  let to = null;

  if (hasFrom) {
    from = new Date(Array.isArray(fromRaw) ? fromRaw[0] : fromRaw);
    if (Number.isNaN(from.getTime())) {
      const err = new Error("Invalid from date");
      err.code = "INVALID_FROM";
      throw err;
    }
  }

  if (hasTo) {
    to = new Date(Array.isArray(toRaw) ? toRaw[0] : toRaw);
    if (Number.isNaN(to.getTime())) {
      const err = new Error("Invalid to date");
      err.code = "INVALID_TO";
      throw err;
    }
  }

  console.log("DATE_FILTER", {
    from: from ? from.toISOString() : null,
    to: to ? to.toISOString() : null,
  });

  return { from, to, usedDefault: false };
}

module.exports = {
  EGYPT_TIMEZONE,
  getEgyptMonthToDateRange,
  getEgyptDayRange,
  egyptLocalToUtc,
  isEasyOrderApiRequest,
  resolveEasyOrderDateRange,
};
