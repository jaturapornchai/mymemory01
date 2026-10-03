// Regressions pinned by the 2026-10-03 quality review: timeWindow on identifiers, huge numbers, Thai non-months; loei context;
// fact+evidence budgets; keyword-only time-only questions. DB part: throwaway per-pid schema, like integration.test.ts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCHEMA = `memhub_test_${process.pid}`;
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
const { connect, ROOT } = await import('../src/db.ts');
const { indexFile } = await import('../src/importer.ts');
const { search, refreshTermDf, timeWindow } = await import('../src/search.ts');
const { queryTerms } = await import('../src/thai.ts');
const { searchText } = await import('../src/mcp.ts');

const keys = (q: string) => queryTerms(q).map((t) => t.key);
const NOW = new Date('2026-10-03T12:00:00Z');

// ---- pure: timeWindow ----

test('code identifiers that contain a time word keep their terms (no substring strip, no spurious window)', () => {
  // real term_df identifiers: calculatestatement 11 docs, latest_buy_impulse 41, posttoday 4, check_today_moons.py 3
  for (const [q, id] of [['calculateStatement', 'calculatestatement'], ['translateString', 'translatestring'], ['latest_buy_impulse', 'latest_buy_impulse'],
    ['posttoday', 'posttoday'], ['getLatestVersion', 'getlatestversion'], ['todayStr', 'todaystr']] as const) {
    const t = timeWindow(q, NOW);
    assert.ok(keys(t.rest).includes(id), `${q} → rest ${JSON.stringify(t.rest)} → ${keys(t.rest).join(',')}`);
    assert.ok(!t.from && !t.recent, `${q} must not set a time window / recency boost`);
  }
});

test('a huge "N units ago" never yields an Invalid Date (pg rejects it → memory_search errors)', () => {
  for (const q of ['99999999999 days ago', '300000 ปีก่อน', '9999999999999 เดือนก่อน']) {
    const t = timeWindow(q, NOW);
    for (const x of [t.from, t.to]) assert.ok(x === undefined || !Number.isNaN(x.getTime()), `${q}: ${x}`);
  }
});

test('ordinary Thai words are not month names (soft boost of the wrong month)', () => {
  assert.equal(timeWindow('ศาลตุลาการ', NOW).from, undefined, 'ตุลาการ = judiciary, not ตุลาคม');
  assert.equal(timeWindow('สำนักงาน ก.พ. ประกาศผลสอบ', NOW).from, undefined, 'ก.พ. alone = the civil service office');
  assert.equal(timeWindow('ประชุม 15 ก.พ. 2569', NOW).from?.toISOString(), '2026-01-31T17:00:00.000Z', 'ก.พ. next to a day number = February');
});

// ---- pure: MCP text budget ----

test('full mode with fact+evidence hits stays within 400 chars × n (rank budgets "same total")', () => {
  const base = { turn_uuid: 'u', header: 'h', score: 1, uses: 0, last: null, status: null, fid: null, kind: null, fact_project: null,
    superseded_by: null, review_target: null, changed_to: null, src_kind: 'main', tool: 'claude', ev_of: null, project: 'd:/demo', session_id: 's1' };
  const ts = new Date('2026-09-20T10:00:00Z');
  const hits: any[] = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ ...base, id: `f${i}`.padEnd(16, '0'), ts, fid: `F0000000${i}`, kind: 'decision',
    text: `D: # F0000000${i} t\nbudgetterm decision ${'fact text words '.repeat(40)}`,
    evidence: [{ ...base, id: `c${i}`.padEnd(16, '0'), ts, text: `U: budgetterm ${'filler words here '.repeat(60)}`, changed_to: ['Faaaaaaa1', 'Fbbbbbbb2', 'Fccccccc3'] }] }));
  const bodies = searchText(hits, 'budgetterm', true).split('\n\n').map((r) => r.length - r.split('\n')[0].length - 1);
  const total = bodies.reduce((a, b) => a + b, 0);
  assert.ok(total <= 8 * 402, `bodies ${bodies.join(',')} = ${total} > ${8 * 402} (base: 8 × 401)`);
});

// ---- DB: keyword-only search (the "embedder busy" path) ----

const db = connect('rw');
const dir = mkdtempSync(join(tmpdir(), 'memhub-review-'));
const file = join(dir, 'proj', 'sess-r.jsonl');
let n = 0;
const line = (type: 'user' | 'assistant', text: string, ts: string) =>
  JSON.stringify({ type, uuid: `r${++n}`, parentUuid: n > 1 ? `r${n - 1}` : null, sessionId: 'sess-r', timestamp: ts, cwd: 'D:\\demo',
    message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] } }) + '\n';
const BEFORE = new Date('2026-09-20T12:00:00Z'); // "now" of the search; Bangkok yesterday = 2026-09-18T17:00Z .. 2026-09-19T17:00Z

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  mkdirSync(join(dir, 'proj'), { recursive: true });
  writeFileSync(file,
    line('user', 'เมื่อวานแก้ calculateStatement ใน ledger ให้ปัดเศษถูกแล้ว', '2026-09-12T05:00:00Z') +
    line('assistant', 'แก้ calculateStatement แล้ว rounding half-even ผ่าน test ครบ', '2026-09-12T05:01:00Z') +
    line('user', 'last time we pinned the image to node:22-alpine because latest broke the build', '2026-09-10T05:00:00Z') +
    line('assistant', 'ok pinned ล่าสุดใช้ node:22-alpine', '2026-09-10T05:01:00Z') +
    // newer distractors: share only the "calcu" prefix the merged strip leaves behind
    [11, 12, 13, 14, 15].map((d) => line('user', `calculate the VAT total for invoice ${d}`, `2026-09-${d + 4}T05:00:00Z`) +
      line('assistant', `calculation done for invoice ${d}`, `2026-09-${d + 4}T05:01:00Z`)).join(''));
  assert.equal(await indexFile(db, file), 'indexed');
  await refreshTermDf(db);
});

after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(dir, { recursive: true, force: true });
});

const kw = (q: string) => search(db, q, { semantic: false, before: BEFORE, limit: 6 });

test('keyword-only: a relative-time-only question still finds something', async () => {
  for (const q of ['เมื่อวานทำอะไร', 'last time', 'ล่าสุดทำอะไร']) assert.ok((await kw(q)).hits.length > 0, q);
});

test('keyword-only: a code identifier containing "late"+"St" is still found by name', async () => {
  const r = await search(db, 'calculateStatement', { semantic: false, before: BEFORE, limit: 2, perSession: 9 });
  assert.match(r.hits[0]?.text ?? '', /calculateStatement/, r.hits.map((h) => h.text.slice(0, 60)).join(' | ') || 'no hits');
});

test('a huge relative number does not make memory_search throw', async () => {
  await assert.doesNotReject(kw('99999999999 days ago'));
});
