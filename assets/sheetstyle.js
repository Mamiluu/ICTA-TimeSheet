// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.
//
// How an organisation has chosen to lay out its printed sheets: where the logo and the
// address sit, how big the logo is, and the font and text size. The server stores a short
// key for each choice (see lib/brandInput.js); this file turns the keys into real CSS, so
// nothing an administrator types ever reaches a stylesheet.
var SHEET_FONTS = [
  { key: 'ARIAL', label: 'Arial', css: 'Arial, Helvetica, sans-serif' },
  { key: 'CALIBRI', label: 'Calibri', css: 'Calibri, Carlito, "Segoe UI", Arial, sans-serif' },
  { key: 'TAHOMA', label: 'Tahoma', css: 'Tahoma, "Segoe UI", Arial, sans-serif' },
  { key: 'VERDANA', label: 'Verdana', css: 'Verdana, Geneva, sans-serif' },
  { key: 'TREBUCHET', label: 'Trebuchet MS', css: '"Trebuchet MS", Tahoma, Arial, sans-serif' },
  { key: 'TIMES', label: 'Times New Roman', css: '"Times New Roman", Times, "Liberation Serif", serif' },
  { key: 'GEORGIA', label: 'Georgia', css: 'Georgia, "Times New Roman", serif' },
  { key: 'COURIER', label: 'Courier New', css: '"Courier New", Courier, monospace' }
];
var SHEET_TEXT_SCALE = { SMALL: 0.9, MEDIUM: 1, LARGE: 1.15 };
var SHEET_LOGO_SCALE = { SMALL: 0.75, MEDIUM: 1, LARGE: 1.4 };
var SHEET_DEFAULT = { logoAlign: 'RIGHT', addressAlign: 'LEFT', logoSize: 'MEDIUM', font: 'ARIAL', fontSize: 'MEDIUM' };

// The organisation's choices with anything missing or unknown replaced by the default.
function sheetStyle(s){
  s = s || {};
  var align = ['LEFT', 'CENTER', 'RIGHT'];
  var size = ['SMALL', 'MEDIUM', 'LARGE'];
  var font = SHEET_FONTS.filter(function(f){ return f.key === s.font; })[0] || SHEET_FONTS[0];
  return {
    logoAlign: align.indexOf(s.logoAlign) > -1 ? s.logoAlign : SHEET_DEFAULT.logoAlign,
    addressAlign: align.indexOf(s.addressAlign) > -1 ? s.addressAlign : SHEET_DEFAULT.addressAlign,
    logoSize: size.indexOf(s.logoSize) > -1 ? s.logoSize : SHEET_DEFAULT.logoSize,
    fontKey: font.key,
    fontCss: font.css,
    fontSize: size.indexOf(s.fontSize) > -1 ? s.fontSize : SHEET_DEFAULT.fontSize,
    textScale: SHEET_TEXT_SCALE[size.indexOf(s.fontSize) > -1 ? s.fontSize : 'MEDIUM'],
    logoScale: SHEET_LOGO_SCALE[size.indexOf(s.logoSize) > -1 ? s.logoSize : 'MEDIUM']
  };
}

// Puts the font and sizes on an element as CSS variables that the page's own CSS reads.
function applySheetVars(el, style){
  if(!el) return;
  el.style.setProperty('--sfont', style.fontCss);
  el.style.setProperty('--sfs', String(style.textScale));
  el.style.setProperty('--lsc', String(style.logoScale));
}

// Lays the two parts of a letterhead (the address block and the logo) out on a grid with a
// left, a middle and a right zone. Each part goes in the zone its alignment names. When both
// choose the same zone they stack, logo first, and the text lines up to that side.
function layoutLetterhead(box, addr, logo, style){
  if(!box || !addr || !logo) return;
  var col = { LEFT: 1, CENTER: 2, RIGHT: 3 };
  var just = { LEFT: 'start', CENTER: 'center', RIGHT: 'end' };
  var txt = { LEFT: 'left', CENTER: 'center', RIGHT: 'right' };
  box.style.display = 'grid';
  box.style.gridTemplateColumns = 'minmax(0,1fr) auto minmax(0,1fr)';
  box.style.columnGap = '16px';
  box.style.rowGap = '8px';
  box.style.alignItems = 'start';
  var same = style.logoAlign === style.addressAlign;
  logo.style.gridColumn = String(col[style.logoAlign]);
  logo.style.gridRow = '1';
  logo.style.justifySelf = just[style.logoAlign];
  logo.style.textAlign = txt[style.logoAlign];
  addr.style.gridColumn = String(col[style.addressAlign]);
  addr.style.gridRow = same ? '2' : '1';
  addr.style.justifySelf = just[style.addressAlign];
  addr.style.textAlign = txt[style.addressAlign];
}
