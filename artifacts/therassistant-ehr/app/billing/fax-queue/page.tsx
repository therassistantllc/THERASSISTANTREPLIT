import FaxQueueClient from "./FaxQueueClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Outbound Faxes",
};

export default function FaxQueuePage() {
  return <FaxQueueClient />;
}
