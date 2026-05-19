import PatientChartClient from "@/app/patients/[clientId]/PatientChartClient";

export default async function ClientChartPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <main className="app-shell">
      <PatientChartClient clientId={id} />
    </main>
  );
}
