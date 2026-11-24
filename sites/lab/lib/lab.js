'use strict';
// Shared helpers for the lab site: scenario knobs (with per-record defaults), date formatting, nav.
const kit = require('../../../kit');

const NAV = [
  { id: 'home', label: 'Home', href: '/' },
  { id: 'chat', label: 'Chat', href: '/chat' },
  { id: 'ops', label: 'Ops queues', href: '/ops' },
  { id: 'docs', label: 'Planning docs', href: '/docs' },
  { id: 'kb', label: 'Playbooks', href: '/kb' },
  { id: 'crm', label: 'Accounts', href: '/crm/accounts' },
  { id: 'directory', label: 'Directory', href: '/crm/directory' },
  { id: 'billing', label: 'Billing', href: '/billing/invoices' },
  { id: 'releases', label: 'Releases', href: '/releases' },
  { id: 'parts', label: 'Spare parts', href: '/parts' },
  { id: 'vendors', label: 'Vendors', href: '/vendors' },
  { id: 'markets', label: 'Markets', href: '/markets' },
  { id: 'travel', label: 'Travel', href: '/travel' },
  { id: 'reports', label: 'Reports', href: '/reports' },
  { id: 'imports', label: 'Imports', href: '/data/imports' },
  { id: 'expenses', label: 'Expenses', href: '/expenses' },
  { id: 'events', label: 'Events', href: '/events' },
  { id: 'admin', label: 'Admin', href: '/admin/members' },
  { id: 'developers', label: 'Developers', href: '/developers' },
];
const sectionOf = (url) => {
  const p = String(url).split('?')[0];
  if (p === '/') return 'home';
  if (p.startsWith('/crm/directory')) return 'directory';
  if (p.startsWith('/crm')) return 'crm';
  if (p.startsWith('/data')) return 'imports';
  const first = p.split('/')[1];
  return NAV.find((n) => n.id === first) ? first : first === 'billing' ? 'billing' : null;
};

// ---- scenario knobs. Every knob has a deterministic default per record, so pages work without one.
const LIST_KINDS = ['unmount', 'recycle', 'pinned', 'sections', 'grid'];
const EDITORS = ['shadow', 'contenteditable', 'textarea'];
const SOURCES = ['inline', 'api', 'bundle'];
const sc = () => kit.scenario();
const pickOf = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

function listCfg(queue) {
  const s = sc();
  const w = s.widgets || {};
  const kind = pickOf(w.queue, LIST_KINDS, queue.widget);
  const scroll = kind === 'grid' ? 'page' : pickOf(s.scroll, ['container', 'page'], queue.id % 3 === 0 ? 'page' : 'container');
  const rowH = Number.isInteger(s.row_height) && s.row_height >= 32 && s.row_height <= 120 ? s.row_height : 52;
  return { kind, scroll, rowH };
}
const editorFor = (channel) => pickOf((sc().widgets || {}).editor, EDITORS, channel.editor);
const paneFor = () => pickOf(sc().pane, ['open', 'closed'], 'open');
const sourceFor = (account) => pickOf(sc().data_source, SOURCES, account.data_source);
function jobSeconds(id) {
  const s = sc().job_seconds;
  return Number.isInteger(s) && s >= 1 && s <= 300 ? s : 10 + (id * 7) % 51;
}
const rerender = () => sc().rerender !== false;

// ---- dates (all UTC; the site shows UTC times)
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const toDate = (s) => new Date(String(s).replace(' ', 'T') + (String(s).length <= 10 ? 'T00:00:00Z' : 'Z'));
const dayKey = (s) => String(s).slice(0, 10);
function dayLabel(s, now) {
  const d = toDate(s);
  const base = `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  const today = kit.sqlTime(now).slice(0, 10);
  const yest = kit.sqlTime(new Date(now).getTime() - 86400000).slice(0, 10);
  return dayKey(s) === today ? `Today - ${base}` : dayKey(s) === yest ? `Yesterday - ${base}` : base;
}
const hhmm = (s) => String(s).slice(11, 16);
const shortDate = (s) => { const d = toDate(s); return `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---- planted text (rendered with the object it is attached to)
const plantFor = (kind, ref) => kit.sql('SELECT * FROM plants WHERE target_kind = ? AND target_ref = ?').get(kind, String(ref)) || null;

// message row for chat (server render and API)
const msgOut = (m) => ({ id: m.id, user: m.display_name, username: m.username, body: m.body, at: m.created_at, day: dayKey(m.created_at), time: hhmm(m.created_at), plant: m.plant || null });

module.exports = { NAV, sectionOf, LIST_KINDS, EDITORS, SOURCES, listCfg, editorFor, paneFor, sourceFor, jobSeconds, rerender,
  dayLabel, dayKey, hhmm, shortDate, money, toDate, plantFor, msgOut, MONTHS };
