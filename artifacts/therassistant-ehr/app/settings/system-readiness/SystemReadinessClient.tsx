"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import { useUserRole } from "@/lib/store/userRole";

type Severity = "blocking" | "warning" | "info";

type Category =
  | "organization"
  | "providers"
  | "locations"
  | "payers"
  | "clearinghouse"
  | "feeSchedules"
  | "billingDefaults";

type Finding = {
  ruleId: string;
  category: Category;
  severity: Severity;
  message: string;
  fixRoute: string;
  whyItMatters: string;
  resolution: string;
  evidence?: Record<string, unknown>;
};

type ReadinessReport = {
  organizationId: string;
  organizationName: string | null;
  generatedAt: string;
  summary: {
    total: number;
    blocking: number;
    warning: number;
    info: number;
    ready: boolean;
  };
  findings: Finding[];
  findingsByCategory: Record<Category, Finding[]>;
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

const CATEGORY_LABELS: Record<Category, string> = {
  organization: "Organization",
  providers: "Providers",
  locations: "Service Locations",
  payers: "Payers",
  clearinghouse: "Clearinghouse",
  feeSchedules: "Fee Schedules",
  billingDefaults: "Billing Defaults",
};

const CATEGORY_ORDER: Category[] = [
  "organization",
  "billingDefaults",
  "providers",
  "locations",
  "payers",
  "clearinghouse",
  "feeSchedules",
];

const SEVERITY_LABEL: Record<Severity, string> = {
  blocking: "Blocking",
  warning: "Warning",
  info: "Info",
};

const SEVERITY_COLOR: Record<Severity, string> = {
  blocking: "var(--text-danger, #c53030)",
  warning: "var(--text-warning, #b45309)",
  info: "var(--accent, #2563eb)",
};

type SeedResult = {
  success: boolean;
  reset?: boolean;
  seeded_at?: string;
  results?: Record<string, string>;
  errors?: Record<string, string>;
  error?: string;
};

type ClearResult = {
  success: boolean;
  cleared_at?: string;
  total_deleted?: number;
  counts?: Record<string, number>;
  errors?: Record<string, string>;
  error?: string;
};

type SimulationCheck = {
  id: string;
  label: string;
  status: "pass" | "fail" | "skipped";
  detail: string;
};

type SimulationReport = {
  organizationId: string;
  generatedAt: string;
  transmitted: false;
  containsPhi: false;
  configReady: boolean;
  configBlocking: number;
  simulationReady: boolean;
  checks: SimulationCheck[];
  chosenEntities: {
    providerName: string | null;
    locationName: string | null;
    payerName: string | null;
    feeScheduleCpt: string | null;
    clearinghouseVendor: string | null;
  };
  syntheticClaim: {
    patientName: string;
    patientDob: string;
    memberId: string;
    serviceDate: string;
    cpt: string | null;
    diagnosisCode: string;
  };
};

const SIM_STATUS_COLOR: Record<SimulationCheck["status"], string> = {
  pass: "var(--text-success, #15803d)",
  fail: "var(--text-danger, #c53030)",
  skipped: "var(--text-secondary, #6b7280)",
};

const SIM_STATUS_LABEL: Record<SimulationCheck["status"], string> = {
  pass: "PASS",
  fail: "FAIL",
  skipped: "SKIP",
};

export default function SystemReadinessClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const { role } = useUserRole();
  const isAdmin = role === "admin_biller";
  const [data, setData] = useState<ReadinessReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<SeedResult | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearResult, setClearResult] = useState<ClearResult | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearConfirmText, setClearConfirmText] = useState("");
  const [simulating, setSimulating] = useState(false);
  const [simulation, setSimulation] = useState<SimulationReport | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);

  const runSimulation = useCallback(async () => {
    if (!organizationId) return;
    setSimulating(true);
    setSimulationError(null);
    setSimulation(null);
    try {
      const res = await fetch("/api/settings/system-readiness/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "Simulation failed");
      setSimulation(json as SimulationReport);
    } catch (e) {
      setSimulationError(e instanceof Error ? e.message : "Simulation failed.");
    } finally {
      setSimulating(false);
    }
  }, [organizationId]);

  const load = useCallback(() => {
    if (!organizationId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`/api/settings/system-readiness?organizationId=${encodeURIComponent(organizationId)}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json?.error ?? "Failed to load");
        return json as ReadinessReport;
      })
      .then((json) => setData(json))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load system readiness."))
      .finally(() => setLoading(false));
  }, [organizationId]);

  const runClear = useCallback(async () => {
    setClearing(true);
    setClearResult(null);
    try {
      const res = await fetch("/api/admin/clear-demo-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const json: ClearResult = await res.json();
      setClearResult(json);
      if (json.success) {
        setShowClearConfirm(false);
        setClearConfirmText("");
        load();
      }
    } catch {
      setClearResult({ success: false, error: "Network error — could not reach clear endpoint." });
    } finally {
      setClearing(false);
    }
  }, [load]);

  const runSeed = useCallback(
    async (force = false) => {
      setSeeding(true);
      setSeedResult(null);
      setShowResetConfirm(false);
      try {
        const res = await fetch("/api/admin/seed-settings", {
          method: "POST",
          headers: force ? { "Content-Type": "application/json" } : undefined,
          body: force ? JSON.stringify({ force: true }) : undefined,
        });
        const json: SeedResult = await res.json();
        setSeedResult(json);
        if (json.success) load();
      } catch {
        setSeedResult({ success: false, error: "Network error — could not reach seed endpoint." });
      } finally {
        setSeeding(false);
      }
    },
    [load],
  );

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    load();
  }, [load]);

  const fixHref = (route: string) =>
    `${route}${organizationId ? `${route.includes("?") ? "&" : "?"}organizationId=${organizationId}` : ""}`;

  const orderedCategories = useMemo(() => {
    if (!data) return [] as Category[];
    return CATEGORY_ORDER.filter((c) => (data.findingsByCategory[c]?.length ?? 0) > 0);
  }, [data]);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>System Readiness</h1>
          <p className="hero-copy">
            Configuration validation — blocking items must be resolved before claims can be transmitted; warnings and
            info items improve reliability and downstream automation.
          </p>
        </div>
        <div className="hero-actions">
          {isAdmin && (
            <>
              <button
                className="button button-primary"
                onClick={() => runSeed(false)}
                disabled={seeding || loading || showResetConfirm}
              >
                {seeding ? "Seeding…" : "Seed Demo Data"}
              </button>
              {showResetConfirm ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    background: "var(--surface-2, #f4f6f9)",
                    border: "1px solid var(--text-danger, #c53030)",
                    borderRadius: "var(--radius, 6px)",
                    padding: "6px 12px",
                  }}
                >
                  <span style={{ fontSize: "var(--text-sm)", color: "var(--text-danger, #c53030)", fontWeight: 600 }}>
                    Deletes &amp; re-inserts all demo records — continue?
                  </span>
                  <button
                    className="button button-danger"
                    style={{ padding: "4px 10px", fontSize: "var(--text-sm)" }}
                    onClick={() => runSeed(true)}
                    disabled={seeding}
                  >
                    Yes, reset
                  </button>
                  <button
                    className="button button-secondary"
                    style={{ padding: "4px 10px", fontSize: "var(--text-sm)" }}
                    onClick={() => setShowResetConfirm(false)}
                    disabled={seeding}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  className="button button-secondary"
                  onClick={() => setShowResetConfirm(true)}
                  disabled={seeding || loading}
                >
                  Reset Demo Data
                </button>
              )}
              {showClearConfirm ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    background: "var(--surface-2, #f4f6f9)",
                    border: "1px solid var(--text-danger, #c53030)",
                    borderRadius: "var(--radius, 6px)",
                    padding: "6px 12px",
                  }}
                >
                  <span style={{ fontSize: "var(--text-sm)", color: "var(--text-danger, #c53030)", fontWeight: 600 }}>
                    Permanently wipe ALL demo records — type DELETE to confirm:
                  </span>
                  <input
                    type="text"
                    value={clearConfirmText}
                    onChange={(e) => setClearConfirmText(e.target.value)}
                    placeholder="DELETE"
                    autoFocus
                    style={{
                      padding: "4px 8px",
                      fontSize: "var(--text-sm)",
                      border: "1px solid var(--border, #d1d5db)",
                      borderRadius: "var(--radius, 4px)",
                      width: 90,
                    }}
                    disabled={clearing}
                  />
                  <button
                    className="button button-danger"
                    style={{ padding: "4px 10px", fontSize: "var(--text-sm)" }}
                    onClick={runClear}
                    disabled={clearing || clearConfirmText !== "DELETE"}
                  >
                    {clearing ? "Clearing…" : "Wipe data"}
                  </button>
                  <button
                    className="button button-secondary"
                    style={{ padding: "4px 10px", fontSize: "var(--text-sm)" }}
                    onClick={() => {
                      setShowClearConfirm(false);
                      setClearConfirmText("");
                    }}
                    disabled={clearing}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  className="button button-danger"
                  onClick={() => setShowClearConfirm(true)}
                  disabled={clearing || loading || seeding}
                  title="Permanently delete every patient, appointment, encounter, claim, ERA, invoice, mailroom item, workqueue item, and chat record for this organization. Keeps providers, payers, code sets, and billing settings."
                >
                  Clear all demo data
                </button>
              )}
            </>
          )}
          <button
            className="button button-secondary"
            onClick={runSimulation}
            disabled={simulating || loading || !organizationId}
            title="Synthesise a non-PHI test claim and verify every dependency. Nothing is transmitted."
          >
            {simulating ? "Simulating…" : "Run Test Claim Simulation"}
          </button>
          <button className="button button-secondary" onClick={load} disabled={loading}>
            {loading ? "Checking…" : "Refresh"}
          </button>
          <Link className="button button-secondary" href="/settings">
            ← Settings
          </Link>
        </div>
      </section>

      {!organizationId && <div className="alert-panel">No organization context.</div>}
      {error && <div className="alert-panel">{error}</div>}
      {simulationError && <div className="alert-panel">Simulation: {simulationError}</div>}

      {simulation && (
        <section
          className="panel"
          style={{
            borderLeft: `3px solid ${
              simulation.simulationReady ? "var(--text-success, #15803d)" : "var(--text-danger, #c53030)"
            }`,
          }}
        >
          <h2 style={{ marginBottom: "var(--space-2)" }}>
            Test Claim Simulation —{" "}
            {simulation.simulationReady ? (
              <span style={{ color: "var(--text-success, #15803d)" }}>✓ Would succeed</span>
            ) : (
              <span style={{ color: "var(--text-danger, #c53030)" }}>⚠ Would fail</span>
            )}
          </h2>
          <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: "0 0 var(--space-3)" }}>
            Synthetic claim — no PHI, never transmitted. Patient &quot;{simulation.syntheticClaim.patientName}&quot;,
            DOB {simulation.syntheticClaim.patientDob}, member {simulation.syntheticClaim.memberId}, service date{" "}
            {simulation.syntheticClaim.serviceDate}, CPT {simulation.syntheticClaim.cpt ?? "—"}, dx{" "}
            {simulation.syntheticClaim.diagnosisCode}.
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
            {simulation.checks.map((c) => (
              <li
                key={c.id}
                style={{
                  display: "flex",
                  gap: "var(--space-3)",
                  alignItems: "baseline",
                  padding: "var(--space-2) var(--space-3)",
                  background: "var(--surface-2, #f7f9fc)",
                  borderRadius: "var(--radius, 6px)",
                  borderLeft: `3px solid ${SIM_STATUS_COLOR[c.status]}`,
                }}
              >
                <span
                  style={{
                    fontSize: "var(--text-xs, 0.7rem)",
                    fontWeight: 700,
                    letterSpacing: "0.05em",
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: SIM_STATUS_COLOR[c.status],
                    color: "white",
                    minWidth: 48,
                    textAlign: "center",
                  }}
                >
                  {SIM_STATUS_LABEL[c.status]}
                </span>
                <span style={{ minWidth: 200, fontWeight: 600 }}>{c.label}</span>
                <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>{c.detail}</span>
              </li>
            ))}
          </ul>
          <p
            style={{
              fontSize: "var(--text-xs, 0.7rem)",
              color: "var(--text-secondary)",
              textAlign: "right",
              marginTop: "var(--space-3)",
            }}
          >
            Simulation generated {new Date(simulation.generatedAt).toLocaleString()} · transmitted=false ·
            containsPhi=false
          </p>
        </section>
      )}

      {clearResult && (
        <section
          className="panel"
          style={{
            borderLeft: `3px solid ${clearResult.success ? "var(--text-success)" : "var(--text-danger)"}`,
          }}
        >
          <h2 style={{ marginBottom: "var(--space-3)" }}>
            {clearResult.success
              ? `✓ Demo data cleared — ${clearResult.total_deleted ?? 0} record${
                  (clearResult.total_deleted ?? 0) !== 1 ? "s" : ""
                } deleted`
              : "⚠ Clear failed"}
          </h2>
          {clearResult.error && (
            <p style={{ color: "var(--text-danger)", fontSize: "var(--text-sm)" }}>{clearResult.error}</p>
          )}
          {clearResult.counts && Object.keys(clearResult.counts).length > 0 && (
            <ul
              style={{
                margin: 0,
                paddingLeft: "var(--space-4)",
                fontSize: "var(--text-sm)",
                color: "var(--text-secondary)",
                columns: 2,
              }}
            >
              {Object.entries(clearResult.counts)
                .sort((a, b) => b[1] - a[1])
                .map(([table, n]) => (
                  <li key={table}>
                    <code>{table}</code>: {n}
                  </li>
                ))}
            </ul>
          )}
          {clearResult.errors && Object.keys(clearResult.errors).length > 0 && (
            <div style={{ marginTop: "var(--space-3)" }}>
              <strong style={{ color: "var(--text-danger)", fontSize: "var(--text-sm)" }}>Errors:</strong>
              <ul style={{ margin: 0, paddingLeft: "var(--space-4)", fontSize: "var(--text-sm)" }}>
                {Object.entries(clearResult.errors).map(([table, msg]) => (
                  <li key={table}>
                    <code>{table}</code>: {msg}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {clearResult.cleared_at && (
            <p style={{ fontSize: "var(--text-xs, 0.75rem)", color: "var(--text-secondary)", marginTop: 8 }}>
              Cleared at {new Date(clearResult.cleared_at).toLocaleString()}
            </p>
          )}
        </section>
      )}

      {seedResult && (
        <section
          className="panel"
          style={{
            borderLeft: `3px solid ${seedResult.success ? "var(--text-success)" : "var(--text-danger)"}`,
          }}
        >
          <h2 style={{ marginBottom: "var(--space-3)" }}>
            {seedResult.success
              ? seedResult.reset
                ? "⚡ Demo Data Reset & Re-seeded"
                : "✓ Demo Data Seeded"
              : "⚠ Seed Encountered Issues"}
          </h2>
          {seedResult.error && (
            <p style={{ color: "var(--text-danger)", fontSize: "var(--text-sm)" }}>{seedResult.error}</p>
          )}
          {seedResult.seeded_at && (
            <p style={{ fontSize: "var(--text-xs, 0.75rem)", color: "var(--text-secondary)", marginTop: 8 }}>
              {seedResult.reset ? "Reset" : "Seeded"} at {new Date(seedResult.seeded_at).toLocaleString()}
            </p>
          )}
        </section>
      )}

      {loading && (
        <div className="panel">
          <div className="empty-state">Running configuration validation…</div>
        </div>
      )}

      {!loading && data && (
        <>
          <section className="metric-grid">
            <article className="metric-card">
              <span>Overall</span>
              <strong>
                {data.summary.ready ? (
                  <span style={{ color: "var(--text-success)" }}>✓ Ready to bill</span>
                ) : (
                  <span style={{ color: "var(--text-danger)" }}>⚠ Not ready</span>
                )}
              </strong>
            </article>
            <article className="metric-card">
              <span>Blocking</span>
              <strong style={{ color: data.summary.blocking > 0 ? SEVERITY_COLOR.blocking : undefined }}>
                {data.summary.blocking}
              </strong>
            </article>
            <article className="metric-card">
              <span>Warning</span>
              <strong style={{ color: data.summary.warning > 0 ? SEVERITY_COLOR.warning : undefined }}>
                {data.summary.warning}
              </strong>
            </article>
            <article className="metric-card">
              <span>Info</span>
              <strong style={{ color: data.summary.info > 0 ? SEVERITY_COLOR.info : undefined }}>
                {data.summary.info}
              </strong>
            </article>
          </section>

          {data.summary.blocking > 0 && (
            <div className="alert-panel">
              <strong>
                {data.summary.blocking} blocking item{data.summary.blocking !== 1 ? "s" : ""} must be resolved before
                claim submission.
              </strong>{" "}
              Use the &quot;Fix&quot; links below to address each finding.
            </div>
          )}

          {data.summary.total === 0 && (
            <section className="panel">
              <div className="empty-state">
                <strong style={{ color: "var(--text-success)" }}>All configuration checks passed.</strong>
                <p style={{ marginTop: 8, color: "var(--text-secondary)" }}>
                  No blocking, warning, or informational findings for this organization.
                </p>
              </div>
            </section>
          )}

          {orderedCategories.map((cat) => {
            const findings = data.findingsByCategory[cat];
            return (
              <section key={cat} className="panel">
                <h2 style={{ marginBottom: "var(--space-3)" }}>
                  {CATEGORY_LABELS[cat]}{" "}
                  <span style={{ color: "var(--text-secondary)", fontSize: "0.85em", fontWeight: 400 }}>
                    ({findings.length} finding{findings.length !== 1 ? "s" : ""})
                  </span>
                </h2>
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-3)" }}>
                  {findings.map((f) => (
                    <li
                      key={f.ruleId}
                      style={{
                        padding: "var(--space-4)",
                        background: "var(--surface-2, #f7f9fc)",
                        borderLeft: `3px solid ${SEVERITY_COLOR[f.severity]}`,
                        borderRadius: "var(--radius, 6px)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          gap: "var(--space-3)",
                          alignItems: "baseline",
                          flexWrap: "wrap",
                          marginBottom: 6,
                        }}
                      >
                        <span
                          style={{
                            fontSize: "var(--text-xs, 0.7rem)",
                            fontWeight: 700,
                            letterSpacing: "0.04em",
                            textTransform: "uppercase",
                            padding: "2px 8px",
                            borderRadius: 999,
                            background: SEVERITY_COLOR[f.severity],
                            color: "white",
                          }}
                        >
                          {SEVERITY_LABEL[f.severity]}
                        </span>
                        <strong style={{ fontSize: "var(--text-md, 0.95rem)" }}>{f.message}</strong>
                        <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", fontFamily: "monospace" }}>
                          {f.ruleId}
                        </span>
                      </div>
                      <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: "4px 0" }}>
                        <strong>Why it matters: </strong>
                        {f.whyItMatters}
                      </p>
                      <p style={{ fontSize: "var(--text-sm)", margin: "4px 0" }}>
                        <strong>How to resolve: </strong>
                        {f.resolution}
                      </p>
                      <div style={{ marginTop: 8 }}>
                        <Link
                          href={fixHref(f.fixRoute)}
                          style={{
                            color: "var(--accent)",
                            fontSize: "var(--text-sm)",
                            textDecoration: "underline",
                          }}
                        >
                          Fix in {CATEGORY_LABELS[f.category]} →
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

          <p style={{ fontSize: "var(--text-xs, 0.7rem)", color: "var(--text-secondary)", textAlign: "right" }}>
            Generated {new Date(data.generatedAt).toLocaleString()}
          </p>
        </>
      )}
    </main>
  );
}
