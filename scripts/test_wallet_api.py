import json
import os
import uuid
import urllib.error
import urllib.parse
import urllib.request

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def main():
    names = ('WALLET_TEST_SUPABASE_URL','WALLET_TEST_ANON_KEY','WALLET_TEST_EMAIL','WALLET_TEST_PASSWORD')
    require(all(os.environ.get(k) for k in names), 'Set all four WALLET_TEST repository secrets')
    base, key, email, password = (os.environ[k] for k in names)
    base = base.rstrip('/')
    parsed = urllib.parse.urlsplit(base)
    require(parsed.scheme=='https' and parsed.hostname and not parsed.username and not parsed.password and parsed.path in ('','/') and not parsed.query and not parsed.fragment, 'Test URL must be an HTTPS project origin')

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(NoRedirect)

    def request(path, token=None, payload=None):
        headers = {'apikey':key, 'Accept':'application/json'}
        if token:
            headers['Authorization'] = 'Bearer '+token
        data = None
        if payload is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(payload).encode()
        req = urllib.request.Request(base+path, data=data, headers=headers)
        try:
            with opener.open(req, timeout=20) as response:
                status, raw = response.status, response.read()
        except urllib.error.HTTPError as exc:
            status, raw = exc.code, exc.read()
        try:
            body = json.loads(raw) if raw else None
        except (ValueError, UnicodeDecodeError):
            raise RuntimeError('API returned non-JSON data; response omitted') from None
        return status, body

    status, login = request('/auth/v1/token?grant_type=password', payload={'email':email,'password':password})
    require(status==200 and isinstance(login,dict) and login.get('access_token'), 'Test account sign-in failed; confirm account, password, and project key')
    token = login['access_token']
    user = str(uuid.UUID(login['user']['id']))
    try:
        status, rows = request('/rest/v1/credit_wallets?select=user_id,balance&limit=2',token)
        require(status==200 and isinstance(rows,list) and len(rows)==1, 'Expected exactly one accessible wallet; verify provisioning and SELECT policy')
        require(rows[0].get('user_id')==user and type(rows[0].get('balance')) is int and rows[0]['balance']>=0, 'Invalid or foreign wallet returned')
        print('PASS: signed-in account reads its own nonnegative wallet')

        for table in ('credit_wallets','credit_transactions','generation_jobs'):
            status, rows = request('/rest/v1/'+table+'?select=user_id&user_id=neq.'+user+'&limit=1',token)
            require(status==200 and rows==[], 'Cross-user read check failed: '+table)
            status, rows = request('/rest/v1/'+table+'?select=user_id&limit=1')
            require((status==200 and rows==[]) or (status in (401,403) and isinstance(rows,dict) and rows.get('code')=='42501'), 'Anonymous read check failed: '+table)
        print('PASS: no foreign rows returned; anonymous table reads blocked or empty')
        print('LIMIT: use a project with at least two populated accounts for meaningful cross-user coverage. This cannot prove isolation when foreign rows do not exist. No credit mutation, generation, signup, or application-route tests are performed.')
    finally:
        status, _ = request('/auth/v1/logout?scope=local',token,payload={})
        require(status==204, 'Test session cleanup failed; revoke the dedicated test session manually')
    print('PASS: test session signed out')

if __name__=='__main__':
    try:
        main()
    except (RuntimeError, ValueError, KeyError, TypeError) as exc:
        if isinstance(exc,RuntimeError):
            raise SystemExit('FAIL: '+str(exc)) from None
        raise SystemExit('FAIL: unexpected API response shape; response omitted') from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise SystemExit('FAIL: API connection failed; connection details omitted') from None
