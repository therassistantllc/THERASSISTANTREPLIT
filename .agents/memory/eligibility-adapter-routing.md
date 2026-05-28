---
name: Eligibility adapter routing (Phase 2 wiring)
description: How ClearinghouseService.runEligibility picks SOAP vs Mock and the field-shape contract every CORE eligibility adapter must satisfy.
---

The CAQH CORE 270/271 path is fronted by a tiny structural-type contract — `CoreEligibilityAdapter.runEligibilityCORE(Eligibility270Input) → CoreEligibilityRunResult` — and picked at runtime from `clearinghouse_connections.vendor`. The legacy `ClearinghouseAdapter.runEligibility270(EligibilityRequestInput)` shim still exists but its Availity implementation **throws**; never add new callers to it.

**Why:** The rich `Eligibility270Input` carries subscriber DOB and provider NPI, both required by CAQH CORE Data Content Rule but absent from the older flat `EligibilityRequestInput`. Routing every caller through the rich shape lets the SOAP/X12 path, the REST Coverages path, and the Mock path stay transport-agnostic and share one persistence flow (parse271 → attribution routing → `eligibility_checks` insert).

**How to apply:**
- New eligibility transports implement `CoreEligibilityAdapter` and return the legacy `EligibilityResponseNormalized` (including `attribution`) via `parsed271ToLegacyNormalized`.
- Routing decision lives in `pickEligibilityAdapter({ vendor })`; default branch is Mock — safe for unknown vendors but means a new real vendor (`change_healthcare`, etc.) silently mocks until added.
- Field defaults that are NOT in the DB schema today live in `buildEligibility270InputFromContext` and pull from `AVAILITY_DEFAULT_PROVIDER_NPI` / `AVAILITY_DEFAULT_PROVIDER_LAST_NAME` / `AVAILITY_DEFAULT_PROVIDER_FIRST_NAME` / `AVAILITY_DEFAULT_SUBMITTER_ID` / `AVAILITY_DEFAULT_SUBMITTER_NAME`. Missing provider NPI is intentionally left empty so `validate270` fails loudly at emission.
- Subscriber identity defaults to the client's (self-coverage). When the schema gains real subscriber columns, extend `BuilderPolicy` and the SQL select in `ClearinghouseService.runEligibility` together — the builder already accepts `subscriber_first_name/last_name/dob/gender`.
- `ClearinghouseService` still keeps `private adapter = new MockClearinghouseAdapter()` because the 276/277 claim-status path has not been migrated. Removing it will break `runClaimStatus`.
