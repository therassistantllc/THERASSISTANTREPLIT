-- Task #487: Saved-card + autopay enrollment on clients.
--
-- A client can have at most one default card on file linked to a
-- specific connected Stripe Express account (the practice's account on
-- which the customer + payment method live, since we use direct
-- charges). Display columns (brand/last4/exp) let the UI render the
-- card without round-tripping to Stripe.
alter table public.clients
  add column if not exists stripe_connect_account_id text,
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_payment_method_id text,
  add column if not exists stripe_payment_method_brand text,
  add column if not exists stripe_payment_method_last4 text,
  add column if not exists stripe_payment_method_exp_month smallint,
  add column if not exists stripe_payment_method_exp_year smallint,
  add column if not exists stripe_payment_method_saved_at timestamptz,
  add column if not exists autopay_enabled boolean not null default false;

create index if not exists clients_stripe_customer_id_idx
  on public.clients (stripe_customer_id)
  where stripe_customer_id is not null;

notify pgrst, 'reload schema';
