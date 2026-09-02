// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// Every env var defaults to this pilot's actual current values (ICT
// Authority), so an unconfigured deployment behaves exactly as it always
// has -- this only exists so a *different* agency standing up their own
// deployment can rebrand the letterhead/emails/topbar text via env vars
// instead of editing HTML in eight different files. The logo image itself
// is not included here: it's a real asset (a base64 PNG baked into each
// page), and swapping that safely belongs with a proper asset-upload story
// this pilot doesn't have yet, not a one-line env var.
export const BRANDING = {
  orgName: process.env.BRAND_ORG_NAME || 'ICT Authority',
  productName: process.env.BRAND_PRODUCT_NAME || 'Event Attendance',
  addressLines: (process.env.BRAND_ADDRESS_LINES || 'Teleposta Towers 12th Floor, Kenyatta Ave\nPO Box 27150 - 00100 Nairobi Kenya')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean),
  phone: process.env.BRAND_PHONE || '+254 20 2089061',
  website: process.env.BRAND_WEBSITE || 'https://www.icta.go.ke'
};
