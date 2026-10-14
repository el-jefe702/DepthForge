begin;

create or replace function public.create_credit_wallet_for_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.credit_wallets(user_id) values(new.id) on conflict(user_id) do nothing;
  return new;
end;
$$;
revoke all on function public.create_credit_wallet_for_user() from public, anon, authenticated;
drop trigger if exists depthforge_create_credit_wallet on auth.users;
create trigger depthforge_create_credit_wallet after insert on auth.users
for each row execute function public.create_credit_wallet_for_user();

insert into public.credit_wallets(user_id)
select id from auth.users on conflict(user_id) do nothing;

create table if not exists public.credit_prices (
  job_type text primary key,
  credits integer not null check(credits > 0),
  updated_at timestamptz not null default now()
);
alter table public.credit_prices enable row level security;
revoke all on table public.credit_prices from public, anon, authenticated;
grant select on table public.credit_prices to service_role;

insert into public.credit_prices(job_type,credits) values
  ('generate_single', :'single_credits'::integer),
  ('generate_batch_4', :'batch_credits'::integer)
on conflict(job_type) do update set credits=excluded.credits, updated_at=now();

create or replace function public.ensure_credit_wallet(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null then raise exception 'User ID required'; end if;
  insert into public.credit_wallets(user_id) values(p_user_id) on conflict(user_id) do nothing;
end;
$$;
revoke all on function public.ensure_credit_wallet(uuid) from public, anon, authenticated;
grant execute on function public.ensure_credit_wallet(uuid) to service_role;

create or replace function public.reserve_priced_credit_job(p_user_id uuid, p_job_id uuid, p_job_type text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  price integer;
  existing public.generation_jobs%rowtype;
begin
  perform public.ensure_credit_wallet(p_user_id);
  -- Match lifecycle lock order. A retry uses the original job price.
  perform 1 from public.credit_wallets where user_id=p_user_id for update;
  select * into existing from public.generation_jobs where id=p_job_id for update;
  if found then
    if existing.user_id <> p_user_id or existing.job_type <> p_job_type then
      raise exception 'Job owner or type mismatch';
    end if;
    price := existing.credits_reserved;
  else
    select credits into price from public.credit_prices where job_type=p_job_type;
    if not found then raise exception 'Unknown or unpriced job type'; end if;
  end if;
  return public.credit_job_action('reserve',p_user_id,p_job_id,price,p_job_type);
end;
$$;
revoke all on function public.reserve_priced_credit_job(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.reserve_priced_credit_job(uuid,uuid,text) to service_role;

commit;
