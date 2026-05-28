"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import styles from "@/components/layout/AppShell.module.css";
import { DEFAULT_ORG_ID } from "@/lib/config";

const PATIENT_TABS = [
  { label: "Summary",     slug: "" },
  { label: "Intake",      slug: "intake" },
  { label: "Visits",      slug: "appointments" },
  { label: "Conditions",  slug: "conditions" },
  { label: "Notes",       slug: "notes" },
  { label: "Documents",   slug: "documents" },
  { label: "Insurance",   slug: "eligibility" },
  { label: "Billing",     slug: "balance" },
  { label: "Claims",      slug: "claims" },
  { label: "Mail Room",   slug: "mailroom" },
  { label: "Workqueue",   slug: "workqueue" },
] satisfies { label: string; slug: string }[];

export default function PatientTabNav({ clientId }: { clientId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const orgId = searchParams.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;

  return (
    <div className={styles.patientTabs} role="navigation" aria-label="Client chart tabs">
      {PATIENT_TABS.map(({ label, slug }) => {
        const base = `/clients/${clientId}${slug ? `/${slug}` : ""}`;
        const href = orgId ? `${base}?organizationId=${encodeURIComponent(orgId)}` : base;
        const active = slug === ""
          ? pathname === `/clients/${clientId}`
          : pathname.startsWith(`/clients/${clientId}/${slug}`);
        return (
          <Link
            key={label}
            href={href}
            className={active ? `${styles.patientTab} ${styles.patientTabActive}` : styles.patientTab}
            aria-current={active ? "page" : undefined}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}
