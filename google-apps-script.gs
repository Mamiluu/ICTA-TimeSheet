var SHEET_NAME = 'Attendance';
var HEADERS = ['Timestamp', 'Name', 'Organization', 'Email', 'Phone', 'Signature', 'ClientID'];

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
  } else {
    var existingHeader = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
    if (existingHeader.join('|') !== HEADERS.join('|')) {
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    }
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
    var clientId = body.clientId || '';

    // Idempotency guard: if this exact submission (by client-generated id)
    // already made it into the sheet — e.g. the first request actually
    // succeeded but the response was lost on a flaky connection and the
    // client retried, or a double-tap slipped through — return the
    // existing row instead of creating a duplicate.
    if (clientId) {
      var lastRow = sheet.getLastRow();
      if (lastRow > 1) {
        var clientIds = sheet.getRange(2, 7, lastRow - 1, 1).getValues();
        for (var i = 0; i < clientIds.length; i++) {
          if (clientIds[i][0] === clientId) {
            return ContentService
              .createTextOutput(JSON.stringify({ ok: true, id: i + 1, duplicate: true }))
              .setMimeType(ContentService.MimeType.JSON);
          }
        }
      }
    }

    sheet.appendRow([
      new Date(),
      body.name || '',
      body.org || '',
      body.email || '',
      body.phone || '',
      body.signature || '',
      clientId
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
