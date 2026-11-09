import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function fixture() {
  const source = (await readFile(new URL('../orders-admin.js', import.meta.url), 'utf8')).replace(/^import .*?;\s*$/gm, '');
  const context = vm.createContext({ document: { addEventListener() {} }, window: {}, navigator: { geolocation: { clearWatch() {} } }, adminToken: () => context.token, clearAdminSession: () => { context.token = ''; }, Intl, Date });
  context.token = 'a'.repeat(64);
  new vm.Script(`${source}\n;globalThis.hooks = { state, ui, call, clearPrivateState, startLocation, stopLocation };`).runInContext(context);
  const element = () => ({ children: ['private data'], textContent: '', hidden: false, value: '', dataset: {}, open: false, replaceChildren(...values) { this.children = values; }, reset() {}, close() { this.open = false; } });
  for (const key of ['loginStatus', 'useAdminLocation', 'ordersList', 'customersList', 'inventoryList', 'deliveryList', 'orderDetailBody', 'commerceSettingsForm', 'settingEmailSubject', 'settingEmailBody', 'emailPreviewSubject', 'emailPreviewBody', 'orderDialog', 'commerceDashboard', 'commerceLogin', 'adminLogout', 'adminLocationStatus']) context.hooks.ui[key] = element();
  context.hooks.state.authenticated = true;
  return { context, ...context.hooks };
}

test('a delayed orders response cannot cross logout and a new admin sign-in', async () => {
  const { context, state, call } = await fixture();
  let finish;
  state.api = () => new Promise(resolve => { finish = resolve; });
  const request = call('admin_orders');
  state.sessionGeneration++;
  context.token = 'b'.repeat(64);
  finish({ orders: [{ customer_email: 'private@example.invalid' }] });
  await assert.rejects(request, { code: 'SESSION_CHANGED' });
  assert.equal(state.authenticated, true);
  assert.equal(context.token, 'b'.repeat(64));
});

test('an old unauthorized response cannot sign out a replacement admin session', async () => {
  const { context, state, call } = await fixture();
  let finish;
  state.api = () => new Promise((resolve, reject) => { finish = reject; });
  const request = call('admin_customers');
  state.sessionGeneration++;
  context.token = 'b'.repeat(64);
  const error = new Error('Expired previous session'); error.status = 401;
  finish(error);
  await assert.rejects(request, /Expired previous session/);
  assert.equal(state.authenticated, true);
  assert.equal(context.token, 'b'.repeat(64));
});

test('clearing the commerce session removes customer details and the map immediately', async () => {
  const { context, state, ui, clearPrivateState } = await fixture();
  state.orders = [{ customer_email: 'private@example.invalid' }];
  state.customers = [{ email: 'private@example.invalid' }];
  state.detail = state.orders[0];
  let removed = false;
  state.map = { remove() { removed = true; } };
  clearPrivateState();
  assert.equal(context.token, '');
  assert.equal(state.authenticated, false);
  assert.equal(state.orders.length, 0);
  assert.equal(state.customers.length, 0);
  assert.equal(state.detail, null);
  assert.equal(ui.orderDetailBody.children.length, 0);
  assert.equal(ui.customersList.children.length, 0);
  assert.equal(ui.commerceDashboard.hidden, true);
  assert.equal(removed, true);
});

test('a location callback queued before Stop cannot restore staff location', async () => {
  const { context, state, startLocation, stopLocation } = await fixture();
  let location;
  context.navigator.geolocation.watchPosition = callback => { location = callback; return 1; };
  state.tab = 'delivery';
  startLocation();
  stopLocation();
  location({ coords: { latitude: 23.99, longitude: 85.35, accuracy: 10 } });
  assert.equal(state.ownLocation, null);
  assert.equal(state.geoWatch, null);
});
