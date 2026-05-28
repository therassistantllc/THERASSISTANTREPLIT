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
  { value: "90846", label: "90846 — Family w/o client" },
  { value: "90847", label: "90847 — Family w/ client" },
  { value: "90853", label: "90853 — Group psychotherapy" },
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const TIME_CHIP_OPTIONS: Array<{ value: string; label: string }> = (() => {
  const opts: Array<{ value: string; label: string }> = [];
  for (let hour = 8; hour <= 18; hour++) {
    for (const minute of [0, 30]) {
      if (hour === 18 && minute === 30) continue;
      const h24 = String(hour).padStart(2, "0");
      const mm = String(minute).padStart(2, "0");
      const h12 = ((hour + 11) % 12) + 1;
      const suffix = hour < 12 ? "a" : "p";
      opts.push({
        value: `${h24}:${mm}`,
        label: `${h12}:${mm}${suffix}`,
      });
    }
  }
  return opts;
})();

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

type ProviderOption = {
  id: string;
  provider_name: string;
  credential_display: string | null;
};

type MePayload = { providerId?: string | null; staffId?: string | null };

const PROVIDER_FILTER_STORAGE_PREFIX = "appointmentList.providerFilter:";

function storageKeyFor(staffId: string | null | undefined) {
  return staffId ? `${PROVIDER_FILTER_STORAGE_PREFIX}${staffId}` : null;
}

function readInitialProviderFilterFromUrl(): string {
  if (typeof window === "undefined") return "";
  const fromUrl = new URLSearchParams(window.location.search).get("providerId");
  return fromUrl !== null ? fromUrl.trim() : "";
}

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

function apptTypeLabel(
  appt: { appointmentType: string | null; cptCode: string | null },
): string | null {
  const raw = (appt.appointmentType ?? "").trim();
  if (!raw) return null;
  // Legacy rows stashed the CPT code in appointment_type. Don't echo it
  // back as the appointment type label.
  if (/^9\d{4}$/.test(raw)) return null;
  if (appt.cptCode && raw === appt.cptCode) return null;
  return raw;
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
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([]);
  const [me, setMe] = useState<MePayload | null>(null);
  const [providerFilter, setProviderFilter] = useState<string>(() => readInitialProviderFilterFromUrl());
  const [filterRestored, setFilterRestored] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return new URLSearchParams(window.location.search).get("providerId") !== null;
  });

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
  const checkingInRef = useRef(false);

  const [collectOpen, setCollectOpen] = useState(false);
  const [collectPrefill, setCollectPrefill] = useState<{ amount: number; note: string; title: string } | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createInitialDate, setCreateInitialDate] = useState<string | null>(null);

  function openCreateForDate(day: Date) {
    const y = day.getFullYear();
    const m = String(day.getMonth() + 1).padStart(2, "0");
    const d = String(day.getDate()).padStart(2, "0");
    setCreateInitialDate(`${y}-${m}-${d}`);
    setCreateOpen(true);
  }

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/providers?organizationId=${encodeURIComponent(ORG_ID)}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as { success?: boolean; providers?: ProviderOption[] };
        if (!cancelled && res.ok && json.success && Array.isArray(json.providers)) {
          setProviderOptions(json.providers);
        }
      } catch {
        // Non-fatal: dropdown just stays at "All providers"
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as MePayload;
        if (cancelled) return;
        setMe(json);
        if (!filterRestored && typeof window !== "undefined") {
          const key = storageKeyFor(json.staffId);
          if (key) {
            try {
              const saved = window.localStorage.getItem(key);
              if (saved) setProviderFilter(saved);
            } catch {
              // ignore privacy mode
            }
          }
          setFilterRestored(true);
        }
      } catch {
        // Non-fatal: "Just me" toggle just won't appear
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filterRestored]);

  const meStaffId = me?.staffId ?? null;
  const updateProviderFilter = useCallback((next: string) => {
    setProviderFilter(next);
    if (typeof window === "undefined") return;
    const key = storageKeyFor(meStaffId);
    if (key) {
      try {
        if (next) window.localStorage.setItem(key, next);
        else window.localStorage.removeItem(key);
      } catch {
        // ignore quota / privacy mode
      }
    }
    try {
      const url = new URL(window.location.href);
      if (next) url.searchParams.set("providerId", next);
      else url.searchParams.delete("providerId");
      window.history.replaceState(null, "", url.toString());
    } catch {
      // ignore — URL stays in sync next navigation
    }
  }, [meStaffId]);

  const myProviderId = me?.providerId ?? null;

  const visibleAppointments = useMemo(() => {
    if (!providerFilter) return appointments;
    return appointments.filter((a) => a.providerId === providerFilter);
  }, [appointments, providerFilter]);

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
    for (const appt of visibleAppointments) {
      const d = new Date(appt.scheduledStartAt);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const list = map.get(key) ?? [];
      list.push(appt);
      map.set(key, list);
    }
    return map;
  }, [visibleAppointments]);

  const [today, setToday] = useState<Date | null>(null);
  useEffect(() => {
    setToday(new Date());
  }, []);

  function goPrev() {
    setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1));
  }
  function goNext() {
    setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1));
  }
  function goToday() {
    const t = today ?? new Date();
    setCursor(new Date(t.getFullYear(), t.getMonth(), 1));
  }

  function closeDrawer() {
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    setDrawerBanner(null);
    setCollectOpen(false);
    setCollectPrefill(null);
    setCancelOpen(false);
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
      await loadAppointments();
      closeDrawer();
      return;
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
    if (checkingInRef.current) return;
    checkingInRef.current = true;
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
      checkingInRef.current = false;
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
                : `${visibleAppointments.length} appointment${visibleAppointments.length === 1 ? "" : "s"} in view`}
            </div>
          </div>
        </div>
        <div className={styles.headerRight}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <span>Provider</span>
            <select
              value={providerFilter}
              onChange={(e) => updateProviderFilter(e.target.value)}
              style={{ padding: "4px 8px" }}
            >
              <option value="">All providers</option>
              {providerOptions.map((p) => (
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
              className={styles.navBtn}
              onClick={() => updateProviderFilter(myProviderId)}
              disabled={providerFilter === myProviderId}
            >
              Just me
            </button>
          ) : null}
          {providerFilter ? (
            <button
              type="button"
              className={styles.navBtn}
              onClick={() => updateProviderFilter("")}
            >
              Clear
            </button>
          ) : null}
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
            const isToday = today ? isSameDay(day, today) : false;
            const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
            const dayAppointments = (dayBuckets.get(key) ?? []).sort((a, b) =>
              a.scheduledStartAt.localeCompare(b.scheduledStartAt),
            );
            const visible = dayAppointments.slice(0, 3);
            const overflow = dayAppointments.length - visible.length;
            return (
              <div
                key={key}
                role="button"
                tabIndex={0}
                aria-label={`Add appointment on ${day.toLocaleDateString()}`}
                className={`${styles.cell} ${inMonth ? "" : styles.cellOther} ${isToday ? styles.cellToday : ""}`}
                onClick={() => openCreateForDate(day)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openCreateForDate(day);
                  }
                }}
              >
                <span className={styles.dayNum}>{day.getDate()}</span>
                {visible.map((appt) => {
                  const typeLabel = apptTypeLabel(appt);
                  const cpt = appt.cptCode;
                  const titleParts = [
                    `${fmtTime(appt.scheduledStartAt)} ${appt.clientName}`,
                    appt.providerName,
                    typeLabel,
                    cpt,
                  ].filter(Boolean);
                  return (
                    <div
                      key={appt.id}
                      className={`${styles.chip} ${chipClassFor(appt.status)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedId(appt.id);
                      }}
                      title={titleParts.join(" — ")}
                    >
                      <strong>{fmtTime(appt.scheduledStartAt)}</strong>{" "}
                      {appt.clientName}
                      {typeLabel || cpt ? (
                        <div className={styles.chipMeta}>
                          <span className={styles.chipMetaPrimary}>
                            {typeLabel ?? "—"}
                          </span>
                          {cpt ? (
                            <span className={styles.chipCpt}>{cpt}</span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {overflow > 0 ? (
                  <div
                    className={styles.overflow}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedId(dayAppointments[3].id);
                    }}
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
                    {detail.appointment.serviceLocation ? (
                      <div className={styles.sectionMuted}>
                        {detail.appointment.serviceLocation}
                      </div>
                    ) : null}
                  </div>

                  <div className={styles.row}>
                    <div className={styles.section}>
                      <div className={styles.sectionLabel}>Appointment type</div>
                      {(() => {
                        const typeLabel = apptTypeLabel(detail.appointment);
                        return (
                          <div className={styles.sectionValue}>
                            {typeLabel ?? "—"}
                          </div>
                        );
                      })()}
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
                    <div className={styles.sectionLabel}>Client balance</div>
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
                      const disabled = checkingIn || !detail.appointment.clientId;
                      return (
                        <button
                          className={styles.primaryBtn}
                          onClick={handleCheckIn}
                          disabled={disabled}
                          aria-busy={checkingIn || undefined}
                          title={!detail.appointment.clientId ? "Assign a client before checking in" : undefined}
                        >
                          {checkingIn ? (
                            <>
                              <span className={styles.btnSpinner} aria-hidden="true" />
                              Checking in…
                            </>
                          ) : alreadyCheckedIn ? (
                            "Open note"
                          ) : (
                            "Check in"
                          )}
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
                    {detail.encounter ? (
                      <button
                        className={styles.secondaryBtn}
                        onClick={() => setCancelOpen(true)}
                        disabled={detail.appointment.status === "cancelled"}
                      >
                        {detail.appointment.status === "cancelled" ? "Cancelled" : "Cancel"}
                      </button>
                    ) : (
                      <button
                        className={styles.secondaryBtn}
                        onClick={handleStartNote}
                      >
                        Start note
                      </button>
                    )}
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
          initialAmount={collectPrefill?.amount ?? null}
          initialNote={collectPrefill?.note ?? null}
          title={collectPrefill?.title ?? "Collect copay"}
          onClose={() => { setCollectOpen(false); setCollectPrefill(null); }}
          onCollected={async () => {
            setCollectOpen(false);
            setCollectPrefill(null);
            setDrawerBanner({ kind: "success", text: "Payment posted." });
            if (detail) await loadDetail(detail.appointment.id);
          }}
        />
      ) : null}

      {cancelOpen && detail ? (
        <CancelAppointmentModal
          appointmentId={detail.appointment.id}
          alreadyCancelled={detail.appointment.status === "cancelled"}
          onClose={() => setCancelOpen(false)}
          onCancelled={async ({ fee, reason }) => {
            setCancelOpen(false);
            setDrawerBanner({ kind: "success", text: "Appointment cancelled." });
            if (detail) await loadDetail(detail.appointment.id);
            await loadAppointments();
            if (fee && fee > 0 && detail.appointment.clientId) {
              setCollectPrefill({
                amount: fee,
                note: reason ? `Cancellation fee — ${reason}` : "Cancellation fee",
                title: "Charge cancellation fee",
              });
              setCollectOpen(true);
            }
          }}
        />
      ) : null}

      {createOpen ? (
        <CreateAppointmentModal
          organizationId={ORG_ID}
          initialDate={createInitialDate}
          onClose={() => {
            setCreateOpen(false);
            setCreateInitialDate(null);
          }}
          onCreated={async () => {
            setCreateOpen(false);
            setCreateInitialDate(null);
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

function CancelAppointmentModal({
  appointmentId,
  alreadyCancelled,
  onClose,
  onCancelled,
}: {
  appointmentId: string;
  alreadyCancelled: boolean;
  onClose: () => void;
  onCancelled: (args: { fee: number | null; reason: string }) => void | Promise<void>;
}) {
  const [chargeFee, setChargeFee] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      let fee: number | null = null;
      if (chargeFee) {
        const n = Number(amount);
        const cents = Math.round(n * 100);
        if (!Number.isFinite(n) || cents < 1) {
          throw new Error("Enter a cancellation fee of at least $0.01");
        }
        fee = cents / 100;
      }
      if (!alreadyCancelled) {
        const trimmedReason = reason.trim();
        const internalNote = [
          "Cancelled via appointment drawer",
          trimmedReason ? `Reason: ${trimmedReason}` : null,
          fee ? `Cancellation fee: $${fee.toFixed(2)}` : null,
        ].filter(Boolean).join(" — ");
        const res = await fetch(`/api/scheduling/appointments/${appointmentId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope: "single",
            updates: {
              appointment_status: "cancelled",
              internal_note: internalNote,
            },
          }),
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json.error ?? "Could not cancel appointment");
        }
      }
      await onCancelled({ fee, reason: reason.trim() });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3>{alreadyCancelled ? "Charge cancellation fee" : "Cancel appointment"}</h3>
        {error ? <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div> : null}

        {!alreadyCancelled ? (
          <div className={styles.modalRow}>
            <label className={styles.modalLabel}>Reason (optional)</label>
            <input
              className={styles.input}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. client called, late cancel"
              disabled={busy}
            />
          </div>
        ) : null}

        <div className={styles.modalRow}>
          <label className={styles.modalLabel}>
            <input
              type="checkbox"
              checked={chargeFee}
              onChange={(e) => setChargeFee(e.target.checked)}
              disabled={busy}
              style={{ marginRight: 6 }}
            />
            Charge the client a cancellation fee
          </label>
        </div>

        {chargeFee ? (
          <div className={styles.modalRow}>
            <label className={styles.modalLabel}>Fee amount</label>
            <input
              className={styles.input}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              disabled={busy}
              autoFocus
            />
          </div>
        ) : null}

        <div className={styles.modalActions}>
          <button className={styles.secondaryBtn} onClick={onClose} disabled={busy}>
            Never mind
          </button>
          <button className={styles.primaryBtn} onClick={submit} disabled={busy}>
            {busy
              ? "Working…"
              : alreadyCancelled
                ? (chargeFee ? "Continue to charge" : "Close")
                : (chargeFee ? "Cancel & charge fee" : "Cancel appointment")}
          </button>
        </div>
      </div>
    </div>
  );
}

function CollectModal({
  organizationId,
  clientId,
  appointmentId,
  providerId,
  openBalance,
  initialAmount,
  initialNote,
  title,
  onClose,
  onCollected,
}: {
  organizationId: string;
  clientId: string;
  appointmentId: string;
  providerId: string | null;
  openBalance: number;
  initialAmount?: number | null;
  initialNote?: string | null;
  title?: string;
  onClose: () => void;
  onCollected: () => void | Promise<void>;
}) {
  const defaultAmount = initialAmount && initialAmount > 0
    ? initialAmount.toFixed(2)
    : openBalance > 0 ? openBalance.toFixed(2) : "0.00";
  const [amount, setAmount] = useState<string>(defaultAmount);
  const [applyTo, setApplyTo] = useState<string>(initialAmount && initialAmount > 0 ? "account_balance" : openBalance > 0 ? "account_balance" : "encounter");
  const [note, setNote] = useState(initialNote ?? "");
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
        <h3>{title ?? "Collect copay"}</h3>
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

export function CreateAppointmentModal({
  organizationId,
  initialDate,
  lockedClientId,
  onClose,
  onCreated,
}: {
  organizationId: string;
  initialDate?: string | null;
  lockedClientId?: string | null;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [providers, setProviders] = useState<ProviderLite[]>([]);
  const [clientId, setClientId] = useState(lockedClientId ?? "");
  const [providerId, setProviderId] = useState("");
  const [startAt, setStartAt] = useState<string>(() => {
    if (initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate)) {
      const now = new Date();
      const hour = now.getHours() < 8 || now.getHours() >= 18 ? 9 : now.getHours() + 1;
      return `${initialDate}T${String(hour).padStart(2, "0")}:00`;
    }
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    return iso;
  });
  const [duration, setDuration] = useState<number>(60);
  const [memo, setMemo] = useState("");
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
        if (lockedClientId) {
          setClientId(lockedClientId);
        } else if (clientRows[0]) {
          setClientId(clientRows[0].id);
        }
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
        memo,
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
            disabled={Boolean(lockedClientId)}
          >
            {lockedClientId ? (
              <option value={lockedClientId}>
                {clients.find((c) => c.id === lockedClientId)?.name ?? "This client"}
              </option>
            ) : (
              clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.id}
                </option>
              ))
            )}
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
          <div className={styles.timeChips}>
            {TIME_CHIP_OPTIONS.map((opt) => {
              const active = startAt.slice(11, 16) === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={`${styles.timeChip} ${active ? styles.timeChipActive : ""}`}
                  onClick={() => {
                    const datePart = startAt.slice(0, 10) || (initialDate ?? "");
                    if (datePart) setStartAt(`${datePart}T${opt.value}`);
                  }}
                  disabled={busy}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
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
          <label className={styles.modalLabel}>Memo</label>
          <input
            className={styles.input}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
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
