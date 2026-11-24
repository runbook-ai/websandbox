'use strict';
// Store widget slots (../widgets.js, docs/WIDGETS.md): every value renders, list chunks hold exactly
// the items of the plain pages, forms post the same fields, the plant is display only.
//   node --test sites/store/test/widgets.test.js   (Env: STORE_DATA, default $WSB_DATA_ROOT/store)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, rl, q, tmpdir } = require('../../../kit/test/helpers');
const SW = require('../widgets');

const DATA = process.env.STORE_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'store');
const CUSTOMER = 'emma.lopez@gmail.com';

test('store widgets', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  const site = require('../server.js');
  const s = await site.start({ tenants: 1, port: 0, data: DATA, bind: 'ports', uploads: tmpdir('wsb-store-w-'), jobTickMs: 50 });
  t.after(() => s.close());
  const A = s.url(0);
  const reset = (widgets) => rl(A, '/reset', widgets ? { scenario: { widgets } } : {});
  const as = async (user) => { const c = new Client(A); if (user) { const l = await rl(A, '/login', { user }); c.jar.set(l.cookie.name, l.cookie.value); } return c; };
  const J = { headers: { accept: 'application/json' } };
  const all = async (c, src) => {
    const url = src.replace(/&amp;/g, '&');
    const first = (await c.get(`${url}${url.includes('?') ? '&' : '?'}offset=0&limit=24`, J)).json();
    let items = first.items;
    while (items.length < first.total) {
      const more = (await c.get(`${url}${url.includes('?') ? '&' : '?'}offset=${items.length}&limit=24`, J)).json().items;
      if (!more.length) break;
      items = items.concat(more);
    }
    return { total: first.total, html: items.join('\n') };
  };
  const srcOf = (html, cls = 'wsb-vlist') => /class="wsb-vlist[^"]*" data-src="([^"]+)"/.exec(html)?.[1] || assert.fail(`no ${cls}`);
  const pids = (html) => [...html.matchAll(/class="price-box price-final_price" data-product-id="(\d+)"/g)].map((m) => +m[1]);
  const reviewed = (await q(A, `SELECT p.url_key FROM reviews r JOIN products p ON p.id = r.product_id WHERE r.status = 'approved' AND p.visibility = 4 AND p.status = 1
    GROUP BY p.id ORDER BY count(*) DESC, p.id LIMIT 1`))[0].url_key;
  const PROD = `/${reviewed}.html`;

  await t.test('reset validates slots and values', async () => {
    for (const w of [{ grid: 'carousel' }, { cards: 'shadow' }, { checkout: 'frame' }, { admin_grid: 'table' }, { plant: 'x' }]) assert.equal((await rl(A, '/reset', { scenario: { widgets: w } })).status, 400, JSON.stringify(w));
    assert.equal((await rl(A, '/reset', { scenario: { widgets: { grid: 'grid', reviews: 'recycle', card: 'shadow', price: 'js', checkout: 'frame-cross', admin_grid: 'shadow', admin_job: 'slow', editor: 'shadow', plant: 'review', delivery: 'dates' } } })).status, 200);
  });

  await t.test('widget-only endpoints are absent while off', async () => {
    await reset();
    const c = await as(CUSTOMER);
    assert.equal((await c.get('/checkout/frame/address/')).status, 404);
    const adm = await as('admin');
    assert.equal((await adm.get('/admin/reports/job/1/')).status, 404);
    assert.match((await c.get('/catalogsearch/result/?q=usb+wifi&_w=items')).text, /<html/);
  });

  await t.test('grid: the window holds the next 240 results in page order; chunk requests are not logged searches', async () => {
    await reset();
    const c = await as(null);
    for (const url of ['/catalogsearch/result/?q=usb+wifi', '/video-games.html?product_list_order=price&product_list_dir=desc', '/gear/bags.html?product_list_mode=list']) {
      await reset();
      const want = [];
      const lim = url.includes('mode=list') ? 30 : 36;
      for (let p = 1; want.length < 240; p++) {
        const got = pids((await c.get(`${url}${url.includes('?') ? '&' : '?'}product_list_limit=${lim}&p=${p}`)).text);
        if (!got.length || (p > 1 && got[0] === want[want.length - got.length])) break;
        want.push(...got);
        if (got.length < lim) break;
      }
      for (const kind of SW.SLOTS.grid) {
        await reset({ grid: kind });
        const before = (await q(A, "SELECT coalesce(sum(popularity), 0) n FROM search_terms"))[0].n;
        const page = (await c.get(url)).text;
        assert.equal(pids(page).length, 0, `${url} ${kind}: no cards in the page`);
        const got = await all(c, srcOf(page));
        assert.deepEqual(pids(got.html), want.slice(0, 240), `${url} ${kind}`);
        const after = (await q(A, "SELECT coalesce(sum(popularity), 0) n FROM search_terms"))[0].n;
        assert.equal(after - before, url.startsWith('/catalogsearch') ? 1 : 0, 'one logged search per page view, none per chunk');
      }
    }
  });

  await t.test('reviews: every list kind serves all reviews, newest first', async () => {
    await reset();
    const c = await as(null);
    const rid = (h) => [...h.matchAll(/id="review-(\d+)"/g)].map((m) => +m[1]);
    const want = [];
    for (let rp = 1; rp <= 10; rp++) { const got = rid((await c.get(`${PROD}?rp=${rp}`)).text); if (!got.length || want.includes(got[0])) break; want.push(...got); }
    assert.ok(want.length > 100);
    for (const kind of SW.SLOTS.reviews) {
      await reset({ reviews: kind });
      const page = (await c.get(PROD)).text;
      assert.equal(rid(page).length, 0);
      assert.doesNotMatch(page, /Review pages/);
      assert.deepEqual(rid((await all(c, srcOf(page))).html), want, kind);
    }
  });

  await t.test('card shadow and price js', async () => {
    await reset({ card: 'shadow' });
    const c = await as(null);
    const grid = (await c.get('/gear/bags.html')).text;
    assert.equal((grid.match(/<div class="wsb-card"><template data-wsb-shadow>/g) || []).length, pids(grid).length);
    const pp = (await c.get('/joust-duffle-bag.html')).text;
    assert.match(pp, /<div class="product-info-price"><template data-wsb-shadow>/);
    assert.match(pp, /\/_kit\/widgets\/shadow\.js/);
    await reset({ price: 'js' });
    const pj = (await c.get('/joust-duffle-bag.html')).text;
    const main = /<div class="product-info-price">([\s\S]*?)<div class="product attribute sku">/.exec(pj)[1];
    assert.doesNotMatch(main.replace(/<script[^>]*>[^<]*<\/script>/g, ''), /\$34\.00|data-price-amount|In stock/);
    assert.match(main, /data-wsb-fill-data>\{"price-1-final":"\$34\.00"\}/);
    assert.match(main, /"stock-1":"In stock"/);
    assert.match(pj, /\/_kit\/widgets\/fill\.js/);
  });

  await t.test('checkout frames: same-site and cross-site; the page form posts the same fields', async () => {
    for (const kind of SW.SLOTS.checkout) {
      await reset({ checkout: kind });
      const c = await as(CUSTOMER);
      const ship = await c.get('/checkout/');
      assert.equal(ship.status, 200);
      const src = /<iframe class="wsb-frame checkout-frame" data-wsb-frame="address" data-origin="([^"]+)" src="([^"]+)"/.exec(ship.text);
      assert.ok(src, kind);
      const port = new URL(A).port;
      if (kind === 'frame-cross') {
        assert.equal(src[1], `http://localhost:${port}`);
        assert.match(ship.headers.get('content-security-policy'), new RegExp(`frame-src 'self' http://localhost:${port}`));
      } else assert.equal(src[1], A);
      const frame = await new Client(src[1]).get(src[2].replace(/&amp;/g, '&').replace(src[1], ''));
      assert.equal(frame.status, 200);
      assert.match(frame.text, new RegExp(`data-wsb-frame-form="address" data-parent-origin="${A}"`));
      assert.match(frame.text, /name="postcode"/);
      // the page form: hidden copies of the frame's fields; post a new address through it
      assert.match(ship.text, /<input type="hidden" name="postcode" value="[^"]*" data-wsb-frame-field="address">/);
      const csrf = /name="csrf-token" content="([^"]+)"/.exec(ship.text)[1];
      const r = await c.post('/checkout/shipping/', { form: { _csrf: csrf, address_id: 'new', firstname: 'Ann', lastname: 'Lee', telephone: '555-0100', 'street[0]': '1 Main St', city: 'Austin', region_id: '57', postcode: '73301', country_id: 'US', shipping_method: 'flatrate_flatrate' } });
      assert.equal(r.status, 302);
      assert.equal(r.location, '/checkout/payment/');
      const pay = await c.get('/checkout/payment/');
      assert.match(pay.text, /data-wsb-frame="payment"/);
      assert.match(pay.text, /<input type="hidden" name="payment_method" value="checkmo" data-wsb-frame-field="payment">/);
      const o = await c.post('/checkout/placeOrder/', { form: { _csrf: csrf, payment_method: 'cashondelivery', billing_same: '1' } });
      assert.equal(o.location, '/checkout/onepage/success/');
      assert.equal((await q(A, "SELECT p.method FROM order_payments p JOIN orders o ON o.id = p.order_id ORDER BY o.id DESC LIMIT 1"))[0].method, 'cashondelivery');
    }
  });

  await t.test('admin grids: list kinds hold the next 500 rows; shadow wraps cell contents', async () => {
    const rows = (h) => [...h.matchAll(/<tr class="data-row" data-id="(\d+)"/g)].map((m) => +m[1]);
    for (const url of ['/admin/sales/order/', '/admin/customer/index/?sort=email_asc', '/admin/catalog/product/?q=shirt']) {
      await reset();
      const adm = await as('admin');
      const want = [];
      for (let p = 1; want.length < 500; p++) { const got = rows((await adm.get(`${url}${url.includes('?') ? '&' : '?'}per_page=200&page=${p}`)).text); want.push(...got); if (got.length < 200) break; }
      for (const kind of ['unmount', 'sections', 'infinite']) {
        await reset({ admin_grid: kind });
        const adm2 = await as('admin');
        const page = (await adm2.get(url)).text;
        assert.equal(rows(page).length, 0);
        assert.deepEqual(rows((await all(adm2, srcOf(page))).html), want.slice(0, 500), `${url} ${kind}`);
      }
    }
    await reset({ admin_grid: 'shadow' });
    const adm3 = await as('admin');
    const sh = (await adm3.get('/admin/sales/order/')).text;
    assert.equal(rows(sh).length, 20);
    assert.match(sh, /<div class="data-grid-cell-content"><template data-wsb-shadow>/);
    // other grids are untouched
    assert.doesNotMatch((await adm3.get('/admin/review/product/')).text, /data-wsb-shadow/);
  });

  await t.test('admin_job slow: a report run waits 10-60 s of site time and the page polls it', async () => {
    await reset({ admin_job: 'slow' });
    const adm = await as('admin');
    const url = '/admin/reports/report_sales/bestsellers/?report_from=1/1/22&report_to=12/31/22&report_period=year';
    const p1 = (await adm.get(url)).text;
    const poll = /id="wsb-job" data-poll="([^"]+)"/.exec(p1)[1];
    assert.match(p1, /\/_kit\/widgets\/jobwait\.js/);
    const j = (await q(A, "SELECT (julianday(run_at) - julianday(created_at)) * 86400 AS s FROM kit_jobs WHERE type = 'admin.report'"))[0];
    assert.ok(j.s >= 9.5 && j.s <= 60.5, `delay ${j.s}`);
    assert.equal((await adm.get(poll, J)).json().status, 'queued');
    await rl(A, '/clock', { advance: 61 });
    assert.equal((await adm.get(poll, J)).json().status, 'done');
    assert.match((await adm.get(url)).text, /records found/);
  });

  await t.test('editor on the review form; reviews still post the same fields', async () => {
    for (const kind of SW.SLOTS.editor) {
      await reset({ editor: kind });
      const c = await as(CUSTOMER);
      const page = (await c.get('/joust-duffle-bag.html')).text;
      assert.match(page, new RegExp(`name="detail" id="review_field"[^>]*data-wsb-editor="${kind}"`));
      const csrf = /name="csrf-token" content="([^"]+)"/.exec(page)[1];
      const rating = /name="ratings\[(\d+)\]"/.exec(page)[1];
      await c.post('/review/product/post/id/1/', { form: { _csrf: csrf, nickname: 'Tess', title: `via ${kind}`, detail: 'Good bag.', [`ratings[${rating}]`]: '5' } });
      assert.equal((await q(A, `SELECT count(*) n FROM reviews WHERE title = 'via ${kind}'`))[0].n, 1);
    }
  });

  await t.test('delivery dates: promises on cards and the product page; "Get it by Tomorrow" keeps 1-day items only', async () => {
    const cat = (await q(A, "SELECT url_path FROM categories WHERE level = 3 AND is_active = 1 AND url_path IS NOT NULL ORDER BY id LIMIT 1"))[0].url_path;
    let c = await as();
    assert.doesNotMatch((await c.get(`/${cat}.html`)).text, /delivery-promise|Get it by Tomorrow/, 'off: unchanged');
    await reset({ delivery: 'dates' });
    c = await as();
    const page = (await c.get(`/${cat}.html?product_list_limit=36`)).text;
    const ids = pids(page);
    assert.ok(/class="delivery-promise"/.test(page));
    assert.match(page, /Get it by Tomorrow/);
    const tom = (await c.get(`/${cat}.html?product_list_limit=36&delivery=tomorrow`)).text;
    const kept = pids(tom);
    assert.ok(kept.length > 0 && kept.every((id) => SW.deliveryDays(id) === 1));
    assert.equal((tom.match(/FREE delivery <b>Tomorrow/g) || []).length, (tom.match(/class="delivery-promise"/g) || []).length);
    assert.ok(ids.some((id) => SW.deliveryDays(id) === 2), 'the listing has 2-day items the filter drops');
    assert.match((await c.get(PROD)).text, /class="delivery-promise"/);
    await reset();
  });

  await t.test('plant: one planted note per product page with reviews, never in the DB', async () => {
    for (const [name, p] of Object.entries(SW.PLANTS)) {
      await reset({ plant: name });
      const c = await as(null);
      assert.equal((await c.get(PROD)).text.split(p.code).length - 1, 1, name);
      await rl(A, '/reset', { scenario: { widgets: { plant: name, reviews: 'unmount' } } });
      const src = srcOf((await c.get(PROD)).text);
      assert.equal((await all(c, src)).html.split(p.code).length - 1, 1);
      assert.equal((await q(A, `SELECT count(*) n FROM reviews WHERE detail LIKE '%${p.code}%'`))[0].n, 0);
    }
  });
  await reset();
});
