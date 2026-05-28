"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type PortalInvite = {
  id: string;
  token: string;
  url: string;
  status: string;
  expiresAt: string | null;
  createdAt: string | null;
  acceptedAt: string | null;
  deliveryMethod: string;
  deliveredToEmail: string | null;
  deliveredAt: string | null;
  deliveryError: string | null;
  deliveryStatus: string | null;
  deliveryStatusAt: string | null;
};

type PatientLite = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
};

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function statusLabel(status: string): string {
  switch (status) {
    case "not_invited":
      return "Not invited";
    case "invited":
      return "Invite sent";
    case "active":
      return "Active";
    case "revoked":
      return "Revoked";
    default:
      return status || "Unknown";
  }
}

export default function PortalAccessClient({ clientId }: { clientId: string }) {
  const [client, setClient] = useState<PatientLite | null>(null);
  const [portalStatus, setPortalStatus] = useState<string>("not_invited");
  const [invites, setInvites] = useState<PortalInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [summaryRes, invitesRes] = await Promise.all([
        fetch(`/api/patients/${encodeURIComponent(clientId)}/summary`, { cache: "no-store" }),
        fetch(`/api/portal/invites?clientId=${encodeURIComponent(clientId)}`, { cache: "no-store" }),
      ]);
      const summaryJson = await summaryRes.json().catch(() => null);
      const p = summaryJson?.client ?? summaryJson?.data?.client ?? null;
      if (summaryRes.ok && p) {
        setClient({
          id: p.id ?? clientId,
          firstName: p.firstName ?? p.first_name ?? null,
          lastName: p.lastName ?? p.last_name ?? null,
          email: p.email ?? null,
        });
      }
      const invitesJson = await invitesRes.json().catch(() => null);
      if (invitesRes.ok && invitesJson?.success) {
        setInvites(invitesJson.invites ?? []);
        setPortalStatus(invitesJson.portalStatus ?? "not_invited");
      } else if (invitesJson?.error) {
        setError(invitesJson.error);
      }
    } catch (loadErr) {
      setError(loadErr instanceof Error ? loadErr.message : "Failed to load portal status");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    load();
  }, [load]);

  async function revokeInvite(inviteId: string) {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        "Revoke this pending portal invite? The client will not be able to use the existing link.",
      );
      if (!ok) return;
    }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(`/api/portal/invites`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteId }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json?.success) {
        throw new Error(json?.error ?? "Failed to revoke portal invite");
      }
      setMessage("Portal invite revoked.");
      await load();
    } catch (revokeErr) {
      setError(revokeErr instanceof Error ? revokeErr.message : "Failed to revoke portal invite");
    } finally {
      setBusy(false);
    }
  }

  async function createInvite(delivery: "clipboard" | "email") {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(`/api/portal/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, delivery }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Failed to create portal invite");
      }
      const url =
        typeof window !== "undefined" ? `${window.location.origin}${json.invite.url}` : json.invite.url;
      if (delivery === "email") {
        const to = json.email?.to ?? "the client";
        setMessage(`Portal invite emailed to ${to}.`);
      } else {
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            await navigator.clipboard.writeText(url);
            setMessage(`Portal invite copied to clipboard: ${url}`);
          } else {
            setMessage(`Portal invite link: ${url}`);
          }
        } catch {
          setMessage(`Portal invite link: ${url}`);
        }
      }
      await load();
    } catch (createErr) {
      setError(createErr instanceof Error ? createErr.message : "Failed to create portal invite");
    } finally {
      setBusy(false);
    }
  }

  const patientName = client
    ? [client.firstName, client.lastName].filter(Boolean).join(" ") || "this client"
    : "this client";
  const hasEmail = Boolean(client?.email);
  const activeInvite = invites.find((inv) => inv.status === "pending") ?? null;

  return (
    <section className="summary-block" aria-label="Portal access" style={{ maxWidth: 720 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Client portal access</h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Manage portal invites for {patientName}.
          </p>
        </div>
        <Link href={`/clients/${clientId}`} className="summary-rail-action">
          Back to chart
        </Link>
      </header>

      {loading ? (
        <p className="muted" style={{ marginTop: 16 }}>Loading portal status…</p>
      ) : (
        <>
          <div style={{ marginTop: 16, padding: 12, border: "1px solid #e5e7eb", borderRadius: 6 }}>
            <div>
              <strong>Current status:</strong> {statusLabel(portalStatus)}
            </div>
            {activeInvite ? (
              <div style={{ marginTop: 8, fontSize: 13, color: "#4b5563" }}>
                <div>
                  Active invite created {formatDateTime(activeInvite.createdAt)} · expires{" "}
                  {formatDateTime(activeInvite.expiresAt)}
                  {activeInvite.deliveredToEmail
                    ? ` · last sent to ${activeInvite.deliveredToEmail}`
                    : ""}
                </div>
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="summary-rail-action"
                    onClick={() => revokeInvite(activeInvite.id)}
                    disabled={busy}
                    title="Revoke this pending portal invite so the link can no longer be used"
                  >
                    {busy ? "Working…" : "Revoke invite"}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 13, color: "#4b5563" }}>
                No active invite. Send one below to give the client portal access.
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
            <button
              type="button"
              className="summary-rail-action"
              onClick={() => createInvite("email")}
              disabled={busy || !hasEmail}
              title={
                hasEmail
                  ? `Email portal invite to ${client?.email}`
                  : "No email on file — add one to the chart to email an invite"
              }
            >
              {busy ? "Sending…" : activeInvite ? "Resend invite by email" : "Send invite by email"}
            </button>
            <button
              type="button"
              className="summary-rail-action"
              onClick={() => createInvite("clipboard")}
              disabled={busy}
            >
              {busy ? "Generating…" : "Copy invite link"}
            </button>
          </div>

          {message ? <div className="alert-panel" style={{ marginTop: 12 }}>{message}</div> : null}
          {error ? (
            <div className="alert-panel" style={{ marginTop: 12, color: "#b91c1c" }}>
              {error}
            </div>
          ) : null}

          <h3 style={{ marginTop: 24 }}>Invite history</h3>
          {invites.length === 0 ? (
            <p className="muted">No portal invites have been sent yet.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {invites.map((inv) => (
                <li
                  key={inv.id}
                  style={{
                    padding: "8px 0",
                    borderBottom: "1px solid #e5e7eb",
                    fontSize: 13,
                  }}
                >
                  <div>
                    <strong>{inv.status}</strong> · {inv.deliveryMethod}
                    {inv.deliveredToEmail ? ` → ${inv.deliveredToEmail}` : ""}
                  </div>
                  <div className="muted">
                    Created {formatDateTime(inv.createdAt)} · expires {formatDateTime(inv.expiresAt)}
                    {inv.acceptedAt ? ` · accepted ${formatDateTime(inv.acceptedAt)}` : ""}
                  </div>
                  {inv.deliveryError ? (
                    <div style={{ color: "#b91c1c" }}>Delivery error: {inv.deliveryError}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
