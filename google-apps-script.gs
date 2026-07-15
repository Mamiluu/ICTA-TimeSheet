// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.
// Unauthorized copying, modification, or distribution is prohibited.

var ATTENDANCE_SHEET_NAME = 'Attendance';
var EVENTS_SHEET_NAME = 'Events';
var ATTENDANCE_HEADERS = ['Timestamp', 'EventID', 'Name', 'Organization', 'Email', 'Phone', 'Signature', 'ClientID'];
var EVENTS_HEADERS = ['EventID', 'Name', 'Date', 'Location', 'CreatedAt'];

// Set Script Properties > ADMIN_TOKEN (Project Settings in the Apps Script
// editor) to whatever password event organizers should enter on admin.html
// before they can create events. Without this set, event creation is
// disabled for everyone — reading/submitting attendance still works.
function getAdminToken_() {
  return PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN') || '';
}

function getSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  } else {
    var existingHeader = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    if (existingHeader.join('|') !== headers.join('|')) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  }
  return sheet;
}

function getAttendanceSheet_() { return getSheet_(ATTENDANCE_SHEET_NAME, ATTENDANCE_HEADERS); }
function getEventsSheet_() { return getSheet_(EVENTS_SHEET_NAME, EVENTS_HEADERS); }

function formatDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v || '';
}

// Every event nationwide lives as one row in this registry — this is what
// lets the same Apps Script + Spreadsheet serve many simultaneous events
// instead of needing a separate backend per event.
function readEvents_() {
  var sheet = getEventsSheet_();
  var data = sheet.getDataRange().getValues();
  data.shift();
  return data
    .filter(function (r) { return r[0]; })
    .map(function (r) {
      return { id: r[0], name: r[1], date: formatDate_(r[2]), location: r[3], createdAt: r[4] };
    });
}

function findEvent_(eventId) {
  var events = readEvents_();
  for (var i = 0; i < events.length; i++) {
    if (events[i].id === eventId) return events[i];
  }
  return null;
}

// Rows are tagged with EventID rather than split across separate sheets —
// simplest to operate day-to-day, and a national rollup is just "read this
// one sheet." The tradeoff is that all events share one LockService lock on
// write, which is fine at the scale of dozens of simultaneous events but is
// the thing to revisit if usage grows to hundreds nationwide at once.
function readAttendanceRows_(eventId) {
  var sheet = getAttendanceSheet_();
  var data = sheet.getDataRange().getValues();
  data.shift();
  var rows = [];
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (eventId && r[1] !== eventId) continue;
    rows.push({
      id: i + 1,
      timestamp: r[0],
      eventId: r[1],
      name: r[2],
      org: r[3],
      email: r[4],
      phone: r[5],
      signature: r[6]
    });
  }
  return rows;
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function slugify_(s) {
  var base = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
  return base || 'event';
}

function doGet(e) {
  var params = (e && e.parameter) || {};
  try {
    // Admin dashboard: list every event nationwide with a live submitted count,
    // so head office can see everything happening countrywide at a glance.
    if (params.action === 'events') {
      var events = readEvents_();
      var counts = {};
      readAttendanceRows_().forEach(function (r) { counts[r.eventId] = (counts[r.eventId] || 0) + 1; });
      events.forEach(function (ev) { ev.count = counts[ev.id] || 0; });
      events.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      return jsonOut_({ ok: true, events: events });
    }

    if (params.event) {
      var ev = findEvent_(params.event);
      if (!ev) return jsonOut_({ ok: false, error: 'Event not found' });
      return jsonOut_({ ok: true, event: ev, rows: readAttendanceRows_(params.event) });
    }

    // No event specified: back-compat / diagnostic view across everything.
    return jsonOut_({ ok: true, rows: readAttendanceRows_() });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var body = JSON.parse(e.postData.contents);

    if (body.action === 'createEvent') {
      return handleCreateEvent_(body);
    }

    if (body.action === 'updateEvent') {
      return handleUpdateEvent_(body);
    }

    if (body.action === 'deleteEvent') {
      return handleDeleteEvent_(body);
    }

    return handleSubmitAttendance_(body);
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Name, date, and location are all mandatory — an event with no date/location
// gives the venue nothing to distinguish it from any other sheet, so the
// admin UI blocks submission client-side and this is the server-side backstop.
function handleCreateEvent_(body) {
  var token = getAdminToken_();
  if (!token || body.adminToken !== token) {
    return jsonOut_({ ok: false, error: 'Not authorized' });
  }
  var name = body.name && String(body.name).trim();
  var date = body.date && String(body.date).trim();
  var location = body.location && String(body.location).trim();
  if (!name) return jsonOut_({ ok: false, error: 'Event name is required' });
  if (!date) return jsonOut_({ ok: false, error: 'Event date is required' });
  if (!location) return jsonOut_({ ok: false, error: 'Event location is required' });

  var sheet = getEventsSheet_();
  var eventId = slugify_(name) + '-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  sheet.appendRow([eventId, name, date, location, new Date()]);

  return jsonOut_({
    ok: true,
    event: { id: eventId, name: name, date: date, location: location }
  });
}

// Lets the admin correct/rename an event after creation (typos, venue
// changes) without losing its EventID — and therefore without orphaning any
// attendance rows already submitted against that ID.
function handleUpdateEvent_(body) {
  var token = getAdminToken_();
  if (!token || body.adminToken !== token) {
    return jsonOut_({ ok: false, error: 'Not authorized' });
  }
  var eventId = body.eventId && String(body.eventId).trim();
  if (!eventId) return jsonOut_({ ok: false, error: 'Missing event id' });

  var name = body.name && String(body.name).trim();
  var date = body.date && String(body.date).trim();
  var location = body.location && String(body.location).trim();
  if (!name) return jsonOut_({ ok: false, error: 'Event name is required' });
  if (!date) return jsonOut_({ ok: false, error: 'Event date is required' });
  if (!location) return jsonOut_({ ok: false, error: 'Event location is required' });

  var sheet = getEventsSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === eventId) {
      sheet.getRange(i + 1, 2, 1, 3).setValues([[name, date, location]]);
      return jsonOut_({ ok: true, event: { id: eventId, name: name, date: date, location: location } });
    }
  }
  return jsonOut_({ ok: false, error: 'Event not found' });
}

function handleSubmitAttendance_(body) {
  var eventId = body.event || '';
  if (!eventId) return jsonOut_({ ok: false, error: 'Missing event' });
  if (!findEvent_(eventId)) return jsonOut_({ ok: false, error: 'Unknown event' });

  var sheet = getAttendanceSheet_();
  var clientId = body.clientId || '';

  // Idempotency guard: if this exact submission (by client-generated id)
  // already made it into the sheet — e.g. the first request actually
  // succeeded but the response was lost on a flaky connection and the
  // client retried, or a double-tap slipped through — return the
  // existing row instead of creating a duplicate.
  if (clientId) {
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var clientIds = sheet.getRange(2, 8, lastRow - 1, 1).getValues();
      for (var i = 0; i < clientIds.length; i++) {
        if (clientIds[i][0] === clientId) {
          return jsonOut_({ ok: true, id: i + 1, duplicate: true });
        }
      }
    }
  }

  sheet.appendRow([
    new Date(),
    eventId,
    body.name || '',
    body.org || '',
    body.email || '',
    body.phone || '',
    body.signature || '',
    clientId
  ]);
  var id = sheet.getLastRow() - 1; // minus header row
  return jsonOut_({ ok: true, id: id });
}
