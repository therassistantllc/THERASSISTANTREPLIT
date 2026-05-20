"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bell,
  Calendar as CalendarIcon,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  MapPin,
  MoreVertical,
  Search,
  User,
  Video,
  XCircle,
} from "lucide-react";
import { DEFAULT_ORG_ID } from "@/lib/config";

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

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
    alerts: [{ text: "Telehealth – verify location", tone: "purple" }],
    recentNote:
      "Client reported significant improvement in sleep and daily functioning. Continuing CBT techniques for anxiety management.",
    diagnoses: ["F33.1 – Major Depressive Disorder, recurrent"],
    tasks: [{ text: "Confirm telehealth link sent", color: "#8B5CF6" }],
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
    recentNote:
      "Session focused on school-related stressors. Family dynamics improving. Guardian engaged and supportive.",
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
    alerts: [{ text: "Note unsigned – required for billing", tone: "amber" }],
    recentNote:
      "Client discussed employment transition. Mood stable. Sleep improved with behavioral changes. GAD symptoms reduced.",
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
    alerts: [{ text: "Treatment plan expires in 3 days", tone: "red" }],
    recentNote:
      "Strong session — client identifying triggers for depressive episodes. Setting behavioral activation goals for the next 2 weeks.",
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
    alerts: [{ text: "No-show – 2nd occurrence this month", tone: "red" }],
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

function parseTimeToMinutes(timeStr: string): number {
  const [hm, p] = timeStr.split(" ");
  const [hh, mm] = hm.split(":").map((n) => parseInt(n, 10));
  const h24 = p === "PM" && hh !== 12 ? hh + 12 : p === "AM" && hh === 12 ? 0 : hh;
  return h24 * 60 + mm;
}

function formatDob(iso: string): string {
  if (!iso) return "";
  const date = new Date(`${iso}T00:00:00`);
  const age = Math.floor((Date.now() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · Age ${age}`;
}

function money(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value));
}

function getStatusConfig(status: AppointmentStatus) {
  switch (status) {
    case "scheduled":
      return { bg: "bg-blue-50 border-blue-200", accent: "bg-blue-500", text: "text-blue-900", label: "Scheduled" };
    case "checked_in":
      return { bg: "bg-emerald-50 border-emerald-200", accent: "bg-emerald-500", text: "text-emerald-900", label: "Checked In" };
    case "in_session":
      return { bg: "bg-purple-50 border-purple-200", accent: "bg-purple-500", text: "text-purple-900", label: "In Session" };
    case "needs_signature":
      return { bg: "bg-amber-50 border-amber-200", accent: "bg-amber-500", text: "text-amber-900", label: "Needs Sig." };
    case "completed":
      return { bg: "bg-gray-50 border-gray-200", accent: "bg-gray-500", text: "text-gray-900", label: "Completed" };
    case "no_show":
      return { bg: "bg-rose-50 border-rose-200", accent: "bg-rose-500", text: "text-rose-900", label: "No Show" };
    case "cancelled":
      return { bg: "bg-gray-100 border-gray-300", accent: "bg-gray-400", text: "text-gray-600", label: "Cancelled" };
    default:
      return { bg: "bg-gray-50 border-gray-200", accent: "bg-gray-500", text: "text-gray-900", label: status };
  }
}

function computeSummary(appts: ScheduleAppointment[]) {
  return {
    total: appts.length,
    unsigned: appts.filter((a) => a.status === "needs_signature").length,
    pending: appts.filter((a) => a.alerts.some((al) => al.tone === "amber")).length,
    noShow: appts.filter((a) => a.status === "no_show").length,
    messages: 3,
  };
}

/* ─── Timeline constants ──────────────────────────────────────────────────── */

const START_HOUR = 8;
const END_HOUR = 18; // 6 PM (covers 4:38 PM end times)
const MINS_IN_DAY = (END_HOUR - START_HOUR) * 60;
const PIXELS_PER_MINUTE = 2.5;

/* ─── Main Component ─────────────────────────────────────────────────────── */

export default function ScheduleClient() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dateLabels, setDateLabels] = useState<{ label: string; short: string }>({ label: "", short: "" });
  const [appointments, setAppointments] = useState<ScheduleAppointment[]>(APPOINTMENTS);
  const [isNewApptOpen, setIsNewApptOpen] = useState(false);
  const [nowMinutes, setNowMinutes] = useState<number | null>(null);
  const organizationId = useMemo(() => getOrganizationId(), []);

  useEffect(() => {
    setDateLabels(computeDateLabels());
    const now = new Date();
    setNowMinutes(now.getHours() * 60 + now.getMinutes());
    const interval = setInterval(() => {
      const n = new Date();
      setNowMinutes(n.getHours() * 60 + n.getMinutes());
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

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

  const selectedAppt = useMemo(
    () => appointments.find((a) => a.id === selectedId) ?? null,
    [appointments, selectedId],
  );

  const handleAppointmentCreated = (created: ScheduleAppointment) => {
    setAppointments((prev) =>
      [...prev, created].sort((a, b) => parseTimeToMinutes(a.timeStart) - parseTimeToMinutes(b.timeStart)),
    );
    setSelectedId(created.id);
    setIsNewApptOpen(false);
  };

  const hours = Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => START_HOUR + i);
  const nowInRange =
    nowMinutes !== null && nowMinutes >= START_HOUR * 60 && nowMinutes <= END_HOUR * 60;
  const nowTop = nowInRange ? (nowMinutes! - START_HOUR * 60) * PIXELS_PER_MINUTE : 0;
  const nowLabel = nowInRange
    ? (() => {
        const h = Math.floor(nowMinutes! / 60);
        const m = nowMinutes! % 60;
        const period = h >= 12 ? "PM" : "AM";
        const h12 = h % 12 === 0 ? 12 : h % 12;
        return `${h12}:${String(m).padStart(2, "0")} ${period}`;
      })()
    : "";

  return (
    <div className="flex flex-col bg-slate-50 font-sans text-slate-900" style={{ height: "calc(100dvh - var(--nav-height, 44px))" }}>
      {/* Top Header */}
      <header className="bg-white border-b border-slate-200 z-20 shadow-sm shrink-0">
        <div className="px-6 py-3 flex items-center gap-4">
          <div className="bg-slate-100 p-2 rounded-lg text-slate-700">
            <CalendarIcon className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-slate-900 truncate">
              {dateLabels.label || "\u00A0"}
            </h1>
            <p className="text-xs text-slate-500 font-medium">Timeline View</p>
          </div>

          <div className="flex-1" />

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search patients, type, CPT…"
              className="w-72 pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-300"
            />
          </div>

          <div className="flex gap-5">
            <div className="flex flex-col items-end">
              <span className="text-xl font-bold leading-none text-slate-900">{summary.total}</span>
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mt-1">Total</span>
            </div>
            <div className="w-px h-8 bg-slate-200 self-center" />
            <div className="flex flex-col items-end">
              <span className="text-xl font-bold leading-none text-amber-600">{summary.unsigned}</span>
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mt-1">Unsigned</span>
            </div>
            <div className="w-px h-8 bg-slate-200 self-center" />
            <div className="flex flex-col items-end">
              <span className="text-xl font-bold leading-none text-rose-600">{summary.noShow}</span>
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mt-1">No Show</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsNewApptOpen(true)}
            className="bg-slate-900 text-white hover:bg-slate-800 rounded-full px-5 py-2 text-sm font-semibold transition-colors"
          >
            + New Appointment
          </button>
        </div>

        {/* Filter chips row */}
        <div className="px-6 pb-3 flex items-center gap-2">
          {(
            [
              { id: "all", label: "All" },
              { id: "scheduled", label: "Upcoming" },
              { id: "checked_in", label: "Active" },
              { id: "completed", label: "Done" },
              { id: "no_show", label: "No Show" },
            ] as { id: Filter; label: string }[]
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={cn(
                "px-3 py-1 text-xs font-semibold rounded-full border transition-colors",
                filter === f.id
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50",
              )}
            >
              {f.label}
            </button>
          ))}
          <div className="flex-1" />
          {filtered.length !== appointments.length ? (
            <span className="text-xs text-slate-500">
              Showing {filtered.length} of {appointments.length}
            </span>
          ) : null}
        </div>
      </header>

      {isNewApptOpen ? (
        <NewAppointmentModal
          organizationId={organizationId}
          onClose={() => setIsNewApptOpen(false)}
          onCreated={handleAppointmentCreated}
        />
      ) : null}

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Timeline */}
        <div className="flex-1 overflow-y-auto relative bg-white">
          {filtered.length === 0 ? (
            <div className="text-center text-slate-400 text-sm py-16">
              No appointments match the current filter.
            </div>
          ) : null}
          <div
            className="relative min-w-[600px] px-6"
            style={{ height: `${MINS_IN_DAY * PIXELS_PER_MINUTE + 100}px`, marginTop: 20 }}
          >
            {/* Time grid lines */}
            {hours.map((hour) => {
              const displayHour = hour > 12 ? hour - 12 : hour;
              const ampm = hour >= 12 ? "PM" : "AM";
              const top = (hour * 60 - START_HOUR * 60) * PIXELS_PER_MINUTE;
              return (
                <div key={hour} className="absolute left-0 right-6 flex items-start" style={{ top: `${top}px` }}>
                  <div className="w-20 pr-4 text-right -translate-y-2.5">
                    <span className="text-xs font-semibold text-slate-400">
                      {displayHour} {ampm}
                    </span>
                  </div>
                  <div className="flex-1 border-t border-slate-100" />
                </div>
              );
            })}

            {/* Now line */}
            {nowInRange ? (
              <div
                className="absolute left-20 right-6 flex items-center z-10 pointer-events-none"
                style={{ top: `${nowTop}px` }}
              >
                <div className="w-2 h-2 rounded-full bg-rose-500 -translate-x-1" />
                <div className="flex-1 border-t-2 border-rose-500 opacity-50" />
                <div className="bg-rose-500 text-white text-[10px] font-bold px-2 py-0.5 rounded ml-2 shadow-sm">
                  {nowLabel}
                </div>
              </div>
            ) : null}

            {/* Appointment cards */}
            <div className="absolute left-20 right-6 bottom-0" style={{ top: 0 }}>
              {filtered.map((appt) => {
                const startMin = parseTimeToMinutes(appt.timeStart);
                const top = (startMin - START_HOUR * 60) * PIXELS_PER_MINUTE;
                const height = Math.max(appt.durationMin * PIXELS_PER_MINUTE, 50);
                const isSelected = selectedId === appt.id;
                const statusConfig = getStatusConfig(appt.status);
                return (
                  <div
                    key={appt.id}
                    onClick={() => setSelectedId(isSelected ? null : appt.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedId(isSelected ? null : appt.id);
                      }
                    }}
                    className={cn(
                      "absolute left-4 right-4 rounded-xl border transition-all duration-200 cursor-pointer overflow-hidden group shadow-sm hover:shadow-md focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2",
                      statusConfig.bg,
                      isSelected ? "ring-2 ring-slate-400 ring-offset-2 z-10" : "z-0",
                    )}
                    style={{ top: `${top}px`, height: `${height}px` }}
                    aria-selected={isSelected}
                  >
                    <div className={cn("absolute left-0 top-0 bottom-0 w-1.5", statusConfig.accent)} />
                    <div className="p-3 pl-4 flex flex-col h-full relative">
                      <div className="flex justify-between items-start gap-2">
                        <div className="min-w-0">
                          <h3 className={cn("font-bold text-[15px] leading-tight mb-1 truncate", statusConfig.text)}>
                            {appt.patientName}
                          </h3>
                          <p className={cn("text-xs font-medium opacity-80 flex items-center gap-1 flex-wrap", statusConfig.text)}>
                            {appt.timeStart} – {appt.timeEnd}
                            <span className="opacity-50 mx-1">•</span>
                            {appt.type}
                            {appt.cpt ? (
                              <>
                                <span className="opacity-50 mx-1">•</span>
                                {appt.cpt}
                              </>
                            ) : null}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {appt.location === "Telehealth" ? (
                            <div className="bg-purple-100 text-purple-700 p-1.5 rounded-md" title="Telehealth">
                              <Video className="w-3.5 h-3.5" />
                            </div>
                          ) : (
                            <div className="bg-slate-100 text-slate-600 p-1.5 rounded-md" title="In Office">
                              <MapPin className="w-3.5 h-3.5" />
                            </div>
                          )}
                          <span
                            className={cn(
                              "text-[10px] font-semibold px-2 py-0.5 rounded-md border bg-white/60",
                              statusConfig.text,
                            )}
                          >
                            {statusConfig.label}
                          </span>
                        </div>
                      </div>

                      {height > 70 ? (
                        <div className="mt-auto flex items-end justify-between gap-2">
                          <div className="flex gap-2 flex-wrap">
                            {appt.alerts.length > 0 ? (
                              <div className="flex items-center gap-1 text-[11px] font-medium text-amber-800 bg-amber-100/70 px-2 py-1 rounded-md">
                                <AlertCircle className="w-3 h-3" />
                                {appt.alerts.length} {appt.alerts.length === 1 ? "Alert" : "Alerts"}
                              </div>
                            ) : null}
                          </div>
                          <span className={cn("text-[11px] font-medium opacity-60 truncate", statusConfig.text)}>
                            {appt.provider}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Context Side Panel */}
        {selectedAppt ? (
          <ContextPanel
            key={selectedAppt.id}
            appt={selectedAppt}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <aside className="hidden lg:flex w-[360px] border-l border-slate-200 bg-slate-50 flex-col items-center justify-center text-center px-8">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
              <User className="w-5 h-5" />
            </div>
            <p className="text-sm text-slate-500">
              Select an appointment to view patient details, alerts, and quick actions.
            </p>
          </aside>
        )}
      </div>
    </div>
  );
}

/* ─── Context Panel ───────────────────────────────────────────────────────── */

type EligibilityRunResult = {
  status: string;
  payerName: string | null;
  planName: string | null;
  coverageLevel: string | null;
  copayAmount: number | null;
  deductibleRemaining: number | null;
  effectiveDate: string | null;
  terminationDate: string | null;
  message?: string | null;
};

/**
 * Pre-check freshness snapshot. Read once when the panel opens (and after a
 * fresh run) so the front-desk sees missing-or-stale banners at check-in
 * BEFORE deciding whether to run a new 270/271. Stale = no check or
 * checked_at > 30 days.
 */
type EligibilityFreshness = {
  state: "missing" | "stale" | "fresh" | "loading";
  daysSince: number | null;
  lastStatus: string | null;
};

const STALE_DAYS = 30;

function ContextPanel({ appt, onClose }: { appt: ScheduleAppointment; onClose: () => void }) {
  const organizationId = useMemo(() => getOrganizationId(), []);
  const [eligibilityRunning, setEligibilityRunning] = useState(false);
  const [eligibilityError, setEligibilityError] = useState<string | null>(null);
  const [eligibilityResult, setEligibilityResult] = useState<EligibilityRunResult | null>(null);
  const [freshness, setFreshness] = useState<EligibilityFreshness>({
    state: "loading",
    daysSince: null,
    lastStatus: null,
  });

  // Reset and re-fetch freshness whenever the selected appointment changes.
  useEffect(() => {
    let cancelled = false;
    setEligibilityRunning(false);
    setEligibilityError(null);
    setEligibilityResult(null);
    setFreshness({ state: "loading", daysSince: null, lastStatus: null });

    (async () => {
      try {
        const url = `/api/patients/${encodeURIComponent(appt.clientId)}/eligibility?organizationId=${encodeURIComponent(organizationId)}`;
        const res = await fetch(url, { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        const latest = json?.latestEligibility ?? null;
        if (!latest || !latest.checkedAt) {
          setFreshness({ state: "missing", daysSince: null, lastStatus: null });
          return;
        }
        const t = new Date(latest.checkedAt).getTime();
        const days = Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86_400_000)) : null;
        if (days !== null && days > STALE_DAYS) {
          setFreshness({ state: "stale", daysSince: days, lastStatus: latest.status ?? null });
        } else {
          setFreshness({ state: "fresh", daysSince: days, lastStatus: latest.status ?? null });
        }
      } catch {
        if (!cancelled) setFreshness({ state: "missing", daysSince: null, lastStatus: null });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [appt.id, appt.clientId, organizationId]);

  const runEligibility = async () => {
    setEligibilityRunning(true);
    setEligibilityError(null);
    try {
      const res = await fetch("/api/clearinghouse/eligibility/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patientId: appt.clientId, appointmentId: appt.id }),
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
          coverageLevel: n.coverageLevel ?? null,
          copayAmount: n.copayAmount ?? null,
          deductibleRemaining: n.deductibleRemaining ?? null,
          effectiveDate: n.effectiveDate ?? null,
          terminationDate: n.terminationDate ?? null,
          message: n.message ?? null,
        });
        // A successful run resets the staleness banner to fresh immediately.
        setFreshness({ state: "fresh", daysSince: 0, lastStatus: String(n.status ?? "unknown") });
      }
    } catch (e) {
      setEligibilityError(e instanceof Error ? e.message : "Eligibility check failed.");
    } finally {
      setEligibilityRunning(false);
    }
  };

  const primaryCta = (() => {
    if (appt.status === "scheduled") {
      return { label: "Check In", className: "bg-emerald-600 hover:bg-emerald-700", href: null };
    }
    if (appt.status === "checked_in") {
      return {
        label: "Start Session",
        className: "bg-purple-600 hover:bg-purple-700",
        href: `/encounters/new?clientId=${appt.clientId}`,
      };
    }
    if (appt.status === "in_session") {
      return {
        label: "Continue Note",
        className: "bg-purple-600 hover:bg-purple-700",
        href: `/encounters/new?clientId=${appt.clientId}`,
      };
    }
    if (appt.status === "needs_signature") {
      return {
        label: "Sign Note",
        className: "bg-amber-600 hover:bg-amber-700",
        href: `/clients/${appt.clientId}/notes`,
      };
    }
    return {
      label: "Open Chart",
      className: "bg-slate-900 hover:bg-slate-800",
      href: `/clients/${appt.clientId}`,
    };
  })();

  const eligibilityToneClass =
    eligibilityResult?.status === "active"
      ? "bg-emerald-50 border-emerald-200 text-emerald-900"
      : eligibilityResult?.status === "inactive"
        ? "bg-rose-50 border-rose-200 text-rose-900"
        : "bg-amber-50 border-amber-200 text-amber-900";

  return (
    <aside className="w-[400px] border-l border-slate-200 bg-slate-50 flex flex-col shadow-[-4px_0_15px_-3px_rgba(0,0,0,0.05)] z-20 shrink-0">
      <div className="p-5 border-b border-slate-200 bg-white">
        <div className="flex justify-between items-start mb-4 gap-2">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-slate-900 truncate">{appt.patientName}</h2>
            <p className="text-xs text-slate-500 font-medium mt-1 truncate">
              {appt.dob ? `DOB: ${formatDob(appt.dob)}` : null}
              {appt.dob && appt.insurance ? " • " : ""}
              {appt.insurance || null}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close patient panel"
            className="text-slate-400 hover:text-slate-600 p-1 rounded-md hover:bg-slate-100 transition-colors shrink-0"
          >
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        <div className="flex gap-2">
          {primaryCta.href ? (
            <Link
              href={primaryCta.href}
              className={cn(
                "flex-1 text-center text-white font-semibold text-sm py-2 rounded-lg transition-colors",
                primaryCta.className,
              )}
            >
              {primaryCta.label}
            </Link>
          ) : (
            <button
              type="button"
              className={cn(
                "flex-1 text-white font-semibold text-sm py-2 rounded-lg transition-colors",
                primaryCta.className,
              )}
            >
              {primaryCta.label}
            </button>
          )}
          <button
            type="button"
            aria-label="More actions"
            className="shrink-0 w-9 h-9 inline-flex items-center justify-center border border-slate-200 rounded-lg bg-white hover:bg-slate-50"
          >
            <MoreVertical className="w-4 h-4 text-slate-600" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {/* Appointment details */}
        <section className="space-y-2">
          <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-slate-400" /> Appointment Details
          </h4>
          <div className="border border-slate-200 rounded-xl bg-white p-3 space-y-2">
            <Row label="Time" value={`${appt.timeStart} – ${appt.timeEnd}`} />
            <Row label="Type" value={appt.type} />
            <Row label="CPT" value={appt.cpt} />
            <Row label="Location" value={appt.location} />
            <Row label="Provider" value={appt.provider} />
            {appt.copay ? (
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-500">Copay</span>
                <span className="text-xs font-bold text-emerald-600">{appt.copay}</span>
              </div>
            ) : null}
          </div>
        </section>

        {/* Alerts */}
        {appt.alerts.length > 0 ? (
          <section className="space-y-2">
            <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5 text-slate-400" /> Active Alerts
            </h4>
            <div className="space-y-2">
              {appt.alerts.map((alert) => {
                const tone =
                  alert.tone === "red"
                    ? "bg-rose-50 border-rose-200 text-rose-900"
                    : alert.tone === "amber"
                      ? "bg-amber-50 border-amber-200 text-amber-900"
                      : alert.tone === "purple"
                        ? "bg-purple-50 border-purple-200 text-purple-900"
                        : "bg-blue-50 border-blue-200 text-blue-900";
                const icon =
                  alert.tone === "red"
                    ? "text-rose-500"
                    : alert.tone === "amber"
                      ? "text-amber-500"
                      : alert.tone === "purple"
                        ? "text-purple-500"
                        : "text-blue-500";
                return (
                  <div
                    key={alert.text}
                    className={cn("p-3 rounded-lg flex items-start gap-3 border", tone)}
                  >
                    <AlertCircle className={cn("w-4 h-4 mt-0.5 shrink-0", icon)} />
                    <span className="text-xs font-medium">{alert.text}</span>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* Tasks */}
        {appt.tasks.length > 0 ? (
          <section className="space-y-2">
            <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 text-slate-400" /> Tasks
            </h4>
            <div className="border border-slate-200 rounded-xl overflow-hidden bg-white divide-y divide-slate-100">
              {appt.tasks.map((task) => (
                <div
                  key={task.text}
                  className="p-3 flex items-start gap-3 hover:bg-slate-50 transition-colors"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                    aria-label={task.text}
                  />
                  <p className="text-xs font-medium text-slate-800 leading-snug flex-1">{task.text}</p>
                  <span
                    className="w-2 h-2 rounded-full shrink-0 mt-1.5"
                    style={{ background: task.color }}
                    aria-hidden="true"
                  />
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Real-time eligibility */}
        <section className="space-y-2">
          <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
            <Bell className="w-3.5 h-3.5 text-slate-400" /> Real-time Eligibility
          </h4>

          {/* Pre-check staleness banner: render BEFORE the run button so
              front-desk sees missing/stale state at check-in without having
              to click anything. */}
          {freshness.state === "missing" ? (
            <div className="p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
              <span>
                <span className="font-semibold">No eligibility on file.</span> Run a real-time check
                before this visit.
              </span>
            </div>
          ) : freshness.state === "stale" ? (
            <div className="p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
              <span>
                <span className="font-semibold">
                  Last check was {freshness.daysSince} day{freshness.daysSince === 1 ? "" : "s"} ago
                </span>{" "}
                (older than {STALE_DAYS} days). Re-check before billing.
              </span>
            </div>
          ) : freshness.state === "fresh" && !eligibilityResult ? (
            <div className="p-2 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-900 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-600" />
              <span>
                Eligibility checked {freshness.daysSince === 0 ? "today" : `${freshness.daysSince} day${freshness.daysSince === 1 ? "" : "s"} ago`}
                {freshness.lastStatus ? ` — ${freshness.lastStatus}` : ""}.
              </span>
            </div>
          ) : null}

          <button
            type="button"
            onClick={runEligibility}
            disabled={eligibilityRunning}
            className="w-full text-sm font-semibold py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-60 disabled:cursor-wait transition-colors"
          >
            {eligibilityRunning ? "Checking eligibility…" : "Check eligibility"}
          </button>
          {eligibilityError ? (
            <div className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-900 text-xs space-y-2">
              <div className="font-semibold">Check failed</div>
              <div>{eligibilityError}</div>
              <button
                type="button"
                onClick={runEligibility}
                disabled={eligibilityRunning}
                className="px-2 py-1 rounded border border-rose-300 bg-white text-rose-900 font-semibold hover:bg-rose-50 disabled:opacity-60"
              >
                Retry
              </button>
            </div>
          ) : null}
          {eligibilityResult ? (
            <div className={cn("p-3 rounded-lg border text-xs space-y-1", eligibilityToneClass)}>
              <div className="font-bold uppercase tracking-wider text-[11px]">{eligibilityResult.status}</div>
              {eligibilityResult.payerName ? <div>Payer: {eligibilityResult.payerName}</div> : null}
              {eligibilityResult.planName ? <div>Plan: {eligibilityResult.planName}</div> : null}
              {eligibilityResult.coverageLevel ? (
                <div>Coverage type: {eligibilityResult.coverageLevel}</div>
              ) : null}
              <div>Copay: {money(eligibilityResult.copayAmount)}</div>
              <div>Deductible remaining: {money(eligibilityResult.deductibleRemaining)}</div>
              {eligibilityResult.effectiveDate || eligibilityResult.terminationDate ? (
                <div>
                  Coverage: {eligibilityResult.effectiveDate ?? "—"} → {eligibilityResult.terminationDate ?? "—"}
                </div>
              ) : null}
              {eligibilityResult.message ? (
                <div className="italic mt-1">{eligibilityResult.message}</div>
              ) : null}
            </div>
          ) : null}
        </section>

        {/* Clinical context */}
        <section className="space-y-2">
          <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-slate-400" /> Clinical Context
          </h4>
          <div className="space-y-2">
            {appt.diagnoses.map((dx) => (
              <div
                key={dx}
                className="text-xs font-medium text-slate-700 bg-slate-100 px-3 py-2 rounded-lg border border-slate-200"
              >
                {dx}
              </div>
            ))}
            {appt.recentNote ? (
              <div className="bg-blue-50/50 border border-blue-100 rounded-xl p-3">
                <p className="text-[10px] font-bold text-blue-900 uppercase tracking-wider mb-1">Most Recent Note</p>
                <p className="text-xs text-blue-900/80 italic leading-relaxed">&ldquo;{appt.recentNote}&rdquo;</p>
              </div>
            ) : null}
          </div>
        </section>

        {/* Secondary actions */}
        <section className="pt-2 border-t border-slate-200 space-y-2">
          <Link
            href={`/clients/${appt.clientId}`}
            className="w-full inline-flex items-center justify-between px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-sm font-medium text-slate-800"
          >
            Open full chart
            <ChevronRight className="w-4 h-4 text-slate-400" />
          </Link>
          {appt.telehealthUrl &&
          (appt.status === "scheduled" || appt.status === "checked_in" || appt.status === "in_session") ? (
            <a
              href={appt.telehealthUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full inline-flex items-center justify-between px-3 py-2 rounded-lg border border-purple-200 bg-purple-50 hover:bg-purple-100 text-sm font-semibold text-purple-900"
            >
              <span className="inline-flex items-center gap-2">
                <Video className="w-4 h-4" /> Join Telehealth
              </span>
              <ChevronRight className="w-4 h-4 text-purple-400" />
            </a>
          ) : null}
          {appt.copay ? (
            <button
              type="button"
              className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-sm font-medium text-slate-800"
            >
              Collect copay {appt.copay}
            </button>
          ) : null}
        </section>
      </div>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center gap-3">
      <span className="text-xs text-slate-500 shrink-0">{label}</span>
      <span className="text-xs font-semibold text-slate-900 text-right truncate">{value}</span>
    </div>
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
