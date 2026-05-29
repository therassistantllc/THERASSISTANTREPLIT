"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

type StaffMember = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  isActive: boolean;
  roles: Array<{ id: string; code: string; name: string }>;
  providerId: string | null;
  providerName: string | null;
};

type RoleOption = { id: string; code: string; name: string };
type OrgOption = { id: string; name: string };
type ProviderOption = { id: string; userId: string | null; name: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  clinician: "Clinician",
  biller: "Biller",
  supervisor: "Supervisor",
  support: "Support",
  read_only: "Read-only",
};

function roleBadge(code: string) {
  const colors: Record<string, { bg: string; color: string }> = {
    admin:      { bg: "#EEF2FF", color: "#4338CA" },
    clinician:  { bg: "#F0FDF4", color: "#166534" },
    biller:     { bg: "#FFF7ED", color: "#C2410C" },
    supervisor: { bg: "#F0F9FF", color: "#0369A1" },
    support:    { bg: "#F9FAFB", color: "#374151" },
    read_only:  { bg: "#F9FAFB", color: "#6B7280" },
  };
  const s = colors[code] ?? { bg: "#F3F4F6", color: "#374151" };
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      background: s.bg,
      color: s.color,
    }}>
      {ROLE_LABELS[code] ?? code}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function UsersSettingsClient({ apiEnabled = true }: { apiEnabled?: boolean }) {
  const [members, setMembers] = useState<StaffMember[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-user modal state
  const [addOpen, setAddOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [orgId, setOrgId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [sendInvite, setSendInvite] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);

  // Status toggle busy state
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!apiEnabled) {
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [membersRes, orgsRes] = await Promise.all([
        fetch("/api/admin/security/members", { cache: "no-store" }),
        fetch("/api/admin/organizations", { cache: "no-store" }).catch(() => ({ ok: false, json: async () => ({}) })),
      ]);

      if (membersRes.status === 401) {
        throw new Error("Sign in to manage users.");
      }
      if (!membersRes.ok) {
        const j = await membersRes.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? "Failed to load members");
      }
      const membersJson = await membersRes.json();
      const currentOrgId = String(membersJson.organizationId ?? "").trim();

      setMembers(membersJson.members ?? []);
      setRoles(membersJson.roles ?? []);

      let loadedOrgs: OrgOption[] = [];
      if ((orgsRes as Response).ok) {
        const orgsJson = await (orgsRes as Response).json();
        loadedOrgs = (orgsJson.organizations ?? []) as OrgOption[];
        setOrgs(loadedOrgs);
      }

      // Load providers (for "assigned clinician" dropdown) using the current org.
      const providerOrgId = currentOrgId || loadedOrgs[0]?.id || "";
      const provRes = await fetch(
        providerOrgId
          ? `/api/providers?organizationId=${encodeURIComponent(providerOrgId)}`
          : "/api/providers",
        { cache: "no-store" },
      ).catch(() => null);
      if (provRes?.ok) {
        const provJson = await provRes.json();
        if (Array.isArray(provJson.providers)) {
          setProviders(
            (provJson.providers as { id: string; user_id?: string | null; provider_name?: string; display_name?: string }[]).map((p) => ({
              id: p.id,
              userId: p.user_id ?? null,
              name: p.provider_name ?? p.display_name ?? p.id,
            })),
          );
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [apiEnabled]);

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function resetForm() {
    setFirstName(""); setLastName(""); setEmail("");
    setRoleId(""); setOrgId(""); setProviderId("");
    setIsActive(true); setSendInvite(true);
    setSubmitError(null); setSubmitSuccess(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setSubmitSuccess(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim(),
        role_id: roleId,
        send_invite: sendInvite,
      };
      if (orgId) body.organization_id = orgId;
      if (providerId) body.provider_id = providerId;
      if (!isActive) body.is_active = false;

      const res = await fetch("/api/admin/security/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error((json as { error?: string }).error ?? "Invite failed");
      setSubmitSuccess(`Invite sent to ${email.trim()}.`);
      resetForm();
      await load();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Failed to invite user");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(member: StaffMember) {
    setTogglingId(member.id);
    try {
      const res = await fetch(`/api/admin/security/members/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !member.isActive }),
      });
      if (res.ok) await load();
    } catch { /* non-fatal */ }
    setTogglingId(null);
  }

  async function syncClinicianUsers() {
    setSyncBusy(true);
    setSubmitError(null);
    setSubmitSuccess(null);
    try {
      const res = await fetch("/api/admin/security/sync-clinicians", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw new Error((json as { error?: string }).error ?? "Failed to sync clinician users");
      }
      const created = Number((json as { created?: number }).created ?? 0);
      const roleAssigned = Number((json as { roleAssigned?: number }).roleAssigned ?? 0);
      setSubmitSuccess(`Clinician sync complete: created ${created} user(s), assigned clinician role to ${roleAssigned} user(s).`);
      await load();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Failed to sync clinician users");
    } finally {
      setSyncBusy(false);
    }
  }

  return (
    <main className="app-shell">
      {/* ── Header ── */}
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Users</h1>
          <p className="hero-copy">Manage all users, including clinicians/providers, roles, and access.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/settings">← Settings</Link>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void syncClinicianUsers()}
            disabled={syncBusy || !apiEnabled}
          >
            {syncBusy ? "Syncing…" : "Sync Clinicians"}
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={!apiEnabled}
            onClick={() => { resetForm(); setAddOpen(true); }}
          >
            + Add User
          </button>
        </div>
      </section>

      {error ? (
        <section className="panel" role="alert" style={{ borderLeft: "4px solid #DC2626" }}>
          <p style={{ color: "#DC2626" }}>{error}</p>
          <button type="button" className="button button-secondary" onClick={load}>Retry</button>
        </section>
      ) : null}

      {!apiEnabled ? (
        <section className="panel" role="status" style={{ borderLeft: "4px solid #2563EB" }}>
          <p style={{ color: "#1E40AF", margin: 0 }}>
            Sign in to use Users setup. This preview is visible in development, but user management actions require an authenticated admin session.
          </p>
        </section>
      ) : null}

      {submitSuccess ? (
        <section className="panel" style={{ borderLeft: "4px solid #059669", marginBottom: 0 }}>
          <p style={{ color: "#059669" }}>{submitSuccess}</p>
        </section>
      ) : null}

      {/* ── User table ── */}
      <section className="panel">
        {loading ? (
          <p style={{ color: "var(--text-secondary)" }}>Loading users…</p>
        ) : members.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>No users found. Add your first user above.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--line, #E2E8F0)" }}>
                  <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600, color: "#475569" }}>Name</th>
                  <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600, color: "#475569" }}>Email</th>
                  <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600, color: "#475569" }}>Role</th>
                  <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600, color: "#475569" }}>Provider link</th>
                  <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600, color: "#475569" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} style={{ borderBottom: "1px solid var(--line, #F1F5F9)" }}>
                    <td style={{ padding: "10px 12px", fontWeight: 600, color: "#0F172A" }}>
                      {[m.firstName, m.lastName].filter(Boolean).join(" ") || "—"}
                    </td>
                    <td style={{ padding: "10px 12px", color: "#475569" }}>{m.email ?? "—"}</td>
                    <td style={{ padding: "10px 12px" }}>
                      {m.roles.map((r) => (
                        <span key={r.id} style={{ marginRight: 4 }}>{roleBadge(r.code)}</span>
                      ))}
                      {m.roles.length === 0 ? <span style={{ color: "#94A3B8" }}>—</span> : null}
                    </td>
                    <td style={{ padding: "10px 12px", color: "#475569" }}>{m.providerName ?? "—"}</td>
                    <td style={{ padding: "10px 12px" }}>
                      <button
                        type="button"
                        disabled={togglingId === m.id}
                        onClick={() => void toggleActive(m)}
                        style={{
                          padding: "3px 10px",
                          borderRadius: 999,
                          border: "none",
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: "pointer",
                          background: m.isActive ? "#DCFCE7" : "#FEE2E2",
                          color: m.isActive ? "#166534" : "#991B1B",
                        }}
                      >
                        {togglingId === m.id ? "…" : m.isActive ? "Active" : "Inactive"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Add User modal ── */}
      {addOpen ? (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setAddOpen(false)}
        >
          <div
            style={{ background: "#fff", borderRadius: 10, width: "100%", maxWidth: 520, padding: 32, boxShadow: "0 8px 40px rgba(0,0,0,.18)", maxHeight: "90vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Add User</h2>
              <button type="button" onClick={() => setAddOpen(false)} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#64748B" }}>×</button>
            </div>

            {submitError ? (
              <div style={{ padding: "8px 12px", background: "#FEF2F2", color: "#991B1B", borderRadius: 6, marginBottom: 16, fontSize: 13 }}>{submitError}</div>
            ) : null}

            <form onSubmit={(e) => void handleSubmit(e)} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Name row */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#374151" }}>
                  First name *
                  <input
                    required
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 14 }}
                    placeholder="First"
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#374151" }}>
                  Last name *
                  <input
                    required
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 14 }}
                    placeholder="Last"
                  />
                </label>
              </div>

              {/* Email */}
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#374151" }}>
                Email *
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 14 }}
                  placeholder="name@example.com"
                />
              </label>

              {/* Role */}
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#374151" }}>
                Role *
                <select
                  required
                  value={roleId}
                  onChange={(e) => setRoleId(e.target.value)}
                  style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 14 }}
                >
                  <option value="">Select a role…</option>
                  {roles.length > 0
                    ? roles.map((r) => (
                        <option key={r.id} value={r.id}>{ROLE_LABELS[r.code] ?? r.name}</option>
                      ))
                    : Object.entries(ROLE_LABELS).map(([code, label]) => (
                        <option key={code} value={code}>{label}</option>
                      ))
                  }
                </select>
              </label>

              {/* Assigned practice */}
              {orgs.length > 0 ? (
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#374151" }}>
                  Assigned practice
                  <select
                    value={orgId}
                    onChange={(e) => setOrgId(e.target.value)}
                    style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 14 }}
                  >
                    <option value="">Default / current org</option>
                    {orgs.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </label>
              ) : null}

              {/* Assigned clinician */}
              {providers.length > 0 ? (
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600, color: "#374151" }}>
                  Assigned clinician / provider link
                  <select
                    value={providerId}
                    onChange={(e) => setProviderId(e.target.value)}
                    style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #CBD5E1", fontSize: 14 }}
                  >
                    <option value="">None</option>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
              ) : null}

              {/* Status */}
              <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, fontWeight: 600, color: "#374151", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  style={{ width: 16, height: 16 }}
                />
                Active (user can log in immediately)
              </label>

              {/* Invite email */}
              <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, fontWeight: 600, color: "#374151", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={sendInvite}
                  onChange={(e) => setSendInvite(e.target.checked)}
                  style={{ width: 16, height: 16 }}
                />
                Send setup / invite email
              </label>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
                <button
                  type="button"
                  onClick={() => setAddOpen(false)}
                  style={{ padding: "9px 18px", borderRadius: 6, border: "1px solid #CBD5E1", background: "#fff", fontWeight: 600, fontSize: 14, cursor: "pointer" }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  style={{
                    padding: "9px 18px",
                    borderRadius: 6,
                    border: "none",
                    background: submitting ? "#94A3B8" : "var(--navy, #0F2D63)",
                    color: "#fff",
                    fontWeight: 600,
                    fontSize: 14,
                    cursor: submitting ? "not-allowed" : "pointer",
                  }}
                >
                  {submitting ? "Sending…" : sendInvite ? "Invite & Create" : "Create User"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </main>
  );
}
