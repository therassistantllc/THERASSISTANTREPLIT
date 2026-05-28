import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function value(input: unknown) {
  return String(input ?? "").trim();
}

// Resend sends webhooks via Svix. We verify the signature using the
// `RESEND_WEBHOOK_SECRET` shared secret. Spec:
//   https://docs.svix.com/receiving/verifying-payloads/how-manual
// Header format:
//   svix-id: <id>
//   svix-timestamp: <unix seconds>
//   svix-signature: "v1,<b64 hmac> v1,<b64 hmac>" (space-separated versions)
// HMAC payload: `${svix_id}.${svix_timestamp}.${rawBody}`
function verifySvixSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
): boolean {
  const svixId = headers.get("svix-id");
  const svixTimestamp = headers.get("svix-timestamp");
  const svixSignature = headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Reject anything older than 5 minutes to limit replay risk.
  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return false;
  }

  // `secret` is base64-encoded after a `whsec_` prefix in Svix conventions.
  const trimmed = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(trimmed, "base64");
    if (secretBytes.length === 0) secretBytes = Buffer.from(trimmed, "utf8");
  } catch {
    secretBytes = Buffer.from(trimmed, "utf8");
  }

  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = createHmac("sha256", secretBytes).update(signedPayload).digest();

  const signatures = svixSignature.split(" ");
  for (const part of signatures) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    let provided: Buffer;
    try {
      provided = Buffer.from(sig, "base64");
    } catch {
      continue;
    }
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return true;
    }
  }
  return false;
}

function statusForEvent(eventType: string): {
  status: "sent" | "delivered" | "bounced" | "complained" | "failed";
  errorText: string | null;
} | null {
  const normalized = eventType.toLowerCase();
  if (normalized === "email.sent") return { status: "sent", errorText: null };
  if (normalized === "email.delivered") return { status: "delivered", errorText: null };
  if (normalized === "email.bounced")
    return { status: "bounced", errorText: "Email bounced. The client's address rejected the message." };
  if (normalized === "email.complained")
    return { status: "complained", errorText: "Client marked the intake email as spam." };
  if (normalized === "email.delivery_delayed")
    return { status: "sent", errorText: null };
  if (normalized === "email.failed")
    return { status: "failed", errorText: "Email provider could not deliver the message." };
  return null;
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
    if (!secret) {
      // Refuse to process if we have no shared secret. This prevents
      // unauthenticated writes to delivery status.
      return NextResponse.json(
        { success: false, error: "Webhook secret not configured" },
        { status: 503 },
      );
    }
    if (!verifySvixSignature(rawBody, request.headers, secret)) {
      return NextResponse.json({ success: false, error: "Invalid signature" }, { status: 401 });
    }

    let payload: Row;
    try {
      payload = JSON.parse(rawBody) as Row;
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 });
    }

    const eventType = value(payload.type);
    const mapped = statusForEvent(eventType);
    if (!mapped) {
      // Unknown event types are acknowledged but ignored.
      return NextResponse.json({ success: true, ignored: true });
    }

    const data = (payload.data ?? {}) as Row;
    const emailId = value((data as { email_id?: unknown }).email_id) || value(data.id);
    if (!emailId) {
      return NextResponse.json({ success: false, error: "Missing email id in payload" }, { status: 400 });
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    // Pull a more specific bounce/failure reason when the provider supplies one.
    let errorText = mapped.errorText;
    const bounce = (data as { bounce?: Row }).bounce;
    if (bounce && typeof bounce === "object") {
      const reason =
        value((bounce as { message?: unknown }).message) ||
        value((bounce as { reason?: unknown }).reason) ||
        value((bounce as { subType?: unknown }).subType);
      if (reason) errorText = reason;
    }
    const failed = (data as { failed?: Row }).failed;
    if (failed && typeof failed === "object") {
      const reason = value((failed as { reason?: unknown }).reason);
      if (reason) errorText = reason;
    }

    const update: Row = {
      delivery_status: mapped.status,
      delivery_status_at: new Date().toISOString(),
    };
    if (errorText) update.delivery_error = errorText;
    if (mapped.status === "delivered") {
      update.delivery_error = null;
    }

    const { error: updateErr, data: updated } = await supabase
      .from("intake_links")
      .update(update)
      .eq("delivery_provider_id", emailId)
      .select("id");

    if (updateErr) {
      console.error("Resend webhook update error:", updateErr);
      return NextResponse.json({ success: false, error: updateErr.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      matched: Array.isArray(updated) ? updated.length : 0,
      status: mapped.status,
    });
  } catch (error) {
    console.error("Resend webhook error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Webhook processing failed" },
      { status: 500 },
    );
  }
}
