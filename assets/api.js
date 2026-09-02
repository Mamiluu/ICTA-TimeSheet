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
    del: function(path){ return request('DELETE', path); }
  };
})();

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
