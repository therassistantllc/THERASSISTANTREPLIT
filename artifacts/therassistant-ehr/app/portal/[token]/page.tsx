import { redirect } from "next/navigation";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import { getPortalSession, setPortalSessionCookie } from "@/lib/portal/session";

type Row = Record<string, unknown>;

function value(input: unknown) {
  return String(input ?? "").trim();
}

type LoadResult = {
  invite: {
    id: string;
    organizationId: string;
    clientId: string;
    status: string;
    expiresAt: string | null;
    acceptedAt: string | null;
  } | null;
  client: Row | null;
  practice: string;
  error: string | null;
};

async function loadInvite(token: string): Promise<LoadResult> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) {
    return { invite: null, client: null, practice: "Your care team", error: "Database unavailable" };
  }

  const { data: inviteRow, error: inviteErr } = await supabase
    .from("portal_invites")
    .select("id, organization_id, client_id, status, expires_at, accepted_at")
    .eq("token", token)
    .maybeSingle();
  if (inviteErr || !inviteRow) {
    return { invite: null, client: null, practice: "Your care team", error: "Invite not found" };
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
      organizationId: value(invite.organization_id),
      clientId: value(invite.client_id),
      status: value(invite.status),
      expiresAt: (invite.expires_at as string | null) ?? null,
      acceptedAt: (invite.accepted_at as string | null) ?? null,
    },
    client: clientRow as Row | null,
    practice: value((orgRow as Row | null)?.name) || "Your care team",
    error: null,
  };
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now();
}

const containerStyle: React.CSSProperties = {
  maxWidth: 520,
  margin: "64px auto",
  padding: 24,
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
};

const buttonStyle: React.CSSProperties = {
  display: "inline-block",
  marginTop: 16,
  padding: "10px 18px",
  background: "#10243f",
  color: "#ffffff",
  borderRadius: 6,
  border: "none",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

export default async function PatientPortalInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const { invite, client, practice, error } = await loadInvite(token);

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

  if (invite.status === "revoked") {
    return (
      <main style={containerStyle}>
        <h1 style={{ marginTop: 0 }}>Invite revoked</h1>
        <p>This portal invite has been revoked. Please contact {practice} for a new invite.</p>
      </main>
    );
  }

  if (isExpired(invite.expiresAt) || invite.status === "expired") {
    return (
      <main style={containerStyle}>
        <h1 style={{ marginTop: 0 }}>Invite expired</h1>
        <p>
          This portal invite has expired. Please contact {practice} to request a fresh invitation.
        </p>
      </main>
    );
  }

  // If the user already has a valid session for THIS invite's client, send them home.
  const existing = await getPortalSession();
  if (existing && existing.clientId === invite.clientId) {
    redirect("/portal/home");
  }

  // If the invite was already accepted, allow re-establishing a session by clicking continue.
  const patientName = client
    ? value(client.preferred_name) || value(client.first_name) || "there"
    : "there";

  async function acceptInvite() {
    "use server";
    const supabase = createServerSupabaseAdminClient();
    if (!supabase) {
      throw new Error("Database unavailable");
    }
    // Re-validate within the server action — never trust the rendered closure alone.
    const { data: row } = await supabase
      .from("portal_invites")
      .select("id, organization_id, client_id, status, expires_at")
      .eq("token", token)
      .maybeSingle();
    if (!row) throw new Error("Invite not found");
    const r = row as Row;
    const status = value(r.status);
    if (status === "revoked") throw new Error("Invite has been revoked");
    const exp = (r.expires_at as string | null) ?? null;
    if (status === "expired" || isExpired(exp)) {
      throw new Error("Invite has expired");
    }

    const inviteId = value(r.id);
    const clientId = value(r.client_id);
    const organizationId = value(r.organization_id);

    if (status === "pending") {
      await supabase
        .from("portal_invites")
        .update({ status: "accepted", accepted_at: new Date().toISOString() })
        .eq("id", inviteId);
      await supabase
        .from("clients")
        .update({ portal_status: "active" })
        .eq("id", clientId);
    }

    const ok = await setPortalSessionCookie({
      clientId,
      organizationId,
      inviteId,
      issuedAt: Date.now(),
    });
    if (!ok) {
      throw new Error(
        "Portal session secret is not configured. Set PORTAL_SESSION_SECRET (or SESSION_SECRET) and try again.",
      );
    }
    redirect("/portal/home");
  }

  const alreadyAccepted = invite.status === "accepted";

  return (
    <main style={containerStyle}>
      <h1 style={{ marginTop: 0 }}>Welcome, {patientName}</h1>
      <p>
        {practice} has invited you to access your patient portal. Continue to view your upcoming
        appointments, balance, and shared documents.
      </p>
      <form action={acceptInvite}>
        <button type="submit" style={buttonStyle}>
          {alreadyAccepted ? "Open portal" : "Continue to portal"}
        </button>
      </form>
      <p style={{ fontSize: 13, color: "#4b5563", marginTop: 24 }}>
        If you have questions, please contact {practice} directly.
      </p>
    </main>
  );
}
