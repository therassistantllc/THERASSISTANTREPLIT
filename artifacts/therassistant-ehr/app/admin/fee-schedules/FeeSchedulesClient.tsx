"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

interface FeeRow {
  id: string;
  organizationId: string;
  payerContractId: string | null;
  payerProfileId: string | null;
  payerName: string | null;
  contractName: string | null;
  scheduleName: string;
  procedureCode: string;
  modifiers: string[];
  placeOfService: string | null;
  allowedAmount: number;
  billedRate: number | null;
  effectiveDate: string | null;
  expirationDate: string | null;
  notes: string | null;
  updatedAt: string | null;
}

interface ContractOption {
  id: string;
  name: string;
  payerProfileId: string | null;
  payerName: string | null;
}

interface Payload {
  success: boolean;
  error?: string;
  rows?: FeeRow[];
  contracts?: ContractOption[];
}

interface ExtractedDraftRow {
  procedureCode: string;
  modifiers: string;
  placeOfService: string;
  allowedAmount: string;
  billedRate: string;
  notes: string;
}

interface Draft {
  payerContractId: string;
  scheduleName: string;
  procedureCode: string;
  modifiers: string;
  placeOfService: string;
  allowedAmount: string;
  billedRate: string;
  effectiveDate: string;
  expirationDate: string;
  notes: string;
}

const EMPTY_DRAFT: Draft = {
  payerContractId: "",
  scheduleName: "",
  procedureCode: "",
  modifiers: "",
  placeOfService: "",
  allowedAmount: "",
  billedRate: "",
  effectiveDate: "",
  expirationDate: "",
  notes: "",
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function money(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

const inputStyle: CSSProperties = {
  padding: 8,
  border: "1px solid #D1D5DB",
  borderRadius: 4,
  fontSize: 13,
  width: "100%",
};

const buttonStyle: CSSProperties = {
  fontSize: 13,
  padding: "8px 14px",
  borderRadius: 4,
  border: "1px solid #2563EB",
  background: "#2563EB",
  color: "white",
  cursor: "pointer",
};

const subtleButton: CSSProperties = {
  fontSize: 13,
  padding: "8px 14px",
  borderRadius: 4,
  border: "1px solid #D1D5DB",
  background: "white",
  color: "#111827",
  cursor: "pointer",
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "block", fontSize: 12, color: "#374151" }}>
      <span style={{ display: "block", marginBottom: 4 }}>{label}</span>
      {children}
    </label>
  );
}

function rowDraft(row: FeeRow): Draft {
  return {
    payerContractId: row.payerContractId ?? "",
    scheduleName: row.scheduleName,
    procedureCode: row.procedureCode,
    modifiers: row.modifiers.join(", "),
    placeOfService: row.placeOfService ?? "",
    allowedAmount: row.allowedAmount.toFixed(2),
    billedRate: row.billedRate == null ? "" : row.billedRate.toFixed(2),
    effectiveDate: row.effectiveDate ?? "",
    expirationDate: row.expirationDate ?? "",
    notes: row.notes ?? "",
  };
}

export default function FeeSchedulesClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [rows, setRows] = useState<FeeRow[]>([]);
  const [contracts, setContracts] = useState<ContractOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("");
  const [showBulk, setShowBulk] = useState(false);
  const [csv, setCsv] = useState("");
  const [bulkContract, setBulkContract] = useState("");
  const [bulkScheduleName, setBulkScheduleName] = useState("");
  const [bulkEffective, setBulkEffective] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [extractBusy, setExtractBusy] = useState(false);
  const [extractedRows, setExtractedRows] = useState<ExtractedDraftRow[]>([]);
  const [extractMeta, setExtractMeta] = useState<{
    filename: string;
    kind: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/billing/fee-schedules?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as Payload;
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to load fee schedules");
      }
      setRows(json.rows ?? []);
      setContracts(json.contracts ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load fee schedules");
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  function startNew() {
    setEditingId("new");
    setDraft(EMPTY_DRAFT);
    setMessage(null);
  }

  function startEdit(row: FeeRow) {
    setEditingId(row.id);
    setDraft(rowDraft(row));
    setMessage(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  }

  async function save() {
    if (!draft.procedureCode.trim()) {
      setError("CPT / procedure code is required");
      return;
    }
    const allowed = Number(draft.allowedAmount);
    if (!Number.isFinite(allowed) || allowed < 0) {
      setError("Allowed amount must be a non-negative number");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const isNew = editingId === "new";
      const payload = {
        organizationId,
        id: isNew ? undefined : editingId,
        payerContractId: draft.payerContractId || null,
        scheduleName: draft.scheduleName.trim(),
        procedureCode: draft.procedureCode.trim(),
        modifiers: draft.modifiers,
        placeOfService: draft.placeOfService.trim() || null,
        allowedAmount: allowed,
        billedRate:
          draft.billedRate.trim() === "" ? null : Number(draft.billedRate),
        effectiveDate: draft.effectiveDate || null,
        expirationDate: draft.expirationDate || null,
        notes: draft.notes.trim() || null,
      };
      const res = await fetch("/api/billing/fee-schedules", {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        throw new Error(json?.error ?? `Save failed (${res.status})`);
      }
      setMessage(isNew ? "Fee schedule row added" : "Fee schedule updated");
      cancelEdit();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save fee schedule");
    } finally {
      setSaving(false);
    }
  }

  async function archive(row: FeeRow) {
    if (
      !confirm(
        `Archive fee schedule row for ${row.procedureCode}${
          row.payerName ? ` (${row.payerName})` : ""
        }?`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      const res = await fetch(
        `/api/billing/fee-schedules?id=${encodeURIComponent(row.id)}&organizationId=${encodeURIComponent(organizationId)}`,
        { method: "DELETE" },
      );
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        throw new Error(json?.error ?? `Archive failed (${res.status})`);
      }
      setMessage("Fee schedule row archived");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to archive");
    }
  }

  async function handleExtractFile(file: File) {
    setExtractBusy(true);
    setError(null);
    setMessage(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(
        `/api/billing/fee-schedules/extract?organizationId=${encodeURIComponent(organizationId)}`,
        { method: "POST", body: fd },
      );
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: string;
        kind?: string;
        filename?: string;
        rows?: Array<{
          procedureCode: string;
          modifiers: string[];
          placeOfService: string | null;
          allowedAmount: number;
          billedRate: number | null;
          notes: string | null;
        }>;
      } | null;
      if (!res.ok || !json?.success) {
        throw new Error(json?.error ?? `Extract failed (${res.status})`);
      }
      const drafts: ExtractedDraftRow[] = (json.rows ?? []).map((r) => ({
        procedureCode: r.procedureCode,
        modifiers: r.modifiers.join(", "),
        placeOfService: r.placeOfService ?? "",
        allowedAmount: r.allowedAmount.toFixed(2),
        billedRate: r.billedRate == null ? "" : r.billedRate.toFixed(2),
        notes: r.notes ?? "",
      }));
      setExtractedRows(drafts);
      setExtractMeta({
        filename: json.filename ?? file.name,
        kind: json.kind ?? "unknown",
      });
      if (drafts.length === 0) {
        setError(
          "No CPT/allowed rate rows found. The file may be a scanned image or use an unusual layout — try the CSV importer.",
        );
      } else {
        setMessage(
          `Extracted ${drafts.length} rows from ${json.filename ?? file.name}. Review and edit before committing.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extract failed");
    } finally {
      setExtractBusy(false);
    }
  }

  function updateExtracted(
    idx: number,
    patch: Partial<ExtractedDraftRow>,
  ) {
    setExtractedRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  }

  function removeExtracted(idx: number) {
    setExtractedRows((prev) => prev.filter((_, i) => i !== idx));
  }

  function clearExtracted() {
    setExtractedRows([]);
    setExtractMeta(null);
  }

  async function commitExtracted() {
    if (extractedRows.length === 0) {
      setError("Nothing to commit");
      return;
    }
    setBulkBusy(true);
    setError(null);
    try {
      const payloadRows = extractedRows.map((r) => ({
        procedureCode: r.procedureCode.trim(),
        modifiers: r.modifiers,
        placeOfService: r.placeOfService.trim() || null,
        allowedAmount: r.allowedAmount,
        billedRate: r.billedRate.trim() === "" ? null : r.billedRate,
        notes: r.notes.trim() || null,
      }));
      const res = await fetch("/api/billing/fee-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          rows: payloadRows,
          defaultContractId: bulkContract || null,
          defaultScheduleName: bulkScheduleName.trim() || undefined,
          defaultEffectiveDate: bulkEffective || null,
          source: extractMeta
            ? `${extractMeta.kind}:${extractMeta.filename}`
            : "preview-grid",
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: string;
        inserted?: number;
        skipped?: number;
        errors?: Array<{ line: number; error: string }>;
      } | null;
      if (!res.ok || !json?.success) {
        const detail =
          json?.errors && json.errors.length > 0
            ? ` (${json.errors
                .slice(0, 3)
                .map((e) => `row ${e.line}: ${e.error}`)
                .join("; ")})`
            : "";
        throw new Error(
          (json?.error ?? `Import failed (${res.status})`) + detail,
        );
      }
      setMessage(
        `Imported ${json.inserted ?? 0} rows${
          json.skipped ? ` (${json.skipped} skipped)` : ""
        }`,
      );
      clearExtracted();
      setShowBulk(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Commit failed");
    } finally {
      setBulkBusy(false);
    }
  }

  async function importCsv() {
    if (!csv.trim()) {
      setError("Paste CSV content first");
      return;
    }
    setBulkBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/fee-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          csv,
          defaultContractId: bulkContract || null,
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: string;
        inserted?: number;
        skipped?: number;
        errors?: Array<{ line: number; error: string }>;
      } | null;
      if (!res.ok || !json?.success) {
        const detail =
          json?.errors && json.errors.length > 0
            ? ` (${json.errors
                .slice(0, 3)
                .map((e) => `line ${e.line}: ${e.error}`)
                .join("; ")})`
            : "";
        throw new Error((json?.error ?? `Import failed (${res.status})`) + detail);
      }
      setMessage(
        `Imported ${json.inserted ?? 0} rows${
          json.skipped ? ` (${json.skipped} skipped)` : ""
        }`,
      );
      setCsv("");
      setShowBulk(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk import failed");
    } finally {
      setBulkBusy(false);
    }
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [
        r.procedureCode,
        r.scheduleName,
        r.payerName ?? "",
        r.contractName ?? "",
        r.modifiers.join(" "),
        r.notes ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [rows, filter]);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: 24 }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          marginBottom: 16,
          gap: 16,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Contracted fee schedule</h1>
          <p style={{ color: "#6B7280", margin: "4px 0 0", fontSize: 13 }}>
            Per payer/CPT contracted allowed rates. The{" "}
            <a
              href="/billing/underpayments"
              style={{ color: "#2563EB", textDecoration: "underline" }}
            >
              Underpayments workqueue
            </a>{" "}
            uses these rates to flag ERA lines paid below contract.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by CPT, payer, contract…"
            style={{ ...inputStyle, width: 260 }}
          />
          <button
            type="button"
            style={subtleButton}
            onClick={() => {
              setShowBulk((v) => !v);
              setMessage(null);
            }}
          >
            {showBulk ? "Close bulk import" : "Bulk import CSV"}
          </button>
          <button type="button" style={buttonStyle} onClick={startNew}>
            + Add row
          </button>
        </div>
      </header>

      {error ? (
        <div
          style={{
            background: "#FEE2E2",
            color: "#991B1B",
            padding: 10,
            borderRadius: 4,
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      ) : null}
      {message ? (
        <div
          style={{
            background: "#DCFCE7",
            color: "#166534",
            padding: 10,
            borderRadius: 4,
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          {message}
        </div>
      ) : null}

      {showBulk ? (
        <div
          style={{
            border: "1px solid #D1D5DB",
            borderRadius: 6,
            padding: 16,
            marginBottom: 16,
            background: "#F9FAFB",
          }}
        >
          <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Bulk import</h3>
          <p style={{ margin: "0 0 12px", fontSize: 12, color: "#4B5563" }}>
            Upload a payer contract <strong>PDF</strong> or{" "}
            <strong>Excel (.xlsx)</strong> fee schedule and we'll extract
            CPT + allowed-rate rows for you to review before committing.
            Or paste CSV with a header row — required columns:{" "}
            <code>cpt</code>, <code>allowed_amount</code>.
          </p>

          <div
            style={{
              border: "1px dashed #CBD5E1",
              borderRadius: 6,
              padding: 12,
              marginBottom: 16,
              background: "white",
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <label
              style={{
                ...subtleButton,
                display: "inline-block",
                cursor: extractBusy ? "wait" : "pointer",
                opacity: extractBusy ? 0.6 : 1,
              }}
            >
              {extractBusy ? "Extracting…" : "Upload PDF or XLSX"}
              <input
                type="file"
                accept=".pdf,.xlsx,.xls,.xlsm,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void handleExtractFile(f);
                }}
                disabled={extractBusy}
                style={{ display: "none" }}
              />
            </label>
            {extractMeta ? (
              <span style={{ fontSize: 12, color: "#4B5563" }}>
                Loaded <strong>{extractMeta.filename}</strong> (
                {extractMeta.kind.toUpperCase()}) — {extractedRows.length} rows
                {extractedRows.length > 0 ? " ready to commit" : ""}
              </span>
            ) : (
              <span style={{ fontSize: 12, color: "#6B7280" }}>
                We look for CPT/HCPCS codes paired with dollar amounts.
                Scanned (image-only) PDFs can't be parsed.
              </span>
            )}
          </div>

          {extractedRows.length > 0 ? (
            <div
              style={{
                marginBottom: 16,
                border: "1px solid #E5E7EB",
                borderRadius: 6,
                background: "white",
              }}
            >
              <div
                style={{
                  padding: "8px 12px",
                  borderBottom: "1px solid #E5E7EB",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: "#F3F4F6",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                <span>Preview — extracted rows ({extractedRows.length})</span>
                <button
                  type="button"
                  style={{ ...subtleButton, padding: "4px 10px" }}
                  onClick={clearExtracted}
                  disabled={bulkBusy}
                >
                  Clear
                </button>
              </div>
              <div
                style={{
                  maxHeight: 360,
                  overflow: "auto",
                }}
              >
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 12,
                  }}
                >
                  <thead
                    style={{
                      background: "#F9FAFB",
                      position: "sticky",
                      top: 0,
                    }}
                  >
                    <tr>
                      <th style={{ padding: "6px 8px", textAlign: "left" }}>
                        CPT *
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "left" }}>
                        Modifiers
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "left" }}>
                        POS
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "right" }}>
                        Allowed *
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "right" }}>
                        Billed
                      </th>
                      <th style={{ padding: "6px 8px", textAlign: "left" }}>
                        Notes
                      </th>
                      <th style={{ padding: "6px 8px" }} />
                    </tr>
                  </thead>
                  <tbody>
                    {extractedRows.map((r, idx) => (
                      <tr
                        key={idx}
                        style={{ borderTop: "1px solid #E5E7EB" }}
                      >
                        <td style={{ padding: "4px 8px" }}>
                          <input
                            value={r.procedureCode}
                            onChange={(e) =>
                              updateExtracted(idx, {
                                procedureCode: e.target.value.toUpperCase(),
                              })
                            }
                            style={{
                              ...inputStyle,
                              padding: 4,
                              fontFamily: "ui-monospace, monospace",
                              fontWeight: 600,
                              width: 80,
                            }}
                          />
                        </td>
                        <td style={{ padding: "4px 8px" }}>
                          <input
                            value={r.modifiers}
                            onChange={(e) =>
                              updateExtracted(idx, {
                                modifiers: e.target.value.toUpperCase(),
                              })
                            }
                            placeholder="95, HJ"
                            style={{ ...inputStyle, padding: 4, width: 100 }}
                          />
                        </td>
                        <td style={{ padding: "4px 8px" }}>
                          <input
                            value={r.placeOfService}
                            onChange={(e) =>
                              updateExtracted(idx, {
                                placeOfService: e.target.value,
                              })
                            }
                            placeholder="11"
                            style={{ ...inputStyle, padding: 4, width: 60 }}
                          />
                        </td>
                        <td
                          style={{ padding: "4px 8px", textAlign: "right" }}
                        >
                          <input
                            value={r.allowedAmount}
                            onChange={(e) =>
                              updateExtracted(idx, {
                                allowedAmount: e.target.value,
                              })
                            }
                            inputMode="decimal"
                            style={{
                              ...inputStyle,
                              padding: 4,
                              width: 90,
                              textAlign: "right",
                            }}
                          />
                        </td>
                        <td
                          style={{ padding: "4px 8px", textAlign: "right" }}
                        >
                          <input
                            value={r.billedRate}
                            onChange={(e) =>
                              updateExtracted(idx, {
                                billedRate: e.target.value,
                              })
                            }
                            inputMode="decimal"
                            style={{
                              ...inputStyle,
                              padding: 4,
                              width: 90,
                              textAlign: "right",
                            }}
                          />
                        </td>
                        <td style={{ padding: "4px 8px" }}>
                          <input
                            value={r.notes}
                            onChange={(e) =>
                              updateExtracted(idx, { notes: e.target.value })
                            }
                            style={{ ...inputStyle, padding: 4 }}
                          />
                        </td>
                        <td
                          style={{ padding: "4px 8px", textAlign: "right" }}
                        >
                          <button
                            type="button"
                            onClick={() => removeExtracted(idx)}
                            style={{
                              ...subtleButton,
                              padding: "2px 8px",
                              borderColor: "#FCA5A5",
                              color: "#B91C1C",
                            }}
                            title="Remove row"
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div
                style={{
                  padding: 12,
                  borderTop: "1px solid #E5E7EB",
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr auto",
                  gap: 12,
                  alignItems: "end",
                  background: "#F9FAFB",
                }}
              >
                <Field label="Payer contract to attach">
                  <select
                    value={bulkContract}
                    onChange={(e) => setBulkContract(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="">— No contract —</option>
                    {contracts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.payerName ? `${c.payerName} — ` : ""}
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Schedule label">
                  <input
                    value={bulkScheduleName}
                    onChange={(e) => setBulkScheduleName(e.target.value)}
                    placeholder={
                      extractMeta
                        ? extractMeta.filename
                        : "2026 commercial schedule"
                    }
                    style={inputStyle}
                  />
                </Field>
                <Field label="Effective date">
                  <input
                    type="date"
                    value={bulkEffective}
                    onChange={(e) => setBulkEffective(e.target.value)}
                    style={inputStyle}
                  />
                </Field>
                <button
                  type="button"
                  style={buttonStyle}
                  onClick={commitExtracted}
                  disabled={bulkBusy || extractedRows.length === 0}
                >
                  {bulkBusy
                    ? "Committing…"
                    : `Commit ${extractedRows.length} rows`}
                </button>
              </div>
            </div>
          ) : null}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 280px",
              gap: 12,
            }}
          >
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={10}
              placeholder={
                "cpt,allowed_amount,modifiers,place_of_service\n" +
                "90837,165.00,,11\n" +
                "90834,135.00,95,02\n" +
                "H0031,95.00,HE,11"
              }
              style={{
                ...inputStyle,
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
                fontSize: 12,
              }}
            />
            <div>
              <Field label="Apply default contract to all rows (optional)">
                <select
                  value={bulkContract}
                  onChange={(e) => setBulkContract(e.target.value)}
                  style={inputStyle}
                >
                  <option value="">— No contract —</option>
                  {contracts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.payerName ? `${c.payerName} — ` : ""}
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                <button
                  type="button"
                  style={buttonStyle}
                  onClick={importCsv}
                  disabled={bulkBusy}
                >
                  {bulkBusy ? "Importing…" : "Import rows"}
                </button>
                <button
                  type="button"
                  style={subtleButton}
                  onClick={() => setCsv("")}
                  disabled={bulkBusy}
                >
                  Clear
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {editingId ? (
        <div
          style={{
            border: "1px solid #D1D5DB",
            borderRadius: 6,
            padding: 16,
            marginBottom: 16,
            background: "#F9FAFB",
          }}
        >
          <h3 style={{ margin: "0 0 12px", fontSize: 15 }}>
            {editingId === "new" ? "Add fee schedule row" : "Edit fee schedule row"}
          </h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 12,
              marginBottom: 12,
            }}
          >
            <Field label="Payer contract">
              <select
                value={draft.payerContractId}
                onChange={(e) =>
                  setDraft({ ...draft, payerContractId: e.target.value })
                }
                style={inputStyle}
              >
                <option value="">— No contract / org default —</option>
                {contracts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.payerName ? `${c.payerName} — ` : ""}
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="CPT / procedure code *">
              <input
                value={draft.procedureCode}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    procedureCode: e.target.value.toUpperCase(),
                  })
                }
                placeholder="90837"
                style={inputStyle}
              />
            </Field>
            <Field label="Modifiers (comma- or space-separated)">
              <input
                value={draft.modifiers}
                onChange={(e) =>
                  setDraft({ ...draft, modifiers: e.target.value.toUpperCase() })
                }
                placeholder="95, HJ"
                style={inputStyle}
              />
            </Field>
            <Field label="Allowed amount *">
              <input
                value={draft.allowedAmount}
                onChange={(e) =>
                  setDraft({ ...draft, allowedAmount: e.target.value })
                }
                placeholder="165.00"
                inputMode="decimal"
                style={inputStyle}
              />
            </Field>
            <Field label="Billed rate (optional)">
              <input
                value={draft.billedRate}
                onChange={(e) =>
                  setDraft({ ...draft, billedRate: e.target.value })
                }
                placeholder="200.00"
                inputMode="decimal"
                style={inputStyle}
              />
            </Field>
            <Field label="Place of service">
              <input
                value={draft.placeOfService}
                onChange={(e) =>
                  setDraft({ ...draft, placeOfService: e.target.value })
                }
                placeholder="11"
                style={inputStyle}
              />
            </Field>
            <Field label="Effective date">
              <input
                type="date"
                value={draft.effectiveDate}
                onChange={(e) =>
                  setDraft({ ...draft, effectiveDate: e.target.value })
                }
                style={inputStyle}
              />
            </Field>
            <Field label="Expiration date">
              <input
                type="date"
                value={draft.expirationDate}
                onChange={(e) =>
                  setDraft({ ...draft, expirationDate: e.target.value })
                }
                style={inputStyle}
              />
            </Field>
            <Field label="Schedule label">
              <input
                value={draft.scheduleName}
                onChange={(e) =>
                  setDraft({ ...draft, scheduleName: e.target.value })
                }
                placeholder="2026 commercial schedule"
                style={inputStyle}
              />
            </Field>
          </div>
          <Field label="Notes">
            <textarea
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              rows={2}
              style={{ ...inputStyle, fontFamily: "inherit" }}
            />
          </Field>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button
              type="button"
              style={buttonStyle}
              onClick={save}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" style={subtleButton} onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div
        style={{
          border: "1px solid #E5E7EB",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 13,
          }}
        >
          <thead style={{ background: "#F3F4F6", textAlign: "left" }}>
            <tr>
              <th style={{ padding: "8px 12px" }}>CPT</th>
              <th style={{ padding: "8px 12px" }}>Modifiers</th>
              <th style={{ padding: "8px 12px" }}>POS</th>
              <th style={{ padding: "8px 12px" }}>Payer / contract</th>
              <th style={{ padding: "8px 12px", textAlign: "right" }}>Allowed</th>
              <th style={{ padding: "8px 12px", textAlign: "right" }}>Billed</th>
              <th style={{ padding: "8px 12px" }}>Effective</th>
              <th style={{ padding: "8px 12px" }} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={8}
                  style={{ padding: 16, color: "#6B7280", textAlign: "center" }}
                >
                  Loading…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  style={{ padding: 16, color: "#6B7280", textAlign: "center" }}
                >
                  No fee schedule rows yet. Add one or bulk-import a CSV to
                  start flagging underpayments.
                </td>
              </tr>
            ) : (
              filtered.map((row) => (
                <tr key={row.id} style={{ borderTop: "1px solid #E5E7EB" }}>
                  <td
                    style={{
                      padding: "8px 12px",
                      fontFamily: "ui-monospace, monospace",
                      fontWeight: 600,
                    }}
                  >
                    {row.procedureCode}
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    {row.modifiers.length > 0 ? row.modifiers.join(", ") : "—"}
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    {row.placeOfService ?? "—"}
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    {row.payerName ?? <em style={{ color: "#9CA3AF" }}>Any payer</em>}
                    {row.contractName ? (
                      <div style={{ fontSize: 11, color: "#6B7280" }}>
                        {row.contractName}
                      </div>
                    ) : null}
                  </td>
                  <td
                    style={{
                      padding: "8px 12px",
                      textAlign: "right",
                      fontWeight: 600,
                    }}
                  >
                    {money(row.allowedAmount)}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>
                    {money(row.billedRate)}
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    {row.effectiveDate ?? "—"}
                    {row.expirationDate ? ` → ${row.expirationDate}` : ""}
                  </td>
                  <td
                    style={{
                      padding: "8px 12px",
                      textAlign: "right",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <button
                      type="button"
                      style={{
                        ...subtleButton,
                        padding: "4px 10px",
                        marginRight: 6,
                      }}
                      onClick={() => startEdit(row)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      style={{
                        ...subtleButton,
                        padding: "4px 10px",
                        borderColor: "#FCA5A5",
                        color: "#B91C1C",
                      }}
                      onClick={() => archive(row)}
                    >
                      Archive
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
