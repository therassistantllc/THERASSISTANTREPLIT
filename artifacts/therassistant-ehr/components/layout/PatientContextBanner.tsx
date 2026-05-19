"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./AppShell.module.css";

type PatientBannerData = {
  name: string;
  dateOfBirth: string | null;
  insurancePlan: string | null;
  eligibilityStatus: string | null;
  openBalance: number;
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
        if (json.success && json.patient) {
          const policies: Array<{ plan_name?: string | null; active_flag?: boolean | null }> = json.insurance?.policies ?? [];
          const primaryPolicy = policies.find((p) => p.active_flag) ?? policies[0] ?? null;
          setData({
            name: json.patient.name,
            dateOfBirth: json.patient.dateOfBirth ?? null,
            insurancePlan: primaryPolicy?.plan_name ?? null,
            eligibilityStatus: json.insurance?.latestEligibility?.eligibility_status ?? null,
            openBalance: json.balance?.total ?? 0,
          });
        }
      })
      .catch(() => { /* silently skip — banner is non-critical */ })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [clientId, organizationId]);

  if (loading) {
    return <div className={styles.patientBannerLoading}>Loading patient…</div>;
  }

  if (!data) {
    return (
      <div className={styles.patientBanner}>
        <span className={styles.patientBannerName}>Patient Chart</span>
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
    <div className={styles.patientBanner} role="banner" aria-label="Patient context">
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
        <span className={styles.patientBannerField} style={{ color: eligColor }}>
          Eligibility: <strong style={{ color: eligColor }}>{elig}</strong>
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
