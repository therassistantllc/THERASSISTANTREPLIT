import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { DEFAULT_ORG_ID } from "@/lib/config";

type DbRow = Record<string, unknown>;

function getString(v: unknown) {
  return typeof v === "string" ? v : "";
}

function normalizeClient(value: unknown) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  const r = row as DbRow;
  return {
    id: getString(r.id),
    firstName: getString(r.first_name),
    lastName: getString(r.last_name),
  };
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }
    const url = new URL(request.url);
    const organizationId =
      url.searchParams.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
    const filter = (url.searchParams.get("filter") || "all").toLowerCase();
    const userId = url.searchParams.get("userId") || "";
    const search = (url.searchParams.get("search") || "").trim();
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 100), 1), 200);

    let query = supabase
      .from("inbound_email_messages")
      .select(`
        id, provider, from_email, from_name, to_email, subject, snippet, received_at,
        matched_profile_id, matched_client_id, mailroom_item_id, workqueue_item_id,
        processing_status, ai_sentiment, ai_priority, ai_category, ai_summary,
        ai_analysis_status, archived_at, created_at,
        clients:matched_client_id(id, first_name, last_name)
      `)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("received_at", { ascending: false, nullsFirst: false })
      .limit(limit);

    if (filter === "mine" && userId) {
      query = query.eq("matched_profile_id", userId);
    } else if (filter === "unmatched") {
      query = query.is("matched_client_id", null).is("matched_profile_id", null);
    } else if (filter === "patient") {
      query = query.not("matched_client_id", "is", null);
    } else if (filter === "routed") {
      query = query.in("processing_status", ["routed", "matched"]);
    }

    if (search) {
      const safe = search.replace(/[%,()]/g, " ").trim();
      if (safe) query = query.or(`subject.ilike.%${safe}%,from_email.ilike.%${safe}%,from_name.ilike.%${safe}%,snippet.ilike.%${safe}%`);
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 422 });
    }

    const messages = ((data ?? []) as DbRow[]).map((row) => ({
      id: getString(row.id),
      provider: getString(row.provider),
      fromEmail: getString(row.from_email),
      fromName: getString(row.from_name),
      toEmail: getString(row.to_email),
      subject: getString(row.subject),
      snippet: getString(row.snippet),
      receivedAt: getString(row.received_at) || getString(row.created_at),
      matchedProfileId: getString(row.matched_profile_id),
      matchedClientId: getString(row.matched_client_id),
      mailroomItemId: getString(row.mailroom_item_id),
      workqueueItemId: getString(row.workqueue_item_id),
      processingStatus: getString(row.processing_status),
      aiSentiment: getString(row.ai_sentiment),
      aiPriority: getString(row.ai_priority),
      aiCategory: getString(row.ai_category),
      aiSummary: getString(row.ai_summary),
      aiAnalysisStatus: getString(row.ai_analysis_status),
      client: normalizeClient(row.clients),
    }));

    const counts = messages.reduce(
      (acc, m) => {
        acc.total += 1;
        if (m.matchedClientId) acc.patient += 1;
        if (!m.matchedClientId && !m.matchedProfileId) acc.unmatched += 1;
        if (m.processingStatus === "routed" || m.processingStatus === "matched") acc.routed += 1;
        if (userId && m.matchedProfileId === userId) acc.mine += 1;
        return acc;
      },
      { total: 0, patient: 0, unmatched: 0, routed: 0, mine: 0 },
    );

    return NextResponse.json({ success: true, messages, counts });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Email list failed" },
      { status: 500 },
    );
  }
}
