// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// "Eric Chepkwony" -> "E*** C*********". Enough for a person to recognise
// their own name, not enough for a stranger who typed someone else's phone
// number to learn who it belongs to. The star count is fixed per word so the
// real length isn't leaked either.
export function maskName(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => [...w][0] + '***')
    .join(' ');
}
