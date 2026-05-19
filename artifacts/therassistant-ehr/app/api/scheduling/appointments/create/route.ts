import crypto from "crypto";
import { NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { addMonthsKeepingClock, checkProviderAvailability, resolveOrganizationId } from "@/lib/scheduling/core";

type RecurrenceFrequency = "none" | "weekly" | "biweekly" | "monthly";
type RecurrenceEndMode = "by_date" | "by_count";

function generateUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function formatError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Appointment creation failed";
}

function telehealthUrlFor(token: string) {
  const base = String(process.env.TELEHEALTH_BASE_URL ?? "https://meet.therassistant.app/session").trim();
  return `${base.replace(/\/$/, "")}/${token}`;
}

function buildOccurrenceStarts(
  firstStart: Date,
  frequency: RecurrenceFrequency,
  endMode: RecurrenceEndMode,
  endDate: string | null,
  sessionCount: number | null,
) {
  if (frequency === "none") return [firstStart];

  const starts: Date[] = [];
  const hardLimit = 260;
  const normalizedCount = Number.isFinite(sessionCount ?? NaN) ? Math.max(1, Number(sessionCount)) : null;
  const until = endDate ? new Date(endDate) : null;
  if (until && !Number.isNaN(until.getTime())) {
    until.setHours(23, 59, 59, 999);
  }

  for (let index = 0; index < hardLimit; index += 1) {
    let nextStart: Date;
    if (index === 0) {
      nextStart = new Date(firstStart);
    } else if (frequency === "weekly") {
      nextStart = new Date(firstStart);
      nextStart.setDate(firstStart.getDate() + index * 7);
    } else if (frequency === "biweekly") {
      nextStart = new Date(firstStart);
      nextStart.setDate(firstStart.getDate() + index * 14);
    } else {
      nextStart = addMonthsKeepingClock(firstStart, index);
    }

    if (until && nextStart > until) break;
    starts.push(nextStart);
    if (endMode === "by_count" && normalizedCount && starts.length >= normalizedCount) break;
  }

  return starts;
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Service role key is required for appointment writes." },
        { status: 503 },
      );
    }

    const body = (await request.json()) as {
      organizationId?: string;
      clientId?: string;
      providerId?: string;
      insurancePolicyId?: string | null;
      scheduledStartAt?: string;
      durationMinutes?: number;
      appointmentType?: string;
      reason?: string;
      serviceLocation?: "office" | "telehealth";
      internalNote?: string;
      reminderEmailEnabled?: boolean;
      reminderSmsEnabled?: boolean;
      reminderPortalEnabled?: boolean;
      reminderLeadHours?: number;
      recurrence?: {
        frequency?: RecurrenceFrequency;
        endMode?: RecurrenceEndMode;
        endDate?: string | null;
        sessionCount?: number | null;
      };
    };

    const organizationId = await resolveOrganizationId(supabase, body.organizationId);
    if (!organizationId) {
      return NextResponse.json({ success: false, error: "Create an organization before scheduling." }, { status: 400 });
    }

    const clientId = String(body.clientId ?? "").trim();
    const providerId = String(body.providerId ?? "").trim();
    const scheduledStartAt = String(body.scheduledStartAt ?? "").trim();
    const durationMinutes = Math.max(15, Number(body.durationMinutes ?? 60));
    const appointmentType = String(body.appointmentType ?? "").trim();
    const reason = String(body.reason ?? "").trim();
    const serviceLocation = body.serviceLocation ?? (appointmentType.toLowerCase().includes("tele") ? "telehealth" : "office");

    if (!clientId || !providerId || !scheduledStartAt || !appointmentType || !reason) {
      return NextResponse.json(
        { success: false, error: "Client, provider, start time, classification, and reason are required." },
        { status: 400 },
      );
    }

    const firstStart = new Date(scheduledStartAt);
    if (Number.isNaN(firstStart.getTime())) {
      return NextResponse.json({ success: false, error: "Invalid start time." }, { status: 400 });
    }

    if (firstStart.getMinutes() % 15 !== 0) {
      return NextResponse.json({ success: false, error: "Appointments must start on 15-minute intervals." }, { status: 400 });
    }

    const recurrenceFrequency: RecurrenceFrequency = body.recurrence?.frequency ?? "none";
    const recurrenceEndMode: RecurrenceEndMode = body.recurrence?.endMode ?? "by_count";
    const recurrenceEndDate = body.recurrence?.endDate ?? null;
    const recurrenceSessionCount = body.recurrence?.sessionCount ?? (recurrenceFrequency === "none" ? 1 : 12);

    const starts = buildOccurrenceStarts(
      firstStart,
      recurrenceFrequency,
      recurrenceEndMode,
      recurrenceEndDate,
      recurrenceSessionCount,
    );

    const seriesId = recurrenceFrequency === "none" ? null : generateUuid();
    const now = new Date().toISOString();

    if (seriesId) {
      const { error: seriesError } = await supabase.from("appointment_series").insert({
        id: seriesId,
        organization_id: organizationId,
        provider_id: providerId,
        client_id: clientId,
        recurrence_frequency: recurrenceFrequency,
        recurrence_interval: recurrenceFrequency === "biweekly" ? 2 : 1,
        ends_on: recurrenceEndDate,
        session_count: recurrenceSessionCount,
        created_at: now,
        updated_at: now,
      });
      if (seriesError && !String(seriesError.message).includes("appointment_series")) throw seriesError;
    }

    const reminderLeadHours = Math.max(1, Number(body.reminderLeadHours ?? 24));
    const reminderEmailEnabled = Boolean(body.reminderEmailEnabled);
    const reminderSmsEnabled = Boolean(body.reminderSmsEnabled);
    const reminderPortalEnabled = body.reminderPortalEnabled !== false;

    const createdRows: Array<{ id: string; scheduled_start_at: string }> = [];

    for (let index = 0; index < starts.length; index += 1) {
      const startAt = starts[index];
      const endAt = new Date(startAt);
      endAt.setMinutes(endAt.getMinutes() + durationMinutes);

      const availability = await checkProviderAvailability({
        supabase,
        organizationId,
        providerId,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        location: serviceLocation,
      });

      if (!availability.available) {
        return NextResponse.json(
          {
            success: false,
            error: `Availability check failed for occurrence ${index + 1}.`,
            reasonCodes: availability.reasonCodes,
            reasons: availability.reasons,
          },
          { status: 409 },
        );
      }

      const teleToken = serviceLocation === "telehealth" ? generateUuid() : null;
      const teleUrl = teleToken ? telehealthUrlFor(teleToken) : null;

      const appointmentId = generateUuid();
      const appointmentPayload = {
        id: appointmentId,
        organization_id: organizationId,
        client_id: clientId,
        provider_id: providerId,
        insurance_policy_id: body.insurancePolicyId ?? null,
        scheduled_start_at: startAt.toISOString(),
        scheduled_end_at: endAt.toISOString(),
        appointment_status: "scheduled",
        appointment_type: appointmentType,
        reason,
        service_location: serviceLocation,
        internal_note: body.internalNote ?? null,
        reminder_email_enabled: reminderEmailEnabled,
        reminder_sms_enabled: reminderSmsEnabled,
        reminder_portal_enabled: reminderPortalEnabled,
        reminder_lead_hours: reminderLeadHours,
        telehealth_session_token: teleToken,
        telehealth_url: teleUrl,
        series_id: seriesId,
        recurrence_index: index + 1,
        recurrence_frequency: recurrenceFrequency === "none" ? null : recurrenceFrequency,
        created_at: now,
        updated_at: now,
      };

      const { error: appointmentError } = await supabase.from("appointments").insert(appointmentPayload);
      if (appointmentError) throw appointmentError;

      createdRows.push({ id: appointmentId, scheduled_start_at: startAt.toISOString() });

      const reminderChannels = [
        reminderEmailEnabled ? "email" : null,
        reminderSmsEnabled ? "sms" : null,
        reminderPortalEnabled ? "portal" : null,
      ].filter(Boolean) as string[];

      if (reminderChannels.length > 0) {
        const scheduledFor = new Date(startAt);
        scheduledFor.setHours(scheduledFor.getHours() - reminderLeadHours);

        const reminderRows = reminderChannels.map((channel) => ({
          id: generateUuid(),
          organization_id: organizationId,
          appointment_id: appointmentId,
          channel,
          scheduled_for: scheduledFor.toISOString(),
          reminder_status: "scheduled",
          payload: {
            appointmentType,
            serviceLocation,
            reason,
            leadHours: reminderLeadHours,
          },
          created_at: now,
          updated_at: now,
        }));

        const { error: reminderError } = await supabase.from("appointment_reminders").insert(reminderRows);
        if (reminderError && !String(reminderError.message).includes("appointment_reminders")) throw reminderError;
      }
    }

    return NextResponse.json({
      success: true,
      seriesId,
      occurrencesCreated: createdRows.length,
      appointments: createdRows,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: formatError(error),
      },
      { status: 500 },
    );
  }
}
