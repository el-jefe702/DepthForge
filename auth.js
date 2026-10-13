import { createClient } from '@supabase/supabase-js';

/**
 * Configurable Supabase authentication middleware.
 *
 * When SUPABASE_AUTH_ENABLED is not exactly 'true', requests pass through
 * unchanged. This allows the existing DepthForge tests and deployment smoke
 * checks to continue working while authentication is rolled out.
 */
export function createAuth(options = {}) {
  const enabled = options.enabled ?? process.env.SUPABASE_AUTH_ENABLED === 'true';
  const supabaseUrl = options.supabaseUrl ?? process.env.SUPABASE_URL;
  const supabaseAnonKey = options.supabaseAnonKey ?? process.env.SUPABASE_ANON_KEY;
  const supabase = options.supabaseClient ?? (
    supabaseUrl && supabaseAnonKey
      ? createClient(supabaseUrl, supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false }
        })
      : null
  );

  async function requireAuth(req, res, next) {
    if (!enabled) {
      req.user = null;
      return next();
    }

    if (!supabase) {
      return res.status(503).json({
        error: 'Authentication is enabled but Supabase is not configured.'
      });
    }

    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice(7).trim()
      : '';

    if (!token) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) {
        return res.status(401).json({ error: 'Invalid or expired session.' });
      }
      req.user = data.user;
      return next();
    } catch (err) {
      console.error('[Auth] Token verification failed:', err?.message || err);
      return res.status(401).json({ error: 'Invalid or expired session.' });
    }
  }

  return {
    supabase,
    requireAuth,
    isEnabled: () => enabled
  };
}

export default createAuth;
