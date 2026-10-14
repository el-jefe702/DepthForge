import runpy
import subprocess
import uuid
from pathlib import Path
import psycopg

ROOT = Path(__file__).resolve().parents[1]
base = runpy.run_path(str(ROOT / 'tests' / 'credit_lifecycle.py'))
URL, check, scalar, rejects = (base[k] for k in ('URL','check','scalar','rejects'))

def execute(sql, params=()):
    with psycopg.connect(URL) as c:
        c.execute(sql, params)

def service(sql, params=()):
    with psycopg.connect(URL) as c:
        c.execute('set local role service_role')
        return c.execute(sql, params).fetchone()[0]

def install(single=5, batch=18):
    subprocess.run(['psql',URL,'-X','-v','ON_ERROR_STOP=1',
        '-v',f'single_credits={single}','-v',f'batch_credits={batch}',
        '-f',str(ROOT/'supabase/migrations/004_wallet_creation_pricing.sql')],check=True)

def reserve(user, job, kind='generate_single'):
    return service('select public.reserve_priced_credit_job(%s,%s,%s)',(user,job,kind))

def balance(user):
    return scalar('select balance from public.credit_wallets where user_id=%s',(user,))

legacy = uuid.uuid4()
execute('insert into auth.users(id) values(%s)',(legacy,))
existing = base['u']
old_balance = balance(existing)
install()
check(balance(legacy)==0, 'Backfill must create zero-balance wallet')
check(balance(existing)==old_balance, 'Backfill reset existing balance')
install()
check(balance(existing)==old_balance, 'Rerun reset existing balance')

new = uuid.uuid4()
execute('insert into auth.users(id) values(%s)',(new,))
check(balance(new)==0, 'Signup trigger failed')
service('select public.ensure_credit_wallet(%s)',(new,))
service('select public.ensure_credit_wallet(%s)',(new,))
check(scalar('select count(*) from public.credit_wallets where user_id=%s',(new,))==1, 'Duplicate wallets')
rejects(lambda: reserve(new,uuid.uuid4()), 'Insufficient credits')
rejects(lambda: service('select public.ensure_credit_wallet(%s)',(uuid.uuid4(),)), 'foreign key')
execute('update public.credit_wallets set balance=100 where user_id=%s',(new,))
job = uuid.uuid4()
reserve(new,job)
check(balance(new)==95, 'Single-image price not applied')
batch_job = uuid.uuid4()
reserve(new,batch_job,'generate_batch_4')
check(balance(new)==77, 'Batch total price not applied')
rejects(lambda: reserve(new,uuid.uuid4(),'unknown'), 'Unknown or unpriced')
rejects(lambda: reserve(existing,job), 'owner or type mismatch')
rejects(lambda: reserve(new,job,'generate_batch_4'), 'owner or type mismatch')

install(single=9,batch=30)
check(reserve(new,job)['replayed'], 'Retry lost idempotency after price change')
check(balance(new)==77, 'Retry charged new price')
check(scalar('select credits_reserved from public.generation_jobs where id=%s',(job,))==5, 'Original reservation repriced')
reserve(new,uuid.uuid4())
check(balance(new)==68, 'New job did not use updated price')
check(scalar('select count(*) from public.credit_transactions where user_id=%s',(new,))==3, 'Unexpected ledger entries')

for role in ('anon','authenticated'):
    for signature in ('public.ensure_credit_wallet(uuid)', 'public.reserve_priced_credit_job(uuid,uuid,text)', 'public.create_credit_wallet_for_user()'):
        check(not scalar('select has_function_privilege(%s,%s,\'EXECUTE\')',(role,signature)), 'Client has provisioning or pricing RPC access')
    for privilege in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE'):
        check(not scalar('select has_table_privilege(%s,\'public.credit_prices\',%s)',(role,privilege)), 'Client has price-table access')
rejects(lambda: execute("insert into public.credit_prices(job_type,credits) values('invalid_zero',0)"), 'check constraint')
check(balance(legacy)==0, 'Unexpected free-credit grant')
print('PASS: backfill, signup trigger, reruns, zero grants, server prices, price-change retries, unknown types, ownership, and permissions')
