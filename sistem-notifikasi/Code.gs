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


// ====== 2. FORM SUBMIT TRIGGER - VALIDATION + SLA CALC ======
function onFormSubmit(e) {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  var ss = SpreadsheetApp.openById(id);
  var logSheet = ss.getSheetByName(SHEET_LOG_NAME);
  var lastRow = logSheet.getLastRow();

  var currentRow = logSheet.getRange(lastRow, 1, 1, 6).getValues()[0];
  var wad = currentRow[COL.WAD];
  var event = currentRow[COL.EVENT];
  var timestamp = new Date(currentRow[COL.TIMESTAMP]);

  // SATU batched read untuk semua row sebelum ni -- gantikan N+1 getRange() per-row
  // yang asal (getLastEventForWad_ / findMostRecentRow_ dulu masing-masing loop &
  // getValue() sendiri; sekarang loop dalam memori atas array yang sama).
  var priorCount = lastRow - 2; // rows 2 .. lastRow-1 (row 1 = header)
  var priorRows = priorCount > 0 ? logSheet.getRange(2, 1, priorCount, 6).getValues() : [];

  var previousEvent = getLastEventForWad_(priorRows, wad);
  var validasi = validateSequence_(previousEvent, event);
  logSheet.getRange(lastRow, COL.STATUS_VALIDASI + 1).setValue(validasi.status);

  if (!validasi.ok) {
    notifyAnomali_(wad, event, previousEvent, validasi.status);
    // Tak return -- alarm/notifikasi tetap proceed walau anomali (staff kena tahu troli
    // siap walaupun urutan pelik). SLA calc di bawah handle sendiri kes tiada pairing sah.
  }

  if (event === EVENT_SELESAI) {
    var hantarRow = findMostRecentRow_(priorRows, wad, EVENT_HANTAR);
    if (hantarRow) {
      recordSlaResult_(wad, new Date(hantarRow[COL.TIMESTAMP]), timestamp);
    } else {
      // FIX: cycle ni dulu senyap-senyap hilang terus dari SLA_Summary sebab tiada
      // rekod Hantar untuk pairing. Sekarang direkod sebagai partial row supaya cycle
      // tetap kekal dalam statistik (count wujud), cuma TAT ditanda tak dapat dikira.
      recordSlaPartial_(wad, timestamp);
    }
  }

  if (event === EVENT_AMBIL) {
    var selesaiRow = findMostRecentRow_(priorRows, wad, EVENT_SELESAI);
    if (selesaiRow) {
      updateSlaAmbil_(wad, new Date(selesaiRow[COL.TIMESTAMP]), timestamp);
    }
  }
}


// ====== 3. SEQUENCE VALIDATION LOGIC ======
// Urutan yang sah: (tiada/Ambil Balik) -> Hantar Troli -> Selesai Isi Farmasi -> Ambil Balik Troli
function validateSequence_(previousEvent, currentEvent) {
  if (currentEvent === EVENT_HANTAR) {
    if (previousEvent === EVENT_HANTAR || previousEvent === EVENT_SELESAI) {
      return { ok: false, status: 'ANOMALI: Cycle sebelum belum tamat (belum Ambil Balik)' };
    }
    return { ok: true, status: 'OK' };
  }

  if (currentEvent === EVENT_SELESAI) {
    if (previousEvent === EVENT_AMBIL) {
      return { ok: false, status: 'ANOMALI: Pembetulan selepas kesilapan tick - rekod "Selesai Isi Farmasi" ini disubmit selepas "Ambil Balik" yang mungkin tersilap. SLA mungkin tidak tepat untuk cycle ini, sila semak manual.' };
    }
    if (previousEvent !== EVENT_HANTAR) {
      return { ok: false, status: 'ANOMALI: Tiada rekod Hantar Troli untuk wad ini' };
    }
    return { ok: true, status: 'OK' };
  }

  if (currentEvent === EVENT_AMBIL) {
    if (previousEvent === EVENT_HANTAR) {
      return { ok: false, status: 'ANOMALI: Kemungkinan kesilapan tick - troli ditanda diambil tanpa rekod Selesai Isi Farmasi terlebih dahulu. Sila semak jika ini patut menjadi "Selesai Isi Farmasi".' };
    }
    if (previousEvent !== EVENT_SELESAI) {
      return { ok: false, status: 'ANOMALI: Troli belum direkod Selesai Isi oleh Farmasi' };
    }
    return { ok: true, status: 'OK' };
  }

  return { ok: false, status: 'ANOMALI: Jenis tindakan tidak dikenali' };
}


// ====== 4. HELPER - CARI EVENT DALAM ARRAY YANG DAH DIBATCH (bukan sheet call lagi) ======
function getLastEventForWad_(rows, wad) {
  for (var r = rows.length - 1; r >= 0; r--) {
    if (rows[r][COL.WAD] === wad) return rows[r][COL.EVENT];
  }
  return null;
}

function findMostRecentRow_(rows, wad, eventType) {
  for (var r = rows.length - 1; r >= 0; r--) {
    if (rows[r][COL.WAD] === wad && rows[r][COL.EVENT] === eventType) return rows[r];
  }
  return null;
}


// ====== 5. SLA RECORDING ======
function recordSlaResult_(wad, hantarTime, selesaiTime) {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  var ss = SpreadsheetApp.openById(id);
  var slaSheet = ss.getSheetByName(SHEET_SLA_NAME);

  var durasiMs = selesaiTime.getTime() - hantarTime.getTime();
  var durasiJam = (durasiMs / (1000 * 60 * 60)).toFixed(2);
  var statusSla = durasiMs <= SLA_LIMIT_MS ? 'PATUH (<=4 jam)' : 'LEWAT (>4 jam)';
  var tarikh = Utilities.formatDate(hantarTime, 'Asia/Kuala_Lumpur', 'dd/MM/yyyy');

  slaSheet.appendRow([wad, tarikh, hantarTime, selesaiTime, durasiJam, statusSla, '', '']);
}

// FIX (isu #3 review): cycle "Selesai" tanpa "Hantar" berpadanan -- rekod partial row
// supaya cycle tetap kekal dalam SLA_Summary (count sah), tapi TAT jelas ditanda N/A.
function recordSlaPartial_(wad, selesaiTime) {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  var ss = SpreadsheetApp.openById(id);
  var slaSheet = ss.getSheetByName(SHEET_SLA_NAME);
  var tarikh = Utilities.formatDate(selesaiTime, 'Asia/Kuala_Lumpur', 'dd/MM/yyyy');

  slaSheet.appendRow([wad, tarikh, '', selesaiTime, '', 'TAT TIDAK DAPAT DIKIRA (tiada rekod Hantar Troli)', '', '']);
}

function updateSlaAmbil_(wad, selesaiTime, ambilTime) {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  var ss = SpreadsheetApp.openById(id);
  var slaSheet = ss.getSheetByName(SHEET_SLA_NAME);
  var lastRow = slaSheet.getLastRow();
  if (lastRow < 2) return;

  // Batched read (dulu getRange().getValue() per-cell dalam loop)
  var data = slaSheet.getRange(2, 1, lastRow - 1, 8).getValues();
  for (var i = data.length - 1; i >= 0; i--) {
    var row = data[i];
    var rowWad = row[0];
    var rowSelesai = row[3] ? new Date(row[3]) : null;
    var rowAmbil = row[6];

    if (rowWad === wad && rowSelesai && rowSelesai.getTime() === selesaiTime.getTime() && !rowAmbil) {
      var durasiTungguMs = ambilTime.getTime() - selesaiTime.getTime();
      var durasiTungguJam = (durasiTungguMs / (1000 * 60 * 60)).toFixed(2);
      var sheetRow = i + 2;
      slaSheet.getRange(sheetRow, 7, 1, 2).setValues([[ambilTime, durasiTungguJam]]);
      return;
    }
  }
}


// ====== 6. ANOMALI NOTIFICATION (optional email ke admin) ======
function notifyAnomali_(wad, event, previousEvent, statusMsg) {
  Logger.log('ANOMALI DIKESAN: Wad=' + wad + ', Event=' + event + ', Previous=' + previousEvent + ', Status=' + statusMsg);
  // Uncomment dan tukar email kalau nak notification email:
  // MailApp.sendEmail('adzrysapie@gmail.com', 'Anomali Sistem Troli Ubat', statusMsg + ' (Wad: ' + wad + ')');
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


// ====== 8. DASHBOARD STATUS - STATUS SEMASA + TIMELINE HARI INI ======
function getWadStatus(wad) {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  if (!id) return { error: 'Sistem belum di-setup.' };

  var ss = SpreadsheetApp.openById(id);
  var sheet = ss.getSheetByName(SHEET_LOG_NAME);
  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return { lastRow: lastRow, currentState: 'TIADA_CYCLE', timeline: [], pendingAlarm: false };
  }

  var allData = sheet.getRange(2, 1, lastRow - 1, 7).getValues(); // dah batched, satu call je
  var todayStr = Utilities.formatDate(new Date(), 'Asia/Kuala_Lumpur', 'dd/MM/yyyy');

  var timeline = [];
  var lastEventForWad = null;
  var lastEventTimestamp = null;
  var lastEventAnomali = false;
  var lastHantarTimestamp = null;
  var lastSelesaiTimestamp = null;

  for (var i = 0; i < allData.length; i++) {
    var row = allData[i];
    var rowWad = row[COL.WAD];
    var rowTimestamp = new Date(row[COL.TIMESTAMP]);
    var rowDateStr = Utilities.formatDate(rowTimestamp, 'Asia/Kuala_Lumpur', 'dd/MM/yyyy');

    if (rowWad !== wad) continue;

    lastEventForWad = row[COL.EVENT];
    lastEventTimestamp = rowTimestamp;
    lastEventAnomali = row[COL.STATUS_VALIDASI] && row[COL.STATUS_VALIDASI].toString().indexOf('ANOMALI') === 0;

    if (row[COL.EVENT] === EVENT_HANTAR) lastHantarTimestamp = rowTimestamp;
    if (row[COL.EVENT] === EVENT_SELESAI) lastSelesaiTimestamp = rowTimestamp;

    if (rowDateStr === todayStr) {
      timeline.push({
        event: row[COL.EVENT],
        nama: row[COL.NAMA],
        jawatan: row[COL.JAWATAN],
        time: Utilities.formatDate(rowTimestamp, 'Asia/Kuala_Lumpur', 'HH:mm'),
        anomali: row[COL.STATUS_VALIDASI] && row[COL.STATUS_VALIDASI].toString().indexOf('ANOMALI') === 0
      });
    }
  }

  var currentState = 'TIADA_CYCLE';
  if (lastEventForWad === EVENT_HANTAR) currentState = 'MENUNGGU_PENGISIAN';
  else if (lastEventForWad === EVENT_SELESAI) currentState = 'SEDIA_DIAMBIL';
  else if (lastEventForWad === EVENT_AMBIL) currentState = 'SELESAI';

  var tatMinit = null;
  var tatLabel = null;

  if (currentState === 'MENUNGGU_PENGISIAN' && lastHantarTimestamp) {
    tatMinit = Math.round((new Date().getTime() - lastHantarTimestamp.getTime()) / 60000);
    tatLabel = 'sedang berjalan';
  } else if ((currentState === 'SEDIA_DIAMBIL' || currentState === 'SELESAI') && lastHantarTimestamp && lastSelesaiTimestamp) {
    tatMinit = Math.round((lastSelesaiTimestamp.getTime() - lastHantarTimestamp.getTime()) / 60000);
    tatLabel = 'selesai';
  }

  var tatFormatted = null;
  if (tatMinit !== null) {
    var jam = Math.floor(tatMinit / 60);
    var minit = tatMinit % 60;
    tatFormatted = jam > 0 ? (jam + ' j ' + minit + ' m') : (minit + ' minit');
  }

  return {
    lastRow: lastRow,
    currentState: currentState,
    pendingAlarm: currentState === 'SEDIA_DIAMBIL',
    pendingAnomali: currentState === 'SEDIA_DIAMBIL' && lastEventAnomali,
    lastEventTime: lastEventTimestamp ? Utilities.formatDate(lastEventTimestamp, 'Asia/Kuala_Lumpur', 'HH:mm') : null,
    tatFormatted: tatFormatted,
    tatLabel: tatLabel,
    timeline: timeline
  };
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


// ====== 13. ADMIN - MANUAL CLOSE STUCK CYCLES ======
// PENTING: runHealthCheck() detect stuck cycle dari event TERAKHIR setiap wad
// dalam Log_Troli -- BUKAN dari SLA_Summary. Sebab tu fungsi ni kena tulis satu
// row penutup ke Log_Troli sendiri (bukan sekadar edit SLA_Summary), kalau tak
// wad yang sama akan terus di-flag esok walaupun dah "ditutup".
//
// Run manual (dropdown Apps Script Editor) bila troli disahkan dah diambil secara
// fizikal, tapi staff tak submit Form "Ambil Balik". Untuk setiap wad yang stuck:
// 1. Tulis SATU row ke Log_Troli, event=Ambil Balik, Nama/Jawatan label jelas
//    "PENUTUPAN ADMIN" (bukan menyamar sebagai submission staff sebenar)
// 2. Kemaskini SLA_Summary jika ada row terbuka sepadan -- Masa Ambil & Durasi
//    Tunggu KEKAL KOSONG (tak fabricate durasi dari masa admin tutup cycle,
//    sebab itu bukan masa sebenar troli diambil)
function closeAllStuckCycles() {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  var ss = SpreadsheetApp.openById(id);
  var logSheet = ss.getSheetByName(SHEET_LOG_NAME);
  var slaSheet = ss.getSheetByName(SHEET_SLA_NAME);

  var lastRow = logSheet.getLastRow();
  if (lastRow < 2) { Logger.log('Tiada data dalam Log_Troli.'); return; }

  var allData = logSheet.getRange(2, 1, lastRow - 1, 7).getValues();
  var now = new Date();
  var stuckList = [];

  // Cari semua wad stuck -- logic sama macam runHealthCheck()
  for (var w = 0; w < WAD_LIST.length; w++) {
    var wad = WAD_LIST[w];
    var lastEv = null, lastTs = null;
    for (var j = allData.length - 1; j >= 0; j--) {
      if (allData[j][COL.WAD] === wad) { lastEv = allData[j][COL.EVENT]; lastTs = new Date(allData[j][COL.TIMESTAMP]); break; }
    }
    if (!lastEv || lastEv === EVENT_AMBIL) continue; // takde cycle / dah closed
    var ageHrs = (now.getTime() - lastTs.getTime()) / 3600000;
    if (ageHrs <= 6) continue; // belum stuck lagi
    stuckList.push({ wad: wad, lastEvent: lastEv, lastTs: lastTs });
  }

  if (stuckList.length === 0) { Logger.log('Tiada stuck cycle dijumpai -- takde apa nak ditutup.'); return; }

  var noteStatus = 'PENUTUPAN ADMIN: troli disahkan sudah diambil secara fizikal, tetapi staf tidak submit Form "Ambil Balik". Masa ambil sebenar tidak direkod.';

  stuckList.forEach(function (c) {
    // 1. Tulis event penutup ke Log_Troli (jadi event terakhir baru utk wad ni,
    //    supaya runHealthCheck() esok tak flag wad ni lagi)
    logSheet.appendRow([now, 'admin-closure@sistem', c.wad, EVENT_AMBIL, 'PENUTUPAN ADMIN', 'Sistem (Admin)', noteStatus]);

    // 2. Kemaskini SLA_Summary jika ada row terbuka sepadan
    if (c.lastEvent === EVENT_SELESAI) {
      var slaLastRow = slaSheet.getLastRow();
      if (slaLastRow >= 2) {
        var slaData = slaSheet.getRange(2, 1, slaLastRow - 1, 8).getValues();
        for (var i = slaData.length - 1; i >= 0; i--) {
          var row = slaData[i];
          var rowSelesai = row[3] ? new Date(row[3]) : null;
          if (row[0] === c.wad && rowSelesai && rowSelesai.getTime() === c.lastTs.getTime() && !row[6]) {
            var sheetRow = i + 2;
            // Masa Ambil & Durasi Tunggu (lajur G, H) KEKAL KOSONG -- catat status je
            slaSheet.getRange(sheetRow, 6).setValue(row[5] + ' | ' + noteStatus);
            break;
          }
        }
      }
    } else if (c.lastEvent === EVENT_HANTAR) {
      // Cycle tak sempat capai "Selesai" pun -- rekod row baru sbg partial closure
      var tarikh = Utilities.formatDate(c.lastTs, 'Asia/Kuala_Lumpur', 'dd/MM/yyyy');
      slaSheet.appendRow([c.wad, tarikh, c.lastTs, '', '', 'TAT TIDAK DAPAT DIKIRA (tiada rekod Selesai Isi) | ' + noteStatus, '', '']);
    }
  });

  Logger.log(stuckList.length + ' cycle ditutup: ' + stuckList.map(function (c) { return c.wad; }).join(', '));
}
