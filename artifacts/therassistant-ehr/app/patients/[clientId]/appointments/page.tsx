"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CreateAppointmentModal } from "@/app/calendar/MonthCalendarClient";

type Appointment = {
  id: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  status: string | null;
  type: string | null;
  memo: string | null;
  checkedInAt: string | null;
  cancelledAt: string | null;
  providerId: string | null;
  createdAt: string | null;
  encounter: { id: string; status: string | null; serviceDate: string | null } | null;
};

function formatDate(v: string | null | undefined) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusClass(v: string | null | undefined) {
  const s = String(v ?? "").toLowerCase();
  if (s.includes("complet") || s.includes("checked_in") || s.includes("check_in")) return "status status-green";
  if (s.includes("cancel") || s.includes("no_show") || s.includes("noshow")) return "status status-red";
  if (s.includes("schedul") || s.includes("confirm") || s.includes("scheduled")) return "status status-yellow";
  return "status";
}

export default function VisitsAppointmentsPage() {
  const params = useParams<{ clientId: string }>();
  const clientId = params?.clientId ?? "";
  const searchParams = useSearchParams();
  const orgId = searchParams.get("organizationId") ?? process.env.NEXT_PUBLIC_ORGANIZATION_ID ?? "";

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [schedulerOpen, setSchedulerOpen] = useState(false);

  const load = useCallback(async () => {
    if (!clientId || !orgId) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/patients/${clientId}/appointments?organizationId=${encodeURIComponent(orgId)}`, { cache: "no-store" });
      const json = (await r.json()) as { success: boolean; appointments?: Appointment[]; error?: string };
      if (!json.success) throw new Error(json.error ?? "Failed");
      setAppointments(json.appointments ?? []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [clientId, orgId]);

  useEffect(() => { void load(); }, [load]);

  const orgQ = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : "";

  return (
    <main className="app-shell">
      <section className="page-header">
        <div>
          <p className="eyebrow">Client Chart</p>
          <h2>Visits &amp; Appointments</h2>
        </div>
        <div className="hero-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() => setSchedulerOpen(true)}
            disabled={!orgId || !clientId}
          >
            Schedule Appointment
          </button>
        </div>
      </section>

      {loading && <div className="empty-state">Loading appointments…</div>}
      {error && <div className="alert-panel">{error}</div>}

      {!loading && appointments.length === 0 && !error && (
        <div className="empty-state">No appointments found for this client.</div>
      )}

      {appointments.length > 0 && (
        <section className="panel">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date / Time</th>
                <th>Type</th>
                <th>Memo</th>
                <th>Status</th>
                <th>Check-in</th>
                <th>Encounter</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {appointments.map((appt) => (
                <tr key={appt.id}>
                  <td>{formatDate(appt.scheduledStart)}</td>
                  <td>{appt.type ?? "—"}</td>
                  <td>
                    {appt.memo ? (
                      <span
                        title={appt.memo}
                        style={{
                          display: "inline-block",
                          maxWidth: "260px",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          verticalAlign: "bottom",
                        }}
                      >
                        {appt.memo}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td><span className={statusClass(appt.status)}>{appt.status ?? "—"}</span></td>
                  <td>{appt.checkedInAt ? formatDate(appt.checkedInAt) : "—"}</td>
                  <td>
                    {appt.encounter
                      ? <Link className="inline-link" href={`/encounters/${appt.encounter.id}${orgQ}`}>{appt.encounter.status ?? "open"}</Link>
                      : <span className="muted">No encounter</span>}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      {appt.encounter && (
                        <Link className="button button-secondary" href={`/encounters/${appt.encounter.id}${orgQ}`}>
                          Open Note
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {schedulerOpen && orgId && clientId ? (
        <CreateAppointmentModal
          organizationId={orgId}
          lockedClientId={clientId}
          onClose={() => setSchedulerOpen(false)}
          onCreated={async () => {
            setSchedulerOpen(false);
            await load();
          }}
        />
      ) : null}
    </main>
  );
}
