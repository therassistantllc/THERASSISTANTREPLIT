-- Task #726 — surface Telnyx's terminal fax delivery status in the
-- Submission history.
--
-- Until now, claim_documentation_transmissions.status flipped straight to
-- 'sent' the moment Telnyx accepted the job. But Telnyx delivery is
-- asynchronous — the fax can still go busy / no-answer / line-dropped
-- downstream. Billers were left looking at "SENT" with no insight into
-- the real outcome.
--
-- We now widen the allowed status set so a reconciler (or webhook) can
-- write Telnyx's real lifecycle:
--
--   queued     → row written, not yet handed to provider
--   sending    → provider accepted the job, awaiting terminal status
--   delivered  → provider confirms terminal success
--   sent       → legacy synonym for delivered (kept for back-compat with
--                existing rows written before this change)
--   failed     → provider confirms terminal failure
--   logged     → channel='logged' (no actual transmission occurred)

alter table public.claim_documentation_transmissions
  drop constraint if exists claim_documentation_transmissions_status_check;

alter table public.claim_documentation_transmissions
  add constraint claim_documentation_transmissions_status_check
  check (status in ('queued','sending','sent','delivered','failed','logged'));

notify pgrst, 'reload schema';
