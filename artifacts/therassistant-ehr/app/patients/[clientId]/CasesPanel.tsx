"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Priority = "primary" | "secondary" | "tertiary";

type CaseType =
  | "commercial"
  | "medicaid"
  | "medicare"
  | "workers_comp"
  | "charity"
  | "self_pay"
  | "other";

interface CasePolicy {
  id: string;
  policyId: string;
  priority: Priority;
  planName: string | null;
  payerName: string | null;
  policyNumber: string | null;
  activeFlag: boolean;
}

interface CaseRecord {
  id: string;
  name: string;
  caseType: CaseType;
  notes: string | null;
  activeFlag: boolean;
  isDefault: boolean;
  archivedAt: string | null;
  policies: CasePolicy[];
}

interface PolicyOption {
  id: string;
  plan_name?: string | null;
  policy_number?: string | null;
  priority?: string | null;
  payer_name?: string | null;
}

const CASE_TYPE_LABELS: Record<CaseType, string> = {
  commercial: "Commercial",
  medicaid: "Medicaid",
  medicare: "Medicare",
  workers_comp: "Workers Comp",
  charity: "Charity",
  self_pay: "Self-pay",
  other: "Other",
};

const PRIORITIES: Priority[] = ["primary", "secondary", "tertiary"];

export default function CasesPanel({
  clientId,
  organizationId,
  availablePolicies,
}: {
  clientId: string;
  organizationId: string;
  availablePolicies: PolicyOption[];
}) {
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<CaseType>("commercial");
  const [newNotes, setNewNotes] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ name: string; caseType: CaseType; notes: string }>({
    name: "",
    caseType: "commercial",
    notes: "",
  });

  const orgQ = useMemo(
    () => `?organizationId=${encodeURIComponent(organizationId)}`,
    [organizationId],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/cases${orgQ}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Failed to load cases");
      setCases(json.cases ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load cases");
    } finally {
      setLoading(false);
    }
  }, [clientId, orgQ]);

  useEffect(() => {
    void load();
  }, [load]);

  async function callCase(method: string, path: string, body?: unknown) {
    setBusy(path);
    setError(null);
    try {
      const init: RequestInit = {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify({ organizationId, ...(body as object) }) : undefined,
      };
      const res = await fetch(path, init);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        const msg =
          json.error ??
          (Array.isArray(json.errors)
            ? json.errors.map((e: { message?: string }) => e.message).join("; ")
            : "Request failed");
        throw new Error(msg);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate() {
    if (!newName.trim()) {
      setError("Case name is required.");
      return;
    }
    await callCase("POST", `/api/clients/${clientId}/cases`, {
      name: newName.trim(),
      caseType: newType,
      notes: newNotes.trim() || null,
    });
    setShowCreate(false);
    setNewName("");
    setNewType("commercial");
    setNewNotes("");
  }

  function startEdit(c: CaseRecord) {
    setEditingId(c.id);
    setEditDraft({ name: c.name, caseType: c.caseType, notes: c.notes ?? "" });
  }

  async function saveEdit(c: CaseRecord) {
    await callCase("PATCH", `/api/clients/${clientId}/cases/${c.id}`, {
      name: editDraft.name.trim(),
      caseType: editDraft.caseType,
      notes: editDraft.notes.trim() || null,
    });
    setEditingId(null);
  }

  async function toggleActive(c: CaseRecord) {
    await callCase("PATCH", `/api/clients/${clientId}/cases/${c.id}`, {
      activeFlag: !c.activeFlag,
    });
  }

  async function setDefault(c: CaseRecord) {
    await callCase("PATCH", `/api/clients/${clientId}/cases/${c.id}`, { isDefault: true });
  }

  async function archive(c: CaseRecord) {
    if (typeof window !== "undefined" && !window.confirm(`Archive case "${c.name}"?`)) return;
    await callCase("DELETE", `/api/clients/${clientId}/cases/${c.id}${orgQ}`);
  }

  async function attachPolicy(caseId: string, policyId: string, priority: Priority) {
    await callCase("POST", `/api/clients/${clientId}/cases/${caseId}/policies`, {
      policyId,
      priority,
    });
  }

  async function detachPolicy(caseId: string, policyId: string) {
    if (typeof window !== "undefined" && !window.confirm("Detach this policy from the case?")) return;
    await callCase("DELETE", `/api/clients/${clientId}/cases/${caseId}/policies/${policyId}${orgQ}`);
  }

  if (loading) return <div className="empty-state">Loading cases…</div>;

  return (
    <section className="content-card">
      <header className="content-card-header">
        <div>
          <h2>Cases</h2>
          <p className="content-card-subtitle">
            Group insurance coverage by visit. Tag appointments and claims with the case they should be billed under.
          </p>
        </div>
        <button
          type="button"
          className="button"
          onClick={() => setShowCreate((v) => !v)}
          disabled={Boolean(busy)}
        >
          {showCreate ? "Cancel" : "New case"}
        </button>
      </header>

      {error ? <div className="alert-panel">{error}</div> : null}

      {showCreate ? (
        <div className="content-card-section" style={{ display: "grid", gap: "0.5rem", padding: "0.75rem 0" }}>
          <label>
            <span>Case name</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Medicaid — Colorado Access"
            />
          </label>
          <label>
            <span>Case type</span>
            <select value={newType} onChange={(e) => setNewType(e.target.value as CaseType)}>
              {(Object.keys(CASE_TYPE_LABELS) as CaseType[]).map((t) => (
                <option key={t} value={t}>
                  {CASE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Notes</span>
            <textarea
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              rows={2}
              placeholder="Optional notes for billers"
            />
          </label>
          <div>
            <button type="button" className="button" onClick={handleCreate} disabled={Boolean(busy)}>
              Create case
            </button>
          </div>
        </div>
      ) : null}

      {cases.length === 0 ? (
        <div className="empty-state">No cases yet. Add one to start tracking coverage by visit.</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.75rem" }}>
          {cases.map((c) => {
            const primary = c.policies.find((p) => p.priority === "primary");
            const usedPriorities = new Set(c.policies.map((p) => p.priority));
            const attachedPolicyIds = new Set(c.policies.map((p) => p.policyId));
            const attachable = availablePolicies.filter((p) => !attachedPolicyIds.has(p.id));
            const isEditing = editingId === c.id;
            return (
              <li
                key={c.id}
                className="content-card-section"
                style={{
                  border: "1px solid var(--border-color, #e5e7eb)",
                  borderRadius: 8,
                  padding: "0.75rem 1rem",
                  background: c.isDefault ? "rgba(59,130,246,0.04)" : undefined,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                  {isEditing ? (
                    <>
                      <input
                        type="text"
                        value={editDraft.name}
                        onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                        style={{ flex: "1 1 220px" }}
                      />
                      <select
                        value={editDraft.caseType}
                        onChange={(e) =>
                          setEditDraft((d) => ({ ...d, caseType: e.target.value as CaseType }))
                        }
                      >
                        {(Object.keys(CASE_TYPE_LABELS) as CaseType[]).map((t) => (
                          <option key={t} value={t}>
                            {CASE_TYPE_LABELS[t]}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <>
                      <strong style={{ fontSize: "1rem" }}>{c.name}</strong>
                      <span className="status">{CASE_TYPE_LABELS[c.caseType]}</span>
                      {c.isDefault ? <span className="status status-green">Default</span> : null}
                      {!c.activeFlag ? <span className="status status-yellow">Inactive</span> : null}
                    </>
                  )}
                </div>

                {isEditing ? (
                  <textarea
                    value={editDraft.notes}
                    onChange={(e) => setEditDraft((d) => ({ ...d, notes: e.target.value }))}
                    rows={2}
                    style={{ width: "100%", marginTop: "0.5rem" }}
                  />
                ) : c.notes ? (
                  <p style={{ margin: "0.25rem 0", color: "var(--muted-color, #6b7280)" }}>{c.notes}</p>
                ) : null}

                <div style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
                  <strong>Primary payer:</strong>{" "}
                  {primary
                    ? primary.payerName ?? primary.planName ?? "—"
                    : c.caseType === "self_pay" || c.caseType === "charity"
                      ? "Patient responsibility"
                      : "Not set"}
                </div>

                {c.policies.length > 0 ? (
                  <ul style={{ listStyle: "none", padding: 0, margin: "0.5rem 0", display: "grid", gap: "0.25rem" }}>
                    {c.policies.map((p) => (
                      <li
                        key={p.id}
                        style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}
                      >
                        <span className="status">{p.priority}</span>
                        <span>{p.payerName ?? p.planName ?? "Policy"}</span>
                        {p.policyNumber ? <span style={{ color: "var(--muted-color, #6b7280)" }}>#{p.policyNumber}</span> : null}
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => detachPolicy(c.id, p.policyId)}
                          disabled={Boolean(busy)}
                        >
                          Detach
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {attachable.length > 0 && PRIORITIES.some((p) => !usedPriorities.has(p)) ? (
                  <AttachPolicyForm
                    onAttach={(policyId, priority) => attachPolicy(c.id, policyId, priority)}
                    availablePolicies={attachable}
                    availablePriorities={PRIORITIES.filter((p) => !usedPriorities.has(p))}
                    disabled={Boolean(busy)}
                  />
                ) : null}

                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                  {isEditing ? (
                    <>
                      <button type="button" className="button" onClick={() => saveEdit(c)} disabled={Boolean(busy)}>
                        Save
                      </button>
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => setEditingId(null)}
                        disabled={Boolean(busy)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => startEdit(c)}
                        disabled={Boolean(busy)}
                      >
                        Edit
                      </button>
                      {!c.isDefault ? (
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => setDefault(c)}
                          disabled={Boolean(busy) || !c.activeFlag || Boolean(c.archivedAt)}
                          title="Mark as the default case for new appointments"
                        >
                          Make default
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => toggleActive(c)}
                        disabled={Boolean(busy)}
                      >
                        {c.activeFlag ? "Mark inactive" : "Mark active"}
                      </button>
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => archive(c)}
                        disabled={Boolean(busy)}
                      >
                        Archive
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function AttachPolicyForm({
  onAttach,
  availablePolicies,
  availablePriorities,
  disabled,
}: {
  onAttach: (policyId: string, priority: Priority) => void | Promise<void>;
  availablePolicies: PolicyOption[];
  availablePriorities: Priority[];
  disabled: boolean;
}) {
  const [policyId, setPolicyId] = useState<string>(availablePolicies[0]?.id ?? "");
  const [priority, setPriority] = useState<Priority>(availablePriorities[0] ?? "primary");

  useEffect(() => {
    if (!availablePolicies.find((p) => p.id === policyId)) {
      setPolicyId(availablePolicies[0]?.id ?? "");
    }
  }, [availablePolicies, policyId]);

  useEffect(() => {
    if (!availablePriorities.includes(priority)) {
      setPriority(availablePriorities[0] ?? "primary");
    }
  }, [availablePriorities, priority]);

  return (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
      <select value={policyId} onChange={(e) => setPolicyId(e.target.value)} disabled={disabled}>
        {availablePolicies.map((p) => (
          <option key={p.id} value={p.id}>
            {p.payer_name ?? p.plan_name ?? "Policy"}
            {p.policy_number ? ` (#${p.policy_number})` : ""}
          </option>
        ))}
      </select>
      <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} disabled={disabled}>
        {availablePriorities.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="button button-secondary"
        disabled={disabled || !policyId}
        onClick={() => policyId && onAttach(policyId, priority)}
      >
        Attach policy
      </button>
    </div>
  );
}
