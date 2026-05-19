import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient as createServerSupabaseAdminClientTyped } from "@/lib/supabase/server";
import { requireRoleInRoute } from "@/lib/rbac/middleware";
import { mapLegacyClaimInputToProfessionalClaim } from "@/lib/claims/createProfessionalClaimFromLegacyInput";
import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRow = Record<string, any>;

type LifecycleStep = {
  step: string;
  status: "created" | "reused" | "updated" | "skipped";
  id?: string | null;
  message: string;
};

function generateUuid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function money(value: unknown, fallback = "0.00") {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? n.toFixed(2) : fallback;
}

async function createWorkqueueItem(
  supabase: SupabaseClient,
  input: {
    organization_id: string;
    title: string;
    work_type: string;
    priority: "low" | "medium" | "high" | "urgent";
    source_object_type: string;
    source_object_id: string;
    client_id: string;
    appointment_id?: string | null;
    encounter_id?: string | null;
    claim_id?: string | null;
    description?: string | null;
    context_payload?: Record<string, unknown>;
  },
) {
  if (!supabase) throw new Error("Database connection not available");

  const { data: existing, error: existingError } = await supabase
    .from("workqueue_items")
    .select("id")
    .eq("source_object_type", input.source_object_type)
    .eq("source_object_id", input.source_object_id)
    .eq("work_type", input.work_type)
    .in("status", ["open", "in_progress", "blocked"])
    .is("archived_at", null)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing) return { item: existing, status: "reused" as const };

  const now = new Date().toISOString();
  const payload = {
    id: generateUuid(),
    organization_id: input.organization_id,
    title: input.title,
    description: input.description ?? null,
    work_type: input.work_type,
    status: "open",
    priority: input.priority,
    source_object_type: input.source_object_type,
    source_object_id: input.source_object_id,
    client_id: input.client_id,
    appointment_id: input.appointment_id ?? null,
    encounter_id: input.encounter_id ?? null,
    claim_id: input.claim_id ?? null,
    context_payload: input.context_payload ?? {},
    created_at: now,
    updated_at: now,
  };

  const { data, error } = await supabase.from("workqueue_items").insert(payload).select().single();
  if (error) throw error;
  return { item: data, status: "created" as const };
}

export async function POST(request: Request) {
  // Restrict to admin role — this endpoint mutates the full billing lifecycle
  const authOrError = await requireRoleInRoute("admin");
  if (authOrError instanceof NextResponse) return authOrError;

  try {
    const supabase = createServerSupabaseAdminClientTyped();
    if (!supabase) return NextResponse.json({ error: "Database connection not available" }, { status: 500 });

    const body = await request.json();
    const appointmentId = body.appointmentId as string | undefined;
    const autoSign = body.autoSign !== false;
    const createMockStatusInquiry = body.createMockStatusInquiry !== false;
    const createMockPaymentImport = body.createMockPaymentImport !== false;
    const createPosting = body.createPosting !== false;
    const billedAmount = money(body.billedAmount ?? "150.00");
    const paidAmount = money(body.paidAmount ?? "120.00");
    const patientResponsibilityAmount = money(body.patientResponsibilityAmount ?? "30.00");

    if (!appointmentId) return NextResponse.json({ error: "appointmentId is required" }, { status: 400 });

    const steps: LifecycleStep[] = [];
    const now = new Date().toISOString();

    const { data: appointment, error: appointmentError } = await supabase
      .from("appointments")
      .select("*")
      .eq("id", appointmentId)
      .single();

    if (appointmentError || !appointment) return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
    if (!appointment.client_id) return NextResponse.json({ error: "Appointment is missing client_id" }, { status: 422 });
    if (!appointment.organization_id) return NextResponse.json({ error: "Appointment is missing organization_id" }, { status: 422 });

    steps.push({ step: "appointment", status: "reused", id: appointment.id, message: "Loaded appointment" });

    const serviceDate = appointment.scheduled_start_at
      ? new Date(appointment.scheduled_start_at).toISOString().split("T")[0]
      : now.split("T")[0];

    let encounter: DbRow;
    const { data: existingEncounter, error: existingEncounterError } = await supabase
      .from("encounters")
      .select("*")
      .eq("appointment_id", appointmentId)
      .is("archived_at", null)
      .maybeSingle();

    if (existingEncounterError) throw existingEncounterError;

    if (existingEncounter) {
      encounter = existingEncounter;
      steps.push({ step: "encounter", status: "reused", id: existingEncounter.id, message: "Encounter already exists" });
    } else {
      const { data: createdEncounter, error: createEncounterError } = await supabase
        .from("encounters")
        .insert({
          id: generateUuid(),
          organization_id: appointment.organization_id,
          client_id: appointment.client_id,
          provider_id: appointment.provider_id,
          appointment_id: appointmentId,
          encounter_status: "draft",
          service_date: serviceDate,
          started_at: appointment.scheduled_start_at ?? null,
          ended_at: appointment.scheduled_end_at ?? null,
          required_billing_fields_complete: false,
          created_at: now,
          updated_at: now,
        })
        .select()
        .single();

      if (createEncounterError) throw createEncounterError;
      if (!createdEncounter) throw new Error("Encounter creation returned no row");
      encounter = createdEncounter;
      steps.push({ step: "encounter", status: "created", id: createdEncounter.id, message: "Created draft encounter from appointment" });
    }

    await createWorkqueueItem(supabase, {
      organization_id: appointment.organization_id,
      title: "Encounter created - documentation needed",
      description: "Complete and sign the clinical note before claim creation.",
      work_type: "documentation_needed",
      priority: "medium",
      source_object_type: "encounter",
      source_object_id: encounter.id,
      client_id: appointment.client_id,
      appointment_id: appointmentId,
      encounter_id: encounter.id,
      context_payload: { lifecycle_step: "appointment_to_encounter" },
    });

    if (autoSign && encounter.encounter_status !== "signed") {
      const { data: signedEncounter, error: signError } = await supabase
        .from("encounters")
        .update({
          encounter_status: "signed",
          required_billing_fields_complete: true,
          updated_at: now,
        })
        .eq("id", encounter.id)
        .select()
        .single();

      if (signError) throw signError;
      if (!signedEncounter) throw new Error("Encounter signing returned no row");
      encounter = signedEncounter;
      steps.push({ step: "signed_note", status: "updated", id: signedEncounter.id, message: "Auto-signed encounter for lifecycle test" });
    } else {
      steps.push({
        step: "signed_note",
        status: encounter.encounter_status === "signed" ? "reused" : "skipped",
        id: encounter.id,
        message: encounter.encounter_status === "signed" ? "Encounter already signed" : "Encounter was not signed because autoSign=false",
      });
    }

    if (encounter.encounter_status !== "signed") {
      return NextResponse.json({
        success: false,
        error: "Encounter must be signed before claim creation",
        steps,
      }, { status: 422 });
    }

    let claim: DbRow;
    const { data: existingClaim, error: existingClaimError } = await supabase
      .from("professional_claims")
      .select("*")
      .eq("encounter_id", encounter.id)
      .maybeSingle();

    if (existingClaimError) throw existingClaimError;

    if (existingClaim) {
      claim = existingClaim;
      steps.push({ step: "claim", status: "reused", id: existingClaim.id, message: "Claim already exists" });
    } else {
      const claimNumber = `CLM-${Date.now()}`;
      const claimId = generateUuid();
      const mappedClaim = mapLegacyClaimInputToProfessionalClaim({
        id: claimId,
        organization_id: encounter.organization_id,
        client_id: encounter.client_id,
        encounter_id: encounter.id,
        claim_number: claimNumber,
        claim_status: "submitted",
        total_charge_amount: billedAmount,
      });

      const { data: createdClaim, error: claimError } = await supabase
        .from("professional_claims")
        .insert(mappedClaim)
        .select()
        .single();

      if (claimError) throw claimError;
      if (!createdClaim) throw new Error("Claim creation returned no row");
      claim = createdClaim;
      steps.push({ step: "claim", status: "created", id: createdClaim.id, message: "Created submitted claim from signed encounter" });
    }

    await createWorkqueueItem(supabase, {
      organization_id: claim.organization_id,
      title: `Claim ${claim.claim_number ?? claim.id} submitted - monitor status`,
      work_type: "claim_status_monitoring",
      priority: "medium",
      source_object_type: "claim",
      source_object_id: claim.id,
      client_id: claim.client_id,
      encounter_id: claim.encounter_id,
      claim_id: claim.id,
      context_payload: { lifecycle_step: "claim_submitted" },
    });

    let statusInquiry: DbRow | null = null;
    if (createMockStatusInquiry) {
      const { data: existingInquiry, error: existingInquiryError } = await supabase
        .from("claim_status_inquiries")
        .select("*")
        .eq("claim_id", claim.id)
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingInquiryError) throw existingInquiryError;

      if (existingInquiry) {
        statusInquiry = existingInquiry;
        steps.push({ step: "status_check", status: "reused", id: existingInquiry.id, message: "Claim status inquiry already exists" });
      } else {
        const { data: inquiry, error: inquiryError } = await supabase
          .from("claim_status_inquiries")
          .insert({
            id: generateUuid(),
            organization_id: claim.organization_id,
            claim_id: claim.id,
            client_id: claim.client_id,
            inquiry_status: "received",
            external_transaction_id: `276277-${Date.now()}`,
            duplicate_detection_key: `276-${claim.id}`,
            payer_status_code: "A1",
            payer_status_text: "Acknowledged/received for processing",
            response_summary: "Mock 277 response created by lifecycle test endpoint.",
            requested_at: now,
            received_at: now,
            created_at: now,
            updated_at: now,
          })
          .select()
          .single();

        if (inquiryError) throw inquiryError;
        if (!inquiry) throw new Error("Claim status inquiry creation returned no row");
        statusInquiry = inquiry;
        steps.push({ step: "status_check", status: "created", id: inquiry.id, message: "Created mock claim status inquiry" });
      }
    } else {
      steps.push({ step: "status_check", status: "skipped", message: "Skipped by request" });
    }

    await createWorkqueueItem(supabase, {
      organization_id: claim.organization_id,
      title: statusInquiry ? "Review latest claim status inquiry" : "Claim status inquiry needed",
      work_type: statusInquiry ? "claim_status_review" : "no_response",
      priority: "medium",
      source_object_type: "claim",
      source_object_id: claim.id,
      client_id: claim.client_id,
      encounter_id: claim.encounter_id,
      claim_id: claim.id,
      context_payload: { lifecycle_step: "status_check", claim_status_inquiry_id: statusInquiry?.id ?? null },
    });

    let paymentImportItem: DbRow | null = null;
    if (createMockPaymentImport) {
      const { data: existingPaymentImport, error: existingPaymentImportError } = await supabase
        .from("payment_import_items")
        .select("*")
        .eq("claim_id", claim.id)
        .is("archived_at", null)
        .maybeSingle();

      if (existingPaymentImportError) throw existingPaymentImportError;

      if (existingPaymentImport) {
        paymentImportItem = existingPaymentImport;
        steps.push({ step: "payment_import", status: "reused", id: existingPaymentImport.id, message: "Payment import item already exists" });
      } else {
        const { data: createdPaymentImport, error: paymentImportError } = await supabase
          .from("payment_import_items")
          .insert({
            id: generateUuid(),
            organization_id: claim.organization_id,
            client_id: claim.client_id,
            claim_id: claim.id,
            posting_ready: true,
            imported_item_ref: `835-${claim.claim_number ?? claim.id}`,
            payer_name: body.payerName ?? "Mock Payer",
            check_or_eft_number: `EFT-${Date.now()}`,
            billed_amount: billedAmount,
            paid_amount: paidAmount,
            patient_responsibility_amount: patientResponsibilityAmount,
            net_amount: paidAmount,
            source: "mock_835",
            created_at: now,
            updated_at: now,
          })
          .select()
          .single();

        if (paymentImportError) throw paymentImportError;
        if (!createdPaymentImport) throw new Error("Payment import creation returned no row");
        paymentImportItem = createdPaymentImport;
        steps.push({ step: "payment_import", status: "created", id: createdPaymentImport.id, message: "Created mock 835 payment import item" });
      }

      if (!paymentImportItem) throw new Error("Payment import item was not available after creation/reuse");
      const readyPaymentImportItem = paymentImportItem;

      await createWorkqueueItem(supabase, {
        organization_id: claim.organization_id,
        title: "Payment ready to post",
        work_type: "payment_posting_needed",
        priority: "medium",
        source_object_type: "payment_import_item",
        source_object_id: readyPaymentImportItem.id,
        client_id: claim.client_id,
        claim_id: claim.id,
        context_payload: { lifecycle_step: "payment_import", payment_import_item_id: readyPaymentImportItem.id },
      });
    } else {
      steps.push({ step: "payment_import", status: "skipped", message: "Skipped by request" });
    }

    let posting: DbRow | null = null;
    if (createPosting && paymentImportItem) {
      const { data: existingPosting, error: existingPostingError } = await supabase
        .from("payment_postings")
        .select("*")
        .eq("payment_import_item_id", paymentImportItem.id)
        .is("archived_at", null)
        .maybeSingle();

      if (existingPostingError) throw existingPostingError;

      if (existingPosting) {
        posting = existingPosting;
        steps.push({ step: "posting", status: "reused", id: existingPosting.id, message: "Payment posting already exists" });
      } else {
        const { data: createdPosting, error: postingError } = await supabase
          .from("payment_postings")
          .insert({
            id: generateUuid(),
            organization_id: claim.organization_id,
            payment_import_item_id: paymentImportItem.id,
            posting_status: "posted",
            posting_reference: `POST-${Date.now()}`,
            total_posted_amount: paidAmount,
            note: "Mock posting created by full lifecycle endpoint.",
            posted_at: now,
            created_at: now,
            updated_at: now,
          })
          .select()
          .single();

        if (postingError) throw postingError;
        if (!createdPosting) throw new Error("Payment posting creation returned no row");
        posting = createdPosting;
        steps.push({ step: "posting", status: "created", id: createdPosting.id, message: "Created posted payment posting" });
      }

      const { error: claimPaidError } = await supabase
        .from("professional_claims")
        .update({
          claim_status: "paid",
          updated_at: now,
        })
        .eq("id", claim.id);

      if (claimPaidError) throw claimPaidError;
      steps.push({ step: "claim_paid", status: "updated", id: claim.id, message: "Marked claim paid after posting" });
    } else {
      steps.push({ step: "posting", status: "skipped", message: "Skipped because payment import or createPosting was not available" });
    }

    return NextResponse.json({
      success: true,
      appointment_id: appointment.id,
      client_id: appointment.client_id,
      encounter_id: encounter.id,
      claim_id: claim.id,
      claim_status_inquiry_id: statusInquiry?.id ?? null,
      payment_import_item_id: paymentImportItem?.id ?? null,
      payment_posting_id: posting?.id ?? null,
      steps,
    });
  } catch (error) {
    console.error("Full lifecycle error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Full lifecycle failed" },
      { status: 500 },
    );
  }
}
