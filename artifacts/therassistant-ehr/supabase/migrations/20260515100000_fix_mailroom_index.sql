-- Fix mailroom status index to match the live schema.
-- Do not add replacement columns; align indexing to existing public.mailroom_items.status.

drop index if exists public.idx_mailroom_items_mail_status;
drop index if exists public.idx_mailroom_items_status;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'mailroom_items'
      and column_name = 'status'
  ) then
    execute $sql$
      create index if not exists idx_mailroom_items_status
        on public.mailroom_items (organization_id, status, created_at desc)
        where archived_at is null
    $sql$;
  end if;
end;
$$;

select pg_notify('pgrst', 'reload schema');
