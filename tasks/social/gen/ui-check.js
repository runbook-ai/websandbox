#!/usr/bin/env node
'use strict';
// UI validation of the social read templates (docs/GENERATOR.md): for every read template, N tasks are
// answered from what headless Chrome renders (pages reached by links, filters and pagination the way
// an agent would: sidebars, profiles, notifications, search) and graded with the social grader, plus
// one negative run per task (a wrong answer) that must fail. Write templates: solve.js (site forms).
//   node tasks/social/gen/ui-check.js [--per 2] [--only name,name] [--out tasks/social/verify-generated.jsonl]
// Starts the site in-process (random port, tenant 0, frozen clock) and its own Chrome (puppeteer-core).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const puppeteer = require(path.join(__dirname, '../../tools/node_modules/puppeteer-core'));
const kit = require('../../../kit');
const grade = require('../../../sites/social/grade');
const L = require('./lib');

const { values: a } = parseArgs({ options: {
  tasks: { type: 'string', default: path.join(__dirname, '..', 'generated.jsonl') }, per: { type: 'string', default: '2' },
  out: { type: 'string', default: path.join(__dirname, '..', 'verify-generated.jsonl') }, only: { type: 'string' },
  chrome: { type: 'string', default: process.env.WSB_CHROME || '/usr/bin/google-chrome' } } });

let H, browser, query;
const ctl = async (p, body) => (await fetch(H + '/__rl' + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-wsb-tenant': '0' }, body: body ? JSON.stringify(body) : undefined })).json();
const go = (page, p) => page.goto(H + p, { waitUntil: 'domcontentloaded' });
const nav = (page, fn) => Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), fn()]);
async function clickText(page, sel, text) {
  const ok = await page.evaluate((s, t) => { const x = [...document.querySelectorAll(s)].find((e) => e.textContent.trim() === t); if (!x) return false; x.setAttribute('data-ui-target', '1'); return true; }, sel, text);
  if (!ok) throw new Error(`no ${sel} "${text}"`);
  await nav(page, () => page.click('[data-ui-target="1"]'));
}
// follow "Next" links until there are none, collecting fn(page) per page
async function eachPage(page, fn, max = 40) {
  const out = [];
  for (let k = 0; k < max; k++) {
    out.push(...await fn(page));
    const next = await page.evaluate(() => { const x = [...document.querySelectorAll('.pager a')].find((e) => /Next|Older/.test(e.textContent)); if (!x) return null; x.setAttribute('data-next', '1'); return true; });
    if (!next) break;
    await nav(page, () => page.click('a[data-next="1"]'));
  }
  return out;
}
const sidebarRules = (page) => page.$$eval('.rules-card li.rule', (ls) => ls.map((l) => ({ n: +l.querySelector('.rule-n').textContent, title: l.querySelector('.rule-title').textContent.trim(), text: l.textContent })));
const profileStats = (page) => page.$$eval('.profile-card .about-stats div', (ds) => Object.fromEntries(ds.map((d) => [d.querySelector('dt').textContent.trim(), d.querySelector('dd').textContent.trim()])));
const cards = (page) => page.$$eval('post-card', (cs) => cs.map((c) => ({ id: +c.getAttribute('post-id'), title: c.querySelector('.card-title-link').textContent.trim(), space: (c.querySelector('.space-link') || {}).textContent, text: c.textContent })));

// ---- solvers: (page, task) -> answer text (read from the rendered pages)
const S = {
  async 'link-blocking-rule'(page, t) {
    await go(page, `/c/${t.instantiation_dict.space}`);
    return String((await sidebarRules(page)).find((r) => /no link posts|links are not allowed|no urls/i.test(r.text)).n);
  },
  async 'can-post-where'(page, t) {
    await go(page, `/u/${t.login_user}`);
    const st = await profileStats(page);
    const karma = +st['Post karma'] + +st['Comment karma'];
    const cake = Date.parse(st['Cake day'] + ' UTC');
    const now = Date.parse((await ctl('/clock')).now);
    const ok = [];
    for (const k of ['a', 'b', 'c', 'd']) {
      const sp = t.instantiation_dict[k];
      await go(page, `/c/${sp}`);
      let allowed = true;
      for (const r of await sidebarRules(page)) {
        let m;
        if ((m = /Minimum (\d+) karma/.exec(r.title)) && karma < +m[1]) allowed = false;
        if ((m = /must be (\d+) days old/.exec(r.title)) && (now - cake) / 86400000 < +m[1]) allowed = false;
      }
      if (allowed) ok.push(sp);
    }
    return ok.join(', ');
  },
  async 'release-version'(page, t) {
    const p = t.instantiation_dict.project;
    await go(page, `/search?q=${encodeURIComponent(p)}`);
    const text = (await cards(page)).map((c) => c.text).join('\n');
    const m = new RegExp(`${p}\\s+v?(\\d+(?:\\.\\d+)+)`, 'i').exec(text);
    if (!m) throw new Error('no version in the search results');
    return m[1];
  },
  async 'replied-to-me-recent'(page, t) {
    const now = Date.parse((await ctl('/clock')).now);
    await go(page, '/notifications');
    const rows = await eachPage(page, (pg) => pg.$$eval('notification-item', (ns) => ns.map((n) => ({ text: n.querySelector('.notif-text').textContent, at: n.querySelector('time').getAttribute('datetime') }))), 6);
    const users = new Set();
    for (const r of rows) {
      const m = /^u\/(\S+) replied to you/.exec(r.text);
      if (m && now - Date.parse(r.at) < t.instantiation_dict.n * 86400000) users.add(m[1]);
    }
    return [...users].join(', ');
  },
  async 'oldest-comment-phrase'(page, t) {
    await go(page, `/search?q=${encodeURIComponent(`"${t.instantiation_dict.q}"`)}&type=comments&sort=new`);
    const rows = await eachPage(page, (pg) => pg.$$eval('comment-preview', (cs) => cs.map((c) => ({ space: c.querySelector('.cp-context a').textContent.replace(/^c\//, ''), user: c.querySelector('.cp-meta a').textContent.replace(/^u\//, ''), at: c.querySelector('time').getAttribute('datetime') }))));
    rows.sort((x, y) => (x.at < y.at ? -1 : 1));
    return `${rows[0].user} in c/${rows[0].space}`;
  },
  async 'top-space-of-user'(page, t) {
    await go(page, `/u/${t.instantiation_dict.user}/posts`);
    const cs = await eachPage(page, cards);
    const n = {};
    for (const c of cs) n[c.space.trim()] = (n[c.space.trim()] || 0) + 1;
    return Object.entries(n).sort((x, y) => y[1] - x[1])[0][0];
  },
  async 'karma-total'(page, t) {
    await go(page, `/u/${t.instantiation_dict.user}`);
    const st = await profileStats(page);
    return String(+st['Post karma'] + +st['Comment karma']);
  },
  async 'karma-gap'(page, t) {
    const k = async (u) => { await go(page, `/u/${u}`); const st = await profileStats(page); return +st['Post karma'] + +st['Comment karma']; };
    return String(await k(t.instantiation_dict.a) - await k(t.instantiation_dict.b));
  },
  async 'moderated-spaces'(page, t) {
    await go(page, `/u/${t.instantiation_dict.user}`);
    return (await page.$$eval('.side-card', (ss) => { const s = ss.find((x) => /Moderator of/.test(x.textContent)); return [...s.querySelectorAll('a')].map((x) => x.textContent.replace(/^c\//, '')); })).join(', ');
  },
  async 'top-flair-post-week'(page, t) {
    const { space, flair, t: win } = t.instantiation_dict;
    await go(page, `/c/${space}`);
    await clickText(page, '.flair-list a.flair', flair);              // the sidebar flair filter
    const u = new URL(page.url()); u.pathname = `/c/${space}/top`; u.searchParams.set('t', win);
    await page.goto(u.href, { waitUntil: 'domcontentloaded' });
    return (await cards(page))[0].title;
  },
  async 'comments-by-user-on-post'(page, t) {
    const { title, space, user } = t.instantiation_dict;
    await go(page, `/c/${space}/search?q=${encodeURIComponent(`"${title}"`)}`);
    await clickText(page, 'a.card-title-link', title);
    return String((await page.$$eval('comment-node', (ns) => ns.map((n) => n.getAttribute('author')))).filter((x) => x === user).length);
  },
  // ---- private messages: the header badge, the inbox list (unread rows), a conversation's messages
  async 'dm-unread-count'(page) {
    await go(page, '/');
    return page.$eval('a.cr-icon-btn[href="/inbox"] .cr-badge', (b) => b.textContent.trim());
  },
  async 'dm-unread-from'(page) {
    await go(page, '/inbox');
    const who = await eachPage(page, (pg) => pg.$$eval('.thread-list li.unread .thread-who', (xs) => xs.map((x) => x.textContent.replace(/^u\//, '').trim())), 10);
    return [...new Set(who)].join(', ');
  },
  async 'dm-meet-when'(page, t) {
    const first = await dmFirst(page, t.instantiation_dict.user);
    const day = DM.DAYS.find((d) => new RegExp(`\\b${d}\\b`).test(first));
    const time = (/\b(\d{1,2}(?::\d\d)?\s?(?:am|pm)|noon)\b/i.exec(first) || [])[1];
    const venue = (/\bThe [A-Z][a-z]+ (?:Taproom|Commons|Library Annex|Coworking|Hall|Cafe|Brewing)\b/.exec(first) || [])[0];
    if (!day || !time || !venue) throw new Error(`no day/time/place in "${first.slice(0, 120)}"`);
    return `${day} at ${time}, ${venue}`;
  },
  async 'dm-borrow-item'(page, t) {
    const first = (await dmFirst(page, t.instantiation_dict.user)).toLowerCase();
    const thing = BORROW.find((x) => first.includes(x));
    if (!thing) throw new Error('nothing to borrow in the first message');
    return thing;
  },
  async 'dm-work-deadline'(page, t) {
    const first = await dmFirst(page, t.instantiation_dict.user);
    const d = ['Thursday 2pm', 'end of day Friday', 'Monday morning', 'next Wednesday', 'Tuesday at noon'].find((x) => first.toLowerCase().includes(x.toLowerCase()));
    if (!d) throw new Error('no deadline in the first message');
    return d;
  },
  async 'dm-thread-length'(page, t) {
    await dmOpen(page, t.instantiation_dict.user);
    return String(await page.$$eval('ol.messages li.msg', (xs) => xs.length));
  },
};
const DM = require('./dm-facts');
const { BORROW } = require('../../../world/sim/dms');
// open the conversation with `user` from the inbox list (following "Older" pages)
async function dmOpen(page, user) {
  await go(page, '/inbox');
  for (let k = 0; k < 10; k++) {
    const ok = await page.evaluate((u) => { const x = [...document.querySelectorAll('.thread-list a.thread-row')].find((a) => a.querySelector('.thread-who').textContent.trim() === `u/${u}`); if (!x) return false; x.setAttribute('data-ui-target', '1'); return true; }, user);
    if (ok) return nav(page, () => page.click('[data-ui-target="1"]'));
    const next = await page.evaluate(() => { const x = [...document.querySelectorAll('.pager a')].find((e) => /Older/.test(e.textContent)); return x ? x.href : null; });
    if (!next) break;
    await page.goto(next, { waitUntil: 'domcontentloaded' });
  }
  throw new Error(`no conversation with u/${user}`);
}
const dmFirst = async (page, user) => { await dmOpen(page, user); return page.$eval('ol.messages li.msg .md', (x) => x.textContent); };
// a wrong answer per template (must fail)
const WRONG = {
  'can-post-where': (t) => ['a', 'b', 'c', 'd'].map((k) => t.instantiation_dict[k]).join(', '),
  'karma-gap': (t, ans) => String(+ans + 1), 'karma-total': (t, ans) => String(+ans + 1), 'link-blocking-rule': (t, ans) => String(+ans + 1),
  'comments-by-user-on-post': (t, ans) => String(+ans + 1), 'release-version': () => '1.0',
  'dm-unread-count': (t, ans) => String(+ans + 1), 'dm-thread-length': (t, ans) => String(+ans + 1), 'dm-borrow-item': () => 'a lawn mower',
  'dm-meet-when': () => 'Friday at 8pm, The Corner Diner', 'dm-work-deadline': () => 'Sunday night',
};

async function main() {
  const site = require('../../../sites/social/server.js');
  const s = await site.start({ tenants: 1, port: 0, data: L.DATA, bind: 'ports', uploads: fs.mkdtempSync(path.join(process.env.WSB_TMP || os.tmpdir(), 'wsb-socialui-')) });
  H = s.url(0).replace(/\/$/, '');
  query = kit.grader.remoteQuery(H, { tenant: 0 });
  const prof = fs.mkdtempSync(path.join(process.env.WSB_TMP || os.tmpdir(), 'wsb-socialui-chrome-'));
  browser = await puppeteer.launch({ executablePath: a.chrome, headless: true, userDataDir: prof, args: ['--no-first-run', '--no-default-browser-check'] });
  const only = a.only ? new Set(a.only.split(',')) : null;
  const tasks = fs.readFileSync(a.tasks, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((t) => t.kind === 'read');
  const seen = new Map();
  const out = [];
  let ok = 0, bad = 0;
  for (const t of tasks) {
    const name = t.template.replace(/^gen-social-/, '');
    if ((seen.get(name) || 0) >= +a.per || !S[name] || (only && !only.has(name))) continue;
    seen.set(name, (seen.get(name) || 0) + 1);
    await ctl('/reset', { frozen: true });
    const l = await ctl('/login', { user: t.login_user });
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setCookie({ name: l.cookie.name, value: l.cookie.value, url: H + '/' });
    let rec;
    try {
      const ans = await S[name](page, t);
      const g = await grade(t, { answer: ans, query, url: page.url() });
      const wrong = (WRONG[name] || (() => 'none of them'))(t, ans);
      const n = await grade(t, { answer: wrong, query });
      rec = { task_id: t.task_id, when: new Date().toISOString(), how: 'headless Chrome: pages read as rendered (ui-check.js)', final_url: page.url().replace(H, '__SOCIAL__'), observed: ans, ok: g.pass === true, negative: { answer: wrong, pass: n.pass }, notes: g.pass === true ? '' : JSON.stringify(g.checks).slice(0, 300) };
      if (g.pass === true && n.pass === false) ok++; else { bad++; console.log('BAD', t.task_id, JSON.stringify(rec).slice(0, 500)); }
    } catch (e) { bad++; rec = { task_id: t.task_id, when: new Date().toISOString(), ok: false, notes: e.message }; console.log('ERROR', t.task_id, e.message); }
    out.push(rec);
    await page.close();
  }
  await browser.close();
  await s.close();
  fs.rmSync(prof, { recursive: true, force: true });
  fs.writeFileSync(a.out, out.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(`ui-check: ${ok} ok, ${bad} bad (${out.length} tasks, ${seen.size} templates) -> ${a.out}`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
