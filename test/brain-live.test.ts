// Search tracer (src/brain-live.ts tracer): its 'ai' rows are exactly memory_search's default answer, every row says why it got or
// missed a slot, `linked` never repeats a row, and a Claude-only source shows nowhere. Own throwaway schema per run (never
// public), fixtures through the real importer store(); all data is fake.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = `memhub_brainlive_test_${process.pid}`;
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMORY_HUB_INTERNAL = '1';
// the two searches compared below each embed the query; under a full-suite load one could miss the 300 ms wait, go keyword-only and rank differently
process.env.MEMHUB_EMBED_WAIT_MS = '10000';
const { connect, ROOT } = await import('../src/db.ts');
const { store } = await import('../src/importer.ts');
const { search } = await import('../src/search.ts');
const { tracer } = await import('../src/brain-live.ts');

const db = connect('rw'), tdb = connect('rw'); // tracer() wraps its pool's query once: it gets a pool of its own
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');
const WORD = 'zorblaxq', MARK = 'PRIVMARK_Q7', TITLE = 'Zebra-Invoice-Title';
const ids: Record<string, { source: string; chunk: string }> = {};
let day = 10, res: Awaited<ReturnType<ReturnType<typeof tracer>>>, expected: string[];

/** One source via the real store(): one user turn = one chunk, a distinct day each (stable order). */
async function put(name: string, tool: string, kind: string, session: string, project: string, texts: string[], role: 'user' | 'note' = 'user') {
  const turns = texts.map((text, i) => ({ uuid: `${name}-${i}`, parentUuid: null, seq: i, role, ts: `2026-09-${day++}T05:00:00Z`, text }));
  const source = await store(db, { tool, path: `bl/${name}`, kind, sessionId: session, project, size: 0, mtimeMs: 0, sha256: '', label: `${name} · ${tool}`, replace: false }, turns);
  ids[name] = { source, chunk: (await db.query(`SELECT id FROM chunks WHERE source_id = $1 ORDER BY seq_from LIMIT 1`, [source])).rows[0].id };
}

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  // a: 5 chats of ONE session hold the word → the per-session cap (3) leaves 2 as 'cap'
  await put('a', 'codex', 'main', 'bl-sess-a', 'd:/brainlive', [0, 1, 2, 3, 4].map((i) => `${WORD} cap probe ${i}: another turn of the same long session`));
  // b + f: a chat and the fact distilled from it (same words) → the chat folds under the fact
  const body = `${WORD} deploy gate decision: ship only after the smoke test passes on the staging box`;
  await put('b', 'zcode', 'main', 'bl-sess-b', 'd:/brainlive', [body]);
  await put('f', 'obsidian', 'note', 'vault/facts/f1.md', 'obsidian/vault', [`${body} (distilled)`], 'note');
  await db.query(`INSERT INTO facts (source_id, fid, kind, valid_at, created_at, source_uuids, md5) VALUES ($1, 'F0000b001', 'fact', now(), now(), '{b-0}', 'm')`, [ids.f.source]);
  // c d e: one chat each → 3 + fact + 3 = 7 rows for the AI's 6 seats, so one finds them 'full'
  for (const [k, tool] of [['c', 'gemini'], ['d', 'lmstudio'], ['e', 'antigravity']]) await put(k, tool, 'main', `bl-sess-${k}`, 'd:/brainlive', [`${WORD} separate session ${k}: chatter about build ${k}`]);
  await put('n', 'obsidian', 'note', 'notes/n1.md', 'obsidian/notes', ['gardening: tomatoes need watering twice a week'], 'note'); // no word, no embedding: only reachable by a link
  await put('p', 'google', 'doc', 'gmail:bl1', 'google/gmail', [`Subject: ${TITLE} ${WORD} ${MARK} please pay`]); // Claude-only (guard.PRIVATE_TOOLS)
  for (const k of ['f', 'a', 'c']) await db.query(`INSERT INTO links (src_id, dst_name, dst_id) VALUES ($1, 'garden', $2)`, [ids[k].source, ids.n.source]);
  // the mail is linked and co-accessed from visible sources too, so only the gate keeps it out of `linked`
  await db.query(`INSERT INTO links (src_id, dst_name, dst_id) VALUES ($1, 'mail', $2)`, [ids.f.source, ids.p.source]);
  await db.query(`INSERT INTO edges (a, b, kind, w) VALUES (least($1::bigint, $2::bigint), greatest($1::bigint, $2::bigint), 'coaccess', 1)`, [ids.a.source, ids.p.source]);
  // an embedding on every chunk with the word (the private one included), varied per chunk so cosines differ
  await db.query(`UPDATE chunks SET embedding = (SELECT array_agg(CASE WHEN i % 7 = abs(hashtext(chunks.id)) % 7 THEN 0.09 ELSE 0.01 END ORDER BY i)
    FROM generate_series(1, 1024) i)::halfvec WHERE text LIKE '%${WORD}%'`);
  res = await tracer(tdb)(WORD, (sid) => `n${sid}`);
  expected = (await search(db, WORD, { limit: 6 })).hits.map((h) => h.id); // the tracer passes no hide option: both hide Claude-only by default
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  await tdb.end();
});

test('ai rows = memory_search\'s default answer (same ids, same order); hits = the same list', () => {
  const ai = res.explain.rows.filter((r) => r.why === 'ai').map((r) => r.id);
  assert.equal(expected.length, 6, 'fixture: 7 candidate slots, so the default limit 6 fills');
  assert.deepEqual(ai, expected);
  assert.deepEqual(res.hits.map((h) => h.id), expected);
});

test('every row says why, as the default 6-seat run of memory_search decided: ai / cap / full / fold:<fact> / out', () => {
  const why = res.explain.rows.map((r) => r.why);
  assert.ok(why.every((w) => ['ai', 'cap', 'full', 'out'].includes(w) || w.startsWith('fold:')), why.join());
  assert.equal(why.filter((w) => w === 'ai').length, 6);
  assert.equal(why.filter((w) => w === 'cap' || w === 'full').length, 3, 'session a: 2 over its 3; one row past the 6 seats');
  assert.ok(why.includes('full'), why.join());
  assert.equal(res.explain.rows.find((r) => r.id === ids.b.chunk)?.why, 'fold:F0000b001');
});

test('linked excludes every row (by node and label), and the linked note shows up', () => {
  const { rows, linked } = res.explain;
  assert.ok(linked.some((l) => l.node === `n${ids.n.source}`), 'fixture: note n is linked from the top hits');
  for (const l of linked) {
    assert.ok(!rows.some((r) => r.node === l.node), `linked node ${l.node} is a row`);
    assert.ok(!rows.some((r) => r.label === l.label), `linked label is a row: ${l.label}`);
  }
});

test('the Claude-only source is nowhere in the result (control: it is a candidate once the gate is open)', async () => {
  const open = await search(db, WORD, { limit: 20, showPrivate: true });
  assert.ok(open.hits.some((h) => h.id === ids.p.chunk), 'fixture: the private chunk matches');
  const json = JSON.stringify(res);
  for (const s of [MARK, TITLE, ids.p.chunk, '"private"']) assert.ok(!json.includes(s), `leaked: ${s}`);
});

test('vector leg: top-1 cosine = signal.cos1 (4 dp)', (t) => {
  if (!res.semantic) return t.skip('embedder (Ollama) not reachable: the vector leg is off');
  assert.equal(res.explain.vec.top[0].cos, Math.round(res.explain.signal!.cos1! * 1e4) / 1e4);
});
