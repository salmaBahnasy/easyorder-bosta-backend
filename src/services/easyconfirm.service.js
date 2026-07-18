const crypto = require("crypto");
const {
  toEasyConfirmWebhookPayload,
} = require("../dto/easyconfirmWebhook.dto");
const {
  applyEasyConfirmConfirmationUpdate,
  findOrderForEasyConfirm,
  findOrderForEasyConfirmByPhone,
} = require("./webhookOrders.service");
const supabase = require("../config/supabase");

/**
 * EasyConfirm webhook service.
 *
 * FIELD MAPPING (update here after inspecting real webhook payloads):
 * - event:            body.event OR header X-EasyConfirm-Event
 * - order id/number:  data.externalOrderId | data.orderId | data.short_id
 * - phone:            data.customerPhone (fallback match only if no order id)
 * - status:           data.status | data.customerAction | inferred from event
 * - timestamp:        body.timestamp | data.updatedAt
 *
 * Docs: https://docs.easyconfirm.net/docs/webhooks/payload-format
 * Signature: https://docs.easyconfirm.net/docs/webhooks/signature-verification
 */

const EVENTS_TABLE =
  process.env.SUPABASE_EASYCONFIRM_WEBHOOK_EVENTS_TABLE ||
  "easyconfirm_webhook_events";

const CONFIRMATION_STATUSES = [
  "pending",
  "confirmed",
  "cancelled",
  "failed",
];

function pickEasyConfirmEventHeader(headers = {}) {
  if (!headers || typeof headers !== "object") return "";
  return String(
    headers["x-easyconfirm-event"] || headers["X-EasyConfirm-Event"] || "",
  ).trim();
}

function pickSignatureHeader(headers = {}) {
  if (!headers || typeof headers !== "object") return "";
  return String(
    headers["x-easyconfirm-signature"] ||
      headers["X-EasyConfirm-Signature"] ||
      "",
  ).trim();
}

/**
 * Verify X-EasyConfirm-Signature:
 * HMAC-SHA256(secret, raw_body) as "sha256=<hex>"
 */
function verifyEasyConfirmSignature(rawBody, signatureHeader, secret) {
  if (!secret) {
    return { ok: true, skipped: true };
  }
  if (!signatureHeader) {
    return { ok: false, reason: "Missing X-EasyConfirm-Signature header" };
  }

  const payload = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(
        typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody ?? {}),
        "utf8",
      );

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(payload).digest("hex");

  try {
    const a = Buffer.from(String(signatureHeader));
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
      return { ok: false, reason: "Invalid signature" };
    }
    return crypto.timingSafeEqual(a, b)
      ? { ok: true, skipped: false }
      : { ok: false, reason: "Invalid signature" };
  } catch {
    return { ok: false, reason: "Invalid signature" };
  }
}

function normalizeConfirmationStatus(raw, eventType = "") {
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

  const value = String(raw || "")
    .trim()
    .toLowerCase();
  const aliases = {
    pending: "pending",
    waiting: "pending",
    confirmed: "confirmed",
    approved: "confirmed",
    confirm: "confirmed",
    canceled: "cancelled",
    cancelled: "cancelled",
    cancel: "cancelled",
    failed: "failed",
    fail: "failed",
  };
  return aliases[value] || "";
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

  const orderIdCandidates = [
    nested.externalOrderId,
    nested.external_order_id,
    nested.orderId,
    nested.order_id,
    nested.short_id,
    nested.shortId,
    payload.externalOrderId,
    payload.external_order_id,
    payload.orderId,
    payload.order_id,
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  const phone = String(
    nested.customerPhone ||
      nested.customer_phone ||
      nested.phone ||
      payload.customerPhone ||
      payload.phone ||
      "",
  ).trim();

  const statusRaw =
    nested.status ||
    nested.customerAction ||
    nested.customer_action ||
    payload.status ||
    "";

  const confirmationStatus = normalizeConfirmationStatus(statusRaw, eventType);

  const eventTimestamp = String(
    payload.timestamp ||
      nested.updatedAt ||
      nested.updated_at ||
      nested.createdAt ||
      "",
  ).trim();

  const easyconfirmOrderId = String(nested.id || "").trim();

  return {
    eventType: eventType || null,
    eventTimestamp: eventTimestamp || null,
    orderIdCandidates,
    phone: phone || null,
    statusRaw: statusRaw || null,
    confirmationStatus: confirmationStatus || null,
    easyconfirmOrderId: easyconfirmOrderId || null,
    customerAction: nested.customerAction ?? nested.customer_action ?? null,
    deliveryStatus: nested.deliveryStatus ?? nested.delivery_status ?? null,
    externalOrderId:
      nested.externalOrderId ?? nested.external_order_id ?? null,
  };
}

function buildEasyConfirmEventId(payload, extracted) {
  const basis = JSON.stringify({
    event: extracted.eventType,
    timestamp: extracted.eventTimestamp,
    easyconfirmId: extracted.easyconfirmOrderId,
    externalOrderId: extracted.externalOrderId,
    status: extracted.confirmationStatus || extracted.statusRaw,
    // Include deliveryStatus so redeliveries of same logical state still dedupe
    deliveryStatus: extracted.deliveryStatus,
  });
  return crypto.createHash("sha256").update(basis).digest("hex");
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
          "easyconfirm_webhook_events insert failed — falling back to order-level idempotency. Run: node scripts/setup-easyconfirm-webhook-events.js",
        error: error.message,
      }),
    );
  }
  return { isNew: true, fallback: true };
}

function redactHeaders(headers = {}) {
  const safe = { ...(headers || {}) };
  for (const key of Object.keys(safe)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("api-key") ||
      lower.includes("authorization") ||
      lower.includes("secret")
    ) {
      safe[key] = "[redacted]";
    }
  }
  return safe;
}

/**
 * Receive EasyConfirm webhook: log → verify → idempotent ERP update.
 */
async function receiveEasyConfirmWebhook({ headers, body, rawBody }) {
  const receivedAt = new Date().toISOString();
  const payload = toEasyConfirmWebhookPayload(body);
  const eventHeader = pickEasyConfirmEventHeader(headers);
  if (!payload.event && eventHeader) {
    payload.event = eventHeader;
  }

  console.log(
    JSON.stringify(
      {
        source: "easyconfirm-webhook",
        timestamp: receivedAt,
        event: payload.event || eventHeader || null,
        headers: redactHeaders(headers),
        body: payload,
      },
      null,
      2,
    ),
  );

  const webhookSecret = process.env.EASYCONFIRM_WEBHOOK_SECRET;
  const signature = pickSignatureHeader(headers);
  const verification = verifyEasyConfirmSignature(
    rawBody != null ? rawBody : JSON.stringify(body ?? {}),
    signature,
    webhookSecret,
  );

  if (webhookSecret && !verification.ok) {
    const err = new Error(verification.reason || "Invalid signature");
    err.code = "EASYCONFIRM_INVALID_SIGNATURE";
    err.statusCode = 401;
    throw err;
  }

  if (verification.skipped) {
    console.warn(
      JSON.stringify({
        source: "easyconfirm-webhook",
        level: "warn",
        message:
          "EASYCONFIRM_WEBHOOK_SECRET not set — signature verification skipped",
      }),
    );
  }

  const extracted = extractEasyConfirmFields(payload, eventHeader);
  const eventId = buildEasyConfirmEventId(payload, extracted);

  // Incomplete payload: log + 200, do not fail
  if (
    !extracted.eventType &&
    !extracted.confirmationStatus &&
    extracted.orderIdCandidates.length === 0
  ) {
    console.warn(
      JSON.stringify({
        source: "easyconfirm-webhook",
        level: "warn",
        message:
          "EasyConfirm payload missing expected fields — logged raw body. Update extractEasyConfirmFields() after inspecting production payload.",
        mappingFile:
          "src/services/easyconfirm.service.js#extractEasyConfirmFields",
        eventId,
      }),
    );
    return {
      receivedAt,
      payload,
      order: null,
      eventId,
      warning: "Payload missing expected EasyConfirm fields — logged only",
      duplicate: false,
    };
  }

  let order = null;
  let matchWarning = null;
  const hasOrderId = extracted.orderIdCandidates.length > 0;

  if (hasOrderId) {
    try {
      order = await findOrderForEasyConfirm({
        candidates: extracted.orderIdCandidates,
        externalOrderId: extracted.externalOrderId,
        // Do not pass EasyConfirm internal UUID as primary id
        id: null,
      });
    } catch (error) {
      if (error.code !== "ORDER_NOT_FOUND") throw error;
      matchWarning = "Order not found";
    }
  } else if (extracted.phone) {
    try {
      order = await findOrderForEasyConfirmByPhone(extracted.phone);
    } catch (error) {
      if (error.code === "ORDER_REFERENCE_AMBIGUOUS") {
        matchWarning = "Multiple orders match phone — skipped";
      } else if (error.code === "ORDER_NOT_FOUND") {
        matchWarning = "Order not found";
      } else {
        throw error;
      }
    }
  } else {
    matchWarning = "Order not found";
  }

  const claim = await claimWebhookEvent({
    eventId,
    eventType: extracted.eventType,
    orderId: order?.sourceOrderId || null,
    confirmationStatus: extracted.confirmationStatus,
    payload,
  });

  if (!claim.isNew) {
    return {
      receivedAt,
      payload,
      order,
      eventId,
      duplicate: true,
      warning: "Duplicate webhook event — skipped",
    };
  }

  if (!order) {
    console.warn(
      JSON.stringify({
        source: "easyconfirm-webhook",
        level: "warn",
        message: matchWarning || "Order not found for EasyConfirm payload",
        eventId,
        event: extracted.eventType,
        externalOrderId: extracted.externalOrderId,
        orderIdCandidates: extracted.orderIdCandidates,
        phoneFallbackUsed: Boolean(extracted.phone) && !hasOrderId,
      }),
    );
    return {
      receivedAt,
      payload,
      order: null,
      eventId,
      duplicate: false,
      warning: matchWarning || "Order not found",
      extracted,
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
        duplicate: true,
        warning: "Duplicate webhook event — skipped",
      };
    }
  }

  const updated = await applyEasyConfirmConfirmationUpdate(order.sourceOrderId, {
    confirmationStatus: extracted.confirmationStatus,
    customerStatus: extracted.confirmationStatus
      ? confirmationStatusToCustomerStatus(extracted.confirmationStatus)
      : null,
    eventType: extracted.eventType,
    eventId,
    payload,
    extracted,
    receivedAt,
  });

  return {
    receivedAt,
    payload,
    order: updated,
    eventId,
    duplicate: false,
    extracted,
    ...(extracted.confirmationStatus
      ? {}
      : {
          warning:
            "No confirmation_status mapped — EasyConfirm metadata saved; update normalizeConfirmationStatus() if needed",
        }),
  };
}

module.exports = {
  receiveEasyConfirmWebhook,
  pickEasyConfirmEventHeader,
  verifyEasyConfirmSignature,
  normalizeConfirmationStatus,
  confirmationStatusToCustomerStatus,
  extractEasyConfirmFields,
  buildEasyConfirmEventId,
  CONFIRMATION_STATUSES,
};
