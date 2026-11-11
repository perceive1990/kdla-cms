'use strict';
// Reads attendance registers (Word .docx tables or CSV) into rows of people. Columns are recognised by
// what they hold rather than by their headings, because registers are typed in many layouts: a cell like
// 123456/78/1 is an NRC, M or F the sex, a 10-digit number the phone, the cell after the sex the village or
// area (the "Organization/Community" column), and yes/no whether the person was present.
const zlib = require('node:zlib');

/** The files inside a .docx (a zip archive), read from its central directory. */
function unzip(buf, wanted) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wanted} not found`);
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Every table row of a Word document, as arrays of cell texts. */
function docxRows(buf) {
  const xml = unzip(buf, 'word/document.xml').toString('utf8');
  const rows = [];
  for (const tr of xml.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || []) {
    const cells = (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map((tc) => decode((tc.match(/<w:t(?: [^>]*)?>[^<]*<\/w:t>/g) || [])
      .map((t) => t.replace(/<[^>]+>/g, '')).join('')).replace(/\s+/g, ' ').trim());
    rows.push(cells);
  }
  return rows;
}

/** Rows of a CSV, tab or semicolon separated file. */
function csvRows(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const first = clean.split(/\r?\n/)[0] || '';
  const sep = [',', '\t', ';'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = [];
  let row = []; let cell = ''; let q = false;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (q) {
      if (ch === '"' && clean[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell.trim()); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i += 1;
      row.push(cell.trim()); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c));
}

const NRC = /^\d{5,7}\/\d{2,3}\/\d[^\d]?$/;
const PHONE = /^\+?\d[\d ]{8,14}$/;
const SEX = { m: 'M', male: 'M', f: 'F', female: 'F' };
const HEADER = /^(s\/?n|no\.?|full ?name|name|nrc|sex|gender|organi[sz]ation.*|community|present|yes|no|phone.*|sign.*)$/i;
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const titleCase = (s) => tidy(s).toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());

/** People from register rows: name, NRC, sex, village or area, phone and whether present. */
function peopleFrom(rows) {
  const out = [];
  for (const raw of rows) {
    const cells = raw.map(tidy);
    // Merged cells repeat their text; keep one copy.
    const vals = cells.filter((c, i) => !(i > 0 && c && c === cells[i - 1]));
    const name = vals.find((c) => /\p{L}{2,}/u.test(c) && !HEADER.test(c) && !SEX[c.toLowerCase()] && !/^(yes|no)$/i.test(c));
    if (!name) continue;
    const at = vals.indexOf(name);
    const rest = vals.slice(at + 1);
    const sexAt = rest.findIndex((c) => SEX[c.toLowerCase()]);
    const sex = sexAt >= 0 ? SEX[rest[sexAt].toLowerCase()] : '';
    let area = '';
    if (sexAt >= 0 && rest[sexAt + 1] && !/^(yes|no)$/i.test(rest[sexAt + 1]) && !PHONE.test(rest[sexAt + 1])) area = rest[sexAt + 1];
    const nrcRaw = rest.find((c) => c.includes('/')) || '';
    const phone = (rest.find((c) => PHONE.test(c) && !c.includes('/')) || '').replace(/\s/g, '');
    const presentCell = rest.find((c) => /^(yes|no|y|n|✓|x)$/i.test(c)) || '';
    const serial = vals.slice(0, at).find((c) => /^\d+$/.test(c)) || '';
    out.push({
      serial, fullName: titleCase(name), nrcRaw: nrcRaw.replace(/\s/g, ''), sex, area: titleCase(area), phone, absent: /^(no|n|x)$/i.test(presentCell),
    });
  }
  return out;
}

/** Splits a full name: the first word is the first name, the rest the last name. */
function splitName(full) {
  const parts = tidy(full).split(' ');
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function readRegister(file) {
  const isDocx = /\.docx$/i.test(file.originalname || '') || (file.buffer[0] === 0x50 && file.buffer[1] === 0x4b);
  return peopleFrom(isDocx ? docxRows(file.buffer) : csvRows(file.buffer.toString('utf8')));
}

module.exports = {
  docxRows, csvRows, peopleFrom, splitName, readRegister, NRC,
};
