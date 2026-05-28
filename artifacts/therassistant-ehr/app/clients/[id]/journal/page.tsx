import { getActiveOrganizationId } from "@/lib/server/getActiveOrganizationId";
import ClinicianJournalPanel from "@/components/encounter/ClinicianJournalPanel";

export default async function ClientJournalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const organizationId = await getActiveOrganizationId();
  return (
    <main className="app-shell">
      <section className="panel">
        <h2>Between-session journal</h2>
        <p className="muted">
          Entries the client has logged between visits — newest first. Use these as a starting
          point for the next session; from the SOAP editor you can import individual entries
          directly into the note.
        </p>
        <ClinicianJournalPanel
          clientId={id}
          organizationId={organizationId}
          mode="standalone"
          windowSinceLastSigned
        />
      </section>
    </main>
  );
}
