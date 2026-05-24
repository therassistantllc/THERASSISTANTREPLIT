import { Metadata } from "next";
import MyInboxClient from "./MyInboxClient";

export const metadata: Metadata = {
  title: "My Inbox · Billing",
};

export const dynamic = "force-dynamic";

export default function Page() {
  return <MyInboxClient />;
}
