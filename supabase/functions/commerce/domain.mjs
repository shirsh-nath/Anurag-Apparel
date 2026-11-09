export class CommerceError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function requireUuid(value, name = 'Order') {
  if (typeof value !== 'string' || !UUID.test(value)) throw new CommerceError('invalid_id', `${name} identifier is invalid.`);
  return value;
}
export function text(value, max = 1000) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new CommerceError('invalid_input', `Text must be no longer than ${max} characters.`);
  return value.trim();
}
export function cartItems(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new CommerceError('invalid_cart', 'Choose between 1 and 100 cart lines.');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new CommerceError('invalid_cart', 'Choose a valid product for each cart line.');
    requireUuid(item.product_id, 'Product');
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) throw new CommerceError('invalid_quantity', 'Item quantity must be between 1 and 100.');
    return { product_id: item.product_id, quantity: item.quantity, size: text(item.size, 60), color: text(item.color, 60) };
  });
}
export function addressInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommerceError('invalid_address', 'Enter a delivery address and choose its map location.');
  const address = {};
  for (const field of ['recipient', 'phone', 'line1', 'line2', 'landmark', 'city', 'state', 'postal_code']) address[field] = text(value[field], field === 'line1' || field === 'line2' || field === 'landmark' ? 250 : 100);
  if (address.recipient.length < 2 || address.line1.length < 5 || address.city.length < 2 || address.state.length < 2 || !/^[1-9]\d{5}$/.test(address.postal_code)) throw new CommerceError('invalid_address', 'Enter the recipient, street address, city, state and a valid six-digit PIN code.');
  address.phone = address.phone.replace(/[\s().-]/g, '');
  if (/^[6-9]\d{9}$/.test(address.phone)) address.phone = '+91' + address.phone;
  if (!/^\+[1-9]\d{7,14}$/.test(address.phone)) throw new CommerceError('invalid_phone', 'Enter a valid delivery phone number with country code.');
  for (const [field, bound] of [['latitude', 90], ['longitude', 180]]) {
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || Math.abs(value[field]) > bound) throw new CommerceError('invalid_location', 'Choose a valid delivery location on the map.');
    address[field] = value[field];
  }
  return address;
}
const placeholders = new Set(['customer_name', 'order_number', 'order_total', 'order_url', 'delivery_slot', 'address', 'order_items', 'cancel_reason', 'store_name', 'store_email', 'store_phone']);
export function validateTemplates(templates) {
  if (!templates || typeof templates !== 'object') throw new CommerceError('invalid_template', 'Provide all three order email templates.');
  const result = {};
  for (const event of ['booked', 'delivered', 'cancelled']) {
    const item = templates[event];
    if (!item || typeof item !== 'object') throw new CommerceError('invalid_template', `The ${event} template is missing.`);
    const subject = text(item.subject, 200), body = text(item.body, 10000);
    if (!subject || !body || /[\r\n]/.test(subject)) throw new CommerceError('invalid_template', 'Each email needs a single-line subject and a message.');
    for (const match of (subject + body).matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      if (!placeholders.has(match[1])) throw new CommerceError('invalid_template', `Unsupported template field: ${match[1]}.`);
    }
    result[event] = { subject, body };
  }
  return result;
}
export function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
export function renderEmail(template, values) {
  const substitute = value => value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(values[key] ?? ''));
  const subject = substitute(template.subject).replace(/[\r\n]/g, ' ').slice(0, 250);
  const body = substitute(template.body);
  return { subject, text: body, html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#27231e"><p style="font-size:12px;letter-spacing:2px;color:#85601e">ANURAG APPAREL</p><h1 style="font-size:24px">${escapeHtml(subject)}</h1><div style="font-size:15px;line-height:1.8">${escapeHtml(body).replace(/\n/g, '<br>')}</div><hr style="border:0;border-top:1px solid #e7e1d8;margin-top:28px"><p style="font-size:12px;color:#625d55">An order update from Anurag Apparel, Hazaribagh.</p></div>` };
}
function bytesToBase64(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function base64ToBytes(value) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
async function keyBytes(secret) {
  let raw;
  try { raw = base64ToBytes(secret); } catch { throw new CommerceError('code_unavailable', 'Delivery verification is temporarily unavailable.', 503); }
  if (raw.length !== 32) throw new CommerceError('code_unavailable', 'Delivery verification is temporarily unavailable.', 503);
  return raw;
}
async function purposeKey(secret, purpose, algorithm, usages) {
  const master = await crypto.subtle.importKey('raw', await keyBytes(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('anurag-commerce-v1'), info: new TextEncoder().encode(purpose) }, master, algorithm, false, usages);
}
export function randomDeliveryCode() {
  const array = new Uint32Array(1), ceiling = Math.floor(0x100000000 / 10000) * 10000;
  do { crypto.getRandomValues(array); } while (array[0] >= ceiling);
  return String(array[0] % 10000).padStart(4, '0');
}
export async function deliveryDigest(secret, orderId, customerId, code) {
  if (!/^\d{4}$/.test(code)) throw new CommerceError('invalid_code', 'Enter the four-digit delivery code.');
  const key = await purposeKey(secret, 'delivery-verification', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`delivery-verifier-v1:${orderId}:${customerId}:${code}`));
  return [...new Uint8Array(signed)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export async function encryptDeliveryCode(secret, orderId, customerId, code) {
  const key = await purposeKey(secret, 'delivery-code-display', { name: 'AES-GCM', length: 256 }, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${orderId}:${customerId}`) }, key, new TextEncoder().encode(code));
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}
export async function decryptDeliveryCode(secret, orderId, customerId, ciphertext) {
  try {
    const [version, iv, body] = ciphertext.split('.');
    if (version !== 'v1') throw new Error('Version');
    const key = await purposeKey(secret, 'delivery-code-display', { name: 'AES-GCM', length: 256 }, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv), additionalData: new TextEncoder().encode(`${orderId}:${customerId}`) }, key, base64ToBytes(body));
    const code = new TextDecoder().decode(decrypted);
    if (!/^\d{4}$/.test(code)) throw new Error('Format');
    return code;
  } catch { throw new CommerceError('code_unavailable', 'The delivery code could not be loaded. Please contact the store.', 503); }
}
export async function requestHash(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function validStoragePath(value) {
  const path = text(value, 450);
  if (!/^(?:products|product-videos|brands|offers|campaigns)\/[A-Za-z0-9_./ -]+$/.test(path) || path.includes('..') || path.includes('//')) throw new CommerceError('invalid_path', 'Choose a valid product-media upload path.');
  return path;
}
