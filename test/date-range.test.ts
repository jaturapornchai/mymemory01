// since/until date range: validation, a hard filter in every leg (words, bigrams, vector, fact notes), Claude-only sources
// stay hidden, and the vector leg keeps its HNSW index. Own throwaway schema + temp vault per run, no Ollama needed.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-daterange-'));
const SCHEMA = `memhub_daterange_test_${process.pid}`;
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMHUB_MEMORY_VAULT = join(tmp, 'vault');
process.env.MEMHUB_VAULTS = '';
process.env.MEMHUB_NO_REINDEX = '1';
process.env.MEMORY_HUB_INTERNAL = '1';
const { connect, ROOT } = await import('../src/db.ts');
const { indexFile, indexToolFile } = await import('../src/importer.ts');
const { writeNote, md5, MEMORY_VAULT } = await import('../src/notes.ts');
const { indexVault } = await import('../src/obsidian.ts');
const { dateRange, refreshTermDf, search } = await import('../src/search.ts');

const db = connect('rw');
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');
const WORD = 'emuterm';
// one session per moment (no per-session cap); 15th 23:59 and 16th 00:00 Bangkok (UTC+7) straddle until = 2026-09-15
const DAYS = ['2026-09-10T05:00:00Z', '2026-09-15T16:59:00Z', '2026-09-15T17:00:00Z', '2026-09-20T05:00:00Z', '2026-09-25T05:00:00Z'];
const FAKE_VEC = `[${Array(1024).fill(0.03).join(',')}]`;
let privateIds: string[] = [];

async function chat(i: number, ts: string) {
  const id = `dr${i}`, file = join(tmp, 'proj', `${id}.jsonl`);
  const line = (type: string, uuid: string, text: string) => JSON.stringify({ type, uuid, sessionId: id, timestamp: ts, cwd: 'D:\\demo',
    message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] } }) + '\n';
  writeFileSync(file, line('user', `${id}-u`, `${WORD} ยื่น ภ.ง.ด.53 รอบ ${i}`) + line('assistant', `${id}-a`, 'ok'));
  await guard();
  assert.equal(await indexFile(db, file), 'indexed');
}

/** A Claude-only source dated inside every range below (Gmail thread, Maps timeline). */
async function privateSource(tool: string, sessionId: string) {
  const path = join(tmp, `${tool}.json`);
  writeFileSync(path, '{}');
  const parse = async () => ({ sessionId, cwd: 'google', kind: 'doc' as const,
    msgs: [{ uuid: `${sessionId}-1`, parentUuid: null, sessionId, ts: '2026-09-12T05:00:00Z', cwd: 'google', role: 'note' as const, text: `${WORD} ภ.ง.ด.53 private marker` }] });
  await guard();
  assert.equal(await indexToolFile(db, { tool, sync: () => ({}), isTranscript: () => true, parse } as never, path), 'indexed');
}

/** Fact chunk ts = its earliest cited turn, else created_at (obsidian.indexVault), never the file's mtime. */
function fact(fid: string, created: string, uuids: string[]) {
  writeNote(`facts/demo/${fid}.md`, { memhub: 'fact', id: fid, kind: 'fact', scope: 'project', project: 'd:/demo', status: 'active', importance: '5',
    valid_at: created, created_at: created, source_uuids: uuids, md5: md5(fid), run: 'r1' }, `${WORD} fact ${fid}\n`);
}

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  mkdirSync(join(tmp, 'proj'), { recursive: true });
  for (const [i, ts] of DAYS.entries()) await chat(i, ts);
  await privateSource('google', 'gmail:dr');
  await privateSource('google-timeline', 'google-timeline');
  fact('Fe0000001', '2026-09-30T05:00:00Z', ['dr1-u', 'dr3-u']); // dated by dr1 (09-15, in range); its other source chat dr3 (09-20) is not
  fact('Fe0000002', '2026-09-24T05:00:00Z', ['gone-u']); // no cited turn left → created_at, after the range
  await guard();
  await indexVault(db, MEMORY_VAULT);
  await db.query(`UPDATE chunks SET embedding = $1::halfvec`, [FAKE_VEC]); // every chunk equally similar to FAKE_VEC
  await refreshTermDf(db);
  privateIds = (await db.query(`SELECT c.id FROM chunks c JOIN sources s ON s.id = c.source_id WHERE s.tool LIKE 'google%'`)).rows.map((r) => r.id);
  assert.equal(privateIds.length, 2);
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

/** db that records every query, and feeds FAKE_VEC to the vector leg (no Ollama in tests). */
function spy() {
  const calls: { sql: string; params: unknown[]; rows: any[] }[] = [];
  const query = async (sql: string, params: unknown[]) => {
    const p = sql.includes('embedding <=> $10') ? params.map((x, i) => (i === 9 ? FAKE_VEC : x)) : params;
    const r = await db.query(sql, p);
    calls.push({ sql, params: p, rows: r.rows });
    return r;
  };
  return { db: { query } as never, calls };
}
const all = (hits: { ts: Date | null; evidence?: { ts: Date | null }[] }[]) => hits.flatMap((h) => [h, ...(h.evidence ?? [])]);
const inRange = (hits: Parameters<typeof all>[0], from: string, to: string) =>
  all(hits).every((h) => h.ts && h.ts.toISOString() >= from && h.ts.toISOString() < to);
const stamps = (hits: Parameters<typeof all>[0]) => all(hits).map((h) => h.ts?.toISOString()).sort().join(' ');

test('dateRange: ISO dates only, a date-only until covers its whole day, since ≤ until', () => {
  assert.deepEqual(dateRange(undefined, '2026-09-30'), { since: null, until: '2026-10-01T00:00:00+07:00' }); // his day, not the UTC day
  assert.deepEqual(dateRange('2026-09-01', '2026-09-01'), { since: '2026-09-01T00:00:00+07:00', until: '2026-09-02T00:00:00+07:00' });
  assert.deepEqual(dateRange(undefined, '2026-12-31'), { since: null, until: '2027-01-01T00:00:00+07:00' });
  assert.deepEqual(dateRange('2026-09-01T09:30'), { since: '2026-09-01T09:30+07:00', until: null }); // no zone = his clock
  assert.deepEqual(dateRange(undefined, '2026-09-30T12:00:00+07:00'), { since: null, until: '2026-09-30T12:00:00+07:00' }); // an instant: as given
  assert.deepEqual(dateRange('', ''), { since: null, until: null });
  for (const bad of ['yesterday', '2026-02-31', '2026-13-01', '2026/09/01', '2026-09', '2026-09-01T25:00', `2026-09-01${' '.repeat(30)}`]) {
    assert.throws(() => dateRange(undefined, bad), /until must be an ISO date/, bad);
    assert.throws(() => dateRange(bad), /since must be an ISO date/, bad);
  }
  assert.throws(() => dateRange('2026-09-02', '2026-09-01'), /after until/);
});

test('until is a hard filter in the words and bigram legs, inclusive of its whole day', async () => {
  const s = spy();
  const { hits } = await search(s.db, `${WORD} ภงด`, { semantic: false, until: '2026-09-15', limit: 8 });
  assert.equal(stamps(all(hits).filter((h) => !(h as { fid?: string }).fid)), '2026-09-10T05:00:00.000Z 2026-09-15T16:59:00.000Z'); // chats, ↳ included
  const legs = s.calls.find((c) => c.sql.includes("'w' leg"))!.rows;
  assert.ok(legs.some((r) => r.leg === 'b') && legs.some((r) => r.leg === 'w'), 'both keyword legs ran');
  const ts = new Map((await db.query(`SELECT id, ts FROM chunks`)).rows.map((r) => [r.id, r.ts.toISOString()]));
  assert.ok(legs.every((r) => ts.get(r.id)! < '2026-09-15T17'), JSON.stringify(legs));
});

test('until is a hard filter in the vector leg (a query no keyword matches)', async () => {
  const { hits } = await search(spy().db, 'zzqqxxnomatch', { semantic: false, until: '2026-09-15', limit: 8, perSession: 9 });
  assert.ok(hits.length >= 2, 'the vector leg found something');
  assert.ok(inRange(hits, '2000', '2026-09-15T17'), stamps(hits));
  const open = await search(spy().db, 'zzqqxxnomatch', { semantic: false, limit: 8, perSession: 9 });
  assert.ok(!inRange(open.hits, '2000', '2026-09-15T17'), 'without until the later chunks are there');
});

test('since + until = one day; fact notes and their source chats (↳) obey the range too', async () => {
  const day = await search(spy().db, WORD, { semantic: false, since: '2026-09-20', until: '2026-09-20', limit: 8 });
  assert.equal(stamps(day.hits), '2026-09-20T05:00:00.000Z');
  const r = await search(spy().db, WORD, { semantic: false, since: '2026-09-11', until: '2026-09-16', limit: 8 });
  assert.ok(inRange(r.hits, '2026-09-10T17', '2026-09-16T17'), stamps(r.hits));
  assert.deepEqual(r.hits.filter((h) => h.fid).map((h) => h.fid), ['Fe0000001']); // Fe0000002 (09-24) is out
  assert.ok(!all(r.hits).some((h) => h.ts?.toISOString().startsWith('2026-09-20')), 'its source chat dr3 (09-20) is not attached');
});

test('a date range never brings back Claude-only sources (hide filter in every leg); Claude sees them', async () => {
  for (const o of [{ until: '2026-09-15' }, { since: '2026-09-12', until: '2026-09-12' }, { since: '2026-09-01' }]) {
    for (const q of [WORD, 'ภงด', 'zzqqxxnomatch']) {
      const s = spy(), { hits } = await search(s.db, q, { semantic: false, limit: 8, perSession: 9, ...o });
      assert.ok(!all(hits).some((h) => privateIds.includes(h.id)), `${q} ${JSON.stringify(o)}`);
      for (const c of s.calls) assert.ok(!c.rows.some((x) => privateIds.includes(x.id)), `${q} ${JSON.stringify(o)}: a leg returned a private row`);
    }
  }
  const mine = await search(spy().db, WORD, { semantic: false, limit: 8, perSession: 9, until: '2026-09-15', showPrivate: true });
  assert.equal(all(mine.hits).filter((h) => privateIds.includes(h.id)).length, 2);
});

test('EXPLAIN: with until the vector leg still uses the HNSW index; iterative scan is on', async () => {
  const s = spy();
  await search(s.db, 'zzqqxxnomatch', { semantic: false, since: '2026-09-01', until: '2026-09-15', limit: 6 });
  const main = s.calls.find((c) => c.sql.includes('embedding <=> $10'))!;
  const c = await db.connect();
  try {
    await c.query('BEGIN; SET LOCAL enable_seqscan = off; SET LOCAL enable_sort = off'); // 7 rows: seq scan + sort would win on cost; show what the leg CAN use
    const plan = JSON.stringify((await c.query(`EXPLAIN (FORMAT JSON) ${main.sql}`, main.params)).rows[0]);
    assert.ok(plan.includes('"Index Name":"chunks_embedding"'), 'vector leg: no HNSW index scan'); // (assert.match would print the whole plan)
    assert.equal((await c.query(`SELECT current_setting('hnsw.iterative_scan') v`)).rows[0].v, 'relaxed_order');
  } finally { await c.query('ROLLBACK'); c.release(); }
});

test('cli retokenize rewrites only rows whose tokens changed (Thai digits fold to the tokens already stored)', async () => {
  await guard();
  const [a, b] = (await db.query(`SELECT id FROM chunks WHERE text LIKE '%ภ.ง.ด.53%' ORDER BY id LIMIT 2`)).rows.map((r) => r.id);
  await db.query(`UPDATE chunks SET text = replace(text, '53', '๕๓') WHERE id = $1`, [a]); // same tokens after fold
  await db.query(`UPDATE chunks SET words = ''::tsvector WHERE id = $1`, [b]);             // stale tokens
  const before = await db.query(`SELECT id, ctid::text, words::text FROM chunks ORDER BY id`);
  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'retokenize'], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^retokenized ${before.rows.length} changed 1$`, 'm'));
  const now = new Map((await db.query(`SELECT id, ctid::text, words::text FROM chunks`)).rows.map((x) => [x.id, x]));
  for (const x of before.rows) {
    if (x.id === b) assert.notEqual(now.get(b).words, '', 'the stale row is rebuilt');
    else assert.deepEqual(now.get(x.id), x, `${x.id} untouched (same tuple)`);
  }
});

test('kind filter and asOf point-in-time temporal query (resurrects later-superseded facts as active at asOf)', async () => {
  await guard();
  writeNote('facts/demo/Fe0000010.md', {
    memhub: 'fact', id: 'Fe0000010', kind: 'rule', scope: 'project', project: 'd:/demo', status: 'superseded',
    superseded_by: 'Fe0000011', importance: '8', valid_at: '2026-09-10T05:00:00Z', created_at: '2026-09-10T05:00:00Z',
    expired_at: '2026-09-20T05:00:00Z', source_uuids: ['dr0-u'], md5: md5('Fe0000010'), run: 'r1',
  }, `${WORD} กฎเดิมก่อนเปลี่ยน\n`);
  writeNote('facts/demo/Fe0000011.md', {
    memhub: 'fact', id: 'Fe0000011', kind: 'rule', scope: 'project', project: 'd:/demo', status: 'active',
    importance: '8', valid_at: '2026-09-20T05:00:00Z', created_at: '2026-09-20T05:00:00Z',
    source_uuids: ['dr3-u'], md5: md5('Fe0000011'), run: 'r1',
  }, `${WORD} กฎใหม่หลังเปลี่ยน\n`);
  await indexVault(db, MEMORY_VAULT);
  await db.query(`UPDATE chunks SET embedding = $1::halfvec`, [FAKE_VEC]);
  await refreshTermDf(db);

  // kind filter: only 'rule' facts come back
  const rulesNow = await search(spy().db, WORD, { semantic: false, kind: 'rule', limit: 8 });
  assert.deepEqual(rulesNow.hits.map((h) => [h.fid, h.status, h.superseded_by]), [
    ['Fe0000011', 'active', null],
    ['Fe0000010', 'superseded', 'Fe0000011'],
  ]);

  // kind='chat': only raw chats come back (no facts)
  const chatsOnly = await search(spy().db, WORD, { semantic: false, kind: 'chat', limit: 8 });
  assert.ok(chatsOnly.hits.length > 0 && chatsOnly.hits.every((h) => h.fid === null && h.tool !== 'obsidian'));

  // asOf = 2026-09-15 (before Fe0000011 replaced Fe0000010 on 2026-09-20): Fe0000010 is active and Fe0000011 does not exist yet
  const atMid = await search(spy().db, WORD, { semantic: false, kind: 'rule', asOf: '2026-09-15', limit: 8 });
  assert.deepEqual(atMid.hits.map((h) => [h.fid, h.status, h.superseded_by]), [['Fe0000010', 'active', null]]);

  // invalid kind or asOf throws a clear error
  await assert.rejects(() => search(spy().db, WORD, { semantic: false, kind: 'bogus' }), /kind must be one of/);
  await assert.rejects(() => search(spy().db, WORD, { semantic: false, asOf: 'not-a-date' }), /as_of must be an ISO date/);
});

