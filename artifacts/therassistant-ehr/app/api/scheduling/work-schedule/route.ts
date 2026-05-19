import crypto from "crypto";
import { NextResponse } from "next/server";
import { createServerSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { resolveOrganizationId } from "@/lib/scheduling/core";

function generateUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function message(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Work schedule request failed";
}

function isMissingRelationError(value: unknown) {
  const text = String(value ?? "").toLowerCase();
  return text.includes("does not exist") || text.includes("schema cache") || text.includes("provider_availability_rules") || text.includes("provider_schedule_blocks");
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Service role key is required." }, { status: 503 });
    }

    const url = new URL(request.url);
    const organizationId = await resolveOrganizationId(supabase, url.searchParams.get("organizationId"));
    if (!organizationId) {
      return NextResponse.json({ success: false, error: "No organization found." }, { status: 400 });
    }

    const providerId = String(url.searchParams.get("providerId") ?? "").trim();
    const start = String(url.searchParams.get("start") ?? "").trim();
    const end = String(url.searchParams.get("end") ?? "").trim();

    const rulesQuery = supabase
      .from("provider_availability_rules")
      .select("*")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("day_of_week", { ascending: true })
      .order("start_time", { ascending: true });

    const blocksQuery = supabase
      .from("provider_schedule_blocks")
      .select("*")
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("starts_at", { ascending: true });

    if (providerId) {
      rulesQuery.eq("provider_id", providerId);
      blocksQuery.eq("provider_id", providerId);
    }

    if (start) {
      blocksQuery.gte("ends_at", start);
    }

    if (end) {
      blocksQuery.lte("starts_at", end);
    }

    const [rulesResp, blocksResp] = await Promise.all([rulesQuery, blocksQuery]);

    if (rulesResp.error && isMissingRelationError(rulesResp.error.message)) {
      return NextResponse.json({ success: true, organizationId, rules: [], blocks: [] });
    }

    if (blocksResp.error && isMissingRelationError(blocksResp.error.message)) {
      return NextResponse.json({ success: true, organizationId, rules: rulesResp.data ?? [], blocks: [] });
    }

    if (rulesResp.error) throw rulesResp.error;
    if (blocksResp.error) throw blocksResp.error;

    return NextResponse.json({
      success: true,
      organizationId,
      rules: rulesResp.data ?? [],
      blocks: blocksResp.data ?? [],
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Service role key is required." }, { status: 503 });
    }

    const body = (await request.json()) as {
      organizationId?: string;
      kind?: "availability_rule" | "administrative_block";
      providerId?: string;
      dayOfWeek?: number;
      startTime?: string;
      endTime?: string;
      locationType?: "office" | "telehealth" | "any";
      blockType?: "meeting" | "administrative" | "break" | "meal" | "leave";
      title?: string;
      description?: string;
      startsAt?: string;
      endsAt?: string;
    };

    const organizationId = await resolveOrganizationId(supabase, body.organizationId);
    if (!organizationId) {
      return NextResponse.json({ success: false, error: "No organization found." }, { status: 400 });
    }

    const now = new Date().toISOString();

    if (body.kind === "availability_rule") {
      const payload = {
        id: generateUuid(),
        organization_id: organizationId,
        provider_id: String(body.providerId ?? "").trim(),
        day_of_week: Number(body.dayOfWeek ?? 0),
        start_time: String(body.startTime ?? "").trim(),
        end_time: String(body.endTime ?? "").trim(),
        location_type: body.locationType ?? "any",
        is_available: true,
        created_at: now,
        updated_at: now,
      };

      if (!payload.provider_id || !payload.start_time || !payload.end_time) {
        return NextResponse.json({ success: false, error: "Provider, day, and time window are required." }, { status: 400 });
      }

      const { error } = await supabase.from("provider_availability_rules").insert(payload);
      if (error && isMissingRelationError(error.message)) {
        return NextResponse.json(
          { success: false, error: "Run the latest scheduling migration before managing work schedule rules." },
          { status: 409 },
        );
      }
      if (error) throw error;

      return NextResponse.json({ success: true, created: "availability_rule" });
    }

    if (body.kind === "administrative_block") {
      const payload = {
        id: generateUuid(),
        organization_id: organizationId,
        provider_id: String(body.providerId ?? "").trim(),
        block_type: body.blockType ?? "administrative",
        title: String(body.title ?? "Administrative block").trim(),
        description: body.description ?? null,
        starts_at: String(body.startsAt ?? "").trim(),
        ends_at: String(body.endsAt ?? "").trim(),
        is_billable: false,
        created_at: now,
        updated_at: now,
      };

      if (!payload.provider_id || !payload.starts_at || !payload.ends_at) {
        return NextResponse.json({ success: false, error: "Provider and block time window are required." }, { status: 400 });
      }

      const { error } = await supabase.from("provider_schedule_blocks").insert(payload);
      if (error && isMissingRelationError(error.message)) {
        return NextResponse.json(
          { success: false, error: "Run the latest scheduling migration before creating administrative blocks." },
          { status: 409 },
        );
      }
      if (error) throw error;

      return NextResponse.json({ success: true, created: "administrative_block" });
    }

    return NextResponse.json({ success: false, error: "Unknown work schedule request type." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 500 });
  }
}
