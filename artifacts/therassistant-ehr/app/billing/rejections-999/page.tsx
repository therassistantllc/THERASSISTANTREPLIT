import { Metadata } from "next";
import Rejections999Client from "./Rejections999Client";

export const metadata: Metadata = {
  title: "999 Rejections · Billing",
};

export const dynamic = "force-dynamic";

export default function Page() {
  return <Rejections999Client />;
}
