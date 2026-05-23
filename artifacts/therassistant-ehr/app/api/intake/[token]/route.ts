import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  GAD7_QUESTIONS,
  PHQ9_QUESTIONS,
  gad7Severity,
  phq9Severity,
  scoreAnswers,
} from "@/lib/intake/scoring";
import { writeChartObjectAuditLogs } from "@/lib/audit/chartObjectAudit";
import { upsertPolicyFromIntake } from "@/lib/intake/upsertPolicyFromIntake";

type Row = Record<string, unknown>;

const INTAKE_POLICY_COLUMN_LABELS: Record<string, string> = {
  plan_name: "Plan name",
  policy_number: "Policy number",
  group_number: "Group number",
  subscriber_relationship: "Subscriber relationship",
  priority: "Priority",
  active_flag: "Active",
};

function policySnapshot(row: Row | null): Record<string, string | null> {
  if (!row) {
    return {
      plan_name: null,
      policy_number: null,
      group_number: null,
      subscriber_relationship: null,
      priority: null,
      active_flag: null,
    };
  }
  const asNullableString = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean") return v ? "true" : "false";
    const s = String(v).trim();
    return s.length > 0 ? s : null;
  };
  return {
    plan_name: asNullableString(row.plan_name),
    policy_number: asNullableString(row.policy_number),
    group_number: asNullableString(row.group_number),
    subscriber_relationship: asNullableString(row.subscriber_relationship),
    priority: asNullableString(row.priority),
    active_flag: asNullableString(row.active_flag),
  };
}

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
    const CARD_BUCKET = "intake-card-images";

    type SanitizedCard = {
      name: string | null;
      type: string | null;
      content: string;
      bytes: Buffer;
      extension: string;
    };

    function sanitizeCard(input: unknown): SanitizedCard | null {
      if (!input || typeof input !== "object") return null;
      const obj = input as Row;
      const content = typeof obj.content === "string" ? obj.content : "";
      if (!content) return null;
      if (content.length > MAX_CARD_BYTES) return null;
      const lower = content.toLowerCase();
      const matched = ALLOWED_IMAGE_PREFIXES.find((prefix) => lower.startsWith(prefix));
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
      const type = typeof obj.type === "string" && obj.type.startsWith("image/") ? obj.type : null;
      const rawName = typeof obj.name === "string" ? obj.name : null;
      const name = rawName ? rawName.replace(/[\r\n<>"'`]/g, "").slice(0, 200) : null;
      const extension = matched.includes("png")
        ? "png"
        : matched.includes("webp")
          ? "webp"
          : matched.includes("gif")
            ? "gif"
            : "jpg";
      return { name, type, content, bytes, extension };
    }

    const cardFrontSanitized = sanitizeCard(insuranceInput.cardFront);
    const cardBackSanitized = sanitizeCard(insuranceInput.cardBack);

    const insurance: Row = {
      planName: value(insuranceInput.planName),
      policyNumber: value(insuranceInput.policyNumber),
      groupNumber: value(insuranceInput.groupNumber),
      subscriberRelationship: value(insuranceInput.subscriberRelationship) || "self",
      // cardFront/cardBack are populated below after the storage upload so
      // we never persist base64 image content in the database.
      cardFront: null as unknown,
      cardBack: null as unknown,
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

    // Upload insurance card photos (if any) to private object storage and
    // record the storage references inside the submission's insurance JSON.
    // We do this AFTER the link is claimed so a failed/duplicate submission
    // never leaves orphaned blobs in the bucket.
    type StoredCard = {
      bucket: string;
      path: string;
      name: string | null;
      type: string | null;
      uploadedAt: string;
    };
    async function uploadCard(
      side: "front" | "back",
      card: SanitizedCard | null,
    ): Promise<StoredCard | null> {
      if (!card) return null;
      const objectPath = `${organizationId}/${submissionId}/${side}.${card.extension}`;
      const contentType = card.type ?? `image/${card.extension === "jpg" ? "jpeg" : card.extension}`;
      const { error: uploadErr } = await supabase!.storage
        .from(CARD_BUCKET)
        .upload(objectPath, card.bytes, {
          contentType,
          upsert: true,
        });
      if (uploadErr) {
        console.error(`Intake card upload failed (${side}):`, uploadErr.message);
        return null;
      }
      return {
        bucket: CARD_BUCKET,
        path: objectPath,
        name: card.name,
        type: contentType,
        uploadedAt: now,
      };
    }

    const [storedFront, storedBack] = await Promise.all([
      uploadCard("front", cardFrontSanitized),
      uploadCard("back", cardBackSanitized),
    ]);

    if (storedFront || storedBack) {
      const updatedInsurance: Row = {
        ...insurance,
        cardFront: storedFront,
        cardBack: storedBack,
      };
      const { error: insUpdateErr } = await supabase!
        .from("intake_submissions")
        .update({ insurance: updatedInsurance })
        .eq("id", submissionId);
      if (insUpdateErr) {
        console.error("Failed to attach card references to submission:", insUpdateErr.message);
      }
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

    // Create or update primary insurance policy if provided. Uses the
    // race-safe upsert helper so two near-simultaneous intake submits
    // (slow-network retry, double-click, second tab) converge on a
    // single insurance_policies row instead of producing two "primary"
    // policies. See lib/intake/upsertPolicyFromIntake.ts and migration
    // 20260602000000_insurance_policies_intake_dedupe_unique.sql.
    const planName = value(insurance.planName);
    const policyNumber = value(insurance.policyNumber);
    if (planName && policyNumber) {
      // Capture the pre-upsert snapshot so the audit log (added in the
      // chart-object audit work) can record before/after diffs. The
      // upsert helper itself is race-safe: two near-simultaneous intake
      // submits converge on a single row via the partial unique index +
      // 23505 catch instead of creating a duplicate "primary" policy.
      const { data: existing } = await supabase!
        .from("insurance_policies")
        .select(
          "id, plan_name, policy_number, group_number, subscriber_relationship, priority, active_flag",
        )
        .eq("client_id", clientId)
        .eq("priority", "primary")
        .maybeSingle();
      const policyFields = {
        organization_id: organizationId,
        client_id: clientId,
        priority: "primary" as const,
        plan_name: planName,
        policy_number: policyNumber,
        group_number: value(insurance.groupNumber) || null,
        subscriber_relationship: value(insurance.subscriberRelationship) || "self",
        active_flag: true,
      };
      const upsert = await upsertPolicyFromIntake(
        supabase! as unknown as Parameters<typeof upsertPolicyFromIntake>[0],
        policyFields,
      );
      if (!upsert.ok) {
        console.error("Intake policy upsert failed:", upsert.error);
      } else {
        const afterSnapshot = policySnapshot(policyFields as unknown as Row);
        const policyId = upsert.policyId;
        if (policyId) {
          const wasExisting = !!(existing && (existing as Row).id);
          const beforeSnapshot = wasExisting
            ? policySnapshot(existing as Row)
            : policySnapshot(null);
          const action = wasExisting
            ? "insurance_policy_updated"
            : "insurance_policy_created";
          try {
            await writeChartObjectAuditLogs({
              supabase: supabase!,
              organizationId,
              patientId: clientId,
              staff: null,
              objectType: "insurance_policy",
              objectId: policyId,
              action,
              objectLabel: "Insurance policy",
              before: beforeSnapshot,
              after: afterSnapshot,
              columnLabels: INTAKE_POLICY_COLUMN_LABELS,
              contextMetadata: { source: "intake_form" },
            });
          } catch (auditError) {
            console.error(
              `[intake.submit] audit log insert failed after policy ${wasExisting ? "update" : "create"}`,
              auditError instanceof Error ? auditError.message : auditError,
            );
          }
        }
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
