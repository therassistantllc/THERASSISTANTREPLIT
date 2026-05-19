-- Payer Configuration Table for Availity Integration
-- Stores organization-specific payer setup and preferences

create table if not exists public.payer_configurations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payer_id text not null,
  payer_name text not null,
  payer_aliases jsonb default '[]'::jsonb,
  supported_transactions jsonb default '[]'::jsonb,
  states jsonb default '[]'::jsonb,
  source text not null default 'availity',
  environment text not null default 'demo',
  is_active boolean not null default true,
  notes text,
  created_by uuid,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  
  constraint valid_source check (source in ('availity', 'manual')),
  constraint valid_environment check (environment in ('demo', 'production', 'sandbox', 'test')),
  constraint payer_id_required check (payer_id != ''),
  constraint unique_payer_per_org unique(organization_id, payer_id)
);

-- Indexes for common queries
create index if not exists idx_payer_configurations_org_id on public.payer_configurations(organization_id);
create index if not exists idx_payer_configurations_payer_id on public.payer_configurations(payer_id);
create index if not exists idx_payer_configurations_payer_name on public.payer_configurations(payer_name);
create index if not exists idx_payer_configurations_is_active on public.payer_configurations(is_active);
create index if not exists idx_payer_configurations_created_at on public.payer_configurations(created_at desc);

-- Enable RLS
alter table public.payer_configurations enable row level security;

-- RLS Policy: Users can only view/modify payer configurations for their organization
drop policy if exists payer_configurations_org_policy on public.payer_configurations;
create policy payer_configurations_org_policy on public.payer_configurations
  for all
  using (
    organization_id is null or
    organization_id = (auth.jwt() ->> 'org_id')::uuid or
    (auth.jwt() ->> 'org_id') is null
  );

-- Comments
comment on table public.payer_configurations is 'Stores organization-specific Availity payer configurations and preferences. Enables per-org payer management, transaction type support tracking, and state-specific rules.';
comment on column public.payer_configurations.payer_aliases is 'Array of alternate payer names/identifiers: ["CO Access", "Colorado Access", "COA"]';
comment on column public.payer_configurations.supported_transactions is 'Array of EDI transaction types: ["270", "271", "276", "277", "837P", "835", "HCR"]';
comment on column public.payer_configurations.states is 'Array of state abbreviations where payer is active: ["CO", "WY", "NM", "UT"]';
comment on column public.payer_configurations.source is 'Where payer info originated: "availity" (from API) or "manual" (user-entered)';

select pg_notify('pgrst', 'reload schema');
