/**
 * Active payer-rule loader + finding projection.
 *
 * `payer_rules` (migration 20260610000000) is a catalog of rules created
 * from CARC-denial proposals on the Denied Claims by CARC workqueue.
 * The pre-submission Claim Content Validation engine calls
 * {@link loadActivePayerRules} for the claim's payer and converts each
 * active row into a ValidationFinding via {@link payerRuleToFinding},
 * so a matching pre-submission claim is auto-flagged (warn) or
 * auto-blocked (block) by the readiness gate.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ValidationFinding } from "../types";

export interface ActivePayerRule {
  id: string;
  payer_profile_id: string;
  carc_code: string | null;
  rule: string;
  action: "warn" | "block";
}

export async function loadActivePayerRules(
  supabase: SupabaseClient,
  organizationId: string,
  payerProfileId: string,
): Promise<ActivePayerRule[]> {
  const { data, error } = await (supabase as any)
    .from("payer_rules")
    .select("id, payer_profile_id, carc_code, rule, action")
    .eq("organization_id", organizationId)
    .eq("payer_profile_id", payerProfileId)
    .eq("status", "active")
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (error || !Array.isArray(data)) return [];
  return data
    .map((r: any) => ({
      id: String(r.id ?? ""),
      payer_profile_id: String(r.payer_profile_id ?? ""),
      carc_code: r.carc_code != null ? String(r.carc_code) : null,
      rule: String(r.rule ?? ""),
      action: r.action === "block" ? "block" : "warn",
    }))
    .filter((r) => (r as { id: string }).id.length > 0) as ActivePayerRule[];
}

export function payerRuleToFinding(
  rule: ActivePayerRule,
  payerName: string | null,
): ValidationFinding {
  const sev = rule.action === "block" ? "blocking" : "warning";
  const payerLabel = payerName?.trim() || "this payer";
  const carcLabel = rule.carc_code ? `CARC ${rule.carc_code}` : "a prior denial";
  const message =
    rule.action === "block"
      ? `${payerLabel} rule (${carcLabel}): submission blocked. ${rule.rule}`
      : `${payerLabel} rule (${carcLabel}): ${rule.rule}`;
  return {
    ruleId: `claim.payer_rule.${rule.id}`,
    category: "claimPayerRules",
    severity: sev,
    message,
    fixRoute: "/billing/denials-by-carc",
    whyItMatters:
      `This rule was created from a previous denial against ${payerLabel}` +
      `${rule.carc_code ? ` for CARC ${rule.carc_code}` : ""}. ` +
      (rule.action === "block"
        ? "Submitting without addressing it will likely repeat the denial."
        : "Confirm the claim does not repeat the original cause before submitting."),
    resolution:
      "Review the rule on the Denied Claims by CARC workqueue. If the rule is obsolete, archive it under Settings → Payer Rules; otherwise correct the underlying issue on the encounter or payer setup.",
    evidence: {
      payer_rule_id: rule.id,
      carc_code: rule.carc_code,
      action: rule.action,
      rule: rule.rule,
    },
  };
}
