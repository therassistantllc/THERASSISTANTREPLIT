import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value || "25", 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return 25;
  }
  return Math.min(parsed, 200);
}

export async function GET(req: NextRequest) {
  try {
    const organizationId = req.nextUrl.searchParams.get("organization_id");
    const patientId = req.nextUrl.searchParams.get("patient_id");
    const payerId = req.nextUrl.searchParams.get("payer_id");
    const status = req.nextUrl.searchParams.get("status");
    const eligibilityStatus = req.nextUrl.searchParams.get("eligibility_status");
    const limit = parseLimit(req.nextUrl.searchParams.get("limit"));

    if (!organizationId) {
      return NextResponse.json(
        { error: "organization_id is required" },
        { status: 400 }
      );
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "Database connection not available" },
        { status: 503 }
      );
    }

    let query = supabase
      .from("eligibility_requests")
      .select(
        "id,organization_id,patient_id,payer_id,payer_name,subscriber_id,subscriber_first_name,subscriber_last_name,subscriber_dob,patient_first_name,patient_last_name,patient_dob,service_type_code,service_type_description,request_mode,status,eligibility_status,copay_amount,deductible_remaining,effective_date,termination_date,created_at,availity_transaction_id",
        { count: "exact" }
      )
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (patientId) {
      query = query.eq("patient_id", patientId);
    }
    if (payerId) {
      query = query.eq("payer_id", payerId);
    }
    if (status) {
      query = query.eq("status", status);
    }
    if (eligibilityStatus) {
      query = query.eq("eligibility_status", eligibilityStatus);
    }

    const { data, error, count } = await query;

    if (error) {
      const message = error?.message || "";
      if (message.includes("Could not find the table") || message.includes("does not exist")) {
        return NextResponse.json(
          {
            ok: true,
            count: 0,
            requests: [],
            message: "Eligibility requests table not yet initialized",
          },
          { status: 200 }
        );
      }
      throw error;
    }

    return NextResponse.json({
      ok: true,
      count: count || 0,
      requests: data ?? [],
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
