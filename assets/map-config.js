// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// Shared by admin.html (the event location picker) and index.html (the
// attendee-facing venue preview) -- one place to drop in a real token
// rather than pasting it into two separate static pages.
//
// To get one: sign up free at https://www.mapbox.com/ (no credit card
// required), then copy your "Default public token" from
// https://account.mapbox.com/access-tokens/ and paste it below in place of
// the placeholder. Once this app is live at its real URL, come back to
// that same token-settings page and restrict the token to that URL so it
// can't be used from anywhere else -- Mapbox's public tokens are designed
// to ship in client-side code like this, security comes from that URL
// restriction, not from keeping the token secret.
window.MAPBOX_TOKEN = 'pk.eyJ1IjoibWFtaWx1dSIsImEiOiJjbXRraDJ0MXYwazNlMnlzbHA0Z2gybHJmIn0.N_myqMrNfaUbLXbh7pBOBg';
