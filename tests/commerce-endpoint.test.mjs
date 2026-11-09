import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptDeliveryCode } from '../supabase/functions/commerce/domain.mjs';

const owner = 'ab7a3b25-8e8e-4b54-a8c0-111111111111';
const other = 'ab7a3b25-8e8e-4b54-a8c0-222222222222';
const orderId = 'ab7a3b25-8e8e-4b54-a8c0-333333333333';
const productId = 'ab7a3b25-8e8e-4b54-a8c0-444444444444';
const key = randomBytes(32).toString('base64url');
const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'test-public', SUPABASE_SERVICE_ROLE_KEY: 'test-server-only', COMMERCE_CODE_KEY: key, COMMERCE_MAINTENANCE_KEY: 'test-maintenance-only', RESEND_API_KEY: 'test-email-server-only', RESEND_FROM_EMAIL: 'store@example.invalid' };
let handler;
globalThis.Deno = { env: { get: name => env[name] }, serve: fn => { handler = fn; } };
await import('../supabase/functions/commerce/index.ts');
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function mock({ user = { id: owner, email: 'test@example.invalid', email_confirmed_at: new Date().toISOString() }, admin = false, ready = true, rpc = {}, email = () => response({ id: 'test-email' }) } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/auth/v1/user')) return response(user, user ? 200 : 401);
    if (url.includes('/rest/v1/site_settings')) return response([{ email_address: 'store@example.invalid', phone_number: '+919876543210' }]);
    if (url === 'https://api.resend.com/emails') return email(options);
    const name = url.split('/rpc/')[1];
    const args = options.body ? JSON.parse(options.body) : {};
    calls.push({ name, args, headers: options.headers });
    if (name === 'commerce_validate_admin_token') return response(admin);
    if (name === 'commerce_get_settings') return response({ allow_orders: false, admin_password_ready: ready });
    if (name in rpc) return typeof rpc[name] === 'function' ? rpc[name](args) : response(rpc[name]);
    throw new Error(`Unexpected network request: ${url}`);
  };
  return calls;
}
function request(action, data = {}, headers = {}) {
  return new Request('https://test.supabase.co/functions/v1/commerce', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5500', ...headers }, body: JSON.stringify({ ...data, action }) });
}
const customerHeaders = { Authorization: 'Bearer test-customer-jwt' };
const adminHeaders = { 'X-Admin-Session': 'a'.repeat(64) };

test('public settings work while customer routes require a validated verified customer', async () => {
  mock();
  assert.equal((await handler(request('public_settings'))).status, 200);
  assert.equal((await handler(request('my_orders'))).status, 401);
  mock({ user: null });
  assert.equal((await handler(request('my_orders', {}, customerHeaders))).status, 401);
  mock({ user: { id: owner, email: 'test@example.invalid' } });
  assert.equal((await handler(request('my_orders', {}, customerHeaders))).status, 403);
});

test('customer identity is derived from Auth rather than submitted customer_id or admin flags', async () => {
  const calls = mock({ rpc: { commerce_list_orders: { orders: [], total: 0, page: 1, page_size: 25 } } });
  const result = await handler(request('my_orders', { customer_id: other, admin: true, limit: 999 }, customerHeaders));
  assert.equal(result.status, 200);
  assert.equal(calls[0].args.input_customer_id, owner);
  assert.equal(calls[0].args.input_admin, false);
  assert.equal(calls[0].args.input_limit, 100);
  assert.equal(calls[0].headers.Authorization, 'Bearer test-server-only');
  assert.doesNotMatch(await result.text(), /test-server-only/);
});

test('forged admin tokens and unreviewed passwords cannot read customer data', async () => {
  mock();
  assert.equal((await handler(request('admin_customers', {}, adminHeaders))).status, 401);
  const calls = mock({ admin: true, ready: false });
  const result = await handler(request('admin_customers', {}, adminHeaders));
  assert.equal(result.status, 403);
  assert.equal((await result.json()).error.code, 'password_change_required');
  assert.equal(calls.some(call => call.name === 'commerce_list_customers'), false);
});

test('delivery-code reveal requires customer identity and passes ownership to the database', async () => {
  const ciphertext = await encryptDeliveryCode(key, orderId, owner, '0042');
  const calls = mock({ admin: true, rpc: { commerce_order_secret: args => args.input_customer_id === owner ? response({ ciphertext }) : response({ code: '42501', message: 'Order not available' }, 403) } });
  assert.equal((await handler(request('delivery_code', { order_id: orderId }, adminHeaders))).status, 401);
  const result = await handler(request('delivery_code', { order_id: orderId, customer_id: other }, customerHeaders));
  assert.deepEqual(await result.json(), { code: '0042' });
  assert.equal(calls.at(-1).args.input_customer_id, owner);
  mock({ user: { id: other, email: 'other@example.invalid', email_confirmed_at: new Date().toISOString() }, rpc: { commerce_order_secret: response => { assert.equal(response.input_customer_id, other); return new Response(JSON.stringify({ code: '42501', message: 'Order not available' }), { status: 403 }); } } });
  assert.equal((await handler(request('delivery_code', { order_id: orderId }, customerHeaders))).status, 400);
});

test('generic admin status changes cannot complete delivery', async () => {
  const calls = mock({ admin: true });
  const result = await handler(request('admin_update_order', { order_id: orderId, status: 'delivered' }, adminHeaders));
  assert.equal(result.status, 400);
  assert.equal((await result.json()).error.code, 'delivery_verification_required');
  assert.equal(calls.some(call => call.name === 'commerce_update_order'), false);
});

test('delivery verification sends only a bound keyed digest to PostgreSQL and preserves lockout errors', async () => {
  const calls = mock({ admin: true, rpc: { commerce_delivery_context: { customer_id: owner, delivery_code_required: true }, commerce_complete_delivery: { ok: false, error: 'code_locked', retry_after: 900 } } });
  const result = await handler(request('admin_complete_delivery', { order_id: orderId, code: '0042', payment_collected: true }, adminHeaders));
  assert.equal(result.status, 429);
  const verification = calls.find(call => call.name === 'commerce_complete_delivery');
  assert.match(verification.args.input_candidate_digest, /^[a-f0-9]{64}$/);
  assert.equal(verification.args.input_payment_collected, true);
  assert.doesNotMatch(JSON.stringify(verification.args), /0042/);
});

test('checkout rejects missing reviewed prices before creating an order', async () => {
  const calls = mock();
  const result = await handler(request('place_order', { items: [{ product_id: productId, quantity: 1 }], address: { recipient: 'Test Customer', phone: '9876543210', line1: '123 Test Road', city: 'Hazaribagh', state: 'Jharkhand', postal_code: '825301', latitude: 23.99, longitude: 85.35 }, idempotency_key: orderId }, customerHeaders));
  assert.equal(result.status, 400);
  assert.equal((await result.json()).error.code, 'quote_required');
  assert.equal(calls.some(call => call.name === 'commerce_create_order'), false);
});

test('maintenance requires its own server secret; browser origin and request size are enforced', async () => {
  mock();
  assert.equal((await handler(request('maintenance', {}, adminHeaders))).status, 403);
  assert.equal((await handler(request('public_settings', {}, { Origin: 'https://untrusted.example' }))).status, 403);
  const oversized = new Request('https://test.supabase.co/functions/v1/commerce', { method: 'POST', body: 'x'.repeat(65537) });
  assert.equal((await handler(oversized)).status, 413);
});

test('database diagnostic details and secrets never leak through unexpected errors', async () => {
  mock({ rpc: { commerce_list_orders: () => response({ code: 'XX000', message: 'internal order server stack test-server-only' }, 500) } });
  const result = await handler(request('my_orders', {}, customerHeaders));
  assert.equal(result.status, 400);
  assert.doesNotMatch(await result.text(), /test-server-only|internal server stack/);
});

test('maintenance renders personalised transactional email without delivery secrets and acknowledges its lease', async () => {
  const job = { id: orderId, lease_token: productId, timezone: 'Asia/Kolkata', template: { subject: 'Order {{order_number}} for {{customer_name}}', body: 'Hi {{customer_name}}\n{{order_total}}\n{{address}}\nTrack: {{order_url}}' }, order: { id: orderId, order_number: 'AA-TEST', customer_name: 'Test Recipient', customer_email: 'recipient@example.invalid', total: 250, slot_start: new Date().toISOString(), address: { line1: '123 Sample Road', city: 'Hazaribagh', postal_code: '825301' }, items: [{ title: 'Test Product', quantity: 1 }] } };
  let sent;
  const calls = mock({ rpc: { commerce_housekeeping: { deleted_orders: 0 }, commerce_claim_emails: [job], commerce_finish_email: true }, email: options => { sent = options; return response({ id: 'fake-provider-receipt' }); } });
  const result = await handler(request('maintenance', {}, { 'x-commerce-maintenance': env.COMMERCE_MAINTENANCE_KEY }));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).emails.sent, 1);
  const payload = JSON.parse(sent.body);
  assert.deepEqual(payload.to, ['recipient@example.invalid']);
  assert.match(payload.subject, /Test Recipient/);
  assert.match(payload.text, /123 Sample Road/);
  assert.match(payload.text, /https:\/\/www.anuragapparel.in\/\?orders=1/);
  assert.doesNotMatch(sent.body, /delivery_code|code_digest|ciphertext|test-server-only|test-email-server-only/);
  assert.equal(sent.headers['Idempotency-Key'], `anurag-order-event/${orderId}`);
  const finished = calls.find(call => call.name === 'commerce_finish_email');
  assert.equal(finished.args.input_lease_token, productId);
  assert.equal(finished.args.input_success, true);
});

test('provider failures queue an email retry without exposing provider response content', async () => {
  const calls = mock({ rpc: { commerce_housekeeping: {}, commerce_claim_emails: [{ id: orderId, lease_token: productId, template: { subject: 'Order received', body: 'Hi {{customer_name}}' }, order: { customer_name: 'Test', customer_email: 'recipient@example.invalid', total: 10, slot_start: new Date().toISOString() } }], commerce_finish_email: true }, email: () => response({ message: 'private provider detail' }, 429) });
  const result = await handler(request('maintenance', {}, { 'x-commerce-maintenance': env.COMMERCE_MAINTENANCE_KEY }));
  assert.equal((await result.json()).emails.failed, 1);
  const finished = calls.find(call => call.name === 'commerce_finish_email');
  assert.equal(finished.args.input_success, false);
  assert.equal(finished.args.input_error, 'Email provider HTTP 429');
});
