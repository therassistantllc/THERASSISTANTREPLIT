import BillingDetailsClient from "./BillingDetailsClient";

export default async function EncounterBillingDetailsPage({ params }: { params: Promise<{ encounterId: string }> }) {
  const { encounterId } = await params;
  return <BillingDetailsClient encounterId={encounterId} />;
}
