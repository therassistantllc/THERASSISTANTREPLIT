import PortalAccessClient from "./PortalAccessClient";

export default async function PatientPortalAccessPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  return (
    <main className="app-shell">
      <PortalAccessClient clientId={clientId} />
    </main>
  );
}
