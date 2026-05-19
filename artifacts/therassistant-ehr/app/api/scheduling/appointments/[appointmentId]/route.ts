import { NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";

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

    const body = (await request.json()) as {
      scope?: "single" | "series";
      updates?: {
        appointment_status?: string;
        reason?: string;
        appointment_type?: string;
        service_location?: string;
        internal_note?: string | null;
      };
    };

    const scope = body.scope ?? "single";
    const updates = body.updates ?? {};
    const allowed: Record<string, unknown> = {};

    if (typeof updates.appointment_status === "string" && updates.appointment_status.trim()) {
      allowed.appointment_status = updates.appointment_status.trim();
    }
    if (typeof updates.reason === "string") allowed.reason = updates.reason;
    if (typeof updates.appointment_type === "string") allowed.appointment_type = updates.appointment_type;
    if (typeof updates.service_location === "string") allowed.service_location = updates.service_location;
    if ("internal_note" in updates) allowed.internal_note = updates.internal_note ?? null;

    if (Object.keys(allowed).length === 0) {
      return NextResponse.json({ success: false, error: "No updates supplied." }, { status: 400 });
    }

    const now = new Date().toISOString();
    allowed.updated_at = now;

    const { data: anchorAppointment, error: anchorError } = await supabase
      .from("appointments")
      .select("id, series_id, scheduled_start_at")
      .eq("id", appointmentId)
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
        .is("archived_at", null);

      if (updateError) throw updateError;

      return NextResponse.json({ success: true, scope: "single", updatedCount: 1 });
    }

    if (!anchorAppointment.series_id) {
      return NextResponse.json(
        { success: false, error: "This appointment does not belong to a recurrence series." },
        { status: 409 },
      );
    }

    const { data: seriesAppointments, error: seriesError } = await supabase
      .from("appointments")
      .select("id")
      .eq("series_id", anchorAppointment.series_id)
      .is("archived_at", null)
      .gte("scheduled_start_at", anchorAppointment.scheduled_start_at)
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
