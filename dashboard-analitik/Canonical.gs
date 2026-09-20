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
