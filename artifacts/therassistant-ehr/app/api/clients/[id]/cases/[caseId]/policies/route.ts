import { NextResponse } from "next/server";
import {
  attachPolicyToCase,
  reorderCasePolicies,
  type PolicyPriority,
} from "@/lib/cases/clientCasesService";
import { requireOrgAccess } from "@/lib/auth/requireOrgAccess";
import { requireAuthenticatedStaff } from "@/lib/rbac/auth";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; caseId: string }> },
) {
  try {
    const { caseId } = await context.params;
    const body = (await request.json()) as {
      organizationId?: string;
      policyId?: string;
      priority?: PolicyPriority;
    };
    const guard = await requireOrgAccess({
      requestedOrganizationId: body.organizationId,
    });
    if (guard instanceof NextResponse) return guard;
    if (!body.policyId || !body.priority) {
      return NextResponse.json(
        { success: false, error: "policyId and priority are required" },
        { status: 400 },
      );
    }
    const staff = await requireAuthenticatedStaff();
    const result = await attachPolicyToCase({
      organizationId: guard.organizationId,
      caseId,
      policyId: body.policyId,
      priority: body.priority,
      staff,
    });
    if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to attach policy" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; caseId: string }> },
) {
  try {
    const { caseId } = await context.params;
    const body = (await request.json()) as {
      organizationId?: string;
      ordered?: Array<{ policyId: string; priority: PolicyPriority }>;
    };
    const guard = await requireOrgAccess({
      requestedOrganizationId: body.organizationId,
    });
    if (guard instanceof NextResponse) return guard;
    if (!Array.isArray(body.ordered)) {
      return NextResponse.json(
        { success: false, error: "ordered is required" },
        { status: 400 },
      );
    }
    const staff = await requireAuthenticatedStaff();
    const result = await reorderCasePolicies({
      organizationId: guard.organizationId,
      caseId,
      ordered: body.ordered,
      staff,
    });
    if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to reorder policies" },
      { status: 500 },
    );
  }
}
