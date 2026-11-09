export class CommerceError extends Error {
  constructor(message, { code = 'REQUEST_FAILED', status = 0 } = {}) {
    super(message);
    this.name = 'CommerceError';
    this.code = code;
    this.status = status;
  }
}

export function createCommerceApi(config, { getAccessToken, getAdminToken, fetchImpl = (...args) => fetch(...args) } = {}) {
  return async function call(action, data = {}) {
    if (!config?.url || !config?.anonKey) throw new CommerceError('The store connection is unavailable. Please try again later.', { code: 'NOT_CONFIGURED' });
    const accessToken = await getAccessToken?.();
    const adminToken = await getAdminToken?.();
    const headers = { 'Content-Type': 'application/json', apikey: config.anonKey, Authorization: `Bearer ${accessToken || config.anonKey}` };
    if (adminToken) headers['X-Admin-Session'] = adminToken;
    let response;
    try {
      response = await fetchImpl(`${config.url.replace(/\/$/, '')}/functions/v1/commerce`, {
        method: 'POST', headers, body: JSON.stringify({ ...data, action }),
        signal: AbortSignal.timeout(25000)
      });
    } catch {
      throw new CommerceError('We could not reach the store. Check your connection and try again.', { code: 'NETWORK_ERROR' });
    }
    let result;
    try { result = await response.json(); }
    catch { throw new CommerceError('The store returned an unexpected response. Please try again.', { status: response.status }); }
    if (!response.ok || result?.error) {
      const source = result?.error;
      throw new CommerceError(typeof source === 'string' ? source : source?.message || result?.message || 'This request could not be completed.', {
        code: source?.code || result?.code || 'REQUEST_FAILED', status: response.status
      });
    }
    return result;
  };
}
