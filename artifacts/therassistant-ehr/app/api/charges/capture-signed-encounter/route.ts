import { NextResponse } from "next/server";
import { captureSignedEncounterCharge } from "@/lib/charges/signedEncounterChargeCaptureService";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.organizationId || !body.encounterId) {
      return NextResponse.json({ success: false, error: "organizationId and encounterId are required" }, { status: 400 });
    }

    const result = await captureSignedEncounterCharge({
      organizationId: String(body.organizationId),
      encounterId: String(body.encounterId),
    });

    return NextResponse.json({ success: result.ok, result }, { status: result.ok ? 200 : 422 });
  } catch (error) {
    console.error("Signed encounter charge capture API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Signed encounter charge capture failed" },
      { status: 500 },
    );
  }
}
