// DepthForge Phase 4 self-hosted JWT authentication helper.
const TOKEN_KEY = 'depthforge_token';
const LEGACY_TOKEN_KEY = 'supabase_token';
const USER_KEY = 'depthforge_user';

function saveSession(token, user) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(LEGACY_TOKEN_KEY, token);
  }
  if (user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY) || null;
}

async function getCurrentSession() {
  const token = getStoredToken();
  if (!token) return null;
  try {
    const res = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      clearSession();
      return null;
    }
    const data = await res.json();
    if (data?.user) {
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      return { access_token: token, user: data.user };
    }
    return null;
  } catch {
    const cached = localStorage.getItem(USER_KEY);
    if (cached) {
      try {
        return { access_token: token, user: JSON.parse(cached) };
      } catch {
        return null;
      }
    }
    return null;
  }
}

function updateAuthUI(session) {
  const email = document.getElementById('userEmail');
  const signIn = document.getElementById('signInBtn');
  const signOut = document.getElementById('signOutBtn');
  if (!email || !signIn || !signOut) return;

  if (session?.user?.email) {
    const creditsText = typeof session.user.credits_balance === 'number'
      ? ` (${session.user.credits_balance} cr)`
      : '';
    email.textContent = `${session.user.email}${creditsText}`;
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
  const modal = document.getElementById('authModal');
  if (modal) {
    modal.style.display = 'flex';
  } else {
    window.location.href = '/login';
  }
}

function closeAuthModal() {
  const modal = document.getElementById('authModal');
  if (modal) modal.style.display = 'none';
  const msg = document.getElementById('authMessage');
  if (msg) msg.textContent = '';
}

async function signInUser() {
  const email = document.getElementById('authEmail')?.value?.trim() || '';
  const password = document.getElementById('authPassword')?.value || '';
  const message = document.getElementById('authMessage');
  if (message) message.textContent = '';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      if (message) message.textContent = data.error || 'Sign in failed.';
      return;
    }
    saveSession(data.token, data.user);
    closeAuthModal();
    await refreshAuthUI();
  } catch (err) {
    if (message) message.textContent = err.message || 'Network error.';
  }
}

async function signOutUser() {
  clearSession();
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

window.DepthForgeAuth = {
  saveSession,
  clearSession,
  getStoredToken,
  getCurrentSession,
  signInUser,
  signOutUser,
  getAuthHeaders
};

window.addEventListener('DOMContentLoaded', refreshAuthUI);
