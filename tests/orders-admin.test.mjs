import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAddress, parseOptions, parseSlotTimes, nextStatuses, needsRetentionConfirmation, validateTemplates, templatePreview, zonedSlotIso, validateSettings } from '../orders-admin-logic.js';

const templates = {
  booked: { subject: 'Order {{order_number}} booked', body: 'Hello {{customer_name}}\n{{order_items}}\n{{order_total}}\n{{delivery_slot}}' },
  delivered: { subject: 'Delivered {{order_number}}', body: 'Thank you {{customer_name}}. {{store_name}}' },
  cancelled: { subject: 'Cancelled {{order_number}}', body: 'Hello {{customer_name}}. {{cancel_reason}}' }
};
const settings = { max_orders_per_day: 50, max_items_per_order: 20, max_quantity_per_item: 10, default_slot_offset: 2, slot_duration_minutes: 120, slot_capacity: 25, customer_history_days: 180, admin_history_days: 365, delivery_fee: 0, min_order_amount: 0, store_latitude: 23.9932828, store_longitude: 85.3593752, delivery_radius_km: 0, timezone: 'Asia/Kolkata', delivery_slots: '17:00\n11:00', serviceable_pincodes: '825301, 825302', allow_orders: false, delivery_code_enabled: true, auto_delete_enabled: false };

test('delivery times are validated, deduplicated and sorted without accepting ambiguous times', () => {
  assert.deepEqual(parseSlotTimes('17:00\n11:00,17:00'), ['11:00', '17:00']);
  for (const invalid of ['', '9:00', '24:00', '11:60', '12:00 PM', Array.from({ length: 13 }, (_, i) => `${String(i).padStart(2, '0')}:00`).join(',')]) assert.throws(() => parseSlotTimes(invalid));
});

test('slot rescheduling uses the configured business timezone rather than staff device timezone', () => {
  assert.equal(zonedSlotIso('2026-11-08', '11:00', 'Asia/Kolkata'), '2026-11-08T05:30:00.000Z');
  assert.equal(zonedSlotIso('2026-11-08', '00:00', 'Asia/Kolkata'), '2026-11-07T18:30:00.000Z');
  assert.equal(zonedSlotIso('2026-07-01', '11:00', 'America/New_York'), '2026-07-01T15:00:00.000Z');
  assert.throws(() => zonedSlotIso('2026-03-08', '02:30', 'America/New_York'));
  assert.throws(() => zonedSlotIso('2026-02-30', '11:00', 'Asia/Kolkata'));
});

test('generic status controls never offer delivered or move a terminal order', () => {
  assert.deepEqual(nextStatuses('placed'), ['confirmed', 'cancelled']);
  assert.deepEqual(nextStatuses('preparing'), ['out_for_delivery', 'cancelled']);
  for (const value of ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled']) assert.equal(nextStatuses(value).includes('delivered'), false);
  assert.deepEqual(nextStatuses('delivered'), []);
  assert.deepEqual(nextStatuses('cancelled'), []);
});

test('enabling or shortening retention requires explicit irreversible-deletion confirmation', () => {
  const previous = { auto_delete_enabled: true, customer_history_days: 180, admin_history_days: 365 };
  assert.equal(needsRetentionConfirmation({ ...previous, auto_delete_enabled: false }, previous), true);
  assert.equal(needsRetentionConfirmation(previous, { ...previous, customer_history_days: 30 }), true);
  assert.equal(needsRetentionConfirmation({ ...previous, admin_history_days: 0 }, previous), true);
  assert.equal(needsRetentionConfirmation(previous, { ...previous, customer_history_days: 200 }), false);
  assert.equal(needsRetentionConfirmation(previous, { ...previous, admin_history_days: 0 }), false);
  assert.equal(needsRetentionConfirmation(previous, { ...previous, auto_delete_enabled: false }), false);
});

test('email templates cannot include acceptance code, unknown fields or header injection', () => {
  assert.equal(validateTemplates(templates).booked.subject, templates.booked.subject);
  for (const body of ['{{delivery_code}}', '{{code}}', '{{customer_password}}']) assert.throws(() => validateTemplates({ ...templates, booked: { subject: 'Order', body } }));
  assert.throws(() => validateTemplates({ ...templates, booked: { subject: 'Order\nBcc: other@example.invalid', body: 'Hello' } }));
  assert.throws(() => validateTemplates({ ...templates, delivered: { subject: 'Delivered', body: '' } }));
  assert.equal(templatePreview('Hello {{ customer_name }}: {{order_number}}'), 'Hello Sample customer: AA-SAMPLE');
});

test('settings validate numeric bounds, delivery area, time zone and all templates before a write', () => {
  const result = validateSettings(settings, templates);
  assert.equal(result.default_slot_offset, 2);
  assert.deepEqual(result.delivery_slots, ['11:00', '17:00']);
  assert.deepEqual(result.serviceable_pincodes, ['825301', '825302']);
  for (const mutation of [{ max_orders_per_day: 0 }, { max_quantity_per_item: 1.5 }, { slot_capacity: '' }, { store_latitude: 91 }, { delivery_fee: -1 }, { timezone: 'Not/A_Timezone' }, { serviceable_pincodes: '123' }, { customer_history_days: -1 }]) assert.throws(() => validateSettings({ ...settings, ...mutation }, templates));
  assert.equal(validateSettings({ ...settings, admin_history_days: 0 }, templates).admin_history_days, 0);
  assert.throws(() => validateSettings({ ...settings, allow_orders: 'false' }, templates));
});

test('product choices and addresses remain simple text with deliberate size limits', () => {
  assert.deepEqual(parseOptions(' S, M, S, XL '), ['S', 'M', 'XL']);
  assert.throws(() => parseOptions('X'.repeat(51)));
  assert.equal(formatAddress({ line1: '<customer input>', city: 'Hazaribagh', state: 'Jharkhand', postal_code: '825301' }), '<customer input>, Hazaribagh, Jharkhand, 825301');
});
