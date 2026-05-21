import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { DEFAULT_ORG_ID } from "@/lib/config";

type DbRow = Record<string, unknown>;

async function loadParticipantsAndPreviews(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  organizationId: string,
  conversationIds: string[],
  currentUserId: string,
) {
  if (!supabase || conversationIds.length === 0) {
    return { participants: new Map(), previews: new Map(), unread: new Map() };
  }

  const [partsRes, msgsRes, myPartRes] = await Promise.all([
    supabase
      .from("chat_participants")
      .select("conversation_id, user_id, role_in_conversation, last_read_at, profiles:user_id(id, full_name, email, role)")
      .in("conversation_id", conversationIds)
      .is("archived_at", null),
    supabase
      .from("chat_messages")
      .select("id, conversation_id, sender_user_id, message_body, created_at")
      .in("conversation_id", conversationIds)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("chat_participants")
      .select("conversation_id, last_read_at")
      .in("conversation_id", conversationIds)
      .eq("user_id", currentUserId)
      .is("archived_at", null),
  ]);

  const participants = new Map<string, Array<{ userId: string; fullName: string; role: string }>>();
  for (const row of (partsRes.data ?? []) as DbRow[]) {
    const cid = String(row.conversation_id ?? "");
    if (!cid) continue;
    const prof = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
    const p = (prof ?? {}) as DbRow;
    if (!participants.has(cid)) participants.set(cid, []);
    participants.get(cid)!.push({
      userId: String(row.user_id ?? ""),
      fullName: String(p.full_name ?? "") || String(p.email ?? "") || "Unknown",
      role: String(p.role ?? ""),
    });
  }

  const previews = new Map<string, { body: string; createdAt: string; senderUserId: string }>();
  const unread = new Map<string, number>();
  const myReadByConvo = new Map<string, string>();
  for (const row of (myPartRes.data ?? []) as DbRow[]) {
    myReadByConvo.set(String(row.conversation_id ?? ""), String(row.last_read_at ?? ""));
  }
  for (const row of (msgsRes.data ?? []) as DbRow[]) {
    const cid = String(row.conversation_id ?? "");
    if (!cid) continue;
    if (!previews.has(cid)) {
      previews.set(cid, {
        body: String(row.message_body ?? ""),
        createdAt: String(row.created_at ?? ""),
        senderUserId: String(row.sender_user_id ?? ""),
      });
    }
    const lastRead = myReadByConvo.get(cid) || "";
    const created = String(row.created_at ?? "");
    const senderId = String(row.sender_user_id ?? "");
    if (senderId !== currentUserId && (!lastRead || created > lastRead)) {
      unread.set(cid, (unread.get(cid) ?? 0) + 1);
    }
  }

  void organizationId;
  return { participants, previews, unread };
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
    const userId = url.searchParams.get("userId") || "";
    if (!userId) {
      return NextResponse.json({ success: false, error: "userId is required" }, { status: 400 });
    }

    const myConvosRes = await supabase
      .from("chat_participants")
      .select("conversation_id")
      .eq("organization_id", organizationId)
      .eq("user_id", userId)
      .is("archived_at", null);

    if (myConvosRes.error) {
      return NextResponse.json({ success: false, error: myConvosRes.error.message }, { status: 422 });
    }

    const conversationIds = Array.from(
      new Set(((myConvosRes.data ?? []) as DbRow[]).map((r) => String(r.conversation_id ?? "")).filter(Boolean)),
    );

    if (conversationIds.length === 0) {
      return NextResponse.json({ success: true, conversations: [] });
    }

    const convosRes = await supabase
      .from("chat_conversations")
      .select("id, conversation_type, title, related_client_id, related_workqueue_item_id, created_by_user_id, created_at, updated_at")
      .eq("organization_id", organizationId)
      .in("id", conversationIds)
      .is("archived_at", null)
      .order("updated_at", { ascending: false });

    if (convosRes.error) {
      return NextResponse.json({ success: false, error: convosRes.error.message }, { status: 422 });
    }

    const { participants, previews, unread } = await loadParticipantsAndPreviews(
      supabase,
      organizationId,
      conversationIds,
      userId,
    );

    const conversations = ((convosRes.data ?? []) as DbRow[]).map((row) => {
      const id = String(row.id ?? "");
      return {
        id,
        conversationType: String(row.conversation_type ?? "direct"),
        title: String(row.title ?? ""),
        relatedClientId: String(row.related_client_id ?? ""),
        relatedWorkqueueItemId: String(row.related_workqueue_item_id ?? ""),
        createdByUserId: String(row.created_by_user_id ?? ""),
        createdAt: String(row.created_at ?? ""),
        updatedAt: String(row.updated_at ?? ""),
        participants: participants.get(id) ?? [],
        lastMessage: previews.get(id) ?? null,
        unreadCount: unread.get(id) ?? 0,
      };
    });

    return NextResponse.json({ success: true, conversations });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Conversations list failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }

    const body = (await request.json()) as {
      organizationId?: string;
      currentUserId?: string;
      participantUserIds?: string[];
      title?: string;
      conversationType?: string;
      relatedClientId?: string | null;
      relatedWorkqueueItemId?: string | null;
    };

    const organizationId = body.organizationId || process.env.NEXT_PUBLIC_ORGANIZATION_ID || DEFAULT_ORG_ID;
    const currentUserId = body.currentUserId || "";
    const participantUserIds = Array.from(new Set([...(body.participantUserIds ?? []), currentUserId])).filter(Boolean);

    if (!currentUserId) {
      return NextResponse.json({ success: false, error: "currentUserId is required" }, { status: 400 });
    }
    if (participantUserIds.length < 2) {
      return NextResponse.json({ success: false, error: "At least one other participant is required" }, { status: 400 });
    }

    const conversationType =
      body.conversationType && ["direct", "group", "workqueue", "patient_context"].includes(body.conversationType)
        ? body.conversationType
        : participantUserIds.length === 2
        ? "direct"
        : "group";

    // For direct conversations, try to find an existing one between the same two users.
    if (conversationType === "direct" && participantUserIds.length === 2) {
      const [a, b] = participantUserIds;
      const myRes = await supabase
        .from("chat_participants")
        .select("conversation_id")
        .eq("organization_id", organizationId)
        .eq("user_id", a)
        .is("archived_at", null);
      const myIds = new Set(((myRes.data ?? []) as DbRow[]).map((r) => String(r.conversation_id ?? "")));
      if (myIds.size > 0) {
        const otherRes = await supabase
          .from("chat_participants")
          .select("conversation_id")
          .eq("organization_id", organizationId)
          .eq("user_id", b)
          .in("conversation_id", Array.from(myIds))
          .is("archived_at", null);
        const shared = ((otherRes.data ?? []) as DbRow[])
          .map((r) => String(r.conversation_id ?? ""))
          .filter(Boolean);
        if (shared.length > 0) {
          const directRes = await supabase
            .from("chat_conversations")
            .select("id")
            .in("id", shared)
            .eq("conversation_type", "direct")
            .is("archived_at", null)
            .limit(1)
            .maybeSingle();
          if (directRes.data) {
            return NextResponse.json({ success: true, conversationId: String((directRes.data as DbRow).id) });
          }
        }
      }
    }

    const insertRes = await supabase
      .from("chat_conversations")
      .insert({
        organization_id: organizationId,
        conversation_type: conversationType,
        title: body.title || null,
        related_client_id: body.relatedClientId || null,
        related_workqueue_item_id: body.relatedWorkqueueItemId || null,
        created_by_user_id: currentUserId,
      })
      .select("id")
      .single();

    if (insertRes.error || !insertRes.data) {
      return NextResponse.json(
        { success: false, error: insertRes.error?.message || "Failed to create conversation" },
        { status: 422 },
      );
    }

    const conversationId = String((insertRes.data as DbRow).id);

    const participantRows = participantUserIds.map((uid) => ({
      organization_id: organizationId,
      conversation_id: conversationId,
      user_id: uid,
      role_in_conversation: uid === currentUserId ? "owner" : "member",
    }));

    const partsInsert = await supabase.from("chat_participants").insert(participantRows);
    if (partsInsert.error) {
      return NextResponse.json({ success: false, error: partsInsert.error.message }, { status: 422 });
    }

    return NextResponse.json({ success: true, conversationId });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Conversation create failed" },
      { status: 500 },
    );
  }
}
