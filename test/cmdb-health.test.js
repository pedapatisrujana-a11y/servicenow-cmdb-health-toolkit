'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createPlatform } = require('./glide-mock');
const data = require('../data/sample-cmdb.json');

function setup(cfg) {
  const p = createPlatform({ cmdb_ci: data.cmdb_ci, cmdb_rel_ci: data.cmdb_rel_ci }, { now: '2026-11-20T12:00:00Z' });
  p.load(path.join(__dirname, '../src/CMDBHealthScorer.js'));
  return { p, scorer: new p.context.CMDBHealthScorer(cfg) };
}

test('only operational CIs are evaluated', () => {
  const { scorer } = setup();
  const report = scorer.run();
  assert.equal(report.totals.count, 7);
  assert.ok(!report.findings.some((f) => f.sys_id === 'ci008'));
});

test('a complete, related, fresh CI scores 100 with no issues', () => {
  const { scorer } = setup();
  const f = scorer.run().findings.find((x) => x.sys_id === 'ci005');
  assert.equal(f.score, 100);
  assert.equal(f.issues.length, 0);
});

test('duplicate detected by case/whitespace-insensitive serial number', () => {
  const { scorer } = setup();
  const f = scorer.run().findings.find((x) => x.sys_id === 'ci003');
  const dup = f.issues.find((i) => i.type === 'duplicate');
  assert.ok(dup, 'expected duplicate issue');
  assert.match(dup.detail, /ci001/);
});

test('orphaned application CI is flagged', () => {
  const { scorer } = setup();
  const f = scorer.run().findings.find((x) => x.sys_id === 'ci006');
  assert.ok(f.issues.some((i) => i.type === 'orphan'));
  assert.ok(f.issues.some((i) => i.type === 'no_ownership'));
  assert.ok(f.issues.some((i) => i.type === 'stale'));
  assert.ok(f.score < 50);
});

test('never-discovered CI is stale and missing fields are listed', () => {
  const { scorer } = setup();
  const f = scorer.run().findings.find((x) => x.sys_id === 'ci004');
  assert.ok(f.issues.some((i) => i.type === 'stale' && /never/.test(i.detail)));
  assert.ok(f.issues.some((i) => i.type === 'missing_fields' && /ip_address/.test(i.detail)));
});

test('staleness window is configurable', () => {
  const { scorer } = setup({ staleDays: 400 });
  const f = scorer.run().findings.find((x) => x.sys_id === 'ci006');
  assert.ok(!f.issues.some((i) => i.type === 'stale'));
});

test('encoded query narrows the evaluated set', () => {
  const { scorer } = setup();
  const r = scorer.run('sys_class_name=cmdb_ci_appl');
  assert.equal(r.totals.count, 2);
  assert.equal(Object.keys(r.byClass).join(), "cmdb_ci_appl");
});

test('run writes a summary log line', () => {
  const { p, scorer } = setup();
  scorer.run();
  assert.ok(p.logs.some(([lvl, msg]) => lvl === 'info' && /evaluated 7 CIs/.test(msg)));
});
