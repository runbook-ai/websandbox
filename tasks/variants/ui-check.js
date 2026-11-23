#!/usr/bin/env node
'use strict';
// UI validation of the widget variant tasks (tasks/variants/generated.jsonl) in headless Chrome
// (puppeteer-core from tasks/tools/node_modules):
//   read   for a sample of answer variants per site and slot, the page that holds the answer is read
//          as a person would -- the virtual list scrolled to its end, the load-older box scrolled to
//          its start, text inside shadow roots, values written by script -- once without and once
//          with the variant's scenario: the items must be the same (in order) and the reference
//          answer must be in what the variant shows (or, for counts, the number of items read)
//   write  a few variant write tasks are done through the UI (typing into the controlled editors,
//          filling the checkout frames, same-site and cross-site) and graded with the site grader
//          values written by script (reaction / like counts, revenue) are compared with the plain page's
//   node tasks/variants/ui-check.js --sites forum=http://127.0.0.1:7710,store=...,mail=...,code=...,social=...,devblog=...,micro=...,makers=... [--per 2] [--per-write 2] [--only forum,mail] [--out tasks/variants/verify-ui.jsonl]
// (with --only, the log keeps the other sites' earlier lines and replaces those of the sites checked)
// Tenant 0 of every site is reset per run (and at the end).
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const kit = require('../../kit');
const B = require('./browser');
const { rl } = require('../../kit/test/helpers');

const ROOT = path.join(__dirname, '..', '..');
const { values: a } = parseArgs({ options: { sites: { type: 'string' }, per: { type: 'string', default: '2' }, 'per-write': { type: 'string', default: '2' }, only: { type: 'string' }, tasks: { type: 'string', default: path.join(__dirname, 'generated.jsonl') },
  out: { type: 'string', default: path.join(__dirname, 'verify-ui.jsonl') } } });
const BASES = Object.fromEntries(a.sites.split(',').map((x) => x.split('=')));
const DIR = { forum: 'forum', shopping: 'store', shopping_admin: 'store', gitlab: 'code', mail: 'mail', social: 'social', devblog: 'devblog', micro: 'micro', makers: 'makers' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const graders = {};
const graderOf = (t) => { const d = DIR[t.site]; if (!(d in graders)) { const p = path.join(ROOT, 'sites', d, 'grade.js'); graders[d] = fs.existsSync(p) ? require(p) : kit.grader.grade; } const g = graders[d]; return typeof g === 'function' ? g : g.grade; };
const baseOf = (t) => BASES[DIR[t.site]];
const qOf = (t) => kit.grader.remoteQuery(baseOf(t), { tenant: 0 });
const one = async (t, sql, p = []) => { const r = await qOf(t)(sql, p); return r[0] ? Object.values(r[0])[0] : null; };
const refsOf = (t) => [].concat(t.eval.answer || []).flatMap((s) => [].concat(s.must_include || s.exact || []));
const isNum = (r) => /^[$]?-?[\d,.]+%?$/.test(String(r).split(' |OR| ')[0].trim());

// ---------------------------------------------------------------- locators: task -> page holding the answer
// {path, widget: 'vlist'|'older'|null, itemSel, count?: true (the answer is the number of items)}
async function forumSub(t) {
  const d = t.instantiation_dict;
  const r = (await qOf(t)("SELECT f.name, s.id, s.slug FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.title = ? AND lower(f.name) = lower(?) ORDER BY s.id LIMIT 1", [d.title, d.forum]))[0];
  return `/f/${r.name}/${r.id}/${r.slug}`;
}
async function storeCategory(t, cat) {
  const names = cat.split(' > ');
  const rows = await qOf(t)('SELECT id, parent_id, name, url_path FROM categories WHERE name = ? AND is_active = 1', [names[names.length - 1]]);
  for (const r of rows) {
    let ok = true; let p = r.parent_id;
    for (let i = names.length - 2; i >= 0 && ok; i--) { const x = (await qOf(t)('SELECT id, parent_id, name FROM categories WHERE id = ?', [p]))[0]; if (!x || x.name !== names[i]) ok = false; else p = x.parent_id; }
    if (ok) return `/${r.url_path}.html`;
  }
  throw new Error(`no category ${cat}`);
}
const productUrl = async (t, name) => `/${await one(t, "SELECT url_key FROM products WHERE name = ? AND status = 1 AND visibility IN (2,3,4) ORDER BY visibility DESC, id LIMIT 1", [name])}.html`;
const DATE = (s) => { const d = new Date(`${s} UTC`); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${String(d.getUTCFullYear()).slice(2)}`; };
const monthRange = (m) => { const d = new Date(`1 ${m} UTC`); const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)); return [DATE(d.toUTCString().slice(5, 16)), `${e.getUTCMonth() + 1}/${e.getUTCDate()}/${String(e.getUTCFullYear()).slice(2)}`]; };
async function mailThread(t, where, params) {
  return one(t, `SELECT thread_id FROM messages WHERE owner_id = (SELECT id FROM users WHERE username = ?) AND is_trash = 0 AND ${where} ORDER BY sent_at DESC LIMIT 1`, [t.login_user, ...params]);
}

// the social frontends
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
async function socialPost(t, title, space) {
  const r = (await qOf(t)(`SELECT s.id, f.name, s.slug FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.network_id = 1 AND s.title = ${lit(title)}${space ? ` AND f.normalized_name = lower(${lit(space)})` : ''} AND s.visibility = 'visible' ORDER BY s.id LIMIT 1`))[0];
  return `/c/${r.name}/comments/${r.id}/${r.slug}`;
}
const WIN = { 'this week': 'week', 'this month': 'month', 'this year': 'year', 'all time': 'all' };
async function devblogArticle(t, title) {
  const r = (await qOf(t)(`SELECT s.id, a.handle, s.slug FROM submissions s JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 2 WHERE s.network_id = 2 AND s.kind = 'article' AND s.title = ${lit(title)} ORDER BY s.id LIMIT 1`))[0];
  return `/${r.handle}/${r.slug}-${r.id}`;
}
async function microPost(t, handle, start) {
  const r = (await qOf(t)(`SELECT s.id, a.handle FROM submissions s JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 4 WHERE s.network_id = 4 AND a.normalized_handle = lower(${lit(handle)}) AND s.body LIKE ${lit(`${start}%`)} ORDER BY s.id LIMIT 1`))[0];
  return r;
}
async function makersGroup(t, title) { return String(await one(t, `SELECT substr(name, 8) FROM forums WHERE network_id = 3 AND title = ${lit(title)} LIMIT 1`)).replace(/_/g, '-'); }
async function makersPost(t, title) { const r = (await qOf(t)(`SELECT id, slug FROM submissions WHERE network_id = 3 AND kind = 'thread-post' AND title = ${lit(title)} ORDER BY id LIMIT 1`))[0]; return `/post/${r.slug}-${r.id}`; }
const makersProduct = async (t, name) => `/product/${await one(t, `SELECT slug FROM products WHERE name = ${lit(name)} LIMIT 1`)}`;
// the deepest reply of a conversation (its page has the longest parent chain)
async function microDeepest(t, root) {
  const r = (await qOf(t)(`WITH RECURSIVE ch(id, d) AS (SELECT ${+root}, 0 UNION ALL SELECT s.id, ch.d + 1 FROM submissions s JOIN ch ON s.reply_to = ch.id WHERE s.visibility = 'visible')
    SELECT ch.id, a.handle FROM ch JOIN submissions s ON s.id = ch.id JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 4 ORDER BY ch.d DESC, ch.id LIMIT 1`))[0];
  return `/${r.handle}/status/${r.id}`;
}

const LOCATE = {
  // community (social)
  'gen-social-top-flair-post-week': async (t) => { const d = t.instantiation_dict; const fl = await one(t, `SELECT fl.id FROM flairs fl JOIN forums f ON f.id = fl.forum_id WHERE f.normalized_name = lower(${lit(d.space)}) AND fl.name = ${lit(d.flair)}`); return { path: `/c/${d.space.toLowerCase()}/top?t=${d.t}&flair=${fl}`, widget: 'vlist', itemSel: 'post-card' }; },
  'gen-social-comments-by-user-on-post': async (t) => ({ path: await socialPost(t, t.instantiation_dict.title, t.instantiation_dict.space), widget: 'vlist', itemSel: 'comment-node' }),
  'gen-social-top-space-of-user': async (t) => ({ path: `/u/${t.instantiation_dict.user}/posts`, widget: null, itemSel: 'post-card' }),
  // devblog
  'gen-devblog-top-tag-article': async (t) => ({ path: `/t/${t.instantiation_dict.tag}/top/${WIN[t.instantiation_dict.win] === 'all' ? 'infinity' : WIN[t.instantiation_dict.win]}`, widget: 'vlist', itemSel: 'article.card', fillSel: '.card-stat:first-child' }),
  'gen-devblog-author-tag-count': async (t) => ({ path: `/${t.instantiation_dict.handle}`, widget: 'vlist', itemSel: 'article.card' }),
  'gen-devblog-top-follower-commenter': async (t) => ({ path: await devblogArticle(t, t.instantiation_dict.title), widget: 'vlist', itemSel: 'div.cm' }),
  'gen-devblog-readinglist-tag-count': async (t) => ({ path: `/readinglist?tag=${t.instantiation_dict.tag}`, widget: 'vlist', itemSel: 'article.rl-item', count: true }),
  'gen-devblog-series-part': async (t) => ({ path: await devblogArticle(t, t.instantiation_dict.title), widget: null, itemSel: 'div.cm' }),
  'gen-devblog-my-top-article': async () => ({ path: '/dashboard', widget: null, fillSel: '.dash-nums span[title=Reactions]' }),
  // micro
  'gen-micro-hashtag-count-by': async (t) => ({ path: `/${t.instantiation_dict.handle}`, widget: 'vlist', itemSel: 'article.post' }),
  'gen-micro-thread-reply-count': async (t) => ({ path: await microDeepest(t, (await microPost(t, t.instantiation_dict.handle, t.instantiation_dict.start)).id), widget: 'older', itemSel: 'article.post' }),
  'gen-micro-who-liked': async (t) => { const p = await microPost(t, t.instantiation_dict.handle, t.instantiation_dict.start); return { path: `/${p.handle}/status/${p.id}`, widget: null, itemSel: 'article.post', fillSel: '.post-stats strong, .likers, .act-like .act-n' }; },
  // makers
  'gen-makers-top-upvoted-post': async (t) => { const d = t.instantiation_dict; const g = /^in the (.+) group$/.exec(d.scope); return { path: `${g ? `/group/${await makersGroup(t, g[1])}` : ''}/top/${WIN[d.win]}`, widget: 'vlist', itemSel: 'article.row' }; },
  'gen-makers-top-mrr-in-group': async (t) => ({ path: `/group/${await makersGroup(t, t.instantiation_dict.group)}/top/${WIN[t.instantiation_dict.win]}`, widget: 'vlist', itemSel: 'article.row', fillSel: '.leader .mrr' }),
  'gen-makers-post-product-revenue': async (t) => ({ path: await makersPost(t, t.instantiation_dict.title), widget: 'vlist', itemSel: 'div.c', fillSel: '.prod-mini .muted.small' }),
  'gen-makers-latest-milestone': async (t) => ({ path: await makersProduct(t, t.instantiation_dict.product), widget: null, fillSel: '.prod-facts dd' }),
  'gen-makers-mrr-gap': async (t) => ({ path: await makersProduct(t, t.instantiation_dict.a), widget: null, fillSel: '.prod-facts dd' }),
  'gen-makers-top-product-topic': async (t) => ({ path: `/products?topic=${t.instantiation_dict.topic}`, widget: null, fillSel: '.prod-mrr' }),

  // forum
  'gen-forum-top-comment-author': async (t) => ({ path: await forumSub(t), widget: 'vlist', itemSel: 'details.comment' }),
  'gen-forum-parent-comment-author': async (t) => ({ path: await forumSub(t), widget: 'vlist', itemSel: 'details.comment' }),
  'gen-forum-top-level-count': async (t) => ({ path: await forumSub(t), widget: 'vlist', itemSel: 'details.comment' }),
  'gen-forum-thread-user-comment-count': async (t) => ({ path: await forumSub(t), widget: 'vlist', itemSel: 'details.comment' }),
  'gen-forum-top-post-author': async (t) => ({ path: `/f/${t.instantiation_dict.forum}/top?t=all`, widget: 'vlist', itemSel: 'article.submission' }),
  'gen-forum-top-link-domain': async (t) => ({ path: `/f/${t.instantiation_dict.forum}/top?t=all`, widget: 'vlist', itemSel: 'article.submission' }),
  'gen-forum-most-commented-title': async (t) => ({ path: `/f/${t.instantiation_dict.forum}/most_commented?t=all`, widget: 'vlist', itemSel: 'article.submission' }),
  'gen-forum-most-active-title': async (t) => ({ path: `/f/${t.instantiation_dict.forum}/active`, widget: 'vlist', itemSel: 'article.submission' }),
  'gen-forum-nth-newest-title': async (t) => ({ path: `/f/${t.instantiation_dict.forum}/new`, widget: 'vlist', itemSel: 'article.submission' }),
  'gen-forum-nth-top-score': async (t) => ({ path: `/f/${t.instantiation_dict.forum}/top?t=all`, widget: 'vlist', itemSel: 'article.submission' }),
  'gen-forum-newest-post-comments': async (t) => ({ path: `/f/${t.instantiation_dict.forum}/new`, widget: 'vlist', itemSel: 'article.submission' }),
  // store
  'gen-shopping-brand-count': async (t) => ({ path: `${await storeCategory(t, t.instantiation_dict.category)}?brand=${encodeURIComponent(t.instantiation_dict.brand)}`, widget: 'vlist', itemSel: 'li.product-item', count: true }),
  'gen-shopping-price-band-count': async (t) => ({ path: `${await storeCategory(t, t.instantiation_dict.category)}?price=${t.instantiation_dict.lo}-${t.instantiation_dict.hi}`, widget: 'vlist', itemSel: 'li.product-item', count: true }),
  'gen-shopping-brand-price-extreme': async (t) => ({ path: `${await storeCategory(t, t.instantiation_dict.category)}?brand=${encodeURIComponent(t.instantiation_dict.brand)}&product_list_order=price&product_list_dir=${/most|high/.test(t.instantiation_dict.which) ? 'desc' : 'asc'}`, widget: 'vlist', itemSel: 'li.product-item' }),
  'gen-shopping-search-sorted-nth': async (t) => ({ path: `/catalogsearch/result/?q=${encodeURIComponent(t.instantiation_dict.q)}&product_list_order=price&product_list_dir=${/high to low/.test(t.instantiation_dict.dir_label) ? 'desc' : 'asc'}`, widget: 'vlist', itemSel: 'li.product-item' }),
  'gen-shopping-review-histogram': async (t) => ({ path: await productUrl(t, t.instantiation_dict.product), widget: 'vlist', itemSel: 'li.review-item' }),
  'gen-shopping-rating-summary': async (t) => ({ path: await productUrl(t, t.instantiation_dict.product), widget: 'vlist', itemSel: 'li.review-item' }),
  'gen-shopping-product-spec': async (t) => ({ path: await productUrl(t, t.instantiation_dict.product), widget: 'vlist', itemSel: 'li.review-item' }),
  'gen-shopping-variant-options': async (t) => ({ path: await productUrl(t, t.instantiation_dict.product), widget: 'vlist', itemSel: 'li.review-item' }),
  'gen-admin-customer-lookup': async (t) => ({ path: `/admin/customer/index/?q=${encodeURIComponent(t.instantiation_dict.value)}`, widget: 'vlist', itemSel: 'tr.data-row' }),
  'gen-admin-product-grid-count': async (t) => ({ path: `/admin/catalog/product/?q=${encodeURIComponent(t.instantiation_dict.term)}`, widget: 'vlist', itemSel: 'tr.data-row' }),
  'gen-admin-orders-report-month': async (t) => { const [f, to] = monthRange(t.instantiation_dict.month); return { path: `/admin/reports/report_sales/sales/?report_from=${f}&report_to=${to}&report_period=month&filter=1`, widget: 'job' }; },
  'gen-admin-top-customer-period': async (t) => { const [f, to] = monthRange(t.instantiation_dict.period); return { path: `/admin/reports/report_customer/totals/?report_from=${f}&report_to=${to}&report_period=month`, widget: 'job' }; },
  // mail
  'gen-mail-label-conversations': async (t) => ({ path: `/label/${encodeURIComponent(t.instantiation_dict.label)}`, widget: 'vlist', itemSel: 'tr.row', count: true }),
  'gen-mail-vendor-quote-amount': async (t) => ({ path: `/thread/${await mailThread(t, "from_name LIKE ? AND from_email LIKE 'sales@%'", [`${t.instantiation_dict.vendor}%`])}`, widget: 'older', itemSel: 'details.msg' }),
  'gen-mail-colleague-request-when': async (t) => ({ path: `/thread/${await mailThread(t, 'from_name = ? AND body LIKE ?', [t.instantiation_dict.name, `%${t.instantiation_dict.gist.split(' ').slice(-1)[0]}%`])}`, widget: 'older', itemSel: 'details.msg' }),
  'gen-mail-friend-plan-day': async (t) => ({ path: `/thread/${await mailThread(t, 'from_name = ? AND (subject LIKE ? OR body LIKE ?)', [t.instantiation_dict.name, `%${t.instantiation_dict.gist.split(' ')[0]}%`, `%${t.instantiation_dict.gist.split(' ')[0]}%`])}`, widget: 'older', itemSel: 'details.msg' }),
  // code
  'gen-code-issue-most-comments': async (t) => ({ path: `/${t.instantiation_dict.repo}/-/issues?state=${t.instantiation_dict.state === 'open' ? 'opened' : t.instantiation_dict.state}&label_name[]=${encodeURIComponent(t.instantiation_dict.label)}`, widget: 'vlist', itemSel: 'li.issuable-row' }),
  'gen-code-branch-latest-commit': async (t) => ({ path: `/${t.instantiation_dict.repo}/-/commits/${encodeURIComponent(t.instantiation_dict.branch)}`, widget: 'vlist', itemSel: 'li.commit-row' }),
  'gen-code-author-commit': async (t) => { const br = await one(t, 'SELECT default_branch FROM projects WHERE full_path = ?', [t.instantiation_dict.repo]); return { path: `/${t.instantiation_dict.repo}/-/commits/${br}?author=${encodeURIComponent(t.instantiation_dict.author)}`, widget: 'vlist', itemSel: 'li.commit-row' }; },
  'gen-code-path-history': async (t) => { const br = await one(t, 'SELECT default_branch FROM projects WHERE full_path = ?', [t.instantiation_dict.repo]); return { path: `/${t.instantiation_dict.repo}/-/commits/${br}/${t.instantiation_dict.path}`, widget: 'vlist', itemSel: 'li.commit-row' }; },
  'gen-code-mr-reviewer-count': async (t) => ({ path: `/${t.instantiation_dict.repo}/-/merge_requests?state=${t.instantiation_dict.state}&reviewer_username=${/@(\w[\w.-]*)/.exec(t.instantiation_dict.user)[1]}`, widget: 'counts', state: t.instantiation_dict.state }),
};

// ---------------------------------------------------------------- browser
let browser;
async function open(t, scenario, p, { keep = false } = {}) {
  const base = baseOf(t);
  if (!keep) { // keep: the tenant as the previous page left it (several steps of one task)
    const r = await rl(base, '/reset', scenario ? { scenario } : {});
    if (r.status !== 200) throw new Error(`reset ${r.status}`);
  }
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  if (t.login_user) {
    const l = await rl(base, '/login', { user: t.login_user });
    await page.setCookie({ name: l.cookie.name, value: l.cookie.value, url: base + '/' });
  }
  await page.goto(base + p, { waitUntil: 'networkidle0' });
  return page;
}
// every element matching sel on the page (document order), its id and text (shadow roots included)
const lightItems = (page, sel) => page.$$eval(sel, (xs, src) => { const deep = eval(src); return xs.map((x, k) => ({ key: x.id || x.getAttribute('data-id') || `#${k}`, text: deep(x).replace(/\s+/g, ' ').trim() })); }, B.DEEP_TEXT);

async function readTask(t) {
  const loc = await LOCATE[t.template](t);
  const slot = t.widget.slot;
  // plain (no scenario): the first page
  const p0 = await open(t, null, loc.path);
  if (loc.widget === 'job') await sleep(1500), await p0.reload({ waitUntil: 'networkidle0' });
  const plainItems = loc.itemSel ? await lightItems(p0, loc.itemSel) : [];
  const plainText = await B.deepText(p0);
  const plainCounts = loc.widget === 'counts' ? await p0.$$eval('.issuable-count', (x) => x.map((e) => e.textContent.trim())) : null;
  // values a script writes in (shadow roots included): innerText leaves out the JSON blobs
  const fills = (pg) => pg.evaluate((sel) => {
    const out = [];
    const walk = (root) => { root.querySelectorAll(sel).forEach((e) => out.push(e.innerText.replace(/\s+/g, ' ').trim())); root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) walk(e.shadowRoot); }); };
    walk(document);
    return out;
  }, loc.fillSel);
  const plainFill = loc.fillSel ? await fills(p0) : null;
  await p0.close();
  // variant
  const p1 = await open(t, t.scenario, loc.path);
  let items = null; let text; let how;
  const listSlot = ['comments', 'listing', 'grid', 'reviews', 'admin_grid', 'inbox', 'issues', 'commits', 'feed', 'timeline', 'readinglist'].includes(slot) && loc.widget === 'vlist';
  if (listSlot && await p1.$('.wsb-vlist')) { items = await B.readVlist(p1, { itemSel: loc.itemSel }); how = `scrolled the ${slot} list (${items.length} items)`; }
  else if (slot === 'thread' && loc.widget === 'older' && await p1.$('.wsb-older')) { items = await B.readOlder(p1, { itemSel: loc.itemSel }); how = `scrolled the conversation up (${items.length} messages)`; }
  else if (slot === 'admin_job') {
    await p1.waitForSelector('#wsb-job');
    await rl(baseOf(t), '/clock', { advance: 61 });
    await p1.waitForSelector('#gridReport', { timeout: 30000 });
    how = 'waited for the slow report job (site clock +61 s), page reloaded itself';
  } else if (slot === 'counts' && loc.widget === 'counts') {
    await p1.waitForFunction(() => [...document.querySelectorAll('.issuable-count')].every((e) => e.textContent.trim() !== ''));
    how = 'tab counts filled from the API';
  } else how = `read the page (${slot}=${t.widget.value})`;
  const listed = !!items;
  if (!items && loc.itemSel) items = await lightItems(p1, loc.itemSel);
  text = listed ? items.map((x) => x.text).join(' \n ') : await B.deepText(p1);
  const counts = slot === 'counts' && loc.widget === 'counts' ? await p1.$$eval('.issuable-count', (x) => x.map((e) => e.textContent.trim())) : null;
  if (loc.fillSel && ['reactions', 'counts', 'product'].includes(slot)) { await sleep(400); how += t.widget.value === 'shadow' ? ', values read in the shadow root' : ', values written by script'; }
  const fill = loc.fillSel && ['reactions', 'counts', 'product'].includes(slot) ? await fills(p1) : null;
  const plantCount = slot === 'plant' ? (await B.deepText(p1)).split(/[A-Z]X-\d{4}/).length - 1 : null;
  await p1.close();
  // checks
  const problems = [];
  if (items && loc.itemSel && plainItems.length) {
    // same items in the same order as the plain first page: by id where items have one, else by text
    const byKey = plainItems.every((x) => !x.key.startsWith('#'));
    const f = (x) => (byKey ? x.key : x.text.slice(0, 160));
    // (an item shown twice on a page, e.g. a post and its repost, is read once)
    const plainOnce = byKey ? plainItems.filter((x, k) => plainItems.findIndex((y) => y.key === x.key) === k) : plainItems;
    const a1 = items.slice(0, plainOnce.length).map(f); const b1 = plainOnce.map(f);
    if (JSON.stringify(a1) !== JSON.stringify(b1)) problems.push(`items differ from the plain page (first at ${b1.findIndex((x, i) => x !== a1[i])}: ${String(a1[b1.findIndex((x, i) => x !== a1[i])]).slice(0, 60)} vs ${String(b1[b1.findIndex((x, i) => x !== a1[i])]).slice(0, 60)})`);
  }
  const refs = refsOf(t);
  const named = refs.filter((r) => !isNum(r));
  if (named.length && !kit.grader.mustInclude(text, named)) problems.push(`reference ${JSON.stringify(named).slice(0, 120)} not in what the variant shows`);
  // (a count beyond the list's window continues on the pages after it)
  if (loc.count && listed && refs.length === 1 && isNum(refs[0]) && +String(refs[0]).replace(/,/g, '') <= items.length && String(items.length) !== String(refs[0]).replace(/,/g, '')) problems.push(`counted ${items.length} items, reference ${refs[0]}`);
  if (counts && JSON.stringify(counts) !== JSON.stringify(plainCounts)) problems.push(`counts ${counts} vs plain ${plainCounts}`);
  if (counts && refs.length === 1 && !counts.includes(String(refs[0]))) problems.push(`no tab count ${refs[0]}`);
  const nums = (xs) => xs && xs.map((x) => (x.match(/\d[\d,.]*/g) || []).join(' '));
  if (fill && JSON.stringify(nums(fill)) !== JSON.stringify(nums(plainFill))) problems.push(`script-written values ${JSON.stringify(fill).slice(0, 120)} vs plain ${JSON.stringify(plainFill).slice(0, 120)}`);
  if (fill && !fill.length) problems.push('no script-written values found');
  // the plant sits in a comment / review / message: the pages that show those carry it once
  if (slot === 'plant' && ['details.comment', 'li.review-item', 'details.msg', 'comment-node', 'div.cm', 'div.c', 'article.post'].includes(loc.itemSel) && plainItems.length && plantCount !== 1) problems.push(`plant shown ${plantCount} times`);
  // the page the locator found does not hold the answer even without the widget: not a widget question
  if (named.length && !listed && !kit.grader.mustInclude(plainText, named)) return { how, ok: true, skipped: 'locator: reference not on the plain page', notes: '' };
  return { how, ok: !problems.length, notes: problems.join('; ') };
}

// ---------------------------------------------------------------- write solves through the UI
const nav = (page, fn) => Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), fn()]);
const WRITES = {
  async 'gen-forum-create-text-post'(t) {
    const d = t.instantiation_dict;
    const page = await open(t, t.scenario, '/submit');
    await page.click('input[name=type][value=text]');
    await page.select('#submission_forum', await page.$$eval('#submission_forum option', (os, f) => os.find((o) => o.value.toLowerCase() === f.toLowerCase()).value, d.forum));
    await page.type('#submission_title', d.title);
    await page.evaluate(() => { document.querySelector('#submission_body').value = 'set by script: not part of the value'; });
    const kind = await B.typeEditor(page, 'body', d.body);
    await nav(page, () => page.click('#submission-form button[type=submit]'));
    await page.close();
    return { how: `submit form, body typed into the ${kind} editor` };
  },
  // the social frontends: the editors / composers of comment, reply and post forms
  async 'gen-social-reply-newest-unanswered'(t) {
    const sid = /submission_id = (\d+)/.exec(t.eval.state_sql)[1];
    const r = (await qOf(t)(`SELECT s.id, f.name, s.slug FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.id = ${+sid}`))[0];
    const page = await open(t, t.scenario, `/c/${r.name}/comments/${r.id}/${r.slug}`);
    await page.evaluate(() => { document.querySelector('#comment-body').value = 'set by script: not part of the value'; });
    const kind = await B.typeEditor(page, 'body', 'Good question! I had the same one last year; asking at the library desk worked for me.', { form: '#comment-composer' });
    await nav(page, () => page.click('#comment-composer button[type=submit]'));
    await page.close();
    return { how: `comment typed into the ${kind} editor` };
  },
  async 'gen-social-reply-unread-replies'(t) {
    const ids = /c\.id IN \(([\d, ]+)\)/.exec(t.eval.state_sql)[1].split(',').map((x) => +x);
    let kind;
    for (const cid of ids) {
      const r = (await qOf(t)(`SELECT s.id, f.name, s.slug FROM comments c JOIN submissions s ON s.id = c.submission_id JOIN forums f ON f.id = s.forum_id WHERE c.id = ${cid}`))[0];
      const page = await open(t, cid === ids[0] ? t.scenario : undefined, `/c/${r.name}/comments/${r.id}/${r.slug}?reply=${cid}`, { keep: cid !== ids[0] });
      kind = await B.typeEditor(page, 'body', 'Thanks for the reply, that helps a lot.', { form: `form.reply-form:has(input[name=parent_id][value="${cid}"])` });
      await nav(page, () => page.click(`form.reply-form:has(input[name=parent_id][value="${cid}"]) button[type=submit]`));
      await page.close();
    }
    return { how: `${ids.length} replies typed into the ${kind} editor (no-script reply forms)` };
  },
  async 'gen-devblog-reply-to-comment'(t) {
    const pid = +/parent_id = (\d+)/.exec(t.eval.state_sql)[1];
    const page = await open(t, t.scenario, await devblogArticle(t, t.instantiation_dict.title));
    await page.click(`#comment-${pid} > .cm-main details.cm-reply-box > summary`);
    const kind = await B.typeEditor(page, 'body', 'Could you say a bit more about how you set that up?', { form: `#comment-${pid} > .cm-main details.cm-reply-box form` });
    await nav(page, () => page.click(`#comment-${pid} > .cm-main details.cm-reply-box form button[type=submit]`));
    await page.close();
    return { how: `reply typed into the ${kind} editor` };
  },
  async 'gen-devblog-publish-article'(t) {
    const d = t.instantiation_dict;
    const page = await open(t, t.scenario, '/new');
    await page.type('#title', d.title);
    await page.type('#tags', `${d.t1}, ${d.t2}`);
    const body = ['Some notes from the project.', '', '## What happened', '', '- start small', '- write it down', '', '```', 'console.log("done");', '```', '', 'More in [the docs](https://example.com/docs).'].join('\n');
    const kind = await B.typeEditor(page, 'body', body);
    await nav(page, () => page.click('button[value=publish]'));
    await page.close();
    return { how: `body (heading, list, code block, link) typed into the ${kind} editor` };
  },
  async 'gen-micro-post-hashtag'(t) {
    const d = t.instantiation_dict;
    const page = await open(t, t.scenario, '/home');
    const kind = await B.typeEditor(page, 'text', `Good news: ${d.news} #${d.tag}`, { form: '.composer-inline' });
    await nav(page, () => page.click('.composer-inline [data-submit]'));
    await page.close();
    return { how: `post typed into the ${kind} composer` };
  },
  async 'gen-micro-reply-newest-mention'(t) {
    const pid = +/reply_to = (\d+)/.exec(t.eval.state_sql)[1];
    const h = await one(t, `SELECT a.handle FROM submissions s JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 4 WHERE s.id = ${pid}`);
    const page = await open(t, t.scenario, `/${h}/status/${pid}`);
    if (t.widget.slot === 'thread' && await page.$('.wsb-older')) await B.readOlder(page, { itemSel: 'article.post' });
    const kind = await B.typeEditor(page, 'text', 'Thanks for the mention!', { form: '.composer-inline' });
    await nav(page, () => page.click('.composer-inline [data-submit]'));
    await page.close();
    return { how: `reply typed into the ${kind} composer` };
  },
  async 'gen-makers-answer-question-post'(t) {
    const page = await open(t, t.scenario, await makersPost(t, t.instantiation_dict.title));
    const kind = await B.typeEditor(page, 'body', 'Worth it for us: we started small, tracked the hours saved and kept it after a month.', { form: 'form.c-form:not(:has(input[name=parent_id]))' });
    await nav(page, () => page.click('form.c-form:not(:has(input[name=parent_id])) button[type=submit]'));
    await page.close();
    return { how: `answer typed into the ${kind} editor` };
  },
  async 'gen-makers-post-group-product'(t) {
    const d = t.instantiation_dict;
    const page = await open(t, t.scenario, '/new');
    await page.type('#w-title', `A ${d.kw} experiment that worked`);
    await page.select('#w-group', await makersGroup(t, d.group));
    await page.select('#w-product', await one(t, `SELECT slug FROM products WHERE name = ${lit(d.product)}`));
    const kind = await B.typeEditor(page, 'body', `Here is ${d.topic}, with the numbers and what I would change next time.`);
    await nav(page, () => page.click('form[data-write] button[type=submit]'));
    await page.close();
    return { how: `post typed into the ${kind} editor` };
  },
  async 'gen-mail-send-new-to-contact'(t) {
    const d = t.instantiation_dict;
    const email = await one(t, 'SELECT email FROM contacts WHERE owner_id = (SELECT id FROM users WHERE username = ?) AND name = ?', [t.login_user, d.name]);
    const page = await open(t, t.scenario, '/compose');
    await page.type('#cf-to', `${d.name} <${email}>`);
    await page.type('#cf-subject', d.subject);
    const kind = await B.typeEditor(page, 'body', `Hi, quick note: it's at ${d.kw}.`);
    await nav(page, () => page.click('button[value=send]'));
    await page.close();
    return { how: `compose, body typed into the ${kind} editor` };
  },
  async 'gen-code-close-issue-comment'(t) {
    const d = t.instantiation_dict;
    const page = await open(t, t.scenario, `/${d.repo}/-/issues/${d.iid}`);
    if (t.widget.slot === 'discussion' && await page.$('.wsb-older')) await B.readOlder(page, { itemSel: 'li.timeline-entry' });
    const kind = await B.typeEditor(page, 'note', d.comment, { form: '#new-note-form' });
    await nav(page, () => page.click('#new-note-form button[name=close]'));
    await page.close();
    return { how: `comment typed into the ${kind} editor, "Comment & close issue"` };
  },
  async 'gen-shopping-review-ordered-item'(t) {
    const d = t.instantiation_dict;
    const pid = /product_id = (\d+)/.exec([].concat(t.eval.state_sql)[0])[1];
    const page = await open(t, t.scenario, `/${await one(t, 'SELECT url_key FROM products WHERE id = ?', [+pid])}.html`);
    await page.click(`#Rating_${d.stars}`);
    await page.$eval('#nickname_field', (e) => { e.value = ''; }); await page.type('#nickname_field', d.nick);
    await page.type('#summary_field', d.title);
    const kind = await B.typeEditor(page, 'detail', d.detail);
    await nav(page, () => page.click('#review-form-el button[type=submit]'));
    await page.close();
    return { how: `review form, text typed into the ${kind} editor` };
  },
  async 'gen-shopping-checkout-new-address'(t) {
    const d = t.instantiation_dict;
    const page = await open(t, t.scenario, await productUrl(t, d.product));
    await page.$eval('#qty', (e) => { e.value = ''; }); await page.type('#qty', String(d.qty));
    await nav(page, () => page.click('#product-addtocart-button'));
    await page.goto(baseOf(t) + '/checkout/', { waitUntil: 'networkidle0' });
    const cust = (await qOf(t)('SELECT firstname, lastname FROM customers WHERE email = ?', [t.login_user]))[0];
    const radio = await page.$('input[name=address_id][value=new]');
    if (radio) await radio.click();
    await sleep(300);
    const fr = page.frames().find((f) => f.url().includes('/checkout/frame/address'));
    const m = /^(.+), (.+), (.+) (\d{5})$/.exec(d.address);
    const clear = async (sel) => fr.$eval(sel, (e) => { e.value = ''; });
    for (const [sel, v] of [['input[name=firstname]', cust.firstname], ['input[name=lastname]', cust.lastname], ['input[name=telephone]', d.phone], ['input[name="street[0]"]', m[1]], ['input[name=city]', m[2]], ['input[name=postcode]', m[4]]]) { await clear(sel); await fr.type(sel, v); }
    await fr.select('select[name=region_id]', String(await one(t, "SELECT id FROM regions WHERE country_id = 'US' AND name = ?", [m[3]])));
    await sleep(300);
    await page.click(/Best Way/.test(d.ship) ? '#s_method_tablerate_bestway' : '#s_method_flatrate_flatrate');
    await nav(page, () => page.click('#shipping-method-buttons-container button'));
    const pf = page.frames().find((f) => f.url().includes('/checkout/frame/payment'));
    await pf.click(/Cash/.test(d.pay) ? '#cashondelivery' : '#checkmo');
    await sleep(300);
    await nav(page, () => page.click('button.checkout'));
    const url = page.url();
    await page.close();
    return { how: `cart, address typed into the ${t.widget.value} address frame, payment chosen in the payment frame (-> ${url.replace(baseOf(t), '')})` };
  },
};

async function main() {
  let tasks = fs.readFileSync(a.tasks, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((t) => baseOf(t));
  if (a.only) tasks = tasks.filter((t) => a.only.split(',').includes(DIR[t.site]));
  // sample: per site/slot, up to --per read tasks (spread over templates and values) + every write template once per value
  const pick = [];
  const groups = new Map();
  for (const t of tasks) {
    const isRead = [].concat(t.eval.type).includes('answer') && LOCATE[t.template];
    const isWrite = WRITES[t.template] && ['editor', 'checkout', 'discussion', 'composer', 'thread'].includes(t.widget.slot);
    if (!isRead && !isWrite) continue;
    const k = `${DIR[t.site]}|${t.widget.slot}|${isRead ? 'read' : 'write'}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  // a conversation needs more than 3 messages for the thread box to have older ones to load
  const fits = async (t) => {
    if (t.widget.slot !== 'thread' || DIR[t.site] !== 'mail' || !LOCATE[t.template]) return true;
    try { const loc = await LOCATE[t.template](t); return (await one(t, 'SELECT count(*) FROM messages WHERE thread_id = ? AND is_trash = 0', [+loc.path.split('/').pop()])) > 3; } catch { return false; }
  };
  for (const [k, ts] of groups) {
    const seen = new Set(); const per = k.endsWith('write') ? +a['per-write'] : +a.per;
    for (const t of ts) { const tk = `${t.template}|${t.widget.value}`; if (seen.has(tk) || !(await fits(t))) continue; seen.add(tk); pick.push(t); if (seen.size >= per) break; }
  }
  browser = (await B.launch()).browser;
  const out = []; let fails = 0;
  try {
    for (const t of pick) {
      const t0 = Date.now();
      let rec;
      try {
        if (WRITES[t.template] && ['editor', 'checkout', 'discussion', 'composer', 'thread'].includes(t.widget.slot)) {
          const r = await WRITES[t.template](t);
          const g = await graderOf(t)(t, { answer: '', url: '', query: qOf(t) });
          rec = { how: r.how, ok: g.pass === true, notes: g.pass === true ? '' : JSON.stringify(g.checks.filter((c) => c.pass !== true)).slice(0, 300) };
        } else rec = await readTask(t);
      } catch (e) { rec = { how: 'error', ok: false, notes: String(e.message || e).slice(0, 300) }; }
      rec = { task_id: t.task_id, scenario: t.scenario, when: new Date().toISOString(), ...rec, seconds: Math.round((Date.now() - t0) / 1000) };
      if (!rec.ok) fails++;
      out.push(rec);
      console.log(`${rec.skipped ? 'skip' : rec.ok ? 'ok  ' : 'FAIL'} ${t.task_id} ${rec.seconds}s ${rec.how}${rec.ok ? '' : ' -- ' + rec.notes}${rec.skipped ? ' -- ' + rec.skipped : ''}`);
    }
  } finally {
    await browser.close();
    for (const b of Object.values(BASES)) await rl(b, '/reset', {});
  }
  // with --only, the other sites' lines of the log stay
  const dirOf = new Map(fs.readFileSync(a.tasks, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((x) => [x.task_id, DIR[x.site]]));
  const kept = a.only && fs.existsSync(a.out) ? fs.readFileSync(a.out, 'utf8').split('\n').filter((l) => l.trim() && !a.only.split(',').includes(dirOf.get(JSON.parse(l).task_id))) : [];
  fs.writeFileSync(a.out, [...kept, ...out.map((x) => JSON.stringify(x))].join('\n') + '\n');
  const skips = out.filter((x) => x.skipped).length;
  console.log(`${out.length - fails - skips}/${out.length} UI runs ok, ${skips} skipped, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
