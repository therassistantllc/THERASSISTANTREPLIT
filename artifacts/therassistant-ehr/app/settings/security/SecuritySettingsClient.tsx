"use client";

import Link from "next/link";

const RBAC_SECTIONS = [
  {
    label: "Staff Profiles",
    description: "Manage staff accounts, contact info, and active status.",
    href: "/settings/security",
  },
  {
    label: "Roles & Permissions",
    description: "Define roles (admin, biller, clinician) and assign granular permissions.",
    href: "/settings/security",
  },
  {
    label: "Role Assignments",
    description: "Assign roles to individual staff members.",
    href: "/settings/security",
  },
];

const POLICY_ITEMS = [
  { label: "Password minimum length", value: "8 characters (enforced by Supabase Auth)" },
  { label: "Multi-factor authentication", value: "Configured in Supabase Auth dashboard" },
  { label: "Session expiry", value: "Configured in Supabase Auth dashboard" },
  { label: "Row-level security (RLS)", value: "Enabled via Supabase policies per table" },
];

export default function SecuritySettingsClient() {
  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Security &amp; Access</h1>
          <p className="hero-copy">Role-based access control, staff management, and audit trail configuration.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/settings">← Settings</Link>
        </div>
      </section>

      <section className="panel">
        <h2>Role-Based Access Control</h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginBottom: "var(--space-4)" }}>
          RBAC is enforced server-side via Supabase RLS policies. Staff roles are managed below.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "var(--space-4)" }}>
          {RBAC_SECTIONS.map((section) => (
            <Link key={section.label} href={section.href} style={{ textDecoration: "none" }}>
              <article className="metric-card" style={{ cursor: "pointer", minHeight: "80px" }}>
                <strong>{section.label}</strong>
                <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginTop: "4px" }}>
                  {section.description}
                </span>
              </article>
            </Link>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Security Policy Overview</h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginBottom: "var(--space-4)" }}>
          Authentication and session policies are managed in the{" "}
          <strong>Supabase Auth dashboard</strong>. The table below shows the current configuration context.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {POLICY_ITEMS.map((item) => (
              <tr key={item.label} style={{ borderBottom: "1px solid var(--border-color)" }}>
                <td style={{ padding: "10px 12px", fontWeight: 600, fontSize: "var(--text-sm)", width: "40%" }}>
                  {item.label}
                </td>
                <td style={{ padding: "10px 12px", color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
                  {item.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Audit Logs</h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginBottom: "var(--space-4)" }}>
          All create/update/delete operations on clinical and billing records are logged to the{" "}
          <code>audit_logs</code> table. Logs include the user ID, action type, before/after values, and timestamp.
        </p>
        <div style={{ display: "flex", gap: "var(--space-3)" }}>
          <Link className="button button-secondary" href="/admin/audit-logs">View Audit Logs</Link>
        </div>
      </section>
    </main>
  );
}
