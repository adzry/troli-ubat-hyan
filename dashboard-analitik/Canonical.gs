/**
 * CANONICAL CYCLE ARCHITECTURE - DASHBOARD ANALITIK (Phase 9)
 *
 * IMPORTANT: this file does NOT contain a second transition engine.
 * dashboard-analitik never evaluates HANTAR/SELESAI/AMBIL events -- it only
 * reads Cycle_Summary (read-only) and, for Admin Closure, forces an
 * already-non-terminal cycle straight to a terminal state. That is a
 * distinct, much simpler operation explicitly permitted to bypass the
 * normal transition flow (frozen rule 19: "Admin Closure may bypass any
 * non-terminal state") -- it is not a competing interpretation of
 * HANTAR/SELESAI/AMBIL semantics.
 *
 * The constants below mirror sistem-notifikasi/Canonical.gs's schema
 * exactly. Apps Script gives standalone projects no shared library without
 * a formal Library dependency (a separate script project + version
 * management via the Apps Script UI, out of scope for this implementation
 * pass -- see Phase 9 report "Known limitations"). Any future change to
 * Cycle_Summary's/Rejection_Audit's column layout in
 * sistem-notifikasi/Canonical.gs MUST be mirrored here manually.
 */

var SHEET_CYCLE_SUMMARY_ = 'Cycle_Summary';
var SHEET_REJECTION_AUDIT_ = 'Rejection_Audit';
var SHEET_ADMIN_USERS_ = 'Admin_Users';
var SHEET_CYCLE_SUMMARY_LEGACY_ = 'Cycle_Summary_Reconstructed_Legacy';

var STATE_COMPLETE_BY_AMBIL_ = 'COMPLETE_BY_AMBIL';
var STATE_COMPLETE_BY_ADMIN_ = 'COMPLETE_BY_ADMIN';
var STATE_COMPLETE_BY_AUTO_ = 'COMPLETE_BY_AUTO';
var TERMINAL_STATES_ = [STATE_COMPLETE_BY_AMBIL_, STATE_COMPLETE_BY_ADMIN_, STATE_COMPLETE_BY_AUTO_];
function isTerminalState2_(state) { return TERMINAL_STATES_.indexOf(state) > -1; }

var MSG_ADMIN_CLOSURE_ = 'ADMIN CLOSURE — Ditutup secara manual oleh pentadbir';

var CS_COL_ = {
  CYCLE_ID: 1, WARD_CODE: 2, WARD: 3, OPERATIONAL_DAY: 4, CURRENT_STATE: 5,
  HANTAR_TS: 6, SELESAI_TS: 7, AMBIL_TS: 8, IS_EXCEPTION: 9, TAT_MS: 10,
  SLA_STATUS: 11, WAIT_MS: 12, CLOSURE_TYPE: 13, CLOSURE_MESSAGE: 14,
  SCHEDULED_BOUNDARY: 15, CLOSED_AT: 16
};
var CS_HEADERS_LEN_ = 16;

var RA_COL_ = {
  AUDIT_ID: 1, RECORD_TYPE: 2, TIMESTAMP: 3, CYCLE_ID: 4, WARD: 5, OPERATIONAL_DAY: 6,
  EVENT_TYPE: 7, FORM_RESPONSE_ID: 8, REJECTED_PAYLOAD: 9, PREVIOUS_VALUE: 10,
  NEW_VALUE: 11, PREVIOUS_STATE: 12, RESULTING_STATE: 13, REASON_CODE: 14,
  REASON_TEXT: 15, ACTOR_TYPE: 16, ACTOR_IDENTITY: 17, EVENT_ROW_REF: 18,
  IDEMPOTENCY_KEY: 19, METADATA: 20
};
var RA_HEADERS_LEN_ = 20;

// =====================================================================
// PHASE 9D -- ADMIN CLOSURE AUTHENTICATION / AUTHORIZATION
//
// Frozen requirements: real Google authentication, server-side
// authorization against an allow-list, no manual-name fallback, block the
// action entirely if identity cannot be established. See Phase 8
// correction pass §2 for the full deployment-mode analysis this
// implements.
//
// IMPORTANT DEPLOYMENT DEPENDENCY: Session.getActiveUser() only returns a
// real visitor identity when this web app's deployment access level is
// NOT "Anyone, even anonymous" -- it must be deployed with access
// restricted to "Anyone with a Google account" (or "Only within your
// organization" for a Workspace domain, the cleaner option if available)
// AND executeAs = "User accessing the web app". This cannot be forced by
// pushing code alone (see appsscript.json comment + Phase 9 report,
// "Manual deployment/setup steps still required") -- redeploying with the
// corrected access level is a required manual step in the Apps Script
// editor's Deploy dialog.
// =====================================================================

function getAuthenticatedAdminEmail_() {
  try {
    var email = Session.getActiveUser().getEmail();
    return email || null;
  } catch (err) {
    return null;
  }
}

function isAuthorizedAdmin_(ss, email) {
  if (!email) return false;
  var sheet = ss.getSheetByName(SHEET_ADMIN_USERS_);
  if (!sheet) return false;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var rows = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  for (var i = 0; i < rows.length; i++) {
    var rowEmail = String(rows[i][0] || '').trim().toLowerCase();
    var active = rows[i][1] === true || rows[i][1] === 'TRUE';
    if (active && rowEmail === email.trim().toLowerCase()) return true;
  }
  return false;
}

function findCycleSummaryRow2_(sheet, cycleId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var data = sheet.getRange(2, 1, lastRow - 1, CS_HEADERS_LEN_).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][CS_COL_.CYCLE_ID - 1] === cycleId) return { rowIndex: i + 2, values: data[i] };
  }
  return null;
}

var _auditIdCounter2_ = 0;
function generateAuditId2_() {
  _auditIdCounter2_++;
  return 'AUD_' + new Date().getTime() + '_' + _auditIdCounter2_;
}

function writeRejectionAudit2_(ss, fields) {
  var sheet = ss.getSheetByName(SHEET_REJECTION_AUDIT_);
  var row = new Array(RA_HEADERS_LEN_);
  row[RA_COL_.AUDIT_ID - 1] = generateAuditId2_();
  row[RA_COL_.RECORD_TYPE - 1] = 'AUDIT_EVENT';
  row[RA_COL_.TIMESTAMP - 1] = new Date();
  row[RA_COL_.CYCLE_ID - 1] = fields.cycleId || '';
  row[RA_COL_.WARD - 1] = fields.ward || '';
  row[RA_COL_.OPERATIONAL_DAY - 1] = fields.operationalDay || '';
  row[RA_COL_.PREVIOUS_STATE - 1] = fields.previousState || '';
  row[RA_COL_.RESULTING_STATE - 1] = fields.resultingState || '';
  row[RA_COL_.REASON_CODE - 1] = fields.reasonCode || '';
  row[RA_COL_.REASON_TEXT - 1] = fields.reasonText || '';
  row[RA_COL_.ACTOR_TYPE - 1] = fields.actorType || '';
  row[RA_COL_.ACTOR_IDENTITY - 1] = fields.actorIdentity || '';
  sheet.appendRow(row);
}

/**
 * Server-side entry point for the dashboard's Admin Closure button.
 * cycleIds: array of CycleId strings selected by the admin in the UI.
 * Every requirement is enforced here, not in the client:
 *   - real authenticated identity (Session.getActiveUser())
 *   - allow-list authorization (Admin_Users, Active=true)
 *   - terminal cycles cannot be reopened/re-closed
 *   - no synthetic AMBIL event, ever
 *   - locked, audited
 */
function closeCycleAdmin(cycleIds) {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  if (!id) return { error: 'Belum disambungkan ke database.' };
  var ss = SpreadsheetApp.openById(id);

  var email = getAuthenticatedAdminEmail_();
  if (!email) {
    return { error: 'Identiti pengguna tidak dapat disahkan. Admin Closure memerlukan log masuk Google yang sah -- operasi disekat.' };
  }
  if (!isAuthorizedAdmin_(ss, email)) {
    writeRejectionAudit2_(ss, {
      reasonCode: 'UNAUTHORIZED_ADMIN',
      reasonText: 'Percubaan Admin Closure oleh akaun tidak dibenarkan: ' + email,
      actorType: 'ADMIN', actorIdentity: email
    });
    return { error: 'Akaun ' + email + ' tidak dibenarkan melakukan Admin Closure. Sila hubungi pentadbir sistem.' };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { error: 'Sistem sibuk (gagal dapat lock). Sila cuba lagi.' };
  }

  try {
    var sheet = ss.getSheetByName(SHEET_CYCLE_SUMMARY_);
    var closed = [];
    var skipped = [];

    (cycleIds || []).forEach(function (cycleId) {
      var found = findCycleSummaryRow2_(sheet, cycleId);
      if (!found) { skipped.push(cycleId + ' (tidak dijumpai)'); return; }

      var currentState = found.values[CS_COL_.CURRENT_STATE - 1];
      if (isTerminalState2_(currentState)) {
        skipped.push(cycleId + ' (sudah tamat/frozen -- tidak boleh dibuka semula)');
        return;
      }

      var row = found.values.slice();
      row[CS_COL_.CURRENT_STATE - 1] = STATE_COMPLETE_BY_ADMIN_;
      row[CS_COL_.CLOSURE_TYPE - 1] = 'ADMIN';
      row[CS_COL_.CLOSURE_MESSAGE - 1] = MSG_ADMIN_CLOSURE_;
      row[CS_COL_.WAIT_MS - 1] = ''; // frozen: Admin Closure never produces genuine waiting time
      row[CS_COL_.CLOSED_AT - 1] = new Date().toISOString();
      // HantarTs/SelesaiTs/AmbilTs/TatMs untouched -- Admin Closure never
      // fabricates an Ambil event or rewrites SLA facts.
      sheet.getRange(found.rowIndex, 1, 1, row.length).setValues([row]);

      writeRejectionAudit2_(ss, {
        cycleId: cycleId, ward: found.values[CS_COL_.WARD - 1], operationalDay: found.values[CS_COL_.OPERATIONAL_DAY - 1],
        previousState: currentState, resultingState: STATE_COMPLETE_BY_ADMIN_,
        reasonCode: 'ADMIN_CLOSURE', reasonText: MSG_ADMIN_CLOSURE_,
        actorType: 'ADMIN', actorIdentity: email
      });
      closed.push(cycleId);
    });

    return { closed: closed, skipped: skipped, actorIdentity: email };
  } finally {
    lock.releaseLock();
  }
}

// =====================================================================
// PHASE 9H -- CUTOVER-AWARE READ HELPERS
// Mirrors sistem-notifikasi/Canonical.gs's getCutoverTimestamp_ exactly
// (same System_Config sheet in the shared spreadsheet -- see that file's
// comment on why this cannot live in PropertiesService).
// =====================================================================

var SHEET_SYSTEM_CONFIG_ = 'System_Config';
var CONFIG_KEY_CUTOVER_ = 'CANONICAL_CUTOVER_TIMESTAMP';

function getCutoverTimestamp2_(ss) {
  var sheet = ss.getSheetByName(SHEET_SYSTEM_CONFIG_);
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === CONFIG_KEY_CUTOVER_ && data[i][1]) return new Date(data[i][1]);
  }
  return null;
}

/**
 * Splits [rangeStart, rangeEnd] against the cutover moment into a legacy
 * sub-range and a canonical sub-range, either of which may be null if the
 * whole requested range falls entirely on one side. Cycle-derived metrics
 * for the two sub-ranges are NEVER combined into one blended figure
 * (Phase 8 correction §6) -- only this split is computed here; callers
 * compute each side from its own authoritative source.
 */
function splitRangeAtCutover_(rangeStart, rangeEnd, cutover) {
  if (!cutover) return { legacy: { start: rangeStart, end: rangeEnd }, canonical: null, mode: 'no_cutover_yet' };
  if (cutover <= rangeStart) return { legacy: null, canonical: { start: rangeStart, end: rangeEnd }, mode: 'canonical' };
  if (cutover >= rangeEnd) return { legacy: { start: rangeStart, end: rangeEnd }, canonical: null, mode: 'legacy' };
  return {
    legacy: { start: rangeStart, end: cutover },
    canonical: { start: cutover, end: rangeEnd },
    mode: 'mixed'
  };
}

/**
 * Canonical (post-cutover) cycle metrics, sourced ENTIRELY from
 * Cycle_Summary -- never SLA_Summary. Shape mirrors the legacy
 * getDashboardData()'s cycle-metric fields so the same render functions on
 * the dashboard can consume either one, clearly labeled by the caller.
 */
function getCanonicalCycleMetrics_(ss, tz, start, end) {
  var sheet = ss.getSheetByName(SHEET_CYCLE_SUMMARY_);
  var lastRow = sheet.getLastRow();
  var result = {
    totalCycles: 0, patuhCount: 0, lewatCount: 0,
    avgDurasiPengisian: -1, avgDurasiTunggu: -1,
    dailyTrend: [], lateList: [], wadComparison: {}, allCycles: []
  };
  if (lastRow < 2) return result;

  var data = sheet.getRange(2, 1, lastRow - 1, CS_HEADERS_LEN_).getValues();
  var totalDurasi = 0, totalTunggu = 0, tungguCount = 0;
  var dailyMap = {};
  var wadStats = {};

  data.forEach(function (row) {
    var opDayStr = row[CS_COL_.OPERATIONAL_DAY - 1];
    var opDay = new Date(opDayStr + 'T00:00:00');
    if (opDay < start || opDay >= end) return;
    if (!isTerminalState2_(row[CS_COL_.CURRENT_STATE - 1])) return; // only completed cycles count toward SLA stats, matching legacy semantics

    var ward = row[CS_COL_.WARD - 1];
    var tatMs = row[CS_COL_.TAT_MS - 1];
    var slaStatus = row[CS_COL_.SLA_STATUS - 1];
    var waitMs = row[CS_COL_.WAIT_MS - 1];

    result.totalCycles++;
    var isPatuh = slaStatus === 'PATUH';
    if (slaStatus) { if (isPatuh) result.patuhCount++; else if (slaStatus === 'LEWAT') result.lewatCount++; }
    if (typeof tatMs === 'number') totalDurasi += tatMs / 3600000;
    if (typeof waitMs === 'number') { totalTunggu += waitMs / 3600000; tungguCount++; }

    if (!wadStats[ward]) wadStats[ward] = { cycles: 0, patuh: 0, lewat: 0, totalDurasi: 0, totalTunggu: 0, tungguCount: 0 };
    wadStats[ward].cycles++;
    if (slaStatus === 'PATUH') wadStats[ward].patuh++; else if (slaStatus === 'LEWAT') wadStats[ward].lewat++;
    if (typeof tatMs === 'number') wadStats[ward].totalDurasi += tatMs / 3600000;
    if (typeof waitMs === 'number') { wadStats[ward].totalTunggu += waitMs / 3600000; wadStats[ward].tungguCount++; }

    var dayKey = Utilities.formatDate(opDay, tz, 'dd/MM');
    if (!dailyMap[dayKey]) dailyMap[dayKey] = { cycles: 0, patuh: 0, lewat: 0, sortKey: opDay.getTime() };
    dailyMap[dayKey].cycles++;
    if (slaStatus === 'PATUH') dailyMap[dayKey].patuh++; else if (slaStatus === 'LEWAT') dailyMap[dayKey].lewat++;

    if (slaStatus === 'LEWAT') {
      result.lateList.push({
        wad: ward, tarikh: Utilities.formatDate(opDay, tz, 'dd/MM/yyyy'),
        masaHantar: row[CS_COL_.HANTAR_TS - 1] ? Utilities.formatDate(new Date(row[CS_COL_.HANTAR_TS - 1]), tz, 'HH:mm') : '-',
        masaSelesai: row[CS_COL_.SELESAI_TS - 1] ? Utilities.formatDate(new Date(row[CS_COL_.SELESAI_TS - 1]), tz, 'HH:mm') : '-',
        durasi: typeof tatMs === 'number' ? (tatMs / 3600000).toFixed(2) : ''
      });
    }

    result.allCycles.push({
      wad: ward, tarikh: Utilities.formatDate(opDay, tz, 'dd/MM/yyyy'), sortKey: opDay.getTime(),
      dayOfWeek: opDay.getDay(), monthStr: Utilities.formatDate(opDay, tz, 'MM/yyyy'),
      masaHantar: row[CS_COL_.HANTAR_TS - 1] ? Utilities.formatDate(new Date(row[CS_COL_.HANTAR_TS - 1]), tz, 'HH:mm') : '-',
      masaSelesai: row[CS_COL_.SELESAI_TS - 1] ? Utilities.formatDate(new Date(row[CS_COL_.SELESAI_TS - 1]), tz, 'HH:mm') : '-',
      masaAmbil: row[CS_COL_.AMBIL_TS - 1] ? Utilities.formatDate(new Date(row[CS_COL_.AMBIL_TS - 1]), tz, 'HH:mm') : null,
      masaPengiMinit: typeof tatMs === 'number' ? Math.round(tatMs / 60000) : null,
      masaTungguMinit: typeof waitMs === 'number' ? Math.round(waitMs / 60000) : null,
      patuh: slaStatus === 'PATUH'
    });
  });

  result.avgDurasiPengisian = result.totalCycles > 0 ? (totalDurasi / result.totalCycles).toFixed(2) : -1;
  result.avgDurasiTunggu = tungguCount > 0 ? (totalTunggu / tungguCount).toFixed(2) : -1;
  result.dailyTrend = Object.keys(dailyMap).map(function (k) {
    return { label: k, cycles: dailyMap[k].cycles, patuh: dailyMap[k].patuh, lewat: dailyMap[k].lewat, sortKey: dailyMap[k].sortKey };
  }).sort(function (a, b) { return a.sortKey - b.sortKey; });
  result.lateList.sort(function (a, b) { return parseFloat(b.durasi) - parseFloat(a.durasi); });
  result.wadComparison = wadStats;
  return result;
}

/**
 * Canonical (post-cutover) rejection/exception list, sourced from
 * Rejection_Audit -- structurally distinct from the legacy "ANOMALI:"
 * text-matched list, never merged with it.
 */
function getCanonicalAnomaliList_(ss, tz, start, end) {
  var sheet = ss.getSheetByName(SHEET_REJECTION_AUDIT_);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var data = sheet.getRange(2, 1, lastRow - 1, RA_HEADERS_LEN_).getValues();
  var list = [];
  data.forEach(function (row) {
    var ts = row[RA_COL_.TIMESTAMP - 1];
    if (!ts || ts < start || ts >= end) return;
    var recordType = row[RA_COL_.RECORD_TYPE - 1];
    var reasonCode = row[RA_COL_.REASON_CODE - 1];
    // Admin/Auto closure and reconciliation housekeeping are audit
    // records, not anomalies for this list -- they are surfaced elsewhere
    // (Admin/Auto Closure history), keeping this list focused on rejected
    // submissions and flagged exceptions, matching the legacy list's intent.
    if (reasonCode === 'ADMIN_CLOSURE' || reasonCode === 'AUTO_CLOSURE' ||
      reasonCode === 'RECONCILIATION_REPAIR' || reasonCode === 'RECONCILIATION_ANOMALY') return;
    list.push({
      tarikh: Utilities.formatDate(ts, tz, 'dd/MM/yyyy'),
      masa: Utilities.formatDate(ts, tz, 'HH:mm'),
      wad: row[RA_COL_.WARD - 1],
      event: row[RA_COL_.EVENT_TYPE - 1],
      nama: '', // Rejection_Audit does not carry a Nama field (rejected
      // submissions were never accepted into Log_Troli, so there is no
      // respondent-name column to draw from here) -- the dashboard falls
      // back to a placeholder for this column on canonical-sourced rows.
      recordType: recordType,
      reasonCode: reasonCode,
      sebab: row[RA_COL_.REASON_TEXT - 1]
    });
  });
  list.sort(function (a, b) { return b.tarikh.localeCompare(a.tarikh) || b.masa.localeCompare(a.masa); });
  return list;
}

/**
 * Replaces the old age-based getStuckCycles(). Returns every currently
 * non-terminal Cycle_Summary row, with no age threshold -- Admin Closure
 * may bypass ANY non-terminal state at any age (frozen rule 19).
 */
function getOpenCycles() {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  if (!id) return { error: 'Belum disambungkan ke database.' };
  var ss = SpreadsheetApp.openById(id);
  var sheet = ss.getSheetByName(SHEET_CYCLE_SUMMARY_);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { open: [] };

  var data = sheet.getRange(2, 1, lastRow - 1, CS_HEADERS_LEN_).getValues();
  var open = [];
  data.forEach(function (row) {
    var state = row[CS_COL_.CURRENT_STATE - 1];
    if (isTerminalState2_(state)) return;
    open.push({
      cycleId: row[CS_COL_.CYCLE_ID - 1],
      ward: row[CS_COL_.WARD - 1],
      operationalDay: row[CS_COL_.OPERATIONAL_DAY - 1],
      currentState: state
    });
  });
  return { open: open };
}
