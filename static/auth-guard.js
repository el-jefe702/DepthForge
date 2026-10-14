// Redirects visitors without a Supabase session to the login page.
(function () {
  const SUPABASE_URL = 'https://qvesjthnzneimllpujng.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ZB_b365K0Q-JTYpKoYPswQ_Y8JJ6qZ9';

  window.addEventListener('DOMContentLoaded', async () => {
    try {
      const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session) {
        location.replace('/login.html');
      }
    } catch (err) {
      console.error('Authentication check failed:', err);
      location.replace('/login.html');
    }
  });
})();
