import os
import psycopg

url = os.environ.get('SUPABASE_DB_URL')
if not url:
    raise SystemExit('Missing repository secret SUPABASE_DB_URL')

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

try:
    with psycopg.connect(url) as c:
        c.execute('set transaction isolation level repeatable read, read only')
        def scalar(sql, params=()):
            return c.execute(sql, params).fetchone()[0]

        for table in ('credit_wallets','credit_transactions','generation_jobs','credit_prices'):
            row = c.execute('select relrowsecurity from pg_class where oid=to_regclass(%s)',('public.'+table,)).fetchone()
            require(row is not None and row[0], 'Missing table or disabled RLS: '+table)
            for role in ('anon','authenticated'):
                for privilege in ('INSERT','UPDATE','DELETE','TRUNCATE'):
                    require(not scalar('select has_table_privilege(%s,%s,%s)',(role,'public.'+table,privilege)), 'Client write permission: '+role+' '+table+' '+privilege)
        print('PASS: required tables, RLS flags, and client write restrictions')

        for signature in ('public.credit_job_action(text,uuid,uuid,integer,text)', 'public.ensure_credit_wallet(uuid)', 'public.reserve_priced_credit_job(uuid,uuid,text)'):
            require(scalar('select to_regprocedure(%s) is not null',(signature,)), 'Missing function: '+signature)
            require(scalar('select prosecdef from pg_proc where oid=to_regprocedure(%s)',(signature,)), 'Function is not security definer: '+signature)
            for role in ('anon','authenticated'):
                require(not scalar('select has_function_privilege(%s,%s,\'EXECUTE\')',(role,signature)), 'Client execute permission: '+signature)
            require(scalar('select has_function_privilege(\'service_role\',%s,\'EXECUTE\')',(signature,)), 'Service role cannot execute: '+signature)
        print('PASS: backend function presence and execution permissions')

        require(scalar("select exists(select 1 from pg_trigger where tgrelid='auth.users'::regclass and tgname='depthforge_create_credit_wallet' and not tgisinternal and tgenabled in ('O','A') and tgfoid=to_regprocedure('public.create_credit_wallet_for_user()') and tgtype=5)"), 'Missing or incorrectly configured wallet signup trigger')
        require(scalar('select count(*) from auth.users u where not exists(select 1 from public.credit_wallets w where w.user_id=u.id)')==0, 'Existing users are missing wallets; run wallet provisioning migration')
        require(scalar('select count(*) from public.credit_wallets where balance<0')==0, 'Negative wallet balance found')
        print('PASS: signup trigger configuration, wallet coverage, and nonnegative balances')

        prices = dict(c.execute("select job_type, credits from public.credit_prices where job_type in ('generate_single','generate_batch_4')").fetchall())
        require(all(isinstance(prices.get(k),int) and prices[k]>0 for k in ('generate_single','generate_batch_4')), 'Missing or invalid generation prices')
        for role in ('anon','authenticated'):
            require(not scalar('select has_table_privilege(%s,\'public.credit_prices\',\'SELECT\')',(role,)), 'Client has direct pricing table access')
        print('PASS: positive single-image and four-image batch prices; client reads blocked')
        print('PASS: read-only live configuration checks. This does not test signup execution, API authentication, RLS policy behavior, function source parity, provider calls, or app credit enforcement.')
except (psycopg.Error, RuntimeError) as exc:
    if isinstance(exc, psycopg.Error):
        raise SystemExit('FAIL: database check could not complete (SQLSTATE '+str(exc.sqlstate)+'). Check connectivity, permissions, and installed migrations. Connection details omitted.') from None
    raise SystemExit('FAIL: '+str(exc)) from None
