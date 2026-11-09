import { CommerceError, requireUuid, text, cartItems, addressInput, validateTemplates, renderEmail, randomDeliveryCode, deliveryDigest, encryptDeliveryCode, decryptDeliveryCode, requestHash, validStoragePath } from './domain.mjs';

const projectUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
const codeKey = Deno.env.get('COMMERCE_CODE_KEY') || '';
const maintenanceKey = Deno.env.get('COMMERCE_MAINTENANCE_KEY') || '';
const allowedOrigins = new Set(['https://anuragapparel.in', 'https://www.anuragapparel.in', 'http://localhost:5500', 'http://127.0.0.1:5500', ...(Deno.env.get('COMMERCE_ALLOWED_ORIGINS') || '').split(',').map(value => value.trim()).filter(Boolean)]);
const serviceHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
const pageSize = value => Math.max(1, Math.min(100, Number.isInteger(value) ? value : 25));
const page = value => Math.max(1, Math.min(100000, Number.isInteger(value) ? value : 1));
const publicErrorMessages = /(?:order|slot|stock|quantity|cart|delivery|address|phone|PIN|profile|price|payment|minimum|daily|limit|security|password|retention|template|size|colour|color|configuration|inventory|product|capacity|booking|idempotency)/i;

async function rpc(name, args = {}) {
  const response = await fetch(`${projectUrl}/rest/v1/rpc/${name}`, { method: 'POST', headers: serviceHeaders, body: JSON.stringify(args), signal: AbortSignal.timeout(20000) });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = ['P0001', '42501'].includes(data?.code) && typeof data?.message === 'string' && publicErrorMessages.test(data.message) && data.message.length < 300 ? data.message : 'This operation could not be completed. Please try again.';
    const businessCode = message.match(/\b(PRICE_CHANGED|SLOT_CHANGED|ORDERS_DISABLED|OUT_OF_STOCK|DAILY_LIMIT_REACHED|SLOT_CAPACITY_REACHED)\b/)?.[1]
      || (/^Online orders are currently off/.test(message) ? 'ORDERS_DISABLED' : /^Insufficient stock/.test(message) ? 'OUT_OF_STOCK' : /^Today's order limit/.test(message) ? 'DAILY_LIMIT_REACHED' : /^Delivery slot is full/.test(message) ? 'SLOT_CAPACITY_REACHED' : null);
    throw new CommerceError(businessCode || (data?.code === '23505' ? 'conflict' : 'operation_failed'), message, businessCode || response.status === 409 ? 409 : 400);
  }
  return data;
}
async function currentUser(req) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token || token === anonKey) throw new CommerceError('sign_in_required', 'Sign in with Google to use your account.', 401);
  const response = await fetch(`${projectUrl}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new CommerceError('session_expired', 'Your session has expired. Please sign in again.', 401);
  const user = await response.json();
  if (!user.id || !user.email || !user.email_confirmed_at) throw new CommerceError('verified_email_required', 'A verified email address is required to order.', 403);
  return user;
}
async function requireAdmin(req) {
  const token = req.headers.get('x-admin-session') || '';
  if (!/^[a-f0-9]{64}$/i.test(token) || !await rpc('commerce_validate_admin_token', { input_token: token })) throw new CommerceError('admin_session_expired', 'Sign in to the admin dashboard again.', 401);
  return token;
}
function listArgs(body, customerId, admin) {
  return { input_customer_id: customerId, input_admin: admin, input_filter: ['all', 'active', 'past'].includes(body.filter) ? body.filter : 'all', input_status: body.status || null, input_search: text(body.search, 100), input_from: body.date_from || null, input_to: body.date_to || null, input_page: page(body.page), input_limit: pageSize(body.limit) };
}
function paginated(data) { return { ...data, pageSize: data.page_size || data.pageSize || 25 }; }
function emailValues(order, timezone, store = {}) {
  const address = order.address || {};
  return { customer_name: order.customer_name, order_number: order.order_number, order_total: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(order.total), order_url: 'https://www.anuragapparel.in/?orders=1', delivery_slot: new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone || 'Asia/Kolkata' }).format(new Date(order.slot_start)), address: [address.recipient, address.line1, address.line2, address.landmark, address.city, address.state, address.postal_code].filter(Boolean).join(', '), order_items: (order.items || []).map(item => `${item.title}${item.size ? ` (${item.size})` : ''}${item.color ? `, ${item.color}` : ''} × ${item.quantity}`).join('\n'), cancel_reason: order.cancel_reason || '', store_name: 'Anurag Apparel', store_email: store.email_address || 'store@anuragapparel.in', store_phone: store.phone_number || '+91 73249 34662' };
}
async function drainEmails() {
  if (!Deno.env.get('RESEND_API_KEY') || !Deno.env.get('RESEND_FROM_EMAIL')) return { pending: true };
  const jobs = await rpc('commerce_claim_emails', { input_limit: 10 });
  let store = {};
  try { if ((jobs || []).some(job => !job.store)) {
    const response = await fetch(`${projectUrl}/rest/v1/site_settings?id=eq.storefront&select=email_address,phone_number`, { headers: serviceHeaders, signal: AbortSignal.timeout(10000) });
    if (response.ok) store = (await response.json())[0] || {};
  } } catch { /* A temporary legacy contact-settings failure does not discard an order email. */ }
  let sent = 0, failed = 0;
  for (const job of jobs || []) {
    try {
      const order = job.order;
      if (!order?.customer_email || !job.template) throw new Error('Email data unavailable');
      const rendered = renderEmail(job.template, emailValues(order, job.timezone, job.store || store));
      const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json', 'Idempotency-Key': `anurag-order-event/${job.id}` }, body: JSON.stringify({ from: Deno.env.get('RESEND_FROM_EMAIL'), to: [order.customer_email], ...rendered }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Email provider HTTP ${response.status}`);
      await rpc('commerce_finish_email', { input_email_id: job.id, input_lease_token: job.lease_token, input_success: true, input_error: '' });
      sent++;
    } catch (error) {
      await rpc('commerce_finish_email', { input_email_id: job.id, input_lease_token: job.lease_token, input_success: false, input_error: /^Email provider HTTP \d+$/.test(error.message) ? error.message : 'Email delivery attempt failed' });
      failed++;
    }
  }
  return { sent, failed };
}
function queueMail() {
  const work = drainEmails().catch(() => ({ failed: true }));
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work);
  return work;
}
async function storageRequest(path, options) {
  const response = await fetch(`${projectUrl}/storage/v1/${path}`, { ...options, headers: { ...serviceHeaders, ...(options.headers || {}) }, signal: AbortSignal.timeout(20000) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new CommerceError('storage_error', 'The media operation failed. Please try again.', 400);
  return data;
}
async function readRequest(req) {
  if (Number(req.headers.get('content-length') || 0) > 65536) throw new CommerceError('request_too_large', 'The request is too large.', 413);
  const reader = req.body?.getReader();
  if (!reader) throw new CommerceError('invalid_json', 'The request is invalid.');
  const decoder = new TextDecoder();
  let bytes = 0, raw = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) { await reader.cancel(); throw new CommerceError('request_too_large', 'The request is too large.', 413); }
      raw += decoder.decode(value, { stream: true });
    }
    return JSON.parse(raw + decoder.decode());
  } catch (error) {
    if (error instanceof CommerceError) throw error;
    throw new CommerceError('invalid_json', 'The request is invalid.');
  } finally { reader.releaseLock(); }
}

Deno.serve(async req => {
  const origin = req.headers.get('origin');
  const cors = { 'Access-Control-Allow-Origin': origin && allowedOrigins.has(origin) ? origin : 'https://www.anuragapparel.in', 'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info,x-admin-session', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Vary': 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (origin && !allowedOrigins.has(origin)) return json({ error: { code: 'origin_not_allowed', message: 'This website address is not enabled for ordering.' } }, 403);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: { code: 'method_not_allowed', message: 'POST is required.' } }, 405);
  try {
    const body = await readRequest(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CommerceError('invalid_json', 'The request is invalid.');
    const action = body.action;
    if (action === 'public_settings') return json({ settings: await rpc('commerce_get_settings', { input_public: true }) });
    if (action === 'maintenance') {
      const supplied = req.headers.get('x-commerce-maintenance') || '';
      if (!maintenanceKey || supplied !== maintenanceKey) throw new CommerceError('forbidden', 'Access denied.', 403);
      return json({ cleanup: await rpc('commerce_housekeeping'), emails: await drainEmails() });
    }
    if (typeof action !== 'string') throw new CommerceError('invalid_action', 'Choose an operation.');
    if (action.startsWith('admin_')) {
      const adminToken = await requireAdmin(req);
      if (!['admin_session', 'admin_logout', 'admin_settings'].includes(action)) {
        const settings = await rpc('commerce_get_settings', { input_public: false });
        if (!settings.admin_password_ready) throw new CommerceError('password_change_required', 'Change the administrator password from the Security menu, then sign in again.', 403);
      }
      switch (action) {
        case 'admin_session': return json({ valid: true });
        case 'admin_logout': await rpc('commerce_admin_logout', { input_token: adminToken }); return json({ signed_out: true });
        case 'admin_orders': return json(paginated(await rpc('commerce_list_orders', listArgs(body, null, true))));
        case 'admin_customers': return json(paginated(await rpc('commerce_list_customers', { input_search: text(body.search, 100), input_page: page(body.page), input_limit: pageSize(body.limit) })));
        case 'admin_settings': return json({ settings: await rpc('commerce_get_settings', { input_public: false }) });
        case 'admin_save_settings': {
          const settings = { ...body.settings };
          if (settings.email_templates) settings.email_templates = validateTemplates(settings.email_templates);
          return json({ settings: await rpc('commerce_save_settings', { input_settings: settings }) });
        }
        case 'admin_update_order': {
          requireUuid(body.order_id);
          if (body.status === 'delivered') throw new CommerceError('delivery_verification_required', 'Use the delivery completion action to finish an order.');
          const order = await rpc('commerce_update_order', { input_order_id: body.order_id, input_status: body.status || null, input_slot_start: body.slot_start || null, input_cancel_reason: text(body.cancel_reason, 500), input_actor: 'admin', input_customer_id: null });
          queueMail();
          return json({ order });
        }
        case 'admin_complete_delivery': {
          requireUuid(body.order_id);
          const context = await rpc('commerce_delivery_context', { input_order_id: body.order_id });
          if (!context) throw new CommerceError('not_found', 'Order not found.', 404);
          const candidate = context.delivery_code_required ? await deliveryDigest(codeKey, body.order_id, context.customer_id, String(body.code || '')) : '';
          const result = await rpc('commerce_complete_delivery', { input_order_id: body.order_id, input_candidate_digest: candidate, input_payment_collected: body.payment_collected === true });
          if (!result.ok) throw new CommerceError(result.error || 'invalid_delivery_code', result.message || 'Delivery could not be confirmed. Check the customer code and try again.', /lock|attempt/i.test(result.error || '') ? 429 : 400);
          queueMail();
          return json({ order: result.order });
        }
        case 'admin_delete_order': return json(await rpc('commerce_delete_order', { input_order_id: requireUuid(body.order_id) }));
        case 'admin_retry_email': {
          const result = await rpc('commerce_retry_emails', { input_order_id: requireUuid(body.order_id) });
          if (result.queued) queueMail();
          return json(result);
        }
        case 'admin_inventory': return json({ products: await rpc('commerce_get_inventory') });
        case 'admin_save_inventory': {
          const id = requireUuid(body.product_id, 'Product');
          if (!Number.isInteger(body.stock_quantity) || body.stock_quantity < 0 || body.stock_quantity > 1000000) throw new CommerceError('invalid_stock', 'Stock must be a whole number between 0 and 1000000.');
          const values = { stock_quantity: body.stock_quantity };
          for (const field of ['size_options', 'color_options']) {
            if (!Array.isArray(body[field]) || body[field].length > 30) throw new CommerceError('invalid_options', 'Use at most 30 product options.');
            values[field] = [...new Set(body[field].map(value => text(value, 60)).filter(Boolean))];
          }
          return json({ product: await rpc('commerce_save_inventory', { input_product_id: id, input_stock_quantity: values.stock_quantity, input_size_options: values.size_options, input_color_options: values.color_options }) });
        }
        case 'admin_storage_sign': {
          if (body.bucket !== 'product-images') throw new CommerceError('invalid_bucket', 'Only product media can be uploaded.');
          const path = validStoragePath(body.path);
          const data = await storageRequest(`object/upload/sign/product-images/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST', headers: { 'x-upsert': 'false' }, body: '{}' });
          const token = data.token || new URL(data.url, `${projectUrl}/storage/v1/`).searchParams.get('token');
          if (!token) throw new CommerceError('storage_error', 'The upload could not be authorised.', 503);
          return json({ path, token });
        }
        case 'admin_storage_remove': {
          if (body.bucket !== 'product-images' || !Array.isArray(body.paths) || body.paths.length > 100) throw new CommerceError('invalid_path', 'Choose product media to remove.');
          const paths = body.paths.map(validStoragePath);
          return json({ data: await storageRequest('object/product-images', { method: 'DELETE', body: JSON.stringify({ prefixes: paths }) }) });
        }
        default: throw new CommerceError('unknown_action', 'This admin operation is unavailable.', 404);
      }
    }
    const user = await currentUser(req);
    switch (action) {
      case 'quote': return json({ quote: await rpc('commerce_quote', { input_customer_id: user.id, input_items: cartItems(body.items), input_address: body.address ? addressInput(body.address) : null, input_slot_start: null }) });
      case 'place_order': {
        const items = cartItems(body.items), address = addressInput(body.address), notes = text(body.notes, 1000);
        const idempotency = requireUuid(body.idempotency_key, 'Checkout'), id = crypto.randomUUID();
        if (typeof body.expected_total !== 'number' || !Number.isFinite(body.expected_total) || body.expected_total < 0 || typeof body.expected_slot_start !== 'string' || !Number.isFinite(Date.parse(body.expected_slot_start))) throw new CommerceError('quote_required', 'Review the current price and delivery slot before placing your order.');
        const code = randomDeliveryCode();
        const order = await rpc('commerce_create_order', { input_order_id: id, input_customer_id: user.id, input_items: items, input_address: address, input_notes: notes, input_idempotency_key: idempotency, input_request_hash: await requestHash({ items, address, notes }), input_code_digest: await deliveryDigest(codeKey, id, user.id, code), input_code_ciphertext: await encryptDeliveryCode(codeKey, id, user.id, code), input_expected_total: body.expected_total, input_expected_slot_start: body.expected_slot_start });
        queueMail();
        return json({ order }, 201);
      }
      case 'my_orders': return json(paginated(await rpc('commerce_list_orders', listArgs(body, user.id, false))));
      case 'delivery_code': {
        const id = requireUuid(body.order_id);
        const result = await rpc('commerce_order_secret', { input_order_id: id, input_customer_id: user.id });
        if (!result?.ciphertext) throw new CommerceError('code_not_available', 'A delivery code is not available for this order.', 404);
        return json({ code: await decryptDeliveryCode(codeKey, id, user.id, result.ciphertext) });
      }
      case 'customer_cancel': {
        const order = await rpc('commerce_update_order', { input_order_id: requireUuid(body.order_id), input_status: 'cancelled', input_slot_start: null, input_cancel_reason: text(body.reason, 500), input_actor: 'customer', input_customer_id: user.id });
        queueMail();
        return json({ order });
      }
      default: throw new CommerceError('unknown_action', 'This operation is unavailable.', 404);
    }
  } catch (error) {
    if (error instanceof CommerceError) return json({ error: { code: error.code, message: error.message } }, error.status);
    // Never log payloads, tokens, addresses, codes, keys, or email bodies.
    return json({ error: { code: 'temporarily_unavailable', message: 'This service is temporarily unavailable. Please try again.' } }, 503);
  }
});
