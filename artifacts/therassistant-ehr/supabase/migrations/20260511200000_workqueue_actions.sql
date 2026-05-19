create extension if not exists pgcrypto;

alter table public.workqueue_items
  add column if not exists deferred_until timestamptz,
  add column if not exists defer_reason text,
  add column if not exists resolved_by_user_id uuid,
  add column if not exists closed_by_user_id uuid;

create table if not exists public.workqueue_item_comments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workqueue_item_id uuid not null references public.workqueue_items(id) on delete cascade,
  comment_body text not null,
  comment_type text not null default 'note' check (
    comment_type in ('note', 'status_change', 'assignment', 'defer', 'resolution')
  ),
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists idx_workqueue_item_comments_item
  on public.workqueue_item_comments (organization_id, workqueue_item_id, created_at desc)
  where archived_at is null;

do $$
begin
  if to_regclass('public.workqueue_items') is not null then
    create index if not exists idx_workqueue_items_deferred_until
      on public.workqueue_items (organization_id, deferred_until)
      where archived_at is null and deferred_until is not null;
  end if;
end $$;

alter table public.workqueue_item_comments enable row level security;

drop policy if exists workqueue_item_comments_org_policy on public.workqueue_item_comments;
create policy workqueue_item_comments_org_policy
  on public.workqueue_item_comments
  for all to authenticated
  using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

select pg_notify('pgrst', 'reload schema');
