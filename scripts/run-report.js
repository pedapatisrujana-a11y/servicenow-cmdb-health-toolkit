'use strict';
// Runs the scorer against the synthetic dataset and prints a summary table.
const path = require('path');
const { createPlatform } = require('../test/glide-mock');
const data = require('../data/sample-cmdb.json');
const config = require('../config.example.json');

const p = createPlatform({ cmdb_ci: data.cmdb_ci, cmdb_rel_ci: data.cmdb_rel_ci }, { now: '2026-11-20T12:00:00Z' });
p.load(path.join(__dirname, '../src/CMDBHealthScorer.js'));
const report = new p.context.CMDBHealthScorer(config).run();

console.log(`CIs evaluated: ${report.totals.count} | healthy: ${report.totals.healthy} | issues: ${report.totals.issues} | avg score: ${report.totals.averageScore}\n`);
console.log('CI'.padEnd(20) + 'Class'.padEnd(18) + 'Score'.padEnd(7) + 'Issues');
for (const f of report.findings) {
  console.log(String(f.name).trim().padEnd(20) + f.sys_class_name.replace('cmdb_ci_', '').padEnd(18) + String(f.score).padEnd(7) + (f.issues.map((i) => i.type).join(', ') || '-'));
}
