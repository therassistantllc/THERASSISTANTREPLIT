import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
/**
 * GET /api/mailroom/search?organizationId=&type=client|claim|encounter&q=
 *
 * Lightweight typeahead search powering the mailroom filing destination picker.
 * Returns a small, display-ready list of entities scoped to the org so users
 * can resolve the correct UUID without pasting it by hand.
 *
 * The supabase-touching logic lives in `lib/mailroom/search` so it can be
 * unit-tested with a fake client (see lib/mailroom/__tests__/search.test.ts).
 */

import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  isMailroomSearchType,
  searchMailroomEntities,
  type MailroomSearchType,
} from "@/lib/mailroom/search";

const MAX_LIMIT = 20;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const rawType = text(searchParams.get("type")).toLowerCase();
    const q = text(searchParams.get("q"));
    const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 10), 1), MAX_LIMIT);

    if (!isMailroomSearchType(rawType)) {
      return NextResponse.json(
        { success: false, error: "type must be client, claim, or encounter" },
        { status: 400 },
      );
    }
    const type: MailroomSearchType = rawType;

    const guard = await requireOrgAccess({
      requestedOrganizationId: text(searchParams.get("organizationId")),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }

    const results = await searchMailroomEntities(supabase, organizationId, type, q, limit);
    return NextResponse.json({ success: true, type, results });
  } catch (error) {
    console.error("Mailroom search API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Search failed" },
      { status: 500 },
    );
  }
}
