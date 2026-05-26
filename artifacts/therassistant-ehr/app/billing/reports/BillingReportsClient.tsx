"use client";

import { useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import { generateBillingInsights, type Insight } from "@/lib/billing/reportInsights";
import { Sparkline, LineChart, HBarChart, StackedBar, Donut } from "./charts";

type MonthlyHeadline = {
  month: string;
  claimsSubmitted: number;
  claimsPaid: number;
  denials: number;
  chargesSubmitted: number;
  paymentsPosted: number;
  paymentCount: number;
  outstandingAR: number;
  averageDaysInAR: number | null;
  collectionRate: number;
};

type PayerCallVolumeEntry = {
  payerProfileId: string | null;
  payerName: string;
  totalAttempts: number;
  spokeWithRep: number;
  leftVoicemail: number;
  noAnswer: number;
  faxes: number;
  otherDialed: number;
};

type DenialEntry = {
  groupCode: string;
  reasonCode: string;
  carcCode: string;
  occurrences: number;
  totalAmount: number;
};

type PayerPerformanceEntry = {
  payerProfileId: string | null;
  payerName: string;
  totalClaims: number;
  acceptedClaims: number;
  paidClaims: number;
  rejectedClaims: number;
  acceptanceRate: number;
  averageTurnaroundDays: number | null;
  totalCharge: number;
};

type ReportPayload = {
  success?: boolean;
  error?: string;
  month?: string;
  claims?: {
    submitted: number;
    paid: number;
    deniedOrRejected: number;
    totalChargeSubmitted: number;
  };
  payments?: {
    count: number;
    totalAmount: number;
  };
  workqueue?: {
    created: number;
    resolved: number;
    deferred: number;
    openNow: number;
  };
  aging?: {
    bucket0to30: { count: number; totalCharge: number };
    bucket31to60: { count: number; totalCharge: number };
    bucket61Plus: { count: number; totalCharge: number };
    totalOutstanding: number;
  };
  denials?: {
    totalAdjustmentAmount: number;
    totalAdjustmentCount: number;
    breakdown: DenialEntry[];
  };
  payerPerformance?: PayerPerformanceEntry[];
  payerCallVolume?: {
    totalAttempts: number;
    spokeWithRep: number;
    leftVoicemail: number;
    noAnswer: number;
    faxes: number;
    voicemailRate: number;
    averageAttemptsPerClaim: number;
    breakdown: PayerCallVolumeEntry[];
  };
  patientResponsibility?: {
    openBalance: number;
    invoiceCount: number;
    collectionsCount: number;
    collectionsBalance: number;
    averageOpenBalance: number;
  };
  priorMonth?: MonthlyHeadline;
  timeSeries?: MonthlyHeadline[];
  derived?: {
    collectionRate: number;
    netCollectionPct: number;
    contractualAdjustments: number;
    averageDaysInAR: number | null;
    outstandingAR: number;
    topDenial: {
      carcCode: string;
      groupCode: string;
      reasonCode: string;
      occurrences: number;
      totalAmount: number;
      payerName: string | null;
    } | null;
  };
  operational?: {
    unresolvedClaims: number;
    eraLagAverageDays: number | null;
    eraUnpostedCount: number;
    eraUnmatchedCount: number;
    authIssuesOpen: number;
  };
  clinicianProductivity?: Array<{
    providerId: string;
    providerName: string;
    claimsSubmitted: number;
    chargesSubmitted: number;
  }>;
};

type Provider = { id: string; provider_name: string };

type ViewerRole = "owner" | "biller" | "clinician";

const ROLE_LABEL: Record<ViewerRole, string> = {
  owner: "Practice Owner",
  biller: "Biller",
  clinician: "Clinician",
};

function getOrganizationId() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
  return (
    new URLSearchParams(window.location.search).get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    DEFAULT_ORG_ID
  );
}

function money(value: number | null | undefined) {
  const amount = Number(value ?? 0);
  return amount.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function moneyFull(value: number | null | undefined) {
  const amount = Number(value ?? 0);
  return amount.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function compactMonth(value: string) {
  if (!/^\d{4}-\d{2}$/.test(value)) return value;
  const d = new Date(`${value}-01T00:00:00`);
  return d.toLocaleString(undefined, { month: "short" });
}

function formatMonth(value: string) {
  if (!value) return "Current month";
  const parsed = new Date(`${value}-01T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, { month: "long", year: "numeric" });
}

function thisMonth() {
  const now = new Date();
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  return `${now.getFullYear()}-${m}`;
}

/* Compute a percent change between current and prior. Returns null when
 * the prior baseline is missing or zero (can't meaningfully compare). */
function delta(current: number | null | undefined, prior: number | null | undefined): number | null {
  if (current == null || prior == null) return null;
  if (!Number.isFinite(current) || !Number.isFinite(prior)) return null;
  if (prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

/* Absolute change (current - prior). Used when the metric is already a rate
 * or duration where a "% of %" would be misleading (e.g. collection rate
 * expressed as points, average days in AR expressed as days). */
function absDelta(current: number | null | undefined, prior: number | null | undefined): number | null {
  if (current == null || prior == null) return null;
  if (!Number.isFinite(current) || !Number.isFinite(prior)) return null;
  return current - prior;
}

function pickPrimaryRole(roles: string[] | undefined | null): ViewerRole {
  const list = (roles ?? []).map((r) => r.toLowerCase());
  if (list.includes("admin") || list.includes("supervisor")) return "owner";
  if (list.includes("biller")) return "biller";
  if (list.includes("clinician")) return "clinician";
  return "owner";
}

function rolesAvailable(roles: string[] | undefined | null): ViewerRole[] {
  const list = new Set<ViewerRole>();
  const lower = (roles ?? []).map((r) => r.toLowerCase());
  if (lower.includes("admin") || lower.includes("supervisor")) list.add("owner");
  if (lower.includes("biller")) list.add("biller");
  if (lower.includes("clinician")) list.add("clinician");
  if (list.size === 0) {
    list.add("owner");
    list.add("biller");
    list.add("clinician");
  }
  return Array.from(list);
}

/* ── Headline KPI card ─────────────────────────────────────────────────── */

type HeadlineProps = {
  label: string;
  value: string;
  spark?: number[];
  delta?: number | null;
  deltaSuffix?: string;
  inverse?: boolean; // when true, a drop is "good" (e.g. days in AR)
  footnote?: string;
};

function HeadlineCard({ label, value, spark, delta: d, deltaSuffix = "%", inverse, footnote }: HeadlineProps) {
  let deltaTone: "positive" | "negative" | "neutral" = "neutral";
  if (d != null && Number.isFinite(d)) {
    if (d > 0) deltaTone = inverse ? "negative" : "positive";
    else if (d < 0) deltaTone = inverse ? "positive" : "negative";
  }
  const deltaColor =
    deltaTone === "positive" ? "var(--success)" : deltaTone === "negative" ? "var(--danger)" : "var(--muted)";
  const arrow = d == null || !Number.isFinite(d) || d === 0 ? "·" : d > 0 ? "▲" : "▼";

  return (
    <article className="kpi-card">
      <div className="kpi-card-head">
        <span className="kpi-label">{label}</span>
        {spark ? (
          <Sparkline values={spark} color={deltaTone === "negative" ? "#b02020" : "#5e8a6a"} />
        ) : null}
      </div>
      <strong className="kpi-value">{value}</strong>
      <div className="kpi-delta-row">
        <span style={{ color: deltaColor, fontWeight: 600, fontSize: 12 }}>
          {arrow}{" "}
          {d == null || !Number.isFinite(d)
            ? "no prior period"
            : `${Math.abs(d).toFixed(deltaSuffix === "%" ? 1 : 0)}${deltaSuffix} vs last month`}
        </span>
        {footnote ? <span className="kpi-footnote">{footnote}</span> : null}
      </div>
    </article>
  );
}

/* ── Operational secondary card ────────────────────────────────────────── */

function OpsCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <article className="ops-card">
      <span className="ops-label">{label}</span>
      <strong className="ops-value">{value}</strong>
      {sub ? <span className="ops-sub">{sub}</span> : null}
    </article>
  );
}

/* ── Insight banner ────────────────────────────────────────────────────── */

function InsightBanners({ insights }: { insights: Insight[] }) {
  if (insights.length === 0) return null;
  return (
    <div className="insight-stack">
      {insights.map((ins, i) => (
        <div key={i} className={`insight-banner insight-${ins.tone}`}>
          <span className="insight-dot" aria-hidden />
          <span>{ins.message}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Main client ───────────────────────────────────────────────────────── */

export default function BillingReportsClient() {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [month, setMonth] = useState(thisMonth());
  const [scope, setScope] = useState<string>("practice");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [payload, setPayload] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState<string | null>(null);
  const [viewerRoles, setViewerRoles] = useState<string[]>([]);
  const [role, setRole] = useState<ViewerRole>("owner");
  const [roleManuallySet, setRoleManuallySet] = useState(false);
  const missingOrgMessage =
    "Missing organizationId. Add ?organizationId=... or configure NEXT_PUBLIC_ORGANIZATION_ID.";

  // Load viewer info for role-aware emphasis.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { roles?: string[] };
        if (cancelled) return;
        setViewerRoles(Array.isArray(json.roles) ? json.roles : []);
        if (!roleManuallySet) setRole(pickPrimaryRole(json.roles));
      } catch {
        /* role detection is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Providers for the scope dropdown.
  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/providers?organizationId=${encodeURIComponent(organizationId)}`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (cancelled) return;
        if (res.ok && json?.success !== false) {
          const rows = Array.isArray(json?.providers) ? json.providers : Array.isArray(json) ? json : [];
          setProviders(
            rows.map((p: { id: string; provider_name?: string; name?: string }) => ({
              id: String(p.id),
              provider_name: String(p.provider_name ?? p.name ?? "Unnamed clinician"),
            })),
          );
        }
      } catch {
        /* providers list is optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  // Report payload.
  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ organizationId, month });
        if (scope !== "practice") params.set("providerId", scope);
        const response = await fetch(`/api/billing/reports?${params.toString()}`, { cache: "no-store" });
        const json = (await response.json()) as ReportPayload;
        if (cancelled) return;
        if (!response.ok || !json.success) throw new Error(json.error || "Failed to load billing report");
        setPayload(json);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load billing report");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [organizationId, month, scope]);

  const insights = useMemo(() => (payload ? generateBillingInsights(payload) : []), [payload]);

  const scopeLabel =
    scope === "practice"
      ? "Practice (all clinicians)"
      : providers.find((p) => p.id === scope)?.provider_name ?? "Clinician";

  const series = payload?.timeSeries ?? [];
  const prior = payload?.priorMonth;
  const derived = payload?.derived;
  const sparkSubmitted = series.map((s) => s.claimsSubmitted);
  const sparkPaid = series.map((s) => s.claimsPaid);
  const sparkDenials = series.map((s) => s.denials);
  const sparkCharges = series.map((s) => s.chargesSubmitted);
  const sparkPayments = series.map((s) => s.paymentsPosted);
  const sparkAR = series.map((s) => s.outstandingAR);
  const sparkCollection = series.map((s) => s.collectionRate);
  const sparkAvgDaysAR = series.map((s) => s.averageDaysInAR ?? 0);

  const topDenialLabel = derived?.topDenial
    ? `${derived.topDenial.carcCode}${
        derived.topDenial.payerName ? ` · ${derived.topDenial.payerName}` : ""
      } (${derived.topDenial.occurrences}×)`
    : "—";

  const availableRoles = rolesAvailable(viewerRoles);

  // Section visibility / ordering per role.
  const sectionOrder: Array<"snapshot" | "operational" | "trends" | "denials" | "payer" | "calls" | "clinician"> = (() => {
    switch (role) {
      case "biller":
        return ["snapshot", "denials", "operational", "trends", "payer", "calls"];
      case "clinician":
        return ["clinician", "snapshot", "operational", "trends"];
      case "owner":
      default:
        return ["snapshot", "trends", "payer", "operational", "denials", "calls"];
    }
  })();

  return (
    <main className="app-shell reports-shell">
      <section className="reports-hero">
        <div>
          <p className="eyebrow">Billing</p>
          <h1>Revenue Overview</h1>
          <p className="hero-copy">
            {formatMonth(payload?.month || month)} · <strong>{scopeLabel}</strong>
            {viewerRoles.length > 0 ? <> · Viewing as <strong>{ROLE_LABEL[role]}</strong></> : null}
          </p>
        </div>
        <div className="reports-toolbar">
          <label className="reports-control">
            <span>Month</span>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
          <label className="reports-control">
            <span>Scope</span>
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="practice">Practice (all clinicians)</option>
              {providers.length > 0 ? <optgroup label="Clinician" /> : null}
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.provider_name}
                </option>
              ))}
            </select>
          </label>
          {availableRoles.length > 1 ? (
            <label className="reports-control">
              <span>View as</span>
              <select
                value={role}
                onChange={(e) => {
                  setRole(e.target.value as ViewerRole);
                  setRoleManuallySet(true);
                }}
              >
                {availableRoles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </section>

      {!organizationId ? <div className="alert-panel">{missingOrgMessage}</div> : null}
      {error ? <div className="alert-panel">{error}</div> : null}
      {loading ? <div className="empty-state">Loading report…</div> : null}

      {!loading && payload ? <InsightBanners insights={insights} /> : null}

      {!loading && payload
        ? sectionOrder.map((section) => {
            switch (section) {
              case "snapshot":
                return (
                  <SnapshotSection
                    key={section}
                    payload={payload}
                    prior={prior}
                    derived={derived}
                    sparkSubmitted={sparkSubmitted}
                    sparkPaid={sparkPaid}
                    sparkDenials={sparkDenials}
                    sparkCharges={sparkCharges}
                    sparkPayments={sparkPayments}
                    sparkAR={sparkAR}
                    sparkCollection={sparkCollection}
                    sparkAvgDaysAR={sparkAvgDaysAR}
                    topDenialLabel={topDenialLabel}
                    scope={scope}
                  />
                );
              case "operational":
                return <OperationalSection key={section} payload={payload} />;
              case "trends":
                return (
                  <TrendsSection
                    key={section}
                    payload={payload}
                    series={series}
                    scope={scope}
                    providerLookup={providers}
                  />
                );
              case "denials":
                return <DenialsSection key={section} payload={payload} />;
              case "payer":
                return <PayerSection key={section} payload={payload} />;
              case "calls":
                return <CallsSection key={section} payload={payload} scope={scope} />;
              case "clinician":
                return <ClinicianSection key={section} payload={payload} scope={scope} />;
              default:
                return null;
            }
          })
        : null}
    </main>
  );
}

/* ── Sections ───────────────────────────────────────────────────────────── */

function SnapshotSection(props: {
  payload: ReportPayload;
  prior?: MonthlyHeadline;
  derived?: ReportPayload["derived"];
  sparkSubmitted: number[];
  sparkPaid: number[];
  sparkDenials: number[];
  sparkCharges: number[];
  sparkPayments: number[];
  sparkAR: number[];
  sparkCollection: number[];
  sparkAvgDaysAR: number[];
  topDenialLabel: string;
  scope: string;
}) {
  const {
    payload,
    prior,
    derived,
    sparkSubmitted,
    sparkPaid,
    sparkDenials,
    sparkCharges,
    sparkPayments,
    sparkAR,
    sparkCollection,
    sparkAvgDaysAR,
    topDenialLabel,
    scope,
  } = props;
  const claims = payload.claims;
  const payments = payload.payments;
  return (
    <section className="reports-section">
      <h2 className="reports-section-title">Executive Snapshot</h2>
      <div className="kpi-grid">
        <HeadlineCard
          label="Claims Submitted"
          value={String(claims?.submitted ?? 0)}
          spark={sparkSubmitted}
          delta={delta(claims?.submitted, prior?.claimsSubmitted)}
        />
        <HeadlineCard
          label="Claims Paid"
          value={String(claims?.paid ?? 0)}
          spark={sparkPaid}
          delta={delta(claims?.paid, prior?.claimsPaid)}
        />
        <HeadlineCard
          label="Denials / Rejections"
          value={String(claims?.deniedOrRejected ?? 0)}
          spark={sparkDenials}
          delta={delta(claims?.deniedOrRejected, prior?.denials)}
          inverse
        />
        <HeadlineCard
          label="Charges Submitted"
          value={money(claims?.totalChargeSubmitted ?? 0)}
          spark={sparkCharges}
          delta={delta(claims?.totalChargeSubmitted, prior?.chargesSubmitted)}
        />
        <HeadlineCard
          label="Payments Posted"
          value={money(payments?.totalAmount ?? 0)}
          spark={sparkPayments}
          delta={delta(payments?.totalAmount, prior?.paymentsPosted)}
          footnote={scope !== "practice" ? "Practice-wide" : undefined}
        />
        <HeadlineCard
          label="Outstanding AR"
          value={money(derived?.outstandingAR ?? 0)}
          spark={sparkAR}
          delta={delta(derived?.outstandingAR, prior?.outstandingAR)}
          inverse
        />
        <HeadlineCard
          label="Collection Rate"
          value={`${derived?.collectionRate ?? 0}%`}
          spark={sparkCollection}
          delta={absDelta(derived?.collectionRate, prior?.collectionRate)}
          deltaSuffix=" pts"
        />
        <HeadlineCard
          label="Avg Days in AR"
          value={derived?.averageDaysInAR != null ? String(Math.round(derived.averageDaysInAR)) : "—"}
          spark={sparkAvgDaysAR}
          delta={absDelta(derived?.averageDaysInAR ?? null, prior?.averageDaysInAR ?? null)}
          inverse
          deltaSuffix=" days"
        />
        <HeadlineCard
          label="Net Collection %"
          value={`${derived?.netCollectionPct ?? 0}%`}
          delta={null}
          footnote="of net (charges − contractual)"
        />
        <HeadlineCard label="Top Denial Reason" value={topDenialLabel} delta={null} />
      </div>
    </section>
  );
}

function OperationalSection({ payload }: { payload: ReportPayload }) {
  const wq = payload.workqueue;
  const calls = payload.payerCallVolume;
  const denials = payload.denials;
  const ops = payload.operational;
  return (
    <section className="reports-section">
      <h2 className="reports-section-title">Operational Health</h2>
      <div className="ops-grid">
        <OpsCard
          label="Unresolved claims"
          value={String(ops?.unresolvedClaims ?? 0)}
          sub="Submitted but not paid/denied"
        />
        <OpsCard
          label="ERA processing lag"
          value={ops?.eraLagAverageDays != null ? `${ops.eraLagAverageDays.toFixed(1)} d` : "—"}
          sub={`${ops?.eraUnpostedCount ?? 0} unposted`}
        />
        <OpsCard
          label="Unmatched ERAs"
          value={String(ops?.eraUnmatchedCount ?? 0)}
          sub="Need manual matching"
        />
        <OpsCard
          label="Auth / eligibility issues"
          value={String(ops?.authIssuesOpen ?? 0)}
          sub="Open in workqueue"
        />
        <OpsCard
          label="Payer call attempts"
          value={String(calls?.totalAttempts ?? 0)}
          sub={`Spoke w/ rep: ${calls?.spokeWithRep ?? 0}`}
        />
        <OpsCard
          label="Open workqueue items"
          value={String(wq?.openNow ?? 0)}
          sub={`${wq?.created ?? 0} created · ${wq?.resolved ?? 0} resolved`}
        />
        <OpsCard
          label="Adjustments posted"
          value={String(denials?.totalAdjustmentCount ?? 0)}
          sub={money(denials?.totalAdjustmentAmount ?? 0)}
        />
        <OpsCard
          label="Voicemail rate"
          value={`${calls?.voicemailRate ?? 0}%`}
          sub={`${calls?.faxes ?? 0} faxes`}
        />
      </div>
    </section>
  );
}

function TrendsSection({
  payload,
  series,
  scope,
  providerLookup,
}: {
  payload: ReportPayload;
  series: MonthlyHeadline[];
  scope: string;
  providerLookup: Provider[];
}) {
  const labels = series.map((s) => compactMonth(s.month));
  const denialBreakdown = (payload.denials?.breakdown ?? []).slice(0, 6);
  const aging = payload.aging;
  const payerPerf = (payload.payerPerformance ?? []).slice(0, 6);
  void scope;
  void providerLookup;
  return (
    <section className="reports-section">
      <h2 className="reports-section-title">Trends &amp; Visuals</h2>
      <div className="charts-grid">
        <div className="chart-card">
          <h3>Charges vs Payments</h3>
          <LineChart
            labels={labels}
            series={[
              { name: "Charges", color: "#10243f", values: series.map((s) => s.chargesSubmitted) },
              { name: "Payments", color: "#5e8a6a", values: series.map((s) => s.paymentsPosted) },
            ]}
            format={(n) => `$${n >= 1000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n)}`}
          />
        </div>
        <div className="chart-card">
          <h3>Denials Trend</h3>
          <LineChart
            labels={labels}
            series={[{ name: "Denials / rejections", color: "#b02020", values: series.map((s) => s.denials) }]}
          />
        </div>
        <div className="chart-card">
          <h3>Payer Mix (by claim volume)</h3>
          <Donut
            slices={payerPerf.map((p) => ({ label: p.payerName, value: p.totalClaims }))}
          />
        </div>
        <div className="chart-card">
          <h3>Top Denial CARCs</h3>
          <HBarChart
            items={denialBreakdown.map((d) => ({ label: d.carcCode, value: d.totalAmount }))}
            format={(n) => `$${n >= 1000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n)}`}
          />
        </div>
        <div className="chart-card chart-card-wide">
          <h3>Aging Buckets</h3>
          <StackedBar
            segments={[
              { label: "0–30 days", value: aging?.bucket0to30.totalCharge ?? 0, color: "#5e8a6a" },
              { label: "31–60 days", value: aging?.bucket31to60.totalCharge ?? 0, color: "#7a5000" },
              { label: "61+ days", value: aging?.bucket61Plus.totalCharge ?? 0, color: "#b02020" },
            ]}
          />
        </div>
        <div className="chart-card">
          <h3>Collections by Payer</h3>
          <HBarChart
            items={payerPerf.map((p) => ({ label: p.payerName, value: p.totalCharge }))}
            format={(n) => `$${n >= 1000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n)}`}
          />
        </div>
        {(payload.clinicianProductivity ?? []).length > 0 ? (
          <div className="chart-card chart-card-wide">
            <h3>Clinician Productivity (claims submitted)</h3>
            <HBarChart
              items={(payload.clinicianProductivity ?? []).map((c) => ({
                label: c.providerName,
                value: c.claimsSubmitted,
              }))}
              format={(n) => `${Math.round(n)}`}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function DenialsSection({ payload }: { payload: ReportPayload }) {
  const rows = payload.denials?.breakdown ?? [];
  if (rows.length === 0) {
    return (
      <section className="reports-section">
        <h2 className="reports-section-title">Denial Categories</h2>
        <div className="empty-state">No denial adjustments posted this month.</div>
      </section>
    );
  }
  return (
    <section className="reports-section">
      <h2 className="reports-section-title">Denial Categories</h2>
      <div className="reports-table-wrap">
        <table className="reports-table">
          <thead>
            <tr>
              <th>CARC</th>
              <th style={{ textAlign: "right" }}>Occurrences</th>
              <th style={{ textAlign: "right" }}>Adjustment $</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.carcCode}>
                <td>{row.carcCode}</td>
                <td style={{ textAlign: "right" }}>{row.occurrences}</td>
                <td style={{ textAlign: "right" }}>{moneyFull(row.totalAmount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PayerSection({ payload }: { payload: ReportPayload }) {
  const rows = payload.payerPerformance ?? [];
  if (rows.length === 0) return null;
  return (
    <section className="reports-section">
      <h2 className="reports-section-title">Payer Performance</h2>
      <div className="reports-table-wrap">
        <table className="reports-table">
          <thead>
            <tr>
              <th>Payer</th>
              <th style={{ textAlign: "right" }}>Claims</th>
              <th style={{ textAlign: "right" }}>Paid</th>
              <th style={{ textAlign: "right" }}>Acceptance</th>
              <th style={{ textAlign: "right" }}>Avg turnaround</th>
              <th style={{ textAlign: "right" }}>Charges</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.payerProfileId ?? row.payerName}>
                <td>{row.payerName}</td>
                <td style={{ textAlign: "right" }}>{row.totalClaims}</td>
                <td style={{ textAlign: "right" }}>{row.paidClaims}</td>
                <td style={{ textAlign: "right" }}>{row.acceptanceRate}%</td>
                <td style={{ textAlign: "right" }}>
                  {row.averageTurnaroundDays != null ? `${row.averageTurnaroundDays} d` : "—"}
                </td>
                <td style={{ textAlign: "right" }}>{moneyFull(row.totalCharge)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CallsSection({ payload, scope }: { payload: ReportPayload; scope: string }) {
  const call = payload.payerCallVolume;
  if (!call) return null;
  return (
    <section className="reports-section">
      <h2 className="reports-section-title">Payer Call Activity</h2>
      <p className="muted-text" style={{ marginTop: -4, marginBottom: 12 }}>
        Structured call attempts logged from the No Response → Call payer panel
        {scope !== "practice" ? " (practice-wide)" : ""}.
      </p>
      <div className="ops-grid">
        <OpsCard label="Attempts" value={String(call.totalAttempts)} />
        <OpsCard label="Spoke with rep" value={String(call.spokeWithRep)} />
        <OpsCard label="Voicemail" value={String(call.leftVoicemail)} />
        <OpsCard label="No answer" value={String(call.noAnswer)} />
        <OpsCard label="Faxes" value={String(call.faxes)} />
        <OpsCard label="Avg attempts / claim" value={String(call.averageAttemptsPerClaim)} />
      </div>
      {call.breakdown.length > 0 ? (
        <div className="reports-table-wrap" style={{ marginTop: 12 }}>
          <table className="reports-table">
            <thead>
              <tr>
                <th>Payer</th>
                <th style={{ textAlign: "right" }}>Attempts</th>
                <th style={{ textAlign: "right" }}>Spoke w/ rep</th>
                <th style={{ textAlign: "right" }}>Voicemail</th>
                <th style={{ textAlign: "right" }}>No answer</th>
                <th style={{ textAlign: "right" }}>Faxes</th>
              </tr>
            </thead>
            <tbody>
              {call.breakdown.map((row) => (
                <tr key={row.payerProfileId ?? row.payerName}>
                  <td>{row.payerName}</td>
                  <td style={{ textAlign: "right" }}>{row.totalAttempts}</td>
                  <td style={{ textAlign: "right" }}>{row.spokeWithRep}</td>
                  <td style={{ textAlign: "right" }}>{row.leftVoicemail}</td>
                  <td style={{ textAlign: "right" }}>{row.noAnswer}</td>
                  <td style={{ textAlign: "right" }}>{row.faxes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function ClinicianSection({ payload, scope }: { payload: ReportPayload; scope: string }) {
  const claims = payload.claims;
  if (scope === "practice") {
    return (
      <section className="reports-section">
        <h2 className="reports-section-title">Your Activity</h2>
        <div className="empty-state">
          Pick yourself from the Scope dropdown above to see clinician-specific metrics.
        </div>
      </section>
    );
  }
  return (
    <section className="reports-section">
      <h2 className="reports-section-title">Your Activity</h2>
      <div className="ops-grid">
        <OpsCard label="Sessions billed" value={String(claims?.submitted ?? 0)} />
        <OpsCard label="Claims paid" value={String(claims?.paid ?? 0)} />
        <OpsCard label="Denied / rejected" value={String(claims?.deniedOrRejected ?? 0)} />
        <OpsCard label="Charges submitted" value={money(claims?.totalChargeSubmitted ?? 0)} />
      </div>
      <p className="muted-text" style={{ marginTop: 8 }}>
        Attendance, no-show analytics, and unsigned-note counts are not yet wired into this report.
      </p>
    </section>
  );
}
