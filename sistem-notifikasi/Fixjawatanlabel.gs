/**
 * FIX LABEL JAWATAN - SISTEM TROLI UBAT HYAN
 * Betulkan "Pembantu Farmasi (PPF)" -> "Penolong Pegawai Farmasi (PPF)"
 * dalam Form sedia ada (URL/QR kekal sama).
 */

var FORM_ID = '1A0M65XLOhpib8cRQmV-nRToN4et_8bbIt_cA5tEUubs';

function fixJawatanLabel() {
  var form = FormApp.openById(FORM_ID);
  var items = form.getItems();

  var jawatanItem = null;
  for (var i = 0; i < items.length; i++) {
    if (items[i].getTitle().indexOf('Jawatan') > -1) {
      jawatanItem = items[i];
      break;
    }
  }

  if (!jawatanItem) {
    Logger.log('AMARAN: Item "Jawatan" tidak dijumpai. Sila semak title soalan tersebut.');
    return;
  }

  var jawatanList = jawatanItem.asListItem();
  var existingChoices = jawatanList.getChoices().map(function (c) { return c.getValue(); });

  Logger.log('Pilihan SEBELUM: ' + JSON.stringify(existingChoices));

  var updatedChoices = existingChoices.map(function (val) {
    if (val.indexOf('Pembantu Farmasi') > -1) {
      return 'Penolong Pegawai Farmasi (PPF)';
    }
    return val;
  });

  jawatanList.setChoiceValues(updatedChoices);

  Logger.log('Pilihan SELEPAS: ' + JSON.stringify(updatedChoices));
  Logger.log('=== SELESAI. Sila buka Form URL untuk verify secara visual. ===');
  Logger.log('Form URL: ' + form.getPublishedUrl());
}
