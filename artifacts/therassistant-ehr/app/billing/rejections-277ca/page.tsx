import type { Metadata } from "next";
import Rejections277CaClient from "./Rejections277CaClient";

export const metadata: Metadata = {
  title: "277CA Rejections · Billing",
};

export const dynamic = "force-dynamic";

export default function Page() {
  return <Rejections277CaClient />;
}
