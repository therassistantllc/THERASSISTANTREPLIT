-- Task #124: Chat live presence + realtime messages.
--
-- Add chat_messages to the supabase_realtime publication so the chat
-- client can subscribe to postgres_changes (INSERT/UPDATE/DELETE) and
-- drop its 5-second polling loop. Presence itself uses broadcast
-- channels and does NOT require any table to be published; only the
-- message-arrival path needs this.
--
-- Wrapped in an exception-tolerant block because the publication may
-- already include the table (re-running migrations), and because some
-- local environments may not have created the publication at all.
do $$
begin
  if to_regclass('public.chat_messages') is not null then
    begin
      execute 'alter publication supabase_realtime add table public.chat_messages';
    exception
      when duplicate_object then null;
      when undefined_object then null;
    end;
    -- Realtime needs full row replica identity for UPDATE/DELETE payloads
    -- to carry the old values; INSERT works either way, but we set FULL
    -- to leave room for "edited message" propagation later.
    begin
      execute 'alter table public.chat_messages replica identity full';
    exception when others then null;
    end;
  end if;
end $$;
