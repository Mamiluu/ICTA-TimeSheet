// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskName } from '../src/lib/mask.js';

test('maskName keeps only each word\'s first letter and a fixed star count', () => {
  assert.equal(maskName('Eric Chepkwony'), 'E*** C***');
  assert.equal(maskName('  Arch  Arenah Musyimi '), 'A*** A*** M***');
  assert.equal(maskName(''), '');
});
