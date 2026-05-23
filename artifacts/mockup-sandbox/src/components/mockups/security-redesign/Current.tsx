import { Shell } from "./_shared/Shell";

const RBAC_SECTIONS = [
  { label: "Staff Profiles", description: "Manage staff accounts, contact info, and active status." },
  { label: "Roles & Permissions", description: "Define roles (admin, biller, clinician) and assign granular permissions." },
  { label: "Role Assignments", description: "Assign roles to individual staff members." },
];

const POLICY_ITEMS = [
  { label: "Password minimum length", value: "8 characters (enforced by Supabase Auth)" },
  { label: "Multi-factor authentication", value: "Configured in Supabase Auth dashboard" },
  { label: "Session expiry", value: "Configured in Supabase Auth dashboard" },
  { label: "Row-level security (RLS)", value: "Enabled via Supabase policies per table" },
];

export function Current() {
  return (
    <Shell>
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Security &amp; Access</h1>
          <p className="hero-copy">Role-based access control, staff management, and audit trail configuration.</p>
        </div>
        <div className="hero-actions">
          <a className="button button-secondary" href="#">← Settings</a>
        </div>
      </section>

      <section className="panel">
        <h2 style={{ textTransform: "none", letterSpacing: 0, fontSize: 15 }}>Role-Based Access Control</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          RBAC is enforced server-side via Supabase RLS policies. Staff roles are managed below.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 }}>
          {RBAC_SECTIONS.map((s) => (
            <article key={s.label} className="metric-card" style={{ minHeight: 80, cursor: "pointer" }}>
              <strong style={{ display: "block", color: "var(--navy)", fontSize: 15 }}>{s.label}</strong>
              <span className="muted" style={{ display: "block", fontSize: 13, marginTop: 4 }}>{s.description}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2 style={{ textTransform: "none", letterSpacing: 0, fontSize: 15 }}>Security Policy Overview</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          Authentication and session policies are managed in the <strong>Supabase Auth dashboard</strong>. The table below shows the current configuration context.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {POLICY_ITEMS.map((it) => (
              <tr key={it.label} style={{ borderBottom: "1px solid var(--line)" }}>
                <td style={{ padding: "10px 12px", fontWeight: 600, fontSize: 13, width: "40%" }}>{it.label}</td>
                <td className="muted" style={{ padding: "10px 12px", fontSize: 13 }}>{it.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2 style={{ textTransform: "none", letterSpacing: 0, fontSize: 15 }}>Audit Logs</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          All create/update/delete operations on clinical and billing records are logged to the <code>audit_logs</code> table. Logs include the user ID, action type, before/after values, and timestamp.
        </p>
        <div style={{ display: "flex", gap: 12 }}>
          <a className="button button-secondary" href="#">View Audit Logs</a>
        </div>
      </section>
    </Shell>
  );
}
