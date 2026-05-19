"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import styles from "@/components/layout/AppShell.module.css";

const CLIENT_TABS = [
  { label: "Summary", slug: "" },
  { label: "Appointments", slug: "appointments" },
  { label: "Notes", slug: "notes" },
  { label: "Eligibility", slug: "eligibility" },
  { label: "Claims", slug: "claims" },
  { label: "Balance", slug: "balance" },
  { label: "Documents", slug: "documents" },
  { label: "Workqueue", slug: "workqueue" },
] satisfies { label: string; slug: string }[];

export default function ClientTabNav({ clientId }: { clientId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const orgId = searchParams.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";

  return (
    <div className={styles.patientTabs} role="navigation" aria-label="Client chart tabs">
      {CLIENT_TABS.map(({ label, slug }) => {
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
