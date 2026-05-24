/**
 * POST /api/billing/payments/manual-insurance
 *
 * Posts a paper EOB / VCC / payer-portal payment through the PP-1 engine.
 * Optionally links to an existing mailroom_item or creates a new one from
 * an uploaded EOB attachment summary.
 */

import { NextResponse } from "next/server";
import {
  commitPosting,
  requireAuthenticatedPaymentPoster,
  PaymentPostingForbiddenError,
  PaymentPostingUnauthenticatedError,
} from "@/lib/payments/postingEngine";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { assertFkBelongsToOrg, FkOwnershipError } from "@/lib/payments/fkOwnershipGuard";

function toAmount(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const organizationId = String(body.organizationId ?? "").trim();
    if (!organizationId) {
      return NextResponse.json({ ok: false, error: "organizationId is required" }, { status: 400 });
    }
    const actor = await requireAuthenticatedPaymentPoster(organizationId);
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json({ ok: false, error: "Database connection not available" }, { status: 503 });
    }

    const professionalClaimId = String(body.professionalClaimId ?? "").trim();
    if (!professionalClaimId) {
      return NextResponse.json({ ok: false, error: "professionalClaimId is required" }, { status: 400 });
    }
    const guard = supabase as unknown as Parameters<typeof assertFkBelongsToOrg>[0];
    await assertFkBelongsToOrg(guard, "professional_claims", organizationId, professionalClaimId);

    if (body.clientId) {
      await assertFkBelongsToOrg(guard, "clients", organizationId, String(body.clientId), "clientId");
    }
    if (body.payerProfileId) {
      await assertFkBelongsToOrg(guard, "payer_profiles", organizationId, String(body.payerProfileId), "payerProfileId");
    }
    if (body.mailroomItemId) {
      await assertFkBelongsToOrg(guard, "mailroom_items", organizationId, String(body.mailroomItemId));
    }
    if (body.eobAttachment && (body.eobAttachment as { clientId?: string }).clientId) {
      await assertFkBelongsToOrg(
        guard,
        "clients",
        organizationId,
        String((body.eobAttachment as { clientId?: string }).clientId),
        "eobAttachment.clientId",
      );
    }

    let mailroomItemId: string | null = body.mailroomItemId ? String(body.mailroomItemId) : null;
    if (!mailroomItemId && body.eobAttachment) {
      const att = body.eobAttachment as { fileName?: string; mimeType?: string; storagePath?: string; clientId?: string };
      const { data: mr, error: mrErr } = await supabase
        .from("mailroom_items")
        .insert({
          organization_id: organizationId,
          client_id: att.clientId ?? body.clientId ?? null,
          file_name: att.fileName ?? "eob-attachment",
          mime_type: att.mimeType ?? "application/pdf",
          storage_path: att.storagePath ?? `manual-eob/${Date.now()}-${att.fileName ?? "eob"}`,
          status: "filed",
          document_type: "eob_remittance",
          source: "manual_insurance_posting",
          notes: `EOB attached at manual posting time for claim ${professionalClaimId}`,
          uploaded_by_user_id: actor.userId,
        })
        .select("id")
        .single();
      if (mrErr) {
        return NextResponse.json({ ok: false, error: `Mailroom item creation failed: ${mrErr.message}` }, { status: 422 });
      }
      mailroomItemId = String(mr!.id);
    }

    let serviceLineAllocations:
      | Array<{
          serviceLineId: string;
          chargeAmount?: number;
          paidAmount: number;
          adjustmentAmount: number;
          patientResponsibilityAmount: number;
        }>
      | undefined;
    if (Array.isArray(body.serviceLineAllocations) && body.serviceLineAllocations.length > 0) {
      const ids = (body.serviceLineAllocations as Array<{ serviceLineId?: string }>)
        .map((a) => String(a?.serviceLineId ?? "").trim())
        .filter(Boolean);
      if (ids.length > 0) {
        // Object-level auth: every supplied service-line id must belong to
        // THIS claim (not just this org). Otherwise a biller could spread
        // allocations onto unrelated service lines they happen to know.
        const { data: ownedLines } = await supabase
          .from("professional_claim_service_lines")
          .select("id, claim_id")
          .eq("claim_id", professionalClaimId)
          .in("id", ids);
        const owned = new Set((ownedLines ?? []).map((r) => String((r as { id: string }).id)));
        for (const id of ids) {
          if (!owned.has(id)) {
            return NextResponse.json(
              { ok: false, error: `Service line ${id} does not belong to claim ${professionalClaimId}` },
              { status: 404 },
            );
          }
        }
      }
      serviceLineAllocations = (body.serviceLineAllocations as Array<Record<string, unknown>>).map((a) => ({
        serviceLineId: String(a.serviceLineId ?? "").trim(),
        chargeAmount: a.chargeAmount != null ? toAmount(a.chargeAmount) : undefined,
        paidAmount: toAmount(a.paidAmount),
        adjustmentAmount: toAmount(a.adjustmentAmount),
        patientResponsibilityAmount: toAmount(a.patientResponsibilityAmount),
      }));
    }

    const result = await commitPosting({
      organizationId,
      actor,
      source: {
        type: "manual_insurance",
        professionalClaimId,
        clientId: body.clientId ? String(body.clientId) : null,
        payerPaymentAmount: toAmount(body.payerPaymentAmount),
        patientResponsibilityAmount: toAmount(body.patientResponsibilityAmount),
        contractualAdjustmentAmount: toAmount(body.contractualAdjustmentAmount),
        totalChargeAmount: body.totalChargeAmount != null ? toAmount(body.totalChargeAmount) : null,
        checkOrEftNumber: body.checkOrEftNumber ? String(body.checkOrEftNumber) : null,
        paymentDate: String(body.paymentDate ?? new Date().toISOString().slice(0, 10)),
        eobReference: body.eobReference ? String(body.eobReference) : null,
        mailroomItemId,
        payerProfileId: body.payerProfileId ? String(body.payerProfileId) : null,
        note: body.note ? String(body.note) : null,
        serviceLineAllocations,
      },
      dryRun: Boolean(body.dryRun),
    });

    if (!result.ok && result.blocked) {
      return NextResponse.json({ ok: false, blocked: true, validation: result.validation, errors: result.errors }, { status: 422 });
    }
    if (!result.ok) {
      return NextResponse.json({ ok: false, errors: result.errors, validation: result.validation }, { status: 500 });
    }
    return NextResponse.json({ ok: true, result, mailroomItemId });
  } catch (err) {
    if (err instanceof PaymentPostingUnauthenticatedError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 401 });
    }
    if (err instanceof PaymentPostingForbiddenError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 403 });
    }
    if (err instanceof FkOwnershipError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 404 });
    }
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Manual insurance posting failed" },
      { status: 500 },
    );
  }
}
