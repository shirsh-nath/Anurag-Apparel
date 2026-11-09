import { createCommerceApi, CommerceError } from './commerce-client.js';

const MAP_URL = 'https://maps.app.goo.gl/nyVYJmLnxqmvGUr89';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CART_PREFIX = 'anurag-cart-v1:';
const ACTIVE_STATES = ['placed', 'confirmed', 'preparing', 'out_for_delivery'];
const STATUS_LABELS = { placed: 'Order received', confirmed: 'Confirmed', preparing: 'Preparing', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled' };
const DEFAULTS = { allow_orders: false, max_items_per_order: 20, max_quantity_per_item: 10, timezone: 'Asia/Kolkata', store_latitude: 23.9932828, store_longitude: 85.3593752 };

// Bind a request to the account that supplied its data, including while an
// access-token refresh is pending. Public settings never need a customer token.
export function createAccountBoundCommerceApi(config, account, { fetchImpl = (...args) => fetch(...args) } = {}) {
  let generation = 0;
  const capture = () => ({ owner: account?.getUser()?.id || null, generation });
  const isCurrent = snapshot => snapshot.generation === generation && snapshot.owner === (account?.getUser()?.id || null);
  const assertCurrent = snapshot => { if (!isCurrent(snapshot)) throw new CommerceError('Your account changed. Open checkout or your orders again.', { code: 'ACCOUNT_CHANGED' }); };
  const publicCall = createCommerceApi(config, { fetchImpl });
  return {
    capture, isCurrent,
    invalidate() { generation++; },
    async call(action, data = {}) {
      if (action === 'public_settings') return publicCall(action, data);
      const snapshot = capture();
      if (!snapshot.owner) throw new CommerceError('Sign in to continue with your order.', { code: 'AUTH_REQUIRED' });
      const request = createCommerceApi(config, {
        async getAccessToken() { assertCurrent(snapshot); const token = await account.getAccessToken(); assertCurrent(snapshot); return token; },
        async fetchImpl(...args) { assertCurrent(snapshot); const response = await fetchImpl(...args); assertCurrent(snapshot); return response; }
      });
      try { const result = await request(action, data); assertCurrent(snapshot); return result; }
      catch (error) { assertCurrent(snapshot); throw error; }
    }
  };
}

export function cartKey(item) { return JSON.stringify([item.product_id, item.size || '', item.color || '']); }
export function normalizeCart(items, maxLines = 20, maxQuantity = 10) {
  const merged = new Map();
  for (const item of Array.isArray(items) ? items.slice(0, 200) : []) {
    if (!UUID.test(String(item?.product_id)) || !Number.isSafeInteger(item.quantity) || item.quantity < 1) continue;
    const normalized = { product_id: item.product_id, quantity: Math.min(item.quantity, maxQuantity), size: String(item.size || '').slice(0, 80), color: String(item.color || '').slice(0, 80) };
    const key = cartKey(normalized);
    if (merged.has(key)) merged.get(key).quantity = Math.min(maxQuantity, merged.get(key).quantity + normalized.quantity);
    else if (merged.size < maxLines) merged.set(key, normalized);
  }
  return [...merged.values()];
}
export function normalizeDeliveryAddress(input) {
  const text = (name, max) => String(input[name] || '').trim().replace(/\s+/g, ' ').slice(0, max);
  let phone = text('phone', 30).replace(/[\s().-]/g, '');
  if (/^[6-9]\d{9}$/.test(phone)) phone = '+91' + phone;
  const address = { recipient: text('recipient', 100), phone, line1: text('line1', 200), line2: text('line2', 200), landmark: text('landmark', 200), city: text('city', 100), state: text('state', 100), postal_code: String(input.postal_code || '').trim(), latitude: Number(input.latitude), longitude: Number(input.longitude) };
  if (address.recipient.length < 2) throw new Error('Enter the recipient’s full name.');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('Enter a valid phone number with country code.');
  if (address.line1.length < 5 || address.city.length < 2 || address.state.length < 2) throw new Error('Enter the house/street, city and state for delivery.');
  if (!/^[1-9]\d{5}$/.test(address.postal_code)) throw new Error('Enter a valid six-digit Indian PIN code.');
  if (input.latitude == null || input.longitude == null || String(input.latitude).trim() === '' || String(input.longitude).trim() === '' || !Number.isFinite(address.latitude) || !Number.isFinite(address.longitude) || Math.abs(address.latitude) > 90 || Math.abs(address.longitude) > 180) throw new Error('Pin your delivery location on the map, use your location, or enter valid coordinates.');
  return address;
}
export function cartItemProblem(item, product, settings = DEFAULTS) {
  if (!product || product.is_active === false || product.price === null || !Number.isFinite(Number(product.price))) return 'This item is currently unavailable for online ordering.';
  if (Number(product.stock_quantity || 0) < item.quantity) return 'Available stock has changed. Reduce the quantity or remove this item.';
  if (item.quantity > Number(settings.max_quantity_per_item || 10)) return 'Reduce the quantity to the store’s current per-item limit.';
  if ((product.size_options?.length && !product.size_options.includes(item.size)) || (product.color_options?.length && !product.color_options.includes(item.color))) return 'The available sizes or colours changed. Remove this item and choose it again.';
  return '';
}
export async function checkoutFingerprint(request) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(request)));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export function orderIsActive(order) { return ACTIVE_STATES.includes(order.status); }
export function formatOrderSlot(order, timezone = 'Asia/Kolkata') {
  if (!order?.slot_start) return 'Delivery slot will appear here';
  try {
    const date = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: timezone }).format(new Date(order.slot_start));
    const clock = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: timezone });
    return `${date}, ${clock.format(new Date(order.slot_start))}${order.slot_end ? ' – ' + clock.format(new Date(order.slot_end)) : ''}`;
  } catch { return 'Contact the store to confirm your delivery slot'; }
}

const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value) || 0);
const node = (tag, className = '', text = '') => { const element = document.createElement(tag); element.className = className; if (text !== '') element.textContent = text; return element; };
const button = (label, onClick, primary = false) => { const element = node('button', primary ? 'shop-button shop-button-primary' : 'shop-button', label); element.type = 'button'; element.addEventListener('click', onClick); return element; };
const storage = {
  read(key) { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } },
  write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} }
};
let leafletReady;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletReady) return leafletReady;
  leafletReady = new Promise((resolve, reject) => {
    const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css'; style.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='; style.crossOrigin = 'anonymous'; document.head.append(style);
    const script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js'; script.crossOrigin = 'anonymous';
    script.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
    script.onload = () => window.L ? resolve(window.L) : reject(new Error('Map unavailable'));
    script.onerror = () => { leafletReady = null; reject(new Error('Map unavailable')); };
    document.head.append(script);
  });
  return leafletReady;
}

export async function initializeStorefrontCommerce(config, { account, getProducts, closeProduct, onSettingsChange } = {}) {
  const accountApi = createAccountBoundCommerceApi(config, account);
  const api = accountApi.call;
  let settings = { ...DEFAULTS }, cart = [], cartOwner = account?.getUser()?.id || 'guest', quote = null, submitting = false, map, marker, activeActions, historyPage = 1, historyTotal = 0, historyRevision = 0, checkoutRevision = 0, locationRevision = 0, settingsRevision = 0, checkoutIntent = false, ordersIntent = false, checkoutAttempt = null;
  const navigationUrl = new URL(window.location.href);
  if (navigationUrl.searchParams.get('orders') === '1') {
    ordersIntent = true;
    try { sessionStorage.setItem('anurag-orders-intent', 'true'); } catch {}
    navigationUrl.searchParams.delete('orders');
    window.history.replaceState(window.history.state, '', navigationUrl.pathname + navigationUrl.search + navigationUrl.hash);
  } else { try { ordersIntent = sessionStorage.getItem('anurag-orders-intent') === 'true'; } catch {} }
  const selectedVariants = new Map();
  const ui = {};
  const cartDialog = node('dialog', 'shop-dialog shop-cart-dialog'); cartDialog.id = 'shoppingDialog'; cartDialog.setAttribute('aria-labelledby', 'shoppingTitle');
  cartDialog.innerHTML = `
    <div class="shop-dialog-heading"><div><p class="shop-kicker">Anurag Apparel / Shop online</p><h2 id="shoppingTitle">Your cart</h2></div><button id="shoppingClose" class="shop-close" type="button" aria-label="Close shopping window">×</button></div>
    <ol class="shop-steps" aria-label="Checkout progress"><li id="shoppingStepCart" aria-current="step">01 Cart</li><li id="shoppingStepDelivery">02 Delivery</li><li id="shoppingStepReview">03 Cash on delivery</li></ol>
    <div id="shoppingStatus" class="shop-notice" role="status" aria-live="polite" hidden></div>
    <section id="shoppingCart"><div id="shoppingItems" class="shop-cart-items"></div><div class="shop-cart-footer"><p id="shoppingCartTotal"></p><button id="shoppingContinue" type="button" class="shop-button shop-button-primary">Continue to delivery</button></div><p class="shop-help">Final stock, prices, delivery charges and your delivery slot are confirmed before you place the order.</p></section>
    <form id="shoppingCheckout" hidden>
      <div class="shop-checkout-grid"><section class="shop-address-section"><h3>Where should we deliver?</h3><p class="shop-help">Enter the full address and mark the exact delivery location. Your details are shared with the store for fulfilment.</p>
        <div class="shop-form-grid">
          <label>Recipient name<input name="recipient" autocomplete="name" maxlength="100" required></label>
          <label>Phone number<input name="phone" type="tel" autocomplete="tel" maxlength="30" placeholder="+91 98765 43210" required></label>
          <label class="shop-full">House / building and street<input name="line1" autocomplete="address-line1" minlength="5" maxlength="200" required></label>
          <label class="shop-full">Area / apartment <span class="shop-optional">(optional)</span><input name="line2" autocomplete="address-line2" maxlength="200"></label>
          <label class="shop-full">Landmark <span class="shop-optional">(optional)</span><input name="landmark" maxlength="200"></label>
          <label>City<input name="city" autocomplete="address-level2" maxlength="100" required></label>
          <label>State<input name="state" autocomplete="address-level1" maxlength="100" required></label>
          <label>PIN code<input name="postal_code" autocomplete="postal-code" inputmode="numeric" pattern="[1-9][0-9]{5}" maxlength="6" required></label>
        </div>
        <div class="shop-map-heading"><h4>Delivery location</h4><button id="shoppingUseLocation" class="shop-button" type="button">Use my location</button></div>
        <p id="shoppingMapHelp" class="shop-help">Tap the map to place your delivery pin. Location access is requested only if you choose “Use my location”.</p>
        <div id="shoppingMap" class="shop-map" role="region" aria-label="Choose your delivery location"></div>
        <div class="shop-form-grid shop-coordinate-fields"><label>Latitude<input name="latitude" type="number" min="-90" max="90" step="any" inputmode="decimal" placeholder="Pin on map or enter" required></label><label>Longitude<input name="longitude" type="number" min="-180" max="180" step="any" inputmode="decimal" placeholder="Pin on map or enter" required></label></div>
        <label class="shop-field">Delivery instructions <span class="shop-optional">(optional)</span><textarea name="notes" rows="2" maxlength="500" placeholder="Gate, floor or directions that help our delivery team"></textarea></label>
      </section><aside class="shop-review"><h3>Order summary</h3><div id="shoppingReviewItems"></div><div id="shoppingTotals" class="shop-totals"></div><div class="shop-payment"><span class="shop-badge">Cash on delivery</span><p>Pay the displayed total when your order arrives.</p></div><div id="shoppingSlot" class="shop-slot" hidden></div><p class="shop-help">Read the <a href="/terms">Terms of Service</a> and <a href="/privacy">Privacy Policy</a> before ordering.</p><button id="shoppingReview" class="shop-button shop-button-primary shop-wide" type="submit">Review order & delivery slot</button><button id="shoppingPlace" class="shop-button shop-button-primary shop-wide" type="button" hidden>Place cash-on-delivery order</button><button id="shoppingBack" class="shop-button shop-wide" type="button">Back to cart</button></aside></div>
    </form>
    <section id="shoppingSuccess" hidden></section>`;
  document.body.append(cartDialog);
  for (const id of ['shoppingClose', 'shoppingStatus', 'shoppingCart', 'shoppingItems', 'shoppingCartTotal', 'shoppingContinue', 'shoppingCheckout', 'shoppingReviewItems', 'shoppingTotals', 'shoppingSlot', 'shoppingReview', 'shoppingPlace', 'shoppingBack', 'shoppingSuccess', 'shoppingUseLocation', 'shoppingMap', 'shoppingMapHelp', 'shoppingStepCart', 'shoppingStepDelivery', 'shoppingStepReview']) ui[id] = document.getElementById(id);
  const form = ui.shoppingCheckout;
  const field = name => form.elements.namedItem(name);
  const ordersDialog = node('dialog', 'shop-dialog shop-orders-dialog'); ordersDialog.id = 'customerOrdersDialog'; ordersDialog.setAttribute('aria-labelledby', 'customerOrdersTitle');
  ordersDialog.innerHTML = `<div class="shop-dialog-heading"><div><p class="shop-kicker">Anurag Apparel / Your purchases</p><h2 id="customerOrdersTitle">My orders</h2></div><button id="customerOrdersClose" class="shop-close" type="button" aria-label="Close order history">×</button></div><div class="shop-order-filters"><label>Show<select id="customerOrderFilter"><option value="active">Active orders</option><option value="past">Past orders</option><option value="all">All visible history</option></select></label><label>Status<select id="customerOrderStatus"><option value="">Any status</option><option value="placed">Order received</option><option value="confirmed">Confirmed</option><option value="preparing">Preparing</option><option value="out_for_delivery">Out for delivery</option><option value="delivered">Delivered</option><option value="cancelled">Cancelled</option></select></label><label class="shop-order-search">Find order<input id="customerOrderSearch" type="search" placeholder="Order number" maxlength="80"></label><button id="customerOrdersRefresh" class="shop-button" type="button">Refresh</button></div><p class="shop-help">History is shown according to the store’s customer-history period. Expired history may no longer be available.</p><p id="customerOrdersStatus" class="shop-notice" role="status" aria-live="polite" hidden></p><div id="customerOrdersList"></div><div id="customerOrderDetails" hidden></div><div class="shop-pagination"><button id="customerOrdersPrevious" class="shop-button" type="button">Previous</button><span id="customerOrdersPage"></span><button id="customerOrdersNext" class="shop-button" type="button">Next</button></div>`;
  document.body.append(ordersDialog);
  for (const id of ['customerOrdersClose', 'customerOrderFilter', 'customerOrderStatus', 'customerOrderSearch', 'customerOrdersRefresh', 'customerOrdersStatus', 'customerOrdersList', 'customerOrderDetails', 'customerOrdersPrevious', 'customerOrdersNext', 'customerOrdersPage']) ui[id] = document.getElementById(id);
  const cartButton = document.getElementById('customerCart');
  const historyButton = document.getElementById('customerOrders');

  function message(text = '', error = false, target = ui.shoppingStatus) { target.textContent = text; target.hidden = !text; target.dataset.error = String(error); }
  function openDialog(dialog) { closeProduct?.(); if (!dialog.open) dialog.showModal(); }
  function setStep(step) {
    ui.shoppingCart.hidden = step !== 'cart'; form.hidden = step !== 'delivery'; ui.shoppingSuccess.hidden = step !== 'success';
    for (const [element, active] of [[ui.shoppingStepCart, step === 'cart'], [ui.shoppingStepDelivery, step === 'delivery' && !quote], [ui.shoppingStepReview, step === 'success' || Boolean(quote)]]) { if (active) element.setAttribute('aria-current', 'step'); else element.removeAttribute('aria-current'); }
  }
  function persistCart() { storage.write(CART_PREFIX + cartOwner, cart); updateCartBadge(); }
  function updateCartBadge() {
    const count = cart.reduce((sum, item) => sum + item.quantity, 0);
    if (cartButton) { cartButton.textContent = count ? `Cart (${count})` : 'Cart'; cartButton.setAttribute('aria-label', `${count} items in cart`); cartButton.hidden = !settings.allow_orders; }
  }
  function productsById() { return new Map((getProducts?.() || []).map(product => [product.id, product])); }
  function productFor(item) { return productsById().get(item.product_id); }
  function invalidateQuote() { ++checkoutRevision; quote = null; ui.shoppingPlace.hidden = true; ui.shoppingReview.hidden = false; ui.shoppingSlot.hidden = true; checkoutAttempt = null; }
  function cartChanged() { invalidateQuote(); persistCart(); renderCart(); }
  function renderCart() {
    ui.shoppingItems.replaceChildren();
    let subtotal = 0;
    if (!cart.length) {
      ui.shoppingItems.append(node('div', 'shop-empty', 'Your cart is empty. Explore the collection and add something you like.'));
      ui.shoppingContinue.disabled = true;
    } else {
      if (cart.length > Number(settings.max_items_per_order || 20)) ui.shoppingItems.append(node('p', 'shop-stock-warning', `Your cart has ${cart.length} product choices. The store currently accepts up to ${settings.max_items_per_order || 20} choices per order. Remove some choices to continue.`));
      for (const item of cart) {
        const product = productFor(item);
        const row = node('article', 'shop-cart-item');
        const imageUrl = product?.gallery_images?.find(url => /\.(?:png|jpe?g|webp|avif)(?:\?|$)/i.test(url));
        if (imageUrl && /^https?:\/\//i.test(imageUrl)) { const image = node('img', 'shop-cart-image'); image.src = imageUrl; image.alt = product.title || ''; image.loading = 'lazy'; row.append(image); }
        const copy = node('div', 'shop-cart-item-copy');
        copy.append(node('h3', '', product?.title || 'Product currently unavailable'));
        if (item.size || item.color) copy.append(node('p', 'shop-help', [item.size && `Size: ${item.size}`, item.color && `Colour: ${item.color}`].filter(Boolean).join(' · ')));
        const unitPrice = Number(product?.price);
        if (product && Number.isFinite(unitPrice) && product.price !== null) { subtotal += unitPrice * item.quantity; copy.append(node('p', 'shop-line-price', money(unitPrice * item.quantity))); }
        const stock = Number(product?.stock_quantity || 0);
        const problem = cartItemProblem(item, product, settings);
        if (problem) copy.append(node('p', 'shop-stock-warning', problem));
        const controls = node('div', 'shop-quantity');
        const minus = button('−', () => { item.quantity = Math.max(1, item.quantity - 1); cartChanged(); }); minus.setAttribute('aria-label', `Reduce quantity of ${product?.title || 'item'}`); minus.disabled = item.quantity <= 1;
        const quantity = node('span', '', String(item.quantity)); quantity.setAttribute('aria-label', 'Quantity');
        const plus = button('+', () => { item.quantity = Math.min(Number(settings.max_quantity_per_item || 10), stock, item.quantity + 1); cartChanged(); }); plus.setAttribute('aria-label', `Increase quantity of ${product?.title || 'item'}`); plus.disabled = item.quantity >= Math.min(Number(settings.max_quantity_per_item || 10), stock);
        controls.append(minus, quantity, plus, button('Remove', () => { cart = cart.filter(value => cartKey(value) !== cartKey(item)); cartChanged(); }));
        copy.append(controls); row.append(copy); ui.shoppingItems.append(row);
      }
      ui.shoppingContinue.disabled = !settings.allow_orders || cart.length > Number(settings.max_items_per_order || 20) || cart.some(item => cartItemProblem(item, productFor(item), settings));
    }
    ui.shoppingCartTotal.textContent = `Items subtotal ${money(subtotal)}`;
    renderReviewItems();
  }
  function renderReviewItems() {
    ui.shoppingReviewItems.replaceChildren();
    for (const item of quote?.items || cart) {
      const product = productFor(item);
      const line = node('div', 'shop-summary-line');
      line.append(node('span', '', `${item.title || product?.title || 'Item'} × ${item.quantity}${item.size ? ` · ${item.size}` : ''}${item.color ? ` · ${item.color}` : ''}`));
      if (quote) line.append(node('strong', '', money(item.line_total ?? Number(item.unit_price) * item.quantity)));
      ui.shoppingReviewItems.append(line);
    }
    ui.shoppingTotals.replaceChildren();
    if (quote) for (const [label, value] of [['Items', quote.subtotal], ['Delivery', quote.delivery_fee], ['Total payable on delivery', quote.total]]) { const line = node('div', 'shop-summary-line'); line.append(node('span', '', label), node('strong', '', money(value))); ui.shoppingTotals.append(line); }
    else ui.shoppingTotals.append(node('p', 'shop-help', 'Review your address to confirm the final total and delivery slot.'));
  }
  function openCart() { message(); invalidateQuote(); setStep('cart'); renderCart(); openDialog(cartDialog); if (!settings.allow_orders) message('Online ordering is currently paused. Your cart is saved; you can still visit the store.'); }
  async function showCheckout() {
    if (!settings.allow_orders) { message('Online ordering is currently paused. Please visit the store.'); return; }
    if (!cart.length) return;
    if (!account?.getUser() || !account?.isProfileComplete()) {
      checkoutIntent = true; storage.write('anurag-checkout-intent', true); cartDialog.close(); account?.open(account?.getUser() ? 'signin' : 'signup'); return;
    }
    const profile = account.getProfile();
    if (!field('recipient').value) field('recipient').value = profile.full_name;
    if (!field('phone').value) field('phone').value = profile.phone;
    invalidateQuote(); message(); setStep('delivery'); renderReviewItems();
    await ensureMap();
  }
  async function ensureMap() {
    if (map) { requestAnimationFrame(() => map.invalidateSize()); return; }
    try {
      const L = await loadLeaflet();
      if (!map) {
        map = L.map(ui.shoppingMap).setView([settings.store_latitude || DEFAULTS.store_latitude, settings.store_longitude || DEFAULTS.store_longitude], 13);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 }).addTo(map);
        map.on('click', event => placePin(event.latlng.lat, event.latlng.lng));
      }
      requestAnimationFrame(() => map.invalidateSize());
    } catch { ui.shoppingMapHelp.textContent = 'The map could not load. Use your current location or enter the latitude and longitude below.'; }
  }
  function placePin(latitude, longitude) {
    field('latitude').value = Number(latitude).toFixed(6); field('longitude').value = Number(longitude).toFixed(6);
    if (map && window.L) { if (marker) marker.setLatLng([latitude, longitude]); else marker = window.L.circleMarker([latitude, longitude], { radius: 10, color: '#79551b', fillColor: '#b7872d', fillOpacity: .9 }).addTo(map); map.setView([latitude, longitude], Math.max(map.getZoom(), 16)); }
    ui.shoppingMapHelp.textContent = 'Delivery pin set. Check that it matches your submitted address.';
    invalidateQuote();
  }
  function readAddress() { return normalizeDeliveryAddress(Object.fromEntries(['recipient', 'phone', 'line1', 'line2', 'landmark', 'city', 'state', 'postal_code', 'latitude', 'longitude'].map(name => [name, field(name).value]))); }
  async function reviewOrder(event) {
    event.preventDefault();
    if (submitting) return;
    let address;
    try { address = readAddress(); } catch (error) { message(error.message, true); return; }
    const owner = account.getUser()?.id;
    if (!owner) { await showCheckout(); return; }
    const identity = accountApi.capture();
    const revision = checkoutRevision;
    ui.shoppingReview.disabled = true; message('Checking stock, delivery availability and your assigned slot…');
    try {
      const response = await api('quote', { items: cart.map(item => ({ ...item })), address });
      if (!accountApi.isCurrent(identity) || !cartDialog.open) return;
      if (revision !== checkoutRevision) { message('Your delivery details changed. Review the order again to confirm the total and slot.'); return; }
      quote = response.quote;
      if (!quote || !Number.isFinite(Number(quote.total))) throw new Error('The final order total is unavailable. Please try again.');
      renderReviewItems();
      ui.shoppingSlot.textContent = `Assigned delivery: ${formatOrderSlot(quote, settings.timezone)}. You can follow any slot updates in My orders.`;
      ui.shoppingSlot.hidden = false; ui.shoppingPlace.hidden = false; ui.shoppingReview.hidden = true; setStep('delivery'); message('Your order is ready for review. It has not been placed yet.');
    } catch (error) { if (accountApi.isCurrent(identity) && cartDialog.open) handleError(error); }
    finally { if (accountApi.isCurrent(identity)) ui.shoppingReview.disabled = !settings.allow_orders; }
  }
  async function placeOrder() {
    if (submitting || !quote) return;
    let address;
    try { address = readAddress(); } catch (error) { message(error.message, true); return; }
    const owner = account.getUser()?.id;
    if (!owner) { await showCheckout(); return; }
    const identity = accountApi.capture();
    const acceptedQuote = { ...quote };
    const request = { items: cart.map(item => ({ ...item })), address, notes: field('notes').value.trim().slice(0, 500) };
    submitting = true; ui.shoppingPlace.disabled = true; ui.shoppingPlace.textContent = 'Placing your order…'; message('Please wait while we book your order.');
    for (const control of form.querySelectorAll('input, select, textarea, button')) control.disabled = true;
    try {
      const fingerprint = await checkoutFingerprint(request);
      if (!accountApi.isCurrent(identity)) return;
      const attemptKey = 'anurag-checkout-attempt:' + owner;
      if (!checkoutAttempt || checkoutAttempt.fingerprint !== fingerprint) {
        let previous;
        try { previous = JSON.parse(sessionStorage.getItem(attemptKey) || 'null'); } catch {}
        checkoutAttempt = previous?.fingerprint === fingerprint && UUID.test(previous.key) && Number(previous.created_at) > Date.now() - 86400000 ? previous : { fingerprint, key: crypto.randomUUID(), created_at: Date.now() };
        // Only an opaque key and request hash survive a reload. No address or code is persisted.
        try { sessionStorage.setItem(attemptKey, JSON.stringify(checkoutAttempt)); } catch {}
      }
      if (!accountApi.isCurrent(identity)) return;
      const result = await api('place_order', { ...request, expected_total: Number(acceptedQuote.total), expected_slot_start: acceptedQuote.slot_start, idempotency_key: checkoutAttempt.key });
      if (!accountApi.isCurrent(identity)) return;
      const order = result.order;
      if (!order?.id) throw new Error('We could not confirm the booking. Retry with this same cart to check its status.');
      cart = []; persistCart(); checkoutAttempt = null; quote = null;
      try { sessionStorage.removeItem(attemptKey); } catch {}
      ui.shoppingSuccess.replaceChildren();
      ui.shoppingSuccess.append(node('p', 'shop-kicker', 'Order received'), node('h3', 'shop-success-title', `Thank you, ${order.customer_name || address.recipient}.`), node('p', '', `Your order ${order.order_number || order.id.slice(0, 8)} has been booked.`), node('p', 'shop-slot', formatOrderSlot(order, settings.timezone)), node('p', 'shop-line-price', `${money(order.total)} · Cash on delivery`), node('p', 'shop-help', order.delivery_code_required ? 'Your private four-digit delivery code is in My orders. Share it with the delivery team only when you receive your order. It is not included in emails.' : 'You can follow your order and delivery slot in My orders.'), button('View my order', () => { cartDialog.close(); openOrders(order.id); }, true));
      form.reset(); ++locationRevision; if (marker) { marker.remove(); marker = null; } setStep('success'); message();
    } catch (error) {
      if (accountApi.isCurrent(identity)) {
        handleError(error);
        if (error.code === 'NETWORK_ERROR' || error.status >= 500 || error.code === 'REQUEST_FAILED') {
          message('We could not confirm the booking. Check My orders before changing your cart, or retry this same order to safely check its booking reference.', true);
          ui.shoppingStatus.append(document.createTextNode(' '), button('Check My orders', () => { cartDialog.close(); void openOrders(); }));
        }
      }
    }
    finally { if (accountApi.isCurrent(identity)) { submitting = false; for (const control of form.querySelectorAll('input, select, textarea, button')) control.disabled = false; ui.shoppingReview.disabled = !settings.allow_orders; ui.shoppingPlace.disabled = !settings.allow_orders; ui.shoppingPlace.textContent = 'Place cash-on-delivery order'; } }
  }
  function handleError(error, target = ui.shoppingStatus) {
    if (error.code === 'ACCOUNT_CHANGED') return;
    if (['ORDERS_DISABLED', 'ORDERING_DISABLED'].includes(error.code)) { settings.allow_orders = false; invalidateQuote(); updateCartBadge(); ui.shoppingContinue.disabled = true; ui.shoppingReview.disabled = true; ui.shoppingPlace.disabled = true; if (activeActions) renderProductActions(activeActions.container, activeActions.product); onSettingsChange?.(settings); }
    if (['PRICE_CHANGED', 'SLOT_CHANGED', 'OUT_OF_STOCK', 'INSUFFICIENT_STOCK', 'ITEM_UNAVAILABLE'].includes(error.code)) { invalidateQuote(); renderReviewItems(); }
    message(error.message || 'This request could not be completed. Please try again.', true, target);
  }
  async function openOrders(orderId, initialFilter = 'active') {
    if (!account?.getUser()) {
      ordersIntent = true; checkoutIntent = false; storage.remove('anurag-checkout-intent');
      try { sessionStorage.setItem('anurag-orders-intent', 'true'); } catch {}
      account?.open('signin'); return;
    }
    ordersIntent = false;
    try { sessionStorage.removeItem('anurag-orders-intent'); } catch {}
    account.close();
    historyPage = 1; ui.customerOrderFilter.value = orderId ? 'all' : initialFilter; ui.customerOrderStatus.value = ''; ui.customerOrderSearch.value = '';
    clearOrderDetails(); openDialog(ordersDialog); await loadOrders(orderId);
  }
  function clearOrderDetails() { ui.customerOrderDetails.replaceChildren(); ui.customerOrderDetails.hidden = true; }
  async function loadOrders(selectId) {
    const owner = account.getUser()?.id;
    if (!owner) return;
    const identity = accountApi.capture();
    const revision = ++historyRevision; clearOrderDetails(); ui.customerOrdersList.replaceChildren(); message('Loading your orders…', false, ui.customerOrdersStatus);
    ui.customerOrdersPrevious.disabled = ui.customerOrdersNext.disabled = true;
    try {
      const result = await api('my_orders', { filter: ui.customerOrderFilter.value, status: ui.customerOrderStatus.value || undefined, search: ui.customerOrderSearch.value.trim(), page: historyPage, limit: 10 });
      if (revision !== historyRevision || !accountApi.isCurrent(identity) || !ordersDialog.open) return;
      historyTotal = Number(result.total) || 0;
      const orders = result.orders || [];
      if (!orders.length) ui.customerOrdersList.append(node('p', 'shop-empty', 'No orders match this view.'));
      for (const order of orders) {
        const card = node('article', 'shop-order-card');
        const copy = node('div'); copy.append(node('h3', '', order.order_number || order.id.slice(0, 8)), node('p', 'shop-help', formatOrderSlot(order, settings.timezone)));
        const summary = node('div', 'shop-order-summary'); summary.append(node('span', `shop-badge shop-status-${order.status}`, STATUS_LABELS[order.status] || order.status), node('strong', '', money(order.total)), button('Order details', () => showOrder(order)));
        card.append(copy, summary); ui.customerOrdersList.append(card);
      }
      ui.customerOrdersPage.textContent = `Page ${historyPage} · ${historyTotal} order${historyTotal === 1 ? '' : 's'}`;
      ui.customerOrdersPrevious.disabled = historyPage <= 1; ui.customerOrdersNext.disabled = historyPage * 10 >= historyTotal; message('', false, ui.customerOrdersStatus);
      if (selectId) { const selected = orders.find(order => order.id === selectId); if (selected) showOrder(selected); }
    } catch (error) { if (revision === historyRevision && accountApi.isCurrent(identity) && ordersDialog.open) handleError(error, ui.customerOrdersStatus); }
  }
  function showOrder(order) {
    clearOrderDetails(); ui.customerOrderDetails.hidden = false;
    const panel = ui.customerOrderDetails;
    panel.append(node('p', 'shop-kicker', 'Order details'), node('h3', '', order.order_number || order.id.slice(0, 8)), node('p', 'shop-slot', formatOrderSlot(order, settings.timezone)));
    const progress = node('ol', 'shop-order-progress');
    const currentIndex = ACTIVE_STATES.indexOf(order.status);
    if (order.status === 'cancelled') progress.append(node('li', 'shop-progress-cancelled', 'Cancelled'));
    else for (const [index, status] of [...ACTIVE_STATES, 'delivered'].entries()) { const point = node('li', order.status === 'delivered' || index <= currentIndex ? 'shop-progress-done' : '', STATUS_LABELS[status]); if (order.status === status) point.setAttribute('aria-current', 'step'); progress.append(point); }
    panel.append(progress);
    const items = node('div', 'shop-order-items');
    for (const item of order.items || order.lineitems || []) { const line = node('div', 'shop-summary-line'); line.append(node('span', '', `${item.title} × ${item.quantity}${item.size ? ` · ${item.size}` : ''}${item.color ? ` · ${item.color}` : ''}`), node('strong', '', money(item.line_total))); items.append(line); }
    panel.append(items, node('p', 'shop-line-price', `${money(order.total)} · Cash on delivery · ${order.payment_status === 'collected' ? 'Collected' : 'Pay on delivery'}`));
    const address = order.address || {};
    panel.append(node('h4', '', 'Delivery address'), node('p', 'shop-address-copy', [address.recipient || order.customer_name, address.line1, address.line2, address.landmark, [address.city, address.state, address.postal_code].filter(Boolean).join(', '), address.phone || order.customer_phone].filter(Boolean).join('\n')));
    if (order.notes) panel.append(node('p', 'shop-help', `Delivery instructions: ${order.notes}`));
    if (order.cancel_reason) panel.append(node('p', 'shop-notice', `Cancellation reason: ${order.cancel_reason}`));
    if (order.delivery_code_required && orderIsActive(order)) {
      const codeBox = node('div', 'shop-code-box'); const code = node('p', 'shop-delivery-code'); code.setAttribute('aria-live', 'polite');
      const reveal = button('Show my delivery code', async () => {
        const identity = accountApi.capture(), revision = historyRevision;
        reveal.disabled = true;
        try {
          const result = await api('delivery_code', { order_id: order.id });
          if (!accountApi.isCurrent(identity) || !ordersDialog.open || revision !== historyRevision || !codeBox.isConnected) return;
          if (!/^\d{4}$/.test(result.code)) throw new Error('The delivery code is unavailable. Please refresh your order.');
          code.textContent = result.code; reveal.hidden = true;
        } catch (error) { if (accountApi.isCurrent(identity) && ordersDialog.open) handleError(error, ui.customerOrdersStatus); }
        finally { reveal.disabled = false; }
      });
      codeBox.append(node('h4', '', 'Your private delivery code'), node('p', 'shop-help', 'Give this code to the delivery team only after receiving your order. Store staff cannot view it in their dashboard.'), reveal, code); panel.append(codeBox);
    }
    panel.append(button('Close details', clearOrderDetails));
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function renderProductActions(container, product) {
    activeActions = { container, product }; container.replaceChildren();
    const visit = node('a', 'product-modal-cta', 'Visit Store'); visit.href = MAP_URL; visit.target = '_blank'; visit.rel = 'noreferrer';
    if (!settings.allow_orders || !UUID.test(product.id) || product.price === null || !Number.isFinite(Number(product.price))) { container.append(visit); return; }
    if (!Number.isInteger(Number(product.stock_quantity)) || Number(product.stock_quantity) < 1) { container.append(node('p', 'shop-stock-warning', 'Currently unavailable for online ordering.'), visit); return; }
    const variant = selectedVariants.get(product.id) || { size: '', color: '', quantity: 1 };
    selectedVariants.set(product.id, variant);
    const choices = node('div', 'shop-product-options');
    for (const [fieldName, label, options] of [['size', 'Size', product.size_options], ['color', 'Colour', product.color_options]]) {
      if (!Array.isArray(options) || !options.length) { variant[fieldName] = ''; continue; }
      const wrapper = node('label', '', label); const select = node('select'); select.setAttribute('aria-label', `Choose ${label.toLowerCase()}`);
      const empty = node('option', '', `Choose ${label.toLowerCase()}`); empty.value = ''; select.append(empty);
      for (const option of options) { const entry = node('option', '', String(option)); entry.value = option; select.append(entry); }
      select.value = variant[fieldName]; select.addEventListener('change', () => { variant[fieldName] = select.value; }); wrapper.append(select); choices.append(wrapper);
    }
    const wrapper = node('label', '', 'Quantity'); const quantity = node('input'); quantity.type = 'number'; quantity.min = '1'; quantity.max = String(Math.min(product.stock_quantity, Number(settings.max_quantity_per_item || 10))); quantity.value = String(variant.quantity); quantity.setAttribute('aria-label', 'Quantity'); quantity.addEventListener('change', () => { variant.quantity = Number(quantity.value); }); wrapper.append(quantity); choices.append(wrapper); container.append(choices);
    const feedback = node('p', 'shop-help'); feedback.setAttribute('role', 'status');
    function add(buyNow = false) {
      if (!settings.allow_orders) { feedback.textContent = 'Ordering has been paused. Please visit the store.'; return; }
      for (const [name, options] of [['size', product.size_options], ['color', product.color_options]]) if (options?.length && !options.includes(variant[name])) { feedback.textContent = `Choose a ${name === 'color' ? 'colour' : 'size'} before adding this item.`; return; }
      const qty = Number(quantity.value);
      if (!Number.isSafeInteger(qty) || qty < 1 || qty > Math.min(Number(product.stock_quantity), Number(settings.max_quantity_per_item || 10))) { feedback.textContent = 'Choose a valid available quantity.'; return; }
      const item = { product_id: product.id, quantity: qty, size: variant.size, color: variant.color };
      const match = cart.find(value => cartKey(value) === cartKey(item));
      const totalProductQuantity = cart.filter(value => value.product_id === product.id).reduce((sum, value) => sum + value.quantity, 0);
      if (totalProductQuantity + qty > Number(product.stock_quantity) || (match?.quantity || 0) + qty > Number(settings.max_quantity_per_item || 10)) { feedback.textContent = 'Your cart already contains the available quantity of this item.'; return; }
      if (!match && cart.length >= Number(settings.max_items_per_order || 20)) { feedback.textContent = 'Your cart has reached the maximum number of items for one order.'; return; }
      if (match) match.quantity += qty; else cart.push(item);
      cartChanged(); feedback.textContent = 'Added to your cart.';
      if (buyNow) { openCart(); void showCheckout(); }
    }
    const actions = node('div', 'shop-product-action-row'); actions.append(button('Add to cart', () => add(), false), button('Buy now', () => add(true), true)); container.append(actions, feedback, node('p', 'shop-help', 'Cash on delivery · Your delivery slot is confirmed at checkout'));
  }
  async function refreshSettings() {
    const revision = ++settingsRevision;
    try {
      const result = await api('public_settings');
      if (revision !== settingsRevision) return;
      settings = { ...DEFAULTS, ...result.settings };
      if (!settings.allow_orders) invalidateQuote();
      updateCartBadge(); onSettingsChange?.(settings);
      if (activeActions) renderProductActions(activeActions.container, activeActions.product);
      if (cartDialog.open && !ui.shoppingCart.hidden) renderCart();
      ui.shoppingReview.disabled = submitting || !settings.allow_orders;
      ui.shoppingPlace.disabled = submitting || !settings.allow_orders;
      if (cartDialog.open && !settings.allow_orders) { ui.shoppingContinue.disabled = true; ui.shoppingPlace.disabled = true; message('Online ordering is now paused. Your cart is saved. Please visit the store.'); }
    } catch {
      if (revision !== settingsRevision) return;
      settings.allow_orders = false; invalidateQuote(); updateCartBadge(); onSettingsChange?.(settings);
      ui.shoppingContinue.disabled = true; ui.shoppingReview.disabled = true; ui.shoppingPlace.disabled = true;
      if (activeActions) renderProductActions(activeActions.container, activeActions.product);
      if (cartDialog.open) message('Ordering is temporarily unavailable. Your cart is saved. Please try again or visit the store.', true);
    }
  }
  function handleAccountChange({ user, profileLoaded }) {
    const nextOwner = user?.id || 'guest';
    if (nextOwner !== cartOwner) {
      accountApi.invalidate();
      persistCart(); cartOwner = nextOwner; cart = normalizeCart(storage.read(CART_PREFIX + cartOwner), 100, 100);
      if (user) { cart = normalizeCart([...cart, ...storage.read(CART_PREFIX + 'guest')], 100, 100); storage.remove(CART_PREFIX + 'guest'); }
      persistCart(); form.reset(); invalidateQuote(); clearOrderDetails(); ui.customerOrdersList.replaceChildren(); ui.shoppingSuccess.replaceChildren(); ++historyRevision; ++locationRevision;
      submitting = false;
      for (const control of form.querySelectorAll('input, select, textarea, button')) control.disabled = false;
      ui.shoppingReview.disabled = ui.shoppingPlace.disabled = !settings.allow_orders;
      ui.shoppingPlace.textContent = 'Place cash-on-delivery order';
      if (marker) { marker.remove(); marker = null; }
      if (map) map.setView([settings.store_latitude || DEFAULTS.store_latitude, settings.store_longitude || DEFAULTS.store_longitude], 13);
      ui.shoppingMapHelp.textContent = 'Tap the map to place your delivery pin. Location access is requested only if you choose “Use my location”.';
      if (!user) { cartDialog.close(); ordersDialog.close(); message(); message('', false, ui.customerOrdersStatus); checkoutIntent = false; ordersIntent = false; storage.remove('anurag-checkout-intent'); try { sessionStorage.removeItem('anurag-orders-intent'); } catch {} }
    }
    if (user && profileLoaded && ordersIntent) { queueMicrotask(() => { if (account.getUser()?.id === user.id && ordersIntent) void openOrders(undefined, 'all'); }); return; }
    if (user && profileLoaded && account.isProfileComplete() && checkoutIntent) { checkoutIntent = false; storage.remove('anurag-checkout-intent'); account.close(); openCart(); void showCheckout(); }
  }
  cart = normalizeCart(storage.read(CART_PREFIX + cartOwner), 100, 100);
  if (account?.getUser()) { cart = normalizeCart([...cart, ...storage.read(CART_PREFIX + 'guest')], 100, 100); storage.remove(CART_PREFIX + 'guest'); }
  persistCart();
  account?.onChange(handleAccountChange);
  checkoutIntent = storage.read('anurag-checkout-intent') === true;
  cartButton?.addEventListener('click', openCart); historyButton?.addEventListener('click', () => void openOrders());
  if (historyButton) historyButton.disabled = false;
  ui.shoppingClose.addEventListener('click', () => { if (!submitting) cartDialog.close(); });
  cartDialog.addEventListener('cancel', event => { if (submitting) event.preventDefault(); });
  cartDialog.addEventListener('close', () => { invalidateQuote(); ++locationRevision; });
  ui.shoppingContinue.addEventListener('click', () => void showCheckout());
  ui.shoppingBack.addEventListener('click', () => { invalidateQuote(); message(); setStep('cart'); renderCart(); });
  form.addEventListener('input', () => { const reviewed = Boolean(quote); invalidateQuote(); if (reviewed) { renderReviewItems(); message('Your details changed. Review the order again to confirm the total and slot.'); } });
  form.addEventListener('submit', event => void reviewOrder(event));
  ui.shoppingPlace.addEventListener('click', () => void placeOrder());
  ui.shoppingUseLocation.addEventListener('click', () => {
    if (!navigator.geolocation) { message('Location is not available in this browser. Please use the map or enter coordinates.', true); return; }
    ui.shoppingUseLocation.disabled = true;
    const owner = account.getUser()?.id, request = ++locationRevision;
    navigator.geolocation.getCurrentPosition(position => { if (owner !== account.getUser()?.id || request !== locationRevision) return; if (!submitting) placePin(position.coords.latitude, position.coords.longitude); ui.shoppingUseLocation.disabled = submitting; }, () => { if (owner !== account.getUser()?.id || request !== locationRevision) return; message('Your location could not be obtained. Please pin it on the map or enter coordinates.', true); ui.shoppingUseLocation.disabled = submitting; }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
  for (const name of ['latitude', 'longitude']) field(name).addEventListener('change', () => { const lat = Number(field('latitude').value), lng = Number(field('longitude').value); if (field('latitude').value && field('longitude').value && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) placePin(lat, lng); });
  ui.customerOrdersClose.addEventListener('click', () => ordersDialog.close());
  ordersDialog.addEventListener('close', () => { ++historyRevision; clearOrderDetails(); ui.customerOrdersList.replaceChildren(); });
  for (const element of [ui.customerOrderFilter, ui.customerOrderStatus]) element.addEventListener('change', () => { historyPage = 1; void loadOrders(); });
  ui.customerOrdersRefresh.addEventListener('click', () => { historyPage = 1; void loadOrders(); });
  ui.customerOrderSearch.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); historyPage = 1; void loadOrders(); } });
  ui.customerOrdersPrevious.addEventListener('click', () => { if (historyPage > 1) { historyPage--; void loadOrders(); } });
  ui.customerOrdersNext.addEventListener('click', () => { if (historyPage * 10 < historyTotal) { historyPage++; void loadOrders(); } });
  await refreshSettings();
  if (ordersIntent) { checkoutIntent = false; storage.remove('anurag-checkout-intent'); void openOrders(undefined, 'all'); }
  else if (checkoutIntent && account?.isProfileComplete() && settings.allow_orders) { checkoutIntent = false; storage.remove('anurag-checkout-intent'); account.close(); openCart(); void showCheckout(); }
  const settingsPoll = setInterval(() => { if (!document.hidden) void refreshSettings(); }, 60000);
  window.addEventListener('pagehide', () => clearInterval(settingsPoll), { once: true });
  return { renderProductActions, refreshSettings, getSettings: () => ({ ...settings }), openCart, openOrders };
}
