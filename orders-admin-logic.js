const TEMPLATE_FIELDS = new Set(['customer_name', 'order_number', 'order_total', 'delivery_slot', 'address', 'order_items', 'cancel_reason', 'store_name', 'store_email', 'store_phone', 'order_url']);

export function formatAddress(address = {}) {
  return [address.line1, address.line2, address.landmark, address.city, address.state, address.postal_code].filter(Boolean).join(', ');
}

export function parseOptions(value) {
  const values = [...new Set(String(value).split(/[,\n]/).map(item => item.trim()).filter(Boolean))];
  if (values.length > 30 || values.some(item => item.length > 50)) throw new Error('Use at most 30 choices, each with 50 characters or fewer.');
  return values;
}

export function parseSlotTimes(value) {
  const values = [...new Set(String(value).split(/[,\n]/).map(item => item.trim()).filter(Boolean))].sort();
  if (!values.length || values.length > 12 || values.some(item => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item))) throw new Error('Enter 1–12 unique delivery times in 24-hour HH:MM format.');
  return values;
}

export function nextStatuses(status) {
  return { placed: ['confirmed', 'cancelled'], confirmed: ['preparing', 'cancelled'], preparing: ['out_for_delivery', 'cancelled'], out_for_delivery: ['cancelled'] }[status] || [];
}

export function needsRetentionConfirmation(previous = {}, next = {}) {
  if (!next.auto_delete_enabled) return false;
  if (!previous.auto_delete_enabled) return true;
  return ['customer_history_days', 'admin_history_days'].some(key => Number(next[key]) > 0 && (Number(previous[key]) === 0 || Number(next[key]) < Number(previous[key])));
}

export function validateTemplates(templates) {
  const result = {};
  for (const event of ['booked', 'delivered', 'cancelled']) {
    const template = templates?.[event] || {};
    const subject = String(template.subject || '').trim();
    const body = String(template.body || '').trim();
    if (!subject || !body || subject.length > 160 || body.length > 8000 || /[\r\n]/.test(subject)) throw new Error(`Complete the ${event} email subject and message within the length limits.`);
    for (const match of (subject + '\n' + body).matchAll(/{{\s*([^{}]+)\s*}}/g)) {
      if (!TEMPLATE_FIELDS.has(match[1].trim())) throw new Error(`The ${event} email contains an unsupported field: ${match[1].trim()}. Delivery codes cannot be included.`);
    }
    result[event] = { subject, body };
  }
  return result;
}

export function templatePreview(value) {
  const sample = { customer_name: 'Sample customer', order_number: 'AA-SAMPLE', order_total: '₹1,250.00', delivery_slot: 'Sample delivery slot', address: 'Sample customer address, Hazaribagh', order_items: '1 × Sample product', cancel_reason: 'Sample cancellation reason', store_name: 'Anurag Apparel', store_email: 'store@anuragapparel.in', store_phone: 'Store phone number', order_url: 'https://www.anuragapparel.in/?orders=1' };
  return String(value).replace(/{{\s*([^{}]+)\s*}}/g, (match, key) => Object.hasOwn(sample, key.trim()) ? sample[key.trim()] : match);
}

export function zonedParts(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  return Object.fromEntries(parts.filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
}

export function zonedSlotIso(date, time, timezone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Choose a delivery date and time.');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const part = zonedParts(instant, timezone);
    const asUtc = Date.UTC(Number(part.year), Number(part.month) - 1, Number(part.day), Number(part.hour), Number(part.minute), Number(part.second));
    instant += target - asUtc;
  }
  const result = zonedParts(instant, timezone);
  if (`${result.year}-${result.month}-${result.day}` !== date || `${result.hour}:${result.minute}` !== time) throw new Error('This local time does not exist in the configured time zone.');
  return new Date(instant).toISOString();
}

export function validateSettings(values, templates) {
  const result = {};
  const integers = { max_orders_per_day: [1, 10000], max_items_per_order: [1, 100], max_quantity_per_item: [1, 100], default_slot_offset: [1, 14], slot_duration_minutes: [15, 720], slot_capacity: [1, 10000], customer_history_days: [0, 3650], admin_history_days: [0, 3650] };
  for (const [key, [min, max]] of Object.entries(integers)) {
    const number = Number(values[key]);
    if (String(values[key]).trim() === '' || !Number.isInteger(number) || number < min || number > max) throw new Error(`${key.replaceAll('_', ' ')} must be a whole number from ${min} to ${max}.`);
    result[key] = number;
  }
  for (const [key, [min, max]] of Object.entries({ delivery_fee: [0, 100000], min_order_amount: [0, 1000000], store_latitude: [-90, 90], store_longitude: [-180, 180], delivery_radius_km: [0, 200] })) {
    const number = Number(values[key]);
    if (String(values[key]).trim() === '' || !Number.isFinite(number) || number < min || number > max) throw new Error(`Enter a valid ${key.replaceAll('_', ' ')}.`);
    result[key] = number;
  }
  const timezone = String(values.timezone || '').trim();
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw new Error('Enter a valid time zone, such as Asia/Kolkata.'); }
  result.timezone = timezone;
  result.delivery_slots = parseSlotTimes(values.delivery_slots);
  result.serviceable_pincodes = [...new Set(String(values.serviceable_pincodes || '').split(/[,\s]+/).filter(Boolean))];
  if (result.serviceable_pincodes.length > 100 || result.serviceable_pincodes.some(value => !/^[1-9]\d{5}$/.test(value))) throw new Error('Enter valid six-digit postal codes, separated by commas.');
  for (const key of ['allow_orders', 'delivery_code_enabled', 'auto_delete_enabled']) {
    if (typeof values[key] !== 'boolean') throw new Error(`Choose a valid ${key.replaceAll('_', ' ')} setting.`);
    result[key] = values[key];
  }
  result.email_templates = validateTemplates(templates);
  return result;
}
