#!/usr/bin/env node
'use strict';
// Browser check of the lab widgets in headless Chrome (puppeteer-core from tasks/tools), against a
// running lab server. Drives the UI the way a user would (scroll, click, type) and compares with the DB.
//   node sites/lab/tools/browser-check.js --site http://127.0.0.1:7800 [--tenant-port 7801] [--chrome /usr/bin/google-chrome]
// Uses host names lab.wa / labpay.wa mapped to 127.0.0.1 by Chrome's host resolver (no /etc/hosts change).
const path = require('path');
const os = require('os');
const fs = require('fs');
const { parseArgs } = require('util');
const puppeteer = require(path.join(__dirname, '../../../tasks/tools/node_modules/puppeteer-core'));

const { values: a } = parseArgs({ options: { site: { type: 'string', default: 'http://127.0.0.1:7800' }, chrome: { type: 'string', default: process.env.WSB_CHROME || '/usr/bin/google-chrome' }, only: { type: 'string' } } });
const port = new URL(a.site).port;
const H = `http://lab.wa:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = async (p, body) => (await fetch(a.site + '/__rl' + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const q = async (sql) => (await ctl('/query', { sql })).rows;
const one = async (sql) => Object.values((await q(sql))[0] || { x: null })[0];
const results = [];
const check = (name, ok, info) => { results.push({ name, ok: !!ok, info }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info !== undefined ? ' ' + JSON.stringify(info) : ''}`); };

async function main() {
  const tmp = fs.mkdtempSync(path.join(process.env.WSB_TMP || os.tmpdir(), 'wsb-lab-chrome-'));
  const browser = await puppeteer.launch({ executablePath: a.chrome, headless: true, userDataDir: tmp,
    args: ['--no-first-run', `--host-resolver-rules=MAP lab.wa 127.0.0.1, MAP labpay.wa 127.0.0.1`], defaultViewport: { width: 1280, height: 860 } });
  const admin = await one("SELECT username FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const errors = [];
  async function fresh(scenario) {
    await ctl('/reset', { scenario });
    const l = await ctl('/login', { user: admin });
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setCookie({ name: l.cookie.name, value: l.cookie.value, url: H + '/' });
    return page;
  }
  const want = (k) => !a.only || a.only.split(',').includes(k);
  try {
    // ---- long lists: scroll through the whole list in small steps, collect every key ever readable
    if (want('lists')) {
      const qq = await q("SELECT slug, n FROM queues WHERE n BETWEEN 140 AND 200 ORDER BY id LIMIT 1");
      const slug = qq[0].slug, n = qq[0].n;
      for (const kind of ['unmount', 'recycle', 'pinned', 'sections', 'grid']) for (const scroll of kind === 'grid' ? ['page'] : ['container', 'page']) {
        const page = await fresh({ widgets: { queue: kind }, scroll, row_height: 48 });
        await page.goto(`${H}/ops/queues/${slug}`, { waitUntil: 'networkidle0' });
        const seen = new Set();
        let mountedMax = 0;
        for (let step = 0; step < 400; step++) {
          const r = await page.evaluate((pageMode) => {
            const el = document.getElementById('vlist');
            const keys = [...el.querySelectorAll('a.vrow')].filter((x) => x.style.display !== 'none' && !x.classList.contains('loading')).map((x) => x.querySelector('.key').textContent);
            const sc = pageMode ? document.scrollingElement : el;
            const atEnd = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
            sc.scrollTop += Math.round(sc.clientHeight * 0.8);
            return { keys, atEnd, mounted: el.querySelectorAll('a.vrow').length };
          }, scroll === 'page');
          r.keys.forEach((k) => seen.add(k));
          mountedMax = Math.max(mountedMax, r.mounted);
          if (r.atEnd && step > 2) break;
          await sleep(60);
        }
        await sleep(300);
        (await page.evaluate(() => [...document.querySelectorAll('#vlist a.vrow .key')].map((x) => x.textContent))).forEach((k) => k && seen.add(k));
        check(`list ${kind}/${scroll}: every row readable by scrolling`, seen.size === n, { seen: seen.size, n, mountedMax });
        check(`list ${kind}/${scroll}: virtualized (far fewer rows mounted than the list)`, mountedMax < n / 2, { mountedMax });
        await page.close();
      }
    }

    // ---- chat: history loads upward until the beginning; composer kinds post and save drafts
    if (want('chat')) {
      const page = await fresh({});
      await page.goto(`${H}/chat/hiring`, { waitUntil: 'networkidle0' });
      const total = await one("SELECT count(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.name = 'hiring'");
      for (let k = 0; k < 80; k++) {
        const done = await page.evaluate(() => { const s = document.getElementById('chat-scroll'); s.scrollTop = 0; return /very beginning/.test(document.getElementById('chat-top').textContent); });
        if (done) break;
        await sleep(450);
      }
      const inDom = await page.evaluate(() => document.querySelectorAll('#msgs .msg').length);
      check('chat: scrolling up loads the whole history', inDom === total, { inDom, total });
      const days = await page.evaluate(() => { const d = [...document.querySelectorAll('#msgs .day')].map((x) => x.dataset.day); return { n: d.length, uniq: new Set(d).size }; });
      check('chat: one divider per day after prepends', days.n === days.uniq, days);
      await page.close();
      for (const editor of ['textarea', 'contenteditable', 'shadow']) {
        const p = await fresh({ widgets: { editor } });
        await p.goto(`${H}/chat/office`, { waitUntil: 'networkidle0' });
        const target = editor === 'textarea' ? 'textarea' : editor === 'contenteditable' ? '.ce-box' : null;
        if (target) await p.click(`#composer ${target}`);
        else { await p.focus('lab-composer'); await p.evaluate(() => document.querySelector('lab-composer').shadowRoot.querySelector('.ph').click()); }
        await p.keyboard.type(`Draft via ${editor}`);
        await sleep(1300);
        const draft = await one("SELECT body FROM drafts d JOIN channels c ON c.id = d.channel_id WHERE c.name = 'office'");
        check(`editor ${editor}: typing autosaves a draft`, draft === `Draft via ${editor}`, { draft });
        // script-set text without real input does not become the value (controlled editors)
        if (editor !== 'textarea') {
          await p.evaluate((ed) => { const box = ed === 'shadow' ? document.querySelector('lab-composer').shadowRoot.querySelector('.box') : document.querySelector('.ce-box'); box.textContent = 'injected by script'; }, editor);
        }
        await p.keyboard.press('Enter');
        await sleep(500);
        const sent = await q("SELECT body FROM messages WHERE source = 'site'");
        check(`editor ${editor}: Enter sends the typed value`, sent.length === 1 && sent[0].body === `Draft via ${editor}`, sent);
        await p.close();
      }
    }

    // ---- planning doc: grid in a shadow root; the pane detaches when closed
    if (want('doc')) {
      const d = (await q('SELECT id, slug FROM docs ORDER BY id LIMIT 1'))[0];
      const p = await fresh({ pane: 'closed' });
      await p.goto(`${H}/docs/${d.slug}`, { waitUntil: 'networkidle0' });
      const r0 = await p.evaluate(() => ({ trs: document.querySelectorAll('tr').length, shadowRows: document.getElementById('grid-host').shadowRoot.querySelectorAll('tbody tr').length, pane: !!document.querySelector('.doc-pane') }));
      const first = await one(`SELECT count(*) FROM doc_rows WHERE sheet_id = (SELECT id FROM doc_sheets WHERE doc_id = ${d.id} AND pos = 0)`);
      check('doc: sheet rows live only in the shadow root; pane closed = not in the DOM', r0.trs === 0 && r0.shadowRows === first && !r0.pane, r0);
      await p.click('#convtoggle');
      await sleep(400);
      const n = await p.evaluate(() => document.querySelectorAll('.doc-pane table.tracker tbody tr').length);
      check('doc: opening the pane shows the tracker', n === await one(`SELECT count(*) FROM doc_items WHERE doc_id = ${d.id}`), { n });
      await p.click('#convtoggle');
      check('doc: closing the pane removes it', !(await p.evaluate(() => document.querySelector('.doc-pane'))));
      await p.close();
    }

    // ---- account chart drawn from each data source; nothing of it in the page text
    if (want('crm')) {
      for (const src of ['inline', 'api', 'bundle']) {
        const p = await fresh({ data_source: src });
        const acct = (await q('SELECT id, arr FROM accounts ORDER BY id LIMIT 1'))[0];
        await p.goto(`${H}/crm/accounts/${acct.id}`, { waitUntil: 'networkidle0' });
        const r = await p.evaluate(() => {
          const c = document.getElementById('health'); const g = c.getContext('2d');
          const d = g.getImageData(0, 0, c.width, c.height).data; let ink = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] < 120) ink++;
          return { ink, text: document.body.innerText };
        });
        check(`crm ${src}: chart drawn, figures not in page text`, r.ink > 200 && !r.text.includes(acct.arr.toLocaleString('en-US')), { ink: r.ink });
        await p.close();
      }
      const p = await fresh({});
      await p.goto(`${H}/crm/directory`, { waitUntil: 'networkidle0' });
      await p.type('#dir-q', 'Ashcombe'); await p.click('#dir-filter button');
      await sleep(400);
      const rows = await p.evaluate(() => document.querySelectorAll('#dir-rows tr').length);
      check('directory: filter renders a page of rows', rows > 0 && rows <= 25, { rows });
      await p.close();
    }

    // ---- frames: pay by typing into the cross-site frame; read the nested frame
    if (want('frames')) {
      const inv = (await q("SELECT number, verify_ref FROM invoices WHERE status = 'open' ORDER BY id LIMIT 1"))[0];
      const p = await fresh({});
      await p.goto(`${H}/billing/invoices/${inv.number}`, { waitUntil: 'networkidle0' });
      const cdp = await browser.target().createCDPSession();
      const oop = (await cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'iframe').map((t) => new URL(t.url).host);
      check('frames: payment frame and nested verification frame are out of process', oop.includes(`labpay.wa:${port}`) && oop.includes(`lab.wa:${port}`), oop);
      const pay = p.frames().find((f) => f.url().includes('/pay/'));
      const verify = p.frames().find((f) => f.url().includes('/embed/verify/'));
      check('frames: nested frame shows the verification reference', (await verify.evaluate(() => document.body.innerText)).includes(inv.verify_ref));
      await pay.type('input[name=number]', '4000 0566 5566 5556');
      await pay.type('input[name=exp]', '11/28');
      await pay.type('input[name=cvc]', '123');
      await pay.type('input[name=name]', 'Rafe Strand');
      await pay.click('button[type=submit]');
      await sleep(600);
      const st = await p.evaluate(() => document.getElementById('inv-status').textContent);
      const row = (await q('SELECT card_last4, card_exp, name_on_card FROM payments'))[0];
      check('frames: paying in the frame records the payment and updates the page', st === 'Paid' && row && row.card_last4 === '5556' && row.name_on_card === 'Rafe Strand', { st, row });
      await p.close();
    }

    // ---- releases rows navigate on click; job pages reload when done; expense submit is slow
    if (want('flows')) {
      let p = await fresh({ job_seconds: 3 });
      await p.goto(`${H}/releases`, { waitUntil: 'networkidle0' });
      await Promise.all([p.waitForNavigation(), p.click('.rel-row[data-row="2"]')]);
      check('releases: clicking a row opens its detail page', /\/releases\/[a-z0-9]{10}$/.test(p.url()), p.url());
      await p.goto(`${H}/reports`, { waitUntil: 'networkidle0' });
      await p.select('select[name=team]', 'Mobile'); await p.select('select[name=period]', 'Q1 2025');
      await Promise.all([p.waitForNavigation(), p.click('form[action="/reports/run"] button')]);
      const code = await one("SELECT code FROM reports WHERE team = 'Mobile' AND period = 'Q1 2025'");
      check('report: code hidden while running', !(await p.content()).includes(code));
      await p.waitForFunction((c) => document.body.innerText.includes(c), { timeout: 15000 }, code);
      check('report: code appears after the job (page reloads itself)', true);
      await p.goto(`${H}/expenses/new`, { waitUntil: 'networkidle0' });
      await p.type('#f-spent_on', '03112026');
      await p.select('#f-category', 'Travel');
      await p.type('#f-amount', '18.40'); await p.type('#f-merchant', 'Harbor Taxi'); await p.type('#f-description', 'Taxi from the airport');
      const t0 = Date.now();
      await Promise.all([p.waitForNavigation({ timeout: 10000 }), p.click('#expense-form button')]);
      const ms = Date.now() - t0;
      check('expense: submit takes a few seconds, then lands on the list', p.url().endsWith('/expenses') && ms > 2500, { ms });
      check('expense: one claim stored', (await one("SELECT count(*) FROM expenses WHERE source = 'site' AND spent_on = '2026-03-11' AND amount_cents = 1840")) === 1);
      await p.close();
    }
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    await ctl('/reset', {});
  }
  check('no page errors', errors.length === 0, errors.slice(0, 5));
  const bad = results.filter((r) => !r.ok);
  console.log(`${results.length - bad.length}/${results.length} checks passed`);
  process.exit(bad.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
