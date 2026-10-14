begin;

create or replace function public.credit_job_action(
  p_action text, p_user_id uuid, p_job_id uuid,
  p_credits integer default null, p_job_type text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  w public.credit_wallets%rowtype;
  j public.generation_jobs%rowtype;
  new_balance integer;
begin
  if p_action is null or p_action not in ('reserve','commit','refund')
     or p_user_id is null or p_job_id is null then
    raise exception 'Invalid credit action or identifiers';
  end if;
  if p_action = 'reserve' and
     (p_credits is null or p_credits <= 0 or p_job_type is null or btrim(p_job_type) = '') then
    raise exception 'Reservation requires positive credits and a job type';
  end if;

  select * into w from public.credit_wallets where user_id = p_user_id for update;
  if not found then raise exception 'Wallet not found'; end if;
  select * into j from public.generation_jobs where id = p_job_id for update;
  if found then
    if j.user_id <> p_user_id then raise exception 'Job owner mismatch'; end if;
    if p_action = 'reserve' then
      if j.credits_reserved <> p_credits or j.job_type <> p_job_type then
        raise exception 'Job reservation parameters mismatch';
      end if;
      if j.status not in ('reserved','processing','succeeded','refunded') then
        raise exception 'Existing job is not a lifecycle reservation';
      end if;
      return jsonb_build_object('job_id',j.id,'status',j.status,'balance',w.balance,'replayed',true);
    end if;
  elsif p_action <> 'reserve' then
    raise exception 'Job not found';
  else
    if w.balance < p_credits then raise exception 'Insufficient credits'; end if;
    insert into public.generation_jobs(id,user_id,job_type,status,credits_reserved)
      values(p_job_id,p_user_id,p_job_type,'reserved',p_credits);
    update public.credit_wallets set balance = balance - p_credits, updated_at = now()
      where user_id = p_user_id returning balance into new_balance;
    insert into public.credit_transactions(user_id,job_id,amount,balance_after,kind,reason,idempotency_key)
      values(p_user_id,p_job_id,-p_credits,new_balance,'reservation','Job credit reservation','credit-job:'||p_job_id::text||':reserve');
    return jsonb_build_object('job_id',p_job_id,'status','reserved','balance',new_balance,'replayed',false);
  end if;

  if (p_action = 'commit' and j.status = 'succeeded') or
     (p_action = 'refund' and j.status = 'refunded') then
    return jsonb_build_object('job_id',j.id,'status',j.status,'balance',w.balance,'replayed',true);
  end if;
  if j.status not in ('reserved','processing') or j.credits_reserved <= 0 or j.credits_charged <> 0 then
    raise exception 'Job cannot transition from its current state';
  end if;
  if not exists(select 1 from public.credit_transactions
    where job_id = p_job_id and user_id = p_user_id and kind = 'reservation'
      and amount = -j.credits_reserved and idempotency_key = 'credit-job:'||p_job_id::text||':reserve') then
    raise exception 'Missing lifecycle reservation';
  end if;

  if p_action = 'commit' then
    update public.credit_wallets set lifetime_spent = lifetime_spent + j.credits_reserved, updated_at = now()
      where user_id = p_user_id returning balance into new_balance;
    update public.generation_jobs set status = 'succeeded', credits_charged = j.credits_reserved, completed_at = now()
      where id = p_job_id;
    insert into public.credit_transactions(user_id,job_id,amount,balance_after,kind,reason,idempotency_key)
      values(p_user_id,p_job_id,0,new_balance,'commit','Finalize previously reserved credits','credit-job:'||p_job_id::text||':commit');
  else
    update public.credit_wallets set balance = balance + j.credits_reserved, updated_at = now()
      where user_id = p_user_id returning balance into new_balance;
    update public.generation_jobs set status = 'refunded', completed_at = now() where id = p_job_id;
    insert into public.credit_transactions(user_id,job_id,amount,balance_after,kind,reason,idempotency_key)
      values(p_user_id,p_job_id,j.credits_reserved,new_balance,'refund','Refund failed or cancelled job','credit-job:'||p_job_id::text||':refund');
  end if;
  return jsonb_build_object('job_id',p_job_id,'status',case when p_action = 'commit' then 'succeeded' else 'refunded' end,'balance',new_balance,'replayed',false);
end;
$fn$;

revoke all on function public.credit_job_action(text,uuid,uuid,integer,text) from public, anon, authenticated;
grant execute on function public.credit_job_action(text,uuid,uuid,integer,text) to service_role;

commit;
