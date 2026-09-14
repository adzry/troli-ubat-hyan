/**
 * EDIT FORM SEDIA ADA - SISTEM TROLI UBAT HYAN
 * Script ni EDIT Form yang dah wujud (URL/QR kekal sama), bukan create baharu.
 *
 * CARA GUNA:
 * 1. Pergi script.google.com/home -> New project (atau buka project sedia ada)
 * 2. Paste code ni
 * 3. Run function `editExistingForm` SEKALI
 * 4. Authorize bila diminta
 * 5. Check Execution Log untuk confirm berjaya
 * 6. Buka Form URL untuk verify visual
 */

var FORM_ID = '1A0M65XLOhpib8cRQmV-nRToN4et_8bbIt_cA5tEUubs';

function editExistingForm() {
  var form = FormApp.openById(FORM_ID);
  var items = form.getItems();

  Logger.log('Form dijumpai: ' + form.getTitle());
  Logger.log('Jumlah item sedia ada: ' + items.length);

  // ====== 3a. EMAIL - tambah description ======
  // Email collection biasanya automatik (setCollectEmail), so kita cari soalan PERTAMA
  // selepas email (kalau ada item text/list di awal yang boleh diberi description).
  // Kalau Form guna native "Collect email" toggle, tiada item boleh diedit untuknya secara terus;
  // jadi kita tambah description kat description Form itu sendiri sebagai fallback.
  form.setDescription(
    'Sila gunakan email rasmi MOH semasa mengisi borang ini. (Amatlah digalakkan)\n\n' +
    'Borang Tindakan Troli Ubat - Hospital Yan'
  );
  Logger.log('Form description dikemaskini (rujukan email rasmi MOH).');

  // ====== Cari item-item sedia ada ikut title ======
  var wadItem = null;
  var eventItem = null;
  var jawatanItem = null;

  for (var i = 0; i < items.length; i++) {
    var title = items[i].getTitle();
    if (title.indexOf('Wad') > -1 || title.indexOf('wad') > -1) {
      if (items[i].getType() === FormApp.ItemType.LIST || items[i].getType() === FormApp.ItemType.MULTIPLE_CHOICE) {
        wadItem = items[i];
      }
    }
    if (title.indexOf('Tindakan') > -1) {
      eventItem = items[i];
    }
    if (title.indexOf('Jawatan') > -1) {
      jawatanItem = items[i];
    }
  }

  // ====== 3b. PILIH WAD - tambah kategori "Selain Wad" ======
  if (wadItem) {
    var wadList = wadItem.asListItem();
    var existingChoices = wadList.getChoices().map(function (c) { return c.getValue(); });

    var nonWadOptions = [
      'Kecemasan & Trauma',
      'Klinik Sejahtera',
      'Klinik Pakar',
      'ESWL',
      'Forensik',
      'Patologi',
      'Fisioterapi',
      'Unit Cara Kerja (Occupational Therapy)'
    ];

    var allOptions = existingChoices.concat(nonWadOptions);
    wadList.setChoiceValues(allOptions);
    Logger.log('Pilihan Wad dikemaskini. Jumlah pilihan sekarang: ' + allOptions.length);
  } else {
    Logger.log('AMARAN: Item "Pilih Wad" tidak dijumpai. Sila semak title soalan tersebut.');
  }

  // ====== 3c. JENIS TINDAKAN - rename + tambah description ======
  if (eventItem) {
    var eventList = eventItem.asMultipleChoiceItem();
    var currentChoices = eventList.getChoices();

    // Kekalkan urutan asal, tukar value & description ikut mapping
    var newChoices = [];
    for (var j = 0; j < currentChoices.length; j++) {
      var val = currentChoices[j].getValue();
      var newVal = val;

      if (val.indexOf('Hantar') > -1) {
        newVal = 'Hantar Troli';
      } else if (val.indexOf('Selesai') > -1 || val.indexOf('selesai') > -1) {
        newVal = 'Pengisian ubat selesai';
      } else if (val.indexOf('Ambil') > -1 || val.indexOf('ambil') > -1) {
        newVal = 'Troli ubat/pesanan ubat telah diambil';
      }

      newChoices.push(eventList.createChoice(newVal));
    }
    eventList.setChoices(newChoices);

    // Google Forms tidak sokong per-choice description secara native untuk Multiple Choice;
    // description diletakkan pada soalan itu sendiri (helpText), merangkumi semua 3 pilihan.
    eventList.setHelpText(
      'Hantar Troli: Untuk tindakan pihak Wad - staff yang datang hantar troli ubat/pesanan ubat ke farmasi.\n\n' +
      'Pengisian ubat selesai: Untuk tindakan diisi oleh pihak farmasi pesakit dalam. PF ataupun PPF.\n\n' +
      'Troli ubat/pesanan ubat telah diambil: Untuk tindakan oleh staff pihak wad yang datang mengambil troli ubat/pesanan ubat.'
    );
    Logger.log('Jenis Tindakan dikemaskini: label baharu + description (helpText).');
  } else {
    Logger.log('AMARAN: Item "Jenis Tindakan" tidak dijumpai. Sila semak title soalan tersebut.');
  }

  // ====== 3d. JAWATAN - tambah 2 pilihan baharu ======
  if (jawatanItem) {
    var jawatanList = jawatanItem.asListItem();
    var existingJawatan = jawatanList.getChoices().map(function (c) { return c.getValue(); });

    var newJawatanOptions = ['Pembantu Perawatan Kesihatan (PPK)', 'Penolong Pegawai Perubatan (PPP)'];
    var combinedJawatan = existingJawatan.concat(newJawatanOptions);

    jawatanList.setChoiceValues(combinedJawatan);
    Logger.log('Pilihan Jawatan dikemaskini. Jumlah pilihan sekarang: ' + combinedJawatan.length);
  } else {
    Logger.log('AMARAN: Item "Jawatan" tidak dijumpai. Sila semak title soalan tersebut.');
  }

  Logger.log('=== SELESAI. Sila buka Form URL untuk verify secara visual. ===');
  Logger.log('Form URL: ' + form.getPublishedUrl());
}


// ====== UTILITI - SENARAI SEMUA ITEM (untuk debug kalau title tidak match) ======
function listAllFormItems() {
  var form = FormApp.openById(FORM_ID);
  var items = form.getItems();
  for (var i = 0; i < items.length; i++) {
    Logger.log((i + 1) + '. [' + items[i].getType() + '] "' + items[i].getTitle() + '"');
  }
}
