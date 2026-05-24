import Link from "next/link";

const ERROR_MESSAGES: Record<string, string> = {
  stripe_not_configured: "Online payment is not set up for your practice yet.",
  db_unavailable: "We could not reach our records. Please try again in a moment.",
  invoice_not_found: "We could not find that invoice on your account.",
  invoice_not_payable: "That invoice is already settled or cancelled.",
  no_balance: "That invoice has no remaining balance.",
  below_minimum: "The payment amount is below the $0.50 minimum for online payment.",
  invalid_amount: "Please enter a payment amount greater than $0.",
  amount_exceeds_balance: "The amount you entered is more than the remaining balance on that invoice.",
  no_connected_account: "Your practice has not finished setting up online payment yet — please contact them.",
  stripe_error: "Stripe rejected the request. Please try again.",
  missing_invoice: "No invoice was selected.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default async function PortalPaymentReturnPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const status = firstString(params.status);
  const reason = firstString(params.reason);

  let title = "Payment update";
  let message = "We could not determine the result of your payment.";
  let tone: "success" | "neutral" | "error" = "neutral";

  if (status === "success") {
    title = "Thanks — your payment is on the way";
    message =
      "Your card was charged successfully. It can take a moment for the balance to update on your account; refresh the portal in a minute if it hasn't caught up yet.";
    tone = "success";
  } else if (status === "cancelled") {
    title = "Payment cancelled";
    message = "No charge was made. You can return to the portal and try again whenever you're ready.";
    tone = "neutral";
  } else if (status === "error") {
    title = "We couldn't start that payment";
    message = ERROR_MESSAGES[reason] ?? "Something went wrong starting your payment.";
    tone = "error";
  }

  const toneClass = `portal-return-tone-${tone}`;

  return (
    <main className="portal-shell-narrow">
      <div className="portal-header">
        <div>
          <div className="eyebrow">Patient portal</div>
          <h1 className={toneClass}>{title}</h1>
        </div>
      </div>
      <section className="panel">
        <p style={{ margin: 0, color: "var(--text)", lineHeight: 1.5 }}>{message}</p>
        <div style={{ marginTop: 16 }}>
          <Link href="/portal/home" className="button button-secondary">
            Back to portal
          </Link>
        </div>
      </section>
    </main>
  );
}
