const PROFILE_COLUMNS = 'id,full_name,phone,created_at,updated_at';

export function normalizeProfile(fullName, phone) {
  const full_name = fullName.trim().replace(/\s+/g, ' ');
  let normalizedPhone = phone.trim().replace(/[\s().-]/g, '');
  if (/^[6-9]\d{9}$/.test(normalizedPhone)) normalizedPhone = `+91${normalizedPhone}`;
  if (full_name.length < 2 || full_name.length > 100) throw new Error('Enter your full name (2–100 characters).');
  if (!/^\+[1-9]\d{7,14}$/.test(normalizedPhone)) throw new Error('Enter a valid phone number with country code, for example +91 98765 43210.');
  return { full_name, phone: normalizedPhone };
}

export function oauthReturnUrl(origin) {
  const url = new URL('/', origin);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Open the store using its website address.');
  url.searchParams.set('account', '1');
  return url.href;
}

export async function initializeCustomerAccount(config) {
  const byId = id => document.getElementById(id);
  const ui = Object.fromEntries(['customerSignIn', 'customerSignUp', 'customerAccount', 'accountDialog', 'accountClose', 'accountTitle', 'accountIntro', 'accountAuth', 'accountProfile', 'accountGoogle', 'accountSwitch', 'accountSwitchCopy', 'accountEmail', 'accountName', 'accountPhone', 'accountSave', 'accountSignOut', 'accountStatus'].map(id => [id, byId(id)]));
  let client, user = null, profile = null, revision = 0, saving = false, profileLoaded = false, signingOut = false;
  const returnRequested = new URL(window.location.href).searchParams.get('account') === '1';
  const callbackUrl = new URL(window.location.href);
  const callbackFailed = callbackUrl.searchParams.has('error') || new URLSearchParams(callbackUrl.hash.slice(1)).has('error');

  function status(message = '', error = false) {
    ui.accountStatus.textContent = message;
    ui.accountStatus.hidden = !message;
    ui.accountStatus.dataset.error = String(error);
  }
  function open(mode = 'signin') {
    render(mode);
    if (!ui.accountDialog.open) ui.accountDialog.showModal();
  }
  function render(mode = 'signin') {
    ui.customerSignIn.hidden = Boolean(user);
    ui.customerSignUp.hidden = Boolean(user);
    ui.customerAccount.hidden = !user;
    ui.accountAuth.hidden = Boolean(user);
    ui.accountProfile.hidden = !user;
    ui.accountGoogle.disabled = !client;
    ui.accountSave.disabled = saving || !profileLoaded;
    if (user) {
      ui.accountTitle.textContent = profile ? 'Your account' : 'Complete your account';
      ui.accountIntro.textContent = 'Your email is verified by Google. Add your contact details so we can identify you when you shop with us.';
      ui.accountEmail.value = user.email || '';
      ui.accountName.value = profile?.full_name || user.user_metadata?.full_name || user.user_metadata?.name || '';
      ui.accountPhone.value = profile?.phone || '';
    } else {
      const signup = mode === 'signup';
      ui.accountTitle.textContent = signup ? 'Create your account' : 'Welcome back';
      ui.accountIntro.textContent = signup ? 'Start with your Google account, then add your name and phone number.' : 'Sign in to your Anurag Apparel account with Google.';
      ui.accountSwitchCopy.textContent = signup ? 'Already have an account?' : 'New to Anurag Apparel?';
      ui.accountSwitch.textContent = signup ? 'Sign in' : 'Create an account';
      ui.accountSwitch.dataset.mode = signup ? 'signin' : 'signup';
      ui.accountEmail.value = ui.accountName.value = ui.accountPhone.value = '';
    }
  }
  function clearCallback() {
    const url = new URL(window.location.href);
    const authKeys = ['code', 'error', 'error_code', 'error_description'];
    for (const key of [...authKeys, 'account']) url.searchParams.delete(key);
    const hash = new URLSearchParams(url.hash.slice(1));
    if (authKeys.some(key => hash.has(key)) || hash.has('access_token')) url.hash = '';
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }
  async function syncSession(session) {
    const nextUser = session?.user || null;
    if (nextUser?.id === user?.id && profileLoaded) return;
    const currentRevision = ++revision;
    user = nextUser;
    profile = null;
    profileLoaded = false;
    render();
    if (!user) return;
    try {
      const { data, error } = await client.from('customer_profiles').select(PROFILE_COLUMNS).eq('id', user.id).maybeSingle();
      if (currentRevision !== revision) return;
      if (error) throw error;
      profile = data;
      profileLoaded = true;
      render();
      status();
      if (!profile || returnRequested) open();
    } catch {
      if (currentRevision !== revision) return;
      status('We could not load your profile. Close this window and open My account to retry.', true);
      open();
    }
  }

  ui.customerSignIn.addEventListener('click', () => open('signin'));
  ui.customerSignUp.addEventListener('click', () => open('signup'));
  ui.customerAccount.addEventListener('click', () => {
    open();
    if (!profileLoaded) void syncSession({ user });
  });
  ui.accountClose.addEventListener('click', () => ui.accountDialog.close());
  ui.accountDialog.addEventListener('click', event => { if (event.target === ui.accountDialog) ui.accountDialog.close(); });
  ui.accountSwitch.addEventListener('click', () => open(ui.accountSwitch.dataset.mode));
  ui.accountGoogle.addEventListener('click', async () => {
    if (!client || ui.accountGoogle.disabled) return;
    ui.accountGoogle.disabled = true;
    status('Opening Google…');
    try {
      const { error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: oauthReturnUrl(window.location.origin), scopes: 'openid email profile', queryParams: { prompt: 'select_account' } }
      });
      if (error) throw error;
    } catch {
      status('Google sign-in could not start. Please try again shortly.', true);
      ui.accountGoogle.disabled = false;
    }
  });
  ui.accountProfile.addEventListener('submit', async event => {
    event.preventDefault();
    if (!user || saving || !profileLoaded || signingOut) return;
    let values;
    try { values = normalizeProfile(ui.accountName.value, ui.accountPhone.value); }
    catch (error) { status(error.message, true); return; }
    const currentUserId = user.id;
    const currentRevision = revision;
    saving = true;
    ui.accountSave.disabled = true;
    status('Saving your details…');
    try {
      const { data, error } = await client.from('customer_profiles').upsert({ id: currentUserId, ...values }, { onConflict: 'id' }).select(PROFILE_COLUMNS).single();
      if (currentRevision !== revision || user?.id !== currentUserId) return;
      if (error) throw error;
      profile = data;
      render();
      status('Your account details are saved.');
    } catch {
      if (currentRevision === revision) status('Your details could not be saved. Please check your connection and try again.', true);
    } finally {
      saving = false;
      ui.accountSave.disabled = !profileLoaded;
    }
  });
  ui.accountSignOut.addEventListener('click', async () => {
    if (!client || signingOut) return;
    signingOut = true;
    ui.accountSignOut.disabled = true;
    ui.accountSave.disabled = true;
    try {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw error;
      await syncSession(null);
      status();
      ui.accountDialog.close();
    } catch { status('Sign out failed. Please try again.', true); }
    finally { signingOut = false; ui.accountSignOut.disabled = false; ui.accountSave.disabled = !profileLoaded; }
  });

  for (const button of [ui.customerSignIn, ui.customerSignUp]) button.disabled = false;
  if (!config?.url || !config?.anonKey || config.url.includes('your_supabase') || !window.supabase?.createClient) {
    status('Account sign-in is temporarily unavailable. Please try again later.', true);
    clearCallback();
    if (returnRequested || callbackFailed) open();
    return;
  }
  // Catalog/admin clients keep using their existing anonymous permissions.
  client = window.supabase.createClient(config.url, config.anonKey, {
    auth: { storageKey: 'anurag-customer-auth', flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true }
  });
  // Never await another Supabase call inside onAuthStateChange's storage lock.
  client.auth.onAuthStateChange((event, session) => {
    if (event === 'TOKEN_REFRESHED' && session?.user.id === user?.id) return;
    setTimeout(() => void syncSession(session), 0);
  });
  try {
    const { data, error } = await client.auth.getSession();
    clearCallback();
    if (error || callbackFailed) throw error || new Error('OAuth failed');
    await syncSession(data.session);
    if (returnRequested && !data.session) {
      status('Sign-in was not completed. Please continue with Google again.', true);
      open();
    }
  } catch {
    clearCallback();
    status('Sign-in was not completed. Please continue with Google again.', true);
    open();
  }
  render();
}
