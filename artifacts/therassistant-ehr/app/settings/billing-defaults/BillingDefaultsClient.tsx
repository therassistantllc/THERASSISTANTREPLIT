"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type BillingDefaults = {
  claim_frequency_code: string;
  default_pos: string;
  default_diagnosis_behavior: string;
  default_procedure_charge_behavior: string;
  eligibility_recheck_days: number;
  claim_hold_days: number;
  aging_bucket_rules: string;
  auto_route_missing_info: boolean;
};

type Rejections277CaAutoroute = {
  enabled: boolean;
  route_invalid_member: boolean;
  route_invalid_provider: boolean;
};

type SettingsChange = {
  id: string;
  created_at: string;
  action: string;
  setting_key: string | null;
  field: string;
  field_label: string;
  before_value: string | number | boolean | null;
  after_value: string | number | boolean | null;
  user_id: string | null;
  user_role: string | null;
  actor_label: string | null;
};

const ACTION_GROUP_LABELS: Record<string, string> = {
  billing_defaults_updated: "Billing defaults",
  rejections_277ca_autoroute_updated: "277CA auto-routing",
  payer_status_auto_check_updated: "Payer status auto-check",
};

function formatChangeValue(v: SettingsChange["before_value"]): string {
  if (v === null) return "—";
  if (typeof v === "boolean") return v ? "On" : "Off";
  return String(v);
}

type PayerStatusAutoCheck = {
  enabled: boolean;
  auto_check_age_days: number;
  auto_recheck_interval_days: number;
};

type AutoCheckLastRunSummary = {
  ran_at: string;
  scanned: number;
  dispatched: number;
  skipped: number;
  failures: number;
  disabled: boolean;
};

type AutoCheckHeartbeat = {
  status: "ok" | "stale" | "never_run" | "disabled";
  lastRunAt: string | null;
  hoursSinceLastRun: number | null;
  thresholdHours: number;
  message: string;
  lastRunSummary?: AutoCheckLastRunSummary | null;
};

type JobHeartbeat = AutoCheckHeartbeat & {
  jobId: string;
  label: string;
  description: string;
  runbookPath?: string;
};

type CronHeartbeats = {
  overall: "ok" | "degraded";
  jobs: JobHeartbeat[];
};

const INITIAL: BillingDefaults = {
  claim_frequency_code: "1",
  default_pos: "11",
  default_diagnosis_behavior: "first_encounter",
  default_procedure_charge_behavior: "manual",
  eligibility_recheck_days: 30,
  claim_hold_days: 3,
  aging_bucket_rules: "30/60/90/120",
  auto_route_missing_info: true,
};

const INITIAL_AUTOROUTE: Rejections277CaAutoroute = {
  enabled: true,
  route_invalid_member: true,
  route_invalid_provider: true,
};

const INITIAL_PAYER_AUTOCHECK: PayerStatusAutoCheck = {
  enabled: true,
  auto_check_age_days: 3,
  auto_recheck_interval_days: 2,
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

export default function BillingDefaultsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [form, setForm] = useState<BillingDefaults>(INITIAL);
  const [autoroute, setAutoroute] = useState<Rejections277CaAutoroute>(INITIAL_AUTOROUTE);
  const [recentChanges, setRecentChanges] = useState<SettingsChange[]>([]);
  const [payerAutoCheck, setPayerAutoCheck] = useState<PayerStatusAutoCheck>(INITIAL_PAYER_AUTOCHECK);
  const [autoCheckHeartbeat, setAutoCheckHeartbeat] = useState<AutoCheckHeartbeat | null>(null);
  const [cronHeartbeats, setCronHeartbeats] = useState<CronHeartbeats | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const loadDefaults = useCallback(async () => {
    if (!organizationId) return;
    const r = await fetch(
      `/api/settings/billing-defaults?organizationId=${encodeURIComponent(organizationId)}`,
    );
    const json = (await r.json()) as {
      billing_defaults?: BillingDefaults;
      rejections_277ca_autoroute?: Rejections277CaAutoroute;
      recent_autoroute_changes?: SettingsChange[];
      recent_settings_changes?: SettingsChange[];
      payer_status_auto_check?: PayerStatusAutoCheck;
    };
    if (json.billing_defaults) setForm((prev) => ({ ...prev, ...json.billing_defaults }));
    if (json.rejections_277ca_autoroute) {
      setAutoroute((prev) => ({ ...prev, ...json.rejections_277ca_autoroute }));
    }
    if (json.payer_status_auto_check) {
      setPayerAutoCheck((prev) => ({ ...prev, ...json.payer_status_auto_check }));
    }
    const recent = Array.isArray(json.recent_settings_changes)
      ? json.recent_settings_changes
      : Array.isArray(json.recent_autoroute_changes)
        ? json.recent_autoroute_changes
        : [];
    setRecentChanges(recent);
  }, [organizationId]);

  const loadAutoCheckHeartbeat = useCallback(async () => {
    if (!organizationId) return;
    try {
      const r = await fetch(
        `/api/admin/cron-heartbeat/claim-status-auto-check?organizationId=${encodeURIComponent(organizationId)}`,
      );
      if (!r.ok) {
        setAutoCheckHeartbeat(null);
        return;
      }
      const json = (await r.json()) as AutoCheckHeartbeat;
      setAutoCheckHeartbeat(json);
    } catch {
      setAutoCheckHeartbeat(null);
    }
  }, [organizationId]);

  const loadCronHeartbeats = useCallback(async () => {
    if (!organizationId) return;
    try {
      const r = await fetch(
        `/api/admin/cron-heartbeats?organizationId=${encodeURIComponent(organizationId)}`,
      );
      if (!r.ok) {
        setCronHeartbeats(null);
        return;
      }
      const json = (await r.json()) as CronHeartbeats;
      setCronHeartbeats(json);
    } catch {
      setCronHeartbeats(null);
    }
  }, [organizationId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!organizationId) { setLoading(false); return; }
    Promise.all([
      loadDefaults().catch(() => {
        setStatusMsg({ type: "err", text: "Failed to load billing defaults." });
      }),
      loadAutoCheckHeartbeat(),
      loadCronHeartbeats(),
    ]).finally(() => setLoading(false));
  }, [organizationId, loadDefaults, loadAutoCheckHeartbeat, loadCronHeartbeats]);

  const staleCronJobs = useMemo(
    () => (cronHeartbeats?.jobs ?? []).filter((j) => j.status !== "ok"),
    [cronHeartbeats],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await fetch(
        `/api/settings/billing-defaults?organizationId=${encodeURIComponent(organizationId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...form,
            rejections_277ca_autoroute: autoroute,
            payer_status_auto_check: payerAutoCheck,
          }),
        },
      );
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? "Save failed");
      setStatusMsg({ type: "ok", text: "Billing defaults saved." });
      // Refresh recent-changes list so the just-saved edits show up.
      await loadDefaults().catch(() => {});
    } catch (err) {
      setStatusMsg({ type: "err", text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }, [form, autoroute, organizationId, loadDefaults]);

  const formatChangeTimestamp = (iso: string) => {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Billing Defaults</h1>
          <p className="hero-copy">Default claim values, eligibility rechecks, and workqueue automation rules.</p>
        </div>
        <div className="hero-actions">
          <Link className="button button-secondary" href="/settings">← Settings</Link>
        </div>
      </section>

      {!organizationId && <div className="alert-panel">No organization context.</div>}
      {statusMsg && (
        <div className={statusMsg.type === "ok" ? "alert-panel alert-panel-success" : "alert-panel"}>{statusMsg.text}</div>
      )}

      {staleCronJobs.length > 0 && (
        <div
          className="alert-panel"
          role="alert"
          data-testid="cron-heartbeats-banner"
          style={{ borderLeft: "4px solid var(--color-danger, #b91c1c)" }}
        >
          <strong>
            {staleCronJobs.length === 1
              ? "1 nightly background job looks broken."
              : `${staleCronJobs.length} nightly background jobs look broken.`}
          </strong>
          <ul style={{ margin: "var(--space-2) 0 0", paddingLeft: "var(--space-5)" }}>
            {staleCronJobs.map((job) => (
              <li key={job.jobId} data-testid={`cron-heartbeat-stale-${job.jobId}`}>
                <strong>{job.label}.</strong> {job.message}{" "}
                {job.lastRunAt && (
                  <span style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
                    Last successful run: {new Date(job.lastRunAt).toLocaleString()}.
                  </span>
                )}
                {job.runbookPath && (
                  <span style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
                    {" "}See <code>{job.runbookPath}</code>.
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading ? (
        <div className="panel"><div className="empty-state">Loading…</div></div>
      ) : (
        <>
          <section className="panel form-panel">
            <h2>Claim Defaults</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginBottom: "var(--space-4)" }}>
              Stored in <code>system_settings</code> under key <code>billing.defaults</code>.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              <label className="field-label">
                Claim Frequency Code
                <select
                  value={form.claim_frequency_code}
                  onChange={(e) => setForm((p) => ({ ...p, claim_frequency_code: e.target.value }))}
                >
                  <option value="1">1 – Original</option>
                  <option value="7">7 – Replacement</option>
                  <option value="8">8 – Void/Cancel</option>
                </select>
              </label>
              <label className="field-label">
                Default Place of Service
                <select value={form.default_pos} onChange={(e) => setForm((p) => ({ ...p, default_pos: e.target.value }))}>
                  <option value="02">02 – Telehealth</option>
                  <option value="10">10 – Telehealth (Client Home)</option>
                  <option value="11">11 – Office</option>
                  <option value="12">12 – Home</option>
                  <option value="49">49 – Independent Clinic</option>
                  <option value="53">53 – Community Mental Health Center</option>
                </select>
              </label>
              <label className="field-label">
                Default Diagnosis Behavior
                <select
                  value={form.default_diagnosis_behavior}
                  onChange={(e) => setForm((p) => ({ ...p, default_diagnosis_behavior: e.target.value }))}
                >
                  <option value="first_encounter">Use first encounter diagnosis</option>
                  <option value="most_recent">Use most recent diagnosis</option>
                  <option value="manual">Manual selection only</option>
                </select>
              </label>
              <label className="field-label">
                Default Procedure Charge Behavior
                <select
                  value={form.default_procedure_charge_behavior}
                  onChange={(e) => setForm((p) => ({ ...p, default_procedure_charge_behavior: e.target.value }))}
                >
                  <option value="manual">Manual entry</option>
                  <option value="auto_from_encounter">Auto from encounter</option>
                  <option value="fee_schedule">Use fee schedule</option>
                </select>
              </label>
            </div>
          </section>

          <section className="panel form-panel">
            <h2>Timing &amp; Aging</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
              <label className="field-label">
                Eligibility Recheck Interval (days)
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={form.eligibility_recheck_days}
                  onChange={(e) => setForm((p) => ({ ...p, eligibility_recheck_days: Number(e.target.value) }))}
                />
              </label>
              <label className="field-label">
                Claim Hold Period (days before submission)
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={form.claim_hold_days}
                  onChange={(e) => setForm((p) => ({ ...p, claim_hold_days: Number(e.target.value) }))}
                />
              </label>
              <label className="field-label">
                Aging Bucket Rules
                <input
                  type="text"
                  value={form.aging_bucket_rules}
                  placeholder="30/60/90/120"
                  onChange={(e) => setForm((p) => ({ ...p, aging_bucket_rules: e.target.value }))}
                />
              </label>
            </div>
          </section>

          <section className="panel form-panel">
            <h2>Workqueue Automation</h2>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={form.auto_route_missing_info}
                onChange={(e) => setForm((p) => ({ ...p, auto_route_missing_info: e.target.checked }))}
              />
              Auto-route claims with missing information to workqueue
            </label>
          </section>

          <section className="panel form-panel">
            <h2>277CA Rejection Auto-Routing</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginBottom: "var(--space-4)" }}>
              Stored in <code>system_settings</code> under key <code>billing.rejections_277ca_autoroute</code>.
              When auto-routing is on, incoming 277CA rejections that match a clear member or provider
              problem skip the 277CA queue and hand off to the right team instead.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={autoroute.enabled}
                  onChange={(e) => setAutoroute((p) => ({ ...p, enabled: e.target.checked }))}
                />
                <span>
                  Enable 277CA auto-routing
                  <span style={{ display: "block", color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
                    Master switch. When off, every 277CA rejection stays in the 277CA workqueue for a biller to triage manually.
                  </span>
                </span>
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  disabled={!autoroute.enabled}
                  checked={autoroute.route_invalid_member}
                  onChange={(e) => setAutoroute((p) => ({ ...p, route_invalid_member: e.target.checked }))}
                />
                <span>
                  Auto-defer &ldquo;Invalid Member&rdquo; rejections to Eligibility
                  <span style={{ display: "block", color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
                    Subscriber, member ID, DOB, and policy-number problems hand off to the eligibility queue.
                  </span>
                </span>
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  disabled={!autoroute.enabled}
                  checked={autoroute.route_invalid_provider}
                  onChange={(e) => setAutoroute((p) => ({ ...p, route_invalid_provider: e.target.checked }))}
                />
                <span>
                  Auto-defer &ldquo;Invalid Provider&rdquo; rejections to Credentialing
                  <span style={{ display: "block", color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
                    Rendering, billing, referring, and taxonomy problems hand off to the credentialing queue.
                  </span>
                </span>
              </label>
            </div>

          </section>

          <section className="panel form-panel">
            <h2>Payer Status Auto-Check</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginBottom: "var(--space-4)" }}>
              Stored in <code>organization_settings</code> under keys{" "}
              <code>payer_status.auto_check_enabled</code>,{" "}
              <code>payer_status.auto_check_age_days</code>, and{" "}
              <code>payer_status.auto_recheck_interval_days</code>. Controls
              how aggressively the scheduled job re-checks claims sitting in
              the Payer Received queue.
            </p>
            {autoCheckHeartbeat && (
              <AutoCheckLastRunTile heartbeat={autoCheckHeartbeat} />
            )}
            {autoCheckHeartbeat &&
              autoCheckHeartbeat.status !== "ok" &&
              autoCheckHeartbeat.status !== "disabled" && (
              <div
                className="alert-panel"
                role="alert"
                data-testid="auto-check-heartbeat-banner"
                style={{
                  marginBottom: "var(--space-4)",
                  borderLeft: "4px solid var(--color-danger, #b91c1c)",
                }}
              >
                <strong>Nightly payer auto-check looks broken.</strong>{" "}
                {autoCheckHeartbeat.message}{" "}
                {autoCheckHeartbeat.lastRunAt && (
                  <span style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
                    Last successful run: {new Date(autoCheckHeartbeat.lastRunAt).toLocaleString()}.
                  </span>
                )}{" "}
                <span style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
                  See <code>CLAIM_STATUS_AUTO_CHECK_RUNBOOK.md</code> for recovery steps.
                </span>
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={payerAutoCheck.enabled}
                  onChange={(e) => setPayerAutoCheck((p) => ({ ...p, enabled: e.target.checked }))}
                />
                <span>
                  Enable scheduled payer-status auto-checking
                  <span style={{ display: "block", color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
                    Master switch. When off, the cron leaves every Payer Received
                    claim alone — billers must use the manual &ldquo;Check payer status&rdquo;
                    button. Useful for sandbox payers that don&apos;t answer 276 requests.
                  </span>
                </span>
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
                <label className="field-label">
                  Start auto-checking a claim after (days)
                  <input
                    type="number"
                    min={1}
                    max={365}
                    disabled={!payerAutoCheck.enabled}
                    value={payerAutoCheck.auto_check_age_days}
                    onChange={(e) =>
                      setPayerAutoCheck((p) => ({
                        ...p,
                        auto_check_age_days: Math.max(1, Number(e.target.value) || 1),
                      }))
                    }
                  />
                  <span style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
                    Claims aren&apos;t polled until they&apos;ve been in Payer
                    Received this many days (default 3).
                  </span>
                </label>
                <label className="field-label">
                  Re-check at most every (days)
                  <input
                    type="number"
                    min={1}
                    max={365}
                    disabled={!payerAutoCheck.enabled}
                    value={payerAutoCheck.auto_recheck_interval_days}
                    onChange={(e) =>
                      setPayerAutoCheck((p) => ({
                        ...p,
                        auto_recheck_interval_days: Math.max(1, Number(e.target.value) || 1),
                      }))
                    }
                  />
                  <span style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}>
                    Skip a claim if any inquiry (manual or auto) already ran
                    within this window (default 2).
                  </span>
                </label>
              </div>
            </div>
          </section>

          <section className="panel form-panel">
            <h2>Recent settings changes</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", marginBottom: "var(--space-3)" }}>
              Audit trail of who changed any field on this page and when.
              Covers claim defaults, timing &amp; aging, workqueue automation,
              277CA auto-routing, and payer-status auto-check. Shows the last{" "}
              {recentChanges.length || "20"} edits.
            </p>
            {recentChanges.length === 0 ? (
              <div className="empty-state" style={{ padding: "var(--space-3)" }}>
                No changes recorded yet for this organization.
              </div>
            ) : (
              <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                {recentChanges.map((change) => {
                  const actor = change.actor_label
                    ?? (change.user_id ? `User ${change.user_id.slice(0, 8)}` : "Unknown user");
                  const role = change.user_role ? ` (${change.user_role})` : "";
                  const beforeStr = formatChangeValue(change.before_value);
                  const afterStr = formatChangeValue(change.after_value);
                  const group = ACTION_GROUP_LABELS[change.action] ?? change.action;
                  return (
                    <li
                      key={change.id}
                      style={{
                        padding: "var(--space-3)",
                        background: "var(--surface-subtle, #f8fafc)",
                        borderRadius: "var(--radius-md, 6px)",
                        fontSize: "var(--text-sm)",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-2)" }}>
                        <div style={{ fontWeight: 600 }}>{change.field_label}</div>
                        <div style={{ color: "var(--text-secondary)", fontSize: "var(--text-xs, 12px)" }}>{group}</div>
                      </div>
                      <div>
                        <code>{beforeStr}</code> → <code>{afterStr}</code>
                      </div>
                      <div style={{ color: "var(--text-secondary)", marginTop: "var(--space-1)" }}>
                        {formatChangeTimestamp(change.created_at)} · {actor}{role}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <div style={{ padding: "0 var(--space-6) var(--space-6)" }}>
            <button className="button button-primary" onClick={handleSave} disabled={saving || !organizationId}>
              {saving ? "Saving…" : "Save Billing Defaults"}
            </button>
          </div>
        </>
      )}
    </main>
  );
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diffMs = Date.now() - ts;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Surfaces the most recent cron-run snapshot so practices can see whether
 * the nightly auto-check is actually firing on their settings. When the
 * org has the feature switched off, says so explicitly (instead of
 * looking like the cron is broken).
 */
function AutoCheckLastRunTile({ heartbeat }: { heartbeat: AutoCheckHeartbeat }) {
  const summary = heartbeat.lastRunSummary ?? null;
  const baseStyle: React.CSSProperties = {
    marginBottom: "var(--space-4)",
    padding: "var(--space-3)",
    borderRadius: "var(--radius-md, 6px)",
    background: "var(--surface-subtle, #f8fafc)",
    border: "1px solid var(--border-default, #e2e8f0)",
    fontSize: "var(--text-sm)",
  };

  if (summary?.disabled) {
    return (
      <div data-testid="auto-check-last-run-tile" style={baseStyle}>
        <div style={{ fontWeight: 600 }}>Payer auto-check is disabled for this organization.</div>
        <div style={{ color: "var(--text-secondary)", marginTop: "var(--space-1)" }}>
          The scheduled cron last checked in {formatRelative(summary.ran_at)} and intentionally
          skipped this org. Re-enable it above to resume auto-polling the Payer Received queue.
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div data-testid="auto-check-last-run-tile" style={baseStyle}>
        <div style={{ fontWeight: 600 }}>No recorded auto-check run yet for this organization.</div>
        <div style={{ color: "var(--text-secondary)", marginTop: "var(--space-1)" }}>
          The next time the nightly cron runs, you&apos;ll see when it ran and what it did here.
        </div>
      </div>
    );
  }

  return (
    <div data-testid="auto-check-last-run-tile" style={baseStyle}>
      <div style={{ fontWeight: 600 }}>
        Last auto-check run: {formatRelative(summary.ran_at)}
      </div>
      <div style={{ color: "var(--text-secondary)", marginTop: "var(--space-1)" }}>
        Scanned {summary.scanned} · polled {summary.dispatched} · skipped {summary.skipped}
        {summary.failures > 0 ? ` · failures ${summary.failures}` : ""} ·{" "}
        <span title={new Date(summary.ran_at).toLocaleString()}>
          {new Date(summary.ran_at).toLocaleString()}
        </span>
      </div>
    </div>
  );
}
