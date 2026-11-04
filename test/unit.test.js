'use strict';
process.env.SESSION_SECRET = 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const { toSql, matches } = require('../src/db/query');
const totp = require('../src/totp');
const { isRealDate, daysBetween } = require('../src/helpers');
const { nameKey } = require('../src/conflicts');
const { ageCategoryProblem, normaliseNrc } = require('../src/people-core');
const { caseFilter, canSeeCase, visibleWhere } = require('../src/access');

test('Cosmos SQL: parameters, OR/AND groups and the confidential filter', () => {
  const q = toSql({
    where: visibleWhere({ id: 'u1', role: 'officer' }, { status: { $in: ['Open Active Case'] } }),
    search: { term: 'mary', fields: ['heading'] }, orderBy: ['updatedAt', 'DESC'], offset: 25, limit: 25,
  });
  assert.strictEqual(q.query, 'SELECT * FROM c WHERE (ARRAY_CONTAINS(@p0, c.status)) AND ((((NOT IS_DEFINED(c.restricted) OR IS_NULL(c.restricted) OR c.restricted = false)) OR (c.officerId = @p1) OR (ARRAY_CONTAINS(c.teamIds, @p2)))) AND (CONTAINS(ToString(c.heading), @p3, true)) ORDER BY c.updatedAt DESC OFFSET 25 LIMIT 25');
  let depth = 0;
  for (const ch of q.query) { depth += ch === '(' ? 1 : ch === ')' ? -1 : 0; assert.ok(depth >= 0); }
  assert.strictEqual(depth, 0, 'brackets balance');
  assert.deepStrictEqual(q.parameters.map((p) => p.value), [['Open Active Case'], 'u1', 'u1', 'mary']);
  assert.strictEqual(toSql({ where: { id: { $in: [] } } }, { count: true }).query, 'SELECT VALUE COUNT(1) FROM c WHERE false');
  assert.throws(() => toSql({ where: { value: 1 } }), /reserved word/);
  assert.throws(() => toSql({ where: { 'x; DROP': 1 } }), /Invalid field/);
  assert.deepStrictEqual(caseFilter({ id: 'a', role: 'admin' }), {});
});

test('In-memory matching mirrors Cosmos semantics', () => {
  const doc = { status: 'Open', restricted: false, teamIds: ['u2'], officerId: 'u9' };
  const officer = { id: 'u2', role: 'officer' };
  assert.ok(matches({ ...doc, restricted: true }, { where: caseFilter(officer) }), 'team member sees confidential case');
  assert.ok(!matches({ ...doc, restricted: true, teamIds: [] }, { where: caseFilter(officer) }), 'others do not');
  assert.ok(matches({ status: 'Open' }, { where: caseFilter(officer) }), 'missing flag counts as not confidential');
  assert.ok(canSeeCase(officer, { restricted: true, teamIds: ['u2'] }));
  assert.ok(!canSeeCase(officer, { restricted: true, officerId: 'x' }));
  assert.ok(!matches({ a: undefined }, { where: { a: { $ne: 'x' } } }), '$ne excludes missing fields, as in Cosmos');
});

test('TOTP matches RFC 6238 test vectors', () => {
  const key = Buffer.from('12345678901234567890');
  assert.strictEqual(totp.hotp(key, Math.floor(59 / 30), 8), '94287082');
  assert.strictEqual(totp.hotp(key, Math.floor(1111111109 / 30), 8), '07081804');
  assert.strictEqual(totp.hotp(key, Math.floor(20000000000 / 30), 8), '65353130');
  const secret = totp.generateSecret();
  const step = totp.currentStep();
  const code = totp.hotp(totp.base32Decode(secret), step);
  assert.strictEqual(totp.verify(secret, code), step);
  assert.strictEqual(totp.verify(secret, code, { lastStep: step }), null, 'a code cannot be reused');
});

test('dates, names, NRC and age categories', () => {
  assert.ok(isRealDate('2028-02-29'));
  assert.ok(!isRealDate('2026-02-29'));
  assert.ok(!isRealDate('29/02/2028'));
  assert.strictEqual(daysBetween('2026-01-01', '2026-12-31'), 364);
  assert.strictEqual(nameKey('  Mwíla ', 'BANDA-Phiri'), 'mwila banda phiri');
  assert.strictEqual(normaliseNrc('123456 78 1'), '123456/78/1');
  assert.strictEqual(normaliseNrc('123456781'), '123456/78/1');
  assert.ok(ageCategoryProblem(30, 'Boy'));
  assert.ok(ageCategoryProblem(12, 'Woman'));
  assert.strictEqual(ageCategoryProblem(17, 'Girl'), null);
  assert.strictEqual(ageCategoryProblem(null, 'Man'), null);
});

test('formatted report text keeps safe formatting and removes anything else', () => {
  const rich = require('../src/richtext');
  const dirty = '<p>Hello <script>alert(1)</script><span class="ql-size-large evil" onclick="steal()">big</span> '
    + '<a href="javascript:alert(1)">bad</a> <a href="https://kdla.example">good</a><img src="x" onerror="y"></p><ol><li data-list="bullet">one</li></ol>';
  const clean = rich.clean(dirty);
  assert.ok(!/script|onclick|onerror|javascript:|<img|evil/.test(clean), clean);
  assert.match(clean, /class="ql-size-large"/);
  assert.match(clean, /<li data-list="bullet">one<\/li>/);
  assert.match(clean, /href="https:\/\/kdla\.example" rel="noopener noreferrer" target="_blank"/);
  assert.strictEqual(rich.clean('<p><br></p>'), '', 'an empty editor counts as empty');
  assert.strictEqual(rich.clean('Plain text <b>stays</b> text'), 'Plain text <b>stays</b> text');
  assert.strictEqual(rich.toHtml('Line one\nline two\n\nNext <para>'), '<p>Line one<br>line two</p><p>Next &lt;para&gt;</p>');
  assert.strictEqual(rich.toText('<p>A &amp; B</p><ul><li data-list="bullet">x</li></ul>'), 'A & B\nx');
});

test('chart helpers escape labels and count by month', () => {
  const charts = require('../src/charts');
  const svg = charts.hbars([{ label: '<b>x</b>', count: 3 }, { label: 'y', count: 0 }], { title: 't' });
  assert.ok(svg.includes('&lt;b&gt;x&lt;/b&gt;') && !svg.includes('<b>'));
  const m = charts.monthly(['2026-01-05', '2026-01-20', '2026-03-01', '2025-12-31'], '2026-01-01', '2026-03-31');
  assert.deepStrictEqual(m.map((x) => x.count), [2, 0, 1]);
  assert.match(charts.meter(150), /100%/);
});

test('switching on Blob storage keeps earlier files readable and copies them across', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { Writable } = require('stream');
  const { DiskStorage, BlobStorage } = require('../src/storage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdla-blob-'));
  const disk = new DiskStorage(dir);
  const oldKey = await disk.save({ originalname: 'old photo.jpg', buffer: Buffer.from('OLD') });

  // A small stand-in for an Azure Blob container
  const blobs = new Map();
  const client = (key) => ({
    exists: async () => blobs.has(key),
    uploadData: async (buf) => { blobs.set(key, Buffer.from(buf)); },
    deleteIfExists: async () => { blobs.delete(key); },
    download: async () => ({ readableStreamBody: require('stream').Readable.from([blobs.get(key)]) }),
  });
  const container = { createIfNotExists: async () => {}, getBlobClient: client, getBlockBlobClient: client };
  const blob = new BlobStorage('', '', { container, diskDir: dir });
  const read = async (key) => {
    const chunks = [];
    const sink = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
    const found = await blob.stream(key, sink);
    return found ? Buffer.concat(chunks).toString() : null;
  };

  assert.strictEqual(await read(oldKey), 'OLD', 'old files are served from the disk before they are copied');
  const newKey = await blob.save({ originalname: 'new.pdf', buffer: Buffer.from('NEW'), mimetype: 'application/pdf' });
  assert.ok(blobs.has(newKey));
  assert.strictEqual(fs.existsSync(path.join(dir, newKey)), false, 'new uploads go only to Blob storage');
  assert.strictEqual(await blob.copyFromDisk(), 1);
  assert.strictEqual(await blob.copyFromDisk(), 0, 'copying again does nothing');
  assert.strictEqual(blobs.get(oldKey).toString(), 'OLD');
  await blob.remove(oldKey);
  assert.strictEqual(await read(oldKey), null, 'deleting removes both copies');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('work plans: activity dates move with the start of the plan', () => {
  const { moveItems } = require('../src/services/workplans');
  const items = [
    { id: 'a', startDate: '2027-01-15', endDate: '2027-01-20' },
    { id: 'b', startDate: '2027-03-25', endDate: '2027-03-31' },
    { id: 'c', startDate: '', endDate: '' },
  ];
  // A quarter later: whole months, the 31st becomes the last day of June
  const q2 = moveItems(items, { periodStart: '2027-01-01' }, { periodStart: '2027-04-01', periodEnd: '2027-06-30' });
  assert.deepStrictEqual(q2.map((it) => [it.startDate, it.endDate]), [['2027-04-15', '2027-04-20'], ['2027-06-25', '2027-06-30'], ['', '']]);
  // A year later, into a leap year
  const leap = moveItems([{ startDate: '2027-02-28', endDate: '2027-03-01' }], { periodStart: '2027-01-01' }, { periodStart: '2028-01-01', periodEnd: '2028-12-31' });
  assert.deepStrictEqual([leap[0].startDate, leap[0].endDate], ['2028-02-28', '2028-03-01']);
  // October to January keeps the last days of the quarter
  const q1 = moveItems([{ startDate: '2026-12-30', endDate: '2026-12-31' }], { periodStart: '2026-10-01' }, { periodStart: '2027-01-01', periodEnd: '2027-03-31' });
  assert.deepStrictEqual([q1[0].startDate, q1[0].endDate], ['2027-03-30', '2027-03-31']);
  // A shorter period: dates that would fall after it end on its last day
  const short = moveItems([{ startDate: '2027-03-15', endDate: '2027-03-31' }], { periodStart: '2027-01-01' }, { periodStart: '2027-02-01', periodEnd: '2027-03-31' });
  assert.deepStrictEqual([short[0].startDate, short[0].endDate], ['2027-03-31', '2027-03-31']);
  // Starts on different days of the month: moved by days
  const days = moveItems([{ startDate: '2027-01-10', endDate: '2027-01-12' }], { periodStart: '2027-01-01' }, { periodStart: '2027-01-08', periodEnd: '2027-12-31' });
  assert.deepStrictEqual([days[0].startDate, days[0].endDate], ['2027-01-17', '2027-01-19']);
  // Backwards by three months
  const back = moveItems([{ startDate: '2027-04-01', endDate: '2027-04-02' }], { periodStart: '2027-04-01' }, { periodStart: '2027-01-01', periodEnd: '2027-03-31' });
  assert.deepStrictEqual([back[0].startDate, back[0].endDate], ['2027-01-01', '2027-01-02']);
});

test('M&E: spreadsheet rows, numbering and indicator status', () => {
  const lf = require('../src/services/logframes');
  // Excel copy and paste (tabs), quotes with commas and line breaks, semicolon files
  assert.deepStrictEqual(lf.parseRows('Output\t1.1\tReach "1,500"\n'), [['Output', '1.1', 'Reach "1,500"']]);
  assert.deepStrictEqual(lf.parseRows('﻿Output,,"Reach 1,500 people,\nincluding ""youth"""\r\n'), [['Output', '', 'Reach 1,500 people,\nincluding "youth"']]);
  assert.deepStrictEqual(lf.parseRows('Output;1.1;Text\n'), [['Output', '1.1', 'Text']]);
  const p = lf.parseOutline('Level,Code,Text,Unit,Baseline,Target\nGoal,,G\nOutcome,,O\nOutput,,X\nIndicator,,Share,%,,"60%"\nActivity,,A\nOutput,,Y\nActivity,,B\nOutcome,,P\nActivity,,Lost');
  assert.deepStrictEqual(Object.values(p.errors), ['Row 10: put this activity under an output.'], 'an activity cannot attach to the output of an earlier outcome');
  assert.deepStrictEqual(p.indicators.map((i) => [i.unit, i.baseline, i.target]), [['percent', null, 60]]);
  const fw = { id: 'f', results: p.results, indicators: [] };
  const codes = lf.codes(fw);
  assert.deepStrictEqual(lf.ordered(fw).map((r) => codes[r.id]), ['', '1', '1.1', '1.1.1', '1.2', '1.2.1', '2']);
  // Status: counts against the time gone, shares against their target, decreasing indicators too
  assert.strictEqual(lf.judge({ target: 100, baseline: 0, unit: 'number' }, 30, 30).status, 'On track');
  assert.strictEqual(lf.judge({ target: 100, baseline: 0, unit: 'number' }, 15, 30).status, 'Behind');
  assert.strictEqual(lf.judge({ target: 100, baseline: 0, unit: 'number' }, 120, 30).status, 'Achieved');
  assert.strictEqual(lf.judge({ target: 60, baseline: 0, unit: 'percent' }, 59, 90).status, 'Below target');
  assert.deepStrictEqual(lf.judge({ target: 10, baseline: 50, unit: 'number' }, 30, 50), { pct: 50, status: 'On track' }, 'reducing from 50 to 10');
  assert.strictEqual(lf.judge({ target: 5, baseline: 0 }, null, 10).status, 'No data');
  assert.strictEqual(lf.timeElapsed({ startDate: '2026-01-01', endDate: '2026-12-31' }, '2026-07-02'), 50);
  assert.strictEqual(lf.timeElapsed({ startDate: '2027-01-01', endDate: '2027-12-31' }, '2026-07-02'), 0);
  assert.strictEqual(lf.timeElapsed({}, '2026-07-02'), null);
});
