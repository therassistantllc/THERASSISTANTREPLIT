"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import LatestPayerStatusResponse from "@/components/billing/LatestPayerStatusResponse";
import Claim277caAckSummary from "@/components/billing/Claim277caAckSummary";
import { DEFAULT_ORG_ID } from "@/lib/config";

type Claim = {
  id: string | null;
  claim_number: string | null;
  claim_status: string | null;
  total_charge: number | null;
  patient_responsibility_amount: number | null;
  diagnosis_codes: string[];
  created_at: string | null;
  submitted_at: string | null;
  patient_id: string | null;
  patient_name: string | null;
  encounter_id: string | null;
  appointment_id: string | null;
  payer_profile_id: string | null;
  payer_name: string | null;
  archived_at: string | null;
};

function formatDate(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

function formatMoney(value: number | null) {
  const n = Number(value ?? 0);
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function statusClass(value: string | null) {
  const s = String(value ?? "").toLowerCase();
  if (s.includes("paid") || s.includes("accepted"))
    return "status status-green";
  if (s.includes("denied") || s.includes("rejected") || s.includes("error"))
    return "status status-red";
  if (s.includes("pending") || s.includes("submitted") || s.includes("batch"))
    return "status status-yellow";
  return "status";
}

export default function ClaimDetailClient({ claimId }: { claimId: string }) {
  const searchParams = useSearchParams();
  const orgId =
    searchParams.get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID;

  const [claim, setClaim] = useState<Claim | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!claimId || !orgId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/billing/claims/${encodeURIComponent(claimId)}?organizationId=${encodeURIComponent(orgId)}`,
        { cache: "no-store" },
      );
      const j = (await r.json()) as {
        success: boolean;
        claim?: Claim;
        error?: string;
      };
      if (!j.success || !j.claim) throw new Error(j.error ?? "Failed");
      setClaim(j.claim);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load claim");
    } finally {
      setLoading(false);
    }
  }, [claimId, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const orgQ = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : "";

  return (
    <main className="app-shell">
      <section className="page-header">
        <div>
          <p className="eyebrow">Billing</p>
          <h2>
            Claim{" "}
            {claim?.claim_number ?? (claim?.id ? claim.id.slice(0, 8) : "—")}
          </h2>
        </div>
        <div className="hero-actions">
          {claim?.patient_id ? (
            <Link
              className="button button-secondary"
              href={`/patients/${claim.patient_id}/claims${orgQ}`}
            >
              Back to patient claims
            </Link>
          ) : null}
        </div>
      </section>

      {loading && <div className="empty-state">Loading claim…</div>}
      {error && <div className="alert-panel">{error}</div>}

      {claim ? (
        <>
          <section
            className="panel"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "1rem",
              padding: "1rem",
            }}
          >
            <div>
              <div className="muted" style={{ fontSize: 12 }}>
                Status
              </div>
              <div>
                <span className={statusClass(claim.claim_status)}>
                  {claim.claim_status ?? "—"}
                </span>
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>
                Patient
              </div>
              <div>
                {claim.patient_id ? (
                  <Link
                    className="inline-link"
                    href={`/patients/${claim.patient_id}/claims${orgQ}`}
                  >
                    {claim.patient_name ?? claim.patient_id.slice(0, 8)}
                  </Link>
                ) : (
                  "—"
                )}
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>
                Payer
              </div>
              <div>{claim.payer_name ?? "—"}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>
                Total charge
              </div>
              <div>{formatMoney(claim.total_charge)}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>
                Submitted
              </div>
              <div>
                {claim.submitted_at ? (
                  formatDate(claim.submitted_at)
                ) : (
                  <span className="muted">Not submitted</span>
                )}
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>
                Diagnoses
              </div>
              <div>{claim.diagnosis_codes.join(", ") || "—"}</div>
            </div>
            {claim.encounter_id ? (
              <div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Encounter
                </div>
                <div>
                  <Link
                    className="inline-link"
                    href={`/encounters/${claim.encounter_id}${orgQ}`}
                  >
                    Open encounter
                  </Link>
                </div>
              </div>
            ) : null}
          </section>

          <section style={{ marginTop: "1rem" }}>
            <Claim277caAckSummary
              claimId={claim.id ?? claimId}
              organizationId={orgId}
            />
          </section>

          <section style={{ marginTop: "1rem" }}>
            <LatestPayerStatusResponse
              claimId={claim.id ?? claimId}
              organizationId={orgId}
            />
          </section>
        </>
      ) : null}
    </main>
  );
}
