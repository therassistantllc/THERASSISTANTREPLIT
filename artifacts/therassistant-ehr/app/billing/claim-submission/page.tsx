import { redirect } from "next/navigation";

export const metadata = {
  title: "Denied Claims by CARC",
};

export default function ClaimSubmissionRedirect() {
  redirect("/billing/denials-by-carc");
}
