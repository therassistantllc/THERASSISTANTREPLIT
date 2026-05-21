"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ORGANIZATION_ID } from "@/lib/config";

type Organization = {
  id: string;
  name: string;
  legal_name?: string | null;
  slug?: string | null;
  default_state?: string | null;
  timezone?: string | null;
  is_active?: boolean;
  archived_at?: string | null;
};

type ProviderProfile = {
  id: string;
  provider_name: string;
  credential_display?: string | null;
  email?: string | null;
  individual_npi?: string | null;
  is_active?: boolean;
  organization_id: string;
};

type ProvidersByOrg = Record<string, ProviderProfile[]>;

function activeOrgIdFromClient(): string {
  if (typeof window === "undefined") return ORGANIZATION_ID;
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("organizationId");
  if (fromUrl) return fromUrl;
  try {
    const stored = window.localStorage.getItem("activeOrganizationId");
    if (stored) return stored;
  } catch { /* ignore */ }
  return ORGANIZATION_ID;
}

export default function OrganizationsListClient() {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [providersByOrg, setProvidersByOrg] = useState<ProvidersByOrg>({});
  const [unassigned, setUnassigned] = useState<ProviderProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeOrgId, setActiveOrgId] = useState<string>(ORGANIZATION_ID);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // create-org form
  const [newName, setNewName] = useState("");
  const [newLegal, setNewLegal] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newState, setNewState] = useState("");
  const [newTz, setNewTz] = useState("America/New_York");
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState("");

  // per-org add-provider drafts
  const [draftProvider, setDraftProvider] = useState<Record<string, { name: string; credential: string; email: string; npi: string }>>({});
  const [savingProvider, setSavingProvider] = useState<string | null>(null);
  const [providerMsg, setProviderMsg] = useState<Record<string, string>>({});

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const orgsRes = await fetch("/api/organizations").then(r => r.json()) as { organizations?: Organization[]; error?: string };
      const list = orgsRes.organizations ?? [];
      setOrgs(list);

      const perOrg: ProvidersByOrg = {};
      await Promise.all(list.map(async (o) => {
        const r = await fetch(`/api/organizations/${encodeURIComponent(o.id)}/providers`).then(r => r.json()) as { providers?: ProviderProfile[] };
        perOrg[o.id] = r.providers ?? [];
      }));
      setProvidersByOrg(perOrg);

      // collect provider profiles whose organization_id is not in the list (unassigned/orphaned)
      const knownIds = new Set(list.map(o => o.id));
      const allProfiles = Object.values(perOrg).flat();
      const orphans = allProfiles.filter(p => !knownIds.has(p.organization_id));
      setUnassigned(orphans);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setActiveOrgId(activeOrgIdFromClient());
    loadAll();
  }, [loadAll]);

  const switchActiveOrg = useCallback((id: string) => {
    try { window.localStorage.setItem("activeOrganizationId", id); } catch { /* ignore */ }
    setActiveOrgId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("organizationId", id);
    window.history.replaceState({}, "", url.toString());
  }, []);

  const handleCreateOrg = useCallback(async () => {
    const name = newName.trim();
    if (!name) { setCreateMsg("Name is required."); return; }
    setCreating(true);
    setCreateMsg("");
    try {
      const res = await fetch("/api/organizations/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          legal_name: newLegal.trim() || name,
          slug: newSlug.trim(),
          default_state: newState.trim(),
          timezone: newTz.trim() || "America/New_York",
        }),
      });
      const json = await res.json() as { success?: boolean; error?: string; organizationId?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to create organization");
      setCreateMsg(`Created "${name}".`);
      setNewName(""); setNewLegal(""); setNewSlug(""); setNewState("");
      await loadAll();
      if (json.organizationId) {
        setExpanded(e => ({ ...e, [json.organizationId!]: true }));
      }
    } catch (e) {
      setCreateMsg(e instanceof Error ? e.message : "Failed to create organization");
    } finally {
      setCreating(false);
    }
  }, [newName, newLegal, newSlug, newState, newTz, loadAll]);

  const handleAddProvider = useCallback(async (orgId: string) => {
    const draft = draftProvider[orgId] ?? { name: "", credential: "", email: "", npi: "" };
    const provider_name = draft.name.trim();
    if (!provider_name) {
      setProviderMsg(m => ({ ...m, [orgId]: "Provider name is required." }));
      return;
    }
    setSavingProvider(orgId);
    setProviderMsg(m => ({ ...m, [orgId]: "" }));
    try {
      const res = await fetch(`/api/organizations/${encodeURIComponent(orgId)}/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "create",
          provider_name,
          credential_display: draft.credential.trim() || undefined,
          email: draft.email.trim() || undefined,
          individual_npi: draft.npi.trim() || undefined,
        }),
      });
      const json = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to add provider");
      setProviderMsg(m => ({ ...m, [orgId]: "Provider added." }));
      setDraftProvider(d => ({ ...d, [orgId]: { name: "", credential: "", email: "", npi: "" } }));
      await loadAll();
    } catch (e) {
      setProviderMsg(m => ({ ...m, [orgId]: e instanceof Error ? e.message : "Failed to add provider" }));
    } finally {
      setSavingProvider(null);
    }
  }, [draftProvider, loadAll]);

  const handleAttachProvider = useCallback(async (orgId: string, profileId: string) => {
    setSavingProvider(orgId);
    try {
      const res = await fetch(`/api/organizations/${encodeURIComponent(orgId)}/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "attach", profile_id: profileId }),
      });
      const json = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to move provider");
      await loadAll();
    } catch (e) {
      setProviderMsg(m => ({ ...m, [orgId]: e instanceof Error ? e.message : "Failed to move provider" }));
    } finally {
      setSavingProvider(null);
    }
  }, [loadAll]);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Organizations</h1>
          <p className="hero-copy">Create multiple practice organizations and assign providers to each. The active organization scopes scheduling, billing, and provider lookups across the app.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/settings">← Settings</Link>
        </div>
      </section>

      <section className="panel form-panel">
        <h2>Create a new organization</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
          <label className="field-label">Display name<input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Northside Counseling" /></label>
          <label className="field-label">Legal name (optional)<input value={newLegal} onChange={e => setNewLegal(e.target.value)} placeholder="defaults to display name" /></label>
          <label className="field-label">Slug (optional)<input value={newSlug} onChange={e => setNewSlug(e.target.value)} placeholder="auto-generated if blank" /></label>
          <label className="field-label">Default state<input value={newState} onChange={e => setNewState(e.target.value)} placeholder="CO" maxLength={2} /></label>
          <label className="field-label">Timezone<input value={newTz} onChange={e => setNewTz(e.target.value)} /></label>
        </div>
        <div style={{ marginTop: "var(--space-3)", display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <button className="button button-primary" onClick={handleCreateOrg} disabled={creating || !newName.trim()}>
            {creating ? "Creating…" : "Create organization"}
          </button>
          {createMsg && <span style={{ fontSize: "var(--text-sm)", color: createMsg.startsWith("Created") ? "var(--success, #1f7a3a)" : "var(--danger, #b02020)" }}>{createMsg}</span>}
        </div>
      </section>

      <section className="panel">
        <div style={{ padding: "var(--space-5)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>All organizations ({orgs.length})</h2>
          <span style={{ fontSize: "var(--text-sm)", color: "var(--muted, #5c6e82)" }}>
            Active: <strong>{orgs.find(o => o.id === activeOrgId)?.name ?? "—"}</strong>
          </span>
        </div>

        {loading ? (
          <div className="empty-state" style={{ padding: "var(--space-6)" }}>Loading…</div>
        ) : orgs.length === 0 ? (
          <div className="empty-state" style={{ padding: "var(--space-6)" }}>No organizations yet. Create one above.</div>
        ) : (
          <div style={{ borderTop: "1px solid var(--line, #d8e1e9)" }}>
            {orgs.map(org => {
              const providers = providersByOrg[org.id] ?? [];
              const isExpanded = expanded[org.id] ?? false;
              const isActive = org.id === activeOrgId;
              const draft = draftProvider[org.id] ?? { name: "", credential: "", email: "", npi: "" };
              const setDraftField = (k: "name" | "credential" | "email" | "npi", v: string) =>
                setDraftProvider(d => ({ ...d, [org.id]: { ...(d[org.id] ?? { name: "", credential: "", email: "", npi: "" }), [k]: v } }));

              return (
                <div key={org.id} style={{ borderBottom: "1px solid var(--line, #d8e1e9)", padding: "var(--space-4) var(--space-5)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <strong style={{ fontSize: "var(--text-base, 15px)" }}>{org.name}</strong>
                        {isActive && <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#1f7a3a", background: "#e6f4ec", padding: "2px 6px", borderRadius: 4 }}>ACTIVE</span>}
                        {org.is_active === false && <span style={{ fontSize: 10, fontWeight: 700, color: "#b02020", background: "#fbeaea", padding: "2px 6px", borderRadius: 4 }}>INACTIVE</span>}
                      </div>
                      <div style={{ fontSize: "var(--text-xs, 11px)", color: "var(--muted, #5c6e82)", marginTop: 2 }}>
                        {providers.length} provider{providers.length === 1 ? "" : "s"}
                        {org.slug ? ` · ${org.slug}` : ""}
                        {org.default_state ? ` · ${org.default_state}` : ""}
                        {org.timezone ? ` · ${org.timezone}` : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "var(--space-2)", flexShrink: 0 }}>
                      {!isActive && (
                        <button className="button button-secondary" onClick={() => switchActiveOrg(org.id)}>Make active</button>
                      )}
                      <button className="button button-secondary" onClick={() => setExpanded(e => ({ ...e, [org.id]: !isExpanded }))}>
                        {isExpanded ? "Hide providers" : "Manage providers"}
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div style={{ marginTop: "var(--space-4)", padding: "var(--space-4)", background: "var(--bg-subtle, #f7f9fc)", borderRadius: 6 }}>
                      <h3 style={{ margin: "0 0 var(--space-3) 0", fontSize: "var(--text-sm, 13px)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted, #5c6e82)" }}>Providers in {org.name}</h3>

                      {providers.length === 0 ? (
                        <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginBottom: "var(--space-3)" }}>No providers assigned yet.</div>
                      ) : (
                        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "var(--space-3)" }}>
                          <thead>
                            <tr style={{ textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)" }}>
                              <th style={{ padding: "6px 8px" }}>Name</th>
                              <th style={{ padding: "6px 8px" }}>Credential</th>
                              <th style={{ padding: "6px 8px" }}>NPI</th>
                              <th style={{ padding: "6px 8px" }}>Email</th>
                              <th style={{ padding: "6px 8px" }}>Move to…</th>
                            </tr>
                          </thead>
                          <tbody>
                            {providers.map(p => (
                              <tr key={p.id} style={{ borderTop: "1px solid var(--line)" }}>
                                <td style={{ padding: "6px 8px" }}>{p.provider_name}</td>
                                <td style={{ padding: "6px 8px" }}>{p.credential_display ?? "—"}</td>
                                <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>{p.individual_npi ?? "—"}</td>
                                <td style={{ padding: "6px 8px" }}>{p.email ?? "—"}</td>
                                <td style={{ padding: "6px 8px" }}>
                                  <select
                                    defaultValue=""
                                    onChange={(e) => {
                                      const target = e.target.value;
                                      if (target && target !== org.id) handleAttachProvider(target, p.id);
                                      e.target.value = "";
                                    }}
                                    style={{ fontSize: 12 }}
                                  >
                                    <option value="">— move to another org —</option>
                                    {orgs.filter(o => o.id !== org.id).map(o => (
                                      <option key={o.id} value={o.id}>{o.name}</option>
                                    ))}
                                  </select>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}

                      <div style={{ borderTop: "1px solid var(--line)", paddingTop: "var(--space-3)" }}>
                        <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginBottom: "var(--space-2)" }}>Add a provider to this organization</div>
                        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 2fr 1fr auto", gap: "var(--space-2)", alignItems: "end" }}>
                          <label className="field-label" style={{ margin: 0 }}>Name<input value={draft.name} onChange={e => setDraftField("name", e.target.value)} placeholder="Dr. Jane Smith" /></label>
                          <label className="field-label" style={{ margin: 0 }}>Credential<input value={draft.credential} onChange={e => setDraftField("credential", e.target.value)} placeholder="LPC, LCSW…" /></label>
                          <label className="field-label" style={{ margin: 0 }}>Email<input type="email" value={draft.email} onChange={e => setDraftField("email", e.target.value)} placeholder="jane@example.com" /></label>
                          <label className="field-label" style={{ margin: 0 }}>NPI<input value={draft.npi} onChange={e => setDraftField("npi", e.target.value)} placeholder="10 digits" maxLength={10} /></label>
                          <button className="button button-primary" onClick={() => handleAddProvider(org.id)} disabled={savingProvider === org.id || !draft.name.trim()}>
                            {savingProvider === org.id ? "Saving…" : "Add provider"}
                          </button>
                        </div>
                        {providerMsg[org.id] && (
                          <div style={{ marginTop: 6, fontSize: "var(--text-xs)", color: providerMsg[org.id].includes("added") ? "var(--success, #1f7a3a)" : "var(--danger, #b02020)" }}>
                            {providerMsg[org.id]}
                          </div>
                        )}
                        <div style={{ marginTop: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                          For full credentialing detail (NPIs, payer IDs, telehealth URL, Stripe link), use the per-provider editor on{" "}
                          <Link href={`/settings/providers?organizationId=${encodeURIComponent(org.id)}`}>Provider Settings</Link>.
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {unassigned.length > 0 && (
          <div style={{ padding: "var(--space-4) var(--space-5)", borderTop: "1px solid var(--line)" }}>
            <h3 style={{ margin: "0 0 var(--space-2) 0", fontSize: "var(--text-sm)", color: "#b86a00" }}>
              Orphaned provider profiles ({unassigned.length})
            </h3>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
              These profiles reference an organization id that no longer exists. Use the "Move to…" dropdown to re-home them.
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
