'use strict';
// Family F: slow background jobs on the site clock (10-60 s, scenario). The answer exists only once
// the job has finished: a report code (random token) or an import's rejected-row count.
const L = require('./lib');

const jobScenario = (r) => ({ job_seconds: r.range(10, 60), rerender: r.chance(0.6) });

module.exports = [
  {
    name: 'report-code', kind: 'read', skills: ['multi-step', 'read-detail'], difficulty: 2, max: 130,
    phrasings: [
      'Generate the {{period}} usage report for the {{team}} team and tell me its report code.',
      'Run the usage report for team {{team}}, period {{period}}. What report code does it give?',
      'I need the report code of the {{team}} team\'s usage report for {{period}}. Generate it and tell me.',
    ],
    *generate(r) {
      for (const x of r.shuffle(L.all('SELECT id, team, period, code FROM reports ORDER BY id'))) {
        const near = L.all('SELECT code FROM reports WHERE id <> ? AND (team = ? OR period = ?) ORDER BY abs(id - ?) LIMIT 4', x.id, x.team, x.period, x.id).map((y) => y.code);
        yield { slots: { team: x.team, period: x.period }, login_user: L.loginFor(r), start_url: '__LAB__/reports', scenario: jobScenario(r),
          eval: { type: 'answer', answer: { must_include: [x.code], must_exclude: near }, answer_sql: `SELECT code FROM reports WHERE team = ${L.lit(x.team)} AND period = ${L.lit(x.period)}` } };
      }
    },
  },
  {
    name: 'import-rejected', kind: 'read', skills: ['multi-step', 'read-detail'], difficulty: 2, max: 130, heldout: 'template',
    phrasings: [
      'Import the file {{file}} and tell me how many rows were rejected.',
      'Run the import for {{file}}. How many rows did it reject?',
      'How many rows of {{file}} get rejected when you import it?',
    ],
    *generate(r) {
      for (const f of r.shuffle(L.all('SELECT id, name, rows, rejected FROM import_files ORDER BY id'))) {
        yield { slots: { file: f.name }, login_user: L.loginFor(r), start_url: '__LAB__/data/imports', scenario: jobScenario(r),
          eval: { type: 'answer', answer: { must_include: [String(f.rejected)] }, answer_sql: `SELECT rejected FROM import_files WHERE name = ${L.lit(f.name)}` } };
      }
    },
  },
];
