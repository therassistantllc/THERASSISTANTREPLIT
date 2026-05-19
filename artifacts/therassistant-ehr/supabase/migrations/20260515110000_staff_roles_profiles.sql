-- Staff profiles and RBAC role tables.
-- Supports staff management, role assignment, and permission enforcement.

create extension if not exists pgcrypto;

create table if not exists public.staff_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text null,
  job_title text null,
  provider_npi text null,
  is_active boolean not null default true,
  staff_status text null,
  archived_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, email)
);

create table if not exists public.staff_roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  role_code text not null,
  role_name text not null,
  description text null,
  is_default boolean not null default false,
  display_order integer null,
  archived_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, role_code)
);

create table if not exists public.staff_role_permissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  staff_role_id uuid not null references public.staff_roles(id) on delete cascade,
  permission_code text not null,
  archived_at timestamptz null,
  created_at timestamptz not null default now(),
  unique (organization_id, staff_role_id, permission_code)
);

create table if not exists public.staff_role_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  staff_id uuid not null references public.staff_profiles(id) on delete cascade,
  staff_role_id uuid not null references public.staff_roles(id) on delete cascade,
  archived_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, staff_id, staff_role_id)
);

create index if not exists idx_staff_profiles_org_active
  on public.staff_profiles (organization_id, is_active)
  where archived_at is null;

create index if not exists idx_staff_roles_org
  on public.staff_roles (organization_id)
  where archived_at is null;

create index if not exists idx_staff_role_permissions_role
  on public.staff_role_permissions (staff_role_id, permission_code)
  where archived_at is null;

create index if not exists idx_staff_role_assignments_staff
  on public.staff_role_assignments (staff_id, organization_id)
  where archived_at is null;

select pg_notify('pgrst', 'reload schema');
