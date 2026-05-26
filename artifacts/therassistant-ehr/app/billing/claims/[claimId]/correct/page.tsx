import ClaimCorrectionClient from "./ClaimCorrectionClient";

interface Props {
  params: Promise<{ claimId: string }>;
}

export default async function ClaimCorrectionPage({ params }: Props) {
  const { claimId } = await params;
  return <ClaimCorrectionClient claimId={claimId} />;
}
