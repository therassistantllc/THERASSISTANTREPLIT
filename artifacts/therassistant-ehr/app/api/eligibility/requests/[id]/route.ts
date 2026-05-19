import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { error: "Database connection not available" },
        { status: 503 }
      );
    }

    const { data: requestRow, error: requestError } = await supabase
      .from("eligibility_requests")
      .select(
        "id,organization_id,patient_id,payer_id,payer_name,subscriber_id,subscriber_first_name,subscriber_last_name,subscriber_dob,patient_first_name,patient_last_name,patient_dob,service_type_code,service_type_description,request_mode,status,eligibility_status,copay_amount,deductible_remaining,effective_date,termination_date,created_at,availity_transaction_id,request_payload_safe,response_payload_safe"
      )
      .eq("id", id)
      .maybeSingle();

    if (requestError) {
      const message = requestError?.message || "";
      if (message.includes("Could not find the table") || message.includes("does not exist")) {
        return NextResponse.json(
          { error: "Eligibility requests table not initialized" },
          { status: 503 }
        );
      }
      throw requestError;
    }

    if (!requestRow) {
      return NextResponse.json({ error: "Eligibility request not found" }, { status: 404 });
    }

    let transaction = null;
    if (requestRow.availity_transaction_id) {
      const { data: txRow, error: txError } = await supabase
        .from("availity_transactions")
        .select(
          "id,transaction_type,status,environment,request_url,response_status,error_message,started_at,completed_at,created_at"
        )
        .eq("id", requestRow.availity_transaction_id)
        .maybeSingle();

      if (!txError && txRow) {
        transaction = txRow;
      }
    }

    return NextResponse.json({
      ok: true,
      request: requestRow,
      transaction,
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
