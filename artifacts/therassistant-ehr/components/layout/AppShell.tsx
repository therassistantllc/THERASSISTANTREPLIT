import Link from "next/link";
import AppSidebarNav from "./AppSidebarNav";
import styles from "./AppShell.module.css";
import { ORGANIZATION_ID } from "@/lib/config";
import { createServerSupabaseAdminClient } from "@/lib/supabase/server";

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
  const orgName = await fetchOrgName();
  return (
    <div className={styles.frame}>
      {/* Top utility bar */}
      <header className={styles.topbar}>
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
        <aside className={styles.sidebar} aria-label="Application navigation">
          <AppSidebarNav />
        </aside>
        <div className={styles.content}>
          {children}
        </div>
      </div>
    </div>
  );
}
