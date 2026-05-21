import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { DEFAULT_ORG_ID } from "@/lib/config";

type DbRow = Record<string, unknown>;

function getString(v: unknown) {
  return typeof v === "string" ? v : "";
}

async function ensureMember(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  organizationId: string,
  conversationId: string,
  userId: string,
) {
  if (!supabase) return false;
  const { data, error } = await supabase
    .from("chat_participants")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) return false;
  return !!data;
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }
    const { id: conversationId } = await ctx.params;
    const url = new URL(request.url);
    const organizationId =
      url.searchParams.get("organizationId") || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
    const userId = url.searchParams.get("userId") || "";
    const markRead = url.searchParams.get("markRead") === "1";

    if (!conversationId || !userId) {
      return NextResponse.json({ success: false, error: "conversationId and userId required" }, { status: 400 });
    }

    const isMember = await ensureMember(supabase, organizationId, conversationId, userId);
    if (!isMember) {
      return NextResponse.json({ success: false, error: "Not a participant of this conversation" }, { status: 403 });
    }

    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, sender_user_id, message_body, attachment_path, attachment_file_name, created_at, edited_at, profiles:sender_user_id(full_name, role)")
      .eq("organization_id", organizationId)
      .eq("conversation_id", conversationId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(500);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 422 });
    }

    if (markRead) {
      await supabase
        .from("chat_participants")
        .update({ last_read_at: new Date().toISOString() })
        .eq("organization_id", organizationId)
        .eq("conversation_id", conversationId)
        .eq("user_id", userId);
    }

    const messages = ((data ?? []) as DbRow[]).map((row) => {
      const prof = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
      const p = (prof ?? {}) as DbRow;
      return {
        id: getString(row.id),
        senderUserId: getString(row.sender_user_id),
        senderName: getString(p.full_name) || "Unknown",
        senderRole: getString(p.role),
        body: getString(row.message_body),
        attachmentPath: getString(row.attachment_path),
        attachmentFileName: getString(row.attachment_file_name),
        createdAt: getString(row.created_at),
        editedAt: getString(row.edited_at),
      };
    });

    return NextResponse.json({ success: true, messages });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Messages list failed" },
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
    const { id: conversationId } = await ctx.params;
    const body = (await request.json()) as {
      organizationId?: string;
      senderUserId?: string;
      body?: string;
    };

    const organizationId = body.organizationId || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
    const senderUserId = body.senderUserId || "";
    const messageBody = (body.body || "").trim();

    if (!conversationId || !senderUserId) {
      return NextResponse.json({ success: false, error: "conversationId and senderUserId required" }, { status: 400 });
    }
    if (!messageBody) {
      return NextResponse.json({ success: false, error: "Message body cannot be empty" }, { status: 400 });
    }

    const isMember = await ensureMember(supabase, organizationId, conversationId, senderUserId);
    if (!isMember) {
      return NextResponse.json({ success: false, error: "Not a participant of this conversation" }, { status: 403 });
    }

    const insert = await supabase
      .from("chat_messages")
      .insert({
        organization_id: organizationId,
        conversation_id: conversationId,
        sender_user_id: senderUserId,
        message_body: messageBody,
      })
      .select("id, created_at")
      .single();

    if (insert.error || !insert.data) {
      return NextResponse.json(
        { success: false, error: insert.error?.message || "Failed to send message" },
        { status: 422 },
      );
    }

    await supabase
      .from("chat_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);

    await supabase
      .from("chat_participants")
      .update({ last_read_at: new Date().toISOString() })
      .eq("organization_id", organizationId)
      .eq("conversation_id", conversationId)
      .eq("user_id", senderUserId);

    return NextResponse.json({
      success: true,
      message: {
        id: getString((insert.data as DbRow).id),
        createdAt: getString((insert.data as DbRow).created_at),
      },
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Send message failed" },
      { status: 500 },
    );
  }
}
