"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import styles from "./AppShell.module.css";

type PatientBannerData = {
  name: string;
  dateOfBirth: string | null;
  insurancePlan: string | null;
  eligibilityStatus: string | null;
  openBalance: number;
  copay: number | null;
  deductibleRemaining: number | null;
  benefitTier: string | null;
};

function getOrganizationId() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";
}

function formatDob(value: string | null) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
}

function formatMoney(n: number) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

export default function PatientContextBanner({ clientId }: { clientId: string }) {
  const [data, setData] = useState<PatientBannerData | null>(null);
  const [loading, setLoading] = useState(true);
  const organizationId = useMemo(() => getOrganizationId(), []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!organizationId) { setLoading(false); return; }
    let cancelled = false;

    fetch(`/api/patients/${clientId}/summary?organizationId=${encodeURIComponent(organizationId)}`, {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.success && json.client) {
          const policies: Array<{ plan_name?: string | null; active_flag?: boolean | null }> = json.insurance?.policies ?? [];
          const primaryPolicy = policies.find((p) => p.active_flag) ?? policies[0] ?? null;
          const elig = json.insurance?.latestEligibility ?? null;
          const toNum = (v: unknown): number | null => {
            if (v === null || v === undefined || v === "") return null;
            const n = typeof v === "number" ? v : Number(v);
            return Number.isFinite(n) ? n : null;
          };
          setData({
            name: json.client.name,
            dateOfBirth: json.client.dateOfBirth ?? null,
            insurancePlan: primaryPolicy?.plan_name ?? null,
            eligibilityStatus: elig?.eligibility_status ?? null,
            openBalance: json.balance?.total ?? 0,
            copay: toNum(elig?.copay_amount),
            deductibleRemaining: toNum(elig?.deductible_remaining),
            benefitTier: typeof elig?.benefit_tier === "string" ? elig.benefit_tier : null,
          });
        }
      })
      .catch(() => { /* silently skip — banner is non-critical */ })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [clientId, organizationId]);

  if (loading) {
    return <div className={styles.patientBannerLoading}>Loading client…</div>;
  }

  if (!data) {
    return (
      <div className={styles.patientBanner}>
        <span className={styles.patientBannerName}>Client Chart</span>
      </div>
    );
  }

  const dob = formatDob(data.dateOfBirth);
  const elig = data.eligibilityStatus;
  const eligColor =
    elig === "active" ? "#1e5e40" :
    elig === "inactive" ? "#b02020" :
    "#5c6e82";

  return (
    <div className={styles.patientBanner} role="banner" aria-label="Client context">
      <span className={styles.patientBannerName}>{data.name}</span>
      {dob && (
        <span className={styles.patientBannerField}>
          DOB: <strong>{dob}</strong>
        </span>
      )}
      {data.insurancePlan && (
        <span className={styles.patientBannerField}>
          Ins: <strong>{data.insurancePlan}</strong>
        </span>
      )}
      {elig && (
        <Link
          href={`/patients/${clientId}/eligibility?organizationId=${encodeURIComponent(organizationId)}`}
          className={styles.patientBannerField}
          style={{ color: eligColor, textDecoration: "underline" }}
          title="Open eligibility detail"
        >
          Eligibility: <strong style={{ color: eligColor }}>{elig}</strong>
        </Link>
      )}
      {data.copay !== null && (
        <span className={styles.patientBannerField} title="Client copay from latest 271">
          Copay: <strong>{formatMoney(data.copay)}</strong>
        </span>
      )}
      {data.deductibleRemaining !== null && (
        <span className={styles.patientBannerField} title="Deductible remaining from latest 271">
          Deductible left: <strong>{formatMoney(data.deductibleRemaining)}</strong>
        </span>
      )}
      {data.benefitTier && (
        <span className={styles.patientBannerField} title="Benefit tier from latest 271">
          Tier: <strong>{data.benefitTier}</strong>
        </span>
      )}
      {data.openBalance > 0 && (
        <span className={styles.patientBannerField} style={{ color: "#7a5000" }}>
          Balance: <strong style={{ color: "#7a5000" }}>{formatMoney(data.openBalance)}</strong>
        </span>
      )}
    </div>
  );
}
