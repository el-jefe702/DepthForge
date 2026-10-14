// DepthForge Supabase authentication helper.
// Uses the public/anon key only. Never place a service-role or secret key here.
const SUPABASE_URL = 'REPLACE_WITH_SUPABASE_URL';
const SUPABASE_PUBLISHABLE_KEY = 'REPLACE_WITH_SUPABASE_ANON_OR_PUBLISHABLE_KEY';

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

async function getCurrentSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

function updateAuthUI(session) {
  const email = document.getElementById('userEmail');
  const signIn = document.getElementById('signInBtn');
  const signOut = document.getElementById('signOutBtn');
  if (!email || !signIn || !signOut) return;

  if (session?.user?.email) {
    email.textContent = session.user.email;
    email.style.display = 'inline';
    signIn.style.display = 'none';
    signOut.style.display = 'inline-flex';
  } else {
    email.textContent = '';
    email.style.display = 'none';
    signIn.style.display = 'inline-flex';
    signOut.style.display = 'none';
  }
}

function openAuthModal() {
  document.getElementById('authModal').style.display = 'flex';
}

function closeAuthModal() {
  document.getElementById('authModal').style.display = 'none';
  document.getElementById('authMessage').textContent = '';
}

async function signInUser() {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const message = document.getElementById('authMessage');
  message.textContent = '';

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    message.textContent = error.message;
    return;
  }

  closeAuthModal();
  await refreshAuthUI();
}

async function signOutUser() {
  await supabase.auth.signOut();
  await refreshAuthUI();
}

async function refreshAuthUI() {
  try {
    updateAuthUI(await getCurrentSession());
  } catch (error) {
    console.error('Auth session error:', error);
    updateAuthUI(null);
  }
}

async function getAuthHeaders() {
  const session = await getCurrentSession();
  if (!session?.access_token) {
    openAuthModal();
    throw new Error('Sign in required.');
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.access_token}`
  };
}

window.addEventListener('DOMContentLoaded', refreshAuthUI);
