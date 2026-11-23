'use strict';
// Background jobs (site clock): a report or import run finishes `seconds` after it started.
module.exports = {
  'report.finish': ({ payload, db }) => {
    db.prepare("UPDATE report_runs SET status = 'done', done_at = now() WHERE id = ? AND status = 'running'").run(payload.run);
    return { run: payload.run };
  },
  'import.finish': ({ payload, db }) => {
    db.prepare("UPDATE import_runs SET status = 'done', done_at = now() WHERE id = ? AND status = 'running'").run(payload.run);
    return { run: payload.run };
  },
};
