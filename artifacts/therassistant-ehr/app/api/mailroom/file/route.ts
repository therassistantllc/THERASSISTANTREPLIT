// File: app/api/mailroom/file/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error("Server Supabase configuration is missing");
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey);
}

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabase();
    const body = await req.json();
    const { 
      mailroom_item_id, 
      filing_destination,
      target_id,
      admin_comments,
      organization_id
    } = body;

    if (!mailroom_item_id || !filing_destination || !organization_id) {
      return NextResponse.json(
        { error: "Missing required fields: mailroom_item_id, filing_destination, organization_id" },
        { status: 400 }
      );
    }

    // Get mailroom item
    const { data: mailroomItem, error: mailroomError } = await supabase
      .from("mailroom_items")
      .select("*")
      .eq("id", mailroom_item_id)
      .single();

    if (mailroomError || !mailroomItem) {
      return NextResponse.json(
        { error: "Mailroom item not found" },
        { status: 404 }
      );
    }

    // Create document record
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const documentData: any = {
      organization_id,
      storage_path: mailroomItem.storage_path,
      file_name: mailroomItem.file_name || "mailroom_document",
      file_type: mailroomItem.mime_type || "application/pdf",
      uploaded_by: mailroomItem.uploaded_by_user_id,
      uploaded_at: new Date().toISOString(),
    };

    // Set appropriate FK based on filing destination
    if (filing_destination === "patient_chart" && target_id) {
      documentData.client_id = target_id;
    } else if (filing_destination === "claim" && target_id) {
      documentData.claim_id = target_id;
    } else if (filing_destination === "encounter" && target_id) {
      documentData.encounter_id = target_id;
    }
    // practice_documents doesn't need a target_id

    const { data: document, error: documentError } = await supabase
      .from("documents")
      .insert([documentData])
      .select()
      .single();

    if (documentError) {
      return NextResponse.json(
        { error: `Failed to create document: ${documentError.message}` },
        { status: 500 }
      );
    }

    // Update mailroom item status to filed
    const { error: updateError } = await supabase
      .from("mailroom_items")
      .update({
        status: "filed",
        admin_comments,
        updated_at: new Date().toISOString(),
      })
      .eq("id", mailroom_item_id);

    if (updateError) {
      return NextResponse.json(
        { error: `Failed to update mailroom item: ${updateError.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ 
      success: true,
      document_id: document.id,
      message: "Document filed successfully"
    });
  } catch (error: unknown) {
    console.error("Mailroom filing error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
