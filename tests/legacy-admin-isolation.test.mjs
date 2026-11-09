import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor(hidden = false) { this.hidden = hidden; this.classes = new Set(hidden ? ['hidden'] : []); this.textContent = ''; this.value = ''; this.disabled = false; this.children = []; this.classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value), toggle: (value, force) => { if (force === undefined ? !this.classes.has(value) : force) this.classes.add(value); else this.classes.delete(value); }, contains: value => this.classes.has(value) }; }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  reset() { this.value = ''; }
  addEventListener() {}
  setAttribute() {}
  querySelector() { return new Element(); }
  querySelectorAll() { return []; }
}
const config = { url: 'https://example.supabase.co', anonKey: 'public-key' };

async function loadPage(filename, loader) {
  const html = await readFile(filename, 'utf8');
  const body = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*?;\s*$/gm, '');
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element(match[1] === 'dashboard')]));
  const store = new Map();
  const storage = { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
  const document = { hidden: false, addEventListener() {}, getElementById: id => elements.get(id) || new Element(), querySelector: selector => elements.get(selector.slice(1)) || new Element(), querySelectorAll: () => [], createElement: () => new Element() };
  const context = vm.createContext({ document, window: { addEventListener() {}, supabase: { createClient() {} }, setInterval() { return 1; }, clearInterval() {} }, localStorage: storage, sessionStorage: storage, ADMIN_SESSION_KEY: 'test-admin-session', adminToken: () => context.token, loadSupabaseConfig: async () => config, validateAdminSession: async () => null, signOutAdmin: async () => {}, console: { log() {}, warn() {}, error() {} }, URL, Intl, Date, setTimeout, clearTimeout });
  context.token = 'a'.repeat(64);
  new vm.Script(body + `\n;globalThis.hooks = { state, dom, loader: ${loader}, unlockDashboard, lockDashboard };`).runInContext(context);
  for (const [id, element] of elements) if (!(id in context.hooks.dom)) context.hooks.dom[id] = element;
  return { context, hooks: context.hooks, elements };
}

for (const [filename, loader, dataField, renderNames] of [
  ['admin.html', 'loadProducts', 'products', ['renderProducts', 'renderSubcategories']],
  ['analytics.html', 'loadAnalytics', 'events', ['renderAnalytics']],
  ['email_resend.html', 'loadContacts', 'contacts', ['renderAll']]
]) {
  test(`${filename}: an in-flight private response is discarded after logout`, async () => {
    const { context, hooks } = await loadPage(filename, loader);
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const builder = new Proxy({}, { get(target, property) { if (property === 'then') return pending.then.bind(pending); return () => builder; } });
    const client = { from() { return builder; } };
    hooks.state.client = client; hooks.state.authGeneration = 1;
    context.renders = 0;
    new vm.Script(`setStatus = () => {}; ${renderNames.map(name => `${name} = () => { globalThis.renders++; };`).join('\n')}`).runInContext(context);
    const loading = hooks.loader();
    hooks.state.authGeneration++;
    hooks.state.client = null;
    context.token = '';
    finish({ data: [{ id: 'private-test-record' }], error: null });
    await loading;
    assert.equal(hooks.state[dataField].length, 0);
    assert.equal(context.renders, 0);
  });

  test(`${filename}: dashboard remains hidden until session restoration succeeds`, { timeout: 1000 }, async () => {
    const { context, hooks, elements } = await loadPage(filename, loader);
    let validate;
    let started;
    const validating = new Promise(resolve => { started = resolve; });
    context.validateAdminSession = () => new Promise(resolve => { validate = resolve; started(); });
    new vm.Script(`
      setStatus = () => {};
      ${filename === 'admin.html' ? 'setAdminControlsEnabled = () => {}; purgeAdminAnalytics = async () => {}; loadAnnouncementBoard = async () => {}; loadSiteSettings = async () => {}; loadSubcategories = async () => {}; loadBrands = async () => {}; loadProducts = async () => {}; loadCampaignImages = async () => {}; loadGoogleReviews = async () => {};' : filename === 'analytics.html' ? 'loadAnalytics = async () => {}; startAutoRefresh = () => {};' : 'loadContacts = async () => {}; loadBrands = async () => {}; loadCampaignImages = async () => {};'}
    `).runInContext(context);
    const unlocking = hooks.unlockDashboard();
    await validating;
    assert.equal(elements.get('dashboard').classes.has('hidden'), true);
    assert.equal(elements.get('authGate').classes.has('hidden'), false);
    assert.equal(typeof validate, 'function');
    validate({ from() {} });
    await unlocking;
    assert.equal(elements.get('dashboard').classes.has('hidden'), false);
    assert.equal(elements.get('authGate').classes.has('hidden'), true);
  });
}
