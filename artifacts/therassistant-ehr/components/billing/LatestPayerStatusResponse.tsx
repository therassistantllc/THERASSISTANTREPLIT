"use client";

import { useCallback, useEffect, useState } from "react";
import PayerStatusResponseModal from "./PayerStatusResponseModal";
import { InlineSpinner } from "./InlineSpinner";

type InquirySummary = {
  id: string | null;
  status: string | null;
  status_code: string | null;
  status_text: string | null;
  requested_at: string | null;
  received_at: string | null;
  created_at: string | null;
  triggered_by_display_name: string | null;
};

type LineSummary = {
  total_charge_amount: number | null;
  paid_amount: number | null;
  check_eft_number: string | null;
  payer_claim_control_number: string | null;
};

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

// Claim statuses where a fresh 276/277 makes sense: the claim is out the door
// and we're waiting on (or want to refresh) the payer's word on it. Mirrors
// the same set the No-Response workqueue runs against.
const STATUS_CHECK_ELIGIBLE_STATUSES = new Set([
  "submitted",
  "accepted_oa",
  "accepted_payer",
]);

/**
 * LatestPayerStatusResponse
 *
 * Inline card showing the most recent 276/277 claim status response for a
 * single claim — the headline status, paid/billed, and check/EFT pulled from
 * the first STC line — with a "View full response" button that opens the
 * same modal used by the No-Response workqueue.
 *
 * When the claim is in a state that supports a status check and we know the
 * client/client, the card also exposes a "Check status now" action that
 * fires a fresh 276 inquiry through the same Availity endpoint the
 * No-Response workqueue uses and then re-fetches the latest response so the
 * card refreshes inline.
 */
export default function LatestPayerStatusResponse({
  claimId,
  organizationId,
  claimStatus,
  patientId,
}: {
  claimId: string;
  organizationId: string;
  claimStatus?: string | null;
  patientId?: string | null;
}) {
  const [inquiry, setInquiry] = useState<InquirySummary | null>(null);
  const [line, setLine] = useState<LineSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkInfo, setCheckInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!claimId || !organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/billing/claims/${claimId}/status-inquiries?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: "no-store" },
      );
      const j = await r.json();
      if (j?.success === false) {
        setError(j.error || "Failed to load payer status");
        setInquiry(null);
        setLine(null);
        return;
      }
      const inquiries = (j?.inquiries ?? []) as InquirySummary[];
      // The list endpoint sorts by created_at desc, so the latest with
      // an id is the freshest inquiry the biller has run.
      const latest = inquiries.find((i) => i.id) ?? null;
      setInquiry(latest);
      if (latest?.id) {
        try {
          const dr = await fetch(
            `/api/billing/claims/${claimId}/status-inquiries/${latest.id}?organizationId=${encodeURIComponent(organizationId)}`,
            { cache: "no-store" },
          );
          const dj = await dr.json();
          if (dj?.success !== false) {
            const lines = (dj?.lines ?? []) as LineSummary[];
            setLine(lines[0] ?? null);
          }
        } catch {
          // The headline card still works without parsed line detail;
          // the user can open the modal for the full breakdown.
        }
      } else {
        setLine(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, [claimId, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const canCheck = Boolean(
    patientId &&
      claimStatus &&
      STATUS_CHECK_ELIGIBLE_STATUSES.has(String(claimStatus).toLowerCase()),
  );

  const runCheckNow = useCallback(async () => {
    if (!canCheck || !patientId) return;
    setChecking(true);
    setCheckError(null);
    setCheckInfo(null);
    try {
      const res = await fetch("/api/clearinghouse/availity/claim-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          clientId: patientId,
          claimId,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        setCheckError(json?.error || `Request failed (${res.status})`);
        return;
      }
      setCheckInfo("Status check sent — refreshing latest response…");
      await load();
      setCheckInfo("Latest payer status response updated.");
    } catch (e) {
      setCheckError(e instanceof Error ? e.message : "Failed to run check");
    } finally {
      setChecking(false);
    }
  }, [canCheck, patientId, organizationId, claimId, load]);

  const cardStyle: React.CSSProperties = {
    border: "1px solid #E5E7EB",
    borderRadius: 8,
    padding: 16,
    background: "#fff",
  };

  const checkButton = canCheck ? (
    <button
      type="button"
      onClick={runCheckNow}
      disabled={checking}
      style={{
        background: checking ? "#E2E8F0" : "#1D4ED8",
        color: checking ? "#475569" : "#fff",
        border: "none",
        borderRadius: 6,
        padding: "6px 12px",
        fontSize: 12,
        fontWeight: 600,
        cursor: checking ? "wait" : "pointer",
      }}
    >
      {checking ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <InlineSpinner size={11} thickness={2} ariaLabel="Checking payer status" />
          Checking…
        </span>
      ) : (
        "Check status now"
      )}
    </button>
  ) : null;

  const headerRight = (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      {inquiry?.id ? (
        <button
          type="button"
          onClick={() => setOpenId(inquiry.id)}
          style={{
            background: "transparent",
            border: "none",
            color: "#1D4ED8",
            fontWeight: 600,
            fontSize: 13,
            cursor: "pointer",
            padding: 0,
          }}
        >
          View full response →
        </button>
      ) : null}
      {checkButton}
    </div>
  );

  const checkMessages = (
    <>
      {checkError ? (
        <div style={{ color: "#B91C1C", fontSize: 12, marginTop: 8 }}>
          {checkError}
        </div>
      ) : null}
      {checkInfo && !checkError ? (
        <div style={{ color: "#047857", fontSize: 12, marginTop: 8 }}>
          {checkInfo}
        </div>
      ) : null}
    </>
  );

  if (loading) {
    return (
      <section style={cardStyle}>
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <strong style={{ fontSize: 14 }}>Latest payer status response</strong>
          {checkButton}
        </header>
        <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>
        {checkMessages}
      </section>
    );
  }

  if (error) {
    return (
      <section style={cardStyle}>
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <strong style={{ fontSize: 14 }}>Latest payer status response</strong>
          {checkButton}
        </header>
        <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>
        {checkMessages}
      </section>
    );
  }

  if (!inquiry) {
    return (
      <section style={cardStyle}>
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <strong style={{ fontSize: 14 }}>Latest payer status response</strong>
          {checkButton}
        </header>
        <div style={{ color: "#94A3B8", fontSize: 13 }}>
          No payer status inquiries have been run for this claim yet.
        </div>
        {checkMessages}
      </section>
    );
  }

  const when =
    inquiry.received_at ?? inquiry.requested_at ?? inquiry.created_at;
  const headline = inquiry.status ?? "unknown";
  const code = inquiry.status_code ? ` · ${inquiry.status_code}` : "";

  return (
    <section style={cardStyle}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 14 }}>Latest payer status response</strong>
        {headerRight}
      </header>
      <div
        style={{
          fontSize: 12,
          color: "#6B7280",
          marginBottom: 4,
        }}
      >
        {formatDateTime(when)}
        {inquiry.triggered_by_display_name
          ? ` · ${inquiry.triggered_by_display_name}`
          : ""}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: "#0F172A" }}>
        {headline}
        {code}
      </div>
      {inquiry.status_text ? (
        <div style={{ fontSize: 13, color: "#475569", marginTop: 4 }}>
          {inquiry.status_text}
        </div>
      ) : null}
      {line ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "4px 12px",
            marginTop: 10,
            fontSize: 12,
            color: "#475569",
          }}
        >
          {line.total_charge_amount != null ? (
            <>
              <strong>Billed</strong>
              <span>{formatCurrency(line.total_charge_amount)}</span>
            </>
          ) : null}
          {line.paid_amount != null ? (
            <>
              <strong>Paid</strong>
              <span>{formatCurrency(line.paid_amount)}</span>
            </>
          ) : null}
          {line.check_eft_number ? (
            <>
              <strong>Check / EFT</strong>
              <span style={{ fontFamily: "ui-monospace, monospace" }}>
                {line.check_eft_number}
              </span>
            </>
          ) : null}
          {line.payer_claim_control_number ? (
            <>
              <strong>Payer claim #</strong>
              <span style={{ fontFamily: "ui-monospace, monospace" }}>
                {line.payer_claim_control_number}
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      {checkMessages}
      {openId ? (
        <PayerStatusResponseModal
          claimId={claimId}
          inquiryId={openId}
          organizationId={organizationId}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </section>
  );
}
