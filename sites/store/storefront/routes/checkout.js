'use strict';
// Cart (/checkout/cart/) and checkout (/checkout/ -> /checkout/payment/ -> place order ->
// /checkout/onepage/success/). Placing an order writes orders, order_items, order_addresses,
// order_payments, order_status_history and stock reservations, like Magento.
const S = require('../../shared');
const C = require('../lib/catalog');
const cart = require('../lib/cart');
const { helpers: H } = require('./customer');
const { safeBack } = require('./catalog');

// checkout widget slot (../../widgets.js): fields in a same-site or cross-site frame
const ADDRESS_FIELDS = ['firstname', 'lastname', 'company', 'telephone', 'street[0]', 'street[1]', 'street[2]', 'city', 'region_id', 'region', 'postcode', 'country_id'];
function frameOf(req, kit, name, query) {
  const cf = kit.widget('checkout');
  if (!cf) return null;
  const origin = cf === 'frame-cross' ? req.originFor('pay') : req.originFor(null);
  const path = `/checkout/frame/${name}/?${new URLSearchParams(query).toString()}`;
  return { origin, src: cf === 'frame-cross' ? origin + path : path };
}

// Parse the add-to-cart form: super_attribute[code]=option_id, options[id]=value_id|text, options[id][]=...
function parseOptions(db, product, body) {
  const errors = [];
  const opts = {};
  if (product.type === 'configurable') {
    const axes = db.prepare('SELECT a.attribute_code AS code, coalesce(a.label, at.label) AS label, at.typed_column FROM product_variant_axes a LEFT JOIN attributes at ON at.code = a.attribute_code WHERE a.product_id = ? ORDER BY a.position').all(product.id);
    const sel = {};
    for (const [k, v] of Object.entries(body)) { const m = /^super_attribute\[([\w]+)\]$/.exec(k); if (m) sel[m[1]] = +v; }
    if (body.super_attribute && typeof body.super_attribute === 'object') Object.assign(sel, Object.fromEntries(Object.entries(body.super_attribute).map(([k, v]) => [k, +v])));
    for (const a of axes) if (!sel[a.code]) errors.push(`${a.label} is a required field.`);
    if (!errors.length) {
      const kids = db.prepare('SELECT c.* FROM product_variants v JOIN products c ON c.id = v.child_id WHERE v.parent_id = ? AND c.status = 1').all(product.id);
      const child = kids.find((k) => axes.every((a) => k[`${a.typed_column || a.code}_option_id`] === sel[a.code]));
      if (!child) errors.push('The requested product options are not available.');
      else {
        if (!child.is_in_stock) errors.push('This product is out of stock.');
        opts.child_id = child.id; opts.child_sku = child.sku; opts.simple_name = child.name;
        opts.super_attribute = sel;
        opts.attributes_info = axes.map((a) => ({ label: a.label, value: db.prepare('SELECT label FROM attribute_options WHERE id = ?').pluck().get(sel[a.code]), option_id: a.code, option_value: String(sel[a.code]) }));
      }
    }
  }
  const pos = db.prepare('SELECT * FROM product_options WHERE product_id = ? ORDER BY position, id').all(product.id);
  if (pos.length) {
    const given = {};
    for (const [k, v] of Object.entries(body)) { const m = /^options\[(\d+)\](\[\])?$/.exec(k); if (m) given[m[1]] = v; }
    if (body.options && typeof body.options === 'object') Object.assign(given, body.options);
    const chosen = [];
    for (const o of pos) {
      let v = given[o.id];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) { if (o.is_require) errors.push(`${o.title} is a required option.`); continue; }
      if (['drop_down', 'radio', 'checkbox', 'multiple'].includes(o.type)) {
        const ids = [].concat(v).map(Number);
        const vals = db.prepare('SELECT * FROM product_option_values WHERE option_id = ? AND id IN (SELECT value FROM json_each(?))').all(o.id, JSON.stringify(ids));
        if (!vals.length) { errors.push(`${o.title}: please select a valid option.`); continue; }
        chosen.push({ label: o.title, value: vals.map((x) => x.title).join(', '), print_value: vals.map((x) => x.title).join(', '), option_id: String(o.id), option_type: o.type, option_value: vals.map((x) => String(x.id)).join(','), price: vals.reduce((s, x) => s + Number(x.price || 0), 0) });
      } else {
        v = String(Array.isArray(v) ? v[0] : v).slice(0, o.max_characters || 2000);
        chosen.push({ label: o.title, value: v, print_value: v, option_id: String(o.id), option_type: o.type, option_value: v, price: Number(o.price || 0) });
      }
    }
    if (chosen.length) opts.options = chosen;
  }
  return { opts, errors };
}

module.exports = async function checkoutRoutes(app, kit) {
  const db = () => kit.db();
  const group = (req) => (req.user ? req.user.group_id ?? 1 : 0);

  // ---------------------------------------------------------------- cart
  const cartPage = async (req, reply) => {
    const c = cart.findCart(req);
    const t = c ? cart.totals(c, { customerGroupId: group(req) }) : null;
    const crossIds = t && t.lines.length ? db().prepare(`SELECT DISTINCT l.linked_product_id FROM product_links l JOIN products x ON x.id = l.linked_product_id WHERE l.product_id IN (SELECT value FROM json_each(?)) AND l.link_type = 'crosssell' AND x.status = 1 LIMIT 4`).pluck().all(JSON.stringify(t.lines.map((l) => l.product_id))) : [];
    return reply.render('checkout/cart', { title: 'Shopping Cart', c, t, cross: C.cards(db(), crossIds), bodyClass: 'checkout-cart-index' });
  };
  app.get('/checkout/cart', cartPage);
  app.get('/checkout/cart/index', cartPage);

  app.post('/checkout/cart/add', async (req, reply) => {
    const b = req.body || {};
    const p = db().prepare('SELECT * FROM products WHERE id = ? AND status = 1').get(+(b.product || 0));
    if (!p) { req.flash('error', 'The product that was requested doesn\'t exist. Verify the product and try again.'); return reply.redirect(safeBack(req, '/checkout/cart/')); }
    const url = C.productUrl(p);
    const qty = Math.max(1, Math.min(10000, parseFloat(b.qty) || 1));
    if (!p.is_in_stock) { req.flash('error', 'Product that you are trying to add is not available.'); return reply.redirect(url); }
    if (p.type === 'grouped' || p.type === 'bundle') { req.flash('error', 'Please specify product option(s): add the items of this set from their own pages.'); return reply.redirect(url); }
    const { opts, errors } = parseOptions(db(), p, b);
    if (errors.length) { for (const e of errors) req.flash('error', e); return reply.redirect(url); }
    if (p.type === 'configurable' && !opts.child_id) { req.flash('error', 'You need to choose options for your item.'); return reply.redirect(url); }
    cart.addItem(req, p, qty, opts);
    req.flash('success', `You added ${S.plainName(p.name)} to your shopping cart.`);
    return reply.redirect(b.return_url && String(b.return_url).startsWith('/') ? String(b.return_url) : '/checkout/cart/');
  });

  app.post('/checkout/cart/updatePost', async (req, reply) => {
    const c = cart.findCart(req);
    if (!c) return reply.redirect('/checkout/cart/');
    const b = req.body || {};
    if (b.update_cart_action === 'empty_cart') {
      db().prepare('DELETE FROM cart_items WHERE cart_id = ?').run(c.id);
    } else {
      for (const [k, v] of Object.entries(b)) {
        const m = /^cart\[(\d+)\]\[qty\]$/.exec(k);
        if (!m) continue;
        const q = parseFloat(v);
        if (!Number.isFinite(q) || q < 0) continue;
        if (q === 0) db().prepare('DELETE FROM cart_items WHERE id = ? AND cart_id = ?').run(+m[1], c.id);
        else db().prepare('UPDATE cart_items SET qty = ?, updated_at = ? WHERE id = ? AND cart_id = ?').run(Math.min(q, 10000), kit.nowSql(), +m[1], c.id);
      }
    }
    cart.recalc(c.id);
    return reply.redirect('/checkout/cart/');
  });
  app.post('/checkout/cart/delete', async (req, reply) => {
    const c = cart.findCart(req);
    if (c) { db().prepare('DELETE FROM cart_items WHERE (id = ? OR parent_item_id = ?) AND cart_id = ?').run(+(req.body.id || 0), +(req.body.id || 0), c.id); cart.recalc(c.id); }
    return reply.redirect('/checkout/cart/');
  });
  app.post('/checkout/cart/couponPost', async (req, reply) => {
    const b = req.body || {};
    const c = cart.findCart(req);
    if (!c) return reply.redirect('/checkout/cart/');
    if (b.remove === '1' || b.remove === 1) {
      db().prepare('UPDATE carts SET coupon_code = NULL, updated_at = ? WHERE id = ?').run(kit.nowSql(), c.id);
      req.flash('success', 'You canceled the coupon code.');
      return reply.redirect(safeBack(req, '/checkout/cart/'));
    }
    const code = String(b.coupon_code || '').trim();
    if (!code) { req.flash('error', 'Please enter a discount code.'); return reply.redirect(safeBack(req, '/checkout/cart/')); }
    const exists = db().prepare('SELECT c.*, r.uses_per_customer FROM coupons c JOIN sales_rules r ON r.id = c.rule_id WHERE lower(c.code) = lower(?)').get(code);
    let ok = false;
    if (exists) {
      const t = cart.totals({ ...c, coupon_code: code }, { customerGroupId: group(req) });
      const used = req.user ? db().prepare('SELECT times_used FROM sales_rule_usage WHERE rule_id = ? AND customer_id = ?').pluck().get(exists.rule_id, req.user.id) || 0 : 0;
      const limitOk = (!exists.usage_limit || (exists.times_used || 0) < exists.usage_limit) && (!exists.uses_per_customer || used < exists.uses_per_customer);
      ok = t.couponValid && limitOk;
    }
    if (ok) {
      db().prepare('UPDATE carts SET coupon_code = ?, updated_at = ? WHERE id = ?').run(exists.code, kit.nowSql(), c.id);
      req.flash('success', `You used coupon code "${code}".`);
    } else req.flash('error', `The coupon code "${code}" is not valid.`);
    return reply.redirect(safeBack(req, '/checkout/cart/'));
  });

  // ---------------------------------------------------------------- checkout
  const needCart = (req) => {
    const c = cart.findCart(req);
    if (!c) return null;
    const n = db().prepare('SELECT count(*) FROM cart_items WHERE cart_id = ?').pluck().get(c.id);
    return n ? c : null;
  };
  const state = (req) => req.session.get('checkout') || {};
  const addrOf = (req, st) => {
    if (st.address_id && req.user) return db().prepare('SELECT * FROM customer_addresses WHERE id = ? AND customer_id = ?').get(st.address_id, req.user.id) || null;
    return st.address || null;
  };

  const shippingPage = async (req, reply, extra = {}, status) => {
    const c = needCart(req);
    if (!c) return reply.redirect('/checkout/cart/');
    const st = state(req);
    const saved = req.user ? db().prepare('SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY id').all(req.user.id) : [];
    const selected = st.address_id || (req.user && req.user.default_shipping_id) || (saved[0] && saved[0].id) || null;
    const addr = selected && req.user ? saved.find((a) => a.id === selected) : st.address;
    const t = cart.totals(c, { customerGroupId: group(req), address: addr });
    const methods = cart.shippingOptions(t, addr);
    const countries = db().prepare("SELECT id, name FROM countries WHERE coalesce(name, '') <> '' ORDER BY name").all();
    const regions = db().prepare('SELECT id, country_id, code, name FROM regions ORDER BY country_id, name').all();
    const data = { title: 'Checkout', pageTitle: false, t, saved, selected, methods, method: st.method || 'flatrate_flatrate', a: st.address || { country_id: 'US' }, email: st.email || '', countries, regions, errors: {}, fmtAddr: (x) => H.formatAddress(db(), x), bodyClass: 'checkout-index-index', ...extra };
    if (kit.widget('checkout')) {
      const a = data.a || {}; const street = String(a.street || '').split('\n');
      const vals = Object.fromEntries(ADDRESS_FIELDS.map((k) => { const m = /^street\[(\d)\]$/.exec(k); return [k, String((m ? street[+m[1]] : a[k]) ?? '')]; }));
      if (!vals.country_id) vals.country_id = 'US';
      data.cf = { ...frameOf(req, kit, 'address', vals), fields: Object.entries(vals), name: 'address', title: 'Shipping address' };
    }
    return reply.render('checkout/shipping', data, status);
  };
  app.get('/checkout', shippingPage);
  app.get('/checkout/index', shippingPage);
  app.get('/checkout/onepage', shippingPage);

  app.post('/checkout/shipping', async (req, reply) => {
    const c = needCart(req);
    if (!c) return reply.redirect('/checkout/cart/');
    const b = req.body || {};
    const st = {};
    const errors = {};
    if (!req.user) {
      const email = String(b.email || b.username || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = 'Please enter a valid email address (Ex: johndoe@domain.com).';
      st.email = email;
    }
    const useSaved = req.user && b.address_id && b.address_id !== 'new';
    if (useSaved) {
      const a = db().prepare('SELECT id FROM customer_addresses WHERE id = ? AND customer_id = ?').get(+b.address_id, req.user.id);
      if (!a) errors.address_id = 'Please select a shipping address.';
      else st.address_id = a.id;
    } else {
      const p = H.parseAddress(db(), b);
      Object.assign(errors, p.errors);
      st.address = p.values;
      st.save_address = !!b.save_in_address_book;
    }
    const method = String(b.shipping_method || '');
    if (!cart.SHIPPING_METHODS.some((m) => m.code === method)) errors.shipping_method = 'The shipping method is missing. Select the shipping method and try again.';
    st.method = method;
    if (Object.keys(errors).length) {
      req.session.set('checkout', st);
      return shippingPage(req, reply, { errors, a: st.address || { country_id: 'US' }, email: st.email || '' }, 422);
    }
    req.session.set('checkout', st);
    return reply.redirect('/checkout/payment/');
  });

  app.get('/checkout/payment', async (req, reply) => {
    const c = needCart(req);
    if (!c) return reply.redirect('/checkout/cart/');
    const st = state(req);
    const addr = addrOf(req, st);
    if (!addr || !st.method) return reply.redirect('/checkout/');
    const t = cart.totals(c, { customerGroupId: group(req), address: addr, shippingMethod: st.method });
    const billing = req.user && req.user.default_billing_id ? db().prepare('SELECT * FROM customer_addresses WHERE id = ?').get(req.user.default_billing_id) : null;
    const m = cart.SHIPPING_METHODS.find((x) => x.code === st.method);
    const data = { title: 'Checkout', pageTitle: false, t, c, addr, billing, method: m, email: req.user ? req.user.email : st.email, fmtAddr: (x) => H.formatAddress(db(), x), bodyClass: 'checkout-index-index' };
    if (kit.widget('checkout')) data.cf = { ...frameOf(req, kit, 'payment', { payment_method: 'checkmo' }), fields: [['payment_method', 'checkmo']], name: 'payment', title: 'Payment method' };
    return reply.render('checkout/payment', data);
  });

  // the frames of the checkout widget slot (404 while it is off); stateless: values come in the query
  app.get('/checkout/frame/:name', async (req, reply) => {
    kit.widgets.need('checkout');
    const name = req.params.name;
    if (name !== 'address' && name !== 'payment') throw kit.httpError(404, 'Page not found');
    const q = req.query || {};
    const a = { ...Object.fromEntries(ADDRESS_FIELDS.filter((k) => !k.startsWith('street')).map((k) => [k, q[k] ?? ''])), street: [0, 1, 2].map((i) => q[`street[${i}]`] || '').join('\n').replace(/\n+$/, '') };
    if (a.region_id) a.region_id = +a.region_id;
    if (!a.country_id) a.country_id = 'US';
    const countries = db().prepare("SELECT id, name FROM countries WHERE coalesce(name, '') <> '' ORDER BY name").all();
    const regions = db().prepare('SELECT id, country_id, code, name FROM regions ORDER BY country_id, name').all();
    return reply.render('checkout/frame', { frame: name, a, countries, regions, errors: {}, pm: q.payment_method === 'cashondelivery' ? 'cashondelivery' : 'checkmo', parentOrigin: req.originFor(null) });
  });

  app.post('/checkout/placeOrder', async (req, reply) => {
    const c = needCart(req);
    if (!c) return reply.redirect('/checkout/cart/');
    const st = state(req);
    const addr = addrOf(req, st);
    if (!addr || !st.method) return reply.redirect('/checkout/');
    const b = req.body || {};
    const pm = String(b.payment_method || b['payment[method]'] || 'checkmo');
    if (!PAYMENT[pm]) { req.flash('error', 'The requested Payment Method is not available.'); return reply.redirect('/checkout/payment/'); }
    let billingAddr = addr;
    if (!(b.billing_same === '1' || b.billing_same === 'on' || b.billing_same === undefined) && req.user && req.user.default_billing_id) billingAddr = db().prepare('SELECT * FROM customer_addresses WHERE id = ?').get(req.user.default_billing_id) || addr;
    const order = placeOrder(req, c, { addr, billingAddr, method: st.method, payment: pm, email: req.user ? req.user.email : st.email, comment: b.comment });
    req.session.set('checkout', undefined);
    req.session.set('last_order_id', order.id);
    return reply.redirect('/checkout/onepage/success/');
  });

  app.get('/checkout/onepage/success', async (req, reply) => {
    const id = req.session.get('last_order_id');
    const o = id ? db().prepare('SELECT * FROM orders WHERE id = ?').get(id) : null;
    if (!o) return reply.redirect('/checkout/cart/');
    return reply.render('checkout/success', { title: 'Thank you for your purchase!', o, bodyClass: 'checkout-onepage-success' });
  });

  // ---------------------------------------------------------------- order creation
  const PAYMENT = { checkmo: 'Check / Money order', cashondelivery: 'Cash On Delivery', purchaseorder: 'Purchase Order' };
  function placeOrder(req, c, { addr, billingAddr, method, payment, email, comment }) {
    const d = db();
    const now = kit.nowSql();
    const u = req.user;
    const t = cart.totals(c, { customerGroupId: group(req), address: addr, shippingMethod: method });
    const m = cart.SHIPPING_METHODS.find((x) => x.code === method);
    const max = d.prepare('SELECT max(CAST(increment_id AS INTEGER)) FROM orders').pluck().get() || 0;
    const inc = String(max + 1).padStart(9, '0');
    const qty = t.lines.reduce((s, l) => s + l.qty, 0);
    const weight = t.lines.reduce((s, l) => s + (l.weight || 0) * l.qty, 0);
    const ruleIds = t.applied.map((r) => r.id).join(',') || null;
    const discLabel = t.applied.filter((r) => r.amount > 0).map((r) => r.label).join(', ') || (c.coupon_code || null);
    const r = d.prepare(`INSERT INTO orders (increment_id, state, status, customer_id, customer_email, customer_firstname, customer_lastname, customer_group_id, customer_is_guest, customer_note,
        created_at, updated_at, subtotal, subtotal_incl_tax, discount_amount, discount_description, shipping_amount, shipping_incl_tax, tax_amount, grand_total, total_paid, total_due,
        total_invoiced, total_refunded, total_canceled, total_qty_ordered, total_item_count, weight, shipping_method, shipping_description, payment_method, coupon_code, applied_rule_ids,
        remote_ip, currency, store_name, source)
      VALUES (?, 'new', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, '127.0.0.1', 'USD', ?, 'live')`)
      .run(inc, u ? u.id : null, email, u ? u.firstname : addr.firstname, u ? u.lastname : addr.lastname, u ? u.group_id ?? 1 : 0, u ? 0 : 1, comment ? String(comment).slice(0, 2000) : null,
        now, now, t.subtotal, t.subtotal, t.discount ? -t.discount : 0, discLabel, t.shipping || 0, t.shipping || 0, t.grand_total, t.grand_total,
        qty, t.lines.length, weight, method, m.title, payment, c.coupon_code || null, ruleIds, 'Main Website\nMain Website Store\nDefault Store View');
    const oid = Number(r.lastInsertRowid);
    const insItem = d.prepare(`INSERT INTO order_items (order_id, parent_item_id, product_id, product_type, sku, name, options_json, qty_ordered, qty_invoiced, qty_shipped, qty_refunded, qty_canceled,
        price, base_price, original_price, price_incl_tax, discount_percent, discount_amount, tax_percent, tax_amount, row_total, row_total_incl_tax, amount_refunded, row_invoiced, weight, row_weight, applied_rule_ids, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, 0, ?, 0, 0, ?, ?, 0, 0, ?, ?, ?, ?, ?)`);
    for (const l of t.lines) {
      const o = l.opts || {};
      const info = { info_buyRequest: { product: String(l.product_id), qty: l.qty, ...(o.super_attribute ? { super_attribute: o.super_attribute } : {}), ...(o.options ? { options: Object.fromEntries(o.options.map((x) => [x.option_id, x.option_value])) } : {}) } };
      if (o.options) info.options = o.options.map(({ price, ...x }) => ({ ...x, custom_view: false }));
      if (o.attributes_info) Object.assign(info, { attributes_info: o.attributes_info, simple_name: o.simple_name, simple_sku: o.child_sku, product_calculations: 1, shipment_type: 0 });
      const orig = l.type === 'configurable' ? d.prepare('SELECT price FROM products WHERE id = ?').pluck().get(o.child_id) : l.regular_price;
      const pr = insItem.run(oid, null, l.product_id, l.type, o.child_sku || l.sku, l.name, JSON.stringify(info), l.qty, l.price, l.price, orig ?? l.price, l.price, l.discount || 0, l.row_total, l.row_total, l.weight || 0, (l.weight || 0) * l.qty, ruleIds, now, now);
      if (l.type === 'configurable' && o.child_id) {
        const ch = d.prepare('SELECT * FROM products WHERE id = ?').get(o.child_id);
        insItem.run(oid, Number(pr.lastInsertRowid), ch.id, 'simple', ch.sku, ch.name, JSON.stringify({ info_buyRequest: info.info_buyRequest }), l.qty, 0, 0, ch.price ?? 0, 0, 0, 0, 0, l.weight || 0, (l.weight || 0) * l.qty, null, now, now);
      }
      d.prepare("INSERT INTO stock_reservations (sku, quantity, metadata, source) VALUES (?, ?, ?, 'live')").run(o.child_sku || l.sku, -l.qty, JSON.stringify({ event_type: 'order_placed', object_type: 'order', object_id: String(oid), object_increment_id: inc }));
    }
    const insAddr = d.prepare(`INSERT INTO order_addresses (order_id, address_type, customer_address_id, customer_id, firstname, middlename, lastname, company, street, city, region, region_id, postcode, country_id, telephone, fax, email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const addAddr = (type, a) => Number(insAddr.run(oid, type, a.id && u ? a.id : null, u ? u.id : null, a.firstname, a.middlename || null, a.lastname, a.company || null, a.street, a.city, a.region || H.regionName(d, a) || null, a.region_id || null, a.postcode, a.country_id, a.telephone, a.fax || null, email).lastInsertRowid);
    const shipId = addAddr('shipping', addr);
    const billId = addAddr('billing', billingAddr);
    d.prepare('UPDATE orders SET billing_address_id = ?, shipping_address_id = ? WHERE id = ?').run(billId, shipId, oid);
    d.prepare('INSERT INTO order_payments (order_id, method, amount_ordered, amount_paid, amount_refunded, amount_canceled, shipping_amount, additional_information) VALUES (?, ?, ?, 0, 0, 0, ?, ?)')
      .run(oid, payment, t.grand_total, t.shipping || 0, JSON.stringify({ method_title: PAYMENT[payment] }));
    d.prepare("INSERT INTO order_status_history (order_id, status, comment, is_customer_notified, is_visible_on_front, entity_name, created_at) VALUES (?, 'pending', ?, 1, 0, 'order', ?)").run(oid, comment ? String(comment).slice(0, 2000) : null, now);
    for (const a of t.applied) {
      d.prepare('UPDATE sales_rules SET times_used = coalesce(times_used, 0) + 1 WHERE id = ?').run(a.id);
      if (u) d.prepare('INSERT INTO sales_rule_usage (rule_id, customer_id, times_used) VALUES (?, ?, 1) ON CONFLICT(rule_id, customer_id) DO UPDATE SET times_used = times_used + 1').run(a.id, u.id);
    }
    if (c.coupon_code) d.prepare('UPDATE coupons SET times_used = coalesce(times_used, 0) + 1 WHERE lower(code) = lower(?)').run(c.coupon_code);
    // new address typed at checkout: save to the address book if asked (or if the customer has none)
    if (u && !addr.id && (stSave(req) || !u.default_shipping_id)) {
      const aid = Number(d.prepare('INSERT INTO customer_addresses (customer_id, firstname, middlename, lastname, company, street, city, region, region_id, postcode, country_id, telephone, fax, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
        .run(u.id, addr.firstname, addr.middlename || null, addr.lastname, addr.company || null, addr.street, addr.city, addr.region || null, addr.region_id || null, addr.postcode, addr.country_id, addr.telephone, addr.fax || null, now, now).lastInsertRowid);
      if (!u.default_shipping_id) d.prepare('UPDATE customers SET default_shipping_id = ? WHERE id = ?').run(aid, u.id);
      if (!u.default_billing_id) d.prepare('UPDATE customers SET default_billing_id = ? WHERE id = ?').run(aid, u.id);
    }
    d.prepare('UPDATE carts SET is_active = 0, updated_at = ? WHERE id = ?').run(now, c.id);
    if (!u) req.session.set('cart_id', undefined);
    return { id: oid, increment_id: inc };
  }
  const stSave = (req) => !!(req.session.get('checkout') || {}).save_address;
};
module.exports.parseOptions = parseOptions;
