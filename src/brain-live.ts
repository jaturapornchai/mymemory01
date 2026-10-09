// Local viewer only (brain-serve on 127.0.0.1, never published): what each MCP call did, for the brain view's neural
// light. Queries are ลุงจืด's own words; a call that touched a Claude-only (Google) source shows no query and no node.
import type pg from 'pg';
import { PRIVATE_TOOLS } from './guard.ts';
import { HIDDEN, hiddenNameMask, search, unfamiliar } from './search.ts';
import { associate } from './synapse.ts';

export type HitType = 'rule' | 'fact' | 'chat' | 'note' | 'github' | 'daily' | 'private';
export type LiveHit = { type: HitType; node: string | null; label?: string };
export type LiveCall = { t: number; kind: string; client: string | null; project: string | null; query: string | null; ms: number | null; hits: LiveHit[] };

const PROCEDURAL = new Set(['rule', 'feedback', 'howto']);
export function hitType(factKind: string | null, tool: string | null, srcKind: string | null): HitType {
  if (tool && PRIVATE_TOOLS.has(tool)) return 'private';
  if (factKind && factKind !== 'card') return PROCEDURAL.has(factKind) ? 'rule' : 'fact'; // a card sums up one chat: episodic
  if (tool === 'obsidian') return srcKind === 'daily' ? 'daily' : factKind ? 'chat' : 'note';
  if (tool === 'github') return 'github';
  return 'chat';
}

/** MCP calls logged after `after`, oldest first. One call = one access_log INSERT = one now(), a row per returned chunk. */
export async function liveCalls(db: pg.Pool, after: Date, nodeOf: (sourceId: string) => string | null): Promise<LiveCall[]> {
  const rows = (await db.query(`
    SELECT a.ts, a.kind, a.client, a.project, a.query, a.ms, s.id::text sid, s.tool, s.kind src_kind, f.kind fact_kind
    FROM access_log a LEFT JOIN turns u ON u.uuid = a.turn_uuid LEFT JOIN sources s ON s.id = u.source_id
    LEFT JOIN LATERAL (SELECT kind FROM facts WHERE source_id = s.id LIMIT 1) f ON true
    WHERE a.ts > $1 ORDER BY a.ts, a.rank NULLS LAST LIMIT 2000`, [after])).rows;
  const calls = new Map<string, LiveCall>();
  for (const r of rows) {
    const key = `${+r.ts}|${r.kind}`;
    let c = calls.get(key);
    if (!c) calls.set(key, (c = { t: +r.ts, kind: r.kind, client: r.client, project: r.project, query: r.query, ms: r.ms, hits: [] }));
    const type = hitType(r.fact_kind, r.tool, r.src_kind);
    c.hits.push({ type, node: type === 'private' || !r.sid ? null : nodeOf(r.sid) });
  }
  for (const c of calls.values()) if (c.hits.some((h) => h.type === 'private')) c.query = null;
  return [...calls.values()];
}

// which part of search() a SQL statement belongs to (same split as tmp/neural/gates/speed/breakdown.ts)
const stageOf = (sql: string) => (sql.includes('ts_lexize') || (sql.includes('leg') && sql.includes('bigrams')) ? 'keyword'
  : sql.includes('embedding <=>') ? (sql.includes('LATERAL') ? 'synapse' : 'vector') : 'other');

/**
 * One search like memory_search's default (6 hits; synapse competition only runs above 6) for a caller with no project (no
 * ×1.3 own-project boost) and no private access, not logged: no access_log row, so no ACT-R/Hebbian effect. Returns the time each stage spent in SQL and, for the test-ask log, what each step saw.
 * `db` must be this function's own pool: its query is wrapped once.
 * ponytail: one shared stage counter — two concurrent traces mix their stage times; a per-call pool if that ever matters.
 */
export function tracer(db: pg.Pool) {
  let stages: Record<string, number> = {};
  const query = db.query.bind(db) as (...a: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  (db as unknown as { query: unknown }).query = async (sql: unknown, ...rest: unknown[]) => {
    const t0 = performance.now();
    try { return await query(sql, ...rest); } finally {
      const k = stageOf(String((sql as { text?: string })?.text ?? sql));
      stages[k] = (stages[k] ?? 0) + performance.now() - t0;
    }
  };
  return async (q: string, nodeOf: (sourceId: string) => string | null) => {
    stages = {};
    const t0 = performance.now();
    // the default run decides (fold / cap / full / evidence exactly as memory_search's 6); a wider run, not timed, only lists
    // more candidates: its rows past the ones the default run looked at are 'out'
    const r = await search(db, q, { limit: AI_HITS, explain: true });
    const ms = performance.now() - t0, spent = { ...stages }, x = r.explain!;
    const wide = (await search(db, q, { limit: WIDE, explain: true })).explain!.rows, decided = new Map(x.rows.map((row) => [row.id, row.why]));
    // neural links from the top 3 answers, to memories the search did not score (memory_search's ⇢ linked, off there by default)
    const s0 = performance.now();
    const linked = r.hits.length ? await associate(db, r.hits.slice(0, 3).map((h) => ({ chunkId: h.id, a: h.score / r.hits[0].score })),
      { hide: [...PRIVATE_TOOLS], exclude: wide.map((row) => row.id), qvec: r.qvec, limit: LINKED }).catch(() => []) : [];
    const synapse = performance.now() - s0;
    // the vector leg's top 60 as search()'s v CTE ranks them for these options (no project / date / own filter), not timed
    const vec = r.qvec ? (await query(`SELECT id, 1 - (embedding <=> $1::halfvec) cos FROM chunks WHERE embedding IS NOT NULL
      AND source_id NOT IN (${HIDDEN('$2')}) ORDER BY embedding <=> $1::halfvec LIMIT 60`, [r.qvec, [...PRIVATE_TOOLS]])).rows : [];
    const vecR = new Map(vec.map((v, i) => [v.id as string, { r: i + 1, cos: round(Number(v.cos)) }]));
    const kwR = new Map(x.kw), biR = new Map(x.bi), hitAt = new Map(r.hits.map((h, i) => [h.id, i]));
    const viaAt = new Map(r.hits.slice(0, 3).flatMap((h, i): [string, number][] => [[h.id, i], ...(h.fid ? [[h.fid, i] as [string, number]] : [])])); // associate: via = fact id or chunk id
    const top = (legs: [string, number][]) => [...legs].sort((a, b) => a[1] - b[1]).slice(0, LEG_TOP);
    const tops = { kw: top(x.kw), bi: top(x.bi), vec: vec.slice(0, LEG_TOP).map((v, i): [string, number] => [v.id as string, i + 1]) };
    const ids = [...new Set([...wide.map((row) => row.id), ...linked.map((a) => a.chunk.id), ...Object.values(tops).flat().map(([id]) => id)])];
    const info = new Map((await query(`SELECT c.id, c.source_id::text sid, coalesce(nullif(c.ctx_header, ''), c.text) label, s.tool, s.kind src_kind,
        s.status, (SELECT kind FROM facts WHERE source_id = s.id LIMIT 1) fact_kind
      FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.id = ANY($1)`, [ids])).rows.map((c) => [c.id as string, c]));
    const mask = await hiddenNameMask(db, [...PRIVATE_TOOLS]); // a visible note may name a hidden one in a link
    const item = (id: string) => {
      const c = info.get(id), type = c ? hitType(c.fact_kind as string | null, c.tool as string, c.src_kind as string) : 'chat';
      return { type, node: c && type !== 'private' ? nodeOf(c.sid as string) : null, label: c ? mask(String(c.label)).slice(0, LABEL) : '',
        status: (c?.status as string | null) ?? null };
    };
    const ranks = (id: string) => ({ kw: kwR.get(id) ?? null, bi: biR.get(id) ?? null, vec: vecR.get(id)?.r ?? null, cos: vecR.get(id)?.cos ?? null });
    const leg = (n: number, t: [string, number][]) => ({ n, top: t.map(([id, rank]) => ({ ...item(id), r: rank, cos: vecR.get(id)?.cos ?? null })) });
    const sql = Object.values(spent).reduce((a, b) => a + b, 0);
    const rows = wide.map((row) => {
      const at = hitAt.get(row.id), why = decided.get(row.id) ?? 'out';
      return { ...item(row.id), ...ranks(row.id), score: round(row.score), id: row.id,
        why: why === 'hit' ? 'ai' : why, ev: at === undefined ? 0 : r.hits[at].evidence?.length ?? 0 };
    });
    return {
      q, ms: Math.round(ms), semantic: r.semantic, unfamiliar: unfamiliar(r.signal), // same "ไม่รู้" rule as memory_search
      // embed runs beside the keyword legs (not SQL): the wall time no SQL explains; synapse = the link step after search()
      stages: { embed: Math.max(0, Math.round(ms - sql)), ...Object.fromEntries(Object.entries(spent).map(([k, v]) => [k, Math.round(v)])), synapse: Math.round(synapse) },
      hits: r.hits.map((h) => rows.find((row) => row.id === h.id) ?? { ...item(h.id), id: h.id }), // what the AI gets by default
      explain: { corpus: Math.round(x.corpus), time: x.time, terms: x.terms, unseen: x.unseen, fused: x.fused, signal: r.signal ?? null,
        kw: leg(x.kw.length, tops.kw), bi: leg(x.bi.length, tops.bi), vec: leg(vec.length, tops.vec), rows,
        linked: linked.map((a) => ({ ...item(a.chunk.id), via: (viaAt.get(a.via) ?? -1) + 1, kind: a.kind, act: round(a.act), sim: a.sim === undefined ? null : round(a.sim) })) },
    };
  };
}
const AI_HITS = 6, WIDE = 20, LINKED = 8, LEG_TOP = 10, LABEL = 160; // AI_HITS = memory_search's default limit (mcp.ts); WIDE: its SQL looks at 60
const round = (v: number) => Math.round(v * 1e4) / 1e4;
