import PatientBalanceClient from "./PatientBalanceClient";

export default async function PatientBalancePage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;

  return (
    <main className="app-shell">
      <PatientBalanceClient clientId={clientId} />
    </main>
  );
}
