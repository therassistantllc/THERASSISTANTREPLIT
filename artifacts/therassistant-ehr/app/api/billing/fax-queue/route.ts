import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

type DbRow = Record<string, any>;

const text = (v: unknown) => String(v ?? "").trim();

interface FaxQueueItem {
  id: string;
  status: string;
  toFaxNumber: string;
  subject: string | null;
  body: string;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  claimId: string | null;
  claimNumber: string | null;
  payerId: string | null;
  payerName: string | null;
  createdByUserId: string | null;
  createdByDisplayName: string | null;
}

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });
    }
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({ requestedOrganizationId: searchParams.get("organizationId") });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const wantList = searchParams.get("list") === "1" || searchParams.get("list") === "true";

    if (!wantList) {
      const { count, error } = await (supabase as any)
        .from("fax_queue")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("status", "pending");

      if (error) throw error;
      return NextResponse.json({ success: true, pendingCount: count ?? 0 });
    }

    // ── List mode: return the most recent fax_queue rows with claim /
    //    payer breadcrumbs so the UI can link each row back to its source.
    const statusFilter = text(searchParams.get("status")).toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(searchParams.get("limit") ?? "200") || 200));

    let q = (supabase as any)
      .from("fax_queue")
      .select(
        "id, status, to_fax_number, subject, body, error, created_at, sent_at, claim_id, payer_id, created_by_user_id",
      )
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (statusFilter) q = q.eq("status", statusFilter);

    const { data: rows, error } = await q;
    if (error) throw error;

    const raw = ((rows as DbRow[]) ?? []);
    const claimIds = Array.from(new Set(raw.map((r) => text(r.claim_id)).filter(Boolean)));
    const payerIds = Array.from(new Set(raw.map((r) => text(r.payer_id)).filter(Boolean)));
    const userIds = Array.from(new Set(raw.map((r) => text(r.created_by_user_id)).filter(Boolean)));

    const [claimsRes, payersRes, usersRes] = await Promise.all([
      claimIds.length
        ? (supabase as any)
            .from("professional_claims")
            .select("id, claim_number")
            .eq("organization_id", organizationId)
            .in("id", claimIds)
        : Promise.resolve({ data: [], error: null }),
      payerIds.length
        ? (supabase as any)
            .from("insurance_payers")
            .select("id, name")
            .in("id", payerIds)
        : Promise.resolve({ data: [], error: null }),
      userIds.length
        ? (supabase as any)
            .from("staff_profiles")
            .select("auth_user_id, display_name")
            .eq("organization_id", organizationId)
            .in("auth_user_id", userIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if ((claimsRes as any).error) throw (claimsRes as any).error;
    if ((payersRes as any).error) throw (payersRes as any).error;
    if ((usersRes as any).error) throw (usersRes as any).error;

    const claimMap = new Map<string, string>();
    for (const c of (((claimsRes as any).data as DbRow[]) ?? [])) {
      claimMap.set(text(c.id), text(c.claim_number));
    }
    const payerMap = new Map<string, string>();
    for (const p of (((payersRes as any).data as DbRow[]) ?? [])) {
      payerMap.set(text(p.id), text(p.name));
    }
    const userMap = new Map<string, string>();
    for (const u of (((usersRes as any).data as DbRow[]) ?? [])) {
      userMap.set(text(u.auth_user_id), text(u.display_name));
    }

    const items: FaxQueueItem[] = raw.map((r) => {
      const claimId = text(r.claim_id) || null;
      const payerId = text(r.payer_id) || null;
      const userId = text(r.created_by_user_id) || null;
      return {
        id: text(r.id),
        status: text(r.status) || "pending",
        toFaxNumber: text(r.to_fax_number),
        subject: text(r.subject) || null,
        body: text(r.body),
        error: text(r.error) || null,
        createdAt: text(r.created_at),
        sentAt: text(r.sent_at) || null,
        claimId,
        claimNumber: claimId ? (claimMap.get(claimId) || null) : null,
        payerId,
        payerName: payerId ? (payerMap.get(payerId) || null) : null,
        createdByUserId: userId,
        createdByDisplayName: userId ? (userMap.get(userId) || null) : null,
      };
    });

    const counts = {
      pending: items.filter((i) => i.status === "pending").length,
      sent: items.filter((i) => i.status === "sent").length,
      failed: items.filter((i) => i.status === "failed").length,
      canceled: items.filter((i) => i.status === "canceled").length,
    };

    return NextResponse.json({ success: true, items, counts });
  } catch (error) {
    console.error("Fax queue GET error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Fax queue read failed" },
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
    const body = await request.json().catch(() => ({}));
    const guard = await requireBillingAccess({ requestedOrganizationId: body?.organizationId ?? null });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const toFaxNumber = String(body?.toFaxNumber ?? "").trim();
    const bodyText = String(body?.body ?? "").trim();
    if (!toFaxNumber) {
      return NextResponse.json({ success: false, error: "toFaxNumber is required" }, { status: 400 });
    }
    if (!bodyText) {
      return NextResponse.json({ success: false, error: "body is required" }, { status: 400 });
    }

    const insertRow: Record<string, unknown> = {
      organization_id: organizationId,
      claim_id: body?.claimId ?? null,
      payer_id: body?.payerId ?? null,
      to_fax_number: toFaxNumber,
      subject: body?.subject ?? null,
      body: bodyText,
      status: "pending",
      created_by_user_id: guard.userId ?? null,
    };

    const { data: inserted, error: insertErr } = await (supabase as any)
      .from("fax_queue")
      .insert(insertRow)
      .select("id")
      .single();

    if (insertErr) throw insertErr;

    const { count, error: countErr } = await (supabase as any)
      .from("fax_queue")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "pending");

    if (countErr) throw countErr;

    return NextResponse.json({
      success: true,
      id: inserted?.id ?? null,
      pendingCount: count ?? 0,
    });
  } catch (error) {
    console.error("Fax queue POST error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Fax queue insert failed" },
      { status: 500 },
    );
  }
}
