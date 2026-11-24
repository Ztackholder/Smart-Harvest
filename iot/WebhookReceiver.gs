function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Log_Sensor");
    var data = JSON.parse(e.postData.contents);

    var timestamp = new Date();
    var temp      = Number(data.temp);
    var pres      = Number(data.pres);
    var soilPct   = Number(data.soil_pct);
    var soilRaw   = Number(data.soil_raw);

    var nextRow = sheet.getLastRow() + 1;
    var statusFormula = '=IF(D' + nextRow + '<30,"Kering",IF(D' + nextRow + '<=75,"Optimal","Terlalu Basah"))';

    sheet.appendRow([
      timestamp,
      temp,
      pres,
      soilPct,
      soilRaw,
      statusFormula
    ]);

    return ContentService.createTextOutput(JSON.stringify({ status: "OK" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "ERROR", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
