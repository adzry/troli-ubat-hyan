/**
 * CANONICAL CYCLE ARCHITECTURE - SISTEM TROLI UBAT HYAN
 * Phase 9 implementation of the Phase 6/7/8 FROZEN business/process model.
 *
 * This file is the SINGLE canonical cycle-interpretation engine for the
 * whole system. Code.gs (onFormSubmit, getWadStatus) calls into this file;
 * dashboard-analitik has its own copy of the small, closure-only subset it
 * needs for Admin Closure (see PHASE9-CLOSURE commit) because Apps Script
 * gives no shared library between standalone projects without a formal
 * Library dependency (out of scope -- see Phase 9 report "Known
 * limitations"). dashboard-analitik NEVER evaluates HANTAR/SELESAI/AMBIL
 * transitions -- it only reads Cycle_Summary and, for Admin Closure, forces
 * an already-non-terminal cycle to a terminal state. That is a distinct,
 * much simpler operation (frozen rule: "Admin Closure may bypass any
 * non-terminal state") and is not a second transition engine.
 *
 * FROZEN CANONICAL STATES (do not add/remove/rename):
 *   NOT_STARTED, HANTAR_ACTIVE, SELESAI_ACTIVE,
 *   EXCEPTION_SELESAI_WITHOUT_HANTAR,
 *   COMPLETE_BY_AMBIL, COMPLETE_BY_ADMIN, COMPLETE_BY_AUTO
 */

// ====== CANONICAL SHEET NAMES ======
var SHEET_CYCLE_SUMMARY = 'Cycle_Summary';
var SHEET_REJECTION_AUDIT = 'Rejection_Audit';
var SHEET_WARD_MASTER = 'Ward_Master';
var SHEET_ADMIN_USERS = 'Admin_Users';
var SHEET_CYCLE_SUMMARY_LEGACY = 'Cycle_Summary_Reconstructed_Legacy';

// ====== CANONICAL STATES (frozen, Phase 6/7/8) ======
var STATE_NOT_STARTED = 'NOT_STARTED';
var STATE_HANTAR_ACTIVE = 'HANTAR_ACTIVE';
var STATE_SELESAI_ACTIVE = 'SELESAI_ACTIVE';
var STATE_EXCEPTION_SELESAI_WITHOUT_HANTAR = 'EXCEPTION_SELESAI_WITHOUT_HANTAR';
var STATE_COMPLETE_BY_AMBIL = 'COMPLETE_BY_AMBIL';
var STATE_COMPLETE_BY_ADMIN = 'COMPLETE_BY_ADMIN';
var STATE_COMPLETE_BY_AUTO = 'COMPLETE_BY_AUTO';

var TERMINAL_STATES = [STATE_COMPLETE_BY_AMBIL, STATE_COMPLETE_BY_ADMIN, STATE_COMPLETE_BY_AUTO];

function isTerminalState_(state) {
  return TERMINAL_STATES.indexOf(state) > -1;
}

// ====== FIXED MESSAGE STRINGS (frozen, Phase 6/7/8 -- do not reword) ======
var MSG_AMBIL_BEFORE_SELESAI = 'Tidak scan QR selepas semak.';
var MSG_ADMIN_CLOSURE = 'ADMIN CLOSURE — Ditutup secara manual oleh pentadbir';
var MSG_AUTO_CLOSURE_HANTAR_ONLY = 'AUTO CLOSURE — QR tidak discan selepas semakan ubat dibuat dan selepas Troli diambil';
var MSG_AUTO_CLOSURE_SELESAI_ONLY = 'AUTO CLOSURE — Pengambil troli tidak scan selepas troli diambil';
var MSG_AUTO_CLOSURE_EXCEPTION = 'AUTO CLOSURE — Selesai tanpa Hantar tidak diambil sebelum tamat hari';

// ====== REASON CODES (engineering vocabulary, not business rules) ======
var REASON_UNKNOWN_WARD = 'UNKNOWN_WARD';
var REASON_WARD_INACTIVE = 'WARD_INACTIVE';
var REASON_HANTAR_AFTER_SELESAI = 'HANTAR_AFTER_SELESAI';
var REASON_HANTAR_AFTER_EXCEPTION = 'HANTAR_AFTER_EXCEPTION';
var REASON_POST_TERMINAL_EVENT = 'POST_TERMINAL_EVENT';
var REASON_UNRECOGNIZED_EVENT_TYPE = 'UNRECOGNIZED_EVENT_TYPE';
var REASON_SUPERSEDED_HANTAR = 'SUPERSEDED_HANTAR';
var REASON_SUPERSEDED_SELESAI = 'SUPERSEDED_SELESAI';
var REASON_ADMIN_CLOSURE = 'ADMIN_CLOSURE';
var REASON_AUTO_CLOSURE = 'AUTO_CLOSURE';
var REASON_LOCK_TIMEOUT = 'LOCK_TIMEOUT';
var REASON_RECONCILIATION_REPAIR = 'RECONCILIATION_REPAIR';
var REASON_RECONCILIATION_ANOMALY = 'RECONCILIATION_ANOMALY';
var REASON_RETRY_SUPPRESSED = 'RETRY_SUPPRESSED';
var REASON_UNAUTHORIZED_ADMIN = 'UNAUTHORIZED_ADMIN';

var RECORD_TYPE_REJECTED = 'REJECTED_SUBMISSION';
var RECORD_TYPE_AUDIT = 'AUDIT_EVENT';

var TZ = 'Asia/Kuala_Lumpur';

// ====== CYCLE_SUMMARY COLUMN MAP (1-indexed, matches sheet layout below) ======
var CS_COL = {
  CYCLE_ID: 1, WARD_CODE: 2, WARD: 3, OPERATIONAL_DAY: 4, CURRENT_STATE: 5,
  HANTAR_TS: 6, SELESAI_TS: 7, AMBIL_TS: 8, IS_EXCEPTION: 9, TAT_MS: 10,
  SLA_STATUS: 11, WAIT_MS: 12, CLOSURE_TYPE: 13, CLOSURE_MESSAGE: 14,
  SCHEDULED_BOUNDARY: 15, CLOSED_AT: 16
};
var CS_HEADERS = ['CycleId', 'WardCode', 'Ward', 'OperationalDay', 'CurrentState',
  'HantarTs', 'SelesaiTs', 'AmbilTs', 'IsException', 'TatMs', 'SlaStatus', 'WaitMs',
  'ClosureType', 'ClosureMessage', 'ScheduledBoundary', 'ClosedAt'];

// ====== REJECTION_AUDIT COLUMN MAP ======
var RA_COL = {
  AUDIT_ID: 1, RECORD_TYPE: 2, TIMESTAMP: 3, CYCLE_ID: 4, WARD: 5, OPERATIONAL_DAY: 6,
  EVENT_TYPE: 7, FORM_RESPONSE_ID: 8, REJECTED_PAYLOAD: 9, PREVIOUS_VALUE: 10,
  NEW_VALUE: 11, PREVIOUS_STATE: 12, RESULTING_STATE: 13, REASON_CODE: 14,
  REASON_TEXT: 15, ACTOR_TYPE: 16, ACTOR_IDENTITY: 17, EVENT_ROW_REF: 18,
  IDEMPOTENCY_KEY: 19, METADATA: 20
};
var RA_HEADERS = ['AuditId', 'RecordType', 'Timestamp', 'CycleId', 'Ward', 'OperationalDay',
  'EventType', 'FormResponseId', 'RejectedPayload', 'PreviousValue', 'NewValue',
  'PreviousState', 'ResultingState', 'ReasonCode', 'ReasonText', 'ActorType',
  'ActorIdentity', 'EventRowRef', 'IdempotencyKey', 'Metadata'];

// ====== WARD_MASTER COLUMN MAP ======
var WM_COL = { WARD_CODE: 1, WARD_NAME_CANONICAL: 2, WARD_NAME_ALIASES: 3, ACTIVE: 4, EFFECTIVE_FROM: 5 };
var WM_HEADERS = ['WardCode', 'WardNameCanonical', 'WardNameAliases', 'Active', 'EffectiveFrom'];

// Ward_Master initial population -- sourced ONLY from the actual current
// Form/dashboard destination lists (dashboard-analitik/Code.gs TROLLEY_WADS +
// OTHER_UNITS, 15 entries total, verified against the repository, not invented).
// Wad Test is Active=false per the frozen Phase 8 correction: test/playground
// only, must not enter production operational statistics.
var WARD_MASTER_SEED = [
  ['WL4A', 'Wad Lelaki 4A', 'Wad Lelaki 4A', true],
  ['WL4B', 'Wad Lelaki 4B', 'Wad Lelaki 4B', true],
  ['WPR', 'Wad Perempuan', 'Wad Perempuan', true],
  ['WBS', 'Wad Bersalin', 'Wad Bersalin', true],
  ['WKK', 'Wad Kanak-Kanak', 'Wad Kanak-Kanak', true],
  ['UHD', 'Unit Hemodialisis', 'Unit Hemodialisis', true],
  ['WTEST', 'Wad Test', 'Wad Test', false],
  ['KCT', 'Kecemasan & Trauma', 'Kecemasan & Trauma', true],
  ['KSJ', 'Klinik Sejahtera', 'Klinik Sejahtera', true],
  ['KPK', 'Klinik Pakar', 'Klinik Pakar', true],
  ['ESWL', 'ESWL', 'ESWL', true],
  ['FOR', 'Forensik', 'Forensik', true],
  ['PAT', 'Patologi', 'Patologi', true],
  ['FIZ', 'Fisioterapi', 'Fisioterapi', true],
  ['UCK', 'Unit Cara Kerja (Occupational Therapy)', 'Unit Cara Kerja (Occupational Therapy)', true]
];

var AU_COL = { EMAIL: 1, ACTIVE: 2, NOTES: 3 };
var AU_HEADERS = ['Email', 'Active', 'Notes'];

// ====== CUTOVER CONFIGURATION ======
// The canonical pipeline's go-live timestamp. NOT hardcoded to a guessed
// historical date -- must be set manually, once, at the moment of actual
// production cutover (see Phase 9 report, "Manual deployment/setup steps
// still required"). Reading it before it is set returns null, and callers
// must treat that as "cutover has not happened yet," never guess a date.
//
// IMPORTANT: stored as a row in the shared System_Config sheet in the
// shared database spreadsheet, NOT in PropertiesService. Apps Script's
// PropertiesService.getScriptProperties() is scoped per-project, and
// sistem-notifikasi/dashboard-analitik are two separate standalone
// projects -- a value set in one project's Script Properties is invisible
// to the other. Both projects need to agree on the same cutover moment
// (dashboard for mixed-range reporting, this project for any future
// cutover-aware behavior), so it must live in the one place both projects
// already share: the spreadsheet itself.
var SHEET_SYSTEM_CONFIG = 'System_Config';
var CONFIG_KEY_CUTOVER = 'CANONICAL_CUTOVER_TIMESTAMP';

function getCutoverTimestamp_() {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  if (!id) return null;
  var ss = SpreadsheetApp.openById(id);
  var sheet = ss.getSheetByName(SHEET_SYSTEM_CONFIG);
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === CONFIG_KEY_CUTOVER && data[i][1]) return new Date(data[i][1]);
  }
  return null;
}

/**
 * ONE-TIME setup: run manually from the Apps Script editor after this code
 * is deployed. Creates the 4 new canonical sheets if they do not already
 * exist. Never touches Log_Troli or SLA_Summary. Idempotent -- safe to
 * re-run (skips any sheet that already exists, never overwrites data).
 */
function setupCanonicalArchitecture_() {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  if (!id) { Logger.log('DB_ID belum ditetapkan -- jalankan setupSystem() dahulu.'); return; }
  var ss = SpreadsheetApp.openById(id);

  var created = [];

  if (!ss.getSheetByName(SHEET_CYCLE_SUMMARY)) {
    var cs = ss.insertSheet(SHEET_CYCLE_SUMMARY);
    cs.appendRow(CS_HEADERS);
    cs.getRange(1, 1, 1, CS_HEADERS.length).setFontWeight('bold');
    created.push(SHEET_CYCLE_SUMMARY);
  }

  if (!ss.getSheetByName(SHEET_REJECTION_AUDIT)) {
    var ra = ss.insertSheet(SHEET_REJECTION_AUDIT);
    ra.appendRow(RA_HEADERS);
    ra.getRange(1, 1, 1, RA_HEADERS.length).setFontWeight('bold');
    created.push(SHEET_REJECTION_AUDIT);
  }

  if (!ss.getSheetByName(SHEET_WARD_MASTER)) {
    var wm = ss.insertSheet(SHEET_WARD_MASTER);
    wm.appendRow(WM_HEADERS);
    wm.getRange(1, 1, 1, WM_HEADERS.length).setFontWeight('bold');
    WARD_MASTER_SEED.forEach(function (row) {
      wm.appendRow([row[0], row[1], row[2], row[3], new Date()]);
    });
    created.push(SHEET_WARD_MASTER + ' (' + WARD_MASTER_SEED.length + ' wad diseed)');
  }

  if (!ss.getSheetByName(SHEET_ADMIN_USERS)) {
    var au = ss.insertSheet(SHEET_ADMIN_USERS);
    au.appendRow(AU_HEADERS);
    au.getRange(1, 1, 1, AU_HEADERS.length).setFontWeight('bold');
    // PLACEHOLDER ROW -- must be edited manually. We do not invent the
    // process owner's real email; see Phase 9 report for exact instructions.
    au.appendRow(['REPLACE_WITH_PROCESS_OWNER_EMAIL@example.com', false,
      'PLACEHOLDER -- ganti dengan email Google akaun sebenar pentadbir, ' +
      'dan tukar Active kepada TRUE, sebelum Admin Closure boleh digunakan.']);
    created.push(SHEET_ADMIN_USERS + ' (placeholder row -- MUST be edited manually)');
  }

  if (!ss.getSheetByName(SHEET_SYSTEM_CONFIG)) {
    var cfg = ss.insertSheet(SHEET_SYSTEM_CONFIG);
    cfg.appendRow(['Key', 'Value']);
    cfg.getRange(1, 1, 1, 2).setFontWeight('bold');
    cfg.appendRow([CONFIG_KEY_CUTOVER, '']); // PLACEHOLDER -- set manually at actual cutover, see Phase 9 report
    created.push(SHEET_SYSTEM_CONFIG + ' (CANONICAL_CUTOVER_TIMESTAMP left blank -- MUST be set manually at cutover)');
  }

  if (!ss.getSheetByName(SHEET_CYCLE_SUMMARY_LEGACY)) {
    var legacy = ss.insertSheet(SHEET_CYCLE_SUMMARY_LEGACY);
    legacy.appendRow(['Reconstructed retrospectively under current rules — not the historically-reported figures.']);
    legacy.appendRow(CS_HEADERS);
    legacy.getRange(2, 1, 1, CS_HEADERS.length).setFontWeight('bold');
    legacy.getRange(1, 1, 1, 1).setFontStyle('italic').setFontColor('#B00020');
    created.push(SHEET_CYCLE_SUMMARY_LEGACY);
  }

  // FormResponseId column on Log_Troli -- additive only (column 8), existing
  // 7-column readers are unaffected. Historical rows keep column 8 blank,
  // which is expected and documented (Phase 8 §4/§5) -- never backfilled.
  var logSheet = ss.getSheetByName(SHEET_LOG_NAME);
  if (logSheet && logSheet.getRange(1, 8).getValue() !== 'FormResponseId') {
    logSheet.getRange(1, 8).setValue('FormResponseId').setFontWeight('bold');
    created.push(SHEET_LOG_NAME + ' (added column 8: FormResponseId)');
  }

  Logger.log('setupCanonicalArchitecture_ selesai. Dicipta/dikemaskini: ' + JSON.stringify(created));
  Logger.log('PENTING: (1) edit Admin_Users dengan email pentadbir sebenar; ' +
    '(2) isi nilai "' + CONFIG_KEY_CUTOVER + '" dalam sheet "' + SHEET_SYSTEM_CONFIG + '" (format tarikh/masa ISO) apabila cutover berlaku sebenar.');
  return created;
}

/**
 * Public entry point for setupCanonicalArchitecture_().
 *
 * Apps Script's function-selector dropdown only lists top-level functions
 * whose names do NOT end in "_" -- trailing underscore is Apps Script's
 * convention for "private/internal," and setupCanonicalArchitecture_ is
 * named that way deliberately (it's an internal implementation called by
 * this file's own logic, not originally meant to be run standalone). That
 * made the one-time production bootstrap impossible to trigger from the
 * editor UI. This wrapper adds no logic of its own -- it exists solely so
 * an administrator can select and run the bootstrap from the dropdown.
 *
 * Left in place permanently (not removed post-bootstrap): the underlying
 * function is idempotent -- see setupCanonicalArchitecture_'s own doc
 * comment -- so this remains safe as a standing admin/maintenance entry
 * point (e.g. to re-create a sheet that was accidentally deleted) rather
 * than a one-time-only script that must be cleaned up after use.
 */
function runCanonicalBootstrap() {
  setupCanonicalArchitecture_();
}

// ====== OPERATIONAL DAY ======
function resolveOperationalDay_(timestamp) {
  return Utilities.formatDate(timestamp, TZ, 'yyyy-MM-dd');
}

// ====== WARD RESOLUTION (Ward_Master-backed, never invents a WardCode) ======
function loadWardMasterMap_(ss) {
  var sheet = ss.getSheetByName(SHEET_WARD_MASTER);
  var lastRow = sheet.getLastRow();
  var map = {}; // normalized alias text -> {wardCode, active, canonical}
  if (lastRow < 2) return map;
  var rows = sheet.getRange(2, 1, lastRow - 1, WM_HEADERS.length).getValues();
  rows.forEach(function (row) {
    var wardCode = row[WM_COL.WARD_CODE - 1];
    var canonical = row[WM_COL.WARD_NAME_CANONICAL - 1];
    var aliasesRaw = row[WM_COL.WARD_NAME_ALIASES - 1];
    var active = row[WM_COL.ACTIVE - 1] === true || row[WM_COL.ACTIVE - 1] === 'TRUE';
    var aliases = String(aliasesRaw || canonical).split(',').map(function (a) { return normWardText_(a); });
    aliases.forEach(function (alias) {
      if (alias) map[alias] = { wardCode: wardCode, active: active, canonical: canonical };
    });
  });
  return map;
}

function normWardText_(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Resolves a raw Form ward string against Ward_Master.
 * Returns {ok:true, wardCode, canonical} or {ok:false, reasonCode}.
 * Never fabricates a WardCode for unrecognized text (frozen Phase 8 rule).
 * An entry that IS recognized but Active=false (e.g. Wad Test) is rejected
 * with REASON_WARD_INACTIVE, distinct from REASON_UNKNOWN_WARD, so it never
 * silently enters production cycle statistics per the frozen instruction
 * that Wad Test must not be part of production operational statistics.
 */
function resolveWard_(ss, rawWardText) {
  var map = loadWardMasterMap_(ss);
  var entry = map[normWardText_(rawWardText)];
  if (!entry) return { ok: false, reasonCode: REASON_UNKNOWN_WARD };
  if (!entry.active) return { ok: false, reasonCode: REASON_WARD_INACTIVE, wardCode: entry.wardCode };
  return { ok: true, wardCode: entry.wardCode, canonical: entry.canonical };
}

// ====== CYCLE_ID (deterministic, no counter, no random ID) ======
function deriveCycleId_(wardCode, operationalDay) {
  return wardCode + '_' + operationalDay;
}

// =====================================================================
// PHASE 9B -- CANONICAL TRANSITION ENGINE
// This is the ONE canonical cycle-interpretation function in the system.
// It is pure (no sheet I/O) so it can be unit-tested directly and reused
// identically by the live write pipeline, reconciliation, and Auto Closure.
// It is deliberately a lookup table over (currentState, eventType), per
// the frozen Phase 9 transition spec -- not re-derived ad hoc anywhere else.
// =====================================================================

/**
 * @param {string} currentState one of the 7 canonical states
 * @param {string} eventType EVENT_HANTAR / EVENT_SELESAI / EVENT_AMBIL
 * @returns {{decision:string, nextState:(string|null), isException:boolean,
 *            reasonCode:(string|null)}}
 *   decision is one of: 'ACCEPT', 'ACCEPT_CORRECTION', 'ACCEPT_EXCEPTION', 'REJECT'
 */
function evaluateTransition_(currentState, eventType) {
  if (eventType !== EVENT_HANTAR && eventType !== EVENT_SELESAI && eventType !== EVENT_AMBIL) {
    return { decision: 'REJECT', nextState: null, isException: false, reasonCode: REASON_UNRECOGNIZED_EVENT_TYPE };
  }

  if (isTerminalState_(currentState)) {
    // Frozen rules 12/13/14: any event after completion is REJECT + AUDIT,
    // regardless of event type. Terminal cycles are immutable (rule 10/11).
    return { decision: 'REJECT', nextState: null, isException: false, reasonCode: REASON_POST_TERMINAL_EVENT };
  }

  switch (currentState) {
    case STATE_NOT_STARTED:
      if (eventType === EVENT_HANTAR) return { decision: 'ACCEPT', nextState: STATE_HANTAR_ACTIVE, isException: false, reasonCode: null };
      if (eventType === EVENT_SELESAI) return { decision: 'ACCEPT', nextState: STATE_EXCEPTION_SELESAI_WITHOUT_HANTAR, isException: true, reasonCode: null };
      if (eventType === EVENT_AMBIL) return { decision: 'ACCEPT_EXCEPTION', nextState: STATE_COMPLETE_BY_AMBIL, isException: true, reasonCode: null };
      break;

    case STATE_HANTAR_ACTIVE:
      if (eventType === EVENT_HANTAR) return { decision: 'ACCEPT_CORRECTION', nextState: STATE_HANTAR_ACTIVE, isException: false, reasonCode: REASON_SUPERSEDED_HANTAR };
      if (eventType === EVENT_SELESAI) return { decision: 'ACCEPT', nextState: STATE_SELESAI_ACTIVE, isException: false, reasonCode: null };
      if (eventType === EVENT_AMBIL) return { decision: 'ACCEPT_EXCEPTION', nextState: STATE_COMPLETE_BY_AMBIL, isException: true, reasonCode: null };
      break;

    case STATE_SELESAI_ACTIVE:
      if (eventType === EVENT_HANTAR) return { decision: 'REJECT', nextState: null, isException: false, reasonCode: REASON_HANTAR_AFTER_SELESAI };
      if (eventType === EVENT_SELESAI) return { decision: 'ACCEPT_CORRECTION', nextState: STATE_SELESAI_ACTIVE, isException: false, reasonCode: REASON_SUPERSEDED_SELESAI };
      if (eventType === EVENT_AMBIL) return { decision: 'ACCEPT', nextState: STATE_COMPLETE_BY_AMBIL, isException: false, reasonCode: null };
      break;

    case STATE_EXCEPTION_SELESAI_WITHOUT_HANTAR:
      if (eventType === EVENT_HANTAR) return { decision: 'REJECT', nextState: null, isException: false, reasonCode: REASON_HANTAR_AFTER_EXCEPTION };
      // Duplicate Selesai while still in the exception state: the frozen
      // correction/supersession model (rules 8/9) applies to "the same
      // event type while active" without carving out this state, so a
      // repeat Selesai here supersedes and the cycle remains in exception.
      if (eventType === EVENT_SELESAI) return { decision: 'ACCEPT_CORRECTION', nextState: STATE_EXCEPTION_SELESAI_WITHOUT_HANTAR, isException: true, reasonCode: REASON_SUPERSEDED_SELESAI };
      if (eventType === EVENT_AMBIL) return { decision: 'ACCEPT_EXCEPTION', nextState: STATE_COMPLETE_BY_AMBIL, isException: true, reasonCode: null };
      break;
  }

  // Should be unreachable given the switch above covers all 4 non-terminal
  // states and all 3 recognized event types -- fail safe rather than silent.
  return { decision: 'REJECT', nextState: null, isException: false, reasonCode: REASON_UNRECOGNIZED_EVENT_TYPE };
}

// =====================================================================
// PHASE 9B -- Cycle_Summary ACCESS
// =====================================================================

/**
 * Finds the Cycle_Summary row for cycleId. Returns {rowIndex, values} where
 * rowIndex is the 1-indexed sheet row, or null if no row exists yet.
 * O(n) scan of a sheet expected to hold only ~15 rows/day (Phase 8 §13 --
 * a dedicated index sheet was evaluated and found unnecessary at this scale).
 */
function findCycleSummaryRow_(sheet, cycleId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var data = sheet.getRange(2, 1, lastRow - 1, CS_HEADERS.length).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][CS_COL.CYCLE_ID - 1] === cycleId) return { rowIndex: i + 2, values: data[i] };
  }
  return null;
}

function cycleRowToObject_(values) {
  if (!values) return null;
  return {
    cycleId: values[CS_COL.CYCLE_ID - 1],
    wardCode: values[CS_COL.WARD_CODE - 1],
    ward: values[CS_COL.WARD - 1],
    operationalDay: values[CS_COL.OPERATIONAL_DAY - 1],
    currentState: values[CS_COL.CURRENT_STATE - 1],
    hantarTs: values[CS_COL.HANTAR_TS - 1] || null,
    selesaiTs: values[CS_COL.SELESAI_TS - 1] || null,
    ambilTs: values[CS_COL.AMBIL_TS - 1] || null,
    isException: values[CS_COL.IS_EXCEPTION - 1] === true,
    tatMs: values[CS_COL.TAT_MS - 1] === '' ? null : values[CS_COL.TAT_MS - 1],
    slaStatus: values[CS_COL.SLA_STATUS - 1] || null,
    waitMs: values[CS_COL.WAIT_MS - 1] === '' ? null : values[CS_COL.WAIT_MS - 1],
    closureType: values[CS_COL.CLOSURE_TYPE - 1] || null,
    closureMessage: values[CS_COL.CLOSURE_MESSAGE - 1] || null,
    scheduledBoundary: values[CS_COL.SCHEDULED_BOUNDARY - 1] || null,
    closedAt: values[CS_COL.CLOSED_AT - 1] || null
  };
}

function cycleObjectToRow_(o) {
  var row = new Array(CS_HEADERS.length);
  row[CS_COL.CYCLE_ID - 1] = o.cycleId;
  row[CS_COL.WARD_CODE - 1] = o.wardCode;
  row[CS_COL.WARD - 1] = o.ward;
  row[CS_COL.OPERATIONAL_DAY - 1] = o.operationalDay;
  row[CS_COL.CURRENT_STATE - 1] = o.currentState;
  row[CS_COL.HANTAR_TS - 1] = o.hantarTs || '';
  row[CS_COL.SELESAI_TS - 1] = o.selesaiTs || '';
  row[CS_COL.AMBIL_TS - 1] = o.ambilTs || '';
  row[CS_COL.IS_EXCEPTION - 1] = !!o.isException;
  row[CS_COL.TAT_MS - 1] = (o.tatMs === null || o.tatMs === undefined) ? '' : o.tatMs;
  row[CS_COL.SLA_STATUS - 1] = o.slaStatus || '';
  row[CS_COL.WAIT_MS - 1] = (o.waitMs === null || o.waitMs === undefined) ? '' : o.waitMs;
  row[CS_COL.CLOSURE_TYPE - 1] = o.closureType || '';
  row[CS_COL.CLOSURE_MESSAGE - 1] = o.closureMessage || '';
  row[CS_COL.SCHEDULED_BOUNDARY - 1] = o.scheduledBoundary || '';
  row[CS_COL.CLOSED_AT - 1] = o.closedAt || '';
  return row;
}

function writeCycleSummaryRow_(sheet, existingRowIndex, cycleObj) {
  var row = cycleObjectToRow_(cycleObj);
  if (existingRowIndex) {
    sheet.getRange(existingRowIndex, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
}

function newCycleObject_(cycleId, wardCode, ward, operationalDay) {
  return {
    cycleId: cycleId, wardCode: wardCode, ward: ward, operationalDay: operationalDay,
    currentState: STATE_NOT_STARTED, hantarTs: null, selesaiTs: null, ambilTs: null,
    isException: false, tatMs: null, slaStatus: null, waitMs: null,
    closureType: null, closureMessage: null, scheduledBoundary: null, closedAt: null
  };
}

// =====================================================================
// PHASE 9B -- SLA / WAITING TIME (frozen: SLA = Hantar->Selesai, 4h;
// waiting = Selesai->genuine Ambil only; both frozen at terminal state)
// =====================================================================

function computeSla_(hantarTs, selesaiTs) {
  if (!hantarTs || !selesaiTs) return { tatMs: null, slaStatus: 'TIDAK_DAPAT_DIKIRA' };
  var tatMs = new Date(selesaiTs).getTime() - new Date(hantarTs).getTime();
  return { tatMs: tatMs, slaStatus: tatMs <= SLA_LIMIT_MS ? 'PATUH' : 'LEWAT' };
}

// waitMs is computed ONLY for genuine Ambil completions; Admin/Auto closure
// callers must set waitMs = null directly and must never call this helper
// with a closure timestamp masquerading as an Ambil timestamp.
function computeWaitMs_(selesaiTs, genuineAmbilTs) {
  if (!selesaiTs || !genuineAmbilTs) return null;
  return new Date(genuineAmbilTs).getTime() - new Date(selesaiTs).getTime();
}

// =====================================================================
// PHASE 9C -- IDEMPOTENCY
// Bounded-window scan (not full-history) -- a trigger retry of the same
// FormResponseId happens within seconds/minutes, never hundreds of events
// later, so this bounds cost regardless of total sheet size while still
// reliably catching every real retry.
// =====================================================================
var IDEMPOTENCY_SCAN_WINDOW_ROWS = 500;

function isDuplicateFormResponse_(ss, formResponseId) {
  if (!formResponseId) return false; // defensive: no id available, cannot dedupe -- caller proceeds

  var logSheet = ss.getSheetByName(SHEET_LOG_NAME);
  var lastRow = logSheet.getLastRow();
  if (lastRow >= 2) {
    var n = Math.min(IDEMPOTENCY_SCAN_WINDOW_ROWS, lastRow - 1);
    var startRow = lastRow - n + 1;
    var ids = logSheet.getRange(startRow, 8, n, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0] === formResponseId) return true;
    }
  }

  var raSheet = ss.getSheetByName(SHEET_REJECTION_AUDIT);
  var raLastRow = raSheet.getLastRow();
  if (raLastRow >= 2) {
    var rn = Math.min(IDEMPOTENCY_SCAN_WINDOW_ROWS, raLastRow - 1);
    var raStart = raLastRow - rn + 1;
    var raIds = raSheet.getRange(raStart, RA_COL.FORM_RESPONSE_ID, rn, 1).getValues();
    for (var j = 0; j < raIds.length; j++) {
      if (raIds[j][0] === formResponseId) return true;
    }
  }

  return false;
}

// =====================================================================
// PHASE 9C -- ACCEPT / REJECT WRITERS
// =====================================================================

var _auditIdCounter = 0;
function generateAuditId_() {
  _auditIdCounter++;
  return 'AUD_' + new Date().getTime() + '_' + _auditIdCounter;
}

/**
 * Appends ONE accepted event row to Log_Troli. NEVER called for a rejected
 * submission (frozen rules 15/16). statusText is acceptance provenance
 * ("OK" or "OK (CORRECTION - ...)"), replacing the old anomaly-flag usage
 * of this column.
 */
function writeAcceptedEvent_(ss, wardRaw, eventType, timestamp, nama, jawatan, email, formResponseId, statusText) {
  var logSheet = ss.getSheetByName(SHEET_LOG_NAME);
  logSheet.appendRow([timestamp, email || '', wardRaw, eventType, nama || '', jawatan || '', statusText, formResponseId || '']);
}

/**
 * Writes ONE Rejection_Audit row. recordType is RECORD_TYPE_REJECTED for a
 * rejected submission, RECORD_TYPE_AUDIT for a correction/closure/
 * reconciliation record. rejectedPayload is only meaningful for a rejected
 * submission (the submitted values, since no Log_Troli row exists for it).
 */
function writeRejectionAudit_(ss, fields) {
  var sheet = ss.getSheetByName(SHEET_REJECTION_AUDIT);
  var row = new Array(RA_HEADERS.length);
  row[RA_COL.AUDIT_ID - 1] = generateAuditId_();
  row[RA_COL.RECORD_TYPE - 1] = fields.recordType;
  row[RA_COL.TIMESTAMP - 1] = new Date();
  row[RA_COL.CYCLE_ID - 1] = fields.cycleId || '';
  row[RA_COL.WARD - 1] = fields.ward || '';
  row[RA_COL.OPERATIONAL_DAY - 1] = fields.operationalDay || '';
  row[RA_COL.EVENT_TYPE - 1] = fields.eventType || '';
  row[RA_COL.FORM_RESPONSE_ID - 1] = fields.formResponseId || '';
  row[RA_COL.REJECTED_PAYLOAD - 1] = fields.rejectedPayload || '';
  row[RA_COL.PREVIOUS_VALUE - 1] = fields.previousValue || '';
  row[RA_COL.NEW_VALUE - 1] = fields.newValue || '';
  row[RA_COL.PREVIOUS_STATE - 1] = fields.previousState || '';
  row[RA_COL.RESULTING_STATE - 1] = fields.resultingState || '';
  row[RA_COL.REASON_CODE - 1] = fields.reasonCode || '';
  row[RA_COL.REASON_TEXT - 1] = fields.reasonText || '';
  row[RA_COL.ACTOR_TYPE - 1] = fields.actorType || 'SYSTEM';
  row[RA_COL.ACTOR_IDENTITY - 1] = fields.actorIdentity || '';
  row[RA_COL.EVENT_ROW_REF - 1] = fields.eventRowRef || '';
  row[RA_COL.IDEMPOTENCY_KEY - 1] = fields.idempotencyKey || fields.formResponseId || '';
  row[RA_COL.METADATA - 1] = fields.metadata || '';
  sheet.appendRow(row);
}

// =====================================================================
// PHASE 9C -- PIPELINE ORCHESTRATOR
// Called by onFormSubmit (Code.gs) while holding the script lock. Pure
// orchestration around evaluateTransition_ -- this function does not itself
// decide business outcomes, it only sequences reads/writes around the one
// canonical decision function.
// =====================================================================

/**
 * @returns {{status:string}} status is 'ACCEPTED', 'ACCEPTED_CORRECTION',
 *   'ACCEPTED_EXCEPTION', or 'REJECTED' -- for logging/diagnostics only,
 *   never consumed by any live business decision downstream.
 */
function processFormSubmission_(ss, input) {
  // input: {wardRaw, eventType, timestamp, nama, jawatan, email, formResponseId}
  var wardResolution = resolveWard_(ss, input.wardRaw);
  if (!wardResolution.ok) {
    writeRejectionAudit_(ss, {
      recordType: RECORD_TYPE_REJECTED,
      ward: input.wardRaw,
      eventType: input.eventType,
      formResponseId: input.formResponseId,
      rejectedPayload: JSON.stringify(input),
      reasonCode: wardResolution.reasonCode,
      reasonText: wardResolution.reasonCode === REASON_WARD_INACTIVE
        ? 'Wad "' + input.wardRaw + '" wujud dalam Ward_Master tetapi tidak aktif (cth. Wad Test) -- tidak dibenarkan masuk statistik operasi.'
        : 'Wad "' + input.wardRaw + '" tidak dikenali dalam Ward_Master.',
      actorType: 'SYSTEM'
    });
    return { status: 'REJECTED' };
  }

  var operationalDay = resolveOperationalDay_(input.timestamp);
  var cycleId = deriveCycleId_(wardResolution.wardCode, operationalDay);

  var cycleSheet = ss.getSheetByName(SHEET_CYCLE_SUMMARY);
  var existing = findCycleSummaryRow_(cycleSheet, cycleId);
  var cycleObj = existing ? cycleRowToObject_(existing.values) : newCycleObject_(cycleId, wardResolution.wardCode, input.wardRaw, operationalDay);
  var previousState = cycleObj.currentState;

  var transition = evaluateTransition_(cycleObj.currentState, input.eventType);

  if (transition.decision === 'REJECT') {
    writeRejectionAudit_(ss, {
      recordType: RECORD_TYPE_REJECTED,
      cycleId: cycleId, ward: input.wardRaw, operationalDay: operationalDay,
      eventType: input.eventType, formResponseId: input.formResponseId,
      rejectedPayload: JSON.stringify(input),
      previousState: previousState, resultingState: previousState,
      reasonCode: transition.reasonCode,
      reasonText: rejectionReasonText_(transition.reasonCode, input.eventType),
      actorType: 'SYSTEM'
    });
    return { status: 'REJECTED' };
  }

  // ACCEPT / ACCEPT_CORRECTION / ACCEPT_EXCEPTION -- write the event first.
  var statusText = transition.decision === 'ACCEPT_CORRECTION'
    ? 'OK (CORRECTION - supersedes previous ' + input.eventType + ')'
    : (transition.decision === 'ACCEPT_EXCEPTION' ? 'OK (EXCEPTION)' : 'OK');
  writeAcceptedEvent_(ss, input.wardRaw, input.eventType, input.timestamp, input.nama, input.jawatan, input.email, input.formResponseId, statusText);

  // Apply the transition to the cycle object.
  cycleObj.currentState = transition.nextState;
  if (input.eventType === EVENT_HANTAR) cycleObj.hantarTs = input.timestamp.toISOString();
  if (input.eventType === EVENT_SELESAI) cycleObj.selesaiTs = input.timestamp.toISOString();
  if (input.eventType === EVENT_AMBIL) cycleObj.ambilTs = input.timestamp.toISOString();
  if (transition.isException) cycleObj.isException = true;

  // SLA recompute (frozen: recalculates while active on Hantar/Selesai change).
  var sla = computeSla_(cycleObj.hantarTs, cycleObj.selesaiTs);
  cycleObj.tatMs = sla.tatMs;
  cycleObj.slaStatus = sla.slaStatus;

  // Closure bookkeeping -- ONLY for genuine Ambil completion here (Admin/Auto
  // closure are separate code paths, Phase 9D). waitMs is null unless this
  // is a genuine, non-exception Ambil completion from SELESAI_ACTIVE.
  if (transition.nextState === STATE_COMPLETE_BY_AMBIL) {
    cycleObj.closureType = 'AMBIL';
    cycleObj.closedAt = input.timestamp.toISOString();
    cycleObj.waitMs = (!cycleObj.isException && cycleObj.selesaiTs)
      ? computeWaitMs_(cycleObj.selesaiTs, cycleObj.ambilTs)
      : null;
    if (cycleObj.isException) cycleObj.closureMessage = MSG_AMBIL_BEFORE_SELESAI;
  }

  writeCycleSummaryRow_(cycleSheet, existing ? existing.rowIndex : null, cycleObj);

  if (transition.decision === 'ACCEPT_CORRECTION') {
    writeRejectionAudit_(ss, {
      recordType: RECORD_TYPE_AUDIT,
      cycleId: cycleId, ward: input.wardRaw, operationalDay: operationalDay,
      eventType: input.eventType, formResponseId: input.formResponseId,
      previousValue: input.eventType === EVENT_HANTAR ? String(previousState) : '',
      newValue: input.timestamp.toISOString(),
      previousState: previousState, resultingState: transition.nextState,
      reasonCode: transition.reasonCode, reasonText: 'Rekod ' + input.eventType + ' terkini menggantikan rekod sebelumnya (cycle masih aktif).',
      actorType: 'SYSTEM'
    });
  }

  return { status: transition.decision };
}

function rejectionReasonText_(reasonCode, eventType) {
  switch (reasonCode) {
    case REASON_HANTAR_AFTER_SELESAI: return 'Hantar Troli diterima selepas Selesai pada hari operasi yang sama -- submission tidak sah.';
    case REASON_HANTAR_AFTER_EXCEPTION: return 'Hantar Troli diterima selepas cycle sudah dalam status pengecualian (Selesai tanpa Hantar) -- tiada backfill dibenarkan.';
    case REASON_POST_TERMINAL_EVENT: return eventType + ' diterima selepas cycle sudah tamat (frozen) -- ditolak.';
    default: return 'Submission ditolak (' + reasonCode + ').';
  }
}

// =====================================================================
// PHASE 9D -- AUTO CLOSURE (time-driven, 00:00, self-healing catch-up)
// Frozen: occurs at the operational-day boundary, never depends on a user
// event; must inspect ALL open cycles from PAST operational days (not only
// "yesterday") so a missed trigger firing self-heals on the next successful
// run with no separate catch-up job. Already-terminal cycles (Admin or a
// prior Auto run) are structurally excluded by the query itself.
// =====================================================================

function autoClosureMessageForState_(state) {
  if (state === STATE_HANTAR_ACTIVE) return MSG_AUTO_CLOSURE_HANTAR_ONLY;
  if (state === STATE_SELESAI_ACTIVE) return MSG_AUTO_CLOSURE_SELESAI_ONLY;
  if (state === STATE_EXCEPTION_SELESAI_WITHOUT_HANTAR) return MSG_AUTO_CLOSURE_EXCEPTION;
  return null; // NOT_STARTED / terminal states are never eligible -- see caller
}

/**
 * Registered via createAutoClosureTrigger_() as a daily 00:00 time-driven
 * trigger. Also safe to invoke manually/administratively at any time -- it
 * is idempotent (only rows that are non-terminal and from a past
 * operational day are ever touched; a terminal row simply never matches).
 */
function runAutoClosure_() {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  var ss = SpreadsheetApp.openById(id);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('runAutoClosure_: gagal dapat lock -- akan cuba lagi pada firing seterusnya (self-healing, tiada cycle akan tertinggal ditutup selama-lamanya).');
    return { closed: 0, skipped: 'lock_timeout' };
  }

  try {
    var todayOperationalDay = resolveOperationalDay_(new Date());
    var sheet = ss.getSheetByName(SHEET_CYCLE_SUMMARY);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { closed: 0 };

    var data = sheet.getRange(2, 1, lastRow - 1, CS_HEADERS.length).getValues();
    var closedCount = 0;
    var now = new Date();

    for (var i = 0; i < data.length; i++) {
      var cycleObj = cycleRowToObject_(data[i]);
      if (isTerminalState_(cycleObj.currentState)) continue; // already terminal -- NO-OP, never reopened
      if (cycleObj.operationalDay >= todayOperationalDay) continue; // still today or future -- not yet eligible

      var message = autoClosureMessageForState_(cycleObj.currentState);
      if (!message) continue; // NOT_STARTED has no accepted events -- nothing to close (Phase 8 §12 case D)

      var previousState = cycleObj.currentState;
      cycleObj.currentState = STATE_COMPLETE_BY_AUTO;
      cycleObj.closureType = 'AUTO';
      cycleObj.closureMessage = message;
      cycleObj.waitMs = null; // frozen: Auto Closure never produces genuine waiting time
      // ScheduledBoundary is the midnight that should have closed this cycle:
      // the day after its own operational day.
      var boundary = new Date(cycleObj.operationalDay + 'T00:00:00');
      boundary.setDate(boundary.getDate() + 1);
      cycleObj.scheduledBoundary = boundary.toISOString();
      cycleObj.closedAt = now.toISOString();
      // HantarTs/SelesaiTs/AmbilTs/TatMs are NEVER touched here (frozen: Auto
      // Closure must not alter historical Hantar/Selesai timestamps or SLA).

      writeCycleSummaryRow_(sheet, i + 2, cycleObj);

      writeRejectionAudit_(ss, {
        recordType: RECORD_TYPE_AUDIT,
        cycleId: cycleObj.cycleId, ward: cycleObj.ward, operationalDay: cycleObj.operationalDay,
        previousState: previousState, resultingState: STATE_COMPLETE_BY_AUTO,
        reasonCode: REASON_AUTO_CLOSURE, reasonText: message,
        actorType: 'SYSTEM'
      });
      closedCount++;
    }

    Logger.log('runAutoClosure_: ' + closedCount + ' cycle ditutup secara automatik.');
    return { closed: closedCount };
  } finally {
    lock.releaseLock();
  }
}

/**
 * ONE-TIME setup: run manually from the Apps Script editor. Registers the
 * daily 00:00 trigger. Guards against duplicate registration if re-run.
 */
function createAutoClosureTrigger_() {
  var existing = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'runAutoClosure_';
  });
  existing.forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('runAutoClosure_').timeBased().everyDays(1).atHour(0).create();
  Logger.log('Trigger dicipta: runAutoClosure_() akan run setiap hari lebih kurang jam 00:00.');
}

// =====================================================================
// PHASE 9E -- RECONCILIATION
// Time-driven (default every 15 minutes -- an engineering configuration,
// not a business rule), bounded to today's + yesterday's operational days
// only (a cycle cannot be older than one day before Auto Closure would
// terminate it, and this bound is exactly what keeps reconciliation from
// ever touching ambiguous/old history automatically). Replays accepted
// Log_Troli events through the SAME evaluateTransition_ the live pipeline
// uses -- never a second, independent interpretation.
// =====================================================================

var RECONCILIATION_WINDOW_DAYS = 2; // today + yesterday

/**
 * Deterministically replays a chronologically-sorted list of accepted
 * {eventType, timestamp} events for ONE cycle through evaluateTransition_,
 * starting from NOT_STARTED. Returns the resulting cycle object shape
 * (same fields as cycleRowToObject_) -- this is what Cycle_Summary SHOULD
 * contain if every write had succeeded.
 */
function replayCycleFromEvents_(cycleId, wardCode, ward, operationalDay, events) {
  var obj = newCycleObject_(cycleId, wardCode, ward, operationalDay);
  events.forEach(function (ev) {
    var t = evaluateTransition_(obj.currentState, ev.eventType);
    if (t.decision === 'REJECT') return; // replay only ever applies ACCEPT* decisions to accepted history
    obj.currentState = t.nextState;
    if (ev.eventType === EVENT_HANTAR) obj.hantarTs = ev.timestamp;
    if (ev.eventType === EVENT_SELESAI) obj.selesaiTs = ev.timestamp;
    if (ev.eventType === EVENT_AMBIL) obj.ambilTs = ev.timestamp;
    if (t.isException) obj.isException = true;
  });
  var sla = computeSla_(obj.hantarTs, obj.selesaiTs);
  obj.tatMs = sla.tatMs;
  obj.slaStatus = sla.slaStatus;
  if (obj.currentState === STATE_COMPLETE_BY_AMBIL) {
    obj.closureType = 'AMBIL';
    obj.waitMs = (!obj.isException && obj.selesaiTs) ? computeWaitMs_(obj.selesaiTs, obj.ambilTs) : null;
    if (obj.isException) obj.closureMessage = MSG_AMBIL_BEFORE_SELESAI;
  }
  return obj;
}

function reconcileCycles_() {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  var ss = SpreadsheetApp.openById(id);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('reconcileCycles_: gagal dapat lock -- akan cuba lagi pada firing seterusnya.');
    return { repaired: 0, anomalies: 0, skipped: 'lock_timeout' };
  }

  try {
    var windowDays = {};
    for (var d = 0; d < RECONCILIATION_WINDOW_DAYS; d++) {
      var day = new Date();
      day.setDate(day.getDate() - d);
      windowDays[resolveOperationalDay_(day)] = true;
    }

    var logSheet = ss.getSheetByName(SHEET_LOG_NAME);
    var lastRow = logSheet.getLastRow();
    var repaired = 0, anomalies = 0;
    var seenFormResponseIds = {};
    var duplicateFormResponseIds = {};

    if (lastRow >= 2) {
      var allRows = logSheet.getRange(2, 1, lastRow - 1, 8).getValues();
      var byCycle = {}; // cycleId -> {wardCode, ward, operationalDay, events:[{eventType,timestamp}]}

      allRows.forEach(function (row) {
        var ts = new Date(row[COL.TIMESTAMP]);
        var opDay = resolveOperationalDay_(ts);
        if (!windowDays[opDay]) return; // outside bounded window -- never touched automatically

        var frId = row[7];
        if (frId) {
          if (seenFormResponseIds[frId]) duplicateFormResponseIds[frId] = true;
          seenFormResponseIds[frId] = true;
        }

        var wardRaw = row[COL.WAD];
        var wardResolution = resolveWard_(ss, wardRaw);
        if (!wardResolution.ok) return; // shouldn't happen for an accepted row -- if it does, reconciliation cannot resolve a cycle identity for it, so it cannot be replayed (not a case reconciliation is authorized to fix)

        var cycleId = deriveCycleId_(wardResolution.wardCode, opDay);
        if (!byCycle[cycleId]) byCycle[cycleId] = { wardCode: wardResolution.wardCode, ward: wardRaw, operationalDay: opDay, events: [] };
        byCycle[cycleId].events.push({ eventType: row[COL.EVENT], timestamp: ts.toISOString(), tsObj: ts });
      });

      var cycleSheet = ss.getSheetByName(SHEET_CYCLE_SUMMARY);

      Object.keys(byCycle).forEach(function (cycleId) {
        var group = byCycle[cycleId];
        group.events.sort(function (a, b) { return a.tsObj - b.tsObj; });
        var expected = replayCycleFromEvents_(cycleId, group.wardCode, group.ward, group.operationalDay, group.events);

        var found = findCycleSummaryRow_(cycleSheet, cycleId);

        if (!found) {
          // Case (a): accepted events exist but Cycle_Summary is entirely
          // missing -- deterministic repair, write the full replayed row.
          writeCycleSummaryRow_(cycleSheet, null, expected);
          writeRejectionAudit_(ss, {
            recordType: RECORD_TYPE_AUDIT, cycleId: cycleId, ward: group.ward, operationalDay: group.operationalDay,
            resultingState: expected.currentState, reasonCode: REASON_RECONCILIATION_REPAIR,
            reasonText: 'Cycle_Summary tiada row langsung untuk cycle ini walaupun rekod diterima wujud dalam Log_Troli -- dibina semula dari replay deterministik.',
            actorType: 'SYSTEM'
          });
          repaired++;
          return;
        }

        var actual = cycleRowToObject_(found.values);

        if (isTerminalState_(actual.currentState) && actual.closureType !== 'AMBIL') {
          // ADMIN/AUTO closure: pure event-replay can never validate this
          // (closure is a separate operation, outside the transition
          // matrix), so instead check case (d): is the closure audited?
          var hasAuditEvidence = rejectionAuditHasClosureEvidence_(ss, cycleId, actual.closureType);
          if (!hasAuditEvidence) {
            writeRejectionAudit_(ss, {
              recordType: RECORD_TYPE_AUDIT, cycleId: cycleId, ward: group.ward, operationalDay: group.operationalDay,
              previousState: actual.currentState, resultingState: actual.currentState,
              reasonCode: REASON_RECONCILIATION_REPAIR,
              reasonText: 'Cycle ditutup (' + actual.closureType + ') tetapi rekod audit tiada -- audit dibina semula tanpa mengubah status cycle.',
              actorType: 'SYSTEM'
            });
            repaired++;
          }
          return; // never touches CurrentState/ClosureType/ClosureMessage of a terminal row
        }

        if (isTerminalState_(actual.currentState) && actual.closureType === 'AMBIL') {
          if (expected.currentState !== STATE_COMPLETE_BY_AMBIL) {
            // Case (b): Cycle_Summary claims a genuine-Ambil completion that
            // accepted Log_Troli history does NOT support. This could mean a
            // real operational fact happened outside the recorded trail --
            // reconciliation has no authority to invent or retract that.
            // Flag only, never touch the row.
            writeRejectionAudit_(ss, {
              recordType: RECORD_TYPE_AUDIT, cycleId: cycleId, ward: group.ward, operationalDay: group.operationalDay,
              previousState: actual.currentState, resultingState: actual.currentState,
              reasonCode: REASON_RECONCILIATION_ANOMALY,
              reasonText: 'Cycle_Summary menunjukkan COMPLETE_BY_AMBIL tetapi tiada rekod Ambil diterima yang menyokongnya dalam tetingkap semakan -- memerlukan semakan manual, TIDAK diubah secara automatik.',
              actorType: 'SYSTEM'
            });
            anomalies++;
          } else if (actual.tatMs === null && expected.tatMs !== null) {
            // Narrow, safe repair: derived metric fields left null by a
            // crash between the state-write and the metric-write, uniquely
            // determined by this row's OWN already-accepted timestamps.
            actual.tatMs = expected.tatMs; actual.slaStatus = expected.slaStatus;
            if (actual.waitMs === null && expected.waitMs !== null) actual.waitMs = expected.waitMs;
            writeCycleSummaryRow_(cycleSheet, found.rowIndex, actual);
            writeRejectionAudit_(ss, {
              recordType: RECORD_TYPE_AUDIT, cycleId: cycleId, ward: group.ward, operationalDay: group.operationalDay,
              previousState: actual.currentState, resultingState: actual.currentState,
              reasonCode: REASON_RECONCILIATION_REPAIR,
              reasonText: 'Medan terbitan (TatMs/WaitMs) kosong pada row yang sudah tamat -- diisi semula dari cap masa yang sudah diterima pada row yang sama.',
              actorType: 'SYSTEM'
            });
            repaired++;
          }
          return;
        }

        // Non-terminal Cycle_Summary row: safe to fully repair from replay
        // if it disagrees with what accepted history supports (Case a
        // variant -- e.g. Log_Troli has a Selesai the crashed write never
        // reached). Never applies here if it would REGRESS the state
        // (replay producing something "earlier" than what's stored would
        // itself be a case-(b)-style anomaly, not a repair).
        var stateRank = { NOT_STARTED: 0, HANTAR_ACTIVE: 1, SELESAI_ACTIVE: 2, EXCEPTION_SELESAI_WITHOUT_HANTAR: 2 };
        var actualRank = stateRank.hasOwnProperty(actual.currentState) ? stateRank[actual.currentState] : -1;
        var expectedRank = stateRank.hasOwnProperty(expected.currentState) ? stateRank[expected.currentState] : -1;

        if (isTerminalState_(expected.currentState) || expectedRank > actualRank) {
          writeCycleSummaryRow_(cycleSheet, found.rowIndex, expected);
          writeRejectionAudit_(ss, {
            recordType: RECORD_TYPE_AUDIT, cycleId: cycleId, ward: group.ward, operationalDay: group.operationalDay,
            previousState: actual.currentState, resultingState: expected.currentState,
            reasonCode: REASON_RECONCILIATION_REPAIR,
            reasonText: 'Cycle_Summary (' + actual.currentState + ') tertinggal berbanding rekod diterima dalam Log_Troli -- dikemaskini semula melalui replay deterministik.',
            actorType: 'SYSTEM'
          });
          repaired++;
        } else if (expectedRank < actualRank) {
          // Stored state is further along than accepted history alone
          // explains -- flag, never regress it automatically.
          writeRejectionAudit_(ss, {
            recordType: RECORD_TYPE_AUDIT, cycleId: cycleId, ward: group.ward, operationalDay: group.operationalDay,
            previousState: actual.currentState, resultingState: actual.currentState,
            reasonCode: REASON_RECONCILIATION_ANOMALY,
            reasonText: 'Cycle_Summary (' + actual.currentState + ') lebih maju daripada yang disokong replay rekod diterima -- memerlukan semakan manual.',
            actorType: 'SYSTEM'
          });
          anomalies++;
        }
      });
    }

    Object.keys(duplicateFormResponseIds).forEach(function (frId) {
      writeRejectionAudit_(ss, {
        recordType: RECORD_TYPE_AUDIT, formResponseId: frId,
        reasonCode: REASON_RECONCILIATION_ANOMALY,
        reasonText: 'FormResponseId ' + frId + ' dijumpai berulang dalam Log_Troli yang diterima -- sepatutnya dihalang oleh semakan idempotensi. Isyarat pepijat, bukan dipadam/digabung secara automatik.',
        actorType: 'SYSTEM'
      });
      anomalies++;
    });

    Logger.log('reconcileCycles_: ' + repaired + ' dibaiki, ' + anomalies + ' anomali dibendera.');
    return { repaired: repaired, anomalies: anomalies };
  } finally {
    lock.releaseLock();
  }
}

function rejectionAuditHasClosureEvidence_(ss, cycleId, closureType) {
  var sheet = ss.getSheetByName(SHEET_REJECTION_AUDIT);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var expectedReason = closureType === 'ADMIN' ? REASON_ADMIN_CLOSURE : REASON_AUTO_CLOSURE;
  var data = sheet.getRange(2, RA_COL.CYCLE_ID, lastRow - 1, RA_COL.REASON_CODE - RA_COL.CYCLE_ID + 1).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === cycleId && data[i][RA_COL.REASON_CODE - RA_COL.CYCLE_ID] === expectedReason) return true;
  }
  return false;
}

/**
 * ONE-TIME setup: registers the 15-minute reconciliation trigger.
 */
function createReconciliationTrigger_() {
  var existing = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'reconcileCycles_';
  });
  existing.forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('reconcileCycles_').timeBased().everyMinutes(15).create();
  Logger.log('Trigger dicipta: reconcileCycles_() akan run setiap 15 minit.');
}

// =====================================================================
// PHASE 9I -- HISTORICAL RECONSTRUCTION (retrospective, isolated)
//
// Answers ONLY "what would historical records look like under the
// canonical model?" -- it is NEVER read by getWadStatus, Admin Closure,
// Auto Closure, or reconciliation, and it never writes to the live
// Cycle_Summary sheet. Historical Log_Troli rows are NEVER modified by
// this function (frozen: "do not rewrite historical facts").
//
// Run manually/on-demand from the Apps Script editor -- not a trigger.
// Safe to re-run: it clears and rebuilds ONLY the data rows of
// Cycle_Summary_Reconstructed_Legacy (rows 1-2, the warning banner and
// header, are preserved).
//
// A historical row that the canonical matrix would have REJECTED (e.g. an
// old "ANOMALI:"-flagged Hantar-after-Selesai submission) is simply not
// applied to the replayed cycle -- replayCycleFromEvents_ already skips
// REJECT decisions -- which is the correct reading of "what would this
// look like if evaluated under today's rules," not a rewriting of what
// actually happened (that fact remains, untouched, in Log_Troli itself).
// =====================================================================

function buildReconstructedLegacyView_() {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  var ss = SpreadsheetApp.openById(id);
  var logSheet = ss.getSheetByName(SHEET_LOG_NAME);
  var lastRow = logSheet.getLastRow();
  if (lastRow < 2) { Logger.log('Log_Troli kosong -- tiada apa untuk dibina semula.'); return { count: 0 }; }

  var allRows = logSheet.getRange(2, 1, lastRow - 1, 8).getValues();
  var byCycle = {};

  allRows.forEach(function (row) {
    var ts = new Date(row[COL.TIMESTAMP]);
    var opDay = resolveOperationalDay_(ts);
    var wardResolution = resolveWard_(ss, row[COL.WAD]);
    if (!wardResolution.ok) return; // unresolvable ward text -- skipped, never fabricated a cycle identity for it

    var cycleId = deriveCycleId_(wardResolution.wardCode, opDay);
    if (!byCycle[cycleId]) byCycle[cycleId] = { wardCode: wardResolution.wardCode, ward: row[COL.WAD], operationalDay: opDay, events: [] };
    byCycle[cycleId].events.push({ eventType: row[COL.EVENT], timestamp: ts.toISOString(), tsObj: ts });
  });

  var legacySheet = ss.getSheetByName(SHEET_CYCLE_SUMMARY_LEGACY);
  var existingLastRow = legacySheet.getLastRow();
  if (existingLastRow > 2) legacySheet.getRange(3, 1, existingLastRow - 2, CS_HEADERS.length).clearContent();

  var rowsOut = [];
  Object.keys(byCycle).forEach(function (cycleId) {
    var group = byCycle[cycleId];
    group.events.sort(function (a, b) { return a.tsObj - b.tsObj; });
    var replayed = replayCycleFromEvents_(cycleId, group.wardCode, group.ward, group.operationalDay, group.events);
    rowsOut.push(cycleObjectToRow_(replayed));
  });

  if (rowsOut.length > 0) legacySheet.getRange(3, 1, rowsOut.length, CS_HEADERS.length).setValues(rowsOut);
  Logger.log('buildReconstructedLegacyView_: ' + rowsOut.length + ' cycle dibina semula secara retrospektif ke "' + SHEET_CYCLE_SUMMARY_LEGACY + '". Sheet ini TIDAK digunakan oleh mana-mana logik langsung.');
  return { count: rowsOut.length };
}
