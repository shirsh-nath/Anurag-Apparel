import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_SESSION_KEY, adminToken, createAdminClient, signInAdmin, validateAdminSession, signOutAdmin, clearAdminSession } from '../admin-session.js';

const token = 'a'.repeat(64);
const config = { url: 'https://example.supabase.co', anonKey: 'public-anon-key' };
const expiryKey = 'anurag-apparel-admin-session-expires';
const legacyKey = 'anurag-apparel-admin-unlocked';
function fixture({ login = { ok: true, token, expires_at: new Date(Date.now() + 60000).toISOString() }, sessionValid = true, rpcImpl } = {}) {
  const session = new Map(), local = new Map(), calls = { clients: [], rpc: [], fetch: [], uploads: [] };
  const storage = map => ({ getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) });
  globalThis.sessionStorage = storage(session);
  globalThis.localStorage = storage(local);
  globalThis.window = { supabase: { createClient(url, key, options) {
    calls.clients.push({ url, key, options });
    return {
      async rpc(name, args) { calls.rpc.push({ name, args }); return rpcImpl ? rpcImpl(name, args) : { data: name === 'commerce_admin_login' ? login : sessionValid, error: null }; },
      storage: { from(bucket) { return {
        async uploadToSignedUrl(path, capability, body, options) { calls.uploads.push({ bucket, path, capability, body, options }); return { data: { path }, error: null }; },
        async upload() { throw new Error('Unsigned upload must never be used'); },
        async remove() { throw new Error('Unsigned removal must never be used'); }
      }; } }
    };
  } } };
  globalThis.fetch = async (url, options) => {
    calls.fetch.push({ url, options, localTokenAtRequest: sessionStorage.getItem(ADMIN_SESSION_KEY) });
    const body = JSON.parse(options.body);
    const data = body.action === 'admin_storage_sign' ? { path: body.path, token: 'path-bound-test-capability' } : body.action === 'admin_storage_remove' ? { data: [{ name: 'removed' }] } : { signed_out: true };
    return { ok: true, status: 200, async json() { return data; } };
  };
  return { session, local, calls };
}

test('a legacy true flag or malformed token cannot restore admin access', () => {
  fixture();
  sessionStorage.setItem(legacyKey, 'true');
  assert.equal(adminToken(), '');
  for (const value of ['true', '1', 'not-a-token', 'a'.repeat(63)]) { sessionStorage.setItem(ADMIN_SESSION_KEY, value); assert.equal(adminToken(), ''); }
  sessionStorage.setItem(ADMIN_SESSION_KEY, token);
  sessionStorage.setItem(expiryKey, new Date(Date.now() - 1000).toISOString());
  assert.equal(adminToken(), '');
});

test('sign-in saves an opaque session and uses an isolated nonpersistent anonymous client', async () => {
  const { calls } = fixture();
  sessionStorage.setItem(legacyKey, 'true');
  const result = await signInAdmin(config, 'test-admin', 'test-password-only');
  assert.equal(result.token, token);
  assert.equal(sessionStorage.getItem(ADMIN_SESSION_KEY), token);
  assert.equal(sessionStorage.getItem(legacyKey), null);
  assert.equal(calls.rpc[0].name, 'commerce_admin_login');
  assert.equal(calls.clients[0].options.auth.persistSession, false);
  assert.equal(calls.clients[0].options.auth.detectSessionInUrl, false);
  assert.equal(calls.clients.at(-1).options.global.headers['x-admin-session'], token);
});

test('a rejected login never installs an admin token', async () => {
  fixture({ login: { ok: false, error: 'invalid_credentials' } });
  await assert.rejects(signInAdmin(config, 'test-admin', 'wrong-test-password'));
  assert.equal(sessionStorage.getItem(ADMIN_SESSION_KEY), null);
});

test('session restoration validates on the server and removes rejected credentials', async () => {
  const { calls } = fixture({ sessionValid: false });
  sessionStorage.setItem(ADMIN_SESSION_KEY, token);
  sessionStorage.setItem(expiryKey, new Date(Date.now() + 60000).toISOString());
  localStorage.setItem('anurag-apparel-is-admin', 'true');
  assert.equal(await validateAdminSession(config), null);
  assert.equal(calls.rpc[0].name, 'commerce_admin_session_valid');
  assert.equal(sessionStorage.getItem(ADMIN_SESSION_KEY), null);
  assert.equal(localStorage.getItem('anurag-apparel-is-admin'), null);
});

test('logout clears local access before the revocation network request', async () => {
  const { calls } = fixture();
  sessionStorage.setItem(ADMIN_SESSION_KEY, token);
  sessionStorage.setItem(expiryKey, new Date(Date.now() + 60000).toISOString());
  await signOutAdmin(config);
  assert.equal(sessionStorage.getItem(ADMIN_SESSION_KEY), null);
  assert.equal(calls.fetch[0].localTokenAtRequest, null);
  assert.equal(JSON.parse(calls.fetch[0].options.body).action, 'admin_logout');
  assert.equal(calls.fetch[0].options.headers['X-Admin-Session'], token);
});

test('media upload requires a signed capability and cannot silently use anonymous upload', async () => {
  const { calls } = fixture();
  sessionStorage.setItem(ADMIN_SESSION_KEY, token);
  const client = createAdminClient(config, token);
  await client.storage.from('product-images').upload('products/test.jpg', 'test-file', { contentType: 'image/jpeg', upsert: true });
  assert.equal(JSON.parse(calls.fetch[0].options.body).action, 'admin_storage_sign');
  assert.equal(calls.fetch[0].options.headers['X-Admin-Session'], token);
  assert.equal(calls.uploads[0].capability, 'path-bound-test-capability');
  assert.equal(calls.uploads[0].options.upsert, false);
});

test('media removal travels through the authenticated admin endpoint', async () => {
  const { calls } = fixture();
  sessionStorage.setItem(ADMIN_SESSION_KEY, token);
  const result = await createAdminClient(config, token).storage.from('product-images').remove(['products/test.jpg']);
  assert.equal(JSON.parse(calls.fetch[0].options.body).action, 'admin_storage_remove');
  assert.deepEqual(JSON.parse(calls.fetch[0].options.body).paths, ['products/test.jpg']);
  assert.equal(calls.fetch[0].options.headers['X-Admin-Session'], token);
  assert.equal(result.error, null);
});

test('a login response arriving after logout cannot create a new local session', async () => {
  let finish;
  fixture({ rpcImpl: () => new Promise(resolve => { finish = resolve; }) });
  const login = signInAdmin(config, 'test-admin', 'test-password-only');
  clearAdminSession();
  finish({ data: { ok: true, token, expires_at: new Date(Date.now() + 60000).toISOString() }, error: null });
  await assert.rejects(login, { name: 'AbortError' });
  assert.equal(adminToken(), '');
});

test('an old validation failure does not clear a newly signed-in session', async () => {
  let finishValidation;
  const replacement = 'b'.repeat(64);
  fixture({ rpcImpl: name => name === 'commerce_admin_session_valid' ? new Promise(resolve => { finishValidation = resolve; }) : { data: { ok: true, token: replacement, expires_at: new Date(Date.now() + 60000).toISOString() }, error: null } });
  sessionStorage.setItem(ADMIN_SESSION_KEY, token);
  const validation = validateAdminSession(config);
  await signInAdmin(config, 'test-admin', 'test-password-only');
  finishValidation({ data: false, error: null });
  assert.equal(await validation, null);
  assert.equal(adminToken(), replacement);
});

test('logout aborts pending admin requests and rejects delayed private response bodies', async () => {
  const { calls } = fixture();
  sessionStorage.setItem(ADMIN_SESSION_KEY, token);
  createAdminClient(config, token);
  const scopedFetch = calls.clients[0].options.global.fetch;
  let finishResponse;
  let requestSignal;
  globalThis.fetch = (url, options) => { requestSignal = options.signal; return new Promise(resolve => { finishResponse = resolve; }); };
  const pending = scopedFetch('https://example.supabase.co/rest/v1/email_contacts');
  clearAdminSession();
  assert.equal(requestSignal.aborted, true);
  finishResponse(new Response('[{"email":"private@example.invalid"}]'));
  await assert.rejects(pending, { name: 'AbortError' });

  sessionStorage.setItem(ADMIN_SESSION_KEY, token);
  createAdminClient(config, token);
  let finishBody;
  globalThis.fetch = async () => ({ json: () => new Promise(resolve => { finishBody = resolve; }) });
  const response = await calls.clients.at(-1).options.global.fetch('https://example.supabase.co/rest/v1/email_contacts');
  const body = response.json();
  clearAdminSession();
  finishBody([{ email: 'private@example.invalid' }]);
  await assert.rejects(body, { name: 'AbortError' });
});
