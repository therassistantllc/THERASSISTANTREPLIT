import { NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { checkProviderAvailability, resolveOrganizationId } from "@/lib/scheduling/core";

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Service role key is required for availability checks." },
        { status: 503 },
      );
    }

    const body = (await request.json()) as {
      organizationId?: string;
      providerId?: string;
      startAt?: string;
      endAt?: string;
      location?: "office" | "telehealth" | "any";
    };

    const organizationId = await resolveOrganizationId(supabase, body.organizationId);
    if (!organizationId) {
      return NextResponse.json({ success: false, error: "No organization found." }, { status: 400 });
    }

    const providerId = String(body.providerId ?? "").trim();
    const startAt = String(body.startAt ?? "").trim();
    const endAt = String(body.endAt ?? "").trim();
    const location = body.location ?? "any";

    const result = await checkProviderAvailability({
      supabase,
      organizationId,
      providerId,
      startAt,
      endAt,
      location,
    });

    return NextResponse.json({ success: true, organizationId, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Availability check failed",
      },
      { status: 500 },
    );
  }
}
