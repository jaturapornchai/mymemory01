// Hot path: search's own-session freshness filter (every leg), the words leg's df budget, term_df refresh vs readers, forget's access_log purge.
// Needs the memhub-pg container; throwaway schema + temp vault, and a fake Ollama so the vector leg runs without a GPU.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-hotpath-'));
const SCHEMA = `memhub_hotpath_test_${process.pid}`; // per run: a concurrent run must never drop our schema
const VEC = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)); // every chunk and query: the vector leg returns them all
const ollama = createServer((req, res) => { req.resume(); res.end(JSON.stringify(req.url === '/api/ps' ? { models: [] } : { embeddings: [VEC] })); });
await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r));
process.env.OLLAMA_URL = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMHUB_MEMORY_VAULT = join(tmp, 'vault');
process.env.MEMHUB_VAULTS = '';
process.env.MEMHUB_NO_REINDEX = '1';
process.env.MEMORY_HUB_INTERNAL = '1';
const { connect, ROOT } = await import('../src/db.ts');
const { store, forget } = await import('../src/importer.ts');
const { search, refreshTermDf } = await import('../src/search.ts');

const db = connect('rw');
const SINCE = new Date('2026-10-01T00:00:00Z'), LATER = '2026-10-02T00:00:00Z';
async function chat(tool: string, sid: string, project: string, ts: string, text: string) {
  await store(db, { tool, path: join(tmp, `${sid}.jsonl`), kind: 'main', sessionId: sid, project, size: 1, mtimeMs: 1, sha256: sid,
    label: project, replace: true }, [{ uuid: `${sid}-u0`, parentUuid: null, seq: 0, role: 'user', ts, text }]);
}
const sessions = (r: { hits: { session_id: string }[] }) => r.hits.map((h) => h.session_id).sort();

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  await chat('claude', 'own-live', 'd:/proj', LATER, 'zqfresh the caller session itself');
  await chat('codex', 'codex-live', 'd:/proj', LATER, 'zqfresh another app right now');
  await chat('claude', 'other-proj', 'd:/other', LATER, 'zqfresh same app, another project');
  await db.query('UPDATE chunks SET embedding = $1::halfvec', [`[${VEC.join(',')}]`]);
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  ollama.close();
  rmSync(tmp, { recursive: true, force: true });
});

const own = { since: SINCE, tool: 'claude', project: 'd:/proj' };
const ALL = ['codex-live', 'other-proj', 'own-live'];

test('own hides only the caller\'s live session: keyword legs', async () => {
  assert.deepEqual(sessions(await search(db, 'zqfresh', { semantic: false })), ALL);
  assert.deepEqual(sessions(await search(db, 'zqfresh', { semantic: false, own })), ['codex-live', 'other-proj']);
});

test('own hides only the caller\'s live session: vector leg', async () => {
  const q = 'qqnomatchword'; // no keyword hit: every row comes from the vector leg
  const plain = await search(db, q);
  assert.equal(plain.semantic, true);
  assert.deepEqual(sessions(plain), ALL);
  assert.deepEqual(sessions(await search(db, q, { own })), ['codex-live', 'other-proj']);
});

test('own with nothing newer than since = own undefined (same hits, same order, same scores)', async () => {
  const before = new Date('2026-12-01T00:00:00Z'); // a fixed recency anchor: scores comparable across calls
  for (const q of ['zqfresh', 'qqnomatchword']) {
    assert.deepEqual(await search(db, q, { before, own: { ...own, since: new Date('2026-11-01T00:00:00Z') } }), await search(db, q, { before }));
  }
});

test('refreshTermDf completes while a reader holds term_df (TRUNCATE waited for it and queued every later search)', async () => {
  const reader = await db.connect();
  try {
    await reader.query('BEGIN; SELECT count(*) FROM term_df'); // ACCESS SHARE until COMMIT, like a search mid-flight
    const r = await Promise.race([refreshTermDf(db).then(() => 'done'), new Promise((res) => setTimeout(res, 3000, 'blocked'))]);
    assert.equal(r, 'done');
  } finally { await reader.query('COMMIT'); reader.release(); }
  assert.equal((await db.query(`SELECT ndoc FROM term_df WHERE word = 'zqfresh'`)).rows[0]?.ndoc, 3);
});

test('forget purges the access_log of what it forgot only: re-chunked turns of other chats keep their history', async () => {
  await chat('claude', 'keep-s', 'd:/hist', '2026-09-01T00:00:00Z', 'history that stays');
  await chat('claude', 'gone-s', 'd:/hist', '2026-09-01T00:00:00Z', 'history to forget');
  const chunk = async (sid: string) => (await db.query('SELECT id FROM chunks WHERE session_id = $1', [sid])).rows[0].id;
  const [keep, gone] = [await chunk('keep-s'), await chunk('gone-s')];
  await db.query(`INSERT INTO access_log (kind, chunk_id, turn_uuid, query) SELECT 'get', c, t, q
    FROM unnest($1::text[], $2::text[], $3::text[]) x(c, t, q)`, [
    [gone, gone, 'rechunked0000000', keep],
    ['gone-s-u0', null, 'keep-s-u0', 'keep-s-u0'],
    ['gone by turn', 'gone, logged before turn_uuid', 'keep, chunk id changed', 'keep'],
  ]);
  await forget(db, 'session', 'gone-s');
  assert.deepEqual((await db.query('SELECT query FROM access_log ORDER BY query')).rows.map((r) => r.query), ['keep', 'keep, chunk id changed']);
});

test('words leg: rarest candidates first while their df adds up to ≤ 4000, the rest only score (live: 93 of 200 queries scanned more)', async () => {
  const sid = (await db.query('SELECT id FROM sources LIMIT 1')).rows[0].id;
  await db.query(`INSERT INTO chunks (id, source_id, turn_uuid, seq_from, seq_to, session_id, ctx_header, text, words, bigrams, chunker_ver)
    SELECT 'fill' || g, $1, 'fill', 0, 0, 'fill', '', '', '', '', 'x' FROM generate_series(1, 40000) g`, [sid]); // corpus ≈ 40k: 5% = 2000
  await db.query(`ANALYZE chunks; INSERT INTO term_df (word, ndoc) VALUES ('zqbudaa', 1500), ('zqbudbb', 1800), ('zqbudcc', 1900)`);
  try {
    const { explain } = await search(db, 'zqbudcc zqbudaa zqbudbb', { semantic: false, explain: true });
    assert.deepEqual(Object.fromEntries(explain!.terms.map((t) => [t.key, t.used])), { zqbudaa: true, zqbudbb: true, zqbudcc: false });
  } finally { await db.query(`DELETE FROM chunks WHERE session_id = 'fill'; DELETE FROM term_df WHERE word LIKE 'zqbud%'; ANALYZE chunks`); }
});
