import test from 'node:test';
import assert from 'node:assert/strict';

const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-server-only', RESEND_API_KEY: 'test-resend', RESEND_FROM_EMAIL: 'store@example.invalid', APIFY_API_KEY: 'test-apify', CRON_SECRET: 'test-cron', COMMERCE_MAINTENANCE_KEY: 'test-maintenance' };
let captured;
globalThis.Deno = { env: { get: name => env[name] }, serve: handler => { captured = handler; } };
await import('../supabase/functions/send-email/index.ts');
const campaigns = captured;
await import('../supabase/functions/sync-google-reviews/index.ts');
const reviews = captured;
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function network({ valid = false, ready = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer test-server-only');
    if (url.endsWith('/rpc/commerce_validate_admin_token')) return json(valid);
    if (url.endsWith('/rpc/commerce_get_settings')) return json({ admin_password_ready: ready });
    throw new Error('External provider must not be contacted before authorization and input checks.');
  };
  return calls;
}
const req = headers => new Request('https://test.supabase.co/functions/v1/legacy', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
for (const [name, handler] of [['campaigns', campaigns], ['review refresh', reviews]]) {
  test(`${name}: missing and forged admin sessions cannot reach a provider`, async () => {
    const calls = network();
    assert.equal((await handler(req({}))).status, 401);
    assert.equal(calls.length, 0);
    assert.equal((await handler(req({ 'x-admin-session': 'a'.repeat(64) }))).status, 401);
    assert.equal(calls.length, 1);
  });
  test(`${name}: a valid session still requires administrator password review`, async () => {
    const calls = network({ valid: true, ready: false });
    assert.equal((await handler(req({ 'x-admin-session': 'a'.repeat(64) }))).status, 403);
    assert.equal(calls.length, 2);
  });
}
test('campaigns: reviewed admin session reaches input validation without sending an empty campaign', async () => {
  const calls = network({ valid: true, ready: true });
  assert.equal((await campaigns(req({ 'x-admin-session': 'a'.repeat(64) }))).status, 400);
  assert.equal(calls.length, 2);
});

test('review refresh: an incorrect maintenance token cannot bypass staff authentication', async () => {
  const calls = network();
  assert.equal((await reviews(req({ 'x-commerce-maintenance': 'wrong-maintenance' }))).status, 401);
  assert.equal(calls.length, 0);
});

test('review refresh: the scoped scheduled token reaches the provider without a browser session', async () => {
  const calls = [];
  globalThis.fetch = async url => { calls.push(String(url)); return new Response(JSON.stringify({ error: 'synthetic provider failure' }), { status: 503 }); };
  const response = await reviews(req({ 'x-commerce-maintenance': env.COMMERCE_MAINTENANCE_KEY }));
  assert.equal(response.status, 500);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/api\.apify\.com\//);
});
