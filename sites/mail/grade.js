'use strict';
// Mail grader: the kit grader, plus SQL builders for mail state checks (schema: build/schema.sql).
//   grade(task, {answer, url, query, fuzzy}) -> {pass, score, checks}
//   grade.sql.sent({user, to, subject?, bodyIncludes?, since?})   count of mail the user sent (UI-sent only)
//   grade.sql.threadFlag({user, subject, flag})                    max(flag) over a thread found by subject
const kit = require('../../kit');

const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const uid = (user) => `(SELECT id FROM users WHERE username = lower(${lit(user)}))`;

const sql = {
  // Mail sent from the UI by `user` to an address (case-insensitive), optionally by subject / body text.
  sent: ({ user, to, subject, bodyIncludes, since }) => `SELECT count(*) FROM messages m WHERE m.owner_id = ${uid(user)} AND m.is_sent = 1 AND m.source = 'site'`
    + (to ? ` AND (lower(m.to_addrs) LIKE ${lit(`%"${String(to).toLowerCase()}"%`)} OR lower(m.cc_addrs) LIKE ${lit(`%"${String(to).toLowerCase()}"%`)} OR lower(m.bcc_addrs) LIKE ${lit(`%"${String(to).toLowerCase()}"%`)})` : '')
    + (subject ? ` AND lower(m.subject) LIKE ${lit(`%${String(subject).toLowerCase()}%`)}` : '')
    + (bodyIncludes ? ` AND lower(m.body) LIKE ${lit(`%${String(bodyIncludes).toLowerCase()}%`)}` : '')
    + (since ? ` AND m.sent_at >= ${lit(since)}` : ''),
  threadFlag: ({ user, subject, flag }) => `SELECT max(m.${flag.replace(/[^a-z_]/g, '')}) FROM messages m WHERE m.owner_id = ${uid(user)} AND m.thread_id IN (SELECT thread_id FROM messages WHERE owner_id = ${uid(user)} AND subject = ${lit(subject)})`,
  labelled: ({ user, label, subject }) => `SELECT count(*) FROM message_labels ml JOIN labels l ON l.id = ml.label_id JOIN messages m ON m.id = ml.message_id
    WHERE l.owner_id = ${uid(user)} AND lower(l.name) = lower(${lit(label)})${subject ? ` AND m.subject = ${lit(subject)}` : ''}`,
};

function grade(task, ctx) {
  return kit.grader.grade(task, ctx);
}
grade.sql = sql;
grade.lit = lit;
module.exports = grade;
