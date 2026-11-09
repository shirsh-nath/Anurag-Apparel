import { createCommerceApi } from './commerce-client.js';

export const ADMIN_SESSION_KEY = 'anurag-apparel-admin-session';
const EXPIRY_KEY = 'anurag-apparel-admin-session-expires';
const LEGACY_KEY = 'anurag-apparel-admin-unlocked';
let sessionGeneration = 0;
const pendingRequests = new Set();

function sessionChanged() {
  const error = new Error('The admin session changed. Sign in again.');
  error.name = 'AbortError';
  return error;
}

function invalidateRequests() {
  sessionGeneration++;
  for (const controller of pendingRequests) controller.abort();
  pendingRequests.clear();
}

function sessionFetch(token) {
  const generation = sessionGeneration;
  const assertCurrent = () => {
    if (generation !== sessionGeneration || (token && token !== adminToken())) throw sessionChanged();
  };
  return async (input, init = {}) => {
    assertCurrent();
    const controller = new AbortController();
    const upstream = init.signal || input?.signal;
    const abort = () => controller.abort(upstream?.reason);
    if (upstream?.aborted) abort();
    else upstream?.addEventListener('abort', abort, { once: true });
    pendingRequests.add(controller);
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      assertCurrent();
      // Supabase consumes the response body after fetch resolves. Check again
      // when it finishes so a delayed body cannot restore data after logout.
      return new Proxy(response, { get(target, property) {
        const value = Reflect.get(target, property, target);
        if (['json', 'text', 'arrayBuffer', 'blob', 'formData'].includes(property) && typeof value === 'function') {
          return async (...args) => { const data = await value.apply(target, args); assertCurrent(); return data; };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    } finally {
      pendingRequests.delete(controller);
      upstream?.removeEventListener('abort', abort);
    }
  };
}
export function adminToken() {
  const token = sessionStorage.getItem(ADMIN_SESSION_KEY) || '';
  const expires = sessionStorage.getItem(EXPIRY_KEY);
  if (!/^[a-f0-9]{64}$/i.test(token) || (expires && Date.parse(expires) <= Date.now())) return '';
  return token;
}
export function createAdminClient(config, token = adminToken()) {
  if (!config?.url || !config?.anonKey || !window.supabase?.createClient) return null;
  const fetchImpl = sessionFetch(token);
  const client = window.supabase.createClient(config.url, config.anonKey, {
    auth: { storageKey: 'anurag-admin-anonymous', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: token ? { 'x-admin-session': token } : {}, fetch: fetchImpl }
  });
  const call = createCommerceApi(config, { getAdminToken: () => token, fetchImpl });
  const originalFrom = client.storage.from.bind(client.storage);
  client.storage.from = bucket => {
    const storage = originalFrom(bucket);
    // Private storage writes use short-lived, path-bound upload capabilities.
    storage.createSignedUploadUrl = async path => {
      try { return { data: await call('admin_storage_sign', { bucket, path }), error: null }; }
      catch (error) { return { data: null, error }; }
    };
    storage.upload = async (path, file, options = {}) => {
      const signed = await storage.createSignedUploadUrl(path);
      if (signed.error) return signed;
      return storage.uploadToSignedUrl(path, signed.data.token, file, { ...options, upsert: false });
    };
    storage.remove = async paths => {
      try { const result = await call('admin_storage_remove', { bucket, paths }); return { data: result.data, error: null }; }
      catch (error) { return { data: null, error }; }
    };
    return storage;
  };
  return client;
}
export async function signInAdmin(config, username, password) {
  invalidateRequests();
  const generation = sessionGeneration;
  const client = createAdminClient(config, '');
  if (!client) throw new Error('The dashboard connection is unavailable.');
  const { data, error } = await client.rpc('commerce_admin_login', { input_username: username, input_password: password });
  if (generation !== sessionGeneration) throw sessionChanged();
  if (error) throw new Error('Admin sign-in is unavailable. Please try again.');
  if (!data?.ok || !/^[a-f0-9]{64}$/i.test(data.token || '')) {
    const messages = { login_locked: 'Too many unsuccessful attempts. Please try again in 15 minutes.', password_reset_required: 'The initial administrator password must be changed before using this dashboard. Contact the site owner.', weak_admin_password: 'The initial administrator password must be changed before using this dashboard. Contact the site owner.', invalid_credentials: 'Invalid username or password.' };
    throw new Error(messages[data?.error] || 'Admin sign-in could not be completed. Please try again.');
  }
  sessionStorage.setItem(ADMIN_SESSION_KEY, data.token);
  sessionStorage.setItem(EXPIRY_KEY, data.expires_at);
  sessionStorage.removeItem(LEGACY_KEY);
  return { client: createAdminClient(config, data.token), token: data.token, expires_at: data.expires_at };
}
export async function validateAdminSession(config) {
  const token = adminToken();
  const generation = sessionGeneration;
  if (!token) return null;
  const client = createAdminClient(config);
  if (!client) return null;
  try {
    const { data, error } = await client.rpc('commerce_admin_session_valid');
    if (generation !== sessionGeneration || token !== adminToken()) return null;
    if (error || data !== true) { clearAdminSession(); return null; }
    return client;
  } catch { return null; }
}
export function clearAdminSession() {
  invalidateRequests();
  sessionStorage.removeItem(ADMIN_SESSION_KEY);
  sessionStorage.removeItem(EXPIRY_KEY);
  sessionStorage.removeItem(LEGACY_KEY);
  localStorage.removeItem('anurag-apparel-is-admin');
}
export async function signOutAdmin(config) {
  const token = adminToken();
  clearAdminSession();
  if (token && config?.url) {
    try { await createCommerceApi(config, { getAdminToken: () => token })('admin_logout'); } catch { /* Local access is cleared even if the network is unavailable. */ }
  }
}
