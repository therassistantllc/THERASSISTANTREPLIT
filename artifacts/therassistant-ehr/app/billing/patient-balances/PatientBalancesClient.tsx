"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DEFAULT_ORG_ID } from "@/lib/config";

// ─── Types ───────────────────────────────────────────────────────────────────

interface BalanceRow {
  id: string;
  claimId: string;
  claimNumber: string;
  claimStatus: string;
  clientId: string;
  clientName: string;
  clientEmail: string | null;
  payerName: string;
  providerName: string | null;
  providerId: string | null;
  dateOfService: string | null;
  totalCharge: number;
  patientResponsibility: number;
  payerPaid: number;
  amountPaid: number;
  adjustmentAmount: number;
  diagnosisCodes: string[];
  billingNotes: string | null;
  hasCardOnFile: boolean;
  cardSummary: string | null;
  autopayEnabled: boolean;
  createdAt: string;
}

interface Provider {
  id: string;
  name: string;
  credential: string | null;
  staffProfileId: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getOrgId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function fmt$(n: number): string {
  return `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

// ─── Route-to-Provider Modal ──────────────────────────────────────────────────

function RouteProviderModal({
  claimIds,
  providers,
  onClose,
  onDone,
}: {
  claimIds: string[];
  providers: Provider[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!selectedProvider) return;
    if (!selectedProvider.staffProfileId) {
      setError("This provider doesn't have a staff profile linked — ask your admin to link the provider account.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/patient-balances/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: getOrgId(),
          action: "route_to_provider",
          claimIds,
          providerStaffId: selectedProvider.staffProfileId,
          billingComment: comment.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "Failed");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to route");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          background: "var(--card)",
          borderRadius: 10,
          width: "100%",
          maxWidth: 440,
          padding: "28px 24px 20px",
          boxShadow: "0 8px 32px rgba(16,36,63,.18)",
        }}
      >
        <h3 style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700, color: "var(--navy)" }}>
          Route to Provider for Approval
        </h3>
        <p style={{ margin: "0 0 18px", fontSize: 12, color: "var(--muted)" }}>
          {claimIds.length === 1 ? "1 claim" : `${claimIds.length} claims`} will be sent to the selected provider.
        </p>

        <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: ".04em" }}>
          Provider *
        </label>
        <select
          value={selectedProvider?.id ?? ""}
          onChange={(e) => setSelectedProvider(providers.find((p) => p.id === e.target.value) ?? null)}
          style={{
            width: "100%",
            padding: "8px 10px",
            border: "1px solid var(--line)",
            borderRadius: 6,
            fontSize: 13,
            color: "var(--text)",
            background: "var(--card)",
            marginBottom: 14,
          }}
        >
          <option value="">Select a provider…</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}{p.credential ? `, ${p.credential}` : ""}
              {!p.staffProfileId ? " (no staff record)" : ""}
            </option>
          ))}
        </select>

        <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: ".04em" }}>
          Comment (optional)
        </label>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Add a note for the provider…"
          rows={3}
          style={{
            width: "100%",
            padding: "8px 10px",
            border: "1px solid var(--line)",
            borderRadius: 6,
            fontSize: 13,
            color: "var(--text)",
            background: "var(--card)",
            resize: "vertical",
            marginBottom: error ? 8 : 18,
            boxSizing: "border-box",
          }}
        />

        {error && (
          <p style={{ fontSize: 12, color: "var(--danger)", margin: "0 0 12px" }}>{error}</p>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            disabled={busy}
            style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--card)", fontSize: 13, cursor: "pointer", color: "var(--text)" }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !selectedProvider}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              border: "none",
              background: selectedProvider ? "var(--navy)" : "var(--line)",
              color: selectedProvider ? "#fff" : "var(--muted)",
              fontSize: 13,
              fontWeight: 600,
              cursor: selectedProvider ? "pointer" : "not-allowed",
            }}
          >
            {busy ? "Routing…" : "Send to Provider"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Single-row route modal ───────────────────────────────────────────────────

function RowRouteModal({
  row,
  providers,
  onClose,
  onDone,
}: {
  row: BalanceRow;
  providers: Provider[];
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <RouteProviderModal
      claimIds={[row.claimId]}
      providers={providers}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ msg, onDismiss }: { msg: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4000);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <div
      style={{
        position: "fixed",
        bottom: 28,
        right: 28,
        background: "var(--success)",
        color: "#fff",
        padding: "10px 18px",
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 600,
        boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
        zIndex: 200,
        maxWidth: 340,
      }}
    >
      {msg}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function PatientBalancesClient() {
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  // Modals
  const [routeModal, setRouteModal] = useState<"bulk" | null>(null);
  const [rowRouteModal, setRowRouteModal] = useState<BalanceRow | null>(null);

  // Action states
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);

  const orgId = useMemo(() => getOrgId(), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [balRes, provRes] = await Promise.all([
        fetch(`/api/billing/patient-balances?organizationId=${encodeURIComponent(orgId)}`),
        fetch(`/api/billing/providers-for-routing?organizationId=${encodeURIComponent(orgId)}`),
      ]);
      const [balJson, provJson] = await Promise.all([balRes.json(), provRes.json()]);
      if (balJson.success) setRows(balJson.rows ?? []);
      else setError(balJson.error ?? "Failed to load balances");
      if (provJson.success) setProviders(provJson.providers ?? []);
    } catch {
      setError("Network error loading patient balances");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.clientName.toLowerCase().includes(q) ||
        r.claimNumber.toLowerCase().includes(q) ||
        r.payerName.toLowerCase().includes(q) ||
        (r.providerName?.toLowerCase().includes(q) ?? false),
    );
  }, [rows, search]);

  const allSelected = filtered.length > 0 && filtered.every((r) => selectedIds.has(r.id));

  function toggleAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((r) => r.id)));
    }
  }

  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedRows = useMemo(
    () => filtered.filter((r) => selectedIds.has(r.id)),
    [filtered, selectedIds],
  );

  // Summary totals
  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          charge: acc.charge + r.totalCharge,
          responsibility: acc.responsibility + r.patientResponsibility,
          count: acc.count + 1,
          withCard: acc.withCard + (r.hasCardOnFile ? 1 : 0),
        }),
        { charge: 0, responsibility: 0, count: 0, withCard: 0 },
      ),
    [rows],
  );

  async function handleSendStatements() {
    const ids = selectedRows.map((r) => r.claimId);
    if (!ids.length) return;
    setBulkBusy("statements");
    try {
      const res = await fetch("/api/billing/patient-balances/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgId, action: "send_statement", claimIds: ids }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setToast(`Statements queued for ${ids.length} patient(s)`);
      setSelectedIds(new Set());
    } catch (e) {
      setToast(`Error: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setBulkBusy(null);
    }
  }

  async function handleChargeCards() {
    const ids = selectedRows.filter((r) => r.hasCardOnFile).map((r) => r.claimId);
    const noCard = selectedRows.filter((r) => !r.hasCardOnFile).length;
    if (!ids.length) {
      setToast(noCard > 0 ? `None of the ${noCard} selected patients have a card on file` : "No claims selected");
      return;
    }
    setBulkBusy("cards");
    try {
      const res = await fetch("/api/billing/patient-balances/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgId, action: "charge_card", claimIds: ids }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      const skipped = noCard > 0 ? ` (${noCard} skipped — no card)` : "";
      setToast(`${ids.length} charge(s) queued${skipped}`);
      setSelectedIds(new Set());
    } catch (e) {
      setToast(`Error: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setBulkBusy(null);
    }
  }

  async function handleRowEmail(row: BalanceRow) {
    try {
      const res = await fetch("/api/billing/patient-balances/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgId, action: "send_statement", claimIds: [row.claimId] }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setToast(`Statement emailed to ${row.clientName}`);
    } catch (e) {
      setToast(`Error: ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  }

  async function handleRowCharge(row: BalanceRow) {
    if (!row.hasCardOnFile) {
      setToast("No card on file for this patient");
      return;
    }
    try {
      const res = await fetch("/api/billing/patient-balances/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgId, action: "charge_card", claimIds: [row.claimId] }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setToast(`Charge queued for ${row.clientName} — ${row.cardSummary ?? "card"}`);
    } catch (e) {
      setToast(`Error: ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  }

  const hasSelected = selectedIds.size > 0;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: "0 0 40px" }}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          padding: "24px 28px 0",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "var(--navy)" }}>
            Patient Balances
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--muted)" }}>
            Collect patient responsibility — charge cards, send statements, or route for approval.
          </p>
        </div>

        {/* Bulk Action Buttons */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={handleSendStatements}
            disabled={!hasSelected || bulkBusy === "statements"}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              border: "1px solid var(--line)",
              background: hasSelected ? "var(--card)" : "#f5f7fa",
              color: hasSelected ? "var(--navy)" : "var(--muted)",
              fontWeight: 600,
              fontSize: 12,
              cursor: hasSelected ? "pointer" : "not-allowed",
              letterSpacing: ".03em",
            }}
          >
            {bulkBusy === "statements" ? "Sending…" : "✉ SEND STATEMENTS"}
          </button>
          <button
            onClick={handleChargeCards}
            disabled={!hasSelected || bulkBusy === "cards"}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              border: "1px solid var(--line)",
              background: hasSelected ? "var(--card)" : "#f5f7fa",
              color: hasSelected ? "var(--navy)" : "var(--muted)",
              fontWeight: 600,
              fontSize: 12,
              cursor: hasSelected ? "pointer" : "not-allowed",
              letterSpacing: ".03em",
            }}
          >
            {bulkBusy === "cards" ? "Queuing…" : "💳 CHARGE CARDS"}
          </button>
          <button
            onClick={() => hasSelected && setRouteModal("bulk")}
            disabled={!hasSelected}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              border: "none",
              background: hasSelected ? "var(--navy)" : "var(--line)",
              color: hasSelected ? "#fff" : "var(--muted)",
              fontWeight: 600,
              fontSize: 12,
              cursor: hasSelected ? "pointer" : "not-allowed",
              letterSpacing: ".03em",
            }}
          >
            ⬆ REQUEST PROVIDER APPROVAL
          </button>
        </div>
      </div>

      {/* ── Summary Cards ────────────────────────────────────────────────── */}
      {!loading && rows.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 12,
            padding: "16px 28px 0",
            flexWrap: "wrap",
          }}
        >
          {[
            { label: "Open Balances", val: totals.count.toString(), sub: "claims" },
            { label: "Total Charges", val: fmt$(totals.charge), sub: "billed" },
            { label: "Patient Responsibility", val: fmt$(totals.responsibility), sub: "outstanding" },
            { label: "Cards on File", val: totals.withCard.toString(), sub: `of ${totals.count} patients` },
          ].map((s) => (
            <div
              key={s.label}
              style={{
                flex: "1 1 160px",
                background: "var(--card)",
                border: "1px solid var(--line)",
                borderRadius: 8,
                padding: "12px 16px",
              }}
            >
              <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>
                {s.label}
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--navy)", margin: "4px 0 2px" }}>
                {s.val}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>{s.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Search + Filter Bar ───────────────────────────────────────────── */}
      <div style={{ padding: "16px 28px 0", display: "flex", gap: 10, alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search patient, claim #, payer, provider…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: "1 1 280px",
            maxWidth: 360,
            padding: "8px 12px",
            border: "1px solid var(--line)",
            borderRadius: 6,
            fontSize: 13,
            color: "var(--text)",
            background: "var(--card)",
          }}
        />
        {selectedIds.size > 0 && (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            {selectedIds.size} selected
          </span>
        )}
        <button
          onClick={load}
          style={{
            padding: "8px 14px",
            border: "1px solid var(--line)",
            borderRadius: 6,
            background: "var(--card)",
            fontSize: 12,
            color: "var(--muted)",
            cursor: "pointer",
          }}
        >
          ↺ Refresh
        </button>
      </div>

      {/* ── Table ────────────────────────────────────────────────────────── */}
      <div style={{ padding: "12px 28px 0" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: "60px 0", color: "var(--muted)", fontSize: 14 }}>
            Loading patient balances…
          </div>
        ) : error ? (
          <div style={{ textAlign: "center", padding: "40px 0", color: "var(--danger)", fontSize: 13 }}>
            {error}
          </div>
        ) : filtered.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "60px 20px",
              color: "var(--muted)",
              fontSize: 14,
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 8,
            }}
          >
            {rows.length === 0
              ? "No open patient balances found."
              : "No results match your search."}
          </div>
        ) : (
          <div
            style={{
              overflowX: "auto",
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 8,
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
                tableLayout: "fixed",
              }}
            >
              <colgroup>
                <col style={{ width: 36 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 110 }} />
                <col style={{ width: 140 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 95 }} />
                <col style={{ width: 95 }} />
                <col style={{ width: 100 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 110 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 190 }} />
              </colgroup>
              <thead>
                <tr style={{ background: "var(--sage-soft)", borderBottom: "1px solid var(--line)" }}>
                  <th style={thStyle}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      style={{ cursor: "pointer" }}
                    />
                  </th>
                  <th style={thStyle}>Patient Name</th>
                  <th style={thStyle}>Date of Service</th>
                  <th style={thStyle}>Provider</th>
                  <th style={thStyle}>CPT/HCPCS</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Charge</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Allowed</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Adjustment</th>
                  <th style={thStyle}>CARC/RARC</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Pt Responsibility</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Amt Paid</th>
                  <th style={thStyle}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, idx) => {
                  const sel = selectedIds.has(row.id);
                  const allowedAmt = row.payerPaid + row.patientResponsibility;
                  const balance = row.patientResponsibility - row.amountPaid;
                  return (
                    <tr
                      key={row.id}
                      style={{
                        background: sel
                          ? "rgba(94,138,106,0.07)"
                          : idx % 2 === 0
                          ? "var(--card)"
                          : "#f9fafb",
                        borderBottom: "1px solid var(--line)",
                      }}
                    >
                      <td style={tdStyle}>
                        <input
                          type="checkbox"
                          checked={sel}
                          onChange={() => toggleRow(row.id)}
                          style={{ cursor: "pointer" }}
                        />
                      </td>
                      <td style={tdStyle}>
                        <Link
                          href={`/clients/${row.clientId}`}
                          style={{ color: "var(--navy)", fontWeight: 600, textDecoration: "none" }}
                        >
                          {row.clientName}
                        </Link>
                        <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 1 }}>
                          {row.claimNumber || "—"}
                        </div>
                        {row.hasCardOnFile && (
                          <div
                            style={{
                              display: "inline-block",
                              marginTop: 3,
                              fontSize: 9,
                              fontWeight: 700,
                              padding: "1px 5px",
                              borderRadius: 4,
                              background: "var(--sage-soft)",
                              color: "var(--success)",
                              letterSpacing: ".04em",
                              textTransform: "uppercase",
                            }}
                          >
                            {row.cardSummary ?? "Card on file"}
                          </div>
                        )}
                      </td>
                      <td style={tdStyle}>{fmtDate(row.dateOfService)}</td>
                      <td style={{ ...tdStyle, color: "var(--muted)" }}>{row.providerName ?? "—"}</td>
                      <td style={{ ...tdStyle, color: "var(--muted)" }}>—</td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>{fmt$(row.totalCharge)}</td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>{fmt$(allowedAmt)}</td>
                      <td style={{ ...tdStyle, textAlign: "right", color: row.adjustmentAmount > 0 ? "var(--muted)" : "var(--text)" }}>
                        {row.adjustmentAmount !== 0 ? fmt$(row.adjustmentAmount) : "—"}
                      </td>
                      <td style={{ ...tdStyle, color: "var(--muted)" }}>
                        {row.diagnosisCodes.length > 0 ? row.diagnosisCodes[0] : "—"}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        <span
                          style={{
                            fontWeight: 700,
                            color: balance > 0 ? "var(--danger)" : "var(--success)",
                          }}
                        >
                          {fmt$(balance)}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right", color: "var(--muted)" }}>
                        {row.amountPaid > 0 ? fmt$(row.amountPaid) : "—"}
                      </td>
                      <td style={tdStyle}>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {row.hasCardOnFile ? (
                            <button
                              onClick={() => handleRowCharge(row)}
                              style={actionBtn("var(--navy)")}
                              title={row.cardSummary ?? "Charge card"}
                            >
                              Charge
                            </button>
                          ) : (
                            <button
                              disabled
                              style={actionBtn(undefined, true)}
                              title="No card on file"
                            >
                              No Card
                            </button>
                          )}
                          <button
                            onClick={() => handleRowEmail(row)}
                            style={actionBtn("var(--sage)")}
                            title="Email statement"
                          >
                            Email
                          </button>
                          <button
                            onClick={() => setRowRouteModal(row)}
                            style={actionBtn("#5c6e82")}
                            title="Route to provider for approval"
                          >
                            Route
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Modals ───────────────────────────────────────────────────────── */}
      {routeModal === "bulk" && (
        <RouteProviderModal
          claimIds={selectedRows.map((r) => r.claimId)}
          providers={providers}
          onClose={() => setRouteModal(null)}
          onDone={() => {
            setRouteModal(null);
            setSelectedIds(new Set());
            setToast(`${selectedRows.length} claim(s) routed to provider`);
            load();
          }}
        />
      )}

      {rowRouteModal && (
        <RowRouteModal
          row={rowRouteModal}
          providers={providers}
          onClose={() => setRowRouteModal(null)}
          onDone={() => {
            setRowRouteModal(null);
            setToast(`${rowRouteModal.clientName}'s claim routed to provider`);
            load();
          }}
        />
      )}

      {/* ── Toast ────────────────────────────────────────────────────────── */}
      {toast && <Toast msg={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}

// ─── Shared Styles ────────────────────────────────────────────────────────────

const thStyle: React.CSSProperties = {
  padding: "8px 10px",
  textAlign: "left",
  fontSize: 10,
  fontWeight: 700,
  color: "var(--muted)",
  textTransform: "uppercase",
  letterSpacing: ".05em",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "9px 10px",
  verticalAlign: "middle",
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function actionBtn(
  bg?: string,
  disabled?: boolean,
): React.CSSProperties {
  return {
    padding: "4px 8px",
    border: "none",
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 700,
    background: disabled ? "var(--line)" : (bg ?? "var(--navy)"),
    color: disabled ? "var(--muted)" : "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
    letterSpacing: ".03em",
    textTransform: "uppercase",
  };
}
