/**
 * DASHBOARD ANALITIK - SISTEM TROLI UBAT HOSPITAL YAN
 * Backend Apps Script (PROJECT BERASINGAN dari sistem notifikasi)
 *
 * Webapp ni baca DATA YANG SAMA (Sheet "Sistem Troli Ubat - Backend HYAN")
 * tapi cuma untuk paparan analytics/reporting -- tidak menulis apa-apa ke Sheet.
 *
 * SETUP PENTING: Selepas paste code ni dalam project standalone baharu,
 * RUN function `connectToExistingSheet()` SEKALI untuk link ke database
 * sedia ada (guna Sheet ID yang sama dengan sistem notifikasi).
 */

// ====== CONFIG (kena padan dengan Code.gs sistem notifikasi) ======
var TROLLEY_WADS = ['Wad Lelaki 4A', 'Wad Lelaki 4B', 'Wad Perempuan', 'Wad Bersalin', 'Wad Kanak-Kanak', 'Unit Hemodialisis', 'Wad Test'];
var OTHER_UNITS = ['Kecemasan & Trauma', 'Klinik Sejahtera', 'Klinik Pakar', 'ESWL', 'Forensik', 'Patologi', 'Fisioterapi', 'Unit Cara Kerja (Occupational Therapy)'];
var WAD_LIST = TROLLEY_WADS.concat(OTHER_UNITS); // semua 13 destinasi, untuk event counting
var SLA_LIMIT_MS = 4 * 60 * 60 * 1000; // 4 jam
var SHEET_LOG_NAME = 'Log_Troli';
var SHEET_SLA_NAME = 'SLA_Summary';

var COL = {
  TIMESTAMP: 0,
  EMAIL: 1,
  WAD: 2,
  EVENT: 3,
  NAMA: 4,
  JAWATAN: 5,
  STATUS_VALIDASI: 6
};

var EVENT_HANTAR = 'Hantar Troli';
var EVENT_SELESAI = 'Pengisian ubat selesai';
var EVENT_AMBIL = 'Troli ubat/pesanan ubat telah diambil';


// ====== SETUP - RUN SEKALI: LINK KE SHEET DATABASE SEDIA ADA ======
// Tampal Sheet ID dari URL sistem notifikasi (bukan create Sheet baharu!)
// Contoh URL: https://docs.google.com/spreadsheets/d/SHEET_ID_DI_SINI/edit
function connectToExistingSheet() {
  var SHEET_ID = '1XkTASMH6_M02iRmi0dZZlg2NddJjVkNTYREPukaMwno';

  PropertiesService.getScriptProperties().setProperty('DB_ID', SHEET_ID);

  // Test sambungan
  var ss = SpreadsheetApp.openById(SHEET_ID);
  Logger.log('Berjaya sambung ke: ' + ss.getName());
  Logger.log('Sheets dijumpai: ' + ss.getSheets().map(function (s) { return s.getName(); }).join(', '));
}


// ====== WEBAPP ENTRYPOINT ======
function doGet(e) {
  var template = HtmlService.createTemplateFromFile('Index');
  return template.evaluate()
    .setTitle('Dashboard Analitik - Troli Ubat HYAN')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


// ====== MAIN AGGREGATION FUNCTION (Phase 9H -- cutover-aware) ======
// startDate, endDate: string format 'yyyy-MM-dd' (dari <input type="date">)
//
// Cycle-derived metrics (totalCycles, patuh/lewat, avgDurasi, avgTunggu,
// dailyTrend, lateList, anomali) are NEVER blended across the canonical
// cutover boundary (Phase 8 correction §6). Raw event totals (totalEvents,
// eventCountByType, wadEventCount, rawLog) are cutover-INSENSITIVE and
// stay continuous, since Log_Troli's shape does not change at cutover.
function getDashboardData(startDate, endDate) {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  if (!id) return { error: 'Belum disambungkan ke database. Sila run connectToExistingSheet() dahulu.' };

  var ss = SpreadsheetApp.openById(id);
  var logSheet = ss.getSheetByName(SHEET_LOG_NAME);

  var tz = 'Asia/Kuala_Lumpur';
  var rangeStart = parseDateStart(startDate, tz);
  var rangeEnd = parseDateEnd(endDate, tz);

  // ---- 1. Baca Log_Troli, filter ikut date range (CONTINUOUS -- tidak
  // sensitif kepada cutover, sebab bentuk Log_Troli tidak berubah). ----
  var logLastRow = logSheet.getLastRow();
  var logRows = logLastRow >= 2 ? logSheet.getRange(2, 1, logLastRow - 1, 8).getValues() : [];

  var totalEvents = 0;
  var eventCountByType = {};
  eventCountByType[EVENT_HANTAR] = 0;
  eventCountByType[EVENT_SELESAI] = 0;
  eventCountByType[EVENT_AMBIL] = 0;

  var wadEventCount = {};
  WAD_LIST.forEach(function (w) { wadEventCount[w] = 0; });

  for (var i = 0; i < logRows.length; i++) {
    var row = logRows[i];
    var ts = new Date(row[COL.TIMESTAMP]);
    if (ts < rangeStart || ts > rangeEnd) continue;

    totalEvents++;
    var ev = row[COL.EVENT];
    if (eventCountByType.hasOwnProperty(ev)) eventCountByType[ev]++;

    var wad = row[COL.WAD];
    if (wadEventCount.hasOwnProperty(wad)) wadEventCount[wad]++;
  }

  // ---- 2. Tentukan mod julat berbanding cutover ----
  var cutover = getCutoverTimestamp2_(ss);
  var split = splitRangeAtCutover_(rangeStart, rangeEnd, cutover);

  var legacy = split.legacy ? computeLegacyCycleMetrics_(ss, tz, split.legacy.start, split.legacy.end) : null;
  var canonical = split.canonical ? getCanonicalCycleMetrics_(ss, tz, split.canonical.start, split.canonical.end) : null;
  var canonicalAnomaliList = split.canonical ? getCanonicalAnomaliList_(ss, tz, split.canonical.start, split.canonical.end) : null;

  // wadComparison (event-count portion is continuous; cycle portion is
  // split exactly like everything else above -- built per-regime below,
  // never combined into a single blended per-ward cycle figure).
  var wadComparisonEventCounts = WAD_LIST.map(function (w) {
    return { wad: w, isTrolleyWard: TROLLEY_WADS.indexOf(w) > -1, eventCount: wadEventCount[w] };
  });

  return {
    rangeMode: split.mode, // 'legacy' | 'canonical' | 'mixed' | 'no_cutover_yet'
    summary: {
      totalEvents: totalEvents,
      eventCountByType: eventCountByType
    },
    wadComparisonEventCounts: wadComparisonEventCounts,
    legacy: legacy, // {totalCycles, patuhCount, lewatCount, avgDurasiPengisian, avgDurasiTunggu, dailyTrend, lateList, wadComparison, anomaliList} or null
    canonical: canonical ? {
      totalCycles: canonical.totalCycles, patuhCount: canonical.patuhCount, lewatCount: canonical.lewatCount,
      avgDurasiPengisian: canonical.avgDurasiPengisian, avgDurasiTunggu: canonical.avgDurasiTunggu,
      dailyTrend: canonical.dailyTrend, lateList: canonical.lateList, wadComparison: canonical.wadComparison,
      anomaliList: canonicalAnomaliList, allCycles: canonical.allCycles
    } : null,
    rawLog: logRows.filter(function (r) {
      var rts = new Date(r[COL.TIMESTAMP]);
      return rts >= rangeStart && rts <= rangeEnd;
    }).map(function (r) {
      return {
        timestamp: Utilities.formatDate(new Date(r[COL.TIMESTAMP]), tz, 'dd/MM/yyyy HH:mm'),
        wad: r[COL.WAD],
        event: r[COL.EVENT],
        nama: r[COL.NAMA],
        jawatan: r[COL.JAWATAN],
        status: r[COL.STATUS_VALIDASI]
      };
    }).reverse()
  };
}

// Legacy (pre-cutover) cycle metrics -- reads SLA_Summary exactly as the
// original implementation did. Kept as the ONLY reader of SLA_Summary
// going forward (frozen as read-only legacy reference, never written to
// again -- see Phase 9 report §"Historical data").
function computeLegacyCycleMetrics_(ss, tz, rangeStart, rangeEnd) {
  var slaSheet = ss.getSheetByName(SHEET_SLA_NAME);
  var slaLastRow = slaSheet.getLastRow();
  var slaRows = slaLastRow >= 2 ? slaSheet.getRange(2, 1, slaLastRow - 1, 8).getValues() : [];

  var totalCycles = 0, patuhCount = 0, lewatCount = 0;
  var totalDurasiPengisian = 0, totalDurasiTunggu = 0, cyclesWithTunggu = 0;
  var wadStats = {};
  WAD_LIST.forEach(function (w) { wadStats[w] = { cycles: 0, patuh: 0, lewat: 0, totalDurasi: 0, totalTunggu: 0, tungguCount: 0 }; });
  var dailyMap = {};
  var lateList = [];
  var anomaliList = [];
  var allCycles = []; // per-cycle rows for Analisis Masa -- replaces client-side re-pairing

  for (var j = 0; j < slaRows.length; j++) {
    var srow = slaRows[j];
    var sWad = srow[0];
    var sMasaHantar = srow[2] ? new Date(srow[2]) : null;
    var sMasaSelesai = srow[3] ? new Date(srow[3]) : null;
    var sDurasi = parseFloat(srow[4]) || 0;
    var sStatusSla = srow[5];
    var sMasaAmbil = srow[6] ? new Date(srow[6]) : null;
    var sDurasiTunggu = srow[7] !== '' ? parseFloat(srow[7]) : null;

    if (!sMasaHantar || sMasaHantar < rangeStart || sMasaHantar >= rangeEnd) continue;

    totalCycles++;
    var isPatuh = sStatusSla && sStatusSla.toString().indexOf('PATUH') === 0;
    if (isPatuh) patuhCount++; else lewatCount++;
    totalDurasiPengisian += sDurasi;
    if (sDurasiTunggu !== null) { totalDurasiTunggu += sDurasiTunggu; cyclesWithTunggu++; }

    if (wadStats.hasOwnProperty(sWad)) {
      wadStats[sWad].cycles++;
      if (isPatuh) wadStats[sWad].patuh++; else wadStats[sWad].lewat++;
      wadStats[sWad].totalDurasi += sDurasi;
      if (sDurasiTunggu !== null) { wadStats[sWad].totalTunggu += sDurasiTunggu; wadStats[sWad].tungguCount++; }
    }

    var dayKey = Utilities.formatDate(sMasaHantar, tz, 'dd/MM');
    if (!dailyMap[dayKey]) dailyMap[dayKey] = { cycles: 0, patuh: 0, lewat: 0, sortKey: sMasaHantar.getTime() };
    dailyMap[dayKey].cycles++;
    if (isPatuh) dailyMap[dayKey].patuh++; else dailyMap[dayKey].lewat++;

    if (!isPatuh) {
      lateList.push({
        wad: sWad, tarikh: Utilities.formatDate(sMasaHantar, tz, 'dd/MM/yyyy'),
        masaHantar: Utilities.formatDate(sMasaHantar, tz, 'HH:mm'),
        masaSelesai: sMasaSelesai ? Utilities.formatDate(sMasaSelesai, tz, 'HH:mm') : '-',
        durasi: sDurasi
      });
    }

    allCycles.push({
      wad: sWad, tarikh: Utilities.formatDate(sMasaHantar, tz, 'dd/MM/yyyy'), sortKey: sMasaHantar.getTime(),
      dayOfWeek: sMasaHantar.getDay(), monthStr: Utilities.formatDate(sMasaHantar, tz, 'MM/yyyy'),
      masaHantar: Utilities.formatDate(sMasaHantar, tz, 'HH:mm'),
      masaSelesai: sMasaSelesai ? Utilities.formatDate(sMasaSelesai, tz, 'HH:mm') : '-',
      masaAmbil: sMasaAmbil ? Utilities.formatDate(sMasaAmbil, tz, 'HH:mm') : null,
      masaPengiMinit: Math.round(sDurasi * 60),
      masaTungguMinit: sDurasiTunggu !== null ? Math.round(sDurasiTunggu * 60) : null,
      patuh: isPatuh
    });
  }

  var dailyTrend = Object.keys(dailyMap).map(function (k) {
    return { label: k, cycles: dailyMap[k].cycles, patuh: dailyMap[k].patuh, lewat: dailyMap[k].lewat, sortKey: dailyMap[k].sortKey };
  }).sort(function (a, b) { return a.sortKey - b.sortKey; });

  // Legacy anomaly list -- the old "ANOMALI:" text-matched rows from
  // Log_Troli, scoped to this sub-range only, kept structurally distinct
  // from the canonical Rejection_Audit-sourced list.
  var logSheet = ss.getSheetByName(SHEET_LOG_NAME);
  var logLastRow = logSheet.getLastRow();
  if (logLastRow >= 2) {
    var logRows = logSheet.getRange(2, 1, logLastRow - 1, 7).getValues();
    logRows.forEach(function (arow) {
      var ats = new Date(arow[COL.TIMESTAMP]);
      if (ats < rangeStart || ats >= rangeEnd) return;
      var astatus = arow[COL.STATUS_VALIDASI];
      if (astatus && astatus.toString().indexOf('ANOMALI') === 0) {
        anomaliList.push({
          tarikh: Utilities.formatDate(ats, tz, 'dd/MM/yyyy'), masa: Utilities.formatDate(ats, tz, 'HH:mm'),
          wad: arow[COL.WAD], event: arow[COL.EVENT], nama: arow[COL.NAMA], sebab: astatus
        });
      }
    });
    anomaliList.sort(function (a, b) { return b.tarikh.localeCompare(a.tarikh) || b.masa.localeCompare(a.masa); });
  }

  return {
    totalCycles: totalCycles, patuhCount: patuhCount, lewatCount: lewatCount,
    avgDurasiPengisian: totalCycles > 0 ? (totalDurasiPengisian / totalCycles).toFixed(2) : -1,
    avgDurasiTunggu: cyclesWithTunggu > 0 ? (totalDurasiTunggu / cyclesWithTunggu).toFixed(2) : -1,
    dailyTrend: dailyTrend,
    lateList: lateList.sort(function (a, b) { return b.durasi - a.durasi; }),
    wadComparison: wadStats,
    anomaliList: anomaliList,
    allCycles: allCycles
  };
}


// ====== HELPERS ======
function parseDateStart(dateStr, tz) {
  if (!dateStr) {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  var parts = dateStr.split('-');
  var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 0, 0, 0);
  return d;
}

function parseDateEnd(dateStr, tz) {
  if (!dateStr) {
    var d = new Date();
    d.setHours(23, 59, 59, 999);
    return d;
  }
  var parts = dateStr.split('-');
  var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 23, 59, 59);
  return d;
}


// ====== CSV EXPORT (untuk tab Rekod) ======
function exportLogCsv(startDate, endDate) {
  var data = getDashboardData(startDate, endDate);
  if (data.error) return data.error;

  var rows = [['Timestamp', 'Wad', 'Jenis Tindakan', 'Nama', 'Jawatan', 'Status Validasi']];
  data.rawLog.forEach(function (r) {
    rows.push([r.timestamp, r.wad, r.event, r.nama, r.jawatan, r.status]);
  });

  return rows.map(function (row) {
    return row.map(function (cell) {
      var s = String(cell || '');
      if (s.indexOf(',') > -1 || s.indexOf('"') > -1) {
        s = '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }).join(',');
  }).join('\n');
}


// ====== [RETIRED] getStuckCycles() / closeStuckCyclesAdmin() ======
// Replaced by getOpenCycles() / closeCycleAdmin() in Canonical.gs (Phase 9D):
// no age threshold (Admin Closure may bypass ANY non-terminal state, not
// just ones stuck >6h), real Session.getActiveUser() + Admin_Users
// authorization (not the old hardcoded 'admin-closure@sistem' actor), reads
// canonical Cycle_Summary instead of re-deriving "stuck" from raw Log_Troli,
// and never writes a synthetic EVENT_AMBIL row.
