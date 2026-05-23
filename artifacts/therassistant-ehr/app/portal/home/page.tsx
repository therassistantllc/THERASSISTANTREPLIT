import { redirect } from "next/navigation";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";
import {
  clearPortalSessionCookie,
  getPortalSession,
} from "@/lib/portal/session";

type Row = Record<string, unknown>;

function value(input: unknown) {
  return String(input ?? "").trim();
}

function formatMoney(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

type PortalData = {
  patientName: string;
  practiceName: string;
  appointments: Array<{
    id: string;
    startsAt: string | null;
    endsAt: string | null;
    status: string;
    type: string;
    providerName: string;
    telehealthUrl: string | null;
  }>;
  balance: {
    total: number;
    invoices: Array<{
      id: string;
      number: string;
      status: string;
      amount: number;
      paid: number;
      balance: number;
    }>;
  };
  documents: Array<{
    id: string;
    title: string;
    type: string;
    fileName: string | null;
    createdAt: string | null;
  }>;
};

async function loadPortalData(
  clientId: string,
  organizationId: string,
): Promise<PortalData | null> {
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return null;

  const nowIso = new Date().toISOString();

  const [clientRes, orgRes, apptsRes, invoicesRes, docsRes] = await Promise.all([
    supabase
      .from("clients")
      .select("first_name, last_name, preferred_name")
      .eq("id", clientId)
      .maybeSingle(),
    supabase.from("organizations").select("name").eq("id", organizationId).maybeSingle(),
    supabase
      .from("appointments")
      .select(
        "id, scheduled_start_at, scheduled_end_at, appointment_status, appointment_type, provider_id, telehealth_url",
      )
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .gte("scheduled_start_at", nowIso)
      .neq("appointment_status", "cancelled")
      .order("scheduled_start_at", { ascending: true })
      .limit(20),
    supabase
      .from("patient_invoices")
      .select(
        "id, invoice_number, invoice_status, patient_responsibility_amount, paid_amount, balance_amount",
      )
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .in("invoice_status", ["open", "sent", "collections"])
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("documents")
      .select("id, title, document_type, file_name, created_at")
      .eq("organization_id", organizationId)
      .eq("client_id", clientId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const client = (clientRes.data ?? {}) as Row;
  const practiceName =
    value((orgRes.data as Row | null)?.name) || "Your care team";
  const patientName =
    value(client.preferred_name) || value(client.first_name) || "there";

  const apptRows = (apptsRes.data ?? []) as Row[];
  const providerIds = Array.from(
    new Set(apptRows.map((r) => value(r.provider_id)).filter(Boolean)),
  );
  let providerNameById = new Map<string, string>();
  if (providerIds.length > 0) {
    const { data: provRows } = await supabase
      .from("providers")
      .select("id, first_name, last_name")
      .in("id", providerIds);
    providerNameById = new Map(
      ((provRows ?? []) as Row[]).map((r) => {
        const name = [value(r.first_name), value(r.last_name)].filter(Boolean).join(" ");
        return [value(r.id), name || "Your provider"];
      }),
    );
  }

  const appointments = apptRows.map((r) => ({
    id: value(r.id),
    startsAt: (r.scheduled_start_at as string | null) ?? null,
    endsAt: (r.scheduled_end_at as string | null) ?? null,
    status: value(r.appointment_status) || "scheduled",
    type: value(r.appointment_type),
    providerName: providerNameById.get(value(r.provider_id)) || "Your provider",
    telehealthUrl: (r.telehealth_url as string | null) ?? null,
  }));

  const invoiceRows = (invoicesRes.data ?? []) as Row[];
  const invoices = invoiceRows.map((r) => ({
    id: value(r.id),
    number: value(r.invoice_number) || value(r.id).slice(0, 8),
    status: value(r.invoice_status),
    amount: Number(r.patient_responsibility_amount ?? 0) || 0,
    paid: Number(r.paid_amount ?? 0) || 0,
    balance: Number(r.balance_amount ?? 0) || 0,
  }));
  const total = invoices.reduce((sum, inv) => sum + inv.balance, 0);

  const documents = ((docsRes.data ?? []) as Row[]).map((r) => ({
    id: value(r.id),
    title: value(r.title) || value(r.file_name) || "Untitled document",
    type: value(r.document_type) || "document",
    fileName: (r.file_name as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
  }));

  return {
    patientName,
    practiceName,
    appointments,
    balance: { total, invoices },
    documents,
  };
}

const pageWrap: React.CSSProperties = {
  maxWidth: 880,
  margin: "0 auto",
  padding: "24px 20px 64px",
};

const headerBar: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 16,
  marginBottom: 24,
};

const cardStyle: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 10,
  padding: 20,
  marginBottom: 20,
  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
};

const sectionTitle: React.CSSProperties = {
  margin: "0 0 12px",
  fontSize: 16,
  fontWeight: 700,
  color: "#10243f",
};

const mutedSmall: React.CSSProperties = { fontSize: 13, color: "#6b7280" };

const itemRow: React.CSSProperties = {
  padding: "12px 0",
  borderTop: "1px solid #eef1f5",
  display: "flex",
  justifyContent: "space-between",
  gap: 16,
  alignItems: "flex-start",
};

const signOutBtn: React.CSSProperties = {
  background: "transparent",
  color: "#4b5563",
  border: "1px solid #d0d8e2",
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 13,
  cursor: "pointer",
};

const joinLinkStyle: React.CSSProperties = {
  display: "inline-block",
  marginTop: 6,
  fontSize: 13,
  color: "#1d4ed8",
  textDecoration: "underline",
};

async function signOut() {
  "use server";
  await clearPortalSessionCookie();
  redirect("/portal/signed-out");
}

export default async function PatientPortalHomePage() {
  const session = await getPortalSession();
  if (!session) redirect("/portal/signed-out");

  const data = await loadPortalData(session.clientId, session.organizationId);
  if (!data) {
    return (
      <main style={pageWrap}>
        <div style={cardStyle}>
          <h1 style={{ marginTop: 0 }}>Portal unavailable</h1>
          <p>We could not load your portal right now. Please try again later.</p>
        </div>
      </main>
    );
  }

  const { patientName, practiceName, appointments, balance, documents } = data;

  return (
    <main style={pageWrap}>
      <div style={headerBar}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: 0.08, textTransform: "uppercase", color: "#6b7280" }}>
            {practiceName}
          </div>
          <h1 style={{ margin: "4px 0 0", fontSize: 24, color: "#10243f" }}>
            Hi, {patientName}
          </h1>
        </div>
        <form action={signOut}>
          <button type="submit" style={signOutBtn}>Sign out</button>
        </form>
      </div>

      {/* Upcoming appointments */}
      <section style={cardStyle} aria-labelledby="appts-heading">
        <h2 id="appts-heading" style={sectionTitle}>Upcoming appointments</h2>
        {appointments.length === 0 ? (
          <p style={mutedSmall}>You have no upcoming appointments scheduled.</p>
        ) : (
          <div>
            {appointments.map((appt) => (
              <div key={appt.id} style={itemRow}>
                <div>
                  <div style={{ fontWeight: 600 }}>{formatDateTime(appt.startsAt)}</div>
                  <div style={mutedSmall}>
                    {appt.type || "Appointment"} with {appt.providerName}
                  </div>
                  {appt.telehealthUrl ? (
                    <a href={appt.telehealthUrl} style={joinLinkStyle} target="_blank" rel="noreferrer">
                      Join telehealth visit
                    </a>
                  ) : null}
                </div>
                <span
                  style={{
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: 0.06,
                    color: "#6b7280",
                    background: "#f3f4f6",
                    borderRadius: 999,
                    padding: "2px 10px",
                    height: "fit-content",
                  }}
                >
                  {appt.status.replace(/_/g, " ")}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Outstanding balance */}
      <section style={cardStyle} aria-labelledby="balance-heading">
        <h2 id="balance-heading" style={sectionTitle}>Outstanding balance</h2>
        <div style={{ fontSize: 28, fontWeight: 700, color: balance.total > 0 ? "#b91c1c" : "#10243f" }}>
          {formatMoney(balance.total)}
        </div>
        <div style={{ ...mutedSmall, marginBottom: 8 }}>
          {balance.invoices.length === 0
            ? "You have no open invoices."
            : `${balance.invoices.length} open invoice${balance.invoices.length === 1 ? "" : "s"}.`}
        </div>
        {balance.invoices.map((inv) => (
          <div key={inv.id} style={itemRow}>
            <div>
              <div style={{ fontWeight: 600 }}>Invoice #{inv.number}</div>
              <div style={mutedSmall}>
                {formatMoney(inv.amount)} billed · {formatMoney(inv.paid)} paid
              </div>
            </div>
            <div style={{ fontWeight: 600 }}>{formatMoney(inv.balance)}</div>
          </div>
        ))}
        {balance.total > 0 ? (
          <p style={{ ...mutedSmall, marginTop: 12 }}>
            To pay your balance, please contact {practiceName}.
          </p>
        ) : null}
      </section>

      {/* Documents */}
      <section style={cardStyle} aria-labelledby="docs-heading">
        <h2 id="docs-heading" style={sectionTitle}>Documents</h2>
        {documents.length === 0 ? (
          <p style={mutedSmall}>No documents have been shared with you yet.</p>
        ) : (
          documents.map((doc) => (
            <div key={doc.id} style={itemRow}>
              <div>
                <div style={{ fontWeight: 600 }}>{doc.title}</div>
                <div style={mutedSmall}>
                  {doc.type.replace(/_/g, " ")}
                  {doc.createdAt ? ` · ${formatDate(doc.createdAt)}` : ""}
                </div>
              </div>
              <span style={mutedSmall}>{doc.fileName ?? ""}</span>
            </div>
          ))
        )}
        <p style={{ ...mutedSmall, marginTop: 12 }}>
          To request a copy of any document, please contact {practiceName}.
        </p>
      </section>
    </main>
  );
}
