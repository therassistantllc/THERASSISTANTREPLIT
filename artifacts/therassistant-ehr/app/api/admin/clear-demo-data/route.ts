import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { requireRoleInRoute } from "@/lib/rbac/middleware";
import { STAFF_ROLES } from "@/lib/rbac/constants";
import { ORGANIZATION_ID as DEMO_ORG_ID } from "@/lib/config";

export async function POST(request: NextRequest) {
  const authOrError = await requireRoleInRoute(STAFF_ROLES.ADMIN);
  if (authOrError instanceof NextResponse) return authOrError;

  const { organizationId } = authOrError;

  // Tenant-isolation guard: only the demo org may be wiped through this
  // endpoint. We still derive the actual delete scope from the authenticated
  // session (`organizationId`), never from a caller-supplied value or a
  // hardcoded constant in the SQL.
  if (organizationId !== DEMO_ORG_ID) {
    return NextResponse.json(
      { success: false, error: "This endpoint is only available for the demo organization." },
      { status: 403 },
    );
  }

  let body: { confirm?: string } = {};
  try {
    body = await request.json();
  } catch {
    // ignore
  }
  if (body.confirm !== "DELETE") {
    return NextResponse.json(
      {
        success: false,
        error: "Confirmation token missing. POST { confirm: 'DELETE' } to proceed.",
      },
      { status: 400 },
    );
  }

  const supabase = createServerSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json(
      {
        success: false,
        error:
          "SUPABASE_SERVICE_ROLE_KEY is required. Add it to Replit Secrets and restart the dev server.",
      },
      { status: 503 },
    );
  }

  // Atomic wipe — the SQL function runs every delete inside a single
  // transaction, so any error rolls the whole thing back (no partial state).
  // It returns a JSONB map of {table: rows_deleted} including zeros.
  const { data, error } = await supabase.rpc("clear_org_demo_data", {
    p_organization_id: organizationId,
  });

  if (error) {
    return NextResponse.json(
      {
        success: false,
        error: `Wipe failed and was rolled back: ${error.message}`,
      },
      { status: 500 },
    );
  }

  const counts: Record<string, number> = {};
  if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      counts[k] = typeof v === "number" ? v : Number(v) || 0;
    }
  }
  const totalDeleted = Object.values(counts).reduce((a, b) => a + b, 0);

  return NextResponse.json({
    success: true,
    cleared_at: new Date().toISOString(),
    organization_id: organizationId,
    total_deleted: totalDeleted,
    counts,
  });
}
