import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function value(input: unknown) {
  return String(input ?? "").trim();
}

async function loadInvite(token: string) {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return { invite: null, client: null, practice: null, error: "Database unavailable" as const };

  const { data: inviteRow, error: inviteErr } = await supabase
    .from("portal_invites")
    .select("id, organization_id, client_id, status, expires_at, accepted_at")
    .eq("token", token)
    .maybeSingle();
  if (inviteErr || !inviteRow) {
    return { invite: null, client: null, practice: null, error: "Invite not found" as const };
  }

  const invite = inviteRow as Row;
  const [{ data: clientRow }, { data: orgRow }] = await Promise.all([
    supabase
      .from("clients")
      .select("first_name, last_name, preferred_name")
      .eq("id", value(invite.client_id))
      .maybeSingle(),
    supabase
      .from("organizations")
      .select("name")
      .eq("id", value(invite.organization_id))
      .maybeSingle(),
  ]);

  return {
    invite: {
      id: value(invite.id),
      status: value(invite.status),
      expiresAt: (invite.expires_at as string | null) ?? null,
      acceptedAt: (invite.accepted_at as string | null) ?? null,
    },
    client: clientRow as Row | null,
    practice: value((orgRow as Row | null)?.name) || "Your care team",
    error: null as null,
  };
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now();
}

export default async function PatientPortalLandingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const { invite, client, practice, error } = await loadInvite(token);

  const containerStyle: React.CSSProperties = {
    maxWidth: 520,
    margin: "64px auto",
    padding: 24,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
    color: "#1f2937",
    border: "1px solid #e5e7eb",
    borderRadius: 8,
  };

  if (error || !invite) {
    return (
      <main style={containerStyle}>
        <h1 style={{ marginTop: 0 }}>Portal link not found</h1>
        <p>
          This portal invite link is invalid. Please contact your care team to request a new
          invitation.
        </p>
      </main>
    );
  }

  const expired = isExpired(invite.expiresAt) || invite.status === "expired";
  const revoked = invite.status === "revoked";
  const patientName = client
    ? value(client.preferred_name) || value(client.first_name) || "there"
    : "there";

  if (revoked) {
    return (
      <main style={containerStyle}>
        <h1 style={{ marginTop: 0 }}>Invite revoked</h1>
        <p>This portal invite has been revoked. Please contact {practice} for a new invite.</p>
      </main>
    );
  }

  if (expired) {
    return (
      <main style={containerStyle}>
        <h1 style={{ marginTop: 0 }}>Invite expired</h1>
        <p>
          This portal invite has expired. Please contact {practice} to request a fresh invitation.
        </p>
      </main>
    );
  }

  return (
    <main style={containerStyle}>
      <h1 style={{ marginTop: 0 }}>Welcome, {patientName}</h1>
      <p>
        {practice} has invited you to access your patient portal. The full portal experience is
        coming soon — for now, please use this link to confirm receipt of your invitation, and
        the practice will follow up with next steps.
      </p>
      <p style={{ fontSize: 13, color: "#4b5563" }}>
        If you have questions, please contact {practice} directly.
      </p>
    </main>
  );
}
