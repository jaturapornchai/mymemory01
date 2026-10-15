// Synapses between sources (table edges, a < b) and the associative channel that reads them.
//  - structural kinds, rebuilt from base tables (hourly at the end of sync, and nightly):
//      prov  fact/card ↔ the sources holding its cited turns · spawn  subagent/headless run ↔ its main session ·
//      next  consecutive main sessions of one project (any app) with a gap ≤ 24 h
//  - plastic kind coaccess, rebuilt nightly ('sleep') from access_log: three-factor Hebbian + homeostatic downscaling
//  - judged kind sem: top-cosine pairs the local Gemma judged 'certainly the same thread' (blind opus check P 0.86 vs cosine 0.38,
//      2026-10-11); written outside rebuildSynapses (which never deletes it), shown by associate, not in competition
//  - associate(): bounded spreading activation from search hits (the '⇢ linked' lines), never part of the ranking.
// Claude-only sources (guard.PRIVATE_TOOLS, also via hide_as) never become an endpoint; readers filter again per caller.
// Design, constants and measurements: docs/research/phase4-design.md §4b.
import { basename } from 'node:path';
import type pg from 'pg';
import { PRIVATE_TOOLS } from './guard.ts';
import { MEMORY_PROJECT, MEMORY_VAULT } from './notes.ts';
import { dateRange, isOtherProject, RANK, type Hit } from './search.ts';

const HIDDEN = `(SELECT id FROM sources WHERE coalesce(hide_as, tool) = ANY($1::text[]))`;

/** Structural kind → SELECT of (x, y) source pairs; $1 = hidden tools. Exported for read-only dry runs on the live DB. */
export const STRUCTURAL: Record<string, string> = {
  prov: `SELECT f.source_id, t.source_id FROM facts f JOIN sources s ON s.id = f.source_id
    CROSS JOIN unnest(f.source_uuids) u(uuid) JOIN turns t ON t.uuid = u.uuid
    WHERE u.uuid NOT LIKE 'obs:%' AND s.status IS DISTINCT FROM 'rejected'`,
  spawn: `SELECT s.id, m.id FROM sources s JOIN sources m ON m.kind = 'main' AND m.tool = s.tool AND m.session_id = s.session_id
    WHERE s.kind IN ('subagent', 'headless')`,
  // hidden sessions leave before ordering, so the visible sessions around one still link up
  next: `SELECT id, nid FROM (
      SELECT id, t1, lead(id) OVER w nid, lead(t0) OVER w nt0 FROM (
        SELECT s.id, c.project, min(c.ts) t0, max(c.ts) t1 FROM sources s JOIN chunks c ON c.source_id = s.id
        WHERE s.kind = 'main' AND s.tool NOT IN ('obsidian', 'github') AND s.hide_as IS NULL AND s.tool <> ALL($1::text[])
          AND c.project <> '' AND c.ts IS NOT NULL
        GROUP BY 1, 2) m
      WINDOW w AS (PARTITION BY project ORDER BY t0, id)) o
    WHERE nt0 - t1 <= interval '24 hours'`,
};
// Weighted structural kinds (a < b, w) — LLM-free bridges between sources that never cite each other (docs/decisions/0005):
//  entity  two sessions/notes/docs naming the same rare identifier (a file, package, version, host, IP: a word with _ . or digits),
//          IDF-weighted, per-node top ENTITY_TOP; df counted per (app, session) so a main session + its subagents are one unit
//  cites   a chat/note naming a GitHub commit (sha ≥ 7 hex) or a github.com URL ↔ that commit's / issue's / repo's source
// $1 hidden tools, $4 MEMORY_PROJECT, $5 its hubs/ prefix (scaffolding: never an endpoint, like loadGraph's SCAFFOLD).
const ENTITY_TOP = 8, ENTITY_DF = [2, 12];
const VIS = `coalesce(s.hide_as, s.tool) <> ALL($1::text[]) AND s.status IS DISTINCT FROM 'rejected' AND s.kind <> 'daily'
  AND NOT (s.project = $4 AND starts_with(s.session_id, $5))`;
const WEIGHTED: Record<string, string> = {
  entity: `WITH t AS (
      SELECT DISTINCT u.lexeme w, c.source_id src, s.tool || ':' || coalesce(s.session_id, s.path) unit
      FROM chunks c JOIN sources s ON s.id = c.source_id CROSS JOIN LATERAL unnest(c.words) u JOIN term_df d ON d.word = u.lexeme
      WHERE d.ndoc BETWEEN 2 AND 60 AND length(u.lexeme) >= 5 AND u.lexeme !~ '^[0-9a-f]+$' -- hashes name nothing (shas: cites)
        AND (u.lexeme ~ '[a-z]' AND u.lexeme ~ '[_.0-9]' OR u.lexeme ~ '^[0-9]+(\\.[0-9]+){2,}$') AND ${VIS}),
    df AS (SELECT w, count(DISTINCT unit) n FROM t GROUP BY w HAVING count(DISTINCT unit) BETWEEN ${ENTITY_DF[0]} AND ${ENTITY_DF[1]}),
    pr AS (SELECT x.src a, y.src b, sum(1 / ln(1 + df.n)) w FROM t x JOIN df USING (w) JOIN t y ON y.w = x.w AND y.unit <> x.unit AND x.src < y.src
           GROUP BY 1, 2),
    rk AS (SELECT a, b, w, row_number() OVER (PARTITION BY a ORDER BY w DESC, b) ra, row_number() OVER (PARTITION BY b ORDER BY w DESC, a) rb FROM pr)
    SELECT a, b, least(1, w) w FROM rk WHERE ra <= ${ENTITY_TOP} AND rb <= ${ENTITY_TOP}`,
  cites: `WITH sha AS (SELECT t.source_id g, substring(t.uuid FROM '@([0-9a-f]{40})$') h FROM turns t JOIN sources s ON s.id = t.source_id
                   WHERE s.tool = 'github' AND t.uuid ~ '@[0-9a-f]{40}$' AND ${VIS}),
    hx AS (SELECT DISTINCT u.lexeme w, c.source_id src FROM chunks c JOIN sources s ON s.id = c.source_id CROSS JOIN LATERAL unnest(c.words) u
           WHERE s.tool <> 'github' AND length(u.lexeme) BETWEEN 7 AND 40 AND u.lexeme ~ '^[0-9a-f]+$' AND u.lexeme ~ '[a-f]' AND u.lexeme ~ '[0-9]'
             AND ${VIS}),
    url AS (SELECT DISTINCT c.source_id src, lower(regexp_replace(m[1], '(\\.git|\\.)$', '')) repo, m[3] typ, m[4] ref
            FROM chunks c JOIN sources s ON s.id = c.source_id
            CROSS JOIN LATERAL regexp_matches(c.text, 'github\\.com/([A-Za-z0-9_-]+/[A-Za-z0-9_.-]+)(/(commit|issues|pull)/([0-9a-f]{7,40}|[0-9]+))?', 'g') m
            WHERE s.tool <> 'github' AND c.words @@ 'github'::tsquery AND ${VIS}),
    p AS (SELECT hx.src x, sha.g y FROM hx JOIN sha ON left(sha.h, 7) = left(hx.w, 7) AND starts_with(sha.h, hx.w)
          UNION SELECT url.src, s.id FROM url JOIN sources s ON s.tool = 'github' AND ${VIS} AND lower(s.session_id) = 'github:' || url.repo ||
            CASE WHEN url.typ IS NULL THEN '' WHEN url.typ = 'commit' THEN ':commits' ELSE '#' || url.ref END)
    SELECT DISTINCT least(x, y) a, greatest(x, y) b, 1::real w FROM p WHERE x <> y`,
};

/** Distinct visible endpoint pairs (a < b) of a STRUCTURAL query. */
export const pairs = (sql: string) => `SELECT DISTINCT least(x, y) a, greatest(x, y) b FROM (${sql}) p(x, y)
  WHERE x <> y AND x NOT IN ${HIDDEN} AND y NOT IN ${HIDDEN}`;

/**
 * Plastic co-access (a, b, w, at); $1 = hidden tools, $2 = now. A pure function of access_log, keyed by turn_uuid:
 *  - eligibility × reward (three-factor): two sources co-shown in the top 5 of one search call (session + ts), then either
 *    one opened (get / related / timeline) in that session within 30 min → 0.05·0.995^age_days
 *  - co-open (the rule before): both opened in one session within 30 min → 0.1·0.995^age_days
 *  - each counts once per (session, pair, rule); w = min(1, Σ); then w ← w·min(1, 1/Σw(a), 1/Σw(b)) so every node's
 *    co-access weights sum to ≤ 1 (sleep downscaling); prune w < 0.01.
 */
export const COACCESS = `
WITH ev AS (SELECT DISTINCT a.kind = 'search' imp, a.session, a.ts, c.source_id src
            FROM access_log a JOIN chunks c ON c.turn_uuid = a.turn_uuid
            WHERE a.session IS NOT NULL AND (a.kind IN ('get', 'related') OR (a.kind = 'search' AND a.rank <= 5))
              AND c.source_id NOT IN ${HIDDEN}),
opn AS (SELECT session, ts, src FROM ev WHERE NOT imp),
pair AS (
  SELECT x.session, x.src a, y.src b, 0.05 eta, x.ts at FROM ev x JOIN ev y ON y.imp AND y.session = x.session AND y.ts = x.ts AND x.src < y.src
  WHERE x.imp AND EXISTS (SELECT 1 FROM opn o WHERE o.session = x.session AND o.src IN (x.src, y.src) AND o.ts BETWEEN x.ts AND x.ts + interval '30 min')
  UNION ALL
  SELECT x.session, x.src, y.src, 0.1, greatest(x.ts, y.ts) FROM opn x JOIN opn y
    ON y.session = x.session AND x.src < y.src AND abs(extract(epoch FROM x.ts - y.ts)) <= 1800),
once AS (SELECT a, b, eta, max(at) at FROM pair GROUP BY session, a, b, eta),
raw AS (SELECT a, b, least(1, sum(eta * power(0.995, greatest(0, extract(epoch FROM $2::timestamptz - at)) / 86400))) w, max(at) at
        FROM once GROUP BY a, b),
deg AS (SELECT n, sum(w) s FROM (SELECT a n, w FROM raw UNION ALL SELECT b, w FROM raw) d GROUP BY n)
SELECT r.a, r.b, r.w * least(1, 1 / da.s, 1 / db.s) w, r.at FROM raw r JOIN deg da ON da.n = r.a JOIN deg db ON db.n = r.b
WHERE r.w * least(1, 1 / da.s, 1 / db.s) >= 0.01`;

/** Rebuild synapse kinds: one transaction per part, each kind DELETE + INSERT. Returns rows written per kind. */
export async function rebuildSynapses(db: pg.Pool, o: { structural?: boolean; plastic?: boolean; now?: Date }) {
  const now = o.now ?? new Date(), hide = [...PRIVATE_TOOLS], n: Record<string, number> = {};
  const tx = async (f: (c: pg.PoolClient) => Promise<void>) => {
    const c = await db.connect();
    try { // hourly sync and nightly consolidate may overlap: two DELETE+INSERT of one kind would collide on edges_pkey
      await c.query('BEGIN'); await c.query(`SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':memhub-synapses'))`); await f(c); await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  };
  if (o.structural) await tx(async (c) => {
    for (const [kind, sql] of Object.entries(STRUCTURAL)) {
      await c.query(`DELETE FROM edges WHERE kind = $1`, [kind]);
      n[kind] = (await c.query(`INSERT INTO edges (a, b, kind, w, updated_at) SELECT a, b, $2, 1, $3 FROM (${pairs(sql)}) p`, [hide, kind, now])).rowCount ?? 0;
    }
    for (const [kind, sql] of Object.entries(WEIGHTED)) {
      await c.query(`DELETE FROM edges WHERE kind = $1`, [kind]);
      n[kind] = (await c.query(`INSERT INTO edges (a, b, kind, w, updated_at) SELECT a, b, $2, w, $3 FROM (${sql}) p`,
        [hide, kind, now, MEMORY_PROJECT, `${basename(MEMORY_VAULT)}/hubs/`])).rowCount ?? 0;
    }
  });
  if (o.plastic) await tx(async (c) => {
    await c.query(`DELETE FROM edges WHERE kind = 'coaccess'`);
    n.coaccess = (await c.query(`INSERT INTO edges (a, b, kind, w, updated_at) SELECT a, b, 'coaccess', w, at FROM (${COACCESS}) x`, [hide, now])).rowCount ?? 0;
  });
  return n;
}

// ---------------- associative recall ----------------

type Arc = { to: number; w: number; kind: string };   // w = τ·weight
type Cell = { cls: string; status: string | null; arcs: Arc[] };
export type Graph = { cells: Map<number, Cell>; edges: { a: number; b: number; kind: string; w: number }[] };

const TAU: Record<string, number> = { link: 1, prov: 0.8, spawn: 0.5, next: 0.3, entity: 0.5, cites: 0.8, sem: 0.8 }; // coaccess: its own w
const COACCESS_MIN = 0.15; // a co-access synapse spreads only once confirmed (≈ ≥ 2 sessions)
const RELAY_MAX_DEGREE = 24; // p99 visible degree: hubs above it never relay (APL-like)
/** Bridges (entity, cites) are fan-normalized on their own, at half gain: a node's many bridges never dilute its link/spawn/prov
 *  arcs (joint normalization cost the N1 tune split 20.2 → 18.6 B-visible; per-family 19.7, gain 0.5 = 1 there, kinder to spawn). */
const BRIDGE = new Set(['entity', 'cites', 'sem']), BRIDGE_GAIN = 0.5; // sem: a bridge too (cross-session, not structural)
function share(out: { kind: string; w: number }[]) {
  const sum = { base: 0, bridge: 0 }, fam = (k: string) => (BRIDGE.has(k) ? 'bridge' : 'base');
  for (const e of out) sum[fam(e.kind)] += e.w;
  return (e: { kind: string; w: number }) => (BRIDGE.has(e.kind) ? BRIDGE_GAIN : 1) * e.w / sum[fam(e.kind)];
}
const HOP2 = 0.5;            // damping of the 2nd hop (HippoRAG PPR 0.5)
const RELOAD_MS = 15 * 60e3;

/** Links (resolved, src ≠ dst) + edges, both directions, without scaffolding (daily notes, memory-vault hubs/): those
 *  never relay or come out. Hidden tools stay in (cls) and are dropped per caller at query time. */
export async function loadGraph(db: pg.Pool): Promise<Graph> {
  const SCAFFOLD = (s: string) => `coalesce(${s}.kind = 'daily' OR (${s}.project = $2 AND starts_with(${s}.session_id, $3)), false)`;
  const rows = (await db.query(`
    WITH e AS (SELECT DISTINCT least(src_id, dst_id) a, greatest(src_id, dst_id) b, 'link' kind, 1::float8 w FROM links
               WHERE dst_id IS NOT NULL AND src_id <> dst_id
               UNION ALL SELECT a, b, kind, w FROM edges WHERE kind IN ('prov', 'spawn', 'next', 'entity', 'cites', 'sem') OR (kind = 'coaccess' AND w >= $1))
    SELECT e.a::float8 a, e.b::float8 b, e.kind, e.w, coalesce(sa.hide_as, sa.tool) acls, sa.status ast, coalesce(sb.hide_as, sb.tool) bcls, sb.status bst
    FROM e JOIN sources sa ON sa.id = e.a JOIN sources sb ON sb.id = e.b
    WHERE NOT ${SCAFFOLD('sa')} AND NOT ${SCAFFOLD('sb')}`, [COACCESS_MIN, MEMORY_PROJECT, `${basename(MEMORY_VAULT)}/hubs/`])).rows;
  const cells = new Map<number, Cell>();
  for (const r of rows) {
    cells.set(r.a, { cls: r.acls, status: r.ast, arcs: [] });
    cells.set(r.b, { cls: r.bcls, status: r.bst, arcs: [] });
  }
  return wire(cells, rows.map((r) => ({ a: r.a, b: r.b, kind: r.kind, w: r.w })));
}

function wire(cells: Map<number, Cell>, edges: Graph['edges']): Graph {
  for (const c of cells.values()) c.arcs = [];
  for (const e of edges) {
    const w = (TAU[e.kind] ?? 1) * e.w;
    cells.get(e.a)!.arcs.push({ to: e.b, w, kind: e.kind });
    cells.get(e.b)!.arcs.push({ to: e.a, w, kind: e.kind });
  }
  return { cells, edges };
}

/** Control graph for the eval: degree-preserving endpoint swaps within each kind ((a,b),(c,d) → (a,d),(c,b)), seeded. */
export function shuffled(g: Graph, seed: number, only?: string[]): Graph { // only: these kinds (the rest stay real)
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; }; // mulberry32
  const edges = g.edges.map((e) => ({ ...e }));
  const key = (e: { a: number; b: number; kind: string }) => `${Math.min(e.a, e.b)} ${Math.max(e.a, e.b)} ${e.kind}`;
  const have = new Set(edges.map(key));
  const byKind = new Map<string, typeof edges>();
  for (const e of edges) (byKind.get(e.kind) ?? byKind.set(e.kind, []).get(e.kind)!).push(e);
  for (const [kind, list] of byKind) {
    if (only && !only.includes(kind)) continue;
    for (let i = 0; i < 10 * list.length; i++) {
      const x = list[Math.floor(rnd() * list.length)], y = list[Math.floor(rnd() * list.length)];
      if (rnd() < 0.5) [x.a, x.b] = [x.b, x.a]; // undirected: either endpoint may move
      const nx = { ...x, b: y.b }, ny = { ...y, b: x.b };
      if (x === y || nx.a === nx.b || ny.a === ny.b || have.has(key(nx)) || have.has(key(ny))) continue;
      have.delete(key(x)); have.delete(key(y));
      [x.b, y.b] = [y.b, x.b];
      have.add(key(x)); have.add(key(y));
    }
  }
  return wire(new Map([...g.cells].map(([id, c]) => [id, { ...c }])), edges);
}

const cache = new WeakMap<pg.Pool, { at: number; g: Promise<Graph> }>();
/** Per pool, reloaded stale-while-revalidate after 15 min (the old graph serves until the new one is in); the first call
 *  awaits the load, a failed first load is retried by the next call. */
function graphOf(db: pg.Pool): Promise<Graph> {
  const c = cache.get(db);
  if (c && Date.now() - c.at < RELOAD_MS) return c.g;
  const g = loadGraph(db);
  if (!c) g.catch(() => cache.delete(db));
  else g.then(() => cache.set(db, { at: Date.now(), g }), () => {});
  cache.set(db, c ? { at: Date.now(), g: c.g } : { at: Date.now(), g });
  return cache.get(db)!.g;
}

export type Seed = { chunkId: string; a: number; sourceId?: number };
export type AssocFilters = { project?: string; since?: string; until?: string; before?: Date; own?: { since: Date; tool: string; project: string } };
export type AssocChunk = { id: string; source_id: string; turn_uuid: string; ts: Date | null; project: string; session_id: string; text: string;
  tool: string; src_kind: string; status: string | null; fid: string | null; kind: string | null; fact_project: string | null;
  superseded_by: string | null; review_target: string | null };
export type Assoc = { chunk: AssocChunk; via: string; kind: string; act: number; sim?: number }; // sim = cosine to o.qvec

/**
 * Spreading activation from seed hits over the synapse graph (only nodes visible to `hide`; rejected never, superseded ×0.5):
 * hop 1 act(m) += a_s·τw/Σ_out τw(s); hop 2 via relays m ∉ seeds with visible degree ≤ 24: act(x) += 0.5·act(m)·τw/Σ_out τw(m).
 * The sources of seeds and `exclude` (chunk ids already shown) never come out; then the top `limit` with act ≥ theta, each as
 * its chunk nearest to the via seed's chunk (no embedding → its first chunk), under the same filters as search().
 * via = the seed's display id (fact id for a fact); kind = the strongest path ('link', 'prov→next', …).
 */
export async function associate(db: pg.Pool, seeds: Seed[], o: { hide: string[]; exclude?: Iterable<string>; filters?: AssocFilters; limit?: number;
  theta?: number; graph?: Graph; qvec?: string | null; kinds?: string[]; hops?: number; currentProject?: string; query?: string }): Promise<Assoc[]> {
  const { limit = 2, theta = Number(process.env.MEMHUB_ASSOC_THETA ?? 0.15), filters: f = {} } = o;
  const exclude = [...(o.exclude ?? [])];
  if (!seeds.length || limit < 1) return [];
  const [g, ids] = await Promise.all([o.graph ?? graphOf(db), db.query(
    `SELECT c.id, c.source_id::float8 src, CASE WHEN fa.kind <> 'card' THEN fa.fid END fid FROM chunks c LEFT JOIN facts fa ON fa.source_id = c.source_id
     WHERE c.id = ANY($1::text[])`, [[...seeds.map((s) => s.chunkId), ...exclude]]).then((r) => new Map(r.rows.map((x) => [x.id, x])))]);
  const hide = new Set(o.hide);
  const live = (id: number) => { const c = g.cells.get(id); return c && !hide.has(c.cls) && c.status !== 'rejected' ? c : undefined; };
  const arcs = (id: number) => live(id)?.arcs.filter((e) => live(e.to) && (!o.kinds || o.kinds.includes(e.kind))) ?? [];
  type Act = { a: number; best: number; via: string; viaChunk: string; kind: string };
  const act = new Map<number, Act>();
  const add = (x: number, v: number, via: string, viaChunk: string, kind: string) => {
    v *= live(x)!.status === 'superseded' ? 0.5 : 1;
    const t = act.get(x) ?? act.set(x, { a: 0, best: 0, via, viaChunk, kind }).get(x)!;
    t.a += v;
    if (v > t.best) Object.assign(t, { best: v, via, viaChunk, kind });
  };
  const seedSrc = new Set<number>();
  for (const s of seeds) {
    const r = ids.get(s.chunkId), src = s.sourceId ?? r?.src;
    if (src === undefined) continue;
    seedSrc.add(src);
    const out = arcs(src), part = share(out), via = r?.fid ?? s.chunkId;
    for (const e of out) add(e.to, s.a * part(e), via, s.chunkId, e.kind);
  }
  // the cached graph may predate a hide_as / forget / reject: relay only through sources visible now (targets: the query below)
  const relays = o.hops === 1 ? [] : [...act.keys()].filter((m) => !seedSrc.has(m)); // hops 1 (C2): no relay
  const visible = new Set(relays.length ? (await db.query(`SELECT id::float8 id FROM sources WHERE id = ANY($1::bigint[])
    AND coalesce(hide_as, tool) <> ALL($2::text[]) AND status IS DISTINCT FROM 'rejected'`, [relays, o.hide])).rows.map((r) => r.id) : []);
  for (const [m, x] of [...act].map(([m, x]) => [m, { ...x }] as const)) {
    if (!visible.has(m)) continue;
    const out = arcs(m);
    if (out.length > RELAY_MAX_DEGREE) continue;
    const part = share(out);
    for (const e of out) add(e.to, HOP2 * x.a * part(e), x.via, x.viaChunk, `${x.kind}→${e.kind}`);
  }
  const shown = new Set([...seedSrc, ...exclude.map((id) => ids.get(id)?.src)]);
  const top = [...act].filter(([id, x]) => !shown.has(id) && x.a >= theta).sort((p, q) => q[1].a - p[1].a || p[0] - q[0]).slice(0, limit * 3);
  if (!top.length) return [];
  const { since, until } = dateRange(f.since, f.until);
  const fetchLimit = o.currentProject ? limit * 3 : limit;
  const rows = (await db.query(`
    SELECT o.ord, c.id, c.source_id, c.turn_uuid, c.ts, c.project, c.session_id, c.text, s.tool, s.kind src_kind, s.status,
           fa.fid, fa.kind, fa.project fact_project, fa.superseded_by, fa.review_target, 1 - (c.embedding <=> $12::halfvec) sim
    FROM unnest($1::bigint[], $2::text[]) WITH ORDINALITY o(src, via, ord) JOIN sources s ON s.id = o.src LEFT JOIN facts fa ON fa.source_id = o.src
    CROSS JOIN LATERAL (
      SELECT c.* FROM chunks c WHERE c.source_id = o.src
        AND ($3::text IS NULL OR c.project LIKE '%' || $3 || '%' OR o.src IN (SELECT source_id FROM facts WHERE project LIKE '%' || $3 || '%' OR scope = 'global'))
        AND ($4::timestamptz IS NULL OR c.ts >= $4) AND ($5::timestamptz IS NULL OR c.ts < $5) AND ($6::timestamptz IS NULL OR c.ts < $6)
        AND ($7::timestamptz IS NULL OR c.ts < $7 OR c.project IS DISTINCT FROM $8 OR s.tool <> $9)
      ORDER BY c.embedding <=> coalesce($12::halfvec, (SELECT embedding FROM chunks WHERE id = o.via)) NULLS LAST, c.seq_from, c.id LIMIT 1) c
    WHERE coalesce(s.hide_as, s.tool) <> ALL($10::text[]) AND s.status IS DISTINCT FROM 'rejected'
    ORDER BY o.ord LIMIT $11`,
  [top.map(([id]) => id), top.map(([, x]) => x.viaChunk), f.project?.toLowerCase() || null, since, until, f.before ?? null,
    f.own?.since ?? null, f.own?.project ?? null, f.own?.tool ?? null, o.hide, fetchLimit, o.qvec ?? null])).rows;
  const out = rows.map(({ ord, sim, ...chunk }) => {
    const x = top[Number(ord) - 1][1];
    const scale = isOtherProject(chunk, f.project ? undefined : o.currentProject, o.query) ? RANK.otherProject : 1;
    return { chunk, via: x.via, kind: x.kind, act: x.a * scale, ...(sim != null && { sim: Number(sim) }) };
  });
  return o.currentProject ? out.sort((a, b) => b.act - a.act).slice(0, limit) : out;
}

// Equal-slot competition (memory_search limit > 6; MEMHUB_COMPETE=0 = off). docs/decisions/0004
// The graph adds no lines: it proposes candidates that compete with hits keep+1..n for the same slots.
// no 'next' (3/168 precision), no 2nd hop (0/33); MEMHUB_COMPETE_KINDS = another list (eval arms)
const competeKinds = () => (process.env.MEMHUB_COMPETE_KINDS ?? 'link,spawn,prov,coaccess').split(',').filter(Boolean);

/** Candidates for the last slots: 1-hop neighbours of the top `keep` hits, each as its chunk nearest the query (qvec),
 *  act ≥ theta, at most `pool` by act; plus the query similarity of the chunks of hits keep+1.. (their rivals). */
export async function proposals(db: pg.Pool, hits: Hit[], qvec: string, o: { hide: string[]; filters?: AssocFilters; keep?: number; theta?: number;
  pool?: number; graph?: Graph; currentProject?: string; query?: string }) {
  const { keep = 6, pool = 8 } = o;
  const seeds = hits.slice(0, keep).map((h) => ({ chunkId: h.id, a: h.score / hits[0].score }));
  const [props, sims] = await Promise.all([
    associate(db, seeds, { hide: o.hide, exclude: hits.flatMap((h) => [h.id, ...(h.evidence ?? []).map((e) => e.id)]), filters: o.filters, limit: pool,
      theta: o.theta, graph: o.graph, qvec, kinds: competeKinds(), hops: 1, currentProject: o.currentProject, query: o.query }),
    db.query(`SELECT id, coalesce(1 - (embedding <=> $2::halfvec), 0)::float8 sim FROM chunks WHERE id = ANY($1::text[])`, [hits.slice(keep).map((h) => h.id), qvec])
      .then((r) => new Map<string, number>(r.rows.map((x) => [x.id, x.sim])))]);
  return { props, sims };
}

/** Final list: hits[0..keep) unchanged + the best n − keep of {hits[keep..), proposals with act ≥ theta} by sim + bonus·act − margin
 *  (ties keep the hit). A proposal is printed as an ordinary result (hitText), not a '⇢ linked' line. */
export function compete(hits: Hit[], c: { props: Assoc[]; sims: Map<string, number> }, o: { n?: number; keep?: number; theta?: number; bonus?: number; margin?: number; currentProject?: string; query?: string } = {}): Hit[] {
  const { n = 8, keep = 6, theta = 0, bonus = 0, margin = 0 } = o;
  const scale = (h: Pick<Hit, 'project' | 'fact_project' | 'fid' | 'tool'>) => isOtherProject(h, o.currentProject, o.query) ? RANK.otherProject : 1;
  const rivals = [...hits.slice(keep).map((h) => ({ h, s: (c.sims.get(h.id) ?? 0) * scale(h) })),
    ...c.props.filter((p) => p.act >= theta).map((p) => {
      const h = { ...p.chunk, header: '', score: 0, uses: 0, last: null, changed_to: null, ev_of: null } as Hit;
      return { h, s: ((p.sim ?? 0) + bonus * p.act - margin) * scale(h) };
    })];
  return [...hits.slice(0, keep), ...rivals.sort((x, y) => y.s - x.s).slice(0, Math.max(0, n - keep)).map((x) => x.h)];
}
