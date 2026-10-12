// Nightly sem job (src/sem.ts): top-cosine pairs of visible nodes → a judge (here a fake, never :8080) → judged_pairs, and
// edges kind 'sem' for rel ≠ none AND strength 3 only. Own throwaway schema; embeddings inserted directly.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCHEMA = `memhub_sem_test_${process.pid}`;
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMHUB_MEMORY_VAULT = join(mkdtempSync(join(tmpdir(), 'memhub-sem-')), 'vault');
process.env.MEMORY_HUB_INTERNAL = '1';
const { connect, ROOT } = await import('../src/db.ts');
const { runSem } = await import('../src/sem.ts');

const db = connect('rw');
const S: Record<string, number> = {};
let n = 0;
// a shared direction + a little of the node's own axis → cos ≈ 0.92 between any two `near` nodes; `far` is orthogonal to them
const vec = (near: boolean, i: number) => `[${Array.from({ length: 1024 }, (_, d) => (d === 0 && near ? 1 : 0) + (d === i ? (near ? 0.3 : 1) : 0)).join(',')}]`;
async function src(name: string, tool: string, kind: string, text: string, o: { near?: boolean; hide_as?: string; session?: string } = {}) {
  const i = ++n, session = o.session ?? `s${i}`;
  const id = Number((await db.query(`INSERT INTO sources (tool, path, kind, session_id, project, size, mtime_ms, sha256, hide_as)
    VALUES ($1, $2, $3, $4, 'd:/p', 0, 0, '', $5) RETURNING id`, [tool, `p${i}`, kind, session, o.hide_as ?? null])).rows[0].id);
  await db.query(`INSERT INTO turns (uuid, source_id, seq, session_id, role, ts, text_redacted) VALUES ($1, $2, 0, $3, 'user', now(), $4)`, [`u${i}`, id, session, text]);
  await db.query(`INSERT INTO chunks (id, source_id, turn_uuid, seq_from, seq_to, session_id, ts, ctx_header, text, words, bigrams, embedding, chunker_ver)
    VALUES ($1, $2, $3, 0, 0, $4, now(), '', $5, ''::tsvector, ''::tsvector, $6::halfvec, 't')`, [i.toString(16).padStart(16, '0'), id, `u${i}`, session, text, vec(o.near ?? true, i)]);
  return (S[name] = id);
}
const key = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`;
const named = (k: string) => k.split('-').map((x) => Object.keys(S).find((s) => S[s] === Number(x))).join('-');
// fake judge: verdicts by pair name; records every pair and text it was sent
const VERDICT: Record<string, { rel: string; strength: number }> = {
  'n1-n3': { rel: 'same_task', strength: 3 }, 'n1-n4': { rel: 'fixes', strength: 2 }, 'n2-n3': { rel: 'none', strength: 0 },
  'n2-n4': { rel: 'none', strength: 3 }, 'n3-n4': { rel: 'updates', strength: 3 },
};
let sent: string[] = [];
const texts: string[] = [];
const judge = async (x: { id: number; text: string }, y: { id: number; text: string }) => {
  const k = named(key(x.id, y.id));
  sent.push(k); texts.push(x.text, y.text);
  return VERDICT[k] ?? { rel: 'none', strength: 0 };
};
const sem = async () => (await db.query(`SELECT a::int a, b::int b FROM edges WHERE kind = 'sem' ORDER BY a, b`)).rows.map((r) => named(key(r.a, r.b)));

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA);
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  await src('n1', 'obsidian', 'note', 'D: deploy runbook for the box77 server, step by step with the caddy reverse proxy');
  await src('n2', 'obsidian', 'note', 'D: box77 server notes: caddy config, ssh tunnel and the hourly sync job');
  await src('n3', 'codex', 'main', 'U: fix the caddy reverse proxy on box77, the tunnel keeps dropping every night');
  await src('n4', 'claude', 'main', 'U: box77 caddy tunnel again: move the reverse proxy behind the ssh tunnel');
  await src('h', 'claude', 'main', 'U: box77 caddy SECRET-GMAIL thread about the server invoice and tunnel', { hide_as: 'google', session: 'sh' });
  // a fact citing the hidden session is hidden too (its text may quote it)
  const f = await src('hf', 'obsidian', 'note', 'D: box77 caddy fact distilled from SECRET-GMAIL, the tunnel and reverse proxy');
  await db.query(`INSERT INTO facts (source_id, fid, kind, valid_at, created_at, source_uuids, session_ids, md5)
    VALUES ($1, 'F00000001', 'fact', now(), now(), '{u5}', '{sh}', 'x')`, [f]);
  await src('far', 'obsidian', 'note', 'D: a recipe for green curry with chicken, coconut milk and thai basil', { near: false });
  await src('thin', 'obsidian', 'note', 'D: box77');                                                    // under 40 chars: no node
  await db.query(`INSERT INTO judged_pairs (a, b, verdict, strength, model) VALUES ($1, $2, 'same_task', 3, 'gemma4')`, [Math.min(S.n1, S.n2), Math.max(S.n1, S.n2)]);
});
after(async () => { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await db.end(); });

test('dry: counts pending pairs, judges nothing', async () => {
  const r = await runSem(db, { dry: true });
  assert.deepEqual([r.nodes, r.candidates, r.pending], [5, 6, 5], 'n1..n4 + far (hidden, its fact, thin: never a node); far pairs with none; n1-n2 judged');
  assert.equal((await db.query(`SELECT count(*)::int n FROM judged_pairs`)).rows[0].n, 1);
});

test('only unjudged pairs are sent, per-run cap, strength 3 (rel ≠ none) only becomes sem, a rerun judges nothing again', async () => {
  const r1 = await runSem(db, { limit: 3, judge, model: 'fake' });
  assert.equal(sent.length, 3, 'the cap');
  const r2 = await runSem(db, { judge, model: 'fake' });
  assert.deepEqual([r1.judged, r2.judged, r2.pending, r1.sem! + r2.sem!], [3, 2, 2, 2]);
  assert.deepEqual(sent.sort(), ['n1-n3', 'n1-n4', 'n2-n3', 'n2-n4', 'n3-n4'], 'every candidate once, never the pre-judged n1-n2');
  assert.ok(!texts.some((t) => t.includes('SECRET-GMAIL')), 'hidden sources and facts citing them never reach the judge');
  assert.deepEqual(await sem(), ['n1-n3', 'n3-n4'], 'strength 2 and none:3 are not edges; n1-n2 (judged before) is not re-inserted');
  const v = (await db.query(`SELECT a::int a, b::int b, verdict, strength, model FROM judged_pairs ORDER BY a, b`)).rows;
  assert.equal(v.length, 6, 'every verdict kept, none too');
  assert.deepEqual(v.filter((x) => x.model === 'fake').map((x) => `${named(key(x.a, x.b))} ${x.verdict}:${x.strength}`),
    ['n1-n3 same_task:3', 'n1-n4 fixes:2', 'n2-n3 none:0', 'n2-n4 none:0', 'n3-n4 updates:3'], 'none is stored with strength 0');
  sent = [];
  const r3 = await runSem(db, { judge, model: 'fake' });
  assert.deepEqual([sent.length, r3.pending], [0, 0], 'a rerun re-judges nothing (sem pairs stay candidates, so no 9th neighbour moves up)');
});

test('a bad verdict is not stored; a deleted source drops its verdicts and edges; no Gemma → skipped', async () => {
  const far = await src('far2', 'obsidian', 'note', 'D: green curry again, this time with pork and more basil leaves', { near: false, session: 'sf' });
  await db.query(`UPDATE chunks SET embedding = (SELECT embedding FROM chunks WHERE source_id = $1) WHERE source_id = $2`, [S.far, far]);
  const bad = await runSem(db, { judge: async () => ({ rel: 'maybe', strength: 9 }), model: 'fake' });
  assert.deepEqual([bad.pending, bad.judged, bad.failed], [1, 0, 1], 'far-far2 pending, the bad verdict rejected, retried next run');
  await db.query(`DELETE FROM sources WHERE id = $1`, [S.n4]);
  assert.deepEqual(await sem(), ['n1-n3']);
  assert.equal((await db.query(`SELECT count(*)::int n FROM judged_pairs WHERE $1 IN (a, b)`, [S.n4])).rows[0].n, 0);
  process.env.MEMHUB_GEMMA_URL = 'http://127.0.0.1:9'; // discard port: nothing listens
  try { assert.match((await runSem(db, {})).skipped ?? '', /not reachable/); }
  finally { delete process.env.MEMHUB_GEMMA_URL; }
});
