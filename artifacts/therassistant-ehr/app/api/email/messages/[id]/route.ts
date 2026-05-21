import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { DEFAULT_ORG_ID } from "@/lib/config";

type DbRow = Record<string, unknown>;

function getString(v: unknown) {
  return typeof v === "string" ? v : "";
}

function extractBody(rawPayload: unknown): string {
  if (!rawPayload || typeof rawPayload !== "object") return "";
  const payload = rawPayload as DbRow;
  const direct = (payload.body as DbRow | undefined)?.data;
  if (typeof direct === "string") {
    try {
      return Buffer.from(direct.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    } catch {
      return "";
    }
  }
  const parts = payload.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const p = part as DbRow;
      const mime = getString(p.mimeType);
      const data = (p.body as DbRow | undefined)?.data;
      if ((mime === "text/plain" || mime === "text/html") && typeof data === "string") {
        try {
          return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
        } catch {
          /* ignore */
        }
      }
      const nested = extractBody(p);
      if (nested) return nested;
    }
  }
  return "";
}

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }
    const { id } = await ctx.params;
    const organizationId = process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;

    const { data, error } = await supabase
      .from("inbound_email_messages")
      .select(`*, clients:matched_client_id(id, first_name, last_name)`)
      .eq("organization_id", organizationId)
      .eq("id", id)
      .maybeSingle();

    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 422 });
    if (!data) return NextResponse.json({ success: false, error: "Email not found" }, { status: 404 });

    const row = data as DbRow;
    const client = (() => {
      const value = Array.isArray(row.clients) ? row.clients[0] : row.clients;
      if (!value || typeof value !== "object") return null;
      const r = value as DbRow;
      return { id: getString(r.id), firstName: getString(r.first_name), lastName: getString(r.last_name) };
    })();

    return NextResponse.json({
      success: true,
      message: {
        id: getString(row.id),
        provider: getString(row.provider),
        fromEmail: getString(row.from_email),
        fromName: getString(row.from_name),
        toEmail: getString(row.to_email),
        subject: getString(row.subject),
        snippet: getString(row.snippet),
        body: extractBody(row.raw_payload),
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
        aiDraftReply: getString(row.ai_draft_reply),
        aiAnalysisStatus: getString(row.ai_analysis_status),
        client,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Email fetch failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }
    const { id } = await ctx.params;
    const body = (await request.json()) as { action?: string; organizationId?: string };
    const action = (body.action || "").toLowerCase();
    const organizationId = body.organizationId || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;

    if (!["archive", "unarchive", "mark_ignored", "mark_routed"].includes(action)) {
      return NextResponse.json({ success: false, error: `Unsupported action: ${action}` }, { status: 400 });
    }

    const patch: DbRow = { updated_at: new Date().toISOString() };
    if (action === "archive") patch.archived_at = new Date().toISOString();
    if (action === "unarchive") patch.archived_at = null;
    if (action === "mark_ignored") patch.processing_status = "ignored";
    if (action === "mark_routed") patch.processing_status = "routed";

    const { error } = await supabase
      .from("inbound_email_messages")
      .update(patch)
      .eq("organization_id", organizationId)
      .eq("id", id);

    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 422 });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Email action failed" },
      { status: 500 },
    );
  }
}
