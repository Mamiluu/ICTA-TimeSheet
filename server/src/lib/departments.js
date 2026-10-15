// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

// Departments the platform admin can load in one click. The first one already
// exists from the migration that introduced departments; the rest are added
// idempotently by name, so running the seed twice changes nothing.
export const DEFAULT_DEPARTMENTS = [
  'Innovation & Incubation',
  'Information Security',
  'ICT Infrastructure',
  'Supply Chain Management',
  'Finance & Accounting',
  'Internal Audit',
  'Legal Services',
  'Planning, Monitoring & Evaluation',
  'Human Resources & Administration',
  'Programme Management Office'
];

export const MAX_SUPER_ADMINS_PER_DEPARTMENT = 3;

export function departmentSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

// Returns a trimmed single-spaced name, or null when it isn't usable.
export function cleanDepartmentName(raw) {
  const name = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length < 3 || name.length > 80) return null;
  if (!departmentSlug(name)) return null;
  return name;
}
