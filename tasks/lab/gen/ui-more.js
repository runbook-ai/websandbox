'use strict';
// UI solvers for the later lab templates (travel, markets, vendors, task files, part photos), used by
// ui-check.js: (page, task, {neg}) -> {answer?, wrong?, files?, how}. `wrong` is the answer a negative
// read run gives (a trap's value); write and file templates do the wrong thing themselves when neg.
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('../../../kit/lib/grader');
const textimg = require('../../../sites/lab/lib/textimg');

module.exports = function uiMore({ H, sleep, nav, clickLink, bodyText, ROOT, photo, MONTHS }) {
  const longIso = (s) => { const m = /(\w+) (\d+), (\d{4})/.exec(s); return `${m[3]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; };
  const mins12 = (s) => { const m = /(\d+):(\d+) (AM|PM)/.exec(s); return ((+m[1] % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + +m[2]; };
  const csvText = (rows) => rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\n') + '\n';
  const inputText = (t, name) => { const f = t.input_files.find((x) => x.name === name) || t.input_files[0]; return f.text != null ? f.text : fs.readFileSync(path.join(ROOT, f.path), 'utf8'); };
  const fetchText = (page, url) => page.evaluate(async (u) => (await fetch(u)).text(), url);
  const fetchB64 = (page, url) => page.evaluate(async (u) => { const b = new Uint8Array(await (await fetch(u)).arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }, url);

  // ---- travel
  async function pickAirport(page, which, city) {
    await page.click(`#${which}-q`, { clickCount: 3 });
    await page.type(`#${which}-q`, city.slice(0, 4), { delay: 20 });
    await page.waitForFunction((w) => document.querySelectorAll(`#${w}-list li[data-i]`).length > 0, {}, which);
    const ok = await page.evaluate((w, c) => { const li = [...document.querySelectorAll(`#${w}-list li[data-i]`)].find((x) => x.querySelector('b').textContent === c); if (!li) return false; li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; }, which, city);
    if (!ok) throw new Error(`no suggestion ${city}`);
  }
  async function pickDate(page, iso) {
    await page.click('#date-shown');
    const want = `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(0, 4)}`;
    for (let k = 0; k < 8 && (await page.$eval('.cal-title', (e) => e.textContent)) !== want; k++) await page.click('.cal-next');
    await page.click(`.cal-day[data-date="${iso}"]`);
  }
  async function searchFlights(page, d) {
    await pickAirport(page, 'from', d.from); await pickAirport(page, 'to', d.to);
    await pickDate(page, longIso(d.date));
    await page.click('input[name=nonstop]');
    await nav(page, () => page.click('#flight-search button[type=submit]'));
    while (await page.$('#more-flights')) { await page.click('#more-flights'); await sleep(300); }
    const fromPrice = await page.$eval('.from-price strong', (e) => e.textContent.replace('$', ''));
    const rows = await page.$$eval('#flight-list li.flight', (lis) => lis.map((li) => ({ number: li.dataset.number, dep: li.querySelector('.fl-time b').textContent, meta: li.querySelector('.fl-meta').textContent, fare: +li.querySelector('.fl-fare').textContent.replace('$', ''), href: li.querySelector('.fl-book').getAttribute('href') })));
    const ok = rows.filter((f) => /Nonstop/.test(f.meta) && mins12(f.dep) >= mins12(d.after)).sort((a, b) => a.fare - b.fare);
    return { rows, ok, fromPrice };
  }
  async function fileExpense(page, x) {
    await page.goto(`${H}/expenses`, { waitUntil: 'networkidle0' });
    await clickLink(page, 'New claim');
    await page.type('#f-spent_on', `${x.iso.slice(5, 7)}${x.iso.slice(8, 10)}${x.iso.slice(0, 4)}`);
    await page.select('#f-category', x.category);
    await page.type('#f-amount', String(x.amount)); await page.type('#f-merchant', x.merchant); await page.type('#f-description', x.desc);
    await nav(page, () => page.click('#expense-form button'));
  }
  async function register(page, p) {
    for (let attempt = 0; attempt < 6; attempt++) {
      await page.$eval('#f-name', (e) => { e.value = ''; }); await page.type('#f-name', p.name);
      await page.$eval('#f-email', (e) => { e.value = ''; }); await page.type('#f-email', p.email);
      await page.select('#f-team', p.team); await page.select('#f-dietary', p.dietary);
      await nav(page, () => page.click('form[action$="/register"] button'));
      const t = await bodyText(page);
      const m = /Registered .+?\. Confirmation code: (REG-[0-9A-F]{6})/.exec(t);
      if (m) return m[1];
      const w = /Wait (\d+) seconds/.exec(t);
      if (!w) throw new Error(`registration failed: ${t.slice(0, 200)}`);
      await sleep(+w[1] * 1000 + 300);
    }
    throw new Error('rate limited too often');
  }
  // ---- markets
  async function chain(page, sym, expiryLabel) {
    await page.goto(`${H}/markets/${sym}`, { waitUntil: 'networkidle0' });
    await clickLink(page, expiryLabel);
    const all = await page.evaluate(() => [...document.querySelectorAll('a')].some((a) => a.textContent === 'Show all strikes'));
    if (all) await clickLink(page, 'Show all strikes');
    const spot = +(await page.$eval('.spot', (e) => e.textContent));
    const rows = await page.$$eval('table.chain tbody tr', (trs) => trs.map((tr) => {
      const c = [...tr.children];
      const side = (o) => ({ contract: c[o].querySelector('a').title, last: +c[o].textContent, bid: +c[o + 1].textContent, ask: +c[o + 2].textContent, oi: +c[o + 4].textContent.replace(/,/g, '') });
      return { strike: +c[6].textContent, call: side(0), put: side(7) };
    }));
    return { spot, rows };
  }
  const short = (s) => { const iso = longIso(s); const d = new Date(`${iso}T00:00:00Z`); return `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
  // ---- vendors: the filtered list, page by page (UI), optionally opening every vendor page
  async function vendorList(page, f, { details = false } = {}) {
    if (f.category) await page.select('select[name=category]', f.category);
    if (f.status) await page.select('select[name=status]', f.status);
    if (f.region) await page.select('select[name=region]', f.region);
    await nav(page, () => page.click('form[role=search] button'));
    const out = [];
    for (;;) {
      out.push(...await page.$$eval('table.grid tbody tr', (trs) => trs.map((tr) => ({ id: tr.children[0].textContent.trim(), name: tr.children[1].textContent.trim() }))));
      const next = await page.$('a[rel="next"]');
      if (!next) break;
      await nav(page, () => next.click());
    }
    if (details) {
      for (const v of out) {
        const html = await fetchText(page, `/vendors/${v.id}`);
        const dd = (label) => new RegExp(`<dt>${label}</dt><dd>([^<]*)</dd>`).exec(html)[1];
        v.email = dd('Contact email'); v.end = dd('Contract ends'); v.spend = +dd('Annual spend').replace(/[$,]/g, '');
      }
    }
    return out;
  }
  const policyRates = (text, appendix) => {
    const sec = text.split(/^## /m).find((x) => x.startsWith(`Appendix ${appendix}.`));
    return Object.fromEntries(sec.split('\n').filter((l) => /^\| [A-Z]/.test(l) && !/^\| City/.test(l)).map((l) => { const c = l.split('|').map((x) => x.trim()); return [c[1], { meal: +c[2], hotel: +c[3] }]; }));
  };
  const familyPhotos = async (page, family) => {
    const fam = family[0].toUpperCase() + family.slice(1);
    await clickLink(page, fam);
    const cards = await page.$$eval('.part-card', (cs) => cs.map((c) => ({ sku: c.querySelector('.muted').textContent.split(' ')[0], src: c.querySelector('img').getAttribute('src') })));
    for (const c of cards) c.seen = photo.analyze(Buffer.from(await fetchB64(page, c.src), 'base64'));
    return cards;
  };

  // the trends chart of a team, read from its pixels
  const trendChart = async (page, team) => {
    await page.goto(`${H}/reports`, { waitUntil: 'networkidle0' });
    await clickLink(page, 'Trends: monthly sessions per team');
    if ((await page.$eval('select[name=team]', (e) => e.value)) !== team) await nav(page, () => page.select('select[name=team]', team));
    const src = await page.$eval('figure.trend img', (i) => i.getAttribute('src'));
    return textimg.readChartBlind(Buffer.from(await fetchB64(page, src), 'base64'));
  };
  // a receipt input file, read from its pixels: merchant, date, subtotal and total
  const receiptFacts = (t, name) => {
    const f = t.input_files.find((x) => x.name === name);
    const r = textimg.readReceiptBlind(fs.readFileSync(path.join(ROOT, f.path)));
    const amt = (l) => l.trim().split(/\s+/).pop().replace('$', '');
    const items = r.lines.filter((l) => /\$\d/.test(l) && !/^(TAX|TOTAL)/.test(l)).map((l) => +amt(l));
    const titled = r.merchant.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    return { merchant: titled, date: /DATE (\d{4}-\d{2}-\d{2})/.exec(r.lines[0])[1], total: amt(r.lines.find((l) => l.startsWith('TOTAL'))),
      subtotal: items.reduce((s, v) => s + v, 0).toFixed(2) };
  };

  return {
    async 'flight-cheapest'(page, t) {
      const d = t.instantiation_dict;
      const s = await searchFlights(page, d);
      const w = s.ok[0];
      return { answer: `${w.number}, $${w.fare}`, wrong: `${s.rows[0].number}, $${s.fromPrice}`, how: `autocomplete + calendar + nonstop, ${s.rows.length} flights after "show more"; negative: the first result and the "from" price` };
    },
    async 'flight-book'(page, t, { neg } = {}) {
      const d = t.instantiation_dict;
      const s = await searchFlights(page, d);
      const book = async (f) => {
        await page.goto(H + f.href, { waitUntil: 'networkidle0' });
        await page.$eval('#f-traveler', (e) => { e.value = ''; }); await page.type('#f-traveler', d.traveler);
        await page.select('#f-cost_center', d.cc);
        await nav(page, () => page.click('#book-form button'));
      };
      await book(neg ? s.ok[1] : s.ok[0]);
      return { how: neg ? 'booked the second-cheapest nonstop' : `booked ${s.ok[0].number}` };
    },
    async 'option-strike'(page, t) {
      const d = t.instantiation_dict;
      const c = await chain(page, d.sym, short(d.expiry));
      const target = c.spot * (1 + d.pct / 100);
      const r = [...c.rows].sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target));
      return { answer: `${r[0].call.contract}, ask ${r[0].call.ask.toFixed(2)}`, wrong: `${r[1].call.contract}, ask ${r[1].call.ask.toFixed(2)}`, how: `spot ${c.spot}, target ${target.toFixed(2)}, all strikes` };
    },
    async 'option-liquid'(page, t) {
      const d = t.instantiation_dict;
      const exps = await (async () => { await page.goto(`${H}/markets/${d.sym}`, { waitUntil: 'networkidle0' }); return page.$$eval('.tabs.expiries a', (as) => as.map((a) => a.textContent)); })();
      const lo = longIso(d.from), hi = longIso(d.to);
      const got = [];
      for (const e of exps) {
        const iso = longIso(e.replace(/^(\w{3})/, (m) => MONTHS.find((x) => x.startsWith(m))));
        if (iso < lo || iso > hi) continue;
        const c = await chain(page, d.sym, e);
        const row = c.rows.find((x) => x.strike === +d.strike);
        got.push(row[d.kind]);
      }
      got.sort((a, b) => b.oi - a.oi);
      return { answer: `${got[0].contract}, open interest ${got[0].oi}`, wrong: `${got[1].contract}, open interest ${got[1].oi}`, how: `${got.length} expiries compared` };
    },
    async 'option-mid'(page, t) {
      const d = t.instantiation_dict;
      const c = await chain(page, d.sym, short(d.expiry));
      const o = c.rows.find((x) => x.strike === +d.strike)[d.kind];
      return { answer: ((o.bid + o.ask) / 2).toFixed(2), wrong: o.bid.toFixed(2), how: `bid ${o.bid} ask ${o.ask}` };
    },
    async 'vendor-spend'(page, t) {
      const d = t.instantiation_dict;
      const vs = await vendorList(page, d, { details: true });
      const sum = vs.reduce((s, v) => s + Math.round(v.spend * 100), 0) / 100;
      const first = Math.round(vs[0].spend * 100) / 100;
      return { answer: `$${sum.toFixed(2)}`, wrong: `$${(sum - first).toFixed(2)}`, how: `filtered list, opened ${vs.length} vendor pages, summed` };
    },
    async 'vendor-expiring'(page, t) {
      const d = t.instantiation_dict;
      const vs = await vendorList(page, { category: d.category, status: 'active' }, { details: true });
      const ym = longIso(`${d.month.split(' ')[0]} 1, ${d.month.split(' ')[1]}`).slice(0, 7);
      const ids = vs.filter((v) => v.end.startsWith(ym)).map((v) => v.id);
      return { answer: ids.join(', '), how: `filtered list, opened ${vs.length} vendor pages` };
    },
    async 'vendor-export'(page, t, { neg } = {}) {
      const d = t.instantiation_dict;
      const q = new URLSearchParams({ category: d.category, status: d.status, limit: '100' });
      const rows = [];
      for (let cursor = 0; cursor !== null;) {
        const j = JSON.parse(await fetchText(page, `/api/v2/vendors?${q}&cursor=${cursor}`));
        rows.push(...j.vendors.map((v) => [v.vendor_id, v.name, v.contact_email]));
        cursor = j.nextCursor;
      }
      if (neg) rows.pop();
      return { files: { [d.file]: { text: csvText([['Vendor ID', 'Name', 'Contact email'], ...rows]) } }, how: `vendor API, ${rows.length} rows to ${d.file}${neg ? ' (one dropped)' : ''}` };
    },
    async 'register-csv'(page, t, { neg } = {}) {
      const d = t.instantiation_dict;
      const [head, ...people] = parseCsv(inputText(t, d.file));
      const ix = (k) => head.indexOf(k);
      await clickLink(page, d.event);
      await clickLink(page, 'Register an attendee');
      const out = [];
      for (const p of people) out.push([p[ix('Email')], await register(page, { name: p[ix('Name')], email: p[ix('Email')], team: p[ix('Team')], dietary: p[ix('Dietary')] })]);
      if (neg) out[0][1] = 'REG-000000';
      return { files: { 'registration-codes.csv': { text: csvText([['Email', 'Confirmation code'], ...out]) } }, how: `${people.length} registrations from the attached CSV, codes saved${neg ? ' (one code wrong)' : ''}` };
    },
    async 'statement-claims'(page, t, { neg } = {}) {
      const d = t.instantiation_dict;
      const [, ...rows] = parseCsv(inputText(t, d.file));
      const want = rows.filter((r) => r[1] === d.merchant.toUpperCase() && +r[2] > 0 || (neg && r[1] !== d.merchant.toUpperCase() && r[1].startsWith(d.merchant.toUpperCase().split(' ')[0]) && +r[2] > 0));
      for (const r of want) await fileExpense(page, { iso: r[0], category: d.category, amount: r[2], merchant: d.merchant, desc: d.desc });
      return { how: `${want.length} claims from the statement${neg ? ' (look-alike merchant claimed too)' : ''}` };
    },
    async 'policy-claim'(page, t, { neg } = {}) {
      const d = t.instantiation_dict;
      const rates = policyRates(inputText(t, 'travel-policy-2026.md'), neg ? 'C' : 'A');
      const cost = +d.amount.replace(/[$,]/g, '');
      const amount = Math.min(cost, rates[d.city].meal);
      await fileExpense(page, { iso: longIso(`${d.date}`), category: 'Meals', amount: amount.toFixed(2), merchant: d.merchant, desc: 'Client dinner' });
      return { how: `policy cap ${rates[d.city].meal} (${neg ? '2025 table' : 'appendix A'}), claimed ${amount.toFixed(2)}` };
    },
    async 'policy-lookup'(page, t) {
      const d = t.instantiation_dict;
      const text = inputText(t, 'travel-policy-2026.md');
      return { answer: `$${policyRates(text, 'A')[d.city].hotel} per night`, wrong: `$${policyRates(text, 'C')[d.city].hotel} per night`, how: 'read appendix A of the attached policy; negative: the superseded 2025 table' };
    },
    async 'part-photo-spec'(page, t) {
      const d = t.instantiation_dict;
      const cards = await familyPhotos(page, d.family);
      const hit = cards.filter((c) => c.seen.tag === d.color);
      if (hit.length !== 1) throw new Error(`${hit.length} photos with a ${d.color} tag`);
      await page.goto(`${H}/parts/p/${hit[0].sku}`, { waitUntil: 'networkidle0' });
      const href = await page.$eval('a[download]', (a) => a.getAttribute('href'));
      const spec = parseCsv(await fetchText(page, href));
      const weight = spec.find((r) => r[0] === 'Weight (g)')[1];
      const other = cards.find((c) => c !== hit[0]);
      return { answer: `${hit[0].sku}, ${weight} g`, wrong: `${other.sku}, ${weight} g`, how: `read ${cards.length} photos' pixels (tag colour), spec sheet CSV` };
    },
    async 'part-photo-color'(page, t) {
      const sku = t.instantiation_dict.sku;
      await page.goto(`${H}/parts/p/${sku}`, { waitUntil: 'networkidle0' });
      const src = await page.$eval('.part-detail img', (i) => i.getAttribute('src'));
      const seen = photo.analyze(Buffer.from(await fetchB64(page, src), 'base64'));
      const other = Object.keys(photo.COLORS).find((c) => c !== seen.tag);
      return { answer: seen.tag, wrong: other, how: 'part page, read the photo\'s pixels (tag colour)' };
    },
    async 'part-photo-most-holes'(page, t) {
      const cards = await familyPhotos(page, t.instantiation_dict.family);
      const s = [...cards].sort((a, b) => b.seen.holes - a.seen.holes);
      return { answer: s[0].sku, wrong: s[1].sku, how: `counted holes in ${cards.length} photos` };
    },
    async 'chart-peak'(page, t) {
      const pts = await trendChart(page, t.instantiation_dict.team);
      const s = [...pts].sort((a, b) => b[1] - a[1]);
      const lab = (l) => { const [m, y] = l.split(' '); return `${MONTHS.find((x) => x.toUpperCase().startsWith(m))} 20${y}`; };
      return { answer: lab(s[0][0]), wrong: lab(s[1][0]), how: `trends chart, read ${pts.length} bar labels from the pixels` };
    },
    async 'chart-value'(page, t) {
      const d = t.instantiation_dict;
      const pts = await trendChart(page, d.team);
      const [m, y] = d.month.split(' ');
      const hit = pts.find((p) => p[0] === `${m.slice(0, 3).toUpperCase()} ${y.slice(2)}`);
      return { answer: String(hit[1]), wrong: String(hit[1] + 100), how: 'trends chart, read the bar label from the pixels' };
    },
    async 'receipt-claim'(page, t, { neg } = {}) {
      const d = t.instantiation_dict;
      const x = receiptFacts(t, d.file);
      await fileExpense(page, { iso: x.date, category: d.category, amount: neg ? x.subtotal : x.total, merchant: x.merchant, desc: d.desc });
      return { how: `read the receipt image (merchant, date, total), filed the claim${neg ? ' with the subtotal' : ''}` };
    },
    async 'receipt-total'(page, t) {
      const x = receiptFacts(t, t.instantiation_dict.file);
      return { answer: `$${x.total}`, wrong: `$${x.subtotal}`, how: 'read the receipt image\'s TOTAL line' };
    },
    async 'part-photo-holes'(page, t) {
      const d = t.instantiation_dict;
      const cards = await familyPhotos(page, d.family);
      const n = cards.filter((c) => c.seen.holes === +d.n).length;
      return { answer: String(n), wrong: String(n + 1), how: `counted holes in ${cards.length} photos (dark blobs)` };
    },
  };
};
