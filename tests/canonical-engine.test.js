/**
 * PHASE 9J -- CANONICAL ENGINE TEST SUITE (Node, zero dependencies)
 *
 * Deliberately placed at the repo ROOT, outside both sistem-notifikasi/ and
 * dashboard-analitik/ (each a separate clasp project with rootDir "."), so
 * `clasp push` never picks this file up and pushes it into the live Apps
 * Script projects.
 *
 * SCOPE / HONESTY NOTE: this suite exercises evaluateTransition_() and the
 * other pure (no SpreadsheetApp/LockService/Session/PropertiesService
 * calls) functions in sistem-notifikasi/Canonical.gs directly, by loading
 * the real source file into a Node vm context -- this is the actual
 * production code, not a reimplementation of it. It covers every mandatory
 * test-matrix scenario that is pure state-machine logic (A-I, AF, plus the
 * duplicate-Selesai-while-exception carryover from the Phase 8 correction
 * pass, plus SLA/waiting/Cycle_ID unit checks).
 *
 * It does NOT and CANNOT exercise scenarios requiring live Google Apps
 * Script services -- Admin/Auto Closure (J-R), concurrency/locking (U-V),
 * partial-write/reconciliation (W-Y), authorization (Z-AA), or dashboard
 * mixed-range rendering (AE) -- since those require LockService,
 * SpreadsheetApp, Session, and an actual Google Sheet, none of which exist
 * outside the deployed Apps Script runtime. Those are verified by code
 * review and structural analysis instead; see the Phase 9 report's Test
 * Matrix Results section for the honest breakdown of executed vs.
 * reviewed-only scenarios.
 *
 * Run with: node tests/canonical-engine.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// Canonical.gs references EVENT_HANTAR/EVENT_SELESAI/EVENT_AMBIL/
// SLA_LIMIT_MS/etc., which are declared in Code.gs -- in the real Apps
// Script project these share one global scope (multiple .gs files in the
// same project), so both are loaded into the SAME vm context here, in the
// same order Apps Script would effectively make them available, to
// accurately mirror production rather than re-declaring them separately.
const codeSrc = fs.readFileSync(path.join(__dirname, '..', 'sistem-notifikasi', 'Code.gs'), 'utf8');
const canonicalSrc = fs.readFileSync(path.join(__dirname, '..', 'sistem-notifikasi', 'Canonical.gs'), 'utf8');
const sandbox = {
  // Minimal Utilities.formatDate stub -- fixed UTC+8 offset matching the
  // project's declared "Asia/Kuala_Lumpur" timezone (no DST in Malaysia),
  // so these tests are deterministic regardless of the host machine's own
  // timezone. Only the two patterns Canonical.gs actually calls are
  // supported; anything else is a deliberate hard failure, not a silent
  // wrong answer.
  Utilities: {
    formatDate: function (date, tz, pattern) {
      var d = new Date(date);
      var kl = new Date(d.getTime() + 8 * 3600000);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      if (pattern === 'yyyy-MM-dd') return kl.getUTCFullYear() + '-' + pad(kl.getUTCMonth() + 1) + '-' + pad(kl.getUTCDate());
      if (pattern === 'HH:mm') return pad(kl.getUTCHours()) + ':' + pad(kl.getUTCMinutes());
      throw new Error('Unsupported Utilities.formatDate pattern in test stub: ' + pattern);
    }
  },
  Logger: { log: function () {} } // silence Logger.log calls reached incidentally
};
vm.createContext(sandbox);
vm.runInContext(codeSrc, sandbox, { filename: 'Code.gs' });
vm.runInContext(canonicalSrc, sandbox, { filename: 'Canonical.gs' });

var S = sandbox; // shorthand for the loaded module's globals

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS - ' + name); }
  catch (e) { failed++; console.log('FAIL - ' + name + ' -- ' + e.message); }
}

// ---- A. Clean cycle ----
test('A: NOT_STARTED + Hantar -> ACCEPT, HANTAR_ACTIVE', function () {
  var t = S.evaluateTransition_(S.STATE_NOT_STARTED, S.EVENT_HANTAR);
  assert.strictEqual(t.decision, 'ACCEPT');
  assert.strictEqual(t.nextState, S.STATE_HANTAR_ACTIVE);
});
test('A: HANTAR_ACTIVE + Selesai -> ACCEPT, SELESAI_ACTIVE', function () {
  var t = S.evaluateTransition_(S.STATE_HANTAR_ACTIVE, S.EVENT_SELESAI);
  assert.strictEqual(t.decision, 'ACCEPT');
  assert.strictEqual(t.nextState, S.STATE_SELESAI_ACTIVE);
});
test('A: SELESAI_ACTIVE + Ambil -> ACCEPT, COMPLETE_BY_AMBIL, no exception', function () {
  var t = S.evaluateTransition_(S.STATE_SELESAI_ACTIVE, S.EVENT_AMBIL);
  assert.strictEqual(t.decision, 'ACCEPT');
  assert.strictEqual(t.nextState, S.STATE_COMPLETE_BY_AMBIL);
  assert.strictEqual(t.isException, false);
});

// ---- B. Duplicate Hantar while active ----
test('B: HANTAR_ACTIVE + Hantar -> ACCEPT_CORRECTION, stays HANTAR_ACTIVE', function () {
  var t = S.evaluateTransition_(S.STATE_HANTAR_ACTIVE, S.EVENT_HANTAR);
  assert.strictEqual(t.decision, 'ACCEPT_CORRECTION');
  assert.strictEqual(t.nextState, S.STATE_HANTAR_ACTIVE);
  assert.strictEqual(t.reasonCode, S.REASON_SUPERSEDED_HANTAR);
});

// ---- C. Duplicate Selesai while active ----
test('C: SELESAI_ACTIVE + Selesai -> ACCEPT_CORRECTION, stays SELESAI_ACTIVE', function () {
  var t = S.evaluateTransition_(S.STATE_SELESAI_ACTIVE, S.EVENT_SELESAI);
  assert.strictEqual(t.decision, 'ACCEPT_CORRECTION');
  assert.strictEqual(t.nextState, S.STATE_SELESAI_ACTIVE);
  assert.strictEqual(t.reasonCode, S.REASON_SUPERSEDED_SELESAI);
});
test('extra: EXCEPTION_SELESAI_WITHOUT_HANTAR + Selesai -> ACCEPT_CORRECTION, stays exception', function () {
  var t = S.evaluateTransition_(S.STATE_EXCEPTION_SELESAI_WITHOUT_HANTAR, S.EVENT_SELESAI);
  assert.strictEqual(t.decision, 'ACCEPT_CORRECTION');
  assert.strictEqual(t.nextState, S.STATE_EXCEPTION_SELESAI_WITHOUT_HANTAR);
  assert.strictEqual(t.isException, true);
});

// ---- D. Duplicate Ambil after completion ----
test('D: COMPLETE_BY_AMBIL + Ambil -> REJECT (post-terminal)', function () {
  var t = S.evaluateTransition_(S.STATE_COMPLETE_BY_AMBIL, S.EVENT_AMBIL);
  assert.strictEqual(t.decision, 'REJECT');
  assert.strictEqual(t.reasonCode, S.REASON_POST_TERMINAL_EVENT);
});

// ---- E. Hantar after Selesai ----
test('E: SELESAI_ACTIVE + Hantar -> REJECT (HANTAR_AFTER_SELESAI), no backfill/new cycle', function () {
  var t = S.evaluateTransition_(S.STATE_SELESAI_ACTIVE, S.EVENT_HANTAR);
  assert.strictEqual(t.decision, 'REJECT');
  assert.strictEqual(t.reasonCode, S.REASON_HANTAR_AFTER_SELESAI);
  assert.strictEqual(t.nextState, null);
});

// ---- F. Hantar after completion ----
test('F: COMPLETE_BY_ADMIN + Hantar -> REJECT (post-terminal)', function () {
  var t = S.evaluateTransition_(S.STATE_COMPLETE_BY_ADMIN, S.EVENT_HANTAR);
  assert.strictEqual(t.decision, 'REJECT');
  assert.strictEqual(t.reasonCode, S.REASON_POST_TERMINAL_EVENT);
});
test('F: COMPLETE_BY_AUTO + Selesai -> REJECT (post-terminal)', function () {
  var t = S.evaluateTransition_(S.STATE_COMPLETE_BY_AUTO, S.EVENT_SELESAI);
  assert.strictEqual(t.decision, 'REJECT');
});

// ---- G. Selesai without Hantar ----
test('G: NOT_STARTED + Selesai -> ACCEPT, EXCEPTION_SELESAI_WITHOUT_HANTAR, isException', function () {
  var t = S.evaluateTransition_(S.STATE_NOT_STARTED, S.EVENT_SELESAI);
  assert.strictEqual(t.decision, 'ACCEPT');
  assert.strictEqual(t.nextState, S.STATE_EXCEPTION_SELESAI_WITHOUT_HANTAR);
  assert.strictEqual(t.isException, true);
});
test('G: EXCEPTION_SELESAI_WITHOUT_HANTAR + Hantar -> REJECT, no backfill', function () {
  var t = S.evaluateTransition_(S.STATE_EXCEPTION_SELESAI_WITHOUT_HANTAR, S.EVENT_HANTAR);
  assert.strictEqual(t.decision, 'REJECT');
  assert.strictEqual(t.reasonCode, S.REASON_HANTAR_AFTER_EXCEPTION);
});

// ---- H. Ambil before Selesai ----
test('H: HANTAR_ACTIVE + Ambil -> ACCEPT_EXCEPTION, COMPLETE_BY_AMBIL, isException', function () {
  var t = S.evaluateTransition_(S.STATE_HANTAR_ACTIVE, S.EVENT_AMBIL);
  assert.strictEqual(t.decision, 'ACCEPT_EXCEPTION');
  assert.strictEqual(t.nextState, S.STATE_COMPLETE_BY_AMBIL);
  assert.strictEqual(t.isException, true);
});

// ---- I. Ambil before any event ----
test('I: NOT_STARTED + Ambil -> ACCEPT_EXCEPTION, COMPLETE_BY_AMBIL, isException', function () {
  var t = S.evaluateTransition_(S.STATE_NOT_STARTED, S.EVENT_AMBIL);
  assert.strictEqual(t.decision, 'ACCEPT_EXCEPTION');
  assert.strictEqual(t.nextState, S.STATE_COMPLETE_BY_AMBIL);
  assert.strictEqual(t.isException, true);
});

// ---- AF. Terminal immutability ----
test('AF: every terminal state rejects every event type', function () {
  var terminals = [S.STATE_COMPLETE_BY_AMBIL, S.STATE_COMPLETE_BY_ADMIN, S.STATE_COMPLETE_BY_AUTO];
  var events = [S.EVENT_HANTAR, S.EVENT_SELESAI, S.EVENT_AMBIL];
  terminals.forEach(function (st) {
    events.forEach(function (ev) {
      var t = S.evaluateTransition_(st, ev);
      assert.strictEqual(t.decision, 'REJECT', st + ' + ' + ev + ' should REJECT');
      assert.strictEqual(t.nextState, null, st + ' + ' + ev + ' must not produce a next state');
    });
  });
});

// ---- Unrecognized event type (defensive, not a business scenario) ----
test('defensive: unrecognized event type always REJECTs, from any state', function () {
  var t = S.evaluateTransition_(S.STATE_NOT_STARTED, 'Something Else');
  assert.strictEqual(t.decision, 'REJECT');
  assert.strictEqual(t.reasonCode, S.REASON_UNRECOGNIZED_EVENT_TYPE);
});

// ---- SLA (frozen: Hantar->Selesai, 4h threshold) ----
test('SLA: within 4h -> PATUH, correct TatMs', function () {
  var hantar = new Date('2026-01-01T08:00:00Z').toISOString();
  var selesai = new Date('2026-01-01T10:00:00Z').toISOString();
  var r = S.computeSla_(hantar, selesai);
  assert.strictEqual(r.slaStatus, 'PATUH');
  assert.strictEqual(r.tatMs, 2 * 3600000);
});
test('SLA: exactly 4h -> PATUH (threshold is inclusive, "<=" per frozen SLA_LIMIT_MS)', function () {
  var hantar = new Date('2026-01-01T08:00:00Z').toISOString();
  var selesai = new Date('2026-01-01T12:00:00Z').toISOString();
  var r = S.computeSla_(hantar, selesai);
  assert.strictEqual(r.slaStatus, 'PATUH');
});
test('SLA: beyond 4h -> LEWAT', function () {
  var hantar = new Date('2026-01-01T08:00:00Z').toISOString();
  var selesai = new Date('2026-01-01T13:00:00Z').toISOString();
  var r = S.computeSla_(hantar, selesai);
  assert.strictEqual(r.slaStatus, 'LEWAT');
});
test('SLA: no Hantar -> TIDAK_DAPAT_DIKIRA, tatMs null (no invented TAT)', function () {
  var r = S.computeSla_(null, new Date().toISOString());
  assert.strictEqual(r.slaStatus, 'TIDAK_DAPAT_DIKIRA');
  assert.strictEqual(r.tatMs, null);
});

// ---- Waiting time (frozen: Selesai->genuine Ambil only) ----
test('Waiting: null when either timestamp missing (never fabricated)', function () {
  assert.strictEqual(S.computeWaitMs_(null, new Date().toISOString()), null);
  assert.strictEqual(S.computeWaitMs_(new Date().toISOString(), null), null);
});
test('Waiting: correct duration when both present', function () {
  var selesai = new Date('2026-01-01T10:00:00Z').toISOString();
  var ambil = new Date('2026-01-01T10:15:00Z').toISOString();
  assert.strictEqual(S.computeWaitMs_(selesai, ambil), 15 * 60000);
});

// ---- Cycle_ID (frozen: deterministic, no counter, no random) ----
test('Cycle_ID: deterministic and stable for the same WardCode+day', function () {
  assert.strictEqual(S.deriveCycleId_('WL4A', '2026-09-21'), 'WL4A_2026-09-21');
  assert.strictEqual(S.deriveCycleId_('WL4A', '2026-09-21'), S.deriveCycleId_('WL4A', '2026-09-21'));
});

// ---- S. Cross-midnight: no cycle crosses 00:00 ----
test('S: resolveOperationalDay_ buckets pre/post-midnight KL timestamps into different days', function () {
  // 23:58 and the next 00:05, both Asia/Kuala_Lumpur wall-clock time
  // (UTC+8), expressed here as UTC instants 8h earlier.
  var beforeMidnightKL = new Date('2026-09-20T15:58:00Z'); // 2026-09-20 23:58 KL
  var afterMidnightKL = new Date('2026-09-20T16:05:00Z');  // 2026-09-21 00:05 KL
  var day1 = S.resolveOperationalDay_(beforeMidnightKL);
  var day2 = S.resolveOperationalDay_(afterMidnightKL);
  assert.notStrictEqual(day1, day2, 'timestamps either side of KL midnight must resolve to different operational days');
  assert.strictEqual(S.deriveCycleId_('WL4A', day1) !== S.deriveCycleId_('WL4A', day2), true, 'must produce two distinct Cycle_IDs, never one spanning both');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
