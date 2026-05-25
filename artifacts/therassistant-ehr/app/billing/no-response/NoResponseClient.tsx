"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import WorkqueueShell, {
  type ColumnDef,
  type DetailTab,
  type FilterDef,
  type RowAction,
  type SummaryMetric,
} from "@/components/billing/WorkqueueShell";
import PlaceClaimOnHoldModal from "@/components/billing/PlaceClaimOnHoldModal";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab =
  | "no_999"
  | "no_277ca"
  | "no_payer_status"
  | "no_era"
  | "past_follow_up";

type Row = {
  id: string;
  claim_number: string | null;
  claim_status: string | null;
  patient_id: string | null;
  patient_name: string;
  payer_profile_id: string | null;
  payer_name: string | null;
  payer_id_external: string | null;
  payer_notes: string | null;
  payer_claims_phone: string | null;
  payer_claims_fax: string | null;
  payer_provider_services_phone: string | null;
  service_date_from: string | null;
  service_date_to: string | null;
  submitted_at: string | null;
  days_outstanding: number | null;
  total_charge: number;
  defer_until: string | null;
  deferred_reason: string | null;
  follow_up_due_date: string | null;
  assigned_to_user_id: string | null;
  assigned_to_display_name: string | null;
  priority: string | null;
  clinician_id: string | null;
  practice_location_id: string | null;
  note_count: number;
  latest_note_excerpt: string | null;
  latest_note_at: string | null;
  last_known_status: string;
  last_status_at: string | null;
  missing_artifact: Tab;
  expected_response_missing: string;
  clearinghouse_trace_number: string | null;
};

type Practice = { id: string; name: string };
type Clinician = { id: string; displayName: string };
type Assignee = { id: string; displayName: string };

type Note = {
  id: string;
  body: string;
  author_display_name: string | null;
  created_at: string;
};

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "no_999", label: "No 999" },
  { id: "no_277ca", label: "No 277CA" },
  { id: "no_payer_status", label: "No Payer Status" },
  { id: "no_era", label: "No ERA" },
  { id: "past_follow_up", label: "Past Follow-Up Date" },
];

// ─── Utils ────────────────────────────────────────────────────────────────────

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value || 0);
}

function dosLabel(r: Row) {
  if (!r.service_date_from && !r.service_date_to) return "—";
  if (
    r.service_date_from &&
    r.service_date_to &&
    r.service_date_from !== r.service_date_to
  ) {
    return `${formatDate(r.service_date_from)} – ${formatDate(r.service_date_to)}`;
  }
  return formatDate(r.service_date_from ?? r.service_date_to);
}

function isUrgent(r: Row): boolean {
  if (r.priority === "urgent") return true;
  if (
    r.follow_up_due_date &&
    r.follow_up_due_date < new Date().toISOString().slice(0, 10)
  )
    return true;
  return (r.days_outstanding ?? 0) > 30;
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        background: "#111827",
        color: "#fff",
        padding: "10px 16px",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        zIndex: 1100,
      }}
    >
      {message}
    </div>
  );
}

// ─── Modal shell ──────────────────────────────────────────────────────────────

const fieldLabel: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 4,
};
const fieldInput: React.CSSProperties = {
  width: "100%",
  padding: 8,
  border: "1px solid #D1D5DB",
  borderRadius: 4,
  fontFamily: "inherit",
  fontSize: 13,
};
const buttonRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
  marginTop: 16,
};

function ModalShell({
  title,
  onClose,
  children,
  width = 480,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          width,
          maxWidth: "92vw",
          maxHeight: "88vh",
          overflow: "auto",
          borderRadius: 8,
          padding: 24,
          boxShadow: "0 12px 32px rgba(0,0,0,0.22)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              fontSize: 20,
              cursor: "pointer",
              color: "#6B7280",
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Action modals ────────────────────────────────────────────────────────────

function FollowUpNoteModal({
  row,
  organizationId,
  onClose,
  onSaved,
}: {
  row: Row;
  organizationId: string;
  onClose: () => void;
  onSaved: (patch: Partial<Row>) => void;
}) {
  const [body, setBody] = useState("");
  const [deferEnabled, setDeferEnabled] = useState(false);
  const [deferDate, setDeferDate] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  });
  const [resolvedDenial, setResolvedDenial] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = body.trim();
    if (!trimmed) {
      setError("Note body is required");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/billing/claims/${row.id}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        body: trimmed,
        defer_until: deferEnabled ? deferDate : null,
        resolved_denial: resolvedDenial,
      }),
    });
    const json = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok || json?.success === false) {
      setError(json?.error || "Failed to save note");
      return;
    }
    onSaved({
      note_count: row.note_count + 1,
      latest_note_excerpt: trimmed.slice(0, 117),
      latest_note_at: new Date().toISOString(),
      defer_until: deferEnabled ? deferDate : row.defer_until,
      follow_up_due_date: deferEnabled ? deferDate : row.follow_up_due_date,
    });
    onClose();
  }

  return (
    <ModalShell title={`Add follow-up note — ${row.patient_name}`} onClose={onClose}>
      <p style={{ color: "#6B7280", fontSize: 13, margin: "0 0 12px" }}>
        Claim {row.claim_number ?? row.id} · {row.payer_name ?? "—"}
      </p>
      <label style={fieldLabel}>Note</label>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={5}
        style={fieldInput}
      />
      <div style={{ marginTop: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={deferEnabled}
            onChange={(e) => setDeferEnabled(e.target.checked)}
          />
          Defer follow-up until
        </label>
        {deferEnabled ? (
          <input
            type="date"
            value={deferDate}
            min={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setDeferDate(e.target.value)}
            style={{ ...fieldInput, marginTop: 6, maxWidth: 220 }}
          />
        ) : null}
      </div>
      <div style={{ marginTop: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={resolvedDenial}
            onChange={(e) => setResolvedDenial(e.target.checked)}
          />
          This note resolved the denial
        </label>
      </div>
      {error ? (
        <div style={{ color: "#B91C1C", marginTop: 8, fontSize: 13 }}>{error}</div>
      ) : null}
      <div style={buttonRow}>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save note"}
        </button>
      </div>
    </ModalShell>
  );
}

function telHref(value: string): string {
  return `tel:${value.replace(/[^\d+]/g, "")}`;
}

function faxHref(value: string): string {
  return `fax:${value.replace(/[^\d+]/g, "")}`;
}

const DISPOSITIONS = ["Left voicemail", "Spoke with rep", "No answer"] as const;
type Disposition = (typeof DISPOSITIONS)[number];

function CallPayerModal({
  row,
  organizationId,
  onClose,
  onLogged,
}: {
  row: Row;
  organizationId: string;
  onClose: () => void;
  onLogged: (note: { body: string; created_at: string }) => void;
}) {
  const claimsPhone = row.payer_claims_phone;
  const claimsFax = row.payer_claims_fax;
  const providerPhone = row.payer_provider_services_phone;
  const hasAnyContact = Boolean(claimsPhone || claimsFax || providerPhone);

  const [logging, setLogging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastContact, setLastContact] = useState<{
    label: string;
    number: string;
    kind: "phone" | "fax";
  } | null>(null);
  const [callLogged, setCallLogged] = useState(false);

  async function postNote(body: string): Promise<boolean> {
    setLogging(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing/claims/${row.id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        setError(json?.error || "Failed to log call");
        return false;
      }
      onLogged({
        body,
        created_at: json?.note?.created_at ?? new Date().toISOString(),
      });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to log call");
      return false;
    } finally {
      setLogging(false);
    }
  }

  function handleDial(
    label: string,
    number: string,
    kind: "phone" | "fax",
  ) {
    setLastContact({ label, number, kind });
    const verb = kind === "fax" ? "Faxed payer at" : "Called payer at";
    void postNote(`${verb} ${number} (${label})`).then((ok) => {
      if (ok) setCallLogged(true);
    });
    // Do not preventDefault — the tel:/fax: link should still dial.
  }

  async function handleDisposition(disp: Disposition) {
    const ref = lastContact
      ? ` — ${lastContact.label} ${lastContact.number}`
      : "";
    await postNote(`${disp}${ref}`);
  }

  function ContactLink({
    label,
    number,
    kind,
  }: {
    label: string;
    number: string;
    kind: "phone" | "fax";
  }) {
    const href = kind === "fax" ? faxHref(number) : telHref(number);
    return (
      <a href={href} onClick={() => handleDial(label, number, kind)}>
        {number}
      </a>
    );
  }

  return (
    <ModalShell title={`Call payer — ${row.payer_name ?? "—"}`} onClose={onClose}>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        <div style={{ marginBottom: 12, color: "#6B7280" }}>
          Use the contact info below to call the payer about claim{" "}
          {row.claim_number ?? row.id}. Clicking a number dials it and logs a
          call note automatically.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px" }}>
          <strong>Payer</strong>
          <span>{row.payer_name ?? "—"}</span>
          <strong>Payer ID</strong>
          <span style={{ fontFamily: "ui-monospace, monospace" }}>
            {row.payer_id_external ?? "—"}
          </span>
          <strong>Claim #</strong>
          <span style={{ fontFamily: "ui-monospace, monospace" }}>
            {row.claim_number ?? "—"}
          </span>
          <strong>Trace #</strong>
          <span style={{ fontFamily: "ui-monospace, monospace" }}>
            {row.clearinghouse_trace_number ?? "—"}
          </span>
          <strong>Claims phone</strong>
          <span>
            {claimsPhone ? (
              <ContactLink label="Claims phone" number={claimsPhone} kind="phone" />
            ) : (
              <span style={{ color: "#94A3B8" }}>—</span>
            )}
          </span>
          <strong>Claims fax</strong>
          <span>
            {claimsFax ? (
              <ContactLink label="Claims fax" number={claimsFax} kind="fax" />
            ) : (
              <span style={{ color: "#94A3B8" }}>—</span>
            )}
          </span>
          <strong>Provider services</strong>
          <span>
            {providerPhone ? (
              <ContactLink
                label="Provider services"
                number={providerPhone}
                kind="phone"
              />
            ) : (
              <span style={{ color: "#94A3B8" }}>—</span>
            )}
          </span>
          {!hasAnyContact ? (
            <>
              <strong>Notes</strong>
              <span style={{ whiteSpace: "pre-wrap" }}>
                {row.payer_notes ?? "No payer contact info on file."}
              </span>
            </>
          ) : null}
        </div>
        {!hasAnyContact ? (
          <p style={{ color: "#94A3B8", fontSize: 12, marginTop: 16 }}>
            Tip: maintain payer phone/fax in Settings → Payers so reps can dial
            directly from this panel.
          </p>
        ) : null}

        {hasAnyContact ? (
          <div style={{ marginTop: 18 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "#64748B",
                textTransform: "uppercase",
                letterSpacing: 0.4,
                marginBottom: 6,
              }}
            >
              Log disposition
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {DISPOSITIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => void handleDisposition(d)}
                  disabled={logging}
                  style={{
                    border: "1px solid #CBD5E1",
                    background: "#F8FAFC",
                    color: "#0F172A",
                    padding: "6px 10px",
                    borderRadius: 999,
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: logging ? "wait" : "pointer",
                  }}
                >
                  {d}
                </button>
              ))}
            </div>
            {callLogged && !error ? (
              <div style={{ color: "#15803D", fontSize: 12, marginTop: 8 }}>
                Call logged to claim notes.
              </div>
            ) : null}
            {error ? (
              <div style={{ color: "#B91C1C", fontSize: 12, marginTop: 8 }}>
                {error}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div style={buttonRow}>
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Detail panel helpers ─────────────────────────────────────────────────────

function DetailKV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        fontSize: 13,
        padding: "5px 0",
        borderBottom: "1px solid #F1F5F9",
      }}
    >
      <span style={{ color: "#64748B", fontWeight: 500 }}>{label}</span>
      <span
        style={{
          color: "#0F172A",
          textAlign: "right",
          maxWidth: "60%",
          wordBreak: "break-word",
        }}
      >
        {value}
      </span>
    </div>
  );
}

type InquiryDetailLine = {
  id: string | null;
  status_category_code: string | null;
  status_code: string | null;
  entity_code: string | null;
  status_effective_date: string | null;
  total_charge_amount: number | null;
  paid_amount: number | null;
  check_eft_number: string | null;
  payer_claim_control_number: string | null;
  service_date_from: string | null;
  service_date_to: string | null;
  message: string | null;
  raw_stc_segment: unknown;
};

type InquiryDetail = {
  id: string | null;
  status: string | null;
  status_code: string | null;
  status_text: string | null;
  requested_at: string | null;
  received_at: string | null;
  created_at: string | null;
  external_transaction_id: string | null;
  payer_id: string | null;
  payer_name: string | null;
  raw_response_json: unknown;
  raw_response_x12: string | null;
};

function InquiryDetailModal({
  claimId,
  inquiryId,
  organizationId,
  onClose,
}: {
  claimId: string;
  inquiryId: string;
  organizationId: string;
  onClose: () => void;
}) {
  const [inquiry, setInquiry] = useState<InquiryDetail | null>(null);
  const [lines, setLines] = useState<InquiryDetailLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rawTab, setRawTab] = useState<"parsed" | "json" | "x12">("parsed");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(
      `/api/billing/claims/${claimId}/status-inquiries/${inquiryId}?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) {
          setError(j.error || "Failed to load inquiry");
        } else {
          setInquiry(j.inquiry as InquiryDetail);
          setLines((j.lines ?? []) as InquiryDetailLine[]);
        }
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [claimId, inquiryId, organizationId]);

  const title = inquiry
    ? `Payer status response · ${formatDateTime(
        inquiry.received_at ?? inquiry.requested_at ?? inquiry.created_at,
      )}`
    : "Payer status response";

  const tabBtn = (id: "parsed" | "json" | "x12", label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setRawTab(id)}
      style={{
        border: "none",
        background: "transparent",
        padding: "6px 10px",
        fontSize: 12,
        fontWeight: rawTab === id ? 600 : 500,
        color: rawTab === id ? "#1D4ED8" : "#475569",
        borderBottom:
          rawTab === id ? "2px solid #1D4ED8" : "2px solid transparent",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <ModalShell title={title} onClose={onClose} width={760}>
      {loading ? (
        <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>
      ) : error ? (
        <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>
      ) : inquiry ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <DetailKV label="Status" value={inquiry.status ?? "—"} />
            <DetailKV label="Status code" value={inquiry.status_code ?? "—"} />
            <DetailKV label="Payer text" value={inquiry.status_text ?? "—"} />
            <DetailKV label="Payer" value={inquiry.payer_name ?? "—"} />
            <DetailKV
              label="Transaction ID"
              value={
                <span style={{ fontFamily: "ui-monospace, monospace" }}>
                  {inquiry.external_transaction_id ?? "—"}
                </span>
              }
            />
            <DetailKV
              label="Requested"
              value={formatDateTime(inquiry.requested_at)}
            />
            <DetailKV
              label="Received"
              value={formatDateTime(inquiry.received_at)}
            />
          </div>
          <div
            role="tablist"
            aria-label="Response view"
            style={{
              display: "flex",
              gap: 4,
              borderBottom: "1px solid #E5E7EB",
            }}
          >
            {tabBtn("parsed", `Parsed lines (${lines.length})`)}
            {tabBtn("json", "Raw JSON")}
            {tabBtn("x12", "Raw X12")}
          </div>
          {rawTab === "parsed" ? (
            lines.length === 0 ? (
              <div style={{ color: "#94A3B8", fontSize: 13 }}>
                No parsed STC lines returned by the payer.
              </div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 8 }}
              >
                {lines.map((l, idx) => (
                  <div
                    key={l.id ?? `ln-${idx}`}
                    style={{
                      border: "1px solid #E5E7EB",
                      borderRadius: 6,
                      padding: 10,
                      background: "#F9FAFB",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: "#0F172A",
                      }}
                    >
                      {l.status_category_code ?? "—"}
                      {l.status_code ? ` · ${l.status_code}` : ""}
                      {l.entity_code ? ` · entity ${l.entity_code}` : ""}
                    </div>
                    {l.message ? (
                      <div
                        style={{
                          fontSize: 12,
                          color: "#475569",
                          marginTop: 4,
                        }}
                      >
                        {l.message}
                      </div>
                    ) : null}
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "auto 1fr",
                        gap: "4px 12px",
                        marginTop: 6,
                        fontSize: 12,
                        color: "#475569",
                      }}
                    >
                      {l.total_charge_amount != null ? (
                        <>
                          <strong>Billed</strong>
                          <span>{formatCurrency(l.total_charge_amount)}</span>
                        </>
                      ) : null}
                      {l.paid_amount != null ? (
                        <>
                          <strong>Paid</strong>
                          <span>{formatCurrency(l.paid_amount)}</span>
                        </>
                      ) : null}
                      {l.check_eft_number ? (
                        <>
                          <strong>Check / EFT</strong>
                          <span style={{ fontFamily: "ui-monospace, monospace" }}>
                            {l.check_eft_number}
                          </span>
                        </>
                      ) : null}
                      {l.payer_claim_control_number ? (
                        <>
                          <strong>Payer claim #</strong>
                          <span style={{ fontFamily: "ui-monospace, monospace" }}>
                            {l.payer_claim_control_number}
                          </span>
                        </>
                      ) : null}
                      {l.service_date_from || l.service_date_to ? (
                        <>
                          <strong>Service dates</strong>
                          <span>
                            {formatDate(l.service_date_from)}
                            {l.service_date_to &&
                            l.service_date_to !== l.service_date_from
                              ? ` – ${formatDate(l.service_date_to)}`
                              : ""}
                          </span>
                        </>
                      ) : null}
                      {l.status_effective_date ? (
                        <>
                          <strong>Effective</strong>
                          <span>{formatDate(l.status_effective_date)}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : rawTab === "json" ? (
            <pre
              style={{
                background: "#0F172A",
                color: "#F1F5F9",
                padding: 12,
                borderRadius: 6,
                fontSize: 12,
                maxHeight: 420,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {inquiry.raw_response_json
                ? JSON.stringify(inquiry.raw_response_json, null, 2)
                : "No raw JSON stored for this inquiry."}
            </pre>
          ) : (
            <pre
              style={{
                background: "#0F172A",
                color: "#F1F5F9",
                padding: 12,
                borderRadius: 6,
                fontSize: 12,
                maxHeight: 420,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {inquiry.raw_response_x12 ?? "No raw X12 stored for this inquiry."}
            </pre>
          )}
        </div>
      ) : null}
      <div style={buttonRow}>
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </ModalShell>
  );
}

function StatusCheckHistory({
  claimId,
  organizationId,
  bumpKey,
}: {
  claimId: string;
  organizationId: string;
  bumpKey: number;
}) {
  type Inquiry = {
    id: string | null;
    status: string | null;
    status_code: string | null;
    status_text: string | null;
    requested_at: string | null;
    received_at: string | null;
    created_at: string | null;
    triggered_by_display_name: string | null;
  };
  type EdiTx = {
    id: string | null;
    transaction_type: string | null;
    direction: string | null;
    status: string | null;
    control_number: string | null;
    sent_at: string | null;
    received_at: string | null;
    created_at: string | null;
  };
  const [inquiries, setInquiries] = useState<Inquiry[] | null>(null);
  const [transactions, setTransactions] = useState<EdiTx[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openInquiryId, setOpenInquiryId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInquiries(null);
    setTransactions([]);
    setError(null);
    fetch(
      `/api/billing/claims/${claimId}/status-inquiries?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) {
          setError(j.error || "Failed to load status check history");
          setInquiries([]);
          return;
        }
        setInquiries((j?.inquiries ?? []) as Inquiry[]);
        setTransactions((j?.transactions ?? []) as EdiTx[]);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      });
    return () => {
      cancelled = true;
    };
  }, [claimId, organizationId, bumpKey]);

  if (error) return <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>;
  if (inquiries == null) return <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>;
  if (inquiries.length === 0 && transactions.length === 0)
    return (
      <div style={{ color: "#94A3B8", fontSize: 13 }}>
        No claim status inquiries have been run for this claim yet. Use
        “Run claim status” to check with the payer.
      </div>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {inquiries.map((i, idx) => {
        const when = i.received_at ?? i.requested_at ?? i.created_at;
        const headline = i.status ?? "unknown";
        const code = i.status_code ? ` · ${i.status_code}` : "";
        const canOpen = Boolean(i.id);
        return (
          <button
            key={i.id ?? `inq-${idx}`}
            type="button"
            disabled={!canOpen}
            onClick={() => {
              if (i.id) setOpenInquiryId(i.id);
            }}
            title={canOpen ? "View full payer response" : undefined}
            style={{
              textAlign: "left",
              border: "1px solid #E5E7EB",
              borderRadius: 6,
              padding: 10,
              background: "#F9FAFB",
              cursor: canOpen ? "pointer" : "default",
              font: "inherit",
              color: "inherit",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 12,
                color: "#6B7280",
                marginBottom: 4,
              }}
            >
              <span>
                {formatDateTime(when)}
                {i.triggered_by_display_name
                  ? ` · ${i.triggered_by_display_name}`
                  : ""}
              </span>
              {canOpen ? (
                <span style={{ color: "#1D4ED8", fontWeight: 600 }}>
                  View response →
                </span>
              ) : null}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {headline}
              {code}
            </div>
            {i.status_text ? (
              <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>
                {i.status_text}
              </div>
            ) : null}
          </button>
        );
      })}
      {openInquiryId ? (
        <InquiryDetailModal
          claimId={claimId}
          inquiryId={openInquiryId}
          organizationId={organizationId}
          onClose={() => setOpenInquiryId(null)}
        />
      ) : null}
      {transactions.length > 0 ? (
        <div style={{ marginTop: 4 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "#64748B",
              textTransform: "uppercase",
              letterSpacing: 0.4,
              marginBottom: 6,
            }}
          >
            276 / 277 transmissions
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {transactions.map((t, idx) => (
              <div
                key={t.id ?? `tx-${idx}`}
                style={{
                  border: "1px solid #E5E7EB",
                  borderRadius: 6,
                  padding: 8,
                  background: "#FFFFFF",
                  fontSize: 12,
                  color: "#475569",
                }}
              >
                <div style={{ fontWeight: 600, color: "#0F172A" }}>
                  {t.transaction_type ?? "EDI"}
                  {t.direction ? ` · ${t.direction}` : ""}
                  {t.status ? ` · ${t.status}` : ""}
                </div>
                <div style={{ marginTop: 2 }}>
                  {formatDateTime(t.received_at ?? t.sent_at ?? t.created_at)}
                  {t.control_number ? ` · ctrl ${t.control_number}` : ""}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NotesPanel({
  claimId,
  organizationId,
  bumpKey,
}: {
  claimId: string;
  organizationId: string;
  bumpKey: number;
}) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setNotes(null);
    setError(null);
    fetch(
      `/api/billing/claims/${claimId}/notes?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) setError(j.error || "Failed");
        else setNotes((j?.notes ?? []) as Note[]);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      });
    return () => {
      cancelled = true;
    };
  }, [claimId, organizationId, bumpKey]);

  if (error) return <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>;
  if (notes == null) return <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>;
  if (notes.length === 0)
    return <div style={{ color: "#94A3B8", fontSize: 13 }}>No notes yet.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {notes.map((n) => (
        <div
          key={n.id}
          style={{
            border: "1px solid #E5E7EB",
            borderRadius: 6,
            padding: 10,
            background: "#F9FAFB",
          }}
        >
          <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 4 }}>
            {n.author_display_name ?? "Staff"} · {formatDateTime(n.created_at)}
          </div>
          <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{n.body}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Action helpers ───────────────────────────────────────────────────────────

async function runClaimStatus(
  row: Row,
  organizationId: string,
): Promise<{ success: boolean; error?: string }> {
  if (!row.patient_id) {
    return { success: false, error: "Missing patient on claim" };
  }
  const res = await fetch("/api/clearinghouse/availity/claim-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      organizationId,
      clientId: row.patient_id,
      claimId: row.id,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    return { success: false, error: json?.error || `Request failed (${res.status})` };
  }
  return { success: true };
}

async function resubmit(
  row: Row,
  organizationId: string,
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`/api/billing/claims/${row.id}/resubmit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      organizationId,
      reason: `Resubmitted from No Response (${row.expected_response_missing} missing)`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    return { success: false, error: json?.error || `Request failed (${res.status})` };
  }
  return { success: true };
}

async function escalate(
  row: Row,
  organizationId: string,
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(
    `/api/billing/executive-priority/${row.id}/escalate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        priority: "urgent",
        reason: `Escalated from No Response (${row.expected_response_missing} missing)`,
      }),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    return { success: false, error: json?.error || `Request failed (${res.status})` };
  }
  return { success: true };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NoResponseClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [practices, setPractices] = useState<Practice[]>([]);
  const [clinicians, setClinicians] = useState<Clinician[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [tabCounts, setTabCounts] = useState<Record<Tab, number>>({
    no_999: 0,
    no_277ca: 0,
    no_payer_status: 0,
    no_era: 0,
    past_follow_up: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<Tab>("no_999");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  const [noteRow, setNoteRow] = useState<Row | null>(null);
  const [callRow, setCallRow] = useState<Row | null>(null);
  const [holdRow, setHoldRow] = useState<Row | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkHoldOpen, setBulkHoldOpen] = useState(false);
  const [bumpKey, setBumpKey] = useState(0);

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId, tab: activeTab });
      for (const [k, v] of Object.entries(filterValues)) {
        if (v && v.length > 0) params.set(k, v);
      }
      const res = await fetch(
        `/api/billing/no-response?${params.toString()}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load");
      setRows((json.items ?? []) as Row[]);
      setTabCounts(json.tabCounts ?? tabCounts);
      setPractices((json.practices ?? []) as Practice[]);
      setClinicians((json.clinicians ?? []) as Clinician[]);
      setAssignees((json.assignees ?? []) as Assignee[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, activeTab, JSON.stringify(filterValues)]);

  useEffect(() => {
    void load();
  }, [load]);

  function patchRow(claimId: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.id === claimId ? { ...r, ...patch } : r)));
  }

  function removeRow(claimId: string) {
    setRows((prev) => prev.filter((r) => r.id !== claimId));
    if (selectedRowId === claimId) setSelectedRowId(null);
  }

  // ── Filter rail ────────────────────────────────────────────────────────────
  const payerOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const r of rows)
      if (r.payer_profile_id && r.payer_name)
        set.set(r.payer_profile_id, r.payer_name);
    return Array.from(set.entries()).map(([value, label]) => ({ value, label }));
  }, [rows]);

  const filters: FilterDef[] = useMemo(
    () => [
      { id: "practice", label: "Practice", kind: "select", options: practices.map((p) => ({ value: p.id, label: p.name })) },
      { id: "clinician", label: "Clinician", kind: "select", options: clinicians.map((c) => ({ value: c.id, label: c.displayName })) },
      { id: "payer", label: "Payer", kind: "select", options: payerOptions },
      { id: "client", label: "Client", kind: "text", placeholder: "Patient name…" },
      { id: "dosFrom", label: "DOS from", kind: "date" },
      { id: "dosTo", label: "DOS to", kind: "date" },
      {
        id: "status",
        label: "Status",
        kind: "select",
        options: [
          { value: "submitted", label: "Submitted" },
          { value: "accepted_oa", label: "Accepted (clearinghouse)" },
          { value: "accepted_payer", label: "Accepted (payer)" },
        ],
      },
      {
        id: "assignedBiller",
        label: "Assigned biller",
        kind: "select",
        options: [
          { value: "__unassigned__", label: "Unassigned" },
          ...assignees.map((a) => ({ value: a.id, label: a.displayName })),
        ],
      },
      { id: "minAmount", label: "Min $", kind: "number", placeholder: "0" },
      { id: "maxAmount", label: "Max $", kind: "number", placeholder: "0" },
      {
        id: "agingBucket",
        label: "Aging bucket",
        kind: "select",
        options: [
          { value: "0-30", label: "0–30 days" },
          { value: "31-60", label: "31–60 days" },
          { value: "61-90", label: "61–90 days" },
          { value: "91-120", label: "91–120 days" },
          { value: "120+", label: "120+ days" },
        ],
      },
      { id: "carcRarc", label: "CARC/RARC", kind: "text", placeholder: "e.g. 197" },
      {
        id: "priority",
        label: "Priority",
        kind: "select",
        options: [
          { value: "urgent", label: "Urgent" },
          { value: "high", label: "High" },
          { value: "normal", label: "Normal" },
          { value: "low", label: "Low" },
        ],
      },
      {
        id: "followUpDue",
        label: "Follow-up due",
        kind: "select",
        options: [
          { value: "overdue", label: "Overdue" },
          { value: "today", label: "Today" },
          { value: "week", label: "Next 7 days" },
        ],
      },
    ],
    [practices, clinicians, payerOptions, assignees],
  );

  // ── Summary metrics ───────────────────────────────────────────────────────
  const summary: SummaryMetric[] = useMemo(() => {
    const total = rows.length;
    const dollars = rows.reduce((s, r) => s + (r.total_charge || 0), 0);
    const oldest = rows.reduce((m, r) => Math.max(m, r.days_outstanding ?? 0), 0);
    const urgent = rows.filter(isUrgent).length;
    return [
      { id: "count", label: "Claims in view", value: total.toLocaleString() },
      {
        id: "dollars",
        label: "Total $ outstanding",
        value: formatCurrency(dollars),
        tone: dollars > 0 ? "amber" : "default",
      },
      {
        id: "oldest",
        label: "Oldest (days)",
        value: oldest,
        tone: oldest > 90 ? "red" : oldest > 30 ? "amber" : "default",
      },
      {
        id: "urgent",
        label: "Urgent",
        value: urgent,
        tone: urgent > 0 ? "red" : "default",
      },
    ];
  }, [rows]);

  // ── Columns (spec-exact labels) ───────────────────────────────────────────
  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      {
        id: "claim",
        header: "Claim ID",
        cell: (r) => (
          <span style={{ fontFamily: "ui-monospace, monospace" }}>
            {r.claim_number ?? r.id.slice(0, 8)}
          </span>
        ),
      },
      { id: "client", header: "Client", cell: (r) => r.patient_name },
      { id: "payer", header: "Payer", cell: (r) => r.payer_name ?? "—" },
      { id: "dos", header: "DOS", cell: (r) => dosLabel(r) },
      { id: "submitted", header: "Submitted date", cell: (r) => formatDate(r.submitted_at) },
      {
        id: "days",
        header: "Days outstanding",
        align: "right",
        cell: (r) => {
          const d = r.days_outstanding ?? 0;
          return (
            <span
              style={{
                fontVariantNumeric: "tabular-nums",
                color: d > 90 ? "#B91C1C" : d > 30 ? "#B45309" : "#0F172A",
                fontWeight: d > 90 ? 600 : 400,
              }}
            >
              {r.days_outstanding != null ? `${d}d` : "—"}
            </span>
          );
        },
      },
      {
        id: "lastStatus",
        header: "Last known status",
        cell: (r) => (
          <div style={{ maxWidth: 220 }}>
            <div>{r.last_known_status}</div>
            {r.last_status_at ? (
              <div style={{ fontSize: 11, color: "#6B7280" }}>
                {formatDate(r.last_status_at)}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: "missing",
        header: "Expected response missing",
        cell: (r) => (
          <span
            style={{
              display: "inline-block",
              padding: "2px 8px",
              borderRadius: 999,
              background: "#FEF3C7",
              color: "#92400E",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            {r.expected_response_missing}
          </span>
        ),
      },
      {
        id: "charge",
        header: "Charge amount",
        align: "right",
        cell: (r) => (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatCurrency(r.total_charge)}
          </span>
        ),
      },
      {
        id: "followUp",
        header: "Follow-up due date",
        cell: (r) => {
          if (!r.follow_up_due_date) return "—";
          const today = new Date().toISOString().slice(0, 10);
          const overdue = r.follow_up_due_date < today;
          return (
            <span
              style={{
                color: overdue ? "#B91C1C" : "#0F172A",
                fontWeight: overdue ? 600 : 400,
              }}
            >
              {formatDate(r.follow_up_due_date)}
            </span>
          );
        },
      },
    ],
    [],
  );

  // ── Row actions (spec-exact labels) ───────────────────────────────────────
  const handleRunStatus = useCallback(
    async (r: Row) => {
      const result = await runClaimStatus(r, organizationId);
      setToast(
        result.success
          ? `Claim status request sent for ${r.claim_number ?? r.id}.`
          : `Claim status failed: ${result.error}`,
      );
      if (result.success) {
        setBumpKey((k) => k + 1);
        void load();
      }
    },
    [organizationId, load],
  );

  const handleResubmit = useCallback(
    async (r: Row) => {
      const result = await resubmit(r, organizationId);
      if (result.success) {
        removeRow(r.id);
        setToast(`Claim ${r.claim_number ?? r.id} queued for resubmission.`);
      } else {
        setToast(`Resubmit failed: ${result.error}`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [organizationId],
  );

  const handleEscalate = useCallback(
    async (r: Row) => {
      const result = await escalate(r, organizationId);
      if (result.success) {
        patchRow(r.id, { priority: "urgent" });
        setToast(`Escalated ${r.claim_number ?? r.id} to urgent.`);
      } else {
        setToast(`Escalate failed: ${result.error}`);
      }
    },
    [organizationId],
  );

  const rowActions: RowAction<Row>[] = useMemo(
    () => [
      { id: "status", label: "Run claim status", onClick: (r) => void handleRunStatus(r) },
      { id: "call", label: "Call payer", onClick: (r) => setCallRow(r) },
      { id: "note", label: "Add follow-up note", onClick: (r) => setNoteRow(r) },
      { id: "resubmit", label: "Resubmit", variant: "primary", onClick: (r) => void handleResubmit(r) },
      { id: "escalate", label: "Escalate", variant: "danger", onClick: (r) => void handleEscalate(r) },
      { id: "hold", label: "Place on hold", onClick: (r) => setHoldRow(r) },
    ],
    [handleRunStatus, handleResubmit, handleEscalate],
  );

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedRowId) ?? null,
    [rows, selectedRowId],
  );

  // ── Detail panel (spec-exact section labels) ──────────────────────────────
  const detailTabs: DetailTab[] = useMemo(
    () => [
      {
        id: "timeline",
        label: "Submission timeline",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV label="Claim #" value={selectedRow.claim_number ?? "—"} />
              <DetailKV label="Status" value={selectedRow.claim_status ?? "—"} />
              <DetailKV label="Submitted" value={formatDateTime(selectedRow.submitted_at)} />
              <DetailKV
                label="Days outstanding"
                value={selectedRow.days_outstanding != null ? `${selectedRow.days_outstanding}d` : "—"}
              />
              <DetailKV label="Last known status" value={selectedRow.last_known_status} />
              <DetailKV label="Last status at" value={formatDateTime(selectedRow.last_status_at)} />
              <DetailKV label="Expected response missing" value={selectedRow.expected_response_missing} />
              <DetailKV label="Follow-up due" value={formatDate(selectedRow.follow_up_due_date)} />
            </div>
          ) : null,
      },
      {
        id: "status_history",
        label: "Status check history",
        render: () =>
          selectedRow ? (
            <StatusCheckHistory
              claimId={selectedRow.id}
              organizationId={organizationId}
              bumpKey={bumpKey}
            />
          ) : null,
      },
      {
        id: "trace",
        label: "Clearinghouse trace number",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV
                label="Trace number"
                value={
                  <span style={{ fontFamily: "ui-monospace, monospace" }}>
                    {selectedRow.clearinghouse_trace_number ?? "—"}
                  </span>
                }
              />
              <DetailKV label="Claim #" value={selectedRow.claim_number ?? "—"} />
              <DetailKV label="Payer claim ID" value={selectedRow.payer_id_external ?? "—"} />
              <p style={{ color: "#94A3B8", fontSize: 12, marginTop: 12 }}>
                Use this trace number when calling the clearinghouse or payer to
                look up the original transmission.
              </p>
            </div>
          ) : null,
      },
      {
        id: "payer_contact",
        label: "Payer contact info",
        render: () =>
          selectedRow ? (
            <div>
              <DetailKV label="Payer" value={selectedRow.payer_name ?? "—"} />
              <DetailKV
                label="Payer ID"
                value={
                  <span style={{ fontFamily: "ui-monospace, monospace" }}>
                    {selectedRow.payer_id_external ?? "—"}
                  </span>
                }
              />
              <div style={{ marginTop: 12, fontSize: 13, whiteSpace: "pre-wrap" }}>
                {selectedRow.payer_notes ?? "No payer contact info on file. Add phone / fax in Settings → Payers."}
              </div>
            </div>
          ) : null,
      },
      {
        id: "notes",
        label: "Notes",
        render: () =>
          selectedRow ? (
            <NotesPanel
              claimId={selectedRow.id}
              organizationId={organizationId}
              bumpKey={bumpKey}
            />
          ) : null,
      },
    ],
    [selectedRow, organizationId, bumpKey],
  );

  const detailActions = selectedRow
    ? [
        {
          id: "status",
          label: "Run claim status",
          onClick: () => void handleRunStatus(selectedRow),
        },
        { id: "call", label: "Call payer", onClick: () => setCallRow(selectedRow) },
        { id: "note", label: "Add follow-up note", onClick: () => setNoteRow(selectedRow) },
        {
          id: "resubmit",
          label: "Resubmit",
          variant: "primary" as const,
          onClick: () => void handleResubmit(selectedRow),
        },
        {
          id: "escalate",
          label: "Escalate",
          variant: "danger" as const,
          onClick: () => void handleEscalate(selectedRow),
        },
        {
          id: "hold",
          label: "Place on hold",
          onClick: () => setHoldRow(selectedRow),
        },
      ]
    : [];

  // ── Tab strip ─────────────────────────────────────────────────────────────
  const tabStrip = (
    <div
      role="tablist"
      aria-label="No Response categories"
      style={{
        display: "flex",
        gap: 4,
        padding: "12px 24px 0",
        borderBottom: "1px solid #E5E7EB",
        flexWrap: "wrap",
      }}
    >
      {TABS.map((t) => {
        const count = tabCounts[t.id] ?? 0;
        const active = t.id === activeTab;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              setActiveTab(t.id);
              setSelectedRowId(null);
            }}
            style={{
              border: "none",
              background: "transparent",
              padding: "8px 12px",
              fontSize: 13,
              fontWeight: active ? 600 : 500,
              color: active ? "#1D4ED8" : "#475569",
              borderBottom: active ? "2px solid #1D4ED8" : "2px solid transparent",
              cursor: "pointer",
            }}
          >
            {t.label}
            <span style={{ marginLeft: 6, color: "#6B7280", fontWeight: 500 }}>{count}</span>
          </button>
        );
      })}
    </div>
  );

  const message = !organizationId
    ? {
        tone: "error" as const,
        text:
          "Missing organizationId. Add ?organizationId=… to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.",
      }
    : error
      ? { tone: "error" as const, text: error }
      : null;

  return (
    <>
      {tabStrip}
      <WorkqueueShell<Row>
        title="No Response"
        description="Claims submitted to a payer where the expected acknowledgement or response has not come back."
        headerActions={[
          ...(selectedIds.length > 0
            ? [
                {
                  id: "bulk-hold",
                  label: `Place ${selectedIds.length} on hold`,
                  variant: "primary" as const,
                  onClick: () => setBulkHoldOpen(true),
                },
                {
                  id: "clear-selection",
                  label: "Clear selection",
                  onClick: () => setSelectedIds([]),
                },
              ]
            : []),
          {
            id: "refresh",
            label: loading ? "Loading…" : "Refresh",
            onClick: () => void load(),
            disabled: loading,
          },
        ]}
        summary={summary}
        filters={filters}
        filterValues={filterValues}
        onFilterChange={setFilterValues}
        filterUrlNamespace={`nr_${activeTab}`}
        rows={rows}
        columns={columns}
        rowId={(r) => r.id}
        rowActions={rowActions}
        loading={loading}
        emptyMessage="No claims awaiting payer response in this view."
        selectedRowId={selectedRowId}
        onSelectRow={setSelectedRowId}
        selectedRowIds={selectedIds}
        onSelectionChange={setSelectedIds}
        detailTabs={detailTabs}
        detailActions={detailActions}
        message={message}
      />

      {noteRow ? (
        <FollowUpNoteModal
          row={noteRow}
          organizationId={organizationId}
          onClose={() => setNoteRow(null)}
          onSaved={(patch) => {
            patchRow(noteRow.id, patch);
            setBumpKey((k) => k + 1);
            setToast("Note saved");
          }}
        />
      ) : null}
      {callRow ? (
        <CallPayerModal
          row={callRow}
          organizationId={organizationId}
          onClose={() => setCallRow(null)}
          onLogged={(note) => {
            patchRow(callRow.id, {
              note_count: callRow.note_count + 1,
              latest_note_excerpt: note.body.slice(0, 117),
              latest_note_at: note.created_at,
            });
            setBumpKey((k) => k + 1);
            setToast("Call logged to claim notes");
          }}
        />
      ) : null}
      {holdRow ? (
        <PlaceClaimOnHoldModal
          claimId={holdRow.id}
          organizationId={organizationId}
          subtitle={`Claim ${holdRow.claim_number ?? holdRow.id} · ${holdRow.payer_name ?? "—"}`}
          onClose={() => setHoldRow(null)}
          onPlaced={() => {
            const label = holdRow.claim_number ?? holdRow.id;
            removeRow(holdRow.id);
            setToast(`Claim ${label} placed on hold.`);
          }}
        />
      ) : null}
      {bulkHoldOpen ? (
        <PlaceClaimOnHoldModal
          claimIds={selectedIds}
          organizationId={organizationId}
          subtitle={`${selectedIds.length} claim${selectedIds.length === 1 ? "" : "s"} selected`}
          onClose={() => setBulkHoldOpen(false)}
          onPlacedBulk={(summary) => {
            for (const r of summary.results) {
              if (r.success) removeRow(r.claimId);
            }
            const parts = [
              `${summary.succeeded} placed on hold`,
              summary.failed > 0 ? `${summary.failed} failed` : null,
            ].filter(Boolean);
            setToast(parts.join(" · "));
            setSelectedIds([]);
          }}
        />
      ) : null}
      {toast ? <Toast message={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}
