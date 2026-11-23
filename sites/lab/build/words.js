'use strict';
// Invented vocabulary for the lab build. Every name, company, place and product here is made up;
// any resemblance to a real one is accidental.

const FIRST = ['Aldo', 'Brina', 'Cass', 'Dorian', 'Elva', 'Fenn', 'Greer', 'Hollis', 'Ines', 'Jory', 'Kaela', 'Linus',
  'Mara', 'Nils', 'Odile', 'Pasco', 'Quilla', 'Rafe', 'Sunniva', 'Tobin', 'Ulla', 'Vance', 'Wynn', 'Xavi',
  'Yara', 'Zeno', 'Anouk', 'Bram', 'Celyn', 'Davin', 'Emrys', 'Faye', 'Gideon', 'Halia', 'Ivo', 'Juno',
  'Keir', 'Lark', 'Milo', 'Nessa', 'Orla', 'Piers', 'Romy', 'Soren', 'Tamsin', 'Uriel', 'Vesna', 'Wilder'];
const LAST = ['Ashdown', 'Brightwell', 'Corrin', 'Dunmore', 'Ellery', 'Fairholm', 'Gallow', 'Hartigan', 'Iverson', 'Jessup',
  'Kettering', 'Lowrie', 'Marchetti', 'Nyland', 'Okonkwo', 'Pellam', 'Quintero', 'Rasmussen', 'Strand', 'Thorne',
  'Underhill', 'Varga', 'Whitlock', 'Yarrow', 'Zielinski', 'Abernathy', 'Bexley', 'Calloway', 'Dresner', 'Eastman',
  'Faraday', 'Grantham', 'Holloway', 'Imrie', 'Jansen', 'Kowalczyk', 'Lindqvist', 'Moreau', 'Northcott', 'Ostrander',
  'Penhallow', 'Quayle', 'Redfern', 'Saltonstall', 'Trevelyan', 'Umberto', 'Vasquez', 'Wexford'];
const TEAMS = ['Platform', 'Payments', 'Mobile', 'Data', 'Support', 'Design', 'Sales', 'Finance'];
const TITLES = {
  Platform: ['Staff engineer', 'Site reliability engineer', 'Backend engineer', 'Engineering manager'],
  Payments: ['Payments engineer', 'Risk analyst', 'Backend engineer', 'Product manager'],
  Mobile: ['iOS engineer', 'Android engineer', 'Mobile lead', 'QA engineer'],
  Data: ['Data engineer', 'Analytics engineer', 'Data scientist', 'Data lead'],
  Support: ['Support specialist', 'Support lead', 'Escalations engineer', 'Technical writer'],
  Design: ['Product designer', 'Design lead', 'UX researcher', 'Content designer'],
  Sales: ['Account executive', 'Sales engineer', 'Account manager', 'Sales lead'],
  Finance: ['Controller', 'Accountant', 'Finance analyst', 'Billing specialist'],
};

const CHANNELS = [
  ['general', 'Company-wide announcements and chatter'], ['platform', 'Platform team: infra, deploys, on-call'],
  ['deploys', 'Deploy notices from every team'], ['design-review', 'Mockups and critique, Tuesdays and Thursdays'],
  ['support-escalations', 'Tickets that need an engineer'], ['data-pipeline', 'Warehouse loads, dashboards, data questions'],
  ['mobile', 'iOS and Android'], ['random', 'Anything goes'], ['sales-wins', 'Closed deals and renewals'],
  ['finance-ops', 'Invoices, payouts, month-end close'], ['incident-room', 'Active incidents only'],
  ['frontend', 'Web app and component library'], ['hiring', 'Interview loops and referrals'], ['office', 'Facilities, lunch, building notes'],
];
const CHAT_LINES = [
  'can someone take a look at this before standup?', 'pushed a fix, waiting on CI', 'heads up, the staging box is slow again',
  'who owns the retry config these days?', 'notes from the sync are up', 'I will pick this up after lunch',
  'thanks, that unblocked me', 'moving the review to tomorrow morning', 'anyone else seeing flaky tests on main?',
  'the dashboard numbers look off since Friday', 'reminder: freeze starts Thursday', 'draft is ready for comments',
  'we should write this down somewhere', 'pairing on the migration this afternoon', 'ok, rolling back for now',
  'customer confirmed the fix works', 'can we move this thread to the ticket?', 'new hire starts Monday, say hi',
  'the vendor call got pushed a week', 'I added a checklist to the doc', 'that alert is noise, muting it',
  'great work on the launch everyone', 'need a second reviewer on this one', 'the numbers reconcile now',
  'filed a ticket so we do not lose it', 'is the offsite agenda final?', 'office coffee machine is fixed',
  'lunch order closes at 11:30', 'benchmarks are better than expected', 'docs updated with the new flags',
];
const LINK_KINDS = { mockup: 'mockups', spec: 'specs', recording: 'recordings', dashboard: 'dashboards' };
const LINK_LINES = {
  mockup: ['latest mockup here', 'updated the empty state, see', 'two options for the header'],
  spec: ['spec for review', 'wrote up the proposal', 'here is the design doc'],
  recording: ['recording of the demo', 'missed the call? recording:', 'walkthrough video'],
  dashboard: ['dashboard for this', 'numbers are on', 'live view here'],
};

const COMPONENTS = ['Checkout API', 'Refund service', 'Ledger', 'Auth gateway', 'Search index', 'Notification worker',
  'Mobile sync', 'Billing UI', 'Report builder', 'Export service', 'Webhook relay', 'Feature flags', 'Session store',
  'Image pipeline', 'Audit log', 'Rate limiter', 'Scheduler', 'Email sender', 'Data loader', 'Admin console',
  'Onboarding flow', 'Payout batcher', 'Invoice renderer', 'Status page', 'CLI', 'SDK', 'Billing webhooks',
  'Tax engine', 'Fraud rules', 'Catalog sync'];
const PROBLEMS = ['timeouts', 'duplicate entries', 'stale cache', 'wrong totals', 'missing translations', 'slow queries',
  'memory growth', 'retry storms', 'broken pagination', 'off-by-one dates', 'silent failures', 'flaky tests',
  'high error rate', 'lost events', 'permission errors', 'malformed CSV', 'clock skew', 'race condition',
  'broken links', 'wrong currency', 'empty responses', 'truncated text', 'dropped webhooks', 'double charges',
  'expired tokens', 'locale bugs', 'layout shift', 'config drift', 'disk pressure', 'noisy alerts'];
const CONTEXTS = ['after deploy', 'for large accounts', 'on Android', 'on iOS', 'in the EU region', 'during month-end',
  'for new signups', 'with SSO users', 'when retrying', 'under load', 'on first login', 'for annual plans',
  'in dark mode', 'with long names', 'at midnight UTC', 'for partial refunds', 'behind the proxy', 'in staging only',
  'for archived records', 'with two-factor on', 'in the nightly job', 'after a password reset', 'for trial accounts',
  'in exported reports', 'with slow networks', 'on the status page', 'for tax-exempt customers', 'with emoji input',
  'in bulk actions', 'for imported data'];
const QUEUE_AREAS = ['Triage', 'Backlog', 'On-call', 'Bugs', 'Requests', 'Tech debt', 'Escalations', 'Release blockers',
  'Customer issues', 'Hardening'];

const SHEET_TYPES = [
  { name: 'Milestones', cols: ['Milestone', 'Owner', 'Target', 'Status'], status: ['on track', 'at risk', 'done', 'not started'],
    item: ['Kickoff', 'Design sign-off', 'API freeze', 'Beta', 'Load test', 'Security review', 'Docs complete', 'Launch', 'Retro', 'Pilot', 'Migration', 'Cutover', 'Training', 'Handoff'] },
  { name: 'Risks', cols: ['Risk', 'Owner', 'Likelihood', 'Status'], status: ['open', 'mitigated', 'accepted', 'closed'],
    item: ['Vendor delay', 'Staffing gap', 'Scope creep', 'Data loss', 'Latency regression', 'Budget overrun', 'Legal review', 'Dependency slip', 'Capacity', 'Hiring freeze', 'Contract terms', 'Rollback plan'] },
  { name: 'Vendors', cols: ['Vendor', 'Region', 'Owner', 'Contract'], status: ['signed', 'in review', 'lapsed', 'prospect'],
    item: ['Archway', 'Bellcrest', 'Cobalt Row', 'Driftwood', 'Emberline', 'Fernhill', 'Glasswing', 'Hollowell', 'Inkstone', 'Juniper Yard', 'Keystone Bay', 'Lanternfield'] },
  { name: 'Use cases', cols: ['Use case', 'Surface', 'Owner', 'Status'], status: ['live', 'staged', 'backlog', 'dropped'],
    item: ['Search by order', 'Refund lookup', 'Plan upgrade', 'Seat transfer', 'Invoice copy', 'Address change', 'Usage export', 'Team invite', 'Card update', 'Tax receipt', 'Delivery status', 'Account merge'] },
  { name: 'Test plan', cols: ['Test', 'Area', 'Owner', 'Result'], status: ['pass', 'fail', 'blocked', 'not run'],
    item: ['Smoke', 'Regression', 'Accessibility', 'Localization', 'Performance', 'Failover', 'Upgrade path', 'Permissions', 'Offline mode', 'Data import', 'Billing cycle', 'Email rendering'] },
];
const PROGRAMS = ['Atlas', 'Beacon', 'Cairn', 'Delta', 'Ember', 'Fjord', 'Gale', 'Harbor', 'Iris', 'Jasper', 'Kite', 'Lumen',
  'Meridian', 'Nimbus', 'Onyx', 'Pylon', 'Quill', 'Ridge', 'Summit', 'Tidal'];
const DOC_KINDS = ['source of truth', 'launch plan', 'program tracker', 'rollout plan'];
const SCOPES = ['Phase One', 'Pilot', 'Beta Launch', 'Migration Wave 1', 'Spring Release', 'Hardening Sprint', 'Regional Rollout', 'Partner Preview'];
const TRACKER_NOTES = [
  'Spin up the staging catalog with the new routing rules', 'Add ontology entries for the four test entities',
  'Write the routes for the release-date question', 'Add overrides for regional and metro rollouts',
  'Share the previous cycle query logs', 'Set up an experiment without the ranking model', 'Review coverage numbers with the program lead',
  'Draft the partner FAQ', 'Load-test the export endpoint', 'Translate onboarding emails', 'Wire the billing webhook to the ledger',
  'Retire the legacy settings page', 'Backfill missing invoice numbers', 'Add the audit trail to admin actions',
  'Run the accessibility pass on checkout', 'Document the rollback procedure', 'Clean up stale feature flags',
  'Move nightly jobs to the new scheduler', 'Tune alert thresholds for the queue workers', 'Collect sign-off from legal',
  'Prepare the support macros', 'Benchmark the search index rebuild', 'Ship the usage dashboard to pilot customers',
  'Migrate saved cards to the new vault', 'Update the status page components', 'Reconcile tax totals for March',
];

const KB_TOPICS = ['database failover', 'certificate rotation', 'queue backlog recovery', 'cache warm-up', 'payout batch rerun',
  'search reindex', 'log retention cleanup', 'region evacuation', 'webhook replay', 'feature flag rollback',
  'disk pressure response', 'stuck export jobs', 'session store flush', 'scheduler pause and resume', 'replica rebuild',
  'rate limiter tuning', 'invoice re-render', 'email bounce handling', 'audit log export', 'secret rotation'];
const KB_KINDS = ['Guide', 'Playbook', 'Procedure'];
const KB_CATEGORIES = ['Platform', 'Payments', 'Data', 'Support'];
const KB_SUBJ = ['The on-call engineer', 'The primary responder', 'Whoever holds the pager', 'The incident lead', 'The service owner', 'A second reviewer'];
const KB_VERB = ['confirms', 'checks', 'records', 'verifies', 'notes', 'watches', 'compares', 'reviews'];
const KB_OBJ = ['the replica lag', 'the error budget', 'the queue depth', 'the deploy marker', 'the alert history', 'the last good snapshot',
  'the change calendar', 'the dashboard for the affected region', 'the pending migrations', 'the current traffic split',
  'the open incident ticket', 'the backup timestamps', 'the worker pool size', 'the retry counters'];
const KB_COND = ['before touching production', 'while traffic is drained', 'after the first restart', 'once the page is acknowledged',
  'if the metric keeps climbing', 'before paging a second team', 'during the maintenance window', 'when the backlog stops shrinking',
  'after customers are notified', 'if the rollback does not help'];
const KB_FILL = ['This step is easy to skip under pressure, so write it in the incident channel.',
  'Most incidents of this kind resolve here, but do not stop watching the graphs.',
  'If anything looks unfamiliar, stop and ask before continuing.',
  'Keep a timestamped note of every command you run.',
  'The dashboards lag by about a minute, so wait before you compare numbers.',
  'Older versions of this procedure skipped this; the current one does not.',
  'Expect a short spike in latency while this happens.',
  'Nothing in this step is reversible, so double-check the target first.'];
const KB_SECTIONS = ['Overview', 'When to use this', 'Before you start', 'Assess the impact', 'Communicate', 'Drain traffic',
  'Take a snapshot', 'Apply the change', 'Verify', 'Watch for regressions', 'Restore traffic', 'Clean up', 'Hand off',
  'Follow-up work', 'Known pitfalls', 'Escalation paths', 'History of this procedure', 'Appendix: commands', 'Appendix: dashboards', 'Glossary'];
const CHECK_TEXT = ['confirm the replica lag is under 30 seconds', 'post the incident number in the channel', 'check that the snapshot finished',
  'verify the error rate is back under the threshold', 'make sure the traffic split shows 0% to the drained region',
  'confirm the worker pool is at its normal size', 'check that no migrations are pending', 'record the deploy marker id',
  'verify the backlog is shrinking', 'confirm the alert has cleared for ten minutes'];

const ACCT_A = ['Alder', 'Bramble', 'Cinder', 'Dunlin', 'Eskar', 'Fallow', 'Gantry', 'Harrow', 'Islet', 'Jetty', 'Kestrel', 'Larch',
  'Marrow', 'Nettle', 'Orrin', 'Pellam', 'Quarry', 'Rookery', 'Sable', 'Tansy', 'Umber', 'Vetch', 'Wren', 'Yarrow', 'Zephyr'];
const ACCT_B = ['Works', 'Freight', 'Labs', 'Analytics', 'Supply', 'Foods', 'Systems', 'Textiles', 'Robotics', 'Clinics',
  'Logistics', 'Studio', 'Partners', 'Ceramics', 'Optics', 'Instruments', 'Outfitters', 'Mills', 'Dairy', 'Print'];
const INDUSTRIES = ['Manufacturing', 'Retail', 'Healthcare', 'Logistics', 'Media', 'Education', 'Food', 'Energy'];
const REGIONS = ['North', 'South', 'East', 'West', 'Central'];
const CITIES = ['Port Ellery', 'Marrowgate', 'Halden Falls', 'Westbury Cross', 'Calder Bay', 'Northmere', 'Ashcombe',
  'Linden Vale', 'Greyhaven', 'Saltmarsh', 'Brennan Hill', 'Oxley Junction'];
const ROLES = ['Buyer', 'Engineer', 'Director', 'Analyst', 'Office manager', 'Designer', 'Controller', 'Operations lead', 'Recruiter', 'Product owner'];

const REL_COMPONENTS = ['billing-gateway', 'ledger-core', 'auth-proxy', 'search-indexer', 'notify-worker', 'mobile-sync',
  'report-builder', 'export-svc', 'webhook-relay', 'flag-service', 'session-store', 'image-pipe', 'audit-trail',
  'rate-guard', 'sched-runner', 'mail-sender'];
const CHANNELS_REL = ['stable', 'beta', 'hotfix'];

const EXP_CATEGORIES = ['Travel', 'Meals', 'Software', 'Hardware', 'Training', 'Office supplies'];
const MERCHANTS = ['Cobble Street Cafe', 'Northline Rail', 'Pinewood Hotel', 'Brightdesk Supply', 'Juniper Books',
  'Harbor Taxi', 'Lanternfield Software', 'Copperpot Kitchen', 'Ridgeway Air', 'Quillworks Stationery',
  'Fernhill Conference Center', 'Saltmarsh Diner', 'Glasswing Electronics', 'Emberline Printing', 'Bellcrest Training'];
const EXP_DESC = ['Client dinner', 'Train to the customer site', 'Hotel for the offsite', 'Team lunch', 'Conference ticket',
  'Replacement keyboard', 'Annual license renewal', 'Taxi from the airport', 'Workshop materials', 'Flight to the partner summit',
  'Printer paper and toner', 'Books for the reading group', 'Coffee for the hack day', 'Monitor cable', 'Course fee'];
const EVENTS = ['Platform guild meetup', 'Spring offsite', 'Design critique night', 'Data office hours', 'Security awareness workshop',
  'New hire breakfast', 'Quarterly planning day', 'Accessibility clinic', 'Mobile release party', 'Support shadowing day',
  'Finance month-end walkthrough', 'Writing workshop', 'Hack day', 'Customer panel', 'Mentoring kickoff'];
const PLACES = ['Room 4B', 'The atrium', 'Lab 2', 'Harbor room', 'Rooftop terrace', 'Library', 'Main hall', 'Studio 1'];
const DIETARY = ['None', 'Vegetarian', 'Vegan', 'Gluten-free', 'Nut allergy'];

module.exports = {
  FIRST, LAST, TEAMS, TITLES, CHANNELS, CHAT_LINES, LINK_KINDS, LINK_LINES, COMPONENTS, PROBLEMS, CONTEXTS, QUEUE_AREAS,
  SHEET_TYPES, PROGRAMS, DOC_KINDS, SCOPES, TRACKER_NOTES, KB_TOPICS, KB_KINDS, KB_CATEGORIES, KB_SUBJ, KB_VERB, KB_OBJ, KB_COND,
  KB_FILL, KB_SECTIONS, CHECK_TEXT, ACCT_A, ACCT_B, INDUSTRIES, REGIONS, CITIES, ROLES, REL_COMPONENTS, CHANNELS_REL,
  EXP_CATEGORIES, MERCHANTS, EXP_DESC, EVENTS, PLACES, DIETARY,
};
