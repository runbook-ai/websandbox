'use strict';
// Widgets off = unchanged (docs/WIDGETS.md): with no scenario and with an empty one, the pages the
// widget slots touch render byte-identical (CSRF token aside) to widgets-off.snap.json, recorded
// before the slots existed.  node --test sites/code/test/widgets-off.test.js
// Env: CODE_DATA (default $WSB_DATA_ROOT/code). WSB_SNAPSHOT=record re-records.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const snap = require('../../../kit/test/snapshot');

const DATA = process.env.CODE_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'code');
const ME = 'byteblaze';

test('code pages are unchanged without a scenario', { skip: !fs.existsSync(path.join(DATA, 'base.db')) && `no ${DATA}/base.db` }, async (t) => {
  await snap.check(t, {
    site: require('../server.js'), data: DATA, file: path.join(__dirname, 'widgets-off.snap.json'),
    plan: async ({ q }) => {
      const P = `SELECT n.path || '/' || p.path AS full, p.default_branch AS br FROM projects p JOIN namespaces n ON n.id = p.namespace_id`;
      const proj = async (full) => (await q(`${P} WHERE n.path || '/' || p.path = '${full}'`))[0];
      const a11y = await proj('a11yproject/a11yproject.com');
      const cra = await proj('facebook/create-react-app');
      const mine = (await q(`${P} JOIN users u ON u.username = '${ME}' WHERE n.path = '${ME}' AND p.open_issues_count > 0 ORDER BY p.id LIMIT 1`))[0];
      const issues = await q(`SELECT n.path || '/' || p.path AS full, i.iid FROM issues i JOIN projects p ON p.id = i.project_id JOIN namespaces n ON n.id = p.namespace_id
        WHERE i.confidential = 0 ORDER BY i.user_notes_count DESC, i.id LIMIT 2`);
      const mrs = await q(`SELECT n.path || '/' || p.path AS full, m.iid FROM merge_requests m JOIN projects p ON p.id = m.project_id JOIN namespaces n ON n.id = p.namespace_id
        ORDER BY m.user_notes_count DESC, m.id LIMIT 2`);
      const myIssue = (await q(`SELECT i.iid FROM issues i JOIN projects p ON p.id = i.project_id JOIN namespaces n ON n.id = p.namespace_id
        WHERE n.path || '/' || p.path = '${mine.full}' ORDER BY i.iid LIMIT 1`))[0].iid;
      const pages = [
        '/explore/projects', `/${a11y.full}`, `/${a11y.full}/-/issues`, `/${a11y.full}/-/issues?state=all`, `/${a11y.full}/-/issues?state=closed`, `/${a11y.full}/-/issues?page=2`,
        `/${a11y.full}/-/issues/?label_name%5B%5D=help%20wanted&state=all`, `/${a11y.full}/-/issues/?sort=created_asc&state=opened`, `/${cra.full}/-/issues`, `/${cra.full}/-/issues?search=build`,
        `/${a11y.full}/-/merge_requests`, `/${a11y.full}/-/merge_requests?state=all`, `/${cra.full}/-/merge_requests?state=merged`,
        ...issues.map((i) => `/${i.full}/-/issues/${i.iid}`), ...mrs.map((m) => `/${m.full}/-/merge_requests/${m.iid}`),
        `/${cra.full}/-/commits/${cra.br}`, `/${cra.full}/-/commits/${cra.br}?page=2`, `/${cra.full}/-/commits/${cra.br}?author=Dan%20Abramov`, `/${cra.full}/-/commits/${cra.br}/README.md`,
        `/${a11y.full}/-/commits/${a11y.br}`, `/${mine.full}`, `/${mine.full}/-/issues`, `/${mine.full}/-/issues/${myIssue}`, `/${mine.full}/-/commits/${mine.br}`,
      ];
      return [
        { user: null, pages: ['/', ...pages] },
        { user: ME, pages: ['/', ...pages, `/${a11y.full}/-/issues/new`, `/${mine.full}/-/issues/new`, `/${mine.full}/-/issues/${myIssue}/edit`,
          `/dashboard/issues?scope=all&state=opened&assignee_username=${ME}`, `/dashboard/merge_requests?reviewer_username=${ME}`, '/dashboard/todos', '/dashboard/projects'] },
      ];
    },
  });
});
