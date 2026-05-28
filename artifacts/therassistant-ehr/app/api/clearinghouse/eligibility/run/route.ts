// File: app/api/clearinghouse/eligibility/run/route.ts
import { NextResponse } from "next/server";
import { ClearinghouseService } from "@/lib/clearinghouse/ClearinghouseService";
import { requirePermissionInRoute } from "@/lib/rbac/middleware";
import { PERMISSIONS } from "@/lib/rbac/constants";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authOrError = await requirePermissionInRoute(PERMISSIONS.RUN_ELIGIBILITY);
  if (authOrError instanceof NextResponse) return authOrError;
  const { staffId, organizationId, roles } = authOrError;

  let body: { patientId?: string; appointmentId?: string | null; insurancePolicyId?: string | null; serviceTypeCode?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patientId = body?.patientId;
  if (!patientId) {
    return NextResponse.json({ error: "patientId is required." }, { status: 400 });
  }

  // Tenant isolation: verify client belongs to the caller's organization
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database connection not available" }, { status: 500 });
  }
  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, organization_id")
    .eq("id", patientId)
    .maybeSingle();
  if (clientError || !client) {
    return NextResponse.json({ error: "Client not found." }, { status: 404 });
  }
  if (client.organization_id !== organizationId) {
    return NextResponse.json({ error: "Access denied: organization mismatch" }, { status: 403 });
  }

  // If an insurance policy is specified, verify it belongs to this client AND this org.
  if (body.insurancePolicyId) {
    const { data: policy, error: policyError } = await supabase
      .from("insurance_policies")
      .select("id, client_id, organization_id")
      .eq("id", body.insurancePolicyId)
      .maybeSingle();
    if (policyError || !policy) {
      return NextResponse.json({ error: "Insurance policy not found." }, { status: 404 });
    }
    if (policy.organization_id !== organizationId || policy.client_id !== patientId) {
      // Audit the denied attempt so cross-tenant probing is observable.
      await supabase.from("audit_logs").insert({
        organization_id: organizationId,
        patient_id: patientId,
        appointment_id: body.appointmentId ?? null,
        user_id: staffId,
        user_role: roles?.[0] ?? null,
        event_type: "eligibility_check_denied",
        event_summary: "Eligibility run denied: insurance policy does not belong to this client/organization.",
        action: "eligibility.run",
        object_type: "insurance_policy",
        object_id: body.insurancePolicyId,
        event_metadata: {
          reason: "policy_tenant_mismatch",
          insurance_policy_id: body.insurancePolicyId,
        },
      });
      return NextResponse.json({ error: "Access denied: insurance policy does not belong to this client." }, { status: 403 });
    }
  }

  const startedAt = new Date().toISOString();
  const service = new ClearinghouseService();

  try {
    const result = await service.runEligibility({
      patientId,
      appointmentId: body.appointmentId ?? null,
      insurancePolicyId: body.insurancePolicyId ?? null,
      serviceTypeCode: body.serviceTypeCode ?? "98",
    });

    // Audit success
    await supabase.from("audit_logs").insert({
      organization_id: organizationId,
      patient_id: patientId,
      appointment_id: body.appointmentId ?? null,
      user_id: staffId,
      user_role: roles?.[0] ?? null,
      event_type: "eligibility_check_run",
      event_summary: `Eligibility ${result.normalized?.status ?? "completed"} (270/271)`,
      action: "eligibility.run",
      object_type: "eligibility_check",
      object_id: result.latest?.id ?? null,
      event_metadata: {
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status: result.normalized?.status ?? null,
        payer_name: result.normalized?.payerName ?? null,
        service_type_code: result.normalized?.serviceTypeCode ?? "98",
        insurance_policy_id: body.insurancePolicyId ?? null,
      },
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Eligibility run failed.";

    // Audit failure
    await supabase.from("audit_logs").insert({
      organization_id: organizationId,
      patient_id: patientId,
      appointment_id: body.appointmentId ?? null,
      user_id: staffId,
      user_role: roles?.[0] ?? null,
      event_type: "eligibility_check_failed",
      event_summary: `Eligibility check failed: ${message}`,
      action: "eligibility.run",
      object_type: "eligibility_check",
      event_metadata: {
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        error: message,
        insurance_policy_id: body.insurancePolicyId ?? null,
      },
    });

    return NextResponse.json(
      { success: false, error: message, retryable: true },
      { status: 502 },
    );
  }
}
