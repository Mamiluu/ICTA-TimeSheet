// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// Not currently loaded by any page -- admin.html's event Address field is
// plain typed text for now (no map, no venue search), so this token isn't
// read by anything. Kept here, already filled in, for whenever a map/venue
// -search picker gets re-added: that would mean loading Mapbox GL JS (see
// the mapbox-gl.css/.js CDN tags removed from admin.html and index.html --
// check git history around the "remove the map thing for now" change for
// the last working version) and adding this file's script tag back before
// it, plus restoring api.mapbox.com to server/src/index.js's CSP
// (script-src, style-src, img-src, connect-src, worker-src, and
// 'wasm-unsafe-eval' on script-src -- see that file's git history too).
//
// If this token ever needs replacing: sign up at https://www.mapbox.com/,
// then copy the "Default public token" from
// https://account.mapbox.com/access-tokens/. Note Mapbox requires a
// payment method on file to issue any token at all (free-tier usage isn't
// billed, but a card is still required up front). Once whatever uses this
// is live at a real URL, restrict the token to that URL on the same
// tokens page -- Mapbox public tokens are designed to ship in client-side
// code like this, security comes from that URL restriction, not from
// keeping the token secret. GitHub's push protection may flag this line as
// a "Mapbox Secret Access Token" when you commit it even though it's a
// public (pk.) token -- that's just the name of the detection pattern, not
// a sign something's wrong; allow it via the URL GitHub gives you.
window.MAPBOX_TOKEN = 'pk.eyJ1IjoibWFtaWx1dSIsImEiOiJjbXRraDJ0MXYwazNlMnlzbHA0Z2gybHJmIn0.N_myqMrNfaUbLXbh7pBOBg';
