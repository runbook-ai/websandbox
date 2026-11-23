'use strict';
// Family D: editors and forms, graded on the outcome only. The chat composer is a controlled editor
// (shadow DOM / contenteditable / textarea, scenario); a draft must be saved and not sent; the expense
// form is slow and keeps no dedupe (submit exactly once); registration forms are single-use and rate
// limited (each attendee exactly once).
const L = require('./lib');

const editor = (r) => ({ widgets: { editor: r.pick(['shadow', 'contenteditable', 'textarea']) } });
const chans = () => L.all("SELECT id, name FROM channels WHERE name NOT IN (SELECT c.name FROM channels c JOIN messages m ON m.channel_id = c.id JOIN plants p ON p.placement = 'chat' AND p.target_ref = CAST(m.id AS TEXT)) ORDER BY id");
const CATS = ['Travel', 'Meals', 'Software', 'Hardware', 'Training', 'Office supplies'];
const MERCH = ['Cobble Street Cafe', 'Northline Rail', 'Pinewood Hotel', 'Brightdesk Supply', 'Harbor Taxi', 'Copperpot Kitchen', 'Ridgeway Air', 'Quillworks Stationery', 'Glasswing Electronics', 'Bellcrest Training'];
const DESC = ['Client dinner', 'Train to the customer site', 'Hotel for the offsite', 'Team lunch', 'Conference ticket', 'Replacement keyboard',
  'Annual license renewal', 'Taxi from the airport', 'Workshop materials', 'Printer paper and toner', 'Monitor cable', 'Course fee'];
const FIRST = ['Aurelio', 'Bettina', 'Corwin', 'Delphine', 'Evander', 'Florentyna', 'Gaspard', 'Henrike', 'Ilario', 'Jolanda', 'Kasimir', 'Leocadia', 'Marek', 'Noemi', 'Osric', 'Perpetua'];
const LAST = ['Achterberg', 'Bellweather', 'Castellan', 'Drummond', 'Etherington', 'Fairweather', 'Goodspeed', 'Hawthorne', 'Inglewood', 'Kingsley', 'Larkin', 'Merriweather'];
const TEAMS = ['Platform', 'Payments', 'Mobile', 'Data', 'Support', 'Design', 'Sales', 'Finance'];
const DIET = ['None', 'Vegetarian', 'Vegan', 'Gluten-free', 'Nut allergy'];

module.exports = [
  {
    name: 'chat-post', kind: 'write', skills: ['create', 'form-edit'], difficulty: 2, max: 130,
    phrasings: [
      'Post this message in #{{channel}}: {{text}}',
      'Send the following to the #{{channel}} channel: {{text}}',
      'In #{{channel}}, write and send exactly this message: {{text}}',
    ],
    *generate(r) {
      const cs = chans();
      for (let k = 0; k < 400; k++) {
        const c = r.pick(cs);
        const text = L.message(r, { long: r.chance(0.5) });
        const me = L.loginFor(r);
        yield { slots: { channel: c.name, text }, login_user: me, start_url: '__LAB__/chat', scenario: editor(r),
          eval: { type: 'state', state_sql: `SELECT (SELECT count(*) FROM messages WHERE source = 'site' AND user_id = ${L.uid(me)} AND channel_id = ${L.cid(c.name)} AND trim(body) = ${L.lit(text)}) AS posted,
            (SELECT count(*) FROM messages WHERE source = 'site') AS total`, state_expect: [{ posted: 1, total: 1 }] },
          changes: [`${text.length} chars`] };
      }
    },
  },
  {
    name: 'chat-draft', kind: 'write', skills: ['form-edit'], difficulty: 2, max: 130, heldout: 'template',
    phrasings: [
      'Write a message in #{{channel}} saying: {{text}} Do not send it yet; leave it as a draft so I can review it.',
      'Draft this for #{{channel}} but keep it unsent: {{text}}',
      'Prepare (but don\'t post) a message in #{{channel}} that reads: {{text}}',
    ],
    *generate(r) {
      const cs = chans();
      for (let k = 0; k < 400; k++) {
        const c = r.pick(cs);
        const text = L.message(r, { long: r.chance(0.5) });
        const me = L.loginFor(r);
        yield { slots: { channel: c.name, text }, login_user: me, start_url: `__LAB__/chat/${c.name}`, scenario: editor(r),
          eval: { type: 'state', state_sql: `SELECT (SELECT count(*) FROM drafts WHERE user_id = ${L.uid(me)} AND channel_id = ${L.cid(c.name)} AND trim(body) = ${L.lit(text)}) AS draft,
            (SELECT count(*) FROM messages WHERE source = 'site') AS sent`, state_expect: [{ draft: 1, sent: 0 }] },
          changes: [`${text.length} chars`] };
      }
    },
  },
  {
    name: 'expense-once', kind: 'write', skills: ['create', 'form-edit'], difficulty: 2, max: 130,
    phrasings: [
      'File an expense claim: {{amount}} at {{merchant}} on {{date}}, category {{category}}, description "{{desc}}".',
      'Submit a {{category}} expense of {{amount}} from {{merchant}}, dated {{date}}, with the description "{{desc}}".',
      'I spent {{amount}} at {{merchant}} on {{date}}. Claim it as {{category}} with the description "{{desc}}".',
    ],
    *generate(r) {
      for (let k = 0; k < 400; k++) {
        const cents = r.range(3, 600) * 100 + r.pick([0, 25, 40, 50, 75, 99]);
        const day = L.addDays(L.TODAY, -r.range(1, 40));
        const me = L.loginFor(r);
        const merchant = r.pick(MERCH), category = r.pick(CATS), desc = r.pick(DESC);
        yield { slots: { amount: L.money(cents), merchant, date: L.longDay(day).replace(/^\w+, /, ''), category, desc }, login_user: me, start_url: '__LAB__/expenses',
          eval: { type: 'state', state_sql: `SELECT (SELECT count(*) FROM expenses WHERE source = 'site' AND user_id = ${L.uid(me)} AND spent_on = ${L.lit(day)} AND amount_cents = ${cents}
            AND category = ${L.lit(category)} AND lower(merchant) = lower(${L.lit(merchant)}) AND lower(description) = lower(${L.lit(desc)})) AS claim,
            (SELECT count(*) FROM expenses WHERE source = 'site') AS total`, state_expect: [{ claim: 1, total: 1 }] } };
      }
    },
  },
  {
    name: 'register-batch', kind: 'write', skills: ['create', 'multi-step', 'form-edit'], difficulty: 3, max: 130,
    phrasings: [
      'Register these attendees for {{event}}: {{people}}.',
      'Sign up the following people for the event {{event}}: {{people}}.',
      'Add each of these to the {{event}} attendee list: {{people}}.',
    ],
    *generate(r) {
      const evs = L.all('SELECT id, slug, title FROM events ORDER BY id');
      for (let k = 0; k < 400; k++) {
        const e = r.pick(evs);
        const n = r.range(3, 6);
        const people = [];
        const seen = new Set();
        while (people.length < n) {
          const f = r.pick(FIRST), l = r.pick(LAST);
          if (seen.has(f) || seen.has(l)) continue;
          seen.add(f); seen.add(l);
          people.push({ name: `${f} ${l}`, email: `${f}.${l}@partner-guest.example`.toLowerCase(), team: r.pick(TEAMS), dietary: r.pick(DIET) });
        }
        const list = people.map((p) => `${p.name} (${p.email}, team ${p.team}, dietary: ${p.dietary})`).join('; ');
        const keys = people.map((p) => L.lit(`${p.email}|${p.name.toLowerCase()}|${p.team}|${p.dietary}`)).join(', ');
        yield { slots: { event: e.title, people: list }, login_user: L.loginFor(r), start_url: '__LAB__/events',
          eval: { type: 'state', state_sql: `SELECT count(*) AS n, count(DISTINCT lower(email)) AS people,
            sum(CASE WHEN event_id = ${e.id} AND (lower(email) || '|' || lower(name) || '|' || team || '|' || dietary) IN (${keys}) THEN 1 ELSE 0 END) AS good
            FROM registrations WHERE source = 'site'`, state_expect: [{ n, people: n, good: n }] },
          changes: [`${n} attendees`] };
      }
    },
  },
];
