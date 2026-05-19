// File: app/api/dashboard/alerts/[id]/resolve/route.ts
import { NextResponse } from "next/server";

export async function PATCH(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  return NextResponse.json({
    ok: true,
    id,
    status: "resolved",
  });
}
