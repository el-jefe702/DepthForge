-- DepthForge credit wallet schema
-- Applies the foundational tables for metered, auditable credit usage.

create table if not exists credit_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  lifetime_granted integer not null default 0,
  lifetime_spent integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid,
  amount integer not null,
  balance_after integer not null,
  kind text not null check (kind in (
    'signup_grant',
    'purchase',
    'reservation',
    'commit',
    'refund',
    'admin_grant',
    'adjustment'
  )),
  reason text not null,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);

create table if not exists generation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_type text not null,
  status text not null default 'pending' check (status in (
    'pending',
    'reserved',
    'processing',
    'succeeded',
    'failed',
    'refunded'
  )),
  credits_reserved integer not null default 0,
  credits_charged integer not null default 0,
  provider_job_id text,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists credit_transactions_user_created_idx
  on credit_transactions (user_id, created_at desc);

create index if not exists generation_jobs_user_created_idx
  on generation_jobs (user_id, created_at desc);

create index if not exists generation_jobs_status_idx
  on generation_jobs (status, created_at desc);
