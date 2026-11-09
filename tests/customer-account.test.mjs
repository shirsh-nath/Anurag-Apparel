import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeCustomerAccount, normalizeProfile, oauthReturnUrl } from '../customer-account.js';
import { loadSupabaseConfig } from '../public-config.js';
import configHandler from '../api/config.js';

const user = { id: 'customer-a', email: 'customer@example.invalid', user_metadata: { full_name: 'Customer Name' } };
const config = { url: 'https://example.supabase.co', anonKey: 'public-key' };

function fixture({ session = null, profile = null, profileError = null, saveError = null, signInError = null, signOutError = null, sessionError = null, href = 'http://localhost:5500/' } = {}) {
  const elements = new Map();
  class Element {
    hidden = false; disabled = false; open = false; value = ''; textContent = ''; dataset = {}; listeners = new Map();
    addEventListener(event, callback) { this.listeners.set(event, callback); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    async fire(event = 'click') { await this.listeners.get(event)?.({ target: this, preventDefault() {} }); }
  }
  globalThis.document = { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); } };
  const calls = { writes: [], reads: [], clients: [], oauth: [] };
  const client = {
    auth: {
      onAuthStateChange(callback) { calls.authCallback = callback; return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session }, error: sessionError }; },
      async signInWithOAuth(options) { calls.oauth.push(options); return { error: signInError }; },
      async signOut(options) { calls.signOut = options; return { error: signOutError }; }
    },
    from(table) {
      assert.equal(table, 'customer_profiles');
      return {
        select() { return { eq(column, id) { calls.reads.push({ column, id }); return { async maybeSingle() { return { data: profile, error: profileError }; } }; } }; },
        upsert(values) { calls.writes.push(values); return { select() { return { async single() { return { data: { ...values }, error: saveError }; } }; } }; }
      };
    }
  };
  globalThis.window = {
    location: new URL(href),
    history: { state: null, replaceState(state, title, url) { window.location = new URL(url, window.location); } },
    supabase: { createClient(url, key, options) { calls.clients.push({ url, key, options }); return client; } }
  };
  return { ui: id => document.getElementById(id), calls, client };
}

test('checkout token belongs to the displayed account even before an Auth change notification arrives', async () => {
  const { client } = fixture({ session: { user, access_token: 'customer-a-token' } });
  const account = await initializeCustomerAccount(config);
  assert.equal(await account.getAccessToken(), 'customer-a-token');
  client.auth.getSession = async () => ({ data: { session: { user: { id: 'customer-b' }, access_token: 'customer-b-token' } }, error: null });
  assert.equal(account.getUser().id, user.id);
  assert.equal(await account.getAccessToken(), null);
});

test('a delayed token read cannot survive customer logout', async () => {
  const { client, ui } = fixture({ session: { user, access_token: 'customer-a-token' } });
  const account = await initializeCustomerAccount(config);
  let finish;
  client.auth.getSession = () => new Promise(resolve => { finish = resolve; });
  const token = account.getAccessToken();
  await ui('accountSignOut').fire();
  finish({ data: { session: { user, access_token: 'customer-a-token' } }, error: null });
  assert.equal(await token, null);
});

test('normalizes Indian and international contact details and rejects malformed input', () => {
  assert.deepEqual(normalizeProfile('  Asha   Nath  ', '98765 43210'), { full_name: 'Asha Nath', phone: '+919876543210' });
  assert.equal(normalizeProfile('Asha Nath', '+44 (7700) 900-123').phone, '+447700900123');
  for (const [name, phone] of [[' ', '+919876543210'], ['A', '+919876543210'], ['N'.repeat(101), '+919876543210'], ['Asha', '123'], ['Asha', '+0123456789'], ['Asha', '98765abc10']]) assert.throws(() => normalizeProfile(name, phone));
});

test('OAuth return URL is same-origin and contains no customer data', () => {
  assert.equal(oauthReturnUrl('https://www.anuragapparel.in'), 'https://www.anuragapparel.in/?account=1');
  assert.equal(oauthReturnUrl('http://localhost:5500'), 'http://localhost:5500/?account=1');
  assert.throws(() => oauthReturnUrl('file:///store'));
});

test('Google sign-up uses PKCE, isolated storage and only identity scopes', async () => {
  const { ui, calls } = fixture();
  await initializeCustomerAccount(config);
  await ui('customerSignUp').fire();
  assert.equal(ui('accountTitle').textContent, 'Create your account');
  assert.equal(ui('accountDialog').open, true);
  await ui('accountGoogle').fire();
  assert.equal(calls.clients[0].options.auth.flowType, 'pkce');
  assert.equal(calls.clients[0].options.auth.storageKey, 'anurag-customer-auth');
  assert.deepEqual(calls.oauth[0], { provider: 'google', options: { redirectTo: 'http://localhost:5500/?account=1', scopes: 'openid email profile', queryParams: { prompt: 'select_account' } } });
  assert.equal(calls.writes.length, 0);
});

test('first login asks for profile; invalid input never reaches database; save uses session identity', async () => {
  const { ui, calls } = fixture({ session: { user }, href: 'http://localhost:5500/?code=one-use&account=1#products' });
  await initializeCustomerAccount(config);
  assert.equal(ui('customerSignIn').hidden, true);
  assert.equal(ui('customerAccount').hidden, false);
  assert.equal(ui('accountDialog').open, true);
  assert.equal(ui('accountEmail').value, user.email);
  assert.equal(window.location.href, 'http://localhost:5500/#products');
  ui('accountPhone').value = 'bad-number';
  await ui('accountProfile').fire('submit');
  assert.equal(calls.writes.length, 0);
  ui('accountPhone').value = '9876543210';
  await ui('accountProfile').fire('submit');
  assert.deepEqual(calls.writes[0], { id: user.id, full_name: 'Customer Name', phone: '+919876543210' });
  assert.match(ui('accountStatus').textContent, /saved/);
  assert.equal(ui('accountSave').disabled, false);
});

test('returning customer restores profile and signs out locally without catalog access', async () => {
  const { ui, calls } = fixture({ session: { user }, profile: { id: user.id, full_name: 'Saved Name', phone: '+919876543210' } });
  await initializeCustomerAccount(config);
  assert.equal(ui('accountDialog').open, false);
  await ui('customerAccount').fire();
  assert.equal(ui('accountName').value, 'Saved Name');
  await ui('accountSignOut').fire();
  assert.deepEqual(calls.signOut, { scope: 'local' });
  assert.equal(ui('accountName').value, '');
  assert.equal(ui('accountEmail').value, '');
  assert.equal(ui('customerAccount').hidden, true);
  assert.equal(ui('accountDialog').open, false);
});

test('database failures stay visible and save can be retried', async () => {
  const { ui } = fixture({ session: { user }, saveError: new Error('database unavailable') });
  await initializeCustomerAccount(config);
  ui('accountPhone').value = '+919876543210';
  await ui('accountProfile').fire('submit');
  assert.equal(ui('accountStatus').dataset.error, 'true');
  assert.equal(ui('accountSave').disabled, false);
  assert.equal(ui('accountDialog').open, true);
});

test('profile read failure prevents overwriting an unknown profile', async () => {
  const { ui, calls } = fixture({ session: { user }, profileError: new Error('network failure') });
  await initializeCustomerAccount(config);
  assert.equal(ui('accountSave').disabled, true);
  await ui('accountProfile').fire('submit');
  assert.equal(calls.writes.length, 0);
  assert.match(ui('accountStatus').textContent, /could not load/);
});

test('provider rejection is retryable; canceled callback is cleaned and shown safely', async () => {
  const { ui } = fixture({ signInError: new Error('provider disabled'), href: 'http://localhost:5500/?error=access_denied&error_description=private-detail&account=1' });
  await initializeCustomerAccount(config);
  assert.equal(window.location.search, '');
  assert.equal(ui('accountDialog').open, true);
  assert.doesNotMatch(ui('accountStatus').textContent, /private-detail/);
  await ui('accountGoogle').fire();
  assert.equal(ui('accountGoogle').disabled, false);
  assert.equal(ui('accountStatus').dataset.error, 'true');
});

test('failed sign-out retains account details and allows retry', async () => {
  const { ui } = fixture({ session: { user }, signOutError: new Error('network failure') });
  await initializeCustomerAccount(config);
  await ui('accountSignOut').fire();
  assert.equal(ui('customerAccount').hidden, false);
  assert.equal(ui('accountSignOut').disabled, false);
  assert.match(ui('accountStatus').textContent, /Sign out failed/);
});

test('missing config keeps Google disabled and displays a useful status', async () => {
  const { ui } = fixture();
  await initializeCustomerAccount({});
  await ui('customerSignIn').fire();
  assert.equal(ui('accountGoogle').disabled, true);
  assert.equal(ui('accountDialog').open, true);
  assert.match(ui('accountStatus').textContent, /unavailable/);
});

test('public configuration never fetches .env, including endpoint failure', async () => {
  fixture();
  const paths = [];
  globalThis.fetch = async path => { paths.push(path); return { ok: false }; };
  assert.deepEqual(await loadSupabaseConfig(), {});
  assert.deepEqual(paths, ['/api/config']);
});

test('config API returns only allowlisted public values even when secrets exist', () => {
  const before = { ...process.env };
  Object.assign(process.env, { SUPABASE_URL: config.url, SUPABASE_ANON_KEY: config.anonKey, GOOGLE_OAUTH_CLIENT_SECRET: 'never-send-this', RESEND_API_KEY: 'private-email-key' });
  let body;
  configHandler({}, { setHeader() {}, status(code) { assert.equal(code, 200); return this; }, json(data) { body = data; } });
  assert.deepEqual(Object.keys(body).sort(), ['maxVideoMb', 'supabaseAnonKey', 'supabaseUrl']);
  assert.doesNotMatch(JSON.stringify(body), /never-send-this|private-email-key/);
  process.env = before;
});

test('catalog cannot consume customer OAuth callback or inherit customer sessions', async () => {
  const html = await readFile('index.html', 'utf8');
  assert.match(html, /storageKey: 'anurag-catalog', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false/);
  for (const page of ['index.html', 'admin.html', 'analytics.html', 'email_resend.html']) assert.doesNotMatch(await readFile(page, 'utf8'), /fetch\(envPath|function parseEnv/);
});
