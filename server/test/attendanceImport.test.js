// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSheetBuffer } from '../src/lib/readSheet.js';
import { tidyName, initialsFor, initialsSignature, findColumns } from '../src/lib/attendanceImport.js';

test('tidyName fixes all-caps and all-lower names and leaves mixed case alone', () => {
  assert.equal(tidyName('LYDIA OGOT'), 'Lydia Ogot');
  assert.equal(tidyName('Martin  wainaina '), 'Martin Wainaina');
  assert.equal(tidyName('faith jeruto'), 'Faith Jeruto');
  assert.equal(tidyName('Jane McDonald'), 'Jane McDonald');
  assert.equal(tidyName("o'neil mary-ann"), "O'Neil Mary-Ann");
});

test('initialsFor uses every name, capped at three letters', () => {
  assert.equal(initialsFor('Annette Kamau'), 'AK');
  assert.equal(initialsFor('John Daniel Kebati'), 'JDK');
  assert.equal(initialsFor('Mary Jane Wanjiru Kamau'), 'MJK');
  assert.equal(initialsFor('Madonna'), 'MA');
});

test('initialsSignature is an SVG data URI that cannot carry markup', () => {
  const uri = initialsSignature('A<B');
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(uri.split(',')[1], 'base64').toString();
  assert.ok(!svg.includes('<B'));
});

test('findColumns matches headings loosely, in any order', () => {
  const c = findColumns(['Timestamp', 'Phone number', 'Full name ', 'Organization', 'E-mail']);
  assert.equal(c.name, 'Full name ');
  assert.equal(c.phone, 'Phone number');
  assert.equal(c.organisation, 'Organization');
  assert.equal(c.email, 'E-mail');
});

test('readSheetBuffer reads CSV with quotes, commas and blank rows', () => {
  const csv = '﻿Full name,Phone number,Organisation\r\n"Kamau, Annette",0721828831,"Tech ""Minds"""\r\n\r\nJohn,0713645520,\r\n';
  const { headers, rows } = readSheetBuffer(Buffer.from(csv), '.csv');
  assert.deepEqual(headers, ['Full name', 'Phone number', 'Organisation']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].values['Full name'], 'Kamau, Annette');
  assert.equal(rows[0].values.Organisation, 'Tech "Minds"');
  assert.equal(rows[1].rowNum, 4);
});

test('readSheetBuffer rejects something that is not an xlsx', () => {
  assert.throws(() => readSheetBuffer(Buffer.from('this is not a zip file at all, just text'), '.xlsx'));
});
