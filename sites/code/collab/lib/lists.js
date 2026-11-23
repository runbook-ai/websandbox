'use strict';
const CW = require('../../lib/widgets');
// Issue / merge request lists with GitLab's URL parameters (project, group and dashboard scope):
//   state=opened|closed|all (MRs also merged)       search=<words> [in=title|description]
//   author_username=  assignee_username= (or assignee_username[]=, assignee_id=None|Any)
//   label_name[]= (AND; None = no labels, Any = some label)   not[label_name][]=  not[author_username]=
//   milestone_title= (None|Any|Upcoming|Started|<title>)   confidential=yes|no   my_reaction_emoji=
//   due_date=0|any|overdue|week|month|next_month_and_previous_two_weeks
//   MRs: reviewer_username=  source_branch=  target_branch=  draft=yes|no  approved_by_usernames[]=
//   sort=created_date|created_asc|updated_desc|updated_asc|due_date|due_date_desc|milestone_due_asc|
//        milestone_due_desc|popularity|popularity_asc|label_priority|priority|title_asc|title_desc|
//        merged_at_desc|merged_at_asc|closed_at_desc|closed_at_asc   page=  per_page=
const kit = require('../../../../kit');
const U = require('./util');

const SORTS = {
  created_date: 't.created_at DESC', created_desc: 't.created_at DESC', created_asc: 't.created_at ASC',
  updated_desc: 't.updated_at DESC', updated_asc: 't.updated_at ASC',
  due_date: 't.due_date IS NULL, t.due_date ASC', due_date_asc: 't.due_date IS NULL, t.due_date ASC', due_date_desc: 't.due_date IS NULL, t.due_date DESC',
  milestone_due_asc: 'ms.due_date IS NULL, ms.due_date ASC', milestone_due_desc: 'ms.due_date IS NULL, ms.due_date DESC', milestone: 'ms.due_date IS NULL, ms.due_date ASC',
  popularity: 't.upvotes DESC', popularity_desc: 't.upvotes DESC', popularity_asc: 't.upvotes ASC',
  label_priority: 'lprio IS NULL, lprio ASC', label_priority_asc: 'lprio IS NULL, lprio ASC', label_priority_desc: 'lprio IS NULL, lprio DESC',
  priority: 'ms.due_date IS NULL, ms.due_date ASC, lprio IS NULL, lprio ASC', priority_asc: 'ms.due_date IS NULL, ms.due_date ASC, lprio IS NULL, lprio ASC',
  title_asc: 't.title COLLATE NOCASE ASC', title_desc: 't.title COLLATE NOCASE DESC',
  merged_at_desc: 't.merged_at DESC', merged_at_asc: 't.merged_at ASC', merged_at: 't.merged_at DESC',
  closed_at_desc: 't.closed_at DESC', closed_at_asc: 't.closed_at ASC', closed_at: 't.closed_at DESC',
  relative_position: 't.id ASC', relative_position_asc: 't.id ASC', weight: 't.weight IS NULL, t.weight ASC', weight_asc: 't.weight IS NULL, t.weight ASC', weight_desc: 't.weight DESC',
};
const SORT_LABELS = {
  issue: [['created_date', 'Created date'], ['created_asc', 'Created date (oldest)'], ['updated_desc', 'Updated date'], ['updated_asc', 'Updated date (oldest)'],
    ['priority', 'Priority'], ['label_priority', 'Label priority'], ['milestone_due_asc', 'Milestone due date'], ['due_date', 'Due date'], ['due_date_desc', 'Due date (latest)'],
    ['popularity', 'Popularity'], ['title_asc', 'Title'], ['title_desc', 'Title (Z-A)']],
  merge_request: [['created_date', 'Created date'], ['created_asc', 'Created date (oldest)'], ['updated_desc', 'Updated date'], ['updated_asc', 'Updated date (oldest)'],
    ['merged_at_desc', 'Merged date'], ['closed_at_desc', 'Closed date'], ['priority', 'Priority'], ['label_priority', 'Label priority'], ['milestone_due_asc', 'Milestone due date'],
    ['popularity', 'Popularity'], ['title_asc', 'Title'], ['title_desc', 'Title (Z-A)']],
};

const CFG = {
  issue: { table: 'issues', assignees: ['issue_assignees', 'issue_id'], states: ['opened', 'closed', 'all'] },
  merge_request: { table: 'merge_requests', assignees: ['mr_assignees', 'merge_request_id'], states: ['opened', 'merged', 'closed', 'all'] },
};

const userId = (name) => kit.sql('SELECT id FROM users WHERE username = ?').pluck().get(name) ?? -1;

// scope: { projectId } | { projectIds: [..] } | { dashboard: true, user }
function build(kind, query, scope) {
  const c = CFG[kind];
  const where = []; const params = []; const active = [];
  const q = query || {};
  if (scope.projectId) { where.push('t.project_id = ?'); params.push(scope.projectId); }
  else if (scope.projectIds) { where.push(`t.project_id IN (${scope.projectIds.map(() => '?').join(',') || 'NULL'})`); params.push(...scope.projectIds); }
  if (scope.visible) { where.push(scope.visible.sql); params.push(...scope.visible.params); }
  // confidential issues are hidden from users who may not see them
  if (kind === 'issue' && scope.confidentialFilter) { where.push(scope.confidentialFilter.sql); params.push(...scope.confidentialFilter.params); }

  const add = (name, label, value, sql, ...p) => { where.push(sql); params.push(...p); active.push({ name, label, value }); };
  const author = U.str(q.author_username);
  if (author) add('author_username', 'Author', author, 't.author_id = ?', userId(author));
  const notAuthor = U.str(q['not[author_username]']);
  if (notAuthor) add('not[author_username]', 'Author is not', notAuthor, 'coalesce(t.author_id, 0) != ?', userId(notAuthor));
  const [at, ac] = c.assignees;
  const assignees = U.qlist(q, 'assignee_username');
  const aid = U.str(q.assignee_id);
  if (aid.toLowerCase() === 'none' || assignees.some((a) => a.toLowerCase() === 'none')) add('assignee_id', 'Assignee', 'None', `NOT EXISTS (SELECT 1 FROM ${at} WHERE ${ac} = t.id)`);
  else if (aid.toLowerCase() === 'any' || assignees.some((a) => a.toLowerCase() === 'any')) add('assignee_id', 'Assignee', 'Any', `EXISTS (SELECT 1 FROM ${at} WHERE ${ac} = t.id)`);
  else for (const a of assignees) add('assignee_username', 'Assignee', a, `t.id IN (SELECT ${ac} FROM ${at} WHERE user_id = ?)`, userId(a));
  if (aid && /^\d+$/.test(aid)) add('assignee_id', 'Assignee', aid, `t.id IN (SELECT ${ac} FROM ${at} WHERE user_id = ?)`, +aid);
  for (const a of U.qlist(q, 'not[assignee_username]')) add('not[assignee_username]', 'Assignee is not', a, `t.id NOT IN (SELECT ${ac} FROM ${at} WHERE user_id = ?)`, userId(a));
  if (kind === 'merge_request') {
    const rev = U.str(q.reviewer_username);
    const rid = U.str(q.reviewer_id);
    if (rev.toLowerCase() === 'none' || rid.toLowerCase() === 'none') add('reviewer_id', 'Reviewer', 'None', 'NOT EXISTS (SELECT 1 FROM mr_reviewers WHERE merge_request_id = t.id)');
    else if (rev.toLowerCase() === 'any' || rid.toLowerCase() === 'any') add('reviewer_id', 'Reviewer', 'Any', 'EXISTS (SELECT 1 FROM mr_reviewers WHERE merge_request_id = t.id)');
    else if (rev) add('reviewer_username', 'Reviewer', rev, 't.id IN (SELECT merge_request_id FROM mr_reviewers WHERE user_id = ?)', userId(rev));
    const sb = U.str(q.source_branch); if (sb) add('source_branch', 'Source branch', sb, 't.source_branch = ?', sb);
    const tb = U.str(q.target_branch); if (tb) add('target_branch', 'Target branch', tb, 't.target_branch = ?', tb);
    const dr = U.str(q.draft || q.wip).toLowerCase();
    if (dr === 'yes') add('draft', 'Draft', 'Yes', 't.draft = 1'); else if (dr === 'no') add('draft', 'Draft', 'No', 't.draft = 0');
    for (const a of U.qlist(q, 'approved_by_usernames')) add('approved_by_usernames', 'Approved by', a, 't.id IN (SELECT merge_request_id FROM mr_approvals WHERE user_id = ?)', userId(a));
  }
  // labels (titles; resolved per scope)
  const labels = U.qlist(q, 'label_name');
  const labelScope = scope.labelIds || null; // function(title) -> ids, for project scope
  const idsFor = (title) => (labelScope ? labelScope(title) : kit.sql('SELECT id FROM labels WHERE title = ?').pluck().all(title));
  for (const l of labels) {
    if (l.toLowerCase() === 'none') add('label_name', 'Label', 'None', 'NOT EXISTS (SELECT 1 FROM label_links WHERE target_type = ? AND target_id = t.id)', kind);
    else if (l.toLowerCase() === 'any') add('label_name', 'Label', 'Any', 'EXISTS (SELECT 1 FROM label_links WHERE target_type = ? AND target_id = t.id)', kind);
    else {
      const ids = idsFor(l);
      add('label_name', 'Label', l, ids.length ? `EXISTS (SELECT 1 FROM label_links WHERE target_type = ? AND target_id = t.id AND label_id IN (${ids.join(',')}))` : '0', ...(ids.length ? [kind] : []));
    }
  }
  for (const l of U.qlist(q, 'not[label_name]')) {
    const ids = idsFor(l);
    if (ids.length) add('not[label_name]', 'Label is not', l, `NOT EXISTS (SELECT 1 FROM label_links WHERE target_type = ? AND target_id = t.id AND label_id IN (${ids.join(',')}))`, kind);
  }
  const ms = U.str(q.milestone_title);
  if (ms) {
    const low = ms.toLowerCase();
    if (low === 'none') add('milestone_title', 'Milestone', 'None', 't.milestone_id IS NULL');
    else if (low === 'any') add('milestone_title', 'Milestone', 'Any', 't.milestone_id IS NOT NULL');
    else if (low === 'upcoming') add('milestone_title', 'Milestone', 'Upcoming', "t.milestone_id IN (SELECT id FROM milestones WHERE state = 'active' AND due_date > date(now()))");
    else if (low === 'started') add('milestone_title', 'Milestone', 'Started', "t.milestone_id IN (SELECT id FROM milestones WHERE state = 'active' AND start_date <= date(now()))");
    else add('milestone_title', 'Milestone', ms, 't.milestone_id IN (SELECT id FROM milestones WHERE title = ?)', ms);
  }
  const conf = U.str(q.confidential).toLowerCase();
  if (kind === 'issue' && conf === 'yes') add('confidential', 'Confidential', 'Yes', 't.confidential = 1');
  if (kind === 'issue' && conf === 'no') add('confidential', 'Confidential', 'No', 't.confidential = 0');
  const emoji = U.str(q.my_reaction_emoji);
  if (emoji && scope.user) {
    if (emoji.toLowerCase() === 'none') add('my_reaction_emoji', 'My reaction', 'None', 'NOT EXISTS (SELECT 1 FROM award_emoji WHERE awardable_type = ? AND awardable_id = t.id AND user_id = ?)', kind, scope.user.id);
    else add('my_reaction_emoji', 'My reaction', emoji, 'EXISTS (SELECT 1 FROM award_emoji WHERE awardable_type = ? AND awardable_id = t.id AND user_id = ? AND name = ?)', kind, scope.user.id, emoji);
  }
  const due = U.str(q.due_date);
  if (kind === 'issue' && due) {
    const m = { 0: ['No due date', 't.due_date IS NULL'], none: ['No due date', 't.due_date IS NULL'], any: ['Any due date', 't.due_date IS NOT NULL'],
      overdue: ['Overdue', 't.due_date < date(now())'], week: ['Due this week', "t.due_date BETWEEN date(now(), 'weekday 0', '-6 days') AND date(now(), 'weekday 0')"],
      month: ['Due this month', "t.due_date BETWEEN date(now(), 'start of month') AND date(now(), 'start of month', '+1 month', '-1 day')"],
      next_month_and_previous_two_weeks: ['Due next month and previous two weeks', "t.due_date BETWEEN date(now(), '-14 days') AND date(now(), 'start of month', '+2 months', '-1 day')"] }[due];
    if (m) add('due_date', 'Due date', m[0], m[1]);
  }
  const iids = U.qlist(q, 'iids');
  if (iids.length) add('iids', 'IID', iids.join(', '), `t.iid IN (${iids.map(() => '?').join(',')})`, ...iids.map(Number));
  // text search (GitLab: words of >= 3 chars must each appear in title or description; "#12" = iid)
  const search = U.str(q.search);
  if (search) {
    const inCol = U.str(q.in).toLowerCase();
    const cols = inCol === 'title' ? ['t.title'] : inCol === 'description' ? ['t.description'] : ['t.title', 't.description'];
    const m = /^[#!](\d+)$/.exec(search);
    if (m) add('search', 'Search', search, 't.iid = ?', +m[1]);
    else {
      let words = search.match(/"[^"]+"|\S+/g).map((w) => w.replace(/^"|"$/g, ''));
      const long = words.filter((w) => w.length >= 3);
      words = long.length ? long : [search];
      const clauses = words.map(() => `(${cols.map((col) => `${col} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      const p = words.flatMap((w) => cols.map(() => `%${w.replace(/[\\%_]/g, (x) => '\\' + x)}%`));
      where.push(clauses.join(' AND ')); params.push(...p); active.push({ name: 'search', label: 'Search', value: search });
    }
  }
  return { where: where.length ? where.join(' AND ') : '1', params, active };
}

function stateWhere(kind, state) {
  if (state === 'all') return '1';
  if (kind === 'merge_request' && state === 'closed') return "t.state IN ('closed')";
  if (kind === 'merge_request' && state === 'opened') return "t.state IN ('opened','locked')";
  return `t.state = '${state === 'closed' ? 'closed' : state === 'merged' ? 'merged' : 'opened'}'`;
}

// counts per state + one page of rows
function list(kind, req, scope, { perPage = 20 } = {}) {
  const c = CFG[kind];
  const query = req.query || {};
  const f = build(kind, query, scope);
  let state = U.str(query.state) || 'opened';
  if (!c.states.includes(state)) state = 'opened';
  const counts = {};
  const countSql = (st) => `SELECT count(*) FROM ${c.table} t WHERE ${f.where} AND ${stateWhere(kind, st)}`;
  for (const st of c.states) counts[st] = kit.sql(countSql(st)).pluck().get(...f.params);
  const total = counts[state];
  const sortKey = SORTS[U.str(query.sort)] ? U.str(query.sort) : 'created_date';
  let orderBy = SORTS[sortKey];
  const needMs = /ms\./.test(orderBy); const needPrio = /lprio/.test(orderBy);
  const pager = kit.paginate(req, total, { perPage, cap: 1000000 });
  const rows = kit.sql(`SELECT t.*${needPrio ? `, (SELECT min(lp.priority) FROM label_links ll JOIN label_priorities lp ON lp.label_id = ll.label_id AND lp.project_id = t.project_id WHERE ll.target_type = '${kind}' AND ll.target_id = t.id) AS lprio` : ''}
    FROM ${c.table} t ${needMs ? 'LEFT JOIN milestones ms ON ms.id = t.milestone_id' : ''}
    WHERE ${f.where} AND ${stateWhere(kind, state)} ORDER BY ${orderBy}, t.id DESC LIMIT ? OFFSET ?`).all(...f.params, pager.limit, pager.offset);
  decorate(kind, rows);
  const out = { rows, counts, state, total, pager, sort: sortKey, sortOptions: SORT_LABELS[kind], active: f.active };
  // ---- widget slots (../../lib/widgets.js): `vw` = the next ISSUES_WINDOW items as one list, `chunk`
  // = a chunk of it (?_w=rows), `countsJs` = the state counts come from ?_w=counts (`countsJson`)
  const iw = kit.widget('issues');
  if (iw) {
    const n = Math.max(0, Math.min(CW.ISSUES_WINDOW, total - pager.offset));
    if (query._w === 'rows') {
      const { offset, limit } = kit.widgets.range(req, { max: 100, dflt: 50 });
      const part = kit.sql(`SELECT t.*${needPrio ? `, (SELECT min(lp.priority) FROM label_links ll JOIN label_priorities lp ON lp.label_id = ll.label_id AND lp.project_id = t.project_id WHERE ll.target_type = '${kind}' AND ll.target_id = t.id) AS lprio` : ''}
        FROM ${c.table} t ${needMs ? 'LEFT JOIN milestones ms ON ms.id = t.milestone_id' : ''}
        WHERE ${f.where} AND ${stateWhere(kind, state)} ORDER BY ${orderBy}, t.id DESC LIMIT ? OFFSET ?`).all(...f.params, Math.max(0, Math.min(limit, n - offset)), pager.offset + offset);
      out.chunk = { total: n, rows: decorate(kind, part) };
    } else if (n) {
      out.vw = kit.widgets.vlist({ src: kit.urlWith(req, { _w: 'rows' }), total: n, kind: iw, est: 64, chunk: 50, label: kind === 'merge_request' ? 'Merge requests' : 'Issues',
        lineTag: 'ul', lineClass: `issuable-list ${kind === 'merge_request' ? 'mr-list' : 'issues-list'}` });
    }
  }
  if (kit.widget('counts') === 'js') {
    out.countsJs = true;
    out.countsSrc = kit.urlWith(req, { _w: 'counts', page: null });
    if (query._w === 'counts') {
      const num = require('../../lib/code').fmtNum;
      out.countsJson = { ...Object.fromEntries(c.states.map((st) => [`count-${st}`, num(counts[st])])), 'count-total': num(total) };
    }
  }
  return out;
}

// bulk-load labels / assignees / reviewers / milestone / author / project for rows
function decorate(kind, rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id); const ph = ids.map(() => '?').join(',');
  const by = (list, key) => { const m = new Map(); for (const x of list) { if (!m.has(x[key])) m.set(x[key], []); m.get(x[key]).push(x); } return m; };
  const labels = by(kit.sql(`SELECT ll.target_id, l.id, l.title, l.color, l.description, l.project_id, l.group_id FROM label_links ll JOIN labels l ON l.id = ll.label_id
    WHERE ll.target_type = ? AND ll.target_id IN (${ph}) ORDER BY l.title COLLATE NOCASE`).all(kind, ...ids), 'target_id');
  const [at, ac] = CFG[kind].assignees;
  const assignees = by(kit.sql(`SELECT a.${ac} AS tid, u.id, u.username, u.name, u.avatar FROM ${at} a JOIN users u ON u.id = a.user_id WHERE a.${ac} IN (${ph})`).all(...ids), 'tid');
  const reviewers = kind === 'merge_request' ? by(kit.sql(`SELECT r.merge_request_id AS tid, r.state, u.id, u.username, u.name, u.avatar FROM mr_reviewers r JOIN users u ON u.id = r.user_id WHERE r.merge_request_id IN (${ph})`).all(...ids), 'tid') : new Map();
  const approvals = kind === 'merge_request' ? new Map(kit.sql(`SELECT merge_request_id, count(*) n FROM mr_approvals WHERE merge_request_id IN (${ph}) GROUP BY 1`).all(...ids).map((r) => [r.merge_request_id, r.n])) : new Map();
  const uids = [...new Set(rows.map((r) => r.author_id).filter(Boolean))];
  const users = new Map(uids.length ? kit.sql(`SELECT id, username, name, avatar FROM users WHERE id IN (${uids.map(() => '?').join(',')})`).all(...uids).map((u) => [u.id, u]) : []);
  const mids = [...new Set(rows.map((r) => r.milestone_id).filter(Boolean))];
  const mss = new Map(mids.length ? kit.sql(`SELECT id, iid, title, due_date, state, project_id, group_id FROM milestones WHERE id IN (${mids.map(() => '?').join(',')})`).all(...mids).map((m) => [m.id, m]) : []);
  const pids = [...new Set(rows.map((r) => r.project_id))];
  const projs = new Map(kit.sql(`SELECT p.id, p.full_path, p.name, n.name AS ns_name FROM projects p JOIN namespaces n ON n.id = p.namespace_id WHERE p.id IN (${pids.map(() => '?').join(',')})`).all(...pids).map((p) => [p.id, p]));
  for (const r of rows) {
    r.labels = labels.get(r.id) || []; r.assignees = assignees.get(r.id) || []; r.reviewers = reviewers.get(r.id) || [];
    r.approvals = approvals.get(r.id) || 0;
    r.author = users.get(r.author_id) || null; r.milestone = mss.get(r.milestone_id) || null; r.project = projs.get(r.project_id);
  }
  return rows;
}

module.exports = { build, list, decorate, SORTS, SORT_LABELS, stateWhere };
