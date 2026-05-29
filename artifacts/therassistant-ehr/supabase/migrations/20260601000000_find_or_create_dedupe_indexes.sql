-- Task #184: sweep the remaining read-then-insert spots in the EHR with
-- the same race protection that Task #148 added for encounters/notes.
--
-- Every index here matches a find-or-create pair in the app:
--   * select existing row keyed by (org, business key)
--   * insert if missing
-- Two near-simultaneous callers used to both miss the SELECT and both
-- INSERT, producing duplicate rows. A partial unique index closes the
-- race; application code (see lib/db/findOrCreate.ts) catches the
-- resulting 23505 unique_violation and re-selects the winning row, so
-- concurrent retries deterministically return the same id.
--
-- All indexes are partial on `archived_at is null` so a row can be
-- legitimately re-created for the same business key after the prior one
-- is archived (mirrors idx_encounters_unique_active_appointment and
-- uq_workqueue_items_open_source_dedupe).

do $$
begin
  -- 1. professional_claims: one live claim per signed encounter.
  -- Callers: app/api/claims/create-from-encounter/route.ts,
  --          app/api/lifecycle/run-full-flow/route.ts.
  if to_regclass('public.professional_claims') is not null then
    create unique index if not exists idx_professional_claims_unique_active_encounter
      on public.professional_claims (organization_id, encounter_id)
      where archived_at is null and encounter_id is not null;
  end if;

  -- 2. payment_postings: one live posting per payment_import_item.
  -- Callers: app/api/payments/post/route.ts,
  --          app/api/lifecycle/run-full-flow/route.ts.
  if to_regclass('public.payment_postings') is not null then
    create unique index if not exists idx_payment_postings_unique_active_import_item
      on public.payment_postings (payment_import_item_id)
      where archived_at is null and payment_import_item_id is not null;
  end if;

  -- 3. payment_import_batches: one live ingest per (org, source file hash).
  -- Caller: app/api/clearinghouse/availity/era-835/route.ts. The hash
  -- check today returns 409 before insert; the index turns the racing
  -- second writer's INSERT into a 23505 we catch and convert to the
  -- same 409 response.
  if to_regclass('public.payment_import_batches') is not null then
    create unique index if not exists idx_payment_import_batches_unique_active_file_hash
      on public.payment_import_batches (organization_id, source_file_hash)
      where archived_at is null and source_file_hash is not null;
  end if;

  -- 4. era_posting_ledger_entries: one live entry per
  -- (org, era_claim_payment, entry_type). The posting engine writes up
  -- to three entries per claim (insurance_payment, contractual_adjustment,
  -- patient_responsibility); double-posting any one of them would skew
  -- balances. Caller: lib/payments/postingEngine/index.ts createLedgerEntry.
  if to_regclass('public.era_posting_ledger_entries') is not null then
    create unique index if not exists idx_era_posting_ledger_entries_unique_active
      on public.era_posting_ledger_entries (organization_id, era_claim_payment_id, entry_type)
      where archived_at is null;
  end if;

  -- 5. patient_invoices: one live invoice per ERA claim payment.
  -- Caller: lib/payments/postingEngine/index.ts createPatientInvoiceIfNeeded.
  if to_regclass('public.patient_invoices') is not null then
    create unique index if not exists idx_patient_invoices_unique_active_era_payment
      on public.patient_invoices (organization_id, era_claim_payment_id)
      where archived_at is null and era_claim_payment_id is not null;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
