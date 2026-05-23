"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import styles from "./monthCalendar.module.css";
import { DEFAULT_ORG_ID } from "@/lib/config";

const ORG_ID =
  (typeof process !== "undefined" &&
    process.env.NEXT_PUBLIC_ORGANIZATION_ID) ||
  DEFAULT_ORG_ID;

const CPT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "90791", label: "90791 — Diagnostic eval" },
  { value: "90832", label: "90832 — Psychotherapy 30 min" },
  { value: "90834", label: "90834 — Psychotherapy 45 min" },
  { value: "90837", label: "90837 — Psychotherapy 60 min" },
  { value: "90846", label: "90846 — Family w/o patient" },
  { value: "90847", label: "90847 — Family w/ patient" },
  { value: "90853", label: "90853 — Group psychotherapy" },
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type ListAppointment = {
  id: string;
  clientId: string | null;
  clientName: string;
  providerId: string | null;
  providerName: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  status: string;
  appointmentType: string | null;
  serviceLocation: string | null;
  cptCode: string | null;
};

type AppointmentDetail = {
  appointment: {
    id: string;
    clientId: string | null;
    clientName: string;
    providerId: string | null;
    providerName: string;
    scheduledStartAt: string;
    scheduledEndAt: string;
    status: string;
    appointmentType: string | null;
    serviceLocation: string | null;
    reason: string | null;
    cptCode: string | null;
    memo: string;
  };
  insurance: {
    primaryPolicy: {
      id: string;
      planName: string | null;
      policyNumber: string | null;
      priority: number | null;
      payerId: string | null;
      payerName: string | null;
      payerCode: string | null;
    } | null;
  };
  eligibility: {
    id?: string;
    eligibility_status?: string;
    checked_at?: string | null;
    copay_amount?: number | null;
    displayStatus: "active" | "inactive" | "unknown" | "stale" | "not_checked";
    asOf: string | null;
  } | null;
  balance: { openBalance: number };
  encounter: { id: string; encounter_status?: string } | null;
};

type ClientLite = { id: string; name: string };
type ProviderLite = { id: string; provider_name: string };

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}
function startOfWeek(d: Date) {
  const x = new Date(d);
  x.setDate(x.getDate() - x.getDay());
  x.setHours(0, 0, 0, 0);
  return x;
}
function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function fmtMonth(d: Date) {
  return d.toLocaleString(undefined, { month: "long", year: "numeric" });
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function money(n: number) {
  return `$${n.toFixed(2)}`;
}

function chipClassFor(status: string): string {
  switch (status) {
    case "completed":
      return styles.chipCompleted;
    case "cancelled":
      return styles.chipCancelled;
    case "no_show":
      return styles.chipNoShow;
    case "in_progress":
    case "checked_in":
      return styles.chipInProgress;
    default:
      return "";
  }
}

export default function MonthCalendarClient() {
  const [cursor, setCursor] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [appointments, setAppointments] = useState<ListAppointment[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AppointmentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [drawerBanner, setDrawerBanner] = useState<
    { kind: "success" | "error"; text: string } | null
  >(null);

  const [memoDraft, setMemoDraft] = useState("");
  const [cptDraft, setCptDraft] = useState<string>("90837");
  const [cptFallback, setCptFallback] = useState<string | null>(null);
  const [savingDetail, setSavingDetail] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);

  const [collectOpen, setCollectOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // Calendar grid: start at start-of-week of month-start, render 6 weeks.
  const gridStart = useMemo(() => startOfWeek(startOfMonth(cursor)), [cursor]);
  const gridDays = useMemo(() => {
    const days: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      days.push(d);
    }
    return days;
  }, [gridStart]);

  const loadAppointments = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const from = gridDays[0].toISOString();
      const lastEnd = new Date(gridDays[41]);
      lastEnd.setDate(lastEnd.getDate() + 1);
      const to = lastEnd.toISOString();
      const params = new URLSearchParams({
        organizationId: ORG_ID,
        from,
        to,
      });
      const res = await fetch(`/api/scheduling/appointments?${params}`);
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to load appointments");
      }
      setAppointments(json.appointments ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load");
      setAppointments([]);
    } finally {
      setLoading(false);
    }
  }, [gridDays]);

  useEffect(() => {
    loadAppointments();
  }, [loadAppointments]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    try {
      const params = new URLSearchParams({ organizationId: ORG_ID });
      const res = await fetch(
        `/api/scheduling/appointments/${id}/detail?${params}`,
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to load appointment");
      }
      setDetail(json as AppointmentDetail);
      setMemoDraft(json.appointment.memo ?? "");
      // CPT dropdown: if the stored value matches a known psychotherapy code
      // use it directly; otherwise preserve it as a fallback option so we
      // don't silently overwrite a non-standard CPT/HCPCS code on save.
      const stored = json.appointment.cptCode ?? null;
      const knownValues = CPT_OPTIONS.map((o) => o.value);
      if (stored && knownValues.includes(stored)) {
        setCptDraft(stored);
        setCptFallback(null);
      } else if (stored) {
        setCptDraft(stored);
        setCptFallback(stored);
      } else {
        setCptDraft("90837");
        setCptFallback(null);
      }
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "Failed");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const dayBuckets = useMemo(() => {
    const map = new Map<string, ListAppointment[]>();
    for (const appt of appointments) {
      const d = new Date(appt.scheduledStartAt);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const list = map.get(key) ?? [];
      list.push(appt);
      map.set(key, list);
    }
    return map;
  }, [appointments]);

  const today = new Date();

  function goPrev() {
    setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1));
  }
  function goNext() {
    setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1));
  }
  function goToday() {
    setCursor(new Date(today.getFullYear(), today.getMonth(), 1));
  }

  function closeDrawer() {
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    setDrawerBanner(null);
    setCollectOpen(false);
  }

  async function saveDetailChanges() {
    if (!detail) return;
    setSavingDetail(true);
    setDrawerBanner(null);
    try {
      const res = await fetch(
        `/api/scheduling/appointments/${detail.appointment.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope: "single",
            updates: { cpt_code: cptDraft, memo: memoDraft },
          }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Save failed");
      }
      setDrawerBanner({ kind: "success", text: "Saved." });
      await loadAppointments();
      await loadDetail(detail.appointment.id);
    } catch (e) {
      setDrawerBanner({
        kind: "error",
        text: e instanceof Error ? e.message : "Save failed",
      });
    } finally {
      setSavingDetail(false);
    }
  }

  async function handleStartNote() {
    if (!detail) return;
    setDrawerBanner(null);
    try {
      const res = await fetch(`/api/encounters/create-from-appointment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: ORG_ID,
          appointmentId: detail.appointment.id,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Could not start note");
      }
      if (json.encounterId) {
        window.location.href = `/encounters/${json.encounterId}`;
      } else {
        setDrawerBanner({ kind: "success", text: "Note ready." });
        await loadDetail(detail.appointment.id);
      }
    } catch (e) {
      setDrawerBanner({
        kind: "error",
        text: e instanceof Error ? e.message : "Could not start note",
      });
    }
  }

  async function handleCheckIn() {
    if (!detail) return;
    setDrawerBanner(null);
    setCheckingIn(true);
    try {
      const res = await fetch(`/api/check-ins/appointment/start-note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: ORG_ID,
          appointmentId: detail.appointment.id,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Check-in failed");
      }
      // Refresh list so the status pill reflects checked_in before navigation.
      await loadAppointments();
      const target = typeof json.noteUrl === "string" && json.noteUrl
        ? json.noteUrl
        : json.encounterId
          ? `/encounters/${json.encounterId}`
          : null;
      if (target) {
        window.location.href = target;
      } else {
        setDrawerBanner({ kind: "success", text: "Checked in." });
        await loadDetail(detail.appointment.id);
      }
    } catch (e) {
      setDrawerBanner({
        kind: "error",
        text: e instanceof Error ? e.message : "Check-in failed",
      });
    } finally {
      setCheckingIn(false);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <button className={styles.navBtn} onClick={goPrev} aria-label="Previous month">
            ‹
          </button>
          <button className={styles.navBtn} onClick={goToday}>
            Today
          </button>
          <button className={styles.navBtn} onClick={goNext} aria-label="Next month">
            ›
          </button>
          <div>
            <h1 className={styles.title}>{fmtMonth(cursor)}</h1>
            <div className={styles.subtitle}>
              {loading
                ? "Loading…"
                : `${appointments.length} appointment${appointments.length === 1 ? "" : "s"} in view`}
            </div>
          </div>
        </div>
        <div className={styles.headerRight}>
          <button className={styles.primaryBtn} onClick={() => setCreateOpen(true)}>
            + New appointment
          </button>
        </div>
      </header>

      <div className={styles.body}>
        {loadError ? (
          <div className={`${styles.banner} ${styles.bannerError}`}>
            {loadError}
          </div>
        ) : null}

        <div className={styles.weekHeader}>
          {WEEKDAYS.map((d) => (
            <div key={d}>{d}</div>
          ))}
        </div>
        <div className={styles.grid}>
          {gridDays.map((day) => {
            const inMonth = day.getMonth() === cursor.getMonth();
            const isToday = isSameDay(day, today);
            const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
            const dayAppointments = (dayBuckets.get(key) ?? []).sort((a, b) =>
              a.scheduledStartAt.localeCompare(b.scheduledStartAt),
            );
            const visible = dayAppointments.slice(0, 3);
            const overflow = dayAppointments.length - visible.length;
            return (
              <div
                key={key}
                className={`${styles.cell} ${inMonth ? "" : styles.cellOther} ${isToday ? styles.cellToday : ""}`}
              >
                <span className={styles.dayNum}>{day.getDate()}</span>
                {visible.map((appt) => (
                  <div
                    key={appt.id}
                    className={`${styles.chip} ${chipClassFor(appt.status)}`}
                    onClick={() => setSelectedId(appt.id)}
                    title={`${fmtTime(appt.scheduledStartAt)} ${appt.clientName} — ${appt.providerName}`}
                  >
                    <strong>{fmtTime(appt.scheduledStartAt)}</strong>{" "}
                    {appt.clientName}
                  </div>
                ))}
                {overflow > 0 ? (
                  <div
                    className={styles.overflow}
                    onClick={() => setSelectedId(dayAppointments[3].id)}
                  >
                    +{overflow} more
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {selectedId ? (
        <div className={styles.drawerOverlay} onClick={closeDrawer}>
          <aside className={styles.drawer} onClick={(e) => e.stopPropagation()}>
            <div className={styles.drawerHeader}>
              <h2 className={styles.drawerTitle}>Appointment</h2>
              <button className={styles.closeBtn} onClick={closeDrawer}>
                ×
              </button>
            </div>
            <div className={styles.drawerBody}>
              {detailLoading ? <div>Loading…</div> : null}
              {detailError ? (
                <div className={`${styles.banner} ${styles.bannerError}`}>
                  {detailError}
                </div>
              ) : null}
              {drawerBanner ? (
                <div
                  className={`${styles.banner} ${drawerBanner.kind === "success" ? styles.bannerSuccess : styles.bannerError}`}
                >
                  {drawerBanner.text}
                </div>
              ) : null}
              {detail ? (
                <>
                  <div className={styles.section}>
                    <div className={styles.sectionLabel}>Client</div>
                    <div className={styles.sectionValue}>
                      {detail.appointment.clientId ? (
                        <Link
                          className={styles.link}
                          href={`/patients/${detail.appointment.clientId}`}
                        >
                          {detail.appointment.clientName}
                        </Link>
                      ) : (
                        detail.appointment.clientName
                      )}
                    </div>
                  </div>

                  <div className={styles.section}>
                    <div className={styles.sectionLabel}>When</div>
                    <div className={styles.sectionValue}>
                      {fmtDateTime(detail.appointment.scheduledStartAt)} –{" "}
                      {fmtTime(detail.appointment.scheduledEndAt)}
                    </div>
                    {(() => {
                      const ms =
                        new Date(detail.appointment.scheduledEndAt).getTime() -
                        new Date(detail.appointment.scheduledStartAt).getTime();
                      const mins = Math.max(0, Math.round(ms / 60000));
                      const h = Math.floor(mins / 60);
                      const m = mins % 60;
                      const label =
                        h > 0
                          ? `${h}h${m ? ` ${m}m` : ""}`
                          : `${m} min`;
                      return (
                        <div className={styles.sectionMuted}>
                          Duration: {label}
                        </div>
                      );
                    })()}
                  </div>

                  <div className={styles.section}>
                    <div className={styles.sectionLabel}>Clinician</div>
                    <div className={styles.sectionValue}>
                      {detail.appointment.providerName}
                    </div>
                    {detail.appointment.appointmentType ? (
                      <div className={styles.sectionMuted}>
                        {detail.appointment.appointmentType}
                        {detail.appointment.serviceLocation
                          ? ` · ${detail.appointment.serviceLocation}`
                          : ""}
                      </div>
                    ) : null}
                  </div>

                  <div className={styles.section}>
                    <div className={styles.sectionLabel}>CPT code</div>
                    <select
                      className={styles.select}
                      value={cptDraft}
                      onChange={(e) => setCptDraft(e.target.value)}
                    >
                      {CPT_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                      {cptFallback &&
                      !CPT_OPTIONS.some((o) => o.value === cptFallback) ? (
                        <option value={cptFallback}>
                          {cptFallback} — existing
                        </option>
                      ) : null}
                    </select>
                  </div>

                  <div className={styles.section}>
                    <div className={styles.sectionLabel}>Internal memo</div>
                    <textarea
                      className={styles.textarea}
                      value={memoDraft}
                      onChange={(e) => setMemoDraft(e.target.value)}
                      placeholder="Add a private note for this appointment…"
                    />
                  </div>

                  <div className={styles.section}>
                    <div className={styles.sectionLabel}>Insurance</div>
                    {detail.insurance.primaryPolicy ? (
                      <>
                        <div className={styles.sectionValue}>
                          {detail.insurance.primaryPolicy.payerName ??
                            "Unknown payer"}
                        </div>
                        {detail.insurance.primaryPolicy.planName ? (
                          <div className={styles.sectionMuted}>
                            Plan: {detail.insurance.primaryPolicy.planName}
                          </div>
                        ) : null}
                        <div className={styles.sectionMuted}>
                          Member ID:{" "}
                          {detail.insurance.primaryPolicy.policyNumber ?? "—"}
                        </div>
                      </>
                    ) : (
                      <div className={styles.sectionMuted}>
                        No primary policy on file.
                      </div>
                    )}
                  </div>

                  <div className={styles.section}>
                    <div className={styles.sectionLabel}>Eligibility</div>
                    {(() => {
                      const e = detail.eligibility;
                      const ds = e?.displayStatus ?? "not_checked";
                      const label =
                        ds === "active"
                          ? "Active"
                          : ds === "inactive"
                            ? "Inactive"
                            : ds === "stale"
                              ? "Stale"
                              : ds === "unknown"
                                ? "Unknown"
                                : "Not checked";
                      const badgeCls =
                        ds === "active"
                          ? styles.badgeActive
                          : ds === "inactive"
                            ? styles.badgeInactive
                            : styles.badgeUnknown;
                      const asOf = e?.asOf ?? null;
                      return (
                        <>
                          <div>
                            <span className={`${styles.badge} ${badgeCls}`}>
                              {label}
                            </span>
                          </div>
                          {asOf ? (
                            <div className={styles.sectionMuted}>
                              As of {new Date(asOf).toLocaleDateString()}
                              {e?.copay_amount != null
                                ? ` · copay ${money(Number(e.copay_amount))}`
                                : ""}
                            </div>
                          ) : (
                            <div className={styles.sectionMuted}>
                              No eligibility check on file for this policy.
                            </div>
                          )}
                          {detail.appointment.clientId ? (
                            <div className={styles.sectionMuted}>
                              <Link
                                className={styles.link}
                                href={`/clients/${detail.appointment.clientId}/eligibility`}
                              >
                                {asOf
                                  ? "Open eligibility history"
                                  : "Check eligibility"}
                              </Link>
                            </div>
                          ) : null}
                        </>
                      );
                    })()}
                  </div>

                  <div className={styles.section}>
                    <div className={styles.sectionLabel}>Patient balance</div>
                    <div className={styles.sectionValue}>
                      {money(detail.balance.openBalance)} open
                    </div>
                  </div>

                  <div className={styles.section}>
                    <div className={styles.sectionLabel}>Progress note</div>
                    {detail.encounter ? (
                      <Link
                        className={styles.link}
                        href={`/encounters/${detail.encounter.id}`}
                      >
                        Open note ({detail.encounter.encounter_status ?? "draft"})
                      </Link>
                    ) : (
                      <div className={styles.sectionMuted}>
                        No encounter yet.
                      </div>
                    )}
                  </div>

                  <div className={styles.actions}>
                    {(() => {
                      const status = detail.appointment.status;
                      const alreadyCheckedIn = status === "checked_in" || status === "in_progress" || status === "completed";
                      const label = checkingIn
                        ? "Checking in…"
                        : alreadyCheckedIn
                          ? "Open note"
                          : "Check in";
                      const disabled = checkingIn || !detail.appointment.clientId;
                      return (
                        <button
                          className={styles.primaryBtn}
                          onClick={handleCheckIn}
                          disabled={disabled}
                          title={!detail.appointment.clientId ? "Assign a client before checking in" : undefined}
                        >
                          {label}
                        </button>
                      );
                    })()}
                    <button
                      className={styles.secondaryBtn}
                      onClick={saveDetailChanges}
                      disabled={savingDetail}
                    >
                      {savingDetail ? "Saving…" : "Save changes"}
                    </button>
                    <button
                      className={styles.secondaryBtn}
                      onClick={handleStartNote}
                    >
                      {detail.encounter ? "Open note" : "Start note"}
                    </button>
                    {detail.appointment.clientId ? (
                      <button
                        className={styles.secondaryBtn}
                        onClick={() => setCollectOpen(true)}
                      >
                        Collect
                      </button>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}

      {collectOpen && detail && detail.appointment.clientId ? (
        <CollectModal
          organizationId={ORG_ID}
          clientId={detail.appointment.clientId}
          appointmentId={detail.appointment.id}
          providerId={detail.appointment.providerId}
          openBalance={detail.balance.openBalance}
          onClose={() => setCollectOpen(false)}
          onCollected={async () => {
            setCollectOpen(false);
            setDrawerBanner({ kind: "success", text: "Payment posted." });
            if (detail) await loadDetail(detail.appointment.id);
          }}
        />
      ) : null}

      {createOpen ? (
        <CreateAppointmentModal
          organizationId={ORG_ID}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false);
            await loadAppointments();
          }}
        />
      ) : null}
    </div>
  );
}

/* --- Collect modal: posts to /api/billing/payments/patient --- */

type ConnectStatus = "not_connected" | "onboarding" | "connected" | "restricted";
type ProviderConnectInfo = {
  status: ConnectStatus;
  chargesEnabled: boolean;
  credentialingProfileId: string | null;
  providerName: string | null;
};

declare global {
  interface Window { Stripe?: (key: string, options?: { stripeAccount?: string }) => unknown }
}

const STRIPE_JS_URL = "https://js.stripe.com/v3/";

function loadStripeJs(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("Stripe.js requires browser"));
  if (window.Stripe) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${STRIPE_JS_URL}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Stripe.js")));
      if (window.Stripe) resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = STRIPE_JS_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Stripe.js"));
    document.head.appendChild(s);
  });
}

function CollectModal({
  organizationId,
  clientId,
  appointmentId,
  providerId,
  openBalance,
  onClose,
  onCollected,
}: {
  organizationId: string;
  clientId: string;
  appointmentId: string;
  providerId: string | null;
  openBalance: number;
  onClose: () => void;
  onCollected: () => void | Promise<void>;
}) {
  const [amount, setAmount] = useState<string>(openBalance > 0 ? openBalance.toFixed(2) : "0.00");
  const [applyTo, setApplyTo] = useState<string>(openBalance > 0 ? "account_balance" : "encounter");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [connect, setConnect] = useState<ProviderConnectInfo | null>(null);
  const [connectLoading, setConnectLoading] = useState(true);
  const [mode, setMode] = useState<"card" | "manual">("card");
  const [manualMethod, setManualMethod] = useState<string>("cash");

  useEffect(() => {
    let cancelled = false;
    if (!providerId) {
      setConnect({ status: "not_connected", chargesEnabled: false, credentialingProfileId: null, providerName: null });
      setConnectLoading(false);
      setMode("manual");
      return;
    }
    setConnectLoading(true);
    fetch(`/api/billing/stripe-connect/provider-status?providerId=${encodeURIComponent(providerId)}&organizationId=${encodeURIComponent(organizationId)}`)
      .then((r) => r.json())
      .then((j: { success?: boolean; status?: ConnectStatus; chargesEnabled?: boolean; credentialingProfileId?: string | null; providerName?: string | null; error?: string }) => {
        if (cancelled) return;
        if (!j.success) throw new Error(j.error ?? "Lookup failed");
        const info: ProviderConnectInfo = {
          status: (j.status ?? "not_connected") as ConnectStatus,
          chargesEnabled: Boolean(j.chargesEnabled),
          credentialingProfileId: j.credentialingProfileId ?? null,
          providerName: j.providerName ?? null,
        };
        setConnect(info);
        setMode(info.chargesEnabled ? "card" : "manual");
      })
      .catch(() => {
        if (cancelled) return;
        setConnect({ status: "not_connected", chargesEnabled: false, credentialingProfileId: null, providerName: null });
        setMode("manual");
      })
      .finally(() => { if (!cancelled) setConnectLoading(false); });
    return () => { cancelled = true; };
  }, [providerId, organizationId]);

  async function submitManual() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        organizationId,
        clientId,
        amount: Number(amount),
        method: manualMethod,
        applyToKind: applyTo,
        note: note || null,
      };
      if (applyTo === "encounter") body.appointmentId = appointmentId;
      const res = await fetch(`/api/billing/payments/patient`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? (json.errors && json.errors[0]?.message) ?? "Payment posting failed");
      }
      await onCollected();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3>Collect copay</h3>
        {error ? <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div> : null}

        {!connectLoading && connect && (
          <div style={{ display: "flex", gap: 8, marginBottom: 10, fontSize: 12 }}>
            <button
              type="button"
              className={mode === "card" ? styles.primaryBtn : styles.secondaryBtn}
              style={{ padding: "6px 10px" }}
              disabled={!connect.chargesEnabled || busy}
              onClick={() => setMode("card")}
            >
              Charge card{!connect.chargesEnabled ? " (provider not connected)" : ""}
            </button>
            <button
              type="button"
              className={mode === "manual" ? styles.primaryBtn : styles.secondaryBtn}
              style={{ padding: "6px 10px" }}
              disabled={busy}
              onClick={() => setMode("manual")}
            >
              Log payment
            </button>
          </div>
        )}

        <div className={styles.modalRow}>
          <label className={styles.modalLabel}>Amount</label>
          <input className={styles.input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
        </div>
        <div className={styles.modalRow}>
          <label className={styles.modalLabel}>Apply to</label>
          <select className={styles.select} value={applyTo} onChange={(e) => setApplyTo(e.target.value)} disabled={busy}>
            <option value="account_balance">Account balance</option>
            <option value="encounter">This encounter</option>
          </select>
        </div>
        <div className={styles.modalRow}>
          <label className={styles.modalLabel}>Note (optional)</label>
          <input className={styles.input} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
        </div>

        {mode === "card" && connect?.chargesEnabled && connect.credentialingProfileId ? (
          <StripeCardCharge
            organizationId={organizationId}
            clientId={clientId}
            appointmentId={appointmentId}
            credentialingProfileId={connect.credentialingProfileId}
            amount={Number(amount)}
            applyTo={applyTo}
            note={note}
            onError={setError}
            onPosted={onCollected}
            busy={busy}
            setBusy={setBusy}
            onCancel={onClose}
          />
        ) : (
          <>
            {mode === "card" && !connectLoading && connect && !connect.chargesEnabled && (
              <div className={`${styles.banner}`} style={{ marginBottom: 10 }}>
                {connect.status === "not_connected"
                  ? "This provider has not connected a Stripe account yet. Use Settings → Providers to connect, or log the payment manually."
                  : "Provider's Stripe account is not ready to accept charges yet. Finish onboarding in Settings → Providers, or log the payment manually."}
              </div>
            )}
            <div className={styles.modalRow}>
              <label className={styles.modalLabel}>Method</label>
              <select className={styles.select} value={manualMethod} onChange={(e) => setManualMethod(e.target.value)} disabled={busy}>
                <option value="cash">Cash</option>
                <option value="check">Check</option>
                <option value="credit_card">Credit card</option>
                <option value="debit_card">Debit card</option>
                <option value="external_card">External card (charged elsewhere)</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className={styles.modalActions}>
              <button className={styles.secondaryBtn} onClick={onClose} disabled={busy}>Cancel</button>
              <button className={styles.primaryBtn} onClick={submitManual} disabled={busy}>
                {busy ? "Posting…" : "Log payment"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StripeCardCharge({
  organizationId,
  clientId,
  appointmentId,
  credentialingProfileId,
  amount,
  applyTo,
  note,
  onPosted,
  onError,
  onCancel,
  busy,
  setBusy,
}: {
  organizationId: string;
  clientId: string;
  appointmentId: string;
  credentialingProfileId: string;
  amount: number;
  applyTo: string;
  note: string;
  onPosted: () => void | Promise<void>;
  onError: (msg: string | null) => void;
  onCancel: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  type StripeInstance = {
    elements: (opts?: Record<string, unknown>) => {
      create: (type: string, opts?: Record<string, unknown>) => {
        mount: (el: HTMLElement) => void;
        unmount: () => void;
        on?: (ev: string, cb: (e: unknown) => void) => void;
      };
    };
    confirmCardPayment: (
      clientSecret: string,
      data: { payment_method: { card: unknown } },
    ) => Promise<{ paymentIntent?: { id: string; status: string; latest_charge?: string | { id: string } | null }; error?: { message?: string } }>;
  };

  const cardMountRef = useRef<HTMLDivElement | null>(null);
  const stripeRef = useRef<StripeInstance | null>(null);
  const cardRef = useRef<{ unmount: () => void } | null>(null);
  const stripeAccountRef = useRef<string | null>(null);
  const intentRef = useRef<{ clientSecret: string; paymentIntentId: string } | null>(null);

  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    onError(null);
    setReady(false);
    setBootError(null);
    (async () => {
      try {
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error("Enter an amount greater than $0.00");
        }
        const amountCents = Math.round(amount * 100);
        if (amountCents < 50) throw new Error("Stripe minimum charge is $0.50");

        await loadStripeJs();
        if (cancelled) return;

        const resp = await fetch("/api/billing/stripe-connect/payment-intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerId: credentialingProfileId,
            appointmentId,
            clientId,
            amountCents,
            organizationId,
          }),
        });
        const j = (await resp.json()) as {
          success?: boolean;
          clientSecret?: string;
          paymentIntentId?: string;
          stripeAccountId?: string;
          publishableKey?: string;
          error?: string;
        };
        if (!resp.ok || !j.success || !j.clientSecret || !j.publishableKey || !j.stripeAccountId) {
          throw new Error(j.error ?? `Could not initialize card form (${resp.status})`);
        }
        if (cancelled) return;
        stripeAccountRef.current = j.stripeAccountId;
        intentRef.current = { clientSecret: j.clientSecret, paymentIntentId: j.paymentIntentId ?? "" };

        const stripe = (window.Stripe as (k: string, o?: { stripeAccount?: string }) => StripeInstance)(j.publishableKey, {
          stripeAccount: j.stripeAccountId,
        });
        stripeRef.current = stripe;
        const elements = stripe.elements();
        const card = elements.create("card", { hidePostalCode: false });
        if (cardMountRef.current) card.mount(cardMountRef.current);
        cardRef.current = card;
        setReady(true);
      } catch (e) {
        if (!cancelled) setBootError(e instanceof Error ? e.message : "Card form failed to load");
      }
    })();
    return () => {
      cancelled = true;
      try { cardRef.current?.unmount(); } catch { /* noop */ }
      cardRef.current = null;
    };
    // Recreate intent on amount change so it matches what we charge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, credentialingProfileId, appointmentId, clientId, organizationId]);

  async function pay() {
    if (!stripeRef.current || !cardRef.current || !intentRef.current) return;
    setBusy(true);
    onError(null);
    try {
      const result = await stripeRef.current.confirmCardPayment(intentRef.current.clientSecret, {
        payment_method: { card: cardRef.current },
      });
      if (result.error) throw new Error(result.error.message ?? "Card declined");
      const pi = result.paymentIntent;
      if (!pi || pi.status !== "succeeded") throw new Error(`Payment status: ${pi?.status ?? "unknown"}`);

      const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null;
      const externalId = chargeId ?? pi.id;

      const body: Record<string, unknown> = {
        organizationId,
        clientId,
        amount,
        method: "stripe",
        applyToKind: applyTo,
        externalPaymentId: externalId,
        stripeChargeId: chargeId,
        stripeConnectedAccountId: stripeAccountRef.current,
        reference: pi.id,
        note: note || null,
      };
      if (applyTo === "encounter") body.appointmentId = appointmentId;

      const postRes = await fetch(`/api/billing/payments/patient`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const postJson = await postRes.json();
      if (!postRes.ok || !postJson.ok) {
        // Charge succeeded but local posting failed: do NOT throw a hard error —
        // the Connect webhook will retry posting. Surface a soft notice.
        onError(
          `Card charged successfully (${pi.id}) but immediate posting failed: ${postJson.error ?? "unknown"}. The webhook will retry — refresh in a moment.`,
        );
      }
      await onPosted();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Card charge failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={styles.modalRow}>
        <label className={styles.modalLabel}>Card</label>
        <div
          ref={cardMountRef}
          style={{
            padding: "10px 12px",
            border: "1px solid var(--border-default, #cbd5e1)",
            borderRadius: 6,
            background: "#fff",
            minHeight: 38,
          }}
        />
      </div>
      {bootError && <div className={`${styles.banner} ${styles.bannerError}`}>{bootError}</div>}
      <div className={styles.modalActions}>
        <button className={styles.secondaryBtn} onClick={onCancel} disabled={busy}>Cancel</button>
        <button className={styles.primaryBtn} onClick={pay} disabled={busy || !ready || bootError !== null}>
          {busy ? "Charging…" : ready ? `Charge $${amount.toFixed(2)}` : "Loading…"}
        </button>
      </div>
    </>
  );
}

/* --- New Appointment modal --- */

function CreateAppointmentModal({
  organizationId,
  onClose,
  onCreated,
}: {
  organizationId: string;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [providers, setProviders] = useState<ProviderLite[]>([]);
  const [clientId, setClientId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [startAt, setStartAt] = useState<string>(() => {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    return iso;
  });
  const [duration, setDuration] = useState<number>(60);
  const [reason, setReason] = useState("Therapy session");
  const [serviceLocation, setServiceLocation] = useState<
    "office" | "telehealth"
  >("office");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [cRes, pRes] = await Promise.all([
          fetch(`/api/clients?organizationId=${organizationId}`),
          fetch(`/api/providers?organizationId=${organizationId}`),
        ]);
        const cJson = await cRes.json();
        const pJson = await pRes.json();
        const clientRows: ClientLite[] = (cJson.clients ?? cJson.data ?? []).map(
          (r: Record<string, unknown>) => {
            const composed = [r.first_name, r.last_name]
              .map((part) => String(part ?? "").trim())
              .filter(Boolean)
              .join(" ");
            const name = String(r.name ?? "").trim() || composed || String(r.id);
            return { id: String(r.id), name };
          },
        );
        const providerRows: ProviderLite[] = (pJson.providers ?? []).map(
          (r: Record<string, unknown>) => ({
            id: String(r.id),
            provider_name: String(r.provider_name ?? "Provider"),
          }),
        );
        setClients(clientRows);
        setProviders(providerRows);
        if (clientRows[0]) setClientId(clientRows[0].id);
        if (providerRows[0]) setProviderId(providerRows[0].id);
      } catch {
        setError("Could not load clients or providers");
      }
    })();
  }, [organizationId]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        organizationId,
        clientId,
        providerId,
        scheduledStartAt: new Date(startAt).toISOString(),
        durationMinutes: Number(duration),
        appointmentType: "Therapy",
        reason,
        serviceLocation,
      };
      const res = await fetch(`/api/scheduling/appointments/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Could not create appointment");
      }
      await onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3>New appointment</h3>
        {error ? (
          <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>
        ) : null}
        <div className={styles.modalRow}>
          <label className={styles.modalLabel}>Client</label>
          <select
            className={styles.select}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || c.id}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.modalRow}>
          <label className={styles.modalLabel}>Provider</label>
          <select
            className={styles.select}
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.provider_name}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.modalRow}>
          <label className={styles.modalLabel}>Start time</label>
          <input
            className={styles.input}
            type="datetime-local"
            value={startAt}
            onChange={(e) => setStartAt(e.target.value)}
          />
        </div>
        <div className={styles.modalRow}>
          <label className={styles.modalLabel}>Duration (minutes)</label>
          <input
            className={styles.input}
            type="number"
            min={15}
            step={15}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
        </div>
        <div className={styles.modalRow}>
          <label className={styles.modalLabel}>Location</label>
          <select
            className={styles.select}
            value={serviceLocation}
            onChange={(e) =>
              setServiceLocation(e.target.value as "office" | "telehealth")
            }
          >
            <option value="office">Office</option>
            <option value="telehealth">Telehealth</option>
          </select>
        </div>
        <div className={styles.modalRow}>
          <label className={styles.modalLabel}>Reason</label>
          <input
            className={styles.input}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className={styles.modalActions}>
          <button
            className={styles.secondaryBtn}
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className={styles.primaryBtn}
            onClick={submit}
            disabled={busy || !clientId || !providerId}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
