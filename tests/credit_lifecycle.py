import os
import uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import psycopg

URL = os.environ['TEST_DB_URL']
ROOT = Path(__file__).resolve().parents[1]

def check(condition, message):
    if not condition:
        raise AssertionError(message)

def scalar(sql, params=()):
    with psycopg.connect(URL) as c:
        return c.execute(sql, params).fetchone()[0]

def wallet(balance=100):
    user = uuid.uuid4()
    with psycopg.connect(URL) as c:
        c.execute('insert into auth.users(id) values (%s)', (user,))
        c.execute('insert into public.credit_wallets(user_id,balance) values (%s,%s)', (user,balance))
    return user

def action(kind, user, job, cost=None, job_type=None):
    with psycopg.connect(URL) as c:
        c.execute('set local role service_role')
        return c.execute('select public.credit_job_action(%s,%s,%s,%s,%s)', (kind,user,job,cost,job_type)).fetchone()[0]

def rejects(call, expected):
    try:
        call()
    except psycopg.Error as exc:
        check(expected in str(exc), f'Unexpected error: {exc}')
    else:
        raise AssertionError('Expected rejection: ' + expected)

def balance(user):
    return scalar('select balance from public.credit_wallets where user_id=%s', (user,))

with psycopg.connect(URL, autocommit=True) as c:
    c.execute("""
        create role anon nologin;
        create role authenticated nologin;
        create role service_role nologin;
        create schema auth;
        create table auth.users(id uuid primary key);
        create function auth.uid() returns uuid language sql stable as
          $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        grant usage on schema auth to authenticated;
        grant execute on function auth.uid() to authenticated;
    """)
    for name in ['001_credit_wallet.sql', '002_credit_wallet_security.sql', '003_credit_lifecycle.sql']:
        c.execute((ROOT / 'supabase' / 'migrations' / name).read_text())

u = wallet()
j = uuid.uuid4()
action('reserve',u,j,20,'test')
check(balance(u)==80, 'Reserve deduction')
check(action('reserve',u,j,20,'test')['replayed'], 'Reserve retry')
check(balance(u)==80, 'Retry deducted twice')
rejects(lambda: action('reserve',u,j,21,'test'), 'parameters mismatch')
action('commit',u,j)
check(action('commit',u,j)['replayed'], 'Commit retry')
check(balance(u)==80, 'Commit deducted twice')
check(scalar('select lifetime_spent from public.credit_wallets where user_id=%s',(u,))==20, 'Spend accounting')
rejects(lambda: action('refund',u,j), 'cannot transition')

r = uuid.uuid4()
action('reserve',u,r,15,'test')
action('refund',u,r)
check(action('refund',u,r)['replayed'], 'Refund retry')
check(balance(u)==80, 'Refund amount')
rejects(lambda: action('commit',u,r), 'cannot transition')
rejects(lambda: action('reserve',u,uuid.uuid4(),81,'test'), 'Insufficient credits')
check(balance(u)==80, 'Rejected reserve mutated balance')
check(scalar('select count(*) from public.credit_transactions where user_id=%s',(u,))==4, 'Duplicate ledger entries')
other = wallet()
rejects(lambda: action('commit',other,j), 'owner mismatch')

# Multiple independent connections retry the same reservation.
same_user = wallet(10)
same_job = uuid.uuid4()
with ThreadPoolExecutor(max_workers=8) as pool:
    results = list(pool.map(lambda _: action('reserve',same_user,same_job,7,'test'), range(8)))
check(sum(not x['replayed'] for x in results)==1, 'Concurrent retry applied more than once')
check(balance(same_user)==3, 'Concurrent retry balance')

# Competing jobs cannot both spend the same available credits.
race_user = wallet(10)
def compete(_):
    try:
        action('reserve',race_user,uuid.uuid4(),7,'test')
        return True
    except psycopg.Error as exc:
        check('Insufficient credits' in str(exc), str(exc))
        return False
with ThreadPoolExecutor(max_workers=2) as pool:
    wins = list(pool.map(compete, range(2)))
check(sum(wins)==1 and balance(race_user)==3, 'Concurrent overspending')

with psycopg.connect(URL) as c:
    c.execute('set local role authenticated')
    c.execute("select set_config('request.jwt.claim.sub', %s, true)", (str(u),))
    rows = c.execute('select user_id from public.credit_wallets').fetchall()
    check(rows==[(u,)], 'RLS exposed other wallets')
    check(all(row[0]==u for row in c.execute('select user_id from public.generation_jobs').fetchall()), 'RLS exposed other jobs')
    check(all(row[0]==u for row in c.execute('select user_id from public.credit_transactions').fetchall()), 'RLS exposed other transactions')
for role in ['anon','authenticated']:
    check(not scalar("select has_function_privilege(%s,'public.credit_job_action(text,uuid,uuid,integer,text)','EXECUTE')",(role,)), 'Client can execute credit mutation')
    for table in ['credit_wallets','credit_transactions','generation_jobs']:
        for privilege in ['INSERT','UPDATE','DELETE','TRUNCATE']:
            check(not scalar('select has_table_privilege(%s,%s,%s)',(role,'public.'+table,privilege)), 'Client can mutate wallet tables')
print('PASS: reservation, commit, refund, retries, insufficient funds, ownership, RLS, permissions, and concurrent reservations')
