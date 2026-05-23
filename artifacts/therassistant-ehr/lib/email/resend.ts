import { Resend } from "resend";

const REPLIT_CONNECTORS_HOSTNAME = process.env.REPLIT_CONNECTORS_HOSTNAME;
const X_REPLIT_TOKEN =
  process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

type ResendCredentials = {
  apiKey: string;
  fromEmail?: string;
};

async function fetchResendCredentialsFromConnector(): Promise<ResendCredentials | null> {
  if (!REPLIT_CONNECTORS_HOSTNAME || !X_REPLIT_TOKEN) return null;

  try {
    const response = await fetch(
      `https://${REPLIT_CONNECTORS_HOSTNAME}/api/v2/connection?include_secrets=true&connector_names=resend`,
      {
        headers: {
          Accept: "application/json",
          X_REPLIT_TOKEN,
        },
      },
    );
    if (!response.ok) return null;
    const json = (await response.json()) as { items?: Array<Record<string, unknown>> };
    const item = json.items?.[0];
    if (!item) return null;
    const settings = (item.settings ?? {}) as Record<string, unknown>;
    const apiKey =
      (typeof settings.api_key === "string" && settings.api_key) ||
      (typeof (settings as { apiKey?: unknown }).apiKey === "string" && (settings as { apiKey: string }).apiKey) ||
      "";
    const fromEmail =
      (typeof settings.from_email === "string" && settings.from_email) ||
      (typeof (settings as { fromEmail?: unknown }).fromEmail === "string" && (settings as { fromEmail: string }).fromEmail) ||
      undefined;
    if (!apiKey) return null;
    return { apiKey, fromEmail };
  } catch {
    return null;
  }
}

async function resolveResendCredentials(): Promise<ResendCredentials | null> {
  const envKey = process.env.RESEND_API_KEY?.trim();
  if (envKey) {
    return {
      apiKey: envKey,
      fromEmail: process.env.RESEND_FROM_EMAIL?.trim() || undefined,
    };
  }
  return fetchResendCredentialsFromConnector();
}

export type SendIntakeEmailInput = {
  to: string;
  patientName: string;
  practiceName: string;
  intakeUrl: string;
  expiresAt: string | null;
};

export type SendIntakeEmailResult =
  | { ok: true; providerId: string | null; fromEmail: string }
  | { ok: false; error: string };

function formatExpiration(expiresAt: string | null): string {
  if (!expiresAt) return "soon";
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return "soon";
  return d.toLocaleString(undefined, {
    dateStyle: "long",
    timeStyle: "short",
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendIntakeEmail(input: SendIntakeEmailInput): Promise<SendIntakeEmailResult> {
  const credentials = await resolveResendCredentials();
  if (!credentials) {
    return {
      ok: false,
      error:
        "Email is not configured. Connect Resend in Integrations (or set RESEND_API_KEY) before emailing intake links.",
    };
  }

  const fromEmail =
    credentials.fromEmail ??
    process.env.RESEND_FROM_EMAIL?.trim() ??
    "onboarding@resend.dev";

  const expirationText = formatExpiration(input.expiresAt);
  const safeName = input.patientName.trim() || "there";
  const safePractice = input.practiceName.trim() || "your care team";

  const subject = `${safePractice}: complete your intake before your visit`;
  const textBody =
    `Hello ${safeName},\n\n` +
    `${safePractice} has sent you a secure intake form to complete before your visit.\n\n` +
    `Open your form: ${input.intakeUrl}\n\n` +
    `This link expires on ${expirationText}. If the link has expired, contact the practice and we'll send a new one.\n\n` +
    `Thank you,\n${safePractice}`;

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1f2937; max-width: 560px; margin: 0 auto;">
      <p>Hello ${escapeHtml(safeName)},</p>
      <p><strong>${escapeHtml(safePractice)}</strong> has sent you a secure intake form to complete before your visit.</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(input.intakeUrl)}" style="background:#2563eb;color:#ffffff;padding:12px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Open your intake form</a>
      </p>
      <p style="font-size: 13px; color: #4b5563;">Or paste this link into your browser:<br/>
        <a href="${escapeHtml(input.intakeUrl)}">${escapeHtml(input.intakeUrl)}</a>
      </p>
      <p style="font-size: 13px; color: #4b5563;">This link expires on <strong>${escapeHtml(expirationText)}</strong>. If it has expired by the time you open it, please contact the practice and we will send a fresh link.</p>
      <p style="margin-top: 32px;">Thank you,<br/>${escapeHtml(safePractice)}</p>
    </div>
  `;

  try {
    const client = new Resend(credentials.apiKey);
    const result = await client.emails.send({
      from: fromEmail,
      to: input.to,
      subject,
      text: textBody,
      html: htmlBody,
    });

    if (result.error) {
      const message = result.error.message || "Resend rejected the email";
      return { ok: false, error: message };
    }
    return { ok: true, providerId: result.data?.id ?? null, fromEmail };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send email";
    return { ok: false, error: message };
  }
}

export type SendPortalInviteEmailInput = {
  to: string;
  patientName: string;
  practiceName: string;
  portalUrl: string;
  expiresAt: string | null;
};

export type SendPortalInviteEmailResult =
  | { ok: true; providerId: string | null; fromEmail: string }
  | { ok: false; error: string };

export async function sendPortalInviteEmail(
  input: SendPortalInviteEmailInput,
): Promise<SendPortalInviteEmailResult> {
  const credentials = await resolveResendCredentials();
  if (!credentials) {
    return {
      ok: false,
      error:
        "Email is not configured. Connect Resend in Integrations (or set RESEND_API_KEY) before emailing portal invites.",
    };
  }

  const fromEmail =
    credentials.fromEmail ??
    process.env.RESEND_FROM_EMAIL?.trim() ??
    "onboarding@resend.dev";

  const expirationText = formatExpiration(input.expiresAt);
  const safeName = input.patientName.trim() || "there";
  const safePractice = input.practiceName.trim() || "your care team";

  const subject = `${safePractice}: your patient portal access`;
  const textBody =
    `Hello ${safeName},\n\n` +
    `${safePractice} has invited you to access your patient portal.\n\n` +
    `Open your portal: ${input.portalUrl}\n\n` +
    `This link expires on ${expirationText}. If the link has expired, contact the practice and we'll send a new one.\n\n` +
    `Thank you,\n${safePractice}`;

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1f2937; max-width: 560px; margin: 0 auto;">
      <p>Hello ${escapeHtml(safeName)},</p>
      <p><strong>${escapeHtml(safePractice)}</strong> has invited you to access your patient portal.</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(input.portalUrl)}" style="background:#2563eb;color:#ffffff;padding:12px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Open your patient portal</a>
      </p>
      <p style="font-size: 13px; color: #4b5563;">Or paste this link into your browser:<br/>
        <a href="${escapeHtml(input.portalUrl)}">${escapeHtml(input.portalUrl)}</a>
      </p>
      <p style="font-size: 13px; color: #4b5563;">This link expires on <strong>${escapeHtml(expirationText)}</strong>. If it has expired by the time you open it, please contact the practice and we will send a fresh link.</p>
      <p style="margin-top: 32px;">Thank you,<br/>${escapeHtml(safePractice)}</p>
    </div>
  `;

  try {
    const client = new Resend(credentials.apiKey);
    const result = await client.emails.send({
      from: fromEmail,
      to: input.to,
      subject,
      text: textBody,
      html: htmlBody,
    });

    if (result.error) {
      const message = result.error.message || "Resend rejected the email";
      return { ok: false, error: message };
    }
    return { ok: true, providerId: result.data?.id ?? null, fromEmail };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send email";
    return { ok: false, error: message };
  }
}
