-- Staging table for the broking extract.
--
-- Run this once in the Supabase SQL editor before loading data.
--
-- Two deliberate choices worth understanding:
--
-- 1. Every business column is TEXT. This is a landing table for whatever the
--    source system produces, mess included -- money written with thousand
--    separators, dates in two different formats. Cleaning happens on read, in
--    the application, where it is visible and reconciled. Typing these columns
--    would silently reject the very rows we want to talk about.
--
-- 2. policy_id is NOT the primary key, because in the real extract it is not
--    unique -- nine rows share an id. A surrogate row_id keeps every row, and
--    the duplicate problem stays visible rather than being hidden by a
--    constraint error at load time.

create table if not exists policies (
  row_id          bigint generated always as identity primary key,
  policy_id       text,
  client          text,
  account_owner   text,
  product_line    text,
  country         text,
  region          text,
  distribution    text,
  retail_broker   text,
  business_type   text,
  inception_date  text,
  expiry_date     text,
  status          text,
  currency        text,
  fx_rate         text,
  premium_local   text,
  gwp_gbp         text,
  revenue_gbp     text,
  brokerage_pct   text,
  loaded_at       timestamptz not null default now()
);

create index if not exists policies_policy_id_idx on policies (policy_id);

-- Row level security ON, with no policy attached.
--
-- That means the anon and authenticated API roles can read nothing at all.
-- This app reaches Supabase from its own server using the service role key,
-- which bypasses RLS by design -- so the data is reachable by the application
-- and by nobody else holding the public key.
--
-- This is the grown-up version of the choice made on the project creation
-- screen: the convenient default exposes new tables automatically; this does
-- the opposite and makes access explicit.
alter table policies enable row level security;

revoke all on policies from anon;
revoke all on policies from authenticated;
