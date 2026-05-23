import { NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";

import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
import { ensureMeetingForAppointment, syncMeetingForAppointment } from "@/lib/telehealth/sessions";
function extractMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Appointment update failed";
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ appointmentId: string }> | { appointmentId: string } },
) {
  try {
    const resolvedParams = await Promise.resolve(params);
    const appointmentId = String(resolvedParams.appointmentId ?? "").trim();

    const supabase = createServerSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Service role key is required for appointment updates." },
        { status: 503 },
      );
    }

    const guard = await requireOrgAccess();
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const body = (await request.json()) as {
      scope?: "single" | "series";
      updates?: {
        appointment_status?: string;
        appointment_type?: string;
        service_location?: string;
        internal_note?: string | null;
        cpt_code?: string | null;
        memo?: string | null;
        case_id?: string | null;
        scheduled_start_at?: string;
        scheduled_end_at?: string;
      };
    };

    const scope = body.scope ?? "single";
    const updates = body.updates ?? {};
    const allowed: Record<string, unknown> = {};

    if (typeof updates.appointment_status === "string" && updates.appointment_status.trim()) {
      allowed.appointment_status = updates.appointment_status.trim();
    }
    // CPT and memo each have their own dedicated columns now, so we
    // write them independently of appointment_type. This keeps the
    // original appointment type (e.g. "therapy", "Initial
    // Consultation") intact when a CPT is saved.
    if ("cpt_code" in updates) {
      allowed.cpt_code = updates.cpt_code ?? null;
    }
    if (typeof updates.appointment_type === "string") {
      allowed.appointment_type = updates.appointment_type;
    }
    if ("memo" in updates) {
      allowed.memo = updates.memo ?? null;
    }
    if (typeof updates.service_location === "string") {
      allowed.service_location = updates.service_location;
    }
    if ("internal_note" in updates) {
      allowed.internal_note = updates.internal_note ?? null;
    }
    if ("case_id" in updates) {
      allowed.case_id = updates.case_id ?? null;
    }
    let scheduledTimeChanged = false;
    if (typeof updates.scheduled_start_at === "string" && updates.scheduled_start_at.trim()) {
      const startDate = new Date(updates.scheduled_start_at);
      if (Number.isNaN(startDate.getTime())) {
        return NextResponse.json({ success: false, error: "Invalid scheduled_start_at." }, { status: 400 });
      }
      allowed.scheduled_start_at = startDate.toISOString();
      scheduledTimeChanged = true;
    }
    if (typeof updates.scheduled_end_at === "string" && updates.scheduled_end_at.trim()) {
      const endDate = new Date(updates.scheduled_end_at);
      if (Number.isNaN(endDate.getTime())) {
        return NextResponse.json({ success: false, error: "Invalid scheduled_end_at." }, { status: 400 });
      }
      allowed.scheduled_end_at = endDate.toISOString();
      scheduledTimeChanged = true;
    }

    if (Object.keys(allowed).length === 0) {
      return NextResponse.json({ success: false, error: "No updates supplied." }, { status: 400 });
    }

    const now = new Date().toISOString();
    allowed.updated_at = now;

    // Anchor select is scope-dependent because the live schema may not
    // have a `series_id` column; only request it when caller needs it.
    const anchorQuery =
      scope === "series"
        ? supabase
            .from("appointments")
            .select("id, series_id, scheduled_start_at")
        : supabase
            .from("appointments")
            .select("id, scheduled_start_at");
    const { data: anchorAppointment, error: anchorError } = await anchorQuery
      .eq("id", appointmentId)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .maybeSingle();

    if (anchorError) throw anchorError;
    if (!anchorAppointment) {
      return NextResponse.json({ success: false, error: "Appointment not found." }, { status: 404 });
    }

    if (scope === "single") {
      const { error: updateError } = await supabase
        .from("appointments")
        .update(allowed)
        .eq("id", appointmentId)
        .eq("organization_id", organizationId)
        .is("archived_at", null);

      if (updateError) throw updateError;

      let meetingSyncWarning: string | null = null;
      let refreshedJoinUrl: string | null = null;
      let refreshedStartAt: string | null = null;
      if (scheduledTimeChanged) {
        try {
          const { data: fresh } = await supabase
            .from("appointments")
            .select(
              "id, organization_id, provider_id, scheduled_start_at, scheduled_end_at, appointment_type, telehealth_url, service_location",
            )
            .eq("id", appointmentId)
            .maybeSingle();
          if (fresh && (fresh as any).service_location === "telehealth") {
            const appt = {
              id: (fresh as any).id,
              organizationId: (fresh as any).organization_id,
              providerId: (fresh as any).provider_id ?? null,
              scheduledStartAt: (fresh as any).scheduled_start_at,
              scheduledEndAt: (fresh as any).scheduled_end_at ?? null,
              appointmentType: (fresh as any).appointment_type ?? null,
              telehealthUrl: (fresh as any).telehealth_url ?? null,
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sb = supabase as any;
            const outcome = await syncMeetingForAppointment(sb, appt, {
              fallbackOwnerUserId: guard.userId ?? null,
            });
            const applyJoinUrl = async (joinUrl: string) => {
              await supabase
                .from("appointments")
                .update({ telehealth_url: joinUrl, updated_at: new Date().toISOString() })
                .eq("id", appointmentId)
                .eq("organization_id", organizationId);
              refreshedJoinUrl = joinUrl;
            };
            refreshedStartAt = appt.scheduledStartAt;
            // Fallback to the appointment's current telehealth_url so
            // that even when meeting sync skips/falls back, the reminder
            // payload below still gets refreshed to the latest URL on
            // the appointment row.
            refreshedJoinUrl = appt.telehealthUrl ?? null;
            if (outcome.status === "updated" || outcome.status === "recreated") {
              await applyJoinUrl(outcome.joinUrl);
            } else if (outcome.status === "no_session") {
              // No prior telehealth session — likely a legacy appointment or
              // one whose initial create fell back. Best-effort: try to
              // create one now so reminders for the new time carry a real
              // link.
              const ensure = await ensureMeetingForAppointment(sb, appt, {
                fallbackOwnerUserId: guard.userId ?? null,
              });
              if (ensure.status === "created" || ensure.status === "existing") {
                await applyJoinUrl(ensure.joinUrl);
              } else if (ensure.status === "fallback" || ensure.status === "skipped") {
                meetingSyncWarning = ensure.warning;
              } else if (
                ensure.status === "credential_error" ||
                ensure.status === "adapter_error"
              ) {
                meetingSyncWarning = `Could not auto-create ${ensure.platform} meeting: ${ensure.error}.`;
                console.warn("[appointments/PATCH] ensureMeeting failed", ensure);
              }
            } else if (outcome.status === "fallback" || outcome.status === "skipped") {
              meetingSyncWarning = outcome.warning;
            } else if (outcome.status === "credential_error" || outcome.status === "adapter_error") {
              meetingSyncWarning = `Could not sync ${outcome.platform} meeting: ${outcome.error}.`;
              console.warn("[appointments/PATCH] meeting sync failed", outcome);
            }
          }
        } catch (e) {
          meetingSyncWarning = e instanceof Error ? e.message : "Meeting sync failed";
          console.warn("[appointments/PATCH] syncMeetingForAppointment threw", e);
        }
      }

      // If the appointment was rescheduled, refresh any pending reminder
      // rows so they (a) fire relative to the new start time and (b)
      // carry the refreshed join URL. Reminders that have already been
      // sent are left alone.
      if (scheduledTimeChanged && refreshedStartAt) {
        try {
          const { data: pendingReminders } = await supabase
            .from("appointment_reminders")
            .select("id, payload")
            .eq("appointment_id", appointmentId)
            .eq("organization_id", organizationId)
            .eq("reminder_status", "scheduled");
          for (const row of (pendingReminders ?? []) as Array<{
            id: string;
            payload: Record<string, unknown> | null;
          }>) {
            const payload = (row.payload ?? {}) as Record<string, unknown>;
            const leadHours = Math.max(1, Number(payload.leadHours ?? 24));
            const newScheduledFor = new Date(refreshedStartAt);
            newScheduledFor.setHours(newScheduledFor.getHours() - leadHours);
            const nextPayload = {
              ...payload,
              ...(refreshedJoinUrl !== null ? { telehealthUrl: refreshedJoinUrl } : {}),
            };
            await supabase
              .from("appointment_reminders")
              .update({
                scheduled_for: newScheduledFor.toISOString(),
                payload: nextPayload,
                updated_at: new Date().toISOString(),
              })
              .eq("id", row.id)
              .eq("organization_id", organizationId);
          }
        } catch (e) {
          // Best-effort: reminder refresh failures should not fail the
          // appointment update itself. Surface as a warning instead.
          const msg = e instanceof Error ? e.message : "Reminder refresh failed";
          meetingSyncWarning = meetingSyncWarning
            ? `${meetingSyncWarning} ${msg}`
            : msg;
          console.warn("[appointments/PATCH] reminder refresh failed", e);
        }
      }

      return NextResponse.json({
        success: true,
        scope: "single",
        updatedCount: 1,
        ...(meetingSyncWarning ? { meetingSyncWarning } : {}),
      });
    }

    const anchorSeriesId = (anchorAppointment as { series_id?: string | null })
      .series_id;
    if (!anchorSeriesId) {
      return NextResponse.json(
        { success: false, error: "This appointment does not belong to a recurrence series." },
        { status: 409 },
      );
    }

    const { data: seriesAppointments, error: seriesError } = await supabase
      .from("appointments")
      .select("id")
      .eq("series_id", anchorSeriesId)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .gte(
        "scheduled_start_at",
        (anchorAppointment as { scheduled_start_at: string }).scheduled_start_at,
      )
      .order("scheduled_start_at", { ascending: true });

    if (seriesError) throw seriesError;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = (seriesAppointments ?? []).map((row: any) => row.id).filter(Boolean);
    if (ids.length === 0) {
      return NextResponse.json({ success: false, error: "No series appointments found." }, { status: 404 });
    }

    const { error: updateSeriesError } = await supabase
      .from("appointments")
      .update(allowed)
      .in("id", ids)
      .eq("organization_id", organizationId)
      .is("archived_at", null);

    if (updateSeriesError) throw updateSeriesError;

    return NextResponse.json({ success: true, scope: "series", updatedCount: ids.length });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: extractMessage(error),
      },
      { status: 500 },
    );
  }
}
