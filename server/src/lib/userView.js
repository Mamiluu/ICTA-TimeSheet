// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// What the browser is told about a signed-in account: who they are, their role,
// and the department they belong to. Never a password hash or a token. Used by
// login and /me so both always agree.
export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    county: u.county,
    department: u.department ? { id: u.department.id, name: u.department.name } : null
  };
}

// An account in a paused department can no longer sign in or keep a session,
// even though the account itself is still active.
export function departmentPaused(u) {
  return !!(u.department && u.department.active === false);
}
