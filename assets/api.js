// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.
//
// Shared fetch wrapper for every page that talks to the Node backend.
// Session auth is a cookie (credentials:'include'), not a token in
// localStorage -- there is nothing else callers need to attach.
var API = (function(){
  // Same origin as the page in production; override here only if the API
  // is ever served from a different host than the static pages.
  var BASE_URL = '';

  function request(method, path, body){
    return fetch(BASE_URL + path, {
      method: method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function(res){
      // A body that fails to parse as JSON almost always means the request
      // never reached the app at all -- most commonly Render's free tier
      // spinning back up after an idle period (see the dashboard's own
      // "will spin down with inactivity" notice), or a gateway/proxy
      // hiccup during a deploy -- not a real API response. Every page on
      // this site follows the same `r.data.message || 'Could not do X.'`
      // pattern, so setting `message` here once is enough to make every
      // one of those call sites -- present and future -- show an honest
      // "temporarily unavailable, try again" instead of misreporting a
      // transient outage as "could not do X" (e.g. implying a delete was
      // refused when the request never even reached the delete route).
      return res.json().catch(function(){
        return {
          ok: false,
          error: 'BAD_RESPONSE',
          message: 'The server was temporarily unavailable (it may be waking up after being idle). Please wait a few seconds and try again.'
        };
      }).then(function(data){
        return { status: res.status, data: data };
      });
    });
  }

  return {
    get: function(path){ return request('GET', path); },
    post: function(path, body){ return request('POST', path, body); },
    put: function(path, body){ return request('PUT', path, body); },
    patch: function(path, body){ return request('PATCH', path, body); },
    del: function(path){ return request('DELETE', path); }
  };
})();

// Where each kind of account lands after signing in, and where a page sends an
// account that does not belong on it. One place, so the pages can never send a
// role back and forth between two dashboards.
function homeFor(role){
  if(role === 'OWNER') return 'owner.html';
  if(role === 'PLATFORM_ADMIN') return 'platform.html';
  if(role === 'SUPER_ADMIN') return 'superadmin.html';
  return 'admin.html';
}

// Every value rendered via string-concatenated innerHTML elsewhere on these
// pages (event names, admin emails, audit metadata) originates from the
// database, not a template -- always pass it through this first. Building
// rows via textContent/DOM APIs is preferred where practical, but the
// admin/superadmin activity tables interpolate several fields into one
// innerHTML string for brevity, so escaping is the safety net there.
function escapeHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
  });
}

// Shared by admin.html/superadmin.html's topbar -- both hardcode "ICT
// Authority — <role>" as a sane default, then swap in the real org name
// once GET /api/branding resolves, same pattern as index.html's own
// letterhead (see applyBranding there). `suffix` is the page's own role
// label ("Event Admin" / "Super Admin"); the org name is the only part
// that ever varies by deployment.
function applyTopbarBranding(suffix){
  var el = document.getElementById('brandTopbarTitle');
  if(!el) return;
  API.get('/api/branding').then(function(r){
    if(r.status === 200 && r.data && r.data.ok && r.data.orgName){
      el.textContent = r.data.orgName + ' — ' + suffix;
    }
  }).catch(function(){ /* keep the built-in default */ });
}

// --- Audit trail formatting -------------------------------------------
// Shared by admin.html's "My activity" and superadmin.html's per-admin
// audit drill-down, both of which used to render a row's Detail column as
// a literal JSON.stringify(metadata) -- correct, but unreadable at a
// glance for anyone who isn't the person who wrote the route that logged
// it. This turns each of the ~17 actions this app actually writes (see
// every writeAudit() call site under server/src/routes/) into a plain-
// language summary, and an EVENT_UPDATE/ATTENDANCE_EDIT's before/after
// pair into just the fields that actually changed, not a full record
// dump. The raw metadata is never hidden, only tucked behind a per-row
// <details> toggle -- an audit trail that hides its own source data on a
// redesign would defeat the entire point of having one.
var AUDIT_ACTION_META = {
  LOGIN: { label: 'Logged in', tone: 'neutral' },
  LOGOUT: { label: 'Logged out', tone: 'neutral' },
  ACCOUNT_ACTIVATED: { label: 'Activated account', tone: 'positive' },
  PASSWORD_RESET_REQUESTED: { label: 'Requested password reset', tone: 'neutral' },
  PASSWORD_RESET_COMPLETED: { label: 'Completed password reset', tone: 'positive' },
  SIGNATURE_REQUESTED: { label: 'Requested signature', tone: 'neutral' },
  ATTENDANCE_EDIT: { label: 'Edited entry', tone: 'neutral' },
  ATTENDANCE_FLAGGED: { label: 'Flagged entry', tone: 'warning' },
  ATTENDANCE_RETIRED: { label: 'Removed entry', tone: 'danger' },
  ATTENDANCE_REOPENED: { label: 'Reopened entry', tone: 'positive' },
  EVENT_CREATE: { label: 'Created event', tone: 'positive' },
  EVENT_UPDATE: { label: 'Updated event', tone: 'neutral' },
  EVENT_DELETE: { label: 'Deleted event', tone: 'danger' },
  EVENT_ATTENDANCE_EXPORTED: { label: 'Exported attendance', tone: 'info' },
  ADMIN_CREATE: { label: 'Created admin', tone: 'positive' },
  ADMIN_ACTIVATION_LINK_VIEWED: { label: 'Viewed activation link', tone: 'neutral' },
  ADMIN_DISABLE: { label: 'Disabled admin', tone: 'danger' },
  ADMIN_REACTIVATE: { label: 'Reactivated admin', tone: 'positive' },
  ADMIN_DELETE: { label: 'Deleted admin', tone: 'danger' },
  ADMIN_ACCESS_CHANGED: { label: 'Changed admin access', tone: 'warning' },
  DUTY_PAYEE_ADDED: { label: 'Added to payment sheet', tone: 'positive' },
  DUTY_PAYEE_UPDATED: { label: 'Updated payment details', tone: 'neutral' },
  DUTY_PAYEE_REMOVED: { label: 'Removed from payment sheet', tone: 'danger' },
  DUTY_ROLL_PRINTED: { label: 'Printed payment sheet', tone: 'info' },
  DUTY_ROLL_EXPORTED: { label: 'Exported payment schedule', tone: 'info' },
  DUTY_ROLL_SUBMITTED: { label: 'Submitted payment sheet', tone: 'info' },
  DUTY_ROLL_REVIEWED: { label: 'Reviewed payment sheet', tone: 'neutral' },
  DUTY_ROLL_CERTIFIED: { label: 'Certified payment sheet', tone: 'positive' },
  DUTY_ROLL_VERIFIED: { label: 'Verified payment sheet', tone: 'positive' },
  DUTY_ROLL_RETURNED: { label: 'Returned payment sheet', tone: 'warning' },
  DUTY_QUERY_RAISED: { label: 'Question raised', tone: 'neutral' },
  DUTY_QUERY_RESOLVED: { label: 'Question answered', tone: 'positive' },
  SUPER_ADMIN_CREATE: { label: 'Created super admin', tone: 'positive' },
  SUPER_ADMIN_ACTIVATION_LINK_VIEWED: { label: 'Viewed activation link', tone: 'neutral' },
  SUPER_ADMIN_DISABLE: { label: 'Disabled super admin', tone: 'danger' },
  SUPER_ADMIN_REACTIVATE: { label: 'Reactivated super admin', tone: 'positive' },
  SUPER_ADMIN_DELETE: { label: 'Deleted super admin', tone: 'danger' },
  ORG_CREATE: { label: 'Created organisation', tone: 'positive' },
  ORG_SUSPEND: { label: 'Suspended organisation', tone: 'danger' },
  ORG_RESUME: { label: 'Resumed organisation', tone: 'positive' },
  ORG_ACTIVATION_LINK_VIEWED: { label: 'Viewed activation link', tone: 'neutral' },
  DEPARTMENT_CREATE: { label: 'Created department', tone: 'positive' },
  DEPARTMENT_SEED: { label: 'Added standard departments', tone: 'positive' },
  DEPARTMENT_RENAME: { label: 'Renamed department', tone: 'neutral' },
  DEPARTMENT_PAUSE: { label: 'Paused department', tone: 'warning' },
  DEPARTMENT_RESUME: { label: 'Resumed department', tone: 'positive' },
  SHEET_SEALED: { label: 'Sealed sheet', tone: 'info' },
  DAY_REOPENED: { label: 'Reopened a day', tone: 'warning' },
  DAY_CHECKIN_BY_PHONE: { label: 'Phone check-in', tone: 'neutral' },
  DAY_CHECKIN_DOOR: { label: 'Door check-in', tone: 'neutral' },
  CERTIFICATE_ISSUED: { label: 'Certificate issued', tone: 'positive' },
  CHAIN_ANCHORED: { label: 'Anchored audit trail', tone: 'info' },
  CLAIM_PACK_GENERATED: { label: 'Generated claim pack', tone: 'info' },
  CLAIM_PACK_APPROVED: { label: 'Approved claim pack', tone: 'positive' },
  DOOR_ROSTER_DOWNLOADED: { label: 'Saved guest list offline', tone: 'info' }
};

var AUDIT_FIELD_LABELS = {
  name: 'Name', description: 'Description', startAt: 'Start', endAt: 'End', timezone: 'Timezone',
  locationType: 'Location type', address: 'Address', meetingLink: 'Meeting link',
  organization: 'Organization', email: 'Email', phone: 'Phone'
};

function auditFieldValue(key, value){
  if(value == null || value === '') return '—';
  if(key === 'startAt' || key === 'endAt') return new Date(value).toLocaleString();
  return String(value);
}

// Only the fields that actually differ -- before/after are always built
// with identical key sets by the routes that log them (see EVENT_UPDATE
// in admin.js, ATTENDANCE_EDIT in public.js), so comparing after's keys
// against before covers every real case.
function auditDiff(before, after){
  if(!before || !after) return [];
  return Object.keys(after)
    .filter(function(k){ return Object.prototype.hasOwnProperty.call(before, k) && before[k] !== after[k]; })
    .map(function(k){
      var label = AUDIT_FIELD_LABELS[k] || k;
      return escapeHtml(label) + ': ' + escapeHtml(auditFieldValue(k, before[k])) + ' → ' + escapeHtml(auditFieldValue(k, after[k]));
    });
}

function auditSummary(e){
  var m = e.metadata || {};
  switch(e.action){
    case 'SIGNATURE_REQUESTED':
      return 'Sent a signature request to ' + escapeHtml(m.name || 'an attendee');
    case 'ATTENDANCE_EDIT': {
      var editChanges = auditDiff(m.before, m.after);
      return editChanges.length ? editChanges.join('<br>') : 'Saved with no actual field changes';
    }
    case 'ATTENDANCE_FLAGGED':
      return escapeHtml(m.name || 'An entry') + (m.reason ? ' — “' + escapeHtml(m.reason) + '”' : '');
    case 'ATTENDANCE_RETIRED':
      return 'Confirmed removal of ' + escapeHtml(m.name || 'an entry') + (m.reason ? ' — “' + escapeHtml(m.reason) + '”' : '');
    case 'ATTENDANCE_REOPENED':
      return 'Reopened ' + escapeHtml(m.name || 'an entry') + (m.previousStatus ? ' (was ' + escapeHtml(m.previousStatus) + ')' : '') + (m.reason ? ' — “' + escapeHtml(m.reason) + '”' : '');
    case 'EVENT_CREATE':
      return '“' + escapeHtml(m.name || '') + '” — ' + escapeHtml(auditFieldValue('startAt', m.startAt)) +
        (m.locationType === 'VIRTUAL' ? ' · Virtual' : (m.address ? ' · ' + escapeHtml(m.address) : ''));
    case 'EVENT_UPDATE': {
      var eventChanges = auditDiff(m.before, m.after);
      return eventChanges.length ? eventChanges.join('<br>') : 'Saved with no actual field changes';
    }
    case 'EVENT_DELETE':
      return '“' + escapeHtml(m.name || '') + '”';
    case 'EVENT_ATTENDANCE_EXPORTED':
      return '“' + escapeHtml(m.name || '') + '” — ' + (m.rowCount != null ? m.rowCount : '?') + (m.rowCount === 1 ? ' record' : ' records');
    case 'SHEET_SEALED': {
      var sealDays = m.dayCount || 1;
      return (sealDays > 1 ? 'All ' + sealDays + ' days' : 'The sheet') + (m.rowCount != null ? ' · ' + m.rowCount + (m.rowCount === 1 ? ' person' : ' people') : '');
    }
    case 'DAY_REOPENED':
      return 'Day ' + (m.position || '?') + ' reopened for ' + (m.hours || '?') + ' hours';
    case 'DAY_CHECKIN_BY_PHONE':
    case 'DAY_CHECKIN_DOOR':
      return 'Day ' + (m.position || '?');
    case 'CERTIFICATE_ISSUED':
      return (m.days || '?') + (m.days === 1 ? ' day' : ' days') + ' certified';
    case 'CLAIM_PACK_GENERATED':
      return '“' + escapeHtml(m.name || '') + '” — ' + (m.rowCount != null ? m.rowCount : '?') + (m.rowCount === 1 ? ' person' : ' people');
    case 'CLAIM_PACK_APPROVED':
      return 'Sealed ' + escapeHtml(m.sealCode || '') + ' · ' + (m.people != null ? m.people : '?') + ' people · ' + (m.review || 0) + (m.review === 1 ? ' item' : ' items') + ' reviewed' + (m.note ? ' — “' + escapeHtml(m.note) + '”' : '');
    case 'DOOR_ROSTER_DOWNLOADED':
      return 'Guest list saved for offline door scanning — ' + (m.rowCount != null ? m.rowCount : '?') + (m.rowCount === 1 ? ' person' : ' people');
    case 'CHAIN_ANCHORED':
      return (m.entries != null ? m.entries : '?') + ' entries on record' + (m.sent != null ? ' · emailed to ' + m.sent : '');
    case 'ADMIN_CREATE':
      return escapeHtml(m.county || '');
    case 'ADMIN_DELETE':
      return escapeHtml(m.email || '') + (m.county ? ' (' + escapeHtml(m.county) + ')' : '');
    case 'ADMIN_ACCESS_CHANGED':
      return escapeHtml(m.from || '') + ' → ' + escapeHtml(m.to || '');
    case 'DUTY_PAYEE_ADDED':
    case 'DUTY_PAYEE_REMOVED':
      return escapeHtml(m.name || '') + (m.reason ? ' — “' + escapeHtml(m.reason) + '”' : '');
    case 'DUTY_PAYEE_UPDATED':
      return escapeHtml(m.name || '') + (m.before && m.after && m.before.ratePerDay !== m.after.ratePerDay ? ': rate ' + m.before.ratePerDay + ' → ' + m.after.ratePerDay : '');
    case 'DUTY_ROLL_SUBMITTED':
      return '“' + escapeHtml(m.name || '') + '” — ' + (m.people != null ? m.people : '?') + ' people' + (m.early ? ' · sent early: ' + escapeHtml(m.reason || '') : '');
    case 'DUTY_ROLL_CERTIFIED':
    case 'DUTY_ROLL_VERIFIED':
    case 'DUTY_ROLL_RETURNED':
      return '“' + escapeHtml(m.name || '') + '”' + (m.sealCode ? ' · seal ' + escapeHtml(m.sealCode) : '') + (m.review ? ' · ' + m.review + (m.review === 1 ? ' item' : ' items') + ' reviewed' : '') + (m.note ? ' — “' + escapeHtml(m.note) + '”' : '');
    case 'DUTY_ROLL_REVIEWED':
    case 'DUTY_QUERY_RESOLVED':
      return '“' + escapeHtml(m.name || '') + '”' + (m.response ? ' — “' + escapeHtml(m.response) + '”' : '');
    case 'DUTY_ROLL_PRINTED':
    case 'DUTY_ROLL_EXPORTED':
      return '“' + escapeHtml(m.name || '') + '” — ' + (m.rowCount != null ? m.rowCount : '?') + (m.rowCount === 1 ? ' person' : ' people');
    case 'SUPER_ADMIN_CREATE':
      return escapeHtml(m.department || '');
    case 'SUPER_ADMIN_DISABLE':
      return escapeHtml(m.department || '');
    case 'SUPER_ADMIN_DELETE':
      return escapeHtml(m.email || '') + (m.department ? ' (' + escapeHtml(m.department) + ')' : '');
    case 'ORG_CREATE':
    case 'ORG_RESUME':
      return escapeHtml(m.name || '');
    case 'ORG_SUSPEND':
      return escapeHtml(m.name || '') + (m.reason ? ' — “' + escapeHtml(m.reason) + '”' : '');
    case 'DEPARTMENT_CREATE':
    case 'DEPARTMENT_PAUSE':
    case 'DEPARTMENT_RESUME':
      return escapeHtml(m.name || '');
    case 'DEPARTMENT_RENAME':
      return escapeHtml(m.from || '') + ' → ' + escapeHtml(m.to || '');
    case 'DEPARTMENT_SEED':
      return (m.created ? m.created.length : 0) + ' added'; 
    default:
      return e.targetType ? escapeHtml(e.targetType) + (e.targetId ? ' ' + escapeHtml(String(e.targetId).slice(0, 8)) : '') : '';
  }
}

// Who did it, in words. An entry with no signed-in person behind it comes from
// one of two places: the system itself (the daily audit anchor) or an attendee
// acting on their own entry, who has no account (a certificate, a phone-number
// check-in). Anything else without an actor is shown as not recorded rather
// than guessed at.
var AUDIT_SYSTEM_ACTIONS = ['CHAIN_ANCHORED'];
var AUDIT_ROLE_LABEL = { OWNER: 'Platform owner', PLATFORM_ADMIN: 'Organisation admin', SUPER_ADMIN: 'Super admin', COUNTY_ADMIN: 'County admin' };
var AUDIT_ATTENDEE_ACTIONS = ['CERTIFICATE_ISSUED', 'DAY_CHECKIN_BY_PHONE'];
function auditActorLabel(e){
  if(e.actor) return e.actor.email + ' (' + (AUDIT_ROLE_LABEL[e.actor.role] || e.actor.role) + (e.actor.county ? ', ' + e.actor.county : '') + (e.actor.department ? ', ' + e.actor.department.name : '') + ')';
  if(e.actorEmail) return e.actorEmail + ' (' + e.actorRole + (e.actorCounty ? ', ' + e.actorCounty : '') + ') [deleted]';
  if(e.actorId) return e.actorId;
  if(AUDIT_SYSTEM_ACTIONS.indexOf(e.action) !== -1) return 'System (automatic)';
  if(AUDIT_ATTENDEE_ACTIONS.indexOf(e.action) !== -1) return 'Attendee';
  return 'Not recorded';
}

// A short, approximate hint alongside the exact timestamp every caller
// already renders -- never the only time shown, since an official record
// should say precisely when something happened, not just "a while ago".
function auditRelativeTime(date){
  var mins = Math.round((Date.now() - date.getTime()) / 60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return mins + 'm ago';
  var hours = Math.round(mins / 60);
  if(hours < 24) return hours + 'h ago';
  var days = Math.round(hours / 24);
  if(days < 30) return days + 'd ago';
  return null;
}

// Returns everything a caller needs to render one audit row: a colored
// action badge, a human-readable summary, and (if this entry actually
// carries metadata) a collapsed <details> block with the untouched raw
// JSON -- callers just drop these into whatever <td> markup that page
// already uses.
function formatAuditEntry(e){
  var meta = AUDIT_ACTION_META[e.action] || { label: e.action, tone: 'neutral' };
  var rawJson = e.metadata ? JSON.stringify(e.metadata, null, 2) : '';
  return {
    badgeHtml: '<span class="audit-badge audit-badge-' + meta.tone + '">' + escapeHtml(meta.label) + '</span>',
    summaryHtml: auditSummary(e) || '<span class="audit-empty">—</span>',
    rawHtml: rawJson ? '<details class="audit-raw"><summary>Raw</summary><pre>' + escapeHtml(rawJson) + '</pre></details>' : ''
  };
}
