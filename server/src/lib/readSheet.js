// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.
//
// Reads the first sheet of an .xlsx (or a .csv) into an array of
// { header: value } objects, with no third-party package. An .xlsx is a zip of
// XML files, so this walks the zip's central directory, inflates the three
// parts that matter (workbook rels, shared strings, the first worksheet) and
// reads cells from them. Deliberately small: values are returned as strings, or
// as a Date for cells whose style is a date format, which is all the importers
// need. The heavier `xlsx` package was left out on purpose -- its npm release is
// unmaintained and has known advisories, and this runs against live data.

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

// ---- zip ------------------------------------------------------------------

function readZip(buf) {
  // End-of-central-directory record: last 22+ bytes, signature 0x06054b50.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no zip directory found).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip directory.');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => files.has(name),
    text(name) {
      const f = files.get(name);
      if (!f) return null;
      const lo = f.localOffset;
      const dataStart = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
      const raw = buf.subarray(dataStart, dataStart + f.compSize);
      // The file may be an upload from a stranger: cap what a part can inflate to, so a tiny zip that
      // expands to gigabytes (a "zip bomb") fails instead of eating the server's memory.
      const out = f.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: 30 * 1024 * 1024 });
      return out.toString('utf8');
    }
  };
}

// ---- xml helpers ----------------------------------------------------------

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

// Concatenated text of every <t> inside a fragment (rich-text cells split text over several runs).
function textOf(fragment) {
  let out = '';
  for (const m of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1];
  return unescapeXml(out);
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : null;
}

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Which cell styles (cellXfs index) are dates. Built-in date formats are 14-22 and 45-47; custom ones
// are recognised by the format code containing day/month/year/hour tokens outside quotes.
function dateStyles(stylesXml) {
  const set = new Set();
  if (!stylesXml) return set;
  const custom = new Map();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*>/g)) {
    custom.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') || '');
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!cellXfs) return set;
  let i = 0;
  for (const m of cellXfs[1].matchAll(/<xf\b[^>]*?(?:\/>|>)/g)) {
    const id = Number(attr(m[0], 'numFmtId') || 0);
    const code = custom.get(id);
    const builtIn = (id >= 14 && id <= 22) || (id >= 45 && id <= 47);
    const custom_ = code ? /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')) : false;
    if (builtIn || custom_) set.add(i);
    i++;
  }
  return set;
}

// Excel serial (days since 1899-12-30) -> a Date whose *wall-clock* fields equal the sheet's. The sheet
// carries no timezone, so the caller decides which zone those fields are in.
function serialToParts(serial) {
  const ms = Math.round(serial * 86400000);
  return new Date(Date.UTC(1899, 11, 30) + ms);
}

// ---- xlsx -----------------------------------------------------------------

function readXlsx(buf) {
  const zip = readZip(buf);
  const wbXml = zip.text('xl/workbook.xml');
  if (!wbXml) throw new Error('Not a valid .xlsx file (no workbook).');
  const firstSheet = /<sheet\b[^>]*>/.exec(wbXml)?.[0];
  const rid = firstSheet && attr(firstSheet, 'r:id');
  let sheetPath = 'xl/worksheets/sheet1.xml';
  if (rid) {
    const rels = zip.text('xl/_rels/workbook.xml.rels') || '';
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (attr(m[0], 'Id') === rid) {
        const target = attr(m[0], 'Target');
        sheetPath = target.startsWith('/') ? target.slice(1) : path.posix.join('xl', target);
      }
    }
  }
  const sheetXml = zip.text(sheetPath);
  if (!sheetXml) throw new Error(`Worksheet ${sheetPath} not found in the file.`);

  const shared = [];
  const ssXml = zip.text('xl/sharedStrings.xml');
  if (ssXml) for (const m of ssXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));

  const dates = dateStyles(zip.text('xl/styles.xml'));
  const grid = [];
  for (const rowM of sheetXml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (!rowM[1]) continue;
    const row = [];
    for (const cM of rowM[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = cM[1];
      const ref = attr(tag, 'r');
      if (!ref) continue;
      const type = attr(tag, 't');
      const style = Number(attr(tag, 's') || 0);
      const body = cM[2] || '';
      let value = '';
      if (type === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = v ? shared[Number(v[1])] ?? '' : '';
      } else if (type === 'inlineStr') {
        value = textOf(body);
      } else if (type === 'str' || type === 'e') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = v ? unescapeXml(v[1]) : '';
      } else if (type === 'b') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = v ? (v[1] === '1' ? 'TRUE' : 'FALSE') : '';
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        if (v) value = dates.has(style) ? serialToParts(Number(v[1])) : v[1];
      }
      row[colIndex(ref)] = value;
    }
    grid.push(row);
  }
  return grid;
}

// ---- csv ------------------------------------------------------------------

function readCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

// ---- public ---------------------------------------------------------------

// Returns { headers: string[], rows: [{ rowNum, values: {header: value} }] }. rowNum is the 1-based row
// in the original sheet, so a report can point at the exact line a person would see in Excel.
export function readSheet(filePath) {
  return readSheetBuffer(readFileSync(filePath), path.extname(filePath));
}

// Same, from bytes already in memory (an upload). `ext` is ".xlsx" or ".csv".
export function readSheetBuffer(buf, ext) {
  ext = String(ext || '').toLowerCase();
  const grid = ext === '.csv' ? readCsv(buf.toString('utf8')) : readXlsx(buf);
  const headerIdx = grid.findIndex((r) => r && r.some((c) => String(c ?? '').trim() !== ''));
  if (headerIdx < 0) return { headers: [], rows: [] };
  const headers = (grid[headerIdx] || []).map((h) => String(h ?? '').trim());
  const rows = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const cells = grid[i] || [];
    if (!cells.some((c) => String(c ?? '').trim() !== '')) continue;
    const values = {};
    headers.forEach((h, c) => {
      if (h) values[h] = cells[c] ?? '';
    });
    rows.push({ rowNum: i + 1, values });
  }
  return { headers, rows };
}
