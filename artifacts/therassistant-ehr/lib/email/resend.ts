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

export type SendCobUpdateEmailInput = {
  to: string;
  patientName: string;
  practiceName: string;
  updateUrl: string;
  expiresAt: string | null;
};

export type SendCobUpdateEmailResult =
  | { ok: true; providerId: string | null; fromEmail: string }
  | { ok: false; error: string };

export async function sendCobUpdateEmail(
  input: SendCobUpdateEmailInput,
): Promise<SendCobUpdateEmailResult> {
  const credentials = await resolveResendCredentials();
  if (!credentials) {
    return {
      ok: false,
      error:
        "Email is not configured. Connect Resend in Integrations (or set RESEND_API_KEY) before emailing insurance update links.",
    };
  }

  const fromEmail =
    credentials.fromEmail ??
    process.env.RESEND_FROM_EMAIL?.trim() ??
    "onboarding@resend.dev";

  const expirationText = formatExpiration(input.expiresAt);
  const safeName = input.patientName.trim() || "there";
  const safePractice = input.practiceName.trim() || "your care team";

  const subject = `${safePractice}: confirm your insurance so we can bill correctly`;
  const textBody =
    `Hello ${safeName},\n\n` +
    `${safePractice} needs you to confirm your current insurance so we can bill your recent visit to the correct payer.\n\n` +
    `Open the secure form: ${input.updateUrl}\n\n` +
    `It takes about a minute — you'll confirm which plan is primary, let us know if you have any other coverage, and optionally upload a photo of your insurance card.\n\n` +
    `This link expires on ${expirationText}. If the link has expired, contact the practice and we'll send a new one.\n\n` +
    `Thank you,\n${safePractice}`;

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1f2937; max-width: 560px; margin: 0 auto;">
      <p>Hello ${escapeHtml(safeName)},</p>
      <p><strong>${escapeHtml(safePractice)}</strong> needs you to confirm your current insurance so we can bill your recent visit to the correct payer.</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(input.updateUrl)}" style="background:#2563eb;color:#ffffff;padding:12px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Confirm your insurance</a>
      </p>
      <p style="font-size: 13px; color: #4b5563;">It takes about a minute — you'll confirm which plan is primary, let us know if you have any other coverage, and optionally upload a photo of your insurance card.</p>
      <p style="font-size: 13px; color: #4b5563;">Or paste this link into your browser:<br/>
        <a href="${escapeHtml(input.updateUrl)}">${escapeHtml(input.updateUrl)}</a>
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

export type PayerDocumentationAttachment = {
  filename: string;
  content: Buffer;
};

export type SendPayerDocumentationEmailInput = {
  to: string;
  payerName: string;
  practiceName: string;
  claimNumber: string;
  patientName: string;
  dateOfService: string | null;
  note: string | null;
  attachments: PayerDocumentationAttachment[];
};

export type SendPayerDocumentationEmailResult =
  | { ok: true; providerId: string | null; fromEmail: string }
  | { ok: false; error: string };

export async function sendPayerDocumentationEmail(
  input: SendPayerDocumentationEmailInput,
): Promise<SendPayerDocumentationEmailResult> {
  const credentials = await resolveResendCredentials();
  if (!credentials) {
    return {
      ok: false,
      error:
        "Email is not configured. Connect Resend in Integrations (or set RESEND_API_KEY) before sending documentation to payers.",
    };
  }

  const fromEmail =
    credentials.fromEmail ??
    process.env.RESEND_FROM_EMAIL?.trim() ??
    "onboarding@resend.dev";

  const safePayer = input.payerName.trim() || "Insurance Payer";
  const safePractice = input.practiceName.trim() || "the billing office";
  const safeClient = input.patientName.trim() || "the client";
  const dosText = input.dateOfService
    ? new Date(input.dateOfService).toLocaleDateString()
    : "the date of service on file";

  const subject = `Medical records — claim ${input.claimNumber} (${safeClient})`;
  const noteLine = input.note ? `\n\nNotes from the biller:\n${input.note}` : "";
  const fileList = input.attachments.map((a) => `  • ${a.filename}`).join("\n");
  const textBody =
    `${safePayer} records team,\n\n` +
    `Please find attached the documentation requested for the claim below.\n\n` +
    `Claim number: ${input.claimNumber}\n` +
    `Client: ${safeClient}\n` +
    `Date of service: ${dosText}\n` +
    `Attachments (${input.attachments.length}):\n${fileList}` +
    `${noteLine}\n\n` +
    `Thank you,\n${safePractice}`;

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1f2937; max-width: 640px; margin: 0 auto;">
      <p>${escapeHtml(safePayer)} records team,</p>
      <p>Please find attached the documentation requested for the claim below.</p>
      <table style="font-size:14px;border-collapse:collapse;margin:12px 0;">
        <tbody>
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Claim number</td><td style="padding:4px 0;"><strong>${escapeHtml(input.claimNumber)}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Client</td><td style="padding:4px 0;">${escapeHtml(safeClient)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Date of service</td><td style="padding:4px 0;">${escapeHtml(dosText)}</td></tr>
        </tbody>
      </table>
      <p style="font-size:13px;color:#374151;"><strong>Attachments (${input.attachments.length}):</strong></p>
      <ul style="font-size:13px;color:#374151;margin:0 0 12px 18px;padding:0;">
        ${input.attachments.map((a) => `<li>${escapeHtml(a.filename)}</li>`).join("")}
      </ul>
      ${input.note ? `<p style="font-size:13px;color:#374151;white-space:pre-wrap;"><strong>Notes from the biller:</strong><br/>${escapeHtml(input.note)}</p>` : ""}
      <p style="margin-top:24px;">Thank you,<br/>${escapeHtml(safePractice)}</p>
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
      attachments: input.attachments.map((a) => ({
        filename: a.filename,
        content: a.content,
      })),
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

export type SendEligibilityRoutedEmailInput = {
  to: string;
  assigneeName: string;
  routedByName: string | null;
  patientName: string | null;
  appointmentAt: string | null;
  kind: "clinician" | "admin";
  note: string | null;
  inboxUrl: string;
  // Task #702: scheduled re-ping for items still open past the threshold.
  // Only affects the subject line so the assignee can spot it in their
  // inbox; body + opt-out preference are identical to the first send.
  isReminder?: boolean;
  reminderNumber?: number;
};

export type SendEligibilityRoutedEmailResult =
  | { ok: true; providerId: string | null; fromEmail: string }
  | { ok: false; error: string };

export async function sendEligibilityRoutedEmail(
  input: SendEligibilityRoutedEmailInput,
): Promise<SendEligibilityRoutedEmailResult> {
  const credentials = await resolveResendCredentials();
  if (!credentials) {
    return {
      ok: false,
      error:
        "Email is not configured. Connect Resend in Integrations (or set RESEND_API_KEY) before sending eligibility routing notifications.",
    };
  }

  const fromEmail =
    credentials.fromEmail ??
    process.env.RESEND_FROM_EMAIL?.trim() ??
    "onboarding@resend.dev";

  const safeAssignee = input.assigneeName.trim() || "there";
  const kindLabel =
    input.kind === "clinician"
      ? "verify a client's insurance before their next visit"
      : "follow up on an eligibility issue";
  const routedBy = input.routedByName?.trim()
    ? `${input.routedByName.trim()} routed`
    : "A biller routed";
  const patientLine = input.patientName?.trim()
    ? `Client: ${input.patientName.trim()}`
    : null;
  const apptLine = input.appointmentAt
    ? `Appointment: ${formatExpiration(input.appointmentAt)}`
    : null;
  const noteLine = input.note?.trim() ? `Note: ${input.note.trim()}` : null;

  const baseSubject =
    input.kind === "clinician"
      ? "Action needed: verify client insurance"
      : "Action needed: resolve eligibility issue";
  const subject = input.isReminder
    ? `Reminder${input.reminderNumber && input.reminderNumber > 1 ? ` (#${input.reminderNumber})` : ""}: ${baseSubject}`
    : baseSubject;

  const lines = [
    `Hello ${safeAssignee},`,
    "",
    `${routedBy} an eligibility issue to your inbox — please ${kindLabel}.`,
    "",
    ...[patientLine, apptLine, noteLine].filter(Boolean) as string[],
    "",
    `Open My Inbox: ${input.inboxUrl}`,
    "",
    "You can opt out of these emails from My Inbox.",
  ];
  const textBody = lines.join("\n");

  const detailsHtml = [
    patientLine ? `<li>${escapeHtml(patientLine)}</li>` : "",
    apptLine ? `<li>${escapeHtml(apptLine)}</li>` : "",
    noteLine ? `<li>${escapeHtml(noteLine)}</li>` : "",
  ]
    .filter(Boolean)
    .join("");

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1f2937; max-width: 560px; margin: 0 auto;">
      <p>Hello ${escapeHtml(safeAssignee)},</p>
      <p>${escapeHtml(routedBy)} an eligibility issue to your inbox — please ${escapeHtml(kindLabel)}.</p>
      ${detailsHtml ? `<ul style="font-size:13px;color:#374151;margin:8px 0 16px 18px;padding:0;">${detailsHtml}</ul>` : ""}
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(input.inboxUrl)}" style="background:#1D4ED8;color:#ffffff;padding:12px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Open My Inbox</a>
      </p>
      <p style="font-size: 12px; color: #6b7280;">You're receiving this because an eligibility issue was routed to you. You can opt out of these emails from the My Inbox screen.</p>
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

export type SendAutopayRetryNoticeEmailInput = {
  to: string;
  patientName: string;
  practiceName: string;
  amountDollars: number;
  brand: string;
  last4: string;
  retryDate: string | null;
  portalUrl: string;
};

export type SendAutopayRetryNoticeEmailResult =
  | { ok: true; providerId: string | null; fromEmail: string }
  | { ok: false; error: string };

function formatRetryDate(iso: string | null): string {
  if (!iso) return "soon";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "soon";
  return d.toLocaleDateString(undefined, { dateStyle: "long" });
}

/**
 * Heads-up email sent just before the FINAL autopay retry attempt
 * (Task #732). Gives the client a chance to update their saved card
 * before the card gets re-charged one last time.
 */
export async function sendAutopayRetryNoticeEmail(
  input: SendAutopayRetryNoticeEmailInput,
): Promise<SendAutopayRetryNoticeEmailResult> {
  const credentials = await resolveResendCredentials();
  if (!credentials) {
    return {
      ok: false,
      error:
        "Email is not configured. Connect Resend in Integrations (or set RESEND_API_KEY) before emailing autopay retry notices.",
    };
  }

  const fromEmail =
    credentials.fromEmail ??
    process.env.RESEND_FROM_EMAIL?.trim() ??
    "onboarding@resend.dev";

  const safeName = input.patientName.trim() || "there";
  const safePractice = input.practiceName.trim() || "your care team";
  const dateText = formatRetryDate(input.retryDate);
  const amountText = `$${input.amountDollars.toFixed(2)}`;
  const cardText =
    input.brand && input.last4
      ? `${input.brand} •••• ${input.last4}`
      : "the card on file";

  const subject = `${safePractice}: please update your card before your next charge`;
  const textBody =
    `Hello ${safeName},\n\n` +
    `${safePractice} tried to automatically charge ${cardText} ${amountText} for your recent visit, but the card was declined.\n\n` +
    `We will try one more time on ${dateText}. To avoid a manual collections call, please update your card on file before ${dateText} from your client portal:\n\n` +
    `${input.portalUrl}\n\n` +
    `If you have already updated your card, no further action is needed.\n\n` +
    `Thank you,\n${safePractice}`;

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1f2937; max-width: 560px; margin: 0 auto;">
      <p>Hello ${escapeHtml(safeName)},</p>
      <p><strong>${escapeHtml(safePractice)}</strong> tried to automatically charge ${escapeHtml(cardText)} <strong>${escapeHtml(amountText)}</strong> for your recent visit, but the card was declined.</p>
      <p>We will try one more time on <strong>${escapeHtml(dateText)}</strong>. To avoid a manual collections call, please update your card on file before then.</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(input.portalUrl)}" style="background:#2563eb;color:#ffffff;padding:12px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Update your card</a>
      </p>
      <p style="font-size: 13px; color: #4b5563;">Or paste this link into your browser:<br/>
        <a href="${escapeHtml(input.portalUrl)}">${escapeHtml(input.portalUrl)}</a>
      </p>
      <p style="font-size: 13px; color: #4b5563;">If you have already updated your card, no further action is needed.</p>
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

  const subject = `${safePractice}: your client portal access`;
  const textBody =
    `Hello ${safeName},\n\n` +
    `${safePractice} has invited you to access your client portal.\n\n` +
    `Open your portal: ${input.portalUrl}\n\n` +
    `This link expires on ${expirationText}. If the link has expired, contact the practice and we'll send a new one.\n\n` +
    `Thank you,\n${safePractice}`;

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1f2937; max-width: 560px; margin: 0 auto;">
      <p>Hello ${escapeHtml(safeName)},</p>
      <p><strong>${escapeHtml(safePractice)}</strong> has invited you to access your client portal.</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(input.portalUrl)}" style="background:#2563eb;color:#ffffff;padding:12px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Open your client portal</a>
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

export type SendAutopayFailureEmailInput = {
  to: string;
  patientName: string;
  practiceName: string;
  portalUrl: string;
  amountDollars: number;
  brand: string;
  last4: string;
  /**
   * The Stripe error code surfaced by `chargeSavedCardForInvoice`.
   * `authentication_required` triggers the 3DS-specific copy; any
   * other value uses the generic "card was declined" copy.
   */
  failureKind: "authentication_required" | "card_declined";
};

export type SendAutopayFailureEmailResult =
  | { ok: true; providerId: string | null; fromEmail: string }
  | { ok: false; error: string };

function formatMoneyForEmail(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

/**
 * Notify a client that an autopay charge against their saved card
 * failed (Task #736). Copy branches on `failureKind`:
 *   - `authentication_required` → 3DS confirmation copy (their bank
 *     wants them to verify the charge from the portal; we re-bill
 *     automatically once they confirm).
 *   - anything else → plain decline copy (update the card on file).
 * Throttling lives in the caller (autopayService) — this helper just
 * fires the email and returns the provider result.
 */
export async function sendAutopayFailureEmail(
  input: SendAutopayFailureEmailInput,
): Promise<SendAutopayFailureEmailResult> {
  const credentials = await resolveResendCredentials();
  if (!credentials) {
    return {
      ok: false,
      error:
        "Email is not configured. Connect Resend in Integrations (or set RESEND_API_KEY) before sending autopay failure notices.",
    };
  }

  const fromEmail =
    credentials.fromEmail ??
    process.env.RESEND_FROM_EMAIL?.trim() ??
    "onboarding@resend.dev";

  const safeName = input.patientName.trim() || "there";
  const safePractice = input.practiceName.trim() || "your care team";
  const amountText = formatMoneyForEmail(input.amountDollars);
  const cardSuffix = input.last4
    ? `${input.brand || "card"} ending in ${input.last4}`
    : input.brand || "card on file";

  const is3ds = input.failureKind === "authentication_required";

  const subject = is3ds
    ? `${safePractice}: confirm your ${amountText} autopay charge`
    : `${safePractice}: your autopay charge of ${amountText} didn't go through`;

  const ctaLabel = is3ds ? "Confirm the charge" : "Update your payment";

  const introLine = is3ds
    ? `Your bank asked us to verify the ${amountText} autopay charge we tried to run on your ${cardSuffix}. ` +
      `Tap the button below to confirm it from your client portal — once you do, we'll re-run the charge automatically.`
    : `We tried to run an autopay charge of ${amountText} on your ${cardSuffix} and it was declined. ` +
      `Open your client portal to update the card on file (or use a different card), and we'll charge the new card right away.`;

  const textBody =
    `Hello ${safeName},\n\n` +
    `${introLine}\n\n` +
    `Open your portal: ${input.portalUrl}\n\n` +
    `If you've already taken care of it, you can ignore this email.\n\n` +
    `Thank you,\n${safePractice}`;

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1f2937; max-width: 560px; margin: 0 auto;">
      <p>Hello ${escapeHtml(safeName)},</p>
      <p>${escapeHtml(introLine)}</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(input.portalUrl)}" style="background:#1D4ED8;color:#ffffff;padding:12px 18px;border-radius:6px;text-decoration:none;display:inline-block;">${escapeHtml(ctaLabel)}</a>
      </p>
      <p style="font-size: 13px; color: #4b5563;">Or paste this link into your browser:<br/>
        <a href="${escapeHtml(input.portalUrl)}">${escapeHtml(input.portalUrl)}</a>
      </p>
      <p style="font-size: 13px; color: #6b7280;">If you've already taken care of it, you can ignore this email.</p>
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

export type BillingReportEmailAttachment = {
  filename: string;
  content: Buffer | string;
};

export type SendBillingReportEmailInput = {
  to: string[];
  practiceName: string;
  monthLabel: string;
  scopeLabel: string;
  senderName: string | null;
  note: string | null;
  reportUrl: string;
  htmlSnapshot: string;
  textSnapshot: string;
  attachments?: BillingReportEmailAttachment[];
};

export type SendBillingReportEmailResult =
  | { ok: true; providerId: string | null; fromEmail: string }
  | { ok: false; error: string };

/**
 * Send the Revenue Overview snapshot (Task #781) to one or more
 * recipients. The body is the same single-page summary the on-screen
 * Download PDF button captures, plus a link back to the live report
 * with the current month/scope filters preserved.
 */
export async function sendBillingReportEmail(
  input: SendBillingReportEmailInput,
): Promise<SendBillingReportEmailResult> {
  const credentials = await resolveResendCredentials();
  if (!credentials) {
    return {
      ok: false,
      error:
        "Email is not configured. Connect Resend in Integrations (or set RESEND_API_KEY) before emailing billing reports.",
    };
  }

  const fromEmail =
    credentials.fromEmail ??
    process.env.RESEND_FROM_EMAIL?.trim() ??
    "onboarding@resend.dev";

  const safePractice = input.practiceName.trim() || "Practice";
  const safeMonth = input.monthLabel.trim() || "Current month";
  const safeScope = input.scopeLabel.trim() || "Practice (all clinicians)";
  const sender = input.senderName?.trim();
  const note = input.note?.trim();

  const subject = `${safePractice} — Revenue Overview, ${safeMonth} (${safeScope})`;

  const senderLine = sender ? `${sender} shared this report with you.` : `Shared from ${safePractice}.`;
  const noteBlockText = note ? `\nNote from ${sender || "the sender"}:\n${note}\n` : "";
  const textBody =
    `${senderLine}\n\n` +
    `Revenue Overview — ${safeMonth}\n` +
    `Scope: ${safeScope}\n` +
    `Practice: ${safePractice}\n` +
    `${noteBlockText}\n` +
    `${input.textSnapshot}\n\n` +
    `Open the live report: ${input.reportUrl}\n`;

  const noteBlockHtml = note
    ? `<p style="background:#f8fafc;border-left:3px solid #1D4ED8;padding:10px 14px;font-size:13px;color:#374151;white-space:pre-wrap;margin:16px 0;">` +
      `<strong style="display:block;color:#1f2937;margin-bottom:4px;">Note from ${escapeHtml(sender || "the sender")}</strong>` +
      `${escapeHtml(note)}</p>`
    : "";

  const htmlBody = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;max-width:720px;margin:0 auto;">
      <p style="font-size:13px;color:#6b7280;margin:0 0 4px 0;">${escapeHtml(safePractice)} · Billing</p>
      <h1 style="font-size:22px;margin:0 0 4px 0;color:#10243f;">Revenue Overview — ${escapeHtml(safeMonth)}</h1>
      <p style="font-size:13px;color:#4b5563;margin:0 0 18px 0;">Scope: <strong>${escapeHtml(safeScope)}</strong></p>
      <p style="font-size:13px;color:#374151;margin:0 0 12px 0;">${escapeHtml(senderLine)}</p>
      ${noteBlockHtml}
      ${input.htmlSnapshot}
      <p style="margin:24px 0;">
        <a href="${escapeHtml(input.reportUrl)}" style="background:#1D4ED8;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block;font-size:14px;">Open the live report</a>
      </p>
      <p style="font-size:12px;color:#6b7280;">Or paste this link into your browser:<br/>
        <a href="${escapeHtml(input.reportUrl)}" style="color:#1D4ED8;">${escapeHtml(input.reportUrl)}</a>
      </p>
      <p style="font-size:12px;color:#9ca3af;margin-top:24px;">Sent from ${escapeHtml(safePractice)} via Therassistant.</p>
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
      attachments: input.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
      })),
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
