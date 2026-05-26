import Link from "next/link";

const SETTINGS_SECTIONS = [
  {
    label: "Organizations",
    href: "/settings/organizations",
    description: "List, add, and edit your organizations — practice name, NPI, tax ID, billing address, and provider assignments.",
  },
  {
    label: "Staff & Users",
    href: "/settings/security",
    description: "Manage staff accounts, roles, and access permissions.",
  },
  {
    label: "Provider Credentialing",
    href: "/settings/providers",
    description: "Credentialing profiles, payer enrollments, and network status.",
  },
  {
    label: "Clearinghouse / Availity",
    href: "/settings/clearinghouse",
    description: "Clearinghouse connection settings and test submission tools.",
  },
  {
    label: "Payer Profiles",
    href: "/settings/payers",
    description: "Payer IDs, enrollment status, and Availity payer mappings.",
  },
  {
    label: "Service Locations",
    href: "/settings/service-locations",
    description: "Practice locations, place-of-service codes, and NPI assignments.",
  },
  {
    label: "Billing Defaults",
    href: "/settings/billing-defaults",
    description: "Default diagnosis codes, fee schedules, and billing rules.",
  },
  {
    label: "Reference Code Sets",
    href: "/settings/code-sets",
    description: "When ICD-10-CM, HCPCS, and CPT reference data were last loaded — flags stale releases.",
  },
  {
    label: "Note Templates",
    href: "/admin/note-templates",
    description: "Pre-populated note scaffolding per service type or CPT so clinicians don't start from blank.",
  },
  {
    label: "Payer Rules",
    href: "/admin/payer-rules",
    description: "Auto-flag claims when payers respond with specific RARC/CARC codes so billers can react faster.",
  },
  {
    label: "Security",
    href: "/settings/security",
    description: "Password policy, two-factor authentication, and audit logs.",
  },
  {
    label: "Mail Room Settings",
    href: "/settings/mailroom",
    description: "Mail routing rules, document categories, and filing workflows.",
  },
  {
    label: "System Readiness",
    href: "/settings/system-readiness",
    description: "Configuration checklist — verify the system is ready to generate and submit claims.",
  },
  {
    label: "Settings Audit Log",
    href: "/settings/audit-log",
    description: "One place to see who changed any system setting — billing defaults, 277CA auto-routing, payer connections. Filter by setting, user, and date.",
  },
];

export default function SettingsPage() {
  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Practice Settings</h1>
          <p className="hero-copy">Manage your practice configuration, users, credentialing, and billing defaults.</p>
        </div>
      </section>

      <section className="metric-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
        {SETTINGS_SECTIONS.map((section) => (
          <Link key={section.label} href={section.href} style={{ textDecoration: "none" }}>
            <article className="metric-card" style={{ cursor: "pointer", minHeight: "96px" }}>
              <strong>{section.label}</strong>
              <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginTop: "4px" }}>
                {section.description}
              </span>
            </article>
          </Link>
        ))}
      </section>
    </main>
  );
}
