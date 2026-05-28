import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";
import { generateCoverLetterPdf, type CoverLetterAttachment } from "@/lib/pdf/coverLetter";
import {
  sendPayerDocumentationEmail,
  type PayerDocumentationAttachment,
} from "@/lib/email/resend";
import {
  buildSubmissionPacket,
  type PacketAttachmentInput,
} from "@/lib/pdf/submissionPacket";

const COVER_LETTER_BUCKET = "mailroom-documents";

async function ensureCoverLetterBucket(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
): Promise<void> {
  if (!supabase) return;
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (buckets && buckets.some((b) => b.name === COVER_LETTER_BUCKET)) return;
    const { error } = await supabase.storage.createBucket(COVER_LETTER_BUCKET, {
      public: false,
      fileSizeLimit: 25 * 1024 * 1024,
    });
    if (error && !/already exists/i.test(error.message)) {
      console.warn(`[cover-letter] ensure bucket failed: ${error.message}`);
    }
  } catch (err) {
    console.warn(
      `[cover-letter] ensure bucket exception: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

type ActionName =
  | "attach_records"
  | "send_documentation"
  | "create_cover_letter"
  | "download_submission_packet"
  | "route_to_clinician"
  | "route_to_admin"
  | "assign_biller"
  | "set_follow_up"
  | "mark_submitted";

interface ActionBody {
  organizationId?: string;
  action?: ActionName;
  claimId?: string;
  clientId?: string | null;
  appointmentId?: string | null;
  providerId?: string | null;
  billerId?: string | null;
  followUpDueAt?: string | null;
  note?: string;
  documentTitles?: string[];
  /**
   * For `download_submission_packet`: optional subset of claim
   * `documents.id`s to include. If omitted, every non-archived attachment
   * on the claim (other than previously-generated packets/cover letters)
   * is bundled.
   */
  documentIds?: string[];
  recipientEmail?: string;
  payerAttention?: string | null;
}

async function writeAuditStrict(
  supabase: ReturnType<typeof createServerSupabaseAdminClient>,
  args: {
    organizationId: string;
    userId: string | null;
    action: string;
    claimId: string;
    clientId: string | null;
    appointmentId: string | null;
    summary: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: "Database connection not available" };
  try {
    const { error } = await (
      supabase as unknown as {
        from: (t: string) => {
          insert: (v: unknown) => Promise<{ error: { message?: string } | null }>;
        };
      }
    )
      .from("audit_logs")
      .insert({
        organization_id: args.organizationId,
        user_id: args.userId,
        action: args.action,
        event_type: "medical_review_workqueue",
        event_summary: args.summary,
        event_metadata: args.metadata ?? {},
        appointment_id: args.appointmentId,
        claim_id: args.claimId,
        patient_id: args.clientId,
        object_type: "professional_claim",
        object_id: args.claimId,
      });
    if (error) return { ok: false, error: error.message ?? "audit_logs insert failed" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "audit_logs insert failed" };
  }
}

export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }
    const body = (await request.json()) as ActionBody;
    const guard = await requireBillingAccess({ requestedOrganizationId: body.organizationId });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const userId = guard.userId;

    const action = body.action;
    const claimId = body.claimId ?? "";
    const note = (body.note ?? "").trim();

    if (!action || !claimId) {
      return NextResponse.json(
        { success: false, error: "action and claimId are required" },
        { status: 400 },
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as unknown as { from: (t: string) => any };

    // Validate the claim exists in the caller's org BEFORE any audit write.
    const { data: claim, error: claimErr } = await sb
      .from("professional_claims")
      .select("id, patient_id, appointment_id, billing_notes, claim_number, payer_profile_id, total_charge, encounter_id")
      .eq("id", claimId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (claimErr) {
      return NextResponse.json(
        { success: false, error: claimErr.message ?? "Failed to look up claim" },
        { status: 500 },
      );
    }
    if (!claim) {
      return NextResponse.json(
        { success: false, error: "Claim not found in this organization" },
        { status: 404 },
      );
    }
    const clientId = body.clientId ?? (claim.patient_id as string | null) ?? null;
    const appointmentId = body.appointmentId ?? (claim.appointment_id as string | null) ?? null;

    switch (action) {
      case "attach_records": {
        const titles = (body.documentTitles ?? []).map((s) => String(s).trim()).filter(Boolean);
        const audit = await writeAuditStrict(supabase, {
          organizationId, userId,
          action: "medical_review_records_attached",
          claimId, clientId, appointmentId,
          summary: note || `Attached ${titles.length || 0} document(s) to claim`,
          metadata: { documentTitles: titles, note },
        });
        if (!audit.ok) return NextResponse.json({ success: false, error: audit.error }, { status: 500 });
        return NextResponse.json({ success: true, attached: titles });
      }
      case "send_documentation": {
        const recipientOverride = (body.recipientEmail ?? "").trim();

        // Pull payer contact + practice/client snapshot for the email body.
        const [{ data: payer }, { data: org }, { data: client }, { data: appt }] =
          await Promise.all([
            claim.payer_profile_id
              ? sb.from("payer_profiles")
                  .select("payer_name, records_email, records_fax, claims_fax")
                  .eq("id", claim.payer_profile_id)
                  .eq("organization_id", organizationId)
                  .maybeSingle()
              : Promise.resolve({ data: null }),
            sb.from("organizations").select("name").eq("id", organizationId).maybeSingle(),
            clientId
              ? sb.from("clients")
                  .select("first_name, last_name")
                  .eq("id", clientId)
                  .eq("organization_id", organizationId)
                  .maybeSingle()
              : Promise.resolve({ data: null }),
            appointmentId
              ? sb.from("appointments")
                  .select("scheduled_start_at")
                  .eq("id", appointmentId)
                  .eq("organization_id", organizationId)
                  .maybeSingle()
              : Promise.resolve({ data: null }),
          ]);

        const payerName = (payer?.payer_name as string | null) || "Insurance Payer";
        const recordsEmail = (payer?.records_email as string | null)?.trim() || "";
        const recordsFax =
          (payer?.records_fax as string | null)?.trim() ||
          (payer?.claims_fax as string | null)?.trim() ||
          "";

        const recipient = recipientOverride || recordsEmail || recordsFax;
        if (!recipient) {
          return NextResponse.json(
            {
              success: false,
              error: `No documentation contact on file for ${payerName}. Add a records email or fax to the payer profile, or pass recipientEmail.`,
            },
            { status: 400 },
          );
        }

        const looksLikeEmail = recipient.includes("@");
        const channel: "email" | "fax" = looksLikeEmail ? "email" : "fax";

        // Gather all non-archived documents on this claim plus the most
        // recent cover letter (which is also a row in documents, but we
        // pull it out so it can lead the attachment list).
        const { data: docRows, error: docsErr } = await sb
          .from("documents")
          .select("id, title, file_name, mime_type, storage_bucket, storage_path, document_type, created_at")
          .eq("organization_id", organizationId)
          .eq("claim_id", claimId)
          .is("archived_at", null)
          .order("created_at", { ascending: false })
          .limit(50);
        if (docsErr) {
          return NextResponse.json(
            { success: false, error: docsErr.message ?? "Failed to load attached documents" },
            { status: 500 },
          );
        }

        type DocRow = {
          id: string;
          title: string | null;
          file_name: string | null;
          mime_type: string | null;
          storage_bucket: string | null;
          storage_path: string | null;
          document_type: string | null;
          created_at: string | null;
        };
        const allDocs = ((docRows ?? []) as DocRow[]).filter(
          (d) => d.storage_bucket && d.storage_path,
        );
        if (allDocs.length === 0) {
          return NextResponse.json(
            {
              success: false,
              error: "No documents are attached to this claim. Upload or attach records before sending.",
            },
            { status: 400 },
          );
        }
        // Sort so the cover letter (if any) comes first.
        allDocs.sort((a, b) => {
          const ac = a.document_type === "cover_letter" ? 0 : 1;
          const bc = b.document_type === "cover_letter" ? 0 : 1;
          return ac - bc;
        });

        const sentAt = new Date();
        const fileList = allDocs.map((d) => ({
          id: String(d.id),
          title: d.title || d.file_name || "Document",
          fileName: d.file_name || "document",
          documentType: d.document_type ?? null,
          mimeType: d.mime_type ?? null,
        }));
        const documentIds = allDocs.map((d) => String(d.id));

        // Seed a transmission row up front so even a failure is recorded.
        const baseTransmission = {
          organization_id: organizationId,
          claim_id: claimId,
          payer_profile_id: (claim.payer_profile_id as string | null) ?? null,
          channel,
          recipient,
          document_ids: documentIds,
          file_list: fileList,
          note: note || null,
          created_by_user_id: userId,
        };

        let transmissionStatus: "sent" | "failed" | "queued" = channel === "email" ? "queued" : "queued";
        let transmissionError: string | null = null;
        let providerMessageId: string | null = null;

        if (channel === "email") {
          // Download each file from storage as a Buffer for the email.
          const attachments: PayerDocumentationAttachment[] = [];
          for (const d of allDocs) {
            const { data: blob, error: dlErr } = await supabase.storage
              .from(String(d.storage_bucket))
              .download(String(d.storage_path));
            if (dlErr || !blob) {
              transmissionError = `Failed to download ${d.file_name ?? d.id}: ${dlErr?.message ?? "unknown error"}`;
              transmissionStatus = "failed";
              break;
            }
            const arrayBuf = await blob.arrayBuffer();
            attachments.push({
              filename: d.file_name || `${d.title || "document"}.bin`,
              content: Buffer.from(arrayBuf),
            });
          }

          if (transmissionStatus !== "failed") {
            const firstName = client ? String((client as { first_name?: unknown }).first_name ?? "").trim() : "";
            const lastName = client ? String((client as { last_name?: unknown }).last_name ?? "").trim() : "";
            const patientName = `${firstName} ${lastName}`.trim() || "Unknown client";
            const result = await sendPayerDocumentationEmail({
              to: recipient,
              payerName,
              practiceName: (org?.name as string | null) || "Billing office",
              claimNumber: (claim.claim_number as string | null) || claimId,
              patientName,
              dateOfService: appt ? ((appt as { scheduled_start_at?: string | null }).scheduled_start_at ?? null) : null,
              note: note || null,
              attachments,
            });
            if (result.ok) {
              transmissionStatus = "sent";
              providerMessageId = result.providerId;
            } else {
              transmissionStatus = "failed";
              transmissionError = result.error;
            }
          }
        } else {
          // Fax channel: queue a row in fax_queue so the existing
          // outbound-fax worker picks it up. The attachment files
          // themselves are referenced by name in the body; the fax
          // worker resolves them from storage via document_ids on the
          // transmission row (file_list also carries titles for ops).
          const subject = `Records — claim ${(claim.claim_number as string | null) || claimId}`;
          const bodyText =
            `Attached: ${fileList.length} file(s) for claim ${(claim.claim_number as string | null) || claimId}.\n` +
            fileList.map((f) => `• ${f.title} (${f.fileName})`).join("\n") +
            (note ? `\n\nNotes: ${note}` : "");
          const { data: faxRow, error: faxErr } = await sb
            .from("fax_queue")
            .insert({
              organization_id: organizationId,
              claim_id: claimId,
              to_fax_number: recipient,
              subject,
              body: bodyText,
              status: "pending",
              created_by_user_id: userId,
            })
            .select("id")
            .single();
          if (faxErr) {
            transmissionStatus = "failed";
            transmissionError = faxErr.message ?? "fax_queue insert failed";
          } else {
            transmissionStatus = "queued";
            providerMessageId = faxRow ? String(faxRow.id) : null;
          }
        }

        const { data: transmission, error: txErr } = await sb
          .from("claim_documentation_transmissions")
          .insert({
            ...baseTransmission,
            status: transmissionStatus,
            provider_message_id: providerMessageId,
            error: transmissionError,
            sent_at: transmissionStatus === "sent" ? sentAt.toISOString() : null,
          })
          .select("id")
          .single();
        if (txErr) {
          return NextResponse.json(
            { success: false, error: txErr.message ?? "Failed to record transmission" },
            { status: 500 },
          );
        }

        const summary =
          transmissionStatus === "sent"
            ? `Sent ${fileList.length} document(s) to ${recipient}`
            : transmissionStatus === "queued"
              ? `Queued ${fileList.length} document(s) for ${channel} to ${recipient}`
              : `Failed to send documentation to ${recipient}: ${transmissionError ?? "unknown error"}`;

        const audit = await writeAuditStrict(supabase, {
          organizationId, userId,
          action: "medical_review_documentation_sent",
          claimId, clientId, appointmentId,
          summary: note ? `${summary} — ${note}` : summary,
          metadata: {
            recipient,
            channel,
            status: transmissionStatus,
            transmissionId: transmission ? String(transmission.id) : null,
            providerMessageId,
            error: transmissionError,
            fileList,
            note,
          },
        });
        if (!audit.ok) return NextResponse.json({ success: false, error: audit.error }, { status: 500 });

        if (transmissionStatus === "failed") {
          return NextResponse.json(
            {
              success: false,
              error: transmissionError ?? "Send failed",
              transmissionId: transmission ? String(transmission.id) : null,
              channel,
              recipient,
              fileList,
              status: transmissionStatus,
            },
            { status: 502 },
          );
        }

        return NextResponse.json({
          success: true,
          sentAt: transmissionStatus === "sent" ? sentAt.toISOString() : null,
          channel,
          recipient,
          fileList,
          status: transmissionStatus,
          transmissionId: transmission ? String(transmission.id) : null,
          providerMessageId,
        });
      }
      case "create_cover_letter": {
        // Hydrate the bits we need to populate the letter. Each lookup is
        // best-effort so a missing payer / client doesn't block letter
        // generation — we fall back to placeholders.
        const [
          { data: org },
          { data: client },
          { data: payer },
          { data: appt },
          { data: existingDocs },
          { data: billingProfileRow },
        ] = await Promise.all([
          sb.from("organizations").select("name").eq("id", organizationId).maybeSingle(),
          clientId
            ? sb.from("clients")
                .select("first_name, last_name, date_of_birth")
                .eq("id", clientId)
                .eq("organization_id", organizationId)
                .maybeSingle()
            : Promise.resolve({ data: null }),
          claim.payer_profile_id
            ? sb.from("payer_profiles")
                .select("payer_name")
                .eq("id", claim.payer_profile_id)
                .eq("organization_id", organizationId)
                .maybeSingle()
            : Promise.resolve({ data: null }),
          appointmentId
            ? sb.from("appointments")
                .select("scheduled_start_at, provider_id")
                .eq("id", appointmentId)
                .eq("organization_id", organizationId)
                .maybeSingle()
            : Promise.resolve({ data: null }),
          sb.from("documents")
            .select("title, file_name, document_type")
            .eq("organization_id", organizationId)
            .eq("claim_id", claimId)
            .is("archived_at", null)
            .order("created_at", { ascending: false })
            .limit(50),
          sb.from("system_settings")
            .select("setting_value")
            .eq("organization_id", organizationId)
            .eq("setting_key", "organization.billing_profile")
            .maybeSingle(),
        ]);

        // Unpack the billing profile so the letterhead has a real address,
        // phone, fax, email, and optional logo to render — not just the org
        // name. Each piece is optional; missing values simply omit the line.
        const billingProfile: Record<string, unknown> =
          billingProfileRow?.setting_value &&
          typeof billingProfileRow.setting_value === "object" &&
          !Array.isArray(billingProfileRow.setting_value)
            ? (billingProfileRow.setting_value as Record<string, unknown>)
            : {};
        const bpStr = (k: string): string | null => {
          const v = billingProfile[k];
          return typeof v === "string" && v.trim() ? v.trim() : null;
        };
        const letterheadName =
          bpStr("billing_provider_name") || (org?.name as string | null) || "Billing Office";
        const addrLine1 = bpStr("billing_address_line1");
        const addrLine2 = bpStr("billing_address_line2");
        const city = bpStr("billing_city");
        const stateCode = bpStr("billing_state");
        const zip = bpStr("billing_zip");
        const cityStateZip = [city, stateCode].filter(Boolean).join(", ");
        const cityStateZipLine = [cityStateZip, zip].filter(Boolean).join(" ");
        const addressLines = [addrLine1, addrLine2, cityStateZipLine].filter(Boolean);
        const organizationAddress = addressLines.length ? addressLines.join("\n") : null;
        const organizationPhone = bpStr("billing_phone");
        const organizationFax = bpStr("billing_fax");
        const organizationEmail = bpStr("billing_email");

        // Optional logo — fetch bytes from storage; non-JPEG / missing files
        // are silently skipped so a broken logo never blocks the letter.
        const logoBucket = bpStr("letterhead_logo_bucket");
        const logoPath = bpStr("letterhead_logo_path");
        // Defense in depth: only dereference the logo through the admin
        // storage client when it lives in the canonical letterhead scope
        // (dedicated bucket + this org's letterhead/ prefix). This stops a
        // tampered billing_profile from pointing the cover-letter render at
        // an unrelated storage object.
        const LOGO_BUCKET_ALLOWED = "organization-assets";
        const logoPrefix = `${organizationId}/letterhead/`;
        const logoLocationOk =
          !!logoBucket &&
          !!logoPath &&
          logoBucket === LOGO_BUCKET_ALLOWED &&
          logoPath.startsWith(logoPrefix) &&
          !logoPath.includes("..");
        let logoJpegBytes: Uint8Array | null = null;
        if (logoLocationOk) {
          try {
            const { data: blob, error: dlErr } = await supabase.storage
              .from(logoBucket)
              .download(logoPath);
            if (!dlErr && blob) {
              logoJpegBytes = new Uint8Array(await blob.arrayBuffer());
            }
          } catch (e) {
            console.warn(
              `[cover-letter] logo download failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }

        let providerName: string | null = null;
        const providerId = appt ? String(appt.provider_id ?? "") : "";
        if (providerId) {
          const { data: prov } = await sb
            .from("providers")
            .select("first_name, last_name")
            .eq("id", providerId)
            .eq("organization_id", organizationId)
            .maybeSingle();
          if (prov) {
            const fn = String(prov.first_name ?? "").trim();
            const ln = String(prov.last_name ?? "").trim();
            providerName = `${fn} ${ln}`.trim() || null;
          }
        }

        // Distinguish "caller didn't specify" from "caller intentionally sent
        // an empty list". When the modal posts an explicit array (even empty)
        // it is authoritative; only fall back to existing claim docs when no
        // array was supplied at all.
        const titlesProvided = Array.isArray(body.documentTitles);
        const titlesFromBody = (body.documentTitles ?? [])
          .map((s) => String(s).trim())
          .filter(Boolean);
        const attachments: CoverLetterAttachment[] = titlesProvided
          ? titlesFromBody.map((t) => ({ title: t }))
          : ((existingDocs ?? []) as Array<{
              title: string | null;
              file_name: string | null;
              document_type: string | null;
            }>).map((d) => ({
              title: d.title || d.file_name || "Document",
              description: d.document_type ?? null,
            }));

        const clientFirst = client ? String(client.first_name ?? "").trim() : "";
        const clientLast = client ? String(client.last_name ?? "").trim() : "";
        const clientFullName =
          `${clientFirst} ${clientLast}`.trim() || "Unknown client";
        const clientDob = client ? (client.date_of_birth as string | null) : null;
        const orgName = letterheadName;
        const payerName = (payer?.payer_name as string | null) || "Insurance Payer";
        const claimNumber = (claim.claim_number as string | null) || claimId;
        const dos = appt ? (appt.scheduled_start_at as string | null) : null;
        const totalCharge = Number(claim.total_charge ?? 0);

        const generatedAt = new Date();
        let pdfBytes: Uint8Array;
        try {
          const payerAttention = (body.payerAttention ?? "").trim() || null;
          pdfBytes = generateCoverLetterPdf({
            organizationName: orgName,
            organizationAddress,
            organizationPhone,
            organizationFax,
            organizationEmail,
            logo: logoJpegBytes ? { jpegBytes: logoJpegBytes } : null,
            payerName,
            payerAttention,
            clientName: clientFullName,
            clientDob,
            claimNumber,
            dateOfService: dos,
            providerName,
            totalCharge: Number.isFinite(totalCharge) ? totalCharge : null,
            requestReference: note || null,
            attachments,
            notes: note || null,
            generatedAt,
          });
        } catch (e) {
          return NextResponse.json(
            {
              success: false,
              error: `Failed to render cover letter: ${e instanceof Error ? e.message : String(e)}`,
            },
            { status: 500 },
          );
        }

        await ensureCoverLetterBucket(supabase);
        const stamp = generatedAt.toISOString().replace(/[:.]/g, "-");
        const safeClaim = String(claimNumber).replace(/[^\w.-]+/g, "_");
        const fileName = `cover-letter-${safeClaim}-${stamp}.pdf`;
        const storagePath = `${organizationId}/cover-letters/${claimId}/${fileName}`;

        const { error: upErr } = await supabase.storage
          .from(COVER_LETTER_BUCKET)
          .upload(storagePath, pdfBytes, {
            contentType: "application/pdf",
            upsert: false,
          });
        if (upErr) {
          return NextResponse.json(
            { success: false, error: `Storage upload failed: ${upErr.message}` },
            { status: 500 },
          );
        }

        const docTitle = `Cover letter - claim ${claimNumber}`;
        const { data: docRow, error: docErr } = await sb
          .from("documents")
          .insert({
            organization_id: organizationId,
            claim_id: claimId,
            client_id: clientId,
            encounter_id: claim.encounter_id ?? null,
            document_scope: "claim",
            document_type: "cover_letter",
            title: docTitle,
            file_name: fileName,
            mime_type: "application/pdf",
            file_size_bytes: pdfBytes.byteLength,
            storage_bucket: COVER_LETTER_BUCKET,
            storage_path: storagePath,
            filed_at: generatedAt.toISOString(),
            filed_by_user_id: userId,
            uploaded_by_user_id: userId,
            notes:
              `Generated by Medical Review queue for payer ${payerName}` +
              (note ? `. ${note}` : "."),
          })
          .select("id, title, file_name, storage_path, storage_bucket, file_size_bytes, created_at")
          .single();

        if (docErr || !docRow) {
          // Best-effort cleanup of the orphan storage object.
          await supabase.storage
            .from(COVER_LETTER_BUCKET)
            .remove([storagePath])
            .catch(() => {});
          return NextResponse.json(
            { success: false, error: docErr?.message ?? "Failed to record cover letter document" },
            { status: 500 },
          );
        }

        const audit = await writeAuditStrict(supabase, {
          organizationId, userId,
          action: "medical_review_cover_letter_created",
          claimId, clientId, appointmentId,
          summary: note || `Cover letter generated for ${payerName}`,
          metadata: {
            note,
            documentId: String(docRow.id),
            fileName,
            storageBucket: COVER_LETTER_BUCKET,
            storagePath,
            fileSizeBytes: pdfBytes.byteLength,
            attachmentCount: attachments.length,
          },
        });
        if (!audit.ok) {
          return NextResponse.json({ success: false, error: audit.error }, { status: 500 });
        }
        return NextResponse.json({
          success: true,
          createdAt: generatedAt.toISOString(),
          document: {
            id: String(docRow.id),
            title: docTitle,
            fileName,
            fileSizeBytes: pdfBytes.byteLength,
            downloadUrl: `/api/billing/claims/${claimId}/documents/${docRow.id}/file?organizationId=${encodeURIComponent(organizationId)}`,
          },
        });
      }
      case "download_submission_packet": {
        // Resolve the documents we are going to bundle. Either the caller
        // hand-picked a subset (documentIds) or we use every non-archived
        // attachment on the claim except previously-generated cover
        // letters / packets (we always regenerate the cover letter and
        // never want to recursively merge a prior packet into the new
        // one).
        const requestedIds = (body.documentIds ?? [])
          .map((s) => String(s).trim())
          .filter(Boolean);

        let docsQuery = sb
          .from("documents")
          .select(
            "id, title, file_name, mime_type, document_type, storage_bucket, storage_path, file_size_bytes",
          )
          .eq("organization_id", organizationId)
          .eq("claim_id", claimId)
          .is("archived_at", null)
          .order("created_at", { ascending: true });
        if (requestedIds.length > 0) {
          docsQuery = docsQuery.in("id", requestedIds);
        } else {
          docsQuery = docsQuery.not(
            "document_type",
            "in",
            "(cover_letter,submission_packet)",
          );
        }
        const { data: docRows, error: docsErr } = await docsQuery;
        if (docsErr) {
          return NextResponse.json(
            { success: false, error: docsErr.message ?? "Failed to load attachments" },
            { status: 500 },
          );
        }
        const docs = (docRows ?? []) as Array<{
          id: string;
          title: string | null;
          file_name: string | null;
          mime_type: string | null;
          document_type: string | null;
          storage_bucket: string | null;
          storage_path: string | null;
          file_size_bytes: number | null;
        }>;

        // Hydrate cover-letter inputs (mirror of create_cover_letter).
        const [
          { data: org },
          { data: client },
          { data: payer },
          { data: appt },
        ] = await Promise.all([
          sb.from("organizations").select("name").eq("id", organizationId).maybeSingle(),
          clientId
            ? sb.from("clients")
                .select("first_name, last_name, date_of_birth")
                .eq("id", clientId)
                .eq("organization_id", organizationId)
                .maybeSingle()
            : Promise.resolve({ data: null }),
          claim.payer_profile_id
            ? sb.from("payer_profiles")
                .select("payer_name")
                .eq("id", claim.payer_profile_id)
                .eq("organization_id", organizationId)
                .maybeSingle()
            : Promise.resolve({ data: null }),
          appointmentId
            ? sb.from("appointments")
                .select("scheduled_start_at, provider_id")
                .eq("id", appointmentId)
                .eq("organization_id", organizationId)
                .maybeSingle()
            : Promise.resolve({ data: null }),
        ]);

        let providerName: string | null = null;
        const providerId = appt ? String(appt.provider_id ?? "") : "";
        if (providerId) {
          const { data: prov } = await sb
            .from("providers")
            .select("first_name, last_name")
            .eq("id", providerId)
            .eq("organization_id", organizationId)
            .maybeSingle();
          if (prov) {
            const fn = String(prov.first_name ?? "").trim();
            const ln = String(prov.last_name ?? "").trim();
            providerName = `${fn} ${ln}`.trim() || null;
          }
        }

        const coverAttachments: CoverLetterAttachment[] = docs.map((d) => ({
          title: d.title || d.file_name || "Document",
          description: d.document_type ?? null,
        }));

        const clientFirst = client ? String(client.first_name ?? "").trim() : "";
        const clientLast = client ? String(client.last_name ?? "").trim() : "";
        const clientFullName =
          `${clientFirst} ${clientLast}`.trim() || "Unknown client";
        const clientDob = client ? (client.date_of_birth as string | null) : null;
        const orgName = (org?.name as string | null) || "Billing Office";
        const payerName = (payer?.payer_name as string | null) || "Insurance Payer";
        const claimNumber = (claim.claim_number as string | null) || claimId;
        const dos = appt ? (appt.scheduled_start_at as string | null) : null;
        const totalCharge = Number(claim.total_charge ?? 0);

        const generatedAt = new Date();
        let coverBytes: Uint8Array;
        try {
          coverBytes = generateCoverLetterPdf({
            organizationName: orgName,
            payerName,
            clientName: clientFullName,
            clientDob,
            claimNumber,
            dateOfService: dos,
            providerName,
            totalCharge: Number.isFinite(totalCharge) ? totalCharge : null,
            requestReference: note || null,
            attachments: coverAttachments,
            notes: note || null,
            generatedAt,
          });
        } catch (e) {
          return NextResponse.json(
            {
              success: false,
              error: `Failed to render cover letter: ${e instanceof Error ? e.message : String(e)}`,
            },
            { status: 500 },
          );
        }

        // Download each attachment from storage in parallel, but preserve
        // the original `docs` order (which is `created_at asc`, or the
        // caller-supplied id list) when feeding the merger. `Promise.all`
        // resolves results positionally, so we keep one slot per source
        // doc and either fill it with bytes or record a per-slot skip.
        type Slot =
          | { ok: true; input: PacketAttachmentInput }
          | { ok: false; title: string; fileName: string; reason: string };
        const slots: Slot[] = await Promise.all(
          docs.map(async (d): Promise<Slot> => {
            const bucket = (d.storage_bucket ?? "").trim();
            const path = (d.storage_path ?? "").trim();
            const title = d.title || d.file_name || "Document";
            const fileName = d.file_name || `${d.id}.bin`;
            if (!bucket || !path) {
              return {
                ok: false,
                title,
                fileName,
                reason: "No file is stored for this document",
              };
            }
            const { data: blob, error: dlErr } = await supabase.storage
              .from(bucket)
              .download(path);
            if (dlErr || !blob) {
              return {
                ok: false,
                title,
                fileName,
                reason: dlErr?.message || "File not available in storage",
              };
            }
            const bytes = new Uint8Array(await blob.arrayBuffer());
            return {
              ok: true,
              input: { title, fileName, bytes, mimeType: d.mime_type ?? null },
            };
          }),
        );
        const downloaded: PacketAttachmentInput[] = [];
        const downloadSkipped: Array<{ title: string; fileName: string; reason: string }> = [];
        for (const slot of slots) {
          if (slot.ok) downloaded.push(slot.input);
          else downloadSkipped.push({ title: slot.title, fileName: slot.fileName, reason: slot.reason });
        }

        let packet;
        try {
          packet = await buildSubmissionPacket(coverBytes, downloaded);
        } catch (e) {
          return NextResponse.json(
            {
              success: false,
              error: `Failed to build submission packet: ${e instanceof Error ? e.message : String(e)}`,
            },
            { status: 500 },
          );
        }

        const skipped = [
          ...packet.skipped,
          ...downloadSkipped.map((s) => ({
            title: s.title,
            fileName: s.fileName,
            kind: "skipped" as const,
            reason: s.reason,
          })),
        ];

        await ensureCoverLetterBucket(supabase);
        const stamp = generatedAt.toISOString().replace(/[:.]/g, "-");
        const safeClaim = String(claimNumber).replace(/[^\w.-]+/g, "_");
        const fileName = `submission-packet-${safeClaim}-${stamp}.pdf`;
        const storagePath = `${organizationId}/submission-packets/${claimId}/${fileName}`;

        const { error: upErr } = await supabase.storage
          .from(COVER_LETTER_BUCKET)
          .upload(storagePath, packet.pdfBytes, {
            contentType: "application/pdf",
            upsert: false,
          });
        if (upErr) {
          return NextResponse.json(
            { success: false, error: `Storage upload failed: ${upErr.message}` },
            { status: 500 },
          );
        }

        const docTitle = `Submission packet - claim ${claimNumber}`;
        const skippedSummary = skipped.length
          ? ` Skipped ${skipped.length} unsupported attachment(s): ` +
            skipped.map((s) => `${s.title} (${s.reason})`).join("; ")
          : "";
        const { data: docRow, error: docErr } = await sb
          .from("documents")
          .insert({
            organization_id: organizationId,
            claim_id: claimId,
            client_id: clientId,
            encounter_id: claim.encounter_id ?? null,
            document_scope: "claim",
            document_type: "submission_packet",
            title: docTitle,
            file_name: fileName,
            mime_type: "application/pdf",
            file_size_bytes: packet.pdfBytes.byteLength,
            storage_bucket: COVER_LETTER_BUCKET,
            storage_path: storagePath,
            filed_at: generatedAt.toISOString(),
            filed_by_user_id: userId,
            uploaded_by_user_id: userId,
            notes:
              `Combined cover letter + ${packet.included.length} attachment(s) for ${payerName}.` +
              skippedSummary +
              (note ? ` ${note}` : ""),
          })
          .select("id, title, file_name, storage_path, storage_bucket, file_size_bytes, created_at")
          .single();

        if (docErr || !docRow) {
          await supabase.storage
            .from(COVER_LETTER_BUCKET)
            .remove([storagePath])
            .catch(() => {});
          return NextResponse.json(
            { success: false, error: docErr?.message ?? "Failed to record packet document" },
            { status: 500 },
          );
        }

        const audit = await writeAuditStrict(supabase, {
          organizationId, userId,
          action: "medical_review_submission_packet_created",
          claimId, clientId, appointmentId,
          summary:
            note ||
            `Submission packet generated for ${payerName} (${packet.included.length} attachment(s)` +
              (skipped.length ? `, ${skipped.length} skipped` : "") +
              ")",
          metadata: {
            note,
            documentId: String(docRow.id),
            fileName,
            storageBucket: COVER_LETTER_BUCKET,
            storagePath,
            fileSizeBytes: packet.pdfBytes.byteLength,
            includedCount: packet.included.length,
            skippedCount: skipped.length,
            included: packet.included,
            skipped,
          },
        });
        if (!audit.ok) {
          return NextResponse.json({ success: false, error: audit.error }, { status: 500 });
        }
        return NextResponse.json({
          success: true,
          createdAt: generatedAt.toISOString(),
          included: packet.included,
          skipped,
          document: {
            id: String(docRow.id),
            title: docTitle,
            fileName,
            fileSizeBytes: packet.pdfBytes.byteLength,
            downloadUrl: `/api/billing/claims/${claimId}/documents/${docRow.id}/file?organizationId=${encodeURIComponent(organizationId)}`,
          },
        });
      }
      case "route_to_clinician": {
        let providerId = body.providerId ?? null;
        if (!providerId && appointmentId) {
          const { data: appt } = await sb
            .from("appointments")
            .select("provider_id")
            .eq("id", appointmentId)
            .eq("organization_id", organizationId)
            .maybeSingle();
          providerId = appt ? String(appt.provider_id ?? "") || null : null;
        }
        const display = providerId ? `Clinician ${providerId.slice(0, 8)}` : "Clinician";
        const audit = await writeAuditStrict(supabase, {
          organizationId, userId,
          action: "medical_review_routed_clinician",
          claimId, clientId, appointmentId,
          summary: note || `Routed to ${display}`,
          metadata: { providerId, assignedToDisplay: display, kind: "clinician", note },
        });
        if (!audit.ok) return NextResponse.json({ success: false, error: audit.error }, { status: 500 });
        return NextResponse.json({
          success: true,
          assignment: { kind: "clinician", display, userId: providerId },
        });
      }
      case "route_to_admin": {
        const display = "Admin pool";
        const audit = await writeAuditStrict(supabase, {
          organizationId, userId,
          action: "medical_review_routed_admin",
          claimId, clientId, appointmentId,
          summary: note || `Routed to ${display}`,
          metadata: { assignedToDisplay: display, kind: "admin", note },
        });
        if (!audit.ok) return NextResponse.json({ success: false, error: audit.error }, { status: 500 });
        return NextResponse.json({
          success: true,
          assignment: { kind: "admin", display, userId: null },
        });
      }
      case "assign_biller": {
        const billerId = (body.billerId ?? userId ?? "").trim();
        if (!billerId) {
          return NextResponse.json(
            { success: false, error: "billerId is required" },
            { status: 400 },
          );
        }
        const audit = await writeAuditStrict(supabase, {
          organizationId, userId,
          action: "medical_review_assigned_biller",
          claimId, clientId, appointmentId,
          summary: note || `Assigned to biller ${billerId}`,
          metadata: { billerId, note },
        });
        if (!audit.ok) return NextResponse.json({ success: false, error: audit.error }, { status: 500 });
        return NextResponse.json({ success: true, billerId });
      }
      case "set_follow_up": {
        const dueAt = (body.followUpDueAt ?? "").trim();
        if (!dueAt) {
          return NextResponse.json(
            { success: false, error: "followUpDueAt is required" },
            { status: 400 },
          );
        }
        const audit = await writeAuditStrict(supabase, {
          organizationId, userId,
          action: "medical_review_follow_up_set",
          claimId, clientId, appointmentId,
          summary: note || `Follow-up due ${dueAt}`,
          metadata: { dueAt, note },
        });
        if (!audit.ok) return NextResponse.json({ success: false, error: audit.error }, { status: 500 });
        return NextResponse.json({ success: true, dueAt });
      }
      case "mark_submitted": {
        const marker = `[MED REVIEW SUBMITTED ${new Date().toISOString()}] ${note || "Documentation submitted to payer"}`;
        const prior = (claim.billing_notes as string | null) ?? "";
        const merged = prior ? `${prior}\n${marker}` : marker;
        const { error } = await sb
          .from("professional_claims")
          .update({ billing_notes: merged })
          .eq("id", claimId)
          .eq("organization_id", organizationId);
        if (error) {
          return NextResponse.json(
            { success: false, error: error.message ?? "Failed to update claim" },
            { status: 500 },
          );
        }
        const audit = await writeAuditStrict(supabase, {
          organizationId, userId,
          action: "medical_review_submitted",
          claimId, clientId, appointmentId,
          summary: note || "Documentation submitted to payer",
          metadata: { note, submittedAt: new Date().toISOString() },
        });
        if (!audit.ok) return NextResponse.json({ success: false, error: audit.error }, { status: 500 });
        return NextResponse.json({ success: true, submittedAt: new Date().toISOString() });
      }
      default:
        return NextResponse.json(
          { success: false, error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Action failed" },
      { status: 500 },
    );
  }
}
