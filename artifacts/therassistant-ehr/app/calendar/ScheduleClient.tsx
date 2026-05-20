"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_ORG_ID } from "@/lib/config";
import styles from "./schedule.module.css";

function getOrganizationId() {
  if (typeof window === "undefined") return DEFAULT_ORG_ID;
  const params = new URLSearchParams(window.location.search);
  return params.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
}

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
  const [appointments, setAppointments] = useState<ScheduleAppointment[]>(APPOINTMENTS);
  const [isNewApptOpen, setIsNewApptOpen] = useState(false);
  const organizationId = useMemo(() => getOrganizationId(), []);

  useEffect(() => {
    setDateLabels(computeDateLabels());
  }, []);

  const DATE_LABEL = dateLabels.label;
  const DATE_SHORT = dateLabels.short;

  const summary = useMemo(() => computeSummary(appointments), [appointments]);

  const filtered = useMemo(() => {
    let list = appointments;
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
  }, [appointments, search, filter]);

  const selected = useMemo(() => appointments.find((a) => a.id === selectedId) ?? null, [appointments, selectedId]);

  const handleAppointmentCreated = (created: ScheduleAppointment) => {
    setAppointments((prev) =>
      [...prev, created].sort((a, b) => {
        const toMin = (t: string) => {
          const [hm, p] = t.split(" ");
          const [hh, mm] = hm.split(":").map((n) => parseInt(n, 10));
          const h24 = p === "PM" && hh !== 12 ? hh + 12 : p === "AM" && hh === 12 ? 0 : hh;
          return h24 * 60 + mm;
        };
        return toMin(a.timeStart) - toMin(b.timeStart);
      }),
    );
    setSelectedId(created.id);
    setIsNewApptOpen(false);
  };

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

        <button type="button" className={styles.newApptBtn} onClick={() => setIsNewApptOpen(true)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Appointment
        </button>
      </header>

      {isNewApptOpen ? (
        <NewAppointmentModal
          organizationId={organizationId}
          onClose={() => setIsNewApptOpen(false)}
          onCreated={handleAppointmentCreated}
        />
      ) : null}

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

type EligibilityRunResult = {
  status: string;
  payerName: string | null;
  planName: string | null;
  copayAmount: number | null;
  deductibleRemaining: number | null;
  effectiveDate: string | null;
  terminationDate: string | null;
  message?: string | null;
};

function money(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value));
}

function ContextPanel({ appt }: { appt: ScheduleAppointment }) {
  const [eligibilityRunning, setEligibilityRunning] = useState(false);
  const [eligibilityError, setEligibilityError] = useState<string | null>(null);
  const [eligibilityResult, setEligibilityResult] = useState<EligibilityRunResult | null>(null);

  // Reset eligibility panel state whenever the selected appointment changes
  useEffect(() => {
    setEligibilityRunning(false);
    setEligibilityError(null);
    setEligibilityResult(null);
  }, [appt.id]);

  const runEligibility = async () => {
    setEligibilityRunning(true);
    setEligibilityError(null);
    try {
      const res = await fetch("/api/clearinghouse/eligibility/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patientId: appt.clientId,
          appointmentId: appt.id,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setEligibilityError(json?.error || "Eligibility check failed.");
      } else {
        const n = json?.normalized ?? {};
        setEligibilityResult({
          status: String(n.status ?? "unknown"),
          payerName: n.payerName ?? null,
          planName: n.planName ?? null,
          copayAmount: n.copayAmount ?? null,
          deductibleRemaining: n.deductibleRemaining ?? null,
          effectiveDate: n.effectiveDate ?? null,
          terminationDate: n.terminationDate ?? null,
          message: n.message ?? null,
        });
      }
    } catch (e) {
      setEligibilityError(e instanceof Error ? e.message : "Eligibility check failed.");
    } finally {
      setEligibilityRunning(false);
    }
  };

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

        {/* Eligibility (real-time 270/271) */}
        <div className={styles.contextSection}>
          <div className={styles.contextSectionLabel}>Real-time eligibility</div>
          <button
            type="button"
            className={styles.contextActionSecondary}
            onClick={runEligibility}
            disabled={eligibilityRunning}
            style={{ width: "100%" }}
          >
            {eligibilityRunning ? "Checking eligibility…" : "Check eligibility"}
          </button>
          {eligibilityError ? (
            <div style={{ marginTop: 8, padding: 8, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, color: "#991b1b", fontSize: 12.5 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Check failed</div>
              <div style={{ marginBottom: 6 }}>{eligibilityError}</div>
              <button
                type="button"
                onClick={runEligibility}
                disabled={eligibilityRunning}
                style={{ fontSize: 12, padding: "4px 8px", border: "1px solid #fca5a5", background: "white", borderRadius: 4, cursor: "pointer", color: "#991b1b" }}
              >
                Retry
              </button>
            </div>
          ) : null}
          {eligibilityResult ? (
            <div style={{ marginTop: 8, padding: 8, background: eligibilityResult.status === "active" ? "#ecfdf5" : eligibilityResult.status === "inactive" ? "#fef2f2" : "#fffbeb", border: `1px solid ${eligibilityResult.status === "active" ? "#a7f3d0" : eligibilityResult.status === "inactive" ? "#fecaca" : "#fde68a"}`, borderRadius: 6, fontSize: 12.5 }}>
              <div style={{ fontWeight: 600, marginBottom: 4, textTransform: "uppercase" }}>{eligibilityResult.status}</div>
              {eligibilityResult.payerName ? <div>Payer: {eligibilityResult.payerName}</div> : null}
              {eligibilityResult.planName ? <div>Plan: {eligibilityResult.planName}</div> : null}
              <div>Copay: {money(eligibilityResult.copayAmount)}</div>
              <div>Deductible remaining: {money(eligibilityResult.deductibleRemaining)}</div>
              {eligibilityResult.effectiveDate || eligibilityResult.terminationDate ? (
                <div>Coverage: {eligibilityResult.effectiveDate ?? "—"} → {eligibilityResult.terminationDate ?? "—"}</div>
              ) : null}
              {eligibilityResult.message ? <div style={{ marginTop: 4, fontStyle: "italic" }}>{eligibilityResult.message}</div> : null}
            </div>
          ) : null}
        </div>

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

/* ─── New Appointment Modal ───────────────────────────────────────────────── */

type ClientOption = { id: string; name: string };
type ProviderOption = { id: string; name: string };

function NewAppointmentModal({
  organizationId,
  onClose,
  onCreated,
}: {
  organizationId: string;
  onClose: () => void;
  onCreated: (appointment: ScheduleAppointment) => void;
}) {
  const today = useMemo(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }, []);

  const [clientQuery, setClientQuery] = useState("");
  const [selectedClient, setSelectedClient] = useState<ClientOption | null>(null);
  const [clientResults, setClientResults] = useState<ClientOption[]>([]);
  const [clientLoading, setClientLoading] = useState(false);
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false);

  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [providerId, setProviderId] = useState("");
  const [providersLoading, setProvidersLoading] = useState(true);

  const [date, setDate] = useState(today);
  const [timeStart, setTimeStart] = useState("09:00");
  const [durationMin, setDurationMin] = useState(45);
  const [type, setType] = useState("Individual Therapy");
  const [reason, setReason] = useState("");
  const [location, setLocation] = useState<"Office" | "Telehealth">("Office");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showNewClient, setShowNewClient] = useState(false);
  const [newFirstName, setNewFirstName] = useState("");
  const [newLastName, setNewLastName] = useState("");
  const [newDob, setNewDob] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [creatingClient, setCreatingClient] = useState(false);
  const [newClientError, setNewClientError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clientReqSeqRef = useRef(0);

  const handleCreateClient = async () => {
    setNewClientError(null);
    if (!newFirstName.trim() || !newLastName.trim()) {
      setNewClientError("First and last name are required");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDob)) {
      setNewClientError("Date of birth is required");
      return;
    }
    if (!newPhone.trim()) {
      setNewClientError("Primary phone is required");
      return;
    }
    setCreatingClient(true);
    try {
      const response = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          firstName: newFirstName.trim(),
          lastName: newLastName.trim(),
          dateOfBirth: newDob,
          phone: newPhone.trim(),
          email: newEmail.trim() || undefined,
        }),
      });
      const json = (await response.json()) as { success?: boolean; error?: string; client?: { id: string; name: string } };
      if (!response.ok || !json.success || !json.client) {
        throw new Error(json.error || `Failed to create client (${response.status})`);
      }
      const created: ClientOption = { id: String(json.client.id), name: String(json.client.name) };
      setSelectedClient(created);
      setClientQuery(created.name);
      setClientResults([created]);
      setClientDropdownOpen(false);
      setShowNewClient(false);
      setNewFirstName("");
      setNewLastName("");
      setNewDob("");
      setNewPhone("");
      setNewEmail("");
    } catch (err) {
      setNewClientError(err instanceof Error ? err.message : "Failed to create client");
    } finally {
      setCreatingClient(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setProvidersLoading(true);
    fetch(`/api/providers/credentialing?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json: { success?: boolean; providers?: Array<{ id: string; provider_name: string; credential_display?: string | null; is_active?: boolean }>; error?: string }) => {
        if (cancelled) return;
        if (!json.success) throw new Error(json.error || "Failed to load providers");
        const list = (json.providers ?? [])
          .filter((p) => p.is_active !== false)
          .map((p) => ({
            id: String(p.id),
            name: p.credential_display ? `${p.provider_name}, ${p.credential_display}` : String(p.provider_name),
          }));
        setProviders(list);
        if (list.length > 0) setProviderId(list[0].id);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load providers");
      })
      .finally(() => {
        if (!cancelled) setProvidersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (selectedClient && clientQuery === selectedClient.name) return;
    const q = clientQuery.trim();
    debounceRef.current = setTimeout(() => {
      const seq = ++clientReqSeqRef.current;
      setClientLoading(true);
      const params = new URLSearchParams({ organizationId });
      if (q) params.set("q", q);
      fetch(`/api/clients?${params.toString()}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((json: { success?: boolean; clients?: Array<{ id: string; name: string }>; error?: string }) => {
          if (seq !== clientReqSeqRef.current) return;
          if (!json.success) throw new Error(json.error || "Failed to load clients");
          setClientResults((json.clients ?? []).slice(0, 25).map((c) => ({ id: String(c.id), name: String(c.name) })));
          setError(null);
        })
        .catch((e: unknown) => {
          if (seq !== clientReqSeqRef.current) return;
          setClientResults([]);
          setError(e instanceof Error ? e.message : "Client search failed");
        })
        .finally(() => {
          if (seq === clientReqSeqRef.current) setClientLoading(false);
        });
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [clientQuery, organizationId, selectedClient]);

  const cptForType = (t: string) => {
    if (t === "Intake") return "90791";
    if (t === "Treatment Plan Review") return "H0032";
    if (durationMin >= 53) return "90837";
    return "90834";
  };

  const formatClock = (hour24: number, minute: number) => {
    const period = hour24 >= 12 ? "PM" : "AM";
    const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    return `${h12}:${String(minute).padStart(2, "0")} ${period}`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!selectedClient) return setError("Select a client from your chart list");
    if (!providerId) return setError("Select a provider");
    if (!reason.trim()) return setError("Reason is required");
    const [hh, mm] = timeStart.split(":").map((n) => parseInt(n, 10));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return setError("Invalid start time");
    if (mm % 15 !== 0) return setError("Start time must be on a 15-minute interval (00, 15, 30, 45)");

    const startLocal = new Date(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`);
    if (Number.isNaN(startLocal.getTime())) return setError("Invalid date/time");

    const providerLabel = providers.find((p) => p.id === providerId)?.name ?? "Unassigned";

    setSubmitting(true);
    try {
      const response = await fetch("/api/scheduling/appointments/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          clientId: selectedClient.id,
          providerId,
          scheduledStartAt: startLocal.toISOString(),
          durationMinutes: durationMin,
          appointmentType: type,
          reason: reason.trim(),
          serviceLocation: location === "Telehealth" ? "telehealth" : "office",
          reminderPortalEnabled: true,
        }),
      });
      const json = (await response.json()) as {
        success?: boolean;
        error?: string;
        appointments?: Array<{ id: string; scheduled_start_at: string }>;
      };
      if (!response.ok || !json.success) {
        throw new Error(json.error || `Failed to create appointment (${response.status})`);
      }

      const created = json.appointments?.[0];
      const newId = created?.id ?? `appt-${Date.now()}`;
      const endTotal = hh * 60 + mm + durationMin;
      const endH = Math.floor(endTotal / 60);
      const endM = endTotal % 60;

      const appointment: ScheduleAppointment = {
        id: newId,
        clientId: selectedClient.id,
        patientName: selectedClient.name,
        dob: "",
        timeStart: formatClock(hh, mm),
        timeEnd: formatClock(endH, endM),
        durationMin,
        type,
        cpt: cptForType(type),
        provider: providerLabel,
        location,
        insurance: "",
        status: "scheduled",
        alerts: [],
        recentNote: null,
        diagnoses: [],
        tasks: [],
        copay: null,
      };
      onCreated(appointment);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create appointment");
    } finally {
      setSubmitting(false);
    }
  };

  const overlay: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(16, 36, 63, 0.45)",
    backdropFilter: "blur(2px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: 16,
  };
  const card: React.CSSProperties = {
    background: "#fff",
    border: "1px solid #d8e1e9",
    borderRadius: 6,
    width: "100%",
    maxWidth: 520,
    boxShadow: "0 20px 50px rgba(16, 36, 63, 0.2)",
    overflow: "hidden",
  };
  const head: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 18px",
    borderBottom: "1px solid #e8eef3",
    background: "#f8fafc",
  };
  const body: React.CSSProperties = { padding: "16px 18px", display: "grid", gap: 12 };
  const label: React.CSSProperties = {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    color: "#5c6e82",
    fontWeight: 600,
    marginBottom: 4,
    display: "block",
  };
  const input: React.CSSProperties = {
    width: "100%",
    border: "1px solid #d8e1e9",
    borderRadius: 4,
    padding: "8px 10px",
    fontSize: 13,
    color: "#1a2332",
    background: "#fff",
  };
  const row: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 };
  const foot: React.CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 18px",
    borderTop: "1px solid #e8eef3",
    background: "#fafbfc",
  };
  const btn: React.CSSProperties = {
    padding: "8px 14px",
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    border: "1px solid #d8e1e9",
    background: "#fff",
    color: "#1a2332",
    cursor: "pointer",
  };
  const btnPrimary: React.CSSProperties = {
    ...btn,
    background: "#10243f",
    color: "#fff",
    borderColor: "#10243f",
  };

  return (
    <div style={overlay} onClick={onClose} role="dialog" aria-modal="true" aria-label="New appointment">
      <form style={card} onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <div style={head}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#10243f" }}>New Appointment</div>
          <button type="button" onClick={onClose} style={{ ...btn, padding: "4px 8px" }} aria-label="Close">
            ×
          </button>
        </div>
        <div style={body}>
          {error ? (
            <div style={{ background: "#fff1f1", border: "1px solid #f4c7c7", color: "#b02020", padding: "8px 10px", borderRadius: 4, fontSize: 12 }}>
              {error}
            </div>
          ) : null}
          <div style={{ position: "relative" }}>
            <label style={label}>Client (chart)</label>
            <input
              style={input}
              type="text"
              value={clientQuery}
              onChange={(e) => {
                setClientQuery(e.target.value);
                setSelectedClient(null);
                setClientDropdownOpen(true);
              }}
              onFocus={() => setClientDropdownOpen(true)}
              onBlur={() => setTimeout(() => setClientDropdownOpen(false), 150)}
              placeholder="Search by client name…"
              autoComplete="off"
              autoFocus
            />
            {clientDropdownOpen && (clientResults.length > 0 || clientLoading) ? (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  right: 0,
                  marginTop: 2,
                  background: "#fff",
                  border: "1px solid #d8e1e9",
                  borderRadius: 4,
                  boxShadow: "0 8px 20px rgba(16,36,63,0.12)",
                  maxHeight: 200,
                  overflowY: "auto",
                  zIndex: 1010,
                }}
              >
                {clientLoading ? (
                  <div style={{ padding: "8px 10px", fontSize: 12, color: "#5c6e82" }}>Searching…</div>
                ) : (
                  clientResults.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setSelectedClient(c);
                        setClientQuery(c.name);
                        setClientDropdownOpen(false);
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 10px",
                        fontSize: 13,
                        background: selectedClient?.id === c.id ? "#eef4fb" : "#fff",
                        border: "none",
                        borderBottom: "1px solid #f0f3f6",
                        cursor: "pointer",
                        color: "#1a2332",
                      }}
                    >
                      {c.name}
                    </button>
                  ))
                )}
              </div>
            ) : null}
            <div style={{ marginTop: 4, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              {selectedClient ? (
                <div style={{ fontSize: 11, color: "#1a7f3c" }}>
                  ✓ Linked to chart {selectedClient.id.slice(0, 8)}…
                </div>
              ) : (
                <div style={{ fontSize: 11, color: "#5c6e82" }}>
                  Select an existing chart, or add a new one below.
                </div>
              )}
              <button
                type="button"
                onClick={() => setShowNewClient((v) => !v)}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#10243f",
                  textDecoration: "underline",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {showNewClient ? "Cancel new client" : "Can't find them? + Add new client"}
              </button>
            </div>
            {showNewClient ? (
              <div
                style={{
                  marginTop: 8,
                  padding: 10,
                  border: "1px dashed #c8d3df",
                  borderRadius: 4,
                  background: "#f8fafc",
                  display: "grid",
                  gap: 8,
                }}
              >
                {newClientError ? (
                  <div style={{ background: "#fff1f1", border: "1px solid #f4c7c7", color: "#b02020", padding: "6px 8px", borderRadius: 4, fontSize: 11 }}>
                    {newClientError}
                  </div>
                ) : null}
                <div style={row}>
                  <div>
                    <label style={label}>First name</label>
                    <input style={input} type="text" value={newFirstName} onChange={(e) => setNewFirstName(e.target.value)} />
                  </div>
                  <div>
                    <label style={label}>Last name</label>
                    <input style={input} type="text" value={newLastName} onChange={(e) => setNewLastName(e.target.value)} />
                  </div>
                </div>
                <div style={row}>
                  <div>
                    <label style={label}>Date of birth</label>
                    <input style={input} type="date" value={newDob} onChange={(e) => setNewDob(e.target.value)} />
                  </div>
                  <div>
                    <label style={label}>Primary phone</label>
                    <input style={input} type="tel" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="(555) 123-4567" />
                  </div>
                </div>
                <div>
                  <label style={label}>Email (optional)</label>
                  <input style={input} type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={handleCreateClient}
                    disabled={creatingClient}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 4,
                      fontSize: 12,
                      fontWeight: 600,
                      border: "1px solid #10243f",
                      background: "#10243f",
                      color: "#fff",
                      cursor: creatingClient ? "wait" : "pointer",
                      opacity: creatingClient ? 0.6 : 1,
                    }}
                  >
                    {creatingClient ? "Creating…" : "Create client & select"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <div style={row}>
            <div>
              <label style={label}>Date</label>
              <input style={input} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label style={label}>Start time</label>
              <input style={input} type="time" step={900} value={timeStart} onChange={(e) => setTimeStart(e.target.value)} />
            </div>
          </div>
          <div style={row}>
            <div>
              <label style={label}>Duration (min)</label>
              <select style={input} value={durationMin} onChange={(e) => setDurationMin(parseInt(e.target.value, 10))}>
                <option value={30}>30</option>
                <option value={45}>45</option>
                <option value={53}>53</option>
                <option value={60}>60</option>
              </select>
            </div>
            <div>
              <label style={label}>Location</label>
              <select
                style={input}
                value={location}
                onChange={(e) => setLocation(e.target.value as "Office" | "Telehealth")}
              >
                <option>Office</option>
                <option>Telehealth</option>
              </select>
            </div>
          </div>
          <div style={row}>
            <div>
              <label style={label}>Appointment type</label>
              <select style={input} value={type} onChange={(e) => setType(e.target.value)}>
                <option>Individual Therapy</option>
                <option>Intake</option>
                <option>Treatment Plan Review</option>
                <option>Family Therapy</option>
              </select>
            </div>
            <div>
              <label style={label}>Provider</label>
              <select style={input} value={providerId} onChange={(e) => setProviderId(e.target.value)} disabled={providersLoading}>
                {providersLoading ? <option value="">Loading…</option> : null}
                {!providersLoading && providers.length === 0 ? <option value="">No active providers</option> : null}
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label style={label}>Reason</label>
            <input
              style={input}
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Weekly therapy session, follow-up on anxiety symptoms"
            />
          </div>
        </div>
        <div style={foot}>
          <button type="button" style={btn} onClick={onClose} disabled={submitting}>Cancel</button>
          <button type="submit" style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? "wait" : "pointer" }} disabled={submitting}>
            {submitting ? "Creating…" : "Create appointment"}
          </button>
        </div>
      </form>
    </div>
  );
}
