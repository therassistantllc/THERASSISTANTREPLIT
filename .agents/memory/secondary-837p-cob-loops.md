---
name: Secondary 837P COB loops (5010X222A1)
description: Loop ordering and field requirements when generating a secondary 837P after primary adjudication. Required by any payer to process the downstream claim.
---

When emitting a secondary 837P, the COB loops must appear in this exact order
or the secondary payer will reject the claim or (worse) pay it as primary:

1. **2000B SBR** — `SBR*S*...*CI`. Responsibility code `S` because the
   *destination* payer is secondary. 2010BA / 2010BB carry the SECONDARY
   subscriber + payer.
2. **2320 SBR** — `SBR*P*...*CI`. The OTHER payer (primary) adjudication.
3. **2320 CAS** — claim-level adjustments from the primary 835/EOB.
4. **2320 AMT*D** — primary payer paid amount (CLP04 on the 835).
5. **2320 AMT*F2** — patient responsibility (CLP05 on the 835).
6. **2320 OI** — `OI***Y***Y` (release-of-info + benefits-assignment for
   the other payer).
7. **2330A NM1*IL** — primary subscriber name + member id.
8. **2330B NM1*PR** — primary payer name + id.
9. **2400 SVD** per service line — `SVD*<otherPayerId>*<paidAmt>*HC:<proc>**<units>`.
10. **2400 CAS** per line — line-level adjustments tied to the SVD.
11. **2400 DTP*573** — primary payer's adjudication date (D8 YYYYMMDD).

**Why:** Payers ignore the 2320 AMT totals if the per-line SVD/CAS doesn't
tie back; without DTP*573 the secondary side cannot reconcile timing for
their own COB rules. Skipping 2330A/2330B causes immediate rejection (no
"other subscriber" identified).

**How to apply:**
- Build the COB summary from `era_claim_payments` when present
  (cas_adjustments[] for claim level, service_lines[].cas_adjustments[]
  for line level). Match ERA service_lines to claim service_lines by
  `service_line_id` first, falling back to `procedure_code`.
- When only a manual EOB exists, emit claim-level AMT*D / AMT*F2 from the
  claim's payer/patient responsibility totals and SKIP per-line SVD/CAS —
  the data isn't trustworthy without an 835.
- The parties snapshot needs to be REWRITTEN for the secondary submission:
  swap `subscriber_*` and `payer_*` to the secondary policy's holder + payer
  before passing to the emitter. The primary identity goes into 2330A/2330B.
- `claim_837p_batch_claims` has a per-(org, claim, submission_kind) unique
  index; archive any prior active secondary link before inserting a new one,
  or the insert fails with a constraint violation.
