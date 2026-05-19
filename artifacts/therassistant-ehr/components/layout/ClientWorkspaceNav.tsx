"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import styles from "./ClientWorkspaceNav.module.css";

const clientSections = [
  { label: "Profile & Demographics", slug: "profile", description: "CMS-1500 clean claim verification" },
  { label: "Insurance & Auths", slug: "insurance", description: "Policies, auth countdown, eligibility" },
  { label: "Ledger & Stripe", slug: "balance", description: "Balances, invoices, payment tokens" },
  { label: "Client Mailroom Upload", slug: "mailroom", description: "Quick scan linked to client" },
  { label: "Session Logs", slug: "sessions", description: "DOS, CPT, modifiers, billing status" },
  { label: "Progress Notes", slug: "notes", description: "Protected clinical record" },
];

function hrefFor(clientId: string, slug: string, organizationId: string) {
  const suffix = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";
  if (slug === "profile") return `/clients/${clientId}${suffix}`;
  if (slug === "balance") return `/clients/${clientId}/balance${suffix}`;
  return `/clients/${clientId}/${slug}${suffix}`;
}

function activeFor(pathname: string, clientId: string, slug: string) {
  if (slug === "profile") return pathname === `/clients/${clientId}`;
  if (slug === "balance") return pathname === `/clients/${clientId}/balance`;
  return pathname.startsWith(`/clients/${clientId}/${slug}`);
}

export default function ClientWorkspaceNav({ clientId }: { clientId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const organizationId = searchParams.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || "";

  return (
    <aside className={styles.panel} aria-label="Client workspace navigation">
      <div className={styles.header}>
        <span>Client Workspace</span>
        <small>Contextual chart menu</small>
      </div>
      <nav className={styles.links}>
        {clientSections.map((section) => {
          const isActive = activeFor(pathname, clientId, section.slug);
          return (
            <Link
              key={section.slug}
              className={isActive ? `${styles.link} ${styles.active}` : styles.link}
              href={hrefFor(clientId, section.slug, organizationId)}
            >
              <span>{section.label}</span>
              <small>{section.description}</small>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
