


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."appointment_status" AS ENUM (
    'scheduled',
    'checked_in',
    'in_progress',
    'completed',
    'no_show',
    'cancelled'
);


ALTER TYPE "public"."appointment_status" OWNER TO "postgres";


CREATE TYPE "public"."authorization_status" AS ENUM (
    'not_required',
    'pending',
    'approved',
    'denied',
    'expired',
    'cancelled'
);


ALTER TYPE "public"."authorization_status" OWNER TO "postgres";


CREATE TYPE "public"."billing_alert_status" AS ENUM (
    'open',
    'snoozed',
    'resolved'
);


ALTER TYPE "public"."billing_alert_status" OWNER TO "postgres";


CREATE TYPE "public"."claim_status" AS ENUM (
    'draft',
    'ready_to_submit',
    'submitted',
    'accepted',
    'rejected',
    'denied',
    'paid',
    'partially_paid',
    'voided'
);


ALTER TYPE "public"."claim_status" OWNER TO "postgres";


CREATE TYPE "public"."claim_status_inquiry_status" AS ENUM (
    'queued',
    'sent',
    'received',
    'no_response',
    'failed'
);


ALTER TYPE "public"."claim_status_inquiry_status" OWNER TO "postgres";


CREATE TYPE "public"."claim_submission_status" AS ENUM (
    'queued',
    'sent',
    'accepted_by_clearinghouse',
    'rejected_by_clearinghouse',
    'accepted_by_payer',
    'rejected_by_payer',
    'failed'
);


ALTER TYPE "public"."claim_submission_status" OWNER TO "postgres";


CREATE TYPE "public"."eligibility_status" AS ENUM (
    'not_checked',
    'active',
    'inactive',
    'pending',
    'error'
);


ALTER TYPE "public"."eligibility_status" OWNER TO "postgres";


CREATE TYPE "public"."encounter_status" AS ENUM (
    'scheduled',
    'in_progress',
    'completed',
    'ready_to_bill',
    'billed',
    'voided'
);


ALTER TYPE "public"."encounter_status" OWNER TO "postgres";


CREATE TYPE "public"."envelope_format" AS ENUM (
    'x12',
    'none',
    'xml_wrapper'
);


ALTER TYPE "public"."envelope_format" OWNER TO "postgres";


CREATE TYPE "public"."environment_flag" AS ENUM (
    'test',
    'production'
);


ALTER TYPE "public"."environment_flag" OWNER TO "postgres";


CREATE TYPE "public"."external_attempt_status" AS ENUM (
    'queued',
    'sent',
    'succeeded',
    'failed',
    'timeout',
    'retry_scheduled'
);


ALTER TYPE "public"."external_attempt_status" OWNER TO "postgres";


CREATE TYPE "public"."external_transaction_status" AS ENUM (
    'queued',
    'in_flight',
    'succeeded',
    'failed',
    'deferred',
    'cancelled'
);


ALTER TYPE "public"."external_transaction_status" OWNER TO "postgres";


CREATE TYPE "public"."insurance_policy_priority" AS ENUM (
    'primary',
    'secondary',
    'tertiary'
);


ALTER TYPE "public"."insurance_policy_priority" OWNER TO "postgres";


CREATE TYPE "public"."message_format" AS ENUM (
    'x12',
    'json',
    'xml'
);


ALTER TYPE "public"."message_format" OWNER TO "postgres";


CREATE TYPE "public"."note_status" AS ENUM (
    'not_started',
    'in_progress',
    'signed',
    'amended'
);


ALTER TYPE "public"."note_status" OWNER TO "postgres";


CREATE TYPE "public"."payment_import_status" AS ENUM (
    'imported',
    'parsed',
    'needs_review',
    'ready_to_post',
    'posted',
    'failed'
);


ALTER TYPE "public"."payment_import_status" OWNER TO "postgres";


CREATE TYPE "public"."payment_posting_status" AS ENUM (
    'pending',
    'posted',
    'partially_posted',
    'reversed',
    'failed'
);


ALTER TYPE "public"."payment_posting_status" OWNER TO "postgres";


CREATE TYPE "public"."processing_mode" AS ENUM (
    'realtime',
    'batch'
);


ALTER TYPE "public"."processing_mode" OWNER TO "postgres";


CREATE TYPE "public"."source_object_type" AS ENUM (
    'appointment',
    'encounter',
    'claim',
    'eligibility_check',
    'authorization_or_referral',
    'payment_import_item',
    'payment_posting',
    'client',
    'insurance_policy',
    'workqueue_item',
    'mailroom_item'
);


ALTER TYPE "public"."source_object_type" OWNER TO "postgres";


CREATE TYPE "public"."support_ticket_status" AS ENUM (
    'open',
    'pending',
    'waiting_on_client',
    'waiting_on_payer',
    'resolved',
    'closed'
);


ALTER TYPE "public"."support_ticket_status" OWNER TO "postgres";


CREATE TYPE "public"."transaction_type" AS ENUM (
    '270',
    '276',
    '278',
    '837'
);


ALTER TYPE "public"."transaction_type" OWNER TO "postgres";


CREATE TYPE "public"."workqueue_priority" AS ENUM (
    'low',
    'normal',
    'high',
    'urgent'
);


ALTER TYPE "public"."workqueue_priority" OWNER TO "postgres";


CREATE TYPE "public"."workqueue_status" AS ENUM (
    'open',
    'in_progress',
    'blocked',
    'resolved',
    'closed'
);


ALTER TYPE "public"."workqueue_status" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_updated_at_trigger"("table_name" "regclass") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  EXECUTE format(
    'DROP TRIGGER IF EXISTS trg_set_updated_at ON %s;
     CREATE TRIGGER trg_set_updated_at
     BEFORE UPDATE ON %s
     FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
    table_name, table_name
  );
END;
$$;


ALTER FUNCTION "public"."apply_updated_at_trigger"("table_name" "regclass") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_claim_matches_encounter_and_policy"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.encounters e
    WHERE e.id = NEW.encounter_id
      AND e.organization_id = NEW.organization_id
      AND e.client_id = NEW.client_id
  ) THEN
    RAISE EXCEPTION
      'Claim does not match encounter organization/client';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.insurance_policies ip
    WHERE ip.id = NEW.insurance_policy_id
      AND ip.organization_id = NEW.organization_id
      AND ip.client_id = NEW.client_id
      AND ip.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'Claim insurance policy does not belong to claim organization/client';
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."assert_claim_matches_encounter_and_policy"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_encounter_matches_appointment"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.appointments a
    WHERE a.id = NEW.appointment_id
      AND a.organization_id = NEW.organization_id
      AND a.client_id = NEW.client_id
      AND (
        a.provider_id IS NULL
        OR a.provider_id = NEW.provider_id
      )
  ) THEN
    RAISE EXCEPTION
      'Encounter does not match appointment organization/client/provider';
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."assert_encounter_matches_appointment"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auto_create_encounter_from_completed_appointment"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.appointment_status = 'completed'
     and (old.appointment_status is distinct from new.appointment_status) then

    if not exists (
      select 1
      from public.encounters e
      where e.appointment_id = new.id
        and e.archived_at is null
    ) then
      insert into public.encounters (
        organization_id,
        appointment_id,
        client_id,
        provider_id,
        encounter_status,
        started_at,
        ended_at,
        service_date,
        required_billing_fields_complete
      )
      values (
        new.organization_id,
        new.id,
        new.client_id,
        new.provider_id,
        'in_progress',
        new.scheduled_start_at,
        new.scheduled_end_at,
        (new.scheduled_start_at at time zone 'utc')::date,
        false
      );
    end if;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."auto_create_encounter_from_completed_appointment"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."external_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "transaction_type" "public"."transaction_type" NOT NULL,
    "payload_type" "text" NOT NULL,
    "payload_version" "text" NOT NULL,
    "message_format" "public"."message_format" NOT NULL,
    "envelope_format" "public"."envelope_format" NOT NULL,
    "processing_mode" "public"."processing_mode" NOT NULL,
    "sender_id" "text" NOT NULL,
    "receiver_id" "text" NOT NULL,
    "core_rule_version" "text",
    "payload_id" "text",
    "request_timestamp" timestamp with time zone DEFAULT "now"() NOT NULL,
    "response_timestamp" timestamp with time zone,
    "provider_office_number" "text",
    "provider_transaction_id" "text",
    "session_id" "text",
    "external_transaction_id" "text",
    "availity_transaction_id" "text",
    "environment_flag" "public"."environment_flag" DEFAULT 'production'::"public"."environment_flag" NOT NULL,
    "raw_outbound_payload" "text",
    "raw_inbound_response" "text",
    "parsed_response_summary" "jsonb",
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "duplicate_detection_key" "text" NOT NULL,
    "retry_after" timestamp with time zone,
    "defer_until" timestamp with time zone,
    "error_class" "text",
    "error_cause_code" "text",
    "error_description" "text",
    "processing_status" "public"."external_transaction_status" DEFAULT 'queued'::"public"."external_transaction_status" NOT NULL,
    "source_object_type" "public"."source_object_type",
    "source_object_id" "uuid",
    "legacy_availity_xml_request" "text",
    "legacy_availity_xml_response" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."external_transactions" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_next_external_transaction"() RETURNS "public"."external_transactions"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_tx public.external_transactions;
BEGIN
  SELECT *
  INTO v_tx
  FROM public.external_transactions et
  WHERE et.archived_at IS NULL
    AND et.processing_status = 'queued'
    AND (et.defer_until IS NULL OR et.defer_until <= now())
    AND (et.retry_after IS NULL OR et.retry_after <= now())
  ORDER BY et.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.external_transactions
  SET
    processing_status = 'in_flight',
    updated_at = now()
  WHERE id = v_tx.id
  RETURNING * INTO v_tx;

  RETURN v_tx;
END;
$$;


ALTER FUNCTION "public"."claim_next_external_transaction"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_workqueue_item"("org_id" "uuid", "source_type" "text", "source_id" "uuid", "work_type" "text", "title" "text") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
declare
  new_id uuid;
begin
  insert into public.workqueue_items (
    organization_id,
    source_object_type,
    source_object_id,
    work_type,
    title
  )
  values (
    org_id,
    source_type::workqueue_source_object_type,
    source_id,
    work_type,
    title
  )
  returning id into new_id;

  return new_id;
end;
$$;


ALTER FUNCTION "public"."create_workqueue_item"("org_id" "uuid", "source_type" "text", "source_id" "uuid", "work_type" "text", "title" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_user_org_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select om.organization_id
  from public.organization_members om
  where om.user_id = auth.uid()
    and om.is_active = true
    and om.archived_at is null;
$$;


ALTER FUNCTION "public"."current_user_org_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_claim_number"("org_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
declare
  new_number text;
begin
  new_number := 'CLM-' || to_char(now(), 'YYYYMMDDHH24MISS');
  return new_number;
end;
$$;


ALTER FUNCTION "public"."generate_claim_number"("org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_system_readiness_report"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select jsonb_build_object(
    'summary', (select to_jsonb(s) from public.system_readiness_summary s),
    'checks', (
      select jsonb_agg(to_jsonb(c) order by c.sort_order)
      from public.system_readiness_checks c
    )
  );
$$;


ALTER FUNCTION "public"."get_system_readiness_report"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    email,
    full_name,
    role,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'clinician'),
    NOW(),
    NOW()
  );

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_org_role"("target_org_id" "uuid", "allowed_roles" "text"[]) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members om
    WHERE om.organization_id = target_org_id
      AND om.user_id = auth.uid()
      AND om.is_active = true
      AND om.ended_at IS NULL
      AND om.archived_at IS NULL
      AND om.role_code = ANY (allowed_roles)
  );
$$;


ALTER FUNCTION "public"."has_org_role"("target_org_id" "uuid", "allowed_roles" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_current_user_org_member"("target_org_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.organization_members om
    where om.user_id = auth.uid()
      and om.organization_id = target_org_id
      and om.is_active = true
      and om.archived_at is null
  );
$$;


ALTER FUNCTION "public"."is_current_user_org_member"("target_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_org_member"("target_org_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members om
    WHERE om.organization_id = target_org_id
      AND om.user_id = auth.uid()
      AND om.is_active = true
      AND om.ended_at IS NULL
      AND om.archived_at IS NULL
  );
$$;


ALTER FUNCTION "public"."is_org_member"("target_org_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_external_transaction_failed_retryable"("p_transaction_id" "uuid", "p_error_class" "text", "p_error_cause_code" "text", "p_error_description" "text", "p_retry_after" timestamp with time zone DEFAULT ("now"() + '00:05:00'::interval)) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE public.external_transactions
  SET
    processing_status = 'queued',
    error_class = p_error_class,
    error_cause_code = p_error_cause_code,
    error_description = p_error_description,
    retry_after = p_retry_after,
    attempt_count = attempt_count + 1,
    updated_at = now()
  WHERE id = p_transaction_id
    AND processing_status = 'in_flight';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No in_flight external transaction found for id %', p_transaction_id;
  END IF;
END;
$$;


ALTER FUNCTION "public"."mark_external_transaction_failed_retryable"("p_transaction_id" "uuid", "p_error_class" "text", "p_error_cause_code" "text", "p_error_description" "text", "p_retry_after" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_external_transaction_succeeded"("p_transaction_id" "uuid", "p_raw_response" "text" DEFAULT NULL::"text", "p_parsed_response_summary" "jsonb" DEFAULT NULL::"jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE public.external_transactions
  SET
    processing_status = 'succeeded',
    response_timestamp = now(),
    raw_inbound_response = COALESCE(p_raw_response, raw_inbound_response),
    parsed_response_summary = COALESCE(p_parsed_response_summary, parsed_response_summary),
    error_class = NULL,
    error_cause_code = NULL,
    error_description = NULL,
    retry_after = NULL,
    defer_until = NULL,
    updated_at = now()
  WHERE id = p_transaction_id
    AND processing_status = 'in_flight';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No in_flight external transaction found for id %', p_transaction_id;
  END IF;
END;
$$;


ALTER FUNCTION "public"."mark_external_transaction_succeeded"("p_transaction_id" "uuid", "p_raw_response" "text", "p_parsed_response_summary" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."queue_eligibility_check_for_appointment"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.insurance_policy_id is not null then
    insert into public.eligibility_checks (
      organization_id,
      client_id,
      insurance_policy_id,
      appointment_id,
      eligibility_status,
      response_summary
    )
    values (
      new.organization_id,
      new.client_id,
      new.insurance_policy_id,
      new.id,
      'not_checked',
      jsonb_build_object(
        'queued_by', 'appointment_trigger',
        'default_service_type', '98',
        'default_service_type_label', 'Professional Services'
      )
    )
    on conflict do nothing;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."queue_eligibility_check_for_appointment"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."queue_stale_eligibility_rechecks"() RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
declare
  inserted_count integer;
begin
  insert into public.eligibility_checks (
    organization_id,
    client_id,
    insurance_policy_id,
    appointment_id,
    eligibility_status,
    response_summary
  )
  select
    a.organization_id,
    a.client_id,
    a.insurance_policy_id,
    a.id,
    'not_checked',
    jsonb_build_object(
      'queued_by', 'stale_recheck',
      'default_service_type', '98',
      'default_service_type_label', 'Professional Services',
      'previous_checked_at', e.checked_at
    )
  from public.appointments a
  join public.eligibility_checks e
    on e.appointment_id = a.id
  where a.insurance_policy_id is not null
    and e.checked_at < now() - interval '30 days';

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;


ALTER FUNCTION "public"."queue_stale_eligibility_rechecks"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."route_inbound_gmail_message"("p_organization_id" "uuid", "p_integration_connection_id" "uuid", "p_gmail_message_id" "text", "p_gmail_thread_id" "text", "p_gmail_history_id" "text", "p_from_email" "text", "p_from_name" "text", "p_to_email" "text", "p_subject" "text", "p_snippet" "text", "p_received_at" timestamp with time zone, "p_raw_headers" "jsonb" DEFAULT '{}'::"jsonb", "p_raw_payload" "jsonb" DEFAULT NULL::"jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_email_id uuid;
  v_client_id uuid;
  v_profile_id uuid;
  v_provider_id uuid;
  v_mailroom_item_id uuid;
  v_workqueue_item_id uuid;
  v_title text;
BEGIN
  SELECT iem.id
  INTO v_email_id
  FROM public.inbound_email_messages iem
  WHERE iem.organization_id = p_organization_id
    AND iem.gmail_message_id = p_gmail_message_id
    AND iem.archived_at IS NULL
  LIMIT 1;

  IF FOUND THEN
    RETURN v_email_id;
  END IF;

  SELECT p.id
  INTO v_profile_id
  FROM public.profiles p
  WHERE lower(p.email) = lower(p_from_email)
    AND (
      p.organization_id = p_organization_id
      OR EXISTS (
        SELECT 1
        FROM public.organization_members om
        WHERE om.organization_id = p_organization_id
          AND om.user_id = p.id
          AND om.is_active = true
          AND om.archived_at IS NULL
          AND om.ended_at IS NULL
      )
    )
  LIMIT 1;

  SELECT c.id
  INTO v_client_id
  FROM public.clients c
  WHERE c.organization_id = p_organization_id
    AND c.archived_at IS NULL
    AND lower(c.email) = lower(p_from_email)
  LIMIT 1;

  IF v_client_id IS NULL THEN
    SELECT cc.client_id
    INTO v_client_id
    FROM public.client_contacts cc
    WHERE cc.organization_id = p_organization_id
      AND cc.archived_at IS NULL
      AND cc.contact_type = 'email'
      AND lower(cc.value) = lower(p_from_email)
    ORDER BY cc.is_primary DESC, cc.created_at DESC
    LIMIT 1;
  END IF;

  SELECT pr.id
  INTO v_provider_id
  FROM public.providers pr
  WHERE pr.organization_id = p_organization_id
    AND pr.archived_at IS NULL
    AND lower(pr.email) = lower(p_from_email)
  LIMIT 1;

  INSERT INTO public.inbound_email_messages (
    organization_id,
    integration_connection_id,
    provider,
    gmail_message_id,
    gmail_thread_id,
    gmail_history_id,
    from_email,
    from_name,
    to_email,
    subject,
    snippet,
    received_at,
    matched_profile_id,
    matched_client_id,
    matched_provider_id,
    match_confidence,
    processing_status,
    raw_headers,
    raw_payload
  )
  VALUES (
    p_organization_id,
    p_integration_connection_id,
    'gmail',
    p_gmail_message_id,
    p_gmail_thread_id,
    p_gmail_history_id,
    p_from_email,
    p_from_name,
    p_to_email,
    p_subject,
    p_snippet,
    p_received_at,
    v_profile_id,
    v_client_id,
    v_provider_id,
    CASE
      WHEN v_client_id IS NOT NULL THEN 1.0
      WHEN v_profile_id IS NOT NULL THEN 0.9
      WHEN v_provider_id IS NOT NULL THEN 0.9
      ELSE 0.0
    END,
    'matched',
    COALESCE(p_raw_headers, '{}'::jsonb),
    p_raw_payload
  )
  RETURNING id INTO v_email_id;

  v_title := COALESCE(NULLIF(p_subject, ''), 'Inbound Gmail message');

  INSERT INTO public.mailroom_items (
    organization_id,
    uploaded_by_user_id,
    client_id,
    document_scope,
    document_type,
    source,
    file_name,
    storage_path,
    mime_type,
    notes,
    admin_comments,
    status,
    filed_client_id
  )
  VALUES (
    p_organization_id,
    NULL,
    v_client_id,
    CASE
      WHEN v_client_id IS NOT NULL THEN 'patient_chart'
      ELSE 'unfiled'
    END,
    'email',
    'gmail',
    left(v_title, 180),
    'gmail://' || p_gmail_message_id,
    'message/rfc822',
    p_snippet,
    'From: ' || COALESCE(p_from_name || ' ', '') || '<' || p_from_email || '>',
    'needs_review',
    v_client_id
  )
  RETURNING id INTO v_mailroom_item_id;

  INSERT INTO public.workqueue_items (
    organization_id,
    source_object_type,
    source_object_id,
    client_id,
    priority,
    status,
    work_type,
    title,
    description,
    context_payload
  )
  VALUES (
    p_organization_id,
    'mailroom_item'::public.source_object_type,
    v_mailroom_item_id,
    v_client_id,
    CASE
      WHEN v_client_id IS NULL THEN 'high'::public.workqueue_priority
      ELSE 'normal'::public.workqueue_priority
    END,
    'open'::public.workqueue_status,
    'mailroom_review',
    'Review Gmail message: ' || v_title,
    'Inbound Gmail message from ' || p_from_email,
    jsonb_build_object(
      'source', 'gmail',
      'gmail_message_id', p_gmail_message_id,
      'gmail_thread_id', p_gmail_thread_id,
      'from_email', p_from_email,
      'from_name', p_from_name,
      'subject', p_subject,
      'matched_client_id', v_client_id,
      'matched_profile_id', v_profile_id,
      'matched_provider_id', v_provider_id
    )
  )
  RETURNING id INTO v_workqueue_item_id;

  UPDATE public.mailroom_items
  SET workqueue_item_id = v_workqueue_item_id,
      updated_at = now()
  WHERE id = v_mailroom_item_id;

  UPDATE public.inbound_email_messages
  SET mailroom_item_id = v_mailroom_item_id,
      workqueue_item_id = v_workqueue_item_id,
      processing_status = 'routed',
      updated_at = now()
  WHERE id = v_email_id;

  RETURN v_email_id;
END;
$$;


ALTER FUNCTION "public"."route_inbound_gmail_message"("p_organization_id" "uuid", "p_integration_connection_id" "uuid", "p_gmail_message_id" "text", "p_gmail_thread_id" "text", "p_gmail_history_id" "text", "p_from_email" "text", "p_from_name" "text", "p_to_email" "text", "p_subject" "text", "p_snippet" "text", "p_received_at" timestamp with time zone, "p_raw_headers" "jsonb", "p_raw_payload" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."run_sql"("query_text" "text") RETURNS TABLE("result" json)
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  return query execute
    'select row_to_json(t) from (' || query_text || ') t';
end;
$$;


ALTER FUNCTION "public"."run_sql"("query_text" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_custom_app_config_date_changed"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.date_changed = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_custom_app_config_date_changed"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."appointments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "provider_id" "uuid",
    "provider_location_id" "uuid",
    "insurance_policy_id" "uuid",
    "scheduled_start_at" timestamp with time zone NOT NULL,
    "scheduled_end_at" timestamp with time zone NOT NULL,
    "appointment_status" "public"."appointment_status" DEFAULT 'scheduled'::"public"."appointment_status" NOT NULL,
    "appointment_type" "text",
    "reason" "text",
    "check_in_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "cancellation_reason" "text",
    "telehealth_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    CONSTRAINT "appointments_check" CHECK (("scheduled_end_at" > "scheduled_start_at")),
    CONSTRAINT "appointments_start_before_end" CHECK (("scheduled_start_at" < "scheduled_end_at")),
    CONSTRAINT "appointments_valid_schedule_chk" CHECK (("scheduled_end_at" > "scheduled_start_at"))
);


ALTER TABLE "public"."appointments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."eligibility_checks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "insurance_policy_id" "uuid" NOT NULL,
    "appointment_id" "uuid",
    "encounter_id" "uuid",
    "eligibility_status" "public"."eligibility_status" DEFAULT 'not_checked'::"public"."eligibility_status" NOT NULL,
    "checked_at" timestamp with time zone,
    "coverage_start_date" "date",
    "coverage_end_date" "date",
    "copay_amount" numeric(12,2),
    "deductible_remaining" numeric(12,2),
    "out_of_pocket_remaining" numeric(12,2),
    "raw_status_text" "text",
    "response_summary" "jsonb",
    "external_transaction_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."eligibility_checks" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."appointment_eligibility_status" WITH ("security_invoker"='true') AS
 SELECT "a"."id" AS "appointment_id",
    "a"."organization_id",
    "a"."client_id",
    "a"."insurance_policy_id",
    "e"."id" AS "eligibility_check_id",
        CASE
            WHEN ("a"."insurance_policy_id" IS NULL) THEN 'no_policy'::"text"
            WHEN ("e"."id" IS NULL) THEN 'not_checked'::"text"
            WHEN ("e"."checked_at" IS NULL) THEN 'not_checked'::"text"
            WHEN ("e"."checked_at" < ("now"() - '30 days'::interval)) THEN 'stale'::"text"
            ELSE ("e"."eligibility_status")::"text"
        END AS "eligibility_status",
    "e"."checked_at",
    "e"."coverage_start_date",
    "e"."coverage_end_date",
    "e"."copay_amount",
    "e"."deductible_remaining",
    "e"."out_of_pocket_remaining",
    "e"."response_summary"
   FROM ("public"."appointments" "a"
     LEFT JOIN "public"."eligibility_checks" "e" ON (("e"."appointment_id" = "a"."id")));


ALTER VIEW "public"."appointment_eligibility_status" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "patient_id" "uuid",
    "appointment_id" "uuid",
    "encounter_id" "uuid",
    "claim_id" "uuid",
    "clinical_note_id" "uuid",
    "workqueue_item_id" "uuid",
    "event_type" "text",
    "event_summary" "text",
    "event_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "uuid",
    "user_role" "text",
    "action" "text",
    "object_type" "text",
    "object_id" "uuid",
    "before_value" "jsonb",
    "after_value" "jsonb"
);


ALTER TABLE "public"."audit_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."authorization_or_referrals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "insurance_policy_id" "uuid" NOT NULL,
    "appointment_id" "uuid",
    "encounter_id" "uuid",
    "auth_type" "text" NOT NULL,
    "authorization_status" "public"."authorization_status" DEFAULT 'pending'::"public"."authorization_status" NOT NULL,
    "authorization_number" "text",
    "referral_number" "text",
    "service_code" "text",
    "units_authorized" integer,
    "units_used" integer DEFAULT 0 NOT NULL,
    "valid_from" "date",
    "valid_to" "date",
    "requested_at" timestamp with time zone,
    "approved_at" timestamp with time zone,
    "denied_at" timestamp with time zone,
    "denial_reason" "text",
    "external_transaction_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    CONSTRAINT "authorization_or_referrals_auth_type_check" CHECK (("auth_type" = ANY (ARRAY['authorization'::"text", 'referral'::"text"]))),
    CONSTRAINT "authorization_or_referrals_check" CHECK ((("valid_to" IS NULL) OR ("valid_from" IS NULL) OR ("valid_to" >= "valid_from"))),
    CONSTRAINT "authorization_or_referrals_units_authorized_check" CHECK ((("units_authorized" IS NULL) OR ("units_authorized" >= 0))),
    CONSTRAINT "authorization_or_referrals_units_used_check" CHECK (("units_used" >= 0)),
    CONSTRAINT "authorization_units_used_lte_authorized_chk" CHECK ((("units_authorized" IS NULL) OR ("units_used" <= "units_authorized"))),
    CONSTRAINT "authorization_valid_dates_chk" CHECK ((("valid_to" IS NULL) OR ("valid_from" IS NULL) OR ("valid_to" >= "valid_from")))
);


ALTER TABLE "public"."authorization_or_referrals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."availity_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "patient_id" "uuid",
    "encounter_id" "uuid",
    "claim_id" "uuid",
    "payer_id" "text",
    "payer_name" "text",
    "transaction_type" "text" NOT NULL,
    "transaction_direction" "text" DEFAULT 'outbound'::"text" NOT NULL,
    "environment" "text" DEFAULT 'demo'::"text" NOT NULL,
    "status" "text" DEFAULT 'created'::"text" NOT NULL,
    "request_method" "text",
    "request_url" "text",
    "request_headers_safe" "jsonb",
    "request_body_safe" "jsonb",
    "response_status" integer,
    "response_headers_safe" "jsonb",
    "response_body_safe" "jsonb",
    "external_transaction_id" "text",
    "correlation_id" "text",
    "error_message" "text",
    "error_type" "text",
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "valid_environment" CHECK (("environment" = ANY (ARRAY['demo'::"text", 'production'::"text", 'sandbox'::"text", 'test'::"text"]))),
    CONSTRAINT "valid_status" CHECK (("status" = ANY (ARRAY['created'::"text", 'pending'::"text", 'sent'::"text", 'received'::"text", 'completed'::"text", 'failed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "valid_transaction_direction" CHECK (("transaction_direction" = ANY (ARRAY['outbound'::"text", 'inbound'::"text", 'internal'::"text"]))),
    CONSTRAINT "valid_transaction_type" CHECK (("transaction_type" = ANY (ARRAY['eligibility_270'::"text", 'eligibility_271'::"text", 'claim_status_276'::"text", 'claim_status_277'::"text", 'claim_submission_837p'::"text", 'era_835'::"text", 'payer_list'::"text", 'enrollment'::"text", 'enrollment_status'::"text", 'diagnostics'::"text", 'token_test'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."availity_transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billing_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "source_object_type" "public"."source_object_type" NOT NULL,
    "source_object_id" "uuid" NOT NULL,
    "workqueue_item_id" "uuid",
    "alert_code" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "status" "public"."billing_alert_status" DEFAULT 'open'::"public"."billing_alert_status" NOT NULL,
    "title" "text" NOT NULL,
    "message" "text" NOT NULL,
    "first_detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "snoozed_until" timestamp with time zone,
    "resolution_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    "client_id" "uuid",
    "claim_id" "uuid",
    "encounter_id" "uuid",
    "alert_type" "text" DEFAULT 'other'::"text" NOT NULL,
    "alert_status" "text" DEFAULT 'open'::"text" NOT NULL,
    "description" "text",
    "due_date" "date",
    "acknowledged_by" "uuid",
    "acknowledged_at" timestamp with time zone,
    "resolved_by" "uuid",
    "context_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "billing_alerts_severity_check" CHECK (("severity" = ANY (ARRAY['blocker'::"text", 'warning'::"text"])))
);


ALTER TABLE "public"."billing_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."charge_capture_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "provider_id" "uuid",
    "appointment_id" "uuid",
    "insurance_policy_id" "uuid",
    "source_object_type" "text" DEFAULT 'encounter'::"text" NOT NULL,
    "source_object_id" "uuid" NOT NULL,
    "charge_status" "text" DEFAULT 'captured'::"text" NOT NULL,
    "service_date" "date" NOT NULL,
    "diagnosis_codes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "service_lines" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "total_charge" numeric(12,2) DEFAULT 0 NOT NULL,
    "place_of_service" "text",
    "claim_id" "uuid",
    "blocker_reasons" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "claim_created_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "charge_capture_items_charge_status_check" CHECK (("charge_status" = ANY (ARRAY['captured'::"text", 'ready_for_claim'::"text", 'claim_created'::"text", 'blocked'::"text", 'voided'::"text"])))
);


ALTER TABLE "public"."charge_capture_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "conversation_type" "text" DEFAULT 'direct'::"text" NOT NULL,
    "title" "text",
    "related_client_id" "uuid",
    "related_workqueue_item_id" "uuid",
    "created_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "chat_conversations_conversation_type_check" CHECK (("conversation_type" = ANY (ARRAY['direct'::"text", 'group'::"text", 'workqueue'::"text", 'patient_context'::"text"])))
);


ALTER TABLE "public"."chat_conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "sender_user_id" "uuid" NOT NULL,
    "message_body" "text" NOT NULL,
    "attachment_path" "text",
    "attachment_file_name" "text",
    "attachment_mime_type" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "edited_at" timestamp with time zone,
    "deleted_at" timestamp with time zone
);


ALTER TABLE "public"."chat_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chat_participants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "conversation_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role_in_conversation" "text" DEFAULT 'member'::"text" NOT NULL,
    "last_read_at" timestamp with time zone,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "chat_participants_role_in_conversation_check" CHECK (("role_in_conversation" = ANY (ARRAY['member'::"text", 'owner'::"text"])))
);


ALTER TABLE "public"."chat_participants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."claim_837p_batch_claims" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "professional_claim_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."claim_837p_batch_claims" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."claim_837p_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "batch_number" "text" NOT NULL,
    "batch_status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "claim_count" integer DEFAULT 0 NOT NULL,
    "total_charge_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "generated_file_name" "text",
    "generated_file_content" "text",
    "submitted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "claim_837p_batches_batch_status_check" CHECK (("batch_status" = ANY (ARRAY['draft'::"text", 'ready_to_generate'::"text", 'generated'::"text", 'submitted'::"text", 'accepted'::"text", 'rejected'::"text", 'voided'::"text"])))
);


ALTER TABLE "public"."claim_837p_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."claim_parties_snapshot" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "claim_id" "uuid" NOT NULL,
    "billing_provider_entity_type" "text" DEFAULT '2'::"text" NOT NULL,
    "billing_provider_name" "text" NOT NULL,
    "billing_provider_first_name" "text",
    "billing_provider_npi" "text" NOT NULL,
    "billing_provider_tax_id" "text" NOT NULL,
    "billing_provider_tax_id_type" "text" DEFAULT 'EI'::"text" NOT NULL,
    "billing_provider_address1" "text" NOT NULL,
    "billing_provider_address2" "text",
    "billing_provider_city" "text" NOT NULL,
    "billing_provider_state" "text" NOT NULL,
    "billing_provider_zip" "text" NOT NULL,
    "subscriber_last_name" "text" NOT NULL,
    "subscriber_first_name" "text" NOT NULL,
    "subscriber_member_id" "text" NOT NULL,
    "subscriber_dob" "date" NOT NULL,
    "subscriber_gender" "text",
    "subscriber_address1" "text" NOT NULL,
    "subscriber_city" "text" NOT NULL,
    "subscriber_state" "text" NOT NULL,
    "subscriber_zip" "text" NOT NULL,
    "patient_is_subscriber" boolean DEFAULT true NOT NULL,
    "patient_last_name" "text",
    "patient_first_name" "text",
    "patient_dob" "date",
    "patient_gender" "text",
    "patient_address1" "text",
    "patient_city" "text",
    "patient_state" "text",
    "patient_zip" "text",
    "payer_name" "text" NOT NULL,
    "payer_id" "text" NOT NULL,
    "rendering_same_as_billing" boolean DEFAULT true NOT NULL,
    "rendering_provider_entity_type" "text",
    "rendering_provider_last_name_or_org" "text",
    "rendering_provider_first_name" "text",
    "rendering_provider_npi" "text",
    "service_facility_same_as_billing" boolean DEFAULT true NOT NULL,
    "service_facility_name" "text",
    "service_facility_npi" "text",
    "service_facility_address1" "text",
    "service_facility_city" "text",
    "service_facility_state" "text",
    "service_facility_zip" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "billing_provider_taxonomy" "text",
    "rendering_provider_taxonomy" "text",
    CONSTRAINT "claim_parties_snapshot_billing_provider_entity_type_check" CHECK (("billing_provider_entity_type" = ANY (ARRAY['1'::"text", '2'::"text"]))),
    CONSTRAINT "claim_parties_snapshot_billing_provider_tax_id_type_check" CHECK (("billing_provider_tax_id_type" = ANY (ARRAY['EI'::"text", 'SY'::"text"]))),
    CONSTRAINT "claim_parties_snapshot_patient_gender_check" CHECK (("patient_gender" = ANY (ARRAY['F'::"text", 'M'::"text", 'U'::"text"]))),
    CONSTRAINT "claim_parties_snapshot_rendering_provider_entity_type_check" CHECK (("rendering_provider_entity_type" = ANY (ARRAY['1'::"text", '2'::"text"]))),
    CONSTRAINT "claim_parties_snapshot_subscriber_gender_check" CHECK (("subscriber_gender" = ANY (ARRAY['F'::"text", 'M'::"text", 'U'::"text"])))
);


ALTER TABLE "public"."claim_parties_snapshot" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."claim_service_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "claim_id" "uuid" NOT NULL,
    "encounter_service_line_id" "uuid",
    "service_date" "date" NOT NULL,
    "cpt_hcpcs_code" "text" NOT NULL,
    "modifier_1" "text",
    "modifier_2" "text",
    "modifier_3" "text",
    "modifier_4" "text",
    "units" numeric(10,2) NOT NULL,
    "charge_amount" numeric(12,2) NOT NULL,
    "allowed_amount" numeric(12,2),
    "paid_amount" numeric(12,2),
    "sequence_number" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    CONSTRAINT "claim_service_lines_charge_amount_check" CHECK (("charge_amount" >= (0)::numeric)),
    CONSTRAINT "claim_service_lines_sequence_number_check" CHECK (("sequence_number" > 0)),
    CONSTRAINT "claim_service_lines_units_check" CHECK (("units" > (0)::numeric))
);


ALTER TABLE "public"."claim_service_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."claim_status_inquiries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "claim_id" "uuid" NOT NULL,
    "inquiry_status" "public"."claim_status_inquiry_status" DEFAULT 'queued'::"public"."claim_status_inquiry_status" NOT NULL,
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "responded_at" timestamp with time zone,
    "payer_status_code" "text",
    "payer_status_text" "text",
    "response_summary" "jsonb",
    "external_transaction_id" "uuid",
    "duplicate_detection_key" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."claim_status_inquiries" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."claim_status_checks" WITH ("security_invoker"='true') AS
 SELECT "id",
    "organization_id",
    "claim_id",
    "inquiry_status",
    "requested_at",
    "responded_at",
    "payer_status_code",
    "payer_status_text",
    "response_summary",
    "external_transaction_id",
    "duplicate_detection_key",
    "created_at",
    "updated_at",
    "created_by_user_id",
    "updated_by_user_id",
    "archived_at"
   FROM "public"."claim_status_inquiries";


ALTER VIEW "public"."claim_status_checks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."claim_status_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "claim_id" "uuid",
    "source" "text" DEFAULT 'system'::"text" NOT NULL,
    "status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "status_message" "text",
    "external_claim_id" "text",
    "office_ally_claim_id" "text",
    "office_ally_file_id" "text",
    "payer_reference_id" "text",
    "raw_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."claim_status_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."claim_submissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "claim_id" "uuid" NOT NULL,
    "submission_status" "public"."claim_submission_status" DEFAULT 'queued'::"public"."claim_submission_status" NOT NULL,
    "submission_sequence" integer DEFAULT 1 NOT NULL,
    "submitted_at" timestamp with time zone,
    "acknowledged_at" timestamp with time zone,
    "payer_claim_reference" "text",
    "clearinghouse_reference" "text",
    "external_transaction_id" "uuid",
    "duplicate_detection_key" "text" NOT NULL,
    "response_summary" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    CONSTRAINT "claim_submissions_submission_sequence_check" CHECK (("submission_sequence" > 0))
);


ALTER TABLE "public"."claim_submissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."claim_workqueue_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "claim_id" "uuid" NOT NULL,
    "client_id" "uuid",
    "encounter_id" "uuid",
    "era_claim_payment_id" "uuid",
    "billing_alert_id" "uuid",
    "item_status" "text" DEFAULT 'no_response'::"text" NOT NULL,
    "priority" "text" DEFAULT 'normal'::"text" NOT NULL,
    "carc_code" "text",
    "rarc_code" "text",
    "group_code" "text",
    "denial_reason" "text",
    "action_taken" "text",
    "assigned_to_user_id" "uuid",
    "defer_until" "date",
    "defer_reason" "text",
    "resolved_at" timestamp with time zone,
    "resolved_by_user_id" "uuid",
    "days_in_ar" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "claim_workqueue_items_group_code_check" CHECK ((("group_code" = ANY (ARRAY['PR'::"text", 'CO'::"text", 'OA'::"text", 'PI'::"text"])) OR ("group_code" IS NULL))),
    CONSTRAINT "claim_workqueue_items_item_status_check" CHECK (("item_status" = ANY (ARRAY['no_response'::"text", 'rejected'::"text", 'denied'::"text", 'appeal_needed'::"text", 'eligibility_issue'::"text", 'missing_era'::"text", 'recoupment'::"text", 'aging_0_30'::"text", 'aging_31_60'::"text", 'aging_61_90'::"text", 'aging_91_120'::"text", 'aging_120_plus'::"text", 'resolved'::"text", 'deferred'::"text"]))),
    CONSTRAINT "claim_workqueue_items_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'normal'::"text", 'high'::"text", 'urgent'::"text"])))
);


ALTER TABLE "public"."claim_workqueue_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."claims" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "insurance_policy_id" "uuid" NOT NULL,
    "claim_number" "text" NOT NULL,
    "claim_status" "public"."claim_status" DEFAULT 'draft'::"public"."claim_status" NOT NULL,
    "claim_frequency_code" "text" DEFAULT '1'::"text" NOT NULL,
    "total_charge_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "patient_responsibility_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "payer_responsibility_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "date_of_service_from" "date" NOT NULL,
    "date_of_service_to" "date" NOT NULL,
    "ready_to_submit_at" timestamp with time zone,
    "submitted_at" timestamp with time zone,
    "accepted_at" timestamp with time zone,
    "denied_at" timestamp with time zone,
    "paid_at" timestamp with time zone,
    "last_blocker_codes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "duplicate_detection_key" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    CONSTRAINT "claims_check" CHECK (("date_of_service_to" >= "date_of_service_from")),
    CONSTRAINT "claims_patient_responsibility_amount_check" CHECK (("patient_responsibility_amount" >= (0)::numeric)),
    CONSTRAINT "claims_payer_responsibility_amount_check" CHECK (("payer_responsibility_amount" >= (0)::numeric)),
    CONSTRAINT "claims_total_charge_amount_check" CHECK (("total_charge_amount" >= (0)::numeric))
);


ALTER TABLE "public"."claims" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clearinghouse_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "vendor" "text" NOT NULL,
    "connection_name" "text",
    "mode" "text" DEFAULT 'test'::"text" NOT NULL,
    "submitter_id" "text",
    "receiver_id" "text",
    "api_base_url" "text",
    "auth_type" "text",
    "encrypted_credentials" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "clearinghouse_name" "text" DEFAULT 'office_ally'::"text" NOT NULL,
    "sender_qualifier" "text" DEFAULT 'ZZ'::"text" NOT NULL,
    "receiver_qualifier" "text" DEFAULT '30'::"text" NOT NULL,
    "receiver_name" "text" DEFAULT 'OFFICEALLY'::"text" NOT NULL,
    "gs_receiver_code" "text" DEFAULT 'OA'::"text" NOT NULL,
    "x12_version" "text" DEFAULT '005010X222A1'::"text" NOT NULL,
    "isa_usage_indicator" "text" DEFAULT 'T'::"text" NOT NULL,
    "sftp_host" "text",
    "sftp_port" integer DEFAULT 22,
    "sftp_username" "text",
    "inbound_folder" "text" DEFAULT 'inbound'::"text",
    "outbound_folder" "text" DEFAULT 'outbound'::"text",
    "eligibility_service_type_code" "text" DEFAULT '98'::"text" NOT NULL,
    "eligibility_transaction_set" "text" DEFAULT '270'::"text" NOT NULL,
    CONSTRAINT "clearinghouse_connections_mode_check" CHECK (("mode" = ANY (ARRAY['test'::"text", 'live'::"text"]))),
    CONSTRAINT "clearinghouse_connections_vendor_check" CHECK (("vendor" = ANY (ARRAY['office_ally'::"text", 'availity'::"text", 'change_healthcare'::"text", 'mock'::"text"])))
);


ALTER TABLE "public"."clearinghouse_connections" OWNER TO "postgres";


COMMENT ON COLUMN "public"."clearinghouse_connections"."eligibility_service_type_code" IS 'X12 270 service type code. 98 = Health Benefit Plan Coverage (default for Office Ally).';



CREATE TABLE IF NOT EXISTS "public"."clearinghouse_response_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "claim_id" "uuid",
    "patient_id" "uuid",
    "edi_transaction_id" "uuid",
    "event_type" "text" NOT NULL,
    "severity" "text" DEFAULT 'info'::"text" NOT NULL,
    "source" "text",
    "title" "text" NOT NULL,
    "message" "text",
    "normalized_code" "text",
    "raw_codes" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "is_resolved" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "clearinghouse_response_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['acknowledgment'::"text", 'rejection'::"text", 'status_update'::"text", 'denial'::"text", 'payment'::"text", 'eligibility_result'::"text", 'error'::"text"]))),
    CONSTRAINT "clearinghouse_response_events_severity_check" CHECK (("severity" = ANY (ARRAY['info'::"text", 'warning'::"text", 'error'::"text", 'critical'::"text"])))
);


ALTER TABLE "public"."clearinghouse_response_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "contact_type" "text" NOT NULL,
    "label" "text",
    "value" "text" NOT NULL,
    "is_primary" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    CONSTRAINT "client_contacts_contact_type_check" CHECK (("contact_type" = ANY (ARRAY['mobile'::"text", 'home'::"text", 'work'::"text", 'email'::"text", 'emergency'::"text", 'guarantor'::"text"])))
);


ALTER TABLE "public"."client_contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_import_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "source_system" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "original_file_name" "text",
    "file_type" "text",
    "status" "text" DEFAULT 'uploaded'::"text" NOT NULL,
    "total_rows" integer DEFAULT 0 NOT NULL,
    "valid_rows" integer DEFAULT 0 NOT NULL,
    "invalid_rows" integer DEFAULT 0 NOT NULL,
    "imported_rows" integer DEFAULT 0 NOT NULL,
    "duplicate_rows" integer DEFAULT 0 NOT NULL,
    "mapping" "jsonb",
    "validation_summary" "jsonb",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "promotion_summary" "jsonb",
    CONSTRAINT "client_import_jobs_valid_status" CHECK (("status" = ANY (ARRAY['uploaded'::"text", 'mapped'::"text", 'validated'::"text", 'importing'::"text", 'completed'::"text", 'failed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."client_import_jobs" OWNER TO "postgres";


COMMENT ON TABLE "public"."client_import_jobs" IS 'Client import job metadata and aggregate validation/import status for staged file ingestion.';



COMMENT ON COLUMN "public"."client_import_jobs"."promotion_summary" IS 'Aggregate promotion outcomes: total/valid/invalid/duplicates/promoted/skipped/failed.';



CREATE TABLE IF NOT EXISTS "public"."client_import_rows" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "import_job_id" "uuid" NOT NULL,
    "row_number" integer NOT NULL,
    "raw_data" "jsonb" NOT NULL,
    "mapped_data" "jsonb",
    "validation_errors" "jsonb",
    "validation_warnings" "jsonb",
    "duplicate_match_client_id" "uuid",
    "import_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "imported_client_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source_client_id" "text",
    "duplicate_reason" "text",
    "duplicate_strategy" "text",
    "promoted_policy_id" "uuid",
    "promotion_error" "text",
    CONSTRAINT "client_import_rows_valid_import_status" CHECK (("import_status" = ANY (ARRAY['pending'::"text", 'valid'::"text", 'invalid'::"text", 'duplicate'::"text", 'imported'::"text", 'skipped'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."client_import_rows" OWNER TO "postgres";


COMMENT ON TABLE "public"."client_import_rows" IS 'Per-row staged import data with mapped fields, validation output, and import state.';



COMMENT ON COLUMN "public"."client_import_rows"."source_client_id" IS 'External source-system client identifier extracted from mapped import row.';



COMMENT ON COLUMN "public"."client_import_rows"."duplicate_reason" IS 'Human-readable explanation for duplicate classification.';



COMMENT ON COLUMN "public"."client_import_rows"."duplicate_strategy" IS 'Duplicate strategy used: source_client_id or name_dob.';



COMMENT ON COLUMN "public"."client_import_rows"."promoted_policy_id" IS 'Primary insurance policy id created/linked during promotion.';



COMMENT ON COLUMN "public"."client_import_rows"."promotion_error" IS 'Terminal row-level promotion error message when import_status=failed.';



CREATE TABLE IF NOT EXISTS "public"."clients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "external_client_ref" "text",
    "mrn" "text",
    "first_name" "text" NOT NULL,
    "middle_name" "text",
    "last_name" "text" NOT NULL,
    "preferred_name" "text",
    "date_of_birth" "date" NOT NULL,
    "sex_at_birth" "text",
    "gender_identity" "text",
    "pronouns" "text",
    "phone" "text",
    "email" "text",
    "address_line_1" "text",
    "address_line_2" "text",
    "city" "text",
    "state" "text",
    "postal_code" "text",
    "preferred_language" "text",
    "primary_clinician_user_id" "uuid",
    "deceased_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."clients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."coding_suggestions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "suggestion_type" "text" DEFAULT 'cpt'::"text" NOT NULL,
    "suggested_code" "text" NOT NULL,
    "suggested_modifier" "text",
    "description" "text",
    "rationale" "text",
    "confidence_score" numeric(5,4),
    "medical_necessity_warning" "text",
    "unsupported_combination" "text",
    "missed_code_alert" "text",
    "suggestion_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "accepted_by_user_id" "uuid",
    "accepted_at" timestamp with time zone,
    "source" "text" DEFAULT 'rules_engine'::"text" NOT NULL,
    "raw_trigger_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "coding_suggestions_confidence_score_check" CHECK ((("confidence_score" >= (0)::numeric) AND ("confidence_score" <= (1)::numeric))),
    CONSTRAINT "coding_suggestions_source_check" CHECK (("source" = ANY (ARRAY['rules_engine'::"text", 'ai'::"text", 'payer_policy'::"text", 'manual'::"text"]))),
    CONSTRAINT "coding_suggestions_suggestion_status_check" CHECK (("suggestion_status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'rejected'::"text", 'ignored'::"text"]))),
    CONSTRAINT "coding_suggestions_suggestion_type_check" CHECK (("suggestion_type" = ANY (ARRAY['cpt'::"text", 'hcpcs'::"text", 'icd10'::"text", 'modifier'::"text", 'missed_code'::"text"])))
);


ALTER TABLE "public"."coding_suggestions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_app_config" (
    "config_id" integer NOT NULL,
    "config_key" character varying(100) NOT NULL,
    "config_value" "text",
    "description" character varying(255),
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "date_changed" timestamp without time zone
);


ALTER TABLE "public"."custom_app_config" OWNER TO "postgres";


ALTER TABLE "public"."custom_app_config" ALTER COLUMN "config_id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."custom_app_config_config_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."custom_appointment_request" (
    "appointment_request_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "provider_id" "uuid",
    "location_id" "uuid",
    "requested_date" "date" NOT NULL,
    "requested_time" time without time zone,
    "appointment_type" character varying(100) NOT NULL,
    "status" character varying(50) DEFAULT 'REQUESTED'::character varying NOT NULL,
    "reason" "text",
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "date_changed" timestamp without time zone
);


ALTER TABLE "public"."custom_appointment_request" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_audit_event" (
    "audit_event_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "client_id" "uuid",
    "event_type" character varying(100) NOT NULL,
    "entity_type" character varying(100),
    "entity_id" "uuid",
    "event_description" "text",
    "ip_address" character varying(45),
    "user_agent" character varying(500),
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE "public"."custom_audit_event" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_billing_service" (
    "billing_service_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "service_code" character varying(100) NOT NULL,
    "service_name" character varying(255) NOT NULL,
    "service_description" "text",
    "default_price" numeric(12,2) DEFAULT 0 NOT NULL,
    "taxable" boolean DEFAULT false NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "date_changed" timestamp without time zone
);


ALTER TABLE "public"."custom_billing_service" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_billing_settings" (
    "billing_settings_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_name" character varying(255),
    "billing_enabled" boolean DEFAULT true NOT NULL,
    "default_currency" character varying(10) DEFAULT 'USD'::character varying NOT NULL,
    "default_tax_rate" numeric(8,4) DEFAULT 0 NOT NULL,
    "invoice_prefix" character varying(50) DEFAULT 'INV'::character varying NOT NULL,
    "next_invoice_number" bigint DEFAULT 1000 NOT NULL,
    "payment_due_days" integer DEFAULT 30 NOT NULL,
    "allow_partial_payments" boolean DEFAULT true NOT NULL,
    "auto_generate_invoice" boolean DEFAULT false NOT NULL,
    "require_payment_before_service" boolean DEFAULT false NOT NULL,
    "billing_contact_name" character varying(255),
    "billing_contact_email" character varying(255),
    "billing_contact_phone" character varying(50),
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "date_changed" timestamp without time zone
);


ALTER TABLE "public"."custom_billing_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_billing_workqueue_comment" (
    "comment_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "claim_id" "uuid",
    "workqueue_item_id" "uuid",
    "client_id" "uuid",
    "action_type" character varying(50) NOT NULL,
    "comment_text" "text" NOT NULL,
    "reportable" boolean DEFAULT true NOT NULL,
    "billing_month" "date" GENERATED ALWAYS AS (("date_trunc"('month'::"text", "date_created"))::"date") STORED,
    "created_by" "uuid",
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "resolved_at" timestamp without time zone,
    "deferred_until" "date",
    "metadata" "jsonb",
    CONSTRAINT "chk_custom_billing_workqueue_action_type" CHECK ((("action_type")::"text" = ANY ((ARRAY['COMMENT'::character varying, 'DEFERRED'::character varying, 'RESOLVED'::character varying, 'REOPENED'::character varying, 'ESCALATED'::character varying, 'FOLLOW_UP'::character varying])::"text"[]))),
    CONSTRAINT "chk_custom_billing_workqueue_target" CHECK ((("claim_id" IS NOT NULL) OR ("workqueue_item_id" IS NOT NULL)))
);


ALTER TABLE "public"."custom_billing_workqueue_comment" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_client_document" (
    "document_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "document_type" character varying(100) NOT NULL,
    "document_title" character varying(255) NOT NULL,
    "file_name" character varying(255) NOT NULL,
    "file_path" character varying(500) NOT NULL,
    "mime_type" character varying(100),
    "file_size_bytes" bigint,
    "uploaded_by" "uuid",
    "date_uploaded" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "voided" boolean DEFAULT false NOT NULL,
    "void_reason" character varying(255)
);


ALTER TABLE "public"."custom_client_document" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_client_import_staging" (
    "staging_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "batch_id" character varying(100) NOT NULL,
    "external_client_id" character varying(100),
    "given_name" character varying(100),
    "middle_name" character varying(100),
    "family_name" character varying(100),
    "gender" character varying(20),
    "birthdate" "date",
    "phone_number" character varying(50),
    "address1" character varying(255),
    "city_village" character varying(100),
    "state_province" character varying(100),
    "country" character varying(100),
    "raw_payload" "jsonb",
    "import_status" character varying(50) DEFAULT 'PENDING'::character varying NOT NULL,
    "error_message" "text",
    "matched_client_id" "uuid",
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "date_processed" timestamp without time zone
);


ALTER TABLE "public"."custom_client_import_staging" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_client_note" (
    "client_note_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "note_type_id" "uuid",
    "note_title" character varying(255),
    "note_body" "text" NOT NULL,
    "note_status" character varying(50) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "note_visibility" character varying(50) DEFAULT 'INTERNAL'::character varying NOT NULL,
    "is_private" boolean DEFAULT false NOT NULL,
    "requires_follow_up" boolean DEFAULT false NOT NULL,
    "follow_up_date" "date",
    "created_by" "uuid",
    "updated_by" "uuid",
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "date_changed" timestamp without time zone,
    "voided" boolean DEFAULT false NOT NULL,
    "void_reason" "text"
);


ALTER TABLE "public"."custom_client_note" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_client_profile" (
    "profile_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "external_client_code" character varying(100),
    "registration_source" character varying(100),
    "enrollment_status" character varying(50) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "assigned_case_worker" character varying(150),
    "notes" "text",
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "date_changed" timestamp without time zone
);


ALTER TABLE "public"."custom_client_profile" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_client_program" (
    "client_program_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "program_name" character varying(150) NOT NULL,
    "program_status" character varying(50) DEFAULT 'ENROLLED'::character varying NOT NULL,
    "enrollment_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "completion_date" "date",
    "outcome" character varying(100),
    "comments" "text",
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "date_changed" timestamp without time zone
);


ALTER TABLE "public"."custom_client_program" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_invoice" (
    "invoice_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "invoice_number" character varying(100) NOT NULL,
    "invoice_status" character varying(50) DEFAULT 'DRAFT'::character varying NOT NULL,
    "invoice_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "due_date" "date",
    "subtotal" numeric(12,2) DEFAULT 0 NOT NULL,
    "tax_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "discount_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "total_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "amount_paid" numeric(12,2) DEFAULT 0 NOT NULL,
    "balance_due" numeric(12,2) DEFAULT 0 NOT NULL,
    "notes" "text",
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "date_changed" timestamp without time zone
);


ALTER TABLE "public"."custom_invoice" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_invoice_line_item" (
    "invoice_line_item_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "billing_service_id" "uuid",
    "item_code" character varying(100),
    "item_description" "text" NOT NULL,
    "quantity" numeric(12,2) DEFAULT 1 NOT NULL,
    "unit_price" numeric(12,2) DEFAULT 0 NOT NULL,
    "tax_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "discount_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "line_total" numeric(12,2) DEFAULT 0 NOT NULL,
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE "public"."custom_invoice_line_item" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_lookup_value" (
    "lookup_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lookup_type" character varying(100) NOT NULL,
    "lookup_code" character varying(100) NOT NULL,
    "lookup_label" character varying(255) NOT NULL,
    "sort_order" integer DEFAULT 0,
    "active" boolean DEFAULT true NOT NULL,
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE "public"."custom_lookup_value" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_note_settings" (
    "note_settings_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "notes_enabled" boolean DEFAULT true NOT NULL,
    "require_note_type" boolean DEFAULT true NOT NULL,
    "require_author" boolean DEFAULT true NOT NULL,
    "allow_private_notes" boolean DEFAULT true NOT NULL,
    "allow_note_editing" boolean DEFAULT true NOT NULL,
    "allow_note_deleting" boolean DEFAULT false NOT NULL,
    "max_note_length" integer DEFAULT 10000 NOT NULL,
    "default_note_visibility" character varying(50) DEFAULT 'INTERNAL'::character varying NOT NULL,
    "default_note_status" character varying(50) DEFAULT 'ACTIVE'::character varying NOT NULL,
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "date_changed" timestamp without time zone
);


ALTER TABLE "public"."custom_note_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_note_type" (
    "note_type_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "note_type_code" character varying(100) NOT NULL,
    "note_type_name" character varying(255) NOT NULL,
    "description" "text",
    "requires_follow_up" boolean DEFAULT false NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "date_changed" timestamp without time zone
);


ALTER TABLE "public"."custom_note_type" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_payment" (
    "payment_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "payment_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "payment_method" character varying(100) NOT NULL,
    "payment_reference" character varying(255),
    "payment_amount" numeric(12,2) NOT NULL,
    "notes" "text",
    "date_created" timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE "public"."custom_payment" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dashboard_user_preferences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "layout" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "hidden_widgets" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."dashboard_user_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dashboard_widgets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "widget_key" "text" NOT NULL,
    "title" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."dashboard_widgets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."diagnosis_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "code_system" "text" DEFAULT 'ICD-10-CM'::"text" NOT NULL,
    "description" "text" NOT NULL,
    "description_short" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "effective_date" "date",
    "expiration_date" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."diagnosis_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."document_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "document_id" "uuid" NOT NULL,
    "linked_entity_type" "text" NOT NULL,
    "linked_entity_id" "uuid" NOT NULL,
    "link_notes" "text",
    "created_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "document_links_linked_entity_type_check" CHECK (("linked_entity_type" = ANY (ARRAY['patient'::"text", 'claim'::"text", 'encounter'::"text", 'appointment'::"text", 'workqueue_item'::"text", 'ticket'::"text", 'mailroom_item'::"text", 'organization'::"text"])))
);


ALTER TABLE "public"."document_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "client_id" "uuid",
    "encounter_id" "uuid",
    "claim_id" "uuid",
    "workqueue_item_id" "uuid",
    "mailroom_item_id" "uuid",
    "document_scope" "text" DEFAULT 'patient_chart'::"text" NOT NULL,
    "document_type" "text",
    "title" "text" NOT NULL,
    "file_name" "text" NOT NULL,
    "storage_bucket" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "mime_type" "text",
    "file_size_bytes" integer,
    "uploaded_by_user_id" "uuid",
    "filed_by_user_id" "uuid",
    "filed_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "documents_document_scope_check" CHECK (("document_scope" = ANY (ARRAY['patient_chart'::"text", 'practice_documents'::"text", 'claim'::"text", 'encounter'::"text", 'mailroom'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."edi_acknowledgements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "edi_batch_id" "uuid",
    "acknowledgement_type" "text" NOT NULL,
    "file_name" "text",
    "raw_content" "text" NOT NULL,
    "parsed_content" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "edi_acknowledgements_acknowledgement_type_check" CHECK (("acknowledgement_type" = ANY (ARRAY['999'::"text", '277CA'::"text", 'file_summary'::"text", 'edi_status'::"text", '835'::"text", 'era_status_text'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."edi_acknowledgements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."edi_batch_claims" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "edi_batch_id" "uuid" NOT NULL,
    "claim_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."edi_batch_claims" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."edi_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "clearinghouse_connection_id" "uuid",
    "transaction_type" "text" DEFAULT '837P'::"text" NOT NULL,
    "mode" "text" NOT NULL,
    "file_name" "text" NOT NULL,
    "file_content" "text" NOT NULL,
    "isa_control_number" "text" NOT NULL,
    "gs_control_number" "text" NOT NULL,
    "st_control_number" "text" NOT NULL,
    "claim_count" integer DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'generated'::"text" NOT NULL,
    "office_ally_file_id" "text",
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "submitted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "edi_batches_mode_check" CHECK (("mode" = ANY (ARRAY['test'::"text", 'production'::"text"]))),
    CONSTRAINT "edi_batches_status_check" CHECK (("status" = ANY (ARRAY['generated'::"text", 'submitted'::"text", 'accepted_999'::"text", 'rejected_999'::"text", 'accepted_277ca'::"text", 'rejected_277ca'::"text", 'partially_accepted'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."edi_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."edi_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "patient_id" "uuid",
    "appointment_id" "uuid",
    "encounter_id" "uuid",
    "claim_id" "uuid",
    "clearinghouse_connection_id" "uuid",
    "transaction_type" "text" NOT NULL,
    "direction" "text" NOT NULL,
    "status" "text" NOT NULL,
    "control_number" "text",
    "correlation_id" "text",
    "request_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "response_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "raw_request" "text",
    "raw_response" "text",
    "parsed_summary" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error_message" "text",
    "sent_at" timestamp with time zone,
    "received_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "edi_transactions_direction_check" CHECK (("direction" = ANY (ARRAY['outbound'::"text", 'inbound'::"text"]))),
    CONSTRAINT "edi_transactions_status_check" CHECK (("status" = ANY (ARRAY['created'::"text", 'sent'::"text", 'received'::"text", 'parsed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."edi_transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."eligibility_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "patient_id" "uuid",
    "payer_configuration_id" "uuid",
    "payer_id" "text",
    "payer_name" "text",
    "provider_npi" "text",
    "subscriber_id" "text",
    "subscriber_first_name" "text",
    "subscriber_last_name" "text",
    "subscriber_dob" "date",
    "patient_first_name" "text",
    "patient_last_name" "text",
    "patient_dob" "date",
    "service_type_code" "text" DEFAULT '98'::"text" NOT NULL,
    "service_type_description" "text" DEFAULT 'Professional Services'::"text" NOT NULL,
    "request_mode" "text" DEFAULT 'mock'::"text" NOT NULL,
    "status" "text" DEFAULT 'created'::"text" NOT NULL,
    "availity_transaction_id" "uuid",
    "request_payload_safe" "jsonb",
    "response_payload_safe" "jsonb",
    "eligibility_status" "text",
    "copay_amount" numeric,
    "deductible_remaining" numeric,
    "effective_date" "date",
    "termination_date" "date",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "appointment_id" "uuid",
    CONSTRAINT "eligibility_requests_service_type_98_default" CHECK (("service_type_code" <> ''::"text")),
    CONSTRAINT "eligibility_requests_valid_request_mode" CHECK (("request_mode" = ANY (ARRAY['mock'::"text", 'demo'::"text", 'production'::"text"]))),
    CONSTRAINT "eligibility_requests_valid_status" CHECK (("status" = ANY (ARRAY['created'::"text", 'prepared'::"text", 'submitted'::"text", 'completed'::"text", 'failed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."eligibility_requests" OWNER TO "postgres";


COMMENT ON TABLE "public"."eligibility_requests" IS 'Internal eligibility request preparation records. Stores safe request/response payloads and normalized summary outputs.';



COMMENT ON COLUMN "public"."eligibility_requests"."service_type_code" IS 'EDI service type code; default must remain 98 (Professional Services).';



COMMENT ON COLUMN "public"."eligibility_requests"."request_payload_safe" IS 'Sanitized request payload with no credentials, tokens, authorization headers, or API keys.';



COMMENT ON COLUMN "public"."eligibility_requests"."response_payload_safe" IS 'Sanitized response payload with no credentials, tokens, authorization headers, or API keys.';



CREATE OR REPLACE VIEW "public"."eligibility_with_staleness" WITH ("security_invoker"='true') AS
 SELECT "id",
    "organization_id",
    "client_id",
    "insurance_policy_id",
    "appointment_id",
    "encounter_id",
    "eligibility_status",
    "checked_at",
    "coverage_start_date",
    "coverage_end_date",
    "copay_amount",
    "deductible_remaining",
    "out_of_pocket_remaining",
    "raw_status_text",
    "response_summary",
    "external_transaction_id",
    "created_at",
    "updated_at",
    "created_by_user_id",
    "updated_by_user_id",
    "archived_at",
        CASE
            WHEN ("checked_at" IS NULL) THEN 'not_checked'::"text"
            WHEN ("checked_at" < ("now"() - '30 days'::interval)) THEN 'stale'::"text"
            ELSE ("eligibility_status")::"text"
        END AS "computed_status"
   FROM "public"."eligibility_checks";


ALTER VIEW "public"."eligibility_with_staleness" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."encounter_clinical_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "provider_id" "uuid",
    "note_status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "subjective" "text",
    "interventions" "text",
    "plan" "text",
    "signed_at" timestamp with time zone,
    "signed_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    "objective" "text",
    "assessment" "text",
    "check_in_imported_at" timestamp with time zone,
    "suggested_codes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    CONSTRAINT "encounter_clinical_notes_note_status_check" CHECK (("note_status" = ANY (ARRAY['draft'::"text", 'signed'::"text", 'voided'::"text"])))
);


ALTER TABLE "public"."encounter_clinical_notes" OWNER TO "postgres";


COMMENT ON COLUMN "public"."encounter_clinical_notes"."subjective" IS 'SOAP S: patient-reported symptoms, check-in intake import target';



COMMENT ON COLUMN "public"."encounter_clinical_notes"."plan" IS 'SOAP P: treatment plan, interventions, next steps';



COMMENT ON COLUMN "public"."encounter_clinical_notes"."objective" IS 'SOAP O: clinician observations, vitals, test results';



COMMENT ON COLUMN "public"."encounter_clinical_notes"."assessment" IS 'SOAP A: clinical assessment and diagnosis';



COMMENT ON COLUMN "public"."encounter_clinical_notes"."suggested_codes" IS 'Auto-flagged CPT/HCPCS codes from check-in import. Values: H0031, H0001, H0032 when clinically supported.';



CREATE TABLE IF NOT EXISTS "public"."encounter_code_suggestions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "encounter_id" "uuid",
    "appointment_id" "uuid",
    "client_id" "uuid" NOT NULL,
    "suggested_code" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "source" "text" DEFAULT 'patient_checkin'::"text" NOT NULL,
    "auto_add" boolean DEFAULT false NOT NULL,
    "accepted" boolean,
    "accepted_by_user_id" "uuid",
    "accepted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "encounter_code_suggestions_source_check" CHECK (("source" = ANY (ARRAY['patient_checkin'::"text", 'duration_rule'::"text", 'clinician_entry'::"text", 'audit'::"text"])))
);


ALTER TABLE "public"."encounter_code_suggestions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."encounter_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "code_type" "text" DEFAULT 'CPT'::"text" NOT NULL,
    "procedure_code" "text" NOT NULL,
    "modifiers" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "units" numeric(8,2) DEFAULT 1 NOT NULL,
    "fee_amount" numeric(12,2),
    "diagnosis_pointers" integer[] DEFAULT '{}'::integer[] NOT NULL,
    "place_of_service" "text",
    "is_primary" boolean DEFAULT false NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "coding_suggestion_id" "uuid",
    "clinical_justification" "text",
    "created_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "encounter_codes_code_type_check" CHECK (("code_type" = ANY (ARRAY['CPT'::"text", 'HCPCS'::"text", 'ICD-10'::"text"]))),
    CONSTRAINT "encounter_codes_source_check" CHECK (("source" = ANY (ARRAY['manual'::"text", 'suggestion'::"text", 'template'::"text", 'copy_forward'::"text"])))
);


ALTER TABLE "public"."encounter_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."encounter_diagnoses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "diagnosis_code" "text" NOT NULL,
    "diagnosis_description" "text",
    "is_primary" boolean DEFAULT false NOT NULL,
    "sequence_number" integer NOT NULL,
    "present_on_claim" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    CONSTRAINT "encounter_diagnoses_sequence_number_check" CHECK (("sequence_number" > 0))
);


ALTER TABLE "public"."encounter_diagnoses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."encounter_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "note_status" "public"."note_status" DEFAULT 'not_started'::"public"."note_status" NOT NULL,
    "note_type" "text" DEFAULT 'progress_note'::"text" NOT NULL,
    "note_body" "text",
    "signed_at" timestamp with time zone,
    "signed_by_provider_id" "uuid",
    "amended_from_note_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."encounter_notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."encounter_service_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "service_date" "date" NOT NULL,
    "cpt_hcpcs_code" "text" NOT NULL,
    "modifier_1" "text",
    "modifier_2" "text",
    "modifier_3" "text",
    "modifier_4" "text",
    "units" numeric(10,2) NOT NULL,
    "charge_amount" numeric(12,2) NOT NULL,
    "rendering_provider_id" "uuid",
    "place_of_service_code" "text",
    "sequence_number" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    CONSTRAINT "encounter_service_lines_charge_amount_check" CHECK (("charge_amount" >= (0)::numeric)),
    CONSTRAINT "encounter_service_lines_sequence_number_check" CHECK (("sequence_number" > 0)),
    CONSTRAINT "encounter_service_lines_units_check" CHECK (("units" > (0)::numeric))
);


ALTER TABLE "public"."encounter_service_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."encounters" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "appointment_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "encounter_status" "public"."encounter_status" DEFAULT 'scheduled'::"public"."encounter_status" NOT NULL,
    "started_at" timestamp with time zone,
    "ended_at" timestamp with time zone,
    "service_date" "date",
    "required_billing_fields_complete" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    "session_summary" "text",
    "soap_note" "jsonb",
    CONSTRAINT "encounters_check" CHECK ((("ended_at" IS NULL) OR ("started_at" IS NULL) OR ("ended_at" >= "started_at")))
);


ALTER TABLE "public"."encounters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."era_claim_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "era_import_batch_id" "uuid" NOT NULL,
    "professional_claim_id" "uuid",
    "client_id" "uuid",
    "clp01_claim_control_number" "text" NOT NULL,
    "clp02_claim_status_code" "text",
    "clp03_total_charge" numeric(12,2) DEFAULT 0 NOT NULL,
    "clp04_payment_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "clp05_patient_responsibility" numeric(12,2) DEFAULT 0 NOT NULL,
    "payer_claim_control_number" "text",
    "claim_match_status" "text" DEFAULT 'unmatched'::"text" NOT NULL,
    "posting_status" "text" DEFAULT 'ready'::"text" NOT NULL,
    "cas_adjustments" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "service_lines" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "raw_segments" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    "check_eft_number" "text",
    "payer_trace_number" "text",
    "check_issue_date" "date",
    "allowed_amount" numeric(12,2),
    "adjustment_amount" numeric(12,2),
    "carc_codes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "rarc_codes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "pr_amount" numeric(12,2),
    "co_amount" numeric(12,2),
    "oa_amount" numeric(12,2),
    "pi_amount" numeric(12,2),
    CONSTRAINT "era_claim_payments_claim_match_status_check" CHECK (("claim_match_status" = ANY (ARRAY['matched'::"text", 'unmatched'::"text", 'ambiguous'::"text"]))),
    CONSTRAINT "era_claim_payments_posting_status_check" CHECK (("posting_status" = ANY (ARRAY['ready'::"text", 'posted'::"text", 'blocked'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."era_claim_payments" OWNER TO "postgres";


COMMENT ON COLUMN "public"."era_claim_payments"."carc_codes" IS 'CARC (Claim Adjustment Reason Codes) from 835 CAS segments';



COMMENT ON COLUMN "public"."era_claim_payments"."rarc_codes" IS 'RARC (Remittance Advice Remark Codes) from 835 MOA/LQ segments';



CREATE TABLE IF NOT EXISTS "public"."era_import_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "source" "text" DEFAULT 'manual_upload'::"text" NOT NULL,
    "file_name" "text",
    "raw_content" "text" NOT NULL,
    "parsed_summary" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "import_status" "text" DEFAULT 'parsed'::"text" NOT NULL,
    "total_claims" integer DEFAULT 0 NOT NULL,
    "total_payment_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "total_patient_responsibility" numeric(12,2) DEFAULT 0 NOT NULL,
    "imported_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "era_import_batches_import_status_check" CHECK (("import_status" = ANY (ARRAY['uploaded'::"text", 'parsed'::"text", 'matched'::"text", 'posted'::"text", 'blocked'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."era_import_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."era_posting_ledger_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "era_claim_payment_id" "uuid" NOT NULL,
    "professional_claim_id" "uuid",
    "client_id" "uuid",
    "entry_type" "text" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "group_code" "text",
    "reason_code" "text",
    "description" "text",
    "source_segment" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "era_posting_ledger_entries_entry_type_check" CHECK (("entry_type" = ANY (ARRAY['insurance_payment'::"text", 'contractual_adjustment'::"text", 'patient_responsibility'::"text", 'other_adjustment'::"text"])))
);


ALTER TABLE "public"."era_posting_ledger_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."external_message_envelopes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "external_transaction_attempt_id" "uuid" NOT NULL,
    "isa01" "text",
    "isa02" "text",
    "isa03" "text",
    "isa04" "text",
    "isa05" "text",
    "isa06" "text",
    "isa07" "text",
    "isa08" "text",
    "isa09" "text",
    "isa10" "text",
    "isa11" "text",
    "isa12" "text",
    "isa13" "text",
    "isa14" "text",
    "isa15" "text",
    "isa16" "text",
    "iea01" "text",
    "iea02" "text",
    "gs01" "text",
    "gs02" "text",
    "gs03" "text",
    "gs04" "text",
    "gs05" "text",
    "gs06" "text",
    "gs07" "text",
    "gs08" "text",
    "ge01" "text",
    "ge02" "text",
    "envelope_valid" boolean DEFAULT false NOT NULL,
    "envelope_error_code" "text",
    "envelope_error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    CONSTRAINT "external_message_envelopes_check" CHECK ((("isa13" IS NULL) OR ("iea02" IS NULL) OR ("isa13" = "iea02"))),
    CONSTRAINT "external_message_envelopes_check1" CHECK ((("gs06" IS NULL) OR ("ge02" IS NULL) OR ("gs06" = "ge02")))
);


ALTER TABLE "public"."external_message_envelopes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."external_transaction_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "external_transaction_id" "uuid" NOT NULL,
    "attempt_number" integer NOT NULL,
    "status" "public"."external_attempt_status" DEFAULT 'queued'::"public"."external_attempt_status" NOT NULL,
    "started_at" timestamp with time zone,
    "ended_at" timestamp with time zone,
    "http_status_code" integer,
    "transport_error_code" "text",
    "transport_error_message" "text",
    "request_headers" "jsonb",
    "response_headers" "jsonb",
    "outbound_payload" "text",
    "inbound_payload" "text",
    "retry_after" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    CONSTRAINT "external_transaction_attempts_attempt_number_check" CHECK (("attempt_number" > 0))
);


ALTER TABLE "public"."external_transaction_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fee_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "payer_contract_id" "uuid",
    "schedule_name" "text" NOT NULL,
    "procedure_code" "text" NOT NULL,
    "modifiers" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "place_of_service" "text",
    "allowed_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "billed_rate" numeric(12,2),
    "effective_date" "date",
    "expiration_date" "date",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."fee_schedules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gmail_oauth_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "integration_connection_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "access_token" "text",
    "refresh_token" "text" NOT NULL,
    "token_type" "text",
    "scope" "text",
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."gmail_oauth_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inbound_email_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "integration_connection_id" "uuid",
    "provider" "text" DEFAULT 'gmail'::"text" NOT NULL,
    "gmail_message_id" "text" NOT NULL,
    "gmail_thread_id" "text",
    "gmail_history_id" "text",
    "from_email" "text" NOT NULL,
    "from_name" "text",
    "to_email" "text",
    "subject" "text",
    "snippet" "text",
    "received_at" timestamp with time zone,
    "matched_profile_id" "uuid",
    "matched_client_id" "uuid",
    "matched_provider_id" "uuid",
    "match_confidence" numeric(5,4),
    "mailroom_item_id" "uuid",
    "workqueue_item_id" "uuid",
    "processing_status" "text" DEFAULT 'received'::"text" NOT NULL,
    "raw_headers" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "raw_payload" "jsonb",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    "ai_sentiment" "text",
    "ai_sentiment_score" numeric(5,4),
    "ai_category" "text",
    "ai_priority" "public"."workqueue_priority",
    "ai_summary" "text",
    "ai_draft_reply" "text",
    "ai_analysis_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "ai_analyzed_at" timestamp with time zone,
    "ai_error" "text",
    CONSTRAINT "inbound_email_messages_ai_analysis_status_check" CHECK (("ai_analysis_status" = ANY (ARRAY['pending'::"text", 'analyzed'::"text", 'failed'::"text", 'skipped'::"text"]))),
    CONSTRAINT "inbound_email_messages_processing_status_check" CHECK (("processing_status" = ANY (ARRAY['received'::"text", 'matched'::"text", 'routed'::"text", 'ignored'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."inbound_email_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insurance_payers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "payer_name" "text" NOT NULL,
    "payer_id" "text" NOT NULL,
    "payer_category" "text",
    "claims_address" "text",
    "remit_address" "text",
    "eligibility_endpoint" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."insurance_payers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insurance_policies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "subscriber_id" "uuid" NOT NULL,
    "payer_id" "uuid" NOT NULL,
    "priority" "public"."insurance_policy_priority" DEFAULT 'primary'::"public"."insurance_policy_priority" NOT NULL,
    "plan_name" "text",
    "policy_number" "text",
    "effective_date" "date" NOT NULL,
    "termination_date" "date",
    "copay_amount" numeric(12,2),
    "coinsurance_percent" numeric(5,2),
    "deductible_amount" numeric(12,2),
    "out_of_pocket_max" numeric(12,2),
    "active_flag" boolean DEFAULT true NOT NULL,
    "legacy_availity_plan_code" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    CONSTRAINT "insurance_policies_check" CHECK ((("termination_date" IS NULL) OR ("termination_date" >= "effective_date"))),
    CONSTRAINT "insurance_policy_valid_dates_chk" CHECK ((("termination_date" IS NULL) OR ("termination_date" >= "effective_date")))
);


ALTER TABLE "public"."insurance_policies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insurance_subscribers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "external_subscriber_ref" "text",
    "first_name" "text" NOT NULL,
    "last_name" "text" NOT NULL,
    "date_of_birth" "date" NOT NULL,
    "relationship_to_client" "text" NOT NULL,
    "member_id" "text" NOT NULL,
    "group_number" "text",
    "address_line_1" "text",
    "address_line_2" "text",
    "city" "text",
    "state" "text",
    "postal_code" "text",
    "phone" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."insurance_subscribers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."integration_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "integration_type" "text" NOT NULL,
    "connection_status" "text" DEFAULT 'disconnected'::"text" NOT NULL,
    "display_name" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "last_checked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "external_account_email" "text",
    "last_history_id" "text",
    "watch_expires_at" timestamp with time zone,
    "last_sync_at" timestamp with time zone,
    "sync_error" "text"
);


ALTER TABLE "public"."integration_connections" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."kpi_claim_summary" WITH ("security_invoker"='true') AS
 SELECT "organization_id",
    "count"(*) AS "total_claims",
    "count"(*) FILTER (WHERE ("claim_status" = 'draft'::"public"."claim_status")) AS "draft_claims",
    "count"(*) FILTER (WHERE ("claim_status" = 'submitted'::"public"."claim_status")) AS "submitted_claims",
    "count"(*) FILTER (WHERE ("claim_status" = 'accepted'::"public"."claim_status")) AS "accepted_claims",
    "count"(*) FILTER (WHERE ("claim_status" = 'rejected'::"public"."claim_status")) AS "rejected_claims",
    "count"(*) FILTER (WHERE ("claim_status" = 'denied'::"public"."claim_status")) AS "denied_claims",
    "count"(*) FILTER (WHERE ("claim_status" = 'paid'::"public"."claim_status")) AS "paid_claims",
    COALESCE("sum"("total_charge_amount"), (0)::numeric) AS "total_charges",
    COALESCE("sum"("patient_responsibility_amount"), (0)::numeric) AS "patient_responsibility",
    COALESCE("sum"("payer_responsibility_amount"), (0)::numeric) AS "payer_responsibility"
   FROM "public"."claims"
  WHERE ("archived_at" IS NULL)
  GROUP BY "organization_id";


ALTER VIEW "public"."kpi_claim_summary" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."kpi_eligibility_summary" WITH ("security_invoker"='true') AS
 SELECT "organization_id",
    "count"(*) AS "total_checks",
    "count"(*) FILTER (WHERE ("eligibility_status" = 'not_checked'::"public"."eligibility_status")) AS "not_checked",
    "count"(*) FILTER (WHERE ("eligibility_status" = 'pending'::"public"."eligibility_status")) AS "pending",
    "count"(*) FILTER (WHERE ("eligibility_status" = 'active'::"public"."eligibility_status")) AS "active",
    "count"(*) FILTER (WHERE ("eligibility_status" = 'inactive'::"public"."eligibility_status")) AS "inactive",
    "count"(*) FILTER (WHERE ("eligibility_status" = 'error'::"public"."eligibility_status")) AS "errors"
   FROM "public"."eligibility_checks"
  WHERE ("archived_at" IS NULL)
  GROUP BY "organization_id";


ALTER VIEW "public"."kpi_eligibility_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_postings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "payment_import_item_id" "uuid",
    "posting_status" "public"."payment_posting_status" DEFAULT 'pending'::"public"."payment_posting_status" NOT NULL,
    "posted_at" timestamp with time zone,
    "reversed_at" timestamp with time zone,
    "posting_reference" "text" NOT NULL,
    "total_posted_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."payment_postings" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."kpi_payment_summary" WITH ("security_invoker"='true') AS
 SELECT "organization_id",
    "count"(*) AS "total_postings",
    COALESCE("sum"("total_posted_amount"), (0)::numeric) AS "total_posted_amount",
    "count"(*) FILTER (WHERE ("posting_status" = 'pending'::"public"."payment_posting_status")) AS "pending_postings",
    "count"(*) FILTER (WHERE ("posting_status" = 'posted'::"public"."payment_posting_status")) AS "posted_payments"
   FROM "public"."payment_postings"
  WHERE ("archived_at" IS NULL)
  GROUP BY "organization_id";


ALTER VIEW "public"."kpi_payment_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workqueue_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "source_object_type" "public"."source_object_type" NOT NULL,
    "source_object_id" "uuid" NOT NULL,
    "client_id" "uuid",
    "encounter_id" "uuid",
    "claim_id" "uuid",
    "priority" "public"."workqueue_priority" DEFAULT 'normal'::"public"."workqueue_priority" NOT NULL,
    "status" "public"."workqueue_status" DEFAULT 'open'::"public"."workqueue_status" NOT NULL,
    "work_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "assigned_to_user_id" "uuid",
    "due_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "closed_at" timestamp with time zone,
    "context_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    "deferred_until" timestamp with time zone,
    "defer_reason" "text",
    "resolved_by_user_id" "uuid",
    "closed_by_user_id" "uuid",
    "professional_claim_id" "uuid",
    "billing_alert_id" "uuid",
    "ticket_id" "uuid",
    CONSTRAINT "workqueue_items_has_source" CHECK ((("source_object_id" IS NOT NULL) AND ("source_object_type" IS NOT NULL))),
    CONSTRAINT "workqueue_items_priority_chk" CHECK ((("priority" IS NULL) OR ("priority" = ANY (ARRAY['low'::"public"."workqueue_priority", 'normal'::"public"."workqueue_priority", 'high'::"public"."workqueue_priority", 'urgent'::"public"."workqueue_priority"]))))
);


ALTER TABLE "public"."workqueue_items" OWNER TO "postgres";


COMMENT ON COLUMN "public"."workqueue_items"."work_type" IS 'References workqueue_type_catalog.work_type. Valid values: no_response, aging_0_30, aging_31_60, aging_61_90, aging_91_120, aging_120_plus, denied, clearinghouse_rejection, payer_rejection, eligibility_issue, eligibility_needed, era_mismatch, appeal_needed, recoupment, ready_to_bill, biller_review.';



COMMENT ON COLUMN "public"."workqueue_items"."professional_claim_id" IS 'FK to professional_claims.id. Set by billing-flow services (aging, ERA, rejection). Distinct from legacy claim_id which references public.claims (workflow engine).';



CREATE OR REPLACE VIEW "public"."kpi_workqueue_summary" WITH ("security_invoker"='true') AS
 SELECT "organization_id",
    "work_type",
    "status",
    "count"(*) AS "item_count"
   FROM "public"."workqueue_items"
  WHERE ("archived_at" IS NULL)
  GROUP BY "organization_id", "work_type", "status";


ALTER VIEW "public"."kpi_workqueue_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mailroom_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "uploaded_by_user_id" "uuid",
    "client_id" "uuid",
    "workqueue_item_id" "uuid",
    "document_scope" "text" DEFAULT 'unfiled'::"text" NOT NULL,
    "document_type" "text",
    "source" "text" DEFAULT 'mail'::"text" NOT NULL,
    "file_name" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "mime_type" "text",
    "notes" "text",
    "admin_comments" "text",
    "status" "text" DEFAULT 'needs_review'::"text" NOT NULL,
    "filed_client_id" "uuid",
    "filed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    "routed_to_workqueue_id" "uuid",
    "routed_at" timestamp with time zone,
    "routed_by_user_id" "uuid",
    "ticket_id" "uuid",
    "mail_status" "text" DEFAULT 'unsorted'::"text" NOT NULL
);


ALTER TABLE "public"."mailroom_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "recipient_role" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "delivery_channels" "jsonb" DEFAULT '["in_app"]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notification_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."operational_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "patient_id" "uuid",
    "provider_id" "uuid",
    "appointment_id" "uuid",
    "claim_id" "uuid",
    "ticket_id" "uuid",
    "alert_type" "text" NOT NULL,
    "severity" "text" DEFAULT 'medium'::"text" NOT NULL,
    "title" "text" NOT NULL,
    "message" "text",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "due_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "operational_alerts_alert_type_check" CHECK (("alert_type" = ANY (ARRAY['missing_note'::"text", 'unsigned_note'::"text", 'eligibility_not_checked'::"text", 'inactive_coverage'::"text", 'claim_denied'::"text", 'claim_rejected'::"text", 'claim_no_response'::"text", 'patient_balance_due'::"text", 'failed_payment'::"text", 'credentialing_due'::"text", 'clearinghouse_error'::"text"])))
);


ALTER TABLE "public"."operational_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organization_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role_code" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ended_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."organization_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "legal_name" "text",
    "tax_id_last4" "text",
    "timezone" "text" DEFAULT 'America/Denver'::"text" NOT NULL,
    "default_state" "text" DEFAULT 'CO'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."organizations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_balances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "total_billed" numeric(12,2) DEFAULT 0 NOT NULL,
    "total_insurance_paid" numeric(12,2) DEFAULT 0 NOT NULL,
    "total_contractual_adj" numeric(12,2) DEFAULT 0 NOT NULL,
    "total_patient_responsible" numeric(12,2) DEFAULT 0 NOT NULL,
    "total_patient_paid" numeric(12,2) DEFAULT 0 NOT NULL,
    "current_balance" numeric(12,2) DEFAULT 0 NOT NULL,
    "balance_0_30" numeric(12,2) DEFAULT 0 NOT NULL,
    "balance_31_60" numeric(12,2) DEFAULT 0 NOT NULL,
    "balance_61_90" numeric(12,2) DEFAULT 0 NOT NULL,
    "balance_91_120" numeric(12,2) DEFAULT 0 NOT NULL,
    "balance_120_plus" numeric(12,2) DEFAULT 0 NOT NULL,
    "last_payment_date" "date",
    "last_payment_amount" numeric(12,2),
    "last_statement_date" "date",
    "in_collections" boolean DEFAULT false NOT NULL,
    "notes" "text",
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."patient_balances" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_check_ins" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "appointment_id" "uuid",
    "encounter_id" "uuid",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "current_mood" "text",
    "current_stressors" "text",
    "safety_concerns" "text",
    "psychosocial_updates" "text",
    "selected_goal_ids" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "goal_updates" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "patient_statement" "text",
    "submitted_at" timestamp with time zone,
    "reviewed_at" timestamp with time zone,
    "reviewed_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "patient_check_ins_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'submitted'::"text", 'reviewed'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."patient_check_ins" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_checkin_goal_selections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "checkin_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "treatment_plan_goal_id" "uuid",
    "goal_label" "text" NOT NULL,
    "selected_for_visit" boolean DEFAULT false NOT NULL,
    "patient_update" "text",
    "requests_goal_update" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."patient_checkin_goal_selections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_checkins" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "appointment_id" "uuid",
    "encounter_id" "uuid",
    "checkin_type" "text" DEFAULT 'medicaid_telehealth'::"text" NOT NULL,
    "status" "text" DEFAULT 'started'::"text" NOT NULL,
    "mental_state_response" "text",
    "psychosocial_update_response" "text",
    "substance_use_update_response" "text",
    "risk_safety_response" "text",
    "patient_journal_response" "text",
    "subjective_import_text" "text",
    "h0031_signal" boolean DEFAULT false NOT NULL,
    "h0001_signal" boolean DEFAULT false NOT NULL,
    "h0032_signal" boolean DEFAULT false NOT NULL,
    "patient_acknowledged_record_notice" boolean DEFAULT false NOT NULL,
    "submitted_at" timestamp with time zone,
    "clinician_notified_at" timestamp with time zone,
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "patient_checkins_checkin_type_check" CHECK (("checkin_type" = ANY (ARRAY['medicaid_telehealth'::"text", 'general'::"text"]))),
    CONSTRAINT "patient_checkins_status_check" CHECK (("status" = ANY (ARRAY['started'::"text", 'submitted'::"text", 'reviewed'::"text", 'imported_to_note'::"text"])))
);


ALTER TABLE "public"."patient_checkins" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "contact_type" "text" DEFAULT 'emergency'::"text" NOT NULL,
    "relationship" "text",
    "first_name" "text" NOT NULL,
    "last_name" "text" NOT NULL,
    "phone" "text",
    "email" "text",
    "address_line1" "text",
    "address_city" "text",
    "address_state" "text",
    "address_zip" "text",
    "is_primary" boolean DEFAULT false NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "patient_contacts_contact_type_check" CHECK (("contact_type" = ANY (ARRAY['emergency'::"text", 'guarantor'::"text", 'guardian'::"text", 'authorized'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."patient_contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_diagnoses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "encounter_id" "uuid",
    "diagnosis_code" "text" NOT NULL,
    "diagnosis_description" "text",
    "code_system" "text" DEFAULT 'ICD-10-CM'::"text" NOT NULL,
    "onset_date" "date",
    "resolved_date" "date",
    "is_active" boolean DEFAULT true NOT NULL,
    "is_primary" boolean DEFAULT false NOT NULL,
    "present_on_claim" boolean DEFAULT true NOT NULL,
    "clinical_notes" "text",
    "created_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."patient_diagnoses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_import_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "import_source" "text" NOT NULL,
    "source_file_name" "text",
    "import_status" "text" DEFAULT 'uploaded'::"text" NOT NULL,
    "total_rows" integer DEFAULT 0 NOT NULL,
    "parsed_rows" integer DEFAULT 0 NOT NULL,
    "error_rows" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."patient_import_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_import_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "row_number" integer NOT NULL,
    "raw_payload" "jsonb" NOT NULL,
    "parsed_payload" "jsonb",
    "matched_client_id" "uuid",
    "import_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."patient_import_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_invoice_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "patient_invoice_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "payment_status" "text" DEFAULT 'posted'::"text" NOT NULL,
    "payment_method" "text" DEFAULT 'manual'::"text" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "external_payment_id" "text",
    "memo" "text",
    "paid_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "patient_invoice_payments_amount_check" CHECK (("amount" >= (0)::numeric)),
    CONSTRAINT "patient_invoice_payments_payment_method_check" CHECK (("payment_method" = ANY (ARRAY['manual'::"text", 'cash'::"text", 'check'::"text", 'card'::"text", 'stripe'::"text", 'portal'::"text", 'other'::"text"]))),
    CONSTRAINT "patient_invoice_payments_payment_status_check" CHECK (("payment_status" = ANY (ARRAY['pending'::"text", 'posted'::"text", 'failed'::"text", 'voided'::"text", 'refunded'::"text"])))
);


ALTER TABLE "public"."patient_invoice_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "professional_claim_id" "uuid",
    "era_claim_payment_id" "uuid",
    "invoice_status" "text" DEFAULT 'open'::"text" NOT NULL,
    "invoice_number" "text" NOT NULL,
    "patient_responsibility_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "paid_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "balance_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "source" "text" DEFAULT 'era_pr'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "patient_invoices_invoice_status_check" CHECK (("invoice_status" = ANY (ARRAY['draft'::"text", 'open'::"text", 'sent'::"text", 'paid'::"text", 'voided'::"text", 'collections'::"text"])))
);


ALTER TABLE "public"."patient_invoices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payer_configurations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid",
    "payer_id" "text" NOT NULL,
    "payer_name" "text" NOT NULL,
    "payer_aliases" "jsonb" DEFAULT '[]'::"jsonb",
    "supported_transactions" "jsonb" DEFAULT '[]'::"jsonb",
    "states" "jsonb" DEFAULT '[]'::"jsonb",
    "source" "text" DEFAULT 'availity'::"text" NOT NULL,
    "environment" "text" DEFAULT 'demo'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payer_id_required" CHECK (("payer_id" <> ''::"text")),
    CONSTRAINT "valid_environment" CHECK (("environment" = ANY (ARRAY['demo'::"text", 'production'::"text", 'sandbox'::"text", 'test'::"text"]))),
    CONSTRAINT "valid_source" CHECK (("source" = ANY (ARRAY['availity'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."payer_configurations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payer_contracts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "payer_profile_id" "uuid",
    "contract_name" "text" NOT NULL,
    "contract_type" "text" DEFAULT 'fee_for_service'::"text" NOT NULL,
    "effective_date" "date",
    "expiration_date" "date",
    "timely_filing_days" integer DEFAULT 365 NOT NULL,
    "appeal_deadline_days" integer DEFAULT 60 NOT NULL,
    "resubmission_limit" integer DEFAULT 1 NOT NULL,
    "notes" "text",
    "contract_document_id" "uuid",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "payer_contracts_contract_type_check" CHECK (("contract_type" = ANY (ARRAY['fee_for_service'::"text", 'capitation'::"text", 'bundled'::"text", 'value_based'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."payer_contracts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payer_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "payer_profile_id" "uuid",
    "insurance_payer_id" "uuid",
    "plan_name" "text" NOT NULL,
    "plan_code" "text",
    "plan_type" "text",
    "electronic_payer_id" "text",
    "timely_filing_days" integer DEFAULT 365 NOT NULL,
    "requires_auth" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "payer_plans_plan_type_check" CHECK (("plan_type" = ANY (ARRAY['hmo'::"text", 'ppo'::"text", 'pos'::"text", 'epo'::"text", 'medicaid'::"text", 'medicare'::"text", 'tricare'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."payer_plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payer_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "payer_name" "text" NOT NULL,
    "office_ally_payer_id" "text" NOT NULL,
    "payer_type" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payer_profiles_payer_type_check" CHECK (("payer_type" = ANY (ARRAY['medicaid'::"text", 'medicare'::"text", 'commercial'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."payer_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_import_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "import_source" "text" NOT NULL,
    "payment_import_status" "public"."payment_import_status" DEFAULT 'imported'::"public"."payment_import_status" NOT NULL,
    "source_file_name" "text",
    "source_file_hash" "text",
    "imported_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "total_item_count" integer DEFAULT 0 NOT NULL,
    "total_amount" numeric(14,2) DEFAULT 0 NOT NULL,
    "parse_errors_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."payment_import_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_import_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "payment_import_status" "public"."payment_import_status" DEFAULT 'imported'::"public"."payment_import_status" NOT NULL,
    "imported_item_ref" "text",
    "payment_date" "date",
    "payer_id" "uuid",
    "claim_id" "uuid",
    "client_id" "uuid",
    "service_line_ref" "text",
    "gross_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "adjustment_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "net_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "unapplied_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "posting_ready" boolean DEFAULT false NOT NULL,
    "raw_item_payload" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    "storage_bucket" "text",
    "storage_path" "text",
    "original_file_name" "text",
    "file_hash" "text",
    "raw_edi" "text",
    "parsed_payload" "jsonb",
    "parse_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "parse_error" "text",
    "parsed_at" timestamp with time zone,
    "match_status" "text" DEFAULT 'unmatched'::"text" NOT NULL,
    "match_reason" "text",
    "matched_at" timestamp with time zone,
    CONSTRAINT "payment_import_items_match_status_check" CHECK (("match_status" = ANY (ARRAY['matched'::"text", 'unmatched'::"text", 'manual_matched'::"text", 'ignored'::"text"])))
);


ALTER TABLE "public"."payment_import_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_posting_allocations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "payment_posting_id" "uuid" NOT NULL,
    "claim_id" "uuid",
    "claim_service_line_id" "uuid",
    "encounter_id" "uuid",
    "client_id" "uuid",
    "allocation_type" "text" NOT NULL,
    "allocated_amount" numeric(12,2) NOT NULL,
    "allocation_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone,
    CONSTRAINT "payment_posting_allocations_allocated_amount_check" CHECK (("allocated_amount" <> (0)::numeric)),
    CONSTRAINT "payment_posting_allocations_allocation_type_check" CHECK (("allocation_type" = ANY (ARRAY['insurance_payment'::"text", 'patient_payment'::"text", 'adjustment'::"text", 'writeoff'::"text"]))),
    CONSTRAINT "payment_posting_allocations_check" CHECK ((((((("claim_id" IS NOT NULL))::integer + (("claim_service_line_id" IS NOT NULL))::integer) + (("encounter_id" IS NOT NULL))::integer) + (("client_id" IS NOT NULL))::integer) >= 1))
);


ALTER TABLE "public"."payment_posting_allocations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."professional_claim_service_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "claim_id" "uuid" NOT NULL,
    "line_number" integer NOT NULL,
    "service_date_from" "date" NOT NULL,
    "service_date_to" "date",
    "procedure_code" "text" NOT NULL,
    "modifiers" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "charge_amount" numeric(12,2) NOT NULL,
    "units" numeric(10,2) DEFAULT 1 NOT NULL,
    "diagnosis_pointers" "text"[] DEFAULT '{1}'::"text"[] NOT NULL,
    "place_of_service" "text",
    "rendering_provider_npi" "text",
    "authorization_number" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."professional_claim_service_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."professional_claims" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "patient_id" "uuid",
    "appointment_id" "uuid",
    "payer_profile_id" "uuid",
    "claim_number" "text",
    "patient_account_number" "text",
    "claim_status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "total_charge" numeric(12,2) DEFAULT 0 NOT NULL,
    "place_of_service" "text",
    "diagnosis_codes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "prior_authorization_number" "text",
    "accept_assignment" boolean DEFAULT true,
    "benefits_assignment" boolean DEFAULT true,
    "release_of_information" boolean DEFAULT true,
    "signature_on_file" boolean DEFAULT true,
    "validation_errors" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "last_validated_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "encounter_id" "uuid",
    "submitted_at" timestamp with time zone,
    "first_billed_date" "date",
    "last_billed_date" "date",
    "appeal_deadline_date" "date",
    "appeal_submitted_at" timestamp with time zone,
    "denial_reason_code" "text",
    "denial_reason_description" "text",
    "days_in_ar" integer,
    "billing_notes" "text",
    CONSTRAINT "professional_claims_claim_status_check" CHECK (("claim_status" = ANY (ARRAY['draft'::"text", 'ready_for_validation'::"text", 'validation_failed'::"text", 'ready_for_batch'::"text", 'batched'::"text", 'submitted'::"text", 'accepted_oa'::"text", 'rejected_oa'::"text", 'accepted_payer'::"text", 'rejected_payer'::"text", 'paid'::"text", 'denied'::"text", 'voided'::"text"])))
);


ALTER TABLE "public"."professional_claims" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "phone" "text",
    "credentials" "text",
    "role" "text" DEFAULT 'clinician'::"text" NOT NULL,
    "organization_id" "uuid",
    "is_active" boolean DEFAULT true NOT NULL,
    "subscription_status" "text" DEFAULT 'inactive'::"text",
    "notification_email" boolean DEFAULT true NOT NULL,
    "notification_sms" boolean DEFAULT false NOT NULL,
    "last_login" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'clinician'::"text", 'biller'::"text", 'supervisor'::"text"]))),
    CONSTRAINT "profiles_subscription_status_check" CHECK (("subscription_status" = ANY (ARRAY['active'::"text", 'inactive'::"text", 'trial'::"text", 'past_due'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_credentialing_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "provider_name" "text" NOT NULL,
    "credential_display" "text",
    "individual_npi" "text",
    "ssn" "text",
    "email" "text",
    "practice_name" "text",
    "practice_address" "text",
    "practice_tax_id" "text",
    "group_npi" "text",
    "group_medicaid_id" "text",
    "date_of_birth" "date",
    "phone" "text",
    "taxonomy_code" "text",
    "individual_medicaid_id" "text",
    "medicare_ptan" "text",
    "caqh_id" "text",
    "other_payer_id" "text",
    "primary_license_number" "text",
    "primary_license_effective_date" "date",
    "payer_effective_date" "date",
    "payer_revalidation_date" "date",
    "secondary_license_number" "text",
    "secondary_license_effective_date" "date",
    "source" "text" DEFAULT 'manual_seed'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."provider_credentialing_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_locations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "location_name" "text" NOT NULL,
    "office_number" "text",
    "place_of_service_code" "text",
    "address_line_1" "text",
    "address_line_2" "text",
    "city" "text",
    "state" "text",
    "postal_code" "text",
    "phone" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."provider_locations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_payer_enrollments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "provider_profile_id" "uuid" NOT NULL,
    "payer_profile_id" "uuid",
    "enrollment_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "enrollment_type" "text" DEFAULT 'in_network'::"text" NOT NULL,
    "provider_payer_id" "text",
    "effective_date" "date",
    "expiration_date" "date",
    "submitted_date" "date",
    "approved_date" "date",
    "notes" "text",
    "credentialing_profile_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "provider_payer_enrollments_enrollment_status_check" CHECK (("enrollment_status" = ANY (ARRAY['pending'::"text", 'submitted'::"text", 'approved'::"text", 'rejected'::"text", 'revalidation_due'::"text", 'terminated'::"text", 'inactive'::"text"]))),
    CONSTRAINT "provider_payer_enrollments_enrollment_type_check" CHECK (("enrollment_type" = ANY (ARRAY['in_network'::"text", 'out_of_network'::"text", 'medicaid'::"text", 'medicare'::"text", 'tricare'::"text"])))
);


ALTER TABLE "public"."provider_payer_enrollments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "staff_id" "uuid",
    "provider_npi" "text",
    "provider_type" "text",
    "specialty" "text",
    "credentials" "text",
    "license_number" "text",
    "license_state" "text",
    "license_expiration_date" "date",
    "board_certifications" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "malpractice_insurance_carrier" "text",
    "malpractice_tail_coverage" boolean DEFAULT false NOT NULL,
    "is_rendering_provider" boolean DEFAULT true NOT NULL,
    "is_billing_provider" boolean DEFAULT false NOT NULL,
    "is_referring_provider" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."provider_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."providers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "first_name" "text" NOT NULL,
    "last_name" "text" NOT NULL,
    "display_name" "text",
    "email" "text",
    "phone" "text",
    "credential" "text",
    "npi" "text",
    "taxonomy_code" "text",
    "medicaid_id" "text",
    "provider_type" "text" DEFAULT 'clinician'::"text" NOT NULL,
    "can_bill_independently" boolean DEFAULT true NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."providers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."service_locations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "location_type" "text" DEFAULT 'office'::"text" NOT NULL,
    "place_of_service_code" "text" DEFAULT '11'::"text" NOT NULL,
    "npi" "text",
    "address_line1" "text",
    "address_city" "text",
    "address_state" "text",
    "address_zip" "text",
    "phone" "text",
    "fax" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "service_locations_location_type_check" CHECK (("location_type" = ANY (ARRAY['office'::"text", 'telehealth'::"text", 'home'::"text", 'hospital'::"text", 'school'::"text", 'community'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."service_locations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."smart_phrases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "created_by_user_id" "uuid",
    "phrase_key" "text" NOT NULL,
    "phrase_label" "text" NOT NULL,
    "phrase_body" "text" NOT NULL,
    "placeholder_count" integer DEFAULT 0 NOT NULL,
    "category" "text" DEFAULT 'general'::"text" NOT NULL,
    "is_shared" boolean DEFAULT true NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "smart_phrases_category_check" CHECK (("category" = ANY (ARRAY['general'::"text", 'subjective'::"text", 'objective'::"text", 'assessment'::"text", 'plan'::"text", 'comment'::"text", 'claim'::"text"])))
);


ALTER TABLE "public"."smart_phrases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."support_ticket_comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "support_ticket_id" "uuid" NOT NULL,
    "author_user_id" "uuid",
    "comment_body" "text" NOT NULL,
    "is_internal" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."support_ticket_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."support_tickets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "workqueue_item_id" "uuid",
    "source_object_type" "public"."source_object_type",
    "source_object_id" "uuid",
    "requestor_user_id" "uuid",
    "assigned_to_user_id" "uuid",
    "status" "public"."support_ticket_status" DEFAULT 'open'::"public"."support_ticket_status" NOT NULL,
    "category" "text" NOT NULL,
    "priority" "public"."workqueue_priority" DEFAULT 'normal'::"public"."workqueue_priority" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "due_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "closed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."support_tickets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."system_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "setting_key" "text" NOT NULL,
    "setting_value" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."system_settings" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."system_readiness_checks" WITH ("security_invoker"='true') AS
 WITH "org" AS (
         SELECT "organizations"."id",
            "organizations"."name",
            "organizations"."slug",
            "organizations"."legal_name",
            "organizations"."tax_id_last4",
            "organizations"."timezone",
            "organizations"."default_state",
            "organizations"."is_active"
           FROM "public"."organizations"
          ORDER BY "organizations"."created_at"
         LIMIT 1
        ), "counts" AS (
         SELECT ( SELECT "count"(*) AS "count"
                   FROM "public"."organizations") AS "organizations_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."profiles") AS "profiles_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."organization_members") AS "organization_members_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."providers"
                  WHERE (COALESCE("providers"."is_active", true) = true)) AS "active_providers_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."provider_profiles") AS "provider_profiles_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."provider_credentialing_profiles"
                  WHERE (COALESCE("provider_credentialing_profiles"."is_active", true) = true)) AS "active_credentialing_profiles_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."provider_payer_enrollments"
                  WHERE ("provider_payer_enrollments"."archived_at" IS NULL)) AS "provider_payer_enrollments_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."service_locations"
                  WHERE ((COALESCE("service_locations"."is_active", true) = true) AND ("service_locations"."archived_at" IS NULL))) AS "active_service_locations_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."provider_locations"
                  WHERE ((COALESCE("provider_locations"."is_active", true) = true) AND ("provider_locations"."archived_at" IS NULL))) AS "active_provider_locations_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."clearinghouse_connections"
                  WHERE (COALESCE("clearinghouse_connections"."is_active", true) = true)) AS "active_clearinghouse_connections_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."payer_profiles"
                  WHERE (COALESCE("payer_profiles"."is_active", true) = true)) AS "active_payer_profiles_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."insurance_payers"
                  WHERE ("insurance_payers"."archived_at" IS NULL)) AS "insurance_payers_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."payer_configurations"
                  WHERE (COALESCE("payer_configurations"."is_active", true) = true)) AS "active_payer_configurations_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."system_settings") AS "system_settings_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."fee_schedules"
                  WHERE ("fee_schedules"."archived_at" IS NULL)) AS "fee_schedules_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."payer_contracts"
                  WHERE ("payer_contracts"."archived_at" IS NULL)) AS "payer_contracts_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."claims"
                  WHERE ("claims"."archived_at" IS NULL)) AS "claims_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."professional_claims") AS "professional_claims_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."encounter_notes"
                  WHERE ("encounter_notes"."archived_at" IS NULL)) AS "encounter_notes_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."encounter_clinical_notes"
                  WHERE ("encounter_clinical_notes"."archived_at" IS NULL)) AS "encounter_clinical_notes_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."custom_client_note"
                  WHERE ("custom_client_note"."voided" IS FALSE)) AS "custom_client_note_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."patient_checkins") AS "patient_checkins_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."patient_check_ins"
                  WHERE ("patient_check_ins"."archived_at" IS NULL)) AS "patient_check_ins_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."mailroom_items"
                  WHERE ("mailroom_items"."archived_at" IS NULL)) AS "mailroom_items_count",
            ( SELECT "count"(*) AS "count"
                   FROM "public"."workqueue_items"
                  WHERE ("workqueue_items"."archived_at" IS NULL)) AS "workqueue_items_count"
        ), "settings" AS (
         SELECT ( SELECT "system_settings"."setting_value"
                   FROM "public"."system_settings"
                  WHERE ("system_settings"."setting_key" = 'claims.defaults'::"text")
                 LIMIT 1) AS "claims_defaults",
            ( SELECT "system_settings"."setting_value"
                   FROM "public"."system_settings"
                  WHERE ("system_settings"."setting_key" = 'clearinghouse.defaults'::"text")
                 LIMIT 1) AS "clearinghouse_defaults",
            ( SELECT "system_settings"."setting_value"
                   FROM "public"."system_settings"
                  WHERE ("system_settings"."setting_key" = 'eligibility.defaults'::"text")
                 LIMIT 1) AS "eligibility_defaults",
            ( SELECT "system_settings"."setting_value"
                   FROM "public"."system_settings"
                  WHERE ("system_settings"."setting_key" = 'mailroom.defaults'::"text")
                 LIMIT 1) AS "mailroom_defaults",
            ( SELECT "system_settings"."setting_value"
                   FROM "public"."system_settings"
                  WHERE ("system_settings"."setting_key" = 'medicaid_telehealth_checkin.defaults'::"text")
                 LIMIT 1) AS "medicaid_checkin_defaults",
            ( SELECT "system_settings"."setting_value"
                   FROM "public"."system_settings"
                  WHERE ("system_settings"."setting_key" = 'security.defaults'::"text")
                 LIMIT 1) AS "security_defaults",
            ( SELECT "system_settings"."setting_value"
                   FROM "public"."system_settings"
                  WHERE ("system_settings"."setting_key" = 'telehealth.defaults'::"text")
                 LIMIT 1) AS "telehealth_defaults",
            ( SELECT "system_settings"."setting_value"
                   FROM "public"."system_settings"
                  WHERE ("system_settings"."setting_key" = 'vcc.defaults'::"text")
                 LIMIT 1) AS "vcc_defaults"
        ), "clearinghouse" AS (
         SELECT "clearinghouse_connections"."id",
            "clearinghouse_connections"."organization_id",
            "clearinghouse_connections"."vendor",
            "clearinghouse_connections"."connection_name",
            "clearinghouse_connections"."mode",
            "clearinghouse_connections"."submitter_id",
            "clearinghouse_connections"."receiver_id",
            "clearinghouse_connections"."api_base_url",
            "clearinghouse_connections"."auth_type",
            "clearinghouse_connections"."encrypted_credentials",
            "clearinghouse_connections"."is_active",
            "clearinghouse_connections"."created_at",
            "clearinghouse_connections"."updated_at",
            "clearinghouse_connections"."clearinghouse_name",
            "clearinghouse_connections"."sender_qualifier",
            "clearinghouse_connections"."receiver_qualifier",
            "clearinghouse_connections"."receiver_name",
            "clearinghouse_connections"."gs_receiver_code",
            "clearinghouse_connections"."x12_version",
            "clearinghouse_connections"."isa_usage_indicator",
            "clearinghouse_connections"."sftp_host",
            "clearinghouse_connections"."sftp_port",
            "clearinghouse_connections"."sftp_username",
            "clearinghouse_connections"."inbound_folder",
            "clearinghouse_connections"."outbound_folder",
            "clearinghouse_connections"."eligibility_service_type_code",
            "clearinghouse_connections"."eligibility_transaction_set"
           FROM "public"."clearinghouse_connections"
          WHERE (COALESCE("clearinghouse_connections"."is_active", true) = true)
          ORDER BY "clearinghouse_connections"."created_at" DESC
         LIMIT 1
        ), "provider_quality" AS (
         SELECT "count"(*) FILTER (WHERE (COALESCE("providers"."npi", ''::"text") <> ''::"text")) AS "providers_with_npi",
            "count"(*) FILTER (WHERE (COALESCE("providers"."taxonomy_code", ''::"text") <> ''::"text")) AS "providers_with_taxonomy",
            "count"(*) FILTER (WHERE (COALESCE("providers"."medicaid_id", ''::"text") <> ''::"text")) AS "providers_with_medicaid_id"
           FROM "public"."providers"
          WHERE (COALESCE("providers"."is_active", true) = true)
        ), "credential_quality" AS (
         SELECT "count"(*) FILTER (WHERE (COALESCE("provider_credentialing_profiles"."individual_npi", ''::"text") <> ''::"text")) AS "credentialing_with_individual_npi",
            "count"(*) FILTER (WHERE (COALESCE("provider_credentialing_profiles"."taxonomy_code", ''::"text") <> ''::"text")) AS "credentialing_with_taxonomy",
            "count"(*) FILTER (WHERE (COALESCE("provider_credentialing_profiles"."practice_tax_id", ''::"text") <> ''::"text")) AS "credentialing_with_tax_id",
            "count"(*) FILTER (WHERE (COALESCE("provider_credentialing_profiles"."group_npi", ''::"text") <> ''::"text")) AS "credentialing_with_group_npi",
            "count"(*) FILTER (WHERE (COALESCE("provider_credentialing_profiles"."individual_medicaid_id", ''::"text") <> ''::"text")) AS "credentialing_with_medicaid_id"
           FROM "public"."provider_credentialing_profiles"
          WHERE ((COALESCE("provider_credentialing_profiles"."is_active", true) = true) AND ("provider_credentialing_profiles"."archived_at" IS NULL))
        ), "rls_disabled" AS (
         SELECT "jsonb_agg"("t"."table_name" ORDER BY "t"."table_name") AS "tables"
           FROM (("information_schema"."tables" "t"
             JOIN "pg_class" "c" ON (("c"."relname" = ("t"."table_name")::"name")))
             JOIN "pg_namespace" "n" ON ((("n"."oid" = "c"."relnamespace") AND ("n"."nspname" = ("t"."table_schema")::"name"))))
          WHERE ((("t"."table_schema")::"name" = 'public'::"name") AND (("t"."table_type")::"text" = 'BASE TABLE'::"text") AND ("c"."relrowsecurity" = false) AND (("t"."table_name")::"name" = ANY (ARRAY['insurance_subscribers'::"name", 'insurance_policies'::"name", 'payment_posting_allocations'::"name", 'workqueue_items'::"name", 'support_tickets'::"name", 'support_ticket_comments'::"name"])))
        ), "base" AS (
         SELECT 10 AS "sort_order",
            'organization'::"text" AS "category",
            'organization_exists'::"text" AS "check_key",
                CASE
                    WHEN ("counts"."organizations_count" > 0) THEN 'pass'::"text"
                    ELSE 'fail'::"text"
                END AS "status",
            'Organization record exists'::"text" AS "title",
                CASE
                    WHEN ("counts"."organizations_count" > 0) THEN 'At least one organization record exists.'::"text"
                    ELSE 'No organization record exists.'::"text"
                END AS "detail",
            "jsonb_build_object"('count', "counts"."organizations_count", 'organization', "to_jsonb"("org".*)) AS "metadata"
           FROM ("counts"
             LEFT JOIN "org" ON (true))
        UNION ALL
         SELECT 20,
            'organization'::"text",
            'organization_billing_profile_incomplete'::"text",
                CASE
                    WHEN (("org"."legal_name" IS NOT NULL) AND ("org"."tax_id_last4" IS NOT NULL) AND ("org"."timezone" IS NOT NULL) AND ("org"."default_state" IS NOT NULL)) THEN 'warning'::"text"
                    ELSE 'fail'::"text"
                END AS "case",
            'Organization billing profile needs production fields'::"text",
            'Organization has basic fields, but production claim generation still needs full billing NPI, full tax ID, billing address, phone, and default POS stored through Settings.'::"text",
            "jsonb_build_object"('legal_name', "org"."legal_name", 'tax_id_last4_present', ("org"."tax_id_last4" IS NOT NULL), 'timezone', "org"."timezone", 'default_state', "org"."default_state") AS "jsonb_build_object"
           FROM ("counts"
             LEFT JOIN "org" ON (true))
        UNION ALL
         SELECT 30,
            'staff_security'::"text",
            'profiles_exist'::"text",
                CASE
                    WHEN ("counts"."profiles_count" > 0) THEN 'pass'::"text"
                    ELSE 'fail'::"text"
                END AS "case",
            'At least one user profile exists'::"text",
                CASE
                    WHEN ("counts"."profiles_count" > 0) THEN 'User profile records exist.'::"text"
                    ELSE 'No user profiles exist.'::"text"
                END AS "case",
            "jsonb_build_object"('count', "counts"."profiles_count") AS "jsonb_build_object"
           FROM "counts"
        UNION ALL
         SELECT 40,
            'staff_security'::"text",
            'organization_members_missing'::"text",
                CASE
                    WHEN ("counts"."organization_members_count" > 0) THEN 'pass'::"text"
                    ELSE 'fail'::"text"
                END AS "case",
            'Organization membership records exist'::"text",
                CASE
                    WHEN ("counts"."organization_members_count" > 0) THEN 'Organization membership records exist.'::"text"
                    ELSE 'organization_members is empty. Role/context logic may fail if the app expects membership rows.'::"text"
                END AS "case",
            "jsonb_build_object"('count', "counts"."organization_members_count") AS "jsonb_build_object"
           FROM "counts"
        UNION ALL
         SELECT 50,
            'providers'::"text",
            'active_provider_exists'::"text",
                CASE
                    WHEN ("counts"."active_providers_count" > 0) THEN 'pass'::"text"
                    ELSE 'fail'::"text"
                END AS "case",
            'At least one active provider exists'::"text",
                CASE
                    WHEN ("counts"."active_providers_count" > 0) THEN 'Active provider record exists.'::"text"
                    ELSE 'No active provider record exists.'::"text"
                END AS "case",
            "jsonb_build_object"('count', "counts"."active_providers_count") AS "jsonb_build_object"
           FROM "counts"
        UNION ALL
         SELECT 60,
            'providers'::"text",
            'provider_profile_missing'::"text",
                CASE
                    WHEN ("counts"."provider_profiles_count" > 0) THEN 'pass'::"text"
                    ELSE 'warning'::"text"
                END AS "case",
            'Provider profile records exist'::"text",
                CASE
                    WHEN ("counts"."provider_profiles_count" > 0) THEN 'Provider profile records exist.'::"text"
                    ELSE 'provider_profiles is empty while providers/provider_credentialing_profiles have data. Provider settings should reconcile these records.'::"text"
                END AS "case",
            "jsonb_build_object"('provider_profiles_count', "counts"."provider_profiles_count", 'providers_count', "counts"."active_providers_count", 'credentialing_profiles_count', "counts"."active_credentialing_profiles_count") AS "jsonb_build_object"
           FROM "counts"
        UNION ALL
         SELECT 70,
            'providers'::"text",
            'provider_claim_identifiers'::"text",
                CASE
                    WHEN (("provider_quality"."providers_with_npi" > 0) AND ("provider_quality"."providers_with_taxonomy" > 0)) THEN 'pass'::"text"
                    ELSE 'warning'::"text"
                END AS "case",
            'Provider NPI and taxonomy present'::"text",
            'At least one active provider should have NPI and taxonomy for claims.'::"text",
            "to_jsonb"("provider_quality".*) AS "to_jsonb"
           FROM "provider_quality"
        UNION ALL
         SELECT 80,
            'providers'::"text",
            'credentialing_profiles_present'::"text",
                CASE
                    WHEN ("counts"."active_credentialing_profiles_count" > 0) THEN 'pass'::"text"
                    ELSE 'warning'::"text"
                END AS "case",
            'Credentialing profiles exist'::"text",
                CASE
                    WHEN ("counts"."active_credentialing_profiles_count" > 0) THEN 'Provider credentialing profiles exist.'::"text"
                    ELSE 'No provider credentialing profiles exist.'::"text"
                END AS "case",
            "jsonb_build_object"('count', "counts"."active_credentialing_profiles_count") AS "jsonb_build_object"
           FROM "counts"
        UNION ALL
         SELECT 90,
            'providers'::"text",
            'provider_payer_enrollments_missing'::"text",
                CASE
                    WHEN ("counts"."provider_payer_enrollments_count" > 0) THEN 'pass'::"text"
                    ELSE 'warning'::"text"
                END AS "case",
            'Provider payer enrollments exist'::"text",
                CASE
                    WHEN ("counts"."provider_payer_enrollments_count" > 0) THEN 'Provider payer enrollment records exist.'::"text"
                    ELSE 'provider_payer_enrollments is empty. Credentialing/enrollment status cannot drive billing warnings yet.'::"text"
                END AS "case",
            "jsonb_build_object"('count', "counts"."provider_payer_enrollments_count") AS "jsonb_build_object"
           FROM "counts"
        UNION ALL
         SELECT 100,
            'locations'::"text",
            'service_locations_missing'::"text",
                CASE
                    WHEN ("counts"."active_service_locations_count" > 0) THEN 'pass'::"text"
                    ELSE 'fail'::"text"
                END AS "case",
            'Service locations exist'::"text",
                CASE
                    WHEN ("counts"."active_service_locations_count" > 0) THEN 'At least one service location exists.'::"text"
                    ELSE 'No service_locations exist. Appointment location, POS, and service facility defaults are incomplete.'::"text"
                END AS "case",
            "jsonb_build_object"('service_locations_count', "counts"."active_service_locations_count", 'provider_locations_count', "counts"."active_provider_locations_count") AS "jsonb_build_object"
           FROM "counts"
        UNION ALL
         SELECT 110,
            'clearinghouse'::"text",
            'clearinghouse_connection_missing'::"text",
                CASE
                    WHEN ("counts"."active_clearinghouse_connections_count" > 0) THEN 'pass'::"text"
                    ELSE 'fail'::"text"
                END AS "case",
            'Active clearinghouse connection exists'::"text",
                CASE
                    WHEN ("counts"."active_clearinghouse_connections_count" > 0) THEN 'An active clearinghouse connection exists.'::"text"
                    ELSE 'No active clearinghouse_connections record exists. Office Ally cannot function live.'::"text"
                END AS "case",
            "jsonb_build_object"('count', "counts"."active_clearinghouse_connections_count") AS "jsonb_build_object"
           FROM "counts"
        UNION ALL
         SELECT 120,
            'clearinghouse'::"text",
            'clearinghouse_submitter_id'::"text",
                CASE
                    WHEN (("clearinghouse"."submitter_id" IS NOT NULL) AND ("clearinghouse"."submitter_id" <> ''::"text")) THEN 'pass'::"text"
                    ELSE 'fail'::"text"
                END AS "case",
            'Clearinghouse submitter ID configured'::"text",
                CASE
                    WHEN (("clearinghouse"."submitter_id" IS NOT NULL) AND ("clearinghouse"."submitter_id" <> ''::"text")) THEN 'Submitter ID is present.'::"text"
                    ELSE 'Submitter ID is missing.'::"text"
                END AS "case",
            "jsonb_build_object"('connection_id', "clearinghouse"."id", 'vendor', "clearinghouse"."vendor", 'mode', "clearinghouse"."mode") AS "jsonb_build_object"
           FROM ("clearinghouse"
             RIGHT JOIN "counts" ON (true))
        UNION ALL
         SELECT 130,
            'clearinghouse'::"text",
            'clearinghouse_receiver_id'::"text",
                CASE
                    WHEN (("clearinghouse"."receiver_id" IS NOT NULL) AND ("clearinghouse"."receiver_id" <> ''::"text")) THEN 'pass'::"text"
                    ELSE 'fail'::"text"
                END AS "case",
            'Clearinghouse receiver ID configured'::"text",
                CASE
                    WHEN (("clearinghouse"."receiver_id" IS NOT NULL) AND ("clearinghouse"."receiver_id" <> ''::"text")) THEN 'Receiver ID is present.'::"text"
                    ELSE 'Receiver ID is missing.'::"text"
                END AS "case",
            "jsonb_build_object"('connection_id', "clearinghouse"."id", 'receiver_name', "clearinghouse"."receiver_name") AS "jsonb_build_object"
           FROM ("clearinghouse"
             RIGHT JOIN "counts" ON (true))
        UNION ALL
         SELECT 140,
            'eligibility'::"text",
            'eligibility_defaults_present'::"text",
                CASE
                    WHEN ("settings"."eligibility_defaults" IS NOT NULL) THEN 'pass'::"text"
                    ELSE 'fail'::"text"
                END AS "case",
            'Eligibility defaults exist'::"text",
                CASE
                    WHEN ("settings"."eligibility_defaults" IS NOT NULL) THEN 'Eligibility defaults exist in system_settings.'::"text"
                    ELSE 'eligibility.defaults missing from system_settings.'::"text"
                END AS "case",
            COALESCE("settings"."eligibility_defaults", '{}'::"jsonb") AS "coalesce"
           FROM "settings"
        UNION ALL
         SELECT 150,
            'eligibility'::"text",
            'eligibility_service_type_98'::"text",
                CASE
                    WHEN (("settings"."eligibility_defaults" ->> 'default_service_type'::"text") = '98'::"text") THEN 'pass'::"text"
                    ELSE 'warning'::"text"
                END AS "case",
            'Eligibility defaults to service type 98'::"text",
            'Eligibility should default to service type 98 for professional services.'::"text",
            COALESCE("settings"."eligibility_defaults", '{}'::"jsonb") AS "coalesce"
           FROM "settings"
        UNION ALL
         SELECT 160,
            'payers'::"text",
            'payer_profiles_exist'::"text",
                CASE
                    WHEN ("counts"."active_payer_profiles_count" > 0) THEN 'pass'::"text"
                    ELSE 'fail'::"text"
                END AS "case",
            'Active payer profiles exist'::"text",
                CASE
                    WHEN ("counts"."active_payer_profiles_count" > 0) THEN 'Active payer profile records exist.'::"text"
                    ELSE 'No active payer profile records exist.'::"text"
                END AS "case",
            "jsonb_build_object"('payer_profiles_count', "counts"."active_payer_profiles_count", 'insurance_payers_count', "counts"."insurance_payers_count", 'payer_configurations_count', "counts"."active_payer_configurations_count") AS "jsonb_build_object"
           FROM "counts"
        UNION ALL
         SELECT 170,
            'billing'::"text",
            'claims_defaults_present'::"text",
                CASE
                    WHEN ("settings"."claims_defaults" IS NOT NULL) THEN 'pass'::"text"
                    ELSE 'fail'::"text"
                END AS "case",
            'Claims defaults exist'::"text",
                CASE
                    WHEN ("settings"."claims_defaults" IS NOT NULL) THEN 'Claims defaults exist in system_settings.'::"text"
                    ELSE 'claims.defaults missing from system_settings.'::"text"
                END AS "case",
            COALESCE("settings"."claims_defaults", '{}'::"jsonb") AS "coalesce"
           FROM "settings"
        UNION ALL
         SELECT 180,
            'billing'::"text",
            'fee_schedules_missing'::"text",
                CASE
                    WHEN ("counts"."fee_schedules_count" > 0) THEN 'pass'::"text"
                    ELSE 'warning'::"text"
                END AS "case",
            'Fee schedules exist'::"text",
                CASE
                    WHEN ("counts"."fee_schedules_count" > 0) THEN 'Fee schedule records exist.'::"text"
                    ELSE 'fee_schedules is empty. Billing can still work with manual charge amounts, but reimbursement/rate logic is incomplete.'::"text"
                END AS "case",
            "jsonb_build_object"('fee_schedules_count', "counts"."fee_schedules_count", 'payer_contracts_count', "counts"."payer_contracts_count") AS "jsonb_build_object"
           FROM "counts"
        UNION ALL
         SELECT 190,
            'mailroom'::"text",
            'mailroom_defaults_present'::"text",
                CASE
                    WHEN ("settings"."mailroom_defaults" IS NOT NULL) THEN 'pass'::"text"
                    ELSE 'warning'::"text"
                END AS "case",
            'Mailroom defaults exist'::"text",
                CASE
                    WHEN ("settings"."mailroom_defaults" IS NOT NULL) THEN 'Mailroom defaults exist in system_settings.'::"text"
                    ELSE 'mailroom.defaults missing from system_settings.'::"text"
                END AS "case",
            COALESCE("settings"."mailroom_defaults", '{}'::"jsonb") AS "coalesce"
           FROM "settings"
        UNION ALL
         SELECT 200,
            'workflow_duplicates'::"text",
            'claims_duplicate_workflows'::"text",
                CASE
                    WHEN (("counts"."claims_count" > 0) AND ("counts"."professional_claims_count" > 0)) THEN 'warning'::"text"
                    ELSE 'pass'::"text"
                END AS "case",
            'Claims workflow duplication check'::"text",
                CASE
                    WHEN (("counts"."claims_count" > 0) AND ("counts"."professional_claims_count" > 0)) THEN 'Both claims and professional_claims contain rows. Choose a canonical claim workflow before further UI work.'::"text"
                    ELSE 'Only one claim workflow appears active.'::"text"
                END AS "case",
            "jsonb_build_object"('claims_count', "counts"."claims_count", 'professional_claims_count', "counts"."professional_claims_count") AS "jsonb_build_object"
           FROM "counts"
        UNION ALL
         SELECT 210,
            'workflow_duplicates'::"text",
            'note_duplicate_workflows'::"text",
                CASE
                    WHEN (((
                    CASE
                        WHEN ("counts"."encounter_notes_count" > 0) THEN 1
                        ELSE 0
                    END +
                    CASE
                        WHEN ("counts"."encounter_clinical_notes_count" > 0) THEN 1
                        ELSE 0
                    END) +
                    CASE
                        WHEN ("counts"."custom_client_note_count" > 0) THEN 1
                        ELSE 0
                    END) > 1) THEN 'warning'::"text"
                    ELSE 'pass'::"text"
                END AS "case",
            'Clinical note workflow duplication check'::"text",
            'Multiple note tables exist. Select canonical note storage for production workflows.'::"text",
            "jsonb_build_object"('encounter_notes_count', "counts"."encounter_notes_count", 'encounter_clinical_notes_count', "counts"."encounter_clinical_notes_count", 'custom_client_note_count', "counts"."custom_client_note_count") AS "jsonb_build_object"
           FROM "counts"
        UNION ALL
         SELECT 220,
            'workflow_duplicates'::"text",
            'checkin_duplicate_tables'::"text",
                CASE
                    WHEN (("counts"."patient_checkins_count" > 0) AND ("counts"."patient_check_ins_count" > 0)) THEN 'warning'::"text"
                    ELSE 'pass'::"text"
                END AS "case",
            'Patient check-in duplicate table check'::"text",
            'Both patient_checkins and patient_check_ins exist. Even if empty, the codebase should choose one canonical table.'::"text",
            "jsonb_build_object"('patient_checkins_count', "counts"."patient_checkins_count", 'patient_check_ins_count', "counts"."patient_check_ins_count") AS "jsonb_build_object"
           FROM "counts"
        UNION ALL
         SELECT 230,
            'security'::"text",
            'rls_disabled_critical_tables'::"text",
                CASE
                    WHEN (COALESCE("jsonb_array_length"("rls_disabled"."tables"), 0) = 0) THEN 'pass'::"text"
                    ELSE 'fail'::"text"
                END AS "case",
            'Critical public tables have RLS enabled'::"text",
                CASE
                    WHEN (COALESCE("jsonb_array_length"("rls_disabled"."tables"), 0) = 0) THEN 'Critical public tables have RLS enabled.'::"text"
                    ELSE 'Some critical public tables have RLS disabled. Do not blindly enable RLS without policies; fix with a security migration.'::"text"
                END AS "case",
            "jsonb_build_object"('tables', COALESCE("rls_disabled"."tables", '[]'::"jsonb")) AS "jsonb_build_object"
           FROM "rls_disabled"
        UNION ALL
         SELECT 240,
            'security'::"text",
            'security_defaults_present'::"text",
                CASE
                    WHEN ("settings"."security_defaults" IS NOT NULL) THEN 'pass'::"text"
                    ELSE 'warning'::"text"
                END AS "case",
            'Security defaults exist'::"text",
                CASE
                    WHEN ("settings"."security_defaults" IS NOT NULL) THEN 'Security defaults exist in system_settings.'::"text"
                    ELSE 'security.defaults missing from system_settings.'::"text"
                END AS "case",
            COALESCE("settings"."security_defaults", '{}'::"jsonb") AS "coalesce"
           FROM "settings"
        )
 SELECT "sort_order",
    "category",
    "check_key",
    "status",
    "title",
    "detail",
    "metadata"
   FROM "base";


ALTER VIEW "public"."system_readiness_checks" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."system_readiness_summary" WITH ("security_invoker"='true') AS
 SELECT "count"(*) AS "total_checks",
    "count"(*) FILTER (WHERE ("status" = 'pass'::"text")) AS "passing_checks",
    "count"(*) FILTER (WHERE ("status" = 'warning'::"text")) AS "warning_checks",
    "count"(*) FILTER (WHERE ("status" = 'fail'::"text")) AS "failing_checks",
        CASE
            WHEN ("count"(*) FILTER (WHERE ("status" = 'fail'::"text")) > 0) THEN 'not_ready'::"text"
            WHEN ("count"(*) FILTER (WHERE ("status" = 'warning'::"text")) > 0) THEN 'needs_review'::"text"
            ELSE 'ready'::"text"
        END AS "readiness_status",
    "now"() AS "checked_at"
   FROM "public"."system_readiness_checks";


ALTER VIEW "public"."system_readiness_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."telehealth_participants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "telehealth_session_id" "uuid" NOT NULL,
    "participant_type" "text" NOT NULL,
    "user_id" "uuid",
    "client_id" "uuid",
    "display_name" "text",
    "joined_at" timestamp with time zone,
    "left_at" timestamp with time zone,
    "connection_status" "text" DEFAULT 'not_joined'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "telehealth_participants_connection_status_check" CHECK (("connection_status" = ANY (ARRAY['not_joined'::"text", 'waiting'::"text", 'connected'::"text", 'disconnected'::"text"]))),
    CONSTRAINT "telehealth_participants_participant_type_check" CHECK (("participant_type" = ANY (ARRAY['client'::"text", 'provider'::"text", 'guardian'::"text", 'interpreter'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."telehealth_participants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."telehealth_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "appointment_id" "uuid",
    "encounter_id" "uuid",
    "client_id" "uuid",
    "provider_id" "uuid",
    "telehealth_vendor" "text" DEFAULT 'internal'::"text" NOT NULL,
    "session_status" "text" DEFAULT 'scheduled'::"text" NOT NULL,
    "meeting_url" "text",
    "host_url" "text",
    "waiting_room_enabled" boolean DEFAULT true NOT NULL,
    "scheduled_start_at" timestamp with time zone,
    "started_at" timestamp with time zone,
    "ended_at" timestamp with time zone,
    "client_joined_at" timestamp with time zone,
    "provider_joined_at" timestamp with time zone,
    "technical_issue_reported" boolean DEFAULT false NOT NULL,
    "technical_issue_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "telehealth_sessions_session_status_check" CHECK (("session_status" = ANY (ARRAY['scheduled'::"text", 'waiting_room'::"text", 'in_progress'::"text", 'completed'::"text", 'cancelled'::"text", 'failed'::"text"]))),
    CONSTRAINT "telehealth_sessions_telehealth_vendor_check" CHECK (("telehealth_vendor" = ANY (ARRAY['internal'::"text", 'zoom'::"text", 'doxy'::"text", 'google_meet'::"text", 'other'::"text"]))),
    CONSTRAINT "telehealth_valid_time_chk" CHECK ((("ended_at" IS NULL) OR ("started_at" IS NULL) OR ("ended_at" >= "started_at")))
);


ALTER TABLE "public"."telehealth_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ticket_comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "ticket_id" "uuid" NOT NULL,
    "comment_body" "text" NOT NULL,
    "smart_phrase_keys" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "comment_type" "text" DEFAULT 'note'::"text" NOT NULL,
    "is_internal" boolean DEFAULT true NOT NULL,
    "created_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "ticket_comments_comment_type_check" CHECK (("comment_type" = ANY (ARRAY['note'::"text", 'status_change'::"text", 'assignment'::"text", 'resolution'::"text", 'system'::"text"])))
);


ALTER TABLE "public"."ticket_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tickets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "client_id" "uuid",
    "claim_id" "uuid",
    "encounter_id" "uuid",
    "workqueue_item_id" "uuid",
    "billing_alert_id" "uuid",
    "ticket_number" "text" NOT NULL,
    "ticket_type" "text" DEFAULT 'billing'::"text" NOT NULL,
    "ticket_status" "text" DEFAULT 'open'::"text" NOT NULL,
    "priority" "text" DEFAULT 'normal'::"text" NOT NULL,
    "subject" "text" NOT NULL,
    "description" "text",
    "assigned_to_user_id" "uuid",
    "due_date" "date",
    "resolved_at" timestamp with time zone,
    "resolved_by_user_id" "uuid",
    "closed_at" timestamp with time zone,
    "closed_by_user_id" "uuid",
    "created_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "tickets_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'normal'::"text", 'high'::"text", 'urgent'::"text"]))),
    CONSTRAINT "tickets_ticket_status_check" CHECK (("ticket_status" = ANY (ARRAY['open'::"text", 'pending'::"text", 'waiting_on_clinician'::"text", 'waiting_on_payer'::"text", 'resolved'::"text", 'closed'::"text"]))),
    CONSTRAINT "tickets_ticket_type_check" CHECK (("ticket_type" = ANY (ARRAY['billing'::"text", 'eligibility'::"text", 'authorization'::"text", 'credentialing'::"text", 'appeal'::"text", 'patient_complaint'::"text", 'clinical'::"text", 'admin'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."tickets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."treatment_plan_goals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "treatment_plan_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "goal_number" integer DEFAULT 1 NOT NULL,
    "goal_description" "text" NOT NULL,
    "objectives" "text",
    "target_date" "date",
    "goal_status" "text" DEFAULT 'active'::"text" NOT NULL,
    "progress_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "treatment_plan_goals_goal_status_check" CHECK (("goal_status" = ANY (ARRAY['active'::"text", 'achieved'::"text", 'revised'::"text", 'discontinued'::"text"])))
);


ALTER TABLE "public"."treatment_plan_goals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."treatment_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "provider_id" "uuid",
    "plan_status" "text" DEFAULT 'active'::"text" NOT NULL,
    "start_date" "date",
    "end_date" "date",
    "next_review_date" "date",
    "presenting_problem" "text",
    "long_term_goals" "text",
    "frequency" "text",
    "duration_weeks" integer,
    "modality" "text",
    "signatures" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "treatment_plans_plan_status_check" CHECK (("plan_status" = ANY (ARRAY['draft'::"text", 'active'::"text", 'completed'::"text", 'discontinued'::"text", 'voided'::"text"])))
);


ALTER TABLE "public"."treatment_plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_presence" (
    "user_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'offline'::"text" NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "current_page" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_presence_status_check" CHECK (("status" = ANY (ARRAY['online'::"text", 'away'::"text", 'offline'::"text"])))
);


ALTER TABLE "public"."user_presence" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vcc_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "mailroom_item_id" "uuid",
    "payment_posting_id" "uuid",
    "payer_name" "text",
    "payer_id" "text",
    "card_last4" "text",
    "card_brand" "text",
    "expiration_month" integer,
    "expiration_year" integer,
    "authorization_code" "text",
    "reference_number" "text",
    "payment_amount" numeric(12,2) NOT NULL,
    "fee_amount" numeric(12,2),
    "service_date_start" "date",
    "service_date_end" "date",
    "client_id" "uuid",
    "claim_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "processed_at" timestamp with time zone,
    "processed_by_user_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "vcc_payments_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processed'::"text", 'failed'::"text", 'expired'::"text", 'voided'::"text"])))
);


ALTER TABLE "public"."vcc_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workqueue_item_comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "workqueue_item_id" "uuid" NOT NULL,
    "comment_body" "text" NOT NULL,
    "comment_type" "text" DEFAULT 'note'::"text" NOT NULL,
    "created_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "archived_at" timestamp with time zone,
    "smart_phrase_keys" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    CONSTRAINT "workqueue_item_comments_comment_type_check" CHECK (("comment_type" = ANY (ARRAY['note'::"text", 'status_change'::"text", 'assignment'::"text", 'defer'::"text", 'resolution'::"text"])))
);


ALTER TABLE "public"."workqueue_item_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workqueue_type_catalog" (
    "work_type" "text" NOT NULL,
    "label" "text" NOT NULL,
    "category" "text" NOT NULL,
    "aging_days_min" integer,
    "aging_days_max" integer,
    "sort_order" integer DEFAULT 99 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    CONSTRAINT "workqueue_type_catalog_category_check" CHECK (("category" = ANY (ARRAY['ar_aging'::"text", 'payer_response'::"text", 'eligibility'::"text", 'billing'::"text", 'era'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."workqueue_type_catalog" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."your_table" (
    "id" bigint NOT NULL
);


ALTER TABLE "public"."your_table" OWNER TO "postgres";


ALTER TABLE "public"."your_table" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."your_table_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_org_id_client_provider_key" UNIQUE ("organization_id", "id", "client_id", "provider_id");



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_org_id_id_unique" UNIQUE ("organization_id", "id");



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_organization_id_id_key" UNIQUE ("organization_id", "id");



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."authorization_or_referrals"
    ADD CONSTRAINT "authorization_or_referrals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."availity_transactions"
    ADD CONSTRAINT "availity_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billing_alerts"
    ADD CONSTRAINT "billing_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."charge_capture_items"
    ADD CONSTRAINT "charge_capture_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_conversations"
    ADD CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_participants"
    ADD CONSTRAINT "chat_participants_conversation_id_user_id_key" UNIQUE ("conversation_id", "user_id");



ALTER TABLE ONLY "public"."chat_participants"
    ADD CONSTRAINT "chat_participants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claim_837p_batch_claims"
    ADD CONSTRAINT "claim_837p_batch_claims_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claim_837p_batches"
    ADD CONSTRAINT "claim_837p_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claim_parties_snapshot"
    ADD CONSTRAINT "claim_parties_snapshot_claim_id_key" UNIQUE ("claim_id");



ALTER TABLE ONLY "public"."claim_parties_snapshot"
    ADD CONSTRAINT "claim_parties_snapshot_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claim_service_lines"
    ADD CONSTRAINT "claim_service_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claim_status_events"
    ADD CONSTRAINT "claim_status_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claim_status_inquiries"
    ADD CONSTRAINT "claim_status_inquiries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claim_submissions"
    ADD CONSTRAINT "claim_submissions_organization_id_claim_id_submission_seque_key" UNIQUE ("organization_id", "claim_id", "submission_sequence");



ALTER TABLE ONLY "public"."claim_submissions"
    ADD CONSTRAINT "claim_submissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claim_workqueue_items"
    ADD CONSTRAINT "claim_workqueue_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claims"
    ADD CONSTRAINT "claims_org_id_id_unique" UNIQUE ("organization_id", "id");



ALTER TABLE ONLY "public"."claims"
    ADD CONSTRAINT "claims_organization_id_claim_number_key" UNIQUE ("organization_id", "claim_number");



ALTER TABLE ONLY "public"."claims"
    ADD CONSTRAINT "claims_organization_id_duplicate_detection_key_key" UNIQUE ("organization_id", "duplicate_detection_key");



ALTER TABLE ONLY "public"."claims"
    ADD CONSTRAINT "claims_organization_id_encounter_id_key" UNIQUE ("organization_id", "encounter_id");



ALTER TABLE ONLY "public"."claims"
    ADD CONSTRAINT "claims_organization_id_id_key" UNIQUE ("organization_id", "id");



ALTER TABLE ONLY "public"."claims"
    ADD CONSTRAINT "claims_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clearinghouse_connections"
    ADD CONSTRAINT "clearinghouse_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clearinghouse_response_events"
    ADD CONSTRAINT "clearinghouse_response_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_contacts"
    ADD CONSTRAINT "client_contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_import_jobs"
    ADD CONSTRAINT "client_import_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_import_rows"
    ADD CONSTRAINT "client_import_rows_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_org_id_id_unique" UNIQUE ("organization_id", "id");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_organization_id_external_client_ref_key" UNIQUE ("organization_id", "external_client_ref");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_organization_id_mrn_key" UNIQUE ("organization_id", "mrn");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coding_suggestions"
    ADD CONSTRAINT "coding_suggestions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."custom_app_config"
    ADD CONSTRAINT "custom_app_config_config_key_key" UNIQUE ("config_key");



ALTER TABLE ONLY "public"."custom_app_config"
    ADD CONSTRAINT "custom_app_config_pkey" PRIMARY KEY ("config_id");



ALTER TABLE ONLY "public"."custom_appointment_request"
    ADD CONSTRAINT "custom_appointment_request_pkey" PRIMARY KEY ("appointment_request_id");



ALTER TABLE ONLY "public"."custom_audit_event"
    ADD CONSTRAINT "custom_audit_event_pkey" PRIMARY KEY ("audit_event_id");



ALTER TABLE ONLY "public"."custom_billing_service"
    ADD CONSTRAINT "custom_billing_service_pkey" PRIMARY KEY ("billing_service_id");



ALTER TABLE ONLY "public"."custom_billing_settings"
    ADD CONSTRAINT "custom_billing_settings_pkey" PRIMARY KEY ("billing_settings_id");



ALTER TABLE ONLY "public"."custom_billing_workqueue_comment"
    ADD CONSTRAINT "custom_billing_workqueue_comment_pkey" PRIMARY KEY ("comment_id");



ALTER TABLE ONLY "public"."custom_client_document"
    ADD CONSTRAINT "custom_client_document_pkey" PRIMARY KEY ("document_id");



ALTER TABLE ONLY "public"."custom_client_import_staging"
    ADD CONSTRAINT "custom_client_import_staging_pkey" PRIMARY KEY ("staging_id");



ALTER TABLE ONLY "public"."custom_client_note"
    ADD CONSTRAINT "custom_client_note_pkey" PRIMARY KEY ("client_note_id");



ALTER TABLE ONLY "public"."custom_client_profile"
    ADD CONSTRAINT "custom_client_profile_pkey" PRIMARY KEY ("profile_id");



ALTER TABLE ONLY "public"."custom_client_program"
    ADD CONSTRAINT "custom_client_program_pkey" PRIMARY KEY ("client_program_id");



ALTER TABLE ONLY "public"."custom_invoice_line_item"
    ADD CONSTRAINT "custom_invoice_line_item_pkey" PRIMARY KEY ("invoice_line_item_id");



ALTER TABLE ONLY "public"."custom_invoice"
    ADD CONSTRAINT "custom_invoice_pkey" PRIMARY KEY ("invoice_id");



ALTER TABLE ONLY "public"."custom_lookup_value"
    ADD CONSTRAINT "custom_lookup_value_pkey" PRIMARY KEY ("lookup_id");



ALTER TABLE ONLY "public"."custom_note_settings"
    ADD CONSTRAINT "custom_note_settings_pkey" PRIMARY KEY ("note_settings_id");



ALTER TABLE ONLY "public"."custom_note_type"
    ADD CONSTRAINT "custom_note_type_pkey" PRIMARY KEY ("note_type_id");



ALTER TABLE ONLY "public"."custom_payment"
    ADD CONSTRAINT "custom_payment_pkey" PRIMARY KEY ("payment_id");



ALTER TABLE ONLY "public"."dashboard_user_preferences"
    ADD CONSTRAINT "dashboard_user_preferences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dashboard_widgets"
    ADD CONSTRAINT "dashboard_widgets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."diagnosis_codes"
    ADD CONSTRAINT "diagnosis_codes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document_links"
    ADD CONSTRAINT "document_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."edi_acknowledgements"
    ADD CONSTRAINT "edi_acknowledgements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."edi_batch_claims"
    ADD CONSTRAINT "edi_batch_claims_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."edi_batches"
    ADD CONSTRAINT "edi_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."edi_transactions"
    ADD CONSTRAINT "edi_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."eligibility_checks"
    ADD CONSTRAINT "eligibility_checks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."eligibility_requests"
    ADD CONSTRAINT "eligibility_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."encounter_clinical_notes"
    ADD CONSTRAINT "encounter_clinical_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."encounter_code_suggestions"
    ADD CONSTRAINT "encounter_code_suggestions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."encounter_codes"
    ADD CONSTRAINT "encounter_codes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."encounter_diagnoses"
    ADD CONSTRAINT "encounter_diagnoses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."encounter_notes"
    ADD CONSTRAINT "encounter_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."encounter_service_lines"
    ADD CONSTRAINT "encounter_service_lines_organization_id_id_key" UNIQUE ("organization_id", "id");



ALTER TABLE ONLY "public"."encounter_service_lines"
    ADD CONSTRAINT "encounter_service_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_org_id_id_unique" UNIQUE ("organization_id", "id");



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_organization_id_appointment_id_key" UNIQUE ("organization_id", "appointment_id");



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_organization_id_id_key" UNIQUE ("organization_id", "id");



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."era_claim_payments"
    ADD CONSTRAINT "era_claim_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."era_import_batches"
    ADD CONSTRAINT "era_import_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."era_posting_ledger_entries"
    ADD CONSTRAINT "era_posting_ledger_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."external_message_envelopes"
    ADD CONSTRAINT "external_message_envelopes_organization_id_external_transac_key" UNIQUE ("organization_id", "external_transaction_attempt_id");



ALTER TABLE ONLY "public"."external_message_envelopes"
    ADD CONSTRAINT "external_message_envelopes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."external_transaction_attempts"
    ADD CONSTRAINT "external_transaction_attempts_organization_id_external_tran_key" UNIQUE ("organization_id", "external_transaction_id", "attempt_number");



ALTER TABLE ONLY "public"."external_transaction_attempts"
    ADD CONSTRAINT "external_transaction_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."external_transactions"
    ADD CONSTRAINT "external_transactions_organization_id_duplicate_detection_k_key" UNIQUE ("organization_id", "duplicate_detection_key");



ALTER TABLE ONLY "public"."external_transactions"
    ADD CONSTRAINT "external_transactions_organization_id_id_key" UNIQUE ("organization_id", "id");



ALTER TABLE ONLY "public"."external_transactions"
    ADD CONSTRAINT "external_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."fee_schedules"
    ADD CONSTRAINT "fee_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gmail_oauth_tokens"
    ADD CONSTRAINT "gmail_oauth_tokens_connection_key" UNIQUE ("integration_connection_id");



ALTER TABLE ONLY "public"."gmail_oauth_tokens"
    ADD CONSTRAINT "gmail_oauth_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inbound_email_messages"
    ADD CONSTRAINT "inbound_email_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."insurance_payers"
    ADD CONSTRAINT "insurance_payers_organization_id_payer_id_key" UNIQUE ("organization_id", "payer_id");



ALTER TABLE ONLY "public"."insurance_payers"
    ADD CONSTRAINT "insurance_payers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."insurance_policies"
    ADD CONSTRAINT "insurance_policies_org_id_id_unique" UNIQUE ("organization_id", "id");



ALTER TABLE ONLY "public"."insurance_policies"
    ADD CONSTRAINT "insurance_policies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."insurance_subscribers"
    ADD CONSTRAINT "insurance_subscribers_organization_id_member_id_group_numbe_key" UNIQUE ("organization_id", "member_id", "group_number");



ALTER TABLE ONLY "public"."insurance_subscribers"
    ADD CONSTRAINT "insurance_subscribers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."integration_connections"
    ADD CONSTRAINT "integration_connections_organization_id_integration_type_key" UNIQUE ("organization_id", "integration_type");



ALTER TABLE ONLY "public"."integration_connections"
    ADD CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mailroom_items"
    ADD CONSTRAINT "mailroom_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_rules"
    ADD CONSTRAINT "notification_rules_organization_id_event_type_recipient_rol_key" UNIQUE ("organization_id", "event_type", "recipient_role");



ALTER TABLE ONLY "public"."notification_rules"
    ADD CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."operational_alerts"
    ADD CONSTRAINT "operational_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_organization_id_user_id_role_code_key" UNIQUE ("organization_id", "user_id", "role_code");



ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."patient_balances"
    ADD CONSTRAINT "patient_balances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_check_ins"
    ADD CONSTRAINT "patient_check_ins_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_checkin_goal_selections"
    ADD CONSTRAINT "patient_checkin_goal_selections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_checkins"
    ADD CONSTRAINT "patient_checkins_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_contacts"
    ADD CONSTRAINT "patient_contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_diagnoses"
    ADD CONSTRAINT "patient_diagnoses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_import_batches"
    ADD CONSTRAINT "patient_import_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_import_items"
    ADD CONSTRAINT "patient_import_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_invoice_payments"
    ADD CONSTRAINT "patient_invoice_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_invoices"
    ADD CONSTRAINT "patient_invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payer_configurations"
    ADD CONSTRAINT "payer_configurations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payer_contracts"
    ADD CONSTRAINT "payer_contracts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payer_plans"
    ADD CONSTRAINT "payer_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payer_profiles"
    ADD CONSTRAINT "payer_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_import_batches"
    ADD CONSTRAINT "payment_import_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_import_items"
    ADD CONSTRAINT "payment_import_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_posting_allocations"
    ADD CONSTRAINT "payment_posting_allocations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payment_postings"
    ADD CONSTRAINT "payment_postings_organization_id_posting_reference_key" UNIQUE ("organization_id", "posting_reference");



ALTER TABLE ONLY "public"."payment_postings"
    ADD CONSTRAINT "payment_postings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."professional_claim_service_lines"
    ADD CONSTRAINT "professional_claim_service_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."professional_claims"
    ADD CONSTRAINT "professional_claims_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_credentialing_profiles"
    ADD CONSTRAINT "provider_credentialing_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_locations"
    ADD CONSTRAINT "provider_locations_organization_id_provider_id_location_nam_key" UNIQUE ("organization_id", "provider_id", "location_name");



ALTER TABLE ONLY "public"."provider_locations"
    ADD CONSTRAINT "provider_locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_payer_enrollments"
    ADD CONSTRAINT "provider_payer_enrollments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_profiles"
    ADD CONSTRAINT "provider_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."providers"
    ADD CONSTRAINT "providers_org_id_id_unique" UNIQUE ("organization_id", "id");



ALTER TABLE ONLY "public"."providers"
    ADD CONSTRAINT "providers_organization_id_npi_key" UNIQUE ("organization_id", "npi");



ALTER TABLE ONLY "public"."providers"
    ADD CONSTRAINT "providers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."service_locations"
    ADD CONSTRAINT "service_locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."smart_phrases"
    ADD CONSTRAINT "smart_phrases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_ticket_comments"
    ADD CONSTRAINT "support_ticket_comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."system_settings"
    ADD CONSTRAINT "system_settings_organization_id_setting_key_key" UNIQUE ("organization_id", "setting_key");



ALTER TABLE ONLY "public"."system_settings"
    ADD CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."telehealth_participants"
    ADD CONSTRAINT "telehealth_participants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."telehealth_sessions"
    ADD CONSTRAINT "telehealth_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ticket_comments"
    ADD CONSTRAINT "ticket_comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tickets"
    ADD CONSTRAINT "tickets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."treatment_plan_goals"
    ADD CONSTRAINT "treatment_plan_goals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."treatment_plans"
    ADD CONSTRAINT "treatment_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_rules"
    ADD CONSTRAINT "unique_org_notification_rule" UNIQUE ("organization_id", "event_type", "recipient_role");



ALTER TABLE ONLY "public"."system_settings"
    ADD CONSTRAINT "unique_org_setting" UNIQUE ("organization_id", "setting_key");



ALTER TABLE ONLY "public"."custom_billing_service"
    ADD CONSTRAINT "uq_custom_billing_service_code" UNIQUE ("service_code");



ALTER TABLE ONLY "public"."custom_client_profile"
    ADD CONSTRAINT "uq_custom_client_profile_client" UNIQUE ("client_id");



ALTER TABLE ONLY "public"."custom_invoice"
    ADD CONSTRAINT "uq_custom_invoice_number" UNIQUE ("invoice_number");



ALTER TABLE ONLY "public"."custom_lookup_value"
    ADD CONSTRAINT "uq_custom_lookup_type_code" UNIQUE ("lookup_type", "lookup_code");



ALTER TABLE ONLY "public"."custom_note_type"
    ADD CONSTRAINT "uq_custom_note_type_code" UNIQUE ("note_type_code");



ALTER TABLE ONLY "public"."user_presence"
    ADD CONSTRAINT "user_presence_pkey" PRIMARY KEY ("user_id", "organization_id");



ALTER TABLE ONLY "public"."vcc_payments"
    ADD CONSTRAINT "vcc_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workqueue_item_comments"
    ADD CONSTRAINT "workqueue_item_comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workqueue_items"
    ADD CONSTRAINT "workqueue_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workqueue_type_catalog"
    ADD CONSTRAINT "workqueue_type_catalog_pkey" PRIMARY KEY ("work_type");



ALTER TABLE ONLY "public"."your_table"
    ADD CONSTRAINT "your_table_pkey" PRIMARY KEY ("id");



CREATE INDEX "appointments_insurance_policy_id_fkey_idx" ON "public"."appointments" USING "btree" ("insurance_policy_id");



CREATE INDEX "appointments_org_client_idx" ON "public"."appointments" USING "btree" ("organization_id", "client_id");



CREATE INDEX "appointments_provider_location_id_fkey_idx" ON "public"."appointments" USING "btree" ("provider_location_id");



CREATE INDEX "authorization_or_referrals_appointment_id_fkey_idx" ON "public"."authorization_or_referrals" USING "btree" ("appointment_id");



CREATE INDEX "authorization_or_referrals_client_id_fkey_idx" ON "public"."authorization_or_referrals" USING "btree" ("client_id");



CREATE INDEX "authorization_or_referrals_encounter_id_fkey_idx" ON "public"."authorization_or_referrals" USING "btree" ("encounter_id");



CREATE INDEX "authorization_or_referrals_external_transaction_id_fkey_idx" ON "public"."authorization_or_referrals" USING "btree" ("external_transaction_id");



CREATE INDEX "authorization_or_referrals_insurance_policy_id_fkey_idx" ON "public"."authorization_or_referrals" USING "btree" ("insurance_policy_id");



CREATE INDEX "authorization_or_referrals_organization_id_fkey_idx" ON "public"."authorization_or_referrals" USING "btree" ("organization_id");



CREATE INDEX "billing_alerts_org_status_idx" ON "public"."billing_alerts" USING "btree" ("organization_id", "status", "severity");



CREATE INDEX "billing_alerts_workqueue_item_id_fkey_idx" ON "public"."billing_alerts" USING "btree" ("workqueue_item_id");



CREATE INDEX "chat_conversations_related_client_id_fkey_idx" ON "public"."chat_conversations" USING "btree" ("related_client_id");



CREATE INDEX "chat_conversations_related_workqueue_item_id_fkey_idx" ON "public"."chat_conversations" USING "btree" ("related_workqueue_item_id");



CREATE INDEX "chat_messages_organization_id_fkey_idx" ON "public"."chat_messages" USING "btree" ("organization_id");



CREATE UNIQUE INDEX "chat_participants_conversation_user_uidx" ON "public"."chat_participants" USING "btree" ("conversation_id", "user_id") WHERE ("archived_at" IS NULL);



CREATE INDEX "chat_participants_organization_id_fkey_idx" ON "public"."chat_participants" USING "btree" ("organization_id");



CREATE INDEX "claim_status_inquiries_claim_idx" ON "public"."claim_status_inquiries" USING "btree" ("claim_id");



CREATE INDEX "claim_status_inquiries_external_transaction_id_fkey_idx" ON "public"."claim_status_inquiries" USING "btree" ("external_transaction_id");



CREATE INDEX "claim_submissions_claim_idx" ON "public"."claim_submissions" USING "btree" ("claim_id");



CREATE INDEX "claim_submissions_external_transaction_id_fkey_idx" ON "public"."claim_submissions" USING "btree" ("external_transaction_id");



CREATE INDEX "claims_insurance_policy_id_fkey_idx" ON "public"."claims" USING "btree" ("insurance_policy_id");



CREATE INDEX "claims_org_client_idx" ON "public"."claims" USING "btree" ("organization_id", "client_id");



CREATE INDEX "claims_org_encounter_idx" ON "public"."claims" USING "btree" ("organization_id", "encounter_id");



CREATE INDEX "client_contacts_client_id_fkey_idx" ON "public"."client_contacts" USING "btree" ("client_id");



CREATE INDEX "client_contacts_organization_id_fkey_idx" ON "public"."client_contacts" USING "btree" ("organization_id");



CREATE UNIQUE INDEX "clients_org_mrn_uidx" ON "public"."clients" USING "btree" ("organization_id", "mrn") WHERE (("mrn" IS NOT NULL) AND ("archived_at" IS NULL));



CREATE INDEX "eligibility_checks_encounter_id_fkey_idx" ON "public"."eligibility_checks" USING "btree" ("encounter_id");



CREATE INDEX "eligibility_checks_external_transaction_id_fkey_idx" ON "public"."eligibility_checks" USING "btree" ("external_transaction_id");



CREATE INDEX "eligibility_checks_insurance_policy_id_fkey_idx" ON "public"."eligibility_checks" USING "btree" ("insurance_policy_id");



CREATE INDEX "eligibility_checks_organization_id_fkey_idx" ON "public"."eligibility_checks" USING "btree" ("organization_id");



CREATE INDEX "encounter_code_suggestions_appointment_id_fkey_idx" ON "public"."encounter_code_suggestions" USING "btree" ("appointment_id");



CREATE INDEX "encounter_code_suggestions_client_id_fkey_idx" ON "public"."encounter_code_suggestions" USING "btree" ("client_id");



CREATE INDEX "encounter_code_suggestions_organization_id_fkey_idx" ON "public"."encounter_code_suggestions" USING "btree" ("organization_id");



CREATE INDEX "encounter_notes_amended_from_note_id_fkey_idx" ON "public"."encounter_notes" USING "btree" ("amended_from_note_id");



CREATE INDEX "encounter_notes_signed_by_provider_id_fkey_idx" ON "public"."encounter_notes" USING "btree" ("signed_by_provider_id");



CREATE INDEX "encounter_service_lines_rendering_provider_id_fkey_idx" ON "public"."encounter_service_lines" USING "btree" ("rendering_provider_id");



CREATE INDEX "encounters_org_appointment_idx" ON "public"."encounters" USING "btree" ("organization_id", "appointment_id");



CREATE INDEX "encounters_org_client_idx" ON "public"."encounters" USING "btree" ("organization_id", "client_id");



CREATE INDEX "idx_appointments_org_provider_start_active" ON "public"."appointments" USING "btree" ("organization_id", "provider_id", "scheduled_start_at") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_appointments_org_start_active" ON "public"."appointments" USING "btree" ("organization_id", "scheduled_start_at") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_appt_org_client" ON "public"."appointments" USING "btree" ("organization_id", "client_id", "scheduled_start_at");



CREATE INDEX "idx_audit_logs_claim_id" ON "public"."audit_logs" USING "btree" ("claim_id");



CREATE INDEX "idx_audit_logs_created_at" ON "public"."audit_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_audit_logs_encounter_id" ON "public"."audit_logs" USING "btree" ("encounter_id");



CREATE INDEX "idx_audit_logs_org_object" ON "public"."audit_logs" USING "btree" ("organization_id", "object_type", "object_id", "created_at" DESC) WHERE ("organization_id" IS NOT NULL);



CREATE INDEX "idx_audit_logs_organization_id" ON "public"."audit_logs" USING "btree" ("organization_id");



CREATE INDEX "idx_audit_logs_patient_id" ON "public"."audit_logs" USING "btree" ("patient_id");



CREATE INDEX "idx_audit_logs_user_id" ON "public"."audit_logs" USING "btree" ("user_id", "created_at" DESC) WHERE ("user_id" IS NOT NULL);



CREATE INDEX "idx_auth_refs_org_client_status_active" ON "public"."authorization_or_referrals" USING "btree" ("organization_id", "client_id", "authorization_status") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_auth_refs_org_policy_status_active" ON "public"."authorization_or_referrals" USING "btree" ("organization_id", "insurance_policy_id", "authorization_status") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_auth_refs_org_validity_active" ON "public"."authorization_or_referrals" USING "btree" ("organization_id", "client_id", "valid_from", "valid_to") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_availity_transactions_claim" ON "public"."availity_transactions" USING "btree" ("claim_id") WHERE ("claim_id" IS NOT NULL);



CREATE INDEX "idx_availity_transactions_correlation_id" ON "public"."availity_transactions" USING "btree" ("correlation_id") WHERE ("correlation_id" IS NOT NULL);



CREATE INDEX "idx_availity_transactions_created_at" ON "public"."availity_transactions" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_availity_transactions_external_id" ON "public"."availity_transactions" USING "btree" ("external_transaction_id") WHERE ("external_transaction_id" IS NOT NULL);



CREATE INDEX "idx_availity_transactions_organization" ON "public"."availity_transactions" USING "btree" ("organization_id") WHERE ("organization_id" IS NOT NULL);



CREATE INDEX "idx_availity_transactions_patient" ON "public"."availity_transactions" USING "btree" ("patient_id") WHERE ("patient_id" IS NOT NULL);



CREATE INDEX "idx_availity_transactions_payer" ON "public"."availity_transactions" USING "btree" ("payer_id") WHERE ("payer_id" IS NOT NULL);



CREATE INDEX "idx_availity_transactions_status" ON "public"."availity_transactions" USING "btree" ("status");



CREATE INDEX "idx_availity_transactions_type" ON "public"."availity_transactions" USING "btree" ("transaction_type");



CREATE INDEX "idx_billing_alerts_claim" ON "public"."billing_alerts" USING "btree" ("organization_id", "claim_id", "alert_status") WHERE (("archived_at" IS NULL) AND ("claim_id" IS NOT NULL));



CREATE INDEX "idx_billing_alerts_client" ON "public"."billing_alerts" USING "btree" ("organization_id", "client_id", "alert_status") WHERE (("archived_at" IS NULL) AND ("client_id" IS NOT NULL));



CREATE INDEX "idx_billing_alerts_due_date" ON "public"."billing_alerts" USING "btree" ("organization_id", "due_date", "alert_status") WHERE (("archived_at" IS NULL) AND ("due_date" IS NOT NULL));



CREATE INDEX "idx_billing_alerts_org_status" ON "public"."billing_alerts" USING "btree" ("organization_id", "alert_status", "severity", "created_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_charge_capture_items_client" ON "public"."charge_capture_items" USING "btree" ("organization_id", "client_id", "captured_at" DESC) WHERE ("archived_at" IS NULL);



CREATE UNIQUE INDEX "idx_charge_capture_items_encounter_active" ON "public"."charge_capture_items" USING "btree" ("encounter_id") WHERE (("archived_at" IS NULL) AND ("charge_status" <> 'voided'::"text"));



CREATE INDEX "idx_charge_capture_items_org_status" ON "public"."charge_capture_items" USING "btree" ("organization_id", "charge_status", "captured_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_chat_conversations_org" ON "public"."chat_conversations" USING "btree" ("organization_id", "updated_at" DESC);



CREATE INDEX "idx_chat_messages_conversation" ON "public"."chat_messages" USING "btree" ("conversation_id", "created_at");



CREATE INDEX "idx_chat_participants_user" ON "public"."chat_participants" USING "btree" ("user_id", "conversation_id");



CREATE INDEX "idx_checkin_goal_selections_checkin" ON "public"."patient_checkin_goal_selections" USING "btree" ("checkin_id");



CREATE INDEX "idx_claim_837p_batch_claims_batch" ON "public"."claim_837p_batch_claims" USING "btree" ("organization_id", "batch_id") WHERE ("archived_at" IS NULL);



CREATE UNIQUE INDEX "idx_claim_837p_batch_claims_unique_active" ON "public"."claim_837p_batch_claims" USING "btree" ("organization_id", "professional_claim_id") WHERE ("archived_at" IS NULL);



CREATE UNIQUE INDEX "idx_claim_837p_batches_org_number" ON "public"."claim_837p_batches" USING "btree" ("organization_id", "batch_number") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_claim_service_lines_org_claim" ON "public"."claim_service_lines" USING "btree" ("organization_id", "claim_id") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_claim_service_lines_org_encounter_service_line" ON "public"."claim_service_lines" USING "btree" ("organization_id", "encounter_service_line_id") WHERE (("archived_at" IS NULL) AND ("encounter_service_line_id" IS NOT NULL));



CREATE INDEX "idx_claim_status_events_claim_source_created" ON "public"."claim_status_events" USING "btree" ("claim_id", "source", "created_at" DESC);



CREATE INDEX "idx_claim_status_inquiries_org_claim_received" ON "public"."claim_status_inquiries" USING "btree" ("organization_id", "claim_id", "requested_at" DESC);



CREATE INDEX "idx_claim_status_inquiries_org_claim_requested_active" ON "public"."claim_status_inquiries" USING "btree" ("organization_id", "claim_id", "requested_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_claim_status_inquiries_org_status_requested_active" ON "public"."claim_status_inquiries" USING "btree" ("organization_id", "inquiry_status", "requested_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_claim_status_inquiries_worker_queue" ON "public"."claim_status_inquiries" USING "btree" ("inquiry_status", "requested_at", "created_at") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_claim_submissions_org_claim_sequence_active" ON "public"."claim_submissions" USING "btree" ("organization_id", "claim_id", "submission_sequence" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_claim_submissions_org_status_submitted_active" ON "public"."claim_submissions" USING "btree" ("organization_id", "submission_status", "submitted_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_claim_submissions_worker_queue" ON "public"."claim_submissions" USING "btree" ("submission_status", "submitted_at", "created_at") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_claim_workqueue_items_claim" ON "public"."claim_workqueue_items" USING "btree" ("organization_id", "claim_id", "item_status") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_claim_workqueue_items_client" ON "public"."claim_workqueue_items" USING "btree" ("organization_id", "client_id") WHERE (("archived_at" IS NULL) AND ("client_id" IS NOT NULL));



CREATE INDEX "idx_claim_workqueue_items_org_status" ON "public"."claim_workqueue_items" USING "btree" ("organization_id", "item_status", "priority", "created_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_claims_org_client_dos_active" ON "public"."claims" USING "btree" ("organization_id", "client_id", "date_of_service_from" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_claims_org_status" ON "public"."claims" USING "btree" ("organization_id", "claim_status");



CREATE INDEX "idx_claims_org_status_dos_active" ON "public"."claims" USING "btree" ("organization_id", "claim_status", "date_of_service_from" DESC) WHERE ("archived_at" IS NULL);



CREATE UNIQUE INDEX "idx_clearinghouse_connections_org_name_mode" ON "public"."clearinghouse_connections" USING "btree" ("organization_id", "clearinghouse_name", "mode");



CREATE INDEX "idx_client_import_jobs_created_at" ON "public"."client_import_jobs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_client_import_jobs_organization_id" ON "public"."client_import_jobs" USING "btree" ("organization_id");



CREATE INDEX "idx_client_import_jobs_status" ON "public"."client_import_jobs" USING "btree" ("status");



CREATE INDEX "idx_client_import_rows_duplicate_match_client_id" ON "public"."client_import_rows" USING "btree" ("duplicate_match_client_id");



CREATE INDEX "idx_client_import_rows_import_job_id" ON "public"."client_import_rows" USING "btree" ("import_job_id");



CREATE INDEX "idx_client_import_rows_import_status" ON "public"."client_import_rows" USING "btree" ("import_status");



CREATE INDEX "idx_client_import_rows_promoted_policy_id" ON "public"."client_import_rows" USING "btree" ("promoted_policy_id");



CREATE INDEX "idx_client_import_rows_source_client_id" ON "public"."client_import_rows" USING "btree" ("source_client_id");



CREATE INDEX "idx_clients_org_dob" ON "public"."clients" USING "btree" ("organization_id", "date_of_birth");



CREATE INDEX "idx_clients_org_name" ON "public"."clients" USING "btree" ("organization_id", "last_name", "first_name");



CREATE INDEX "idx_coding_suggestions_code" ON "public"."coding_suggestions" USING "btree" ("organization_id", "suggested_code", "suggestion_status");



CREATE INDEX "idx_coding_suggestions_encounter" ON "public"."coding_suggestions" USING "btree" ("organization_id", "encounter_id", "suggestion_status");



CREATE INDEX "idx_custom_appointment_client" ON "public"."custom_appointment_request" USING "btree" ("client_id");



CREATE INDEX "idx_custom_appointment_date" ON "public"."custom_appointment_request" USING "btree" ("requested_date");



CREATE INDEX "idx_custom_appointment_location" ON "public"."custom_appointment_request" USING "btree" ("location_id");



CREATE INDEX "idx_custom_appointment_provider" ON "public"."custom_appointment_request" USING "btree" ("provider_id");



CREATE INDEX "idx_custom_appointment_status" ON "public"."custom_appointment_request" USING "btree" ("status");



CREATE INDEX "idx_custom_audit_client" ON "public"."custom_audit_event" USING "btree" ("client_id");



CREATE INDEX "idx_custom_audit_date_created" ON "public"."custom_audit_event" USING "btree" ("date_created");



CREATE INDEX "idx_custom_audit_event_type" ON "public"."custom_audit_event" USING "btree" ("event_type");



CREATE INDEX "idx_custom_audit_user" ON "public"."custom_audit_event" USING "btree" ("user_id");



CREATE INDEX "idx_custom_billing_service_active" ON "public"."custom_billing_service" USING "btree" ("active");



CREATE INDEX "idx_custom_billing_wq_comment_action_type" ON "public"."custom_billing_workqueue_comment" USING "btree" ("action_type");



CREATE INDEX "idx_custom_billing_wq_comment_billing_month" ON "public"."custom_billing_workqueue_comment" USING "btree" ("billing_month");



CREATE INDEX "idx_custom_billing_wq_comment_claim" ON "public"."custom_billing_workqueue_comment" USING "btree" ("claim_id");



CREATE INDEX "idx_custom_billing_wq_comment_client" ON "public"."custom_billing_workqueue_comment" USING "btree" ("client_id");



CREATE INDEX "idx_custom_billing_wq_comment_date_created" ON "public"."custom_billing_workqueue_comment" USING "btree" ("date_created");



CREATE INDEX "idx_custom_billing_wq_comment_reportable" ON "public"."custom_billing_workqueue_comment" USING "btree" ("reportable") WHERE ("reportable" = true);



CREATE INDEX "idx_custom_billing_wq_comment_workqueue_item" ON "public"."custom_billing_workqueue_comment" USING "btree" ("workqueue_item_id");



CREATE INDEX "idx_custom_client_note_client" ON "public"."custom_client_note" USING "btree" ("client_id");



CREATE INDEX "idx_custom_client_note_created" ON "public"."custom_client_note" USING "btree" ("date_created");



CREATE INDEX "idx_custom_client_note_follow_up" ON "public"."custom_client_note" USING "btree" ("follow_up_date") WHERE ("requires_follow_up" = true);



CREATE INDEX "idx_custom_client_note_status" ON "public"."custom_client_note" USING "btree" ("note_status");



CREATE INDEX "idx_custom_client_note_type" ON "public"."custom_client_note" USING "btree" ("note_type_id");



CREATE INDEX "idx_custom_client_note_visibility" ON "public"."custom_client_note" USING "btree" ("note_visibility");



CREATE INDEX "idx_custom_client_profile_external_code" ON "public"."custom_client_profile" USING "btree" ("external_client_code");



CREATE INDEX "idx_custom_client_profile_status" ON "public"."custom_client_profile" USING "btree" ("enrollment_status");



CREATE INDEX "idx_custom_client_program_client" ON "public"."custom_client_program" USING "btree" ("client_id");



CREATE INDEX "idx_custom_client_program_enrollment_date" ON "public"."custom_client_program" USING "btree" ("enrollment_date");



CREATE INDEX "idx_custom_client_program_name" ON "public"."custom_client_program" USING "btree" ("program_name");



CREATE INDEX "idx_custom_client_program_status" ON "public"."custom_client_program" USING "btree" ("program_status");



CREATE INDEX "idx_custom_document_client" ON "public"."custom_client_document" USING "btree" ("client_id");



CREATE INDEX "idx_custom_document_type" ON "public"."custom_client_document" USING "btree" ("document_type");



CREATE INDEX "idx_custom_document_voided" ON "public"."custom_client_document" USING "btree" ("voided");



CREATE INDEX "idx_custom_import_batch" ON "public"."custom_client_import_staging" USING "btree" ("batch_id");



CREATE INDEX "idx_custom_import_external_id" ON "public"."custom_client_import_staging" USING "btree" ("external_client_id");



CREATE INDEX "idx_custom_import_matched_client" ON "public"."custom_client_import_staging" USING "btree" ("matched_client_id");



CREATE INDEX "idx_custom_import_status" ON "public"."custom_client_import_staging" USING "btree" ("import_status");



CREATE INDEX "idx_custom_invoice_client" ON "public"."custom_invoice" USING "btree" ("client_id");



CREATE INDEX "idx_custom_invoice_date" ON "public"."custom_invoice" USING "btree" ("invoice_date");



CREATE INDEX "idx_custom_invoice_line_invoice" ON "public"."custom_invoice_line_item" USING "btree" ("invoice_id");



CREATE INDEX "idx_custom_invoice_line_service" ON "public"."custom_invoice_line_item" USING "btree" ("billing_service_id");



CREATE INDEX "idx_custom_invoice_status" ON "public"."custom_invoice" USING "btree" ("invoice_status");



CREATE INDEX "idx_custom_lookup_active" ON "public"."custom_lookup_value" USING "btree" ("active");



CREATE INDEX "idx_custom_lookup_type" ON "public"."custom_lookup_value" USING "btree" ("lookup_type");



CREATE INDEX "idx_custom_note_type_active" ON "public"."custom_note_type" USING "btree" ("active");



CREATE INDEX "idx_custom_payment_client" ON "public"."custom_payment" USING "btree" ("client_id");



CREATE INDEX "idx_custom_payment_date" ON "public"."custom_payment" USING "btree" ("payment_date");



CREATE INDEX "idx_custom_payment_invoice" ON "public"."custom_payment" USING "btree" ("invoice_id");



CREATE INDEX "idx_dashboard_user_preferences_user_org" ON "public"."dashboard_user_preferences" USING "btree" ("user_id", "organization_id");



CREATE INDEX "idx_dashboard_widgets_org_role_enabled" ON "public"."dashboard_widgets" USING "btree" ("organization_id", "role", "is_enabled", "sort_order");



CREATE UNIQUE INDEX "idx_diagnosis_codes_code_system" ON "public"."diagnosis_codes" USING "btree" ("code", "code_system");



CREATE INDEX "idx_diagnosis_codes_code_text" ON "public"."diagnosis_codes" USING "gin" ("to_tsvector"('"english"'::"regconfig", "description"));



CREATE INDEX "idx_document_links_document" ON "public"."document_links" USING "btree" ("document_id", "linked_entity_type", "linked_entity_id");



CREATE INDEX "idx_document_links_entity" ON "public"."document_links" USING "btree" ("organization_id", "linked_entity_type", "linked_entity_id");



CREATE INDEX "idx_documents_claim" ON "public"."documents" USING "btree" ("claim_id");



CREATE INDEX "idx_documents_client" ON "public"."documents" USING "btree" ("client_id");



CREATE INDEX "idx_documents_encounter" ON "public"."documents" USING "btree" ("encounter_id");



CREATE INDEX "idx_documents_mailroom" ON "public"."documents" USING "btree" ("mailroom_item_id");



CREATE INDEX "idx_documents_org_scope" ON "public"."documents" USING "btree" ("organization_id", "document_scope");



CREATE INDEX "idx_documents_workqueue" ON "public"."documents" USING "btree" ("workqueue_item_id");



CREATE INDEX "idx_edi_acknowledgements_acknowledgement_type" ON "public"."edi_acknowledgements" USING "btree" ("acknowledgement_type");



CREATE INDEX "idx_edi_acknowledgements_edi_batch_id" ON "public"."edi_acknowledgements" USING "btree" ("edi_batch_id");



CREATE INDEX "idx_edi_acknowledgements_organization_id" ON "public"."edi_acknowledgements" USING "btree" ("organization_id");



CREATE UNIQUE INDEX "idx_edi_batch_claims_batch_claim" ON "public"."edi_batch_claims" USING "btree" ("edi_batch_id", "claim_id");



CREATE INDEX "idx_edi_batches_file_name" ON "public"."edi_batches" USING "btree" ("file_name");



CREATE INDEX "idx_edi_batches_organization_id" ON "public"."edi_batches" USING "btree" ("organization_id");



CREATE INDEX "idx_edi_batches_status" ON "public"."edi_batches" USING "btree" ("status");



CREATE INDEX "idx_edi_transactions_org_claim_patient_type_corr_created" ON "public"."edi_transactions" USING "btree" ("organization_id", "claim_id", "patient_id", "transaction_type", "correlation_id", "created_at" DESC);



CREATE INDEX "idx_eligibility_appointment" ON "public"."eligibility_checks" USING "btree" ("appointment_id");



CREATE INDEX "idx_eligibility_checks_org_patient_appt_checked" ON "public"."eligibility_checks" USING "btree" ("organization_id", "client_id", "appointment_id", "checked_at" DESC);



CREATE INDEX "idx_eligibility_client_status" ON "public"."eligibility_checks" USING "btree" ("client_id", "eligibility_status");



CREATE INDEX "idx_eligibility_org_appointment_active" ON "public"."eligibility_checks" USING "btree" ("organization_id", "appointment_id", "checked_at" DESC) WHERE (("archived_at" IS NULL) AND ("appointment_id" IS NOT NULL));



CREATE INDEX "idx_eligibility_org_client_checked_active" ON "public"."eligibility_checks" USING "btree" ("organization_id", "client_id", "checked_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_eligibility_org_policy_checked_active" ON "public"."eligibility_checks" USING "btree" ("organization_id", "insurance_policy_id", "checked_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_eligibility_requests_appointment_id" ON "public"."eligibility_requests" USING "btree" ("appointment_id") WHERE ("appointment_id" IS NOT NULL);



CREATE INDEX "idx_eligibility_requests_availity_transaction_id" ON "public"."eligibility_requests" USING "btree" ("availity_transaction_id");



CREATE INDEX "idx_eligibility_requests_created_at" ON "public"."eligibility_requests" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_eligibility_requests_eligibility_status" ON "public"."eligibility_requests" USING "btree" ("eligibility_status");



CREATE INDEX "idx_eligibility_requests_organization_id" ON "public"."eligibility_requests" USING "btree" ("organization_id");



CREATE INDEX "idx_eligibility_requests_patient_id" ON "public"."eligibility_requests" USING "btree" ("patient_id");



CREATE INDEX "idx_eligibility_requests_payer_configuration_id" ON "public"."eligibility_requests" USING "btree" ("payer_configuration_id");



CREATE INDEX "idx_eligibility_requests_payer_id" ON "public"."eligibility_requests" USING "btree" ("payer_id");



CREATE INDEX "idx_eligibility_requests_status" ON "public"."eligibility_requests" USING "btree" ("status");



CREATE INDEX "idx_encounter_clinical_notes_client" ON "public"."encounter_clinical_notes" USING "btree" ("organization_id", "client_id", "updated_at" DESC) WHERE ("archived_at" IS NULL);



CREATE UNIQUE INDEX "idx_encounter_clinical_notes_unique_active" ON "public"."encounter_clinical_notes" USING "btree" ("organization_id", "encounter_id") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_encounter_code_suggestions_encounter" ON "public"."encounter_code_suggestions" USING "btree" ("encounter_id");



CREATE INDEX "idx_encounter_codes_encounter" ON "public"."encounter_codes" USING "btree" ("organization_id", "encounter_id", "code_type") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_encounter_diagnoses_org_encounter_active" ON "public"."encounter_diagnoses" USING "btree" ("organization_id", "encounter_id") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_encounter_notes_org_encounter" ON "public"."encounter_notes" USING "btree" ("organization_id", "encounter_id");



CREATE INDEX "idx_encounter_service_lines_org_encounter_active" ON "public"."encounter_service_lines" USING "btree" ("organization_id", "encounter_id") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_encounters_org_appt" ON "public"."encounters" USING "btree" ("organization_id", "appointment_id");



CREATE INDEX "idx_encounters_org_client" ON "public"."encounters" USING "btree" ("organization_id", "client_id", "service_date");



CREATE INDEX "idx_encounters_org_provider" ON "public"."encounters" USING "btree" ("organization_id", "provider_id", "service_date");



CREATE INDEX "idx_era_claim_payments_batch" ON "public"."era_claim_payments" USING "btree" ("era_import_batch_id", "claim_match_status", "posting_status") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_era_claim_payments_check_eft" ON "public"."era_claim_payments" USING "btree" ("check_eft_number") WHERE ("check_eft_number" IS NOT NULL);



CREATE INDEX "idx_era_claim_payments_claim" ON "public"."era_claim_payments" USING "btree" ("organization_id", "professional_claim_id") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_era_claim_payments_professional_claim_id" ON "public"."era_claim_payments" USING "btree" ("professional_claim_id") WHERE ("professional_claim_id" IS NOT NULL);



CREATE INDEX "idx_era_import_batches_org_status" ON "public"."era_import_batches" USING "btree" ("organization_id", "import_status", "imported_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_era_posting_ledger_entries_claim" ON "public"."era_posting_ledger_entries" USING "btree" ("organization_id", "professional_claim_id", "entry_type") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_external_attempts_org_transaction_created" ON "public"."external_transaction_attempts" USING "btree" ("organization_id", "external_transaction_id", "created_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_external_attempts_status_retry" ON "public"."external_transaction_attempts" USING "btree" ("status", "retry_after", "created_at") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_external_transactions_availity_transaction_id" ON "public"."external_transactions" USING "btree" ("organization_id", "availity_transaction_id") WHERE (("archived_at" IS NULL) AND ("availity_transaction_id" IS NOT NULL));



CREATE INDEX "idx_external_transactions_org_source" ON "public"."external_transactions" USING "btree" ("organization_id", "source_object_type", "source_object_id") WHERE (("archived_at" IS NULL) AND ("source_object_type" IS NOT NULL) AND ("source_object_id" IS NOT NULL));



CREATE INDEX "idx_external_transactions_org_status_created" ON "public"."external_transactions" USING "btree" ("organization_id", "processing_status", "created_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_external_transactions_payload_id" ON "public"."external_transactions" USING "btree" ("organization_id", "payload_id") WHERE (("archived_at" IS NULL) AND ("payload_id" IS NOT NULL));



CREATE INDEX "idx_external_transactions_worker_queue" ON "public"."external_transactions" USING "btree" ("processing_status", "defer_until", "retry_after", "created_at") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_fee_schedules_org_code" ON "public"."fee_schedules" USING "btree" ("organization_id", "procedure_code") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_inbound_email_ai_category" ON "public"."inbound_email_messages" USING "btree" ("organization_id", "ai_category", "created_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_inbound_email_ai_pending" ON "public"."inbound_email_messages" USING "btree" ("ai_analysis_status", "created_at") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_inbound_email_mailroom" ON "public"."inbound_email_messages" USING "btree" ("organization_id", "mailroom_item_id") WHERE (("archived_at" IS NULL) AND ("mailroom_item_id" IS NOT NULL));



CREATE INDEX "idx_inbound_email_org_from_email" ON "public"."inbound_email_messages" USING "btree" ("organization_id", "lower"("from_email")) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_inbound_email_org_status_received" ON "public"."inbound_email_messages" USING "btree" ("organization_id", "processing_status", "received_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_integration_connections_org_status" ON "public"."integration_connections" USING "btree" ("organization_id", "connection_status", "last_checked_at" DESC);



CREATE INDEX "idx_mailroom_client" ON "public"."mailroom_items" USING "btree" ("client_id");



CREATE INDEX "idx_mailroom_filed_client" ON "public"."mailroom_items" USING "btree" ("filed_client_id");



CREATE INDEX "idx_mailroom_items_client" ON "public"."mailroom_items" USING "btree" ("organization_id", "client_id", "created_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_mailroom_items_mail_status" ON "public"."mailroom_items" USING "btree" ("organization_id", "status", "created_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_mailroom_items_type" ON "public"."mailroom_items" USING "btree" ("organization_id", "document_type", "created_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_mailroom_org_status" ON "public"."mailroom_items" USING "btree" ("organization_id", "status");



CREATE INDEX "idx_mailroom_workqueue" ON "public"."mailroom_items" USING "btree" ("workqueue_item_id");



CREATE INDEX "idx_operational_alerts_org_status_type" ON "public"."operational_alerts" USING "btree" ("organization_id", "status", "alert_type", "created_at" DESC);



CREATE UNIQUE INDEX "idx_patient_balances_client" ON "public"."patient_balances" USING "btree" ("organization_id", "client_id");



CREATE INDEX "idx_patient_check_ins_appointment" ON "public"."patient_check_ins" USING "btree" ("appointment_id");



CREATE INDEX "idx_patient_check_ins_encounter" ON "public"."patient_check_ins" USING "btree" ("encounter_id");



CREATE INDEX "idx_patient_check_ins_org_client_created" ON "public"."patient_check_ins" USING "btree" ("organization_id", "client_id", "created_at" DESC);



CREATE INDEX "idx_patient_checkins_appointment" ON "public"."patient_checkins" USING "btree" ("appointment_id");



CREATE INDEX "idx_patient_checkins_appt" ON "public"."patient_checkins" USING "btree" ("appointment_id");



CREATE INDEX "idx_patient_checkins_client" ON "public"."patient_checkins" USING "btree" ("client_id");



CREATE INDEX "idx_patient_checkins_client_status" ON "public"."patient_checkins" USING "btree" ("client_id", "status");



CREATE INDEX "idx_patient_checkins_status" ON "public"."patient_checkins" USING "btree" ("organization_id", "status");



CREATE INDEX "idx_patient_contacts_client" ON "public"."patient_contacts" USING "btree" ("organization_id", "client_id", "contact_type") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_patient_diagnoses_client" ON "public"."patient_diagnoses" USING "btree" ("organization_id", "client_id", "is_active", "diagnosis_code") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_patient_diagnoses_code" ON "public"."patient_diagnoses" USING "btree" ("diagnosis_code", "organization_id") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_patient_invoice_payments_client" ON "public"."patient_invoice_payments" USING "btree" ("organization_id", "client_id", "paid_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_patient_invoice_payments_invoice" ON "public"."patient_invoice_payments" USING "btree" ("organization_id", "patient_invoice_id", "paid_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_patient_invoices_client_status" ON "public"."patient_invoices" USING "btree" ("organization_id", "client_id", "invoice_status", "created_at" DESC) WHERE ("archived_at" IS NULL);



CREATE UNIQUE INDEX "idx_patient_invoices_invoice_number" ON "public"."patient_invoices" USING "btree" ("organization_id", "invoice_number");



CREATE INDEX "idx_payer_configurations_created_at" ON "public"."payer_configurations" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_payer_configurations_is_active" ON "public"."payer_configurations" USING "btree" ("is_active");



CREATE INDEX "idx_payer_configurations_org_id" ON "public"."payer_configurations" USING "btree" ("organization_id");



CREATE INDEX "idx_payer_configurations_payer_id" ON "public"."payer_configurations" USING "btree" ("payer_id");



CREATE INDEX "idx_payer_configurations_payer_name" ON "public"."payer_configurations" USING "btree" ("payer_name");



CREATE INDEX "idx_payer_contracts_org_payer" ON "public"."payer_contracts" USING "btree" ("organization_id", "payer_profile_id", "is_active") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_payer_plans_org_payer" ON "public"."payer_plans" USING "btree" ("organization_id", "payer_profile_id") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_payer_profiles_office_ally_payer_id" ON "public"."payer_profiles" USING "btree" ("office_ally_payer_id");



CREATE INDEX "idx_payer_profiles_organization_id" ON "public"."payer_profiles" USING "btree" ("organization_id");



CREATE INDEX "idx_payment_import_batch" ON "public"."payment_import_items" USING "btree" ("batch_id");



CREATE INDEX "idx_payment_import_batches_org_status_imported" ON "public"."payment_import_batches" USING "btree" ("organization_id", "payment_import_status", "imported_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_payment_import_items_batch_parse_status" ON "public"."payment_import_items" USING "btree" ("batch_id", "parse_status", "created_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_payment_import_items_batch_status" ON "public"."payment_import_items" USING "btree" ("batch_id", "parse_status", "created_at" DESC);



CREATE INDEX "idx_payment_import_items_org_batch_status" ON "public"."payment_import_items" USING "btree" ("organization_id", "batch_id", "payment_import_status") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_payment_import_items_org_claim" ON "public"."payment_import_items" USING "btree" ("organization_id", "claim_id") WHERE (("archived_at" IS NULL) AND ("claim_id" IS NOT NULL));



CREATE INDEX "idx_payment_import_items_org_client" ON "public"."payment_import_items" USING "btree" ("organization_id", "client_id") WHERE (("archived_at" IS NULL) AND ("client_id" IS NOT NULL));



CREATE INDEX "idx_payment_import_items_org_parse_status" ON "public"."payment_import_items" USING "btree" ("organization_id", "parse_status", "created_at" DESC);



CREATE INDEX "idx_payment_import_items_org_payer_date" ON "public"."payment_import_items" USING "btree" ("organization_id", "payer_id", "payment_date" DESC) WHERE (("archived_at" IS NULL) AND ("payer_id" IS NOT NULL));



CREATE INDEX "idx_payment_postings_status" ON "public"."payment_postings" USING "btree" ("posting_status");



CREATE UNIQUE INDEX "idx_professional_claim_service_lines_claim_line_number" ON "public"."professional_claim_service_lines" USING "btree" ("claim_id", "line_number");



CREATE INDEX "idx_professional_claims_claim_status" ON "public"."professional_claims" USING "btree" ("claim_status");



CREATE INDEX "idx_professional_claims_encounter_id" ON "public"."professional_claims" USING "btree" ("encounter_id") WHERE ("encounter_id" IS NOT NULL);



CREATE INDEX "idx_professional_claims_organization_id" ON "public"."professional_claims" USING "btree" ("organization_id");



CREATE INDEX "idx_professional_claims_patient_id" ON "public"."professional_claims" USING "btree" ("patient_id");



CREATE INDEX "idx_professional_claims_status_org" ON "public"."professional_claims" USING "btree" ("organization_id", "claim_status", "created_at" DESC) WHERE ("claim_status" <> ALL (ARRAY['paid'::"text", 'voided'::"text"]));



CREATE INDEX "idx_profiles_email" ON "public"."profiles" USING "btree" ("email");



CREATE INDEX "idx_profiles_org_id" ON "public"."profiles" USING "btree" ("organization_id");



CREATE INDEX "idx_profiles_role" ON "public"."profiles" USING "btree" ("role");



CREATE UNIQUE INDEX "idx_provider_credentialing_profiles_org_npi" ON "public"."provider_credentialing_profiles" USING "btree" ("organization_id", "individual_npi") WHERE (("archived_at" IS NULL) AND ("individual_npi" IS NOT NULL));



CREATE INDEX "idx_provider_credentialing_profiles_practice" ON "public"."provider_credentialing_profiles" USING "btree" ("organization_id", "practice_name", "provider_name") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_provider_payer_enrollments_payer" ON "public"."provider_payer_enrollments" USING "btree" ("organization_id", "payer_profile_id") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_provider_payer_enrollments_provider" ON "public"."provider_payer_enrollments" USING "btree" ("organization_id", "provider_profile_id", "enrollment_status") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_provider_profiles_org" ON "public"."provider_profiles" USING "btree" ("organization_id") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_response_events_org_claim_type_resolved" ON "public"."clearinghouse_response_events" USING "btree" ("organization_id", "claim_id", "event_type", "is_resolved");



CREATE INDEX "idx_service_locations_org" ON "public"."service_locations" USING "btree" ("organization_id", "is_active") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_smart_phrases_category" ON "public"."smart_phrases" USING "btree" ("organization_id", "category", "is_active");



CREATE UNIQUE INDEX "idx_smart_phrases_key_org" ON "public"."smart_phrases" USING "btree" ("organization_id", "phrase_key");



CREATE UNIQUE INDEX "idx_system_settings_key" ON "public"."system_settings" USING "btree" ("organization_id", "setting_key");



CREATE INDEX "idx_telehealth_participants_session" ON "public"."telehealth_participants" USING "btree" ("telehealth_session_id");



CREATE INDEX "idx_telehealth_sessions_appointment" ON "public"."telehealth_sessions" USING "btree" ("appointment_id");



CREATE INDEX "idx_telehealth_sessions_client" ON "public"."telehealth_sessions" USING "btree" ("client_id");



CREATE INDEX "idx_telehealth_sessions_org_status" ON "public"."telehealth_sessions" USING "btree" ("organization_id", "session_status");



CREATE INDEX "idx_ticket_comments_ticket" ON "public"."ticket_comments" USING "btree" ("ticket_id", "created_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_tickets_assigned_user" ON "public"."tickets" USING "btree" ("organization_id", "assigned_to_user_id", "ticket_status") WHERE (("archived_at" IS NULL) AND ("assigned_to_user_id" IS NOT NULL));



CREATE INDEX "idx_tickets_claim" ON "public"."tickets" USING "btree" ("organization_id", "claim_id") WHERE (("archived_at" IS NULL) AND ("claim_id" IS NOT NULL));



CREATE INDEX "idx_tickets_client" ON "public"."tickets" USING "btree" ("organization_id", "client_id") WHERE (("archived_at" IS NULL) AND ("client_id" IS NOT NULL));



CREATE INDEX "idx_tickets_org_status" ON "public"."tickets" USING "btree" ("organization_id", "ticket_status", "priority", "created_at" DESC) WHERE ("archived_at" IS NULL);



CREATE UNIQUE INDEX "idx_tickets_ticket_number" ON "public"."tickets" USING "btree" ("organization_id", "ticket_number");



CREATE INDEX "idx_treatment_plan_goals_plan" ON "public"."treatment_plan_goals" USING "btree" ("treatment_plan_id", "goal_status") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_treatment_plans_client" ON "public"."treatment_plans" USING "btree" ("organization_id", "client_id", "plan_status") WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_user_presence_org_status" ON "public"."user_presence" USING "btree" ("organization_id", "status", "last_seen_at" DESC);



CREATE INDEX "idx_vcc_claim" ON "public"."vcc_payments" USING "btree" ("claim_id");



CREATE INDEX "idx_vcc_mailroom" ON "public"."vcc_payments" USING "btree" ("mailroom_item_id");



CREATE INDEX "idx_vcc_org_status" ON "public"."vcc_payments" USING "btree" ("organization_id", "status");



CREATE INDEX "idx_vcc_status" ON "public"."vcc_payments" USING "btree" ("organization_id", "status");



CREATE INDEX "idx_workqueue_item_comments_item" ON "public"."workqueue_item_comments" USING "btree" ("organization_id", "workqueue_item_id", "created_at" DESC) WHERE ("archived_at" IS NULL);



CREATE INDEX "idx_workqueue_items_billing_alert" ON "public"."workqueue_items" USING "btree" ("organization_id", "billing_alert_id") WHERE (("billing_alert_id" IS NOT NULL) AND ("archived_at" IS NULL));



CREATE INDEX "idx_workqueue_items_deferred_until" ON "public"."workqueue_items" USING "btree" ("organization_id", "deferred_until") WHERE (("archived_at" IS NULL) AND ("deferred_until" IS NOT NULL));



CREATE INDEX "idx_workqueue_items_open_work_type_claim" ON "public"."workqueue_items" USING "btree" ("organization_id", "work_type", "claim_id", "created_at" DESC) WHERE (("archived_at" IS NULL) AND ("status" = ANY (ARRAY['open'::"public"."workqueue_status", 'in_progress'::"public"."workqueue_status", 'blocked'::"public"."workqueue_status"])));



CREATE INDEX "idx_workqueue_items_professional_claim_id" ON "public"."workqueue_items" USING "btree" ("professional_claim_id") WHERE ("professional_claim_id" IS NOT NULL);



CREATE INDEX "idx_workqueue_org_source" ON "public"."workqueue_items" USING "btree" ("organization_id", "source_object_type", "source_object_id");



CREATE INDEX "idx_workqueue_org_status" ON "public"."workqueue_items" USING "btree" ("organization_id", "status", "priority");



CREATE INDEX "idx_workqueue_status" ON "public"."workqueue_items" USING "btree" ("status");



CREATE INDEX "idx_workqueue_type" ON "public"."workqueue_items" USING "btree" ("work_type");



CREATE UNIQUE INDEX "insurance_payers_org_payer_id_uidx" ON "public"."insurance_payers" USING "btree" ("organization_id", "payer_id") WHERE ("archived_at" IS NULL);



CREATE INDEX "insurance_policies_payer_id_fkey_idx" ON "public"."insurance_policies" USING "btree" ("payer_id");



CREATE INDEX "insurance_policies_subscriber_id_fkey_idx" ON "public"."insurance_policies" USING "btree" ("subscriber_id");



CREATE UNIQUE INDEX "organization_members_org_user_uidx" ON "public"."organization_members" USING "btree" ("organization_id", "user_id") WHERE (("ended_at" IS NULL) AND ("archived_at" IS NULL));



CREATE INDEX "patient_checkin_goal_selections_client_id_fkey_idx" ON "public"."patient_checkin_goal_selections" USING "btree" ("client_id");



CREATE INDEX "patient_checkin_goal_selections_organization_id_fkey_idx" ON "public"."patient_checkin_goal_selections" USING "btree" ("organization_id");



CREATE INDEX "patient_checkins_encounter_id_fkey_idx" ON "public"."patient_checkins" USING "btree" ("encounter_id");



CREATE INDEX "patient_import_batches_organization_id_fkey_idx" ON "public"."patient_import_batches" USING "btree" ("organization_id");



CREATE INDEX "patient_import_items_batch_id_fkey_idx" ON "public"."patient_import_items" USING "btree" ("batch_id");



CREATE INDEX "patient_import_items_matched_client_id_fkey_idx" ON "public"."patient_import_items" USING "btree" ("matched_client_id");



CREATE INDEX "patient_import_items_organization_id_fkey_idx" ON "public"."patient_import_items" USING "btree" ("organization_id");



CREATE INDEX "payment_import_batches_organization_id_fkey_idx" ON "public"."payment_import_batches" USING "btree" ("organization_id");



CREATE INDEX "payment_import_items_claim_id_fkey_idx" ON "public"."payment_import_items" USING "btree" ("claim_id");



CREATE INDEX "payment_import_items_client_id_fkey_idx" ON "public"."payment_import_items" USING "btree" ("client_id");



CREATE INDEX "payment_import_items_organization_id_fkey_idx" ON "public"."payment_import_items" USING "btree" ("organization_id");



CREATE INDEX "payment_import_items_payer_id_fkey_idx" ON "public"."payment_import_items" USING "btree" ("payer_id");



CREATE INDEX "payment_posting_allocations_claim_id_fkey_idx" ON "public"."payment_posting_allocations" USING "btree" ("claim_id");



CREATE INDEX "payment_posting_allocations_claim_service_line_id_fkey_idx" ON "public"."payment_posting_allocations" USING "btree" ("claim_service_line_id");



CREATE INDEX "payment_posting_allocations_client_id_fkey_idx" ON "public"."payment_posting_allocations" USING "btree" ("client_id");



CREATE INDEX "payment_posting_allocations_encounter_id_fkey_idx" ON "public"."payment_posting_allocations" USING "btree" ("encounter_id");



CREATE INDEX "payment_posting_allocations_organization_id_fkey_idx" ON "public"."payment_posting_allocations" USING "btree" ("organization_id");



CREATE INDEX "payment_posting_allocations_payment_posting_id_fkey_idx" ON "public"."payment_posting_allocations" USING "btree" ("payment_posting_id");



CREATE INDEX "payment_postings_payment_import_item_id_fkey_idx" ON "public"."payment_postings" USING "btree" ("payment_import_item_id");



CREATE UNIQUE INDEX "providers_org_npi_uidx" ON "public"."providers" USING "btree" ("organization_id", "npi") WHERE (("npi" IS NOT NULL) AND ("archived_at" IS NULL));



CREATE INDEX "providers_organization_id_fkey_idx" ON "public"."providers" USING "btree" ("organization_id");



CREATE INDEX "providers_user_id_fkey_idx" ON "public"."providers" USING "btree" ("user_id");



CREATE INDEX "support_ticket_comments_organization_id_fkey_idx" ON "public"."support_ticket_comments" USING "btree" ("organization_id");



CREATE INDEX "support_ticket_comments_support_ticket_id_fkey_idx" ON "public"."support_ticket_comments" USING "btree" ("support_ticket_id");



CREATE INDEX "support_tickets_organization_id_fkey_idx" ON "public"."support_tickets" USING "btree" ("organization_id");



CREATE INDEX "support_tickets_workqueue_item_id_fkey_idx" ON "public"."support_tickets" USING "btree" ("workqueue_item_id");



CREATE INDEX "telehealth_participants_client_id_fkey_idx" ON "public"."telehealth_participants" USING "btree" ("client_id");



CREATE INDEX "telehealth_participants_organization_id_fkey_idx" ON "public"."telehealth_participants" USING "btree" ("organization_id");



CREATE INDEX "telehealth_sessions_encounter_id_fkey_idx" ON "public"."telehealth_sessions" USING "btree" ("encounter_id");



CREATE INDEX "telehealth_sessions_provider_id_fkey_idx" ON "public"."telehealth_sessions" USING "btree" ("provider_id");



CREATE UNIQUE INDEX "uniq_active_eligibility_per_appt" ON "public"."eligibility_checks" USING "btree" ("appointment_id") WHERE ("archived_at" IS NULL);



CREATE UNIQUE INDEX "uniq_vcc_reference" ON "public"."vcc_payments" USING "btree" ("reference_number") WHERE ("reference_number" IS NOT NULL);



CREATE UNIQUE INDEX "unique_payer_per_org" ON "public"."payer_configurations" USING "btree" (COALESCE("organization_id", '00000000-0000-0000-0000-000000000000'::"uuid"), "payer_id");



CREATE UNIQUE INDEX "uq_encounter_dx_sequence" ON "public"."encounter_diagnoses" USING "btree" ("organization_id", "encounter_id", "sequence_number");



CREATE UNIQUE INDEX "uq_encounter_service_sequence" ON "public"."encounter_service_lines" USING "btree" ("organization_id", "encounter_id", "sequence_number");



CREATE UNIQUE INDEX "uq_primary_policy_per_client" ON "public"."insurance_policies" USING "btree" ("organization_id", "client_id") WHERE (("priority" = 'primary'::"public"."insurance_policy_priority") AND ("archived_at" IS NULL));



CREATE UNIQUE INDEX "ux_chat_participants_conversation_user_active" ON "public"."chat_participants" USING "btree" ("organization_id", "conversation_id", "user_id") WHERE ("archived_at" IS NULL);



CREATE UNIQUE INDEX "ux_claim_service_lines_claim_sequence_active" ON "public"."claim_service_lines" USING "btree" ("organization_id", "claim_id", "sequence_number") WHERE ("archived_at" IS NULL);



CREATE UNIQUE INDEX "ux_claim_status_inquiries_org_duplicate_key_active" ON "public"."claim_status_inquiries" USING "btree" ("organization_id", "duplicate_detection_key") WHERE ("archived_at" IS NULL);



CREATE UNIQUE INDEX "ux_claim_submissions_org_duplicate_key_active" ON "public"."claim_submissions" USING "btree" ("organization_id", "duplicate_detection_key") WHERE ("archived_at" IS NULL);



CREATE UNIQUE INDEX "ux_external_attempts_org_transaction_attempt" ON "public"."external_transaction_attempts" USING "btree" ("organization_id", "external_transaction_id", "attempt_number") WHERE ("archived_at" IS NULL);



CREATE UNIQUE INDEX "ux_inbound_email_gmail_message_active" ON "public"."inbound_email_messages" USING "btree" ("organization_id", "gmail_message_id") WHERE ("archived_at" IS NULL);



CREATE UNIQUE INDEX "ux_payment_import_items_org_file_claim_ref" ON "public"."payment_import_items" USING "btree" ("organization_id", "file_hash", "imported_item_ref");



CREATE UNIQUE INDEX "ux_payment_import_items_org_file_hash" ON "public"."payment_import_items" USING "btree" ("organization_id", "file_hash") WHERE ("file_hash" IS NOT NULL);



CREATE UNIQUE INDEX "ux_payment_postings_org_reference_active" ON "public"."payment_postings" USING "btree" ("organization_id", "posting_reference") WHERE ("archived_at" IS NULL);



CREATE INDEX "vcc_payments_client_id_fkey_idx" ON "public"."vcc_payments" USING "btree" ("client_id");



CREATE INDEX "vcc_payments_payment_posting_id_fkey_idx" ON "public"."vcc_payments" USING "btree" ("payment_posting_id");



CREATE INDEX "workqueue_items_claim_id_fkey_idx" ON "public"."workqueue_items" USING "btree" ("claim_id");



CREATE INDEX "workqueue_items_client_id_fkey_idx" ON "public"."workqueue_items" USING "btree" ("client_id");



CREATE INDEX "workqueue_items_encounter_id_fkey_idx" ON "public"."workqueue_items" USING "btree" ("encounter_id");



CREATE INDEX "workqueue_items_org_status_idx" ON "public"."workqueue_items" USING "btree" ("organization_id", "status", "priority", "due_at");



CREATE OR REPLACE TRIGGER "set_updated_at_eligibility" BEFORE UPDATE ON "public"."eligibility_checks" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_updated_at_transactions" BEFORE UPDATE ON "public"."external_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_assert_claim_matches_encounter_and_policy" BEFORE INSERT OR UPDATE OF "organization_id", "encounter_id", "client_id", "insurance_policy_id" ON "public"."claims" FOR EACH ROW EXECUTE FUNCTION "public"."assert_claim_matches_encounter_and_policy"();



CREATE OR REPLACE TRIGGER "trg_assert_encounter_matches_appointment" BEFORE INSERT OR UPDATE OF "organization_id", "appointment_id", "client_id", "provider_id" ON "public"."encounters" FOR EACH ROW EXECUTE FUNCTION "public"."assert_encounter_matches_appointment"();



CREATE OR REPLACE TRIGGER "trg_auto_create_encounter_from_completed_appointment" AFTER UPDATE ON "public"."appointments" FOR EACH ROW EXECUTE FUNCTION "public"."auto_create_encounter_from_completed_appointment"();



CREATE OR REPLACE TRIGGER "trg_custom_app_config_date_changed" BEFORE UPDATE ON "public"."custom_app_config" FOR EACH ROW EXECUTE FUNCTION "public"."set_custom_app_config_date_changed"();



CREATE OR REPLACE TRIGGER "trg_queue_eligibility_check_for_appointment" AFTER INSERT ON "public"."appointments" FOR EACH ROW EXECUTE FUNCTION "public"."queue_eligibility_check_for_appointment"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."appointments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."authorization_or_referrals" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."billing_alerts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."claim_service_lines" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."claim_status_inquiries" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."claim_submissions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."claims" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."client_contacts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."clients" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."eligibility_checks" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."encounter_diagnoses" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."encounter_notes" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."encounter_service_lines" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."encounters" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."external_message_envelopes" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."external_transaction_attempts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."external_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."insurance_payers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."insurance_policies" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."insurance_subscribers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."organization_members" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."organizations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."payment_import_batches" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."payment_import_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."payment_posting_allocations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."payment_postings" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."provider_locations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."providers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."support_ticket_comments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."support_tickets" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_set_updated_at" BEFORE UPDATE ON "public"."workqueue_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_insurance_policy_id_fkey" FOREIGN KEY ("insurance_policy_id") REFERENCES "public"."insurance_policies"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_provider_location_id_fkey" FOREIGN KEY ("provider_location_id") REFERENCES "public"."provider_locations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."appointments"
    ADD CONSTRAINT "appointments_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."authorization_or_referrals"
    ADD CONSTRAINT "authorization_or_referrals_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."authorization_or_referrals"
    ADD CONSTRAINT "authorization_or_referrals_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."authorization_or_referrals"
    ADD CONSTRAINT "authorization_or_referrals_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."authorization_or_referrals"
    ADD CONSTRAINT "authorization_or_referrals_external_transaction_id_fkey" FOREIGN KEY ("external_transaction_id") REFERENCES "public"."external_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."authorization_or_referrals"
    ADD CONSTRAINT "authorization_or_referrals_insurance_policy_id_fkey" FOREIGN KEY ("insurance_policy_id") REFERENCES "public"."insurance_policies"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."authorization_or_referrals"
    ADD CONSTRAINT "authorization_or_referrals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."billing_alerts"
    ADD CONSTRAINT "billing_alerts_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."professional_claims"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."billing_alerts"
    ADD CONSTRAINT "billing_alerts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."billing_alerts"
    ADD CONSTRAINT "billing_alerts_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."billing_alerts"
    ADD CONSTRAINT "billing_alerts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."billing_alerts"
    ADD CONSTRAINT "billing_alerts_workqueue_item_id_fkey" FOREIGN KEY ("workqueue_item_id") REFERENCES "public"."workqueue_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."charge_capture_items"
    ADD CONSTRAINT "charge_capture_items_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."charge_capture_items"
    ADD CONSTRAINT "charge_capture_items_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."charge_capture_items"
    ADD CONSTRAINT "charge_capture_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chat_conversations"
    ADD CONSTRAINT "chat_conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."chat_conversations"
    ADD CONSTRAINT "chat_conversations_related_client_id_fkey" FOREIGN KEY ("related_client_id") REFERENCES "public"."clients"("id");



ALTER TABLE ONLY "public"."chat_conversations"
    ADD CONSTRAINT "chat_conversations_related_workqueue_item_id_fkey" FOREIGN KEY ("related_workqueue_item_id") REFERENCES "public"."workqueue_items"("id");



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."chat_participants"
    ADD CONSTRAINT "chat_participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chat_participants"
    ADD CONSTRAINT "chat_participants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."chat_participants"
    ADD CONSTRAINT "chat_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."claim_837p_batch_claims"
    ADD CONSTRAINT "claim_837p_batch_claims_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."claim_837p_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claim_837p_batch_claims"
    ADD CONSTRAINT "claim_837p_batch_claims_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claim_837p_batch_claims"
    ADD CONSTRAINT "claim_837p_batch_claims_professional_claim_id_fkey" FOREIGN KEY ("professional_claim_id") REFERENCES "public"."professional_claims"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claim_837p_batches"
    ADD CONSTRAINT "claim_837p_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claim_parties_snapshot"
    ADD CONSTRAINT "claim_parties_snapshot_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."professional_claims"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claim_service_lines"
    ADD CONSTRAINT "claim_service_lines_organization_claim_fkey" FOREIGN KEY ("organization_id", "claim_id") REFERENCES "public"."claims"("organization_id", "id");



ALTER TABLE ONLY "public"."claim_service_lines"
    ADD CONSTRAINT "claim_service_lines_organization_encounter_service_line_fkey" FOREIGN KEY ("organization_id", "encounter_service_line_id") REFERENCES "public"."encounter_service_lines"("organization_id", "id");



ALTER TABLE ONLY "public"."claim_service_lines"
    ADD CONSTRAINT "claim_service_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."claim_status_events"
    ADD CONSTRAINT "claim_status_events_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."professional_claims"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claim_status_inquiries"
    ADD CONSTRAINT "claim_status_inquiries_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."claim_status_inquiries"
    ADD CONSTRAINT "claim_status_inquiries_external_transaction_id_fkey" FOREIGN KEY ("external_transaction_id") REFERENCES "public"."external_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."claim_status_inquiries"
    ADD CONSTRAINT "claim_status_inquiries_organization_claim_fkey" FOREIGN KEY ("organization_id", "claim_id") REFERENCES "public"."claims"("organization_id", "id");



ALTER TABLE ONLY "public"."claim_status_inquiries"
    ADD CONSTRAINT "claim_status_inquiries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."claim_submissions"
    ADD CONSTRAINT "claim_submissions_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."claim_submissions"
    ADD CONSTRAINT "claim_submissions_external_transaction_id_fkey" FOREIGN KEY ("external_transaction_id") REFERENCES "public"."external_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."claim_submissions"
    ADD CONSTRAINT "claim_submissions_organization_claim_fkey" FOREIGN KEY ("organization_id", "claim_id") REFERENCES "public"."claims"("organization_id", "id");



ALTER TABLE ONLY "public"."claim_submissions"
    ADD CONSTRAINT "claim_submissions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."claim_workqueue_items"
    ADD CONSTRAINT "claim_workqueue_items_billing_alert_id_fkey" FOREIGN KEY ("billing_alert_id") REFERENCES "public"."billing_alerts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."claim_workqueue_items"
    ADD CONSTRAINT "claim_workqueue_items_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."professional_claims"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claim_workqueue_items"
    ADD CONSTRAINT "claim_workqueue_items_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."claim_workqueue_items"
    ADD CONSTRAINT "claim_workqueue_items_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."claim_workqueue_items"
    ADD CONSTRAINT "claim_workqueue_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claims"
    ADD CONSTRAINT "claims_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."claims"
    ADD CONSTRAINT "claims_insurance_policy_id_fkey" FOREIGN KEY ("insurance_policy_id") REFERENCES "public"."insurance_policies"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."claims"
    ADD CONSTRAINT "claims_organization_encounter_fkey" FOREIGN KEY ("organization_id", "encounter_id") REFERENCES "public"."encounters"("organization_id", "id");



ALTER TABLE ONLY "public"."claims"
    ADD CONSTRAINT "claims_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."clearinghouse_response_events"
    ADD CONSTRAINT "clearinghouse_response_events_edi_transaction_id_fkey" FOREIGN KEY ("edi_transaction_id") REFERENCES "public"."edi_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."client_contacts"
    ADD CONSTRAINT "client_contacts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."client_contacts"
    ADD CONSTRAINT "client_contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."client_import_rows"
    ADD CONSTRAINT "client_import_rows_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "public"."client_import_jobs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."coding_suggestions"
    ADD CONSTRAINT "coding_suggestions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coding_suggestions"
    ADD CONSTRAINT "coding_suggestions_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."coding_suggestions"
    ADD CONSTRAINT "coding_suggestions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_links"
    ADD CONSTRAINT "document_links_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_links"
    ADD CONSTRAINT "document_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_mailroom_item_id_fkey" FOREIGN KEY ("mailroom_item_id") REFERENCES "public"."mailroom_items"("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_workqueue_item_id_fkey" FOREIGN KEY ("workqueue_item_id") REFERENCES "public"."workqueue_items"("id");



ALTER TABLE ONLY "public"."edi_acknowledgements"
    ADD CONSTRAINT "edi_acknowledgements_edi_batch_id_fkey" FOREIGN KEY ("edi_batch_id") REFERENCES "public"."edi_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."edi_acknowledgements"
    ADD CONSTRAINT "edi_acknowledgements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."edi_batch_claims"
    ADD CONSTRAINT "edi_batch_claims_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."professional_claims"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."edi_batch_claims"
    ADD CONSTRAINT "edi_batch_claims_edi_batch_id_fkey" FOREIGN KEY ("edi_batch_id") REFERENCES "public"."edi_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."edi_batches"
    ADD CONSTRAINT "edi_batches_clearinghouse_connection_id_fkey" FOREIGN KEY ("clearinghouse_connection_id") REFERENCES "public"."clearinghouse_connections"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."edi_batches"
    ADD CONSTRAINT "edi_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."edi_transactions"
    ADD CONSTRAINT "edi_transactions_clearinghouse_connection_id_fkey" FOREIGN KEY ("clearinghouse_connection_id") REFERENCES "public"."clearinghouse_connections"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."eligibility_checks"
    ADD CONSTRAINT "eligibility_checks_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."eligibility_checks"
    ADD CONSTRAINT "eligibility_checks_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."eligibility_checks"
    ADD CONSTRAINT "eligibility_checks_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."eligibility_checks"
    ADD CONSTRAINT "eligibility_checks_external_transaction_id_fkey" FOREIGN KEY ("external_transaction_id") REFERENCES "public"."external_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."eligibility_checks"
    ADD CONSTRAINT "eligibility_checks_insurance_policy_id_fkey" FOREIGN KEY ("insurance_policy_id") REFERENCES "public"."insurance_policies"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."eligibility_checks"
    ADD CONSTRAINT "eligibility_checks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."eligibility_requests"
    ADD CONSTRAINT "eligibility_requests_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."encounter_clinical_notes"
    ADD CONSTRAINT "encounter_clinical_notes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounter_clinical_notes"
    ADD CONSTRAINT "encounter_clinical_notes_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounter_clinical_notes"
    ADD CONSTRAINT "encounter_clinical_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounter_code_suggestions"
    ADD CONSTRAINT "encounter_code_suggestions_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id");



ALTER TABLE ONLY "public"."encounter_code_suggestions"
    ADD CONSTRAINT "encounter_code_suggestions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id");



ALTER TABLE ONLY "public"."encounter_code_suggestions"
    ADD CONSTRAINT "encounter_code_suggestions_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id");



ALTER TABLE ONLY "public"."encounter_code_suggestions"
    ADD CONSTRAINT "encounter_code_suggestions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."encounter_codes"
    ADD CONSTRAINT "encounter_codes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounter_codes"
    ADD CONSTRAINT "encounter_codes_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounter_codes"
    ADD CONSTRAINT "encounter_codes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounter_diagnoses"
    ADD CONSTRAINT "encounter_diagnoses_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounter_diagnoses"
    ADD CONSTRAINT "encounter_diagnoses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."encounter_notes"
    ADD CONSTRAINT "encounter_notes_amended_from_note_id_fkey" FOREIGN KEY ("amended_from_note_id") REFERENCES "public"."encounter_notes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."encounter_notes"
    ADD CONSTRAINT "encounter_notes_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounter_notes"
    ADD CONSTRAINT "encounter_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."encounter_notes"
    ADD CONSTRAINT "encounter_notes_signed_by_provider_id_fkey" FOREIGN KEY ("signed_by_provider_id") REFERENCES "public"."providers"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."encounter_service_lines"
    ADD CONSTRAINT "encounter_service_lines_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounter_service_lines"
    ADD CONSTRAINT "encounter_service_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."encounter_service_lines"
    ADD CONSTRAINT "encounter_service_lines_rendering_provider_id_fkey" FOREIGN KEY ("rendering_provider_id") REFERENCES "public"."providers"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_organization_appointment_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "public"."appointments"("organization_id", "id");



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."era_claim_payments"
    ADD CONSTRAINT "era_claim_payments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."era_claim_payments"
    ADD CONSTRAINT "era_claim_payments_era_import_batch_id_fkey" FOREIGN KEY ("era_import_batch_id") REFERENCES "public"."era_import_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."era_claim_payments"
    ADD CONSTRAINT "era_claim_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."era_claim_payments"
    ADD CONSTRAINT "era_claim_payments_professional_claim_id_fkey" FOREIGN KEY ("professional_claim_id") REFERENCES "public"."professional_claims"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."era_import_batches"
    ADD CONSTRAINT "era_import_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."era_posting_ledger_entries"
    ADD CONSTRAINT "era_posting_ledger_entries_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."era_posting_ledger_entries"
    ADD CONSTRAINT "era_posting_ledger_entries_era_claim_payment_id_fkey" FOREIGN KEY ("era_claim_payment_id") REFERENCES "public"."era_claim_payments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."era_posting_ledger_entries"
    ADD CONSTRAINT "era_posting_ledger_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."era_posting_ledger_entries"
    ADD CONSTRAINT "era_posting_ledger_entries_professional_claim_id_fkey" FOREIGN KEY ("professional_claim_id") REFERENCES "public"."professional_claims"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."external_message_envelopes"
    ADD CONSTRAINT "external_message_envelopes_external_transaction_attempt_id_fkey" FOREIGN KEY ("external_transaction_attempt_id") REFERENCES "public"."external_transaction_attempts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."external_message_envelopes"
    ADD CONSTRAINT "external_message_envelopes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."external_transaction_attempts"
    ADD CONSTRAINT "external_transaction_attempts_external_transaction_id_fkey" FOREIGN KEY ("external_transaction_id") REFERENCES "public"."external_transactions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."external_transaction_attempts"
    ADD CONSTRAINT "external_transaction_attempts_org_transaction_fkey" FOREIGN KEY ("organization_id", "external_transaction_id") REFERENCES "public"."external_transactions"("organization_id", "id");



ALTER TABLE ONLY "public"."external_transaction_attempts"
    ADD CONSTRAINT "external_transaction_attempts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."external_transactions"
    ADD CONSTRAINT "external_transactions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."fee_schedules"
    ADD CONSTRAINT "fee_schedules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."fee_schedules"
    ADD CONSTRAINT "fee_schedules_payer_contract_id_fkey" FOREIGN KEY ("payer_contract_id") REFERENCES "public"."payer_contracts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."custom_appointment_request"
    ADD CONSTRAINT "fk_custom_appointment_client" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_audit_event"
    ADD CONSTRAINT "fk_custom_audit_client" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."custom_billing_workqueue_comment"
    ADD CONSTRAINT "fk_custom_billing_wq_comment_claim" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_billing_workqueue_comment"
    ADD CONSTRAINT "fk_custom_billing_wq_comment_client" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."custom_billing_workqueue_comment"
    ADD CONSTRAINT "fk_custom_billing_wq_comment_workqueue_item" FOREIGN KEY ("workqueue_item_id") REFERENCES "public"."workqueue_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_client_note"
    ADD CONSTRAINT "fk_custom_client_note_client" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_client_note"
    ADD CONSTRAINT "fk_custom_client_note_type" FOREIGN KEY ("note_type_id") REFERENCES "public"."custom_note_type"("note_type_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."custom_client_profile"
    ADD CONSTRAINT "fk_custom_client_profile_client" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_client_program"
    ADD CONSTRAINT "fk_custom_client_program_client" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_client_document"
    ADD CONSTRAINT "fk_custom_document_client" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_client_import_staging"
    ADD CONSTRAINT "fk_custom_import_matched_client" FOREIGN KEY ("matched_client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."custom_invoice"
    ADD CONSTRAINT "fk_custom_invoice_client" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_invoice_line_item"
    ADD CONSTRAINT "fk_custom_invoice_line_invoice" FOREIGN KEY ("invoice_id") REFERENCES "public"."custom_invoice"("invoice_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_invoice_line_item"
    ADD CONSTRAINT "fk_custom_invoice_line_service" FOREIGN KEY ("billing_service_id") REFERENCES "public"."custom_billing_service"("billing_service_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."custom_payment"
    ADD CONSTRAINT "fk_custom_payment_client" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_payment"
    ADD CONSTRAINT "fk_custom_payment_invoice" FOREIGN KEY ("invoice_id") REFERENCES "public"."custom_invoice"("invoice_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gmail_oauth_tokens"
    ADD CONSTRAINT "gmail_oauth_tokens_integration_connection_id_fkey" FOREIGN KEY ("integration_connection_id") REFERENCES "public"."integration_connections"("id");



ALTER TABLE ONLY "public"."gmail_oauth_tokens"
    ADD CONSTRAINT "gmail_oauth_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."inbound_email_messages"
    ADD CONSTRAINT "inbound_email_messages_integration_connection_id_fkey" FOREIGN KEY ("integration_connection_id") REFERENCES "public"."integration_connections"("id");



ALTER TABLE ONLY "public"."inbound_email_messages"
    ADD CONSTRAINT "inbound_email_messages_mailroom_item_id_fkey" FOREIGN KEY ("mailroom_item_id") REFERENCES "public"."mailroom_items"("id");



ALTER TABLE ONLY "public"."inbound_email_messages"
    ADD CONSTRAINT "inbound_email_messages_matched_client_id_fkey" FOREIGN KEY ("matched_client_id") REFERENCES "public"."clients"("id");



ALTER TABLE ONLY "public"."inbound_email_messages"
    ADD CONSTRAINT "inbound_email_messages_matched_profile_id_fkey" FOREIGN KEY ("matched_profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."inbound_email_messages"
    ADD CONSTRAINT "inbound_email_messages_matched_provider_id_fkey" FOREIGN KEY ("matched_provider_id") REFERENCES "public"."providers"("id");



ALTER TABLE ONLY "public"."inbound_email_messages"
    ADD CONSTRAINT "inbound_email_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."inbound_email_messages"
    ADD CONSTRAINT "inbound_email_messages_workqueue_item_id_fkey" FOREIGN KEY ("workqueue_item_id") REFERENCES "public"."workqueue_items"("id");



ALTER TABLE ONLY "public"."insurance_payers"
    ADD CONSTRAINT "insurance_payers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."insurance_policies"
    ADD CONSTRAINT "insurance_policies_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."insurance_policies"
    ADD CONSTRAINT "insurance_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."insurance_policies"
    ADD CONSTRAINT "insurance_policies_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "public"."insurance_payers"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."insurance_policies"
    ADD CONSTRAINT "insurance_policies_subscriber_id_fkey" FOREIGN KEY ("subscriber_id") REFERENCES "public"."insurance_subscribers"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."insurance_subscribers"
    ADD CONSTRAINT "insurance_subscribers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."integration_connections"
    ADD CONSTRAINT "integration_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mailroom_items"
    ADD CONSTRAINT "mailroom_items_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id");



ALTER TABLE ONLY "public"."mailroom_items"
    ADD CONSTRAINT "mailroom_items_filed_client_id_fkey" FOREIGN KEY ("filed_client_id") REFERENCES "public"."clients"("id");



ALTER TABLE ONLY "public"."mailroom_items"
    ADD CONSTRAINT "mailroom_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."mailroom_items"
    ADD CONSTRAINT "mailroom_items_routed_to_workqueue_id_fkey" FOREIGN KEY ("routed_to_workqueue_id") REFERENCES "public"."workqueue_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."mailroom_items"
    ADD CONSTRAINT "mailroom_items_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."mailroom_items"
    ADD CONSTRAINT "mailroom_items_workqueue_item_id_fkey" FOREIGN KEY ("workqueue_item_id") REFERENCES "public"."workqueue_items"("id");



ALTER TABLE ONLY "public"."notification_rules"
    ADD CONSTRAINT "notification_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organization_members"
    ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."patient_balances"
    ADD CONSTRAINT "patient_balances_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_balances"
    ADD CONSTRAINT "patient_balances_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_check_ins"
    ADD CONSTRAINT "patient_check_ins_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_check_ins"
    ADD CONSTRAINT "patient_check_ins_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_check_ins"
    ADD CONSTRAINT "patient_check_ins_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_check_ins"
    ADD CONSTRAINT "patient_check_ins_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_checkin_goal_selections"
    ADD CONSTRAINT "patient_checkin_goal_selections_checkin_id_fkey" FOREIGN KEY ("checkin_id") REFERENCES "public"."patient_checkins"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_checkin_goal_selections"
    ADD CONSTRAINT "patient_checkin_goal_selections_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id");



ALTER TABLE ONLY "public"."patient_checkin_goal_selections"
    ADD CONSTRAINT "patient_checkin_goal_selections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."patient_checkins"
    ADD CONSTRAINT "patient_checkins_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id");



ALTER TABLE ONLY "public"."patient_checkins"
    ADD CONSTRAINT "patient_checkins_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id");



ALTER TABLE ONLY "public"."patient_checkins"
    ADD CONSTRAINT "patient_checkins_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id");



ALTER TABLE ONLY "public"."patient_checkins"
    ADD CONSTRAINT "patient_checkins_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."patient_contacts"
    ADD CONSTRAINT "patient_contacts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_contacts"
    ADD CONSTRAINT "patient_contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_diagnoses"
    ADD CONSTRAINT "patient_diagnoses_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_diagnoses"
    ADD CONSTRAINT "patient_diagnoses_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_diagnoses"
    ADD CONSTRAINT "patient_diagnoses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_import_batches"
    ADD CONSTRAINT "patient_import_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."patient_import_items"
    ADD CONSTRAINT "patient_import_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."patient_import_batches"("id");



ALTER TABLE ONLY "public"."patient_import_items"
    ADD CONSTRAINT "patient_import_items_matched_client_id_fkey" FOREIGN KEY ("matched_client_id") REFERENCES "public"."clients"("id");



ALTER TABLE ONLY "public"."patient_import_items"
    ADD CONSTRAINT "patient_import_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."patient_invoice_payments"
    ADD CONSTRAINT "patient_invoice_payments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_invoice_payments"
    ADD CONSTRAINT "patient_invoice_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_invoice_payments"
    ADD CONSTRAINT "patient_invoice_payments_patient_invoice_id_fkey" FOREIGN KEY ("patient_invoice_id") REFERENCES "public"."patient_invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_invoices"
    ADD CONSTRAINT "patient_invoices_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_invoices"
    ADD CONSTRAINT "patient_invoices_era_claim_payment_id_fkey" FOREIGN KEY ("era_claim_payment_id") REFERENCES "public"."era_claim_payments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_invoices"
    ADD CONSTRAINT "patient_invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_invoices"
    ADD CONSTRAINT "patient_invoices_professional_claim_id_fkey" FOREIGN KEY ("professional_claim_id") REFERENCES "public"."professional_claims"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payer_contracts"
    ADD CONSTRAINT "payer_contracts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payer_contracts"
    ADD CONSTRAINT "payer_contracts_payer_profile_id_fkey" FOREIGN KEY ("payer_profile_id") REFERENCES "public"."payer_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payer_plans"
    ADD CONSTRAINT "payer_plans_insurance_payer_id_fkey" FOREIGN KEY ("insurance_payer_id") REFERENCES "public"."insurance_payers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payer_plans"
    ADD CONSTRAINT "payer_plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payer_plans"
    ADD CONSTRAINT "payer_plans_payer_profile_id_fkey" FOREIGN KEY ("payer_profile_id") REFERENCES "public"."payer_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payer_profiles"
    ADD CONSTRAINT "payer_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_import_batches"
    ADD CONSTRAINT "payment_import_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."payment_import_items"
    ADD CONSTRAINT "payment_import_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."payment_import_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_import_items"
    ADD CONSTRAINT "payment_import_items_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."payment_import_items"
    ADD CONSTRAINT "payment_import_items_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."payment_import_items"
    ADD CONSTRAINT "payment_import_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."payment_import_items"
    ADD CONSTRAINT "payment_import_items_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "public"."insurance_payers"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."payment_posting_allocations"
    ADD CONSTRAINT "payment_posting_allocations_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."payment_posting_allocations"
    ADD CONSTRAINT "payment_posting_allocations_claim_service_line_id_fkey" FOREIGN KEY ("claim_service_line_id") REFERENCES "public"."claim_service_lines"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."payment_posting_allocations"
    ADD CONSTRAINT "payment_posting_allocations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."payment_posting_allocations"
    ADD CONSTRAINT "payment_posting_allocations_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."payment_posting_allocations"
    ADD CONSTRAINT "payment_posting_allocations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."payment_posting_allocations"
    ADD CONSTRAINT "payment_posting_allocations_payment_posting_id_fkey" FOREIGN KEY ("payment_posting_id") REFERENCES "public"."payment_postings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_postings"
    ADD CONSTRAINT "payment_postings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."payment_postings"
    ADD CONSTRAINT "payment_postings_payment_import_item_id_fkey" FOREIGN KEY ("payment_import_item_id") REFERENCES "public"."payment_import_items"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."professional_claim_service_lines"
    ADD CONSTRAINT "professional_claim_service_lines_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."professional_claims"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."professional_claims"
    ADD CONSTRAINT "professional_claims_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."professional_claims"
    ADD CONSTRAINT "professional_claims_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."professional_claims"
    ADD CONSTRAINT "professional_claims_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."professional_claims"
    ADD CONSTRAINT "professional_claims_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."professional_claims"
    ADD CONSTRAINT "professional_claims_payer_profile_id_fkey" FOREIGN KEY ("payer_profile_id") REFERENCES "public"."payer_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."provider_credentialing_profiles"
    ADD CONSTRAINT "provider_credentialing_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_locations"
    ADD CONSTRAINT "provider_locations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."provider_locations"
    ADD CONSTRAINT "provider_locations_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_payer_enrollments"
    ADD CONSTRAINT "provider_payer_enrollments_credentialing_profile_id_fkey" FOREIGN KEY ("credentialing_profile_id") REFERENCES "public"."provider_credentialing_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."provider_payer_enrollments"
    ADD CONSTRAINT "provider_payer_enrollments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_payer_enrollments"
    ADD CONSTRAINT "provider_payer_enrollments_payer_profile_id_fkey" FOREIGN KEY ("payer_profile_id") REFERENCES "public"."payer_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."provider_payer_enrollments"
    ADD CONSTRAINT "provider_payer_enrollments_provider_profile_id_fkey" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_profiles"
    ADD CONSTRAINT "provider_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."providers"
    ADD CONSTRAINT "providers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."service_locations"
    ADD CONSTRAINT "service_locations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."smart_phrases"
    ADD CONSTRAINT "smart_phrases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."support_ticket_comments"
    ADD CONSTRAINT "support_ticket_comments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."support_ticket_comments"
    ADD CONSTRAINT "support_ticket_comments_support_ticket_id_fkey" FOREIGN KEY ("support_ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_workqueue_item_id_fkey" FOREIGN KEY ("workqueue_item_id") REFERENCES "public"."workqueue_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."system_settings"
    ADD CONSTRAINT "system_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telehealth_participants"
    ADD CONSTRAINT "telehealth_participants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id");



ALTER TABLE ONLY "public"."telehealth_participants"
    ADD CONSTRAINT "telehealth_participants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."telehealth_participants"
    ADD CONSTRAINT "telehealth_participants_telehealth_session_id_fkey" FOREIGN KEY ("telehealth_session_id") REFERENCES "public"."telehealth_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telehealth_sessions"
    ADD CONSTRAINT "telehealth_sessions_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id");



ALTER TABLE ONLY "public"."telehealth_sessions"
    ADD CONSTRAINT "telehealth_sessions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id");



ALTER TABLE ONLY "public"."telehealth_sessions"
    ADD CONSTRAINT "telehealth_sessions_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id");



ALTER TABLE ONLY "public"."telehealth_sessions"
    ADD CONSTRAINT "telehealth_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."telehealth_sessions"
    ADD CONSTRAINT "telehealth_sessions_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id");



ALTER TABLE ONLY "public"."ticket_comments"
    ADD CONSTRAINT "ticket_comments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ticket_comments"
    ADD CONSTRAINT "ticket_comments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tickets"
    ADD CONSTRAINT "tickets_billing_alert_id_fkey" FOREIGN KEY ("billing_alert_id") REFERENCES "public"."billing_alerts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tickets"
    ADD CONSTRAINT "tickets_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."professional_claims"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tickets"
    ADD CONSTRAINT "tickets_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tickets"
    ADD CONSTRAINT "tickets_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tickets"
    ADD CONSTRAINT "tickets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tickets"
    ADD CONSTRAINT "tickets_workqueue_item_id_fkey" FOREIGN KEY ("workqueue_item_id") REFERENCES "public"."workqueue_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."treatment_plan_goals"
    ADD CONSTRAINT "treatment_plan_goals_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."treatment_plan_goals"
    ADD CONSTRAINT "treatment_plan_goals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."treatment_plan_goals"
    ADD CONSTRAINT "treatment_plan_goals_treatment_plan_id_fkey" FOREIGN KEY ("treatment_plan_id") REFERENCES "public"."treatment_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."treatment_plans"
    ADD CONSTRAINT "treatment_plans_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."treatment_plans"
    ADD CONSTRAINT "treatment_plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."treatment_plans"
    ADD CONSTRAINT "treatment_plans_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."provider_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_presence"
    ADD CONSTRAINT "user_presence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."vcc_payments"
    ADD CONSTRAINT "vcc_payments_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id");



ALTER TABLE ONLY "public"."vcc_payments"
    ADD CONSTRAINT "vcc_payments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id");



ALTER TABLE ONLY "public"."vcc_payments"
    ADD CONSTRAINT "vcc_payments_mailroom_item_id_fkey" FOREIGN KEY ("mailroom_item_id") REFERENCES "public"."mailroom_items"("id");



ALTER TABLE ONLY "public"."vcc_payments"
    ADD CONSTRAINT "vcc_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."vcc_payments"
    ADD CONSTRAINT "vcc_payments_payment_posting_id_fkey" FOREIGN KEY ("payment_posting_id") REFERENCES "public"."payment_postings"("id");



ALTER TABLE ONLY "public"."workqueue_item_comments"
    ADD CONSTRAINT "workqueue_item_comments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workqueue_item_comments"
    ADD CONSTRAINT "workqueue_item_comments_workqueue_item_id_fkey" FOREIGN KEY ("workqueue_item_id") REFERENCES "public"."workqueue_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workqueue_items"
    ADD CONSTRAINT "workqueue_items_billing_alert_id_fkey" FOREIGN KEY ("billing_alert_id") REFERENCES "public"."billing_alerts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."workqueue_items"
    ADD CONSTRAINT "workqueue_items_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."workqueue_items"
    ADD CONSTRAINT "workqueue_items_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."workqueue_items"
    ADD CONSTRAINT "workqueue_items_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."workqueue_items"
    ADD CONSTRAINT "workqueue_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."workqueue_items"
    ADD CONSTRAINT "workqueue_items_professional_claim_id_fkey" FOREIGN KEY ("professional_claim_id") REFERENCES "public"."professional_claims"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."workqueue_items"
    ADD CONSTRAINT "workqueue_items_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE SET NULL;



CREATE POLICY "Admins can update all profiles" ON "public"."profiles" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))));



CREATE POLICY "Admins can view all profiles" ON "public"."profiles" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))));



CREATE POLICY "Users can update their own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can view their own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));



ALTER TABLE "public"."appointments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "appointments_org_member_select" ON "public"."appointments" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_logs_org_policy" ON "public"."audit_logs" TO "authenticated" USING ((("organization_id" IS NULL) OR (("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))));



ALTER TABLE "public"."authorization_or_referrals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "authorization_or_referrals_billing_insert" ON "public"."authorization_or_referrals" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text", 'clinician'::"text"]));



CREATE POLICY "authorization_or_referrals_billing_update" ON "public"."authorization_or_referrals" FOR UPDATE TO "authenticated" USING ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text", 'clinician'::"text"])) WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text", 'clinician'::"text"]));



CREATE POLICY "authorization_or_referrals_org_member_select" ON "public"."authorization_or_referrals" FOR SELECT TO "authenticated" USING ((("archived_at" IS NULL) AND "public"."is_org_member"("organization_id")));



ALTER TABLE "public"."availity_transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "availity_transactions_org_policy" ON "public"."availity_transactions" TO "authenticated" USING ((("organization_id" IS NULL) OR (("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")))) WITH CHECK ((("organization_id" IS NULL) OR (("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))));



ALTER TABLE "public"."billing_alerts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "billing_alerts_org_policy" ON "public"."billing_alerts" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."charge_capture_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "charge_capture_items_org_policy" ON "public"."charge_capture_items" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."chat_conversations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chat_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chat_participants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claim_837p_batch_claims" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "claim_837p_batch_claims_org_policy" ON "public"."claim_837p_batch_claims" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."claim_837p_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "claim_837p_batches_org_policy" ON "public"."claim_837p_batches" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."claim_parties_snapshot" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "claim_parties_snapshot_org_member_select" ON "public"."claim_parties_snapshot" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."professional_claims" "pc"
  WHERE (("pc"."id" = "claim_parties_snapshot"."claim_id") AND "public"."is_current_user_org_member"("pc"."organization_id")))));



ALTER TABLE "public"."claim_service_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claim_status_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "claim_status_events_org_member_select" ON "public"."claim_status_events" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."professional_claims" "pc"
  WHERE (("pc"."id" = "claim_status_events"."claim_id") AND "public"."is_current_user_org_member"("pc"."organization_id")))));



ALTER TABLE "public"."claim_status_inquiries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "claim_status_inquiries_billing_insert" ON "public"."claim_status_inquiries" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"]));



CREATE POLICY "claim_status_inquiries_billing_update" ON "public"."claim_status_inquiries" FOR UPDATE TO "authenticated" USING ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"])) WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"]));



CREATE POLICY "claim_status_inquiries_org_member_select" ON "public"."claim_status_inquiries" FOR SELECT TO "authenticated" USING ((("archived_at" IS NULL) AND "public"."is_org_member"("organization_id")));



CREATE POLICY "claim_status_inquiries_org_policy" ON "public"."claim_status_inquiries" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."claim_submissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "claim_submissions_billing_insert" ON "public"."claim_submissions" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"]));



CREATE POLICY "claim_submissions_billing_update" ON "public"."claim_submissions" FOR UPDATE TO "authenticated" USING ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"])) WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"]));



CREATE POLICY "claim_submissions_org_member_select" ON "public"."claim_submissions" FOR SELECT TO "authenticated" USING ((("archived_at" IS NULL) AND "public"."is_org_member"("organization_id")));



ALTER TABLE "public"."claim_workqueue_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "claim_workqueue_items_org_policy" ON "public"."claim_workqueue_items" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."claims" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clearinghouse_connections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "clearinghouse_connections_org_policy" ON "public"."clearinghouse_connections" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."clearinghouse_response_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "clearinghouse_response_events_org_policy" ON "public"."clearinghouse_response_events" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."client_contacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "client_contacts_org_member_select" ON "public"."client_contacts" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."client_import_jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "client_import_jobs_org_policy" ON "public"."client_import_jobs" TO "authenticated" USING ((("organization_id" IS NULL) OR (("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ("auth"."jwt"() ->> 'org_id'::"text"), ''::"text")))) WITH CHECK ((("organization_id" IS NULL) OR (("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ("auth"."jwt"() ->> 'org_id'::"text"), ''::"text"))));



CREATE POLICY "client_import_jobs_service_role_policy" ON "public"."client_import_jobs" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."client_import_rows" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "client_import_rows_org_policy" ON "public"."client_import_rows" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."client_import_jobs" "jobs"
  WHERE (("jobs"."id" = "client_import_rows"."import_job_id") AND (("jobs"."organization_id" IS NULL) OR (("jobs"."organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ("auth"."jwt"() ->> 'org_id'::"text"), ''::"text"))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."client_import_jobs" "jobs"
  WHERE (("jobs"."id" = "client_import_rows"."import_job_id") AND (("jobs"."organization_id" IS NULL) OR (("jobs"."organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ("auth"."jwt"() ->> 'org_id'::"text"), ''::"text")))))));



CREATE POLICY "client_import_rows_service_role_policy" ON "public"."client_import_rows" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."clients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "clients_select_authenticated" ON "public"."clients" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "clients_select_public" ON "public"."clients" FOR SELECT TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."coding_suggestions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "coding_suggestions_org_policy" ON "public"."coding_suggestions" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."custom_app_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_appointment_request" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_audit_event" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_billing_service" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_billing_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_billing_workqueue_comment" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_client_document" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_client_import_staging" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_client_note" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_client_profile" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_client_program" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_invoice" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_invoice_line_item" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_lookup_value" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_note_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_note_type" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_payment" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dashboard_user_preferences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dashboard_user_preferences_org_policy" ON "public"."dashboard_user_preferences" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."dashboard_widgets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dashboard_widgets_org_policy" ON "public"."dashboard_widgets" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."diagnosis_codes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "diagnosis_codes_read" ON "public"."diagnosis_codes" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."document_links" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "document_links_org_policy" ON "public"."document_links" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "documents_org_policy" ON "public"."documents" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."edi_acknowledgements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "edi_acknowledgements_org_policy" ON "public"."edi_acknowledgements" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."edi_batch_claims" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "edi_batch_claims_org_policy" ON "public"."edi_batch_claims" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM ("public"."edi_batches" "eb"
     JOIN "public"."professional_claims" "pc" ON (("pc"."id" = "edi_batch_claims"."claim_id")))
  WHERE (("eb"."id" = "edi_batch_claims"."edi_batch_id") AND (("eb"."organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")) AND (("pc"."organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."edi_batches" "eb"
     JOIN "public"."professional_claims" "pc" ON (("pc"."id" = "edi_batch_claims"."claim_id")))
  WHERE (("eb"."id" = "edi_batch_claims"."edi_batch_id") AND (("eb"."organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")) AND (("pc"."organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))))));



ALTER TABLE "public"."edi_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "edi_batches_org_policy" ON "public"."edi_batches" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."edi_transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "edi_transactions_org_policy" ON "public"."edi_transactions" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."eligibility_checks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "eligibility_checks_billing_insert" ON "public"."eligibility_checks" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text", 'clinician'::"text"]));



CREATE POLICY "eligibility_checks_billing_update" ON "public"."eligibility_checks" FOR UPDATE TO "authenticated" USING ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text", 'clinician'::"text"])) WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text", 'clinician'::"text"]));



CREATE POLICY "eligibility_checks_org_member_select" ON "public"."eligibility_checks" FOR SELECT TO "authenticated" USING ((("archived_at" IS NULL) AND "public"."is_org_member"("organization_id")));



CREATE POLICY "eligibility_checks_org_policy" ON "public"."eligibility_checks" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."eligibility_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "eligibility_requests_org_policy" ON "public"."eligibility_requests" TO "authenticated" USING ((("organization_id" IS NULL) OR (("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ("auth"."jwt"() ->> 'org_id'::"text"), ''::"text")))) WITH CHECK ((("organization_id" IS NULL) OR (("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ("auth"."jwt"() ->> 'org_id'::"text"), ''::"text"))));



ALTER TABLE "public"."encounter_clinical_notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "encounter_clinical_notes_org_policy" ON "public"."encounter_clinical_notes" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."encounter_code_suggestions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "encounter_code_suggestions_org_member_select" ON "public"."encounter_code_suggestions" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."encounter_codes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "encounter_codes_org_policy" ON "public"."encounter_codes" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."encounter_diagnoses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "encounter_diagnoses_org_member_select" ON "public"."encounter_diagnoses" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."encounter_notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "encounter_notes_org_member_select" ON "public"."encounter_notes" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."encounter_service_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "encounter_service_lines_org_member_select" ON "public"."encounter_service_lines" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."encounters" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "encounters_org_member_select" ON "public"."encounters" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."era_claim_payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "era_claim_payments_org_policy" ON "public"."era_claim_payments" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."era_import_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "era_import_batches_org_policy" ON "public"."era_import_batches" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."era_posting_ledger_entries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "era_posting_ledger_entries_org_policy" ON "public"."era_posting_ledger_entries" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."external_message_envelopes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "external_message_envelopes_org_member_select" ON "public"."external_message_envelopes" FOR SELECT TO "authenticated" USING ((("archived_at" IS NULL) AND "public"."is_org_member"("organization_id")));



ALTER TABLE "public"."external_transaction_attempts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "external_transaction_attempts_org_member_select" ON "public"."external_transaction_attempts" FOR SELECT TO "authenticated" USING ((("archived_at" IS NULL) AND "public"."is_org_member"("organization_id")));



ALTER TABLE "public"."external_transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "external_transactions_billing_insert" ON "public"."external_transactions" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"]));



CREATE POLICY "external_transactions_billing_update" ON "public"."external_transactions" FOR UPDATE TO "authenticated" USING ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"])) WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"]));



CREATE POLICY "external_transactions_org_member_select" ON "public"."external_transactions" FOR SELECT TO "authenticated" USING ((("archived_at" IS NULL) AND "public"."is_org_member"("organization_id")));



ALTER TABLE "public"."fee_schedules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fee_schedules_org_policy" ON "public"."fee_schedules" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."gmail_oauth_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inbound_email_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inbound_email_messages_org_member_select" ON "public"."inbound_email_messages" FOR SELECT TO "authenticated" USING ((("archived_at" IS NULL) AND "public"."is_org_member"("organization_id")));



ALTER TABLE "public"."insurance_payers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insurance_payers_authenticated_select" ON "public"."insurance_payers" FOR SELECT TO "authenticated" USING ((("organization_id" IS NULL) OR "public"."is_current_user_org_member"("organization_id")));



ALTER TABLE "public"."insurance_policies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insurance_policies_org_member_select" ON "public"."insurance_policies" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."insurance_subscribers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insurance_subscribers_org_member_select" ON "public"."insurance_subscribers" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."integration_connections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "integration_connections_admin_write" ON "public"."integration_connections" TO "authenticated" USING ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'supervisor'::"text"])) WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'supervisor'::"text"]));



CREATE POLICY "integration_connections_org_member_select" ON "public"."integration_connections" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organization_id"));



ALTER TABLE "public"."mailroom_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mailroom_items_org_policy" ON "public"."mailroom_items" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."notification_rules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notification_rules_org_member_select" ON "public"."notification_rules" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."operational_alerts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "operational_alerts_org_policy" ON "public"."operational_alerts" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."organization_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "organization_members_self_org_select" ON "public"."organization_members" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR "public"."is_current_user_org_member"("organization_id")));



ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "organizations_org_member_select" ON "public"."organizations" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("id"));



ALTER TABLE "public"."patient_balances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "patient_balances_org_policy" ON "public"."patient_balances" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."patient_check_ins" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "patient_check_ins_org_policy" ON "public"."patient_check_ins" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."patient_checkin_goal_selections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "patient_checkin_goal_selections_org_member_select" ON "public"."patient_checkin_goal_selections" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."patient_checkins" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "patient_checkins_org_member_select" ON "public"."patient_checkins" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."patient_contacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "patient_contacts_org_policy" ON "public"."patient_contacts" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."patient_diagnoses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "patient_diagnoses_org_policy" ON "public"."patient_diagnoses" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."patient_import_batches" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_import_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_invoice_payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "patient_invoice_payments_org_policy" ON "public"."patient_invoice_payments" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."patient_invoices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "patient_invoices_org_policy" ON "public"."patient_invoices" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."payer_configurations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payer_configurations_org_policy" ON "public"."payer_configurations" USING ((("auth"."role"() = 'authenticated'::"text") OR ("auth"."role"() = 'service_role'::"text"))) WITH CHECK ((("auth"."role"() = 'authenticated'::"text") OR ("auth"."role"() = 'service_role'::"text")));



ALTER TABLE "public"."payer_contracts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payer_contracts_org_policy" ON "public"."payer_contracts" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."payer_plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payer_plans_org_policy" ON "public"."payer_plans" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."payer_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payer_profiles_org_member_select" ON "public"."payer_profiles" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."payment_import_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payment_import_batches_billing_insert" ON "public"."payment_import_batches" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"]));



CREATE POLICY "payment_import_batches_billing_update" ON "public"."payment_import_batches" FOR UPDATE TO "authenticated" USING ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"])) WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"]));



CREATE POLICY "payment_import_batches_org_member_select" ON "public"."payment_import_batches" FOR SELECT TO "authenticated" USING ((("archived_at" IS NULL) AND "public"."is_org_member"("organization_id")));



ALTER TABLE "public"."payment_import_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payment_import_items_billing_insert" ON "public"."payment_import_items" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"]));



CREATE POLICY "payment_import_items_billing_update" ON "public"."payment_import_items" FOR UPDATE TO "authenticated" USING ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"])) WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"]));



CREATE POLICY "payment_import_items_org_member_select" ON "public"."payment_import_items" FOR SELECT TO "authenticated" USING ((("archived_at" IS NULL) AND "public"."is_org_member"("organization_id")));



ALTER TABLE "public"."payment_posting_allocations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payment_posting_allocations_org_member_select" ON "public"."payment_posting_allocations" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."payment_postings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payment_postings_billing_insert" ON "public"."payment_postings" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"]));



CREATE POLICY "payment_postings_billing_update" ON "public"."payment_postings" FOR UPDATE TO "authenticated" USING ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"])) WITH CHECK ("public"."has_org_role"("organization_id", ARRAY['admin'::"text", 'biller'::"text", 'supervisor'::"text"]));



CREATE POLICY "payment_postings_org_member_select" ON "public"."payment_postings" FOR SELECT TO "authenticated" USING ((("archived_at" IS NULL) AND "public"."is_org_member"("organization_id")));



ALTER TABLE "public"."professional_claim_service_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "professional_claim_service_lines_org_member_select" ON "public"."professional_claim_service_lines" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."professional_claims" "pc"
  WHERE (("pc"."id" = "professional_claim_service_lines"."claim_id") AND "public"."is_current_user_org_member"("pc"."organization_id")))));



ALTER TABLE "public"."professional_claims" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "professional_claims_org_member_select" ON "public"."professional_claims" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."provider_credentialing_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "provider_credentialing_profiles_org_policy" ON "public"."provider_credentialing_profiles" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."provider_locations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "provider_locations_org_member_select" ON "public"."provider_locations" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."provider_payer_enrollments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "provider_payer_enrollments_org_policy" ON "public"."provider_payer_enrollments" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."provider_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "provider_profiles_org_policy" ON "public"."provider_profiles" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."providers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "providers_org_member_select" ON "public"."providers" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."service_locations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "service_locations_org_policy" ON "public"."service_locations" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."smart_phrases" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "smart_phrases_org_policy" ON "public"."smart_phrases" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."support_ticket_comments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "support_ticket_comments_org_member_select" ON "public"."support_ticket_comments" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."support_tickets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "support_tickets_org_member_select" ON "public"."support_tickets" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."system_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "system_settings_org_policy" ON "public"."system_settings" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."telehealth_participants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "telehealth_participants_org_member_select" ON "public"."telehealth_participants" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."telehealth_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "telehealth_sessions_org_member_select" ON "public"."telehealth_sessions" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."ticket_comments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ticket_comments_org_policy" ON "public"."ticket_comments" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."tickets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tickets_org_policy" ON "public"."tickets" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."treatment_plan_goals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "treatment_plan_goals_org_policy" ON "public"."treatment_plan_goals" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."treatment_plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "treatment_plans_org_policy" ON "public"."treatment_plans" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."user_presence" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vcc_payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vcc_payments_org_member_select" ON "public"."vcc_payments" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."workqueue_item_comments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workqueue_item_comments_org_policy" ON "public"."workqueue_item_comments" TO "authenticated" USING ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text"))) WITH CHECK ((("organization_id")::"text" = COALESCE(("auth"."jwt"() ->> 'organization_id'::"text"), (("auth"."jwt"() -> 'app_metadata'::"text") ->> 'organization_id'::"text"), ''::"text")));



ALTER TABLE "public"."workqueue_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workqueue_items_org_member_select" ON "public"."workqueue_items" FOR SELECT TO "authenticated" USING ("public"."is_current_user_org_member"("organization_id"));



ALTER TABLE "public"."workqueue_type_catalog" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workqueue_type_catalog_read_policy" ON "public"."workqueue_type_catalog" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."your_table" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."apply_updated_at_trigger"("table_name" "regclass") TO "anon";
GRANT ALL ON FUNCTION "public"."apply_updated_at_trigger"("table_name" "regclass") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_updated_at_trigger"("table_name" "regclass") TO "service_role";



GRANT ALL ON FUNCTION "public"."assert_claim_matches_encounter_and_policy"() TO "anon";
GRANT ALL ON FUNCTION "public"."assert_claim_matches_encounter_and_policy"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assert_claim_matches_encounter_and_policy"() TO "service_role";



GRANT ALL ON FUNCTION "public"."assert_encounter_matches_appointment"() TO "anon";
GRANT ALL ON FUNCTION "public"."assert_encounter_matches_appointment"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assert_encounter_matches_appointment"() TO "service_role";



GRANT ALL ON FUNCTION "public"."auto_create_encounter_from_completed_appointment"() TO "anon";
GRANT ALL ON FUNCTION "public"."auto_create_encounter_from_completed_appointment"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_create_encounter_from_completed_appointment"() TO "service_role";



GRANT ALL ON TABLE "public"."external_transactions" TO "anon";
GRANT ALL ON TABLE "public"."external_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."external_transactions" TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_next_external_transaction"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_next_external_transaction"() TO "service_role";



GRANT ALL ON FUNCTION "public"."create_workqueue_item"("org_id" "uuid", "source_type" "text", "source_id" "uuid", "work_type" "text", "title" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_workqueue_item"("org_id" "uuid", "source_type" "text", "source_id" "uuid", "work_type" "text", "title" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_workqueue_item"("org_id" "uuid", "source_type" "text", "source_id" "uuid", "work_type" "text", "title" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_user_org_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_user_org_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_org_ids"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_claim_number"("org_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_claim_number"("org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_claim_number"("org_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_system_readiness_report"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_system_readiness_report"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_system_readiness_report"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."has_org_role"("target_org_id" "uuid", "allowed_roles" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."has_org_role"("target_org_id" "uuid", "allowed_roles" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_org_role"("target_org_id" "uuid", "allowed_roles" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_current_user_org_member"("target_org_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_current_user_org_member"("target_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_current_user_org_member"("target_org_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_org_member"("target_org_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_org_member"("target_org_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_org_member"("target_org_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."mark_external_transaction_failed_retryable"("p_transaction_id" "uuid", "p_error_class" "text", "p_error_cause_code" "text", "p_error_description" "text", "p_retry_after" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_external_transaction_failed_retryable"("p_transaction_id" "uuid", "p_error_class" "text", "p_error_cause_code" "text", "p_error_description" "text", "p_retry_after" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."mark_external_transaction_succeeded"("p_transaction_id" "uuid", "p_raw_response" "text", "p_parsed_response_summary" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_external_transaction_succeeded"("p_transaction_id" "uuid", "p_raw_response" "text", "p_parsed_response_summary" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."queue_eligibility_check_for_appointment"() TO "anon";
GRANT ALL ON FUNCTION "public"."queue_eligibility_check_for_appointment"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."queue_eligibility_check_for_appointment"() TO "service_role";



GRANT ALL ON FUNCTION "public"."queue_stale_eligibility_rechecks"() TO "anon";
GRANT ALL ON FUNCTION "public"."queue_stale_eligibility_rechecks"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."queue_stale_eligibility_rechecks"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."rls_auto_enable"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."route_inbound_gmail_message"("p_organization_id" "uuid", "p_integration_connection_id" "uuid", "p_gmail_message_id" "text", "p_gmail_thread_id" "text", "p_gmail_history_id" "text", "p_from_email" "text", "p_from_name" "text", "p_to_email" "text", "p_subject" "text", "p_snippet" "text", "p_received_at" timestamp with time zone, "p_raw_headers" "jsonb", "p_raw_payload" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."route_inbound_gmail_message"("p_organization_id" "uuid", "p_integration_connection_id" "uuid", "p_gmail_message_id" "text", "p_gmail_thread_id" "text", "p_gmail_history_id" "text", "p_from_email" "text", "p_from_name" "text", "p_to_email" "text", "p_subject" "text", "p_snippet" "text", "p_received_at" timestamp with time zone, "p_raw_headers" "jsonb", "p_raw_payload" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."run_sql"("query_text" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."run_sql"("query_text" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_custom_app_config_date_changed"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_custom_app_config_date_changed"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_custom_app_config_date_changed"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON TABLE "public"."appointments" TO "anon";
GRANT ALL ON TABLE "public"."appointments" TO "authenticated";
GRANT ALL ON TABLE "public"."appointments" TO "service_role";



GRANT ALL ON TABLE "public"."eligibility_checks" TO "anon";
GRANT ALL ON TABLE "public"."eligibility_checks" TO "authenticated";
GRANT ALL ON TABLE "public"."eligibility_checks" TO "service_role";



GRANT ALL ON TABLE "public"."appointment_eligibility_status" TO "anon";
GRANT ALL ON TABLE "public"."appointment_eligibility_status" TO "authenticated";
GRANT ALL ON TABLE "public"."appointment_eligibility_status" TO "service_role";



GRANT ALL ON TABLE "public"."audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_logs" TO "service_role";



GRANT ALL ON TABLE "public"."authorization_or_referrals" TO "anon";
GRANT ALL ON TABLE "public"."authorization_or_referrals" TO "authenticated";
GRANT ALL ON TABLE "public"."authorization_or_referrals" TO "service_role";



GRANT ALL ON TABLE "public"."availity_transactions" TO "anon";
GRANT ALL ON TABLE "public"."availity_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."availity_transactions" TO "service_role";



GRANT ALL ON TABLE "public"."billing_alerts" TO "anon";
GRANT ALL ON TABLE "public"."billing_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."billing_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."charge_capture_items" TO "anon";
GRANT ALL ON TABLE "public"."charge_capture_items" TO "authenticated";
GRANT ALL ON TABLE "public"."charge_capture_items" TO "service_role";



GRANT ALL ON TABLE "public"."chat_conversations" TO "anon";
GRANT ALL ON TABLE "public"."chat_conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."chat_conversations" TO "service_role";



GRANT ALL ON TABLE "public"."chat_messages" TO "anon";
GRANT ALL ON TABLE "public"."chat_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."chat_messages" TO "service_role";



GRANT ALL ON TABLE "public"."chat_participants" TO "anon";
GRANT ALL ON TABLE "public"."chat_participants" TO "authenticated";
GRANT ALL ON TABLE "public"."chat_participants" TO "service_role";



GRANT ALL ON TABLE "public"."claim_837p_batch_claims" TO "anon";
GRANT ALL ON TABLE "public"."claim_837p_batch_claims" TO "authenticated";
GRANT ALL ON TABLE "public"."claim_837p_batch_claims" TO "service_role";



GRANT ALL ON TABLE "public"."claim_837p_batches" TO "anon";
GRANT ALL ON TABLE "public"."claim_837p_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."claim_837p_batches" TO "service_role";



GRANT ALL ON TABLE "public"."claim_parties_snapshot" TO "anon";
GRANT ALL ON TABLE "public"."claim_parties_snapshot" TO "authenticated";
GRANT ALL ON TABLE "public"."claim_parties_snapshot" TO "service_role";



GRANT ALL ON TABLE "public"."claim_service_lines" TO "anon";
GRANT ALL ON TABLE "public"."claim_service_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."claim_service_lines" TO "service_role";



GRANT ALL ON TABLE "public"."claim_status_inquiries" TO "anon";
GRANT ALL ON TABLE "public"."claim_status_inquiries" TO "authenticated";
GRANT ALL ON TABLE "public"."claim_status_inquiries" TO "service_role";



GRANT ALL ON TABLE "public"."claim_status_checks" TO "anon";
GRANT ALL ON TABLE "public"."claim_status_checks" TO "authenticated";
GRANT ALL ON TABLE "public"."claim_status_checks" TO "service_role";



GRANT ALL ON TABLE "public"."claim_status_events" TO "anon";
GRANT ALL ON TABLE "public"."claim_status_events" TO "authenticated";
GRANT ALL ON TABLE "public"."claim_status_events" TO "service_role";



GRANT ALL ON TABLE "public"."claim_submissions" TO "anon";
GRANT ALL ON TABLE "public"."claim_submissions" TO "authenticated";
GRANT ALL ON TABLE "public"."claim_submissions" TO "service_role";



GRANT ALL ON TABLE "public"."claim_workqueue_items" TO "anon";
GRANT ALL ON TABLE "public"."claim_workqueue_items" TO "authenticated";
GRANT ALL ON TABLE "public"."claim_workqueue_items" TO "service_role";



GRANT ALL ON TABLE "public"."claims" TO "anon";
GRANT ALL ON TABLE "public"."claims" TO "authenticated";
GRANT ALL ON TABLE "public"."claims" TO "service_role";



GRANT ALL ON TABLE "public"."clearinghouse_connections" TO "anon";
GRANT ALL ON TABLE "public"."clearinghouse_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."clearinghouse_connections" TO "service_role";



GRANT ALL ON TABLE "public"."clearinghouse_response_events" TO "anon";
GRANT ALL ON TABLE "public"."clearinghouse_response_events" TO "authenticated";
GRANT ALL ON TABLE "public"."clearinghouse_response_events" TO "service_role";



GRANT ALL ON TABLE "public"."client_contacts" TO "anon";
GRANT ALL ON TABLE "public"."client_contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."client_contacts" TO "service_role";



GRANT ALL ON TABLE "public"."client_import_jobs" TO "anon";
GRANT ALL ON TABLE "public"."client_import_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."client_import_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."client_import_rows" TO "anon";
GRANT ALL ON TABLE "public"."client_import_rows" TO "authenticated";
GRANT ALL ON TABLE "public"."client_import_rows" TO "service_role";



GRANT ALL ON TABLE "public"."clients" TO "anon";
GRANT ALL ON TABLE "public"."clients" TO "authenticated";
GRANT ALL ON TABLE "public"."clients" TO "service_role";



GRANT ALL ON TABLE "public"."coding_suggestions" TO "anon";
GRANT ALL ON TABLE "public"."coding_suggestions" TO "authenticated";
GRANT ALL ON TABLE "public"."coding_suggestions" TO "service_role";



GRANT ALL ON TABLE "public"."custom_app_config" TO "anon";
GRANT ALL ON TABLE "public"."custom_app_config" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_app_config" TO "service_role";



GRANT ALL ON SEQUENCE "public"."custom_app_config_config_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."custom_app_config_config_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."custom_app_config_config_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."custom_appointment_request" TO "anon";
GRANT ALL ON TABLE "public"."custom_appointment_request" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_appointment_request" TO "service_role";



GRANT ALL ON TABLE "public"."custom_audit_event" TO "anon";
GRANT ALL ON TABLE "public"."custom_audit_event" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_audit_event" TO "service_role";



GRANT ALL ON TABLE "public"."custom_billing_service" TO "anon";
GRANT ALL ON TABLE "public"."custom_billing_service" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_billing_service" TO "service_role";



GRANT ALL ON TABLE "public"."custom_billing_settings" TO "anon";
GRANT ALL ON TABLE "public"."custom_billing_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_billing_settings" TO "service_role";



GRANT ALL ON TABLE "public"."custom_billing_workqueue_comment" TO "anon";
GRANT ALL ON TABLE "public"."custom_billing_workqueue_comment" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_billing_workqueue_comment" TO "service_role";



GRANT ALL ON TABLE "public"."custom_client_document" TO "anon";
GRANT ALL ON TABLE "public"."custom_client_document" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_client_document" TO "service_role";



GRANT ALL ON TABLE "public"."custom_client_import_staging" TO "anon";
GRANT ALL ON TABLE "public"."custom_client_import_staging" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_client_import_staging" TO "service_role";



GRANT ALL ON TABLE "public"."custom_client_note" TO "anon";
GRANT ALL ON TABLE "public"."custom_client_note" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_client_note" TO "service_role";



GRANT ALL ON TABLE "public"."custom_client_profile" TO "anon";
GRANT ALL ON TABLE "public"."custom_client_profile" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_client_profile" TO "service_role";



GRANT ALL ON TABLE "public"."custom_client_program" TO "anon";
GRANT ALL ON TABLE "public"."custom_client_program" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_client_program" TO "service_role";



GRANT ALL ON TABLE "public"."custom_invoice" TO "anon";
GRANT ALL ON TABLE "public"."custom_invoice" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_invoice" TO "service_role";



GRANT ALL ON TABLE "public"."custom_invoice_line_item" TO "anon";
GRANT ALL ON TABLE "public"."custom_invoice_line_item" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_invoice_line_item" TO "service_role";



GRANT ALL ON TABLE "public"."custom_lookup_value" TO "anon";
GRANT ALL ON TABLE "public"."custom_lookup_value" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_lookup_value" TO "service_role";



GRANT ALL ON TABLE "public"."custom_note_settings" TO "anon";
GRANT ALL ON TABLE "public"."custom_note_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_note_settings" TO "service_role";



GRANT ALL ON TABLE "public"."custom_note_type" TO "anon";
GRANT ALL ON TABLE "public"."custom_note_type" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_note_type" TO "service_role";



GRANT ALL ON TABLE "public"."custom_payment" TO "anon";
GRANT ALL ON TABLE "public"."custom_payment" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_payment" TO "service_role";



GRANT ALL ON TABLE "public"."dashboard_user_preferences" TO "anon";
GRANT ALL ON TABLE "public"."dashboard_user_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."dashboard_user_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."dashboard_widgets" TO "anon";
GRANT ALL ON TABLE "public"."dashboard_widgets" TO "authenticated";
GRANT ALL ON TABLE "public"."dashboard_widgets" TO "service_role";



GRANT ALL ON TABLE "public"."diagnosis_codes" TO "anon";
GRANT ALL ON TABLE "public"."diagnosis_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."diagnosis_codes" TO "service_role";



GRANT ALL ON TABLE "public"."document_links" TO "anon";
GRANT ALL ON TABLE "public"."document_links" TO "authenticated";
GRANT ALL ON TABLE "public"."document_links" TO "service_role";



GRANT ALL ON TABLE "public"."documents" TO "anon";
GRANT ALL ON TABLE "public"."documents" TO "authenticated";
GRANT ALL ON TABLE "public"."documents" TO "service_role";



GRANT ALL ON TABLE "public"."edi_acknowledgements" TO "anon";
GRANT ALL ON TABLE "public"."edi_acknowledgements" TO "authenticated";
GRANT ALL ON TABLE "public"."edi_acknowledgements" TO "service_role";



GRANT ALL ON TABLE "public"."edi_batch_claims" TO "anon";
GRANT ALL ON TABLE "public"."edi_batch_claims" TO "authenticated";
GRANT ALL ON TABLE "public"."edi_batch_claims" TO "service_role";



GRANT ALL ON TABLE "public"."edi_batches" TO "anon";
GRANT ALL ON TABLE "public"."edi_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."edi_batches" TO "service_role";



GRANT ALL ON TABLE "public"."edi_transactions" TO "anon";
GRANT ALL ON TABLE "public"."edi_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."edi_transactions" TO "service_role";



GRANT ALL ON TABLE "public"."eligibility_requests" TO "anon";
GRANT ALL ON TABLE "public"."eligibility_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."eligibility_requests" TO "service_role";



GRANT ALL ON TABLE "public"."eligibility_with_staleness" TO "anon";
GRANT ALL ON TABLE "public"."eligibility_with_staleness" TO "authenticated";
GRANT ALL ON TABLE "public"."eligibility_with_staleness" TO "service_role";



GRANT ALL ON TABLE "public"."encounter_clinical_notes" TO "anon";
GRANT ALL ON TABLE "public"."encounter_clinical_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."encounter_clinical_notes" TO "service_role";



GRANT ALL ON TABLE "public"."encounter_code_suggestions" TO "anon";
GRANT ALL ON TABLE "public"."encounter_code_suggestions" TO "authenticated";
GRANT ALL ON TABLE "public"."encounter_code_suggestions" TO "service_role";



GRANT ALL ON TABLE "public"."encounter_codes" TO "anon";
GRANT ALL ON TABLE "public"."encounter_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."encounter_codes" TO "service_role";



GRANT ALL ON TABLE "public"."encounter_diagnoses" TO "anon";
GRANT ALL ON TABLE "public"."encounter_diagnoses" TO "authenticated";
GRANT ALL ON TABLE "public"."encounter_diagnoses" TO "service_role";



GRANT ALL ON TABLE "public"."encounter_notes" TO "anon";
GRANT ALL ON TABLE "public"."encounter_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."encounter_notes" TO "service_role";



GRANT ALL ON TABLE "public"."encounter_service_lines" TO "anon";
GRANT ALL ON TABLE "public"."encounter_service_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."encounter_service_lines" TO "service_role";



GRANT ALL ON TABLE "public"."encounters" TO "anon";
GRANT ALL ON TABLE "public"."encounters" TO "authenticated";
GRANT ALL ON TABLE "public"."encounters" TO "service_role";



GRANT ALL ON TABLE "public"."era_claim_payments" TO "anon";
GRANT ALL ON TABLE "public"."era_claim_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."era_claim_payments" TO "service_role";



GRANT ALL ON TABLE "public"."era_import_batches" TO "anon";
GRANT ALL ON TABLE "public"."era_import_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."era_import_batches" TO "service_role";



GRANT ALL ON TABLE "public"."era_posting_ledger_entries" TO "anon";
GRANT ALL ON TABLE "public"."era_posting_ledger_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."era_posting_ledger_entries" TO "service_role";



GRANT ALL ON TABLE "public"."external_message_envelopes" TO "anon";
GRANT ALL ON TABLE "public"."external_message_envelopes" TO "authenticated";
GRANT ALL ON TABLE "public"."external_message_envelopes" TO "service_role";



GRANT ALL ON TABLE "public"."external_transaction_attempts" TO "anon";
GRANT ALL ON TABLE "public"."external_transaction_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."external_transaction_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."fee_schedules" TO "anon";
GRANT ALL ON TABLE "public"."fee_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."fee_schedules" TO "service_role";



GRANT ALL ON TABLE "public"."gmail_oauth_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."inbound_email_messages" TO "anon";
GRANT ALL ON TABLE "public"."inbound_email_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."inbound_email_messages" TO "service_role";



GRANT ALL ON TABLE "public"."insurance_payers" TO "anon";
GRANT ALL ON TABLE "public"."insurance_payers" TO "authenticated";
GRANT ALL ON TABLE "public"."insurance_payers" TO "service_role";



GRANT ALL ON TABLE "public"."insurance_policies" TO "anon";
GRANT ALL ON TABLE "public"."insurance_policies" TO "authenticated";
GRANT ALL ON TABLE "public"."insurance_policies" TO "service_role";



GRANT ALL ON TABLE "public"."insurance_subscribers" TO "anon";
GRANT ALL ON TABLE "public"."insurance_subscribers" TO "authenticated";
GRANT ALL ON TABLE "public"."insurance_subscribers" TO "service_role";



GRANT ALL ON TABLE "public"."integration_connections" TO "anon";
GRANT ALL ON TABLE "public"."integration_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."integration_connections" TO "service_role";



GRANT ALL ON TABLE "public"."kpi_claim_summary" TO "anon";
GRANT ALL ON TABLE "public"."kpi_claim_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."kpi_claim_summary" TO "service_role";



GRANT ALL ON TABLE "public"."kpi_eligibility_summary" TO "anon";
GRANT ALL ON TABLE "public"."kpi_eligibility_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."kpi_eligibility_summary" TO "service_role";



GRANT ALL ON TABLE "public"."payment_postings" TO "anon";
GRANT ALL ON TABLE "public"."payment_postings" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_postings" TO "service_role";



GRANT ALL ON TABLE "public"."kpi_payment_summary" TO "anon";
GRANT ALL ON TABLE "public"."kpi_payment_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."kpi_payment_summary" TO "service_role";



GRANT ALL ON TABLE "public"."workqueue_items" TO "anon";
GRANT ALL ON TABLE "public"."workqueue_items" TO "authenticated";
GRANT ALL ON TABLE "public"."workqueue_items" TO "service_role";



GRANT ALL ON TABLE "public"."kpi_workqueue_summary" TO "anon";
GRANT ALL ON TABLE "public"."kpi_workqueue_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."kpi_workqueue_summary" TO "service_role";



GRANT ALL ON TABLE "public"."mailroom_items" TO "anon";
GRANT ALL ON TABLE "public"."mailroom_items" TO "authenticated";
GRANT ALL ON TABLE "public"."mailroom_items" TO "service_role";



GRANT ALL ON TABLE "public"."notification_rules" TO "anon";
GRANT ALL ON TABLE "public"."notification_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_rules" TO "service_role";



GRANT ALL ON TABLE "public"."operational_alerts" TO "anon";
GRANT ALL ON TABLE "public"."operational_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."operational_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."organization_members" TO "anon";
GRANT ALL ON TABLE "public"."organization_members" TO "authenticated";
GRANT ALL ON TABLE "public"."organization_members" TO "service_role";



GRANT ALL ON TABLE "public"."organizations" TO "anon";
GRANT ALL ON TABLE "public"."organizations" TO "authenticated";
GRANT ALL ON TABLE "public"."organizations" TO "service_role";



GRANT ALL ON TABLE "public"."patient_balances" TO "anon";
GRANT ALL ON TABLE "public"."patient_balances" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_balances" TO "service_role";



GRANT ALL ON TABLE "public"."patient_check_ins" TO "anon";
GRANT ALL ON TABLE "public"."patient_check_ins" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_check_ins" TO "service_role";



GRANT ALL ON TABLE "public"."patient_checkin_goal_selections" TO "anon";
GRANT ALL ON TABLE "public"."patient_checkin_goal_selections" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_checkin_goal_selections" TO "service_role";



GRANT ALL ON TABLE "public"."patient_checkins" TO "anon";
GRANT ALL ON TABLE "public"."patient_checkins" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_checkins" TO "service_role";



GRANT ALL ON TABLE "public"."patient_contacts" TO "anon";
GRANT ALL ON TABLE "public"."patient_contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_contacts" TO "service_role";



GRANT ALL ON TABLE "public"."patient_diagnoses" TO "anon";
GRANT ALL ON TABLE "public"."patient_diagnoses" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_diagnoses" TO "service_role";



GRANT ALL ON TABLE "public"."patient_import_batches" TO "anon";
GRANT ALL ON TABLE "public"."patient_import_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_import_batches" TO "service_role";



GRANT ALL ON TABLE "public"."patient_import_items" TO "anon";
GRANT ALL ON TABLE "public"."patient_import_items" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_import_items" TO "service_role";



GRANT ALL ON TABLE "public"."patient_invoice_payments" TO "anon";
GRANT ALL ON TABLE "public"."patient_invoice_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_invoice_payments" TO "service_role";



GRANT ALL ON TABLE "public"."patient_invoices" TO "anon";
GRANT ALL ON TABLE "public"."patient_invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_invoices" TO "service_role";



GRANT ALL ON TABLE "public"."payer_configurations" TO "anon";
GRANT ALL ON TABLE "public"."payer_configurations" TO "authenticated";
GRANT ALL ON TABLE "public"."payer_configurations" TO "service_role";



GRANT ALL ON TABLE "public"."payer_contracts" TO "anon";
GRANT ALL ON TABLE "public"."payer_contracts" TO "authenticated";
GRANT ALL ON TABLE "public"."payer_contracts" TO "service_role";



GRANT ALL ON TABLE "public"."payer_plans" TO "anon";
GRANT ALL ON TABLE "public"."payer_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."payer_plans" TO "service_role";



GRANT ALL ON TABLE "public"."payer_profiles" TO "anon";
GRANT ALL ON TABLE "public"."payer_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."payer_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."payment_import_batches" TO "anon";
GRANT ALL ON TABLE "public"."payment_import_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_import_batches" TO "service_role";



GRANT ALL ON TABLE "public"."payment_import_items" TO "anon";
GRANT ALL ON TABLE "public"."payment_import_items" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_import_items" TO "service_role";



GRANT ALL ON TABLE "public"."payment_posting_allocations" TO "anon";
GRANT ALL ON TABLE "public"."payment_posting_allocations" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_posting_allocations" TO "service_role";



GRANT ALL ON TABLE "public"."professional_claim_service_lines" TO "anon";
GRANT ALL ON TABLE "public"."professional_claim_service_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."professional_claim_service_lines" TO "service_role";



GRANT ALL ON TABLE "public"."professional_claims" TO "anon";
GRANT ALL ON TABLE "public"."professional_claims" TO "authenticated";
GRANT ALL ON TABLE "public"."professional_claims" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."provider_credentialing_profiles" TO "anon";
GRANT ALL ON TABLE "public"."provider_credentialing_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_credentialing_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."provider_locations" TO "anon";
GRANT ALL ON TABLE "public"."provider_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_locations" TO "service_role";



GRANT ALL ON TABLE "public"."provider_payer_enrollments" TO "anon";
GRANT ALL ON TABLE "public"."provider_payer_enrollments" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_payer_enrollments" TO "service_role";



GRANT ALL ON TABLE "public"."provider_profiles" TO "anon";
GRANT ALL ON TABLE "public"."provider_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."providers" TO "anon";
GRANT ALL ON TABLE "public"."providers" TO "authenticated";
GRANT ALL ON TABLE "public"."providers" TO "service_role";



GRANT ALL ON TABLE "public"."service_locations" TO "anon";
GRANT ALL ON TABLE "public"."service_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."service_locations" TO "service_role";



GRANT ALL ON TABLE "public"."smart_phrases" TO "anon";
GRANT ALL ON TABLE "public"."smart_phrases" TO "authenticated";
GRANT ALL ON TABLE "public"."smart_phrases" TO "service_role";



GRANT ALL ON TABLE "public"."support_ticket_comments" TO "anon";
GRANT ALL ON TABLE "public"."support_ticket_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."support_ticket_comments" TO "service_role";



GRANT ALL ON TABLE "public"."support_tickets" TO "anon";
GRANT ALL ON TABLE "public"."support_tickets" TO "authenticated";
GRANT ALL ON TABLE "public"."support_tickets" TO "service_role";



GRANT ALL ON TABLE "public"."system_settings" TO "anon";
GRANT ALL ON TABLE "public"."system_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."system_settings" TO "service_role";



GRANT ALL ON TABLE "public"."system_readiness_checks" TO "anon";
GRANT ALL ON TABLE "public"."system_readiness_checks" TO "authenticated";
GRANT ALL ON TABLE "public"."system_readiness_checks" TO "service_role";



GRANT ALL ON TABLE "public"."system_readiness_summary" TO "anon";
GRANT ALL ON TABLE "public"."system_readiness_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."system_readiness_summary" TO "service_role";



GRANT ALL ON TABLE "public"."telehealth_participants" TO "anon";
GRANT ALL ON TABLE "public"."telehealth_participants" TO "authenticated";
GRANT ALL ON TABLE "public"."telehealth_participants" TO "service_role";



GRANT ALL ON TABLE "public"."telehealth_sessions" TO "anon";
GRANT ALL ON TABLE "public"."telehealth_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."telehealth_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."ticket_comments" TO "anon";
GRANT ALL ON TABLE "public"."ticket_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."ticket_comments" TO "service_role";



GRANT ALL ON TABLE "public"."tickets" TO "anon";
GRANT ALL ON TABLE "public"."tickets" TO "authenticated";
GRANT ALL ON TABLE "public"."tickets" TO "service_role";



GRANT ALL ON TABLE "public"."treatment_plan_goals" TO "anon";
GRANT ALL ON TABLE "public"."treatment_plan_goals" TO "authenticated";
GRANT ALL ON TABLE "public"."treatment_plan_goals" TO "service_role";



GRANT ALL ON TABLE "public"."treatment_plans" TO "anon";
GRANT ALL ON TABLE "public"."treatment_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."treatment_plans" TO "service_role";



GRANT ALL ON TABLE "public"."user_presence" TO "anon";
GRANT ALL ON TABLE "public"."user_presence" TO "authenticated";
GRANT ALL ON TABLE "public"."user_presence" TO "service_role";



GRANT ALL ON TABLE "public"."vcc_payments" TO "anon";
GRANT ALL ON TABLE "public"."vcc_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."vcc_payments" TO "service_role";



GRANT ALL ON TABLE "public"."workqueue_item_comments" TO "anon";
GRANT ALL ON TABLE "public"."workqueue_item_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."workqueue_item_comments" TO "service_role";



GRANT ALL ON TABLE "public"."workqueue_type_catalog" TO "anon";
GRANT ALL ON TABLE "public"."workqueue_type_catalog" TO "authenticated";
GRANT ALL ON TABLE "public"."workqueue_type_catalog" TO "service_role";



GRANT ALL ON TABLE "public"."your_table" TO "anon";
GRANT ALL ON TABLE "public"."your_table" TO "authenticated";
GRANT ALL ON TABLE "public"."your_table" TO "service_role";



GRANT ALL ON SEQUENCE "public"."your_table_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."your_table_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."your_table_id_seq" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







