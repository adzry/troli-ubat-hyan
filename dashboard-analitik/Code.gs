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


// ====== MAIN AGGREGATION FUNCTION ======
// startDate, endDate: string format 'yyyy-MM-dd' (dari <input type="date">)
function getDashboardData(startDate, endDate) {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  if (!id) return { error: 'Belum disambungkan ke database. Sila run connectToExistingSheet() dahulu.' };

  var ss = SpreadsheetApp.openById(id);
  var logSheet = ss.getSheetByName(SHEET_LOG_NAME);
  var slaSheet = ss.getSheetByName(SHEET_SLA_NAME);

  var tz = 'Asia/Kuala_Lumpur';
  var rangeStart = parseDateStart(startDate, tz);
  var rangeEnd = parseDateEnd(endDate, tz);

  // ---- 1. Baca Log_Troli, filter ikut date range ----
  var logLastRow = logSheet.getLastRow();
  var logRows = logLastRow >= 2 ? logSheet.getRange(2, 1, logLastRow - 1, 7).getValues() : [];

  var totalEvents = 0;
  var anomaliCount = 0;
  var eventCountByType = { };
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

    var status = row[COL.STATUS_VALIDASI];
    if (status && status.toString().indexOf('ANOMALI') === 0) anomaliCount++;
  }

  // ---- 2. Baca SLA_Summary, filter ikut date range (guna Masa Hantar sebagai anchor tarikh) ----
  var slaLastRow = slaSheet.getLastRow();
  var slaRows = slaLastRow >= 2 ? slaSheet.getRange(2, 1, slaLastRow - 1, 8).getValues() : [];

  var totalCycles = 0;
  var patuhCount = 0;
  var lewatCount = 0;
  var totalDurasiPengisian = 0;
  var totalDurasiTunggu = 0;
  var cyclesWithTunggu = 0;

  var wadStats = {};
  WAD_LIST.forEach(function (w) {
    wadStats[w] = { cycles: 0, patuh: 0, lewat: 0, totalDurasi: 0, totalTunggu: 0, tungguCount: 0 };
  });

  var dailyMap = {}; // { 'dd/MM' : { cycles, patuh, lewat } }
  var lateList = []; // senarai cycle yang lewat, untuk jadual

  for (var j = 0; j < slaRows.length; j++) {
    var srow = slaRows[j];
    var sWad = srow[0];
    var sMasaHantar = srow[2] ? new Date(srow[2]) : null;
    var sMasaSelesai = srow[3] ? new Date(srow[3]) : null;
    var sDurasi = parseFloat(srow[4]) || 0;
    var sStatusSla = srow[5];
    var sMasaAmbil = srow[6] ? new Date(srow[6]) : null;
    var sDurasiTunggu = srow[7] !== '' ? parseFloat(srow[7]) : null;

    if (!sMasaHantar || sMasaHantar < rangeStart || sMasaHantar > rangeEnd) continue;

    totalCycles++;
    var isPatuh = sStatusSla && sStatusSla.toString().indexOf('PATUH') === 0;
    if (isPatuh) patuhCount++; else lewatCount++;
    totalDurasiPengisian += sDurasi;

    if (sDurasiTunggu !== null) {
      totalDurasiTunggu += sDurasiTunggu;
      cyclesWithTunggu++;
    }

    if (wadStats.hasOwnProperty(sWad)) {
      wadStats[sWad].cycles++;
      if (isPatuh) wadStats[sWad].patuh++; else wadStats[sWad].lewat++;
      wadStats[sWad].totalDurasi += sDurasi;
      if (sDurasiTunggu !== null) {
        wadStats[sWad].totalTunggu += sDurasiTunggu;
        wadStats[sWad].tungguCount++;
      }
    }

    var dayKey = Utilities.formatDate(sMasaHantar, tz, 'dd/MM');
    if (!dailyMap[dayKey]) dailyMap[dayKey] = { cycles: 0, patuh: 0, lewat: 0, sortKey: sMasaHantar.getTime() };
    dailyMap[dayKey].cycles++;
    if (isPatuh) dailyMap[dayKey].patuh++; else dailyMap[dayKey].lewat++;

    if (!isPatuh) {
      lateList.push({
        wad: sWad,
        tarikh: Utilities.formatDate(sMasaHantar, tz, 'dd/MM/yyyy'),
        masaHantar: Utilities.formatDate(sMasaHantar, tz, 'HH:mm'),
        masaSelesai: sMasaSelesai ? Utilities.formatDate(sMasaSelesai, tz, 'HH:mm') : '-',
        durasi: sDurasi
      });
    }
  }

  // ---- 3. Bentuk array harian tersusun ikut tarikh ----
  var dailyTrend = Object.keys(dailyMap).map(function (k) {
    return { label: k, cycles: dailyMap[k].cycles, patuh: dailyMap[k].patuh, lewat: dailyMap[k].lewat, sortKey: dailyMap[k].sortKey };
  }).sort(function (a, b) { return a.sortKey - b.sortKey; });

  // ---- 4. Bentuk perbandingan ikut wad/unit (SLA applies sama rata untuk semua 13) ----
  var wadComparison = WAD_LIST.map(function (w) {
    var s = wadStats[w];
    var isTrolleyWard = TROLLEY_WADS.indexOf(w) > -1; // kekal untuk label/kategori visual sahaja
    return {
      wad: w,
      isTrolleyWard: isTrolleyWard,
      cycles: s.cycles,
      patuh: s.patuh,
      lewat: s.lewat,
      patuhRate: s.cycles > 0 ? Math.round((s.patuh / s.cycles) * 100) : -1,
      avgDurasi: s.cycles > 0 ? (s.totalDurasi / s.cycles).toFixed(2) : -1,
      avgTunggu: s.tungguCount > 0 ? (s.totalTunggu / s.tungguCount).toFixed(2) : -1,
      eventCount: wadEventCount[w]
    };
  });

  // ---- 5. Senarai anomali (untuk tab SLA & Anomali) ----
  var anomaliList = [];
  for (var k = 0; k < logRows.length; k++) {
    var arow = logRows[k];
    var ats = new Date(arow[COL.TIMESTAMP]);
    if (ats < rangeStart || ats > rangeEnd) continue;
    var astatus = arow[COL.STATUS_VALIDASI];
    if (astatus && astatus.toString().indexOf('ANOMALI') === 0) {
      anomaliList.push({
        tarikh: Utilities.formatDate(ats, tz, 'dd/MM/yyyy'),
        masa: Utilities.formatDate(ats, tz, 'HH:mm'),
        wad: arow[COL.WAD],
        event: arow[COL.EVENT],
        nama: arow[COL.NAMA],
        sebab: astatus
      });
    }
  }
  anomaliList.sort(function (a, b) { return b.tarikh.localeCompare(a.tarikh) || b.masa.localeCompare(a.masa); });

  return {
    summary: {
      totalCycles: totalCycles,
      patuhCount: patuhCount,
      lewatCount: lewatCount,
      patuhRate: totalCycles > 0 ? Math.round((patuhCount / totalCycles) * 100) : -1,
      avgDurasiPengisian: totalCycles > 0 ? (totalDurasiPengisian / totalCycles).toFixed(2) : -1,
      avgDurasiTunggu: cyclesWithTunggu > 0 ? (totalDurasiTunggu / cyclesWithTunggu).toFixed(2) : -1,
      totalEvents: totalEvents,
      anomaliCount: anomaliCount,
      anomaliRate: totalEvents > 0 ? Math.round((anomaliCount / totalEvents) * 100) : -1
    },
    dailyTrend: dailyTrend,
    wadComparison: wadComparison,
    lateList: lateList.sort(function (a, b) { return b.durasi - a.durasi; }),
    anomaliList: anomaliList,
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


// ====== STUCK CYCLE - DETECTION & ADMIN CLOSE ======
// PENTING (kekal sync manual): logic penutupan ni DUPLICATE dari
// closeAllStuckCycles() dalam Code.gs sistem notifikasi -- dua project Apps
// Script ni standalone, takde shared library. Kalau logic penutupan diubah
// (contoh threshold jam, format note), kena update DUA-DUA tempat supaya
// kekal konsisten -- Code.gs notifikasi DAN Code.gs dashboard ni.
//
// Scan wad terus dari Log_Troli (bukan hardcoded WAD_LIST/TROLLEY_WADS/
// OTHER_UNITS array di atas) supaya automatically cover wad baru yang
// ditambah kemudian (cth Unit Hemodialisis) tanpa perlu update list manual
// di dua tempat setiap kali ada wad baru.
var STUCK_THRESHOLD_HRS = 6;

function getStuckCycles() {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  if (!id) return { error: 'Belum disambungkan ke database.' };

  var ss = SpreadsheetApp.openById(id);
  var logSheet = ss.getSheetByName(SHEET_LOG_NAME);
  var lastRow = logSheet.getLastRow();
  if (lastRow < 2) return { stuck: [] };

  var allData = logSheet.getRange(2, 1, lastRow - 1, 7).getValues();
  var now = new Date();
  var lastEventMap = {}; // wad -> {event, ts}

  for (var i = 0; i < allData.length; i++) {
    var row = allData[i];
    var wad = row[COL.WAD];
    if (!wad) continue; // skip baris kosong/phantom -- tiada wad, bukan data sah
    var ts = new Date(row[COL.TIMESTAMP]);
    if (isNaN(ts.getTime())) continue; // skip kalau timestamp tak sah/kosong
    if (!lastEventMap[wad] || ts > lastEventMap[wad].ts) {
      lastEventMap[wad] = { event: row[COL.EVENT], ts: ts };
    }
  }

  var stuck = [];
  Object.keys(lastEventMap).forEach(function (wad) {
    var info = lastEventMap[wad];
    if (info.event === EVENT_AMBIL) return; // cycle memang dah closed
    var ageHrs = (now.getTime() - info.ts.getTime()) / 3600000;
    if (ageHrs <= STUCK_THRESHOLD_HRS) return; // belum stuck lagi
    stuck.push({
      wad: wad,
      lastEvent: info.event,
      lastEventLabel: info.event === EVENT_HANTAR ? 'Hantar Troli' : 'Pengisian ubat selesai',
      ageHrs: Math.round(ageHrs * 10) / 10,
      lastTsIso: info.ts.toISOString()
    });
  });

  stuck.sort(function (a, b) { return b.ageHrs - a.ageHrs; });
  return { stuck: stuck };
}

// wadsToClose: array of {wad, lastEvent, lastTsIso} -- terus dari getStuckCycles()
// punya output yang dipilih user (bukan re-fetch, supaya lastTsIso konsisten
// dengan apa yang user tengok di skrin masa pilih)
function closeStuckCyclesAdmin(wadsToClose) {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  if (!id) return { error: 'Belum disambungkan ke database.' };

  var ss = SpreadsheetApp.openById(id);
  var logSheet = ss.getSheetByName(SHEET_LOG_NAME);
  var slaSheet = ss.getSheetByName(SHEET_SLA_NAME);

  var now = new Date();
  var noteStatus = 'PENUTUPAN ADMIN: troli disahkan sudah diambil secara fizikal, tetapi staf tidak submit Form "Ambil Balik". Masa ambil sebenar tidak direkod.';
  var closedWads = [];

  wadsToClose.forEach(function (c) {
    var lastTs = new Date(c.lastTsIso);

    // 1. Tulis event penutup ke Log_Troli (jadi event terakhir baru utk wad ni)
    logSheet.appendRow([now, 'admin-closure@sistem', c.wad, EVENT_AMBIL, 'PENUTUPAN ADMIN', 'Sistem (Admin)', noteStatus]);

    // 2. Kemaskini SLA_Summary jika ada row terbuka sepadan
    if (c.lastEvent === EVENT_SELESAI) {
      var slaLastRow = slaSheet.getLastRow();
      if (slaLastRow >= 2) {
        var slaData = slaSheet.getRange(2, 1, slaLastRow - 1, 8).getValues();
        for (var i = slaData.length - 1; i >= 0; i--) {
          var row = slaData[i];
          var rowSelesai = row[3] ? new Date(row[3]) : null;
          if (row[0] === c.wad && rowSelesai && rowSelesai.getTime() === lastTs.getTime() && !row[6]) {
            var sheetRow = i + 2;
            // Masa Ambil & Durasi Tunggu (lajur G, H) KEKAL KOSONG -- catat status je
            slaSheet.getRange(sheetRow, 6).setValue(row[5] + ' | ' + noteStatus);
            break;
          }
        }
      }
    } else if (c.lastEvent === EVENT_HANTAR) {
      var tarikh = Utilities.formatDate(lastTs, 'Asia/Kuala_Lumpur', 'dd/MM/yyyy');
      slaSheet.appendRow([c.wad, tarikh, lastTs, '', '', 'TAT TIDAK DAPAT DIKIRA (tiada rekod Selesai Isi) | ' + noteStatus, '', '']);
    }

    closedWads.push(c.wad);
  });

  return { closed: closedWads };
}
