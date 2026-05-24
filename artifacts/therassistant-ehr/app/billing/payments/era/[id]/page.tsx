import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function EraPosterLegacyRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/billing/era-import/${id}`);
}
