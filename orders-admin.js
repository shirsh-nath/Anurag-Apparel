import { formatAddress, parseOptions, nextStatuses, needsRetentionConfirmation, templatePreview, zonedParts, zonedSlotIso, validateSettings } from '/orders-admin-logic.js';
import { loadSupabaseConfig } from '/public-config.js';
import { createCommerceApi } from '/commerce-client.js';
import { adminToken, clearAdminSession, signInAdmin, validateAdminSession, signOutAdmin } from '/admin-session.js';

const TERMINAL = new Set(['delivered', 'cancelled']);
const STATUS_LABELS = { placed: 'Placed', confirmed: 'Confirmed', preparing: 'Preparing', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled' };
const PAGE_SIZE = 20;

const state = { config: null, api: null, authenticated: false, sessionGeneration: 0, tab: 'orders', settings: null, settingsDirty: false, orderFilter: 'active', orders: [], orderPage: 1, orderTotal: 0, orderRequest: 0, customers: [], customerPage: 1, customerTotal: 0, customerRequest: 0, inventory: [], deliveryOrders: [], deliveryRequest: 0, map: null, markers: null, ownMarker: null, ownAccuracy: null, ownLocation: null, geoWatch: null, locationGeneration: 0, templates: {}, emailEvent: 'booked', detail: null, detailBusy: false, loading: false };
const ui = {};
const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value || 0));
const dateText = value => value ? new Intl.DateTimeFormat('en-IN', { timeZone: state.settings?.timezone || 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : 'Not set';
function el(tag, className, value) { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = String(value); return node; }
function button(label, handler, className = '') { const node = el('button', `oc-button ${className}`, label); node.type = 'button'; node.addEventListener('click', handler); return node; }
function empty(target, message) { target.replaceChildren(el('p', 'oc-empty', message)); }
function status(message = '', error = false, target = ui.commerceStatus, success = false) { target.textContent = message; target.hidden = !message; target.dataset.error = String(error); target.dataset.success = String(success); }
function statusBadge(value) { const badge = el('span', 'oc-badge', STATUS_LABELS[value] || value); badge.dataset.tone = value === 'delivered' ? 'good' : value === 'cancelled' ? 'bad' : 'warn'; return badge; }

async function call(action, data = {}) {
  const generation = state.sessionGeneration;
  const token = adminToken();
  const current = () => state.authenticated && generation === state.sessionGeneration && token === adminToken();
  try {
    const result = await state.api(action, data);
    if (!current()) { const error = new Error('The admin session changed.'); error.code = 'SESSION_CHANGED'; throw error; }
    return result;
  }
  catch (error) {
    if (current() && error.code !== 'password_change_required' && ([401, 403].includes(error.status) || ['ADMIN_SESSION_EXPIRED', 'ADMIN_REQUIRED', 'UNAUTHORIZED'].includes(error.code))) { clearPrivateState(); status('Your admin session ended. Sign in again.', true, ui.loginStatus); }
    throw error;
  }
}

function clearPrivateState() {
  clearAdminSession();
  state.authenticated = false; state.sessionGeneration++; state.orderRequest++; state.customerRequest++; state.deliveryRequest++;
  state.detailBusy = false; state.loading = false;
  state.orders = []; state.customers = []; state.inventory = []; state.deliveryOrders = []; state.settings = null; state.settingsDirty = false; state.templates = {}; state.detail = null;
  stopLocation();
  if (state.map) { state.map.remove(); state.map = null; state.markers = null; state.ownMarker = null; state.ownAccuracy = null; }
  for (const target of [ui.ordersList, ui.customersList, ui.inventoryList, ui.deliveryList, ui.orderDetailBody]) target.replaceChildren();
  ui.commerceSettingsForm.reset(); ui.settingEmailSubject.value = ''; ui.settingEmailBody.value = ''; ui.emailPreviewSubject.textContent = ''; ui.emailPreviewBody.textContent = '';
  if (ui.orderDialog.open) ui.orderDialog.close();
  ui.commerceDashboard.hidden = true; ui.commerceLogin.hidden = false; ui.adminLogout.hidden = true;
}

async function unlock() {
  state.sessionGeneration++;
  state.authenticated = true;
  ui.commerceLogin.hidden = true; ui.commerceDashboard.hidden = false; ui.adminLogout.hidden = false;
  status();
  try {
    await loadSettings();
    if (!state.authenticated) return;
    const requested = window.location.hash.slice(1);
    await selectTab(['orders', 'customers', 'delivery', 'inventory', 'settings'].includes(requested) ? requested : 'orders');
  } catch (error) { status(error.message || 'Unable to load the commerce service.', true); }
}

async function selectTab(tab) {
  if (!state.authenticated) return;
  if (state.tab === 'settings' && state.settingsDirty && !confirm(tab === 'settings' ? 'Reload settings and discard your unsaved changes?' : 'Leave settings and discard your unsaved changes?')) return;
  if (state.tab === 'settings') state.settingsDirty = false;
  if (state.tab === 'delivery' && tab !== 'delivery') stopLocation();
  state.tab = tab;
  for (const node of document.querySelectorAll('[data-tab]')) { const selected = node.dataset.tab === tab; node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1; }
  for (const name of ['orders', 'customers', 'delivery', 'inventory', 'settings']) ui[`panel-${name}`].hidden = name !== tab;
  window.history.replaceState(null, '', `#${tab}`);
  status();
  try {
    if (tab === 'orders') await loadOrders();
    if (tab === 'customers') await loadCustomers();
    if (tab === 'delivery') await loadDeliveries();
    if (tab === 'inventory') await loadInventory();
    if (tab === 'settings') await loadSettings();
  } catch (error) { status(error.message || 'Unable to load this section.', true); }
}

async function loadOrders() {
  const request = ++state.orderRequest;
  ui.orderCount.textContent = 'Loading orders…';
  const data = await call('admin_orders', { filter: state.orderFilter, status: ui.orderStatus.value, search: ui.orderSearch.value.trim(), date_from: ui.orderDateFrom.value || undefined, date_to: ui.orderDateTo.value || undefined, page: state.orderPage, limit: PAGE_SIZE });
  if (!state.authenticated || request !== state.orderRequest) return;
  state.orders = data.orders || []; state.orderTotal = Number(data.total || 0);
  ui.orderCount.textContent = `${state.orderTotal} ${state.orderFilter === 'all' ? 'visible' : state.orderFilter} order${state.orderTotal === 1 ? '' : 's'} match these filters`;
  ui.ordersList.replaceChildren(...state.orders.map(orderCard));
  if (!state.orders.length) empty(ui.ordersList, 'No orders match these filters.');
  updatePager('orders', state.orderPage, state.orderTotal);
}

function orderCard(order) {
  const card = el('article', 'oc-order');
  const first = el('div'); const meta = el('div', 'oc-order-meta'); meta.append(el('h3', 'oc-order-number', order.order_number || order.id), statusBadge(order.status));
  first.append(meta, el('p', '', order.customer_name || 'Customer'), el('p', '', [order.customer_phone, order.customer_email].filter(Boolean).join(' · ')));
  const second = el('div'); second.append(el('p', '', `Delivery: ${dateText(order.slot_start)}`), el('p', '', formatAddress(order.address)));
  const actions = el('div', 'oc-order-actions'); actions.append(el('p', 'oc-order-total', money(order.total)), button('View & manage', () => openOrder(order.id)));
  card.append(first, second, actions); return card;
}

function updatePager(prefix, page, total) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  ui[`${prefix}Previous`].disabled = page <= 1; ui[`${prefix}Next`].disabled = page >= pages;
  ui[`${prefix}Page`].textContent = `Page ${page} of ${pages}`;
}

async function loadCustomers() {
  const request = ++state.customerRequest;
  const data = await call('admin_customers', { search: ui.customerSearch.value.trim(), page: state.customerPage, limit: PAGE_SIZE });
  if (!state.authenticated || request !== state.customerRequest) return;
  state.customers = data.customers || []; state.customerTotal = Number(data.total || 0);
  ui.customerCount.textContent = `${state.customerTotal} registered`;
  ui.customersList.replaceChildren(...state.customers.map(customer => {
    const node = el('article', 'oc-customer'); const heading = el('div', 'oc-status-line'); const complete = customer.profile_complete ?? Boolean(customer.full_name && customer.phone); const badge = el('span', 'oc-badge', complete ? 'Profile complete' : 'Profile incomplete');
    heading.append(el('h3', '', customer.full_name || 'Profile not completed'), badge);
    node.append(heading, el('p', '', customer.email || 'No email available'), el('p', '', customer.phone || 'No phone provided'), el('p', '', `Registered: ${dateText(customer.created_at)}`), el('p', '', `Last sign-in: ${dateText(customer.last_sign_in_at)}`), el('p', '', `${Number(customer.order_count || 0)} order${Number(customer.order_count || 0) === 1 ? '' : 's'}`));
    return node;
  }));
  if (!state.customers.length) empty(ui.customersList, 'No registered customers match this search.');
  updatePager('customers', state.customerPage, state.customerTotal);
}

async function openOrder(id) {
  const known = [...state.orders, ...state.deliveryOrders].find(item => item.id === id);
  if (!known) return;
  state.detail = known; status('', false, ui.orderDialogStatus);
  renderOrderDetail();
  if (!ui.orderDialog.open) ui.orderDialog.showModal();
}

function renderOrderDetail() {
  const order = state.detail; if (!order) return;
  ui.orderDialogTitle.textContent = order.order_number || order.id;
  const summary = el('div', 'oc-order-meta'); summary.append(statusBadge(order.status), el('span', 'oc-badge', `Cash on delivery · ${order.payment_status === 'collected' ? 'collected' : 'pending'}`));
  if (order.delivery_code_required) summary.append(el('span', 'oc-badge', 'Acceptance code required'));
  const grid = el('div', 'oc-detail-grid'); const person = el('div', 'oc-detail-card'); person.append(el('h3', '', 'Customer'), el('p', '', order.customer_name || 'Customer'), el('p', '', order.customer_email || ''), el('p', '', order.customer_phone || ''));
  const delivery = el('div', 'oc-detail-card'); delivery.append(el('h3', '', 'Delivery'), el('p', '', dateText(order.slot_start)), el('p', '', formatAddress(order.address)));
  if (validCoordinates(order.address)) { const directions = el('a', '', 'Open directions'); directions.href = directionsUrl(order.address); directions.target = '_blank'; directions.rel = 'noopener noreferrer'; delivery.append(directions); }
  grid.append(person, delivery);
  const table = el('table', 'oc-items'); const head = el('thead'); const hr = el('tr'); for (const title of ['Item', 'Qty', 'Amount']) hr.append(el('th', '', title)); head.append(hr); const body = el('tbody');
  for (const item of order.items || order.order_items || []) { const row = el('tr'); row.append(el('td', '', [item.title || item.product_title || 'Product', item.size, item.color].filter(Boolean).join(' · ')), el('td', '', item.quantity), el('td', '', money(item.line_total ?? Number(item.unit_price) * Number(item.quantity)))); body.append(row); }
  table.append(head, body);
  const totals = el('p', 'oc-order-total', `Subtotal ${money(order.subtotal)} + delivery ${money(order.delivery_fee)} = ${money(order.total)}`);
  ui.orderDetailBody.replaceChildren(summary, grid, table, totals, el('p', 'oc-help', `Booked ${dateText(order.created_at)}`));
  if (order.notes) ui.orderDetailBody.append(el('p', '', `Customer note: ${order.notes}`));
  if (order.cancel_reason) ui.orderDetailBody.append(el('p', '', `Cancellation reason: ${order.cancel_reason}`));
  if (!TERMINAL.has(order.status)) { addStatusControls(order); addSlotControls(order); addDeliveryControls(order); }
  const mail = el('section', 'oc-detail-section'); mail.append(el('h3', '', 'Order emails'), el('p', 'oc-help', 'Booking, delivery and cancellation emails are sent automatically. Failed messages are retried by the delivery service. Delivery codes are never included.'));
  if (order.email_status) mail.append(el('p', 'oc-mail-status', `Email status: ${String(order.email_status)}`));
  for (const event of order.email_events || []) mail.append(el('p', 'oc-help', `${event.event_type}: ${event.state} · ${Number(event.attempts) || 0} attempt(s)${event.sent_at ? ` · accepted ${dateText(event.sent_at)}` : ''}`));
  if (order.email_events?.some(event => event.can_retry)) mail.append(button('Retry failed email', () => mutateDetail('admin_retry_email', { order_id: order.id }, 'Failed email queued for retry.')));
  else if (order.email_status === 'failed') mail.append(el('p', 'oc-help', 'The safe retry window has expired. Review this notification in Resend before sending a separate message.'));
  ui.orderDetailBody.append(mail);
  if (TERMINAL.has(order.status)) { const section = el('section', 'oc-detail-section'); section.append(el('h3', '', 'Permanent deletion'), el('p', 'oc-help', 'This removes the shared order and related database records for both customer and admin. Already-sent emails and provider backups are outside this action.'), button('Permanently delete order', async () => {
    if (!confirm(`Permanently delete order ${order.order_number || order.id} for both the customer and admin? This cannot be undone.`)) return;
    await mutateDetail('admin_delete_order', { order_id: order.id }, 'Order permanently deleted.', true);
  }, 'oc-danger')); ui.orderDetailBody.append(section); }
}

function addStatusControls(order) {
  const section = el('section', 'oc-detail-section'); section.append(el('h3', '', 'Move the order forward or cancel'));
  const form = el('form'); const label = el('label', '', 'Next status'); const select = el('select'); select.required = true; const placeholder = el('option', '', 'Choose status'); placeholder.value = ''; select.append(placeholder);
  for (const value of nextStatuses(order.status)) { const option = el('option', '', STATUS_LABELS[value]); option.value = value; select.append(option); }
  label.append(select); const cancelLabel = el('label', '', 'Cancellation reason'); const reason = el('input'); reason.maxLength = 500; reason.placeholder = 'Explain the cancellation to the customer'; cancelLabel.append(reason); cancelLabel.hidden = true;
  select.addEventListener('change', () => { cancelLabel.hidden = select.value !== 'cancelled'; reason.required = select.value === 'cancelled'; });
  const save = el('button', 'oc-button oc-primary', 'Update status'); save.type = 'submit'; form.append(label, cancelLabel, save);
  form.addEventListener('submit', async event => { event.preventDefault(); if (!select.value) return; if (select.value === 'cancelled' && !confirm('Cancel this order, release its reserved stock and notify the customer?')) return; await mutateDetail('admin_update_order', { order_id: order.id, status: select.value, cancel_reason: reason.value.trim() || undefined }, select.value === 'cancelled' ? 'Order cancelled. The customer notification is queued.' : 'Order status updated.'); }); section.append(form); ui.orderDetailBody.append(section);
}

function addSlotControls(order) {
  const section = el('section', 'oc-detail-section'); section.append(el('h3', '', 'Change delivery slot'));
  const form = el('form'); const dateLabel = el('label', '', 'Delivery date'); const date = el('input'); date.type = 'date'; date.required = true;
  const timeLabel = el('label', '', `Delivery time (${state.settings?.timezone || 'Asia/Kolkata'})`); const time = el('select'); time.required = true;
  for (const value of state.settings?.delivery_slots || []) { const option = el('option', '', value); option.value = value; time.append(option); }
  if (order.slot_start) { const part = zonedParts(order.slot_start, state.settings?.timezone || 'Asia/Kolkata'); date.value = `${part.year}-${part.month}-${part.day}`; const currentTime = `${part.hour}:${part.minute}`; if ([...time.options].some(option => option.value === currentTime)) time.value = currentTime; }
  dateLabel.append(date); timeLabel.append(time); const submit = el('button', 'oc-button', 'Reschedule'); submit.type = 'submit'; form.append(dateLabel, timeLabel, submit);
  form.addEventListener('submit', async event => { event.preventDefault(); try { const slot_start = zonedSlotIso(date.value, time.value, state.settings?.timezone || 'Asia/Kolkata'); await mutateDetail('admin_update_order', { order_id: order.id, slot_start }, 'Delivery slot updated.'); } catch (error) { status(error.message, true, ui.orderDialogStatus); } });
  section.append(form, el('p', 'oc-help', 'The server checks the configured schedule and slot capacity before saving.')); ui.orderDetailBody.append(section);
}

function addDeliveryControls(order) {
  const section = el('section', 'oc-detail-section'); section.append(el('h3', '', 'Complete delivery'));
  if (order.status !== 'out_for_delivery') { section.append(el('p', 'oc-help', 'Move the order to Out for delivery before recording payment and delivery acceptance.')); ui.orderDetailBody.append(section); return; }
  const form = el('form'); const collected = el('label', 'oc-toggle'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.required = true; collected.append(checkbox, el('span', '', `I collected ${money(order.total)} in cash from the customer.`)); form.append(collected);
  const label = el('label', '', 'Customer acceptance code'); const code = el('input', 'oc-code-input'); code.type = 'text'; code.inputMode = 'numeric'; code.autocomplete = 'off'; code.maxLength = 4; code.pattern = '[0-9]{4}'; code.required = Boolean(order.delivery_code_required); label.hidden = !order.delivery_code_required; label.append(code); form.append(label);
  const submit = el('button', 'oc-button oc-primary', 'Verify & complete delivery'); submit.type = 'submit'; form.append(submit);
  form.addEventListener('submit', async event => { event.preventDefault(); const entered = code.value; code.value = ''; if (order.delivery_code_required && !/^\d{4}$/.test(entered)) { status('Enter the four-digit code provided by the recipient.', true, ui.orderDialogStatus); return; } await mutateDetail('admin_complete_delivery', { order_id: order.id, code: order.delivery_code_required ? entered : undefined, payment_collected: checkbox.checked }, 'Delivery completed. The customer confirmation is queued.'); });
  section.append(form, el('p', 'oc-help', order.delivery_code_required ? 'Ask the recipient to open their order and provide the code. It is not available to admin. Incorrect attempts can temporarily lock verification.' : 'The acceptance-code requirement was off when this order was placed.')); ui.orderDetailBody.append(section);
}

async function mutateDetail(action, payload, message, remove = false) {
  if (state.detailBusy) return;
  const generation = state.sessionGeneration;
  state.detailBusy = true;
  for (const control of ui.orderDetailBody.querySelectorAll('button,input,select')) control.disabled = true;
  status('Saving…', false, ui.orderDialogStatus);
  try {
    const result = await call(action, payload);
    if (!state.authenticated) return;
    if (action === 'admin_retry_email' && !result.queued) throw new Error('No failed email is eligible for retry. Refresh the order to check its current status.');
    if (remove) { ui.orderDialog.close(); state.detail = null; }
    else if (result.order) { state.detail = result.order; renderOrderDetail(); }
    status(message, false, remove ? ui.commerceStatus : ui.orderDialogStatus, true);
    if (state.tab === 'delivery') await loadDeliveries(); else await loadOrders();
  } catch (error) { status(error.message || 'The order could not be updated.', true, ui.orderDialogStatus); }
  finally { if (generation === state.sessionGeneration) { state.detailBusy = false; for (const control of ui.orderDetailBody.querySelectorAll('button,input,select')) control.disabled = false; } }
}

function validCoordinates(address) { return address && address.latitude !== null && address.longitude !== null && address.latitude !== '' && address.longitude !== '' && address.latitude !== undefined && address.longitude !== undefined && Number.isFinite(Number(address.latitude)) && Number.isFinite(Number(address.longitude)) && Math.abs(Number(address.latitude)) <= 90 && Math.abs(Number(address.longitude)) <= 180; }
function directionsUrl(address) { const url = new URL('https://www.google.com/maps/dir/'); url.searchParams.set('api', '1'); url.searchParams.set('destination', `${address.latitude},${address.longitude}`); if (state.ownLocation) url.searchParams.set('origin', `${state.ownLocation.latitude},${state.ownLocation.longitude}`); return url.href; }
function slotDay(value) { if (!value) return ''; const part = zonedParts(value, state.settings?.timezone || 'Asia/Kolkata'); return `${part.year}-${part.month}-${part.day}`; }

async function loadDeliveries() {
  const request = ++state.deliveryRequest;
  const all = []; let total = 0;
  for (let page = 1; page <= 20; page++) {
    const data = await call('admin_orders', { filter: 'active', status: ui.deliveryStatus.value, date_from: ui.deliveryDate.value || undefined, date_to: ui.deliveryDate.value || undefined, page, limit: 100 });
    if (!state.authenticated || request !== state.deliveryRequest) return;
    all.push(...(data.orders || [])); total = Number(data.total || 0);
    if (!(data.orders || []).length || all.length >= total) break;
  }
  state.deliveryOrders = all.filter(order => !ui.deliveryDate.value || slotDay(order.slot_start) === ui.deliveryDate.value);
  ui.deliveryList.replaceChildren(...state.deliveryOrders.map(orderCard));
  if (!state.deliveryOrders.length) empty(ui.deliveryList, 'No active deliveries match these filters.');
  renderDeliveryMap();
  if (all.length < total) ui.deliveryMapStatus.textContent += ` Only the first ${all.length} of ${total} active orders were loaded; narrow your filters to review the rest.`;
}

function renderDeliveryMap() {
  if (!window.L) { ui.deliveryMapStatus.textContent = 'The map library could not load. Addresses and Google directions links remain available in each order.'; return; }
  if (!state.map) {
    state.map = window.L.map(ui.deliveryMap).setView([Number(state.settings?.store_latitude || 23.9932828), Number(state.settings?.store_longitude || 85.3593752)], 13);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(state.map);
    state.markers = window.L.layerGroup().addTo(state.map);
  }
  state.markers.clearLayers(); const bounds = [];
  state.deliveryOrders.filter(order => validCoordinates(order.address)).forEach((order, index) => {
    const coords = [Number(order.address.latitude), Number(order.address.longitude)]; bounds.push(coords);
    const icon = window.L.divIcon({ className: '', html: `<span class="oc-map-marker">${index + 1}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });
    const popup = el('div', 'oc-popup'); popup.append(el('strong', '', order.order_number || order.id), el('p', '', order.customer_name || 'Customer'), el('p', '', formatAddress(order.address)), el('p', '', dateText(order.slot_start)), button('Manage delivery', () => openOrder(order.id)));
    window.L.marker(coords, { icon }).bindPopup(popup).addTo(state.markers);
  });
  if (state.ownLocation) bounds.push([state.ownLocation.latitude, state.ownLocation.longitude]);
  if (bounds.length) state.map.fitBounds(bounds, { padding: [35, 35], maxZoom: 15 });
  requestAnimationFrame(() => state.map?.invalidateSize());
  const pinned = state.deliveryOrders.filter(order => validCoordinates(order.address)).length;
  ui.deliveryMapStatus.textContent = `${pinned} delivery pin${pinned === 1 ? '' : 's'} shown. ${state.deliveryOrders.length - pinned} order${state.deliveryOrders.length - pinned === 1 ? '' : 's'} without a valid map pin.`;
}

function stopLocation() { state.locationGeneration++; if (state.geoWatch !== null) navigator.geolocation?.clearWatch(state.geoWatch); state.geoWatch = null; state.ownLocation = null; state.ownMarker?.remove(); state.ownAccuracy?.remove(); state.ownMarker = null; state.ownAccuracy = null; ui.useAdminLocation.textContent = 'Show my location'; }
function startLocation() {
  if (state.geoWatch !== null) { stopLocation(); ui.adminLocationStatus.textContent = 'Live location updates stopped.'; return; }
  if (!navigator.geolocation) { ui.adminLocationStatus.textContent = 'Geolocation is not supported by this browser.'; return; }
  ui.adminLocationStatus.textContent = 'Requesting your location…'; ui.useAdminLocation.textContent = 'Stop location updates';
  const generation = ++state.locationGeneration;
  state.geoWatch = navigator.geolocation.watchPosition(position => {
    if (generation !== state.locationGeneration) return;
    if (!state.authenticated || state.tab !== 'delivery') { stopLocation(); return; }
    state.ownLocation = { latitude: position.coords.latitude, longitude: position.coords.longitude };
    ui.adminLocationStatus.textContent = `Your current location is shown in blue (accuracy about ${Math.round(position.coords.accuracy)} m). It is not stored in the order database.`;
    renderDeliveryMap();
    if (state.map && window.L) { const coords = [position.coords.latitude, position.coords.longitude]; if (state.ownMarker) state.ownMarker.setLatLng(coords); else state.ownMarker = window.L.circleMarker(coords, { radius: 8, fillColor: '#2365b8', color: '#fff', weight: 3, fillOpacity: 1 }).bindTooltip('Your current location').addTo(state.map); if (state.ownAccuracy) state.ownAccuracy.setLatLng(coords).setRadius(Math.min(position.coords.accuracy, 5000)); else state.ownAccuracy = window.L.circle(coords, { radius: Math.min(position.coords.accuracy, 5000), weight: 1, color: '#2365b8', fillOpacity: .08 }).addTo(state.map); }
  }, error => { if (generation !== state.locationGeneration) return; stopLocation(); ui.adminLocationStatus.textContent = error.code === 1 ? 'Location permission was declined. You can still view customer pins and addresses.' : 'Your location is unavailable. Customer pins and addresses remain available.'; }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
}

async function loadInventory() {
  const data = await call('admin_inventory'); if (!state.authenticated) return; state.inventory = data.products || []; renderInventory();
}
function renderInventory() {
  const search = ui.inventorySearch.value.trim().toLowerCase();
  ui.inventoryList.replaceChildren(...state.inventory.filter(product => String(product.title).toLowerCase().includes(search)).map(product => {
    const form = el('form', 'oc-stock-form'); const heading = el('div', 'oc-stock-heading'); heading.append(el('h3', '', product.title), el('p', '', `${product.price == null ? 'Price on request' : money(product.price)} · ${product.is_active ? 'Active' : 'Archived'}`));
    const stockLabel = el('label', '', 'Available stock'); const stock = el('input'); stock.type = 'number'; stock.min = '0'; stock.max = '1000000'; stock.step = '1'; stock.required = true; stock.value = Number(product.stock_quantity || 0); stockLabel.append(stock);
    const sizeLabel = el('label', '', 'Sizes (comma-separated)'); const sizes = el('input'); sizes.value = (product.size_options || []).join(', '); sizeLabel.append(sizes);
    const colorLabel = el('label', '', 'Colours (comma-separated)'); const colors = el('input'); colors.value = (product.color_options || []).join(', '); colorLabel.append(colors);
    const save = el('button', 'oc-button', 'Save stock'); save.type = 'submit'; form.append(heading, stockLabel, sizeLabel, colorLabel, save);
    form.addEventListener('submit', async event => { event.preventDefault(); try { const quantity = Number(stock.value); if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1000000) throw new Error('Available stock must be a whole number between 0 and 1,000,000.'); const data = { product_id: product.id, stock_quantity: quantity, size_options: parseOptions(sizes.value), color_options: parseOptions(colors.value) }; save.disabled = true; await call('admin_save_inventory', data); await loadInventory(); status('Available stock and product choices saved.', false, ui.commerceStatus, true); } catch (error) { status(error.message, true); } finally { save.disabled = false; } }); return form;
  }));
  if (!ui.inventoryList.children.length) empty(ui.inventoryList, 'No catalogue products match this search.');
}

const settingIds = { allow_orders: 'settingAllowOrders', max_orders_per_day: 'settingMaxOrders', max_items_per_order: 'settingMaxItems', max_quantity_per_item: 'settingMaxQuantity', delivery_fee: 'settingDeliveryFee', min_order_amount: 'settingMinOrder', timezone: 'settingTimezone', delivery_slots: 'settingSlots', default_slot_offset: 'settingSlotOffset', slot_duration_minutes: 'settingSlotDuration', slot_capacity: 'settingSlotCapacity', store_latitude: 'settingStoreLatitude', store_longitude: 'settingStoreLongitude', delivery_radius_km: 'settingRadius', serviceable_pincodes: 'settingPincodes', delivery_code_enabled: 'settingDeliveryCode', auto_delete_enabled: 'settingAutoDelete', customer_history_days: 'settingCustomerDays', admin_history_days: 'settingAdminDays' };
async function loadSettings() {
  const data = await call('admin_settings'); if (!state.authenticated) return; state.settings = data.settings;
  if (!state.settings) throw new Error('Order settings could not be loaded.');
  for (const [key, id] of Object.entries(settingIds)) { const input = ui[id]; if (input.type === 'checkbox') input.checked = Boolean(state.settings[key]); else input.value = Array.isArray(state.settings[key]) ? state.settings[key].join(key === 'delivery_slots' ? '\n' : ', ') : state.settings[key] ?? ''; }
  state.templates = structuredClone(state.settings.email_templates || {}); state.emailEvent = ui.settingEmailEvent.value; fillTemplate();
  const setupNotices = [];
  if (state.settings.security_ready === false) setupNotices.push('Ordering is locked until security activation is complete.');
  if (state.settings.admin_password_ready === false) setupNotices.push('Before enabling orders, change the admin password to at least 12 characters in Admin menu → Admin Password, then sign in again.');
  const locked = setupNotices.length > 0;
  ui.orderingBadge.textContent = state.settings.security_ready === false ? 'Ordering locked · security setup pending' : state.settings.admin_password_ready === false ? 'Ordering locked · change admin password' : state.settings.allow_orders ? 'Online orders enabled' : 'Online orders paused'; ui.orderingBadge.dataset.tone = state.settings.allow_orders && !locked ? 'good' : 'warn';
  ui.settingAllowOrders.disabled = locked;
  if (locked) ui.settingAllowOrders.checked = false;
  status(setupNotices.join(' ') + (state.settings.admin_password_ready === false ? ' Settings can be reviewed here; saving requires the password change after security activation.' : locked ? ' Other settings can be prepared and saved.' : ''), false, ui.orderingSetupStatus);
  state.settingsDirty = false;
  ui.settingsSavedAt.textContent = state.settings.updated_at ? `Last saved ${dateText(state.settings.updated_at)}` : '';
}
function storeTemplate() { state.templates[state.emailEvent] = { subject: ui.settingEmailSubject.value, body: ui.settingEmailBody.value }; }
function fillTemplate() { const template = state.templates[state.emailEvent] || {}; ui.settingEmailSubject.value = template.subject || ''; ui.settingEmailBody.value = template.body || ''; previewTemplate(); }
function previewTemplate() { ui.emailPreviewSubject.textContent = templatePreview(ui.settingEmailSubject.value); ui.emailPreviewBody.textContent = templatePreview(ui.settingEmailBody.value); }
async function saveSettings(event) {
  event.preventDefault(); if (!state.settings || state.loading) return; storeTemplate();
  try {
    const values = Object.fromEntries(Object.entries(settingIds).map(([key, id]) => [key, ui[id].type === 'checkbox' ? ui[id].checked : ui[id].value]));
    const settings = validateSettings(values, state.templates);
    if ((state.settings.security_ready === false || state.settings.admin_password_ready === false) && settings.allow_orders) throw new Error('Ordering is locked until security activation and the required admin password change are complete.');
    if (needsRetentionConfirmation(state.settings, settings) && !confirm('These retention settings may immediately make existing finished orders eligible for irreversible deletion when both visibility periods expire. Save these settings?')) return;
    state.loading = true; ui.saveCommerceSettings.disabled = true;
    await call('admin_save_settings', { settings });
    await loadSettings(); status('Order settings saved. New bookings use the updated delivery-code and slot rules.', false, ui.commerceStatus, true);
  } catch (error) { status(error.message || 'Settings could not be saved.', true); }
  finally { state.loading = false; ui.saveCommerceSettings.disabled = false; }
}

async function init() {
  for (const id of ['commerceLogin', 'commerceLoginForm', 'commerceUsername', 'commercePassword', 'loginStatus', 'commerceDashboard', 'adminLogout', 'commerceRefresh', 'commerceStatus', 'orderingBadge', 'orderingSetupStatus', 'orderCount', 'orderFilters', 'orderSearch', 'orderStatus', 'orderDateFrom', 'orderDateTo', 'ordersList', 'ordersPrevious', 'ordersNext', 'ordersPage', 'customerFilters', 'customerSearch', 'customerCount', 'customersList', 'customersPrevious', 'customersNext', 'customersPage', 'useAdminLocation', 'adminLocationStatus', 'deliveryFilters', 'deliveryDate', 'deliveryStatus', 'deliveryMap', 'deliveryMapStatus', 'deliveryList', 'inventorySearch', 'inventoryList', 'commerceSettingsForm', 'settingEmailEvent', 'settingEmailSubject', 'settingEmailBody', 'emailPreviewSubject', 'emailPreviewBody', 'saveCommerceSettings', 'settingsSavedAt', 'orderDialog', 'orderDialogTitle', 'closeOrderDialog', 'orderDetailBody', 'orderDialogStatus', ...Object.values(settingIds), ...['orders', 'customers', 'delivery', 'inventory', 'settings'].map(name => `panel-${name}`)]) ui[id] = document.getElementById(id);
  ui.commerceLoginForm.addEventListener('submit', async event => { event.preventDefault(); const submit = ui.commerceLoginForm.querySelector('button[type="submit"]'); submit.disabled = true; status('Checking admin credentials…', false, ui.loginStatus); try { await signInAdmin(state.config, ui.commerceUsername.value.trim(), ui.commercePassword.value); ui.commercePassword.value = ''; status('', false, ui.loginStatus); await unlock(); } catch (error) { ui.commercePassword.value = ''; status(error.message || 'Unable to sign in.', true, ui.loginStatus); } finally { submit.disabled = false; } });
  ui.adminLogout.addEventListener('click', () => { void signOutAdmin(state.config); clearPrivateState(); status('Signed out.', false, ui.loginStatus); });
  for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => void selectTab(tab.dataset.tab));
  document.querySelector('.oc-tabs').addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; const tabs = [...document.querySelectorAll('[data-tab]')]; let index = tabs.findIndex(node => node.dataset.tab === state.tab); index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; event.preventDefault(); tabs[index].focus(); void selectTab(tabs[index].dataset.tab); });
  for (const filter of document.querySelectorAll('[data-order-filter]')) filter.addEventListener('click', async () => { state.orderFilter = filter.dataset.orderFilter; state.orderPage = 1; for (const button of document.querySelectorAll('[data-order-filter]')) button.setAttribute('aria-pressed', String(button === filter)); try { await loadOrders(); } catch (error) { status(error.message, true); } });
  ui.orderFilters.addEventListener('submit', async event => { event.preventDefault(); state.orderPage = 1; if (ui.orderDateFrom.value && ui.orderDateTo.value && ui.orderDateFrom.value > ui.orderDateTo.value) { status('The start date must be before the end date.', true); return; } try { await loadOrders(); } catch (error) { status(error.message, true); } });
  ui.customerFilters.addEventListener('submit', async event => { event.preventDefault(); state.customerPage = 1; try { await loadCustomers(); } catch (error) { status(error.message, true); } });
  for (const [id, key, change, loader] of [['ordersPrevious', 'orderPage', -1, loadOrders], ['ordersNext', 'orderPage', 1, loadOrders], ['customersPrevious', 'customerPage', -1, loadCustomers], ['customersNext', 'customerPage', 1, loadCustomers]]) ui[id].addEventListener('click', async () => { state[key] = Math.max(1, state[key] + change); try { await loader(); } catch (error) { state[key] = Math.max(1, state[key] - change); status(error.message, true); } });
  ui.deliveryFilters.addEventListener('submit', async event => { event.preventDefault(); try { await loadDeliveries(); } catch (error) { status(error.message, true); } });
  ui.useAdminLocation.addEventListener('click', startLocation); window.addEventListener('pagehide', stopLocation);
  ui.inventorySearch.addEventListener('input', renderInventory); ui.commerceSettingsForm.addEventListener('submit', saveSettings);
  for (const event of ['input', 'change']) ui.commerceSettingsForm.addEventListener(event, event => { if (event.target !== ui.settingEmailEvent) state.settingsDirty = true; });
  window.addEventListener('beforeunload', event => { if (state.authenticated && state.settingsDirty) { event.preventDefault(); event.returnValue = ''; } });
  ui.settingEmailEvent.addEventListener('change', () => { storeTemplate(); state.emailEvent = ui.settingEmailEvent.value; fillTemplate(); });
  for (const input of [ui.settingEmailSubject, ui.settingEmailBody]) input.addEventListener('input', () => { storeTemplate(); previewTemplate(); });
  ui.closeOrderDialog.addEventListener('click', () => ui.orderDialog.close()); ui.orderDialog.addEventListener('click', event => { if (event.target === ui.orderDialog) ui.orderDialog.close(); });
  ui.commerceRefresh.addEventListener('click', () => void selectTab(state.tab));
  try { state.config = await loadSupabaseConfig(); if (!state.config?.url || !state.config?.anonKey) throw new Error('Admin connection settings are unavailable. Please try again later.'); state.api = createCommerceApi(state.config, { getAdminToken: adminToken }); if (await validateAdminSession(state.config)) await unlock(); }
  catch (error) { clearPrivateState(); status(error.message || 'The admin service could not be loaded.', true, ui.loginStatus); }
}
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);
