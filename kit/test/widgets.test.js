'use strict';
// Scenario widget slots (lib/widgets.js): reset-time validation and the per-request value.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const W = require('../lib/widgets');
const { Tenant } = require('../lib/tenant');
const { als } = require('../lib/context');

const cfg = { name: 'demo', widgets: { list: W.LIST_KINDS, editor: W.EDITOR_KINDS, links: ['js'] }, scenarioKeys: ['seed'] };

test('checkScenario validates widget slots and values against cfg.widgets', () => {
  const ok = (sc) => assert.doesNotThrow(() => Tenant.checkScenario(sc, cfg), JSON.stringify(sc));
  const no = (sc, rx) => assert.throws(() => Tenant.checkScenario(sc, cfg), (e) => e.statusCode === 400 && rx.test(e.message), JSON.stringify(sc));
  ok(undefined); ok({}); ok({ widgets: {} }); ok({ widgets: { list: 'sections', editor: 'shadow' } }); ok({ seed: 3, widgets: { links: 'js' } });
  no({ widgets: { lists: 'recycle' } }, /unknown widget slot 'lists'/);
  no({ widgets: { list: 'carousel' } }, /does not take "carousel"/);
  no({ widgets: { list: 1 } }, /does not take 1/);
  no({ widgets: ['list'] }, /must be an object/);
  no({ widget: { list: 'recycle' } }, /unknown scenario key 'widget'/);
  // sites without cfg.widgets keep the old contract (any object)
  assert.doesNotThrow(() => Tenant.checkScenario({ widgets: { anything: 'x' }, n: 1 }, { name: 'lab' }));
  assert.doesNotThrow(() => Tenant.checkScenario({ widgets: { anything: 'x' } }));
  // a site hook runs after the generic checks
  assert.throws(() => Tenant.checkScenario({ seed: -1 }, { ...cfg, checkScenario: (sc) => { if (sc.seed < 0) throw Object.assign(new Error('bad seed'), { statusCode: 400 }); } }), /bad seed/);
});

test('value(): the slot value inside a request context, else the fallback', () => {
  const fake = (sc) => ({ site: { cfg }, scenario: () => sc });
  assert.equal(W.value('list'), null, 'outside a context');
  assert.equal(als.run({ tenant: fake({}) }, () => W.value('list')), null);
  assert.equal(als.run({ tenant: fake({}) }, () => W.value('list', 'off')), 'off');
  assert.equal(als.run({ tenant: fake({ widgets: { list: 'grid' } }) }, () => W.value('list')), 'grid');
  assert.equal(als.run({ tenant: fake({ widgets: { list: 'grid' } }) }, () => W.value('editor')), null);
  assert.equal(als.run({ tenant: fake({ widgets: { nope: 'grid' } }) }, () => W.value('nope')), null, 'undeclared slot');
  assert.throws(() => als.run({ tenant: fake({}) }, () => W.need('list')), (e) => e.statusCode === 404);
  assert.equal(als.run({ tenant: fake({ widgets: { links: 'js' } }) }, () => W.need('links')), 'js');
});

test('helpers: range, deterministic job seconds, markup', () => {
  assert.deepEqual(W.range({ query: { offset: '50', limit: '500' } }), { offset: 50, limit: 100 });
  assert.deepEqual(W.range({ query: {} }), { offset: 0, limit: 25 });
  const s = W.jobSeconds('report:bestsellers');
  assert.ok(s >= 10 && s <= 60);
  assert.equal(W.jobSeconds('report:bestsellers'), s);
  assert.match(W.vlist({ src: '/x', total: 3, kind: 'recycle', label: 'Items "a"' }), /class="wsb-vlist" data-src="\/x" data-total="3" data-kind="recycle" data-scroll="container".*aria-label="Items &quot;a&quot;"/);
  assert.match(W.vlist({ src: '/x', total: 3, kind: 'grid' }), /data-scroll="page"/);
  assert.match(W.shadow('<b>x</b>', { cls: 'c', css: ['/s.css'] }), /^<div class="c"><template data-wsb-shadow><link rel="stylesheet" href="\/s.css"><b>x<\/b><\/template><\/div>$/);
  assert.equal(W.navButton('/a?b=1&c', 'T', 'link'), '<button type="button" class="link" data-wsb-nav="/a?b=1&amp;c">T</button>');
  // every script a helper can emit exists
  for (const m of W.script('vlist', 'older', 'editor', 'shadow', 'frame', 'jobwait', 'nav', 'fill').matchAll(/src="\/_kit\/widgets\/([^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'widgets', m[1])), m[1]);
  }
});
