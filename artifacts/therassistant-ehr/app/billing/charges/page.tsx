import { redirect } from "next/navigation";

export default function ChargesPage() {
  redirect("/billing/charge-capture");
}
