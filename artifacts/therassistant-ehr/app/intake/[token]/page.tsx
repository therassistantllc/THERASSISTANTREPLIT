import IntakeFormClient from "./IntakeFormClient";

export const dynamic = "force-dynamic";

export default async function IntakePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <IntakeFormClient token={token} />;
}
