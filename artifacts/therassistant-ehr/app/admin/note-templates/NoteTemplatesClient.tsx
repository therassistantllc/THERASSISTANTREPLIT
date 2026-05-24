"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type NoteTemplate = {
  id: string;
  organization_id: string;
  name: string;
  service_type: string | null;
  cpt_code: string | null;
  default_subjective: string;
  default_objective: string;
  default_assessment: string;
  default_plan: string;
  is_default: boolean;
  created_at?: string;
  updated_at?: string;
};

type DraftTemplate = {
  name: string;
  service_type: string;
  cpt_code: string;
  default_subjective: string;
  default_objective: string;
  default_assessment: string;
  default_plan: string;
  is_default: boolean;
};

const EMPTY_DRAFT: DraftTemplate = {
  name: "",
  service_type: "",
  cpt_code: "",
  default_subjective: "",
  default_objective: "",
  default_assessment: "",
  default_plan: "",
  is_default: false,
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

export default function NoteTemplatesClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftTemplate>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  async function loadTemplates() {
    setError(null);
    try {
      const response = await fetch(
        `/api/note-templates?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: "no-store" },
      );
      const json = (await response.json()) as { success?: boolean; error?: string; templates?: NoteTemplate[] };
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to load note templates");
      setTemplates(json.templates ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load note templates");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  function startCreate() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setMessage(null);
  }

  function startEdit(template: NoteTemplate) {
    setEditingId(template.id);
    setDraft({
      name: template.name,
      service_type: template.service_type ?? "",
      cpt_code: template.cpt_code ?? "",
      default_subjective: template.default_subjective ?? "",
      default_objective: template.default_objective ?? "",
      default_assessment: template.default_assessment ?? "",
      default_plan: template.default_plan ?? "",
      is_default: template.is_default,
    });
    setMessage(null);
  }

  async function saveDraft() {
    if (!draft.name.trim()) {
      setError("Template name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const url = editingId
        ? `/api/note-templates?organizationId=${encodeURIComponent(organizationId)}&id=${encodeURIComponent(editingId)}`
        : `/api/note-templates?organizationId=${encodeURIComponent(organizationId)}`;
      const response = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const json = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to save template");
      setMessage(editingId ? "Template updated." : "Template created.");
      setEditingId(null);
      setDraft(EMPTY_DRAFT);
      await loadTemplates();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save template");
    } finally {
      setSaving(false);
    }
  }

  async function archiveTemplate(id: string) {
    if (!confirm("Archive this template? Clinicians will no longer see it in the picker.")) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/note-templates?organizationId=${encodeURIComponent(organizationId)}&id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      const json = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to archive template");
      setMessage("Template archived.");
      if (editingId === id) {
        setEditingId(null);
        setDraft(EMPTY_DRAFT);
      }
      await loadTemplates();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to archive template");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Note Templates</h1>
          <p className="hero-copy">
            Per-organization note scaffolding. When a clinician checks in an appointment, the matching template
            pre-populates the draft note&apos;s subjective, objective, assessment, and plan sections.
          </p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/">Home</Link>
          <button className="button" type="button" onClick={startCreate} disabled={saving}>
            New Template
          </button>
        </div>
      </section>

      {error ? <div className="alert-panel">{error}</div> : null}
      {message ? <div className="empty-state success-panel">{message}</div> : null}

      <section className="panel">
        <h2>{editingId ? "Edit Template" : "New Template"}</h2>
        <p className="muted">
          Match templates to appointments by service type label (e.g. &quot;Intake&quot;) or CPT code (e.g. 90791).
          Set one template as the organization default to use when nothing matches.
        </p>

        <div className="template-form">
          <label>
            <span><strong>Template name *</strong></span>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Intake Assessment"
            />
          </label>

          <div className="template-form-row">
            <label>
              <span><strong>Service type</strong></span>
              <input
                type="text"
                value={draft.service_type}
                onChange={(e) => setDraft({ ...draft, service_type: e.target.value })}
                placeholder="e.g. Intake, Individual, Family, Group"
              />
            </label>

            <label>
              <span><strong>CPT / HCPCS code</strong></span>
              <input
                type="text"
                value={draft.cpt_code}
                onChange={(e) => setDraft({ ...draft, cpt_code: e.target.value })}
                placeholder="e.g. 90791"
              />
            </label>
          </div>

          <label>
            <span><strong>Default subjective</strong></span>
            <textarea
              value={draft.default_subjective}
              onChange={(e) => setDraft({ ...draft, default_subjective: e.target.value })}
              rows={6}
              placeholder="Chief complaint, history, symptoms…"
            />
          </label>

          <label>
            <span><strong>Default objective</strong></span>
            <textarea
              value={draft.default_objective}
              onChange={(e) => setDraft({ ...draft, default_objective: e.target.value })}
              rows={6}
              placeholder="Observations, mental status, vital signs, exam findings…"
            />
          </label>

          <label>
            <span><strong>Default assessment</strong></span>
            <textarea
              value={draft.default_assessment}
              onChange={(e) => setDraft({ ...draft, default_assessment: e.target.value })}
              rows={6}
              placeholder="Clinical assessment, diagnosis, impression…"
            />
          </label>

          <label>
            <span><strong>Default plan</strong></span>
            <textarea
              value={draft.default_plan}
              onChange={(e) => setDraft({ ...draft, default_plan: e.target.value })}
              rows={6}
              placeholder="Treatment plan, follow-up, referrals…"
            />
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.is_default}
              onChange={(e) => setDraft({ ...draft, is_default: e.target.checked })}
            />
            <span>Use this template when no other template matches</span>
          </label>

          <div className="form-actions">
            <button className="button" type="button" onClick={saveDraft} disabled={saving}>
              {editingId ? "Save Changes" : "Create Template"}
            </button>
            {editingId ? (
              <button
                className="button button-secondary"
                type="button"
                onClick={() => { setEditingId(null); setDraft(EMPTY_DRAFT); }}
                disabled={saving}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Existing Templates</h2>
        {loading ? <div className="empty-state">Loading templates…</div> : null}
        {!loading && templates.length === 0 ? (
          <div className="empty-state">No templates yet. Create one above to give clinicians a head start.</div>
        ) : null}

        {templates.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Service type</th>
                <th>CPT</th>
                <th>Default</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((template) => (
                <tr key={template.id}>
                  <td>{template.name}</td>
                  <td>{template.service_type || "—"}</td>
                  <td>{template.cpt_code || "—"}</td>
                  <td>{template.is_default ? <span className="status status-green">Default</span> : "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="button button-secondary button-small"
                      type="button"
                      onClick={() => startEdit(template)}
                      disabled={saving}
                    >
                      Edit
                    </button>
                    <button
                      className="button button-secondary button-small"
                      type="button"
                      onClick={() => archiveTemplate(template.id)}
                      disabled={saving}
                      style={{ marginLeft: "0.5rem" }}
                    >
                      Archive
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <style jsx>{`
        .template-form {
          display: flex;
          flex-direction: column;
          gap: 1rem;
          margin-top: 1rem;
        }
        .template-form label {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }
        .template-form input,
        .template-form textarea {
          padding: 0.6rem;
          border: 1px solid var(--line);
          border-radius: 4px;
          font-family: inherit;
        }
        .template-form textarea {
          font-family: inherit;
          font-size: 0.9rem;
        }
        .template-form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1rem;
        }
        .checkbox-row {
          flex-direction: row !important;
          align-items: center;
          gap: 0.5rem !important;
        }
        .form-actions {
          display: flex;
          gap: 0.75rem;
        }
        .data-table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 1rem;
        }
        .data-table th,
        .data-table td {
          text-align: left;
          padding: 0.6rem 0.5rem;
          border-bottom: 1px solid var(--line);
        }
        .button-small {
          padding: 0.4rem 0.8rem;
          font-size: 0.875rem;
        }
        @media (max-width: 640px) {
          .template-form-row { grid-template-columns: 1fr; }
        }
      `}</style>
    </main>
  );
}
