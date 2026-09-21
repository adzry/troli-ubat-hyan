/**
 * SISTEM TROLI UBAT - HOSPITAL YAN
 * Backend Apps Script — v2 (LEGION Design Framework compliant)
 *
 * Flow:
 * 1. Wad submit "Hantar Troli" (pagi) -> mula SLA
 * 2. Farmasi submit "Selesai Isi" -> tamat SLA, trigger alarm webapp
 * 3. Wad submit "Ambil Balik" -> tutup cycle, kira responsiveness
 *
 * Semua 3 event guna SATU Google Form dengan branch logic
 * (soalan "Jenis Tindakan" -> Hantar Troli / Selesai Isi Farmasi / Ambil Balik Troli)
 *
 * v2 changelog:
 * - onFormSubmit: batched sheet read (fix N+1 -- was 1 getRange() call per row per lookup)
 * - SLA gap fix: cycle tanpa rekod "Hantar Troli" kini direkod sebagai partial row
 *   dalam SLA_Summary (flagged, TAT = tidak dapat dikira) instead of silently dropped
 * - Naming convention: semua private helper functions kini bawah trailing underscore
 * - Removed checkNewRows() -- dead code, frontend hanya guna getWadStatus()
 * - Added: getFloorStockData() -- rujukan stok lantai semua unit (add-on staff wad)
 * - Added: runHealthCheck() -- self-diagnosing infra check
 */

// ====== CONFIG ======
var WAD_LIST = ['Wad Lelaki 4A', 'Wad Lelaki 4B', 'Wad Perempuan', 'Wad Bersalin', 'Wad Kanak-Kanak', 'Unit Hemodialisis', 'Wad Test'];
var SLA_LIMIT_MS = 4 * 60 * 60 * 1000; // 4 jam dalam milisaat
var SHEET_LOG_NAME = 'Log_Troli';
var SHEET_SLA_NAME = 'SLA_Summary';

// --- Floor Stock reference (external, read-only source -- lihat getFloorStockData) ---
// ID spreadsheet FLOOR_STOCK_HYAN_2026_UPDATED, disahkan oleh owner (Adzry).
// Nota: kalau Apps Script projek Troli Ubat ni dijalankan bawah akaun yang SAMA
// dengan owner sheet ni, SpreadsheetApp.openById() jalan terus tanpa isu akses.
// Kalau nanti projek ni "Transfer Ownership" ke akaun lain / deploy bawah service
// account berlainan, akaun baru tu perlu diberi akses Viewer/Editor pada sheet ni dulu.
var FLOOR_STOCK_SHEET_ID = '1nlr3XeAtLvlGyz9KyAj5dRWxcVqGyqkT0rUdVDX6BlI';
var FLOOR_STOCK_HEADER_ANCHOR = 'SKU'; // teks unik untuk cari header row -- lihat findHeaderRow_
var FLOOR_STOCK_MAX_SCAN_ROWS = 25;    // berapa row dari atas nak scan untuk cari header

// --- Rujukan Pantas: Hospital Yan Drug Formulary (AppSheet, external, no data pulled) ---
var DRUG_FORMULARY_URL = 'https://www.appsheet.com/start/34fc5b7f-83da-4a72-a76e-68fcf9f05f68?platform=desktop#appName=FORMHYAN-393954385-25-12-07';

// Column index (0-based) dalam Log_Troli, kena padan dengan susunan soalan Form
var COL = {
  TIMESTAMP: 0,
  EMAIL: 1,
  WAD: 2,
  EVENT: 3,        // 'Hantar Troli' / 'Selesai Isi Farmasi' / 'Ambil Balik Troli'
  NAMA: 4,
  JAWATAN: 5,
  STATUS_VALIDASI: 6  // ditambah oleh script, bukan dari Form
};

var EVENT_HANTAR = 'Hantar Troli';
var EVENT_SELESAI = 'Pengisian ubat selesai';
var EVENT_AMBIL = 'Troli ubat/pesanan ubat telah diambil';


// ====== 1. SETUP - RUN SEKALI JE ======
function setupSystem() {
  var ss = SpreadsheetApp.create('Sistem Troli Ubat - Backend HYAN');
  var sheetId = ss.getId();
  PropertiesService.getScriptProperties().setProperty('DB_ID', sheetId);

  var logSheet = ss.getSheets()[0];
  logSheet.setName(SHEET_LOG_NAME);
  logSheet.appendRow(['Timestamp', 'Email', 'Wad', 'Jenis Tindakan', 'Nama', 'Jawatan', 'Status Validasi']);
  logSheet.getRange(1, 1, 1, 7).setFontWeight('bold');

  var slaSheet = ss.insertSheet(SHEET_SLA_NAME);
  slaSheet.appendRow(['Wad', 'Tarikh', 'Masa Hantar', 'Masa Selesai', 'Durasi (jam)', 'Status SLA', 'Masa Ambil', 'Durasi Tunggu Ambil (jam)']);
  slaSheet.getRange(1, 1, 1, 8).setFontWeight('bold');

  var form = FormApp.create('Borang Tindakan Troli Ubat - HYAN');
  form.setCollectEmail(true);

  var wadItem = form.addListItem();
  wadItem.setTitle('Sila Pilih Wad').setChoiceValues(WAD_LIST).setRequired(true);

  var eventItem = form.addMultipleChoiceItem();
  eventItem.setTitle('Jenis Tindakan')
    .setChoiceValues([EVENT_HANTAR, EVENT_SELESAI, EVENT_AMBIL])
    .setRequired(true);

  form.addTextItem().setTitle('Nama').setRequired(true);

  var jawatanItem = form.addListItem();
  jawatanItem.setTitle('Jawatan')
    .setChoiceValues(['Jururawat (SN)', 'Pegawai Farmasi (PF)', 'Pembantu Farmasi (PPF)', 'Lain-lain'])
    .setRequired(true);

  form.setDestination(FormApp.DestinationType.SPREADSHEET, sheetId);

  ScriptApp.newTrigger('onFormSubmit')
    .forForm(form)
    .onFormSubmit()
    .create();

  Logger.log('=== SISTEM BERJAYA DICIPTA ===');
  Logger.log('Form URL (untuk semua staff): ' + form.getPublishedUrl());
  Logger.log('Sheet URL (database): ' + ss.getUrl());
  Logger.log('PENTING: Pergi ke Deploy > New Deployment > Web app untuk dapatkan URL alarm webapp.');
}


// ====== 2. FORM SUBMIT TRIGGER - CANONICAL PIPELINE (Phase 9C) ======
// Rewritten around the canonical cycle model (see Canonical.gs). This is an
// installable Form-bound trigger (registered via .forForm(form).onFormSubmit()
// in setupSystem()), so e.response (a FormResponse) is available -- this is
// what makes FormResponseId-based idempotency possible without any trigger
// reconfiguration.
//
// CRITICAL: getLastRow() is no longer used as submission identity anywhere
// in this function. Idempotency and pipeline sequencing are driven entirely
// by e.response.getId() and the LockService-guarded critical section below.
function onFormSubmit(e) {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  var ss = SpreadsheetApp.openById(id);

  // Safe to read before the lock: FormResponse fields are immutable per
  // submission, not shared mutable state.
  var response = e && e.response;
  var formResponseId = response ? response.getId() : null;
  var itemResponses = response ? response.getItemResponses() : null;

  var wardRaw, eventType, nama, jawatan;
  var timestamp = response ? response.getTimestamp() : new Date();
  var email = response ? response.getRespondentEmail() : '';

  if (itemResponses && itemResponses.length >= 4) {
    // Form item order: Wad, Jenis Tindakan, Nama, Jawatan (per setupSystem()).
    wardRaw = itemResponses[0].getResponse();
    eventType = itemResponses[1].getResponse();
    nama = itemResponses[2].getResponse();
    jawatan = itemResponses[3].getResponse();
  } else {
    // Defensive fallback (e.g. manual test run without a real FormResponse):
    // fall back to reading the just-appended row, matching the shape the
    // rest of the pipeline expects. This path has no FormResponseId, so
    // idempotency simply cannot dedupe it -- acceptable for a manual test
    // invocation, never expected on a real Form submission.
    var logSheetFallback = ss.getSheetByName(SHEET_LOG_NAME);
    var lastRowFallback = logSheetFallback.getLastRow();
    var rowFallback = logSheetFallback.getRange(lastRowFallback, 1, 1, 6).getValues()[0];
    wardRaw = rowFallback[COL.WAD];
    eventType = rowFallback[COL.EVENT];
    nama = rowFallback[COL.NAMA];
    jawatan = rowFallback[COL.JAWATAN];
    timestamp = new Date(rowFallback[COL.TIMESTAMP]);
    email = rowFallback[COL.EMAIL];
  }

  var lock = LockService.getScriptLock();
  var gotLock = lock.tryLock(30000);
  if (!gotLock) {
    // Frozen rule: a lock failure is NOT a business rejection -- it must
    // never be written as a rejected business event. Nothing is written;
    // Apps Script's own trigger retry is relied on to attempt this
    // FormResponseId again later (idempotency then makes the retry safe).
    Logger.log('onFormSubmit: gagal dapat lock dalam masa yang ditetapkan -- FormResponseId=' + formResponseId + ' tidak diproses, menunggu retry.');
    return;
  }

  try {
    if (formResponseId && isDuplicateFormResponse_(ss, formResponseId)) {
      Logger.log('onFormSubmit: FormResponseId=' + formResponseId + ' sudah diproses -- retry diabaikan (idempotent).');
      return;
    }

    processFormSubmission_(ss, {
      wardRaw: wardRaw, eventType: eventType, timestamp: timestamp,
      nama: nama, jawatan: jawatan, email: email, formResponseId: formResponseId
    });
  } finally {
    lock.releaseLock();
  }
}


// ====== 7. WEBAPP SERVING ======
function doGet(e) {
  var wad = e.parameter.wad;

  if (!wad) {
    return HtmlService.createHtmlOutput('<p>Sila tambah parameter ?wad=Nama_Wad pada URL.</p>');
  }

  var template = HtmlService.createTemplateFromFile('Index');
  template.wadName = wad;
  template.drugFormularyUrl = DRUG_FORMULARY_URL;
  return template.evaluate()
    .setTitle('Sistem Notifikasi Troli Ubat - ' + wad)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}


// ====== 8. LIVE API - CANONICAL Cycle_Summary CONTRACT (Phase 9F) ======
// Rewritten around Cycle_Summary as the single source of truth. The
// frontend consumes this contract directly and performs NO independent
// pairing/state-derivation of its own (see Index.html, Phase 9G).
//
// Legacy fields removed from the contract entirely (confirmed via grep in
// Phase 8 that none were ever consumed by the frontend): lastRow,
// pendingAlarm, tatFormatted, tatLabel. pendingAnomali is replaced by
// isException.
function getWadStatus(wad) {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  if (!id) return { error: 'Sistem belum di-setup.' };
  var ss = SpreadsheetApp.openById(id);

  var wardResolution = resolveWard_(ss, wad);
  var todayOperationalDay = resolveOperationalDay_(new Date());

  var emptyResponse = {
    cycleId: null, ward: wad, operationalDay: todayOperationalDay,
    currentState: STATE_NOT_STARTED, hantarTs: null, selesaiTs: null, ambilTs: null,
    closureType: null, closureMessage: null, isException: false,
    tatMs: null, slaStatus: null, waitMs: null, timeline: []
  };

  if (!wardResolution.ok) {
    // An unresolvable/inactive ward parameter has no cycle identity to
    // report against -- return the NOT_STARTED shape rather than an error,
    // since this is a read-only status view, not a submission path.
    return emptyResponse;
  }

  var cycleId = deriveCycleId_(wardResolution.wardCode, todayOperationalDay);
  var cycleSheet = ss.getSheetByName(SHEET_CYCLE_SUMMARY);
  var found = findCycleSummaryRow_(cycleSheet, cycleId);
  var cycle = found ? cycleRowToObject_(found.values) : newCycleObject_(cycleId, wardResolution.wardCode, wad, todayOperationalDay);

  return {
    cycleId: cycle.cycleId,
    ward: cycle.ward,
    operationalDay: cycle.operationalDay,
    currentState: cycle.currentState,
    hantarTs: cycle.hantarTs,
    selesaiTs: cycle.selesaiTs,
    ambilTs: cycle.ambilTs,
    closureType: cycle.closureType,
    closureMessage: cycle.closureMessage,
    isException: !!cycle.isException,
    tatMs: cycle.tatMs,
    slaStatus: cycle.slaStatus,
    waitMs: cycle.waitMs,
    timeline: buildTimelineForCycle_(ss, wardResolution.wardCode, todayOperationalDay)
  };
}

// Server-scoped timeline: every accepted Log_Troli row for TODAY whose ward
// text resolves to this same WardCode (handles alias variants), never
// filtered/paired client-side. isCorrection/isException are read from the
// acceptance-provenance text written by processFormSubmission_, not
// re-derived by string-matching for "ANOMALI" (that vocabulary no longer
// exists in Log_Troli going forward -- rejections never reach this sheet).
//
// De-duplicated per EventType (CycleId is already fixed by the wardCode +
// operationalDay this function is scoped to): Log_Troli is also the Form's
// own native response destination (setupSystem() -> form.setDestination
// (SPREADSHEET,...)), so Google Forms auto-appends one row per real
// submission (columns A-F only) BEFORE the installable onFormSubmit
// trigger runs; onFormSubmit's own writeAcceptedEvent_() then appends a
// SECOND, complete row (all 8 columns, including FormResponseId) for the
// same physical event. Both rows are genuinely present in Log_Troli --
// this collapses them back to one canonical timeline entry per event type,
// preferring the row that carries a FormResponseId (the canonical
// accept-pipeline write) over the Forms-native blank-provenance row; ties
// break on the later timestamp, so a real correction still surfaces its
// most recent value. Never keyed on timestamp/label alone.
function buildTimelineForCycle_(ss, wardCode, operationalDay) {
  var sheet = ss.getSheetByName(SHEET_LOG_NAME);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var wardMap = loadWardMasterMap_(ss); // loaded once, reused per row below
  var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  var byEventType = {};
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var ts = new Date(row[COL.TIMESTAMP]);
    if (resolveOperationalDay_(ts) !== operationalDay) continue;
    var entry = wardMap[normWardText_(row[COL.WAD])];
    if (!entry || entry.wardCode !== wardCode) continue;

    var statusText = String(row[COL.STATUS_VALIDASI] || '');
    var candidate = {
      event: row[COL.EVENT],
      nama: row[COL.NAMA],
      jawatan: row[COL.JAWATAN],
      time: Utilities.formatDate(ts, TZ, 'HH:mm'),
      isCorrection: statusText.indexOf('CORRECTION') > -1,
      isException: statusText.indexOf('EXCEPTION') > -1,
      _tsMillis: ts.getTime(),
      _hasFormResponseId: !!row[7]
    };

    var existing = byEventType[candidate.event];
    var candidateWins = !existing ||
      (candidate._hasFormResponseId && !existing._hasFormResponseId) ||
      (candidate._hasFormResponseId === existing._hasFormResponseId && candidate._tsMillis > existing._tsMillis);
    if (candidateWins) byEventType[candidate.event] = candidate;
  }

  var timeline = Object.keys(byEventType).map(function (k) { return byEventType[k]; });
  timeline.sort(function (a, b) { return a._tsMillis - b._tsMillis; });
  timeline.forEach(function (ev) { delete ev._tsMillis; delete ev._hasFormResponseId; });
  return timeline;
}


// ====== 9. FLOOR STOCK REFERENCE (ADD-ON) ======
// Rujukan stok lantai SEMUA unit -- read-only mirror, satu batched getValues() per tab.
// Dipanggil client-side lepas paint (async shell pattern), bukan masa doGet().
function getFloorStockData() {
  var out = { items: [], units: [], skipped: [], generatedAt: new Date().toISOString() };

  var ss;
  try {
    ss = SpreadsheetApp.openById(FLOOR_STOCK_SHEET_ID);
  } catch (err) {
    return { error: 'Tidak dapat akses spreadsheet Floor Stock (' + err.message + '). Sila pastikan akaun ni ada akses Viewer.' };
  }

  var sheets = ss.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var sheet = sheets[s];
    var name = sheet.getName();
    try {
      var parsed = parseFloorStockSheet_(sheet);
      if (!parsed) {
        out.skipped.push(name); // tab ni bukan format floor stock (tiada header "SKU" dijumpai)
        continue;
      }
      out.units.push(name);
      for (var j = 0; j < parsed.length; j++) out.items.push(parsed[j]);
    } catch (errTab) {
      out.skipped.push(name + ' (ralat: ' + errTab.message + ')');
    }
  }

  return out;
}

// Parse satu tab floor stock guna resilient header-text detection (bukan hardcoded
// column index) -- format setiap tab boleh beza sikit susunan lajur.
function parseFloorStockSheet_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 2) return null;

  var scanRows = Math.min(FLOOR_STOCK_MAX_SCAN_ROWS, lastRow);
  var scanRange = sheet.getRange(1, 1, scanRows, lastCol).getValues();

  var headerRowIdx = findHeaderRow_(scanRange, FLOOR_STOCK_HEADER_ANCHOR);
  if (headerRowIdx === -1) return null; // bukan format floor stock -- skip tab ni

  var headerRow = scanRange[headerRowIdx];
  var groupRow = headerRowIdx > 0 ? scanRange[headerRowIdx - 1] : [];

  var colMap = {
    ubat: findColumnByHeaderText_(headerRow, groupRow, ['UBATAN', 'NAMA GENERIK']),
    sku: findColumnByHeaderText_(headerRow, groupRow, ['SKU']),
    min: findColumnByHeaderText_(headerRow, groupRow, ['MIN']),
    max: findColumnByHeaderText_(headerRow, groupRow, ['MAX']),
    cara: findColumnByHeaderText_(headerRow, groupRow, ['CARA PEMESANAN']),
    ham: findColumnByHeaderText_(headerRow, groupRow, ['HIGH ALERT', 'HAM']),
    br: findColumnByHeaderText_(headerRow, groupRow, ['BUKU ROKOD', 'BR']),
    fi: findColumnByHeaderText_(headerRow, groupRow, ['FRIDGE', 'FI']),
    eb: findColumnByHeaderText_(headerRow, groupRow, ['EXCHANGE', 'EB']),
    total: findColumnByHeaderText_(headerRow, groupRow, ['TOTAL'])
  };

  if (colMap.ubat === -1) return null; // tanpa lajur nama ubat, tak boleh parse row data

  var dataStartRow = headerRowIdx + 2; // 1-indexed sheet row lepas header
  var numDataRows = lastRow - dataStartRow + 1;
  if (numDataRows <= 0) return [];

  var data = sheet.getRange(dataStartRow, 1, numDataRows, lastCol).getValues();
  var unitName = sheet.getName();
  var results = [];

  for (var r = 0; r < data.length; r++) {
    var row = data[r];
    var ubatName = colMap.ubat > -1 ? normText_(row[colMap.ubat]) : '';
    if (!ubatName) continue; // baris kosong / label kategori (cth "INTERNAL PREPARATION")

    results.push({
      unit: unitName,
      ubat: row[colMap.ubat] ? String(row[colMap.ubat]).trim() : '',
      sku: colMap.sku > -1 ? String(row[colMap.sku] || '').trim() : '',
      min: colMap.min > -1 ? row[colMap.min] : '',
      max: colMap.max > -1 ? row[colMap.max] : '',
      cara: colMap.cara > -1 ? String(row[colMap.cara] || '').trim() : '',
      ham: colMap.ham > -1 && row[colMap.ham] ? 'HAM' : '',
      br: colMap.br > -1 && row[colMap.br] ? 'BR' : '',
      fi: colMap.fi > -1 && row[colMap.fi] ? 'FI' : '',
      eb: colMap.eb > -1 && row[colMap.eb] ? 'EB' : '',
      total: colMap.total > -1 ? row[colMap.total] : ''
    });
  }

  return results;
}

// Cari row (0-indexed dalam scanRange) yang ada cell padan anchorText tepat (case/whitespace-insensitive)
function findHeaderRow_(scanRange, anchorText) {
  var target = normText_(anchorText);
  for (var r = 0; r < scanRange.length; r++) {
    for (var c = 0; c < scanRange[r].length; c++) {
      if (normText_(scanRange[r][c]) === target) return r;
    }
  }
  return -1;
}

// Cari index lajur dalam headerRow (fallback groupRow) yang MENGANDUNGI mana-mana
// keyword dalam senarai keywords (case/whitespace-insensitive, contains-match)
function findColumnByHeaderText_(headerRow, groupRow, keywords) {
  for (var c = 0; c < headerRow.length; c++) {
    var text = normText_(headerRow[c]) || normText_(groupRow[c]);
    for (var k = 0; k < keywords.length; k++) {
      if (text.indexOf(normText_(keywords[k])) > -1) return c;
    }
  }
  return -1;
}

// NBSP collapse + trim + uppercase, untuk text comparison (standard util per framework)
function normText_(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/ /g, ' ').trim().toUpperCase();
}


// ====== 10. HEALTH CHECK - SELF-DIAGNOSING INFRA ======
function runHealthCheck() {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  if (!id) return { ok: false, issues: ['Sistem belum di-setup (DB_ID kosong).'] };

  var issues = [];
  var ss = SpreadsheetApp.openById(id);
  var sheet = ss.getSheetByName(SHEET_LOG_NAME);
  var lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    var allData = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
    var anomaliCount = 0;
    var stuckCandidates = [];
    var now = new Date().getTime();

    // Anomali count
    for (var i = 0; i < allData.length; i++) {
      var status = allData[i][COL.STATUS_VALIDASI];
      if (status && String(status).indexOf('ANOMALI') === 0) anomaliCount++;
    }
    if (anomaliCount > 0) {
      issues.push(anomaliCount + ' rekod ANOMALI dijumpai dalam Log_Troli -- semak lajur Status Validasi.');
    }

    // Stuck cycle detection: wad yang event terkini > 6 jam lepas dan bukan EVENT_AMBIL/TIADA
    for (var w = 0; w < WAD_LIST.length; w++) {
      var wad = WAD_LIST[w];
      var lastEv = null, lastTs = null;
      for (var j = allData.length - 1; j >= 0; j--) {
        if (allData[j][COL.WAD] === wad) { lastEv = allData[j][COL.EVENT]; lastTs = new Date(allData[j][COL.TIMESTAMP]); break; }
      }
      if (lastEv && lastEv !== EVENT_AMBIL && lastTs) {
        var ageHrs = (now - lastTs.getTime()) / 3600000;
        if (ageHrs > 6) stuckCandidates.push(wad + ' (cycle "' + lastEv + '" sejak ' + ageHrs.toFixed(1) + ' jam lepas)');
      }
    }
    if (stuckCandidates.length > 0) {
      issues.push('Cycle berkemungkinan stuck: ' + stuckCandidates.join('; '));
    }
  }

  // Floor stock reachability check
  var fsCheck = getFloorStockData();
  if (fsCheck.error) {
    issues.push('Floor Stock: ' + fsCheck.error);
  } else if (fsCheck.skipped && fsCheck.skipped.length > 0) {
    issues.push('Floor Stock: ' + fsCheck.skipped.length + ' tab dilangkau (format tak dikenali): ' + fsCheck.skipped.join(', '));
  }

  Logger.log(JSON.stringify(issues));
  return { ok: issues.length === 0, issues: issues };
}


// ====== 11. HEALTH CHECK - AUTOMATED DAILY NOTIFICATION ======
// Dipanggil oleh time-driven trigger (createHealthCheckTrigger), BUKAN manual.
// Wrap runHealthCheck() dan hantar SATU email ringkasan (semua wad + anomali +
// floor stock digabung dalam satu senarai -- bukan email berasingan per wad)
// hanya jika ada isu dijumpai. Elak alert fatigue drpd email harian "semua OK".
function runHealthCheckAndNotify() {
  var result = runHealthCheck();
  if (result.ok) return; // takde isu, senyap -- tak hantar email

  sendHealthCheckEmail_(result.issues);
}

function sendHealthCheckEmail_(issues) {
  var tarikhMasa = Utilities.formatDate(new Date(), 'Asia/Kuala_Lumpur', 'dd/MM/yyyy HH:mm');
  var tarikh = Utilities.formatDate(new Date(), 'Asia/Kuala_Lumpur', 'dd/MM/yyyy');
  var subjek = '[Troli Ubat HYAN] ' + issues.length + ' isu dikesan - ' + tarikh;

  var badan = 'Health check automatik Sistem Troli Ubat HYAN (' + tarikhMasa + ')\n\n';
  badan += issues.length + ' isu dikesan:\n\n';
  issues.forEach(function (isu, i) {
    badan += (i + 1) + '. ' + isu + '\n';
  });
  badan += '\n---\nEmail ni dihantar automatik setiap hari lebih kurang jam 7 pagi, hanya bila ada isu dijumpai.';

  MailApp.sendEmail('adzrysapie@gmail.com', subjek, badan);
}


// ====== 12. SETUP - TIME-DRIVEN TRIGGER (RUN SEKALI JE) ======
// Cipta trigger harian ~7 pagi untuk runHealthCheckAndNotify(). Run function ni
// SEKALI dari Apps Script Editor (pilih function ni dari dropdown, tekan Run) --
// lepas tu Google handle jadual automatik, tak perlu sentuh lagi.
function createHealthCheckTrigger() {
  // Elak duplicate trigger kalau function ni accidentally di-run lebih sekali
  var existing = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'runHealthCheckAndNotify';
  });
  existing.forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('runHealthCheckAndNotify')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();

  Logger.log('Trigger dicipta: runHealthCheckAndNotify() akan run setiap hari lebih kurang jam 7 pagi.');
}


// ====== 13. [RETIRED] closeAllStuckCycles() ======
// Replaced by runAutoClosure_() in Canonical.gs (Phase 9D): a 00:00
// operational-day-boundary trigger with self-healing catch-up, distinct
// ClosureType='AUTO' bookkeeping on Cycle_Summary, and no synthetic
// EVENT_AMBIL row written to Log_Troli -- all of which this function's
// age-based (>6h) model and its "write a fake Ambil labelled PENUTUPAN
// ADMIN" approach could not satisfy under the frozen Phase 6-9 rules.
// Confirmed via repository-wide grep before removal: this function was
// never registered as a trigger anywhere (manual-invocation only) and had
// no other call sites.
