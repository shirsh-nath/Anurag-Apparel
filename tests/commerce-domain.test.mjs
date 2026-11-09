import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cartItems, addressInput, validateTemplates, renderEmail, randomDeliveryCode, deliveryDigest, encryptDeliveryCode, decryptDeliveryCode, requestHash, validStoragePath } from '../supabase/functions/commerce/domain.mjs';
const order = 'ab7a3b25-8e8e-4b54-a8c0-111111111111', customer = 'ab7a3b25-8e8e-4b54-a8c0-222222222222';
const key = randomBytes(32).toString('base64url');

test('four-digit codes are encrypted and bound to both order and customer', async () => {
  const ciphertext = await encryptDeliveryCode(key, order, customer, '0042');
  assert.match(ciphertext, /^v1\./);
  assert.equal(await decryptDeliveryCode(key, order, customer, ciphertext), '0042');
  await assert.rejects(decryptDeliveryCode(key, customer, order, ciphertext));
  await assert.rejects(decryptDeliveryCode(randomBytes(32).toString('base64url'), order, customer, ciphertext));
  await assert.rejects(decryptDeliveryCode(key, order, customer, ciphertext + 'x'));
});
test('keyed verification differs by code, customer, order and secret', async () => {
  const digest = await deliveryDigest(key, order, customer, '0042');
  assert.equal(digest.length, 64);
  assert.equal(await deliveryDigest(key, order, customer, '0042'), digest);
  assert.notEqual(await deliveryDigest(key, order, customer, '0043'), digest);
  assert.notEqual(await deliveryDigest(key, customer, order, '0042'), digest);
  assert.notEqual(await deliveryDigest(randomBytes(32).toString('base64url'), order, customer, '0042'), digest);
  await assert.rejects(deliveryDigest(key, order, customer, '42'));
  for (let i = 0; i < 100; i++) assert.match(randomDeliveryCode(), /^\d{4}$/);
});
test('cart accepts only server-relevant identifiers/options, discarding submitted price', () => {
  assert.deepEqual(cartItems([{ product_id: order, quantity: 2, size: ' M ', color: '', unit_price: 1 }]), [{ product_id: order, quantity: 2, size: 'M', color: '' }]);
  for (const value of [[], [null], [[]], [{ product_id: order, quantity: -1 }], [{ product_id: 'malformed', quantity: 1 }], [{ product_id: order, quantity: 1.5 }]]) assert.throws(() => cartItems(value));
});
test('checkout requires contact, postal address and precise map coordinates', () => {
  const address = { recipient: 'Test Person', phone: '9876543210', line1: '12 Sample Road', city: 'Hazaribagh', state: 'Jharkhand', postal_code: '825301', latitude: 23.99, longitude: 85.35 };
  assert.equal(addressInput(address).phone, '+919876543210');
  for (const invalid of [{ ...address, latitude: null }, { ...address, longitude: 181 }, { ...address, postal_code: '000000' }, { ...address, phone: 'bad' }]) assert.throws(() => addressInput(invalid));
});
test('email templates reject code placeholders and escape customer-supplied HTML', () => {
  const templates = Object.fromEntries(['booked', 'delivered', 'cancelled'].map(event => [event, { subject: 'Order {{order_number}}', body: 'Hello {{customer_name}}\n{{address}}' }]));
  validateTemplates(templates);
  assert.throws(() => validateTemplates({ ...templates, booked: { subject: 'Code {{delivery_code}}', body: 'Test' } }));
  const result = renderEmail(templates.booked, { order_number: 'AA-1', customer_name: '<script>alert(1)</script>', address: 'A&B' });
  assert.doesNotMatch(result.html, /<script>/);
  assert.match(result.html, /&lt;script&gt;/);
  assert.match(result.html, /A&amp;B/);
  assert.equal(result.subject, 'Order AA-1');
});
test('checkout fingerprint changes with address and cart; storage paths reject traversal', async () => {
  assert.notEqual(await requestHash({ quantity: 1 }), await requestHash({ quantity: 2 }));
  assert.equal(validStoragePath('products/image.jpg'), 'products/image.jpg');
  for (const path of ['../.env', 'products/../../secret', '/products/a.jpg', 'unknown/a.jpg']) assert.throws(() => validStoragePath(path));
});
