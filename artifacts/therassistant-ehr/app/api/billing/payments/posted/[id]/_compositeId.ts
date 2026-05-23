/**
 * Shared composite-id parser for posted-payment routes.
 *
 * Composite id format: `<kind>:<uuid>` where kind ∈ era|cp|mi.
 * Strict UUID regex is enforced HERE (and not just on GET) so that no action
 * route — reverse/void/recoup/refund — can pass arbitrary suffix text into
 * downstream queries. This closes the filter-injection / malformed-query
 * surface across the whole posted-payment API.
 */
import type { PostedPaymentKind } from "@/lib/payments/postingEngine";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCompositePostedPaymentId(
  raw: string,
): { kind: PostedPaymentKind; id: string } | null {
  const idx = raw.indexOf(":");
  if (idx < 1) return null;
  const prefix = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  if (!UUID_RE.test(id)) return null;
  if (prefix === "era") return { kind: "era_835", id };
  if (prefix === "cp") return { kind: "client_payment", id };
  if (prefix === "mi") return { kind: "insurance_manual", id };
  return null;
}
