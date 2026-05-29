-- Per-row undo for the second-wave billing workqueues (Task #701).
--
-- The action dispatcher (record_queue_action_atomic) flips claim status,
-- inserts adjustments / reversals / refunds, etc. An accidental click
-- has real consequences, so every row needs a one-step "Undo last
-- action" that reverses the most recent mutation AND stamps a
-- compensating audit_logs entry — both in a single transaction.
--
-- Mechanics
-- ─────────
-- 1. record_queue_action_atomic now records `previous_patch` inside the
--    `mutation` jsonb whenever it does a column flip, so the undo path
--    knows exactly what to restore (without keeping a separate table).
-- 2. undo_queue_action_atomic:
--      - finds the most recent `<prefix>_%` audit_logs entry for the row
--        (existing undo entries use event_type `<prefix>_undo`, so seeing
--        one of those on top means "nothing left to undo");
--      - applies the inverse mutation using `previous_patch` for column
--        flips, or by archiving/cancelling the inserted side for inserts
--        and reversals;
--      - refuses when a downstream action would make the undo unsafe
--        (refund already issued, inserted adjustment already archived,
--        reversal target already touched, column value drifted from the
--        action's expected `patch`);
--      - inserts a new `<prefix>_undo` audit log whose `event_metadata.tab`
--        is the *previous* `<prefix>_%` entry's tab (or the queue's
--        default), so the existing audit overlay naturally moves the row
--        back to where it came from.

-- ── 1. Re-create record_queue_action_atomic with previous_patch capture ───
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
  v_prev jsonb := null;
  v_rows int;
  v_era record;
  v_orig_adj record;
  v_balance record;
  v_shortfall numeric(12,2);
  v_credit numeric(12,2);
  v_reversal_id uuid;
  v_inserted_id uuid;
  v_note text;
  v_prior record;
begin
  if p_organization_id is null then
    raise exception 'organization_id is required' using errcode = '22023';
  end if;
  if p_row_id is null then
    raise exception 'row_id is required' using errcode = '22023';
  end if;

  v_note := nullif(btrim(coalesce(p_extras->>'note', '')), '');

  -- ── payer-rejections / resubmissions / compliance-holds ──────────────
  if p_endpoint in ('payer-rejections', 'resubmissions', 'compliance-holds') then
    declare
      v_new_status text := null;
      v_set_submission boolean := false;
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
      v_set_submission := p_action in ('mark_resubmitted', 'mark_submitted');

      if v_new_status is not null then
        select claim_status, submitted_at, last_billed_date
          into v_prior
          from public.professional_claims
         where organization_id = p_organization_id and id = p_row_id
         for update;
        if not found then
          raise exception 'claim % not found in organization %', p_row_id, p_organization_id using errcode = 'P0002';
        end if;
        if v_set_submission then
          update public.professional_claims
             set claim_status = v_new_status,
                 submitted_at = v_now,
                 last_billed_date = v_now::date,
                 updated_at = v_now
           where organization_id = p_organization_id and id = p_row_id;
          v_prev := jsonb_build_object(
            'claim_status', v_prior.claim_status,
            'submitted_at', v_prior.submitted_at,
            'last_billed_date', v_prior.last_billed_date
          );
        else
          update public.professional_claims
             set claim_status = v_new_status, updated_at = v_now
           where organization_id = p_organization_id and id = p_row_id;
          v_prev := jsonb_build_object('claim_status', v_prior.claim_status);
        end if;
        v_mutation := jsonb_build_object(
          'table', 'professional_claims',
          'id', p_row_id,
          'patch', jsonb_build_object('claim_status', v_new_status),
          'previous_patch', v_prev
        );
      end if;
    end;

  -- ── partial-denials ──────────────────────────────────────────────────
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
        raise exception 'no shortfall to write off on era payment %', p_row_id using errcode = '22023';
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
      select posting_status into v_prior
        from public.era_claim_payments
       where organization_id = p_organization_id and id = p_row_id
       for update;
      if not found then
        raise exception 'era payment % not found', p_row_id using errcode = 'P0002';
      end if;
      update public.era_claim_payments
         set posting_status = 'posted', updated_at = v_now
       where organization_id = p_organization_id and id = p_row_id;
      v_mutation := jsonb_build_object(
        'table', 'era_claim_payments', 'id', p_row_id,
        'patch', jsonb_build_object('posting_status', 'posted'),
        'previous_patch', jsonb_build_object('posting_status', v_prior.posting_status));
    end if;

  -- ── adjustments-review ───────────────────────────────────────────────
  elsif p_endpoint = 'adjustments-review' then
    if p_action = 'approve' then
      select posted_at, posted_by_user_id, source into v_prior
        from public.payment_adjustments
       where organization_id = p_organization_id and id = p_row_id
       for update;
      if not found then
        raise exception 'adjustment % not found', p_row_id using errcode = 'P0002';
      end if;
      update public.payment_adjustments
         set posted_at = v_now,
             posted_by_user_id = p_user_id,
             source = 'workqueue_approved',
             updated_at = v_now
       where organization_id = p_organization_id and id = p_row_id;
      v_mutation := jsonb_build_object(
        'table', 'payment_adjustments', 'id', p_row_id,
        'patch', jsonb_build_object('posted_at', v_now),
        'previous_patch', jsonb_build_object(
          'posted_at', v_prior.posted_at,
          'posted_by_user_id', v_prior.posted_by_user_id,
          'source', v_prior.source));
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

  -- ── medical-necessity ────────────────────────────────────────────────
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
        select claim_status, appeal_submitted_at into v_prior
          from public.professional_claims
         where organization_id = p_organization_id and id = v_claim_id
         for update;
        if not found then
          raise exception 'linked claim % not found', v_claim_id using errcode = 'P0002';
        end if;
        update public.professional_claims
           set claim_status = 'appealing',
               appeal_submitted_at = v_now,
               updated_at = v_now
         where organization_id = p_organization_id and id = v_claim_id;
        v_mutation := jsonb_build_object(
          'table', 'professional_claims', 'id', v_claim_id,
          'patch', jsonb_build_object('claim_status', 'appealing'),
          'previous_patch', jsonb_build_object(
            'claim_status', v_prior.claim_status,
            'appeal_submitted_at', v_prior.appeal_submitted_at));
      end if;
    end;

  -- ── unposted-payments ────────────────────────────────────────────────
  elsif p_endpoint = 'unposted-payments' and p_action in ('post_to_claim', 'return_to_payer') then
    declare
      v_target text := case p_action when 'post_to_claim' then 'posted' else 'returned' end;
      v_table text := null;
      v_prev_status text := null;
      v_status_col text := 'posting_status';
    begin
      select posting_status into v_prev_status
        from public.era_claim_payments
       where organization_id = p_organization_id and id = p_row_id
       for update;
      if found then
        update public.era_claim_payments
           set posting_status = v_target, updated_at = v_now
         where organization_id = p_organization_id and id = p_row_id;
        v_table := 'era_claim_payments';
      end if;

      if v_table is null then
        select posting_status into v_prev_status
          from public.client_payments
         where organization_id = p_organization_id and id = p_row_id
         for update;
        if found then
          update public.client_payments
             set posting_status = v_target, updated_at = v_now
           where organization_id = p_organization_id and id = p_row_id;
          v_table := 'client_payments';
        end if;
      end if;

      if v_table is null then
        select status into v_prev_status
          from public.vcc_payments
         where organization_id = p_organization_id and id = p_row_id
         for update;
        if found then
          update public.vcc_payments
             set status = v_target, updated_at = v_now
           where organization_id = p_organization_id and id = p_row_id;
          v_table := 'vcc_payments';
          v_status_col := 'status';
        end if;
      end if;

      if v_table is null then
        raise exception 'payment row % not found in any source table', p_row_id using errcode = 'P0002';
      end if;
      v_mutation := jsonb_build_object(
        'table', v_table, 'id', p_row_id,
        'patch', jsonb_build_object(v_status_col, v_target),
        'previous_patch', jsonb_build_object(v_status_col, v_prev_status));
    end;

  -- ── credit-balances ──────────────────────────────────────────────────
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

  -- ── reconciliation-exceptions ────────────────────────────────────────
  elsif p_endpoint = 'reconciliation-exceptions' and p_action = 'resolve' then
    select processing_status into v_prior
      from public.external_transactions
     where organization_id = p_organization_id and id = p_row_id
     for update;
    if not found then
      raise exception 'transaction % not found', p_row_id using errcode = 'P0002';
    end if;
    update public.external_transactions
       set processing_status = 'cancelled', updated_at = v_now
     where organization_id = p_organization_id and id = p_row_id;
    v_mutation := jsonb_build_object(
      'table', 'external_transactions', 'id', p_row_id,
      'patch', jsonb_build_object('processing_status', 'cancelled'),
      'previous_patch', jsonb_build_object('processing_status', v_prior.processing_status));

  -- ── bad-debt-review ──────────────────────────────────────────────────
  elsif p_endpoint = 'bad-debt-review' and p_action in ('approve', 'mark_written_off') then
    select in_collections into v_prior
      from public.patient_balances
     where organization_id = p_organization_id and id = p_row_id
     for update;
    if not found then
      raise exception 'patient balance % not found', p_row_id using errcode = 'P0002';
    end if;
    update public.patient_balances
       set in_collections = true, updated_at = v_now
     where organization_id = p_organization_id and id = p_row_id;
    v_mutation := jsonb_build_object(
      'table', 'patient_balances', 'id', p_row_id,
      'patch', jsonb_build_object('in_collections', true),
      'previous_patch', jsonb_build_object('in_collections', coalesce(v_prior.in_collections, false)));

  -- ── write-offs (mark_reversal) ───────────────────────────────────────
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

  -- ── audit-queue ──────────────────────────────────────────────────────
  elsif p_endpoint = 'audit-queue' then
    if p_action = 'complete_audit' then
      select status, resolved_at, resolved_by into v_prior
        from public.billing_alerts
       where organization_id = p_organization_id and id = p_row_id
       for update;
      if not found then
        raise exception 'audit alert % not found', p_row_id using errcode = 'P0002';
      end if;
      update public.billing_alerts
         set status = 'resolved',
             resolved_at = v_now,
             resolved_by = p_user_id,
             resolution_note = coalesce(v_note, 'Audit completed via workqueue'),
             updated_at = v_now
       where organization_id = p_organization_id and id = p_row_id;
      v_mutation := jsonb_build_object(
        'table', 'billing_alerts', 'id', p_row_id,
        'patch', jsonb_build_object('status', 'resolved'),
        'previous_patch', jsonb_build_object(
          'status', v_prior.status,
          'resolved_at', v_prior.resolved_at,
          'resolved_by', v_prior.resolved_by));
    elsif p_action = 'reopen' then
      select status, resolved_at, resolved_by into v_prior
        from public.billing_alerts
       where organization_id = p_organization_id and id = p_row_id
       for update;
      if not found then
        raise exception 'audit alert % not found', p_row_id using errcode = 'P0002';
      end if;
      update public.billing_alerts
         set status = 'open',
             resolved_at = null,
             resolved_by = null,
             updated_at = v_now
       where organization_id = p_organization_id and id = p_row_id;
      v_mutation := jsonb_build_object(
        'table', 'billing_alerts', 'id', p_row_id,
        'patch', jsonb_build_object('status', 'open'),
        'previous_patch', jsonb_build_object(
          'status', v_prior.status,
          'resolved_at', v_prior.resolved_at,
          'resolved_by', v_prior.resolved_by));
    end if;
  end if;

  -- Audit log is written in the SAME transaction as the mutation above.
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

-- ── 2. undo_queue_action_atomic ──────────────────────────────────────────
create or replace function public.undo_queue_action_atomic(
  p_organization_id uuid,
  p_endpoint text,
  p_row_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_prefix text;
  v_default_tab text;
  v_last record;
  v_prior_tab record;
  v_mutation jsonb;
  v_prev_patch jsonb;
  v_table text;
  v_id uuid;
  v_inserted_id uuid;
  v_reversed_id uuid;
  v_reversal_id uuid;
  v_undo_event_type text;
  v_prior_tab_value text;
  v_inverse jsonb := null;
  v_rows int;
  v_current_status text;
  v_expected_status text;
  v_refund_status text;
  v_existing_archived_at timestamptz;
begin
  if p_organization_id is null or p_row_id is null then
    raise exception 'organization_id and row_id are required' using errcode = '22023';
  end if;

  v_prefix := case p_endpoint
    when 'payer-rejections' then 'pr'
    when 'resubmissions' then 'rs'
    when 'partial-denials' then 'pd'
    when 'adjustments-review' then 'ar'
    when 'medical-necessity' then 'mn'
    when 'unposted-payments' then 'up'
    when 'credit-balances' then 'cb'
    when 'reconciliation-exceptions' then 're'
    when 'bad-debt-review' then 'bd'
    when 'write-offs' then 'wo'
    when 'audit-queue' then 'aq'
    when 'compliance-holds' then 'ch'
    else null end;
  if v_prefix is null then
    raise exception 'unknown queue %', p_endpoint using errcode = '22023';
  end if;

  v_default_tab := case p_endpoint
    when 'payer-rejections' then 'new'
    when 'resubmissions' then 'ready'
    when 'partial-denials' then 'open'
    when 'adjustments-review' then 'needs_review'
    when 'medical-necessity' then 'open'
    when 'unposted-payments' then 'all'
    when 'credit-balances' then 'patient'
    when 'reconciliation-exceptions' then 'open'
    when 'bad-debt-review' then 'proposed'
    when 'write-offs' then 'recent'
    when 'audit-queue' then 'pre_bill'
    when 'compliance-holds' then 'active'
    end;

  -- Most recent action audit row for this queue + row.
  select id, event_type, event_metadata, created_at
    into v_last
    from public.audit_logs
   where organization_id = p_organization_id
     and object_type = p_endpoint
     and object_id = p_row_id
     and event_type like (v_prefix || '_%')
   order by created_at desc, id desc
   limit 1;
  if not found then
    raise exception 'no action to undo for % %', p_endpoint, p_row_id using errcode = 'P0002';
  end if;
  v_undo_event_type := v_prefix || '_undo';
  if v_last.event_type = v_undo_event_type then
    raise exception 'last action was already an undo' using errcode = '22023';
  end if;

  v_mutation := v_last.event_metadata -> 'mutation';
  v_prev_patch := v_mutation -> 'previous_patch';
  v_table := v_mutation ->> 'table';
  v_id := nullif(v_mutation ->> 'id', '')::uuid;
  v_inserted_id := nullif(v_mutation ->> 'inserted_id', '')::uuid;
  v_reversed_id := nullif(v_mutation ->> 'reversed_id', '')::uuid;
  v_reversal_id := nullif(v_mutation ->> 'reversal_id', '')::uuid;

  -- ── Apply inverse mutation ───────────────────────────────────────────
  if v_mutation is null or v_table is null then
    -- Action had no underlying mutation (audit-only step). Nothing to undo
    -- on the data side; the audit-log stamp below still moves the row tab
    -- back to its prior overlay.
    v_inverse := null;

  elsif v_prev_patch is not null and v_id is not null then
    -- Column flip — restore the captured previous values, but only if the
    -- current value still matches what the action set.
    if v_table = 'professional_claims' then
      select claim_status into v_current_status
        from public.professional_claims
       where organization_id = p_organization_id and id = v_id
       for update;
      v_expected_status := v_mutation -> 'patch' ->> 'claim_status';
      if v_expected_status is not null and v_current_status is distinct from v_expected_status then
        raise exception 'cannot undo: claim status changed since action' using errcode = '22023';
      end if;
      update public.professional_claims
         set claim_status      = coalesce(v_prev_patch ->> 'claim_status', claim_status),
             submitted_at      = case when v_prev_patch ? 'submitted_at'
                                       then nullif(v_prev_patch ->> 'submitted_at','')::timestamptz
                                       else submitted_at end,
             last_billed_date  = case when v_prev_patch ? 'last_billed_date'
                                       then nullif(v_prev_patch ->> 'last_billed_date','')::date
                                       else last_billed_date end,
             appeal_submitted_at = case when v_prev_patch ? 'appeal_submitted_at'
                                       then nullif(v_prev_patch ->> 'appeal_submitted_at','')::timestamptz
                                       else appeal_submitted_at end,
             updated_at = v_now
       where organization_id = p_organization_id and id = v_id;
    elsif v_table = 'era_claim_payments' then
      update public.era_claim_payments
         set posting_status = coalesce(v_prev_patch ->> 'posting_status', posting_status),
             updated_at = v_now
       where organization_id = p_organization_id and id = v_id;
    elsif v_table = 'client_payments' then
      update public.client_payments
         set posting_status = coalesce(v_prev_patch ->> 'posting_status', posting_status),
             updated_at = v_now
       where organization_id = p_organization_id and id = v_id;
    elsif v_table = 'vcc_payments' then
      update public.vcc_payments
         set status = coalesce(v_prev_patch ->> 'status', status),
             updated_at = v_now
       where organization_id = p_organization_id and id = v_id;
    elsif v_table = 'payment_adjustments' then
      update public.payment_adjustments
         set posted_at         = case when v_prev_patch ? 'posted_at'
                                       then nullif(v_prev_patch ->> 'posted_at','')::timestamptz
                                       else posted_at end,
             posted_by_user_id = case when v_prev_patch ? 'posted_by_user_id'
                                       then nullif(v_prev_patch ->> 'posted_by_user_id','')::uuid
                                       else posted_by_user_id end,
             source            = case when v_prev_patch ? 'source'
                                       then nullif(v_prev_patch ->> 'source','')
                                       else source end,
             updated_at = v_now
       where organization_id = p_organization_id and id = v_id;
    elsif v_table = 'external_transactions' then
      update public.external_transactions
         set processing_status = coalesce(v_prev_patch ->> 'processing_status', processing_status),
             updated_at = v_now
       where organization_id = p_organization_id and id = v_id;
    elsif v_table = 'patient_balances' then
      update public.patient_balances
         set in_collections = coalesce((v_prev_patch ->> 'in_collections')::boolean, in_collections),
             updated_at = v_now
       where organization_id = p_organization_id and id = v_id;
    elsif v_table = 'billing_alerts' then
      update public.billing_alerts
         set status      = coalesce(v_prev_patch ->> 'status', status),
             resolved_at = case when v_prev_patch ? 'resolved_at'
                                 then nullif(v_prev_patch ->> 'resolved_at','')::timestamptz
                                 else resolved_at end,
             resolved_by = case when v_prev_patch ? 'resolved_by'
                                 then nullif(v_prev_patch ->> 'resolved_by','')::uuid
                                 else resolved_by end,
             updated_at = v_now
       where organization_id = p_organization_id and id = v_id;
    else
      raise exception 'undo not supported for table %', v_table using errcode = '22023';
    end if;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'row % not found in %', v_id, v_table using errcode = 'P0002';
    end if;
    v_inverse := jsonb_build_object(
      'table', v_table, 'id', v_id,
      'restored', v_prev_patch);

  elsif v_inserted_id is not null then
    -- Insert action — archive / cancel the inserted side.
    if v_table = 'payment_adjustments' then
      select archived_at into v_existing_archived_at
        from public.payment_adjustments
       where organization_id = p_organization_id and id = v_inserted_id
       for update;
      if not found then
        raise exception 'inserted adjustment % not found', v_inserted_id using errcode = 'P0002';
      end if;
      if v_existing_archived_at is not null then
        raise exception 'inserted adjustment % already archived', v_inserted_id using errcode = '22023';
      end if;
      update public.payment_adjustments
         set archived_at = v_now, updated_at = v_now
       where organization_id = p_organization_id and id = v_inserted_id;
    elsif v_table = 'payment_refunds' then
      select refund_status into v_refund_status
        from public.payment_refunds
       where organization_id = p_organization_id and id = v_inserted_id
       for update;
      if not found then
        raise exception 'inserted refund % not found', v_inserted_id using errcode = 'P0002';
      end if;
      if v_refund_status = 'issued' then
        raise exception 'cannot undo: refund has already been issued' using errcode = '22023';
      end if;
      if v_refund_status = 'cancelled' then
        raise exception 'refund % is already cancelled', v_inserted_id using errcode = '22023';
      end if;
      update public.payment_refunds
         set refund_status = 'cancelled', updated_at = v_now
       where organization_id = p_organization_id and id = v_inserted_id;
    else
      raise exception 'undo not supported for inserted table %', v_table using errcode = '22023';
    end if;
    v_inverse := jsonb_build_object(
      'table', v_table, 'cancelled_id', v_inserted_id);

  elsif v_reversal_id is not null and v_reversed_id is not null then
    -- Reversal action — un-link, un-archive the original, archive the reversal.
    select archived_at into v_existing_archived_at
      from public.payment_adjustments
     where organization_id = p_organization_id and id = v_reversal_id
     for update;
    if not found then
      raise exception 'reversal adjustment % not found', v_reversal_id using errcode = 'P0002';
    end if;
    if v_existing_archived_at is not null then
      raise exception 'reversal % already archived', v_reversal_id using errcode = '22023';
    end if;
    update public.payment_adjustments
       set archived_at = v_now, updated_at = v_now
     where organization_id = p_organization_id and id = v_reversal_id;
    update public.payment_adjustments
       set reversed_by_adjustment_id = null,
           archived_at = null,
           updated_at  = v_now
     where organization_id = p_organization_id and id = v_reversed_id
       and reversed_by_adjustment_id = v_reversal_id;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'original adjustment % no longer linked to reversal %', v_reversed_id, v_reversal_id using errcode = '22023';
    end if;
    v_inverse := jsonb_build_object(
      'table', 'payment_adjustments',
      'cancelled_reversal_id', v_reversal_id,
      'restored_id', v_reversed_id);

  else
    raise exception 'cannot infer inverse for mutation %', v_mutation::text using errcode = '22023';
  end if;

  -- ── Find the prior overlay tab (skip undo entries) ────────────────────
  select event_metadata ->> 'tab' as tab
    into v_prior_tab
    from public.audit_logs
   where organization_id = p_organization_id
     and object_type = p_endpoint
     and object_id = p_row_id
     and event_type like (v_prefix || '_%')
     and event_type <> v_undo_event_type
     and id <> v_last.id
   order by created_at desc, id desc
   limit 1;
  v_prior_tab_value := coalesce(v_prior_tab.tab, v_default_tab);

  -- ── Stamp the compensating audit_logs entry (same transaction) ───────
  insert into public.audit_logs (
    organization_id, event_type, event_summary, object_type, object_id,
    user_id, event_metadata
  ) values (
    p_organization_id, v_undo_event_type,
    p_endpoint || ' → undo',
    p_endpoint, p_row_id, p_user_id,
    jsonb_build_object(
      'tab', v_prior_tab_value,
      'undone_audit_log_id', v_last.id,
      'undone_event_type', v_last.event_type,
      'mutation', v_inverse
    )
  );

  return jsonb_build_object(
    'ok', true,
    'mutation', v_inverse,
    'undone_event_type', v_last.event_type,
    'tab', v_prior_tab_value
  );
end;
$$;

revoke all on function public.undo_queue_action_atomic(uuid, text, uuid, uuid)
  from public, authenticated, anon;
grant execute on function public.undo_queue_action_atomic(uuid, text, uuid, uuid)
  to service_role;

select pg_notify('pgrst', 'reload schema');
