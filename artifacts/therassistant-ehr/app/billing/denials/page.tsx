import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function DenialsPage() {
  redirect("/billing/denials-by-carc");
}