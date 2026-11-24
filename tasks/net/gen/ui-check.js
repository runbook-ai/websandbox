#!/usr/bin/env node
'use strict';
// UI validation of the network-site read templates (docs/GENERATOR.md): for every read template, N tasks
// are answered from what headless Chrome renders (pages reached by the site's tabs, filters, links and
// pagination the way an agent would) and graded with the site's grader, plus one negative run per task
// (a wrong answer) that must fail. Each task runs at every clock offset of --advance (hours after the
// site clock, scheduled world events fired), so moving windows and new content are covered too.
// Write templates: solve.js (site forms).
//   node tasks/net/gen/ui-check.js --site devblog|micro|makers [--per 3] [--advance 0,6] [--only name,name] [--out FILE]
// Starts the site in-process (random port, tenant 0) and its own Chrome (puppeteer-core).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const puppeteer = require(path.join(__dirname, '../../tools/node_modules/puppeteer-core'));
const kit = require('../../../kit');
const L = require('./lib');

const { values: a } = parseArgs({ options: {
  site: { type: 'string' }, tasks: { type: 'string' }, per: { type: 'string', default: '3' }, advance: { type: 'string', default: '0,6' },
  out: { type: 'string' }, only: { type: 'string' }, chrome: { type: 'string', default: process.env.WSB_CHROME || '/usr/bin/google-chrome' } } });

let H, query;
const ctl = async (p, body) => (await fetch(H + '/__rl' + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-wsb-tenant': '0' }, body: body ? JSON.stringify(body) : undefined })).json();
const go = (page, p) => page.goto(H + p, { waitUntil: 'domcontentloaded' });
const nav = (page, fn) => Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), fn()]);
const now = async () => Date.parse((await ctl('/clock')).now);
async function clickText(page, sel, txt, { exact = true } = {}) {
  const ok = await page.evaluate((s, t, ex) => {
    for (const e of document.querySelectorAll('[data-ui-target]')) e.removeAttribute('data-ui-target');
    const x = [...document.querySelectorAll(s)].find((e) => (ex ? e.textContent.trim() === t : e.textContent.trim().startsWith(t)));
    if (!x) return false; x.setAttribute('data-ui-target', '1'); return true;
  }, sel, txt, exact);
  if (!ok) throw new Error(`no ${sel} "${txt}"`);
  await nav(page, () => page.click('[data-ui-target="1"]'));
}
// follow the page's "more" / "next" link until there is none, collecting fn(page) per page
async function eachPage(page, fn, max = 40) {
  const out = [];
  for (let k = 0; k < max; k++) {
    out.push(...await fn(page));
    const next = await page.evaluate(() => {
      const x = [...document.querySelectorAll('a[data-more], .pager a')].find((e) => /more|Next|Older/i.test(e.textContent));
      if (!x) return null; return x.getAttribute('href');
    });
    if (!next) break;
    await page.goto(new URL(next, page.url()).href, { waitUntil: 'domcontentloaded' });
  }
  return out;
}

// ---------------------------------------------------------------- devblog
const dCards = (page) => page.$$eval('article.card', (cs) => cs.map((c) => ({ id: +c.dataset.article, title: c.querySelector('.card-title a').textContent.trim(), url: c.querySelector('.card-title a').getAttribute('href'),
  author: c.querySelector('.card-author').getAttribute('href').slice(1), tags: [...c.querySelectorAll('.tags a.tag')].map((t) => t.textContent.replace('#', '').trim()) })));
async function dFind(page, title) {
  await go(page, `/search?q=${encodeURIComponent(title)}`);
  await clickText(page, '.card-title a', title);
}
const devblog = {
  async 'top-tag-article'(page, t) {
    const { tag, win } = t.instantiation_dict;
    await go(page, `/t/${tag}`);
    await clickText(page, '.tabs a', 'Top');
    await clickText(page, '.tabs-sub a', win === 'this week' ? 'Week' : 'Month');
    return (await dCards(page))[0].title;
  },
  async 'my-top-article'(page) {
    await go(page, '/dashboard');
    const rows = await page.$$eval('.dash-item', (xs) => xs.map((x) => ({ title: x.querySelector('.dash-title').textContent.trim(), n: +x.querySelector('[title="Reactions"]').textContent.replace(/\D/g, ''), draft: !!x.querySelector('.chip-draft') })));
    return rows.filter((r) => !r.draft).sort((x, y) => y.n - x.n)[0].title;
  },
  async 'my-comments-total'(page) {
    await go(page, '/dashboard');
    return page.$$eval('.stat', (xs) => xs.find((x) => /Total post comments/.test(x.textContent)).querySelector('strong').textContent.trim());
  },
  async 'series-part'(page, t) {
    await dFind(page, t.instantiation_dict.title);
    const s = await page.$eval('.series-box', (b) => ({ parts: b.querySelectorAll('.series-parts li').length, i: [...b.querySelectorAll('.series-parts li')].findIndex((li) => li.classList.contains('on')) + 1 }));
    return `part ${s.i} of ${s.parts}`;
  },
  async 'readinglist-tag-count'(page, t) {
    await go(page, '/readinglist');
    await clickText(page, '.rl-tags a', `#${t.instantiation_dict.tag}`, { exact: false });
    return String((await page.$$('.rl-item')).length);
  },
  async 'top-follower-commenter'(page, t) {
    await dFind(page, t.instantiation_dict.title);
    const who = await page.$$eval('.cm-meta', (ms) => [...new Set(ms.filter((m) => !m.querySelector('.chip-author')).map((m) => m.querySelector('.cm-name').getAttribute('href').slice(1)))]);
    let best = null;
    for (const h of who) {
      await go(page, `/${h}`);
      const n = +(await page.$$eval('.profile-meta span', (xs) => /^(\d+) followers/.exec(xs.find((x) => / followers$/.test(x.textContent.trim())).textContent.trim())[1]));
      if (!best || n > best.n) best = { h, n };
    }
    return best.h;
  },
  async 'followed-tag-most-followers'(page) {
    await go(page, '/dashboard/tags');
    const mine = await page.$$eval('.tag-tile h3 a', (xs) => xs.map((x) => x.textContent.replace('#', '').trim()));
    await go(page, '/tags');
    const all = await page.$$eval('.tag-tile', (xs) => xs.map((x) => ({ name: x.querySelector('h2 a').textContent.replace('#', '').trim(), n: +/(\d+) following/.exec(x.textContent)[1] })));
    return all.filter((x) => mine.includes(x.name)).sort((x, y) => y.n - x.n)[0].name;
  },
  async 'author-tag-count'(page, t) {
    await go(page, `/${t.instantiation_dict.handle}`);
    const cs = await eachPage(page, dCards);
    return String(new Set(cs.filter((c) => c.tags.includes(t.instantiation_dict.tag)).map((c) => c.id)).size);
  },
};

// ---------------------------------------------------------------- micro
// The timeline loads more cells as you scroll and parks far-away cells (empty placeholders): read it the
// way a person does, scrolling down and collecting the cells that are rendered, until the end.
const mCells = (page, scope = 'article.post') => page.$$eval(scope, (cs) => cs.filter((c) => !c.classList.contains('post-ghost') && c.firstElementChild).map((c) => ({
  id: +c.dataset.post, handle: (c.querySelector('.post-handle') || {}).textContent, repost: !!c.querySelector('.post-social'), reply: !!c.querySelector('.post-replying'),
  text: (c.querySelector('.post-text') || {}).textContent || '', at: (c.querySelector('time') || { getAttribute: () => null }).getAttribute('datetime'), url: c.dataset.url,
  kind: ((c.closest('.note-cell') || document.createElement('i')).querySelector('.note-kind') || {}).textContent || '' })));
async function scrollAll(page, fn, key = (x) => x.id, maxSteps = 300) {
  const seen = new Map();
  let still = 0;
  for (let k = 0; k < maxSteps; k++) {
    for (const x of await fn(page)) if (!seen.has(key(x))) seen.set(key(x), x);
    const st = await page.evaluate(() => { window.scrollBy(0, 1200); return { end: window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4, more: !!document.querySelector('[data-timeline] [data-more]') }; });
    await new Promise((res) => setTimeout(res, st.more ? 250 : 60));
    if (st.end && !st.more) { if (++still >= 3) break; } else still = 0;
  }
  for (const x of await fn(page)) if (!seen.has(key(x))) seen.set(key(x), x);
  return [...seen.values()];
}
async function mOpen(page, handle, start) {
  await go(page, `/${handle}`);
  const cs = await scrollAll(page, (p) => mCells(p), (x) => `${x.id}/${x.repost}`);
  const x = cs.find((c) => !c.repost && c.handle === `@${handle}` && c.text.trim().startsWith(start));
  if (!x) throw new Error('post not on the profile');
  await go(page, x.url);
}
const micro = {
  async 'hashtag-count-by'(page, t) {
    const { handle, tag } = t.instantiation_dict;
    await go(page, `/${handle}`);
    const cs = await scrollAll(page, (p) => mCells(p), (x) => `${x.id}/${x.repost}`);
    return String(new Set(cs.filter((c) => !c.repost && !c.reply && new RegExp(`(^|[^\\w&#])#${tag}(?![A-Za-z0-9_])`, 'i').test(c.text)).map((c) => c.id)).size);
  },
  async 'who-liked'(page, t) {
    await mOpen(page, t.instantiation_dict.handle, t.instantiation_dict.start);
    return (await page.$$eval('.likers a', (xs) => xs.map((x) => x.textContent.trim()))).join(', ');
  },
  async 'reposters-of-mine'(page, t) {
    await go(page, '/notifications');
    const ns = await scrollAll(page, (p) => p.$$eval('article.note', (xs) => xs.map((x) => ({ id: x.id, text: x.querySelector('.note-main p').textContent, who: x.querySelector('.note-main p a').getAttribute('href').slice(1), target: (x.querySelector('.note-target') || {}).textContent || '' }))));
    return [...new Set(ns.filter((n) => /reposted your post/.test(n.text) && n.target.trim().startsWith(t.instantiation_dict.start)).map((n) => n.who))].join(', ');
  },
  async 'replies-last-hours'(page, t) {
    const T = await now();
    await go(page, '/notifications/mentions');
    const cs = await scrollAll(page, (p) => mCells(p, '.note-cell article.post'));
    return String(cs.filter((c) => !c.kind && c.reply && T - Date.parse(c.at) < t.instantiation_dict.n * 3600000).length);
  },
  async 'trending-which'(page, t) {
    await go(page, '/explore');
    const tr = await page.$$eval('a.trend strong', (xs) => xs.map((x) => x.textContent.replace('#', '').trim().toLowerCase()));
    return ['a', 'b', 'c'].map((k) => t.instantiation_dict[k]).filter((x) => tr.includes(x.toLowerCase())).join(', ');
  },
  async 'thread-reply-count'(page, t) {
    await mOpen(page, t.instantiation_dict.handle, t.instantiation_dict.start);
    // breadth-first through the conversation: every reply page lists its direct replies
    let n = 0;
    const todo = [page.url()];
    for (let k = 0; k < todo.length && k < 60; k++) {
      if (k) await page.goto(todo[k], { waitUntil: 'domcontentloaded' });
      const rs = await mCells(page, '.replies article.post');
      n += rs.length;
      for (const r of rs) todo.push(H + r.url);
    }
    return String(n);
  },
  // ---- direct messages: the nav badge, the messages list (unread rows), a conversation's bubbles
  async 'dm-unread-count'(page) {
    await go(page, '/home');
    return page.$eval('a.nv[href="/messages"]', (a) => (a.querySelector('.nv-badge') || { textContent: '0' }).textContent.trim());
  },
  async 'dm-unread-from'(page) {
    await go(page, '/messages');
    return (await page.$$eval('a.dm-row.unread .dm-row-main .muted', (xs) => xs.map((x) => x.textContent.split('·')[0].trim()))).join(', ');
  },
  async 'dm-thread-length'(page, t) {
    await xdmOpen(page, t.instantiation_dict.handle);
    return String(await page.$$eval('.dm-msgs .bubble-row', (xs) => xs.length));
  },
  async 'dm-meet-when'(page, t) {
    await xdmOpen(page, t.instantiation_dict.handle);
    const first = await page.$eval('.dm-msgs .bubble-row .bubble', (x) => x.textContent);
    const day = DAYS.find((d) => new RegExp(`\\b${d}\\b`).test(first));
    const time = (/\b(\d{1,2}(?::\d\d)?\s?(?:am|pm)|noon)\b/i.exec(first) || [])[1];
    const venue = (/\bThe [A-Z][a-z]+ (?:Taproom|Commons|Library Annex|Coworking|Hall|Cafe|Brewing)\b/.exec(first) || [])[0];
    if (!day || !time || !venue) throw new Error(`no day/time/place in "${first.slice(0, 120)}"`);
    return `${day} at ${time}, ${venue}`;
  },
};
const { DAYS } = require('../../social/gen/dm-facts');
async function xdmOpen(page, handle) {
  await go(page, '/messages');
  const ok = await page.evaluate((h) => { const x = [...document.querySelectorAll('a.dm-row')].find((a) => a.querySelector('.dm-row-main .muted').textContent.trim().toLowerCase().startsWith(`@${h.toLowerCase()} `)); if (!x) return false; x.setAttribute('data-ui-target', '1'); return true; }, handle);
  if (!ok) throw new Error(`no conversation with @${handle}`);
  await nav(page, () => page.click('[data-ui-target="1"]'));
}

// ---------------------------------------------------------------- makers
const kRows = (page) => page.$$eval('article.row', (rs) => rs.map((r) => ({ id: r.id, title: r.querySelector('.row-title a').textContent.trim(), product: (r.querySelector('.row-product') || { getAttribute: () => null }).getAttribute('href') })));
async function kProduct(page, name) {
  await go(page, `/products?q=${encodeURIComponent(name)}`);
  await clickText(page, '.prod-row strong', name);
  return page.$$eval('.prod-facts div', (ds) => Object.fromEntries(ds.map((d) => [d.querySelector('dt').textContent.trim(), d.querySelector('dd').textContent.trim()])));
}
const money = (s) => Number(String(s).replace(/[^\d]/g, '')) || 0;
const TOPIC_LABEL = { productivity: 'Productivity', marketing: 'Marketing', freelancing: 'Freelancing', 'AI tools': 'AI tools', startups: 'Startups' };
const makers = {
  async 'latest-milestone'(page, t) {
    await kProduct(page, t.instantiation_dict.product);
    return page.$eval('#milestones .timeline li .tl-value', (x) => x.textContent.trim());
  },
  async 'top-mrr-in-group'(page, t) {
    const { group, win } = t.instantiation_dict;
    await go(page, '/groups');
    await clickText(page, 'a', group, { exact: false });
    await clickText(page, '.pills a', 'Top');
    await clickText(page, '.pills-sub a', { 'this week': 'This week', 'this month': 'This month', 'this year': 'This year' }[win]);
    const rows = await eachPage(page, kRows, 20);
    let best = null;
    for (const href of new Set(rows.map((r) => r.product).filter(Boolean))) {
      await go(page, href);
      const name = await page.$eval('.prod-hero h1', (x) => x.textContent.trim());
      const mrr = money(await page.$eval('.prod-facts dd', (x) => x.textContent));
      if (!best || mrr > best.mrr) best = { name, mrr };
    }
    return best.name;
  },
  async 'top-upvoted-post'(page, t) {
    const { scope, win } = t.instantiation_dict;
    const m = /^in the (.+) group$/.exec(scope);
    if (m) { await go(page, '/groups'); await clickText(page, 'a', m[1], { exact: false }); } else await go(page, '/');
    await clickText(page, '.pills a', 'Top');
    await clickText(page, '.pills-sub a', { 'this week': 'This week', 'this month': 'This month', 'this year': 'This year' }[win]);
    return (await kRows(page))[0].title;
  },
  async 'comment-count-user'(page, t) {
    await go(page, `/${t.instantiation_dict.handle}/comments`);
    return String((await eachPage(page, (p) => p.$$eval('.pc', (xs) => xs.map(() => 1)), 20)).length);
  },
  async 'mrr-gap'(page, t) {
    const x = money((await kProduct(page, t.instantiation_dict.a))['Monthly revenue']);
    const y = money((await kProduct(page, t.instantiation_dict.b))['Monthly revenue']);
    return String(x - y);
  },
  async 'post-product-revenue'(page, t) {
    await go(page, `/search?q=${encodeURIComponent(t.instantiation_dict.title)}&type=posts`);
    await clickText(page, '.row-title a', t.instantiation_dict.title);
    await nav(page, () => page.click('a.row-product'));
    return page.$$eval('.prod-facts div', (ds) => ds.find((d) => /Monthly revenue/.test(d.textContent)).querySelector('dd').textContent.trim());
  },
  async 'top-product-topic'(page, t) {
    await go(page, '/products');
    await clickText(page, '.col-left a.side-link', TOPIC_LABEL[t.instantiation_dict.topic], { exact: false });
    const k = ['highest', 'second-highest', 'third-highest'].indexOf(t.instantiation_dict.rank);
    return (await page.$$eval('.prod-row .prod-main strong', (xs) => xs.map((x) => x.textContent.trim())))[k];
  },
};
const UI = { devblog, micro, makers };
// a wrong answer per template (must fail); default: 'none of them'
const bump = (t, ans) => String((+String(ans).replace(/\D/g, '') || 0) + 1);
const WRONG = {
  'my-comments-total': bump, 'readinglist-tag-count': bump, 'author-tag-count': bump, 'hashtag-count-by': bump, 'replies-last-hours': bump, 'thread-reply-count': bump,
  'comment-count-user': bump, 'mrr-gap': bump, 'series-part': () => 'part 1 of 1',
  'trending-which': (t) => ['a', 'b', 'c'].map((k) => t.instantiation_dict[k]).join(', '),
  'dm-unread-count': bump, 'dm-thread-length': bump, 'dm-meet-when': () => 'Friday at 8pm, The Corner Diner',
};

async function main() {
  const site = a.site;
  if (!L.SITES[site]) throw new Error('--site devblog|micro|makers');
  const grade = require(`../../../sites/${site}/grade`);
  const srv = require(`../../../sites/${site}/server.js`);
  const s = await srv.start({ tenants: 1, port: 0, data: L.dataDir(site), bind: 'ports', uploads: fs.mkdtempSync(path.join(process.env.WSB_TMP || os.tmpdir(), `wsb-${site}ui-`)), jobTickMs: 50 });
  H = s.url(0).replace(/\/$/, '');
  query = kit.grader.remoteQuery(H, { tenant: 0 });
  const prof = fs.mkdtempSync(path.join(process.env.WSB_TMP || os.tmpdir(), `wsb-${site}ui-chrome-`));
  const browser = await puppeteer.launch({ executablePath: a.chrome, headless: true, userDataDir: prof, args: ['--no-first-run', '--no-default-browser-check'] });
  const only = a.only ? new Set(a.only.split(',')) : null;
  const tasks = fs.readFileSync(a.tasks || path.join(__dirname, '..', '..', site, 'generated.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((t) => t.kind === 'read');
  const advances = a.advance.split(',').map(Number);
  const seen = new Map();
  const out = [];
  let ok = 0, bad = 0;
  for (const t of tasks) {
    const name = t.template.replace(`gen-${site}-`, '');
    if ((seen.get(name) || 0) >= +a.per || !UI[site][name] || (only && !only.has(name))) continue;
    seen.set(name, (seen.get(name) || 0) + 1);
    for (const adv of advances) {
      await ctl('/reset', { frozen: true });
      if (adv) { await ctl('/clock', { advance: Math.round(adv * 3600) }); await new Promise((res) => setTimeout(res, 800)); }
      const l = await ctl('/login', { user: t.login_user });
      const page = await browser.newPage();
      page.setDefaultTimeout(20000);
      await page.setViewport({ width: 1280, height: 900 });
      await page.setCookie({ name: l.cookie.name, value: l.cookie.value, url: H + '/' });
      let rec;
      try {
        const ans = await UI[site][name](page, t);
        const g = await grade(t, { answer: ans, query, url: page.url() });
        const wrong = (WRONG[name] || (() => 'none of them'))(t, ans);
        const n = await grade(t, { answer: wrong, query });
        rec = { task_id: t.task_id, when: new Date().toISOString(), how: `headless Chrome: pages read as rendered (ui-check.js), clock +${adv} h`, clock_advance_h: adv,
          final_url: page.url().replace(H, L.SITES[site].token), observed: ans, ok: g.pass === true, negative: { answer: wrong, pass: n.pass }, notes: g.pass === true ? '' : JSON.stringify(g.checks).slice(0, 300) };
        if (g.pass === true && n.pass === false) ok++; else { bad++; console.log('BAD', t.task_id, `+${adv}h`, JSON.stringify(rec).slice(0, 500)); }
      } catch (e) { bad++; rec = { task_id: t.task_id, when: new Date().toISOString(), clock_advance_h: adv, ok: false, notes: e.message }; console.log('ERROR', t.task_id, `+${adv}h`, e.message); }
      out.push(rec);
      await page.close();
    }
  }
  await browser.close();
  await s.close();
  fs.rmSync(prof, { recursive: true, force: true });
  const file = a.out || path.join(__dirname, '..', '..', site, 'verify-generated.jsonl');
  fs.writeFileSync(file, out.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const missing = [...new Set(tasks.map((t) => t.template.replace(`gen-${site}-`, '')))].filter((n) => !UI[site][n]);
  console.log(`${site} ui-check: ${ok} ok, ${bad} bad (${out.length} runs, ${seen.size} templates)${missing.length ? `; no UI solver: ${missing.join(', ')}` : ''} -> ${file}`);
  process.exit(bad || missing.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
