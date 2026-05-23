"use client";

/**
 * Posted-payment detail page (Task #110, PP-4).
 *
 * Renders a unified detail view for any posted payment regardless of source
 * (ERA-835, manual EOB, or client_payment), plus controls for the four
 * destructive operations: reverse, void, recoup, refund. All actions POST
 * to `/api/billing/payments/posted/[id]/<action>` which route through the
 * posting engine (validation + ledger writes + audit).
 *
 * The composite id format is `era:|cp:|mi:<uuid>` — see the GET route for
 * details.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

type DetailResponse = {
  success: boolean;
  compositeId: string;
  kind: "era_835" | "client_payment" | "insurance_manual";
  paymentId: string;
  sourceTitle: string;
  postingStatus: string;
  totalImpact: number;
  header: Record<string, unknown> | null;
  claim: Record<string, unknown> | null;
  patientInvoice: Record<string, unknown> | null;
  ledgerEntries: Array<Record<string, unknown>>;
  refunds: Array<Record<string, unknown>>;
  recoupments: Array<Record<string, unknown>>;
  workqueueItems: Array<Record<string, unknown>>;
  auditChain: Array<Record<string, unknown>>;
  sourceLink?: { kind: string; id: string; label: string } | null;
  casAdjustments?: unknown;
  error?: string;
};

function fmtCurrency(n: unknown) {
  const num = Number(n ?? 0);
  if (!Number.isFinite(num)) return "—";
  return `$${num.toFixed(2)}`;
}

function fmtDate(s: unknown) {
  if (!s) return "—";
  const d = new Date(String(s));
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString();
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "reversed"
      ? "#b45309"
      : status === "voided"
        ? "#6b7280"
        : status === "blocked"
          ? "#b91c1c"
          : status === "posted"
            ? "#15803d"
            : "#374151";
  return (
    <span
      style={{
        background: `${color}15`,
        color,
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.4,
      }}
    >
      {status || "—"}
    </span>
  );
}

export default function PostedPaymentDetailClient({ compositeId }: { compositeId: string }) {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/billing/payments/posted/${encodeURIComponent(compositeId)}?organizationId=${organizationId}`,
        { cache: "no-store" },
      );
      const j = (await r.json()) as DetailResponse;
      if (!r.ok || !j.success) {
        setError(j.error || `Request failed (${r.status})`);
        setDetail(null);
      } else {
        setDetail(j);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [compositeId, organizationId]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function callAction(
    action: "reverse" | "void" | "recoup" | "refund",
    body: Record<string, unknown>,
  ) {
    setActionBusy(action);
    setActionMsg(null);
    try {
      const r = await fetch(
        `/api/billing/payments/posted/${encodeURIComponent(compositeId)}/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId, ...body }),
        },
      );
      const j = (await r.json()) as { success: boolean; error?: string; errors?: Array<{ message: string }> };
      if (!r.ok || !j.success) {
        const msg =
          j.error ||
          (j.errors && j.errors.length ? j.errors.map((e) => e.message).join("; ") : "Action failed");
        setActionMsg(`Failed: ${msg}`);
      } else {
        setActionMsg(`${action.charAt(0).toUpperCase() + action.slice(1)} succeeded.`);
        await reload();
      }
    } catch (e) {
      setActionMsg(`Failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setActionBusy(null);
    }
  }

  function handleReverse() {
    const reason = window.prompt("Reversal reason (required):", "");
    if (!reason || !reason.trim()) return;
    void callAction("reverse", { reason });
  }
  function handleVoid() {
    const reason = window.prompt("Void reason (required):", "");
    if (!reason || !reason.trim()) return;
    void callAction("void", { reason });
  }
  function handleRecoup() {
    const amtStr = window.prompt("Recoupment amount:", "");
    const amount = Number(amtStr);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const reason = window.prompt("Recoupment reason (required):", "");
    if (!reason || !reason.trim()) return;
    void callAction("recoup", { amount, reason });
  }
  function handleRefund(refundType: "insurance" | "patient") {
    const amtStr = window.prompt(`${refundType === "insurance" ? "Insurance" : "Patient"} refund amount:`, "");
    const amount = Number(amtStr);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const reason = window.prompt("Refund reason (required):", "");
    if (!reason || !reason.trim()) return;
    void callAction("refund", { amount, reason, refundType });
  }

  if (loading) {
    return (
      <main style={{ padding: 24 }}>
        <p>Loading posted payment…</p>
      </main>
    );
  }
  if (error || !detail) {
    return (
      <main style={{ padding: 24 }}>
        <Link href="/billing/payments" style={{ color: "#2563eb" }}>← Back to Payments</Link>
        <h1 style={{ marginTop: 16 }}>Posted payment</h1>
        <p style={{ color: "#b91c1c", marginTop: 12 }}>{error || "Not found."}</p>
      </main>
    );
  }

  const isReversed = detail.postingStatus === "reversed";
  const isVoided = detail.postingStatus === "voided";
  const lifecycleOpen = detail.postingStatus === "posted";

  return (
    <main style={{ padding: 24, maxWidth: 1180, margin: "0 auto" }}>
      <Link href="/billing/payments" style={{ color: "#2563eb" }}>← Back to Payments</Link>

      <header style={{ display: "flex", alignItems: "baseline", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>{detail.sourceTitle}</h1>
        <StatusBadge status={detail.postingStatus} />
        <span style={{ marginLeft: "auto", fontSize: 14, color: "#6b7280" }}>
          ID: <code>{detail.compositeId}</code>
        </span>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 16 }}>
        <Card label="Total impact" value={fmtCurrency(detail.totalImpact)} />
        <Card label="Source kind" value={detail.kind} />
        {detail.claim ? (
          <Card
            label="Claim"
            value={String((detail.claim as { claim_number?: string }).claim_number ?? "—")}
            sub={`Status: ${String((detail.claim as { claim_status?: string }).claim_status ?? "—")}`}
          />
        ) : null}
        {detail.patientInvoice ? (
          <Card
            label="Patient invoice"
            value={String((detail.patientInvoice as { invoice_number?: string }).invoice_number ?? "—")}
            sub={`Balance ${fmtCurrency((detail.patientInvoice as { balance_amount?: number }).balance_amount)}`}
          />
        ) : null}
      </section>

      {/* Source link */}
      {detail.sourceLink ? (
        <p style={{ marginTop: 12, fontSize: 13 }}>
          Source: <strong>{detail.sourceLink.label}</strong>{" "}
          <span style={{ color: "#6b7280" }}>({detail.sourceLink.kind})</span>
        </p>
      ) : null}

      {/* CAS adjustments (CARC/RARC breakdown carried on the source row) */}
      {Array.isArray(detail.casAdjustments) && detail.casAdjustments.length > 0 ? (
        <Section title={`Claim/line adjustments (CARC) — ${detail.casAdjustments.length}`}>
          <Table
            cols={["Group", "Reason", "Amount", "Quantity", "Description"]}
            rows={(detail.casAdjustments as Array<Record<string, unknown>>).map((c) => [
              String(c.group_code ?? c.cas01 ?? "—"),
              String(c.reason_code ?? c.cas02 ?? "—"),
              fmtCurrency(c.amount ?? c.cas03),
              String(c.quantity ?? c.cas04 ?? "—"),
              String(c.description ?? "—"),
            ])}
          />
        </Section>
      ) : null}

      {/* Lifecycle controls */}
      <section style={{ marginTop: 24, padding: 16, background: "#f9fafb", borderRadius: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Actions</h2>
        <p style={{ marginTop: 4, color: "#6b7280", fontSize: 13 }}>
          All actions route through the posting engine (validation + audit). Reverse writes
          paired negative ledger entries. Void is only available for posted payments with
          no ledger impact (use Reverse otherwise).
        </p>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button
            onClick={handleReverse}
            disabled={!lifecycleOpen || actionBusy !== null}
            style={btnStyle(!lifecycleOpen)}
          >
            {actionBusy === "reverse" ? "Reversing…" : "Reverse"}
          </button>
          <button
            onClick={handleVoid}
            disabled={!lifecycleOpen || actionBusy !== null}
            style={btnStyle(!lifecycleOpen)}
          >
            {actionBusy === "void" ? "Voiding…" : "Void"}
          </button>
          {detail.kind !== "insurance_manual" ? (
            <button
              onClick={handleRecoup}
              disabled={!lifecycleOpen || actionBusy !== null}
              style={btnStyle(!lifecycleOpen)}
            >
              {actionBusy === "recoup" ? "Recording…" : "Record Recoupment"}
            </button>
          ) : null}
          {detail.kind === "client_payment" ? (
            <button
              onClick={() => handleRefund("patient")}
              disabled={isVoided || actionBusy !== null}
              style={btnStyle(isVoided)}
            >
              {actionBusy === "refund" ? "Refunding…" : "Refund Patient"}
            </button>
          ) : (
            <button
              onClick={() => handleRefund("insurance")}
              disabled={isVoided || actionBusy !== null}
              style={btnStyle(isVoided)}
            >
              {actionBusy === "refund" ? "Refunding…" : "Refund Insurance"}
            </button>
          )}
        </div>
        {isReversed ? (
          <p style={{ marginTop: 12, fontSize: 13, color: "#b45309" }}>
            This payment has been reversed{" "}
            {(detail.header as { reversal_reason?: string })?.reversal_reason
              ? `("${(detail.header as { reversal_reason?: string }).reversal_reason}")`
              : ""}
            . Ledger contains compensating negative entries.
          </p>
        ) : null}
        {isVoided ? (
          <p style={{ marginTop: 12, fontSize: 13, color: "#6b7280" }}>
            This payment has been voided{" "}
            {(detail.header as { void_reason?: string })?.void_reason
              ? `("${(detail.header as { void_reason?: string }).void_reason}")`
              : ""}
            . No financial impact.
          </p>
        ) : null}
        {actionMsg ? (
          <p style={{ marginTop: 12, fontSize: 13, color: actionMsg.startsWith("Failed") ? "#b91c1c" : "#15803d" }}>
            {actionMsg}
          </p>
        ) : null}
      </section>

      {/* Ledger entries */}
      <Section title={`Posted ledger entries (${detail.ledgerEntries.length})`}>
        {detail.ledgerEntries.length === 0 ? (
          <Empty>No ledger entries.</Empty>
        ) : (
          <Table
            cols={["Type", "Amount", "Group/Reason", "Source", "Description", "Posted"]}
            rows={detail.ledgerEntries.map((e) => [
              String(e.entry_type ?? "—"),
              fmtCurrency(e.amount),
              `${String(e.group_code ?? "")}${e.reason_code ? "/" + String(e.reason_code) : ""}` || "—",
              String(e.source_type ?? "—"),
              String(e.description ?? "—"),
              fmtDate(e.posted_at),
            ])}
          />
        )}
      </Section>

      {/* Refunds */}
      <Section title={`Refunds (${detail.refunds.length})`}>
        {detail.refunds.length === 0 ? (
          <Empty>No refunds against this payment.</Empty>
        ) : (
          <Table
            cols={["Type", "Amount", "Status", "Stripe Refund", "Reason", "Requested", "Issued"]}
            rows={detail.refunds.map((r) => [
              String(r.refund_type ?? "—"),
              fmtCurrency(r.amount),
              String(r.refund_status ?? "—"),
              String(r.stripe_refund_id ?? "—"),
              String(r.reason ?? "—"),
              fmtDate(r.requested_at),
              fmtDate(r.issued_at),
            ])}
          />
        )}
      </Section>

      {/* Recoupments */}
      <Section title={`Recoupments (${detail.recoupments.length})`}>
        {detail.recoupments.length === 0 ? (
          <Empty>No recoupments against this payment.</Empty>
        ) : (
          <Table
            cols={["Amount", "Reason code", "Reason", "Offset ERA", "Recouped"]}
            rows={detail.recoupments.map((r) => [
              fmtCurrency(r.amount),
              String(r.reason_code ?? "—"),
              String(r.reason ?? "—"),
              String(r.offset_era_claim_payment_id ?? "—"),
              fmtDate(r.recouped_at),
            ])}
          />
        )}
      </Section>

      {/* Workqueue items */}
      <Section title={`Workqueue items (${detail.workqueueItems.length})`}>
        {detail.workqueueItems.length === 0 ? (
          <Empty>No workqueue items.</Empty>
        ) : (
          <Table
            cols={["Type", "Status", "Priority", "Title", "Created", "Resolved"]}
            rows={detail.workqueueItems.map((w) => [
              String(w.work_type ?? w.queue_type ?? "—"),
              String(w.status ?? "—"),
              String(w.priority ?? "—"),
              String(w.title ?? "—"),
              fmtDate(w.created_at),
              fmtDate(w.resolved_at),
            ])}
          />
        )}
      </Section>

      {/* Audit chain */}
      <Section title={`Audit history (${detail.auditChain.length})`}>
        {detail.auditChain.length === 0 ? (
          <Empty>No audit entries.</Empty>
        ) : (
          <Table
            cols={["When", "Actor", "Action", "Object", "Summary"]}
            rows={detail.auditChain.map((a) => [
              fmtDate(a.created_at),
              `${String(a.user_role ?? "—")} ${String(a.user_id ?? "")}`.trim(),
              String(a.action ?? "—"),
              `${String(a.object_type ?? "—")} ${String(a.object_id ?? "").slice(0, 8)}`,
              String(a.event_summary ?? "—"),
            ])}
          />
        )}
      </Section>
    </main>
  );
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ padding: 12, border: "1px solid #e5e7eb", borderRadius: 8 }}>
      <div style={{ fontSize: 12, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{value}</div>
      {sub ? <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 13, color: "#6b7280" }}>{children}</p>;
}

function Table({ cols, rows }: { cols: string[]; rows: Array<Array<string>> }) {
  return (
    <div style={{ overflowX: "auto", border: "1px solid #e5e7eb", borderRadius: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead style={{ background: "#f9fafb" }}>
          <tr>
            {cols.map((c) => (
              <th key={c} style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600, color: "#374151" }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderTop: "1px solid #e5e7eb" }}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: "8px 12px", color: "#111827" }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function btnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 14px",
    background: disabled ? "#e5e7eb" : "#2563eb",
    color: disabled ? "#9ca3af" : "white",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
