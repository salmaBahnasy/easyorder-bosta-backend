const crypto = require("crypto");
const {
  toEasyConfirmWebhookPayload,
} = require("../dto/easyconfirmWebhook.dto");
const {
  applyEasyConfirmConfirmationUpdate,
  findOrderByEasyConfirmExternalOrderId,
} = require("./webhookOrders.service");
const supabase = require("../config/supabase");

/**
 * EasyConfirm webhook service.
 *
 * Matching rule (critical):
 *   data.externalOrderId  →  ERP orders.order_reference
 *   Example: "7430" matches order_reference = 7430
 *
 * Do NOT match by:
 *   - data.id (EasyConfirm internal UUID)
 *   - customer phone (primary)
 *
 * Mapping file to adjust if payload shape changes: extractEasyConfirmFields()
 */

const EVENTS_TABLE =
  process.env.SUPABASE_EASYCONFIRM_WEBHOOK_EVENTS_TABLE ||
  "easyconfirm_webhook_events";

function pickHeader(headers, ...names) {
  if (!headers || typeof headers !== "object") return "";
  for (const name of names) {
    if (headers[name] != null && String(headers[name]).trim() !== "") {
      return String(headers[name]).trim();
    }
  }
  return "";
}

/**
 * Verify X-EasyConfirm-Signature:
 * HMAC-SHA256(secret, raw_body) → "sha256=<hex>"
 * Uses EASYCONFIRM_WEBHOOK_SECRET only (not API key).
 *
 * Returns { ok: false } when secret or signature is missing/invalid.
 */
function verifyEasyConfirmSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) {
    return { ok: false, reason: "Invalid signature" };
  }

  const payload = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(
        typeof rawBody === "string" ? rawBody : String(rawBody ?? ""),
        "utf8",
      );

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(payload).digest("hex");

  const a = Buffer.from(String(signatureHeader));
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return { ok: false, reason: "Invalid signature" };
  }

  try {
    return crypto.timingSafeEqual(a, b)
      ? { ok: true }
      : { ok: false, reason: "Invalid signature" };
  } catch {
    return { ok: false, reason: "Invalid signature" };
  }
}

/** Map EasyConfirm data.status → ERP confirmation_status */
function mapStatusToConfirmation(statusRaw) {
  const value = String(statusRaw || "")
    .trim()
    .toLowerCase();
  const map = {
    pending: "pending",
    waiting: "pending",
    confirmed: "confirmed",
    approved: "confirmed",
    // EasyConfirm uses one L; ERP stores two L
    canceled: "cancelled",
    cancelled: "cancelled",
    failed: "failed",
  };
  return map[value] || "";
}

/** Map event → confirmation_status (fallback when data.status missing) */
function mapEventToConfirmation(eventType) {
  const event = String(eventType || "")
    .trim()
    .toLowerCase();
  if (event === "order.confirmed" || event.endsWith(".confirmed")) {
    return "confirmed";
  }
  if (
    event === "order.canceled" ||
    event === "order.cancelled" ||
    event.endsWith(".canceled") ||
    event.endsWith(".cancelled")
  ) {
    return "cancelled";
  }
  if (event === "order.failed" || event.endsWith(".failed")) {
    return "failed";
  }
  if (event === "order.created" || event.endsWith(".created")) {
    return "pending";
  }
  return "";
}

/**
 * Prefer data.status; fall back to event.
 */
function resolveConfirmationStatus(statusRaw, eventType) {
  return (
    mapStatusToConfirmation(statusRaw) ||
    mapEventToConfirmation(eventType) ||
    ""
  );
}

function confirmationStatusToCustomerStatus(confirmationStatus) {
  if (confirmationStatus === "confirmed") return "confirmed";
  if (confirmationStatus === "cancelled") return "canceled";
  if (confirmationStatus === "failed") return "failed";
  return "pending";
}

function extractEasyConfirmFields(payload = {}, eventHeader = "") {
  const nested =
    payload.data &&
    typeof payload.data === "object" &&
    !Array.isArray(payload.data)
      ? payload.data
      : {};

  const eventType = String(payload.event || eventHeader || "").trim();
  const externalOrderId = String(
    nested.externalOrderId ??
      nested.external_order_id ??
      payload.externalOrderId ??
      payload.external_order_id ??
      "",
  ).trim();

  const statusRaw = nested.status ?? payload.status ?? "";
  const confirmationStatus = resolveConfirmationStatus(statusRaw, eventType);

  return {
    eventType: eventType || null,
    eventTimestamp: String(
      payload.timestamp || nested.updatedAt || nested.updated_at || "",
    ).trim() || null,
    externalOrderId: externalOrderId || null,
    // EasyConfirm internal id — for storage/idempotency only, NEVER for ERP match
    easyconfirmOrderId: String(nested.id || "").trim() || null,
    phone: String(
      nested.customerPhone || nested.customer_phone || nested.phone || "",
    ).trim() || null,
    statusRaw: statusRaw ? String(statusRaw) : null,
    confirmationStatus: confirmationStatus || null,
    customerAction: nested.customerAction ?? nested.customer_action ?? null,
    deliveryStatus: nested.deliveryStatus ?? nested.delivery_status ?? null,
  };
}

/** Dedup key: `${data.id}:${event}` */
function buildEasyConfirmEventId(extracted) {
  const ecId = extracted.easyconfirmOrderId || "unknown";
  const event = extracted.eventType || "unknown";
  return `${ecId}:${event}`;
}

async function claimWebhookEvent({
  eventId,
  eventType,
  orderId,
  confirmationStatus,
  payload,
}) {
  const { data, error } = await supabase
    .from(EVENTS_TABLE)
    .insert({
      event_id: eventId,
      event_type: eventType,
      order_id: orderId,
      confirmation_status: confirmationStatus,
      payload,
    })
    .select("event_id")
    .maybeSingle();

  if (!error && data) {
    return { isNew: true };
  }

  const code = String(error?.code || "");
  const msg = String(error?.message || "").toLowerCase();
  if (
    code === "23505" ||
    msg.includes("duplicate") ||
    msg.includes("unique")
  ) {
    return { isNew: false };
  }

  if (error) {
    console.warn(
      JSON.stringify({
        source: "easyconfirm-webhook",
        level: "warn",
        message:
          "easyconfirm_webhook_events insert failed — order-level idempotency fallback. Run: npm run setup-easyconfirm-webhook-events",
        error: error.message,
      }),
    );
  }
  return { isNew: true, fallback: true };
}

/**
 * Receive EasyConfirm webhook and update ERP confirmation fields.
 * Signature must already be verified by the controller (signatureVerified: true).
 */
async function receiveEasyConfirmWebhook({
  headers,
  body,
  signatureVerified = false,
}) {
  if (!signatureVerified) {
    const err = new Error("Invalid signature");
    err.code = "EASYCONFIRM_INVALID_SIGNATURE";
    err.statusCode = 401;
    throw err;
  }

  const receivedAt = new Date().toISOString();
  const payload = toEasyConfirmWebhookPayload(body);
  const eventHeader = pickHeader(
    headers,
    "x-easyconfirm-event",
    "X-EasyConfirm-Event",
  );
  if (!payload.event && eventHeader) {
    payload.event = eventHeader;
  }

  const extracted = extractEasyConfirmFields(payload, eventHeader);
  const eventId = buildEasyConfirmEventId(extracted);

  // Safe fields only — never log secrets or signature
  console.log(
    JSON.stringify({
      source: "easyconfirm-webhook",
      timestamp: receivedAt,
      event: extracted.eventType,
      id: extracted.easyconfirmOrderId,
      externalOrderId: extracted.externalOrderId,
      status: extracted.statusRaw,
      customerAction: extracted.customerAction,
    }),
  );

  // Match ONLY by data.externalOrderId → orders.order_reference
  let order = null;
  let orderFound = false;

  if (extracted.externalOrderId) {
    try {
      order = await findOrderByEasyConfirmExternalOrderId(
        extracted.externalOrderId,
      );
      orderFound = Boolean(order);
    } catch (error) {
      if (error.code !== "ORDER_NOT_FOUND") throw error;
      orderFound = false;
    }
  }

  console.log(
    JSON.stringify({
      source: "easyconfirm-webhook",
      level: "info",
      message: orderFound
        ? "ERP order matched by order_reference"
        : "ERP order NOT found for externalOrderId",
      event: extracted.eventType,
      id: extracted.easyconfirmOrderId,
      externalOrderId: extracted.externalOrderId,
      status: extracted.statusRaw,
      customerAction: extracted.customerAction,
      orderFound,
      matchedOrderReference:
        order?.order_reference ?? order?.orderReference ?? null,
    }),
  );

  if (!orderFound) {
    console.warn(
      JSON.stringify({
        source: "easyconfirm-webhook",
        level: "warn",
        message:
          "No ERP order for EasyConfirm externalOrderId — skipping update",
        event: extracted.eventType,
        id: extracted.easyconfirmOrderId,
        externalOrderId: extracted.externalOrderId,
        status: extracted.statusRaw,
        customerAction: extracted.customerAction,
      }),
    );
    await claimWebhookEvent({
      eventId,
      eventType: extracted.eventType,
      orderId: null,
      confirmationStatus: extracted.confirmationStatus,
      payload,
    });
    return {
      receivedAt,
      payload,
      order: null,
      eventId,
      orderFound: false,
      warning: "Order not found",
    };
  }

  const claim = await claimWebhookEvent({
    eventId,
    eventType: extracted.eventType,
    orderId: order.sourceOrderId,
    confirmationStatus: extracted.confirmationStatus,
    payload,
  });

  if (!claim.isNew) {
    console.log(
      JSON.stringify({
        source: "easyconfirm-webhook",
        level: "info",
        message: "Duplicate EasyConfirm event — skipped",
        event: extracted.eventType,
        id: extracted.easyconfirmOrderId,
        externalOrderId: extracted.externalOrderId,
        status: extracted.statusRaw,
        customerAction: extracted.customerAction,
      }),
    );
    return {
      receivedAt,
      payload,
      order,
      eventId,
      orderFound: true,
      duplicate: true,
    };
  }

  if (claim.fallback) {
    const prev =
      order.easyconfirm_last_event_id || order.easyconfirmLastEventId;
    if (prev && String(prev) === String(eventId)) {
      return {
        receivedAt,
        payload,
        order,
        eventId,
        orderFound: true,
        duplicate: true,
      };
    }
  }

  const updated = await applyEasyConfirmConfirmationUpdate(order.sourceOrderId, {
    confirmationStatus: extracted.confirmationStatus || "pending",
    customerStatus: confirmationStatusToCustomerStatus(
      extracted.confirmationStatus || "pending",
    ),
    eventType: extracted.eventType,
    eventId,
    payload,
    extracted,
    receivedAt,
  });

  console.log(
    JSON.stringify({
      source: "easyconfirm-webhook",
      level: "info",
      message: "EasyConfirm confirmation applied to ERP order",
      event: extracted.eventType,
      id: extracted.easyconfirmOrderId,
      externalOrderId: extracted.externalOrderId,
      status: extracted.statusRaw,
      customerAction: extracted.customerAction,
      orderFound: true,
      confirmation_status: updated.confirmation_status,
      dbUpdateSucceeded: true,
    }),
  );

  return {
    receivedAt,
    payload,
    order: updated,
    eventId,
    orderFound: true,
    duplicate: false,
  };
}

/**
 * Diagnostic: lookup ERP order by EasyConfirm externalOrderId (order_reference).
 */
async function diagnoseEasyConfirmExternalOrderId(externalOrderId) {
  const id = String(externalOrderId || "").trim();
  if (!id) {
    return { found: false, error: "externalOrderId required" };
  }
  try {
    const order = await findOrderByEasyConfirmExternalOrderId(id);
    return {
      found: true,
      matchField: "orders.order_reference",
      externalOrderId: id,
      order: {
        sourceOrderId: order.sourceOrderId,
        order_reference: order.order_reference ?? order.orderReference ?? null,
        short_id: order.short_id ?? order.shortId ?? null,
        phone: order.phone || order.mobile || null,
        status: order.status,
        confirmation_status:
          order.confirmation_status ?? order.confirmationStatus ?? null,
        customer_status: order.customer_status ?? order.customerStatus ?? null,
        confirmation_source: order.confirmation_source ?? null,
        confirmation_updated_at: order.confirmation_updated_at ?? null,
        easyconfirm_order_id:
          order.easyconfirm_order_id ?? order.easyconfirm_id ?? null,
        easyconfirm_event:
          order.easyconfirm_event ?? order.easyconfirm_event_type ?? null,
      },
    };
  } catch (error) {
    if (error.code === "ORDER_NOT_FOUND") {
      return {
        found: false,
        matchField: "orders.order_reference",
        externalOrderId: id,
      };
    }
    throw error;
  }
}

module.exports = {
  receiveEasyConfirmWebhook,
  verifyEasyConfirmSignature,
  resolveConfirmationStatus,
  mapStatusToConfirmation,
  mapEventToConfirmation,
  extractEasyConfirmFields,
  buildEasyConfirmEventId,
  confirmationStatusToCustomerStatus,
  diagnoseEasyConfirmExternalOrderId,
};
