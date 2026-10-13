const SUPABASE_URL = 'https://qvesjthnzneimllpujng.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ZB_b365K0Q-JTYpKoYPswQ_Y8JJ6qZ9';

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const form = document.getElementById('auth-form');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const primaryAction = document.getElementById('primary-action');
const toggleMode = document.getElementById('toggle-mode');
const forgotPassword = document.getElementById('forgot-password');
const message = document.getElementById('auth-message');
const sessionStatus = document.getElementById('session-status');
const signOut = document.getElementById('sign-out');

let mode = 'signin';
let recoveryMode = false;

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
  message.hidden = false;
}

function clearMessage() {
  message.hidden = true;
  message.textContent = '';
}

function setBusy(busy) {
  primaryAction.disabled = busy;
  toggleMode.disabled = busy;
  forgotPassword.disabled = busy;
}

function setMode(nextMode) {
  mode = nextMode;
  clearMessage();
  if (mode === 'signin') {
    primaryAction.textContent = 'Sign in';
    toggleMode.textContent = 'Need an account? Sign up';
    passwordInput.autocomplete = 'current-password';
  } else {
    primaryAction.textContent = 'Create account';
    toggleMode.textContent = 'Already have an account? Sign in';
    passwordInput.autocomplete = 'new-password';
  }
}

function setRecoveryMode(enabled) {
  recoveryMode = enabled;
  clearMessage();

  if (enabled) {
    primaryAction.textContent = 'Update password';
    toggleMode.hidden = true;
    forgotPassword.hidden = true;
    emailInput.closest('.field')?.setAttribute('hidden', '');
    passwordInput.autocomplete = 'new-password';
    passwordInput.placeholder = 'New password';
    passwordInput.value = '';
    passwordInput.focus();
    showMessage('Choose a new password for your account.');
  } else {
    primaryAction.textContent = mode === 'signin' ? 'Sign in' : 'Create account';
    toggleMode.hidden = false;
    forgotPassword.hidden = false;
    emailInput.closest('.field')?.removeAttribute('hidden');
    passwordInput.placeholder = 'Password';
    passwordInput.autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  }
}

function setSession(user) {
  if (user) {
    sessionStatus.textContent = `Signed in as ${user.email}`;
    signOut.hidden = false;
    form.hidden = true;
    toggleMode.hidden = true;
    forgotPassword.hidden = true;
  } else {
    sessionStatus.textContent = '';
    signOut.hidden = true;
    form.hidden = false;
    toggleMode.hidden = false;
    forgotPassword.hidden = false;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessage();
  setBusy(true);

  const password = passwordInput.value;

  try {
    if (recoveryMode) {
      if (password.length < 8) {
        throw new Error('New password must be at least 8 characters.');
      }

      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;

      recoveryMode = false;
      setRecoveryMode(false);
      showMessage('Password updated. You can now continue.');
      await refreshSession();
      return;
    }

    const email = emailInput.value.trim();
    const result = mode === 'signin'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });

    if (result.error) throw result.error;

    if (mode === 'signup') {
      showMessage('Check your email to confirm your account.');
    }

    await refreshSession();
  } catch (error) {
    showMessage(error.message || 'Authentication failed.', true);
  } finally {
    setBusy(false);
  }
});

forgotPassword.addEventListener('click', async () => {
  clearMessage();
  const email = emailInput.value.trim();
  if (!email) {
    showMessage('Enter your email first, then choose Forgot password.', true);
    return;
  }

  setBusy(true);
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/static/auth.html'
    });
    if (error) throw error;
    showMessage('Password reset email sent.');
  } catch (error) {
    showMessage(error.message || 'Could not send reset email.', true);
  } finally {
    setBusy(false);
  }
});

signOut.addEventListener('click', async () => {
  await supabase.auth.signOut();
  setSession(null);
});

async function refreshSession() {
  const { data } = await supabase.auth.getSession();
  setSession(data?.session?.user || null);
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    setRecoveryMode(true);
    return;
  }

  setSession(session?.user || null);
});

refreshSession();
