-- Atomic 837P batch creation.
--
-- Wraps the insert / link / status-flip sequence performed by the
-- Ready-to-Generate bulk-batch and single-claim "generate" endpoints in
-- a single Postgres function body so the three writes either all
-- commit or all roll back. Eliminates the partial-write window that
-- the previous best-effort JS rollback could not close if the process
-- was killed mid-sequence.

create or replace function public.create_837p_batch_atomic(
  p_organization_id uuid,
  p_claim_ids uuid[],
  p_batch_number text,
  p_payer_profile_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_count integer;
  v_total numeric(12,2);
  v_archived integer;
  v_held integer;
  v_not_ready integer;
  v_wrong_payer integer;
  v_batch_id uuid;
begin
  if p_organization_id is null then
    raise exception 'organization_id is required' using errcode = '22023';
  end if;
  if p_claim_ids is null or array_length(p_claim_ids, 1) is null then
    raise exception 'claim_ids must be a non-empty array' using errcode = '22023';
  end if;
  if p_batch_number is null or length(btrim(p_batch_number)) = 0 then
    raise exception 'batch_number is required' using errcode = '22023';
  end if;

  -- Lock the candidate claims for the duration of the transaction so a
  -- concurrent batch attempt cannot grab the same rows between our
  -- validation and our status flip.
  perform 1
  from public.professional_claims
  where organization_id = p_organization_id
    and id = any(p_claim_ids)
  for update;

  select count(*),
         coalesce(sum(coalesce(total_charge, 0)), 0),
         count(*) filter (where archived_at is not null),
         count(*) filter (where held_at is not null),
         count(*) filter (where claim_status <> 'ready_for_batch'),
         count(*) filter (
           where p_payer_profile_id is not null
             and (payer_profile_id is distinct from p_payer_profile_id)
         )
    into v_count, v_total, v_archived, v_held, v_not_ready, v_wrong_payer
  from public.professional_claims
  where organization_id = p_organization_id
    and id = any(p_claim_ids);

  if v_count <> array_length(p_claim_ids, 1) then
    raise exception 'one or more claims not found in organization'
      using errcode = 'P0002';
  end if;
  if v_archived > 0 then
    raise exception '% selected claim(s) are archived', v_archived
      using errcode = '22023';
  end if;
  if v_held > 0 then
    raise exception '% selected claim(s) are on hold; release the hold(s) before batching', v_held
      using errcode = '22023';
  end if;
  if v_not_ready > 0 then
    raise exception '% selected claim(s) are not ready_for_batch', v_not_ready
      using errcode = '22023';
  end if;
  if v_wrong_payer > 0 then
    raise exception '% selected claim(s) do not match the requested payer', v_wrong_payer
      using errcode = '22023';
  end if;

  insert into public.claim_837p_batches (
    organization_id,
    batch_number,
    batch_status,
    claim_count,
    total_charge_amount,
    created_at,
    updated_at
  ) values (
    p_organization_id,
    p_batch_number,
    'ready_to_generate',
    v_count,
    v_total,
    v_now,
    v_now
  )
  returning id into v_batch_id;

  insert into public.claim_837p_batch_claims (
    organization_id,
    batch_id,
    professional_claim_id,
    created_at
  )
  select p_organization_id, v_batch_id, c, v_now
    from unnest(p_claim_ids) as c;

  update public.professional_claims
     set claim_status = 'batched',
         updated_at = v_now
   where organization_id = p_organization_id
     and id = any(p_claim_ids);

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'batch_number', p_batch_number,
    'claim_count', v_count,
    'total_charge_amount', v_total
  );
end;
$$;

-- Server-side only: the API routes call this via the service-role
-- admin client (createServerSupabaseAdminClient), which already runs
-- requireBillingAccess for org-membership checks. The function is
-- SECURITY DEFINER and trusts whatever organization_id is passed in,
-- so we MUST NOT grant execute to `authenticated` — that would let a
-- logged-in client invoke it directly with any organization_id /
-- claim_ids they can guess and bypass app-layer authorization.
revoke all on function public.create_837p_batch_atomic(uuid, uuid[], text, uuid) from public;
revoke all on function public.create_837p_batch_atomic(uuid, uuid[], text, uuid) from authenticated, anon;
grant execute on function public.create_837p_batch_atomic(uuid, uuid[], text, uuid) to service_role;

select pg_notify('pgrst', 'reload schema');
