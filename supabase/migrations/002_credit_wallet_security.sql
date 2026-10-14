begin;

alter table public.credit_wallets enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.generation_jobs enable row level security;

revoke all privileges on table public.credit_wallets, public.credit_transactions, public.generation_jobs from public, anon, authenticated;
grant select on table public.credit_wallets, public.credit_transactions, public.generation_jobs to authenticated;

drop policy if exists wallet_owner_read on public.credit_wallets;
create policy wallet_owner_read on public.credit_wallets for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists transactions_owner_read on public.credit_transactions;
create policy transactions_owner_read on public.credit_transactions for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists jobs_owner_read on public.generation_jobs;
create policy jobs_owner_read on public.generation_jobs for select to authenticated using ((select auth.uid()) = user_id);

commit;
