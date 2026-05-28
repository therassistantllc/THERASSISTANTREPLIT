"use client";

import React, { useCallback, useRef, useState } from "react";
import Link from "next/link";
import type { PreviewResponse, PreviewRow } from "@/app/api/payments/parse-835-preview/route";

type PreviewErrorResponse = { ok: false; error?: string };

/* ─────────────────────────────────────────────────────────────────────────
   Types
───────────────────────────────────────────────────────────────────────── */
type Phase = "upload" | "parsing" | "review" | "posting" | "posted" | "error";

interface WorksheetRow extends PreviewRow {
  // All PreviewRow fields; user can edit these:
  patientName: string;
  dateOfService: string;
  providerName: string;
  cptCode: string;
  chargeAmount: number;
  allowedAmount: number;
  adjustmentAmount: number;
  carcRarc: string;
  patientResponsibility: number;
  amountPaid: number;
}

interface EraHeader {
  organizationName: string;
  payerName: string;
  eraDate: string;
  paymentNumber: string;
  totalPaid: number;
  totalAdjustment: number;
  totalPatientResponsibility: number;
}

/* ─────────────────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────────────────── */
function fmt(v: number) {
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "";
  // Handles YYYYMMDD (835) and ISO dates
  const clean = iso.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const d = new Date(clean);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit", year: "numeric" });
}

function orgId() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_ORGANIZATION_ID ?? "";
  return (
    new URLSearchParams(window.location.search).get("organizationId") ??
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ??
    ""
  );
}

type BalanceState = "balanced" | "close" | "out";

function balanceStatus(
  rows: WorksheetRow[],
  header: EraHeader,
): { state: BalanceState; paidDiff: number; prDiff: number } {
  const sumPaid = rows.reduce((s, r) => s + r.amountPaid, 0);
  const sumPR = rows.reduce((s, r) => s + r.patientResponsibility, 0);
  const paidDiff = Math.abs(sumPaid - header.totalPaid);
  const prDiff = Math.abs(sumPR - header.totalPatientResponsibility);
  const maxDiff = Math.max(paidDiff, prDiff);
  if (maxDiff < 0.01) return { state: "balanced", paidDiff, prDiff };
  if (maxDiff < 1.0) return { state: "close", paidDiff, prDiff };
  return { state: "out", paidDiff, prDiff };
}

/* ─────────────────────────────────────────────────────────────────────────
   AddPatientModal
───────────────────────────────────────────────────────────────────────── */
interface AddPatientModalProps {
  rowId: string;
  firstName: string | null;
  lastName: string | null;
  memberId: string | null;
  payerName: string | null;
  onClose: () => void;
  onCreated: (rowId: string, patientId: string, patientName: string) => void;
}

function AddPatientModal({ rowId, firstName, lastName, memberId, payerName, onClose, onCreated }: AddPatientModalProps) {
  const [firstNameInput, setFirstNameInput] = useState(firstName ?? "");
  const [lastNameInput, setLastNameInput] = useState(lastName ?? "");
  const [dob, setDob] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: orgId(),
          firstName: firstNameInput,
          lastName: lastNameInput,
          dateOfBirth: dob,
          phone,
          email: email || undefined,
          sexAtBirth: "unknown",
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to create client");
      onCreated(rowId, json.id ?? json.clientId ?? json.client?.id, `${firstNameInput} ${lastNameInput}`.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(10,24,40,0.45)" }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        style={{ border: "1px solid var(--line)" }}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: "var(--line)" }}>
          <h2 className="text-base font-semibold" style={{ color: "var(--navy)" }}>
            Add Client to System
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            This client was not found in the system. Client information from the ERA has been pre-filled below.
          </p>

          {memberId && (
            <div className="px-3 py-2 rounded-lg text-xs" style={{ background: "var(--sage-soft)", color: "var(--sage)" }}>
              <strong>Member ID:</strong> {memberId}
              {payerName && <span className="ml-2">· <strong>Insurance:</strong> {payerName}</span>}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>First Name *</span>
              <input
                className="mt-1 w-full px-3 py-2 rounded-lg text-sm border"
                style={{ borderColor: "var(--line)", color: "var(--text)" }}
                value={firstNameInput}
                onChange={(e) => setFirstNameInput(e.target.value)}
                required
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>Last Name *</span>
              <input
                className="mt-1 w-full px-3 py-2 rounded-lg text-sm border"
                style={{ borderColor: "var(--line)", color: "var(--text)" }}
                value={lastNameInput}
                onChange={(e) => setLastNameInput(e.target.value)}
                required
              />
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>
              Date of Birth (YYYY-MM-DD) {dob ? "*" : "(optional - add from your EHR)"}
            </span>
            <input
              type="date"
              className="mt-1 w-full px-3 py-2 rounded-lg text-sm border"
              style={{ borderColor: "var(--line)", color: "var(--text)" }}
              value={dob}
              onChange={(e) => setDob(e.target.value)}
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>Phone *</span>
            <input
              type="tel"
              className="mt-1 w-full px-3 py-2 rounded-lg text-sm border"
              style={{ borderColor: "var(--line)", color: "var(--text)" }}
              placeholder="555-555-5555"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>Email (optional)</span>
            <input
              type="email"
              className="mt-1 w-full px-3 py-2 rounded-lg text-sm border"
              style={{ borderColor: "var(--line)", color: "var(--text)" }}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          {error && (
            <p className="text-xs font-medium" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 rounded-lg text-sm border font-medium"
              style={{ borderColor: "var(--line)", color: "var(--muted)" }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold text-white"
              style={{ background: saving ? "var(--sage-mid)" : "var(--navy)", cursor: saving ? "not-allowed" : "pointer" }}
            >
              {saving ? "Adding…" : "Add Client"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   NumberCell — inline-editable number cell
───────────────────────────────────────────────────────────────────────── */
function NumberCell({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState("");

  if (editing) {
    return (
      <input
        autoFocus
        className="w-full px-1 py-0.5 rounded border text-right text-xs"
        style={{ borderColor: "var(--line)", color: "var(--text)" }}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => {
          const n = parseFloat(raw.replace(/[^0-9.-]/g, ""));
          if (!Number.isNaN(n)) onChange(n);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Tab") {
            const n = parseFloat(raw.replace(/[^0-9.-]/g, ""));
            if (!Number.isNaN(n)) onChange(n);
            setEditing(false);
          }
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  return (
    <button
      className="w-full text-right text-xs px-1 py-0.5 rounded hover:bg-slate-50 transition-colors"
      style={{ color: "var(--text)" }}
      onClick={() => { setRaw(value.toFixed(2)); setEditing(true); }}
    >
      {fmt(value)}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   TextCell — inline-editable text cell
───────────────────────────────────────────────────────────────────────── */
function TextCell({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState("");

  if (editing) {
    return (
      <input
        autoFocus
        className="w-full px-1 py-0.5 rounded border text-xs"
        style={{ borderColor: "var(--line)", color: "var(--text)" }}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => { onChange(raw); setEditing(false); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Tab") { onChange(raw); setEditing(false); }
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  return (
    <button
      className="w-full text-left text-xs px-1 py-0.5 rounded hover:bg-slate-50 transition-colors truncate"
      style={{ color: value ? "var(--text)" : "var(--muted)" }}
      onClick={() => { setRaw(value); setEditing(true); }}
      title={value}
    >
      {value || <span className="italic">—</span>}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Main component
───────────────────────────────────────────────────────────────────────── */
export default function EraWorksheetClient() {
  const [phase, setPhase] = useState<Phase>("upload");
  const [dragging, setDragging] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [header, setHeader] = useState<EraHeader | null>(null);
  const [rows, setRows] = useState<WorksheetRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const [postedBatchId, setPostedBatchId] = useState<string | null>(null);
  const [addPatientRowId, setAddPatientRowId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ── Parse 835 via preview API ──────────────────────────────────── */
  async function parseFile(file: File) {
    setPhase("parsing");
    setParseError(null);
    setUploadedFile(file);

    const fd = new FormData();
    fd.append("file", file);
    fd.append("organizationId", orgId());

    try {
      const res = await fetch("/api/payments/parse-835-preview", { method: "POST", body: fd });
      const json = (await res.json()) as PreviewResponse | PreviewErrorResponse;

      if (!res.ok || !json.ok) {
        throw new Error(("error" in json ? json.error : undefined) ?? "Parse failed");
      }

      setHeader({
        organizationName: json.header.organizationName ?? "",
        payerName: json.header.payerName ?? "",
        eraDate: json.header.eraDate ?? "",
        paymentNumber: json.header.paymentNumber ?? "",
        totalPaid: json.header.totalPaid,
        totalAdjustment: json.header.totalAdjustment,
        totalPatientResponsibility: json.header.totalPatientResponsibility,
      });

      setRows(
        json.rows.map((r) => ({
          ...r,
          patientName: r.patientName ?? "",
          dateOfService: r.dateOfService ?? "",
          providerName: r.providerName ?? "",
          cptCode: r.cptCode ?? "",
          carcRarc: r.carcRarc ?? "",
        })),
      );

      setPhase("review");
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Unknown parse error");
      setPhase("error");
    }
  }

  /* ── Drag/drop handling ─────────────────────────────────────────── */
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) parseFile(file);
    },
    [],
  );

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) parseFile(file);
    e.target.value = "";
  };

  /* ── Row editing helpers ────────────────────────────────────────── */
  function updateRow<K extends keyof WorksheetRow>(rowId: string, key: K, val: WorksheetRow[K]) {
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, [key]: val } : r)));
  }

  /* ── Add Client callback ───────────────────────────────────────── */
  function handlePatientCreated(rowId: string, patientId: string, patientName: string) {
    // Update ALL rows with the same client name (normalize for comparison)
    const normalizedName = patientName.trim().toLowerCase();
    setRows((prev) =>
      prev.map((r) => {
        const rowNormalized = (r.patientName ?? "").trim().toLowerCase();
        return rowNormalized === normalizedName
          ? { ...r, patientId, patientName, patientFound: true }
          : r;
      }),
    );
    setAddPatientRowId(null);
  }

  /* ── Post payment ───────────────────────────────────────────────── */
  async function handlePost() {
    if (!uploadedFile) return;
    setPhase("posting");
    setPostError(null);

    const fd = new FormData();
    fd.append("file", uploadedFile);
    fd.append("organizationId", orgId());

    try {
      const res = await fetch("/api/payments/import-835", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Post failed");
      setPostedBatchId(json.batchId ?? null);
      setPhase("posted");
    } catch (err) {
      setPostError(err instanceof Error ? err.message : "Unknown error");
      setPhase("review");
    }
  }

  /* ── Balance status ─────────────────────────────────────────────── */
  const balance = header ? balanceStatus(rows, header) : null;

  /* ─────────────────────────────────────────────────────────────────
     RENDER — upload
  ───────────────────────────────────────────────────────────────── */
  if (phase === "upload") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[480px] p-8">
        <div
          className="w-full max-w-xl rounded-2xl border-2 border-dashed transition-colors p-12 text-center cursor-pointer"
          style={{
            borderColor: dragging ? "var(--navy)" : "var(--line)",
            background: dragging ? "var(--sage-soft)" : "var(--card)",
          }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="flex flex-col items-center gap-4">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center text-3xl"
              style={{ background: "var(--sage-soft)" }}
            >
              📂
            </div>
            <div>
              <p className="text-lg font-semibold" style={{ color: "var(--navy)" }}>
                Drop your 835 ERA file here
              </p>
              <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
                or click to browse — accepts .835, .txt, .edi files
              </p>
            </div>
            <button
              type="button"
              className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white shadow-sm"
              style={{ background: "var(--navy)" }}
              onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
            >
              Select File
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".835,.txt,.edi,.x12"
            className="hidden"
            onChange={handleFileInput}
          />
        </div>
      </div>
    );
  }

  /* ─────────────────────────────────────────────────────────────────
     RENDER — parsing
  ───────────────────────────────────────────────────────────────── */
  if (phase === "parsing") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[480px] gap-4">
        <div
          className="w-12 h-12 rounded-full border-4 border-t-transparent animate-spin"
          style={{ borderColor: "var(--sage-mid)", borderTopColor: "transparent" }}
        />
        <p className="text-sm font-medium" style={{ color: "var(--muted)" }}>
          Parsing 835 file…
        </p>
      </div>
    );
  }

  /* ─────────────────────────────────────────────────────────────────
     RENDER — error
  ───────────────────────────────────────────────────────────────── */
  if (phase === "error") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[480px] gap-4 p-8">
        <div className="text-4xl">⚠️</div>
        <p className="text-base font-semibold" style={{ color: "var(--danger)" }}>
          Could not parse this file
        </p>
        <p className="text-sm text-center max-w-md" style={{ color: "var(--muted)" }}>
          {parseError ?? "Unknown error"}
        </p>
        <button
          type="button"
          className="px-5 py-2 rounded-xl text-sm font-semibold text-white mt-2"
          style={{ background: "var(--navy)" }}
          onClick={() => setPhase("upload")}
        >
          Try Another File
        </button>
      </div>
    );
  }

  /* ─────────────────────────────────────────────────────────────────
     RENDER — posting
  ───────────────────────────────────────────────────────────────── */
  if (phase === "posting") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[480px] gap-4">
        <div
          className="w-12 h-12 rounded-full border-4 border-t-transparent animate-spin"
          style={{ borderColor: "var(--sage-mid)", borderTopColor: "transparent" }}
        />
        <p className="text-sm font-medium" style={{ color: "var(--muted)" }}>
          Posting payment…
        </p>
      </div>
    );
  }

  /* ─────────────────────────────────────────────────────────────────
     RENDER — posted (success)
  ───────────────────────────────────────────────────────────────── */
  if (phase === "posted") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[480px] gap-5 p-8">
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center text-3xl"
          style={{ background: "var(--sage-soft)" }}
        >
          ✅
        </div>
        <div className="text-center">
          <p className="text-lg font-semibold" style={{ color: "var(--navy)" }}>
            Payment Posted Successfully
          </p>
          {postedBatchId && (
            <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
              Batch ID: <span className="font-mono">{postedBatchId}</span>
            </p>
          )}
          <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
            Transactions have been added to the clients&apos; ledgers.
          </p>
        </div>
        <div className="flex gap-3">
          <Link
            href="/billing/era-import"
            className="px-5 py-2 rounded-xl text-sm font-semibold border"
            style={{ borderColor: "var(--line)", color: "var(--navy)" }}
          >
            View ERA Queue
          </Link>
          <button
            type="button"
            className="px-5 py-2 rounded-xl text-sm font-semibold text-white"
            style={{ background: "var(--navy)" }}
            onClick={() => {
              setPhase("upload");
              setHeader(null);
              setRows([]);
              setUploadedFile(null);
              setPostedBatchId(null);
            }}
          >
            Import Another ERA
          </button>
        </div>
      </div>
    );
  }

  /* ─────────────────────────────────────────────────────────────────
     RENDER — review (main worksheet)
  ───────────────────────────────────────────────────────────────── */
  const unmatchedRows = rows.filter((r) => !r.patientFound);
  const balanceGood = balance?.state === "balanced";
  const balanceClose = balance?.state === "close";

  return (
    <div className="flex flex-col min-h-0">
      {/* Add Client Modal */}
      {addPatientRowId !== null && (() => {
        const row = rows.find((r) => r.rowId === addPatientRowId);
        return (
          <AddPatientModal
            rowId={addPatientRowId}
            firstName={row?.patientFirstName ?? null}
            lastName={row?.patientLastName ?? null}
            memberId={row?.patientMemberId ?? null}
            payerName={row?.payerName ?? null}
            onClose={() => setAddPatientRowId(null)}
            onCreated={handlePatientCreated}
          />
        );
      })()}

      {/* ── Header / Toolbar ─────────────────────────────────────── */}
      <div className="flex items-center justify-between px-6 py-3 border-b" style={{ borderColor: "var(--line)", background: "var(--card)" }}>
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold" style={{ color: "var(--navy)" }}>
            ERA Import Worksheet
          </h1>
          {uploadedFile && (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: "var(--sage-soft)", color: "var(--sage)" }}
            >
              {uploadedFile.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="px-3 py-1.5 rounded-lg text-xs font-medium border"
            style={{ borderColor: "var(--line)", color: "var(--muted)" }}
            onClick={() => setPhase("upload")}
          >
            ← Upload Different File
          </button>
          <button
            type="button"
            disabled={!balanceGood && !balanceClose}
            onClick={handlePost}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white shadow-sm transition-opacity"
            style={{
              background: "var(--navy)",
              opacity: !balanceGood && !balanceClose ? 0.4 : 1,
              cursor: !balanceGood && !balanceClose ? "not-allowed" : "pointer",
            }}
            title={!balanceGood && !balanceClose ? "Resolve balance discrepancy before posting" : "Post this ERA payment"}
          >
            Post Payment
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        {/* ── ERA Header Fields ────────────────────────────────────── */}
        {header && (
          <div
            className="rounded-xl p-4"
            style={{ background: "var(--card)", border: "1px solid var(--line)" }}
          >
            <div className="grid grid-cols-3 gap-x-8 gap-y-3">
              {/* Row 1 */}
              <HeaderField label="Organization" value={header.organizationName || "—"} />
              <HeaderField label="Payer" value={header.payerName || "—"} />
              <HeaderField label="Total Paid" value={fmt(header.totalPaid)} highlight />

              {/* Row 2 */}
              <HeaderField label="ERA Date" value={fmtDate(header.eraDate) || "—"} />
              <HeaderField label="Payment #" value={header.paymentNumber || "—"} />
              <HeaderField label="Total Adjustment" value={fmt(header.totalAdjustment)} />

              {/* Row 3 */}
              <div /> {/* spacer */}
              <div /> {/* spacer */}
              <HeaderField
                label="Total Client Responsibility"
                value={fmt(header.totalPatientResponsibility)}
              />
            </div>
          </div>
        )}

        {/* ── Balance Indicator ────────────────────────────────────── */}
        {header && balance && (
          <BalanceBox balance={balance} header={header} rows={rows} />
        )}

        {/* ── Unmatched clients warning ──────────────────────────── */}
        {unmatchedRows.length > 0 && (
          <div
            className="flex items-start gap-3 rounded-xl px-4 py-3 text-sm"
            style={{
              background: "#fffbeb",
              border: "1px solid #fde68a",
              color: "var(--warning)",
            }}
          >
            <span className="text-base mt-0.5">⚠</span>
            <span>
              <strong>{unmatchedRows.length}</strong> service line
              {unmatchedRows.length !== 1 ? "s" : ""} could not be matched to an existing client.
              Use the <strong>Add Client</strong> button in each row to create the client record.
            </span>
          </div>
        )}

        {/* ── Post error ───────────────────────────────────────────── */}
        {postError && (
          <div
            className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm"
            style={{ background: "#fff1f1", border: "1px solid #fca5a5", color: "var(--danger)" }}
          >
            <span>❌</span>
            <span>{postError}</span>
          </div>
        )}

        {/* ── Service Lines Table ──────────────────────────────────── */}
        <div
          className="rounded-xl overflow-auto"
          style={{ border: "1px solid var(--line)", background: "var(--card)" }}
        >
          <table className="w-full text-xs border-collapse min-w-[1100px]">
            <thead>
              <tr style={{ background: "var(--background)", borderBottom: "1px solid var(--line)" }}>
                {[
                  "Client Name",
                  "Date of Service",
                  "Provider Name",
                  "CPT / HCPCS",
                  "Charge Amount",
                  "Allowed Amount",
                  "Adj. Amount",
                  "CARC / RARC",
                  "Client Resp.",
                  "Amount Paid",
                  "",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2.5 text-left font-semibold whitespace-nowrap"
                    style={{ color: "var(--muted)", fontSize: "11px" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-3 py-8 text-center" style={{ color: "var(--muted)" }}>
                    No service lines found in this ERA file.
                  </td>
                </tr>
              )}
              {rows.map((row, i) => (
                <tr
                  key={row.rowId}
                  style={{
                    borderBottom: i < rows.length - 1 ? "1px solid var(--line)" : undefined,
                    background: !row.patientFound ? "#fffdf5" : "transparent",
                  }}
                >
                  {/* Client Name */}
                  <td className="px-2 py-1.5 min-w-[140px]">
                    <div className="flex items-center gap-1.5">
                      {!row.patientFound && (
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                          style={{ background: "#f59e0b" }}
                          title="Client not matched"
                        />
                      )}
                      <TextCell
                        value={row.patientName}
                        onChange={(v) => updateRow(row.rowId, "patientName", v)}
                      />
                    </div>
                  </td>
                  {/* Date of Service */}
                  <td className="px-2 py-1.5 min-w-[110px]">
                    <TextCell
                      value={row.dateOfService ? fmtDate(row.dateOfService) : ""}
                      onChange={(v) => updateRow(row.rowId, "dateOfService", v)}
                    />
                  </td>
                  {/* Provider Name */}
                  <td className="px-2 py-1.5 min-w-[130px]">
                    <TextCell
                      value={row.providerName}
                      onChange={(v) => updateRow(row.rowId, "providerName", v)}
                    />
                  </td>
                  {/* CPT */}
                  <td className="px-2 py-1.5 min-w-[90px]">
                    <TextCell
                      value={row.cptCode}
                      onChange={(v) => updateRow(row.rowId, "cptCode", v)}
                    />
                  </td>
                  {/* Charge */}
                  <td className="px-2 py-1.5 min-w-[100px]">
                    <NumberCell value={row.chargeAmount} onChange={(v) => updateRow(row.rowId, "chargeAmount", v)} />
                  </td>
                  {/* Allowed */}
                  <td className="px-2 py-1.5 min-w-[100px]">
                    <NumberCell value={row.allowedAmount} onChange={(v) => updateRow(row.rowId, "allowedAmount", v)} />
                  </td>
                  {/* Adjustment */}
                  <td className="px-2 py-1.5 min-w-[100px]">
                    <NumberCell value={row.adjustmentAmount} onChange={(v) => updateRow(row.rowId, "adjustmentAmount", v)} />
                  </td>
                  {/* CARC/RARC */}
                  <td className="px-2 py-1.5 min-w-[110px]">
                    <TextCell
                      value={row.carcRarc}
                      onChange={(v) => updateRow(row.rowId, "carcRarc", v)}
                    />
                  </td>
                  {/* Client Responsibility */}
                  <td className="px-2 py-1.5 min-w-[100px]">
                    <NumberCell
                      value={row.patientResponsibility}
                      onChange={(v) => updateRow(row.rowId, "patientResponsibility", v)}
                    />
                  </td>
                  {/* Amount Paid */}
                  <td className="px-2 py-1.5 min-w-[100px]">
                    <NumberCell
                      value={row.amountPaid}
                      onChange={(v) => updateRow(row.rowId, "amountPaid", v)}
                    />
                  </td>
                  {/* Actions */}
                  <td className="px-2 py-1.5 min-w-[120px]">
                    {!row.patientFound && (
                      <button
                        type="button"
                        className="px-2.5 py-1 rounded-lg text-xs font-semibold whitespace-nowrap"
                        style={{ background: "var(--sage-soft)", color: "var(--sage)" }}
                        onClick={() => setAddPatientRowId(row.rowId)}
                      >
                        + Add Client
                      </button>
                    )}
                    {row.patientFound && row.patientId && (
                      <a
                        href={`/patients/${row.patientId}`}
                        className="text-xs font-medium"
                        style={{ color: "var(--navy)" }}
                      >
                        View Profile →
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>

            {/* Totals footer */}
            {rows.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: "2px solid var(--line)", background: "var(--background)" }}>
                  <td colSpan={4} className="px-3 py-2 text-xs font-semibold" style={{ color: "var(--muted)" }}>
                    Totals ({rows.length} lines)
                  </td>
                  <td className="px-3 py-2 text-xs font-semibold text-right" style={{ color: "var(--text)" }}>
                    {fmt(rows.reduce((s, r) => s + r.chargeAmount, 0))}
                  </td>
                  <td className="px-3 py-2 text-xs font-semibold text-right" style={{ color: "var(--text)" }}>
                    {fmt(rows.reduce((s, r) => s + r.allowedAmount, 0))}
                  </td>
                  <td className="px-3 py-2 text-xs font-semibold text-right" style={{ color: "var(--text)" }}>
                    {fmt(rows.reduce((s, r) => s + r.adjustmentAmount, 0))}
                  </td>
                  <td />
                  <td className="px-3 py-2 text-xs font-semibold text-right" style={{ color: "var(--text)" }}>
                    {fmt(rows.reduce((s, r) => s + r.patientResponsibility, 0))}
                  </td>
                  <td className="px-3 py-2 text-xs font-semibold text-right" style={{ color: "var(--text)" }}>
                    {fmt(rows.reduce((s, r) => s + r.amountPaid, 0))}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* Bottom action bar */}
        <div className="flex items-center justify-between py-3">
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            {rows.length} service line{rows.length !== 1 ? "s" : ""} ·{" "}
            {rows.filter((r) => r.patientFound).length} matched ·{" "}
            {unmatchedRows.length} unmatched
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-2 rounded-lg text-sm font-medium border"
              style={{ borderColor: "var(--line)", color: "var(--muted)" }}
              onClick={() => setPhase("upload")}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!balanceGood && !balanceClose}
              onClick={handlePost}
              className="px-5 py-2 rounded-lg text-sm font-semibold text-white shadow-sm"
              style={{
                background: "var(--navy)",
                opacity: !balanceGood && !balanceClose ? 0.4 : 1,
                cursor: !balanceGood && !balanceClose ? "not-allowed" : "pointer",
              }}
            >
              Post Payment
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Sub-components
───────────────────────────────────────────────────────────────────────── */
function HeaderField({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium mb-0.5" style={{ color: "var(--muted)" }}>
        {label}
      </dt>
      <dd
        className={`text-sm font-semibold ${highlight ? "text-base" : ""}`}
        style={{ color: highlight ? "var(--navy)" : "var(--text)" }}
      >
        {value}
      </dd>
    </div>
  );
}

function BalanceBox({
  balance,
  header,
  rows,
}: {
  balance: ReturnType<typeof balanceStatus>;
  header: EraHeader;
  rows: WorksheetRow[];
}) {
  const sumPaid = rows.reduce((s, r) => s + r.amountPaid, 0);
  const sumPR = rows.reduce((s, r) => s + r.patientResponsibility, 0);

  const colors: Record<BalanceState, { bg: string; border: string; icon: string; label: string; text: string }> = {
    balanced: {
      bg: "#f0fdf4",
      border: "#86efac",
      icon: "✓",
      label: "In Balance",
      text: "#166534",
    },
    close: {
      bg: "#fffbeb",
      border: "#fde68a",
      icon: "≈",
      label: "Near Balance",
      text: "#92400e",
    },
    out: {
      bg: "#fff1f2",
      border: "#fca5a5",
      icon: "!",
      label: "Out of Balance",
      text: "#991b1b",
    },
  };

  const c = colors[balance.state];

  return (
    <div
      className="rounded-xl px-5 py-3"
      style={{ background: c.bg, border: `1px solid ${c.border}` }}
    >
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-2">
          <span
            className="w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
            style={{ background: c.border, color: c.text }}
          >
            {c.icon}
          </span>
          <span className="text-sm font-semibold" style={{ color: c.text }}>
            {c.label}
          </span>
        </div>

        <BalanceItem
          label="Amount Paid"
          expected={header.totalPaid}
          actual={sumPaid}
          color={c.text}
        />
        <BalanceItem
          label="Client Responsibility"
          expected={header.totalPatientResponsibility}
          actual={sumPR}
          color={c.text}
        />

        {balance.state !== "balanced" && (
          <p className="text-xs ml-auto" style={{ color: c.text }}>
            {balance.state === "out"
              ? "Resolve the discrepancy before posting."
              : "Minor rounding — you may still post."}
          </p>
        )}
      </div>
    </div>
  );
}

function BalanceItem({
  label,
  expected,
  actual,
  color,
}: {
  label: string;
  expected: number;
  actual: number;
  color: string;
}) {
  const diff = actual - expected;
  return (
    <div className="text-xs" style={{ color }}>
      <span className="font-medium">{label}:</span>{" "}
      <span>
        {fmt(actual)} / {fmt(expected)}
        {Math.abs(diff) >= 0.01 && (
          <span className="font-semibold ml-1">
            ({diff > 0 ? "+" : ""}
            {fmt(diff)})
          </span>
        )}
      </span>
    </div>
  );
}
