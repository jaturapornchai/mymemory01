// Synapses (src/synapse.ts): structural kinds (prov / spawn / next), three-factor co-access with sleep downscaling, and the
// associative channel (bounded spreading activation). Own throwaway schema per run, fixtures inserted directly, no Ollama.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-synapse-'));
const SCHEMA = `memhub_synapse_test_${process.pid}`;
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMHUB_MEMORY_VAULT = join(tmp, 'vault'); // → hub notes: project obsidian/vault, session vault/hubs/…
process.env.MEMORY_HUB_INTERNAL = '1';
const { connect, ROOT } = await import('../src/db.ts');
const { PRIVATE_TOOLS } = await import('../src/guard.ts');
const { associate, loadGraph, rebuildSynapses, shuffled } = await import('../src/synapse.ts');

const db = connect('rw');
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');
const T = Date.parse('2026-09-20T00:00:00Z'), H = 3600e3, NOW = new Date(T + H);
const HIDE = [...PRIVATE_TOOLS];
type Src = { id: number; uuid: string; chunk: string };
const S: Record<string, Src> = {};
let n = 0;

async function src(name: string, tool: string, kind: string, session: string, project: string, at = T, o: { hide_as?: string; status?: string } = {}) {
  const i = ++n, uuid = `u${i}`, chunk = i.toString(16).padStart(16, '0');
  const id = Number((await db.query(`INSERT INTO sources (tool, path, kind, session_id, project, size, mtime_ms, sha256, status, hide_as)
    VALUES ($1, $2, $3, $4, $5, 0, 0, '', $6, $7) RETURNING id`, [tool, `p${i}`, kind, session, project, o.status ?? null, o.hide_as ?? null])).rows[0].id);
  await db.query(`INSERT INTO turns (uuid, source_id, seq, session_id, role, ts, project, text_redacted) VALUES ($1, $2, 0, $3, 'user', $4, $5, $6)`,
    [uuid, id, session, new Date(at), project, `${name} text`]);
  await db.query(`INSERT INTO chunks (id, source_id, turn_uuid, seq_from, seq_to, session_id, project, ts, ctx_header, text, words, bigrams, chunker_ver)
    VALUES ($1, $2, $3, 0, 0, $4, $5, $6, '', $7, ''::tsvector, ''::tsvector, 't')`, [chunk, id, uuid, session, project, new Date(at), `${name} text`]);
  return (S[name] = { id, uuid, chunk });
}
const fact = (s: Src, fid: string, uuids: string[]) => db.query(`INSERT INTO facts (source_id, fid, kind, valid_at, created_at, source_uuids, md5)
  VALUES ($1, $2, 'fact', now(), now(), $3, $2)`, [s.id, fid, uuids]);
const link = (a: Src, b: Src) => db.query(`INSERT INTO links (src_id, dst_name, dst_id) VALUES ($1, $2, $3)`, [a.id, `n${b.id}`, b.id]);
const edge = (a: Src, b: Src, kind: string, w = 1) => db.query(`INSERT INTO edges (a, b, kind, w) VALUES ($1, $2, $3, $4)`, [Math.min(a.id, b.id), Math.max(a.id, b.id), kind, w]);
const log = (kind: string, s: Src, session: string, at: number, rank: number | null = null) =>
  db.query(`INSERT INTO access_log (kind, chunk_id, turn_uuid, rank, session, ts) VALUES ($1, $2, $3, $4, $5, $6)`, [kind, s.chunk, s.uuid, rank, session, new Date(at)]);
const edges = async (kind: string) => (await db.query(`SELECT a::float8 a, b::float8 b, w FROM edges WHERE kind = $1 ORDER BY a, b`, [kind])).rows;
const pair = (x: Src, y: Src) => [Math.min(x.id, y.id), Math.max(x.id, y.id)];
const names = (rows: { chunk: { source_id: string } }[]) => rows.map((r) => Object.keys(S).find((k) => S[k].id === Number(r.chunk.source_id)));

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  await src('m1', 'claude', 'main', 'sm1', 'd:/p');
  await src('mh', 'claude', 'main', 'smh', 'd:/p', T + H, { hide_as: 'google' }); // a Claude chat that saw a Claude-only hit
  await src('m2', 'codex', 'main', 'sm2', 'd:/p', T + 2 * H);
  await src('m3', 'zcode', 'main', 'sm3', 'd:/p', T + 74 * H);                     // > 24 h after m2: no next
  await src('mo', 'gemini', 'main', 'smo', 'd:/other', T + H);
  await src('s1', 'claude', 'subagent', 'sm1', 'd:/p');
  await src('h1', 'codex', 'headless', 'sm2', 'd:/p', T + 2 * H);
  await src('sh', 'claude', 'subagent', 'smh', 'd:/p', T + H);                     // its main is hidden
  await src('g', 'google', 'doc', 'gmail:x', 'google/gmail');
  await src('f1', 'obsidian', 'note', 'vault/facts/f1.md', 'obsidian/vault');
  await src('f2', 'obsidian', 'note', 'vault/facts/f2.md', 'obsidian/vault', T, { status: 'rejected' });
  await src('hub', 'obsidian', 'note', 'vault/hubs/p hub.md', 'obsidian/vault');
  await src('day', 'obsidian', 'daily', 'vault/daily/2026-09-20.md', 'obsidian/vault');
  await src('n1', 'obsidian', 'note', 'notes/n1.md', 'obsidian/notes');
  for (const k of ['x', 'y1', 'y2']) await src(k, 'obsidian', 'note', `notes/${k}.md`, 'obsidian/notes');
  await fact(S.f1, 'F00000001', [S.m1.uuid, S.s1.uuid, 'obs:self', S.mh.uuid]);
  await fact(S.f2, 'F00000002', [S.m2.uuid]);
  // search calls (session + ts) and opens
  await log('search', S.m1, 'A', T, 1); await log('search', S.m2, 'A', T, 2); await log('search', S.g, 'A', T, 3);
  await log('search', S.m1, 'A', T + 60e3, 1); await log('search', S.m2, 'A', T + 60e3, 2); // same pair again: once per session
  await log('get', S.m2, 'A', T + 5 * 60e3);                                                    // reward within 30 min
  await log('search', S.m3, 'B', T, 1); await log('search', S.h1, 'B', T, 2);                 // impressions only
  await log('search', S.s1, 'C', T, 1); await log('search', S.m3, 'C', T, 6); await log('get', S.m3, 'C', T + 60e3); // rank 6
  await log('search', S.m3, 'E', T, 1); await log('search', S.mo, 'E', T, 2); await log('get', S.m3, 'E', T + 40 * 60e3); // too late
  await log('get', S.f1, 'D', T); await log('related', S.s1, 'D', T + 10 * 60e3);             // co-open
  for (let i = 0; i < 10; i++) for (const k of ['x', 'y1', 'y2']) await log('get', S[k], `H${i}`, T); // saturating co-opens
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('structural synapses: prov / spawn / next shapes, never a hidden endpoint', async () => {
  await guard();
  assert.deepEqual(await rebuildSynapses(db, { structural: true, now: NOW }), { prov: 2, spawn: 2, next: 1, entity: 0, cites: 0 });
  const ab = async (k: string) => (await edges(k)).map((e) => [e.a, e.b]);
  assert.deepEqual(await ab('prov'), [pair(S.m1, S.f1), pair(S.s1, S.f1)].sort((p, q) => p[0] - q[0]), 'obs: / hidden / rejected fact skipped');
  assert.deepEqual(await ab('spawn'), [pair(S.m1, S.s1), pair(S.m2, S.h1)].sort((p, q) => p[0] - q[0]));
  assert.deepEqual(await ab('next'), [pair(S.m1, S.m2)], 'hidden session left out of the order; gap > 24 h and other projects unlinked');
});

test('co-access: impressions alone nothing, rewarded pair 0.05, co-open 0.1, once per session, Σw ≤ 1 per node', async () => {
  await guard();
  await rebuildSynapses(db, { plastic: true, now: NOW });
  const e = await edges('coaccess');
  const w = (x: Src, y: Src) => e.find((r) => r.a === pair(x, y)[0] && r.b === pair(x, y)[1])?.w;
  assert.ok(Math.abs(w(S.m1, S.m2)! - 0.05) < 1e-4, `rewarded ${w(S.m1, S.m2)}`);
  assert.ok(Math.abs(w(S.f1, S.s1)! - 0.1) < 1e-4, `co-open ${w(S.f1, S.s1)}`);
  for (const [x, y] of [[S.m3, S.h1], [S.s1, S.m3], [S.m3, S.mo]]) assert.equal(w(x, y), undefined, 'impression-only / rank 6 / late reward');
  for (const [x, y] of [[S.x, S.y1], [S.x, S.y2], [S.y1, S.y2]]) assert.ok(Math.abs(w(x, y)! - 0.5) < 1e-3, `downscaled ${w(x, y)}`);
  const sum = new Map<number, number>();
  for (const r of e) for (const k of [r.a, r.b]) sum.set(k, (sum.get(k) ?? 0) + r.w);
  assert.ok([...sum.values()].every((s) => s <= 1 + 1e-6), JSON.stringify([...sum]));
  assert.equal(e.length, 5);
});

test('rebuild is idempotent and no kind ever has a Claude-only endpoint', async () => {
  await guard();
  const all = async () => (await db.query(`SELECT a, b, kind, w, updated_at FROM edges ORDER BY a, b, kind`)).rows;
  const one = await all();
  await rebuildSynapses(db, { structural: true, plastic: true, now: NOW });
  assert.deepEqual(await all(), one);
  const bad = (await db.query(`SELECT count(*)::int n FROM edges e JOIN sources s ON s.id IN (e.a, e.b) WHERE coalesce(s.hide_as, s.tool) = ANY($1)`, [HIDE])).rows[0].n;
  assert.equal(bad, 0);
});

test('overlapping rebuilds (hourly sync vs nightly consolidate) queue on one lock instead of colliding on edges_pkey', async () => {
  await guard();
  const r = await Promise.all([1, 2, 3].map(() => rebuildSynapses(db, { structural: true, plastic: true, now: NOW })));
  assert.deepEqual(r[1], r[0]); assert.deepEqual(r[2], r[0]);
});

test('associate: fan-normalised 2-hop spread, kinds, via fact id; scaffolding never relays', async () => {
  await guard();
  await link(S.n1, S.f1); await link(S.f1, S.n1); // both directions = one synapse
  await link(S.hub, S.f1); await link(S.hub, S.m3); await link(S.day, S.f1); await link(S.day, S.mo);
  const graph = await loadGraph(db);
  const seed = [{ chunkId: S.f1.chunk, a: 1 }];
  const r = await associate(db, seed, { hide: HIDE, theta: 0, limit: 10, graph });
  assert.deepEqual(names(r), ['n1', 'm1', 's1', 'm2'], 'h1 is 3 hops away; m3 / mo only via hub / daily notes');
  assert.deepEqual(r.map((x) => x.kind), ['link', 'prov', 'prov', 'prov→next']);
  assert.ok(r.every((x) => x.via === 'F00000001'));
  assert.ok(Math.abs(r[0].act - 1 / 2.6) < 1e-6 && Math.abs(r[3].act - (0.5 * (0.8 / 2.6) * 0.3) / 1.6) < 1e-6, JSON.stringify(r.map((x) => x.act)));
  assert.deepEqual(names(await associate(db, seed, { hide: HIDE, graph })), ['n1', 'm1'], 'default θ 0.15, limit 2');
  assert.deepEqual(names(await associate(db, seed, { hide: HIDE, graph, exclude: [S.n1.chunk] })), ['m1', 's1'], 'shown sources never come out');
  // the same filters as search: an own-app chunk of this project since server start is hidden (m1, s1 are claude in d:/p)
  const own = { since: new Date(T - H), tool: 'claude', project: 'd:/p' };
  assert.deepEqual(names(await associate(db, seed, { hide: HIDE, graph, theta: 0, filters: { own } })), ['n1', 'm2']);
  assert.deepEqual(names(await associate(db, seed, { hide: HIDE, graph, theta: 0, filters: { since: '2026-09-21' } })), []);
  assert.deepEqual(names(await associate(db, seed, { hide: HIDE })), ['n1', 'm1'], 'cached graph path');
});

test('associate: superseded ×0.5, rejected neither relays nor comes out', async () => {
  await guard();
  await db.query(`UPDATE sources SET status = CASE id WHEN $1 THEN 'superseded' ELSE 'rejected' END WHERE id IN ($1, $2)`, [S.n1.id, S.m1.id]);
  const r = await associate(db, [{ chunkId: S.f1.chunk, a: 1 }], { hide: HIDE, theta: 0, limit: 10, graph: await loadGraph(db) });
  assert.deepEqual(names(r), ['s1', 'n1']);
  assert.ok(Math.abs(r[1].act - 0.5 / 1.8) < 1e-6, String(r[1].act));
  await db.query(`UPDATE sources SET status = NULL WHERE id IN ($1, $2)`, [S.n1.id, S.m1.id]);
});

test('associate: no relay through a Claude-only node; hubs above degree 24 never relay', async () => {
  await guard();
  const z = await src('z', 'zcode', 'main', 'sz', 'd:/z');
  await edge(S.n1, S.g, 'coaccess'); await edge(S.g, z, 'prov');
  const seed = [{ chunkId: S.n1.chunk, a: 1 }];
  let graph = await loadGraph(db);
  assert.ok(!names(await associate(db, seed, { hide: HIDE, theta: 0, limit: 10, graph })).includes('z'), 'relayed through a hidden node');
  assert.ok(names(await associate(db, seed, { hide: [], theta: 0, limit: 10, graph })).includes('z'), 'control: a Claude caller does reach it');
  const q = await src('q', 'obsidian', 'note', 'notes/q.md', 'obsidian/notes'), hub = await src('r', 'claude', 'main', 'sr', 'd:/r');
  await link(q, hub);
  const kids: Src[] = [];
  for (let i = 0; i < 24; i++) { kids.push(await src(`k${i}`, 'claude', 'subagent', 'sr', 'd:/r')); await edge(hub, kids[i], 'spawn'); }
  const reached = async () => names(await associate(db, [{ chunkId: q.chunk, a: 1 }], { hide: HIDE, theta: 0, limit: 30, graph: await loadGraph(db) })).length;
  assert.equal(await reached(), 1, 'visible degree 25 (q + 24 kids) > 24: r does not relay');
  await db.query(`DELETE FROM edges WHERE kind = 'spawn' AND $1 IN (a, b) AND $2 IN (a, b)`, [hub.id, kids[0].id]);
  assert.equal(await reached(), 24, 'degree 24: r relays to its 23 linked kids');
  graph = await loadGraph(db);
  const sg = shuffled(graph, 1);
  const deg = (g: typeof graph) => JSON.stringify([...g.cells].map(([id, c]) => [id, c.arcs.map((a) => a.kind).sort()]).sort((p, q) => Number(p[0]) - Number(q[0])));
  assert.equal(deg(sg), deg(graph), 'degree per node and kind preserved');
  assert.deepEqual(shuffled(graph, 1).edges, sg.edges, 'seeded');
  const key = (g: typeof graph) => new Set(g.edges.map((e) => `${e.a} ${e.b} ${e.kind}`));
  assert.ok([...key(sg)].some((k) => !key(graph).has(k)), 'some endpoints swapped');
});

test('associate: a relay hidden (hide_as) or forgotten after the graph loaded no longer relays', async () => {
  await guard();
  const a = await src('ca', 'codex', 'main', 'sca', 'd:/c'), h = await src('ch', 'claude', 'main', 'sch', 'd:/c'), x = await src('cx', 'gemini', 'main', 'scx', 'd:/c');
  await edge(a, h, 'next'); await edge(h, x, 'next');
  const graph = await loadGraph(db); // stands in for the 15-min cache
  const reach = async () => names(await associate(db, [{ chunkId: a.chunk, a: 1 }], { hide: HIDE, theta: 0, limit: 10, graph }));
  assert.deepEqual(await reach(), ['ch', 'cx']);
  await db.query(`UPDATE sources SET hide_as = 'google' WHERE id = $1`, [h.id]);
  assert.deepEqual(await reach(), [], 'hidden after the load');
  await db.query(`UPDATE sources SET hide_as = NULL WHERE id = $1`, [h.id]);
  await db.query(`DELETE FROM sources WHERE id = $1`, [h.id]);
  assert.deepEqual(await reach(), [], 'forgotten after the load');
});

test('compete: top 6 stay, the last slots go to the best of {hits 7.., proposals} by sim + bonus·act; ties keep the hit', async () => {
  const { compete } = await import('../src/synapse.ts');
  const hit = (id: string) => ({ id, score: 1 }) as any;
  const hits = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8'].map(hit);
  const prop = (id: string, sim: number, act: number) => ({ chunk: { id } as any, via: 'h1', kind: 'link', act, sim });
  const sims = new Map([['h7', 0.5], ['h8', 0.4]]);
  const ids = (o: object, props = [prop('p1', 0.45, 0.2), prop('p2', 0.3, 0.01)]) => compete(hits, { props, sims }, { n: 8, theta: 0.05, ...o }).map((h) => h.id);
  assert.deepEqual(ids({ bonus: 0.3 }), ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p1', 'h7']); // p1 0.51 > h7 0.5 > h8; p2 under θ
  assert.deepEqual(ids({ bonus: 0 }), ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'p1']);
  assert.deepEqual(ids({ bonus: 0 }, [prop('p1', 0.5, 0.2)]), ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'p1']); // tie with h7: hit first
  assert.deepEqual(ids({ bonus: 0.3 }, []), hits.map((h) => h.id)); // no proposals → unchanged
});
