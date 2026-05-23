const containerStyle: React.CSSProperties = {
  maxWidth: 520,
  margin: "64px auto",
  padding: 24,
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
};

export default function PortalSignedOutPage() {
  return (
    <main style={containerStyle}>
      <h1 style={{ marginTop: 0 }}>You&apos;re signed out</h1>
      <p>
        You have been signed out of your patient portal. To return, open the most recent invite
        link your care team sent you. If you no longer have the link, please contact your care
        team to request a new one.
      </p>
    </main>
  );
}
