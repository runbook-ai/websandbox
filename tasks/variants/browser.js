'use strict';
// Headless Chrome helpers for the widget UI checks (tasks/variants/ui-check.js): read a page the way
// a person would -- scroll a virtual list to its end, scroll a load-older box to its start, read text
// inside shadow roots and frames, type into the controlled editors.
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require(path.join(__dirname, '../tools/node_modules/puppeteer-core'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch({ chrome = process.env.WSB_CHROME || '/usr/bin/google-chrome', hostRules } = {}) {
  const tmp = fs.mkdtempSync(path.join(process.env.WSB_TMP || os.tmpdir(), 'wsb-variants-ui-'));
  const args = ['--no-first-run', '--password-store=basic', '--disable-features=PasswordLeakDetection,PasswordManagerOnboarding'];
  if (hostRules) args.push(`--host-resolver-rules=${hostRules}`);
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: tmp, defaultViewport: { width: 1280, height: 900 }, args });
  const close = async () => { await browser.close(); fs.rmSync(tmp, { recursive: true, force: true }); };
  return { browser, close };
}

// Text of a node including open shadow roots (innerText does not enter them), whitespace-collapsed.
const DEEP_TEXT = `(function deep(n) {
  if (n.nodeType === 3) return n.nodeValue;
  if (n.nodeType !== 1 && n.nodeType !== 11) return '';
  if (n.nodeType === 1 && /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(n.tagName)) return '';
  let s = '';
  if (n.shadowRoot) s += ' ' + deep(n.shadowRoot) + ' ';
  for (const c of n.childNodes) s += deep(c);
  if (n.nodeType === 1 && /^(P|DIV|LI|TR|H\\d|ARTICLE|SECTION|DETAILS|SUMMARY|TD|TH|BR|DT|DD)$/.test(n.tagName)) s = ' ' + s + ' ';
  return s;
})`;
const deepText = (page, sel) => page.evaluate((src, sel) => {
  const f = eval(src);
  const el = sel ? document.querySelector(sel) : document.body;
  return el ? f(el).replace(/\s+/g, ' ').trim() : '';
}, DEEP_TEXT, sel || null);

// Scroll a .wsb-vlist (container or page scroll) to its end and return every item it mounted, in
// list order: [{key, text}] where key = the item's id attribute (itemSel inside each line).
async function readVlist(page, { sel = '.wsb-vlist', itemSel = '[id]', maxSteps = 3000 } = {}) {
  await page.waitForSelector(sel);
  const seen = new Map();
  let stable = 0;
  for (let step = 0; step < maxSteps; step++) {
    const r = await page.evaluate((sel, itemSel, src) => {
      const deep = eval(src);
      const el = document.querySelector(sel);
      const pageMode = el.dataset.scroll === 'page';
      const sc = pageMode ? document.scrollingElement : el;
      const rows = [...el.querySelectorAll('.wsb-vrow')].filter((x) => x.style.display !== 'none' && !x.classList.contains('wsb-loading'));
      const out = [];
      for (const row of rows) {
        const items = [...row.querySelectorAll(itemSel)].filter((x) => { for (let p = x.parentElement; p && p !== row; p = p.parentElement) if (p.matches(itemSel)) return false; return true; });
        items.forEach((it, k) => out.push([+row.dataset.pos, k, it.id || it.getAttribute('data-id') || `#${row.dataset.pos}:${k}`, deep(it).replace(/\s+/g, ' ').trim()]));
      }
      const loading = [...el.querySelectorAll('.wsb-vrow.wsb-loading')].some((x) => x.style.display !== 'none') || /Loading/.test((el.querySelector('.wsb-vstatus') || {}).textContent || '');
      const end = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
      const status = (el.querySelector('.wsb-vstatus') || {}).textContent || '';
      return { out, loading, end, status, total: +el.dataset.total, kind: el.dataset.kind };
    }, sel, itemSel, DEEP_TEXT);
    for (const [pos, k, key, text] of r.out) seen.set(`${String(pos).padStart(7, '0')}:${String(k).padStart(3, '0')}`, { key, text });
    if (r.loading) { await sleep(120); continue; }
    if (r.end) {
      if (r.kind === 'infinite' && r.status) { stable = 0; await page.evaluate(() => window.scrollBy(0, 400)); await sleep(150); continue; }
      if (++stable > 2) break;
    } else stable = 0;
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const sc = el.dataset.scroll === 'page' ? document.scrollingElement : el;
      sc.scrollTop += Math.max(200, Math.round((el.dataset.scroll === 'page' ? window.innerHeight : sc.clientHeight) * 0.8));
    }, sel);
    await sleep(40);
  }
  const keys = [...seen.keys()].sort();
  // an item can be seen in more than one line position only if the list re-flowed; keep first
  const out = []; const have = new Set();
  for (const k of keys) { const v = seen.get(k); if (!have.has(v.key)) { have.add(v.key); out.push(v); } }
  return out;
}

// Scroll a .wsb-older box to its start (loading every older chunk) and return its full text and ids.
async function readOlder(page, { sel = '.wsb-older', itemSel = '[id]', maxSteps = 400 } = {}) {
  await page.waitForSelector(sel);
  for (let step = 0; step < maxSteps; step++) {
    const st = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return { busy: /Loading/.test(el.querySelector('.wsb-older__top').textContent), more: el.dataset.more === '1' && !/beginning|start/i.test(el.querySelector('.wsb-older__top').textContent), top: el.scrollTop };
    }, sel);
    const done = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const t = el.querySelector('.wsb-older__top').textContent;
      return t === (el.dataset.begin || 'This is the beginning.');
    }, sel);
    if (done) break;
    if (st.busy) { await sleep(150); continue; }
    await page.evaluate((sel) => { const el = document.querySelector(sel); el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight); }, sel);
    await sleep(120);
  }
  return page.evaluate((sel, itemSel, src) => {
    const deep = eval(src);
    const el = document.querySelector(sel);
    return [...el.querySelector('.wsb-older__items').querySelectorAll(itemSel)].map((x) => ({ key: x.id, text: deep(x).replace(/\s+/g, ' ').trim() }));
  }, sel, itemSel, DEEP_TEXT);
}

// Type into the controlled editor that replaced textarea[name=name] (or the textarea itself).
async function typeEditor(page, name, text, { form } = {}) {
  const scope = form ? `${form} ` : '';
  const kind = await page.$eval(`${scope}textarea[name="${name}"]`, (t) => t.dataset.wsbEditor || '');
  if (!kind) { await page.type(`${scope}textarea[name="${name}"]`, text); return 'textarea'; }
  if (kind === 'contenteditable') {
    const h = await page.evaluateHandle((s, n) => document.querySelector(`${s}textarea[name="${n}"]`).nextElementSibling, scope, name);
    await h.click();
    await page.keyboard.type(text);
    return kind;
  }
  const host = await page.evaluateHandle((s, n) => document.querySelector(`${s}textarea[name="${n}"]`).nextElementSibling, scope, name);
  await host.click();
  await page.waitForFunction((h) => h.shadowRoot && h.shadowRoot.querySelector('.box') && h.shadowRoot.activeElement, {}, host);
  await page.keyboard.type(text);
  return kind;
}

module.exports = { launch, sleep, deepText, readVlist, readOlder, typeEditor, DEEP_TEXT };
