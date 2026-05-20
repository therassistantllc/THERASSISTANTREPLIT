"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type InsurancePolicySummary = {
  id: string;
  plan_name?: string | null;
  policy_number?: string | null;
  priority?: string | null;
  active_flag?: boolean | null;
};

type EligibilitySummary = {
  id?: string;
  eligibility_status?: string | null;
  checked_at?: string | null;
  copay_amount?: string | number | null;
  deductible_remaining?: string | number | null;
};

type InvoiceSummary = {
  id: string;
  invoice_number?: string | null;
  invoice_status?: string | null;
  balance_amount?: string | number | null;
};

type EncounterSummary = {
  id: string;
  encounter_status?: string | null;
  service_date?: string | null;
};

type WorkqueueSummary = {
  id: string;
  title?: string | null;
  work_type?: string | null;
  status?: string | null;
  priority?: string | null;
  created_at?: string | null;
};

type PatientSummary = {
  success: boolean;
  error?: string;
  patient?: {
    id: string;
    name: string;
    preferredName?: string | null;
    dateOfBirth?: string | null;
    email?: string | null;
    phone?: string | null;
    pronouns?: string | null;
  };
  insurance?: {
    policies: InsurancePolicySummary[];
    latestEligibility: EligibilitySummary | null;
  };
  balance?: {
    total: number;
    invoices: InvoiceSummary[];
  };
  encounters?: EncounterSummary[];
  workqueueItems?: WorkqueueSummary[];
};

type AppointmentSummary = {
  id: string;
  scheduledStart?: string | null;
  status?: string | null;
  type?: string | null;
  reason?: string | null;
  encounter?: { id: string; status?: string | null } | null;
};

type ConditionSummary = {
  id: string;
  code: string;
  description?: string | null;
  encounterId: string;
  encounterDate?: string | null;
};

type ClaimSummary = {
  id: string;
  claimNumber?: string | null;
  status?: string | null;
  totalCharge?: number | null;
  createdAt?: string | null;
};

type NoteSummary = {
  id: string;
  encounterId: string;
  encounterDate?: string | null;
  noteStatus?: string | null;
  noteType?: string | null;
};

type DocumentSummary = {
  id: string;
  title?: string | null;
  fileName?: string | null;
  createdAt?: string | null;
  mailroomItemId?: string | null;
};

type IntakeLink = {
  id: string;
  token: string;
  url: string;
  status: string;
  expiresAt: string | null;
  createdAt: string | null;
  usedAt: string | null;
  submissionId: string | null;
  deliveryMethod?: string | null;
  deliveredToEmail?: string | null;
  deliveredAt?: string | null;
  deliveryError?: string | null;
  deliveryStatus?: string | null;
  deliveryStatusAt?: string | null;
};

type IntakeSubmission = {
  id: string;
  status: string;
  signatureName: string | null;
  signatureSignedAt: string | null;
  phq9Score: number | null;
  phq9Severity: string | null;
  gad7Score: number | null;
  gad7Severity: string | null;
  submittedAt: string | null;
  insurance?: Record<string, unknown> | null;
  consents?: Record<string, unknown> | null;
};

type MailroomSummary = {
  id: string;
  fileName?: string;
  status?: string;
  documentType?: string;
  createdAt?: string;
};

type DetailState = {
  appointments: AppointmentSummary[];
  conditions: ConditionSummary[];
  claims: ClaimSummary[];
  notes: NoteSummary[];
  documents: DocumentSummary[];
  mailroomItems: MailroomSummary[];
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not listed";
  const date = new Date(`${value}`.includes("T") ? value : `${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not listed";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function formatMoney(value: string | number | null | undefined) {
  const amount = Number(value ?? 0);
  return amount.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function statusClass(value: string | null | undefined) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("active") && !normalized.includes("inactive")) return "status status-green";
  if (normalized.includes("paid") || normalized.includes("accepted") || normalized.includes("resolved")) return "status status-green";
  if (normalized.includes("inactive") || normalized.includes("blocked") || normalized.includes("denied") || normalized.includes("rejected")) return "status status-red";
  if (normalized.includes("open") || normalized.includes("sent") || normalized.includes("draft") || normalized.includes("submitted") || normalized.includes("in_progress")) return "status status-yellow";
  return "status";
}

async function fetchList<T>(url: string, field: string): Promise<T[]> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    const json = (await response.json()) as Record<string, unknown> & { success?: boolean };
    if (!response.ok || !json.success) return [];
    return (Array.isArray(json[field]) ? (json[field] as T[]) : []);
  } catch {
    return [];
  }
}

export default function PatientChartClient({ clientId }: { clientId: string }) {
  const [summary, setSummary] = useState<PatientSummary | null>(null);
  const [details, setDetails] = useState<DetailState>({
    appointments: [],
    conditions: [],
    claims: [],
    notes: [],
    documents: [],
    mailroomItems: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [intakeLinks, setIntakeLinks] = useState<IntakeLink[]>([]);
  const [intakeSubmissions, setIntakeSubmissions] = useState<IntakeSubmission[]>([]);
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [intakeMessage, setIntakeMessage] = useState<string | null>(null);
  const [cardRefresh, setCardRefresh] = useState(0);
  const [cardBusy, setCardBusy] = useState<string | null>(null);
  const organizationId = useMemo(() => getOrganizationId(), []);

  async function reloadIntake() {
    try {
      const [linksRes, subsRes] = await Promise.all([
        fetch(`/api/intake/links?clientId=${encodeURIComponent(clientId)}`, { cache: "no-store" }),
        fetch(`/api/intake/submissions?clientId=${encodeURIComponent(clientId)}`, { cache: "no-store" }),
      ]);
      const linksJson = await linksRes.json().catch(() => ({}));
      const subsJson = await subsRes.json().catch(() => ({}));
      if (linksRes.ok && linksJson.success) setIntakeLinks(linksJson.links ?? []);
      if (subsRes.ok && subsJson.success) setIntakeSubmissions(subsJson.submissions ?? []);
    } catch {
      // intake data is best-effort
    }
  }

  async function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.readAsDataURL(file);
    });
  }

  async function handleReplaceCard(submissionId: string, side: "front" | "back", file: File) {
    const key = `${submissionId}:${side}`;
    setCardBusy(key);
    setIntakeMessage(null);
    try {
      if (!file.type.startsWith("image/")) {
        throw new Error("Please choose an image file (PNG, JPEG, WebP, or GIF).");
      }
      if (file.size > 5 * 1024 * 1024) {
        throw new Error("Image must be 5 MB or smaller.");
      }
      const content = await readFileAsDataUrl(file);
      const response = await fetch(
        `/api/intake/card/${encodeURIComponent(submissionId)}/${side}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, name: file.name, type: file.type }),
        },
      );
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to replace card image");
      setIntakeMessage(`Insurance card ${side} updated.`);
      setCardRefresh((n) => n + 1);
      await reloadIntake();
    } catch (err) {
      setIntakeMessage(err instanceof Error ? err.message : "Failed to replace card image");
    } finally {
      setCardBusy(null);
    }
  }

  async function handleRemoveCard(submissionId: string, side: "front" | "back") {
    if (typeof window !== "undefined" && !window.confirm(`Remove the insurance card ${side} image from this submission?`)) {
      return;
    }
    const key = `${submissionId}:${side}`;
    setCardBusy(key);
    setIntakeMessage(null);
    try {
      const response = await fetch(
        `/api/intake/card/${encodeURIComponent(submissionId)}/${side}`,
        { method: "DELETE" },
      );
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to remove card image");
      setIntakeMessage(`Insurance card ${side} removed.`);
      setCardRefresh((n) => n + 1);
      await reloadIntake();
    } catch (err) {
      setIntakeMessage(err instanceof Error ? err.message : "Failed to remove card image");
    } finally {
      setCardBusy(null);
    }
  }

  async function handleCreateIntakeLink(delivery: "clipboard" | "email") {
    setIntakeBusy(true);
    setIntakeMessage(null);
    try {
      const response = await fetch(`/api/intake/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, delivery }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to create intake link");
      const url = typeof window !== "undefined" ? `${window.location.origin}${json.link.url}` : json.link.url;
      if (delivery === "email") {
        const to = json.email?.to ?? "the patient";
        setIntakeMessage(`Intake link emailed to ${to}.`);
      } else {
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            await navigator.clipboard.writeText(url);
            setIntakeMessage(`Intake link copied to clipboard: ${url}`);
          } else {
            setIntakeMessage(`Intake link: ${url}`);
          }
        } catch {
          setIntakeMessage(`Intake link: ${url}`);
        }
      }
      await reloadIntake();
    } catch (linkError) {
      setIntakeMessage(linkError instanceof Error ? linkError.message : "Failed to create intake link");
    } finally {
      setIntakeBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadPatient() {
      if (!organizationId) {
        setError("Missing organizationId. Add ?organizationId=... to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.");
        setLoading(false);
        return;
      }

      try {
        const summaryResponse = await fetch(`/api/patients/${clientId}/summary?organizationId=${encodeURIComponent(organizationId)}`, {
          cache: "no-store",
        });
        const summaryJson = (await summaryResponse.json()) as PatientSummary;
        if (!summaryResponse.ok || !summaryJson.success) throw new Error(summaryJson.error ?? "Failed to load patient chart");

        const [appointments, conditions, claims, notes, documents, mailroomItems] = await Promise.all([
          fetchList<AppointmentSummary>(`/api/patients/${clientId}/appointments?organizationId=${encodeURIComponent(organizationId)}`, "appointments"),
          fetchList<ConditionSummary>(`/api/patients/${clientId}/conditions?organizationId=${encodeURIComponent(organizationId)}`, "conditions"),
          fetchList<ClaimSummary>(`/api/patients/${clientId}/claims?organizationId=${encodeURIComponent(organizationId)}`, "claims"),
          fetchList<NoteSummary>(`/api/patients/${clientId}/notes?organizationId=${encodeURIComponent(organizationId)}`, "notes"),
          fetchList<DocumentSummary>(`/api/patients/${clientId}/documents?organizationId=${encodeURIComponent(organizationId)}`, "documents"),
          fetchList<MailroomSummary>(`/api/mailroom/items?organizationId=${encodeURIComponent(organizationId)}&clientId=${encodeURIComponent(clientId)}&status=all&limit=10`, "items"),
        ]);

        if (cancelled) return;

        setSummary(summaryJson);
        setDetails({
          appointments,
          conditions,
          claims,
          notes,
          documents,
          mailroomItems,
        });
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load patient chart");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadPatient();
    void reloadIntake();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, organizationId]);

  const patient = summary?.patient;
  const latestEligibility = summary?.insurance?.latestEligibility ?? null;
  const policies = summary?.insurance?.policies ?? [];
  const invoices = summary?.balance?.invoices ?? [];
  const encounters = summary?.encounters ?? [];
  const workqueueItems = summary?.workqueueItems ?? [];

  const claimCounts = details.claims.reduce(
    (acc, claim) => {
      const key = String(claim.status ?? "unknown");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const deniedOrRejectedCount = details.claims.filter((claim) => {
    const status = String(claim.status ?? "").toLowerCase();
    return status.includes("denied") || status.includes("rejected");
  }).length;

  const alerts: string[] = [];
  if (!latestEligibility) alerts.push("No recent eligibility check on file.");
  if (latestEligibility && String(latestEligibility.eligibility_status ?? "").toLowerCase().includes("inactive")) {
    alerts.push("Coverage is marked inactive. Verify eligibility before next visit.");
  }
  if ((summary?.balance?.total ?? 0) > 0) alerts.push("Outstanding patient balance requires follow-up.");
  if (deniedOrRejectedCount > 0) alerts.push(`${deniedOrRejectedCount} denied/rejected claim(s) need billing action.`);
  if (workqueueItems.length > 0) alerts.push(`${workqueueItems.length} open workqueue item(s) linked to this client.`);

  const orgQ = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";

  if (loading) return <div className="empty-state">Loading client chart…</div>;
  if (error) return <div className="alert-panel">{error}</div>;
  if (!patient) return <div className="alert-panel">Client record not found.</div>;

  return (
    <>
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Client Chart Summary</p>
          <h1>{patient.name}</h1>
          <p className="hero-copy">
            DOB: {formatDate(patient.dateOfBirth)}{patient.pronouns ? ` · Pronouns: ${patient.pronouns}` : ""}
          </p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href={`/clients/${patient.id}/appointments${orgQ}`}>Appointments</Link>
          <Link className="button button-secondary" href={`/clients/${patient.id}/notes${orgQ}`}>Notes</Link>
          <Link className="button button-secondary" href={`/clients/${patient.id}/eligibility${orgQ}`}>Eligibility</Link>
          <Link className="button button-secondary" href={`/clients/${patient.id}/claims${orgQ}`}>Claims</Link>
          <Link className="button button-secondary" href={`/clients/${patient.id}/balance${orgQ}`}>Balance</Link>
          <Link className="button button-secondary" href={`/clients/${patient.id}/documents${orgQ}`}>Documents</Link>
          <Link className="button" href={`/workqueue/new?clientId=${patient.id}${organizationId ? `&organizationId=${organizationId}` : ""}`}>Route to Biller</Link>
          <button
            type="button"
            className="button"
            onClick={() => handleCreateIntakeLink("email")}
            disabled={intakeBusy || !patient.email}
            title={patient.email ? `Email link to ${patient.email}` : "No email on file for this client"}
          >
            {intakeBusy ? "Sending…" : "Email intake link"}
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => handleCreateIntakeLink("clipboard")}
            disabled={intakeBusy}
          >
            {intakeBusy ? "Generating…" : "Copy intake link"}
          </button>
        </div>
      </section>

      <section className="metric-grid">
        <article className="metric-card">
          <span>Outstanding Balance</span>
          <strong>{formatMoney(summary?.balance?.total ?? 0)}</strong>
        </article>
        <article className="metric-card">
          <span>Claims</span>
          <strong>{details.claims.length}</strong>
        </article>
        <article className="metric-card">
          <span>Recent Encounters</span>
          <strong>{encounters.length}</strong>
        </article>
        <article className="metric-card">
          <span>Open Workqueue</span>
          <strong>{workqueueItems.length}</strong>
        </article>
      </section>

      <section className="panel" style={{ marginBottom: "16px" }}>
        <h2>Patient Intake</h2>
        {intakeMessage ? <div className="alert-panel">{intakeMessage}</div> : null}
        {intakeSubmissions.length === 0 && intakeLinks.length === 0 ? (
          <p className="muted">No intake on file yet. Send the patient a one-time intake link.</p>
        ) : null}
        {intakeSubmissions.length > 0 ? (
          <div className="stack-list">
            {intakeSubmissions.slice(0, 3).map((submission) => {
              const insurance = (submission.insurance ?? {}) as Record<string, unknown>;
              const hasCard = (raw: unknown): boolean => {
                if (!raw || typeof raw !== "object") return false;
                const obj = raw as { path?: unknown; content?: unknown };
                if (typeof obj.path === "string" && obj.path.length > 0) return true;
                if (typeof obj.content === "string" && obj.content.startsWith("data:image/")) return true;
                return false;
              };
              const cacheBust = `?v=${encodeURIComponent(String((insurance.cardFront as Record<string, unknown> | null | undefined)?.uploadedAt ?? "") + ":" + String((insurance.cardBack as Record<string, unknown> | null | undefined)?.uploadedAt ?? "") + ":" + cardRefresh)}`;
              const frontUrl = hasCard(insurance.cardFront)
                ? `/api/intake/card/${encodeURIComponent(submission.id)}/front${cacheBust}`
                : null;
              const backUrl = hasCard(insurance.cardBack)
                ? `/api/intake/card/${encodeURIComponent(submission.id)}/back${cacheBust}`
                : null;
              const cardMeta = (raw: unknown): { uploadedAt: string | null; replacedByStaffName: string | null } => {
                if (!raw || typeof raw !== "object") return { uploadedAt: null, replacedByStaffName: null };
                const obj = raw as Record<string, unknown>;
                const uploadedAt = typeof obj.uploadedAt === "string" ? obj.uploadedAt : null;
                const replacedByStaffName = typeof obj.replacedByStaffName === "string" && obj.replacedByStaffName
                  ? obj.replacedByStaffName
                  : (typeof obj.replacedByStaffId === "string" && obj.replacedByStaffId ? "a staff member" : null);
                return { uploadedAt, replacedByStaffName };
              };
              const frontMeta = cardMeta(insurance.cardFront);
              const backMeta = cardMeta(insurance.cardBack);
              const consents = (submission.consents ?? {}) as Record<string, unknown>;
              const consentList = [
                consents.hipaa ? "HIPAA" : null,
                consents.telehealth ? "Telehealth" : null,
                consents.roi ? "ROI" : null,
              ].filter(Boolean).join(" · ");
              return (
                <div className="stack-item" key={submission.id}>
                  <strong>Submitted: {formatDate(submission.submittedAt)}</strong>
                  <span>Signed by: {submission.signatureName ?? "—"}</span>
                  <span>
                    PHQ-9: {submission.phq9Score ?? "—"} ({submission.phq9Severity ?? "—"}) ·
                    GAD-7: {submission.gad7Score ?? "—"} ({submission.gad7Severity ?? "—"})
                  </span>
                  <span>Consents on file: {consentList || "—"}</span>
                  <div style={{ marginTop: "6px" }}>
                    <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
                      {(["front", "back"] as const).map((side) => {
                        const url = side === "front" ? frontUrl : backUrl;
                        const meta = side === "front" ? frontMeta : backMeta;
                        const busyKey = `${submission.id}:${side}`;
                        const busy = cardBusy === busyKey;
                        const label = side === "front" ? "Front" : "Back";
                        const provenance = url
                          ? meta.replacedByStaffName
                            ? `Updated by ${meta.replacedByStaffName}${meta.uploadedAt ? ` on ${formatDateTime(meta.uploadedAt)}` : ""}`
                            : meta.uploadedAt
                              ? `Uploaded by patient at intake (${formatDateTime(meta.uploadedAt)})`
                              : "Uploaded by patient at intake"
                          : null;
                        return (
                          <div key={side} style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: "120px" }}>
                            <span style={{ fontSize: "12px", fontWeight: 600 }}>Card {label}</span>
                            {url ? (
                              <a href={url} target="_blank" rel="noreferrer" title={`View insurance card ${side}`}>
                                <img
                                  src={url}
                                  alt={`Insurance card ${side}`}
                                  style={{ height: "70px", border: "1px solid var(--border, #ddd)", borderRadius: "4px", display: "block" }}
                                />
                              </a>
                            ) : (
                              <div style={{ height: "70px", width: "120px", border: "1px dashed var(--border, #ccc)", borderRadius: "4px", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted, #777)", fontSize: "12px" }}>
                                No image
                              </div>
                            )}
                            <div style={{ fontSize: "12px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                              <label className="button button-secondary" style={{ padding: "2px 8px", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1 }}>
                                {busy ? "Working…" : url ? "Replace" : "Upload"}
                                <input
                                  type="file"
                                  accept="image/png,image/jpeg,image/webp,image/gif"
                                  style={{ display: "none" }}
                                  disabled={busy}
                                  onChange={(event) => {
                                    const file = event.target.files?.[0];
                                    event.target.value = "";
                                    if (file) void handleReplaceCard(submission.id, side, file);
                                  }}
                                />
                              </label>
                              {url ? (
                                <button
                                  type="button"
                                  className="button button-secondary"
                                  style={{ padding: "2px 8px" }}
                                  disabled={busy}
                                  onClick={() => void handleRemoveCard(submission.id, side)}
                                >
                                  Remove
                                </button>
                              ) : null}
                              {url ? (
                                <a href={url} target="_blank" rel="noreferrer">View original</a>
                              ) : null}
                            </div>
                            {provenance ? (
                              <span style={{ fontSize: "11px", color: "var(--muted, #777)" }}>{provenance}</span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        {intakeLinks.length > 0 ? (
          <div className="stack-list" style={{ marginTop: "12px" }}>
            <p className="muted" style={{ margin: 0 }}>Recent intake links</p>
            {intakeLinks.slice(0, 5).map((link) => {
              const method = (link.deliveryMethod ?? "clipboard").toLowerCase();
              const deliveryStatus = (link.deliveryStatus ?? "").toLowerCase();
              const deliveryLabel =
                method === "email"
                  ? link.deliveredAt
                    ? `Emailed to ${link.deliveredToEmail ?? "patient"} on ${formatDate(link.deliveredAt)}`
                    : `Email queued${link.deliveredToEmail ? ` to ${link.deliveredToEmail}` : ""}`
                  : "Copied to clipboard";
              let statusBadge: { className: string; text: string } | null = null;
              if (method === "email") {
                if (deliveryStatus === "delivered") {
                  statusBadge = { className: "status status-green", text: `Delivered ${formatDate(link.deliveryStatusAt)}` };
                } else if (deliveryStatus === "bounced") {
                  statusBadge = { className: "status status-red", text: `Bounced ${formatDate(link.deliveryStatusAt)}` };
                } else if (deliveryStatus === "complained") {
                  statusBadge = { className: "status status-red", text: `Marked as spam ${formatDate(link.deliveryStatusAt)}` };
                } else if (deliveryStatus === "failed") {
                  statusBadge = { className: "status status-red", text: `Send failed ${formatDate(link.deliveryStatusAt)}` };
                } else if (deliveryStatus === "sent") {
                  statusBadge = { className: "status status-yellow", text: "Sent, awaiting delivery" };
                }
              }
              return (
                <div className="stack-item stack-row" key={link.id}>
                  <div>
                    <strong>{link.status}</strong>
                    <span>Created: {formatDate(link.createdAt)} · Expires: {formatDate(link.expiresAt)}</span>
                    <span>{deliveryLabel}</span>
                    {statusBadge ? <span className={statusBadge.className}>{statusBadge.text}</span> : null}
                    {link.usedAt ? <span>Used: {formatDate(link.usedAt)}</span> : null}
                    {link.deliveryError ? (
                      <span className="status status-red">Email error: {link.deliveryError}</span>
                    ) : null}
                  </div>
                  <Link className="button button-secondary" href={link.url} target="_blank">Open link</Link>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <section className="panel" style={{ marginBottom: "16px" }}>
        <h2>Alerts</h2>
        {alerts.length === 0 ? <p className="muted">No active chart alerts.</p> : null}
        <div className="stack-list">
          {alerts.map((alert) => (
            <div className="stack-item" key={alert}>
              <span className="status status-yellow">Attention</span>
              <strong>{alert}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="chart-grid">
        <article className="panel">
          <h2>Demographics</h2>
          <div className="detail-list">
            <p><strong>Preferred name:</strong> {patient.preferredName ?? "Not listed"}</p>
            <p><strong>Email:</strong> {patient.email ?? "Not listed"}</p>
            <p><strong>Phone:</strong> {patient.phone ?? "Not listed"}</p>
            <p><strong>Client ID:</strong> {patient.id}</p>
          </div>
        </article>

        <article className="panel">
          <h2>Insurance</h2>
          {policies.length === 0 ? <p className="muted">No active insurance policies found.</p> : null}
          <div className="stack-list">
            {policies.slice(0, 3).map((policy) => (
              <div className="stack-item" key={policy.id}>
                <strong>{policy.plan_name ?? "Insurance policy"}</strong>
                <span>{policy.priority ?? "priority not set"} · {policy.active_flag ? "active" : "inactive"}</span>
                <span>Policy: {policy.policy_number ?? "not listed"}</span>
              </div>
            ))}
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href={`/clients/${patient.id}/eligibility${orgQ}`}>Open Eligibility</Link>
          </div>
        </article>

        <article className="panel">
          <h2>Recent Appointments</h2>
          {details.appointments.length === 0 ? <p className="muted">No appointments found.</p> : null}
          <div className="stack-list">
            {details.appointments.slice(0, 5).map((appointment) => (
              <div className="stack-item" key={appointment.id}>
                <strong>{formatDate(appointment.scheduledStart)}</strong>
                <span>{appointment.type ?? "visit"} · {appointment.reason ?? "no reason listed"}</span>
                <span className={statusClass(appointment.status)}>{appointment.status ?? "scheduled"}</span>
              </div>
            ))}
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href={`/clients/${patient.id}/appointments${orgQ}`}>Open Appointments</Link>
          </div>
        </article>

        <article className="panel">
          <h2>Active Conditions / Diagnoses</h2>
          {details.conditions.length === 0 ? <p className="muted">No diagnoses documented.</p> : null}
          <div className="stack-list">
            {details.conditions.slice(0, 6).map((condition) => (
              <div className="stack-item" key={condition.id}>
                <strong>{condition.code}</strong>
                <span>{condition.description ?? "No description"}</span>
                <span>Last seen: {formatDate(condition.encounterDate)}</span>
              </div>
            ))}
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href={`/clients/${patient.id}/conditions${orgQ}`}>Open Diagnoses</Link>
          </div>
        </article>

        <article className="panel wide-panel">
          <h2>Recent Encounters</h2>
          {encounters.length === 0 ? <p className="muted">No encounters found.</p> : null}
          <div className="stack-list">
            {encounters.slice(0, 6).map((encounter) => (
              <div className="stack-item stack-row" key={encounter.id}>
                <div>
                  <strong>{formatDate(encounter.service_date)}</strong>
                  <span className={statusClass(encounter.encounter_status)}>{encounter.encounter_status ?? "status not set"}</span>
                </div>
                <Link className="button button-secondary" href={`/encounters/${encounter.id}${orgQ}`}>Open Encounter</Link>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <h2>Open Workqueue Items</h2>
          {workqueueItems.length === 0 ? <p className="muted">No open routed items.</p> : null}
          <div className="stack-list">
            {workqueueItems.slice(0, 6).map((item) => (
              <div className="stack-item" key={item.id}>
                <strong>{item.title ?? "Routed item"}</strong>
                <span>{item.work_type ?? "work item"} · {item.priority ?? "priority not set"}</span>
                <span className={statusClass(item.status)}>{item.status ?? "status not set"}</span>
              </div>
            ))}
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href={`/clients/${patient.id}/workqueue${orgQ}`}>Open Client Workqueue</Link>
          </div>
        </article>

        <article className="panel">
          <h2>Balance Summary</h2>
          <div className="detail-list">
            <p><strong>Outstanding:</strong> {formatMoney(summary?.balance?.total ?? 0)}</p>
            <p><strong>Open invoices:</strong> {invoices.length}</p>
            <p><strong>Latest eligibility:</strong> <span className={statusClass(latestEligibility?.eligibility_status)}>{latestEligibility?.eligibility_status ?? "not checked"}</span></p>
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href={`/clients/${patient.id}/balance${orgQ}`}>Open Balance</Link>
          </div>
        </article>

        <article className="panel wide-panel">
          <h2>Claim Summary</h2>
          {details.claims.length === 0 ? <p className="muted">No professional claims found.</p> : null}
          <div className="detail-list" style={{ marginBottom: "12px" }}>
            {Object.entries(claimCounts).slice(0, 6).map(([status, count]) => (
              <p key={status}><strong>{status}:</strong> {count}</p>
            ))}
          </div>
          <div className="stack-list">
            {details.claims.slice(0, 5).map((claim) => (
              <div className="stack-item" key={claim.id}>
                <strong>{claim.claimNumber ?? claim.id.slice(0, 8)}</strong>
                <span className={statusClass(claim.status)}>{claim.status ?? "status not set"}</span>
                <span>Total charge: {formatMoney(claim.totalCharge)}</span>
              </div>
            ))}
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href={`/clients/${patient.id}/claims${orgQ}`}>Open Claims</Link>
            <Link className="button button-secondary" href={`/billing/charge-capture${orgQ}`}>Charge Capture</Link>
          </div>
        </article>

        <article className="panel wide-panel">
          <h2>Documents / Mailroom Summary</h2>
          <div className="metric-grid" style={{ marginTop: 0 }}>
            <article className="metric-card">
              <span>Documents</span>
              <strong>{details.documents.length}</strong>
            </article>
            <article className="metric-card">
              <span>Mailroom Items</span>
              <strong>{details.mailroomItems.length}</strong>
            </article>
            <article className="metric-card">
              <span>Clinical Notes</span>
              <strong>{details.notes.length}</strong>
            </article>
            <article className="metric-card">
              <span>Latest Note</span>
              <strong className="metric-text">{formatDate(details.notes[0]?.encounterDate ?? null)}</strong>
            </article>
          </div>
          <div className="stack-list">
            {details.documents.slice(0, 3).map((document) => (
              <div className="stack-item" key={document.id}>
                <strong>{document.title ?? document.fileName ?? "Document"}</strong>
                <span>Created: {formatDate(document.createdAt)}</span>
              </div>
            ))}
            {details.mailroomItems.slice(0, 3).map((mailroomItem) => (
              <div className="stack-item" key={mailroomItem.id}>
                <strong>{mailroomItem.fileName ?? "Mailroom item"}</strong>
                <span>{mailroomItem.documentType ?? "document"} · {mailroomItem.status ?? "status not set"}</span>
                <span>Received: {formatDate(mailroomItem.createdAt ?? null)}</span>
              </div>
            ))}
          </div>
          <div className="section-actions">
            <Link className="button button-secondary" href={`/clients/${patient.id}/documents${orgQ}`}>Open Documents</Link>
            <Link className="button button-secondary" href={`/mailroom${orgQ}`}>Open Mailroom</Link>
            <Link className="button button-secondary" href={`/clients/${patient.id}/notes${orgQ}`}>Open Notes</Link>
          </div>
        </article>
      </section>
    </>
  );
}
