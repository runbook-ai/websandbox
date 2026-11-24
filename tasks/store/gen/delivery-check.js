#!/usr/bin/env node
'use strict';
// UI check of gen-shopping-delivery-pick (widget slot delivery=dates) in headless Chrome: for a few
// tasks, reset the tenant with the task's scenario, open the category listing sorted by price, read
// the cards' prices and delivery promises page by page, answer with the cheapest item that arrives by
// the date, and grade it; the negative run uses the "Get it by Tomorrow" filter instead (the trap)
// and must fail. Appends the runs to tasks/store/verify-generated.jsonl.
//   node tasks/store/gen/delivery-check.js --site http://127.0.0.1:7999 [--tasks FILE] [--n 3] [--no-log]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const L = require('./lib');
const grader = require(path.join(L.ROOT, 'kit', 'lib', 'grader.js'));
const puppeteer = require(path.join(L.ROOT, 'tasks', 'tools', 'node_modules', 'puppeteer-core'));

const { values: a } = parseArgs({ options: { site: { type: 'string', default: 'http://127.0.0.1:7999' }, tasks: { type: 'string', default: path.join(__dirname, '..', 'generated-shopping.jsonl') },
  n: { type: 'string', default: '3' }, 'no-log': { type: 'boolean' }, chrome: { type: 'string', default: process.env.WSB_CHROME || '/usr/bin/google-chrome' } } });
const ctl = async (p, body) => (await fetch(`${a.site}/__rl${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wsb-tenant': '0' }, body: JSON.stringify(body || {}) })).json();
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function main() {
  const tasks = fs.readFileSync(a.tasks, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((t) => t.template === 'gen-shopping-delivery-pick');
  const picks = tasks.filter((_, i) => i % Math.max(1, Math.floor(tasks.length / +a.n)) === 0).slice(0, +a.n);
  const tmp = fs.mkdtempSync(path.join(process.env.WSB_TMP || os.tmpdir(), 'wsb-store-ui-'));
  const browser = await puppeteer.launch({ executablePath: a.chrome, headless: true, userDataDir: tmp, defaultViewport: { width: 1280, height: 900 }, args: ['--no-first-run'] });
  const out = [];
  try {
    for (const t of picks) {
      for (const neg of [false, true]) {
        const t0 = Date.now();
        await ctl('/reset', { scenario: t.scenario });
        const lg = await ctl('/login', { user: t.login_user });
        const page = await browser.newPage();
        await page.setCookie({ name: lg.cookie.name, value: lg.cookie.value, url: `${a.site}/` });
        const c = L.tree().rows.find((x) => L.catPath(x) === t.instantiation_dict.category);
        const by = new Date(`${t.instantiation_dict.date} UTC`);
        let url = `${a.site}/${c.url_path}.html?product_list_order=price&product_list_dir=asc&product_list_limit=36`;
        if (neg) url += '&delivery=tomorrow';
        await page.goto(url, { waitUntil: 'networkidle0' });
        let hit = null, pages = 0;
        while (!hit) {
          pages++;
          const cards = await page.$$eval('li.product-item', (lis) => lis.map((li) => ({
            name: li.querySelector('.product-item-link').textContent.trim(), price: li.querySelector('.price') && li.querySelector('.price').textContent.trim(),
            when: li.querySelector('.delivery-promise b') && li.querySelector('.delivery-promise b').textContent.trim() })));
          for (const x of cards) {
            if (!x.when) continue;
            const m = /(\w{3}) (\d+)$/.exec(x.when);
            const d = new Date(Date.UTC(by.getUTCFullYear(), MON.indexOf(m[1]), +m[2]));
            if (d <= by) { hit = x; break; }
          }
          if (hit) break;
          const next = await page.$('a.action.next');
          if (!next) break;
          await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), next.click()]);
        }
        const answer = hit ? `${hit.name}, ${hit.price}` : 'none';
        const g = await grader.grade(t, { answer });
        const ok = neg ? g.pass === false : g.pass === true;
        out.push({ task_id: t.task_id, when: new Date().toISOString(), how: `${neg ? 'NEGATIVE: "Get it by Tomorrow" filter, ' : ''}category sorted by price, read ${pages} page(s) of cards (price + delivery date), first that arrives by the date`,
          final_url: page.url().replace(a.site, '__SHOPPING__'), observed: answer, ok, notes: neg ? `negative run must fail: pass=${g.pass}` : g.pass ? 'delivery-check' : JSON.stringify(g.checks).slice(0, 300), seconds: Math.round((Date.now() - t0) / 1000) });
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${t.task_id}${neg ? ' (negative)' : ''} ${answer.slice(0, 90)}`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    await ctl('/reset', {});
  }
  if (!a['no-log']) fs.appendFileSync(path.join(__dirname, '..', 'verify-generated.jsonl'), out.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const bad = out.filter((x) => !x.ok).length;
  console.log(`${out.length - bad}/${out.length} runs as expected`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
