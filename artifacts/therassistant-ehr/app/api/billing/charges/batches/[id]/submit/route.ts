import { NextResponse } from "next/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const guard = await requireBillingAccess({ requestedOrganizationId: body.organizationId ?? null });
  if (guard instanceof NextResponse) return guard;

  return NextResponse.json(
    {
      success: false,
      wired: false,
      error:
        "Electronic batch submission from Charges is not wired yet. Use Download 837, upload in Availity, then Mark Submitted.",
    },
    { status: 501 },
  );
}
