-- ScreenFlow tables — run once in Supabase Dashboard → SQL Editor → New query → paste → Run
-- RLS enabled with no policies = locked down; only the server (service key) can access.

create table if not exists users (
  email      text primary key,
  username   text unique not null,
  name       text not null,
  pass_hash  text not null,
  created_at timestamptz not null default now()
);
alter table users enable row level security;

create table if not exists pending_signups (
  email     text primary key,
  name      text not null,
  username  text not null,
  pass_hash text not null,
  otp_hash  text not null,
  expires   bigint not null,
  attempts  int not null default 0
);
alter table pending_signups enable row level security;
