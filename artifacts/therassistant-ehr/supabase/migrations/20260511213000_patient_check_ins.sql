create table if not exists public.patient_check_ins (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  encounter_id uuid references public.encounters(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'reviewed', 'archived')),
  current_mood text,
  current_stressors text,
  safety_concerns text,
  psychosocial_updates text,
  selected_goal_ids text[] not null default '{}'::text[],
  goal_updates jsonb not null default '[]'::jsonb,
  patient_statement text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists idx_patient_check_ins_org_client_created
  on public.patient_check_ins (organization_id, client_id, created_at desc);

create index if not exists idx_patient_check_ins_appointment
  on public.patient_check_ins (appointment_id);

create index if not exists idx_patient_check_ins_encounter
  on public.patient_check_ins (encounter_id);

alter table public.patient_check_ins enable row level security;

drop policy if exists patient_check_ins_org_policy on public.patient_check_ins;
create policy patient_check_ins_org_policy on public.patient_check_ins
  for all to authenticated
  using (
    organization_id::text = coalesce(
      auth.jwt() ->> 'organization_id',
      auth.jwt() -> 'app_metadata' ->> 'organization_id',
      ''
    )
  )
  with check (
    organization_id::text = coalesce(
      auth.jwt() ->> 'organization_id',
      auth.jwt() -> 'app_metadata' ->> 'organization_id',
      ''
    )
  );

select pg_notify('pgrst', 'reload schema');
