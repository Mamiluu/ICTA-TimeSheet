var SHEET_NAME = 'Attendance';
var HEADERS = ['Timestamp', 'Name', 'Organization', 'Email', 'Phone', 'Signature'];

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
  }
  return sheet;
}

function doGet(e) {
  var sheet = getSheet_();
  var data = sheet.getDataRange().getValues();
  data.shift(); // drop header row
  var rows = data.map(function (r, i) {
    return {
      id: i + 1,
      timestamp: r[0],
      name: r[1],
      org: r[2],
      email: r[3],
      phone: r[4],
      signature: r[5]
    };
  });
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, rows: rows }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var body = JSON.parse(e.postData.contents);
    var sheet = getSheet_();
    sheet.appendRow([
      new Date(),
      body.name || '',
      body.org || '',
      body.email || '',
      body.phone || '',
      body.signature || ''
    ]);
    var id = sheet.getLastRow() - 1; // minus header row
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, id: id }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
