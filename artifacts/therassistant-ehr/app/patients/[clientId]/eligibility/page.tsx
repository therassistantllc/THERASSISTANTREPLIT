import EligibilityDetailClient from "./EligibilityDetailClient";

export default async function PatientEligibilityPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return <EligibilityDetailClient clientId={clientId} />;
}
