'use strict';
// Widgets off = unchanged (docs/WIDGETS.md): with no scenario and with an empty one, the storefront
// and back-office pages the widget slots touch render byte-identical (CSRF token aside) to
// widgets-off.snap.json, recorded before the slots existed.  node --test sites/store/test/widgets-off.test.js
// Env: STORE_DATA (default $WSB_DATA_ROOT/store). WSB_SNAPSHOT=record re-records.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const snap = require('../../../kit/test/snapshot');

const DATA = process.env.STORE_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'store');
const CUSTOMER = 'emma.lopez@gmail.com';

test('store pages are unchanged without a scenario', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  await snap.check(t, {
    site: require('../server.js'), data: DATA, file: path.join(__dirname, 'widgets-off.snap.json'),
    plan: async ({ q }) => {
      const reviewed = (await q(`SELECT p.url_key FROM reviews r JOIN products p ON p.id = r.product_id WHERE r.status = 'approved' AND p.visibility = 4 AND p.status = 1
        GROUP BY p.id ORDER BY count(*) DESC, p.id LIMIT 2`)).map((r) => `/${r.url_key}.html`);
      const shop = [
        '/', '/?pbaocw=2', '/catalogsearch/result/?q=usb+wifi', '/catalogsearch/result/?q=usb+wifi&p=2', '/catalogsearch/result/?q=usb+wifi&product_list_mode=list',
        '/catalogsearch/result/index/?product_list_order=price&q=chairs&product_list_dir=asc', '/catalogsearch/result/?q=headphones&product_list_limit=36',
        '/catalogsearch/advanced/result/?name=shirt', '/video-games.html', '/video-games/playstation-4/accessories.html?product_list_order=price&product_list_dir=desc',
        '/clothing-shoes-jewelry/women/shoes.html?price=0-25', '/gear/bags.html', '/gear/bags.html?product_list_mode=list',
        ...reviewed, '/antonia-racer-tank.html', '/joust-duffle-bag.html',
        '/6s-wireless-headphones-over-ear-noise-canceling-hi-fi-bass-foldable-stereo-wireless-kid-headsets-earbuds-with-built-in-mic-micro-sd-tf-fm-for-iphone-samsung-ipad-pc-black-gold.html',
        '/catalog/product_compare/', '/checkout/cart/',
      ];
      const reports = ['/admin/reports/report_sales/bestsellers/?report_from=1/1/22&report_to=12/31/22&report_period=year',
        '/admin/reports/report_sales/sales/?report_from=1/1/22&report_to=12/31/22&report_period=month&filter=1',
        '/admin/reports/report_customer/totals/?report_from=1/1/22&report_to=12/31/22&report_period=year',
        '/admin/reports/report_review/product/', '/admin/reports/report_product/lowstock/'];
      const addr = (await q(`SELECT a.id FROM customer_addresses a JOIN customers c ON c.id = a.customer_id WHERE c.email = '${CUSTOMER}' ORDER BY a.id LIMIT 1`))[0].id;
      return [
        { user: null, pages: [...shop, '/checkout/', '/customer/account/login/'] },
        { user: CUSTOMER, pages: [...shop, '/checkout/', '/checkout/payment/', '/customer/account/', '/customer/address/', '/sales/order/history/',
          '/review/customer/', '/wishlist/'] },
        { user: CUSTOMER, steps: [{ from: '/checkout/', path: '/checkout/shipping/', form: { address_id: String(addr), shipping_method: 'flatrate_flatrate' } }], pages: ['/checkout/payment/', '/checkout/'] },
        { user: 'admin', pages: ['/admin/dashboard/', '/admin/sales/order/', '/admin/sales/order/?q=000000299', '/admin/sales/order/?status=fraud', '/admin/sales/order/?page=2',
          '/admin/sales/order/view/order_id/299/', '/admin/sales/invoice/', '/admin/customer/index/', '/admin/customer/index/?q=2058812302', '/admin/customer/index/?page=3',
          '/admin/catalog/product/', '/admin/catalog/product/?sort=name_asc&page=3', '/admin/catalog/product/?q=hollister', '/admin/catalog/product/edit/id/1481/',
          '/admin/review/product/', '/admin/review/product/pending/', '/admin/review/product/edit/id/347/',
          '/admin/reports/report_sales/bestsellers/', ...reports, '!jobs', ...reports] },
      ];
    },
  });
});
