-- Task #598: Let billers split a paper check line into payment + adjustment + PR.
--
-- Today a paper_check_claim_matches row captures only `applied_amount`
-- (the paid portion against the claim balance). Real paper EOBs allocate
-- each line into three buckets: insurance payment, contractual adjustment
-- (write-off), and patient responsibility. We extend the match row so the
-- biller can record the split at match time and the `post_payment` action
-- can post it as a manual insurance payment with the same shape the
-- ERA-835 and manual-EOB intake paths already use (paid + adjustment +
-- patient_resp), and spawn a patient invoice when PR > 0.

alter table public.paper_check_claim_matches
  add column if not exists adjustment_amount numeric(12,2) not null default 0,
  add column if not exists patient_responsibility_amount numeric(12,2) not null default 0;

notify pgrst, 'reload schema';
