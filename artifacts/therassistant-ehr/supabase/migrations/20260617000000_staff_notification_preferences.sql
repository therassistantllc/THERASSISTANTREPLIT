-- Task #625: per-user opt-out for the "an eligibility issue was routed to you"
-- email/push notification. One row per staff member; unset row means "use the
-- default" (email enabled). Stored separately from staff_profiles so adding
-- more notification toggles in the future doesn't require schema churn on the
-- staff table.

create table if not exists public.staff_notification_preferences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  staff_id uuid not null references public.staff_profiles(id) on delete cascade,
  email_on_eligibility_routing boolean not null default true,
  inapp_on_eligibility_routing boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (staff_id)
);

create index if not exists idx_staff_notification_preferences_org
  on public.staff_notification_preferences (organization_id);

notify pgrst, 'reload schema';
