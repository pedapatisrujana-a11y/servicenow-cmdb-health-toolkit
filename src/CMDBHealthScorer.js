/**
 * Script Include: CMDBHealthScorer
 * Scope: global (or a scoped app such as x_portfolio_cmdbh)
 * Accessible from: server-side only
 *
 * Scores Configuration Items on the three CMDB health dimensions that ServiceNow's
 * CMDB Health Dashboard uses — Completeness, Correctness and Compliance — using
 * rules that are easy to read and change:
 *
 *   completeness : required attributes per CI class are populated
 *   correctness  : no duplicates (same serial number, or same name within a class)
 *                  and no orphaned CIs (application/service CIs with no relationships)
 *   compliance   : CI was discovered/updated within the staleness window and has an
 *                  owner/support group (CSDM ownership expectation)
 *
 * Portfolio project: written independently with synthetic data. Not client code.
 */
var CMDBHealthScorer = Class.create();
CMDBHealthScorer.prototype = {

    /**
     * @param {Object} [config]
     * @param {Object<string,string[]>} [config.requiredFields]  class -> required attributes
     * @param {number}  [config.staleDays=30]                     days before a CI is stale
     * @param {string[]} [config.relationshipRequiredClasses]     classes that must have >=1 relationship
     * @param {string}  [config.ciTable='cmdb_ci']
     * @param {string}  [config.relTable='cmdb_rel_ci']
     */
    initialize: function (config) {
        config = config || {};
        this.requiredFields = config.requiredFields || {
            cmdb_ci_server: ['name', 'serial_number', 'ip_address', 'os', 'support_group'],
            cmdb_ci_appl: ['name', 'version', 'support_group', 'owned_by'],
            cmdb_ci_service: ['name', 'owned_by', 'support_group']
        };
        this.staleDays = typeof config.staleDays === 'number' ? config.staleDays : 30;
        this.relationshipRequiredClasses = config.relationshipRequiredClasses || ['cmdb_ci_appl', 'cmdb_ci_service'];
        this.ciTable = config.ciTable || 'cmdb_ci';
        this.relTable = config.relTable || 'cmdb_rel_ci';
        this.weights = config.weights || { completeness: 0.4, correctness: 0.35, compliance: 0.25 };
    },

    /**
     * Evaluate every operational CI (or those matching an encoded query) and return a report.
     * @param {string} [encodedQuery]
     * @returns {{generatedAt:string, totals:Object, byClass:Object, findings:Object[]}}
     */
    run: function (encodedQuery) {
        var cis = this._loadCIs(encodedQuery);
        var relCounts = this._loadRelationshipCounts();
        var dupes = this._findDuplicates(cis);
        var findings = [];
        var byClass = {};

        for (var i = 0; i < cis.length; i++) {
            var ci = cis[i];
            var result = this.scoreCI(ci, relCounts[ci.sys_id] || 0, dupes[ci.sys_id]);
            findings.push(result);

            var c = byClass[ci.sys_class_name] || (byClass[ci.sys_class_name] = { count: 0, scoreSum: 0, issues: 0 });
            c.count++;
            c.scoreSum += result.score;
            c.issues += result.issues.length;
        }

        var total = { count: findings.length, healthy: 0, issues: 0, averageScore: 0 };
        for (var j = 0; j < findings.length; j++) {
            total.issues += findings[j].issues.length;
            if (findings[j].issues.length === 0) total.healthy++;
            total.averageScore += findings[j].score;
        }
        total.averageScore = findings.length ? Math.round(total.averageScore / findings.length) : 0;

        for (var cls in byClass) {
            if (byClass.hasOwnProperty(cls)) {
                byClass[cls].averageScore = Math.round(byClass[cls].scoreSum / byClass[cls].count);
                delete byClass[cls].scoreSum;
            }
        }

        gs.info('CMDBHealthScorer: evaluated {0} CIs, {1} issues, average score {2}',
            total.count, total.issues, total.averageScore);

        return { generatedAt: gs.nowDateTime(), totals: total, byClass: byClass, findings: findings };
    },

    /**
     * Score a single CI. Pure function of its inputs — easy to unit-test.
     * @param {Object} ci            plain CI object
     * @param {number} relCount      number of relationships the CI participates in
     * @param {string} [duplicateOf] sys_id of the CI this one duplicates, if any
     */
    scoreCI: function (ci, relCount, duplicateOf) {
        var issues = [];

        // Completeness
        var required = this.requiredFields[ci.sys_class_name] || ['name'];
        var missing = [];
        for (var i = 0; i < required.length; i++) {
            if (this._isEmpty(ci[required[i]])) missing.push(required[i]);
        }
        var completeness = required.length ? (required.length - missing.length) / required.length : 1;
        if (missing.length) issues.push({ type: 'missing_fields', detail: missing.join(', ') });

        // Correctness
        var correctness = 1;
        if (duplicateOf) {
            correctness -= 0.6;
            issues.push({ type: 'duplicate', detail: 'possible duplicate of ' + duplicateOf });
        }
        if (this.relationshipRequiredClasses.indexOf(ci.sys_class_name) > -1 && relCount === 0) {
            correctness -= 0.4;
            issues.push({ type: 'orphan', detail: 'no CI relationships' });
        }
        correctness = Math.max(0, correctness);

        // Compliance
        var compliance = 1;
        var age = this._ageInDays(ci.last_discovered || ci.sys_updated_on);
        if (age === null || age > this.staleDays) {
            compliance -= 0.5;
            issues.push({ type: 'stale', detail: age === null ? 'never discovered' : age + ' days since last discovery' });
        }
        if (this._isEmpty(ci.support_group) && this._isEmpty(ci.owned_by)) {
            compliance -= 0.5;
            issues.push({ type: 'no_ownership', detail: 'no support group or owner (CSDM)' });
        }
        compliance = Math.max(0, compliance);

        var score = Math.round(100 * (
            this.weights.completeness * completeness +
            this.weights.correctness * correctness +
            this.weights.compliance * compliance));

        return {
            sys_id: ci.sys_id,
            name: ci.name,
            sys_class_name: ci.sys_class_name,
            score: score,
            completeness: Math.round(completeness * 100),
            correctness: Math.round(correctness * 100),
            compliance: Math.round(compliance * 100),
            issues: issues
        };
    },

    /* ---------- data access ---------- */

    _loadCIs: function (encodedQuery) {
        var out = [];
        var gr = new GlideRecord(this.ciTable);
        gr.addQuery('operational_status', '1');
        if (encodedQuery) gr.addEncodedQuery(encodedQuery);
        gr.query();
        var fields = ['sys_id', 'name', 'sys_class_name', 'serial_number', 'ip_address', 'os', 'version',
            'support_group', 'owned_by', 'last_discovered', 'sys_updated_on'];
        while (gr.next()) {
            var ci = {};
            for (var i = 0; i < fields.length; i++) ci[fields[i]] = gr.getValue(fields[i]);
            out.push(ci);
        }
        return out;
    },

    _loadRelationshipCounts: function () {
        var counts = {};
        var gr = new GlideRecord(this.relTable);
        gr.query();
        while (gr.next()) {
            var p = gr.getValue('parent');
            var c = gr.getValue('child');
            counts[p] = (counts[p] || 0) + 1;
            counts[c] = (counts[c] || 0) + 1;
        }
        return counts;
    },

    /**
     * Duplicate rules (in priority order): same serial number; else same class + normalised name.
     * The oldest record (first seen) is treated as the primary.
     * @returns {Object<string,string>} duplicate sys_id -> primary sys_id
     */
    _findDuplicates: function (cis) {
        var seen = {};
        var dupes = {};
        for (var i = 0; i < cis.length; i++) {
            var ci = cis[i];
            var keys = [];
            if (!this._isEmpty(ci.serial_number)) keys.push('sn:' + String(ci.serial_number).toUpperCase().trim());
            if (!this._isEmpty(ci.name)) keys.push('nm:' + ci.sys_class_name + ':' + String(ci.name).toLowerCase().replace(/\s+/g, ''));
            for (var k = 0; k < keys.length; k++) {
                if (seen[keys[k]] && seen[keys[k]] !== ci.sys_id) { dupes[ci.sys_id] = seen[keys[k]]; break; }
            }
            for (var m = 0; m < keys.length; m++) if (!seen[keys[m]]) seen[keys[m]] = ci.sys_id;
        }
        return dupes;
    },

    /* ---------- helpers ---------- */

    _isEmpty: function (v) {
        return v === undefined || v === null || String(v).trim() === '';
    },

    _ageInDays: function (dateTime) {
        if (this._isEmpty(dateTime)) return null;
        var then = new Date(String(dateTime).replace(' ', 'T') + 'Z').getTime();
        var now = new Date(gs.nowDateTime().replace(' ', 'T') + 'Z').getTime();
        if (isNaN(then)) return null;
        return Math.floor((now - then) / 86400000);
    },

    type: 'CMDBHealthScorer'
};
