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
