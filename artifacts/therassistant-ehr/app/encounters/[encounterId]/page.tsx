import EncounterNoteClient from "./EncounterNoteClient";

export default async function EncounterNotePage({ params }: { params: Promise<{ encounterId: string }> }) {
  const { encounterId } = await params;

  return (
    <main className="app-shell">
      <EncounterNoteClient encounterId={encounterId} />
    </main>
  );
}
