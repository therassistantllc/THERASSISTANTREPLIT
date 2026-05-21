import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { storeClearinghouseApiKey } from "@/lib/clearinghouse/credentials";

function getOrgId(req: NextRequest) {
  return (
    req.nextUrl.searchParams.get("organizationId") ||
    process.env.NEXT_PUBLIC_ORGANIZATION_ID ||
    ""
  );
}

/** Never return encrypted_credentials or vault_secret_id to the client; instead expose
 *  a derived `has_credentials` flag plus a `credential_source` hint so the UI can warn
 *  when a connection is still on legacy plaintext storage. */
function sanitizeConnection(row: Record<string, unknown>) {
  const { encrypted_credentials, vault_secret_id, vault_secret_name, ...safe } = row;
  const hasVault = vault_secret_id !== null && vault_secret_id !== undefined;
  const hasLegacy =
    encrypted_credentials !== null && encrypted_credentials !== undefined &&
    typeof encrypted_credentials === "object" &&
    Object.keys(encrypted_credentials as Record<string, unknown>).length > 0;
  return {
    ...safe,
    has_credentials: hasVault || hasLegacy,
    credential_source: hasVault ? "vault" : hasLegacy ? "legacy_jsonb" : "none",
  };
}

export async function GET(req: NextRequest) {
  const organizationId = getOrgId(req);
  if (!organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database connection not available" }, { status: 503 });
  }

  const { data, error } = await supabase
    .from("clearinghouse_connections")
    .select(
      "id, organization_id, vendor, clearinghouse_name, connection_name, mode, submitter_id, " +
      "sender_qualifier, receiver_qualifier, receiver_id, receiver_name, gs_receiver_code, " +
      "x12_version, isa_usage_indicator, sftp_host, sftp_port, sftp_username, " +
      "inbound_folder, outbound_folder, api_base_url, auth_type, " +
      "eligibility_service_type_code, eligibility_transaction_set, " +
      "is_active, encrypted_credentials, vault_secret_id, vault_secret_name, created_at, updated_at",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[GET /api/settings/clearinghouse]", error);
    return NextResponse.json({ error: "Failed to load clearinghouse connections" }, { status: 500 });
  }

  const connections = (data ?? []).map((row) =>
    sanitizeConnection(row as unknown as Record<string, unknown>),
  );

  return NextResponse.json({ connections });
}

export async function POST(req: NextRequest) {
  const organizationId = getOrgId(req);
  if (!organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database connection not available" }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const now = new Date().toISOString();

  // sftp_password is stored in encrypted_credentials (legacy path; SFTP is not yet using Vault).
  // api_key, on the other hand, goes straight into Supabase Vault via the helper below — it is
  // never persisted to encrypted_credentials and never echoed back to the client.
  const { sftp_password, api_key, ...rest } = body;
  const encryptedCredentials = sftp_password ? { sftp_password } : null;

  const { data, error } = await supabase
    .from("clearinghouse_connections")
    .insert({
      organization_id: organizationId,
      vendor: String(rest.vendor ?? "office_ally"),
      clearinghouse_name: String(rest.clearinghouse_name ?? "Office Ally"),
      connection_name: rest.connection_name ? String(rest.connection_name) : null,
      mode: String(rest.mode ?? "production"),
      submitter_id: rest.submitter_id ? String(rest.submitter_id) : null,
      sender_qualifier: String(rest.sender_qualifier ?? "ZZ"),
      receiver_qualifier: String(rest.receiver_qualifier ?? "ZZ"),
      receiver_id: rest.receiver_id ? String(rest.receiver_id) : null,
      receiver_name: String(rest.receiver_name ?? ""),
      gs_receiver_code: String(rest.gs_receiver_code ?? ""),
      x12_version: String(rest.x12_version ?? "005010X222A1"),
      isa_usage_indicator: String(rest.isa_usage_indicator ?? "P"),
      sftp_host: rest.sftp_host ? String(rest.sftp_host) : null,
      sftp_port: rest.sftp_port ? Number(rest.sftp_port) : null,
      sftp_username: rest.sftp_username ? String(rest.sftp_username) : null,
      inbound_folder: rest.inbound_folder ? String(rest.inbound_folder) : null,
      outbound_folder: rest.outbound_folder ? String(rest.outbound_folder) : null,
      api_base_url: rest.api_base_url ? String(rest.api_base_url) : null,
      auth_type: rest.auth_type ? String(rest.auth_type) : null,
      eligibility_service_type_code: String(rest.eligibility_service_type_code ?? "98"),
      eligibility_transaction_set: String(rest.eligibility_transaction_set ?? "270"),
      is_active: Boolean(rest.is_active ?? true),
      encrypted_credentials: encryptedCredentials,
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[POST /api/settings/clearinghouse]", error);
    return NextResponse.json({ error: "Failed to create clearinghouse connection" }, { status: 500 });
  }

  // After the row exists we can vault the api_key against it. If this fails we still keep the
  // connection row — the operator can re-save the key — but we surface the error so the UI knows.
  if (typeof api_key === "string" && api_key.length > 0) {
    const vaulted = await storeClearinghouseApiKey({ connectionId: data.id, apiKey: api_key });
    if (!vaulted.ok) {
      return NextResponse.json(
        {
          success: true,
          id: data.id,
          warning: `Connection created but API key could not be stored in Vault: ${vaulted.error}`,
        },
        { status: 201 },
      );
    }
  }

  return NextResponse.json({ success: true, id: data.id }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const organizationId = getOrgId(req);
  if (!organizationId) {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }

  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Database connection not available" }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id query parameter required" }, { status: 400 });
  }

  const allowedFields = [
    "vendor", "clearinghouse_name", "connection_name", "mode", "submitter_id",
    "sender_qualifier", "receiver_qualifier", "receiver_id", "receiver_name",
    "gs_receiver_code", "x12_version", "isa_usage_indicator", "sftp_host",
    "sftp_port", "sftp_username", "inbound_folder", "outbound_folder",
    "api_base_url", "auth_type", "eligibility_service_type_code",
    "eligibility_transaction_set", "is_active",
  ] as const;

  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (field in body) updates[field] = body[field];
  }

  // Handle SFTP password update: store in encrypted_credentials (legacy path).
  if ("sftp_password" in body && body.sftp_password) {
    updates.encrypted_credentials = { sftp_password: body.sftp_password };
  }

  updates.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from("clearinghouse_connections")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (error) {
    console.error("[PATCH /api/settings/clearinghouse]", error);
    return NextResponse.json({ error: "Failed to update clearinghouse connection" }, { status: 500 });
  }

  // Vault the API key (rotate the existing secret if one is already linked).
  if ("api_key" in body && typeof body.api_key === "string" && body.api_key.length > 0) {
    const vaulted = await storeClearinghouseApiKey({ connectionId: id, apiKey: body.api_key });
    if (!vaulted.ok) {
      return NextResponse.json({
        success: true,
        warning: `Connection updated but API key could not be rotated in Vault: ${vaulted.error}`,
      });
    }
  }

  return NextResponse.json({ success: true });
}
