-- Extend public.source_object_type with 'system_job' so cron / batch jobs
-- (e.g. the scheduled billing-code refresh) can drop alert rows into
-- workqueue_items without pretending to be a clinical object.
--
-- Enum value additions are idempotent via `add value if not exists`.

do $$
begin
  if not exists (
    select 1
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
     where t.typname = 'source_object_type'
       and n.nspname = 'public'
       and e.enumlabel = 'system_job'
  ) then
    alter type public.source_object_type add value 'system_job';
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
