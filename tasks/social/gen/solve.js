#!/usr/bin/env node
'use strict';
// Reference solver for the social write templates: does each task through the site's own forms (the
// requests the UI sends; lists read from the rendered pages where the task is about a listing), then
// grades it -- the positive counterpart of check.js. Two tasks per template by default; the tenant is
// reset between tasks.
//   node tasks/social/gen/solve.js [--tasks FILE] [--per 2]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseArgs } = require('util');
const kit = require('../../../kit');
const grade = require('../../../sites/social/grade');
const { Client, rl } = require('../../../kit/test/helpers');
const L = require('./lib');

const me = (t) => `(SELECT id FROM users WHERE username = ${L.lit(t.login_user)})`;
const postUrl = async (q, id) => { const p = (await q(`SELECT s.id, s.slug, f.name FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.id = ${+id}`))[0]; return `/c/${p.name}/comments/${p.id}/${p.slug}`; };
const postIds = (html) => [...html.matchAll(/<post-card[^>]*id="t3_(\d+)"/g)].map((m) => +m[1]);
const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// a title that passes the space's title-format rule and keeps `core` in it
async function titleFor(c, space, core) {
  const api = (await c.get(`/api/spaces/${space}/flairs`)).json();
  let title = core.replace(/[?.]*$/, '?');
  const rules = api.rules.map((r) => `${r.title} ${r.description}`).join('\n');
  if (/\[Question\]/.test(rules)) title = `[Question] ${title}`;
  if (/ELI5/.test(rules)) title = `ELI5: ${title}`;
  if (title.length < 30) title = `${title.replace(/\?$/, '')}, any thoughts?`;
  return { title, flairs: api.flairs };
}

const SOLVERS = {
  async 'reply-newest-unanswered'(t, c, q) {
    const page = (await c.get(`/c/${t.instantiation_dict.space}/new`)).text;
    // newest first; the comment count is on each card
    const cards = [...page.matchAll(/<post-card[^>]*id="t3_(\d+)"[\s\S]*?<\/post-card>/g)];
    for (const m of cards) {
      const p = (await q(`SELECT title, comment_count FROM submissions WHERE id = ${m[1]}`))[0];
      if (!/\?\s*$/.test(p.title)) continue;
      if ((await q(`SELECT count(*) n FROM comments WHERE submission_id = ${m[1]}`))[0].n) continue;
      const url = await postUrl(q, m[1]);
      return c.form(`${url}/comment`, { body: 'Good question. In my experience the simplest option works best, start small and see how it goes.' }, url);
    }
    throw new Error('no unanswered question on the page');
  },
  async 'post-with-flair'(t, c) {
    const { space, flair, ask } = t.instantiation_dict;
    const { title, flairs } = await titleFor(c, space, `Looking for ${ask}`);
    const f = flairs.find((x) => x.name === flair);
    return c.form('/submit', { space, type: 'text', title, body: `Hi all, I would love some ${ask}. Thanks!`, flair_id: String(f.id) }, `/submit?space=${space}`);
  },
  async 'no-self-promo-post'(t, c) {
    const { space, topic } = t.instantiation_dict;
    const { title, flairs } = await titleFor(c, space, `How do you approach ${topic.replace(/^how /, '')}`);
    return c.form('/submit', { space, type: 'text', title, body: `Curious how others here handle ${topic}. What has worked for you, and what did you stop doing?`, flair_id: flairs.length ? String(flairs[0].id) : '' }, `/submit?space=${space}`);
  },
  async 'reply-unread-replies'(t, c, q) {
    const p = (await q(`SELECT id FROM submissions WHERE user_id = ${me(t)} AND title = ${L.lit(t.instantiation_dict.title)}`))[0];
    const page = (await c.get('/notifications?filter=unread')).text;
    const url = await postUrl(q, p.id);
    const cids = [...page.matchAll(/name="go" value="[^"]*\/comments\/(\d+)\/[^"/]+\/(\d+)"/g)].filter((m) => +m[1] === p.id).map((m) => +m[2]);
    if (!cids.length) throw new Error('no unread replies on the notifications page');
    for (const id of cids) await c.form(`${url}/comment`, { body: 'Thanks for the reply, that helps!', parent_id: String(id) }, url);
  },
  async 'upvote-user-comments'(t, c, q) {
    const { title, user } = t.instantiation_dict;
    const id = (await q(`SELECT id FROM submissions WHERE title = ${L.lit(title)} AND visibility = 'visible'`))[0].id;
    const url = await postUrl(q, id);
    const page = (await c.get(url)).text;
    // top-level comment nodes carry depth 0
    const top = [...page.matchAll(/<comment-node id="t1_(\d+)" depth="0" author="([^"]*)"/g)].filter((m) => m[2] === user).map((m) => m[1]);
    if (!top.length) throw new Error('no top-level comments found on the page');
    for (const cid of top) await c.form('/vote', { thing: `t1_${cid}`, dir: '1' }, url);
  },
  async 'join-mod-spaces'(t, c) {
    const page = (await c.get(`/u/${t.instantiation_dict.user}`)).text;
    const sec = /Moderator of<\/h2>([\s\S]*?)<\/section>/.exec(page)[1];
    for (const m of sec.matchAll(/href="\/c\/([^"]+)"/g)) await c.form(`/c/${m[1]}/join`, { action: 'join' }, `/c/${m[1]}`);
  },
  async 'save-top-flair'(t, c) {
    const { space, flair, win } = t.instantiation_dict;
    const f = (await c.get(`/api/spaces/${space}/flairs`)).json().flairs.find((x) => x.name === flair);
    const ids = postIds((await c.get(`/c/${space}/top?t=${win.split(' ')[1]}&flair=${f.id}`)).text).slice(0, 3);
    for (const id of ids) await c.form('/save', { thing: `t3_${id}`, saved: '1' }, `/c/${space}`);
  },
  async 'message-mods'(t, c) {
    const { space, subject, n } = t.instantiation_dict;
    const page = (await c.get(`/c/${space}`)).text;
    const sec = /Moderators<\/h2>([\s\S]*?)<\/section>/.exec(page)[1];
    for (const m of sec.matchAll(/href="\/u\/([^"]+)"/g)) await c.form('/message/compose', { to: m[1], subject, body: `Hi, could you explain how rule ${n} is enforced in c/${space}? Thanks.` }, '/message/compose');
  },
  async 'mod-remove-title-rule'(t, c, q) {
    const { space, d, n } = t.instantiation_dict;
    const rule = (await q(`SELECT param FROM space_rules WHERE forum_id = ${L.sid(space)} AND position = ${+n}`))[0];
    const re = new RegExp(JSON.parse(rule.param).pattern);
    const now = (await rl(c.base, '/clock')).now;
    const from = L.sqlTime(Date.parse(now) - d * 86400000);
    for (const p of await q(`SELECT id, title FROM submissions WHERE forum_id = ${L.sid(space)} AND visibility = 'visible' AND created_at > '${from}'`)) {
      if (re.test(p.title)) continue;
      const url = await postUrl(q, p.id);
      await c.form(`${url}/mod`, { action: 'remove' }, url);
    }
  },
  async 'mod-lock-pin-top'(t, c, q) {
    const { space, win } = t.instantiation_dict;
    const id = postIds((await c.get(`/c/${space}/top?t=${win.split(' ')[1]}`)).text)[0];
    const url = await postUrl(q, id);
    await c.form(`${url}/mod`, { action: 'pin' }, url);
    await c.form(`${url}/mod`, { action: 'lock' }, url);
  },
  async 'follow-commenters'(t, c, q) {
    const id = postIds((await c.get(`/u/${t.login_user}/posts`)).text)[0];
    const url = await postUrl(q, id);
    const page = (await c.get(url)).text;
    const users = new Set([...page.matchAll(/<comment-node id="t1_\d+" depth="\d+" author="([^"]+)"/g)].map((m) => m[1]).filter((u) => u !== t.login_user));
    for (const u of users) await c.form(`/u/${u}/follow`, { action: 'follow' }, `/u/${u}`);
  },
  async 'reply-and-dm-op'(t, c, q) {
    const p = (await q(`SELECT s.id, u.username FROM submissions s JOIN users u ON u.id = s.user_id WHERE s.title = ${L.lit(t.instantiation_dict.title)} AND s.visibility = 'visible'`))[0];
    const url = await postUrl(q, p.id);
    const r = await c.post(`${url}/comment`, { form: { body: 'Here is what worked for me: take it one step at a time and ask locals for tips.', _csrf: await c.csrf(url) }, headers: { accept: 'application/json' } });
    if (r.status !== 200) throw new Error(`comment -> ${r.status}`);
    await c.form('/message/compose', { to: p.username, subject: 'Replied to your post', body: `Hi! I left a reply on your post: ${r.json().url}` }, '/message/compose');
  },
  async 'edit-post-update'(t, c, q) {
    const { title, msg } = t.instantiation_dict;
    const id = (await q(`SELECT id FROM submissions WHERE user_id = ${me(t)} AND title = ${L.lit(title)}`))[0].id;
    const url = await postUrl(q, id);
    const page = (await c.get(`${url}?edit=1`)).text;
    const body = unesc(/<textarea[^>]*name="body"[^>]*>([\s\S]*?)<\/textarea>/.exec(page)[1]);
    await c.form(`${url}/edit`, { body: `${body.trim()}\n\nUpdate: ${msg}` }, url);
  },
};

class SocialClient extends Client {
  async form(p, fields, from = '/') {
    const r = await this.post(p, { form: { ...fields, _csrf: await this.csrf(from) } });
    if (r.status >= 400) throw new Error(`POST ${p} -> ${r.status} ${(/class="(?:form-error|banner)[^"]*"[^>]*>([\s\S]{0,200})/.exec(r.text) || [])[1] || ''}`);
    return r;
  }
}

async function main() {
  const { values: a } = parseArgs({ options: { tasks: { type: 'string', default: path.join(__dirname, '..', 'generated.jsonl') }, per: { type: 'string', default: '2' }, only: { type: 'string' } } });
  const site = require('../../../sites/social/server.js');
  const s = await site.start({ tenants: 1, port: 0, data: L.DATA, bind: 'ports', uploads: fs.mkdtempSync(path.join(process.env.WSB_TMP || os.tmpdir(), 'wsb-socialsolve-')), jobTickMs: 50 });
  const base = s.url(0);
  const query = kit.grader.remoteQuery(base, { tenant: 0 });
  const only = a.only ? new Set(a.only.split(',')) : null;
  const tasks = fs.readFileSync(a.tasks, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((t) => t.kind === 'write');
  const seen = new Map();
  let pass = 0, fail = 0;
  for (const t of tasks) {
    const name = t.template.replace(/^gen-social-/, '');
    if ((seen.get(name) || 0) >= +a.per || !SOLVERS[name] || (only && !only.has(name))) continue;
    seen.set(name, (seen.get(name) || 0) + 1);
    await rl(base, '/reset', { frozen: true });
    const c = new SocialClient(base);
    await c.login(t.login_user);
    try {
      await SOLVERS[name](t, c, query);
      await rl(base, '/clock', { advance: 120 });
      const g = await grade(t, { answer: '', query });
      if (g.pass === true) pass++; else { fail++; console.log('FAIL', t.task_id, JSON.stringify(g.checks).slice(0, 400)); }
    } catch (e) { fail++; console.log('ERROR', t.task_id, e.message); }
  }
  await s.close();
  const missing = [...new Set(tasks.map((t) => t.template.replace(/^gen-social-/, '')))].filter((n) => !SOLVERS[n]);
  console.log(`solved ${pass}, failed ${fail}${missing.length ? `; no solver: ${missing.join(', ')}` : ''}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
