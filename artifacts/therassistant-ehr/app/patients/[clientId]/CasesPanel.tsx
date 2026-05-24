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
  payerId: string | null;
  policyNumber: string | null;
  groupNumber: string | null;
  effectiveDate: string | null;
  terminationDate: string | null;
  copayAmount: number | null;
  coinsurancePercent: number | null;
  deductibleAmount: number | null;
  outOfPocketMax: number | null;
  subscriberRelationship: string | null;
  subscriberFirstName: string | null;
  subscriberLastName: string | null;
  subscriberDateOfBirth: string | null;
  subscriberMemberId: string | null;
  subscriberPhone: string | null;
  subscriberAddressLine1: string | null;
  subscriberAddressLine2: string | null;
  subscriberCity: string | null;
  subscriberState: string | null;
  subscriberPostalCode: string | null;
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

interface NewPolicyFields {
  payerId: string;
  planName: string | null;
  policyNumber: string;
  groupNumber: string | null;
  effectiveDate: string | null;
  terminationDate: string | null;
  copayAmount: string | null;
  coinsurancePercent: string | null;
  deductibleAmount: string | null;
  outOfPocketMax: string | null;
  subscriberRelationship: string;
  subscriberFirstName: string | null;
  subscriberLastName: string | null;
  subscriberDateOfBirth: string | null;
  subscriberMemberId: string | null;
  subscriberPhone: string | null;
  subscriberAddressLine1: string | null;
  subscriberAddressLine2: string | null;
  subscriberCity: string | null;
  subscriberState: string | null;
  subscriberPostalCode: string | null;
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
  onMutate,
}: {
  clientId: string;
  organizationId: string;
  availablePolicies: PolicyOption[];
  onMutate?: () => void;
}) {
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ name: string; caseType: CaseType; notes: string }>({
    name: "",
    caseType: "commercial",
    notes: "",
  });
  const [addingPolicyForCaseId, setAddingPolicyForCaseId] = useState<string | null>(null);
  // Cases render collapsed by default — just the name + primary payer
  // summary. Click the row to expand and see attached policies / edit.
  const [expandedCaseIds, setExpandedCaseIds] = useState<Set<string>>(new Set());
  const toggleCaseExpanded = (id: string) =>
    setExpandedCaseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [payers, setPayers] = useState<Array<{ id: string; payer_name: string; payer_id: string | null }>>([]);
  const [providers, setProviders] = useState<Array<{ id: string; provider_name: string }>>([]);

  // Staged "new case" draft. The user adds one or more insurance policies
  // (primary/secondary/tertiary) and a case name, then clicks Save case to
  // commit everything together. Policies are NOT POSTed until save.
  // The "New case" draft shows three inline insurance rows
  // (primary/secondary/tertiary) always visible. The user fills only the
  // rows they need — Save case commits the case plus every row that has
  // a payer + member ID filled in.
  const [caseDraft, setCaseDraft] = useState<{
    name: string;
    caseType: CaseType;
    notes: string;
    rows: Record<Priority, NewPolicyFields>;
    charity: { providerId: string; dateFrom: string; dateTo: string; visitLimit: string };
    selfPay: { flatFee: string };
  } | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/insurance-payers${orgQ}`, { cache: "no-store" });
        const json = await res.json();
        if (!cancelled && res.ok && json.success) {
          setPayers(json.payers ?? []);
        }
      } catch {
        /* non-fatal — UI shows empty payer list */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgQ]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/providers${orgQ}`, { cache: "no-store" });
        const json = await res.json();
        if (!cancelled && res.ok && json.success) {
          setProviders(
            (json.providers ?? []).map((p: { id: string; provider_name: string }) => ({
              id: p.id,
              provider_name: p.provider_name,
            })),
          );
        }
      } catch {
        /* non-fatal — UI shows empty clinician list */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgQ]);

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
      onMutate?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  function openCaseDraft() {
    setCaseDraft({
      name: "",
      caseType: "commercial",
      notes: "",
      rows: {
        primary: { ...EMPTY_NEW_POLICY },
        secondary: { ...EMPTY_NEW_POLICY },
        tertiary: { ...EMPTY_NEW_POLICY },
      },
      charity: { providerId: "", dateFrom: "", dateTo: "", visitLimit: "" },
      selfPay: { flatFee: "" },
    });
  }

  function cancelCaseDraft() {
    setCaseDraft(null);
  }

  function updateRow(priority: Priority, patch: Partial<NewPolicyFields>) {
    setCaseDraft((d) =>
      d
        ? {
            ...d,
            rows: { ...d.rows, [priority]: { ...d.rows[priority], ...patch } },
          }
        : d,
    );
  }

  function filledRows(d: NonNullable<typeof caseDraft>) {
    return PRIORITIES.filter(
      (p) => d.rows[p].payerId && d.rows[p].policyNumber.trim(),
    ).map((p) => ({ priority: p, fields: d.rows[p] }));
  }

  async function saveCaseDraft() {
    if (!caseDraft) return;
    const isCharity = caseDraft.caseType === "charity";
    const isSelfPay = caseDraft.caseType === "self_pay";
    const filled = isCharity || isSelfPay ? [] : filledRows(caseDraft);

    // Derive case name from the primary payer if the user left it blank.
    const primaryRow = caseDraft.rows.primary;
    const primaryPayerName =
      payers.find((p) => p.id === primaryRow.payerId)?.payer_name?.trim() ?? "";
    const fallbackName = isCharity
      ? "Charity Care"
      : isSelfPay
        ? "Self-Pay"
        : primaryPayerName;
    const name = caseDraft.name.trim() || fallbackName;
    if (!name) {
      setError("Enter a case name (or fill in the primary payer).");
      return;
    }

    // Per-type validation. Charity / self-pay skip the insurance rows
    // entirely and require their own fields instead.
    let extraNotes = "";
    if (isCharity) {
      const { providerId, dateFrom, dateTo, visitLimit } = caseDraft.charity;
      if (!providerId) {
        setError("Select the clinician this charity care applies to.");
        return;
      }
      if (!dateFrom || !dateTo) {
        setError("Enter the dates of service (from and to) for charity care.");
        return;
      }
      const clinicianName =
        providers.find((p) => p.id === providerId)?.provider_name ?? providerId;
      const lines = [
        "[Charity Care]",
        `Applies to services rendered by: ${clinicianName}`,
        `For dates of services from: ${dateFrom} to: ${dateTo}`,
      ];
      if (visitLimit.trim()) lines.push(`Visit limit: ${visitLimit.trim()}`);
      extraNotes = lines.join("\n");
    } else if (isSelfPay) {
      const fee = caseDraft.selfPay.flatFee.trim();
      const feeNum = Number(fee);
      if (!fee || !Number.isFinite(feeNum) || feeNum <= 0) {
        setError("Enter a flat fee amount (greater than 0) for self-pay.");
        return;
      }
      extraNotes = `[Self-Pay]\nFlat fee: $${feeNum.toFixed(2)}`;
    } else if (filled.length === 0) {
      setError(
        "Fill in at least one insurance row (payer + member ID) before saving.",
      );
      return;
    }

    const combinedNotes = [extraNotes, caseDraft.notes.trim()]
      .filter(Boolean)
      .join("\n\n");

    setBusy(`save-case-draft`);
    setError(null);
    try {
      const caseRes = await fetch(`/api/clients/${clientId}/cases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          name,
          caseType: caseDraft.caseType,
          notes: combinedNotes || null,
        }),
      });
      const caseJson = await caseRes.json().catch(() => ({}));
      if (!caseRes.ok || !caseJson.success) {
        const msg =
          caseJson.error ??
          (Array.isArray(caseJson.errors)
            ? caseJson.errors.map((e: { message?: string }) => e.message).join("; ")
            : "Failed to create case");
        throw new Error(msg);
      }
      const newCaseId: string | undefined = caseJson.case?.id;
      if (!newCaseId) throw new Error("Case created but id missing");

      const createdPolicyIds: string[] = [];
      // Rollback archives the case we just made. The policy DELETE endpoint
      // doesn't exist yet, so any policies already saved remain in the
      // patient's "available policies" list — the user can attach them to a
      // new case or ignore them.
      const rollback = async (): Promise<{ caseRolledBack: boolean; orphanPolicies: string[] }> => {
        let caseRolledBack = false;
        try {
          const r = await fetch(`/api/clients/${clientId}/cases/${newCaseId}${orgQ}`, {
            method: "DELETE",
          });
          caseRolledBack = r.ok;
        } catch {
          /* leave caseRolledBack = false */
        }
        return { caseRolledBack, orphanPolicies: [...createdPolicyIds] };
      };
      const formatRollback = (r: { caseRolledBack: boolean; orphanPolicies: string[] }) => {
        const parts: string[] = [];
        if (!r.caseRolledBack) parts.push("case could not be rolled back — review chart");
        if (r.orphanPolicies.length > 0) {
          parts.push(
            `${r.orphanPolicies.length} insurance policy/policies were saved and are available to attach`,
          );
        }
        return parts.length ? ` (${parts.join("; ")})` : "";
      };

      // Save policies in priority order so primary always lands first.
      const ordered = filled.sort(
        (a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority),
      );
      for (const staged of ordered) {
        let polRes = await fetch(`/api/clients/${clientId}/policies`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId, priority: staged.priority, ...staged.fields }),
        });
        let polJson = await polRes.json().catch(() => ({}));
        // 409 = the priority slot is occupied by a different active policy.
        // Offer to archive the old one and retry, instead of forcing the
        // user to manually find and archive it elsewhere first.
        if (polRes.status === 409 && polJson?.conflict) {
          const c = polJson.conflict;
          const proceed =
            typeof window !== "undefined" &&
            window.confirm(
              `This patient already has a different ${c.priority} insurance on file (${c.existingPlanName ?? "policy"} #${c.existingPolicyNumber ?? "—"}).\n\nReplace it with the new ${c.priority} insurance? The old one will be archived (kept for history, not deleted).`,
            );
          if (proceed) {
            polRes = await fetch(`/api/clients/${clientId}/policies`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                organizationId,
                priority: staged.priority,
                replaceExistingPriority: true,
                ...staged.fields,
              }),
            });
            polJson = await polRes.json().catch(() => ({}));
          }
        }
        if (!polRes.ok || !polJson.success) {
          const r = await rollback();
          throw new Error(
            `Failed to save ${staged.priority} insurance: ${polJson.error ?? "unknown error"}${formatRollback(r)}`,
          );
        }
        createdPolicyIds.push(polJson.policyId);
        const attachRes = await fetch(
          `/api/clients/${clientId}/cases/${newCaseId}/policies`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              organizationId,
              policyId: polJson.policyId,
              priority: staged.priority,
            }),
          },
        );
        const attachJson = await attachRes.json().catch(() => ({}));
        if (!attachRes.ok || !attachJson.success) {
          const r = await rollback();
          throw new Error(
            `Failed to attach ${staged.priority} insurance to case: ${attachJson.error ?? "unknown error"}${formatRollback(r)}`,
          );
        }
      }

      setCaseDraft(null);
      await load();
      onMutate?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save case");
    } finally {
      setBusy(null);
    }
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

  async function createAndAttachPolicy(caseId: string, fields: NewPolicyFields, priority: Priority) {
    setBusy(`create-policy:${caseId}`);
    setError(null);
    try {
      const createRes = await fetch(`/api/clients/${clientId}/policies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, priority, ...fields }),
      });
      const createJson = await createRes.json().catch(() => ({}));
      if (!createRes.ok || !createJson.success) {
        throw new Error(createJson.error ?? "Failed to create insurance policy");
      }
      const attachRes = await fetch(`/api/clients/${clientId}/cases/${caseId}/policies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, policyId: createJson.policyId, priority }),
      });
      const attachJson = await attachRes.json().catch(() => ({}));
      if (!attachRes.ok || !attachJson.success) {
        // Policy was created but attach failed. Refresh so the new policy
        // appears in availablePolicies and the user can attach it manually
        // (or detach/archive it) instead of getting stuck on a stale view.
        await load();
        onMutate?.();
        throw new Error(
          (attachJson.error ?? "Failed to attach the new policy to the case") +
            " — the policy was saved and is available to attach.",
        );
      }
      setAddingPolicyForCaseId(null);
      await load();
      onMutate?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add insurance");
    } finally {
      setBusy(null);
    }
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
          onClick={() => {
            if (caseDraft) {
              const hasWork =
                caseDraft.name.trim().length > 0 ||
                caseDraft.notes.trim().length > 0 ||
                PRIORITIES.some(
                  (p) =>
                    caseDraft.rows[p].payerId ||
                    caseDraft.rows[p].policyNumber.trim(),
                ) ||
                caseDraft.charity.providerId !== "" ||
                caseDraft.charity.dateFrom !== "" ||
                caseDraft.charity.dateTo !== "" ||
                caseDraft.charity.visitLimit.trim() !== "" ||
                caseDraft.selfPay.flatFee.trim() !== "";
              if (
                hasWork &&
                typeof window !== "undefined" &&
                !window.confirm("Discard this new case and the insurance you've entered?")
              ) {
                return;
              }
              cancelCaseDraft();
            } else {
              openCaseDraft();
            }
          }}
          disabled={Boolean(busy)}
        >
          {caseDraft ? "Cancel" : "+ New case"}
        </button>
      </header>

      {error ? <div className="alert-panel">{error}</div> : null}

      {caseDraft ? <CaseDraftPanel
        draft={caseDraft}
        payers={payers}
        providers={providers}
        busy={Boolean(busy)}
        onChangeName={(name) => setCaseDraft((d) => (d ? { ...d, name } : d))}
        onChangeType={(caseType) =>
          setCaseDraft((d) => (d ? { ...d, caseType } : d))
        }
        onChangeNotes={(notes) => setCaseDraft((d) => (d ? { ...d, notes } : d))}
        onUpdateRow={updateRow}
        onUpdateCharity={(patch) =>
          setCaseDraft((d) => (d ? { ...d, charity: { ...d.charity, ...patch } } : d))
        }
        onUpdateSelfPay={(patch) =>
          setCaseDraft((d) => (d ? { ...d, selfPay: { ...d.selfPay, ...patch } } : d))
        }
        onSave={saveCaseDraft}
        onCancel={() => {
          const hasWork =
            caseDraft.name.trim().length > 0 ||
            caseDraft.notes.trim().length > 0 ||
            PRIORITIES.some(
              (p) =>
                caseDraft.rows[p].payerId ||
                caseDraft.rows[p].policyNumber.trim(),
            ) ||
            caseDraft.charity.providerId !== "" ||
            caseDraft.charity.dateFrom !== "" ||
            caseDraft.charity.dateTo !== "" ||
            caseDraft.charity.visitLimit.trim() !== "" ||
            caseDraft.selfPay.flatFee.trim() !== "";
          if (
            hasWork &&
            typeof window !== "undefined" &&
            !window.confirm("Discard this new case and the insurance you've entered?")
          ) {
            return;
          }
          cancelCaseDraft();
        }}
      /> : null}

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
            const isExpanded = isEditing || expandedCaseIds.has(c.id);
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
                <div
                  style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", cursor: isEditing ? "default" : "pointer" }}
                  onClick={() => {
                    if (!isEditing) toggleCaseExpanded(c.id);
                  }}
                >
                  {!isEditing ? (
                    <span
                      aria-hidden
                      style={{
                        display: "inline-block",
                        width: 14,
                        textAlign: "center",
                        color: "var(--muted-color, #6b7280)",
                        fontSize: "0.75rem",
                      }}
                    >
                      {isExpanded ? "▾" : "▸"}
                    </span>
                  ) : null}
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

                {isExpanded && isEditing ? (
                  <textarea
                    value={editDraft.notes}
                    onChange={(e) => setEditDraft((d) => ({ ...d, notes: e.target.value }))}
                    rows={2}
                    style={{ width: "100%", marginTop: "0.5rem" }}
                  />
                ) : isExpanded && c.notes ? (
                  <p style={{ margin: "0.25rem 0", color: "var(--muted-color, #6b7280)" }}>{c.notes}</p>
                ) : null}

                <div style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: isExpanded ? undefined : "var(--muted-color, #6b7280)" }}>
                  <strong>Primary payer:</strong>{" "}
                  {primary
                    ? primary.payerName ?? primary.planName ?? "—"
                    : c.caseType === "self_pay" || c.caseType === "charity"
                      ? "Patient responsibility"
                      : "Not set"}
                </div>

                {isExpanded && c.policies.length > 0 ? (
                  <ul style={{ listStyle: "none", padding: 0, margin: "0.5rem 0", display: "grid", gap: "0.5rem" }}>
                    {c.policies.map((p) => (
                      <li
                        key={p.id}
                        style={{
                          display: "grid",
                          gap: "0.25rem",
                          padding: "0.5rem 0.75rem",
                          border: "1px solid var(--border-color, #e5e7eb)",
                          borderRadius: 6,
                          background: "var(--surface-color, #fafafa)",
                        }}
                      >
                        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                          <span className="status">{p.priority}</span>
                          <strong>{p.payerName ?? p.planName ?? "Policy"}</strong>
                          {p.planName && p.payerName ? (
                            <span style={{ color: "var(--muted-color, #6b7280)" }}>· {p.planName}</span>
                          ) : null}
                          {!p.activeFlag ? <span className="status status-yellow">Inactive</span> : null}
                          <button
                            type="button"
                            className="button button-secondary"
                            style={{ marginLeft: "auto" }}
                            onClick={() => detachPolicy(c.id, p.policyId)}
                            disabled={Boolean(busy)}
                          >
                            Detach
                          </button>
                        </div>
                        <PolicyDetails p={p} />
                      </li>
                    ))}
                  </ul>
                ) : null}

                {(() => {
                  if (!isExpanded) return null;
                  const openPriorities = PRIORITIES.filter((p) => !usedPriorities.has(p));
                  if (openPriorities.length === 0) return null;
                  const isAdding = addingPolicyForCaseId === c.id;
                  return (
                    <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.5rem" }}>
                      {c.policies.length === 0 ? (
                        <div className="empty-state" style={{ padding: "0.5rem 0.75rem" }}>
                          No insurance attached to this case yet. Add a policy to populate the billing fields.
                        </div>
                      ) : null}
                      {attachable.length > 0 ? (
                        <AttachPolicyForm
                          onAttach={(policyId, priority) => attachPolicy(c.id, policyId, priority)}
                          availablePolicies={attachable}
                          availablePriorities={openPriorities}
                          disabled={Boolean(busy)}
                        />
                      ) : null}
                      {isAdding ? (
                        <CreatePolicyForm
                          payers={payers}
                          availablePriorities={openPriorities}
                          disabled={Boolean(busy)}
                          onCancel={() => setAddingPolicyForCaseId(null)}
                          onSubmit={(fields, priority) =>
                            createAndAttachPolicy(c.id, fields, priority)
                          }
                        />
                      ) : (
                        <div>
                          <button
                            type="button"
                            className="button"
                            onClick={() => setAddingPolicyForCaseId(c.id)}
                            disabled={Boolean(busy)}
                          >
                            {c.policies.length === 0
                              ? "+ Add insurance"
                              : `+ Add ${openPriorities[0]} insurance`}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })()}

                <div style={{ display: isExpanded ? "flex" : "none", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
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

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const s = String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}/${dd}/${d.getFullYear()}`;
  }
  return s;
}

function PolicyField({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
      <dt style={{ color: "var(--muted-color, #6b7280)", fontWeight: 500, fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.02em" }}>{label}</dt>
      <dd style={{ margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value ?? "—"}</dd>
    </div>
  );
}

function money(v: number | null): string | null {
  return v == null ? null : `$${v.toFixed(2)}`;
}

function PolicyDetails({ p }: { p: CasePolicy }) {
  const subscriberName =
    [p.subscriberFirstName, p.subscriberLastName].filter(Boolean).join(" ").trim() || null;
  const rel = (p.subscriberRelationship ?? "").trim();
  const subscriberLabel = subscriberName
    ? rel && rel.toLowerCase() !== "self"
      ? `${subscriberName} (${rel.toLowerCase()})`
      : subscriberName
    : rel.toLowerCase() === "self"
      ? "Self"
      : null;
  const cityState = [p.subscriberCity, p.subscriberState].filter(Boolean).join(", ");
  const subscriberAddress =
    [
      [p.subscriberAddressLine1, p.subscriberAddressLine2].filter(Boolean).join(" "),
      [cityState, p.subscriberPostalCode].filter(Boolean).join(" "),
    ]
      .filter(Boolean)
      .join(", ") || null;

  return (
    <div style={{ display: "grid", gap: "0.75rem", marginTop: "0.25rem" }}>
      <section>
        <h5 style={{ margin: "0 0 0.25rem", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--muted-color, #6b7280)" }}>
          Plan & payer
        </h5>
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: "0.5rem 0.75rem",
            margin: 0,
            fontSize: "0.8125rem",
          }}
        >
          <PolicyField label="Plan name" value={p.planName} />
          <PolicyField label="Payer" value={p.payerName} />
          <PolicyField label="Payer ID" value={p.payerId} />
        </dl>
      </section>

      <section>
        <h5 style={{ margin: "0 0 0.25rem", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--muted-color, #6b7280)" }}>
          Member & coverage
        </h5>
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: "0.5rem 0.75rem",
            margin: 0,
            fontSize: "0.8125rem",
          }}
        >
          <PolicyField label="Policy / Member ID" value={p.policyNumber} />
          <PolicyField label="Group #" value={p.groupNumber} />
          <PolicyField label="Effective" value={formatDate(p.effectiveDate)} />
          <PolicyField label="Termination" value={formatDate(p.terminationDate)} />
        </dl>
      </section>

      <section>
        <h5 style={{ margin: "0 0 0.25rem", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--muted-color, #6b7280)" }}>
          Patient responsibility
        </h5>
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: "0.5rem 0.75rem",
            margin: 0,
            fontSize: "0.8125rem",
          }}
        >
          <PolicyField label="Copay" value={money(p.copayAmount)} />
          <PolicyField
            label="Coinsurance"
            value={p.coinsurancePercent != null ? `${p.coinsurancePercent}%` : null}
          />
          <PolicyField label="Deductible" value={money(p.deductibleAmount)} />
          <PolicyField label="Out-of-pocket max" value={money(p.outOfPocketMax)} />
        </dl>
      </section>

      <section>
        <h5 style={{ margin: "0 0 0.25rem", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--muted-color, #6b7280)" }}>
          Subscriber
        </h5>
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "0.5rem 0.75rem",
            margin: 0,
            fontSize: "0.8125rem",
          }}
        >
          <PolicyField label="Name" value={subscriberLabel} />
          <PolicyField label="Relationship" value={rel || null} />
          <PolicyField label="Date of birth" value={formatDate(p.subscriberDateOfBirth)} />
          <PolicyField label="Subscriber ID" value={p.subscriberMemberId} />
          <PolicyField label="Phone" value={p.subscriberPhone} />
          <PolicyField label="Address" value={subscriberAddress} />
        </dl>
      </section>
    </div>
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
        Attach existing
      </button>
    </div>
  );
}

const EMPTY_NEW_POLICY: NewPolicyFields = {
  payerId: "",
  planName: null,
  policyNumber: "",
  groupNumber: null,
  effectiveDate: null,
  terminationDate: null,
  copayAmount: null,
  coinsurancePercent: null,
  deductibleAmount: null,
  outOfPocketMax: null,
  subscriberRelationship: "self",
  subscriberFirstName: null,
  subscriberLastName: null,
  subscriberDateOfBirth: null,
  subscriberMemberId: null,
  subscriberPhone: null,
  subscriberAddressLine1: null,
  subscriberAddressLine2: null,
  subscriberCity: null,
  subscriberState: null,
  subscriberPostalCode: null,
};

function CreatePolicyForm({
  payers,
  availablePriorities,
  disabled,
  onCancel,
  onSubmit,
  submitLabel = "Save insurance",
  heading = "Add insurance policy",
}: {
  payers: Array<{ id: string; payer_name: string; payer_id: string | null }>;
  availablePriorities: Priority[];
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (fields: NewPolicyFields, priority: Priority) => void | Promise<void>;
  submitLabel?: string;
  heading?: string;
}) {
  const [priority, setPriority] = useState<Priority>(availablePriorities[0] ?? "primary");
  const [draft, setDraft] = useState<NewPolicyFields>({
    ...EMPTY_NEW_POLICY,
    payerId: payers[0]?.id ?? "",
  });
  // Auto-populate payerId once payers finish loading (the form may have
  // mounted before /api/insurance-payers responded).
  useEffect(() => {
    if (!draft.payerId && payers[0]?.id) {
      setDraft((d) => ({ ...d, payerId: payers[0].id }));
    }
  }, [payers, draft.payerId]);
  const set = <K extends keyof NewPolicyFields>(k: K, v: NewPolicyFields[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const text = (k: keyof NewPolicyFields) =>
    (k === "payerId" || k === "policyNumber" || k === "subscriberRelationship"
      ? (draft[k] as string)
      : ((draft[k] as string | null) ?? ""));
  const setText = (k: keyof NewPolicyFields, raw: string) => {
    const trimmed = raw;
    if (k === "payerId" || k === "policyNumber" || k === "subscriberRelationship") {
      set(k, trimmed as never);
    } else {
      set(k, (trimmed.length ? trimmed : null) as never);
    }
  };

  const cellStyle = { display: "grid", gap: 4 } as const;
  const labelStyle = {
    fontSize: "0.7rem",
    textTransform: "uppercase",
    letterSpacing: "0.02em",
    color: "var(--muted-color, #6b7280)",
    fontWeight: 500,
  } as const;
  const grid = (min = 160) =>
    ({
      display: "grid",
      gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
      gap: "0.5rem 0.75rem",
    }) as const;

  const canSubmit = Boolean(draft.payerId && draft.policyNumber.trim() && !disabled);

  return (
    <div
      style={{
        display: "grid",
        gap: "0.75rem",
        padding: "0.75rem",
        border: "1px solid var(--border-color, #e5e7eb)",
        borderRadius: 8,
        background: "var(--surface-color, #fafafa)",
      }}
    >
      <strong>{heading}</strong>

      <div style={grid(160)}>
        <label style={cellStyle}>
          <span style={labelStyle}>Priority</span>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
            disabled={disabled}
          >
            {availablePriorities.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>Payer *</span>
          <select
            value={draft.payerId}
            onChange={(e) => setText("payerId", e.target.value)}
            disabled={disabled || payers.length === 0}
          >
            {payers.length === 0 ? <option value="">No payers configured</option> : null}
            {payers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.payer_name}
                {p.payer_id ? ` (${p.payer_id})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>Plan name</span>
          <input value={text("planName")} onChange={(e) => setText("planName", e.target.value)} disabled={disabled} />
        </label>
      </div>

      <div style={grid(160)}>
        <label style={cellStyle}>
          <span style={labelStyle}>Policy / Member ID *</span>
          <input value={text("policyNumber")} onChange={(e) => setText("policyNumber", e.target.value)} disabled={disabled} />
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>Group #</span>
          <input value={text("groupNumber")} onChange={(e) => setText("groupNumber", e.target.value)} disabled={disabled} />
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>Effective (YYYY-MM-DD)</span>
          <input type="date" value={text("effectiveDate")} onChange={(e) => setText("effectiveDate", e.target.value)} disabled={disabled} />
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>Termination (YYYY-MM-DD)</span>
          <input type="date" value={text("terminationDate")} onChange={(e) => setText("terminationDate", e.target.value)} disabled={disabled} />
        </label>
      </div>

      <div style={grid(140)}>
        <label style={cellStyle}>
          <span style={labelStyle}>Copay ($)</span>
          <input inputMode="decimal" value={text("copayAmount")} onChange={(e) => setText("copayAmount", e.target.value)} disabled={disabled} />
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>Coinsurance (%)</span>
          <input inputMode="decimal" value={text("coinsurancePercent")} onChange={(e) => setText("coinsurancePercent", e.target.value)} disabled={disabled} />
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>Deductible ($)</span>
          <input inputMode="decimal" value={text("deductibleAmount")} onChange={(e) => setText("deductibleAmount", e.target.value)} disabled={disabled} />
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>Out-of-pocket max ($)</span>
          <input inputMode="decimal" value={text("outOfPocketMax")} onChange={(e) => setText("outOfPocketMax", e.target.value)} disabled={disabled} />
        </label>
      </div>

      <div style={grid(180)}>
        <label style={cellStyle}>
          <span style={labelStyle}>Subscriber relationship</span>
          <select
            value={draft.subscriberRelationship}
            onChange={(e) => setText("subscriberRelationship", e.target.value)}
            disabled={disabled}
          >
            <option value="self">Self</option>
            <option value="spouse">Spouse</option>
            <option value="child">Child</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>Subscriber first name</span>
          <input value={text("subscriberFirstName")} onChange={(e) => setText("subscriberFirstName", e.target.value)} disabled={disabled} />
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>Subscriber last name</span>
          <input value={text("subscriberLastName")} onChange={(e) => setText("subscriberLastName", e.target.value)} disabled={disabled} />
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>Subscriber DOB</span>
          <input type="date" value={text("subscriberDateOfBirth")} onChange={(e) => setText("subscriberDateOfBirth", e.target.value)} disabled={disabled} />
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>Subscriber Member ID</span>
          <input value={text("subscriberMemberId")} onChange={(e) => setText("subscriberMemberId", e.target.value)} disabled={disabled} />
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>Subscriber phone</span>
          <input value={text("subscriberPhone")} onChange={(e) => setText("subscriberPhone", e.target.value)} disabled={disabled} />
        </label>
      </div>

      <div style={grid(160)}>
        <label style={cellStyle}>
          <span style={labelStyle}>Address line 1</span>
          <input value={text("subscriberAddressLine1")} onChange={(e) => setText("subscriberAddressLine1", e.target.value)} disabled={disabled} />
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>Address line 2</span>
          <input value={text("subscriberAddressLine2")} onChange={(e) => setText("subscriberAddressLine2", e.target.value)} disabled={disabled} />
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>City</span>
          <input value={text("subscriberCity")} onChange={(e) => setText("subscriberCity", e.target.value)} disabled={disabled} />
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>State</span>
          <input value={text("subscriberState")} onChange={(e) => setText("subscriberState", e.target.value)} disabled={disabled} maxLength={2} />
        </label>
        <label style={cellStyle}>
          <span style={labelStyle}>Postal code</span>
          <input value={text("subscriberPostalCode")} onChange={(e) => setText("subscriberPostalCode", e.target.value)} disabled={disabled} />
        </label>
      </div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button
          type="button"
          className="button"
          disabled={!canSubmit}
          onClick={() => onSubmit(draft, priority)}
        >
          {submitLabel}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={disabled}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function CaseDraftPanel({
  draft,
  payers,
  providers,
  busy,
  onChangeName,
  onChangeType,
  onChangeNotes,
  onUpdateRow,
  onUpdateCharity,
  onUpdateSelfPay,
  onSave,
  onCancel,
}: {
  draft: {
    name: string;
    caseType: CaseType;
    notes: string;
    rows: Record<Priority, NewPolicyFields>;
    charity: { providerId: string; dateFrom: string; dateTo: string; visitLimit: string };
    selfPay: { flatFee: string };
  };
  payers: Array<{ id: string; payer_name: string; payer_id: string | null }>;
  providers: Array<{ id: string; provider_name: string }>;
  busy: boolean;
  onChangeName: (v: string) => void;
  onChangeType: (v: CaseType) => void;
  onChangeNotes: (v: string) => void;
  onUpdateRow: (priority: Priority, patch: Partial<NewPolicyFields>) => void;
  onUpdateCharity: (patch: Partial<{ providerId: string; dateFrom: string; dateTo: string; visitLimit: string }>) => void;
  onUpdateSelfPay: (patch: Partial<{ flatFee: string }>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const isCharity = draft.caseType === "charity";
  const isSelfPay = draft.caseType === "self_pay";
  const labelStyle: React.CSSProperties = {
    fontSize: "0.7rem",
    textTransform: "uppercase",
    letterSpacing: "0.02em",
    color: "var(--muted-color, #6b7280)",
    fontWeight: 500,
  };
  return (
    <div
      className="content-card-section"
      style={{
        display: "grid",
        gap: "0.75rem",
        padding: "0.75rem",
        border: "1px solid var(--border-color, #e5e7eb)",
        borderRadius: 8,
        background: "var(--surface-color, #fafafa)",
        margin: "0.5rem 0",
      }}
    >
      <strong>New case</strong>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "2fr 1fr",
          gap: "0.5rem",
        }}
      >
        <label style={{ display: "grid", gap: 4 }}>
          <span style={labelStyle}>Case name *</span>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => onChangeName(e.target.value)}
            placeholder="e.g. Aetna PPO, Workers Comp – ACME, etc."
            disabled={busy}
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={labelStyle}>Case type</span>
          <select
            value={draft.caseType}
            onChange={(e) => onChangeType(e.target.value as CaseType)}
            disabled={busy}
          >
            {(Object.keys(CASE_TYPE_LABELS) as CaseType[]).map((t) => (
              <option key={t} value={t}>
                {CASE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isCharity ? (
        <div
          style={{
            display: "grid",
            gap: "0.5rem",
            paddingTop: "0.5rem",
            borderTop: "1px solid var(--border-color, #e5e7eb)",
          }}
        >
          <label style={{ display: "grid", gap: 4 }}>
            <span style={labelStyle}>Applies to services rendered by: *</span>
            <select
              value={draft.charity.providerId}
              onChange={(e) => onUpdateCharity({ providerId: e.target.value })}
              disabled={busy}
            >
              <option value="">— Select clinician —</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.provider_name}
                </option>
              ))}
            </select>
          </label>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: "0.5rem",
            }}
          >
            <label style={{ display: "grid", gap: 4 }}>
              <span style={labelStyle}>For dates of services from: *</span>
              <input
                type="date"
                value={draft.charity.dateFrom}
                onChange={(e) => onUpdateCharity({ dateFrom: e.target.value })}
                disabled={busy}
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={labelStyle}>To: *</span>
              <input
                type="date"
                value={draft.charity.dateTo}
                onChange={(e) => onUpdateCharity({ dateTo: e.target.value })}
                disabled={busy}
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={labelStyle}>Visit limit (optional)</span>
              <input
                type="number"
                min={1}
                step={1}
                value={draft.charity.visitLimit}
                onChange={(e) => onUpdateCharity({ visitLimit: e.target.value })}
                disabled={busy}
                placeholder="e.g. 10"
              />
            </label>
          </div>
        </div>
      ) : isSelfPay ? (
        <div
          style={{
            display: "grid",
            gap: "0.5rem",
            paddingTop: "0.5rem",
            borderTop: "1px solid var(--border-color, #e5e7eb)",
          }}
        >
          <label style={{ display: "grid", gap: 4, maxWidth: 240 }}>
            <span style={labelStyle}>Flat fee amount *</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={draft.selfPay.flatFee}
              onChange={(e) => onUpdateSelfPay({ flatFee: e.target.value })}
              disabled={busy}
              placeholder="e.g. 150.00"
              required
            />
          </label>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gap: "0.4rem",
            paddingTop: "0.5rem",
            borderTop: "1px solid var(--border-color, #e5e7eb)",
          }}
        >
          <span style={labelStyle}>Insurance — fill only the rows you need</span>
          {PRIORITIES.map((priority) => {
            const row = draft.rows[priority];
            return (
              <div
                key={priority}
                style={{
                  display: "grid",
                  gridTemplateColumns: "90px 2fr 1fr 1fr 1fr",
                  gap: "0.4rem",
                  alignItems: "center",
                }}
              >
                <span style={{ textTransform: "capitalize", fontWeight: 500 }}>
                  {priority}
                </span>
                <select
                  value={row.payerId}
                  onChange={(e) =>
                    onUpdateRow(priority, { payerId: e.target.value })
                  }
                  disabled={busy}
                >
                  <option value="">— Select payer —</option>
                  {payers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.payer_name}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={row.policyNumber}
                  onChange={(e) =>
                    onUpdateRow(priority, { policyNumber: e.target.value })
                  }
                  placeholder="Member ID *"
                  disabled={busy}
                />
                <input
                  type="text"
                  value={row.planName ?? ""}
                  onChange={(e) =>
                    onUpdateRow(priority, { planName: e.target.value || null })
                  }
                  placeholder="Plan"
                  disabled={busy}
                />
                <input
                  type="text"
                  value={row.groupNumber ?? ""}
                  onChange={(e) =>
                    onUpdateRow(priority, { groupNumber: e.target.value || null })
                  }
                  placeholder="Group #"
                  disabled={busy}
                />
              </div>
            );
          })}
        </div>
      )}

      <label style={{ display: "grid", gap: 4 }}>
        <span style={labelStyle}>Comments</span>
        <textarea
          rows={2}
          value={draft.notes}
          onChange={(e) => onChangeNotes(e.target.value)}
          disabled={busy}
        />
      </label>

      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          justifyContent: "flex-end",
          paddingTop: "0.5rem",
          borderTop: "1px solid var(--border-color, #e5e7eb)",
        }}
      >
        <button
          type="button"
          className="button button-secondary"
          onClick={onCancel}
          disabled={busy}
        >
          Close
        </button>
        <button type="button" className="button" onClick={onSave} disabled={busy}>
          Save
        </button>
      </div>
    </div>
  );
}
