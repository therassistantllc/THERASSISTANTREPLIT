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

function NoticeShell({
  practice,
  title,
  body,
}: {
  practice: string;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <main className="portal-shell-narrow">
      <div className="portal-header">
        <div>
          <div className="eyebrow">{practice}</div>
          <h1>{title}</h1>
        </div>
      </div>
      <section className="panel">
        <p className="muted" style={{ margin: 0 }}>
          {body}
        </p>
      </section>
    </main>
  );
}

export default async function PatientPortalInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const { invite, client, practice, error } = await loadInvite(token);

  if (error || !invite) {
    return (
      <NoticeShell
        practice="Patient portal"
        title="Portal link not found"
        body="This portal invite link is invalid. Please contact your care team to request a new invitation."
      />
    );
  }

  if (invite.status === "revoked") {
    return (
      <NoticeShell
        practice={practice}
        title="Invite revoked"
        body={`This portal invite has been revoked. Please contact ${practice} for a new invite.`}
      />
    );
  }

  if (isExpired(invite.expiresAt) || invite.status === "expired") {
    return (
      <NoticeShell
        practice={practice}
        title="Invite expired"
        body={`This portal invite has expired. Please contact ${practice} to request a fresh invitation.`}
      />
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
    <main className="portal-shell-narrow">
      <div className="portal-header">
        <div>
          <div className="eyebrow">{practice}</div>
          <h1>Welcome, {patientName}</h1>
        </div>
      </div>
      <section className="panel">
        <p style={{ marginTop: 0, color: "var(--text)" }}>
          {practice} has invited you to access your patient portal. Continue to view your upcoming
          appointments, balance, and shared documents.
        </p>
        <form action={acceptInvite}>
          <button type="submit" className="button">
            {alreadyAccepted ? "Open portal" : "Continue to portal"}
          </button>
        </form>
        <p className="muted" style={{ fontSize: 13, marginTop: 20, marginBottom: 0 }}>
          If you have questions, please contact {practice} directly.
        </p>
      </section>
    </main>
  );
}
