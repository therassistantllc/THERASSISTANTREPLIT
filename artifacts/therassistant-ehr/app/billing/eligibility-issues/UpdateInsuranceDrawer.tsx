"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { EligibilityIssueRow } from "@/lib/eligibility/eligibilityIssuesTypes";

type PayerOption = {
  id: string;
  payer_name: string;
  payer_id: string | null;
  payer_category: string | null;
};

type PolicySummary = {
  id: string;
  plan_name: string | null;
  policy_number: string | null;
  group_number: string | null;
  priority: string | null;
  active_flag: boolean | null;
  effective_date: string | null;
  termination_date: string | null;
  payer_id: string | null;
  payer_name?: string | null;
  copay_amount: string | number | null;
};

type Draft = {
  planName: string;
  payerId: string;
  policyNumber: string;
  groupNumber: string;
  effectiveDate: string;
  terminationDate: string;
  copayAmount: string;
};

export type InsuranceUpdate = {
  payerId: string;
  payerName: string;
  policyNumber: string;
  effectiveDate: string | null;
  terminationDate: string | null;
  eligibilityRefreshSuggested: boolean;
};

type Props = {
  row: EligibilityIssueRow;
  organizationId: string;
  onClose: () => void;
  onSaved: (row: EligibilityIssueRow, update: InsuranceUpdate) => void;
  onRunEligibility: (row: EligibilityIssueRow) => Promise<void> | void;
};

function toIsoDate(value: string | null | undefined): string {
  if (!value) return "";
  // accept either YYYY-MM-DD or a full ISO timestamp
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1] : "";
}

export default function UpdateInsuranceDrawer({
  row,
  organizationId,
  onClose,
  onSaved,
  onRunEligibility,
}: Props) {
  const [payers, setPayers] = useState<PayerOption[]>([]);
  const [policy, setPolicy] = useState<PolicySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<InsuranceUpdate | null>(null);
  const [runBusy, setRunBusy] = useState(false);

  const [draft, setDraft] = useState<Draft>({
    planName: "",
    payerId: row.payerId ?? "",
    policyNumber: row.memberId ?? "",
    groupNumber: "",
    effectiveDate: toIsoDate(row.effectiveDate),
    terminationDate: toIsoDate(row.terminationDate),
    copayAmount: row.copay == null ? "" : String(row.copay),
  });

  // Load payers + client policies (to get plan_name/group/copay not on the row)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [payersRes, summaryRes] = await Promise.all([
          fetch(
            `/api/insurance-payers?organizationId=${encodeURIComponent(organizationId)}`,
            { cache: "no-store" },
          ),
          fetch(
            `/api/patients/${encodeURIComponent(row.clientId)}/summary?organizationId=${encodeURIComponent(organizationId)}`,
            { cache: "no-store" },
          ),
        ]);
        const payersJson = await payersRes.json().catch(() => ({}));
        const summaryJson = await summaryRes.json().catch(() => ({}));
        if (cancelled) return;
        if (!payersRes.ok || !payersJson.success) {
          throw new Error(payersJson.error ?? "Failed to load payers");
        }
        setPayers((payersJson.payers ?? []) as PayerOption[]);

        const policies: PolicySummary[] = summaryRes.ok && summaryJson.success
          ? (summaryJson?.insurance?.policies ?? [])
          : [];
        const matched = row.insurancePolicyId
          ? policies.find((p) => p.id === row.insurancePolicyId) ?? null
          : null;
        if (matched) {
          setPolicy(matched);
          setDraft((prev) => ({
            ...prev,
            planName: matched.plan_name ?? "",
            payerId: matched.payer_id ?? prev.payerId,
            policyNumber: matched.policy_number ?? prev.policyNumber,
            groupNumber: matched.group_number ?? "",
            effectiveDate: toIsoDate(matched.effective_date) || prev.effectiveDate,
            terminationDate: toIsoDate(matched.termination_date) || prev.terminationDate,
            copayAmount:
              matched.copay_amount == null || matched.copay_amount === ""
                ? prev.copayAmount
                : String(matched.copay_amount),
          }));
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, row.clientId, row.insurancePolicyId]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hasPolicy = Boolean(row.insurancePolicyId);

  const payerNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of payers) m.set(p.id, p.payer_name);
    return m;
  }, [payers]);

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!hasPolicy || !row.insurancePolicyId) return;
    setSaveError(null);
    const policyNumber = draft.policyNumber.trim();
    if (!policyNumber) {
      setSaveError("Policy number is required");
      return;
    }
    if (!draft.payerId) {
      setSaveError("Payer is required");
      return;
    }
    if (
      draft.effectiveDate &&
      draft.terminationDate &&
      draft.effectiveDate > draft.terminationDate
    ) {
      setSaveError("Effective date must be on or before termination date");
      return;
    }
    if (draft.copayAmount.trim()) {
      const n = Number(draft.copayAmount.trim());
      if (!Number.isFinite(n) || n < 0) {
        setSaveError("Copay must be a non-negative number");
        return;
      }
    }
    setSaving(true);
    try {
      const res = await fetch(
        `/api/clients/${encodeURIComponent(row.clientId)}/policies/${encodeURIComponent(row.insurancePolicyId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            planName: draft.planName.trim() || null,
            payerId: draft.payerId,
            policyNumber,
            groupNumber: draft.groupNumber.trim() || null,
            effectiveDate: draft.effectiveDate.trim() || null,
            terminationDate: draft.terminationDate.trim() || null,
            copayAmount: draft.copayAmount.trim() || null,
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to update policy");
      }
      const payerName =
        payerNameById.get(draft.payerId) ?? policy?.payer_name ?? row.payerName;
      const update: InsuranceUpdate = {
        payerId: draft.payerId,
        payerName,
        policyNumber,
        effectiveDate: draft.effectiveDate.trim() || null,
        terminationDate: draft.terminationDate.trim() || null,
        eligibilityRefreshSuggested: Boolean(json.eligibilityRefreshSuggested),
      };
      setSaved(update);
      onSaved(row, update);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to update policy");
    } finally {
      setSaving(false);
    }
  }, [draft, hasPolicy, onSaved, organizationId, payerNameById, policy, row]);

  const handleRunEligibility = useCallback(async () => {
    setRunBusy(true);
    try {
      await onRunEligibility(row);
      onClose();
    } finally {
      setRunBusy(false);
    }
  }, [onRunEligibility, onClose, row]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Update insurance"
      style={{
        position: "fixed", inset: 0, zIndex: 1200,
        background: "rgba(15, 23, 42, 0.4)",
        display: "flex", justifyContent: "flex-end",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520, maxWidth: "100%", height: "100%",
          background: "#fff", boxShadow: "-12px 0 32px rgba(0,0,0,0.18)",
          display: "flex", flexDirection: "column",
        }}
      >
        <header
          style={{
            padding: "16px 20px", borderBottom: "1px solid #E5E7EB",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#0F172A" }}>
              Update insurance
            </div>
            <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>
              {row.clientName} · {row.payerName || "No payer"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent", border: "1px solid #E5E7EB",
              borderRadius: 6, padding: "6px 10px", cursor: "pointer",
              color: "#475569", fontSize: 13,
            }}
          >
            Close
          </button>
        </header>

        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {loading ? (
            <p style={{ color: "#64748B", fontSize: 13 }}>Loading insurance details…</p>
          ) : loadError ? (
            <p style={{ color: "#B91C1C", fontSize: 13 }}>{loadError}</p>
          ) : !hasPolicy ? (
            <div>
              <p style={{ color: "#B45309", fontSize: 13, marginTop: 0 }}>
                This appointment has no insurance policy on file yet. Add or attach a
                policy from the client&apos;s chart, then return here to re-run eligibility.
              </p>
              <a
                href={`/patients/${encodeURIComponent(row.clientId)}?tab=insurance`}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: "inline-block", marginTop: 8,
                  padding: "8px 14px", borderRadius: 6, fontSize: 13,
                  background: "#0F172A", color: "#fff", textDecoration: "none",
                }}
              >
                Open client chart
              </a>
            </div>
          ) : saved ? (
            <div>
              <div
                style={{
                  background: "#ECFDF5", color: "#065F46",
                  border: "1px solid #A7F3D0", borderRadius: 6,
                  padding: "10px 12px", fontSize: 13, marginBottom: 12,
                }}
              >
                Insurance updated.
                {saved.eligibilityRefreshSuggested
                  ? " The payer or coverage window changed — run eligibility now to refresh this row."
                  : ""}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => void handleRunEligibility()}
                  disabled={runBusy || !row.appointmentId}
                  style={{
                    background: "#0F172A", color: "#fff",
                    border: "none", borderRadius: 6, padding: "8px 14px",
                    fontSize: 13, cursor: runBusy ? "default" : "pointer",
                    opacity: runBusy || !row.appointmentId ? 0.6 : 1,
                  }}
                >
                  {runBusy ? "Running…" : "Run eligibility now"}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    background: "#fff", color: "#0F172A",
                    border: "1px solid #CBD5E1", borderRadius: 6,
                    padding: "8px 14px", fontSize: 13, cursor: "pointer",
                  }}
                >
                  Back to queue
                </button>
              </div>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSave();
              }}
            >
              <Field label="Payer" required>
                <select
                  value={draft.payerId}
                  onChange={(e) => update({ payerId: e.target.value })}
                  style={inputStyle}
                  required
                >
                  <option value="">Select a payer…</option>
                  {payers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.payer_name}
                      {p.payer_id ? ` (${p.payer_id})` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Member / Policy number" required>
                <input
                  type="text"
                  value={draft.policyNumber}
                  onChange={(e) => update({ policyNumber: e.target.value })}
                  style={inputStyle}
                  maxLength={80}
                  required
                />
              </Field>
              <Field label="Group number">
                <input
                  type="text"
                  value={draft.groupNumber}
                  onChange={(e) => update({ groupNumber: e.target.value })}
                  style={inputStyle}
                  maxLength={80}
                />
              </Field>
              <Field label="Plan name">
                <input
                  type="text"
                  value={draft.planName}
                  onChange={(e) => update({ planName: e.target.value })}
                  style={inputStyle}
                  maxLength={200}
                />
              </Field>
              <div style={{ display: "flex", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <Field label="Effective date">
                    <input
                      type="date"
                      value={draft.effectiveDate}
                      onChange={(e) => update({ effectiveDate: e.target.value })}
                      style={inputStyle}
                    />
                  </Field>
                </div>
                <div style={{ flex: 1 }}>
                  <Field label="Termination date">
                    <input
                      type="date"
                      value={draft.terminationDate}
                      onChange={(e) => update({ terminationDate: e.target.value })}
                      style={inputStyle}
                    />
                  </Field>
                </div>
              </div>
              <Field label="Copay ($)">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={draft.copayAmount}
                  onChange={(e) => update({ copayAmount: e.target.value })}
                  style={inputStyle}
                />
              </Field>

              {saveError ? (
                <p style={{ color: "#B91C1C", fontSize: 13, marginTop: 4 }}>{saveError}</p>
              ) : null}

              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button
                  type="submit"
                  disabled={saving}
                  style={{
                    background: "#0F172A", color: "#fff",
                    border: "none", borderRadius: 6, padding: "8px 14px",
                    fontSize: 13, cursor: saving ? "default" : "pointer",
                    opacity: saving ? 0.6 : 1,
                  }}
                >
                  {saving ? "Saving…" : "Save changes"}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={saving}
                  style={{
                    background: "#fff", color: "#0F172A",
                    border: "1px solid #CBD5E1", borderRadius: 6,
                    padding: "8px 14px", fontSize: 13, cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <a
                  href={`/patients/${encodeURIComponent(row.clientId)}?tab=insurance`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    marginLeft: "auto", alignSelf: "center",
                    fontSize: 12, color: "#475569",
                  }}
                >
                  Open full chart ↗
                </a>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box",
  padding: "8px 10px", fontSize: 13,
  border: "1px solid #CBD5E1", borderRadius: 6,
  background: "#fff", color: "#0F172A",
};

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span
        style={{
          display: "block", fontSize: 12, fontWeight: 600,
          color: "#475569", marginBottom: 4,
        }}
      >
        {label}
        {required ? <span style={{ color: "#B91C1C", marginLeft: 2 }}>*</span> : null}
      </span>
      {children}
    </label>
  );
}
