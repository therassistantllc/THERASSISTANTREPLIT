import { NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { DEFAULT_ORG_ID } from "@/lib/config";
import { requireAuthenticatedStaff } from "@/lib/rbac/auth";

function extractMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Appointment update failed";
}

/**
 * Resolve the org allowed to mutate appointments. Production requires an
 * authenticated staff session and uses their org. Dev (no auth session)
 * falls back to DEFAULT_ORG_ID only — never an arbitrary caller-supplied
 * org. The returned org is then enforced on every appointments query
 * below so a caller cannot mutate a row in another tenant.
 */
async function resolveOrgForMutation(): Promise<
  | { ok: true; organizationId: string }
  | { ok: false; status: number; error: string }
> {
  const staff = await requireAuthenticatedStaff();
  if (staff) return { ok: true, organizationId: staff.organizationId };
  if (process.env.NODE_ENV === "production") {
    return { ok: false, status: 401, error: "Authentication required" };
  }
  return { ok: true, organizationId: DEFAULT_ORG_ID };
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

    const orgResolution = await resolveOrgForMutation();
    if (!orgResolution.ok) {
      return NextResponse.json(
        { success: false, error: orgResolution.error },
        { status: orgResolution.status },
      );
    }
    const organizationId = orgResolution.organizationId;

    const body = (await request.json()) as {
      scope?: "single" | "series";
      updates?: {
        appointment_status?: string;
        reason?: string;
        appointment_type?: string;
        service_location?: string;
        internal_note?: string | null;
        cpt_code?: string | null;
        memo?: string | null;
      };
    };

    const scope = body.scope ?? "single";
    const updates = body.updates ?? {};
    const allowed: Record<string, unknown> = {};

    if (typeof updates.appointment_status === "string" && updates.appointment_status.trim()) {
      allowed.appointment_status = updates.appointment_status.trim();
    }
    // CPT lives in `appointment_type`; memo lives in `reason`. Explicit
    // cpt_code / memo updates take precedence over raw reason / appointment_type.
    if ("cpt_code" in updates) {
      allowed.appointment_type = updates.cpt_code ?? null;
    } else if (typeof updates.appointment_type === "string") {
      allowed.appointment_type = updates.appointment_type;
    }
    if ("memo" in updates) {
      allowed.reason = updates.memo ?? null;
    } else if (typeof updates.reason === "string") {
      allowed.reason = updates.reason;
    }
    if (typeof updates.service_location === "string") {
      allowed.service_location = updates.service_location;
    }
    if ("internal_note" in updates) {
      allowed.internal_note = updates.internal_note ?? null;
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

      return NextResponse.json({ success: true, scope: "single", updatedCount: 1 });
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
