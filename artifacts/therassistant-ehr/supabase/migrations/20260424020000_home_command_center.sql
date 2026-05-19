-- File: supabase/migrations/20260424_home_command_center.sql
create extension if not exists pgcrypto;

create table if not exists public.dashboard_widgets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  role text not null,
  widget_key text not null,
  title text not null,
  sort_order integer not null default 0,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.dashboard_user_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  organization_id uuid not null,
  layout jsonb not null default '{}'::jsonb,
  hidden_widgets jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.operational_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  patient_id uuid null,
  provider_id uuid null,
  appointment_id uuid null,
  claim_id uuid null,
  ticket_id uuid null,
  alert_type text not null check (alert_type in (
    'missing_note',
    'unsigned_note',
    'eligibility_not_checked',
    'inactive_coverage',
    'claim_denied',
    'claim_rejected',
    'claim_no_response',
    'patient_balance_due',
    'failed_payment',
    'credentialing_due',
    'clearinghouse_error'
  )),
  severity text not null default 'medium',
  title text not null,
  message text null,
  status text not null default 'open',
  due_at timestamptz null,
  resolved_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_dashboard_widgets_org_role_enabled
  on public.dashboard_widgets (organization_id, role, is_enabled, sort_order);

create index if not exists idx_dashboard_user_preferences_user_org
  on public.dashboard_user_preferences (user_id, organization_id);

create index if not exists idx_operational_alerts_org_status_type
  on public.operational_alerts (organization_id, status, alert_type, created_at desc);

alter table public.dashboard_widgets enable row level security;
alter table public.dashboard_user_preferences enable row level security;
alter table public.operational_alerts enable row level security;

drop policy if exists dashboard_widgets_org_policy on public.dashboard_widgets;
create policy dashboard_widgets_org_policy
  on public.dashboard_widgets
  for all
  to authenticated
  using (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );

drop policy if exists dashboard_user_preferences_org_policy on public.dashboard_user_preferences;
create policy dashboard_user_preferences_org_policy
  on public.dashboard_user_preferences
  for all
  to authenticated
  using (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );

drop policy if exists operational_alerts_org_policy on public.operational_alerts;
create policy operational_alerts_org_policy
  on public.operational_alerts
  for all
  to authenticated
  using (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );
