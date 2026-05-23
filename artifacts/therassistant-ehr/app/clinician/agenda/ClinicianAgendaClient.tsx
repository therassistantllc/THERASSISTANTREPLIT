"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";

type AgendaItem = {
  appointmentId: string;
  clientId: string;
  clientName: string;
  dateOfBirth: string | null;
  startTime: string | null;
  endTime: string | null;
  status: string | null;
  type: string | null;
  serviceLocation: string | null;
  telehealthUrl: string | null;
  encounter: { id: string; status: string | null } | null;
  checkIn: { status: string; checkedInAt: string | null } | null;
  eligibility: {
    id: string;
    status: string;
    rawStatus: string | null;
    checkedAt: string | null;
    copayAmount: string | number | null;
    deductibleRemaining: string | number | null;
    coverageStartDate: string | null;
    coverageEndDate: string | null;
    responseSummary: string | null;
  } | null;
  patientBalance: number;
};

type CommandCenterPayload = {
  success: boolean;
  error?: string;
  devFallback?: boolean;
  organizationId?: string;
  clinicianId?: string | null;
  date?: string;
  metrics?: {
    appointmentsToday: number;
    checkedIn: number;
    eligibilityMissingOrStale: number;
    eligibilityInactive: number;
    balancesToReview: number;
  };
  agenda?: AgendaItem[];
};

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

function formatTime(value: string | null) {
  if (!value) return "Time not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time not set";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatMoney(value: string | number | null | undefined) {
  const amount = Number(value ?? 0);
  return amount.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatDob(value: string | null) {
  if (!value) return "DOB not listed";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function eligibilityLabel(item: AgendaItem) {
  if (!item.eligibility) return "Eligibility not checked";
  if (item.eligibility.status === "stale") return "Eligibility stale";
  return `Eligibility ${item.eligibility.rawStatus ?? item.eligibility.status}`;
}

function checkInLabel(item: AgendaItem) {
  return item.checkIn ? "Checked in" : "Check-in not submitted";
}

function statusClass(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("active") && !normalized.includes("inactive")) return "status status-green";
  if (normalized.includes("checked in")) return "status status-green";
  if (normalized.includes("inactive") || normalized.includes("stale") || normalized.includes("not checked")) return "status status-red";
  if (normalized.includes("not submitted")) return "status status-yellow";
  return "status";
}

function emptyMetrics() {
  return {
    appointmentsToday: 0,
    checkedIn: 0,
    eligibilityMissingOrStale: 0,
    eligibilityInactive: 0,
    balancesToReview: 0,
  };
}

type ProviderOption = {
  id: string;
  provider_name: string;
  credential_display: string | null;
  user_id: string | null;
  email: string | null;
};

type MePayload = {
  staffId?: string;
  email?: string | null;
  providerId?: string | null;
};

const PROVIDER_FILTER_STORAGE_KEY = "clinicianAgenda.providerFilter";

function readInitialClinicianId(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("clinicianId");
  if (fromUrl !== null) return fromUrl.trim();
  try {
    const stored = window.localStorage.getItem(PROVIDER_FILTER_STORAGE_KEY);
    return stored ?? "";
  } catch {
    return "";
  }
}

export default function ClinicianAgendaClient() {
  const [payload, setPayload] = useState<CommandCenterPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [eligibilityChecking, setEligibilityChecking] = useState<Record<string, boolean>>({});
  const [eligibilityResults, setEligibilityResults] = useState<Record<string, string>>({});
  const [joiningTelehealth, setJoiningTelehealth] = useState<Record<string, boolean>>({});
  const [telehealthMessages, setTelehealthMessages] = useState<Record<string, string>>({});
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [me, setMe] = useState<MePayload | null>(null);
  const [selectedClinicianId, setSelectedClinicianId] = useState<string>(() => readInitialClinicianId());

  const joinTelehealth = useCallback(async (item: AgendaItem) => {
    setJoiningTelehealth((prev) => ({ ...prev, [item.appointmentId]: true }));
    setTelehealthMessages((prev) => ({ ...prev, [item.appointmentId]: "" }));
    try {
      const res = await fetch(`/api/telehealth/appointments/${item.appointmentId}/join`, { method: "POST" });
      const json = (await res.json()) as {
        success?: boolean;
        joinUrl?: string;
        hostUrl?: string | null;
        warning?: string;
        error?: string;
        hint?: string;
        requiresConnect?: boolean;
        platform?: string | null;
      };
      if (!res.ok || !json.success || !json.joinUrl) {
        const msg =
          json.error ??
          (json.requiresConnect
            ? `Connect ${json.platform ?? "telehealth"} in Settings → Providers first.`
            : "Could not start meeting.");
        setTelehealthMessages((prev) => ({ ...prev, [item.appointmentId]: msg }));
        return;
      }
      if (json.warning) {
        setTelehealthMessages((prev) => ({ ...prev, [item.appointmentId]: json.warning! }));
      }
      // Host URL is only returned to the provider whose account hosts the meeting;
      // other staff get the join URL. The API enforces this — we just honor it here.
      const url = json.hostUrl ?? json.joinUrl;
      if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setTelehealthMessages((prev) => ({
        ...prev,
        [item.appointmentId]: e instanceof Error ? e.message : "Network error joining meeting.",
      }));
    } finally {
      setJoiningTelehealth((prev) => ({ ...prev, [item.appointmentId]: false }));
    }
  }, []);

  const organizationId = useMemo(() => getOrganizationId(), []);

  const checkEligibility = useCallback(async (item: AgendaItem) => {
    if (!organizationId) return;
    setEligibilityChecking((prev) => ({ ...prev, [item.appointmentId]: true }));
    setEligibilityResults((prev) => ({ ...prev, [item.appointmentId]: "" }));
    try {
      const response = await fetch("/api/clearinghouse/availity/eligibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          clientId: item.clientId,
          appointmentId: item.appointmentId,
          insurancePolicyId: null,
          request: null,
        }),
      });
      const json = (await response.json()) as { success: boolean; error?: string };
      setEligibilityResults((prev) => ({
        ...prev,
        [item.appointmentId]: json.success ? "Eligibility submitted" : (json.error ?? "Eligibility check failed"),
      }));
    } catch {
      setEligibilityResults((prev) => ({ ...prev, [item.appointmentId]: "Eligibility check failed" }));
    } finally {
      setEligibilityChecking((prev) => ({ ...prev, [item.appointmentId]: false }));
    }
  }, [organizationId]);

  useEffect(() => {
    let cancelled = false;

    async function loadAgenda() {
      if (!organizationId) {
        setError("Missing organizationId. Add ?organizationId=... to the URL or configure NEXT_PUBLIC_ORGANIZATION_ID.");
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const params = new URLSearchParams({ organizationId });
        if (selectedClinicianId) params.set("clinicianId", selectedClinicianId);
        const response = await fetch(`/api/clinician/command-center?${params.toString()}`, {
          cache: "no-store",
        });
        const json = (await response.json()) as CommandCenterPayload;
        if (cancelled) return;
        if (!response.ok || !json.success) throw new Error(json.error ?? "Failed to load clinician agenda");
        setPayload(json);
        setError(null);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load clinician agenda");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadAgenda();
    return () => {
      cancelled = true;
    };
  }, [organizationId, selectedClinicianId]);

  useEffect(() => {
    let cancelled = false;
    if (!organizationId) return;
    (async () => {
      try {
        const res = await fetch(`/api/providers?organizationId=${encodeURIComponent(organizationId)}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as { success?: boolean; providers?: ProviderOption[] };
        if (!cancelled && res.ok && json.success && Array.isArray(json.providers)) {
          setProviders(json.providers);
        }
      } catch {
        // Non-fatal: dropdown just stays empty beyond "All providers"
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as MePayload;
        if (!cancelled) setMe(json);
      } catch {
        // Non-fatal: "Just me" shortcut just won't have a target
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const myProviderId = useMemo(() => {
    // Prefer the explicit staff->provider link from /api/auth/me. This is
    // robust to login emails that diverge from provider profile emails
    // (e.g. after a name change or when a shared inbox is used).
    if (me?.providerId) return me.providerId;
    return null;
  }, [me]);

  const updateSelectedClinician = useCallback((next: string) => {
    setSelectedClinicianId(next);
    if (typeof window === "undefined") return;
    try {
      if (next) window.localStorage.setItem(PROVIDER_FILTER_STORAGE_KEY, next);
      else window.localStorage.removeItem(PROVIDER_FILTER_STORAGE_KEY);
    } catch {
      // ignore quota / privacy mode
    }
    try {
      const url = new URL(window.location.href);
      if (next) url.searchParams.set("clinicianId", next);
      else url.searchParams.delete("clinicianId");
      window.history.replaceState(null, "", url.toString());
    } catch {
      // ignore — URL stays in sync next navigation
    }
  }, []);

  const metrics = payload?.metrics ?? emptyMetrics();
  const agenda = payload?.agenda ?? [];
  const devFallback = payload?.devFallback ?? false;

  // In development, replace the red auth error with a muted notice
  const isDev = process.env.NODE_ENV !== "production";
  const isAuthError = error === "Not authenticated";

  return (
    <>
      {error && !(isDev && isAuthError) ? <div className="alert-panel">{error}</div> : null}
      {devFallback || (isDev && isAuthError) ? (
        <p style={{ fontSize: "12px", color: "var(--muted)", margin: "0 0 12px" }}>Development fallback active</p>
      ) : null}

      <section className="metric-grid">
        <article className="metric-card">
          <span>Appointments</span>
          <strong>{loading ? "—" : metrics.appointmentsToday}</strong>
        </article>
        <article className="metric-card">
          <span>Checked In</span>
          <strong>{loading ? "—" : metrics.checkedIn}</strong>
        </article>
        <article className="metric-card">
          <span>Eligibility Issues</span>
          <strong>{loading ? "—" : metrics.eligibilityMissingOrStale + metrics.eligibilityInactive}</strong>
        </article>
        <article className="metric-card">
          <span>Balances to Review</span>
          <strong>{loading ? "—" : metrics.balancesToReview}</strong>
        </article>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Appointment List</h2>
            <p>Practical visit context only. No coding prompts or documentation interruptions.</p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
              <span>Provider</span>
              <select
                value={selectedClinicianId}
                onChange={(e) => updateSelectedClinician(e.target.value)}
                style={{ padding: "4px 8px" }}
              >
                <option value="">All providers</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.provider_name}
                    {p.credential_display ? `, ${p.credential_display}` : ""}
                  </option>
                ))}
              </select>
            </label>
            {myProviderId ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => updateSelectedClinician(myProviderId)}
                disabled={selectedClinicianId === myProviderId}
              >
                Just me
              </button>
            ) : null}
            {selectedClinicianId ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => updateSelectedClinician("")}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>

        {loading ? <div className="empty-state">Loading agenda…</div> : null}
        {!loading && agenda.length === 0 ? <div className="empty-state">No appointments found for today.</div> : null}

        <div className="agenda-list">
          {agenda.map((item) => {
            const eligibility = eligibilityLabel(item);
            const checkIn = checkInLabel(item);
            return (
              <article className="agenda-card" key={item.appointmentId}>
                <div className="agenda-time">
                  <strong>{formatTime(item.startTime)}</strong>
                  <span>{item.type ?? "Visit"}</span>
                </div>

                <div className="agenda-main">
                  <h3>{item.clientName}</h3>
                  <p>DOB: {formatDob(item.dateOfBirth)}</p>
                  <p>{item.serviceLocation ?? (item.telehealthUrl ? "Telehealth" : "Location not set")}</p>
                  <div className="status-row">
                    <span className={statusClass(checkIn)}>{checkIn}</span>
                    <span className={statusClass(eligibility)}>{eligibility}</span>
                    <span className="status">Balance {formatMoney(item.patientBalance)}</span>
                    {item.eligibility?.copayAmount ? <span className="status">Copay {formatMoney(item.eligibility.copayAmount)}</span> : null}
                  </div>
                </div>

                <div className="agenda-actions">
                  {item.clientId ? <a className="button button-secondary" href={`/clients/${item.clientId}`}>Open Chart</a> : null}
                  <a className="button button-secondary" href={item.encounter?.id ? `/encounters/${item.encounter.id}` : `/encounters/new?appointmentId=${item.appointmentId}`}>Open Note</a>
                  {item.clientId ? (
                    <a className="button button-secondary" href={`/clients/${item.clientId}/balance`}>
                      Collect
                    </a>
                  ) : null}
                  {item.clientId ? <a className="button button-secondary" href={`/clients/${item.clientId}/appointments`}>Schedule Follow-up</a> : null}
                  {item.clientId ? <a className="button" href={`/billing/workqueue?clientId=${item.clientId}&appointmentId=${item.appointmentId}`}>Route to Biller</a> : null}
                  {(item.serviceLocation === "telehealth" || item.telehealthUrl) ? (
                    <button
                      className="button button-primary"
                      type="button"
                      disabled={joiningTelehealth[item.appointmentId]}
                      onClick={() => void joinTelehealth(item)}
                    >
                      {joiningTelehealth[item.appointmentId] ? "Joining…" : "Join Telehealth"}
                    </button>
                  ) : null}
                  {telehealthMessages[item.appointmentId] ? (
                    <span className="status muted-text">{telehealthMessages[item.appointmentId]}</span>
                  ) : null}
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={eligibilityChecking[item.appointmentId]}
                    onClick={() => void checkEligibility(item)}
                  >
                    {eligibilityChecking[item.appointmentId] ? "Checking…" : "Check Eligibility"}
                  </button>
                  {eligibilityResults[item.appointmentId] ? (
                    <span className="status muted-text">{eligibilityResults[item.appointmentId]}</span>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}
