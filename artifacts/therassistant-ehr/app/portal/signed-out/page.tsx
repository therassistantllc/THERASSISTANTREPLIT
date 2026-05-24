export default function PortalSignedOutPage() {
  return (
    <main className="portal-shell-narrow">
      <div className="portal-header">
        <div>
          <div className="eyebrow">Patient portal</div>
          <h1>You&apos;re signed out</h1>
        </div>
      </div>
      <section className="panel">
        <p className="muted" style={{ margin: 0 }}>
          You have been signed out of your patient portal. To return, open the most recent invite
          link your care team sent you. If you no longer have the link, please contact your care
          team to request a new one.
        </p>
      </section>
    </main>
  );
}
