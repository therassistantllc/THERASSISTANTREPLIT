import EraPosterClient from "../../payments/era/[id]/EraPosterClient";

export const dynamic = "force-dynamic";

export default async function EraImportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EraPosterClient batchId={id} />;
}
