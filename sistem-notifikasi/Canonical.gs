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
// historical date -- this is a Script Property that MUST be set manually,
// once, at the moment of actual production cutover (see Phase 9 report,
// "Manual deployment/setup steps still required"). Reading it before it is
// set returns null, and callers must treat that as "cutover has not
// happened yet" (i.e. currently in the shadow/pre-implementation period),
// never guess a date.
var CUTOVER_PROPERTY_KEY = 'CANONICAL_CUTOVER_TIMESTAMP';

function getCutoverTimestamp_() {
  var v = PropertiesService.getScriptProperties().getProperty(CUTOVER_PROPERTY_KEY);
  return v ? new Date(v) : null;
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
    '(2) tetapkan Script Property "' + CUTOVER_PROPERTY_KEY + '" (ISO date) apabila cutover berlaku sebenar.');
  return created;
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
