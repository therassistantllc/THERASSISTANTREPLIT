"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import styles from "./schedule.module.css";

/* ─── Types ───────────────────────────────────────────────────────────────── */

type AppointmentStatus =
  | "scheduled"
  | "checked_in"
  | "in_session"
  | "needs_signature"
  | "completed"
  | "no_show"
  | "cancelled";

type ViewMode = "day" | "week" | "provider" | "location";
type Filter = "all" | "scheduled" | "checked_in" | "completed" | "no_show";

interface ScheduleAppointment {
  id: string;
  clientId: string;
  patientName: string;
  dob: string;
  timeStart: string;
  timeEnd: string;
  durationMin: number;
  type: string;
  cpt: string;
  provider: string;
  location: "Office" | "Telehealth";
  telehealthUrl?: string;
  insurance: string;
  status: AppointmentStatus;
  alerts: { text: string; tone: "amber" | "red" | "blue" | "purple" }[];
  recentNote: string | null;
  diagnoses: string[];
  tasks: { text: string; color: string }[];
  copay: string | null;
}

/* ─── Demo Data ───────────────────────────────────────────────────────────── */

function computeDateLabels() {
  const today = new Date();
  return {
    label: today.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }),
    short: today.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }),
  };
}

const APPOINTMENTS: ScheduleAppointment[] = [
  {
    id: "appt-a1",
    clientId: "cc100001-0000-0000-0000-000000000001",
    patientName: "Elena Rodriguez",
    dob: "1989-03-14",
    timeStart: "8:30 AM",
    timeEnd: "9:20 AM",
    durationMin: 50,
    type: "Intake",
    cpt: "90791",
    provider: "Lena Ortiz, LPC",
    location: "Office",
    insurance: "BCBS Colorado",
    status: "checked_in",
    alerts: [
      { text: "Consent forms unsigned", tone: "amber" },
      { text: "Insurance not verified", tone: "red" },
    ],
    recentNote: null,
    diagnoses: ["F41.1 – Generalized Anxiety Disorder"],
    tasks: [
      { text: "Complete intake paperwork", color: "#F59E0B" },
      { text: "Verify BCBS eligibility", color: "#EF4444" },
    ],
    copay: "$30",
  },
  {
    id: "appt-a2",
    clientId: "cc100001-0000-0000-0000-000000000002",
    patientName: "Avery Morgan",
    dob: "1995-07-22",
    timeStart: "9:00 AM",
    timeEnd: "9:53 AM",
    durationMin: 53,
    type: "Individual Therapy",
    cpt: "90837",
    provider: "Lena Ortiz, LPC",
    location: "Telehealth",
    telehealthUrl: "https://telehealth.example.com/session/appt-1001",
    insurance: "Aetna",
    status: "scheduled",
    alerts: [
      { text: "Telehealth – verify location", tone: "purple" },
    ],
    recentNote: "Client reported significant improvement in sleep and daily functioning. Continuing CBT techniques for anxiety management.",
    diagnoses: ["F33.1 – Major Depressive Disorder, recurrent"],
    tasks: [
      { text: "Confirm telehealth link sent", color: "#8B5CF6" },
    ],
    copay: "$20",
  },
  {
    id: "appt-a3",
    clientId: "cc100001-0000-0000-0000-000000000003",
    patientName: "Sofia Martinez",
    dob: "2009-11-05",
    timeStart: "10:30 AM",
    timeEnd: "11:23 AM",
    durationMin: 53,
    type: "Individual Therapy",
    cpt: "90837",
    provider: "Noah Kim, LCSW",
    location: "Office",
    insurance: "BCBS Colorado",
    status: "in_session",
    alerts: [
      { text: "Minor – guardian in waiting room", tone: "blue" },
      { text: "School ROI pending", tone: "amber" },
    ],
    recentNote: "Session focused on school-related stressors. Family dynamics improving. Guardian engaged and supportive.",
    diagnoses: ["F43.23 – Adjustment Disorder with mixed anxiety and depressed mood"],
    tasks: [
      { text: "Send school ROI to guardian", color: "#F59E0B" },
      { text: "Review treatment plan (due this week)", color: "#EF4444" },
    ],
    copay: null,
  },
  {
    id: "appt-a4",
    clientId: "cc100001-0000-0000-0000-000000000004",
    patientName: "James Rivera",
    dob: "1973-01-30",
    timeStart: "11:00 AM",
    timeEnd: "11:45 AM",
    durationMin: 45,
    type: "Individual Therapy",
    cpt: "90834",
    provider: "Priya Shah, PsyD",
    location: "Office",
    insurance: "Medicare",
    status: "needs_signature",
    alerts: [
      { text: "Note unsigned – required for billing", tone: "amber" },
    ],
    recentNote: "Client discussed employment transition. Mood stable. Sleep improved with behavioral changes. GAD symptoms reduced.",
    diagnoses: ["F41.1 – Generalized Anxiety Disorder", "Z56.0 – Problems with employment"],
    tasks: [
      { text: "Sign clinical note", color: "#F59E0B" },
      { text: "Submit claim to Medicare", color: "#94A3B8" },
    ],
    copay: "$0",
  },
  {
    id: "appt-a5",
    clientId: "cc100001-0000-0000-0000-000000000005",
    patientName: "Marcus Thompson",
    dob: "1984-09-18",
    timeStart: "1:00 PM",
    timeEnd: "2:00 PM",
    durationMin: 60,
    type: "Intake",
    cpt: "90791",
    provider: "Priya Shah, PsyD",
    location: "Telehealth",
    telehealthUrl: "https://telehealth.example.com/session/appt-1003",
    insurance: "Colorado Medicaid",
    status: "needs_signature",
    alerts: [
      { text: "Encounter open – note not started", tone: "amber" },
      { text: "Telehealth – verify Colorado location", tone: "purple" },
    ],
    recentNote: null,
    diagnoses: ["Pending – intake assessment needed"],
    tasks: [
      { text: "Complete intake documentation", color: "#EF4444" },
      { text: "Submit prior auth for ongoing therapy", color: "#F59E0B" },
    ],
    copay: "$3",
  },
  {
    id: "appt-a6",
    clientId: "cc100001-0000-0000-0000-000000000001",
    patientName: "Dana Patel",
    dob: "1991-05-27",
    timeStart: "2:30 PM",
    timeEnd: "3:15 PM",
    durationMin: 45,
    type: "Treatment Plan Review",
    cpt: "H0032",
    provider: "Lena Ortiz, LPC",
    location: "Office",
    insurance: "United Behavioral Health",
    status: "scheduled",
    alerts: [
      { text: "Treatment plan expires in 3 days", tone: "red" },
    ],
    recentNote: "Strong session — client identifying triggers for depressive episodes. Setting behavioral activation goals for the next 2 weeks.",
    diagnoses: ["F32.1 – Major Depressive Episode, moderate"],
    tasks: [
      { text: "Update and sign treatment plan", color: "#EF4444" },
      { text: "Collect copay $40", color: "#94A3B8" },
    ],
    copay: "$40",
  },
  {
    id: "appt-a7",
    clientId: "cc100001-0000-0000-0000-000000000002",
    patientName: "Sarah Johnson",
    dob: "1968-12-03",
    timeStart: "3:45 PM",
    timeEnd: "4:38 PM",
    durationMin: 53,
    type: "Individual Therapy",
    cpt: "90837",
    provider: "Noah Kim, LCSW",
    location: "Office",
    insurance: "Aetna",
    status: "no_show",
    alerts: [
      { text: "No-show – 2nd occurrence this month", tone: "red" },
    ],
    recentNote: "Client expressed ambivalence about therapy goals. Recommended adding structure between sessions.",
    diagnoses: ["F33.0 – Major Depressive Disorder, recurrent, mild"],
    tasks: [
      { text: "Send no-show follow-up message", color: "#EF4444" },
      { text: "Review no-show policy with client", color: "#F59E0B" },
    ],
    copay: null,
  },
];

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

const STATUS_LABEL: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled",
  checked_in: "Checked In",
  in_session: "In Session",
  needs_signature: "Needs Signature",
  completed: "Completed",
  no_show: "No Show",
  cancelled: "Cancelled",
};

function statusBadgeClass(status: AppointmentStatus): string {
  return {
    scheduled: styles.badgeScheduled,
    checked_in: styles.badgeCheckedIn,
    in_session: styles.badgeInSession,
    needs_signature: styles.badgeNeedsSignature,
    completed: styles.badgeCompleted,
    no_show: styles.badgeNoShow,
    cancelled: styles.badgeCancelled,
  }[status] ?? styles.badgeCompleted;
}

function statusAccentClass(appt: ScheduleAppointment): string {
  if (appt.location === "Telehealth" && (appt.status === "scheduled" || appt.status === "in_session")) {
    return styles.accentTelehealth;
  }
  return {
    scheduled: styles.accentScheduled,
    checked_in: styles.accentCheckedIn,
    in_session: styles.accentInSession,
    needs_signature: styles.accentNeedsSignature,
    completed: styles.accentCompleted,
    no_show: styles.accentNoShow,
    cancelled: styles.accentCancelled,
  }[appt.status] ?? styles.accentCompleted;
}

function alertClass(tone: string): string {
  if (tone === "red") return `${styles.alert} ${styles.alertRed}`;
  if (tone === "blue") return `${styles.alert} ${styles.alertBlue}`;
  if (tone === "purple") return `${styles.alert} ${styles.alertPurple}`;
  return styles.alert;
}

function formatDob(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  const age = Math.floor((Date.now() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · Age ${age}`;
}

/* ─── Summary counts ─────────────────────────────────────────────────────── */

function computeSummary(appts: ScheduleAppointment[]) {
  return {
    total: appts.length,
    unsigned: appts.filter((a) => a.status === "needs_signature").length,
    pending: appts.filter((a) => a.alerts.some((al) => al.tone === "amber")).length,
    noShow: appts.filter((a) => a.status === "no_show").length,
    messages: 3,
  };
}

/* ─── Main Component ─────────────────────────────────────────────────────── */

export default function ScheduleClient() {
  const [view, setView] = useState<ViewMode>("day");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>("appt-a3");
  const [dateLabels, setDateLabels] = useState<{ label: string; short: string }>({ label: "", short: "" });

  useEffect(() => {
    setDateLabels(computeDateLabels());
  }, []);

  const DATE_LABEL = dateLabels.label;
  const DATE_SHORT = dateLabels.short;

  const summary = useMemo(() => computeSummary(APPOINTMENTS), []);

  const filtered = useMemo(() => {
    let list = APPOINTMENTS;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (a) =>
          a.patientName.toLowerCase().includes(q) ||
          a.type.toLowerCase().includes(q) ||
          a.insurance.toLowerCase().includes(q) ||
          a.cpt.includes(q),
      );
    }
    if (filter === "scheduled") list = list.filter((a) => a.status === "scheduled");
    if (filter === "checked_in") list = list.filter((a) => a.status === "checked_in" || a.status === "in_session");
    if (filter === "completed") list = list.filter((a) => a.status === "completed" || a.status === "needs_signature");
    if (filter === "no_show") list = list.filter((a) => a.status === "no_show" || a.status === "cancelled");
    return list;
  }, [search, filter]);

  const selected = useMemo(() => APPOINTMENTS.find((a) => a.id === selectedId) ?? null, [selectedId]);

  return (
    <div className={styles.page}>
      {/* ── Header ─── */}
      <header className={styles.header}>
        <div className={styles.headerDate}>
          <div className={styles.headerDateDay}>{DATE_SHORT}</div>
          <div className={styles.headerDateSub}>{DATE_LABEL.split(", ").slice(1).join(", ")}</div>
        </div>

        <div className={styles.headerSpacer} />

        <div className={styles.searchWrap}>
          <span className={styles.searchIcon}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <input
            className={styles.searchInput}
            type="text"
            placeholder="Search patients…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className={styles.filterRow}>
          {(["all", "scheduled", "checked_in", "completed", "no_show"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={filter === f ? `${styles.filterChip} ${styles.filterChipActive}` : styles.filterChip}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : f === "checked_in" ? "Active" : f === "no_show" ? "No Show" : f === "scheduled" ? "Upcoming" : "Done"}
            </button>
          ))}
        </div>

        <button type="button" className={styles.newApptBtn}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Appointment
        </button>
      </header>

      {/* ── Summary Strip ─── */}
      <div className={styles.summaryStrip}>
        <div className={styles.summaryItem}>
          <span className={styles.summaryValue}>{summary.total}</span>
          <span className={styles.summaryLabel}>Today's Appointments</span>
        </div>
        <div className={styles.summaryItem}>
          <span className={`${styles.summaryValue} ${styles.summaryValueAmber}`}>{summary.unsigned}</span>
          <span className={styles.summaryLabel}>Unsigned Notes</span>
        </div>
        <div className={styles.summaryItem}>
          <span className={`${styles.summaryValue} ${styles.summaryValueAmber}`}>{summary.pending}</span>
          <span className={styles.summaryLabel}>Pending Alerts</span>
        </div>
        <div className={styles.summaryItem}>
          <span className={`${styles.summaryValue} ${styles.summaryValueRed}`}>{summary.noShow}</span>
          <span className={styles.summaryLabel}>No Show</span>
        </div>
        <div className={styles.summaryItem}>
          <span className={`${styles.summaryValue} ${styles.summaryValueBlue}`}>{summary.messages}</span>
          <span className={styles.summaryLabel}>Messages</span>
        </div>
      </div>

      {/* ── Body ─── */}
      <div className={styles.body}>
        {/* Left: Schedule */}
        <div className={styles.scheduleCol}>
          {/* View toggles */}
          <div className={styles.viewBar}>
            <div className={styles.viewToggleGroup}>
              {(["day", "week", "provider", "location"] as ViewMode[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  className={view === v ? `${styles.viewToggle} ${styles.viewToggleActive}` : styles.viewToggle}
                  onClick={() => setView(v)}
                >
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
            <div className={styles.viewBarSpacer} />
            <span className={styles.viewBarDate}>{DATE_LABEL}</span>
          </div>

          {/* Appointment cards */}
          <div className={styles.appointmentList}>
            {filtered.length === 0 ? (
              <div style={{ color: "#94A3B8", fontSize: 13, textAlign: "center", padding: "40px 0" }}>
                No appointments match the current filter.
              </div>
            ) : null}

            {filtered.map((appt, idx) => {
              const prev = filtered[idx - 1];
              const showLunchDivider = prev && prev.timeEnd === "12:00 PM" && appt.timeStart === "1:00 PM";
              return (
                <div key={appt.id}>
                  {showLunchDivider ? (
                    <div className={styles.listDivider}>
                      <div className={styles.listDividerLine} />
                      <span className={styles.listDividerLabel}>12:00 – 1:00 PM · Lunch</span>
                      <div className={styles.listDividerLine} />
                    </div>
                  ) : null}
                  <AppointmentCard
                    appt={appt}
                    isSelected={selectedId === appt.id}
                    onSelect={() => setSelectedId(appt.id === selectedId ? null : appt.id)}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Context Panel */}
        <aside className={styles.contextPanel}>
          {selected ? (
            <ContextPanel appt={selected} />
          ) : (
            <div className={styles.contextEmpty}>
              <div className={styles.contextEmptyIcon}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </div>
              <p className={styles.contextEmptyText}>
                Select an appointment to view patient details, alerts, and quick actions.
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ─── Appointment Card ────────────────────────────────────────────────────── */

function AppointmentCard({
  appt,
  isSelected,
  onSelect,
}: {
  appt: ScheduleAppointment;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const isTelehealth = appt.location === "Telehealth";
  const showTelehealth = isTelehealth && (appt.status === "scheduled" || appt.status === "in_session" || appt.status === "checked_in");

  return (
    <div
      className={`${styles.card} ${isSelected ? styles.cardSelected : ""}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(); }}
      aria-selected={isSelected}
    >
      {/* Accent strip */}
      <div className={`${styles.cardAccent} ${statusAccentClass(appt)}`} />

      {/* Time */}
      <div className={styles.cardTime}>
        <div className={styles.cardTimeStart}>{appt.timeStart}</div>
        <div className={styles.cardTimeEnd}>{appt.timeEnd}</div>
        <div className={styles.cardDuration}>{appt.durationMin} min</div>
      </div>

      {/* Main content */}
      <div className={styles.cardMain}>
        <div className={styles.cardTopRow}>
          <span className={styles.cardPatient}>{appt.patientName}</span>
          <div className={styles.cardBadges}>
            {isTelehealth ? (
              <span className={`${styles.badge} ${styles.badgeTelehealth}`}>Telehealth</span>
            ) : null}
            <span className={`${styles.badge} ${statusBadgeClass(appt.status)}`}>
              {STATUS_LABEL[appt.status]}
            </span>
          </div>
        </div>

        <div className={styles.cardMeta}>
          <span className={styles.cardMetaItem}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
            </svg>
            {appt.type} · {appt.cpt}
          </span>
          <span className={styles.cardMetaItem}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            {appt.insurance}
          </span>
          <span className={styles.cardMetaItem}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
            </svg>
            {appt.provider.split(",")[0]}
          </span>
        </div>

        {appt.alerts.length > 0 ? (
          <div className={styles.cardAlerts}>
            {appt.alerts.map((al) => (
              <span key={al.text} className={alertClass(al.tone)}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                {al.text}
              </span>
            ))}
          </div>
        ) : null}

        <div className={styles.cardActions} onClick={(e) => e.stopPropagation()} role="presentation">
          <Link className={`${styles.actionBtn} ${styles.actionBtnPrimary}`} href={`/clients/${appt.clientId}`}>
            Open Chart
          </Link>
          {appt.status === "checked_in" || appt.status === "in_session" ? (
            <Link className={`${styles.actionBtn} ${styles.actionBtnGreen}`} href={`/encounters/new?clientId=${appt.clientId}`}>
              Start Note
            </Link>
          ) : null}
          {appt.status === "scheduled" ? (
            <button type="button" className={`${styles.actionBtn} ${styles.actionBtnGreen}`}>Check In</button>
          ) : null}
          {showTelehealth && appt.telehealthUrl ? (
            <a className={styles.actionBtn} href={appt.telehealthUrl} target="_blank" rel="noopener noreferrer">
              Join Telehealth
            </a>
          ) : null}
          {appt.status === "needs_signature" ? (
            <Link className={`${styles.actionBtn} ${styles.actionBtnPrimary}`} href={`/clients/${appt.clientId}/notes`}>
              Sign Note
            </Link>
          ) : null}
          {appt.copay ? (
            <button type="button" className={styles.actionBtn}>Collect {appt.copay}</button>
          ) : null}
          {appt.status !== "no_show" && appt.status !== "cancelled" && appt.status !== "completed" && appt.status !== "needs_signature" ? (
            <button type="button" className={`${styles.actionBtn} ${styles.actionBtnRed}`}>No Show</button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ─── Context Panel ───────────────────────────────────────────────────────── */

function ContextPanel({ appt }: { appt: ScheduleAppointment }) {
  return (
    <>
      <div className={styles.contextHeader}>
        <div className={styles.contextPatientName}>{appt.patientName}</div>
        <div className={styles.contextPatientMeta}>
          <span>{formatDob(appt.dob)}</span>
          <span className={styles.contextPatientMetaDot}>·</span>
          <span>{appt.insurance}</span>
        </div>
      </div>

      <div className={styles.contextBody}>
        {/* Appointment Info */}
        <div className={styles.contextSection}>
          <div className={styles.contextSectionLabel}>Today's Appointment</div>
          <div className={styles.contextRow}>
            <span className={styles.contextRowLabel}>Time</span>
            <span className={styles.contextRowValue}>{appt.timeStart} – {appt.timeEnd}</span>
          </div>
          <div className={styles.contextRow}>
            <span className={styles.contextRowLabel}>Type</span>
            <span className={styles.contextRowValue}>{appt.type}</span>
          </div>
          <div className={styles.contextRow}>
            <span className={styles.contextRowLabel}>CPT</span>
            <span className={styles.contextRowValue}>{appt.cpt}</span>
          </div>
          <div className={styles.contextRow}>
            <span className={styles.contextRowLabel}>Location</span>
            <span className={styles.contextRowValue}>{appt.location}</span>
          </div>
          <div className={styles.contextRow}>
            <span className={styles.contextRowLabel}>Provider</span>
            <span className={styles.contextRowValue}>{appt.provider}</span>
          </div>
          {appt.copay ? (
            <div className={styles.contextRow}>
              <span className={styles.contextRowLabel}>Copay</span>
              <span className={styles.contextRowValue}>{appt.copay}</span>
            </div>
          ) : null}
        </div>

        {/* Alerts */}
        {appt.alerts.length > 0 ? (
          <div className={styles.contextAlerts}>
            {appt.alerts.map((al) => (
              <div key={al.text} className={`${styles.contextAlert} ${al.tone === "blue" || al.tone === "purple" ? styles.contextAlertBlue : ""}`}>
                <span className={styles.contextAlertIcon}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </span>
                <span className={styles.contextAlertText}>{al.text}</span>
              </div>
            ))}
          </div>
        ) : null}

        {/* Diagnoses */}
        <div className={styles.contextSection}>
          <div className={styles.contextSectionLabel}>Diagnosis</div>
          {appt.diagnoses.map((dx) => (
            <div key={dx} className={styles.contextRow}>
              <span className={styles.contextRowValue} style={{ textAlign: "left", maxWidth: "100%", fontSize: 12.5 }}>{dx}</span>
            </div>
          ))}
        </div>

        {/* Recent Note */}
        {appt.recentNote ? (
          <div className={styles.contextNote}>
            <div className={styles.contextNoteLabel}>Most Recent Note</div>
            <div className={styles.contextNoteText}>{appt.recentNote}</div>
          </div>
        ) : null}

        {/* Tasks */}
        {appt.tasks.length > 0 ? (
          <div className={styles.contextTasks}>
            <div className={styles.contextSectionLabel}>Upcoming Tasks</div>
            {appt.tasks.map((t) => (
              <div key={t.text} className={styles.contextTask}>
                <span className={styles.contextTaskDot} style={{ background: t.color }} />
                {t.text}
              </div>
            ))}
          </div>
        ) : null}

        {/* Footer Actions */}
        <div className={styles.contextFooter}>
          <Link className={styles.contextActionPrimary} href={`/clients/${appt.clientId}`}>
            Open Chart
          </Link>
          <div className={styles.contextActionRow}>
            {appt.status === "checked_in" || appt.status === "in_session" ? (
              <Link className={styles.contextActionSecondary} href={`/encounters/new?clientId=${appt.clientId}`}>
                Start Session
              </Link>
            ) : null}
            {appt.status === "needs_signature" ? (
              <Link className={styles.contextActionSecondary} href={`/clients/${appt.clientId}/notes`}>
                Sign Note
              </Link>
            ) : null}
            <button type="button" className={styles.contextActionSecondary}>Send Message</button>
          </div>
        </div>
      </div>
    </>
  );
}
