-- Atomic per-org wipe of all transactional demo data.
-- Preserves structural rows (organization, providers, payer catalog,
-- service_locations, system_settings, clearinghouse_connections,
-- integration_connections, fee_schedules, code sets, etc.).
-- Deletes in FK-safe dependency order; the entire wipe runs inside a
-- single transaction (the function body), so any failure rolls the
-- whole thing back.

CREATE OR REPLACE FUNCTION public.clear_org_demo_data(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  counts jsonb := '{}'::jsonb;
  v_client_ids uuid[];
  v_invoice_ids uuid[];
  v_count bigint;
  v_table text;
  -- Tables wiped via WHERE organization_id = $1, listed in FK-safe order:
  -- every entry references later entries (no NOT-NULL/RESTRICT/NO-ACTION FK
  -- points from a later table back to an earlier one). Tables omitted from
  -- this list (claim_status_events, claim_parties_snapshot,
  -- professional_claim_service_lines, edi_batch_claims, client_import_rows)
  -- have no organization_id column and are reached via ON DELETE CASCADE
  -- from their org-scoped parent.
  v_org_scoped_tables text[] := ARRAY[
    -- Money / ERA ledger (leaf-most)
    'era_posting_ledger_entries',
    'patient_invoice_payments',
    'patient_invoices',
    'era_claim_payments',
    'era_import_batches',
    'payment_posting_allocations',
    'payment_postings',
    'payment_import_items',
    'payment_import_batches',
    'vcc_payments',
    -- Reverse-FK holders into encounters/appointments/clients/insurance_*
    -- must be wiped before those parents.
    'authorization_or_referrals',
    'eligibility_checks',
    'eligibility_requests',
    'billing_alerts',
    'operational_alerts',
    'coding_suggestions',
    'encounter_code_suggestions',
    'encounter_clinical_notes',
    'encounter_codes',
    'encounter_diagnoses',
    'encounter_notes',
    'encounter_service_lines',
    'charge_capture_items',
    'treatment_plan_goals',
    'treatment_plans',
    'telehealth_participants',
    'telehealth_sessions',
    'patient_check_ins',
    'patient_checkin_goal_selections',
    'patient_checkins',
    'patient_balances',
    'patient_diagnoses',
    'patient_contacts',
    'patient_import_items',
    'patient_import_batches',
    'support_ticket_comments',
    'support_tickets',
    'ticket_comments',
    'tickets',
    -- Documents / mailroom / chat / inbound email — these reference
    -- workqueue_items, claims, encounters, clients — so they must die first.
    'document_links',
    'documents',
    'chat_messages',
    'chat_participants',
    'chat_conversations',
    -- inbound_email_messages.mailroom_item_id references mailroom_items
    -- and inbound_email_messages.workqueue_item_id references workqueue_items,
    -- so wipe it before both.
    'inbound_email_messages',
    'mailroom_items',
    -- Workqueue (now safe to delete: nothing else references it)
    'workqueue_item_comments',
    'workqueue_items',
    -- Claims / EDI
    'claim_workqueue_items',
    'claim_status_inquiries',
    'claim_submissions',
    'claim_service_lines',
    'claim_837p_batch_claims',
    'claim_837p_batches',
    'claims',
    'professional_claims',
    'edi_batches',
    'edi_transactions',
    'edi_acknowledgements',
    'clearinghouse_response_events',
    'availity_transactions',
    'external_transaction_attempts',
    'external_transactions',
    'external_message_envelopes',
    'client_import_jobs',
    'client_contacts',
    -- Core patient-flow parents (deleted last)
    'encounters',
    'appointments',
    'insurance_policies',
    'insurance_subscribers',
    'clients',
    'audit_logs'
  ];
  v_client_scoped_tables text[] := ARRAY[
    'custom_audit_event',
    'custom_appointment_request',
    'custom_billing_workqueue_comment',
    'custom_client_document',
    'custom_client_note',
    'custom_client_program',
    'custom_payment',
    'custom_invoice',
    'custom_client_profile'
  ];
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id is required';
  END IF;

  -- Resolve client ids (needed for custom_* tables without organization_id)
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
    INTO v_client_ids
    FROM public.clients
   WHERE organization_id = p_organization_id;

  -- Resolve custom_invoice ids (custom_invoice_line_item has no client_id/org_id)
  IF array_length(v_client_ids, 1) IS NOT NULL THEN
    EXECUTE 'SELECT COALESCE(array_agg(invoice_id), ARRAY[]::uuid[]) FROM public.custom_invoice WHERE client_id = ANY($1)'
      INTO v_invoice_ids
      USING v_client_ids;
  ELSE
    v_invoice_ids := ARRAY[]::uuid[];
  END IF;

  -- 1. custom_invoice_line_item: scoped via invoice ids
  IF array_length(v_invoice_ids, 1) IS NOT NULL THEN
    EXECUTE 'WITH d AS (DELETE FROM public.custom_invoice_line_item WHERE invoice_id = ANY($1) RETURNING 1) SELECT count(*) FROM d'
      INTO v_count USING v_invoice_ids;
  ELSE
    v_count := 0;
  END IF;
  counts := counts || jsonb_build_object('custom_invoice_line_item', v_count);

  -- 2. client-scoped custom_* tables
  FOREACH v_table IN ARRAY v_client_scoped_tables LOOP
    IF array_length(v_client_ids, 1) IS NOT NULL THEN
      EXECUTE format(
        'WITH d AS (DELETE FROM public.%I WHERE client_id = ANY($1) RETURNING 1) SELECT count(*) FROM d',
        v_table
      )
      INTO v_count
      USING v_client_ids;
    ELSE
      v_count := 0;
    END IF;
    counts := counts || jsonb_build_object(v_table, v_count);
  END LOOP;

  -- 3. organization-scoped tables, in FK-safe dependency order
  FOREACH v_table IN ARRAY v_org_scoped_tables LOOP
    EXECUTE format(
      'WITH d AS (DELETE FROM public.%I WHERE organization_id = $1 RETURNING 1) SELECT count(*) FROM d',
      v_table
    )
    INTO v_count
    USING p_organization_id;
    counts := counts || jsonb_build_object(v_table, v_count);
  END LOOP;

  RETURN counts;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_org_demo_data(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_org_demo_data(uuid) TO service_role;
