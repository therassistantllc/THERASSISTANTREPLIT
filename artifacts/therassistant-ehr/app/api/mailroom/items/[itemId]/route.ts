import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
type DbRow = Record<string, unknown>;

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function fullName(first: unknown, last: unknown, preferred?: unknown) {
  const preferredName = clean(preferred);
  if (preferredName) return preferredName;
  const parts = [clean(first), clean(last)].filter(Boolean);
  return parts.join(" ");
}

function itemDto(row: DbRow) {
  return {
    id: clean(row.id),
    organizationId: clean(row.organization_id),
    clientId: clean(row.client_id),
    fileName: clean(row.file_name),
    mimeType: clean(row.mime_type),
    storagePath: clean(row.storage_path),
    status: clean(row.status),
    documentType: clean(row.document_type),
    source: clean(row.source),
    notes: clean(row.notes),
    adminComments: clean(row.admin_comments),
    uploadedByUserId: clean(row.uploaded_by_user_id),
    createdAt: clean(row.created_at),
    updatedAt: clean(row.updated_at),
  };
}

export async function GET(request: Request, context: { params: Promise<{ itemId: string }> }) {
  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) return NextResponse.json({ success: false, error: "Database connection not available" }, { status: 500 });

    const { itemId } = await context.params;
    const { searchParams } = new URL(request.url);
    const guard = await requireOrgAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;

    const { data, error } = await supabase
      .from("mailroom_items")
      .select("id, organization_id, client_id, file_name, mime_type, storage_path, status, document_type, source, notes, admin_comments, uploaded_by_user_id, created_at, updated_at")
      .eq("organization_id", organizationId)
      .eq("id", itemId)
      .maybeSingle();

    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 422 });
    if (!data) return NextResponse.json({ success: false, error: "Mailroom item not found" }, { status: 404 });

    const item = itemDto(data as DbRow);

    // Find the most recent filed document for this mailroom item — it carries the
    // client / encounter / claim FKs that the filing UI produced.
    const { data: docRow } = await supabase
      .from("documents")
      .select("id, client_id, encounter_id, claim_id, filed_at, created_at")
      .eq("organization_id", organizationId)
      .eq("mailroom_item_id", itemId)
      .order("filed_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const filedDoc = (docRow ?? null) as DbRow | null;
    const effectivePatientId = clean(filedDoc?.client_id) || item.clientId;
    const encounterId = clean(filedDoc?.encounter_id);
    const claimId = clean(filedDoc?.claim_id);

    // Client
    let client: { id: string; name: string; dob: string; archived: boolean } | null = null;
    if (effectivePatientId) {
      const { data: clientRow } = await supabase
        .from("clients")
        .select("id, first_name, last_name, preferred_name, date_of_birth, archived_at")
        .eq("organization_id", organizationId)
        .eq("id", effectivePatientId)
        .maybeSingle();
      if (clientRow) {
        const c = clientRow as DbRow;
        client = {
          id: clean(c.id),
          name: fullName(c.first_name, c.last_name, c.preferred_name) || "Unnamed client",
          dob: clean(c.date_of_birth),
          archived: Boolean(c.archived_at),
        };
      } else {
        client = { id: effectivePatientId, name: "", dob: "", archived: true };
      }
    }

    // Encounter
    let encounter: { id: string; serviceDate: string; providerName: string; archived: boolean } | null = null;
    if (encounterId) {
      const { data: encRow } = await supabase
        .from("encounters")
        .select("id, service_date, provider_id, archived_at")
        .eq("organization_id", organizationId)
        .eq("id", encounterId)
        .maybeSingle();
      if (encRow) {
        const e = encRow as DbRow;
        let providerName = "";
        const providerId = clean(e.provider_id);
        if (providerId) {
          const { data: prov } = await supabase
            .from("providers")
            .select("first_name, last_name, display_name, credential")
            .eq("id", providerId)
            .maybeSingle();
          if (prov) {
            const p = prov as DbRow;
            const displayName = clean(p.display_name) || fullName(p.first_name, p.last_name);
            const credential = clean(p.credential);
            providerName = credential ? `${displayName}, ${credential}` : displayName;
          }
        }
        encounter = {
          id: clean(e.id),
          serviceDate: clean(e.service_date),
          providerName,
          archived: Boolean(e.archived_at),
        };
      } else {
        encounter = { id: encounterId, serviceDate: "", providerName: "", archived: true };
      }
    }

    // Claim
    let claim: { id: string; claimNumber: string; serviceDateFrom: string; payerName: string; archived: boolean } | null = null;
    if (claimId) {
      const { data: claimRow } = await supabase
        .from("claims")
        .select("id, claim_number, date_of_service_from, insurance_policy_id, archived_at")
        .eq("organization_id", organizationId)
        .eq("id", claimId)
        .maybeSingle();
      if (claimRow) {
        const cl = claimRow as DbRow;
        let payerName = "";
        const policyId = clean(cl.insurance_policy_id);
        if (policyId) {
          const { data: policy } = await supabase
            .from("insurance_policies")
            .select("payer_id")
            .eq("id", policyId)
            .maybeSingle();
          const payerId = clean((policy as DbRow | null)?.payer_id);
          if (payerId) {
            const { data: payer } = await supabase
              .from("insurance_payers")
              .select("payer_name")
              .eq("id", payerId)
              .maybeSingle();
            payerName = clean((payer as DbRow | null)?.payer_name);
          }
        }
        claim = {
          id: clean(cl.id),
          claimNumber: clean(cl.claim_number),
          serviceDateFrom: clean(cl.date_of_service_from),
          payerName,
          archived: Boolean(cl.archived_at),
        };
      } else {
        claim = { id: claimId, claimNumber: "", serviceDateFrom: "", payerName: "", archived: true };
      }
    }

    return NextResponse.json({ success: true, item, client, encounter, claim });
  } catch (error) {
    console.error("Mailroom item detail API error:", error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Mailroom item detail failed" }, { status: 500 });
  }
}
