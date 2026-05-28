import { NextResponse } from "next/server";
import { archiveCase, getCaseById, updateCase, type CaseType } from "@/lib/cases/clientCasesService";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireAuthenticatedStaff } from "@/lib/rbac/auth";
import { writeChartObjectAuditLogs } from "@/lib/audit/chartObjectAudit";

import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";

const CASE_COLUMN_LABELS: Record<string, string> = {
  name: "Case name",
  case_type: "Case type",
  notes: "Notes",
  active_flag: "Active",
  is_default: "Default case",
  archived_at: "Archived",
};

function caseToSnapshot(c: NonNullable<Awaited<ReturnType<typeof getCaseById>>>) {
  return {
    name: c.name,
    case_type: c.caseType,
    notes: c.notes,
    active_flag: c.activeFlag ? "true" : "false",
    is_default: c.isDefault ? "true" : "false",
    archived_at: c.archivedAt,
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; caseId: string }> },
) {
  try {
    const { caseId } = await context.params;
    const { searchParams } = new URL(request.url);
    const guard = await requireOrgAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;
    const organizationId = guard.organizationId;
    const c = await getCaseById({ organizationId, caseId });
    if (!c) return NextResponse.json({ success: false, error: "Case not found" }, { status: 404 });
    return NextResponse.json({ success: true, case: c });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load case" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; caseId: string }> },
) {
  try {
    const { id: clientId, caseId } = await context.params;
    const body = (await request.json()) as {
      organizationId?: string;
      name?: string;
      caseType?: CaseType;
      notes?: string | null;
      activeFlag?: boolean;
      isDefault?: boolean;
    };
    const guard = await requireOrgAccess({
      requestedOrganizationId: body.organizationId,
    });
    if (guard instanceof NextResponse) return guard;

    // Snapshot the case BEFORE the update so we can diff. updateCase mutates
    // is_default cascade across siblings; the diff we record is for this case.
    const before = await getCaseById({
      organizationId: guard.organizationId,
      caseId,
    });

    // Refuse cross-patient URLs: a case must belong to the client in the
    // path. Without this check, audit_logs.patient_id could be misattributed
    // to a different chart if the URL params are mismatched.
    if (before && String(before.clientId) !== String(clientId)) {
      return NextResponse.json(
        { success: false, error: "Case does not belong to this client" },
        { status: 404 },
      );
    }

    const result = await updateCase({
      organizationId: guard.organizationId,
      caseId,
      name: body.name,
      caseType: body.caseType,
      notes: "notes" in body ? body.notes ?? null : undefined,
      activeFlag: body.activeFlag,
      isDefault: body.isDefault,
    });
    if (!result.ok) return NextResponse.json({ success: false, errors: result.errors }, { status: 400 });

    // Best-effort audit; if the audit insert fails the update has already been
    // committed (the service layer mutates is_default across siblings before
    // patching this row), so we cannot roll it back here. Log loudly instead.
    try {
      if (before) {
        const supabase = createServerSupabaseAdminClient();
        const staff = await requireAuthenticatedStaff();
        if (supabase) {
          await writeChartObjectAuditLogs({
            supabase,
            organizationId: guard.organizationId,
            patientId: clientId,
            staff,
            objectType: "client_case",
            objectId: caseId,
            action: "client_case_updated",
            objectLabel: `Case: ${result.case.name}`,
            before: caseToSnapshot(before),
            after: caseToSnapshot(result.case),
            columnLabels: CASE_COLUMN_LABELS,
            contextMetadata: { case_name: result.case.name },
          });
        }
      }
    } catch (auditError) {
      console.error(
        "[cases.PATCH] audit log insert failed after successful update",
        auditError instanceof Error ? auditError.message : auditError,
      );
    }

    return NextResponse.json({ success: true, case: result.case });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to update case" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; caseId: string }> },
) {
  try {
    const { id: clientId, caseId } = await context.params;
    const { searchParams } = new URL(request.url);
    const guard = await requireOrgAccess({
      requestedOrganizationId: searchParams.get("organizationId"),
    });
    if (guard instanceof NextResponse) return guard;

    const before = await getCaseById({
      organizationId: guard.organizationId,
      caseId,
    });

    // Refuse cross-patient URLs so the audit row can't be misattributed.
    if (before && String(before.clientId) !== String(clientId)) {
      return NextResponse.json(
        { success: false, error: "Case does not belong to this client" },
        { status: 404 },
      );
    }

    const result = await archiveCase({ organizationId: guard.organizationId, caseId });
    if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 });

    try {
      if (before) {
        const supabase = createServerSupabaseAdminClient();
        const staff = await requireAuthenticatedStaff();
        if (supabase) {
          const archivedAt = new Date().toISOString();
          await writeChartObjectAuditLogs({
            supabase,
            organizationId: guard.organizationId,
            patientId: clientId,
            staff,
            objectType: "client_case",
            objectId: caseId,
            action: "client_case_archived",
            objectLabel: `Case: ${before.name}`,
            before: {
              archived_at: before.archivedAt,
              active_flag: before.activeFlag ? "true" : "false",
              is_default: before.isDefault ? "true" : "false",
            },
            after: {
              archived_at: archivedAt,
              active_flag: "false",
              is_default: "false",
            },
            columnLabels: CASE_COLUMN_LABELS,
            contextMetadata: { case_name: before.name },
          });
        }
      }
    } catch (auditError) {
      console.error(
        "[cases.DELETE] audit log insert failed after archive",
        auditError instanceof Error ? auditError.message : auditError,
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to archive case" },
      { status: 500 },
    );
  }
}
