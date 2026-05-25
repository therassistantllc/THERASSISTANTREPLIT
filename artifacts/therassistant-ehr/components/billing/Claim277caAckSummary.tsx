"use client";

import { useEffect, useState } from "react";

type ParsedStc = {
  category: string | null;
  status: string | null;
  entity: string | null;
  message: string | null;
};

type Acknowledgement = {
  id: string;
  edi_batch_id: string;
  file_name: string | null;
  created_at: string | null;
  outcome: string | null;
  matched_claim_ref: {
    trn: string;
    message: string | null;
    stc_statuses: ParsedStc[];
  } | null;
  batch_stc_statuses: ParsedStc[];
};

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function outcomeColor(outcome: string | null): { bg: string; fg: string; border: string } {
  const s = (outcome ?? "").toLowerCase();
  if (s === "rejected") return { bg: "#FEF2F2", fg: "#991B1B", border: "#FECACA" };
  if (s === "partial") return { bg: "#FFFBEB", fg: "#92400E", border: "#FDE68A" };
  if (s === "accepted") return { bg: "#ECFDF5", fg: "#065F46", border: "#A7F3D0" };
  return { bg: "#F1F5F9", fg: "#334155", border: "#CBD5F5" };
}

function formatStcCode(s: ParsedStc): string {
  const parts = [s.category, s.status, s.entity].filter(Boolean) as string[];
  return parts.join(":") || "—";
}

/**
 * Claim277caAckSummary
 *
 * Renders the most recent 277CA acknowledgement message for ONE claim.
 * Prefers the per-claim STC entries from `parsed.claimRefs` matched
 * by TRN02 ↔ patient_account_number / claim_number / id, falling
 * back to the batch-level STC list when this claim's TRN didn't
 * appear in the 2200D loop.
 */
export default function Claim277caAckSummary({
  claimId,
  organizationId,
}: {
  claimId: string;
  organizationId: string;
}) {
  const [ack, setAck] = useState<Acknowledgement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!claimId || !organizationId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(
      `/api/billing/claims/${encodeURIComponent(claimId)}/277ca-status?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.success === false) {
          setError(j.error || "Failed to load 277CA");
          setAck(null);
        } else {
          setAck((j?.acknowledgement ?? null) as Acknowledgement | null);
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
  }, [claimId, organizationId]);

  const cardStyle: React.CSSProperties = {
    border: "1px solid #E5E7EB",
    borderRadius: 8,
    padding: 16,
    background: "#fff",
  };

  if (loading) {
    return (
      <section style={cardStyle}>
        <header style={{ marginBottom: 8 }}>
          <strong style={{ fontSize: 14 }}>Latest 277CA acknowledgement</strong>
        </header>
        <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>
      </section>
    );
  }
  if (error) {
    return (
      <section style={cardStyle}>
        <header style={{ marginBottom: 8 }}>
          <strong style={{ fontSize: 14 }}>Latest 277CA acknowledgement</strong>
        </header>
        <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>
      </section>
    );
  }
  if (!ack) {
    return (
      <section style={cardStyle}>
        <header style={{ marginBottom: 8 }}>
          <strong style={{ fontSize: 14 }}>Latest 277CA acknowledgement</strong>
        </header>
        <div style={{ color: "#94A3B8", fontSize: 13 }}>
          No 277CA has been received for this claim yet.
        </div>
      </section>
    );
  }

  const ref = ack.matched_claim_ref;
  // Per-claim STCs from this claim's own 2200D loop; if the ack didn't
  // slice per claim (eg. older payer that only puts STCs at the
  // transaction level), drop back to the batch-level list so the
  // biller still sees the payer's wording.
  const usingPerClaim = !!ref && (ref.stc_statuses?.length ?? 0) > 0;
  const stcList = usingPerClaim ? ref!.stc_statuses : ack.batch_stc_statuses;
  const headlineMessage =
    (usingPerClaim ? ref!.message : null) ??
    stcList.find((s) => s.message)?.message ??
    null;
  const colors = outcomeColor(ack.outcome);

  return (
    <section style={cardStyle}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
          gap: 8,
        }}
      >
        <strong style={{ fontSize: 14 }}>Latest 277CA acknowledgement</strong>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            padding: "2px 8px",
            borderRadius: 999,
            background: colors.bg,
            color: colors.fg,
            border: `1px solid ${colors.border}`,
          }}
        >
          {ack.outcome ?? "unknown"}
        </span>
      </header>
      <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 8 }}>
        {formatDateTime(ack.created_at)}
        {ack.file_name ? ` · ${ack.file_name}` : ""}
        {usingPerClaim ? (
          <span style={{ marginLeft: 8, color: "#475569" }}>
            · TRN <span style={{ fontFamily: "ui-monospace, monospace" }}>{ref!.trn}</span>
          </span>
        ) : (
          <span style={{ marginLeft: 8, color: "#92400E" }}>
            · No per-claim TRN matched — showing batch-level reason
          </span>
        )}
      </div>

      {headlineMessage ? (
        <div
          style={{
            fontSize: 13,
            color: "#0F172A",
            marginBottom: stcList.length > 0 ? 10 : 0,
            whiteSpace: "pre-wrap",
          }}
        >
          {headlineMessage}
        </div>
      ) : null}

      {stcList.length > 0 ? (
        <div style={{ display: "grid", gap: 6 }}>
          {stcList.map((s, idx) => (
            <div
              key={idx}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: "2px 12px",
                padding: 8,
                borderRadius: 6,
                background: "#F8FAFC",
                border: "1px solid #E2E8F0",
                fontSize: 12,
              }}
            >
              <strong style={{ color: "#475569" }}>STC code</strong>
              <span style={{ fontFamily: "ui-monospace, monospace", color: "#0F172A" }}>
                {formatStcCode(s)}
              </span>
              {s.message ? (
                <>
                  <strong style={{ color: "#475569" }}>Message</strong>
                  <span style={{ color: "#0F172A", whiteSpace: "pre-wrap" }}>
                    {s.message}
                  </span>
                </>
              ) : null}
            </div>
          ))}
        </div>
      ) : !headlineMessage ? (
        <div style={{ color: "#94A3B8", fontSize: 13 }}>
          No STC reason codes were attached to this acknowledgement.
        </div>
      ) : null}
    </section>
  );
}
