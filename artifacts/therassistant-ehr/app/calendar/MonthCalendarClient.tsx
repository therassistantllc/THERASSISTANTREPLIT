"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
                            detail.insurance.primaryPolicy.planName ??
                            "Primary policy"}
                        </div>
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

function CollectModal({
  organizationId,
  clientId,
  appointmentId,
  openBalance,
  onClose,
  onCollected,
}: {
  organizationId: string;
  clientId: string;
  appointmentId: string;
  openBalance: number;
  onClose: () => void;
  onCollected: () => void | Promise<void>;
}) {
  const [amount, setAmount] = useState<string>(
    openBalance > 0 ? openBalance.toFixed(2) : "0.00",
  );
  const [method, setMethod] = useState<string>("cash");
  const [applyTo, setApplyTo] = useState<string>(
    openBalance > 0 ? "account_balance" : "encounter",
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        organizationId,
        clientId,
        amount: Number(amount),
        method,
        applyToKind: applyTo,
        note: note || null,
      };
      if (applyTo === "encounter") {
        body.appointmentId = appointmentId;
      }
      const res = await fetch(`/api/billing/payments/patient`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(
          json.error ??
            (json.errors && json.errors[0]) ??
            "Payment posting failed",
        );
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
        <h3>Collect payment</h3>
        {error ? (
          <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>
        ) : null}
        <div className={styles.modalRow}>
          <label className={styles.modalLabel}>Amount</label>
          <input
            className={styles.input}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className={styles.modalRow}>
          <label className={styles.modalLabel}>Method</label>
          <select
            className={styles.select}
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            <option value="cash">Cash</option>
            <option value="check">Check</option>
            <option value="credit_card">Credit card</option>
            <option value="debit_card">Debit card</option>
            <option value="stripe">Stripe</option>
            <option value="external_card">External card</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className={styles.modalRow}>
          <label className={styles.modalLabel}>Apply to</label>
          <select
            className={styles.select}
            value={applyTo}
            onChange={(e) => setApplyTo(e.target.value)}
          >
            <option value="account_balance">Account balance</option>
            <option value="encounter">This encounter</option>
          </select>
        </div>
        <div className={styles.modalRow}>
          <label className={styles.modalLabel}>Note (optional)</label>
          <input
            className={styles.input}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className={styles.modalActions}>
          <button className={styles.secondaryBtn} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={styles.primaryBtn} onClick={submit} disabled={busy}>
            {busy ? "Posting…" : "Post payment"}
          </button>
        </div>
      </div>
    </div>
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
