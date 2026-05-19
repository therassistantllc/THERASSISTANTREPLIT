import { NextResponse } from "next/server";
import {
  addWorkqueueComment,
  assignWorkqueueItem,
  closeWorkqueueItem,
  deferWorkqueueItem,
  resolveWorkqueueItem,
} from "@/lib/workqueue/workqueueActionService";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.organizationId || !body.workqueueItemId || !body.action) {
      return NextResponse.json(
        { success: false, error: "organizationId, workqueueItemId, and action are required" },
        { status: 400 },
      );
    }

    const base = {
      organizationId: String(body.organizationId),
      workqueueItemId: String(body.workqueueItemId),
      userId: body.userId ?? null,
      comment: body.comment ?? null,
    };

    let result;
    if (body.action === "comment") {
      result = await addWorkqueueComment(base);
    } else if (body.action === "assign") {
      if (!body.assignedToUserId) {
        return NextResponse.json({ success: false, error: "assignedToUserId is required" }, { status: 400 });
      }
      result = await assignWorkqueueItem({ ...base, assignedToUserId: String(body.assignedToUserId) });
    } else if (body.action === "defer") {
      if (!body.deferredUntil) {
        return NextResponse.json({ success: false, error: "deferredUntil is required" }, { status: 400 });
      }
      result = await deferWorkqueueItem({
        ...base,
        deferredUntil: String(body.deferredUntil),
        deferReason: body.deferReason ?? null,
      });
    } else if (body.action === "resolve") {
      result = await resolveWorkqueueItem(base);
    } else if (body.action === "close") {
      result = await closeWorkqueueItem(base);
    } else {
      return NextResponse.json({ success: false, error: `Unsupported workqueue action: ${body.action}` }, { status: 400 });
    }

    return NextResponse.json({ success: result.ok, result }, { status: result.ok ? 200 : 422 });
  } catch (error) {
    console.error("Workqueue action API error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Workqueue action failed" },
      { status: 500 },
    );
  }
}
