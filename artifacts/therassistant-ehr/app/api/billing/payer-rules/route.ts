/**
 * /api/billing/payer-rules
 *
 * Persists payer-specific handling rules surfaced from the
 * Denials-by-RARC workqueue ("When Aetna returns RARC M25, always
 * attach the treatment plan and resubmit") into the real
 * `payer_rules` table so an admin surface can list/edit them.
 *
 *   POST   — upsert a rule on (org, payer, rarc, carc). Also writes
 *            an audit_logs row and stamps a [Payer rule] note on any
 *            claims passed in `claimIds`.
 *   GET    — list active rules for the org (admin surface).
 *   PATCH  — update an existing rule (admin surface).
 *   DELETE — soft-archive a rule (admin surface).
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { insertClaimNote } from "@/lib/billing/claimNotes";

const text = (v: unknown) => String(v ?? "").trim();

interface PostBody {
  organizationId?: string;
  payer?: string | null;
  payerProfileId?: string | null;
  rarcCode?: string | null;
  carcCode?: string | null;
  rule?: string;
  recommendedAction?: string | null;
  claimIds?: string[];
}

interface PatchBody {
  organizationId?: string;
  id?: string;
  payer?: string | null;
  payerProfileId?: string | null;
  rarcCode?: string | null;
  carcCode?: string | null;
  rule?: string;
  recommendedAction?: string | null;
}

function mapRow(r: any) {
  return {
    id: text(r.id),
    payer: text(r.payer_name) || null,
    payerProfileId: text(r.payer_profile_id) || null,
    rarcCode: text(r.rarc_code) || null,
    carcCode: text(r.carc_code) || null,
    rule: text(r.rule),
    recommendedAction: text(r.recommended_action) || null,
    source: text(r.source) || "denials_by_rarc",
    createdAt: text(r.created_at) || null,
    updatedAt: text(r.updated_at) || null,
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    const { data, error } = await (supabase as any)
      .from("payer_rules")
      .select(
        "id, payer_profile_id, payer_name, rarc_code, carc_code, rule, recommended_action, source, created_at, updated_at",
      )
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(500);

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 422 },
      );
    }

    return NextResponse.json({
      success: true,
      organizationId,
      rules: ((data as any[]) ?? []).map(mapRow),
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as PostBody;
    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const rule = text(body.rule);
    const payerName = text(body.payer) || null;
    const payerProfileId = text(body.payerProfileId) || null;
    const rarcCode = text(body.rarcCode).toUpperCase() || null;
    const carcCode = text(body.carcCode).toUpperCase() || null;
    const recommendedAction = text(body.recommendedAction) || null;

    if (!rule) {
      return NextResponse.json(
        { success: false, error: "rule is required" },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    // Upsert by (org, payer, rarc, carc). supabase-js can't express
    // the COALESCE/lower partial index as an ON CONFLICT arbiter, so
    // we manually look up an existing active rule first.
    const lookup = (supabase as any)
      .from("payer_rules")
      .select("id")
      .eq("organization_id", organizationId)
      .is("archived_at", null);
    if (payerName) lookup.ilike("payer_name", payerName);
    else lookup.is("payer_name", null);
    if (rarcCode) lookup.eq("rarc_code", rarcCode);
    else lookup.is("rarc_code", null);
    if (carcCode) lookup.eq("carc_code", carcCode);
    else lookup.is("carc_code", null);

    const { data: existing } = await lookup.maybeSingle();

    let savedId: string | null = null;
    let action: "create" | "update" = "create";
    if (existing && (existing as any).id) {
      action = "update";
      const { data: updated, error: updateErr } = await (supabase as any)
        .from("payer_rules")
        .update({
          rule,
          recommended_action: recommendedAction,
          payer_profile_id: payerProfileId,
          updated_by_user_id: guard.userId,
        })
        .eq("id", (existing as any).id)
        .select("id")
        .maybeSingle();
      if (updateErr) {
        return NextResponse.json(
          { success: false, error: updateErr.message },
          { status: 422 },
        );
      }
      savedId = text((updated as any)?.id) || text((existing as any).id);
    } else {
      const { data: inserted, error: insertErr } = await (supabase as any)
        .from("payer_rules")
        .insert({
          organization_id: organizationId,
          payer_profile_id: payerProfileId,
          payer_name: payerName,
          rarc_code: rarcCode,
          carc_code: carcCode,
          rule,
          recommended_action: recommendedAction,
          source: "denials_by_rarc",
          created_by_user_id: guard.userId,
          updated_by_user_id: guard.userId,
        })
        .select("id")
        .maybeSingle();
      if (insertErr) {
        return NextResponse.json(
          { success: false, error: insertErr.message },
          { status: 422 },
        );
      }
      savedId = text((inserted as any)?.id) || null;
    }

    const summary = `Payer rule — ${payerName || "any payer"} / ${rarcCode || carcCode || "any code"}`;

    await (supabase as any)
      .from("audit_logs")
      .insert({
        organization_id: organizationId,
        user_id: guard.userId,
        event_type: `denials_by_rarc.payer_rule.${action}`,
        event_summary: summary,
        event_metadata: {
          payer: payerName,
          rarcCode,
          carcCode,
          rule,
          recommendedAction,
        },
        action,
        object_type: "payer_rule",
        object_id: savedId,
      })
      .then(() => undefined, () => undefined);

    // Drop a [Payer rule] note on every claim in the group so billers
    // see the guidance in the claim timeline.
    const claimIds = Array.isArray(body.claimIds)
      ? body.claimIds.map(text).filter(Boolean)
      : [];
    let notesWritten = 0;
    if (claimIds.length > 0) {
      const { data: claims } = await (supabase as any)
        .from("professional_claims")
        .select("id")
        .eq("organization_id", organizationId)
        .in("id", claimIds);
      const validIds = ((claims as any[]) ?? []).map((c) => text(c.id));
      for (const id of validIds) {
        const { error } = await insertClaimNote(supabase as any, {
          organizationId,
          claimId: id,
          authorUserId: guard.userId,
          authorDisplayName: "[Payer rule]",
          body: `[Payer rule] ${summary}\n\n${rule}`,
        });
        if (!error) notesWritten += 1;
      }
    }

    return NextResponse.json({
      success: true,
      ruleId: savedId,
      action,
      notesWritten,
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as PatchBody;
    const guard = await requireBillingAccess({
      requestedOrganizationId: body.organizationId ?? null,
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const id = text(body.id);
    if (!id) {
      return NextResponse.json(
        { success: false, error: "id is required" },
        { status: 400 },
      );
    }
    const rule = text(body.rule);
    if (!rule) {
      return NextResponse.json(
        { success: false, error: "rule is required" },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    const patch: Record<string, unknown> = {
      rule,
      updated_by_user_id: guard.userId,
    };
    if (body.payer !== undefined) patch.payer_name = text(body.payer) || null;
    if (body.payerProfileId !== undefined)
      patch.payer_profile_id = text(body.payerProfileId) || null;
    if (body.rarcCode !== undefined)
      patch.rarc_code = text(body.rarcCode).toUpperCase() || null;
    if (body.carcCode !== undefined)
      patch.carc_code = text(body.carcCode).toUpperCase() || null;
    if (body.recommendedAction !== undefined)
      patch.recommended_action = text(body.recommendedAction) || null;

    const { data, error } = await (supabase as any)
      .from("payer_rules")
      .update(patch)
      .eq("id", id)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .select(
        "id, payer_profile_id, payer_name, rarc_code, carc_code, rule, recommended_action, source, created_at, updated_at",
      )
      .maybeSingle();
    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 422 },
      );
    }
    if (!data) {
      return NextResponse.json(
        { success: false, error: "Rule not found" },
        { status: 404 },
      );
    }

    await (supabase as any)
      .from("audit_logs")
      .insert({
        organization_id: organizationId,
        user_id: guard.userId,
        event_type: "denials_by_rarc.payer_rule.update",
        event_summary: `Updated payer rule ${id}`,
        event_metadata: { id, patch },
        action: "update",
        object_type: "payer_rule",
        object_id: id,
      })
      .then(() => undefined, () => undefined);

    return NextResponse.json({ success: true, rule: mapRow(data) });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = text(searchParams.get("id"));
    const guard = await requireBillingAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    if (!id) {
      return NextResponse.json(
        { success: false, error: "id is required" },
        { status: 400 },
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 500 },
      );
    }

    const { error } = await (supabase as any)
      .from("payer_rules")
      .update({
        archived_at: new Date().toISOString(),
        updated_by_user_id: guard.userId,
      })
      .eq("id", id)
      .eq("organization_id", organizationId)
      .is("archived_at", null);
    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 422 },
      );
    }

    await (supabase as any)
      .from("audit_logs")
      .insert({
        organization_id: organizationId,
        user_id: guard.userId,
        event_type: "denials_by_rarc.payer_rule.archive",
        event_summary: `Archived payer rule ${id}`,
        event_metadata: { id },
        action: "delete",
        object_type: "payer_rule",
        object_id: id,
      })
      .then(() => undefined, () => undefined);

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 },
    );
  }
}
