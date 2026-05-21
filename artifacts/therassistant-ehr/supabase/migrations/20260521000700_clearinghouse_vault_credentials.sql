-- T001 Phase 1 compliance: encrypt clearinghouse API credentials at rest using Supabase Vault,
-- and accept both legacy ('test','live') and audit-vocabulary ('sandbox','production') mode values.
-- Additive only; existing rows continue to work via the env-var fallback in the application layer.

-- Vault is preinstalled on managed Supabase since 2023; safety net for older projects.
create extension if not exists supabase_vault with schema vault cascade;

alter table public.clearinghouse_connections
  add column if not exists vault_secret_id uuid,
  add column if not exists vault_secret_name text;

-- Widen the mode check constraint so the UI (which uses 'production'/'sandbox' labels) can store
-- friendlier values alongside the legacy 'test'/'live' values that already exist in some rows.
alter table public.clearinghouse_connections
  drop constraint if exists clearinghouse_connections_mode_check;
alter table public.clearinghouse_connections
  add constraint clearinghouse_connections_mode_check
  check (mode in ('test', 'live', 'sandbox', 'production'));

-- Helper: write (or rotate) a clearinghouse API key into the Vault and link it to the connection.
-- SECURITY DEFINER so it runs as the function owner (postgres) which has access to vault.*;
-- execute privilege is revoked from PUBLIC/anon/authenticated below and granted only to service_role.
create or replace function public.set_clearinghouse_api_key(
  p_connection_id uuid,
  p_api_key text
) returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing uuid;
  v_name text;
  v_id uuid;
begin
  if p_connection_id is null or p_api_key is null or length(p_api_key) = 0 then
    raise exception 'connection_id and api_key are required';
  end if;

  select vault_secret_id into v_existing
    from public.clearinghouse_connections
    where id = p_connection_id;

  if v_existing is not null then
    perform vault.update_secret(v_existing, p_api_key);
    update public.clearinghouse_connections
       set updated_at = now()
       where id = p_connection_id;
    return v_existing;
  end if;

  v_name := 'clearinghouse_api_key_' || p_connection_id::text;
  v_id := vault.create_secret(
    p_api_key,
    v_name,
    'Clearinghouse API key for connection ' || p_connection_id::text
  );

  update public.clearinghouse_connections
     set vault_secret_id = v_id,
         vault_secret_name = v_name,
         updated_at = now()
     where id = p_connection_id;

  return v_id;
end;
$$;

-- Helper: read the decrypted API key for a connection. Returns NULL when no key has been stored.
create or replace function public.get_clearinghouse_api_key(p_connection_id uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_id uuid;
  v_secret text;
begin
  if p_connection_id is null then return null; end if;

  select vault_secret_id into v_id
    from public.clearinghouse_connections
    where id = p_connection_id;

  if v_id is null then return null; end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where id = v_id;

  return v_secret;
end;
$$;

revoke all on function public.set_clearinghouse_api_key(uuid, text) from public, anon, authenticated;
revoke all on function public.get_clearinghouse_api_key(uuid) from public, anon, authenticated;
grant execute on function public.set_clearinghouse_api_key(uuid, text) to service_role;
grant execute on function public.get_clearinghouse_api_key(uuid) to service_role;

select pg_notify('pgrst', 'reload schema');
