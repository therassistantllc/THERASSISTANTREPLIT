-- COB Issues "Bill secondary" / "Bill primary" support.
--
-- When a biller clicks "Bill secondary" from the COB Issues queue we now
-- clone the original (primary-billed) claim into a child claim payable to
-- the secondary policy's payer, stamping the prior-payer (primary) paid /
-- adjustment / patient-responsibility amounts onto the child so the 837P
-- assembler can populate Loop 2320 (SBR*S / AMT / CAS) without having to
-- re-derive them from ERA at assembly time.
--
-- "Bill primary" simply re-points an existing claim that was sent to the
-- wrong (secondary) payer back at the correct primary payer; no new
-- columns needed for that path beyond `cob_billing_role`.
--
-- Resolution: the child claim links back to the original via
-- `original_claim_id` (added in 20260607000000_corrected_claim_columns).
-- The COB row in the queue resolves once the child claim transmits
-- (claim_status in 'submitted','accepted_oa','accepted_payer','paid').

alter table public.professional_claims
  add column if not exists prior_payer_paid_amount                   numeric(12,2),
  add column if not exists prior_payer_adjustment_amount             numeric(12,2),
  add column if not exists prior_payer_patient_responsibility_amount numeric(12,2),
  add column if not exists prior_payer_profile_id                    uuid
    references public.payer_profiles(id) on delete set null,
  add column if not exists prior_payer_eob_data                      jsonb,
  add column if not exists cob_billing_role                          text;

do $$
begin
  if not exists (
    select 1
      from information_schema.check_constraints
     where constraint_schema = 'public'
       and constraint_name   = 'professional_claims_cob_billing_role_check'
  ) then
    alter table public.professional_claims
      add constraint professional_claims_cob_billing_role_check
      check (
        cob_billing_role is null or
        cob_billing_role in ('primary', 'secondary', 'tertiary')
      );
  end if;
end$$;

create index if not exists idx_professional_claims_cob_billing_role
  on public.professional_claims (organization_id, cob_billing_role)
  where cob_billing_role is not null and archived_at is null;

notify pgrst, 'reload schema';
