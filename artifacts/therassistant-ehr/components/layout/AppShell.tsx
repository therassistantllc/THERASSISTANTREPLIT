import Link from "next/link";
import AppSidebarNav from "./AppSidebarNav";
import styles from "./AppShell.module.css";

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.frame}>
      {/* Top utility bar */}
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/">
          <span className={styles.brandName}>THERASSISTANT</span>
          <span className={styles.brandTag}>EHR</span>
        </Link>
        <div className={styles.topbarSpacer} />
        <div className={styles.topbarRight}>
          <span className={styles.orgName}>Therassistant Demo</span>
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
