"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DEFAULT_ORG_ID } from "@/lib/config";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ClaimData {
  id: string;
  claim_number: string | null;
  claim_status: string | null;
  total_charge: number | null;
  patient_responsibility_amount: number | null;
  payer_responsibility_amount: number | null;
  diagnosis_codes: string[] | null;
  place_of_service: string | null;
  prior_authorization_number: string | null;
  billing_notes: string | null;
  patient_name: string | null;
  patient_id: string | null;
  payer_name: string | null;
  payer_profile_id: string | null;
  submitted_at: string | null;
  created_at: string | null;
  denial_reason_code: string | null;
  denial_reason_description: string | null;
  correction_type: string | null;
  correction_status: string | null;
  correction_reason: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getOrgId(searchParams: ReturnType<typeof useSearchParams>): string {
  return (
    searchParams.get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function fmt$(n: number | null): string {
  return Number(n ?? 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

// ─── CMS-1500 Field Row ───────────────────────────────────────────────────────

function CmsBox({
  box,
  label,
  children,
}: {
  box: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 0,
        borderBottom: "1px solid var(--line)",
        minHeight: 38,
      }}
    >
      <div
        style={{
          width: 52,
          flexShrink: 0,
          padding: "8px 6px",
          background: "var(--sage-soft)",
          borderRight: "1px solid var(--line)",
          textAlign: "center",
          fontSize: 10,
          fontWeight: 700,
          color: "var(--muted)",
        }}
      >
        {box}
      </div>
      <div
        style={{
          width: 180,
          flexShrink: 0,
          padding: "8px 10px",
          background: "var(--sage-soft)",
          borderRight: "1px solid var(--line)",
          fontSize: 10,
          fontWeight: 600,
          color: "var(--muted)",
          textTransform: "uppercase",
          letterSpacing: ".04em",
          alignSelf: "center",
        }}
      >
        {label}
      </div>
      <div style={{ flex: 1, padding: "6px 10px", alignSelf: "center" }}>{children}</div>
    </div>
  );
}

function ReadonlyField({ value }: { value: string | null }) {
  return (
    <span style={{ fontSize: 13, color: value ? "var(--text)" : "var(--muted)" }}>
      {value || "—"}
    </span>
  );
}

interface EditableInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: number | string;
}

function EditableInput({ value, onChange, placeholder, width }: EditableInputProps) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        padding: "5px 8px",
        border: "1px solid var(--line)",
        borderRadius: 4,
        fontSize: 13,
        color: "var(--text)",
        background: "#fff",
        width: width ?? "100%",
        maxWidth: 360,
        boxSizing: "border-box",
        outline: "none",
      }}
    />
  );
}

// ─── Diagnosis Codes Editor ───────────────────────────────────────────────────

function DiagnosisEditor({
  codes,
  onChange,
}: {
  codes: string[];
  onChange: (c: string[]) => void;
}) {
  const MAX = 12;
  const padded = [...codes, ...Array(Math.max(0, MAX - codes.length)).fill("")].slice(0, MAX);

  function update(idx: number, val: string) {
    const next = [...padded];
    next[idx] = val.trim().toUpperCase();
    // Remove trailing empty entries
    while (next.length > 0 && next[next.length - 1] === "") next.pop();
    onChange(next);
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {padded.map((code, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: "var(--muted)",
              width: 14,
              textAlign: "right",
              flexShrink: 0,
            }}
          >
            {String.fromCharCode(65 + i)}.
          </span>
          <input
            type="text"
            value={code}
            onChange={(e) => update(i, e.target.value)}
            placeholder={`ICD-10`}
            style={{
              width: 80,
              padding: "4px 6px",
              border: "1px solid var(--line)",
              borderRadius: 4,
              fontSize: 12,
              background: "#fff",
              color: "var(--text)",
              textTransform: "uppercase",
            }}
          />
        </div>
      ))}
    </div>
  );
}

// ─── Notes Area ───────────────────────────────────────────────────────────────

function NotesArea({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div
      style={{
        marginTop: 24,
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: 8,
        padding: "16px 20px",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: "var(--muted)",
          textTransform: "uppercase",
          letterSpacing: ".05em",
          marginBottom: 8,
        }}
      >
        Billing Notes / Work Log
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Log your notes here — denial reason analysis, correction rationale, communication with payer, etc."
        rows={5}
        style={{
          width: "100%",
          padding: "10px 12px",
          border: "1px solid var(--line)",
          borderRadius: 6,
          fontSize: 13,
          color: "var(--text)",
          resize: "vertical",
          boxSizing: "border-box",
          fontFamily: "inherit",
          lineHeight: 1.5,
          background: "#fafbfc",
        }}
      />
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ClaimCorrectionClient({ claimId }: { claimId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const orgId = getOrgId(searchParams);

  const [claim, setClaim] = useState<ClaimData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Editable fields
  const [diagnosisCodes, setDiagnosisCodes] = useState<string[]>([]);
  const [placeOfService, setPlaceOfService] = useState("");
  const [priorAuth, setPriorAuth] = useState("");
  const [notes, setNotes] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionType, setCorrectionType] = useState<"replacement" | "void">("replacement");

  // Action states
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/billing/claims/${encodeURIComponent(claimId)}?organizationId=${encodeURIComponent(orgId)}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "Claim not found");
      const c: ClaimData = json.claim;
      setClaim(c);
      setDiagnosisCodes(Array.isArray(c.diagnosis_codes) ? c.diagnosis_codes.filter(Boolean) : []);
      setPlaceOfService(c.place_of_service ?? "");
      setPriorAuth(c.prior_authorization_number ?? "");
      setNotes(c.billing_notes ?? "");
      setCorrectionReason(c.correction_reason ?? "");
      setCorrectionType((c.correction_type as "replacement" | "void") ?? "replacement");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load claim");
    } finally {
      setLoading(false);
    }
  }, [claimId, orgId]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveAndResubmit() {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await fetch(
        `/api/billing/claims/${encodeURIComponent(claimId)}/correct`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId: orgId,
            diagnosisCodes: diagnosisCodes.filter(Boolean),
            placeOfService: placeOfService || undefined,
            priorAuthorizationNumber: priorAuth || undefined,
            billingNotes: notes || undefined,
            correctionReason: correctionReason || undefined,
            correctionType,
          }),
        },
      );
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "Save failed");
      setSaved(true);
      setSubmitted(true);
      // Brief delay then go to denials
      setTimeout(() => router.push("/billing/denials"), 1800);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ padding: "40px 28px", color: "var(--muted)", fontSize: 14 }}>
        Loading claim…
      </div>
    );
  }

  if (error || !claim) {
    return (
      <div style={{ padding: "40px 28px" }}>
        <p style={{ color: "var(--danger)", fontSize: 13 }}>{error ?? "Claim not found"}</p>
        <button
          onClick={() => router.back()}
          style={{ marginTop: 12, padding: "8px 16px", border: "1px solid var(--line)", borderRadius: 6, cursor: "pointer" }}
        >
          ← Back
        </button>
      </div>
    );
  }

  const isAlreadySubmitted = submitted || claim.correction_status === "pending_resubmission";

  return (
    <div style={{ padding: "0 0 60px" }}>
      {/* ── Page Header ─────────────────────────────────────────────────── */}
      <div
        style={{
          padding: "20px 28px 16px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          borderBottom: "1px solid var(--line)",
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={() => router.push("/billing/denials")}
          style={{
            padding: "6px 12px",
            border: "1px solid var(--line)",
            borderRadius: 6,
            background: "var(--card)",
            fontSize: 12,
            color: "var(--muted)",
            cursor: "pointer",
          }}
        >
          ← Back to Denials
        </button>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--navy)" }}>
            Correct Claim — {claim.claim_number ?? claim.id}
          </h1>
          <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--muted)" }}>
            {claim.patient_name ?? "Unknown client"} · {claim.payer_name ?? "Unknown payer"}
            {claim.denial_reason_code
              ? ` · Denial: ${claim.denial_reason_code}${claim.denial_reason_description ? ` — ${claim.denial_reason_description}` : ""}`
              : ""}
          </p>
        </div>

        {/* Action Buttons */}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => router.push(`/billing/appeals?claimId=${encodeURIComponent(claimId)}`)}
            style={{
              padding: "8px 14px",
              border: "1px solid var(--line)",
              borderRadius: 6,
              background: "var(--card)",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--sage)",
              cursor: "pointer",
              letterSpacing: ".03em",
            }}
          >
            Appeal
          </button>
          <button
            onClick={() => {
              if (confirm("Move this claim to Client Balances?")) {
                fetch(`/api/billing/claims/${encodeURIComponent(claimId)}/bill-to-patient`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ organizationId: orgId }),
                })
                  .then((r) => r.json())
                  .then((j) => {
                    if (j.success) router.push("/billing/patient-balances");
                  });
              }
            }}
            style={{
              padding: "8px 14px",
              border: "none",
              borderRadius: 6,
              background: "#7a5000",
              color: "#fff",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              letterSpacing: ".03em",
            }}
          >
            Bill to Client
          </button>
          <button
            onClick={saveAndResubmit}
            disabled={saving || isAlreadySubmitted}
            style={{
              padding: "8px 18px",
              border: "none",
              borderRadius: 6,
              background: isAlreadySubmitted ? "var(--sage)" : "var(--navy)",
              color: "#fff",
              fontSize: 12,
              fontWeight: 700,
              cursor: saving || isAlreadySubmitted ? "not-allowed" : "pointer",
              letterSpacing: ".03em",
            }}
          >
            {saving
              ? "Submitting…"
              : isAlreadySubmitted
              ? "✓ Queued for Resubmission"
              : "Resubmit Claim"}
          </button>
        </div>
      </div>

      {saveError && (
        <div
          style={{
            margin: "12px 28px 0",
            padding: "10px 14px",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 6,
            fontSize: 12,
            color: "var(--danger)",
          }}
        >
          {saveError}
        </div>
      )}
      {saved && (
        <div
          style={{
            margin: "12px 28px 0",
            padding: "10px 14px",
            background: "#f0fdf4",
            border: "1px solid #86efac",
            borderRadius: 6,
            fontSize: 12,
            color: "var(--success)",
          }}
        >
          Claim queued for resubmission — redirecting to Denials…
        </div>
      )}

      <div style={{ padding: "20px 28px 0", display: "flex", gap: 20, flexWrap: "wrap" }}>
        {/* ── Left: CMS-1500 Form ─────────────────────────────────────── */}
        <div style={{ flex: "1 1 560px", minWidth: 0 }}>
          <div
            style={{
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {/* Form Header */}
            <div
              style={{
                background: "var(--navy)",
                color: "#fff",
                padding: "10px 16px",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>CMS-1500 Health Insurance Claim Form</span>
              <span style={{ fontSize: 10, opacity: 0.7, fontWeight: 400 }}>
                Claim #{claim.claim_number ?? "—"}
              </span>
            </div>

            {/* Client & Insured Section */}
            <div
              style={{
                padding: "8px 12px",
                background: "var(--sage-soft)",
                borderBottom: "1px solid var(--line)",
                fontSize: 10,
                fontWeight: 700,
                color: "var(--sage)",
                textTransform: "uppercase",
                letterSpacing: ".06em",
              }}
            >
              Client &amp; Insured Information
            </div>

            <CmsBox box="2" label="Client's Name">
              <ReadonlyField value={claim.patient_name} />
            </CmsBox>

            <CmsBox box="4" label="Insured's Name">
              <ReadonlyField value={claim.patient_name} />
            </CmsBox>

            <CmsBox box="1a" label="Insured's ID #">
              <ReadonlyField value={null} />
            </CmsBox>

            <CmsBox box="11" label="Insured's Policy #">
              <ReadonlyField value={null} />
            </CmsBox>

            {/* Physician / Supplier Section */}
            <div
              style={{
                padding: "8px 12px",
                background: "var(--sage-soft)",
                borderBottom: "1px solid var(--line)",
                fontSize: 10,
                fontWeight: 700,
                color: "var(--sage)",
                textTransform: "uppercase",
                letterSpacing: ".06em",
              }}
            >
              Physician / Supplier Information
            </div>

            <CmsBox box="21" label="Diagnosis Codes (ICD-10)">
              <DiagnosisEditor codes={diagnosisCodes} onChange={setDiagnosisCodes} />
            </CmsBox>

            <CmsBox box="23" label="Prior Authorization #">
              <EditableInput
                value={priorAuth}
                onChange={setPriorAuth}
                placeholder="Authorization number…"
                width={220}
              />
            </CmsBox>

            <CmsBox box="24B" label="Place of Service">
              <EditableInput
                value={placeOfService}
                onChange={setPlaceOfService}
                placeholder="e.g. 11"
                width={80}
              />
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3 }}>
                11 = Office · 02 = Telehealth · 21 = Inclient Hospital
              </div>
            </CmsBox>

            <CmsBox box="28" label="Total Charge">
              <ReadonlyField value={fmt$(claim.total_charge)} />
            </CmsBox>

            <CmsBox box="29" label="Amount Paid">
              <ReadonlyField value={fmt$(claim.payer_responsibility_amount)} />
            </CmsBox>

            <CmsBox box="30" label="Balance Due">
              <ReadonlyField
                value={fmt$(
                  (claim.total_charge ?? 0) - (claim.payer_responsibility_amount ?? 0),
                )}
              />
            </CmsBox>

            {/* Correction Type + Reason */}
            <div
              style={{
                padding: "8px 12px",
                background: "var(--sage-soft)",
                borderBottom: "1px solid var(--line)",
                fontSize: 10,
                fontWeight: 700,
                color: "var(--sage)",
                textTransform: "uppercase",
                letterSpacing: ".06em",
              }}
            >
              Resubmission Information
            </div>

            <CmsBox box="22" label="Resubmission Code">
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text)", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="correctionType"
                    value="replacement"
                    checked={correctionType === "replacement"}
                    onChange={() => setCorrectionType("replacement")}
                  />
                  7 — Replacement
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text)", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="correctionType"
                    value="void"
                    checked={correctionType === "void"}
                    onChange={() => setCorrectionType("void")}
                  />
                  8 — Void/Cancel
                </label>
              </div>
            </CmsBox>

            <CmsBox box="19" label="Correction Reason">
              <EditableInput
                value={correctionReason}
                onChange={setCorrectionReason}
                placeholder="e.g. Prior auth not submitted on original claim"
              />
            </CmsBox>

            {/* Read-only informational fields */}
            <div
              style={{
                padding: "8px 12px",
                background: "var(--sage-soft)",
                borderBottom: "1px solid var(--line)",
                fontSize: 10,
                fontWeight: 700,
                color: "var(--sage)",
                textTransform: "uppercase",
                letterSpacing: ".06em",
              }}
            >
              Original Submission Info
            </div>

            <CmsBox box="1" label="Insurance Plan">
              <ReadonlyField value={claim.payer_name} />
            </CmsBox>

            <CmsBox box="3" label="Denial Code">
              <ReadonlyField
                value={
                  claim.denial_reason_code
                    ? `${claim.denial_reason_code}${claim.denial_reason_description ? ` — ${claim.denial_reason_description}` : ""}`
                    : null
                }
              />
            </CmsBox>

            <CmsBox box="31" label="Submitted">
              <ReadonlyField value={fmtDate(claim.submitted_at) || null} />
            </CmsBox>

            <CmsBox box="33" label="Claim Status">
              <ReadonlyField value={claim.claim_status} />
            </CmsBox>
          </div>
        </div>

        {/* ── Right: Notes + Status ───────────────────────────────────── */}
        <div style={{ flex: "0 1 320px", minWidth: 260 }}>
          {/* Current Status card */}
          <div
            style={{
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 8,
              padding: "16px 18px",
              marginBottom: 16,
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: "var(--muted)",
                textTransform: "uppercase",
                letterSpacing: ".05em",
                marginBottom: 10,
              }}
            >
              Claim Summary
            </div>
            {[
              { label: "Claim #", value: claim.claim_number ?? "—" },
              { label: "Client", value: claim.patient_name ?? "—" },
              { label: "Payer", value: claim.payer_name ?? "—" },
              { label: "Total Charge", value: fmt$(claim.total_charge) },
              { label: "Payer Paid", value: fmt$(claim.payer_responsibility_amount) },
              { label: "Pt Responsibility", value: fmt$(claim.patient_responsibility_amount) },
              {
                label: "Original Status",
                value: claim.claim_status ?? "—",
              },
            ].map((row) => (
              <div
                key={row.label}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "5px 0",
                  borderBottom: "1px solid var(--line)",
                  fontSize: 12,
                }}
              >
                <span style={{ color: "var(--muted)" }}>{row.label}</span>
                <span style={{ color: "var(--text)", fontWeight: 500 }}>{row.value}</span>
              </div>
            ))}
          </div>

          {/* Quick Links */}
          <div
            style={{
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 8,
              padding: "14px 18px",
              marginBottom: 16,
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: "var(--muted)",
                textTransform: "uppercase",
                letterSpacing: ".05em",
                marginBottom: 10,
              }}
            >
              Quick Links
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <a
                href={`/billing/claims/${claimId}`}
                style={{ fontSize: 12, color: "var(--navy)", textDecoration: "none", display: "flex", alignItems: "center", gap: 6 }}
              >
                → View Full Claim Detail
              </a>
              <a
                href={`/billing/appeals?claimId=${encodeURIComponent(claimId)}`}
                style={{ fontSize: 12, color: "var(--sage)", textDecoration: "none", display: "flex", alignItems: "center", gap: 6 }}
              >
                → File an Appeal
              </a>
              <a
                href="/billing/denials"
                style={{ fontSize: 12, color: "var(--muted)", textDecoration: "none", display: "flex", alignItems: "center", gap: 6 }}
              >
                ← Back to Denials Queue
              </a>
            </div>
          </div>

          {/* Workflow note */}
          <div
            style={{
              background: "#fffbeb",
              border: "1px solid #fde68a",
              borderRadius: 8,
              padding: "12px 16px",
              fontSize: 11,
              color: "#7a5000",
              lineHeight: 1.5,
            }}
          >
            <strong>Resubmit</strong> queues this claim on the Claims page for the next batch
            submission. Edit the diagnosis codes, place of service, and prior auth above before
            resubmitting.
          </div>
        </div>
      </div>

      {/* ── Notes Area (below form) ───────────────────────────────────────── */}
      <div style={{ padding: "0 28px" }}>
        <NotesArea value={notes} onChange={setNotes} />
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
          Notes are saved when you click <strong>Resubmit Claim</strong>.
        </div>
      </div>
    </div>
  );
}
