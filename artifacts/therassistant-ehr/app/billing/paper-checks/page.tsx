import type { Metadata } from "next";
import PaperChecksClient from "./PaperChecksClient";

export const metadata: Metadata = {
  title: "Paper Checks · Billing",
};

export const dynamic = "force-dynamic";

export default function Page() {
  return <PaperChecksClient />;
}
