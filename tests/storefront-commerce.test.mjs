import test from 'node:test';
import assert from 'node:assert/strict';
import { cartKey, normalizeCart, normalizeDeliveryAddress, cartItemProblem, checkoutFingerprint, formatOrderSlot, orderIsActive, createAccountBoundCommerceApi, initializeStorefrontCommerce } from '../storefront-commerce.js';
import { createCommerceApi, CommerceError } from '../commerce-client.js';

const productId = '11111111-2222-4333-8444-555555555555';
const address = { recipient: '  Asha   Nath ', phone: '98765 43210', line1: '42 Malviya Marg', line2: '', landmark: '', city: 'Hazaribagh', state: 'Jharkhand', postal_code: '825301', latitude: '23.99328', longitude: '85.35937' };

test('cart isolates variants, merges matching lines and drops malformed entries', () => {
  const result = normalizeCart([{ product_id: productId, quantity: 2, size: 'M', color: 'Blue', price: .01, owner: 'other-user' }, { product_id: productId, quantity: 4, size: 'M', color: 'Blue' }, { product_id: productId, quantity: 1, size: 'L', color: 'Blue' }, { product_id: 'sample-1', quantity: 1 }, { product_id: productId, quantity: -1 }], 20, 5);
  assert.deepEqual(result, [{ product_id: productId, quantity: 5, size: 'M', color: 'Blue' }, { product_id: productId, quantity: 1, size: 'L', color: 'Blue' }]);
  assert.notEqual(cartKey(result[0]), cartKey(result[1]));
  assert.equal(normalizeCart(result, 1).length, 1);
  assert.deepEqual(normalizeCart({ broken: true }), []);
});

test('delivery requires complete contact, postal address and explicit valid map coordinates', () => {
  const normalized = normalizeDeliveryAddress(address);
  assert.equal(normalized.recipient, 'Asha Nath');
  assert.equal(normalized.phone, '+919876543210');
  assert.equal(normalized.latitude, 23.99328);
  for (const replacement of [{ recipient: ' ' }, { phone: 'bad' }, { line1: ' ' }, { city: '' }, { postal_code: '825301extra' }, { postal_code: '000000' }, { latitude: '' }, { latitude: null }, { longitude: undefined }, { latitude: '91' }, { longitude: '-181' }]) assert.throws(() => normalizeDeliveryAddress({ ...address, ...replacement }));
});

test('cart detects server catalogue changes before review and does not trust persisted prices', () => {
  const item = { product_id: productId, quantity: 3, size: 'M', color: 'Blue', price: 0 };
  const product = { is_active: true, price: 1200, stock_quantity: 3, size_options: ['M'], color_options: ['Blue'] };
  assert.equal(cartItemProblem(item, product), '');
  assert.match(cartItemProblem(item, { ...product, stock_quantity: 2 }), /stock/);
  assert.match(cartItemProblem(item, { ...product, size_options: ['L'] }), /sizes/);
  assert.match(cartItemProblem(item, { ...product, price: null }), /unavailable/);
  assert.match(cartItemProblem(item, product, { max_quantity_per_item: 2 }), /limit/);
  assert.match(cartItemProblem(item, null), /unavailable/);
});

test('request fingerprint is stable for retry, changes with address or quantity and contains no plaintext', async () => {
  const request = { items: [{ product_id: productId, quantity: 1 }], address: normalizeDeliveryAddress(address) };
  const fingerprint = await checkoutFingerprint(request);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await checkoutFingerprint(request), fingerprint);
  assert.notEqual(await checkoutFingerprint({ ...request, address: { ...request.address, line1: 'Another street 44' } }), fingerprint);
  assert.notEqual(await checkoutFingerprint({ ...request, items: [{ product_id: productId, quantity: 2 }] }), fingerprint);
  assert.doesNotMatch(fingerprint, /Asha|Malviya|98765/);
});

test('customer API sends authenticated token, public key and only explicit action payload', async () => {
  let sent;
  const call = createCommerceApi({ url: 'https://example.supabase.co/', anonKey: 'public' }, {
    getAccessToken: async () => 'customer-session',
    fetchImpl: async (url, request) => { sent = { url, request }; return { ok: true, json: async () => ({ orders: [] }) }; }
  });
  assert.deepEqual(await call('my_orders', { action: 'admin_settings', filter: 'past' }), { orders: [] });
  assert.equal(sent.url, 'https://example.supabase.co/functions/v1/commerce');
  assert.equal(sent.request.headers.Authorization, 'Bearer customer-session');
  assert.equal(sent.request.headers.apikey, 'public');
  assert.equal(JSON.parse(sent.request.body).action, 'my_orders');
  assert.equal(sent.request.headers['X-Admin-Session'], undefined);
});

test('admin API uses explicit session header and server errors keep actionable code and status', async () => {
  let headers;
  const call = createCommerceApi({ url: 'https://example.supabase.co', anonKey: 'public' }, {
    getAdminToken: () => 'opaque-admin-session',
    fetchImpl: async (url, request) => { headers = request.headers; return { ok: false, status: 429, json: async () => ({ error: { code: 'CODE_LOCKED', message: 'Try again later.' } }) }; }
  });
  await assert.rejects(call('admin_complete_delivery', { order_id: productId, code: '1234' }), error => error instanceof CommerceError && error.code === 'CODE_LOCKED' && error.status === 429 && error.message === 'Try again later.');
  assert.equal(headers['X-Admin-Session'], 'opaque-admin-session');
});

test('network and non-JSON failures are contained without exposing credentials', async () => {
  const config = { url: 'https://example.supabase.co', anonKey: 'public' };
  await assert.rejects(createCommerceApi(config, { fetchImpl: async () => { throw new Error('private-token'); } })('public_settings'), error => error.code === 'NETWORK_ERROR' && !error.message.includes('private-token'));
  await assert.rejects(createCommerceApi(config, { fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error('private-body'); } }) })('public_settings'), error => error.status === 502 && !error.message.includes('private-body'));
  await assert.rejects(createCommerceApi({})('public_settings'), error => error.code === 'NOT_CONFIGURED');
});

test('history status and delivery slot formatting distinguish active from terminal orders', () => {
  assert.equal(orderIsActive({ status: 'out_for_delivery' }), true);
  assert.equal(orderIsActive({ status: 'cancelled' }), false);
  assert.equal(orderIsActive({ status: 'delivered' }), false);
  assert.match(formatOrderSlot({ slot_start: '2026-11-09T05:30:00Z', slot_end: '2026-11-09T07:30:00Z' }), /9 Nov 2026.*11:00.*1:00/);
});

test('checkout data cannot be sent with a replacement customer token while token refresh is pending', async () => {
  let user = { id: 'customer-a' }, finishToken;
  let requests = 0;
  const account = { getUser: () => user, getAccessToken: () => new Promise(resolve => { finishToken = resolve; }) };
  const api = createAccountBoundCommerceApi({ url: 'https://example.supabase.co', anonKey: 'public' }, account, { fetchImpl: async () => { requests++; return { ok: true, json: async () => ({}) }; } });
  const pending = api.call('place_order', { address, items: [{ product_id: productId, quantity: 1 }] });
  user = { id: 'customer-b' }; api.invalidate(); finishToken('customer-b-token');
  await assert.rejects(pending, error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(requests, 0);
});

test('logout and signing back into the same customer discards a delayed private body', async () => {
  let finishBody, bodyStarted;
  const started = new Promise(resolve => { bodyStarted = resolve; });
  const account = { getUser: () => ({ id: 'customer-a' }), getAccessToken: async () => 'customer-a-token' };
  const api = createAccountBoundCommerceApi({ url: 'https://example.supabase.co', anonKey: 'public' }, account, { fetchImpl: async () => ({ ok: true, json: () => { bodyStarted(); return new Promise(resolve => { finishBody = resolve; }); } }) });
  const pending = api.call('delivery_code', { order_id: productId });
  await started;
  api.invalidate(); api.invalidate();
  finishBody({ code: '1234' });
  await assert.rejects(pending, error => error.code === 'ACCOUNT_CHANGED');
});

test('public ordering settings do not wait for a customer token refresh', async () => {
  let tokenRequests = 0;
  const api = createAccountBoundCommerceApi({ url: 'https://example.supabase.co', anonKey: 'public' }, { getUser: () => ({ id: 'customer-a' }), getAccessToken() { tokenRequests++; return new Promise(() => {}); } }, { fetchImpl: async () => ({ ok: true, json: async () => ({ settings: { allow_orders: true } }) }) });
  assert.equal((await api.call('public_settings')).settings.allow_orders, true);
  assert.equal(tokenRequests, 0);
});

function storefrontFixture(t, { items = [{ product_id: productId, quantity: 1 }] } = {}) {
  const elements = new Map(), local = new Map(), session = new Map();
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.value = ''; this.hidden = false; this.disabled = false; this.open = false; this.dataset = {}; this.listeners = new Map(); this.fields = new Map(); this.elements = { namedItem: name => { if (!this.fields.has(name)) this.fields.set(name, new Element('input')); return this.fields.get(name); } }; }
    set id(value) { this._id = value; elements.set(value, this); } get id() { return this._id; }
    setAttribute(name, value) { this[name] = value; } removeAttribute(name) { delete this[name]; }
    append(...values) { this.children.push(...values); } replaceChildren(...values) { this.children = values; }
    addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(callback); }
    async fire(name = 'click') { for (const callback of this.listeners.get(name) || []) await callback({ target: this, preventDefault() {} }); }
    showModal() { this.open = true; } close() { this.open = false; void this.fire('close'); }
    querySelectorAll() { return [...this.fields.values()]; }
    reset() { for (const field of this.fields.values()) field.value = ''; }
    scrollIntoView() {}
  }
  const document = { hidden: false, body: new Element('body'), head: new Element('head'), createElement: tag => new Element(tag), getElementById: id => { if (!elements.has(id)) { const element = new Element(id === 'shoppingCheckout' ? 'form' : 'div'); element.id = id; } return elements.get(id); } };
  const map = { setView() { return this; }, on() {}, invalidateSize() {} };
  const store = backing => ({ getItem: key => backing.get(key) || null, setItem: (key, value) => backing.set(key, String(value)), removeItem: key => backing.delete(key) });
  const originals = new Map(['document', 'window', 'localStorage', 'sessionStorage', 'fetch', 'setInterval', 'clearInterval', 'requestAnimationFrame'].map(key => [key, globalThis[key]]));
  t.after(() => { for (const [key, value] of originals) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  globalThis.document = document; globalThis.localStorage = store(local); globalThis.sessionStorage = store(session);
  globalThis.window = { location: new URL('http://localhost:5500/'), history: { state: null, replaceState() {} }, addEventListener() {}, L: { map: () => map, tileLayer: () => ({ addTo() {} }) } };
  globalThis.setInterval = () => 1; globalThis.clearInterval = () => {}; globalThis.requestAnimationFrame = callback => callback();
  const products = items.map(item => ({ id: item.product_id, title: 'Test product', price: 100, stock_quantity: 100, is_active: true, size_options: [], color_options: [] }));
  let user = { id: 'customer-a' }, subscriber;
  const requests = [];
  const state = { settings: { allow_orders: true, max_items_per_order: 100, max_quantity_per_item: 100 }, failSettings: false, quote: async () => ({ total: 100, subtotal: 100, delivery_fee: 0, slot_start: '2026-11-09T05:30:00Z', slot_end: '2026-11-09T07:30:00Z' }) };
  globalThis.fetch = async (url, options) => { const payload = JSON.parse(options.body); requests.push(payload); if (payload.action === 'public_settings') { if (state.failSettings) throw new Error('Offline'); return { ok: true, json: async () => ({ settings: state.settings }) }; } if (payload.action === 'quote') return { ok: true, json: async () => ({ quote: await state.quote() }) }; return { ok: true, json: async () => ({ orders: [], total: 0 }) }; };
  const account = { getUser: () => user, getProfile: () => ({ full_name: 'Asha Nath', phone: '+919876543210' }), getAccessToken: async () => `${user?.id}-token`, isProfileComplete: () => Boolean(user), onChange(callback) { subscriber = callback; }, open() {}, close() {} };
  localStorage.setItem('anurag-cart-v1:customer-a', JSON.stringify(items));
  return { ui: id => document.getElementById(id), products, account, local, requests, state, document, change(nextUser) { user = nextUser; subscriber({ user, profileLoaded: true }); } };
}

test('reload and account switching preserve carts above the old default limits and expose lower current limits', async t => {
  const items = Array.from({ length: 25 }, (_, index) => ({ product_id: `11111111-2222-4333-8444-${String(index).padStart(12, '0')}`, quantity: index === 0 ? 75 : 1 }));
  const fixture = storefrontFixture(t, { items });
  const commerce = await initializeStorefrontCommerce({ url: 'https://example.supabase.co', anonKey: 'public' }, { account: fixture.account, getProducts: () => fixture.products });
  const saved = () => JSON.parse(fixture.local.get('anurag-cart-v1:customer-a'));
  assert.equal(saved().length, 25); assert.equal(saved()[0].quantity, 75);
  fixture.change({ id: 'customer-b' }); fixture.change({ id: 'customer-a' });
  assert.equal(saved().length, 25); assert.equal(saved()[0].quantity, 75);
  fixture.state.settings = { allow_orders: true, max_items_per_order: 20, max_quantity_per_item: 10 };
  await commerce.refreshSettings(); commerce.openCart();
  assert.equal(fixture.ui('shoppingContinue').disabled, true);
  assert.match(fixture.ui('shoppingItems').children[0].textContent, /25 product choices.*20 choices/);
  assert.equal(saved()[0].quantity, 75);
});

test('a failed settings refresh disables checkout and returns visible product actions to Visit Store', async t => {
  const fixture = storefrontFixture(t);
  const commerce = await initializeStorefrontCommerce({ url: 'https://example.supabase.co', anonKey: 'public' }, { account: fixture.account, getProducts: () => fixture.products });
  const actions = fixture.document.createElement('div');
  commerce.renderProductActions(actions, fixture.products[0]); commerce.openCart();
  fixture.state.failSettings = true;
  await commerce.refreshSettings();
  assert.equal(commerce.getSettings().allow_orders, false);
  for (const id of ['shoppingContinue', 'shoppingReview', 'shoppingPlace']) assert.equal(fixture.ui(id).disabled, true);
  assert.equal(actions.children[0].textContent, 'Visit Store');
  assert.equal(fixture.ui('customerCart').hidden, true);
});

test('a quote arriving after closing and reopening checkout cannot activate Place order', async t => {
  const fixture = storefrontFixture(t);
  const commerce = await initializeStorefrontCommerce({ url: 'https://example.supabase.co', anonKey: 'public' }, { account: fixture.account, getProducts: () => fixture.products });
  commerce.openCart(); await fixture.ui('shoppingContinue').fire();
  const form = fixture.ui('shoppingCheckout');
  for (const [name, value] of Object.entries(address)) form.elements.namedItem(name).value = value;
  let finishQuote, quoteStarted;
  const started = new Promise(resolve => { quoteStarted = resolve; });
  fixture.state.quote = () => { quoteStarted(); return new Promise(resolve => { finishQuote = resolve; }); };
  await form.fire('submit'); await started;
  fixture.ui('shoppingDialog').close(); commerce.openCart();
  finishQuote({ total: 100, subtotal: 100, delivery_fee: 0, slot_start: '2026-11-09T05:30:00Z' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.ui('shoppingPlace').hidden, true);
  assert.equal(fixture.ui('shoppingSlot').hidden, true);
  assert.equal(fixture.requests.filter(request => request.action === 'place_order').length, 0);
});
