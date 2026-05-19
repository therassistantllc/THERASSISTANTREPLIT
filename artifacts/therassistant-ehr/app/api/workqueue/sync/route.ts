import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRow = Record<string, any>;
type SupabaseAdminClient = NonNullable<ReturnType<typeof createServerSupabaseAdminClient>>;

function generateUuid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function buildWorkqueueItem(input: {
  organization_id: string | null;
  title: string;
  work_type: string;
  priority: "low" | "medium" | "high" | "urgent";
  source_object_type: string;
  source_object_id: string;
  client_id?: string | null;
  appointment_id?: string | null;
  encounter_id?: string | null;
  claim_id?: string | null;
  description?: string | null;
  context_payload?: Record<string, unknown>;
  now: string;
}) {
  return {
    id: generateUuid(),
    organization_id: input.organization_id,
    title: input.title,
    description: input.description ?? null,
    work_type: input.work_type,
    status: "open",
    priority: input.priority,
    source_object_type: input.source_object_type,
    source_object_id: input.source_object_id,
    client_id: input.client_id ?? null,
    appointment_id: input.appointment_id ?? null,
    encounter_id: input.encounter_id ?? null,
    claim_id: input.claim_id ?? null,
    context_payload: input.context_payload ?? {},
    created_at: input.now,
    updated_at: input.now,
  };
}

async function hasExistingItem(supabase: SupabaseAdminClient, sourceId: string, workType: string) {
  const { data, error } = await supabase
    .from("workqueue_items")
    .select("id")
    .eq("source_object_id", sourceId)
    .eq("work_type", workType)
    .in("status", ["open", "in_progress", "blocked"])
    .is("archived_at", null)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

async function insertWorkqueueItem(supabase: SupabaseAdminClient, itemsCreated: DbRow[], payload: DbRow) {
  const { data, error } = await supabase.from("workqueue_items").insert(payload).select().single();
  if (error) throw new Error(`Could not create ${payload.work_type} workqueue item: ${error.message}`);
  if (data) itemsCreated.push(data);
}

export async function POST() {
  try {
    const supabaseAdminClient = createServerSupabaseAdminClient();
    if (!supabaseAdminClient) {
      return NextResponse.json({ error: "Database connection not available" }, { status: 500 });
    }
    const supabase = supabaseAdminClient;

    const now = new Date().toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const itemsCreated: DbRow[] = [];

    const { data: eligibilityChecks, error: eligibilityError } = await supabase
      .from("eligibility_checks")
      .select("id, appointment_id, client_id, organization_id, eligibility_status, checked_at")
      .or(`eligibility_status.eq.not_checked,checked_at.lt.${thirtyDaysAgo}`)
      .is("archived_at", null);

    if (eligibilityError) throw eligibilityError;

    for (const check of eligibilityChecks ?? []) {
      if (await hasExistingItem(supabase, check.id, "eligibility_needed")) continue;
      const eligibilityStatus = check.eligibility_status ?? "stale";

      await insertWorkqueueItem(
        supabase,
        itemsCreated,
        buildWorkqueueItem({
          organization_id: check.organization_id,
          title: `Eligibility check needed - ${eligibilityStatus}`,
          work_type: "eligibility_needed",
          priority: "medium",
          source_object_type: "eligibility_check",
          source_object_id: check.id,
          client_id: check.client_id,
          appointment_id: check.appointment_id,
          context_payload: { eligibility_status: eligibilityStatus, checked_at: check.checked_at },
          now,
        }),
      );
    }

    const { data: encountersWithoutClaims, error: encounterError } = await supabase
      .from("encounters")
      .select("id, client_id, organization_id, encounter_status")
      .eq("encounter_status", "signed")
      .is("archived_at", null);

    if (encounterError) throw encounterError;

    for (const encounter of encountersWithoutClaims ?? []) {
      const { data: claim, error: claimLookupError } = await supabase
        .from("professional_claims")
        .select("id")
        .eq("encounter_id", encounter.id)
        .maybeSingle();

      if (claimLookupError) throw claimLookupError;
      if (claim || (await hasExistingItem(supabase, encounter.id, "ready_to_bill"))) continue;

      await insertWorkqueueItem(
        supabase,
        itemsCreated,
        buildWorkqueueItem({
          organization_id: encounter.organization_id,
          title: "Encounter ready to bill - no claim created",
          work_type: "ready_to_bill",
          priority: "high",
          source_object_type: "encounter",
          source_object_id: encounter.id,
          client_id: encounter.client_id,
          encounter_id: encounter.id,
          now,
        }),
      );
    }

    const { data: claimsWithoutResponse, error: noResponseError } = await supabase
      .from("professional_claims")
      .select("id, client_id, encounter_id, claim_number, organization_id, claim_status, updated_at")
      .eq("claim_status", "submitted")
      .lt("updated_at", thirtyDaysAgo);

    if (noResponseError) throw noResponseError;

    for (const claim of claimsWithoutResponse ?? []) {
      if (await hasExistingItem(supabase, claim.id, "no_response")) continue;

      const { data: recentInquiry, error: inquiryError } = await supabase
        .from("claim_status_inquiries")
        .select("id")
        .eq("claim_id", claim.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (inquiryError) throw inquiryError;

      await insertWorkqueueItem(
        supabase,
        itemsCreated,
        buildWorkqueueItem({
          organization_id: claim.organization_id,
          title: recentInquiry
            ? "Claim submitted over 30 days ago - review latest status inquiry"
            : "Claim submitted over 30 days ago - claim status inquiry needed",
          work_type: "no_response",
          priority: "high",
          source_object_type: "claim",
          source_object_id: claim.id,
          client_id: claim.client_id,
          encounter_id: claim.encounter_id,
          claim_id: claim.id,
          context_payload: { claim_number: claim.claim_number, has_claim_status_inquiry: Boolean(recentInquiry) },
          now,
        }),
      );
    }

    const { data: deniedClaims, error: deniedError } = await supabase
      .from("professional_claims")
      .select("id, client_id, encounter_id, claim_number, organization_id, claim_status")
      .in("claim_status", ["denied", "rejected"]);

    if (deniedError) throw deniedError;

    for (const claim of deniedClaims ?? []) {
      if (await hasExistingItem(supabase, claim.id, "denial_followup")) continue;

      await insertWorkqueueItem(
        supabase,
        itemsCreated,
        buildWorkqueueItem({
          organization_id: claim.organization_id,
          title: `Claim ${claim.claim_status} - needs review`,
          work_type: "denial_followup",
          priority: "high",
          source_object_type: "claim",
          source_object_id: claim.id,
          client_id: claim.client_id,
          encounter_id: claim.encounter_id,
          claim_id: claim.id,
          context_payload: { claim_number: claim.claim_number, claim_status: claim.claim_status },
          now,
        }),
      );
    }

    const { data: paymentImports, error: paymentImportError } = await supabase
      .from("payment_import_items")
      .select("id, client_id, claim_id, organization_id")
      .eq("posting_ready", true)
      .is("archived_at", null);

    if (paymentImportError) throw paymentImportError;

    for (const paymentItem of paymentImports ?? []) {
      const { data: posting, error: postingError } = await supabase
        .from("payment_postings")
        .select("id")
        .eq("payment_import_item_id", paymentItem.id)
        .maybeSingle();

      if (postingError) throw postingError;
      if (posting || (await hasExistingItem(supabase, paymentItem.id, "payment_posting_needed"))) continue;

      await insertWorkqueueItem(
        supabase,
        itemsCreated,
        buildWorkqueueItem({
          organization_id: paymentItem.organization_id,
          title: "Payment ready to post",
          work_type: "payment_posting_needed",
          priority: "medium",
          source_object_type: "payment_import_item",
          source_object_id: paymentItem.id,
          client_id: paymentItem.client_id,
          claim_id: paymentItem.claim_id,
          now,
        }),
      );
    }

    const { data: mailroomItems, error: mailroomError } = await supabase
      .from("mailroom_items")
      .select("id, organization_id, client_id")
      .eq("status", "needs_review")
      .is("archived_at", null);

    if (mailroomError) throw mailroomError;

    for (const item of mailroomItems ?? []) {
      if (await hasExistingItem(supabase, item.id, "mailroom")) continue;

      await insertWorkqueueItem(
        supabase,
        itemsCreated,
        buildWorkqueueItem({
          organization_id: item.organization_id,
          title: "Document needs review and filing",
          work_type: "mailroom",
          priority: "medium",
          source_object_type: "mailroom_item",
          source_object_id: item.id,
          client_id: item.client_id,
          now,
        }),
      );
    }

    const { data: vccPayments, error: vccError } = await supabase
      .from("vcc_payments")
      .select("id, organization_id, client_id, claim_id")
      .eq("status", "pending")
      .is("archived_at", null);

    if (vccError) throw vccError;

    for (const vcc of vccPayments ?? []) {
      if (await hasExistingItem(supabase, vcc.id, "vcc_processing")) continue;

      await insertWorkqueueItem(
        supabase,
        itemsCreated,
        buildWorkqueueItem({
          organization_id: vcc.organization_id,
          title: "VCC payment pending processing",
          work_type: "vcc_processing",
          priority: "high",
          source_object_type: "vcc_payment",
          source_object_id: vcc.id,
          client_id: vcc.client_id,
          claim_id: vcc.claim_id,
          now,
        }),
      );
    }

    const { data: checkins, error: checkinError } = await supabase
      .from("patient_checkins")
      .select("id, organization_id, client_id, appointment_id")
      .eq("status", "submitted")
      .is("archived_at", null);

    if (checkinError) throw checkinError;

    for (const checkin of checkins ?? []) {
      if (await hasExistingItem(supabase, checkin.id, "checkin_review")) continue;

      await insertWorkqueueItem(
        supabase,
        itemsCreated,
        buildWorkqueueItem({
          organization_id: checkin.organization_id,
          title: "Client check-in submitted - needs review",
          work_type: "checkin_review",
          priority: "medium",
          source_object_type: "patient_checkin",
          source_object_id: checkin.id,
          client_id: checkin.client_id,
          appointment_id: checkin.appointment_id,
          now,
        }),
      );
    }

    return NextResponse.json({
      success: true,
      message: "Workqueue sync completed",
      itemsCreated: itemsCreated.length,
      items: itemsCreated,
    });
  } catch (error) {
    console.error("Workqueue sync error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Workqueue sync failed" },
      { status: 500 },
    );
  }
}
