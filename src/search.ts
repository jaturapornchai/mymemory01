// Hybrid keyword search, fused with RRF (k=60) in SQL (the keyword legs run while Ollama embeds the query):
//  - words list: candidates = chunks containing any RARE query term, scored by Σ IDF of matched terms (BM25-lite)
//  - bigram list: short Thai/digit runs as exact phrases (ภ.ง.ด.53, ภงด, short words ICU mangles)
//  - vector list: bge-m3 cosine via HNSW (skipped if Ollama is down → keyword-only, never an error)
import type pg from 'pg';
import { embedQuery, toVec } from './embed.ts';
import { PRIVATE_TOOLS } from './guard.ts';
import { projectName } from './importer.ts';
import { bigramQuery, normalize, queryTerms, words } from './thai.ts';

export type Hit = {
  id: string; turn_uuid: string; ts: Date | null; project: string; session_id: string; header: string; text: string; score: number;
  uses: number; last: Date | null; status: string | null;                                     // recalls by distinct sessions
  fid: string | null; kind: string | null; fact_project: string | null; superseded_by: string | null; review_target: string | null;
  changed_to: string[] | null;                                     // raw chat whose fact was later superseded: the current end(s) of the chain
  src_kind: string;                        // main | subagent | headless | note | doc
  tool: string;                            // claude | codex | … | obsidian | github
  ev_of: string[] | null;                  // raw chat: ids of candidate facts distilled from its turns
  evidence?: Hit[];                        // fact: its source chat chunks among the results (shown under it, no slot of their own)
};
export type Result = { hits: Hit[]; semantic: boolean }; // semantic=false → vector leg skipped (keyword-only)
// before: hide chunks newer than this (the caller's own live session is already in its context).
export type SearchOpts = { project?: string; since?: string; limit?: number; currentProject?: string; before?: Date; semantic?: boolean; perSession?: number;
  tier?: number;      // priority boost τ (default RANK.tier); dream's neighbour lookup passes 0 = pure similarity
  showPrivate?: boolean }; // include PRIVATE_TOOLS (Gmail/Docs/Maps timeline): only for a caller guard.privateOk allows

const EMBED_TIMEOUT_MS = 300; // hot path: GPU busy → keyword-only rather than stall Claude (a cold model is waited for: embedQuery)
const PER_SESSION = 3;       // diversity: a long session must not fill every slot (eval: 3 keeps R@10 = uncapped, 2 costs ~5 pts)

// Bounded priors on the RRF score (RRF gaps between neighbouring ranks are only ~2-3 %, so they must stay mild):
//   final = max(base, base of its source chats) · (1 + τ)^tier,   base = rrf · proj · (1 + β·p) · status
//   p = 1 − (1 − p_use)(1 − p_imp)            (noisy-or)
//   p_use = S/(S+1),  S = t1^−0.5 + (n>0 ∧ tn>t1 ? 2n/(√tn+√t1) : 0)   ACT-R base level (Petrov k=1): recency + frequency
//     t1 = days since last reference (content time or last recall), tn = days since content time, n = sessions that recalled it
//   p_imp = 1 for pinned / rule / feedback facts, (importance−1)/9 for other facts, 0 for raw chats/notes/cards
//   status: superseded ×0.5, pending ×0.8, rejected excluded.  Design + sources: docs/research/phase4-design.md §2
//   tier (priority order, ลุงจืด 2026-10-02): rule/feedback/pinned/hand-saved +2 · other facts +1 · cards, chats of any app
//     and kind, GitHub docs (repo card/commits/issues), Obsidian notes, superseded facts 0.  τ = 0.1 → ×1.21: a chat found by more legs still wins.  Eval (tune split):
//     boosting cards pushed the exact turn below its session summary; boosting OLD facts put more of them in the top 10;
//     down-weighting subagent/headless runs (−1/−2) lost 3 of 10 questions whose answer lives in such a run.
//   curated slot: the best active non-card fact among the top 24 rows scoring ≥ slotRatio × the top result moves up to
//     position `slot` (2) — at limit 3 a rule/fact is visible without pushing the exact chat turn off #1.  Eval (tune):
//     slot 1 cost cross-app R@1 42→31; ratio 0.5 ≥ 0.6 ≥ 0.7 for facts, chats unchanged.
//   source chats: an active non-card fact scores at least its best source turn when both are candidates (its evidence
//     matched the query); a chat lifts only its best-matching fact (siblings keep their own score). search() then shows
//     the chat under that fact (↳) instead of as a separate slot — unless it would get a slot here anyway and mostly says
//     something else (foldDup). Eval (tune): foldDup 0 (always fold) → 0.35 → 0.5: raw ans@w 63.9 → 66.4 → 66.5, direct R@5
//     61.5 → 78.8 → 78.8; fact/currency unchanged. Known cost: a lifting chat that keeps its own slot counts twice (fact
//     + chat) — raw holdout direct R@1 38 → 29 vs the pre-priority order. Tried on tune, rejected: lift × overlap/foldDup
//     (fact R@1 50 → 36, currency pass 90 → 80); always fold at limit ≤ 3 / ≤ 5 (raw ans@w 66.5 → 65.7 / 64.3).
export const RANK = {
  beta: Number(process.env.MEMHUB_RANK_BETA ?? 0.05),
  tier: Number(process.env.MEMHUB_RANK_TIER ?? 0.1),
  superseded: Number(process.env.MEMHUB_RANK_SUPERSEDED ?? 0.5),
  pending: 0.8,
  slot: Number(process.env.MEMHUB_RANK_SLOT ?? 2),
  slotRatio: Number(process.env.MEMHUB_RANK_SLOT_RATIO ?? 0.5),
  foldDup: Number(process.env.MEMHUB_RANK_FOLD_DUP ?? 0.5), // a source chat repeating ≥ this share of its fact (char 5-grams) folds
};

const LATIN = /^[a-z][a-z0-9_]{2,}$/;
const RARE_FRACTION = 0.05; // terms in >5% of chunks don't select candidates (they still add score)

// Keyword legs, run while Ollama embeds the query: $1 words tsquery, $2 bigram tsquery, $3 project, $4 since, $5 before,
// $6/$7 every query term's tsquery / IDF, $8 tools to hide.
const PF = `pf AS (SELECT source_id FROM facts WHERE $3::text IS NOT NULL AND (project LIKE '%' || $3 || '%' OR scope = 'global'))`;
// hidden sources (PRIVATE_TOOLS for a non-Claude caller) leave every leg, so they never take one of its 60 candidate slots
const HIDE = (p: string) => `hide AS (SELECT id FROM sources WHERE coalesce(hide_as, tool) = ANY(${p}::text[]))`; // hide_as: importer.indexFile
const SQL_KEYWORD = `
WITH ${PF}, ${HIDE('$8')},
w AS (
  SELECT id, row_number() OVER (ORDER BY s DESC, ts DESC) r FROM (
    SELECT id, ts, (SELECT sum(x.idf) FROM unnest($6::tsquery[], $7::float8[]) x(q, idf) WHERE words @@ x.q) s
    FROM chunks
    WHERE $1::text IS NOT NULL AND words @@ $1::tsquery
      AND ($3::text IS NULL OR project LIKE '%' || $3 || '%' OR source_id IN (SELECT pf.source_id FROM pf)) AND ($4::timestamptz IS NULL OR ts >= $4) AND ($5::timestamptz IS NULL OR ts < $5)
      AND source_id NOT IN (SELECT id FROM hide)
  ) z ORDER BY r LIMIT 60),
b AS (
  SELECT id, row_number() OVER (ORDER BY ts_rank_cd(bigrams, $2::tsquery, 1) DESC, ts DESC) r
  FROM chunks
  WHERE $2::text IS NOT NULL AND bigrams @@ $2::tsquery
    AND ($3::text IS NULL OR project LIKE '%' || $3 || '%' OR source_id IN (SELECT pf.source_id FROM pf)) AND ($4::timestamptz IS NULL OR ts >= $4) AND ($5::timestamptz IS NULL OR ts < $5)
    AND source_id NOT IN (SELECT id FROM hide)
  ORDER BY r LIMIT 60)
SELECT 'w' leg, id, r FROM w UNION ALL SELECT 'b', id, r FROM b`;

// Vector leg + RRF + priors. The keyword legs come in as (id, rank) arrays in the slots SQL_KEYWORD's own inputs had:
// $1/$2 words, $8/$9 bigrams; $15 tools to hide (the keyword legs already left them out).
const SQL = `
WITH ${PF}, ${HIDE('$15')},
w AS (SELECT * FROM unnest($1::text[], $2::bigint[]) x(id, r)),
b AS (SELECT * FROM unnest($8::text[], $9::bigint[]) x(id, r)),
v AS (
  SELECT id, row_number() OVER (ORDER BY d) r FROM (
    SELECT id, embedding <=> $10::halfvec d FROM chunks
    WHERE $10::text IS NOT NULL AND embedding IS NOT NULL
      AND ($3::text IS NULL OR project LIKE '%' || $3 || '%' OR source_id IN (SELECT pf.source_id FROM pf)) AND ($4::timestamptz IS NULL OR ts >= $4) AND ($7::timestamptz IS NULL OR ts < $7)
      AND source_id NOT IN (SELECT id FROM hide)
    ORDER BY embedding <=> $10::halfvec LIMIT 60) s),
f AS (SELECT id, sum(1.0 / (60 + r)) s FROM (SELECT * FROM w UNION ALL SELECT * FROM b UNION ALL SELECT * FROM v) x GROUP BY id),
u AS (SELECT c.id, count(DISTINCT a.session) n, max(a.ts) last  -- recalls keyed by turn (stable across re-chunking)
      FROM f JOIN chunks c USING (id) JOIN access_log a ON a.turn_uuid = c.turn_uuid
      WHERE a.kind IN ('get', 'related') AND a.ts < coalesce($7, now()) GROUP BY c.id),
x AS (
  SELECT c.id, c.turn_uuid, c.ts, c.project, c.session_id, c.ctx_header AS header, c.text, c.source_id, c.seq_from, c.seq_to, s.status, s.tool,
         s.kind src_kind, coalesce(u.n, 0)::int uses, u.last, fa.fid, fa.kind, fa.project fact_project, fa.superseded_by, fa.review_target,
         fa.source_uuids, f.s rrf,
         CASE WHEN fa.fid IS NULL OR fa.kind = 'card' OR s.status = 'superseded' THEN 0
              WHEN fa.pinned OR fa.user_owned OR fa.run IS NULL OR fa.kind IN ('rule', 'feedback') THEN 2 ELSE 1 END tier,
         CASE WHEN $5::text <> '' AND (c.project = $5 OR fa.project = $5) THEN 1.3 ELSE 1 END proj,
         greatest(extract(epoch FROM coalesce($7, now()) - greatest(c.ts, u.last)) / 86400, 1.0 / 24) t1,
         greatest(extract(epoch FROM coalesce($7, now()) - c.ts) / 86400, 1.0 / 24) tn,
         CASE WHEN fa.pinned OR fa.kind IN ('rule', 'feedback') THEN 1
              WHEN fa.kind IN ('decision', 'preference', 'fact', 'howto', 'insight') THEN (coalesce(fa.importance, 5) - 1) / 9.0 ELSE 0 END p_imp
  FROM f JOIN chunks c USING (id) JOIN sources s ON s.id = c.source_id
  LEFT JOIN u ON u.id = c.id LEFT JOIN facts fa ON fa.source_id = c.source_id
  WHERE s.status IS DISTINCT FROM 'rejected'),
y AS (SELECT x.*, rrf * proj * (1 + $11::float8 * (1 - (1 - sa / (sa + 1)) * (1 - p_imp)))
                  * CASE status WHEN 'superseded' THEN $12::float8 WHEN 'pending' THEN $13::float8 ELSE 1 END base
      FROM (SELECT x.*, power(t1, -0.5) + CASE WHEN uses > 0 AND tn > t1 THEN 2 * uses / (sqrt(tn) + sqrt(t1)) ELSE 0 END sa FROM x) x),
ev AS (  -- candidate raw chat → the best candidate active fact distilled from its turns (one per chat: no sibling lift)
  SELECT DISTINCT ON (ry.id) fy.id fact_id, ry.id raw_id, ry.base FROM y fy CROSS JOIN unnest(fy.source_uuids) su(uuid) JOIN turns t ON t.uuid = su.uuid
  JOIN y ry ON ry.source_id = t.source_id AND t.seq BETWEEN ry.seq_from AND ry.seq_to AND ry.fid IS NULL AND ry.tool <> 'obsidian'
  WHERE fy.kind <> 'card' AND coalesce(fy.status, 'active') = 'active'
  ORDER BY ry.id, fy.base DESC, fy.id),
z AS (SELECT y.*, greatest(base, (SELECT max(e.base) FROM ev e WHERE e.fact_id = y.id)) * power(1 + $14::float8, tier) score,
             (SELECT array_agg(DISTINCT e.fact_id) FROM ev e WHERE e.raw_id = y.id) ev_of FROM y),
sup AS (SELECT fx.fid, fx.superseded_by nxt, fx.source_uuids FROM facts fx JOIN sources sx ON sx.id = fx.source_id
        WHERE sx.status = 'superseded' AND fx.superseded_by IS NOT NULL)
SELECT y.id, y.turn_uuid, y.ts, y.project, y.session_id, y.header, y.text, y.status, y.src_kind, y.tool, y.uses, y.last, y.fid, y.kind, y.fact_project,
       y.superseded_by, y.review_target, y.score, y.ev_of,
       CASE WHEN y.tool <> 'obsidian' THEN (  -- a later-superseded fact never down-ranks its source chats, only annotates them
         WITH RECURSIVE ch(fid, d) AS (       -- with the current END of each supersede chain (A → B → C: C, never the OLD B)
           SELECT nxt, 1 FROM sup WHERE source_uuids && (
             SELECT array_agg(uuid) FROM turns WHERE source_id = y.source_id AND seq BETWEEN y.seq_from AND y.seq_to)
           UNION SELECT sup.nxt, ch.d + 1 FROM ch JOIN sup USING (fid) WHERE ch.d < 8)
         SELECT array_agg(DISTINCT fid ORDER BY fid) FROM ch WHERE fid NOT IN (SELECT fid FROM sup)) END changed_to
FROM z y
ORDER BY score DESC, tier DESC, y.ts DESC
LIMIT $6`;

export async function search(db: pg.Pool, query: string, o: SearchOpts = {}): Promise<Result> {
  const limit = Math.min(Math.max(o.limit ?? 6, 1), 20); // MCP schema caps callers at 8; eval uses up to 20
  const terms = queryTerms(query);
  const vec = o.semantic === false ? null : embedQuery(query, EMBED_TIMEOUT_MS).then((e) => e && toVec(e));
  // One round trip: corpus size, document frequencies, and English stems (redaction → redact:* also finds redacted).
  // Corpus stats leave PRIVATE_TOOLS out (here and in term_df): Claude-only data never shifts another app's ranking.
  const latin = terms.filter((t) => LATIN.test(t.key)).map((t) => t.key);
  const st = (await db.query(
    `WITH st AS (SELECT w, (ts_lexize('english_stem', w))[1] s FROM unnest($2::text[]) w)
     SELECT greatest((SELECT reltuples FROM pg_class WHERE oid = 'chunks'::regclass)
              - (SELECT count(*) FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE coalesce(hide_as, tool) = ANY($3::text[]))), 1)::float8 n,
            coalesce((SELECT json_object_agg(word, ndoc) FROM term_df WHERE word = ANY($1::text[] || ARRAY(SELECT s FROM st))), '{}') df,
            coalesce((SELECT json_object_agg(w, s) FROM st WHERE s IS NOT NULL AND s <> w AND length(s) >= 3), '{}') stems`,
    [terms.map((t) => t.key), latin, [...PRIVATE_TOOLS]],
  )).rows[0];
  const n: number = st.n;
  // Unknown to term_df = newer than the last refresh → treat as rare.
  const scored = terms.map((t) => {
    const stem: string | undefined = st.stems[t.key];
    const df = Math.min(Math.max(st.df[t.key] ?? 0, stem ? st.df[stem] ?? 0 : 0) || 1, n);
    const lit = stem ? `'${stem}':*` : t.lit; // stems are [a-z0-9_] only → safe to quote directly
    return { ...t, lit, df, idf: Math.log(1 + (n - df + 0.5) / (df + 0.5)) };
  });
  let cand = scored.filter((t) => t.df <= Math.max(50, RARE_FRACTION * n));
  if (!cand.length) cand = [...scored].sort((a, b) => a.df - b.df).slice(0, 3);
  const wq = cand.length ? cand.map((t) => t.lit).join(' | ') : null;

  const project = o.project?.toLowerCase() || null, since = o.since || null, before = o.before ?? null;
  const hide = o.showPrivate ? [] : [...PRIVATE_TOOLS];
  const [legs, v] = await Promise.all([db.query(SQL_KEYWORD, [wq, bigramQuery(query), project, since, before,
    scored.map((t) => t.lit), scored.map((t) => t.idf), hide]), vec]);
  const w = legs.rows.filter((r) => r.leg === 'w'), b = legs.rows.filter((r) => r.leg === 'b');
  const rows = (await db.query(SQL, [
    w.map((r) => r.id), w.map((r) => r.r), project, since, o.currentProject ?? '', Math.max(limit, 8) * 3, // ≥ 24 rows: same curated slot at every limit
    before, b.map((r) => r.id), b.map((r) => r.r), v,
    RANK.beta, RANK.superseded, RANK.pending, o.tier ?? RANK.tier, hide,
  ])).rows;
  const ci = rows.slice(0, 24).findIndex((r) => r.fid && r.kind !== 'card' && (r.status ?? 'active') === 'active');
  if (ci >= RANK.slot && Number(rows[ci].score) >= RANK.slotRatio * Number(rows[0].score)) rows.splice(RANK.slot - 1, 0, ...rows.splice(ci, 1));
  const perSession = new Map<string, number>();
  const hits: Hit[] = [];
  for (const r of rows) {
    // dedupe: a fact ranks at or above its own source chats (tier ≥ 1 > chat tiers) → attach them to it instead of a slot,
    // except a chat that would get a slot anyway and mostly says something else (judge-03: folding cut half the answer)
    const fact = r.ev_of && hits.find((h) => r.ev_of.includes(h.id));
    const n = perSession.get(r.session_id) ?? 0;
    const room = hits.length < limit && n < (o.perSession ?? PER_SESSION);
    if (fact && !(room && overlap(snippet(r.text, query), fact.text) < RANK.foldDup)) {
      (fact.evidence ??= []).push({ ...r, score: Number(r.score) }); perSession.set(r.session_id, n + 1); continue; // still counts toward the cap
    }
    if (!room) continue; // full: keep scanning only to attach source chats
    perSession.set(r.session_id, n + 1);
    hits.push({ ...r, score: Number(r.score) });
  }
  return { hits, semantic: v !== null };
}

/** Share of a's character 5-grams (whitespace dropped, normalized) that also occur in b — Thai has no word spaces. */
function overlap(a: string, b: string): number {
  const grams = (s: string) => { const t = normalize(s).replace(/\s+/g, ''); return new Set(Array.from({ length: Math.max(0, t.length - 4) }, (_, i) => t.slice(i, i + 5))); };
  const ga = grams(a), gb = grams(b);
  let n = 0;
  for (const g of ga) n += gb.has(g) ? 1 : 0;
  return ga.size ? n / ga.size : 1;
}

/** Recompute document frequencies (after bulk import; cheap enough to skip on per-session ingest). */
export async function refreshTermDf(db: pg.Pool) {
  await db.query(`BEGIN; TRUNCATE term_df;
    INSERT INTO term_df SELECT word, ndoc FROM ts_stat('SELECT words FROM chunks WHERE source_id NOT IN
      (SELECT id FROM sources WHERE coalesce(hide_as, tool) IN (${[...PRIVATE_TOOLS].map((t) => `''${t}''`).join(', ')}))');
    COMMIT; ANALYZE chunks; ANALYZE term_df;`);
}

/** ≤ max chars around the first query term, whitespace collapsed. */
export function snippet(text: string, query: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const low = normalize(flat);
  const terms = words(query).sort((a, b) => b.length - a.length);
  const at = terms.map((t) => low.indexOf(t)).find((i) => i >= 0) ?? 0;
  const start = Math.max(0, Math.min(at - Math.floor(max / 4), flat.length - max));
  return (start > 0 ? '…' : '') + flat.slice(start, start + max) + (start + max < flat.length ? '…' : '');
}

export const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : '????-??-??');
/** Compact age: 5h, 19d, 7mo, 1.5y. */
export function age(d: Date | null, now = Date.now()): string {
  if (!d) return '?';
  const days = (now - new Date(d).getTime()) / 864e5;
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  if (days < 60) return `${Math.round(days)}d`;
  if (days < 730) return `${Math.round(days / 30.4)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}
/** What a Claude-only hit is: google = Gmail thread (gmail:<id>, google/gmail) / Google Sheets (gsheet:) / Google Docs. */
export const privateLabel = (h: Pick<Hit, 'tool' | 'project' | 'session_id'>) => h.tool === 'google-timeline' ? 'Google Maps timeline'
  : ((k) => (/gmail/.test(k) ? 'Gmail' : /sheet/.test(k) ? 'Google Sheets' : 'Google Docs'))(`${h.project} ${h.session_id.split(':')[0]}`);
/** `[id] 2026-09-12 19d proj-a | decision cur | used 7x, last 2d` — old vs new and how often it was recalled. */
export function hitLine(h: Hit, now = Date.now()): string {
  const proj = projectName(h.fact_project ?? h.project ?? '') || 'global';
  let what = h.kind ? (h.kind === 'card' ? 'session card' : h.kind) : PRIVATE_TOOLS.has(h.tool) ? privateLabel(h) : h.project?.startsWith('obsidian/') ? 'note'
    : h.tool === 'github' ? `github ${/#\d+$/.test(h.session_id) ? 'issue/PR' : h.session_id.endsWith(':commits') ? 'commits' : 'repo'}`
    : h.src_kind === 'subagent' || h.src_kind === 'headless' ? `${h.src_kind} chat` : 'chat';
  if (h.status === 'superseded') what += ` OLD -> [${h.superseded_by ?? '?'}]`;
  else if (h.status === 'pending') what += ` PENDING-REVIEW vs [${h.review_target ?? '?'}]`;
  else if (h.kind && h.kind !== 'card' && h.kind !== 'insight') what += ' cur';
  if (h.changed_to) what += ` (decision here later changed -> [${h.changed_to.join('] [')}])`;
  const parts = [`[${h.fid && h.kind !== 'card' ? h.fid : h.id}] ${day(h.ts)} ${age(h.ts, now)} ${proj}`, what];
  if (h.uses > 0) parts.push(`used ${h.uses}x, last ${age(h.last, now)}`);
  return parts.join(' | ');
}
