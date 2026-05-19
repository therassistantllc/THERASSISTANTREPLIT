import CheckInClient from "./CheckInClient";

export default async function PatientCheckInPage({ params }: { params: Promise<{ appointmentId: string }> }) {
  const { appointmentId } = await params;
  return <CheckInClient appointmentId={appointmentId} />;
}
