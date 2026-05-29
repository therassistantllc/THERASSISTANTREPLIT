import { redirect } from "next/navigation";
import { cookies } from "next/headers";

export default async function HomePage() {
  const jar = await cookies();
  const hasSupabaseSessionCookie = jar
    .getAll()
    .some((cookie) => /sb-.*-auth-token/.test(cookie.name));

  if (hasSupabaseSessionCookie) {
    redirect("/calendar");
  }

  redirect("/login");
}
