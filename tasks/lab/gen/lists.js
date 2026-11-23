'use strict';
// Family A1/A2: long virtualized lists (ops queues). Answers need every row of a queue, and only rows
// near the viewport exist in the page. Variant axes (scenario): list kind x container/page scroll x
// row height; N (40-607) and target positions come from the data. The `sections` kind is held out:
// its tasks form their own templates (<name>-sections).
const L = require('./lib');

const TRAIN_KINDS = ['unmount', 'recycle', 'pinned', 'grid'];
const HELD_KIND = 'sections';
const HEIGHTS = [36, 44, 52, 64, 80, 96];
const scenarioFor = (r, kinds) => {
  const kind = r.pick(kinds);
  return { widgets: { queue: kind }, scroll: kind === 'grid' ? 'page' : r.pick(['container', 'page']), row_height: r.pick(HEIGHTS) };
};
const queues = () => L.all('SELECT id, slug, name, n FROM queues ORDER BY id');
const rows = (qidv) => L.all(`SELECT t.pos, t.key, t.title, t.priority, t.status, u.display_name AS assignee, t.assignee_id FROM tickets t
  LEFT JOIN users u ON u.id = t.assignee_id WHERE t.queue_id = ? ORDER BY t.pos`, qidv);
const deep = (n, positions) => positions.some((p) => p >= n * 0.6); // something past the first screens

// question kinds for counts: [slot text, predicate, sql]
function countKinds(rs) {
  const names = [...new Set(rs.map((x) => x.assignee).filter(Boolean))];
  const out = [
    ['P1 tickets', (x) => x.priority === 'P1', "priority = 'P1'"],
    ['P2 tickets', (x) => x.priority === 'P2', "priority = 'P2'"],
    ['blocked tickets', (x) => x.status === 'blocked', "status = 'blocked'"],
    ['unassigned tickets', (x) => !x.assignee, 'assignee_id IS NULL'],
    ['P1 or P2 tickets that are still open', (x) => ['P1', 'P2'].includes(x.priority) && x.status === 'open', "priority IN ('P1', 'P2') AND status = 'open'"],
  ];
  for (const n of names) out.push([`unresolved tickets assigned to ${n}`, (x) => x.assignee === n && x.status !== 'resolved', `assignee_id = (SELECT id FROM users WHERE display_name = ${L.lit(n)}) AND status <> 'resolved'`]);
  return out;
}

function templates(kinds, suffix, held) {
  const tag = suffix ? `-${suffix}` : '';
  const max = suffix ? 40 : 130;
  return [
    {
      name: `vlist-count${tag}`, kind: 'read', skills: ['aggregate', 'navigate'], difficulty: 2, max, heldout: held, aids: 'queue',
      phrasings: [
        'How many {{what}} are in the {{queue}} queue?',
        'Count the {{what}} in the {{queue}} queue. How many are there?',
        'In the ops queue {{queue}}, how many {{what}} are there in total?',
      ],
      *generate(r) {
        for (const q of r.shuffle(queues())) {
          const rs = rows(q.id);
          for (const [what, pred, cond] of r.sample(countKinds(rs), 6)) {
            const hit = rs.filter(pred);
            if (hit.length < 2 || hit.length > 40 || hit.length === rs.length || !deep(q.n, hit.map((x) => x.pos))) continue;
            yield { slots: { what, queue: q.name }, login_user: L.loginFor(r), start_url: `__LAB__/ops/queues/${q.slug}`, scenario: scenarioFor(r, kinds),
              eval: { type: 'answer', answer: { must_include: [String(hit.length)] }, answer_sql: `SELECT count(*) FROM tickets WHERE queue_id = ${L.qid(q.slug)} AND ${cond}` },
              changes: [`${hit.length} of ${q.n} rows; last match at row ${Math.max(...hit.map((x) => x.pos)) + 1}`] };
          }
        }
      },
    },
    {
      name: `vlist-find${tag}`, kind: 'read', skills: ['search', 'read-detail', 'navigate'], difficulty: 2, max, heldout: held, aids: 'queue',
      phrasings: [
        'What is the key of the ticket "{{title}}" in the {{queue}} queue?',
        'Find the ticket titled "{{title}}" in the {{queue}} queue and give me its key.',
        'Which ticket key belongs to "{{title}}"? It is in the {{queue}} queue.',
      ],
      *generate(r) {
        for (const q of r.shuffle(queues())) {
          const rs = rows(q.id);
          for (let k = 0; k < 2; k++) {
            const t = rs[r.range(Math.floor(rs.length * 0.35), rs.length - 1)];
            const near = rs.filter((x) => x.key !== t.key && Math.abs(x.pos - t.pos) <= 6).map((x) => x.key);
            yield { slots: { title: t.title, queue: q.name }, login_user: L.loginFor(r), start_url: `__LAB__/ops/queues/${q.slug}`, scenario: scenarioFor(r, kinds),
              eval: { type: 'answer', answer: { must_include: [t.key], must_exclude: near }, answer_sql: `SELECT key FROM tickets WHERE queue_id = ${L.qid(q.slug)} AND title = ${L.lit(t.title)}` },
              changes: [`row ${t.pos + 1} of ${q.n}`] };
          }
        }
      },
    },
    {
      name: `vlist-list${tag}`, kind: 'read', skills: ['filter-sort', 'navigate', 'aggregate'], difficulty: 3, max, heldout: held, aids: 'queue',
      phrasings: [
        'List the keys of every {{status}} ticket assigned to {{person}} in the {{queue}} queue.',
        'Which tickets in the {{queue}} queue are assigned to {{person}} and {{status}}? Give all their keys.',
        'Give me the keys of all of {{person}}\'s {{status}} tickets in the {{queue}} queue.',
      ],
      *generate(r) {
        for (const q of r.shuffle(queues())) {
          const rs = rows(q.id);
          const combos = [];
          for (const status of ['open', 'in progress', 'blocked']) {
            for (const person of [...new Set(rs.map((x) => x.assignee).filter(Boolean))]) {
              const hit = rs.filter((x) => x.assignee === person && x.status === status);
              if (hit.length >= 3 && hit.length <= 8 && deep(q.n, hit.map((x) => x.pos))) combos.push({ status, person, hit });
            }
          }
          for (const c of r.sample(combos, 2)) {
            const decoys = r.sample(rs.filter((x) => (x.assignee === c.person) !== (x.status === c.status)), 10).map((x) => x.key);
            yield { slots: { status: c.status, person: c.person, queue: q.name }, login_user: L.loginFor(r), start_url: `__LAB__/ops/queues/${q.slug}`, scenario: scenarioFor(r, kinds),
              eval: { type: 'answer', answer: { must_include: c.hit.map((x) => x.key), must_exclude: decoys },
                answer_sql: `SELECT key FROM tickets WHERE queue_id = ${L.qid(q.slug)} AND status = ${L.lit(c.status)} AND assignee_id = (SELECT id FROM users WHERE display_name = ${L.lit(c.person)}) ORDER BY pos` },
              changes: [`${c.hit.length} keys at rows ${c.hit.map((x) => x.pos + 1).join(', ')} of ${q.n}`] };
          }
        }
      },
    },
  ];
}

module.exports = [...templates(TRAIN_KINDS, '', false), ...templates([HELD_KIND], HELD_KIND, 'variant')];
