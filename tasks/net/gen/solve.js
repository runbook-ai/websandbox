#!/usr/bin/env node
'use strict';
// Reference solver for the network-site write templates: does each task through the site's own forms
// (the requests the UI sends; lists read from the rendered pages where the task is about a listing),
// then grades it -- the positive counterpart of check.js. Two tasks per template by default; the
// tenant is reset between tasks.
//   node tasks/net/gen/solve.js --site devblog|micro|makers [--tasks FILE] [--per 2] [--only name,name]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseArgs } = require('util');
const kit = require('../../../kit');
const { Client, rl } = require('../../../kit/test/helpers');
const L = require('./lib');

const unesc = (s) => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = (html) => unesc(String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

class NetClient extends Client {
  async form(p, fields, from = '/', { ok = [] } = {}) {
    const r = await this.post(p, { form: { ...fields, _csrf: await this.csrf(from) } });
    if (r.status >= 400 && !ok.includes(r.status)) throw new Error(`POST ${p} -> ${r.status} ${text((/class="(?:field-error|banner|flash)[^"]*"[^>]*>([\s\S]{0,300})/.exec(r.text) || [])[1] || '').slice(0, 160)}`);
    return r;
  }
}
const one = async (q, sql) => (await q(sql))[0];

// ---------------------------------------------------------------- devblog
const devblog = {
  async 'publish-article'(t, c) {
    const { title, t1, t2, req } = t.instantiation_dict;
    const parts = ['Some notes from the project.', ''];
    if (/heading/.test(req)) parts.push('## What happened', '', 'It took a few tries.', '');
    if (/bulleted/.test(req)) parts.push('- start small', '- write it down', '');
    if (/code block/.test(req)) parts.push('```js', 'console.log("done");', '```', '');
    if (/link/.test(req)) parts.push('More in [the docs](https://example.com/docs).');
    await c.form('/new', { title, tags: `${t1}, ${t2}`, body: parts.join('\n'), series_id: '', new_series: '', action: 'publish' }, '/new');
  },
  async 'save-draft'(t, c) {
    const { title, tag } = t.instantiation_dict;
    await c.form('/new', { title, tags: tag, body: 'Draft notes.', series_id: '', new_series: '', action: 'draft' }, '/new');
  },
  async 'save-latest-article'(t, c) {
    const page = (await c.get(`/${t.instantiation_dict.handle}`)).text;
    const id = (/<article class="card[^"]*" id="article-(\d+)"/.exec(page) || [])[1];
    if (!id) throw new Error('no article on the profile');
    await c.form('/readinglist', { id, on: '1' }, `/${t.instantiation_dict.handle}`);
  },
  async 'react-kind'(t, c, q) {
    const { title, label } = t.instantiation_dict;
    const page = (await c.get(`/search?q=${encodeURIComponent(title)}`)).text;
    const m = [...page.matchAll(/<a href="(\/[^"]+-(\d+))" id="article-link-\d+">([^<]*)<\/a>/g)].find((x) => unesc(x[3]) === title);
    if (!m) throw new Error('article not found by search');
    await c.form('/reactions', { target: 'article', id: m[2], kind: label.toLowerCase(), on: '1' }, m[1]);
  },
  async 'reply-to-comment'(t, c, q) {
    const { title, name, start } = t.instantiation_dict;
    const a = await one(q, `SELECT s.id, s.slug, a.handle FROM submissions s JOIN accounts a ON a.user_id = s.user_id AND a.network_id = 2 WHERE s.network_id = 2 AND s.title = ${L.lit(title)}`);
    const url = `/${a.handle}/${a.slug}-${a.id}`;
    const page = (await c.get(url)).text;
    const cms = page.split(/<div class="cm(?: cm-reply)?" id=/).slice(1).map((x) => 'id=' + x).map((x) => ({ id: (/id="comment-(\d+)"/.exec(x) || [])[1], name: unesc((/class="cm-name"[^>]*>([^<]*)</.exec(x) || [])[1] || ''), body: text((/class="cm-body[^"]*">([\s\S]*?)<\/div>/.exec(x) || [])[1] || '') }));
    const cm = cms.find((x) => x.name === name && x.body.startsWith(start));
    if (!cm) throw new Error('comment not found on the page');
    await c.form(`${url}/comments`, { body: 'Thanks, that is a good point. How long did it take you to set up?', parent_id: cm.id }, url);
  },
  async 'follow-tags'(t, c) {
    for (const tag of [t.instantiation_dict.a, t.instantiation_dict.b]) await c.form(`/t/${tag}/follow`, { on: '1' }, `/t/${tag}`);
  },
  async 'follow-top-tag-author'(t, c) {
    const { tag, win } = t.instantiation_dict;
    const page = (await c.get(`/t/${tag}/top/${win.split(' ')[1]}`)).text;
    const h = (/<a href="\/([^"/]+)" class="card-author">/.exec(page) || [])[1];
    if (!h) throw new Error('no top article');
    await c.form('/follow', { handle: h, on: '1' }, `/${h}`);
  },
  async 'edit-add-tag'(t, c) {
    const { tag, title } = t.instantiation_dict;
    const dash = (await c.get('/dashboard')).text;
    const m = [...dash.matchAll(/<a class="dash-title" href="([^"]+)">([^<]*)<\/a>/g)].find((x) => unesc(x[2]) === title);
    if (!m) throw new Error('article not on the dashboard');
    const edit = (await c.get(`${m[1]}/edit`)).text;
    const val = (n) => unesc((new RegExp(`name="${n}"[^>]*value="([^"]*)"`).exec(edit) || [])[1] || '');
    const body = unesc((/<textarea[^>]*name="body"[^>]*>([\s\S]*?)<\/textarea>/.exec(edit) || [])[1] || '');
    const series = (/<option value="(\d+)" selected/.exec(edit) || [])[1] || '';
    await c.form(`${m[1]}/edit`, { title: val('title') || title, tags: `${val('tags')}, ${tag}`, body, series_id: series, new_series: '', action: 'publish' }, `${m[1]}/edit`);
  },
  async 'publish-limit'(t, c) {
    const titles = [...t.instantiation_dict.list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (const title of titles) {
      const r = await c.form('/new', { title, tags: '', body: 'A short note.', series_id: '', new_series: '', action: 'publish' }, '/new', { ok: [429] });
      if (r.status === 429) await c.form('/new', { title, tags: '', body: 'A short note.', series_id: '', new_series: '', action: 'draft' }, '/new');
    }
  },
};

// ---------------------------------------------------------------- micro
// post cells of a rendered timeline: id, author handle, reposted?, time
const cells = (html) => html.split('<article class="post').slice(1).map((x) => ({
  id: +(/id="post-(\d+)"/.exec(x) || [])[1], handle: (/class="post-handle muted" href="\/([^"]+)"/.exec(x) || [])[1],
  repost: /class="post-social/.test(x.slice(0, 400)), at: (/<time datetime="([^"]+)"/.exec(x) || [])[1], body: text((/class="post-text[^"]*">([\s\S]*?)<\/div>/.exec(x) || [])[1] || ''),
}));
async function profileCells(c, h, pages = 10) {
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const r = await c.get(`/${h}${p > 1 ? `?page=${p}` : ''}`);
    const xs = cells(r.text);
    out.push(...xs);
    if (!/data-more|rel="next"|page=\d+/.test(r.text) || !xs.length) break;
  }
  return out;
}
const micro = {
  async 'post-hashtag'(t, c) {
    const { news, tag } = t.instantiation_dict;
    await c.form('/compose', { text: `Big day: ${news}! #${tag}` }, '/home');
  },
  async 'reply-newest-mention'(t, c) {
    const page = (await c.get('/notifications/mentions')).text;
    const id = (/<div class="note-cell[^"]*" id="note-\d+">[\s\S]*?<article class="post[^"]*" id="post-(\d+)"/.exec(page) || [])[1];
    if (!id) throw new Error('no mention');
    await c.form('/compose', { text: 'Thanks for the reply!', reply_to: id }, '/home');
  },
  async 'quote-post'(t, c) {
    const { handle, start } = t.instantiation_dict;
    const p = (await profileCells(c, handle, 40)).find((x) => !x.repost && x.handle === handle && x.body.startsWith(start));
    if (!p) throw new Error('post not found on the profile');
    await c.form('/compose', { text: 'Worth a read.', quote_of: String(p.id) }, '/home');
  },
  async 'like-recent-posts'(t, c) {
    const { handle, n } = t.instantiation_dict;
    const now = Date.parse((await rl(c.base, '/clock')).now);
    for (const p of await profileCells(c, handle, 5)) if (!p.repost && now - Date.parse(p.at) < n * 3600000) await c.form('/i/like', { id: String(p.id), on: '1' }, `/${handle}`);
  },
  async 'bookmark-newest'(t, c) {
    const h = t.instantiation_dict.handle;
    const p = (await profileCells(c, h, 3)).find((x) => !x.repost);
    await c.form('/i/bookmark', { id: String(p.id), on: '1' }, `/${h}`);
  },
  async 'follow-repliers'(t, c) {
    const me = t.login_user;
    const p = (await profileCells(c, me, 3)).find((x) => !x.repost);
    const page = (await c.get(`/${me}/status/${p.id}`)).text;
    const replies = page.split('<div class="replies"')[1] || '';
    for (const h of new Set(cells(replies).map((x) => x.handle).filter((x) => x && x.toLowerCase() !== me.toLowerCase()))) await c.form('/i/follow', { handle: h, on: '1' }, `/${h}`);
  },
  // ---- direct messages (micro-dm.js): the conversation is found in the messages list by the other account
  async 'dm-reply-unread'(t, c) {
    const tid = await dmThread(c, t.instantiation_dict.handle, { unread: true });
    await c.form(`/messages/${tid}`, { text: 'Thanks! Sounds good to me.' }, `/messages/${tid}`);
  },
  async 'dm-send-post-link'(t, c, q) {
    const { handle } = t.instantiation_dict;
    const tid = await dmThread(c, handle);
    // my post they replied to
    const p = await one(q, `SELECT p.id FROM submissions p JOIN submissions s ON s.reply_to = p.id WHERE p.user_id = ${L.uidOf(4, t.login_user)} AND s.user_id = ${L.uidOf(4, handle)}
      AND p.network_id = 4 AND p.visibility = 'visible' ORDER BY s.id LIMIT 1`);
    if (!p) throw new Error('no post of mine they replied to');
    await c.form(`/messages/${tid}`, { text: `Here it is: /${t.login_user}/status/${p.id}` }, `/messages/${tid}`);
  },
  async 'dm-answer-topic'(t, c, q) {
    const rows = await q(`SELECT d.thread_id, w.topic FROM world_dm_threads d JOIN world_items w ON w.item_id = d.item_id || '.0' WHERE d.other_id = ${L.uidOf(4, t.login_user)} AND d.network_id = 4 AND d.intent = 'recommend' ORDER BY d.thread_id`);
    const ok = rows.filter((x) => LABEL[x.topic] === t.instantiation_dict.topic).map((x) => x.thread_id);
    if (ok.length !== 1) throw new Error(`${ok.length} matching conversations`);
    await c.form(`/messages/${ok[0]}`, { text: 'Great question! Start with the simplest option and see how it goes.' }, `/messages/${ok[0]}`);
  },
  async 'dm-user'(t, c) {
    const { handle, ask } = t.instantiation_dict;
    await c.form('/messages', { to: handle, text: `Hi! I wanted to ask ${ask}.` }, `/messages/compose?to=${handle}`);
  },
  async 'delete-post-containing'(t, c) {
    const me = t.login_user;
    // search my posts and replies for the phrase (from:me), then delete the match
    const page = (await c.get(`/search?q=${encodeURIComponent(`from:${me} ${t.instantiation_dict.phrase}`)}&f=live`)).text;
    const hit = cells(page).find((x) => x.body.toLowerCase().includes(t.instantiation_dict.phrase.toLowerCase()));
    if (!hit) throw new Error('post not found by search');
    await c.form('/i/delete', { id: String(hit.id) }, `/${me}`);
  },
};

// ---------------------------------------------------------------- makers
const TOPIC_SLUG = { productivity: 'productivity', marketing: 'marketing', freelancing: 'freelancing', 'AI tools': 'ai-tools', startups: 'startups' };
const groupSlug = async (c, title) => {
  const page = (await c.get('/groups')).text;
  const m = [...page.matchAll(/href="\/group\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].find((x) => text(x[2]).includes(title));
  if (!m) throw new Error(`group ${title} not found`);
  return m[1];
};
const productSlug = async (c, name) => {
  const page = (await c.get(`/products?q=${encodeURIComponent(name)}`)).text;
  const m = [...page.matchAll(/href="\/product\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].find((x) => text(x[2]).split(' ').includes(name) || text(x[2]).startsWith(name));
  if (!m) throw new Error(`product ${name} not found`);
  return m[1];
};
const rows = (html) => html.split('<article class="row"').slice(1).map((x) => ({ id: (/id="post-(\d+)"/.exec(x) || [])[1], group: text((/class="row-group"[^>]*>([\s\S]*?)<\/a>/.exec(x) || [])[1] || '') }));
const makers = {
  async 'post-group-product'(t, c) {
    const { group, topic, product, kw } = t.instantiation_dict;
    const g = await groupSlug(c, group);
    const p = await productSlug(c, product);
    await c.form('/new', { title: `${kw[0].toUpperCase()}${kw.slice(1)} notes: ${topic}`.slice(0, 150), body: `Sharing ${topic}. Happy to answer questions.`, group: g, product: p }, '/new');
  },
  async 'add-milestone'(t, c) {
    const { product, title, value } = t.instantiation_dict;
    const p = await productSlug(c, product);
    await c.form(`/product/${p}/milestones`, { title, value, mrr: '' }, `/product/${p}`);
  },
  async 'update-revenue'(t, c) {
    const { product, money } = t.instantiation_dict;
    const p = await productSlug(c, product);
    await c.form(`/product/${p}/milestones`, { title: `Now at ${money} MRR`, value: '', mrr: money.replace(/[$,]/g, '') }, `/product/${p}`);
  },
  async 'upvote-user-posts'(t, c) {
    const { handle, group } = t.instantiation_dict;
    for (let pg = 1; pg <= 10; pg++) {
      const page = (await c.get(`/${handle}${pg > 1 ? `?page=${pg}` : ''}`)).text;
      const rs = rows(page);
      for (const r of rs) if (r.group === group) await c.form('/upvote', { target: 'post', id: r.id, on: '1' }, `/${handle}`);
      if (!/Load more|page=\d+/.test(page) || !rs.length) break;
    }
  },
  async 'answer-question-post'(t, c) {
    const page = (await c.get(`/search?q=${encodeURIComponent(t.instantiation_dict.title)}&type=posts`)).text;
    const m = [...page.matchAll(/<h2 class="row-title"><a href="([^"]+)">([^<]*)<\/a>/g)].find((x) => unesc(x[2]) === t.instantiation_dict.title);
    if (!m) throw new Error('post not found by search');
    await c.form(`${m[1]}/comments`, { body: 'In my experience it was worth it once I gave it a full month. Start with the free tier and measure the time you save.' }, m[1]);
  },
  async 'join-groups-of'(t, c) {
    const page = (await c.get(`/${t.instantiation_dict.handle}`)).text;
    const sec = (/<h2 class="card-h">Groups<\/h2>([\s\S]*?)<\/section>/.exec(page) || [])[1] || '';
    for (const m of sec.matchAll(/href="\/group\/([^"]+)"/g)) await c.form(`/group/${m[1]}/join`, { action: 'join' }, `/group/${m[1]}`);
  },
  async 'no-self-promo-post'(t, c) {
    const { group, ask } = t.instantiation_dict;
    const g = await groupSlug(c, group);
    await c.form('/new', { title: `Question for other founders: ${ask}?`.slice(0, 150), body: `Curious ${ask}. What has worked for you, and what did you stop doing?`, group: g, product: '' }, '/new');
  },
  async 'follow-top-founder'(t, c) {
    const page = (await c.get(`/products?topic=${TOPIC_SLUG[t.instantiation_dict.topic]}&sort=revenue`)).text;
    const slug = (/href="\/product\/([^"]+)"/.exec(page.split('<main')[1] || page) || [])[1];
    const prod = (await c.get(`/product/${slug}`)).text;
    const h = (/<p class="eyebrow">Founder<\/p>\s*<a class="founder-top" href="\/([^"]+)"/.exec(prod) || [])[1];
    if (!h) throw new Error('no founder');
    await c.form('/follow', { handle: h, on: '1' }, `/product/${slug}`);
  },
};

const SOLVERS = { devblog, micro, makers };
const LABEL = Object.fromEntries(require('../../../world/spec/topics.json').topics.map((x) => [x.id, x.label]));
// the conversation with @handle in the micro messages list
async function dmThread(c, handle, { unread = false } = {}) {
  const html = (await c.get('/messages')).text;
  for (const m of html.matchAll(/<a class="dm-row([^"]*)" href="\/messages\/(\d+)"[\s\S]*?<span class="muted">@([^ <]+) &middot;/g)) {
    if (m[3].toLowerCase() === handle.toLowerCase() && (!unread || /unread/.test(m[1]))) return +m[2];
  }
  throw new Error(`no ${unread ? 'unread ' : ''}conversation with @${handle}`);
}

async function main() {
  const { values: a } = parseArgs({ options: { site: { type: 'string' }, tasks: { type: 'string' }, per: { type: 'string', default: '2' }, only: { type: 'string' } } });
  const site = a.site;
  if (!L.SITES[site]) throw new Error('--site devblog|micro|makers');
  const grade = require(`../../../sites/${site}/grade`);
  const srv = require(`../../../sites/${site}/server.js`);
  const s = await srv.start({ tenants: 1, port: 0, data: L.dataDir(site), bind: 'ports', uploads: fs.mkdtempSync(path.join(process.env.WSB_TMP || os.tmpdir(), `wsb-${site}solve-`)), jobTickMs: 50 });
  const base = s.url(0).replace(/\/$/, '');
  const query = kit.grader.remoteQuery(base, { tenant: 0 });
  const only = a.only ? new Set(a.only.split(',')) : null;
  const tasks = fs.readFileSync(a.tasks || path.join(__dirname, '..', '..', site, 'generated.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((t) => t.kind === 'write');
  const seen = new Map();
  let pass = 0, fail = 0;
  for (const t of tasks) {
    const name = t.template.replace(`gen-${site}-`, '');
    if ((seen.get(name) || 0) >= +a.per || !SOLVERS[site][name] || (only && !only.has(name))) continue;
    seen.set(name, (seen.get(name) || 0) + 1);
    await rl(base, '/reset', { frozen: true });
    const c = new NetClient(base);
    try {
      await c.login(t.login_user);
      await SOLVERS[site][name](t, c, query);
      await rl(base, '/clock', { advance: 120 });
      const g = await grade(t, { answer: '', query });
      if (g.pass === true) pass++; else { fail++; console.log('FAIL', t.task_id, JSON.stringify(g.checks).slice(0, 400)); }
    } catch (e) { fail++; console.log('ERROR', t.task_id, e.message); }
  }
  await s.close();
  const missing = [...new Set(tasks.map((t) => t.template.replace(`gen-${site}-`, '')))].filter((n) => !SOLVERS[site][n]);
  console.log(`${site}: solved ${pass}, failed ${fail} (${seen.size} templates)${missing.length ? `; no solver: ${missing.join(', ')}` : ''}`);
  process.exit(fail || missing.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
