import MailroomItemClient from "./MailroomItemClient";

export default async function MailroomItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  return <MailroomItemClient itemId={itemId} />;
}
