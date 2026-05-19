import { NextRequest, NextResponse } from "next/server";
import {
  prepareEligibilityRequest,
  type PrepareEligibilityRequestInput,
} from "@/lib/eligibility/eligibilityPreparationService";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as PrepareEligibilityRequestInput;

    if (!body?.organization_id) {
      return NextResponse.json(
        { error: "organization_id is required" },
        { status: 400 }
      );
    }

    if (!body?.payer_configuration_id && !body?.payer_id) {
      return NextResponse.json(
        { error: "payer_configuration_id or payer_id is required" },
        { status: 400 }
      );
    }

    const result = await prepareEligibilityRequest({
      organization_id: body.organization_id,
      patient_id: body.patient_id ?? null,
      payer_configuration_id: body.payer_configuration_id ?? null,
      payer_id: body.payer_id ?? null,
      payer_name: body.payer_name ?? null,
      provider_npi: body.provider_npi ?? null,
      subscriber_id: body.subscriber_id ?? null,
      subscriber_first_name: body.subscriber_first_name ?? null,
      subscriber_last_name: body.subscriber_last_name ?? null,
      subscriber_dob: body.subscriber_dob ?? null,
      patient_first_name: body.patient_first_name ?? null,
      patient_last_name: body.patient_last_name ?? null,
      patient_dob: body.patient_dob ?? null,
      request_mode: body.request_mode ?? "mock",
    });

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";

    if (
      message.includes("Migration pending") ||
      message.includes("not initialized") ||
      message.includes("Database connection not available")
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: message,
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: message,
      },
      { status: 500 }
    );
  }
}
