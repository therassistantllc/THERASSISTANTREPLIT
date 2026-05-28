"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

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
  demographics?: Record<string, unknown> | null;
  insurance?: Record<string, unknown> | null;
  consents?: Record<string, unknown> | null;
  screeners?: Record<string, unknown> | null;
};

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

function readString(obj: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

export default function IntakePanel({
  clientId,
  patientEmail,
}: {
  clientId: string;
  patientEmail?: string | null;
}) {
  const [submissions, setSubmissions] = useState<IntakeSubmission[]>([]);
  const [links, setLinks] = useState<IntakeLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cardBusy, setCardBusy] = useState<string | null>(null);
  const [cardRefresh, setCardRefresh] = useState(0);

  const reload = useCallback(async () => {
    try {
      const [linksRes, subsRes] = await Promise.all([
        fetch(`/api/intake/links?clientId=${encodeURIComponent(clientId)}`, { cache: "no-store" }),
        fetch(`/api/intake/submissions?clientId=${encodeURIComponent(clientId)}`, { cache: "no-store" }),
      ]);
      const linksJson = await linksRes.json().catch(() => ({}));
      const subsJson = await subsRes.json().catch(() => ({}));
      if (linksRes.ok && linksJson.success) setLinks(linksJson.links ?? []);
      if (subsRes.ok && subsJson.success) setSubmissions(subsJson.submissions ?? []);
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    if (!clientId) return;
    void reload();
  }, [clientId, reload]);

  async function handleCreateIntakeLink(delivery: "clipboard" | "email") {
    setBusy(true);
    setMessage(null);
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
        const to = json.email?.to ?? "the client";
        setMessage(`Intake link emailed to ${to}.`);
      } else {
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            await navigator.clipboard.writeText(url);
            setMessage(`Intake link copied to clipboard: ${url}`);
          } else {
            setMessage(`Intake link: ${url}`);
          }
        } catch {
          setMessage(`Intake link: ${url}`);
        }
      }
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to create intake link");
    } finally {
      setBusy(false);
    }
  }

  async function handleReplaceCard(submissionId: string, side: "front" | "back", file: File) {
    const key = `${submissionId}:${side}`;
    setCardBusy(key);
    setMessage(null);
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
      setMessage(`Insurance card ${side} updated.`);
      setCardRefresh((n) => n + 1);
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to replace card image");
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
    setMessage(null);
    try {
      const response = await fetch(
        `/api/intake/card/${encodeURIComponent(submissionId)}/${side}`,
        { method: "DELETE" },
      );
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to remove card image");
      setMessage(`Insurance card ${side} removed.`);
      setCardRefresh((n) => n + 1);
      await reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to remove card image");
    } finally {
      setCardBusy(null);
    }
  }

  const latest = submissions[0] ?? null;
  const latestDemo = (latest?.demographics ?? {}) as Record<string, unknown>;
  const latestInsurance = (latest?.insurance ?? {}) as Record<string, unknown>;
  const latestConsents = (latest?.consents ?? {}) as Record<string, unknown>;
  const latestScreeners = (latest?.screeners ?? {}) as Record<string, unknown>;

  function renderField(label: string, value: string | null | undefined) {
    return (
      <div style={{ display: "flex", flexDirection: "column", minWidth: 180, marginBottom: 8 }}>
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--muted, #777)" }}>{label}</span>
        <span style={{ fontSize: 14 }}>{value && value.trim().length > 0 ? value : "—"}</span>
      </div>
    );
  }

  return (
    <main className="app-shell">
      <section className="page-header">
        <div>
          <p className="eyebrow">Client Chart</p>
          <h2>Client Intake</h2>
        </div>
        <div className="hero-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => handleCreateIntakeLink("email")}
            disabled={busy || !patientEmail}
            title={patientEmail ? `Email intake link to ${patientEmail}` : "No email on file"}
          >
            {busy ? "Sending…" : "Email intake link"}
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => handleCreateIntakeLink("clipboard")}
            disabled={busy}
          >
            {busy ? "Generating…" : "Copy intake link"}
          </button>
        </div>
      </section>

      {message ? <div className="alert-panel">{message}</div> : null}
      {loading ? <div className="empty-state">Loading intake…</div> : null}

      {!loading && submissions.length === 0 && links.length === 0 ? (
        <div className="empty-state">
          No intake on file yet. Send the client a one-time intake link to collect demographics,
          insurance, consents, and screening tools (PHQ-9, GAD-7).
        </div>
      ) : null}

      {latest ? (
        <>
          <section className="panel" style={{ marginBottom: 16 }}>
            <h2>Latest submission</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Submitted {formatDateTime(latest.submittedAt)} · Signed by {latest.signatureName ?? "—"}
            </p>
          </section>

          <section className="panel" style={{ marginBottom: 16 }}>
            <h2>Demographics</h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
              {renderField("Legal name", [readString(latestDemo, "firstName"), readString(latestDemo, "lastName")].filter(Boolean).join(" ") || null)}
              {renderField("Preferred name", readString(latestDemo, "preferredName"))}
              {renderField("Date of birth", readString(latestDemo, "dateOfBirth"))}
              {renderField("Sex / Gender", readString(latestDemo, "gender") ?? readString(latestDemo, "sex"))}
              {renderField("Phone", readString(latestDemo, "phone"))}
              {renderField("Email", readString(latestDemo, "email"))}
              {renderField("Address", readString(latestDemo, "address") ?? readString(latestDemo, "addressLine1"))}
              {renderField("Emergency contact", readString(latestDemo, "emergencyContactName"))}
              {renderField("Emergency phone", readString(latestDemo, "emergencyContactPhone"))}
            </div>
          </section>

          <section className="panel" style={{ marginBottom: 16 }}>
            <h2>Screening tools</h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
              {renderField("PHQ-9 score", latest.phq9Score !== null ? `${latest.phq9Score}` : null)}
              {renderField("PHQ-9 severity", latest.phq9Severity)}
              {renderField("GAD-7 score", latest.gad7Score !== null ? `${latest.gad7Score}` : null)}
              {renderField("GAD-7 severity", latest.gad7Severity)}
            </div>
            {Object.keys(latestScreeners).length > 0 ? (
              <details style={{ marginTop: 8 }}>
                <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Raw screener responses</summary>
                <pre style={{ fontSize: 12, background: "var(--surface-muted, #f6f7f9)", padding: 10, borderRadius: 4, overflow: "auto" }}>
{JSON.stringify(latestScreeners, null, 2)}
                </pre>
              </details>
            ) : null}
          </section>

          <section className="panel" style={{ marginBottom: 16 }}>
            <h2>Consents on file</h2>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>HIPAA Notice of Privacy Practices: {latestConsents.hipaa ? "Signed" : "—"}</li>
              <li>Telehealth consent: {latestConsents.telehealth ? "Signed" : "—"}</li>
              <li>Release of Information: {latestConsents.roi ? "Signed" : "—"}</li>
            </ul>
            {latest.signatureSignedAt ? (
              <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                Signed on {formatDateTime(latest.signatureSignedAt)}
              </p>
            ) : null}
          </section>

          <section className="panel" style={{ marginBottom: 16 }}>
            <h2>Insurance card images</h2>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              {(["front", "back"] as const).map((side) => {
                const raw = side === "front" ? latestInsurance.cardFront : latestInsurance.cardBack;
                const meta = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
                const hasImage = (typeof meta.path === "string" && meta.path.length > 0) ||
                  (typeof meta.content === "string" && meta.content.startsWith("data:image/"));
                const cacheBust = `?v=${encodeURIComponent(String(meta.uploadedAt ?? "") + ":" + cardRefresh)}`;
                const url = hasImage ? `/api/intake/card/${encodeURIComponent(latest.id)}/${side}${cacheBust}` : null;
                const busyKey = `${latest.id}:${side}`;
                const isBusy = cardBusy === busyKey;
                const uploadedAt = typeof meta.uploadedAt === "string" ? meta.uploadedAt : null;
                const replacedByStaffName = typeof meta.replacedByStaffName === "string" && meta.replacedByStaffName
                  ? meta.replacedByStaffName
                  : (typeof meta.replacedByStaffId === "string" && meta.replacedByStaffId ? "a staff member" : null);
                const provenance = url
                  ? replacedByStaffName
                    ? `Updated by ${replacedByStaffName}${uploadedAt ? ` on ${formatDateTime(uploadedAt)}` : ""}`
                    : uploadedAt
                      ? `Uploaded by client at intake (${formatDateTime(uploadedAt)})`
                      : "Uploaded by client at intake"
                  : null;
                return (
                  <div key={side} style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 160 }}>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>Card {side === "front" ? "Front" : "Back"}</span>
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer" title={`View insurance card ${side}`}>
                        <img
                          src={url}
                          alt={`Insurance card ${side}`}
                          style={{ height: 100, border: "1px solid var(--border, #ddd)", borderRadius: 4, display: "block" }}
                        />
                      </a>
                    ) : (
                      <div style={{ height: 100, width: 160, border: "1px dashed var(--border, #ccc)", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted, #777)", fontSize: 12 }}>
                        No image
                      </div>
                    )}
                    <div style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <label className="button button-secondary" style={{ padding: "2px 8px", cursor: isBusy ? "not-allowed" : "pointer", opacity: isBusy ? 0.6 : 1 }}>
                        {isBusy ? "Working…" : url ? "Replace" : "Upload"}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          style={{ display: "none" }}
                          disabled={isBusy}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file) void handleReplaceCard(latest.id, side, file);
                          }}
                        />
                      </label>
                      {url ? (
                        <button
                          type="button"
                          className="button button-secondary"
                          style={{ padding: "2px 8px" }}
                          disabled={isBusy}
                          onClick={() => void handleRemoveCard(latest.id, side)}
                        >
                          Remove
                        </button>
                      ) : null}
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer">View original</a>
                      ) : null}
                    </div>
                    {provenance ? (
                      <span style={{ fontSize: 11, color: "var(--muted, #777)" }}>{provenance}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {(() => {
              const status = typeof latestInsurance.cardSuggestionStatus === "string"
                ? latestInsurance.cardSuggestionStatus
                : null;
              const sug = (latestInsurance.cardSuggestion && typeof latestInsurance.cardSuggestion === "object")
                ? (latestInsurance.cardSuggestion as Record<string, unknown>)
                : null;
              if (!status || status === "no_card" || status === "not_attempted") return null;
              const badge =
                status === "pending"
                  ? { className: "status status-green", text: "Auto-filled from card" }
                  : status === "low_confidence"
                    ? { className: "status status-yellow", text: "Low-confidence parse — please review" }
                    : { className: "status status-red", text: "Auto-fill unavailable — key from image" };
              const row = (label: string, key: string) => {
                const v = sug && typeof sug[key] === "string" ? (sug[key] as string) : null;
                return v ? (
                  <div style={{ display: "flex", flexDirection: "column", minWidth: 160 }}>
                    <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--muted, #777)" }}>{label}</span>
                    <span style={{ fontSize: 13 }}>{v}</span>
                  </div>
                ) : null;
              };
              return (
                <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--border, #ddd)", borderRadius: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <strong style={{ fontSize: 13 }}>Card OCR suggestion</strong>
                    <span className={badge.className}>{badge.text}</span>
                  </div>
                  {sug ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
                      {row("Payer", "payer_name")}
                      {row("Member ID", "member_id")}
                      {row("Group #", "group_number")}
                      {row("Plan", "plan_name")}
                      {row("Subscriber", "subscriber_name")}
                      {row("RX BIN", "rx_bin")}
                      {row("RX PCN", "rx_pcn")}
                      {row("Member services", "payer_phone")}
                    </div>
                  ) : (
                    <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                      The vision parser could not read this card. Enter the policy by hand.
                    </p>
                  )}
                </div>
              );
            })()}
          </section>

          {submissions.length > 1 ? (
            <section className="panel" style={{ marginBottom: 16 }}>
              <h2>Earlier submissions</h2>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {submissions.slice(1).map((s) => (
                  <li key={s.id} style={{ marginBottom: 4 }}>
                    {formatDateTime(s.submittedAt)} · signed by {s.signatureName ?? "—"} · PHQ-9 {s.phq9Score ?? "—"} · GAD-7 {s.gad7Score ?? "—"}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}

      {links.length > 0 ? (
        <section className="panel" style={{ marginBottom: 16 }}>
          <h2>Intake links</h2>
          <div className="stack-list">
            {links.map((link) => {
              const method = (link.deliveryMethod ?? "clipboard").toLowerCase();
              const deliveryStatus = (link.deliveryStatus ?? "").toLowerCase();
              const deliveryLabel =
                method === "email"
                  ? link.deliveredAt
                    ? `Emailed to ${link.deliveredToEmail ?? "client"} on ${formatDate(link.deliveredAt)}`
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
        </section>
      ) : null}
    </main>
  );
}
