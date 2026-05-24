/**
 * Public-facing endpoint behind a one-time tokenized link sent to the
 * client when a biller routes a COB-flagged claim to "client/admin".
 *
 *   GET  /api/cob-update/:token   — load the form context (practice,
 *                                    client name, current policies).
 *   POST /api/cob-update/:token   — submit the client's confirmed
 *                                    primary/secondary order, "do you
 *                                    have other coverage?" answer, and
 *                                    optional card photo. Updates
 *                                    insurance_policies, flips the link
 *                                    to completed, and writes a
 *                                    `cob_client_update_received` audit
 *                                    row so the COB queue reducer marks
 *                                    the originating claim resolved.
 *
 * NOTE: there is intentionally no auth on these routes — the token IS
 * the credential. Tokens are 24 bytes of crypto-grade randomness, are
 * stored hashed-by-uniqueness in cob_client_update_links, are
 * single-use (status flips to 'completed' on submit), and expire after
 * 7 days. See migrations/20260610000000_cob_client_update_links.sql.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const CARD_BUCKET = "intake-card-images";
const MAX_CARD_BYTES = 6 * 1024 * 1024;
const ALLOWED_IMAGE_PREFIXES = [
  "data:image/png;base64,",
  "data:image/jpeg;base64,",
  "data:image/jpg;base64,",
  "data:image/webp;base64,",
  "data:image/gif;base64,",
];

function value(input: unknown): string {
  return String(input ?? "").trim();
}

async function loadLink(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  token: string,
) {
  if (!supabase) {
    return { error: "Database connection not available", status: 500 as const };
  }
  const { data, error } = await (supabase as any)
    .from("cob_client_update_links")
    .select(
      "id, organization_id, client_id, claim_id, token, status, expires_at, completed_at",
    )
    .eq("token", token)
    .maybeSingle();
  if (error) return { error: error.message, status: 500 as const };
  if (!data) return { error: "Update link not found", status: 404 as const };
  const row = data as Row;
  const status = value(row.status);
  if (status !== "pending") {
    return { error: `Update link is ${status}`, status: 410 as const };
  }
  const expiresAtIso = value(row.expires_at);
  const expiresAt = expiresAtIso ? new Date(expiresAtIso) : null;
  if (expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() < Date.now()) {
    await (supabase as any)
      .from("cob_client_update_links")
      .update({ status: "expired" })
      .eq("id", value(row.id));
    return { error: "Update link has expired", status: 410 as const };
  }
  return { link: row };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await context.params;
    const supabase = createServerSupabaseAdminClient();
    const result = await loadLink(supabase, token);
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }
    const link = result.link;
    const organizationId = value(link.organization_id);
    const clientId = value(link.client_id);
    const claimId = value(link.claim_id);

    const [{ data: client }, { data: org }, { data: claim }, { data: policies }] =
      await Promise.all([
        (supabase as any)
          .from("clients")
          .select("id, first_name, last_name, preferred_name")
          .eq("id", clientId)
          .maybeSingle(),
        (supabase as any)
          .from("organizations")
          .select("id, name")
          .eq("id", organizationId)
          .maybeSingle(),
        (supabase as any)
          .from("professional_claims")
          .select("id, claim_number")
          .eq("id", claimId)
          .maybeSingle(),
        (supabase as any)
          .from("insurance_policies")
          .select(
            "id, payer_id, priority, plan_name, policy_number, effective_date, termination_date, active_flag",
          )
          .eq("organization_id", organizationId)
          .eq("client_id", clientId)
          .is("archived_at", null)
          .eq("active_flag", true),
      ]);

    const payerIds = ((policies ?? []) as Row[])
      .map((p) => value(p.payer_id))
      .filter(Boolean);
    const { data: payers } = payerIds.length
      ? await (supabase as any)
          .from("payer_profiles")
          .select("id, payer_name, payer_type")
          .in("id", payerIds)
      : { data: [] as Row[] };
    const payerById = new Map<string, Row>(
      ((payers ?? []) as Row[]).map((p) => [value(p.id), p]),
    );

    const clientRow = (client ?? {}) as Row;
    const orgRow = (org ?? {}) as Row;
    const claimRow = (claim ?? {}) as Row;

    const policySummaries = ((policies ?? []) as Row[]).map((p) => {
      const payer = payerById.get(value(p.payer_id));
      return {
        id: value(p.id),
        priority: value(p.priority) || "primary",
        payerId: value(p.payer_id) || null,
        payerName: payer ? value(payer.payer_name) || null : null,
        payerType: payer ? value(payer.payer_type) || null : null,
        planName: value(p.plan_name) || null,
        policyNumber: value(p.policy_number) || null,
        effectiveDate: (p.effective_date as string | null) ?? null,
        terminationDate: (p.termination_date as string | null) ?? null,
      };
    });

    return NextResponse.json({
      success: true,
      organization: {
        id: value(orgRow.id),
        name: value(orgRow.name) || "your care team",
      },
      client: {
        id: value(clientRow.id),
        firstName: value(clientRow.first_name),
        lastName: value(clientRow.last_name),
        preferredName: clientRow.preferred_name ?? null,
      },
      claim: {
        id: value(claimRow.id),
        claimNumber: value(claimRow.claim_number) || null,
      },
      policies: policySummaries,
      token,
      expiresAt: link.expires_at ?? null,
    });
  } catch (error) {
    console.error("COB update link load error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load link",
      },
      { status: 500 },
    );
  }
}

type SanitizedCard = {
  bytes: Buffer;
  extension: string;
  contentType: string;
};

function sanitizeCard(input: unknown): SanitizedCard | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Row;
  const content = typeof obj.content === "string" ? obj.content : "";
  if (!content || content.length > MAX_CARD_BYTES) return null;
  const lower = content.toLowerCase();
  const matched = ALLOWED_IMAGE_PREFIXES.find((p) => lower.startsWith(p));
  if (!matched) return null;
  const commaIdx = content.indexOf(",");
  if (commaIdx < 0) return null;
  const base64 = content.slice(commaIdx + 1);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  const extension = matched.includes("png")
    ? "png"
    : matched.includes("webp")
      ? "webp"
      : matched.includes("gif")
        ? "gif"
        : "jpg";
  const contentType = `image/${extension === "jpg" ? "jpeg" : extension}`;
  return { bytes, extension, contentType };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await context.params;
    const supabase = createServerSupabaseAdminClient();
    const result = await loadLink(supabase, token);
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }
    const link = result.link;
    const organizationId = value(link.organization_id);
    const clientId = value(link.client_id);
    const claimId = value(link.claim_id);
    const linkId = value(link.id);

    const payload = (await request.json().catch(() => null)) as Row | null;
    if (!payload) {
      return NextResponse.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 },
      );
    }

    const orderedPolicyIds = Array.isArray(payload.orderedPolicyIds)
      ? (payload.orderedPolicyIds as unknown[]).map((x) => String(x)).filter(Boolean)
      : [];
    const hasOtherCoverage = payload.hasOtherCoverage === true;
    const otherCoverageNote = value(payload.otherCoverageNote).slice(0, 1000);
    const signatureName = value(payload.signatureName);
    const cardSanitized = sanitizeCard(payload.cardPhoto);

    if (!signatureName) {
      return NextResponse.json(
        { success: false, error: "Please type your name to sign." },
        { status: 400 },
      );
    }

    // Re-fetch the live set of active policies and only accept ids
    // that actually belong to this client — never trust the caller's
    // id list for cross-client mutations.
    const { data: livePolicies } = await (supabase as any)
      .from("insurance_policies")
      .select("id, priority, active_flag, plan_name, policy_number")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null);
    const livePolicyIds = new Set(
      ((livePolicies ?? []) as Row[]).map((p) => value(p.id)),
    );
    const safeOrderedIds = orderedPolicyIds.filter((id) => livePolicyIds.has(id));

    const now = new Date().toISOString();

    // Atomically claim the link first so a double-submit can't run the
    // mutation block twice.
    const { data: claimed, error: claimErr } = await (supabase as any)
      .from("cob_client_update_links")
      .update({
        status: "completed",
        completed_at: now,
        submission_payload: {
          orderedPolicyIds: safeOrderedIds,
          hasOtherCoverage,
          otherCoverageNote,
          signatureName,
          cardUploaded: !!cardSanitized,
        },
      })
      .eq("id", linkId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claimed) {
      return NextResponse.json(
        { success: false, error: "This link has already been used." },
        { status: 410 },
      );
    }

    // Re-order priorities. The partial unique index
    // (client_id, priority) WHERE archived_at IS NULL prevents two
    // rows sharing a priority slot, so we soft-archive the rows that
    // are about to change priority first, then re-insert them at their
    // new priority. New rows preserve the original payer/plan/etc.
    const priorityOrder: Array<"primary" | "secondary" | "tertiary"> = [
      "primary",
      "secondary",
      "tertiary",
    ];
    const desired = safeOrderedIds.slice(0, 3);

    // Build a map of policy_id -> desired priority
    const desiredPriority = new Map<string, "primary" | "secondary" | "tertiary">();
    desired.forEach((id, idx) => desiredPriority.set(id, priorityOrder[idx]));

    const livePolicyById = new Map<string, Row>(
      ((livePolicies ?? []) as Row[]).map((p) => [value(p.id), p]),
    );

    // Which rows actually need a priority change?
    const policiesToReassign: Array<{ id: string; from: string; to: string; row: Row }> =
      [];
    for (const [id, to] of desiredPriority.entries()) {
      const row = livePolicyById.get(id);
      if (!row) continue;
      const from = value(row.priority) || "primary";
      if (from !== to) policiesToReassign.push({ id, from, to, row });
    }

    // Step 1: soft-archive all rows that are moving (frees up the slot).
    for (const { id } of policiesToReassign) {
      await (supabase as any)
        .from("insurance_policies")
        .update({ archived_at: now, updated_at: now })
        .eq("id", id);
    }

    // Step 2: re-insert each at its new priority. We copy preserved
    // fields from the archived row so payer/plan/policy_number etc.
    // stay intact.
    for (const { id, to } of policiesToReassign) {
      const { data: src } = await (supabase as any)
        .from("insurance_policies")
        .select(
          "organization_id, client_id, subscriber_id, payer_id, plan_name, policy_number, effective_date, termination_date, copay_amount, coinsurance_percent, deductible_amount, out_of_pocket_max, legacy_availity_plan_code",
        )
        .eq("id", id)
        .maybeSingle();
      if (!src) continue;
      await (supabase as any).from("insurance_policies").insert({
        ...(src as Row),
        priority: to,
        active_flag: true,
        created_at: now,
        updated_at: now,
      });
    }

    // If the client said "no other coverage" and only a single policy
    // was confirmed, deactivate any other live policies so the COB
    // queue stops re-flagging this client purely on row-count.
    if (!hasOtherCoverage && desired.length === 1) {
      const keepId = desired[0];
      for (const row of (livePolicies ?? []) as Row[]) {
        const id = value(row.id);
        if (id === keepId) continue;
        await (supabase as any)
          .from("insurance_policies")
          .update({ active_flag: false, archived_at: now, updated_at: now })
          .eq("id", id);
      }
    }

    // Optional card photo — uploaded after the link is claimed so a
    // failed submit never leaves an orphaned blob in storage. We
    // intentionally do not create a new policy from a card image; the
    // photo lives in storage for the biller to review in the chart.
    let storedCard: { bucket: string; path: string } | null = null;
    if (cardSanitized) {
      const objectPath = `${organizationId}/${clientId}/cob-update-${linkId}.${cardSanitized.extension}`;
      const { error: uploadErr } = await supabase!.storage
        .from(CARD_BUCKET)
        .upload(objectPath, cardSanitized.bytes, {
          contentType: cardSanitized.contentType,
          upsert: true,
        });
      if (uploadErr) {
        console.error("COB update card upload failed:", uploadErr.message);
      } else {
        storedCard = { bucket: CARD_BUCKET, path: objectPath };
      }
    }

    // Audit row → COB queue reducer flips claim state to "resolved".
    const { data: claimRow } = await (supabase as any)
      .from("professional_claims")
      .select("id, patient_id, appointment_id, organization_id")
      .eq("id", claimId)
      .maybeSingle();

    if (claimRow && value(claimRow.organization_id) === organizationId) {
      await (supabase as any).from("audit_logs").insert({
        organization_id: organizationId,
        claim_id: claimId,
        patient_id: claimRow.patient_id ?? null,
        appointment_id: claimRow.appointment_id ?? null,
        event_type: "cob_client_update_received",
        event_summary: "Client submitted insurance update via secure link",
        event_metadata: {
          link_id: linkId,
          ordered_policy_ids: safeOrderedIds,
          has_other_coverage: hasOtherCoverage,
          other_coverage_note: otherCoverageNote || null,
          signature_name: signatureName,
          card_photo: storedCard,
        },
        user_id: null,
        action: "cob_client_update_received",
        object_type: "claim",
        object_id: claimId,
      });
    }

    return NextResponse.json({
      success: true,
      submittedAt: now,
    });
  } catch (error) {
    console.error("COB update link submit error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to submit",
      },
      { status: 500 },
    );
  }
}
