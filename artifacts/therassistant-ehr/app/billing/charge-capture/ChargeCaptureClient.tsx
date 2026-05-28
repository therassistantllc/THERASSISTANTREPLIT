"use client";

/**
 * Charges / Charge Capture
 *
 * Operational charge queue. When a clinician signs a note the charge is
 * created and routed here. Charges are auto-batched by Payer ID + TIN.
 *
 * Top section  — Batch panel: one card per batch, grouped by payer/TIN.
 *               Actions: Download 837, Submit Batch (stub), Mark as Submitted.
 *
 * Bottom section — Dense charge queue.
 *               Columns: Patient, DOS, CPT, Provider, Status, Actions.
 *               Statuses: Missing DX | Unsigned | Ready | Hold
 *               Row actions: Edit charge, Attach diagnosis,
 *                            Review authorization, Release to billing.
 *
 * Data sources:
 *   GET  /api/billing/charges/batches         — batches grouped by payer/TIN
 *   GET  /api/billing/charge-capture          — per-charge queue rows
 *   POST /api/billing/charges/batches/:id/download    — 837 file
 *   POST /api/billing/charges/batches/:id/submit      — electronic (stub)
 *   POST /api/billing/charges/batches/:id/mark-submitted
 *   PATCH /api/billing/charge-capture/:id             — edit/status change
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

// ── Helpers ───────────────────────────────────────────────────────────────────

function getOrgId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function fmtDate(v: string | null) {
  if (!v) return "—";
  const d = new Date(v + (v.includes("T") ? "" : "T00:00:00"));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtMoney(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// ── Types ─────────────────────────────────────────────────────────────────────

type ChargeStatus = "Missing DX" | "Unsigned" | "Ready" | "Hold";

interface ChargeRow {
  id: string;
  chargeStatus: string;
  tab: string;
  dateOfService: string | null;
  client: { id: string; name: string; dob: string | null };
  clinician: string;
  providerSelectedCode: string | null;
  systemSuggestedCode: string | null;
  encounter: {
    id: string | null;
    noteSigned: boolean;
    billingFieldsComplete: boolean;
    noteStatus: string;
  };
  codingAlerts: string[];
  blockers: string[];
  chargeAmount: number;
  claimId: string | null;
  payer: { id: string; name: string } | null;
  authorization: { status: string; number: string | null };
}

interface Batch {
  id: string;
  batchNumber: string;
  status: string;
  claimCount: number;
  totalChargeAmount: number;
  payerName: string;
  billingProviderTaxId: string | null;
  submittedAt: string | null;
  generatedFileName: string | null;
}

interface ChargeDetail {
  id: string;
  status: string;
  serviceDate: string | null;
  placeOfService: string | null;
  totalCharge: number;
  claimId: string | null;
  client: {
    id: string;
    firstName: string;
    lastName: string;
    displayName: string;
    dateOfBirth: string | null;
    accountNumber: string | null;
  } | null;
  provider: {
    id: string;
    displayName: string;
    credential: string | null;
    npi: string | null;
  } | null;
  payer: { id: string; name: string; payerType: string | null } | null;
  policy: {
    planName: string | null;
    policyNumber: string | null;
    subscriberId: string | null;
  } | null;
  diagnoses: string[];
  serviceLines: Array<{
    lineNumber: number;
    procedureCode: string;
    serviceDateFrom: string | null;
    serviceDateTo: string | null;
    modifiers: string[];
    diagnosisPointers: string[];
    units: number;
    chargeAmount: number;
    placeOfService: string | null;
    renderingProviderNpi: string | null;
    authorizationNumber: string | null;
  }>;
}

interface EditSL {
  procedureCode: string;
  serviceDateFrom: string;
  serviceDateTo: string;
  modifiers: string;
  diagnosisPointers: string;
  units: string;
  chargeAmount: string;
  placeOfService: string;
  renderingProviderNpi: string;
  authorizationNumber: string;
}

function slInputStyle(w: number): React.CSSProperties {
  return { width: w, padding: "4px 6px", border: "1px solid #CBD5E1", borderRadius: 4, fontSize: 12, boxSizing: "border-box" };
}

// ── Status derivation ─────────────────────────────────────────────────────────

function deriveStatus(r: ChargeRow): ChargeStatus {
  if (r.tab === "held_charges" || r.chargeStatus === "blocked") return "Hold";
  if (!r.encounter.noteSigned) return "Unsigned";
  if (
    r.codingAlerts.length > 0 ||
    r.blockers.some((b) => /diag|dx|cpt|code/i.test(b)) ||
    !r.encounter.billingFieldsComplete
  ) return "Missing DX";
  return "Ready";
}

const STATUS_STYLE: Record<ChargeStatus, { bg: string; color: string }> = {
  "Missing DX": { bg: "#FEF2F2", color: "#991B1B" },
  "Unsigned":   { bg: "#FFFBEB", color: "#92400E" },
  "Ready":      { bg: "#F0FDF4", color: "#166534" },
  "Hold":       { bg: "#FFF7ED", color: "#C2410C" },
};

// ── Batch status style ────────────────────────────────────────────────────────

function batchStatusStyle(s: string): { bg: string; color: string } {
  switch (s.toLowerCase()) {
    case "submitted": case "accepted": return { bg: "#F0FDF4", color: "#166534" };
    case "generated": case "ready_to_generate": return { bg: "#EFF6FF", color: "#1D4ED8" };
    case "failed": case "rejected": return { bg: "#FEF2F2", color: "#991B1B" };
    default: return { bg: "#F8FAFC", color: "#475569" };
  }
}

function batchStatusLabel(s: string): string {
  switch (s.toLowerCase()) {
    case "ready_to_generate": return "Ready";
    case "generated": return "Generated";
    case "submitted": return "Submitted";
    case "accepted": return "Accepted";
    case "failed": return "Failed";
    case "rejected": return "Rejected";
    default: return s.replace(/_/g, " ");
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ChargeCaptureClient() {
  const orgId = useMemo(() => getOrgId(), []);

  // Batches
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchLoading, setBatchLoading] = useState(true);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchTotals, setBatchTotals] = useState({ totalUnbilledCharges: 0, pendingBatches: 0, readyToSubmit: 0 });
  const [busyBatch, setBusyBatch] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Generate batches
  const [generating, setGenerating] = useState(false);
  const [generateResult, setGenerateResult] = useState<{ batchesCreated: number; claimsQueued: number; message?: string } | null>(null);

  // Charge queue
  const [charges, setCharges] = useState<ChargeRow[]>([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ChargeStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  // CMS-1500 Edit modal
  const [editRow, setEditRow] = useState<ChargeRow | null>(null);
  const [editDetail, setEditDetail] = useState<ChargeDetail | null>(null);
  const [editDetailLoading, setEditDetailLoading] = useState(false);
  const [editDiagnoses, setEditDiagnoses] = useState<string[]>([]);
  const [editPlaceOfService, setEditPlaceOfService] = useState("");
  const [editPriorAuth, setEditPriorAuth] = useState("");
  const [editServiceLines, setEditServiceLines] = useState<EditSL[]>([]);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }

  // ── Loaders ──────────────────────────────────────────────────────────────

  const loadBatches = useCallback(async () => {
    setBatchLoading(true);
    setBatchError(null);
    try {
      const res = await fetch(`/api/billing/charges/batches?organizationId=${encodeURIComponent(orgId)}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load batches");
      setBatches(json.batches ?? []);
      setBatchTotals(json.totals ?? { totalUnbilledCharges: 0, pendingBatches: 0, readyToSubmit: 0 });
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : "Failed to load batches");
    } finally {
      setBatchLoading(false);
    }
  }, [orgId]);

  const loadCharges = useCallback(async () => {
    setQueueLoading(true);
    setQueueError(null);
    try {
      const res = await fetch(`/api/billing/charge-capture?organizationId=${encodeURIComponent(orgId)}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load charges");
      setCharges(json.items ?? []);
    } catch (e) {
      setQueueError(e instanceof Error ? e.message : "Failed to load charges");
    } finally {
      setQueueLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void loadBatches(); void loadCharges(); }, [loadBatches, loadCharges]);

  // ── Generate 837P batches from ready charges ─────────────────────────────

  async function generateBatches() {
    setGenerating(true);
    setGenerateResult(null);
    try {
      const res = await fetch("/api/billing/charges/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgId }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to generate batches");
      setGenerateResult({ batchesCreated: json.batchesCreated ?? 0, claimsQueued: json.claimsQueued ?? 0, message: json.message });
      if ((json.batchesCreated ?? 0) > 0) {
        showToast(`Generated ${json.batchesCreated} batch${json.batchesCreated === 1 ? "" : "es"} covering ${json.claimsQueued} claim${json.claimsQueued === 1 ? "" : "s"}. Download the 837P files below and upload to Availity.`);
      } else {
        showToast(json.message ?? "No new batches were created.");
      }
      await loadBatches();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to generate batches");
    } finally {
      setGenerating(false);
    }
  }

  // ── Batch actions ─────────────────────────────────────────────────────────

  async function batchAction(batchId: string, action: "submit" | "mark-submitted") {    setBusyBatch(batchId);
    try {
      const res = await fetch(`/api/billing/charges/batches/${encodeURIComponent(batchId)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgId }),
      });
      const json = await res.json();
      if (action === "submit" && !json.success) {
        // Submit not yet wired — show informational message, not error
        showToast("Electronic submission not yet active. Download 837 and upload to Availity, then click Mark Submitted.");
      } else if (!res.ok || !json.success) {
        throw new Error(json.error ?? `Failed to ${action}`);
      } else {
        showToast(action === "mark-submitted" ? "Batch marked as submitted." : "Batch submitted.");
      }
      await loadBatches();
    } catch (e) {
      showToast(e instanceof Error ? e.message : `Failed to ${action}`);
    } finally {
      setBusyBatch(null);
    }
  }

  // ── Charge row actions ────────────────────────────────────────────────────

  async function chargeAction(chargeId: string, action: "hold" | "release" | "approve") {
    setActionBusy(chargeId + action);
    try {
      const statusMap: Record<string, string> = {
        hold: "blocked",
        release: "released_to_claims",
        approve: "ready_for_review",
      };
      const res = await fetch(`/api/billing/charge-capture/${encodeURIComponent(chargeId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgId, chargeStatus: statusMap[action] }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? `Failed to ${action}`);
      showToast(
        action === "hold" ? "Charge placed on hold." :
        action === "release" ? "Charge released to billing." :
        "Charge approved."
      );
      await loadCharges();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActionBusy(null);
    }
  }

  // ── Open edit modal (fetch full detail) ─────────────────────────────────

  async function openEditModal(r: ChargeRow) {
    setEditRow(r);
    setEditDetail(null);
    setEditDetailLoading(true);
    setEditError(null);
    try {
      const res = await fetch(
        `/api/billing/charge-capture/${encodeURIComponent(r.id)}?organizationId=${encodeURIComponent(orgId)}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.detail) throw new Error(json.error ?? "Failed to load charge detail");
      const d: ChargeDetail = json.detail;
      setEditDetail(d);
      setEditDiagnoses(d.diagnoses.length > 0 ? d.diagnoses : [""]);
      setEditPlaceOfService(d.placeOfService ?? "");
      setEditPriorAuth(d.serviceLines[0]?.authorizationNumber ?? "");
      const MAX_DX = 12;
      const padded = [...d.diagnoses, ...Array(Math.max(0, MAX_DX - d.diagnoses.length)).fill("")].slice(0, MAX_DX);
      setEditDiagnoses(padded);
      setEditServiceLines(
        d.serviceLines.length > 0
          ? d.serviceLines.map((sl) => ({
              procedureCode: sl.procedureCode,
              serviceDateFrom: sl.serviceDateFrom ?? d.serviceDate ?? "",
              serviceDateTo: sl.serviceDateTo ?? d.serviceDate ?? "",
              modifiers: sl.modifiers.join(", "),
              diagnosisPointers: sl.diagnosisPointers.join(", "),
              units: String(sl.units),
              chargeAmount: String(sl.chargeAmount),
              placeOfService: sl.placeOfService ?? d.placeOfService ?? "",
              renderingProviderNpi: sl.renderingProviderNpi ?? d.provider?.npi ?? "",
              authorizationNumber: sl.authorizationNumber ?? "",
            }))
          : [{
              procedureCode: r.providerSelectedCode ?? r.systemSuggestedCode ?? "",
              serviceDateFrom: d.serviceDate ?? "",
              serviceDateTo: d.serviceDate ?? "",
              modifiers: "",
              diagnosisPointers: "A",
              units: "1",
              chargeAmount: String(d.totalCharge),
              placeOfService: d.placeOfService ?? "",
              renderingProviderNpi: d.provider?.npi ?? "",
              authorizationNumber: "",
            }],
      );
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "Failed to load charge");
    } finally {
      setEditDetailLoading(false);
    }
  }

  // ── Edit save ─────────────────────────────────────────────────────────────

  async function saveEdit() {
    if (!editRow) return;
    setEditSaving(true);
    setEditError(null);
    try {
      const diagnoses = editDiagnoses.map((s) => s.trim().toUpperCase()).filter(Boolean);
      const serviceLines = editServiceLines.map((sl) => ({
        procedureCode: sl.procedureCode.trim(),
        serviceDateFrom: sl.serviceDateFrom.trim() || undefined,
        serviceDateTo: sl.serviceDateTo.trim() || undefined,
        modifiers: sl.modifiers.split(",").map((s) => s.trim()).filter(Boolean),
        diagnosisPointers: sl.diagnosisPointers.split(",").map((s) => s.trim()).filter(Boolean),
        units: Number(sl.units) || 1,
        chargeAmount: parseFloat(sl.chargeAmount) || 0,
        placeOfService: sl.placeOfService.trim() || null,
        renderingProviderNpi: sl.renderingProviderNpi.trim() || null,
        authorizationNumber: sl.authorizationNumber.trim() || null,
      }));
      const body: Record<string, unknown> = {
        organizationId: orgId,
        diagnoses,
        serviceLines,
        placeOfService: editPlaceOfService.trim() || null,
      };
      const res = await fetch(`/api/billing/charge-capture/${encodeURIComponent(editRow.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Save failed");
      showToast("Charge updated.");
      setEditRow(null);
      await loadCharges();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setEditSaving(false);
    }
  }

  // ── Filtered charge queue ─────────────────────────────────────────────────

  const visibleCharges = useMemo(() => {
    return charges.filter((r) => {
      const status = deriveStatus(r);
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (
          !r.client.name.toLowerCase().includes(q) &&
          !r.clinician.toLowerCase().includes(q) &&
          !(r.providerSelectedCode ?? "").toLowerCase().includes(q)
        ) return false;
      }
      return true;
    });
  }, [charges, statusFilter, search]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { "Missing DX": 0, "Unsigned": 0, "Ready": 0, "Hold": 0 };
    for (const r of charges) counts[deriveStatus(r)]++;
    return counts;
  }, [charges]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, padding: "16px 20px", maxWidth: 1400, margin: "0 auto" }}>

      {/* ── Page header ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#0F172A" }}>Charges</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#64748B" }}>
            Release charges, then generate 837P batches by payer / TIN, download, and upload to Availity.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void loadBatches(); void loadCharges(); }}
          style={{ padding: "7px 14px", borderRadius: 6, border: "1px solid #CBD5E1", background: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
        >
          ↺ Refresh
        </button>
      </div>

      {toast ? (
        <div style={{ padding: "10px 14px", borderRadius: 6, background: "#F0FDF4", border: "1px solid #BBF7D0", color: "#166534", fontSize: 13 }}>
          {toast}
        </div>
      ) : null}

      {/* ── Summary metrics ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {[
          { label: "Total Unbilled", value: fmtMoney(batchTotals.totalUnbilledCharges), tone: "#0F172A" },
          { label: "Pending Batches", value: batchTotals.pendingBatches, tone: batchTotals.pendingBatches > 0 ? "#B45309" : "#0F172A" },
          { label: "Ready to Submit", value: batchTotals.readyToSubmit, tone: batchTotals.readyToSubmit > 0 ? "#166534" : "#0F172A" },
        ].map((m) => (
          <div key={m.label} style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 8, padding: "12px 16px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#64748B", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>{m.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: String(m.tone) }}>{m.value}</div>
          </div>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          BATCH PANEL — Manual 837P generation by Payer + TIN
      ══════════════════════════════════════════════════════════════════════ */}
      <section style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 10 }}>
        {/* Panel header with Generate button */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #F1F5F9" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#0F172A" }}>837P Batches</h2>
              {statusCounts["Ready"] > 0 && (
                <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: "#DCFCE7", color: "#166534" }}>
                  {statusCounts["Ready"]} ready
                </span>
              )}
            </div>
            <button
              type="button"
              disabled={generating || statusCounts["Ready"] === 0}
              onClick={() => void generateBatches()}
              style={{
                padding: "8px 16px", borderRadius: 7, border: "none", cursor: generating || statusCounts["Ready"] === 0 ? "not-allowed" : "pointer",
                background: generating || statusCounts["Ready"] === 0 ? "#CBD5E1" : "#1D4ED8",
                color: generating || statusCounts["Ready"] === 0 ? "#94A3B8" : "#fff",
                fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6,
              }}
            >
              {generating ? "Generating…" : "⬡ Generate 837P Batches"}
            </button>
          </div>

          {/* Availity upload workflow steps */}
          <div style={{ marginTop: 12, padding: "10px 14px", background: "#F8FAFC", borderRadius: 8, border: "1px solid #E2E8F0" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6, textTransform: "uppercase", letterSpacing: ".05em" }}>Availity Upload Workflow</div>
            <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 4 }}>
              {[
                { n: 1, text: "Click \"Generate 837P Batches\" to group all ready charges by payer / TIN into downloadable batches." },
                { n: 2, text: "Click \"↓ Download 837\" on each batch to save the X12 EDI file." },
                { n: 3, text: "Log into Availity → Claims → EDI Upload and submit the file. Availity will validate and forward to the payer." },
                { n: 4, text: "Once you confirm the submission in Availity, click \"✓ Mark Submitted\" to update the batch status here." },
              ].map((s) => (
                <li key={s.n} style={{ fontSize: 12, color: "#475569" }}>{s.text}</li>
              ))}
            </ol>
            <a
              href="https://apps.availity.com"
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginTop: 8, display: "inline-block", fontSize: 12, color: "#1D4ED8", fontWeight: 600 }}
            >
              Open Availity Portal →
            </a>
          </div>
        </div>

        {batchError ? (
          <div style={{ padding: 16, color: "#991B1B", fontSize: 13 }}>{batchError}</div>
        ) : batchLoading ? (
          <div style={{ padding: 24, textAlign: "center", color: "#94A3B8", fontSize: 13 }}>Loading batches…</div>
        ) : batches.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "#94A3B8", fontSize: 13 }}>
            {statusCounts["Ready"] > 0
              ? `${statusCounts["Ready"]} charge${statusCounts["Ready"] === 1 ? "" : "s"} ready to batch — click "Generate 837P Batches" above.`
              : "No batches yet. Release charges first, then click \"Generate 837P Batches\" to create downloadable 837P files."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #F1F5F9" }}>
                  {["Batch #", "Payer", "TIN", "Claims", "Total Charge", "Status", "Submitted", "Actions"].map((h) => (
                    <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontWeight: 700, color: "#475569", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => {
                  const ss = batchStatusStyle(b.status);
                  const isBusy = busyBatch === b.id;
                  const downloadUrl = `/api/billing/charges/batches/${encodeURIComponent(b.id)}/download?organizationId=${encodeURIComponent(orgId)}`;
                  const isSubmitted = ["submitted", "accepted"].includes(b.status.toLowerCase());
                  return (
                    <tr key={b.id} style={{ borderBottom: "1px solid #F8FAFC" }}>
                      <td style={{ padding: "10px 12px", fontWeight: 700, color: "#0F172A", whiteSpace: "nowrap" }}>{b.batchNumber}</td>
                      <td style={{ padding: "10px 12px", color: "#334155" }}>{b.payerName}</td>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace", color: "#475569" }}>{b.billingProviderTaxId || "—"}</td>
                      <td style={{ padding: "10px 12px", textAlign: "center", fontWeight: 600 }}>{b.claimCount}</td>
                      <td style={{ padding: "10px 12px", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{fmtMoney(b.totalChargeAmount)}</td>
                      <td style={{ padding: "10px 12px" }}>
                        <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: ss.bg, color: ss.color }}>
                          {batchStatusLabel(b.status)}
                        </span>
                      </td>
                      <td style={{ padding: "10px 12px", color: "#64748B", whiteSpace: "nowrap" }}>{b.submittedAt ? fmtDate(b.submittedAt) : "—"}</td>
                      <td style={{ padding: "10px 12px" }}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {/* Download 837 */}
                          <a
                            href={downloadUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ padding: "4px 10px", borderRadius: 5, border: "1px solid #CBD5E1", background: "#F8FAFC", color: "#334155", fontSize: 12, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}
                          >
                            ↓ Download 837
                          </a>

                          {/* Submit Batch */}
                          {!isSubmitted ? (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void batchAction(b.id, "submit")}
                              style={{ padding: "4px 10px", borderRadius: 5, border: "1px solid #BFDBFE", background: "#EFF6FF", color: "#1D4ED8", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
                            >
                              {isBusy ? "…" : "Submit Batch"}
                            </button>
                          ) : null}

                          {/* Mark as Submitted */}
                          {!isSubmitted ? (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void batchAction(b.id, "mark-submitted")}
                              style={{ padding: "4px 10px", borderRadius: 5, border: "none", background: "#0F2D63", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
                            >
                              {isBusy ? "…" : "✓ Mark Submitted"}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ══════════════════════════════════════════════════════════════════════
          CHARGE QUEUE — Dense operational view
      ══════════════════════════════════════════════════════════════════════ */}
      <section style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 10 }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #F1F5F9" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#0F172A" }}>
              Charge Queue
              {!queueLoading && <span style={{ marginLeft: 8, fontSize: 13, fontWeight: 400, color: "#94A3B8" }}>{visibleCharges.length} of {charges.length}</span>}
            </h2>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {/* Status filter chips */}
              {(["all", "Missing DX", "Unsigned", "Ready", "Hold"] as const).map((s) => {
                const isActive = statusFilter === s;
                const count = s === "all" ? charges.length : statusCounts[s] ?? 0;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatusFilter(s)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      border: "1px solid",
                      borderColor: isActive ? "#0F2D63" : "#E2E8F0",
                      background: isActive ? "#0F2D63" : "#fff",
                      color: isActive ? "#fff" : "#475569",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {s === "all" ? "All" : s} <span style={{ opacity: .7 }}>{count}</span>
                  </button>
                );
              })}
              {/* Search */}
              <input
                type="search"
                placeholder="Patient, clinician, CPT…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 13, width: 200 }}
              />
            </div>
          </div>
        </div>

        {queueError ? (
          <div style={{ padding: 16, color: "#991B1B", fontSize: 13 }}>{queueError}</div>
        ) : queueLoading ? (
          <div style={{ padding: 24, textAlign: "center", color: "#94A3B8", fontSize: 13 }}>Loading charges…</div>
        ) : visibleCharges.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "#94A3B8", fontSize: 14 }}>
            {charges.length === 0 ? "No charges pending. Charges appear here when clinicians sign notes." : "No charges match this filter."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #F1F5F9" }}>
                  {["Patient", "DOS", "CPT", "Provider", "Status", "Actions"].map((h) => (
                    <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontWeight: 700, color: "#475569", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleCharges.map((r) => {
                  const status = deriveStatus(r);
                  const ss = STATUS_STYLE[status];
                  const cpt = r.providerSelectedCode ?? r.systemSuggestedCode ?? "—";
                  const encounterId = r.encounter.id;
                  const isReleased = r.tab === "released_to_claims";
                  return (
                    <tr key={r.id} style={{ borderBottom: "1px solid #F8FAFC" }}>
                      {/* Patient */}
                      <td style={{ padding: "9px 12px" }}>
                        <span style={{ fontWeight: 600, color: "#0F172A" }}>{r.client.name}</span>
                        {r.client.dob ? (
                          <span style={{ display: "block", fontSize: 11, color: "#94A3B8" }}>DOB {fmtDate(r.client.dob)}</span>
                        ) : null}
                      </td>

                      {/* DOS */}
                      <td style={{ padding: "9px 12px", color: "#334155", whiteSpace: "nowrap" }}>{fmtDate(r.dateOfService)}</td>

                      {/* CPT */}
                      <td style={{ padding: "9px 12px", fontFamily: "ui-monospace, monospace", fontWeight: 600, color: "#0F172A" }}>{cpt}</td>

                      {/* Provider */}
                      <td style={{ padding: "9px 12px", color: "#334155" }}>{r.clinician}</td>

                      {/* Status */}
                      <td style={{ padding: "9px 12px" }}>
                        <span style={{ display: "inline-block", padding: "3px 9px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: ss.bg, color: ss.color, whiteSpace: "nowrap" }}>
                          {status}
                        </span>
                      </td>

                      {/* Actions */}
                      <td style={{ padding: "9px 12px" }}>
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>

                          {/* Edit charge */}
                          {!isReleased ? (
                            <button
                              type="button"
                              onClick={() => void openEditModal(r)}
                              style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid #E2E8F0", background: "#fff", color: "#334155", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}
                            >
                              Edit
                            </button>
                          ) : null}

                          {/* Attach diagnosis */}
                          {(status === "Missing DX" || status === "Unsigned") ? (
                            <button
                              type="button"
                              onClick={() => void openEditModal(r)}
                              style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid #FCA5A5", background: "#FEF2F2", color: "#991B1B", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}
                            >
                              Attach DX
                            </button>
                          ) : null}

                          {/* Review authorization */}
                          {r.authorization?.status === "required" || r.tab === "eligibility_auth_issue" ? (
                            <a
                              href={encounterId ? `/encounters/${encounterId}` : `/clients/${r.client.id}`}
                              style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid #BFDBFE", background: "#EFF6FF", color: "#1D4ED8", fontSize: 11, textDecoration: "none", whiteSpace: "nowrap" }}
                            >
                              Auth
                            </a>
                          ) : null}

                          {/* Release to billing */}
                          {status === "Ready" && !isReleased ? (
                            <button
                              type="button"
                              disabled={actionBusy === r.id + "release"}
                              onClick={() => void chargeAction(r.id, "release")}
                              style={{ padding: "3px 8px", borderRadius: 4, border: "none", background: "#0F2D63", color: "#fff", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}
                            >
                              {actionBusy === r.id + "release" ? "…" : "Release"}
                            </button>
                          ) : null}

                          {/* Hold */}
                          {status !== "Hold" && !isReleased ? (
                            <button
                              type="button"
                              disabled={actionBusy === r.id + "hold"}
                              onClick={() => void chargeAction(r.id, "hold")}
                              style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid #FED7AA", background: "#FFF7ED", color: "#C2410C", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}
                            >
                              {actionBusy === r.id + "hold" ? "…" : "Hold"}
                            </button>
                          ) : null}

                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── CMS-1500 Edit Modal ── */}
      {editRow ? (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.52)", zIndex: 9000, display: "flex", alignItems: "flex-start", justifyContent: "center", overflowY: "auto", padding: "24px 16px" }}
          onClick={() => setEditRow(null)}
        >
          <div
            style={{ background: "#fff", borderRadius: 10, width: "100%", maxWidth: 900, boxShadow: "0 12px 60px rgba(0,0,0,.22)", marginBottom: 24 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div style={{ background: "#0F2D63", color: "#fff", padding: "12px 20px", borderRadius: "10px 10px 0 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase" }}>CMS-1500 Health Insurance Claim Form</div>
                <div style={{ fontSize: 11, opacity: .7, marginTop: 2 }}>{editRow.client.name} · {editRow.payer?.name ?? "Unknown Payer"}</div>
              </div>
              <button type="button" onClick={() => setEditRow(null)} style={{ background: "none", border: "none", color: "#fff", fontSize: 24, cursor: "pointer", lineHeight: 1 }}>×</button>
            </div>

            {editDetailLoading ? (
              <div style={{ padding: 40, textAlign: "center", color: "#94A3B8", fontSize: 14 }}>Loading charge details…</div>
            ) : editError && !editDetail ? (
              <div style={{ padding: 24, color: "#991B1B", fontSize: 13 }}>{editError}</div>
            ) : editDetail ? (
              <div style={{ padding: "20px 24px 0" }}>

                {editError ? (
                  <div style={{ padding: "9px 12px", background: "#FEF2F2", color: "#991B1B", borderRadius: 6, marginBottom: 14, fontSize: 13 }}>{editError}</div>
                ) : null}

                {/* ── Section A: Patient & Insured Info ── */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                  <FieldBox label="2. Patient's Name">
                    <ReadonlyVal>{editDetail.client?.displayName ?? "—"}</ReadonlyVal>
                  </FieldBox>
                  <FieldBox label="3. Patient's Date of Birth">
                    <ReadonlyVal>{editDetail.client?.dateOfBirth ? fmtDate(editDetail.client.dateOfBirth) : "—"}</ReadonlyVal>
                  </FieldBox>
                  <FieldBox label="1a. Insured's ID # / Member ID">
                    <ReadonlyVal>{editDetail.policy?.subscriberId ?? editDetail.policy?.policyNumber ?? "—"}</ReadonlyVal>
                  </FieldBox>
                  <FieldBox label="4. Insured's Name">
                    <ReadonlyVal>{editDetail.client?.displayName ?? "—"}</ReadonlyVal>
                  </FieldBox>
                  <FieldBox label="11. Insured's Policy / Group #">
                    <ReadonlyVal>{editDetail.policy?.policyNumber ?? "—"}</ReadonlyVal>
                  </FieldBox>
                  <FieldBox label="5. Insurance Plan / Program Name">
                    <ReadonlyVal>{editDetail.payer?.name ?? "—"}{editDetail.policy?.planName ? ` — ${editDetail.policy.planName}` : ""}</ReadonlyVal>
                  </FieldBox>
                </div>

                {/* ── Section B: Physician / Supplier ── */}
                <SectionHeader>Physician / Supplier Information</SectionHeader>

                {/* Box 21 — Diagnoses */}
                <FieldBox label="21. Diagnosis Codes (ICD-10-CM)" fullWidth>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {(editDiagnoses.length > 0 ? editDiagnoses : Array(4).fill("")).map((code, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", width: 14, textAlign: "right" }}>{String.fromCharCode(65 + i)}.</span>
                        <input
                          type="text"
                          value={code}
                          onChange={(e) => {
                            const next = [...editDiagnoses];
                            next[i] = e.target.value.toUpperCase();
                            setEditDiagnoses(next);
                          }}
                          placeholder="ICD-10"
                          style={{ width: 86, padding: "4px 6px", border: "1px solid #CBD5E1", borderRadius: 4, fontSize: 12, textTransform: "uppercase" }}
                        />
                      </div>
                    ))}
                  </div>
                </FieldBox>

                {/* Box 23 — Prior Auth */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 10 }}>
                  <FieldBox label="23. Prior Authorization #">
                    <input
                      type="text"
                      value={editPriorAuth}
                      onChange={(e) => setEditPriorAuth(e.target.value)}
                      placeholder="Authorization number…"
                      style={{ width: "100%", padding: "5px 8px", border: "1px solid #CBD5E1", borderRadius: 4, fontSize: 13 }}
                    />
                  </FieldBox>
                  <FieldBox label="24B. Default Place of Service">
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        type="text"
                        value={editPlaceOfService}
                        onChange={(e) => setEditPlaceOfService(e.target.value)}
                        placeholder="11"
                        style={{ width: 60, padding: "5px 8px", border: "1px solid #CBD5E1", borderRadius: 4, fontSize: 13 }}
                      />
                      <span style={{ fontSize: 11, color: "#94A3B8" }}>11=Office · 02=Telehealth · 21=Inpatient</span>
                    </div>
                  </FieldBox>
                  <FieldBox label="33. Rendering Provider NPI">
                    <ReadonlyVal>{editDetail.provider?.npi ?? "—"}</ReadonlyVal>
                  </FieldBox>
                  <FieldBox label="31. Signature of Physician">
                    <ReadonlyVal>{editDetail.provider?.displayName ?? "—"}{editDetail.provider?.credential ? `, ${editDetail.provider.credential}` : ""}</ReadonlyVal>
                  </FieldBox>
                </div>

                {/* ── Section C: Service Lines (Box 24) ── */}
                <SectionHeader style={{ marginTop: 16 }}>Box 24 — Service Line Items</SectionHeader>
                <div style={{ overflowX: "auto", marginBottom: 8 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "#F1F5F9" }}>
                        {["#", "24A DOS From", "24A DOS To", "24B POS", "24D CPT / Procedure", "24D Modifiers", "24E Dx Ptr", "24G Units", "24F Charge ($)", "24J Rendering NPI", "Auth #"].map((h) => (
                          <th key={h} style={{ padding: "6px 7px", textAlign: "left", fontWeight: 700, color: "#475569", fontSize: 11, whiteSpace: "nowrap", border: "1px solid #E2E8F0" }}>{h}</th>
                        ))}
                        <th style={{ padding: "6px 7px", border: "1px solid #E2E8F0" }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {editServiceLines.map((sl, idx) => (
                        <tr key={idx} style={{ borderBottom: "1px solid #F1F5F9" }}>
                          <td style={{ padding: "5px 7px", border: "1px solid #E2E8F0", fontWeight: 700, color: "#94A3B8", textAlign: "center" }}>{idx + 1}</td>
                          <td style={{ padding: 4, border: "1px solid #E2E8F0" }}><input type="date" value={sl.serviceDateFrom} onChange={(e) => { const n=[...editServiceLines]; n[idx]={...n[idx], serviceDateFrom:e.target.value}; setEditServiceLines(n); }} style={slInputStyle(120)} /></td>
                          <td style={{ padding: 4, border: "1px solid #E2E8F0" }}><input type="date" value={sl.serviceDateTo} onChange={(e) => { const n=[...editServiceLines]; n[idx]={...n[idx], serviceDateTo:e.target.value}; setEditServiceLines(n); }} style={slInputStyle(120)} /></td>
                          <td style={{ padding: 4, border: "1px solid #E2E8F0" }}><input type="text" value={sl.placeOfService} onChange={(e) => { const n=[...editServiceLines]; n[idx]={...n[idx], placeOfService:e.target.value}; setEditServiceLines(n); }} placeholder="11" style={slInputStyle(44)} /></td>
                          <td style={{ padding: 4, border: "1px solid #E2E8F0" }}><input type="text" value={sl.procedureCode} onChange={(e) => { const n=[...editServiceLines]; n[idx]={...n[idx], procedureCode:e.target.value.toUpperCase()}; setEditServiceLines(n); }} placeholder="90837" style={slInputStyle(72)} /></td>
                          <td style={{ padding: 4, border: "1px solid #E2E8F0" }}><input type="text" value={sl.modifiers} onChange={(e) => { const n=[...editServiceLines]; n[idx]={...n[idx], modifiers:e.target.value}; setEditServiceLines(n); }} placeholder="GT, 95" style={slInputStyle(80)} /></td>
                          <td style={{ padding: 4, border: "1px solid #E2E8F0" }}><input type="text" value={sl.diagnosisPointers} onChange={(e) => { const n=[...editServiceLines]; n[idx]={...n[idx], diagnosisPointers:e.target.value}; setEditServiceLines(n); }} placeholder="A, B" style={slInputStyle(60)} /></td>
                          <td style={{ padding: 4, border: "1px solid #E2E8F0" }}><input type="number" min="1" value={sl.units} onChange={(e) => { const n=[...editServiceLines]; n[idx]={...n[idx], units:e.target.value}; setEditServiceLines(n); }} style={slInputStyle(50)} /></td>
                          <td style={{ padding: 4, border: "1px solid #E2E8F0" }}><input type="number" min="0" step="0.01" value={sl.chargeAmount} onChange={(e) => { const n=[...editServiceLines]; n[idx]={...n[idx], chargeAmount:e.target.value}; setEditServiceLines(n); }} style={slInputStyle(88)} /></td>
                          <td style={{ padding: 4, border: "1px solid #E2E8F0" }}><input type="text" value={sl.renderingProviderNpi} onChange={(e) => { const n=[...editServiceLines]; n[idx]={...n[idx], renderingProviderNpi:e.target.value}; setEditServiceLines(n); }} placeholder="NPI" style={slInputStyle(100)} /></td>
                          <td style={{ padding: 4, border: "1px solid #E2E8F0" }}><input type="text" value={sl.authorizationNumber} onChange={(e) => { const n=[...editServiceLines]; n[idx]={...n[idx], authorizationNumber:e.target.value}; setEditServiceLines(n); }} placeholder="Auth #" style={slInputStyle(90)} /></td>
                          <td style={{ padding: 4, border: "1px solid #E2E8F0", textAlign: "center" }}>
                            <button type="button" onClick={() => setEditServiceLines((s) => s.filter((_, i) => i !== idx))} style={{ background: "none", border: "none", color: "#EF4444", cursor: "pointer", fontSize: 16, lineHeight: 1 }} title="Remove line">×</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button
                  type="button"
                  onClick={() => setEditServiceLines((s) => [...s, {
                    procedureCode: "", serviceDateFrom: editDetail.serviceDate ?? "", serviceDateTo: editDetail.serviceDate ?? "",
                    modifiers: "", diagnosisPointers: "A", units: "1", chargeAmount: "0",
                    placeOfService: editPlaceOfService, renderingProviderNpi: editDetail.provider?.npi ?? "", authorizationNumber: editPriorAuth,
                  }])}
                  style={{ padding: "5px 12px", borderRadius: 5, border: "1px dashed #CBD5E1", background: "#F8FAFC", color: "#475569", fontSize: 12, cursor: "pointer", marginBottom: 16 }}
                >
                  + Add Service Line
                </button>

                {/* ── Totals row ── */}
                <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#475569", borderTop: "1px solid #E2E8F0", paddingTop: 10, marginBottom: 18 }}>
                  <span><strong style={{ color: "#0F172A" }}>28. Total Charge:</strong> {fmtMoney(editServiceLines.reduce((sum, sl) => sum + (parseFloat(sl.chargeAmount) || 0), 0))}</span>
                  <span><strong style={{ color: "#0F172A" }}>Lines:</strong> {editServiceLines.length}</span>
                </div>

                {/* ── Action footer ── */}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "14px 0 20px", borderTop: "1px solid #F1F5F9" }}>
                  <button
                    type="button"
                    onClick={() => setEditRow(null)}
                    style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid #CBD5E1", background: "#fff", fontWeight: 600, fontSize: 14, cursor: "pointer" }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={editSaving}
                    onClick={() => void saveEdit()}
                    style={{ padding: "8px 22px", borderRadius: 6, border: "none", background: "#0F2D63", color: "#fff", fontWeight: 700, fontSize: 14, cursor: editSaving ? "not-allowed" : "pointer" }}
                  >
                    {editSaving ? "Saving…" : "Save Charge"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

    </div>
  );
}

// ── Small presentational helpers ────────────────────────────────────────────

function SectionHeader({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ padding: "6px 10px", background: "#F1F5F9", borderRadius: 4, fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10, ...style }}>
      {children}
    </div>
  );
}

function FieldBox({ label, children, fullWidth }: { label: string; children: React.ReactNode; fullWidth?: boolean }) {
  return (
    <div style={{ gridColumn: fullWidth ? "1 / -1" : undefined }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>{label}</div>
      <div style={{ padding: "7px 10px", border: "1px solid #E2E8F0", borderRadius: 5, background: "#FAFBFC", minHeight: 34 }}>{children}</div>
    </div>
  );
}

function ReadonlyVal({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 13, color: children ? "#0F172A" : "#94A3B8" }}>{children || "—"}</span>;
}
