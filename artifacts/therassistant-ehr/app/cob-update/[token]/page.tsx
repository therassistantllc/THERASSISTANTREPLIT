import CobUpdateClient from "./CobUpdateClient";

export const dynamic = "force-dynamic";

export default async function CobUpdatePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <CobUpdateClient token={token} />;
}
