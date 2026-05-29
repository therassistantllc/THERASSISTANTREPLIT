-- Extend public.encounter_status enum to cover documentation-workflow values
-- that production code already writes (draft, in_review, signed, corrected).
-- Without these values, inserts/updates from lib/encounters/findOrCreate.ts,
-- lib/ehr/pipeline.ts, and lib/canonical-ehr/model.ts fail with
-- "invalid input value for enum encounter_status".

alter type public.encounter_status add value if not exists 'draft';
alter type public.encounter_status add value if not exists 'in_review';
alter type public.encounter_status add value if not exists 'signed';
alter type public.encounter_status add value if not exists 'corrected';

notify pgrst, 'reload schema';
