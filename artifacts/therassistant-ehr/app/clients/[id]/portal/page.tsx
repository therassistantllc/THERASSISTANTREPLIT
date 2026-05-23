import PortalAccessClient from "@/app/patients/[clientId]/portal/PortalAccessClient";

export default async function ClientPortalAccessPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="app-shell">
      <PortalAccessClient clientId={id} />
    </main>
  );
}
