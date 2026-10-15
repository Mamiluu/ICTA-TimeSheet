// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DEPARTMENTS, cleanDepartmentName, departmentSlug } from '../src/lib/departments.js';

test('slug turns & into and and drops punctuation', () => {
  assert.equal(departmentSlug('Innovation & Incubation'), 'innovation-and-incubation');
  assert.equal(departmentSlug('Planning, Monitoring & Evaluation'), 'planning-monitoring-and-evaluation');
});

test('name is trimmed and single-spaced', () => {
  assert.equal(cleanDepartmentName('  Internal   Audit '), 'Internal Audit');
});

test('unusable names are rejected', () => {
  assert.equal(cleanDepartmentName(''), null);
  assert.equal(cleanDepartmentName('ab'), null);
  assert.equal(cleanDepartmentName('!!!!'), null);
  assert.equal(cleanDepartmentName('x'.repeat(81)), null);
  assert.equal(cleanDepartmentName(undefined), null);
});

test('default departments are unique by name and slug', () => {
  assert.equal(new Set(DEFAULT_DEPARTMENTS.map(departmentSlug)).size, DEFAULT_DEPARTMENTS.length);
});
