'use strict';
// Storefront delivery promise (widget slot delivery=dates, sites/store/widgets.js): cards show a
// delivery date 1, 2 or 3-7 days out and listings offer a "Get it by Tomorrow" filter. The task asks
// for the cheapest item that arrives within two days: the filter drops the 2-day items, and the
// winner is always one of them; the cheapest item overall arrives later.
const path = require('node:path');

module.exports = [{
  id: 'gen-shopping-delivery-pick', site: 'shopping', kind: 'read', skills: ['navigate', 'filter-sort', 'compare'], difficulty: 3, cap: 80,
  phrasings: [
    'In the store\'s "{{category}}" category, what is the cheapest product that can be delivered by {{date}}? Give only that product\'s name and price.',
    'I need something from {{category}} that arrives no later than {{date}}. Which qualifying product is the cheapest, and what does it cost? Answer with just that product.',
    'Browse {{category}} and find the lowest-priced item with delivery by {{date}}. Name it and give its price, nothing else.',
  ],
  sample(L, r) {
    const W = require(path.join(L.ROOT, 'sites', 'store', 'widgets.js'));
    const days = (id) => W.deliveryDays(id);
    const by = new Date(Date.parse(`${L.TODAY}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
    const t = L.tree();
    const out = [];
    for (const c of t.rows) {
      if (c.level < 3 || !c.is_active) continue;
      const rows = L.all(`SELECT p.id, p.name, p.is_in_stock, ${L.LPRICE('p')} AS price FROM products p WHERE p.id IN (${L.listedSql(c)})`);
      if (rows.length < 12 || rows.length > 600) continue;
      const stock = rows.filter((p) => p.price != null && p.is_in_stock);
      const ok = stock.filter((p) => days(p.id) <= 2).sort((x, y) => x.price - y.price);
      const all = [...stock].sort((x, y) => x.price - y.price);
      const tom = ok.filter((p) => days(p.id) === 1);
      if (ok.length < 2 || ok[0].price === ok[1].price || !tom.length) continue;
      const win = ok[0];
      // the traps bite: the winner is a 2-day item (the "tomorrow" filter hides it) and the cheapest
      // item overall arrives later
      if (days(win.id) !== 2 || days(all[0].id) <= 2 || all[0].price >= win.price) continue;
      // names are long titles: reference the shortest leading words that no other result shares
      const names = rows.map((p) => L.plain(p.name).replace(/\s+/g, ' ').trim().toLowerCase());
      const key = (p) => {
        const w = L.plain(p.name).replace(/\s+/g, ' ').trim().split(' ');
        for (let k = 4; k <= w.length; k++) {
          const pre = w.slice(0, k).join(' ').replace(/[,;:.]+$/, '');
          if (names.filter((n) => n.startsWith(pre.toLowerCase())).length === 1) return pre;
        }
        return null;
      };
      const keys = [win, all[0], tom[0]].map(key);
      if (keys.some((k) => !k)) continue;
      out.push({ slots: { category: L.catPath(c), date: L.longDate(by) }, login_user: r.pick(L.customers()).email, start_url: '__SHOPPING__/',
        scenario: { widgets: { delivery: 'dates' } },
        eval: { type: 'answer', answer: [{ must_include: [keys[0]], must_exclude: [...new Set(keys.slice(1))].filter((k) => k !== keys[0]) },
          { must_include: [L.moneyRef(win.price)], strict_numbers: false }] },
        wrong_answer: `${keys[2]}, $${tom[0].price.toFixed(2)}` });
    }
    return out;
  },
}];
