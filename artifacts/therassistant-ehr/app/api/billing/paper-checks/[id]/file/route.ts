/**
 * GET /api/billing/paper-checks/[id]/file?kind=eob|scan[&probe=1]
 *
 * Serves the uploaded paper EOB or scanned check from the `paper-checks`
 * Supabase Storage bucket. The stored value on `paper_checks.paper_eob_url`
 * or `scanned_check_url` is either:
 *   - a bucket path (newer rows, written by the upload route), or
 *   - a legacy http(s) URL that was typed in before file uploads existed.
 *
 * For legacy URLs we 302 redirect so the existing "open link" UX keeps
 * working. For bucket paths we stream the bytes back inline so the detail
 * panel can embed them in an <img> or <iframe>.
 *
 * `?probe=1` returns metadata only (existence + mime/filename) so the UI can
 * decide how to render before mounting a heavy preview.
 */
import { NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { requireBillingAccess } from "@/lib/billing/requireBillingAccess";

const BUCKET = "paper-checks";

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function guessMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: checkId } = await ctx.params;
  const url = new URL(request.url);
  const kindRaw = (url.searchParams.get("kind") || "eob").toLowerCase();
  const kind: "eob" | "scan" =
    kindRaw === "scan" || kindRaw === "scanned_check" ? "scan" : "eob";
  const isProbe = url.searchParams.get("probe") === "1";

  const guard = await requireBillingAccess({
    requestedOrganizationId: url.searchParams.get("organizationId"),
  });
  if (guard instanceof NextResponse) return guard;
  const organizationId = guard.organizationId;

  try {
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: "Database connection not available" },
        { status: 500 },
      );
    }
    if (!checkId) {
      return NextResponse.json(
        { success: false, error: "checkId is required" },
        { status: 400 },
      );
    }

    const { data: row, error: rowErr } = await (supabase as any)
      .from("paper_checks")
      .select("id, organization_id, paper_eob_url, scanned_check_url")
      .eq("id", checkId)
      .eq("organization_id", organizationId)
      .is("archived_at", null)
      .maybeSingle();
    if (rowErr) throw rowErr;
    if (!row) {
      return NextResponse.json(
        { success: false, error: "Paper check not found" },
        { status: 404 },
      );
    }

    const stored: string =
      String(
        kind === "scan" ? row.scanned_check_url ?? "" : row.paper_eob_url ?? "",
      ).trim();
    if (!stored) {
      return NextResponse.json(
        {
          success: false,
          error: kind === "scan" ? "No scanned check on file" : "No paper EOB on file",
        },
        { status: 404 },
      );
    }

    // Back-compat: stored is an external URL typed in by a biller.
    if (isHttpUrl(stored)) {
      if (isProbe) {
        return NextResponse.json({
          success: true,
          external: true,
          url: stored,
          mimeType: null,
          fileName: stored.split("/").pop() || `paper-check-${kind}`,
        });
      }
      return NextResponse.redirect(stored, 302);
    }

    const fileName = stored.split("/").pop() || `paper-check-${kind}`;
    const mime = guessMime(stored);

    if (isProbe) {
      const { data: signed, error: signErr } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(stored, 60);
      if (signErr || !signed?.signedUrl) {
        return NextResponse.json(
          {
            success: false,
            error: signErr?.message || "Object not found in storage",
            bucket: BUCKET,
            attemptedPath: stored,
            fileName,
            mimeType: mime,
          },
          { status: 404 },
        );
      }
      return NextResponse.json({
        success: true,
        external: false,
        bucket: BUCKET,
        attemptedPath: stored,
        fileName,
        mimeType: mime,
      });
    }

    const { data: blob, error: dlErr } = await supabase.storage
      .from(BUCKET)
      .download(stored);
    if (dlErr || !blob) {
      return NextResponse.json(
        {
          success: false,
          error: dlErr?.message || "File not available in storage",
          bucket: BUCKET,
          attemptedPath: stored,
        },
        { status: 404 },
      );
    }
    const buffer = Buffer.from(await blob.arrayBuffer());
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": blob.type || mime,
        "Content-Disposition": `inline; filename="${fileName.replace(/"/g, "")}"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch file",
      },
      { status: 500 },
    );
  }
}

export async function HEAD(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const url = new URL(request.url);
  url.searchParams.set("probe", "1");
  return GET(new Request(url.toString(), { method: "GET" }), ctx);
}
