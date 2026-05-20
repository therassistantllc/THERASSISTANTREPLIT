import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  GAD7_QUESTIONS,
  PHQ9_QUESTIONS,
  gad7Severity,
  phq9Severity,
  scoreAnswers,
} from "@/lib/intake/scoring";

type Row = Record<string, unknown>;

function value(input: unknown) {
  return String(input ?? "").trim();
}

async function loadLink(supabase: ReturnType<typeof createServerSupabaseAdminClient>, token: string) {
  if (!supabase) return { error: "Database connection not available", status: 500 as const };
  const { data, error } = await supabase
    .from("intake_links")
    .select("id, organization_id, client_id, token, status, expires_at, used_at")
    .eq("token", token)
    .maybeSingle();
  if (error) return { error: error.message, status: 500 as const };
  if (!data) return { error: "Intake link not found", status: 404 as const };
  const row = data as Row;
  const expiresAt = row.expires_at ? new Date(value(row.expires_at)) : null;
  if (value(row.status) !== "pending") {
    return { error: `Intake link is ${value(row.status)}`, status: 410 as const };
  }
  if (expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() < Date.now()) {
    await supabase.from("intake_links").update({ status: "expired" }).eq("id", value(row.id));
    return { error: "Intake link has expired", status: 410 as const };
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
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }
    const link = result.link;
    const { data: client } = await supabase!
      .from("clients")
      .select(
        "id, first_name, last_name, preferred_name, date_of_birth, email, phone, address_line_1, address_line_2, city, state, postal_code",
      )
      .eq("id", value(link.client_id))
      .single();

    const { data: org } = await supabase!
      .from("organizations")
      .select("id, name")
      .eq("id", value(link.organization_id))
      .single();

    const clientRow = (client ?? {}) as Row;
    const orgRow = (org ?? {}) as Row;

    return NextResponse.json({
      success: true,
      organization: { id: value(orgRow.id), name: value(orgRow.name) || "Your provider" },
      client: {
        id: value(clientRow.id),
        firstName: value(clientRow.first_name),
        lastName: value(clientRow.last_name),
        preferredName: clientRow.preferred_name ?? null,
        dateOfBirth: clientRow.date_of_birth ?? null,
        email: clientRow.email ?? null,
        phone: clientRow.phone ?? null,
        addressLine1: clientRow.address_line_1 ?? null,
        addressLine2: clientRow.address_line_2 ?? null,
        city: clientRow.city ?? null,
        state: clientRow.state ?? null,
        postalCode: clientRow.postal_code ?? null,
      },
      form: {
        phq9Questions: PHQ9_QUESTIONS,
        gad7Questions: GAD7_QUESTIONS,
        consents: [
          { code: "hipaa", label: "HIPAA Notice of Privacy Practices" },
          { code: "telehealth", label: "Telehealth Informed Consent" },
          { code: "roi", label: "Release of Information (optional)", optional: true },
        ],
      },
      token,
      expiresAt: link.expires_at ?? null,
    });
  } catch (error) {
    console.error("Intake load error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load intake" },
      { status: 500 },
    );
  }
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
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }
    const link = result.link;
    const organizationId = value(link.organization_id);
    const clientId = value(link.client_id);

    const payload = (await request.json().catch(() => null)) as Row | null;
    if (!payload) {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const demographics = (payload.demographics ?? {}) as Row;
    const insuranceInput = (payload.insurance ?? {}) as Row;
    const consents = (payload.consents ?? {}) as Row;
    const screeners = (payload.screeners ?? {}) as Row;
    const signatureName = value(payload.signatureName);

    const MAX_CARD_BYTES = 6 * 1024 * 1024; // ~6 MB base64 budget
    const ALLOWED_IMAGE_PREFIXES = [
      "data:image/png;base64,",
      "data:image/jpeg;base64,",
      "data:image/jpg;base64,",
      "data:image/webp;base64,",
      "data:image/gif;base64,",
    ];

    function sanitizeCard(input: unknown): { name: string | null; type: string | null; content: string } | null {
      if (!input || typeof input !== "object") return null;
      const obj = input as Row;
      const content = typeof obj.content === "string" ? obj.content : "";
      if (!content) return null;
      if (content.length > MAX_CARD_BYTES) return null;
      const lower = content.toLowerCase();
      if (!ALLOWED_IMAGE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return null;
      const type = typeof obj.type === "string" && obj.type.startsWith("image/") ? obj.type : null;
      const rawName = typeof obj.name === "string" ? obj.name : null;
      const name = rawName ? rawName.replace(/[\r\n<>"'`]/g, "").slice(0, 200) : null;
      return { name, type, content };
    }

    const insurance: Row = {
      planName: value(insuranceInput.planName),
      policyNumber: value(insuranceInput.policyNumber),
      groupNumber: value(insuranceInput.groupNumber),
      subscriberRelationship: value(insuranceInput.subscriberRelationship) || "self",
      cardFront: sanitizeCard(insuranceInput.cardFront),
      cardBack: sanitizeCard(insuranceInput.cardBack),
    };

    if (!signatureName) {
      return NextResponse.json({ success: false, error: "A typed signature is required" }, { status: 400 });
    }
    if (consents.hipaa !== true || consents.telehealth !== true) {
      return NextResponse.json(
        { success: false, error: "HIPAA and Telehealth consents are required" },
        { status: 400 },
      );
    }

    const phq9 = scoreAnswers(screeners.phq9, PHQ9_QUESTIONS.length);
    const gad7 = scoreAnswers(screeners.gad7, GAD7_QUESTIONS.length);

    const now = new Date().toISOString();

    // Persist the submission first so a transient DB error on the write path
    // does not consume the one-time link. The link is only marked completed
    // after the submission is durably stored.
    const { data: submission, error: subErr } = await supabase!
      .from("intake_submissions")
      .insert({
        organization_id: organizationId,
        client_id: clientId,
        intake_link_id: value(link.id),
        status: "submitted",
        demographics,
        insurance,
        consents,
        screeners,
        signature_name: signatureName,
        signature_signed_at: now,
        phq9_score: phq9,
        gad7_score: gad7,
        phq9_severity: phq9Severity(phq9),
        gad7_severity: gad7Severity(gad7),
        submitted_at: now,
      })
      .select("id")
      .single();

    if (subErr || !submission) throw subErr ?? new Error("Failed to save intake submission");
    const submissionId = value((submission as Row).id);

    // Now atomically claim the link by flipping pending -> completed. Only
    // one concurrent submitter can win this update; the loser's submission
    // row is deleted so the chart does not show duplicates.
    const { data: claimed, error: claimErr } = await supabase!
      .from("intake_links")
      .update({ status: "completed", used_at: now, submission_id: submissionId })
      .eq("id", value(link.id))
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimErr) {
      await supabase!.from("intake_submissions").delete().eq("id", submissionId);
      throw claimErr;
    }
    if (!claimed) {
      await supabase!.from("intake_submissions").delete().eq("id", submissionId);
      return NextResponse.json(
        { success: false, error: "Intake link has already been used" },
        { status: 410 },
      );
    }

    // Patch client demographics & address from intake answers (only when provided)
    const clientPatch: Row = {};
    const dem = demographics;
    if (value(dem.firstName)) clientPatch.first_name = value(dem.firstName);
    if (value(dem.lastName)) clientPatch.last_name = value(dem.lastName);
    if (value(dem.preferredName)) clientPatch.preferred_name = value(dem.preferredName);
    if (value(dem.dateOfBirth)) clientPatch.date_of_birth = value(dem.dateOfBirth);
    if (value(dem.email)) clientPatch.email = value(dem.email);
    if (value(dem.phone)) clientPatch.phone = value(dem.phone);
    if (value(dem.pronouns)) clientPatch.pronouns = value(dem.pronouns);
    if (value(dem.addressLine1)) clientPatch.address_line_1 = value(dem.addressLine1);
    if (value(dem.addressLine2)) clientPatch.address_line_2 = value(dem.addressLine2);
    if (value(dem.city)) clientPatch.city = value(dem.city);
    if (value(dem.state)) clientPatch.state = value(dem.state);
    if (value(dem.postalCode)) clientPatch.postal_code = value(dem.postalCode);
    clientPatch.intake_status = "complete";

    await supabase!.from("clients").update(clientPatch).eq("id", clientId);

    // Create or update primary insurance policy if provided
    const planName = value(insurance.planName);
    const policyNumber = value(insurance.policyNumber);
    if (planName && policyNumber) {
      const { data: existing } = await supabase!
        .from("insurance_policies")
        .select("id")
        .eq("client_id", clientId)
        .eq("priority", "primary")
        .maybeSingle();
      const policyRow: Row = {
        organization_id: organizationId,
        client_id: clientId,
        priority: "primary",
        plan_name: planName,
        policy_number: policyNumber,
        group_number: value(insurance.groupNumber) || null,
        subscriber_relationship: value(insurance.subscriberRelationship) || "self",
        active_flag: true,
      };
      if (existing && (existing as Row).id) {
        await supabase!
          .from("insurance_policies")
          .update(policyRow)
          .eq("id", value((existing as Row).id));
      } else {
        await supabase!.from("insurance_policies").insert(policyRow);
      }
    }

    return NextResponse.json({
      success: true,
      submissionId,
      scores: {
        phq9: { score: phq9, severity: phq9Severity(phq9) },
        gad7: { score: gad7, severity: gad7Severity(gad7) },
      },
    });
  } catch (error) {
    console.error("Intake submit error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to submit intake" },
      { status: 500 },
    );
  }
}
