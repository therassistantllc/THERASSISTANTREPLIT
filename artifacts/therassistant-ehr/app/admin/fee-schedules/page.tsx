import FeeSchedulesClient from "./FeeSchedulesClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Fee schedules",
};

export default function FeeSchedulesPage() {
  return <FeeSchedulesClient />;
}
