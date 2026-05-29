-- Atomic queue-action dispatcher (Task #615).
--
-- The 12 second-wave billing workqueues each need their row actions
-- (approve write-off, release hold, propose refund, …) to (a) mutate
-- the underlying record AND (b) stamp an audit_logs row, atomically.
-- Doing the two writes from app code can leave inconsistent history
-- if the second write fails, and multi-step actions (insert-reversal
-- + link-back) can leave orphans.
--
-- This function moves the dispatch into a single Postgres transaction.
-- Every branch either applies its mutation AND writes the audit log,
-- or raises and the whole thing rolls back.

create or replace function public.record_queue_action_atomic(
  p_organization_id uuid,
  p_endpoint text,
  p_action text,
  p_row_id uuid,
  p_user_id uuid,
  p_extras jsonb,
  p_target_tab text,
  p_event_type text,
  p_event_summary text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_mutation jsonb := null;
  v_rows int;
  v_era record;
  v_orig_adj record;
  v_balance record;
  v_shortfall numeric(12,2);
  v_credit numeric(12,2);
  v_reversal_id uuid;
  v_inserted_id uuid;
  v_note text;
begin
  if p_organization_id is null then
    raise exception 'organization_id is required' using errcode = '22023';
  end if;
  if p_row_id is null then
    raise exception 'row_id is required' using errcode = '22023';
  end if;

  v_note := nullif(btrim(coalesce(p_extras->>'note', '')), '');

  -- ── 1. payer-rejections / resubmissions / compliance-holds ───────────
  if p_endpoint in ('payer-rejections', 'resubmissions', 'compliance-holds') then
    declare
      v_new_status text := null;
      v_patch jsonb;
    begin
      if p_endpoint = 'payer-rejections' then
        v_new_status := case p_action
          when 'mark_resubmitted' then 'submitted'
          when 'mark_fixed' then 'ready_to_submit'
          when 'reopen' then 'rejected_payer'
          else null end;
      elsif p_endpoint = 'resubmissions' then
        v_new_status := case p_action
          when 'queue_for_batch' then 'ready_to_submit'
          when 'mark_submitted' then 'submitted'
          when 'block' then 'held'
          when 'reopen' then 'ready_to_submit'
          else null end;
      else
        v_new_status := case p_action
          when 'release' then 'ready_to_submit'
          when 'reopen' then 'held'
          else null end;
      end if;

      if v_new_status is not null then
        if p_action in ('mark_resubmitted', 'mark_submitted') then
          update public.professional_claims
             set claim_status = v_new_status,
                 submitted_at = v_now,
                 last_billed_date = v_now::date,
                 updated_at = v_now
           where organization_id = p_organization_id and id = p_row_id;
        else
          update public.professional_claims
             set claim_status = v_new_status, updated_at = v_now
           where organization_id = p_organization_id and id = p_row_id;
        end if;
        get diagnostics v_rows = row_count;
        if v_rows = 0 then
          raise exception 'claim % not found in organization %', p_row_id, p_organization_id
            using errcode = 'P0002';
        end if;
        v_mutation := jsonb_build_object(
          'table', 'professional_claims',
          'id', p_row_id,
          'patch', jsonb_build_object('claim_status', v_new_status)
        );
      end if;
    end;

  -- ── 2. partial-denials ────────────────────────────────────────────────
  elsif p_endpoint = 'partial-denials' then
    if p_action = 'write_off' then
      select id, professional_claim_id, client_id,
             clp03_total_charge, clp04_payment_amount
        into v_era
        from public.era_claim_payments
       where organization_id = p_organization_id and id = p_row_id;
      if not found then
        raise exception 'era payment % not found', p_row_id using errcode = 'P0002';
      end if;
      v_shortfall := round(
        greatest(0, coalesce(v_era.clp03_total_charge, 0) - coalesce(v_era.clp04_payment_amount, 0)),
        2);
      if v_shortfall <= 0 then
        raise exception 'no shortfall to write off on era payment %', p_row_id
          using errcode = '22023';
      end if;
      insert into public.payment_adjustments (
        organization_id, professional_claim_id, client_id, era_claim_payment_id,
        adjustment_type, group_code, reason_code, amount, scope, source,
        description, posted_at, posted_by_user_id
      ) values (
        p_organization_id, v_era.professional_claim_id, v_era.client_id, v_era.id,
        'write_off', 'CO', '45', v_shortfall, 'claim', 'workqueue_partial_denial_write_off',
        coalesce(v_note, 'Partial-denial write-off from workqueue'),
        v_now, p_user_id
      ) returning id into v_inserted_id;
      v_mutation := jsonb_build_object(
        'table', 'payment_adjustments',
        'inserted_id', v_inserted_id,
        'amount', v_shortfall,
        'era_claim_payment_id', v_era.id
      );
    elsif p_action = 'mark_recovered' then
      update public.era_claim_payments
         set posting_status = 'posted', updated_at = v_now
       where organization_id = p_organization_id and id = p_row_id;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        raise exception 'era payment % not found', p_row_id using errcode = 'P0002';
      end if;
      v_mutation := jsonb_build_object(
        'table', 'era_claim_payments', 'id', p_row_id,
        'patch', jsonb_build_object('posting_status', 'posted'));
    end if;

  -- ── 3. adjustments-review ────────────────────────────────────────────
  elsif p_endpoint = 'adjustments-review' then
    if p_action = 'approve' then
      update public.payment_adjustments
         set posted_at = v_now,
             posted_by_user_id = p_user_id,
             source = 'workqueue_approved',
             updated_at = v_now
       where organization_id = p_organization_id and id = p_row_id;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        raise exception 'adjustment % not found', p_row_id using errcode = 'P0002';
      end if;
      v_mutation := jsonb_build_object(
        'table', 'payment_adjustments', 'id', p_row_id,
        'patch', jsonb_build_object('posted_at', v_now));
    elsif p_action = 'reverse' then
      select id, professional_claim_id, client_id, era_claim_payment_id,
             group_code, reason_code, amount, scope, adjustment_type
        into v_orig_adj
        from public.payment_adjustments
       where organization_id = p_organization_id and id = p_row_id
       for update;
      if not found then
        raise exception 'adjustment % not found', p_row_id using errcode = 'P0002';
      end if;
      insert into public.payment_adjustments (
        organization_id, professional_claim_id, client_id, era_claim_payment_id,
        adjustment_type, group_code, reason_code, amount, scope, source,
        description, posted_at, posted_by_user_id
      ) values (
        p_organization_id, v_orig_adj.professional_claim_id, v_orig_adj.client_id,
        v_orig_adj.era_claim_payment_id,
        'reversal_of_' || coalesce(v_orig_adj.adjustment_type, 'adjustment'),
        v_orig_adj.group_code, v_orig_adj.reason_code,
        -v_orig_adj.amount, coalesce(v_orig_adj.scope, 'claim'),
        'workqueue_reversal',
        coalesce(v_note, 'Reversal from adjustments-review workqueue'),
        v_now, p_user_id
      ) returning id into v_reversal_id;
      update public.payment_adjustments
         set reversed_by_adjustment_id = v_reversal_id,
             archived_at = v_now, updated_at = v_now
       where organization_id = p_organization_id and id = p_row_id;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        raise exception 'failed to link reversal back to adjustment %', p_row_id;
      end if;
      v_mutation := jsonb_build_object(
        'table', 'payment_adjustments',
        'reversed_id', p_row_id,
        'reversal_id', v_reversal_id,
        'amount', -v_orig_adj.amount);
    end if;

  -- ── 4. medical-necessity ─────────────────────────────────────────────
  elsif p_endpoint = 'medical-necessity' and p_action = 'send_appeal' then
    declare v_claim_id uuid;
    begin
      select professional_claim_id into v_claim_id
        from public.era_claim_payments
       where organization_id = p_organization_id and id = p_row_id;
      if not found then
        raise exception 'era payment % not found', p_row_id using errcode = 'P0002';
      end if;
      if v_claim_id is not null then
        update public.professional_claims
           set claim_status = 'appealing',
               appeal_submitted_at = v_now,
               updated_at = v_now
         where organization_id = p_organization_id and id = v_claim_id;
        get diagnostics v_rows = row_count;
        if v_rows = 0 then
          raise exception 'linked claim % not found', v_claim_id using errcode = 'P0002';
        end if;
        v_mutation := jsonb_build_object(
          'table', 'professional_claims', 'id', v_claim_id,
          'patch', jsonb_build_object('claim_status', 'appealing'));
      end if;
    end;

  -- ── 5. unposted-payments ─────────────────────────────────────────────
  elsif p_endpoint = 'unposted-payments' and p_action in ('post_to_claim', 'return_to_payer') then
    declare
      v_target text := case p_action when 'post_to_claim' then 'posted' else 'returned' end;
      v_table text := null;
    begin
      update public.era_claim_payments
         set posting_status = v_target, updated_at = v_now
       where organization_id = p_organization_id and id = p_row_id;
      get diagnostics v_rows = row_count;
      if v_rows > 0 then v_table := 'era_claim_payments'; end if;

      if v_table is null then
        update public.client_payments
           set posting_status = v_target, updated_at = v_now
         where organization_id = p_organization_id and id = p_row_id;
        get diagnostics v_rows = row_count;
        if v_rows > 0 then v_table := 'client_payments'; end if;
      end if;

      if v_table is null then
        update public.vcc_payments
           set status = v_target, updated_at = v_now
         where organization_id = p_organization_id and id = p_row_id;
        get diagnostics v_rows = row_count;
        if v_rows > 0 then v_table := 'vcc_payments'; end if;
      end if;

      if v_table is null then
        raise exception 'payment row % not found in any source table', p_row_id
          using errcode = 'P0002';
      end if;
      v_mutation := jsonb_build_object(
        'table', v_table, 'id', p_row_id,
        'patch', jsonb_build_object(
          case when v_table = 'vcc_payments' then 'status' else 'posting_status' end,
          v_target));
    end;

  -- ── 6. credit-balances ───────────────────────────────────────────────
  elsif p_endpoint = 'credit-balances' and p_action = 'propose_refund' then
    select id, client_id, current_balance
      into v_balance
      from public.patient_balances
     where organization_id = p_organization_id and id = p_row_id;
    if not found then
      raise exception 'patient balance % not found', p_row_id using errcode = 'P0002';
    end if;
    v_credit := abs(coalesce(v_balance.current_balance, 0));
    if v_credit <= 0 then
      raise exception 'account % is not in credit', p_row_id using errcode = '22023';
    end if;
    insert into public.payment_refunds (
      organization_id, client_id, amount, refund_type, refund_status,
      reason, requested_at, requested_by_actor_id
    ) values (
      p_organization_id, v_balance.client_id, v_credit, 'patient', 'requested',
      coalesce(v_note, 'Credit balance refund proposed from workqueue'),
      v_now, p_user_id
    ) returning id into v_inserted_id;
    v_mutation := jsonb_build_object(
      'table', 'payment_refunds',
      'inserted_id', v_inserted_id,
      'amount', v_credit,
      'client_id', v_balance.client_id);

  -- ── 7. reconciliation-exceptions ─────────────────────────────────────
  elsif p_endpoint = 'reconciliation-exceptions' and p_action = 'resolve' then
    update public.external_transactions
       set processing_status = 'cancelled', updated_at = v_now
     where organization_id = p_organization_id and id = p_row_id;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'transaction % not found', p_row_id using errcode = 'P0002';
    end if;
    v_mutation := jsonb_build_object(
      'table', 'external_transactions', 'id', p_row_id,
      'patch', jsonb_build_object('processing_status', 'cancelled'));

  -- ── 8. bad-debt-review ───────────────────────────────────────────────
  elsif p_endpoint = 'bad-debt-review' and p_action in ('approve', 'mark_written_off') then
    update public.patient_balances
       set in_collections = true, updated_at = v_now
     where organization_id = p_organization_id and id = p_row_id;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'patient balance % not found', p_row_id using errcode = 'P0002';
    end if;
    v_mutation := jsonb_build_object(
      'table', 'patient_balances', 'id', p_row_id,
      'patch', jsonb_build_object('in_collections', true));

  -- ── 9. write-offs (mark_reversal) ────────────────────────────────────
  elsif p_endpoint = 'write-offs' and p_action = 'mark_reversal' then
    select id, professional_claim_id, client_id, era_claim_payment_id,
           group_code, reason_code, amount, scope, adjustment_type
      into v_orig_adj
      from public.payment_adjustments
     where organization_id = p_organization_id and id = p_row_id
     for update;
    if not found then
      raise exception 'write-off % not found', p_row_id using errcode = 'P0002';
    end if;
    insert into public.payment_adjustments (
      organization_id, professional_claim_id, client_id, era_claim_payment_id,
      adjustment_type, group_code, reason_code, amount, scope, source,
      description, posted_at, posted_by_user_id
    ) values (
      p_organization_id, v_orig_adj.professional_claim_id, v_orig_adj.client_id,
      v_orig_adj.era_claim_payment_id,
      'reversal_of_' || coalesce(v_orig_adj.adjustment_type, 'write_off'),
      v_orig_adj.group_code, v_orig_adj.reason_code,
      -v_orig_adj.amount, coalesce(v_orig_adj.scope, 'claim'),
      'workqueue_write_off_reversal',
      coalesce(v_note, 'Write-off reversal from workqueue'),
      v_now, p_user_id
    ) returning id into v_reversal_id;
    update public.payment_adjustments
       set reversed_by_adjustment_id = v_reversal_id, updated_at = v_now
     where organization_id = p_organization_id and id = p_row_id;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'failed to link reversal back to write-off %', p_row_id;
    end if;
    v_mutation := jsonb_build_object(
      'table', 'payment_adjustments',
      'reversed_id', p_row_id,
      'reversal_id', v_reversal_id,
      'amount', -v_orig_adj.amount);

  -- ── 10. audit-queue ──────────────────────────────────────────────────
  elsif p_endpoint = 'audit-queue' then
    if p_action = 'complete_audit' then
      update public.billing_alerts
         set status = 'resolved',
             resolved_at = v_now,
             resolved_by = p_user_id,
             resolution_note = coalesce(v_note, 'Audit completed via workqueue'),
             updated_at = v_now
       where organization_id = p_organization_id and id = p_row_id;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        raise exception 'audit alert % not found', p_row_id using errcode = 'P0002';
      end if;
      v_mutation := jsonb_build_object(
        'table', 'billing_alerts', 'id', p_row_id,
        'patch', jsonb_build_object('status', 'resolved'));
    elsif p_action = 'reopen' then
      update public.billing_alerts
         set status = 'open',
             resolved_at = null,
             resolved_by = null,
             updated_at = v_now
       where organization_id = p_organization_id and id = p_row_id;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        raise exception 'audit alert % not found', p_row_id using errcode = 'P0002';
      end if;
      v_mutation := jsonb_build_object(
        'table', 'billing_alerts', 'id', p_row_id,
        'patch', jsonb_build_object('status', 'open'));
    end if;
  end if;

  -- Audit log is written in the SAME transaction as the mutation above.
  -- Either both commit or both roll back.
  insert into public.audit_logs (
    organization_id, event_type, event_summary, object_type, object_id,
    user_id, event_metadata
  ) values (
    p_organization_id, p_event_type, p_event_summary, p_endpoint, p_row_id,
    p_user_id,
    jsonb_build_object('tab', p_target_tab)
      || case when v_mutation is not null then jsonb_build_object('mutation', v_mutation) else '{}'::jsonb end
      || coalesce(p_extras, '{}'::jsonb)
  );

  return jsonb_build_object(
    'ok', true,
    'mutation', v_mutation
  );
end;
$$;

-- Service-role only: app layer (recordQueueAction → admin client) is
-- already gated by requireBillingAccess. The function is SECURITY
-- DEFINER and trusts the organization_id it receives, so we must NOT
-- grant execute to authenticated/anon.
revoke all on function public.record_queue_action_atomic(
  uuid, text, text, uuid, uuid, jsonb, text, text, text
) from public;
revoke all on function public.record_queue_action_atomic(
  uuid, text, text, uuid, uuid, jsonb, text, text, text
) from authenticated, anon;
grant execute on function public.record_queue_action_atomic(
  uuid, text, text, uuid, uuid, jsonb, text, text, text
) to service_role;

select pg_notify('pgrst', 'reload schema');
