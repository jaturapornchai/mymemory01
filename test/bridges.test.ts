// LLM-free bridges (synapse.ts WEIGHTED): entity = sessions naming the same rare identifier (IDF-weighted, df per app+session,
// per-node top 8); cites = a chat/note naming a GitHub commit sha or github.com URL ↔ that commit's / issue's / repo's source.
// Own throwaway schema; words/term_df inserted directly.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCHEMA = `memhub_bridges_test_${process.pid}`;
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMHUB_MEMORY_VAULT = join(mkdtempSync(join(tmpdir(), 'memhub-bridges-')), 'vault');
process.env.MEMORY_HUB_INTERNAL = '1';
const { connect, ROOT } = await import('../src/db.ts');
const { rebuildSynapses, loadGraph, shuffled, associate } = await import('../src/synapse.ts');

const db = connect('rw');
const S: Record<string, number> = {};
let n = 0;
async function src(name: string, tool: string, kind: string, session: string, words: string, text = words, o: { hide_as?: string; turn?: string; project?: string } = {}) {
  const i = ++n;
  const id = Number((await db.query(`INSERT INTO sources (tool, path, kind, session_id, project, size, mtime_ms, sha256, hide_as)
    VALUES ($1, $2, $3, $4, $5, 0, 0, '', $6) RETURNING id`, [tool, `p${i}`, kind, session, o.project ?? 'd:/p', o.hide_as ?? null])).rows[0].id);
  const uuid = o.turn ?? `u${i}`;
  await db.query(`INSERT INTO turns (uuid, source_id, seq, session_id, role, ts, text_redacted) VALUES ($1, $2, 0, $3, 'user', now(), $4)`, [uuid, id, session, text]);
  await db.query(`INSERT INTO chunks (id, source_id, turn_uuid, seq_from, seq_to, session_id, ts, ctx_header, text, words, bigrams, chunker_ver)
    VALUES ($1, $2, $3, 0, 0, $4, now(), '', $5, $6::tsvector, ''::tsvector, 't')`, [i.toString(16).padStart(16, '0'), id, uuid, session, text, words]);
  return (S[name] = id);
}
const pairs = async (kind: string) => (await db.query(`SELECT a::int a, b::int b, w FROM edges WHERE kind = $1 ORDER BY a, b`, [kind])).rows
  .map((r) => [Object.keys(S).find((k) => S[k] === r.a), Object.keys(S).find((k) => S[k] === r.b), Number(r.w.toFixed(3))]);
const SHA = '4f3a9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b';

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA);
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  await src('a', 'claude', 'main', 'sa', `'box77_srv':1 'v1.2.3':2 'everyday':3`);
  await src('a_sub', 'claude', 'subagent', 'sa', `'box77_srv':1`);              // same session as a: no self-bridge, one df unit
  await src('b', 'codex', 'main', 'sb', `'box77_srv':1 'v1.2.3':2`);           // shares 2 rare ids with a
  await src('c', 'zcode', 'main', 'sc', `'v1.2.3':1 '${SHA.slice(0, 7)}':2 'github':3`, `fixed in ${SHA.slice(0, 7)}, see https://github.com/O/R/issues/12`);
  await src('h', 'claude', 'main', 'sh', `'box77_srv':1`, 'x', { hide_as: 'google' }); // hidden: never an endpoint
  await src('commits', 'github', 'doc', 'github:o/r:commits', `'commit':1`, `[commit ${SHA.slice(0, 7)}] fix`, { turn: `github:o/r@${SHA}` });
  await src('issue', 'github', 'doc', 'github:o/r#12', `'issue':1`, '[issue #12] bug', { turn: 'github:o/r#12' });
  await src('hub', 'obsidian', 'note', 'vault/hubs/p hub.md', `'box77_srv':1`, 'x', { project: 'obsidian/vault' }); // scaffolding
  await db.query(`INSERT INTO term_df (word, ndoc) VALUES ('box77_srv', 5), ('v1.2.3', 3), ('everyday', 500), ('${SHA.slice(0, 7)}', 1), ('github', 1)`);
});
after(async () => { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await db.end(); });

test('entity: rare identifiers shared across sessions, IDF-weighted; cites: sha prefix + github.com URL', async () => {
  const r = await rebuildSynapses(db, { structural: true, now: new Date() });
  assert.equal(r.cites, 2);
  // box77_srv: units sa, sb (h hidden, hub scaffolding) → n 2; v1.2.3: sa, sb, sc → n 3. a–b share both (1/ln3 + 1/ln4 > 1 → 1)
  assert.deepEqual(await pairs('entity'), [['a', 'b', 1], ['a', 'c', 0.721], ['a_sub', 'b', 0.91], ['b', 'c', 0.721]],
    'never a–a_sub (one session), hidden/hub never, everyday too common');
  assert.deepEqual(await pairs('cites'), [['c', 'commits', 1], ['c', 'issue', 1]], 'a 7-hex prefix of the commit, an issue URL (case-insensitive)');
  const g = await loadGraph(db);
  assert.ok(g.edges.some((e) => e.kind === 'entity') && g.edges.some((e) => e.kind === 'cites'), 'loaded for associate / proposals');
  const s = shuffled(g, 1, ['entity']);
  assert.deepEqual(s.edges.filter((e) => e.kind === 'cites'), g.edges.filter((e) => e.kind === 'cites'), 'only the named kinds are shuffled');
});

test('associate: bridges are normalized on their own at half gain, so they never dilute link/spawn/prov arcs', async () => {
  await rebuildSynapses(db, { structural: true, now: new Date() });
  const graph = await loadGraph(db);
  const chunk = (await db.query(`SELECT id FROM chunks WHERE source_id = $1`, [S.a])).rows[0].id;
  const run = (kinds?: string[]) => associate(db, [{ chunkId: chunk, sourceId: S.a, a: 1 }], { hide: [], limit: 9, theta: 0, hops: 1, graph, kinds });
  const act = (r: Awaited<ReturnType<typeof run>>) => new Map(r.map((x) => [Number(x.chunk.source_id), { act: x.act, kind: x.kind }]));
  const base = act(await run(['link', 'spawn', 'prov', 'next', 'coaccess'])), all = act(await run());
  assert.ok(base.size > 0, 'a has base arcs (spawn to a_sub)');
  for (const [src, x] of base) assert.equal(all.get(src)?.act, x.act, 'same activation with or without bridges');
  const bridged = [...all.values()].filter((x) => x.kind === 'entity' || x.kind === 'cites');
  assert.ok(Math.abs(bridged.reduce((t, x) => t + x.act, 0) - 0.5) < 1e-9, 'the bridge family shares half of the seed');
});
