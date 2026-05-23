import Link from "next/link";
import { headers } from "next/headers";
import AppSidebarNav from "./AppSidebarNav";
import MobileNavButton from "./MobileNavButton";
import styles from "./AppShell.module.css";
import { ORGANIZATION_ID } from "@/lib/config";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

const CHROMELESS_PREFIXES = ["/portal"];

async function fetchOrgName(): Promise<string | null> {
  if (!ORGANIZATION_ID) return null;
  const supabase = createServerSupabaseAdminClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", ORGANIZATION_ID)
      .maybeSingle();
    if (error) return null;
    const name = (data as { name?: string | null } | null)?.name;
    return typeof name === "string" && name.trim().length > 0 ? name : null;
  } catch {
    return null;
  }
}

export default async function AppShell({ children }: { children: React.ReactNode }) {
  const hdrs = await headers();
  const pathname = hdrs.get("x-pathname") ?? "";
  if (CHROMELESS_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return <>{children}</>;
  }
  const orgName = await fetchOrgName();
  return (
    <div className={styles.frame}>
      {/* Top utility bar */}
      <header className={styles.topbar}>
        <MobileNavButton />
        <Link className={styles.brand} href="/">
          <span className={styles.brandName}>THERASSISTANT</span>
          <span className={styles.brandTag}>EHR</span>
        </Link>
        {orgName ? (
          <Link href="/settings/organizations" className={styles.orgName} title="Manage organizations" style={{ textDecoration: "none" }}>
            {orgName}
          </Link>
        ) : (
          <Link href="/settings/organizations" className={styles.orgName} title="Create an organization" style={{ textDecoration: "none" }}>
            + Add organization
          </Link>
        )}
        <div className={styles.topbarSpacer} />
        <div className={styles.topbarRight}>
          <span className={styles.userAvatar} aria-label="User menu">TA</span>
        </div>
      </header>

      {/* Body: sidebar + content */}
      <div className={styles.body}>
        <aside
          id="app-sidebar"
          data-app-sidebar
          className={styles.sidebar}
          aria-label="Application navigation"
        >
          <AppSidebarNav />
        </aside>
        <div className={styles.content}>
          {children}
        </div>
      </div>
    </div>
  );
}
