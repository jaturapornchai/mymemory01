// Hybrid keyword search, fused with RRF (k=60) in SQL (the keyword legs run while Ollama embeds the query):
//  - words list: candidates = chunks containing any RARE query term, scored by Σ IDF of matched terms (BM25-lite)
//  - bigram list: short Thai/digit runs as exact phrases (ภ.ง.ด.53, ภงด, short words ICU mangles)
//  - vector list: bge-m3 cosine via HNSW (skipped if Ollama is down → keyword-only, never an error)
// then priors and a soft boost for relative time in the query (timeWindow)
import type pg from 'pg';
import { embedQuery, toVec } from './embed.ts';
import { PRIVATE_TOOLS } from './guard.ts';
import { catchAll, CMD_LINE, projectName, projectTree, sameTree } from './importer.ts';
import { bigramQuery, normalize, queryTerms, words } from './thai.ts';

export type Hit = {
  id: string; turn_uuid: string; ts: Date | null; project: string; session_id: string; header: string; text: string; score: number;
  uses: number; last: Date | null; status: string | null;                                     // recalls by distinct sessions
  fid: string | null; kind: string | null; fact_project: string | null; superseded_by: string | null; review_target: string | null;
  changed_to: string[] | null;                                     // raw chat whose fact was later superseded: the current end(s) of the chain
  src_kind: string;                        // main | subagent | headless | note | daily | doc
  tool: string;                            // claude | codex | … | obsidian | github
  ev_of: string[] | null;                  // raw chat: ids of candidate facts distilled from its turns
  evidence?: Hit[];                        // fact: its source chat chunks among the results (shown under it, no slot of their own)
  flags?: string[]; notes?: string[];      // accuracy.ts flagsFor (memory_search): CONFLICT / STALE / pending fix tags; note + alias lines
  layer?: Layer; why?: string;             // layers(): what the calling AI may do with it, and the verdict behind a ✗ / a warning
};
/** use = ✓ใช้ได้ (a current curated fact of this project tree or global: decide from it), memo = บันทึก (chats, cards, notes,
 *  repos, pending fixes, other projects: what happened, evidence), old = ✗เลิกใช้ (replaced or outdated: do not follow). */
export type Layer = 'use' | 'memo' | 'old';
/** familiarity of a query (metamemory, not used by ranking): cosine of vector hit 1 / 10 / mean of the top 60, the best keyword
 *  chunk's share of the query's IDF, and the IDF share of Latin words no visible chunk has ever held. Only for a query that names a
 *  catalogued project (h = 1): agree = how many of the vector top 10 are also in the words top 60, pun = IDF share of its other
 *  terms that project's chunks never hold. Optional: a Signal without them is h = 0 (the first rule alone). */
export type Signal = { cos1: number | null; cos10: number | null; cosMean: number | null; kw: number; unseen: number; agree?: number; pun?: number; h?: 0 | 1 };
// "ไม่รู้" rule (tmp/abstain2: PREREG.md, fit-final.ts, holdout.ts): logistic fit on eval questions + real memory_search queries judged
// by 2 blind judges vs off-domain / invented-name / unseen-topic queries; threshold = ≤ 5 % of answerable flagged in BOTH groups.
// Round 2 holdout 2026-10-06 (read once): 1.6 % wrong on real answerable queries, invented names 61 %, off-domain 85 %, but a real
// project + a topic never discussed in it only 46 % (the project name alone makes every vector/keyword feature look familiar).
// Round 3 (tmp/abstain3: PREREG.md, r3.json, holdout.ts): UNFAMILIAR = that rule refit on all tune; UNFAMILIAR_NAMED fires only when the
// query names a catalogued project and adds agree + pun, fitted on the 617 project-naming tune rows. Fresh holdout 2026-10-08 (read once,
// "then" regime = unseen/pun as of each item's time) vs the round-2 rule: real project + new topic caught 85.3 → 95.5 % (McNemar p = 1.5e-4);
// wrong ไม่รู้ on new questions 2.6 → 4.7 % (bar 5 %), on real answerable queries 6.3 → 3.2 %; invented names 82.2 → 67.8 % (= the refit alone,
// the price of the recalibration); off-domain 81.5 % unchanged.
const UNFAMILIAR = { b: -10.6052, cos1: 17.874162, cos10: 6.557755, cosMean: -9.793096, kw: 6.865481, unseen: -9.095657 };
const UNFAMILIAR_NAMED = { b: -10.133143, cos1: 37.364348, cos10: 0.408989, cosMean: -24.840211, kw: 5.859402, unseen: -2.582439, agree: 0.329367, pun: -4.159387 };
/** true = memory has nothing on this query ("ไม่รู้"). Keyword-only search (no vector evidence) never says so. */
export function unfamiliar(s?: Signal): boolean {
  if (!s || s.cos1 === null || s.cosMean === null) return false;
  const cos1 = s.cos1, cosMean = s.cosMean, cos10 = s.cos10 ?? cosMean, { kw, unseen } = s; // locals: the null guard above does not reach into the closure
  const lin = (u: typeof UNFAMILIAR) => u.b + u.cos1 * cos1 + u.cos10 * cos10 + u.cosMean * cosMean + u.kw * kw + u.unseen * unseen;
  return lin(UNFAMILIAR) < 0 || (s.h === 1 && lin(UNFAMILIAR_NAMED) + UNFAMILIAR_NAMED.agree * (s.agree ?? 0) + UNFAMILIAR_NAMED.pun * (s.pun ?? 0) < 0);
}
export type Result = { hits: Hit[]; semantic: boolean; qvec?: string | null; signal?: Signal; explain?: Explain }; // semantic=false → vector leg skipped (keyword-only); qvec = the query embedding (halfvec text)
// before: hide chunks newer than this, from every app; also the recency anchor (eval: the frozen clock).
// own: hide only the caller's own live session — chunks newer than own.since from sources of own.tool in own.project;
//   other apps and the same app's other projects stay findable (before would hide them too).
// since/until: ISO dates (dateRange), a hard filter in every leg.
export const SEARCH_KINDS = ['rule', 'feedback', 'decision', 'preference', 'howto', 'fact', 'card', 'insight', 'chat', 'note'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export type SearchOpts = { project?: string; since?: string; until?: string; asOf?: string; kind?: string; limit?: number; currentProject?: string; before?: Date; semantic?: boolean; perSession?: number;
  own?: { since: Date; tool: string; project: string };
  tier?: number;      // priority boost τ (default RANK.tier); dream's neighbour lookup passes 0 = pure similarity
  now?: Date;         // anchor of relative time in the query (timeWindow); default before ?? now (eval: the frozen clock)
  showPrivate?: boolean;   // include PRIVATE_TOOLS (Gmail/Docs/Maps timeline): only for a caller guard.privateOk allows
  explain?: boolean };     // brain view's test ask (brain-live.ts tracer): also return what each step saw; the MCP never sets it
/** what search() saw on the way (explain only): the query's terms (df = chunks holding it; used = rare enough for the words leg),
 *  Latin words no visible chunk holds, the time phrase, each keyword leg's [chunk id, rank], and every row scored after RRF in
 *  rank order with why it got no slot: fold:<fact> (attached under that fact), cap (per-session cap), full (limit reached) */
export type Explain = { corpus: number; time: { from: string | null; to: string | null; recent: boolean } | null;
  terms: { key: string; df: number; used: boolean }[]; unseen: string[]; kw: [string, number][]; bi: [string, number][]; fused: number;
  rows: { id: string; score: number; why: string }[] };

// hot path: GPU busy → keyword-only rather than stall Claude (a cold model is waited for: embedQuery). A CPU-only box
// (the server: hot bge-m3 query ≈ 360 ms on 2 cores) needs more, or every search is keyword-only: MEMHUB_EMBED_WAIT_MS=1500.
const EMBED_TIMEOUT_MS = Number(process.env.MEMHUB_EMBED_WAIT_MS) || 300;
const PER_SESSION = 3;       // diversity: a long session must not fill every slot (eval: 3 keeps R@10 = uncapped, 2 costs ~5 pts)

// Bounded priors on the RRF score (RRF gaps between neighbouring ranks are only ~2-3 %, so they must stay mild):
//   final = max(base, base of its source chats) · (1 + τ)^tier,   base = rrf · proj · (1 + β·p) · status
//   p = 1 − (1 − p_use)(1 − p_imp)            (noisy-or)
//   p_use = S/(S+1),  S = t1^−0.5 + (n>0 ∧ tn>t1 ? 2n/(√tn+√t1) : 0)   ACT-R base level (Petrov k=1): recency + frequency
//     t1 = days since last reference (content time or last recall), tn = days since content time, n = sessions that recalled it
//   p_imp = 1 for pinned / rule / feedback facts, (importance−1)/9 for other facts, 0 for raw chats/notes/cards
//   status: superseded ×0.5, pending ×0.8, rejected excluded.  Design + sources: docs/research/phase4-design.md §2
//   tier (priority order, ลุงจืด 2026-10-02, cards 2026-10-18): rule/feedback/pinned/hand-saved +2 · other facts +1 · cards +0.5 · chats of any app
//     and kind, GitHub docs (repo card/commits/issues), Obsidian notes, superseded facts 0 · daily notes −1 (daily.ts: a
//     digest of chats already indexed; tier 0 let it take slots from the chats it lists).  τ = 0.1 → ×1.21: a chat found by more legs still wins.  Eval (tune split):
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
  daily: Number(process.env.MEMHUB_RANK_DAILY ?? -1),         // tier of daily notes (daily.ts): below chats
  foldDup: Number(process.env.MEMHUB_RANK_FOLD_DUP ?? 0.5), // a source chat repeating ≥ this share of its fact (char 5-grams) folds
  inProject: Number(process.env.MEMHUB_RANK_IN_PROJECT ?? 3.0), // currentProject match boost
  otherProject: Number(process.env.MEMHUB_RANK_OTHER_PROJECT ?? 0.35), // non-currentProject penalty (global/personal stay 1.0)
  opsCmd: Number(process.env.MEMHUB_RANK_OPS_CMD ?? 1.5),   // ops query: howto/rule facts and chats that ran commands
  opsRepo: Number(process.env.MEMHUB_RANK_OPS_REPO ?? 0.5), // ops query: a GitHub repo card (README, no steps)
};

// ลุงจืด 2026-10-18: "deploy server ssh systemctl X" ranked X's README repo card over the chats that ran the commands
const OPS_QUERY = /\b(?:deploy\w*|ssh|scp|rsync|systemctl|service|nginx|docker|pm2|port|env)\b|ดีพลอย|เซิร์ฟเวอร์/i;
const isRepo = (h: Pick<Hit, 'tool' | 'session_id'>) => h.tool === 'github' && !/#\d+$|:commits$/.test(h.session_id ?? '');
const opsFactor = (r: Hit) => (isRepo(r) ? RANK.opsRepo
  : (r.fid && (r.kind === 'howto' || r.kind === 'rule')) || (!r.fid && CMD_LINE.test(r.text)) ? RANK.opsCmd : 1);

/** True if query explicitly names projName (≥ 3 chars) as a token/substring. */
export function queryNamesProject(query: string | undefined, projName: string): boolean {
  const p = projName.toLowerCase();
  if (!query || p.length < 3) return false;
  const ql = query.toLowerCase();
  return /^[a-z0-9_-]+$/.test(p) ? ql.split(/[^a-z0-9_-]+/).includes(p) : ql.includes(p);
}

/** True when currentProject is set and hit h belongs to a different code project (not global, general Obsidian note, personal PRIVATE_TOOLS, same project tree, or explicitly named in query). */
export function isOtherProject(h: Pick<Hit, 'project' | 'fact_project' | 'fid' | 'tool'>, currentProject?: string, query?: string): boolean {
  if (!currentProject) return false;
  const hp = h.fact_project ?? h.project ?? '';
  if (!hp || (h.fid && !h.fact_project) || (h.tool === 'obsidian' && !h.fid) || PRIVATE_TOOLS.has(h.tool) || hp.startsWith('google/')) return false;
  if (sameTree(hp, currentProject)) return false;
  const a = projectName(hp).toLowerCase(), b = projectName(currentProject).toLowerCase();
  if (!a || !b || a === b) return false;
  return !queryNamesProject(query, a);
}

const LATIN = /^[a-z][a-z0-9_]{2,}$/;
const RARE_FRACTION = 0.05; // terms in >5% of chunks don't select candidates (they still add score)
// No rare term at all: the fallback candidates are the ≤ 3 lowest-df terms in ≤ this share of chunks; none → no words leg
// (bigram + vector legs still run). Any df made the words leg a near-full scan: 270–330 ms for a term in 42,803 of 45,447
// chunks (idf 0.05, PERF 2026-10-04). 1 = the old fallback (A/B: eval).
const KW_FALLBACK_MAX_DF = Number(process.env.MEMHUB_KW_FALLBACK_MAX_DF ?? 0.5);
// The words leg reads every chunk holding a candidate (≈ Σ df): candidates join rarest first while their df adds up to ≤ this
// (the rarest always joins); the rest still add score. 93 of 200 bench queries summed 4,000–15,300. 2026-10-10 A/B (MCP, 400
// searches ×2): p50/p95 55/100 → 45/79 ms, keyword-only 46/94 → 36/69; eval tune vis@3–8 same, direct10 −1/88. 0 = no budget.
const KW_DF_BUDGET = Number(process.env.MEMHUB_KW_DF_BUDGET ?? 4000);

// Keyword legs, run while Ollama embeds the query: $1 words tsquery, $2 bigram tsquery, $3 project, $4 since, $5 before,
// $6/$7 every query term's tsquery / IDF, $8 tools to hide, $9 until (exclusive end: dateRange), $10-$12 own (OWN).
const PF = `pf AS (SELECT source_id FROM facts WHERE $3::text IS NOT NULL AND (project LIKE '%' || $3 || '%' OR scope = 'global'))`;
/** SQL: source ids a caller hiding tools ${p} must not see: those tools' sources and every source hidden like them (hide_as:
 *  importer.indexFile; fact/card notes dreamed from a chat hidden later: importer.hideDreamed, so no read-time join here —
 *  that one cost non-Claude keyword search +4 ms p50 in an ABAB run, tmp/privacy/ab.ts). */
export const HIDDEN = (p: string) => `SELECT id FROM sources WHERE coalesce(hide_as, tool) = ANY(${p}::text[])`;
/** Reply-text mask for a caller hiding tools `hide`: a note hidden from it (importer.hideDreamed) can still be NAMED in visible
 *  text written before the hide — another note's [[<fid> <title>]], a session card's fact list, a hub or daily note — so its fid
 *  and the name after it (up to ] | … or the line end) become "?". ponytail: one query per reply; no hidden note = no-op. */
export async function hiddenNameMask(db: pg.Pool, hide: string[]): Promise<(s: string) => string> {
  const fids = hide.length ? (await db.query(`SELECT f.fid FROM facts f JOIN sources s ON s.id = f.source_id
    WHERE s.tool = 'obsidian' AND s.hide_as = ANY($1::text[])`, [hide])).rows.map((r) => r.fid as string) : [];
  if (!fids.length) return (s) => s;
  const re = new RegExp(`\\b(?:${fids.join('|')})\\b[^\\]\\n|…]*`, 'gi');
  return (s) => s.replace(re, '?');
}
// hidden sources (PRIVATE_TOOLS for a non-Claude caller, or sources outside kind / asOf) leave every leg, so they never take one of its 60 candidate slots
const HIDE = (p: string, kind: string, asOf: string) => `hide AS (
  ${HIDDEN(p)}
  UNION ALL SELECT id FROM sources WHERE ${kind}::text IS NOT NULL AND (
    CASE ${kind}::text
      WHEN 'chat' THEN tool = 'obsidian'
      WHEN 'note' THEN tool <> 'obsidian' OR id IN (SELECT source_id FROM facts)
      ELSE id NOT IN (SELECT source_id FROM facts WHERE kind = ${kind}::text)
    END)
  UNION ALL SELECT f.source_id FROM facts f JOIN sources s ON s.id = f.source_id WHERE ${asOf}::timestamptz IS NOT NULL AND (
    f.valid_at >= ${asOf}::timestamptz OR f.invalid_at <= ${asOf}::timestamptz OR f.expired_at <= ${asOf}::timestamptz
    OR (s.status = 'superseded' AND f.invalid_at IS NULL AND f.expired_at IS NULL)))`;
// SearchOpts.own: the caller's live session (newer than since, its project, its app) leaves every leg
const OWN = (since: string, project: string, tool: string) => `(${since}::timestamptz IS NULL OR ts < ${since}
      OR project IS DISTINCT FROM ${project}::text OR source_id NOT IN (SELECT id FROM sources WHERE tool = ${tool}::text))`;
const SQL_KEYWORD = `
WITH ${PF}, ${HIDE('$8', '$13', '$14')},
w AS (
  SELECT id, row_number() OVER (ORDER BY s DESC, ts DESC) r, s FROM (
    SELECT id, ts, (SELECT sum(x.idf) FROM unnest($6::tsquery[], $7::float8[]) x(q, idf) WHERE wd @@ x.q) s
    FROM (SELECT id, ts, words || ''::tsvector wd FROM chunks -- words detoasted once per row, not once per query term:
      WHERE $1::text IS NOT NULL AND words @@ $1::tsquery    -- 200 queries: p50/p95/p99 41/155/192 → 29/69/107 ms, same rows
        AND ($3::text IS NULL OR project LIKE '%' || $3 || '%' OR source_id IN (SELECT pf.source_id FROM pf)) AND ($4::timestamptz IS NULL OR ts >= $4) AND ($5::timestamptz IS NULL OR ts < $5) AND ($9::timestamptz IS NULL OR ts < $9)
        AND ($14::timestamptz IS NULL OR ts < $14 OR source_id IN (SELECT source_id FROM facts))
        AND source_id NOT IN (SELECT id FROM hide) AND ${OWN('$10', '$11', '$12')}
      OFFSET 0) c -- OFFSET 0: keeps the subquery (and its one detoast) from being flattened into the scoring
  ) z ORDER BY r LIMIT 60),
b AS (
  SELECT id, row_number() OVER (ORDER BY ts_rank_cd(bigrams, $2::tsquery, 1) DESC, ts DESC) r
  FROM chunks
  WHERE $2::text IS NOT NULL AND bigrams @@ $2::tsquery
    AND ($3::text IS NULL OR project LIKE '%' || $3 || '%' OR source_id IN (SELECT pf.source_id FROM pf)) AND ($4::timestamptz IS NULL OR ts >= $4) AND ($5::timestamptz IS NULL OR ts < $5) AND ($9::timestamptz IS NULL OR ts < $9)
    AND ($14::timestamptz IS NULL OR ts < $14 OR source_id IN (SELECT source_id FROM facts))
    AND source_id NOT IN (SELECT id FROM hide) AND ${OWN('$10', '$11', '$12')}
  ORDER BY r LIMIT 60)
SELECT 'w' leg, id, r, s FROM w UNION ALL SELECT 'b', id, r, NULL FROM b`; // s: IDF of the query terms a chunk has (signal)

// Vector leg + RRF + priors. The keyword legs come in as (id, rank) arrays in the slots SQL_KEYWORD's own inputs had:
// $1/$2 words, $8/$9 bigrams; $15 tools to hide (the keyword legs already left them out); $16-$19 timeWindow() boost, $20 the daily-note tier;
// $21 until: filter only — $7 (before) stays the recency anchor, so a date range never re-ranks by age. $22-$24 own (OWN); $28 kind, $29 asOf.
const SQL = `
WITH ${PF}, ${HIDE('$15', '$28', '$29')},
w AS (SELECT * FROM unnest($1::text[], $2::bigint[]) x(id, r)),
b AS (SELECT * FROM unnest($8::text[], $9::bigint[]) x(id, r)),
v AS (
  SELECT id, d, row_number() OVER (ORDER BY d) r FROM (
    SELECT id, embedding <=> $10::halfvec d FROM chunks
    WHERE $10::text IS NOT NULL AND embedding IS NOT NULL
      AND ($3::text IS NULL OR project LIKE '%' || $3 || '%' OR source_id IN (SELECT pf.source_id FROM pf)) AND ($4::timestamptz IS NULL OR ts >= $4) AND ($7::timestamptz IS NULL OR ts < $7)
      AND ($21::timestamptz IS NULL OR ts < $21) AND ($29::timestamptz IS NULL OR ts < $29 OR source_id IN (SELECT source_id FROM facts))
      AND source_id NOT IN (SELECT id FROM hide) AND ${OWN('$22', '$23', '$24')}
    ORDER BY embedding <=> $10::halfvec LIMIT 60) s),
f AS (SELECT id, sum(1.0 / (60 + r)) s FROM (SELECT * FROM w UNION ALL SELECT * FROM b UNION ALL SELECT id, r FROM v) x GROUP BY id),
vs AS (SELECT json_build_object('n', count(*), 'd1', min(d), 'd10', (array_agg(d ORDER BY d))[10], 'dm', avg(d),
         'ag', count(*) FILTER (WHERE r <= 10 AND id IN (SELECT id FROM w))) j FROM v), -- ag: signal.agree, the vector top 10 also in the words top 60
u AS (SELECT c.id, count(DISTINCT a.session) n, max(a.ts) last  -- recalls keyed by turn (stable across re-chunking)
      FROM f JOIN chunks c USING (id) JOIN access_log a ON a.turn_uuid = c.turn_uuid
      WHERE a.kind IN ('get', 'related') AND a.ts < coalesce($7, $22::timestamptz, $29::timestamptz, now()) GROUP BY c.id), -- own: not this session's own recalls
x AS (
  SELECT c.id, c.turn_uuid, c.ts, c.project, c.session_id, c.ctx_header AS header, c.text, c.source_id, c.seq_from, c.seq_to,
         CASE WHEN $29::timestamptz IS NOT NULL AND s.status = 'superseded' THEN 'active' ELSE s.status END AS status, s.tool,
         s.kind src_kind, coalesce(u.n, 0)::int uses, u.last, fa.fid, fa.kind, fa.project fact_project,
         CASE WHEN $29::timestamptz IS NOT NULL THEN NULL ELSE fa.superseded_by END AS superseded_by, fa.review_target,
         fa.source_uuids, f.s rrf,
         CASE WHEN s.kind = 'daily' OR (s.tool = 'obsidian' AND s.session_id LIKE '%/hubs/%') THEN $20::float8
              WHEN fa.fid IS NULL OR ($29::timestamptz IS NULL AND s.status = 'superseded') THEN 0 WHEN fa.kind = 'card' THEN 0.5
              WHEN fa.pinned OR fa.user_owned OR fa.run IS NULL OR fa.kind IN ('rule', 'feedback') THEN 2 ELSE 1 END tier,
         CASE WHEN $5::text = '' THEN 1
              WHEN c.project = $5 OR fa.project = $5
                OR proj_basename(coalesce(fa.project, c.project, '')) = proj_basename($5)
                OR proj_basename(coalesce(fa.project, c.project, '')) = ANY($27::text[])
                OR coalesce(fa.project, c.project, '') = ANY($30::text[]) OR starts_with(coalesce(fa.project, c.project, ''), $31::text || '/') THEN $25::float8 -- sameTree()
              -- a global fact naming this project (memory_save from an app that sent no cwd: Antigravity, 2026-10-18) is one of it
              WHEN fa.fid IS NOT NULL AND coalesce(fa.project, '') = '' AND c.words @@ $32::tsquery THEN $25::float8
              WHEN (fa.fid IS NOT NULL AND coalesce(fa.project, '') = '') OR (s.tool = 'obsidian' AND fa.fid IS NULL) OR c.project LIKE 'google/%' THEN 1
              WHEN $3::text IS NULL THEN $26::float8 ELSE 1 END proj,
         greatest(extract(epoch FROM coalesce($7, $29::timestamptz, now()) - greatest(c.ts, u.last)) / 86400, 1.0 / 24) t1,
         greatest(extract(epoch FROM coalesce($7, $29::timestamptz, now()) - c.ts) / 86400, 1.0 / 24) tn,
         CASE WHEN fa.pinned OR fa.kind IN ('rule', 'feedback') THEN 1
              WHEN fa.kind IN ('decision', 'preference', 'fact', 'howto', 'insight') THEN (coalesce(fa.importance, 5) - 1) / 9.0 ELSE 0 END p_imp
  FROM f JOIN chunks c USING (id) JOIN sources s ON s.id = c.source_id
  LEFT JOIN u ON u.id = c.id LEFT JOIN facts fa ON fa.source_id = c.source_id
  WHERE s.status IS DISTINCT FROM 'rejected'),
y AS (SELECT x.*, rrf * proj * (1 + $11::float8 * (1 - (1 - sa / (sa + 1)) * (1 - p_imp)))
                  * CASE status WHEN 'superseded' THEN $12::float8 WHEN 'pending' THEN $13::float8 ELSE 1 END
                  * CASE WHEN ts >= $16 AND ts < $17 THEN 1 + $18::float8 ELSE 1 END * (1 + $19::float8 * (1 - pr)) base -- timeWindow()
      FROM (SELECT x.*, power(t1, -0.5) + CASE WHEN uses > 0 AND tn > t1 THEN 2 * uses / (sqrt(tn) + sqrt(t1)) ELSE 0 END sa,
                   percent_rank() OVER (ORDER BY ts DESC NULLS LAST) pr FROM x) x),
ev AS (  -- candidate raw chat → the best candidate active fact distilled from its turns (one per chat: no sibling lift)
  SELECT DISTINCT ON (ry.id) fy.id fact_id, ry.id raw_id, ry.base FROM y fy CROSS JOIN unnest(fy.source_uuids) su(uuid) JOIN turns t ON t.uuid = su.uuid
  JOIN y ry ON ry.source_id = t.source_id AND t.seq BETWEEN ry.seq_from AND ry.seq_to AND ry.fid IS NULL AND ry.tool <> 'obsidian'
  WHERE fy.kind <> 'card' AND coalesce(fy.status, 'active') = 'active'
  ORDER BY ry.id, fy.base DESC, fy.id),
z AS (SELECT y.*, greatest(base, (SELECT max(e.base) FROM ev e WHERE e.fact_id = y.id)) * power(1 + $14::float8, tier) score,
             (SELECT array_agg(DISTINCT e.fact_id) FROM ev e WHERE e.raw_id = y.id) ev_of FROM y),
sup AS (SELECT fx.fid, fx.superseded_by nxt, fx.source_uuids FROM facts fx JOIN sources sx ON sx.id = fx.source_id
        WHERE sx.status = 'superseded' AND fx.superseded_by IS NOT NULL AND sx.id NOT IN (SELECT id FROM hide)
          AND ($29::timestamptz IS NULL OR coalesce(fx.invalid_at, fx.expired_at) <= $29::timestamptz))
SELECT y.id, y.turn_uuid, y.ts, y.project, y.session_id, y.header, y.text, y.status, y.src_kind, y.tool, y.uses, y.last, y.fid, y.kind, y.fact_project,
       y.superseded_by, y.review_target, y.score, y.ev_of, (SELECT j FROM vs) vsig,
       CASE WHEN y.tool <> 'obsidian' THEN (  -- a later-superseded fact annotates its source chats (search() down-ranks them)
         WITH RECURSIVE ch(fid, d) AS (       -- with the current END of each supersede chain (A → B → C: C, never the OLD B)
           SELECT nxt, 1 FROM sup WHERE source_uuids && (
             SELECT array_agg(uuid) FROM turns WHERE source_id = y.source_id AND seq BETWEEN y.seq_from AND y.seq_to)
           UNION SELECT sup.nxt, ch.d + 1 FROM ch JOIN sup USING (fid) WHERE ch.d < 8)
         SELECT array_agg(DISTINCT fid ORDER BY fid) FROM ch WHERE fid NOT IN (SELECT fid FROM sup)) END changed_to
FROM z y
ORDER BY score DESC, tier DESC, y.ts DESC
LIMIT $6`;

const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** since/until → SQL bounds, or a clear error (a pg cast error says nothing to the calling AI). A value without a zone is
 *  ลุงจืด's day/clock (Asia/Bangkok, like timeWindow, daily and lint), not pg's session zone (UTC): he works past midnight.
 *  A date-only until is inclusive: ts < the next local midnight. Date part only for since ≤ until. */
export function dateRange(since?: string, until?: string, untilName = 'until'): { since: string | null; until: string | null } {
  for (const [k, x] of [['since', since], [untilName, until]]) {
    const d = x?.slice(0, 10) ?? '';
    if (x && (x.length > 30 || !ISO.test(x) || Number.isNaN(Date.parse(x)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d)) {
      throw new Error(`${k} must be an ISO date like 2026-09-01 (got ${JSON.stringify(x.slice(0, 30))})`);
    }
  }
  if (since && until && since.slice(0, 10) > until.slice(0, 10)) throw new Error(`since ${since} is after ${untilName} ${until}`);
  const end = until && until.length === 10 ? new Date(Date.parse(`${until}T00:00:00Z`) + 864e5).toISOString().slice(0, 10) : until;
  const local = (x?: string) => !x ? null : /(?:Z|[+-]\d{2}:?\d{2})$/.test(x.slice(10)) ? x : `${x.length === 10 ? `${x}T00:00:00` : x}+07:00`;
  return { since: local(since), until: local(end) };
}

// Projects a query can name (Signal.h): basename of a project with ≥ 20 visible chunks, ≥ 3 chars, no whitespace, no leading dot, and not an
// everyday word (term_df ≤ 3× its chunks). Built from public chunks like term_df, so it is per pool and goes stale with it: refreshTermDf
// drops it, and an hour's TTL covers a long-lived MCP process (the hourly refresh runs in another one). A failed build = no project named.
type Named = { name: string; raw: string[] };
const CATALOGUE = new WeakMap<pg.Pool, { at: number; p: Promise<Named[]> }>();
export function projectCatalogue(db: pg.Pool): Promise<Named[]> {
  const c = CATALOGUE.get(db);
  if (c && Date.now() - c.at < 36e5) return c.p;
  const p = db.query(`SELECT c.name, c.raw, c.n, coalesce(d.ndoc, 0) df FROM (
      SELECT proj_basename(project) name, array_agg(DISTINCT project) raw, count(*)::int n FROM chunks
      WHERE project IS NOT NULL AND source_id NOT IN (${HIDDEN('$1')}) GROUP BY 1 HAVING count(*) >= 20) c LEFT JOIN term_df d ON d.word = c.name`,
    [[...PRIVATE_TOOLS]]).then((r) => r.rows.filter((x) => x.name.length >= 3 && !/\s/.test(x.name) && !x.name.startsWith('.') && x.df <= 3 * x.n)
    .map((x): Named => ({ name: x.name, raw: x.raw })), () => { CATALOGUE.delete(db); return []; });
  CATALOGUE.set(db, { at: Date.now(), p });
  return p;
}
/** Signal.h / Signal.pun: does the query name a catalogued project (a whole token) and still have another scored term; if so, the IDF
 *  share of those other terms that no visible chunk of that project (older than `before`) holds. One EXISTS per term, one statement. */
async function projectPun(db: pg.Pool, cat: Promise<Named[]> | null, query: string, scored: { key: string; lit: string; idf: number }[],
  hide: string[], before: Date | null): Promise<{ h: 0 | 1; pun: number }> {
  const ql = query.toLowerCase(), none = { h: 0 as const, pun: 0 };
  const named = (await cat)?.filter((p) => (/^[a-z0-9_-]+$/.test(p.name) ? ql.split(/[^a-z0-9_-]+/).includes(p.name) : ql.includes(p.name))) ?? [];
  const parts = named.flatMap((p) => [p.name, ...p.name.split(/[-_]/)]);
  const rest = scored.filter((t) => !parts.some((n) => t.key === n || t.key.includes(n)));
  if (!named.length || !rest.length) return none;
  const has = (await db.query(`SELECT EXISTS (SELECT 1 FROM chunks c WHERE c.project = ANY($1::text[]) AND c.words @@ x.q AND ($2::timestamptz IS NULL OR c.ts < $2)
      AND c.source_id NOT IN (${HIDDEN('$3')})) e FROM unnest($4::tsquery[]) WITH ORDINALITY x(q, i) ORDER BY i`,
    [named.flatMap((p) => p.raw), before, hide, rest.map((t) => t.lit)])).rows.map((r) => r.e as boolean);
  const total = rest.reduce((a, t) => a + t.idf, 0);
  return { h: 1, pun: total ? rest.reduce((a, t, i) => a + (has[i] ? 0 : t.idf), 0) / total : 0 };
}

export async function search(db: pg.Pool, query: string, o: SearchOpts = {}): Promise<Result> {
  const { since, until } = dateRange(o.since, o.until); // first: bad input fails before the embedder or the DB is asked
  const asOf = o.asOf ? dateRange(undefined, o.asOf, 'as_of').until : null;
  if (o.kind !== undefined && !(SEARCH_KINDS as readonly string[]).includes(o.kind)) {
    throw new Error(`kind must be one of ${SEARCH_KINDS.join(', ')} (got ${JSON.stringify(o.kind)})`);
  }
  const kind = o.kind ?? null;
  const limit = Math.min(Math.max(o.limit ?? 6, 1), 20); // MCP schema caps callers at 8; eval uses up to 20
  // tier 0 = dream's similarity-only neighbour lookup: no time boost, terms untouched
  const tw = o.tier === 0 ? { recent: false, rest: query } : timeWindow(query, o.now ?? o.before ?? (asOf ? new Date(asOf) : new Date()));
  let kq = tw.rest, terms = queryTerms(kq);
  if (!terms.length) terms = queryTerms((kq = query)); // only a time phrase ('เมื่อวานทำอะไร'): keep its words, as before
  const vec = o.semantic === false ? null : embedQuery(query, EMBED_TIMEOUT_MS).then((e) => e && toVec(e));
  const cat = vec && o.tier !== 0 ? projectCatalogue(db) : null; // Signal.h/pun are read with a vector signal only; dream's lookup (tier 0) reads neither. Overlaps the stats query below
  // One round trip: corpus size, document frequencies, and English stems (redaction → redact:* also finds redacted).
  // Corpus stats leave PRIVATE_TOOLS out (here and in term_df): Claude-only data never shifts another app's ranking.
  const latin = terms.filter((t) => LATIN.test(t.key)).map((t) => t.key);
  const st = (await db.query(
    `WITH st AS (SELECT w, (ts_lexize('english_stem', w))[1] s FROM unnest($2::text[]) w)
     SELECT greatest((SELECT reltuples FROM pg_class WHERE oid = 'chunks'::regclass)
              - (SELECT count(*) FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE coalesce(hide_as, tool) = ANY($3::text[]))), 1)::float8 n,
            coalesce((SELECT json_object_agg(word, ndoc) FROM term_df WHERE word = ANY($1::text[] || ARRAY(SELECT s FROM st))), '{}') df,
            coalesce((SELECT json_object_agg(w, s) FROM st WHERE s IS NOT NULL AND s <> w AND length(s) >= 3), '{}') stems,
            -- familiarity: a Latin word (names live there; Thai segmentation fragments do not count) no chunk has ever held, not even
            -- as a word starting with its stem (delegating → deleg:*). term_df lags an hour, so the index decides; only words term_df lacks
            coalesce((SELECT json_agg(w) FROM st WHERE NOT EXISTS (SELECT 1 FROM term_df WHERE word IN (st.w, st.s))
              AND length(coalesce(st.s, st.w)) >= 3
              AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.words @@ to_tsquery('simple', quote_literal(coalesce(st.s, st.w)) || ':*')
                AND c.source_id NOT IN (SELECT id FROM sources WHERE coalesce(hide_as, tool) = ANY($4::text[])))), '[]') unseen`,
    // $4: what this caller may see (a word only Claude-only data holds is still "seen" for Claude)
    [terms.map((t) => t.key), latin, [...PRIVATE_TOOLS], o.showPrivate ? [] : [...PRIVATE_TOOLS]],
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
  if (!cand.length) cand = scored.filter((t) => t.df <= KW_FALLBACK_MAX_DF * n).sort((a, b) => a.df - b.df).slice(0, 3);
  if (KW_DF_BUDGET > 0) { let sum = 0; cand = [...cand].sort((a, b) => a.df - b.df).filter((t, i) => (sum += t.df) <= KW_DF_BUDGET || !i); }
  const wq = cand.length ? cand.map((t) => t.lit).join(' | ') : null;

  const project = o.project?.toLowerCase() || null, before = o.before ?? null;
  const hide = o.showPrivate ? [] : [...PRIVATE_TOOLS];
  const own = [o.own?.since ?? null, o.own?.project ?? null, o.own?.tool ?? null];
  const [legs, v, pj] = await Promise.all([db.query(SQL_KEYWORD, [wq, bigramQuery(kq), project, since, before,
    scored.map((t) => t.lit), scored.map((t) => t.idf), hide, until, ...own, kind, asOf]), vec, projectPun(db, cat, query, scored, hide, before)]);
  const w = legs.rows.filter((r) => r.leg === 'w'), b = legs.rows.filter((r) => r.leg === 'b');
  const qProjTokens = query.toLowerCase().split(/[^a-z0-9_\u0E00-\u0E7F-]+/).filter((t) => t.length >= 3);
  const rows = (await db.query(SQL, [
    w.map((r) => r.id), w.map((r) => r.r), project, since, o.currentProject ?? '', Math.max(limit, 8) * 3, // ≥ 24 rows: same curated slot at every limit
    before, b.map((r) => r.id), b.map((r) => r.r), v,
    RANK.beta, RANK.superseded, RANK.pending, o.tier ?? RANK.tier, hide, tw.from ?? null, tw.to ?? null, tw.from ? T_WIN : 0, tw.recent ? T_REC : 0, RANK.daily, until, ...own,
    RANK.inProject, RANK.otherProject, qProjTokens, kind, asOf,
    o.currentProject ? projectTree(o.currentProject) : [], o.currentProject && !catchAll(o.currentProject) ? o.currentProject : null,
    nameQuery(o.currentProject),
  ])).rows;
  // Familiarity, apart from rank (RRF is rank-only: an off-topic query scores like a real match): how close the nearest
  // chunks are, and the share of the query's IDF the best keyword chunk carries. Ranking never reads it.
  const vs = rows[0]?.vsig, idf = scored.reduce((a, t) => a + t.idf, 0);
  const signal: Signal = { cos1: vs?.n ? 1 - vs.d1 : null, cos10: vs?.n >= 10 ? 1 - vs.d10 : null, cosMean: vs?.n ? 1 - vs.dm : null,
    kw: idf ? Math.max(0, ...w.map((r) => Number(r.s))) / idf : 0,
    // each term votes "never seen" with its IDF, normalized by the query's total (FlyWire: weight = share of the target's input)
    unseen: idf ? scored.filter((t) => st.unseen.includes(t.key)).reduce((a, t) => a + t.idf, 0) / idf : 0, agree: vs?.ag ?? 0, ...pj };
  for (const r of rows) delete r.vsig;
  // ลุงจืด 2026-10-18: a chat whose decision a later fact replaced ranks like an OLD fact (×superseded); stable sort keeps the SQL ties
  for (const r of rows) if (r.changed_to && !r.fid) r.score = Number(r.score) * RANK.superseded;
  if (o.tier !== 0 && OPS_QUERY.test(query)) for (const r of rows) r.score = Number(r.score) * opsFactor(r);
  rows.sort((a, b) => Number(b.score) - Number(a.score));
  const ci = rows.slice(0, 24).findIndex((r) => r.fid && r.kind !== 'card' && (r.status ?? 'active') === 'active'
    && !isOtherProject(r, project ? undefined : o.currentProject, query));
  if (ci >= RANK.slot && Number(rows[ci].score) >= RANK.slotRatio * Number(rows[0].score)) rows.splice(RANK.slot - 1, 0, ...rows.splice(ci, 1));
  const perSession = new Map<string, number>();
  const hits: Hit[] = [];
  const why = o.explain ? new Map<string, string>() : null; // explain: why a scored row got no slot
  for (const r of rows) {
    // dedupe: a fact ranks at or above its own source chats (tier ≥ 1 > chat tiers) → attach them to it instead of a slot,
    // except a chat that would get a slot anyway and mostly says something else (judge-03: folding cut half the answer)
    // a long fact is several chunks: one slot (it prints from its head; memory_get prints it whole), not 3 of the same id
    if (r.fid && hits.some((h) => h.fid === r.fid)) { why?.set(r.id, `dup:${r.fid}`); continue; }
    const fact = r.ev_of && hits.find((h) => r.ev_of.includes(h.id));
    const n = perSession.get(r.session_id) ?? 0;
    const room = hits.length < limit && n < (o.perSession ?? PER_SESSION);
    if (fact && !(room && overlap(snippet(r.text, query), fact.text) < RANK.foldDup)) {
      (fact.evidence ??= []).push({ ...r, score: Number(r.score) }); perSession.set(r.session_id, n + 1); why?.set(r.id, `fold:${fact.fid ?? fact.id}`); continue; // still counts toward the cap
    }
    if (!room) { why?.set(r.id, hits.length < limit ? 'cap' : 'full'); continue; } // full: keep scanning only to attach source chats
    perSession.set(r.session_id, n + 1);
    hits.push({ ...r, score: Number(r.score) });
  }
  if (o.tier !== 0) await layers(db, hits, query, project ? undefined : o.currentProject, hide,
    PAST.test(query) || !!(asOf || o.since || o.until || tw.from));
  const explain: Explain | undefined = o.explain ? { corpus: n, unseen: st.unseen, fused: rows.length,
    rows: rows.map((r) => ({ id: r.id, score: Number(r.score), why: why!.get(r.id) ?? 'hit' })),
    time: tw.from || tw.recent ? { from: tw.from?.toISOString() ?? null, to: tw.to?.toISOString() ?? null, recent: tw.recent } : null,
    terms: scored.map((t) => ({ key: t.key, df: t.df, used: cand.includes(t) })),
    kw: w.map((r) => [r.id, Number(r.r)]), bi: b.map((r) => [r.id, Number(r.r)]) } : undefined;
  return { hits, semantic: v !== null, qvec: v, signal, explain };
}

/** tsquery of the current project's folder name (≥ 4 chars, not a catch-all cwd), or null. */
function nameQuery(p?: string): string | null {
  const t = p && !catchAll(p) ? queryTerms(projectName(p)) : [];
  return t.length && t.map((x) => x.key).join('').length >= 4 ? t.map((x) => x.lit).join(' & ') : null;
}

// a question about the past ("เคยใช้อะไร", as_of, a date range, "เมื่อวาน"): the record is the answer → no reordering
const PAST = /เคย|ครั้งก่อน|ครั้งที่แล้ว|ก่อนหน้านี้|ประวัติ|เดิมที|\b(?:last time|used to|previously|history)\b/i;
export const GAP_DAYS = 7;
/** he said it: a memory_save note (only obs: uuids) or a cited turn of his (the rest = AI-only, as hit lines label it). */
export const SAID = (f: string) => `(NOT EXISTS (SELECT 1 FROM unnest(${f}.source_uuids) x WHERE x NOT LIKE 'obs:%')
  OR EXISTS (SELECT 1 FROM unnest(${f}.source_uuids) u(uuid) JOIN turns t ON t.uuid = u.uuid WHERE t.role = 'user'))`;
/** his words for a verdict: SAID, or his own fact (user_owned: a rule/feedback, pinned, edited). */
export const HIS = (f: string) => `(${f}.user_owned OR ${SAID(f)})`;
const SQL_VERDICT = `
SELECT fa.fid, fa.valid_at, ${HIS('fa')} his,
  coalesce((SELECT json_agg(json_build_object('b', fb.fid, 't', fb.valid_at, 'on', st.v->'on'->>(w.i::int - 1), 'his', ${HIS('fb')}))
    FROM state st CROSS JOIN LATERAL jsonb_array_elements_text(st.v->'with') WITH ORDINALITY w(o, i)
    JOIN facts fb ON fb.fid = w.o JOIN sources sb ON sb.id = fb.source_id
    WHERE st.k = 'conflict:' || fa.fid AND coalesce(sb.status, 'active') = 'active' AND coalesce(sb.hide_as, sb.tool) <> ALL($2::text[])), '[]') newer
FROM facts fa WHERE fa.fid = ANY($1::text[])`;

/** ลุงจืด 2026-10-18 "ต้องสื่อสารกับ AI ที่เรียก MCP ว่าตัวไหนใช้ ไม่ใช้ หรือเป็น memo": each hit's Layer, and the hits already
 *  chosen listed ✓ → บันทึก → ✗ (stable within each) unless `keep` (a question about the past). ✗ also: a chat whose decision a
 *  later fact replaced; the older side of a CONFLICT whose other side is his words and > 7 days newer (AI-only newer: a note,
 *  no ✗); an older hit naming what a current fact of his says เลิกใช้ (AI-only fact: a note). One query, only when ✓ facts. */
async function layers(db: pg.Pool, hits: Hit[], query: string, currentProject: string | undefined, hide: string[], keep: boolean) {
  for (const h of hits) h.layer = layerOf(h, currentProject, query);
  const cur = hits.filter((h) => h.layer === 'use');
  const info = new Map(cur.length ? (await db.query(SQL_VERDICT, [cur.map((h) => h.fid), hide])).rows.map((r) => [r.fid as string, r]) : []);
  const when = (h: Hit) => new Date(info.get(h.fid!)?.valid_at ?? h.ts ?? 0).getTime();
  for (const h of cur) for (const n of info.get(h.fid!)?.newer ?? []) {
    const exact = (new Date(n.t).getTime() - when(h)) / 864e5, gap = Math.round(exact); // compare exact: 7 d 33 min is over 7 days
    if (exact <= GAP_DAYS || h.why) continue;
    if (n.his) { h.layer = 'old'; h.why = `น่าจะเลิกใช้: [${n.b}] ${day(new Date(n.t))} ใหม่กว่า ${gap} วัน (คำลุงจืด) ขัดกันเรื่อง ${n.on}`; }
    else h.why = `ขัดกับ [${n.b}] ${day(new Date(n.t))} ที่ใหม่กว่า ${gap} วัน แต่เป็น AI-only: ยังใช้ได้ ถามลุงจืดก่อนเลือก`;
  }
  const own = projectName(currentProject ?? '').toLowerCase();
  for (const f of cur) {
    if (f.layer !== 'use') continue;
    const his = info.get(f.fid!)?.his, at = when(f);
    for (const name of deprecatedNames(f.text).filter((n) => n !== own))
      for (const h of hits) if (h !== f && !h.why && h.layer !== 'old' && when(h) < at && h.text.toLowerCase().includes(name)) {
        if (his) { h.layer = 'old'; h.why = `น่าจะเลิกใช้: [${f.fid}] ${day(new Date(at))} บอกว่า ${name} เลิกใช้แล้ว`; }
        else h.why = `ตรวจก่อนใช้: [${f.fid}] ${day(new Date(at))} (AI-only) บอกว่า ${name} เลิกใช้แล้ว`;
      }
  }
  // ✓ goes first: a rule / howto / decision always (ลุงจืด: "always shown on top"); another kind only when it answers the
  // query: close to the best hit (the curated slot's bar) and holding ≥ half the query words. A fact matching 1 of 4 stays
  // where its score put it, among the records, still labelled ✓
  const top = Math.max(...hits.map((h) => Number(h.score) || 0)), terms = queryTerms(query).map((t) => t.key);
  const answers = (h: Hit) => LEAD.has(h.kind!) || (Number(h.score) >= RANK.slotRatio * top
    && ((low) => terms.filter((k) => low.includes(k)).length * 2 >= terms.length)(normalize(h.text)));
  const rank = (h: Hit) => (h.layer === 'use' && !answers(h) ? ORDER.memo : ORDER[h.layer!]);
  if (!keep) hits.sort((a, b) => rank(a) - rank(b));
}
const ORDER: Record<Layer, number> = { use: 0, memo: 1, old: 2 };
const LEAD = new Set(['rule', 'howto', 'decision']);
export const LABEL: Record<Layer, string> = { use: '✓ใช้ได้', memo: 'บันทึก', old: '✗เลิกใช้' };
/** The layer from the hit alone: ✗ replaced (superseded fact, chat whose decision later changed), ✓ a current fact or
 *  rule of this project or global (not a session card / insight / one under review), บันทึก the rest. */
export const layerOf = (h: Hit, currentProject?: string, query?: string): Layer => h.status === 'superseded' || (h.changed_to && !h.fid) ? 'old'
  : h.fid && h.kind !== 'card' && h.kind !== 'insight' && (h.status ?? 'active') === 'active' && !isOtherProject(h, currentProject, query) ? 'use' : 'memo';

const NAME = /[a-z0-9][\w.:/-]*[a-z0-9]/gi;
// only a name that points at one thing: a domain / host / file / package.module (a dot, a letter), an IPv4, :port allowed.
// Plain words were 150 of the 160 names read from 2,436 live facts (claude, mongodb, setup, cache…): "เลิกใช้ mongodb" in one
// project would ✗ every older hit naming it (2026-10-18)
const IDENT = /^(?:(?=[^.]*[a-z])[a-z0-9-]+(?:\.[a-z0-9-]+)+|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/i;
/** What a fact says is no longer used: the name at "X เลิกใช้แล้ว" / "เลิกใช้ X" / "ไม่ใช้ X แล้ว" / "X ไม่ใช้แล้ว" / "ใช้ A แทน X" /
 *  "X deprecated" on the cue's own line (the token next to the cue), when it is an IDENT. Thai-only names are not read. */
export function deprecatedNames(text: string): string[] {
  const out = new Set<string>();
  const add = (n?: string) => { if (n && IDENT.test(n)) out.add(n.toLowerCase()); };
  const names = (s: string) => [...s.matchAll(NAME)].map((m) => m[0]);
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(/ไม่ใช้\s*`?([a-z0-9][\w.:/-]*[a-z0-9])`?\s*(?:อีก)?(?:ต่อไป)?แล้ว/gi)) add(m[1]);
    for (const m of line.matchAll(/เลิกใช้|ไม่ใช้แล้ว|deprecated|แทน(?:ที่)?/gi)) {
      const before = names(line.slice(Math.max(0, m.index - 40), m.index)).at(-1), rest = line.slice(m.index + m[0].length);
      const next = /^\s*[`'"(]?([a-z0-9][\w.:/-]*[a-z0-9])/i.exec(rest)?.[1];
      add(/^แทน/.test(m[0]) ? names(rest.slice(0, 40))[0] : /^ไม่ใช้แล้ว$/.test(m[0]) ? before : (next ?? before));
    }
  }
  return [...out];
}

// Relative time → a soft boost on the fused rows (never a filter): ts in the window ×(1 + T_WIN); recency words ×(1 + T_REC·(1 −
// percent_rank by ts desc)). Anchor = o.now ?? o.before ?? now. Relative phrases leave the keyword terms (วาน,
// ปี, เดือน were junk "rare" terms); month names and years stay (dated text spells them; stripping them too cost the private
// set 1 q @1). The MCP anchors at the real now (o.now); its before = server start only hides its own session.
const T_WIN = 0.2, T_REC = 0.2; // eval (tune): fine time=relative direct@1 +2 q; 0.4 / 0.4 the same @1, −1 q @10
const TZ = 7 * 3600e3; // ลุงจืด's local day: Asia/Bangkok, no DST
const TH_MONTH = 'มกรา กุมภา มีนา เมษา พฤษภา มิถุนา กรกฎา สิงหา กันยา ตุลา พฤศจิกา ธันวา'.split(' '); // + คม/ยน/พันธ์ = full name
const TH_MON = 'ม.ค. ก.พ. มี.ค. เม.ย. พ.ค. มิ.ย. ก.ค. ส.ค. ก.ย. ต.ค. พ.ย. ธ.ค.'.split(' ');
const MON = TH_MON.join('|').replace(/\./g, '\\.');
const EN_MONTH = 'january february march april may june july august september october november december'.split(' ');
const NUM: Record<string, number> = { หนึ่ง: 1, สอง: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, a: 1, one: 1, two: 2, three: 3 };
// English time words only as whole words: never inside an identifier, path or URL (calculateStatement, latest_buy_impulse, posttoday.com)
const W = (s: string) => String.raw`(?<![\w.:/-])(?:${s})(?![\w.:/-])`;
const YEAR = String.raw`(?:\s*(?:ปี|พ\.ศ\.|ค\.ศ\.)?\s*((?:20|25)\d\d)|(?=\s*ปี\s*(นี้|ที่แล้ว|ก่อน)))?`; // มกราปีนี้: the month of that year
// ตุลาการ (judiciary) is no month; an abbreviation (ก.พ. = also the civil service office) only next to a day/year number or เดือน
const MONTH_RE = new RegExp(String.raw`(?:(?:ต้น|กลาง|ปลาย)?เดือน\s*)?(?:(${TH_MONTH.join('|').replace('ตุลา', 'ตุลา(?!การ)')})(?:คม|ยน|พันธ์)?`
  + String.raw`|(?:(?<=\d\s*|เดือน\s*)|(?=(?:${MON})\s*\d))(${MON})`
  + String.raw`|\b(${EN_MONTH.join('|')})\b(?=\s*\d)|\b(${EN_MONTH.filter((x) => x !== 'may').join('|')})\b)` + YEAR);
const AGO_RE = new RegExp(String.raw`(?<![\w.])(\d+|${Object.keys(NUM).join('|')})\s*(?:(วัน|สัปดาห์|อาทิตย์|เดือน|ปี)\s*(?:ที่แล้ว|ก่อน)|${W(String.raw`(day|week|month|year)s?\s+ago`)})`);
const ce = (y: string) => (Number(y) > 2400 ? Number(y) - 543 : Number(y)); // พ.ศ. → ค.ศ.
export function timeWindow(q: string, now: Date): { from?: Date; to?: Date; recent: boolean; rest: string } {
  let rest = q, from: Date | undefined, to: Date | undefined; // not lower-cased: words() splits camelCase identifiers
  const L = new Date(now.getTime() + TZ), y = L.getUTCFullYear(), m = L.getUTCMonth(), d = L.getUTCDate(), dow = (L.getUTCDay() + 6) % 7;
  const at = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd) - TZ); // local midnight
  const take = (re: RegExp, f: (x: string[]) => [Date, Date] | undefined, strip = true) => {
    const x = rest.match(new RegExp(re.source, 'i')); if (!x) return;
    if (!from) [from, to] = f(x.map((g) => g?.toLowerCase())) ?? []; // the first phrase wins; a matched relative phrase leaves the terms,
    if (strip) rest = rest.replace(x[0], ` ${x.slice(1).filter((g) => /^\d{4}$/.test(g ?? '')).join(' ')} `); // except a year (ภาษีปี 2568)
  };
  const REC = new RegExp(`ครั้งก่อน|ครั้งที่แล้ว|ครั้งล่าสุด|ล่าสุด|${W('last time|latest|recently|most recent')}`, 'gi');
  const recent = REC.test(rest);
  rest = rest.replace(REC, ' ');
  const k01 = (x: string[]) => (x[1] === 'นี้' || x[2] === 'this' ? 0 : 1);
  take(AGO_RE, (x) => { // N units ago → that unit ±1 (soft)
    const k = NUM[x[1]] ?? Number(x[1]), u = x[2] ?? x[3];
    if (k > 200) return; // '99999999999 days ago' would be an Invalid Date (pg rejects it)
    return u === 'วัน' || u === 'day' ? [at(y, m, d - k - 1), at(y, m, d - k + 2)]
      : u === 'เดือน' || u === 'month' ? [at(y, m - k - 1, 1), at(y, m - k + 2, 1)]
        : u === 'ปี' || u === 'year' ? [at(y - k, 0, 1), at(y - k + 1, 0, 1)] : [at(y, m, d - 7 * k - 7), at(y, m, d - 7 * k + 7)];
  });
  take(/เมื่อวานซืน/, () => [at(y, m, d - 2), at(y, m, d - 1)]);
  take(new RegExp(`เมื่อวาน|${W('yesterday')}`), () => [at(y, m, d - 1), at(y, m, d)]);
  take(new RegExp(`วันนี้|${W('today')}`), () => [at(y, m, d), at(y, m, d + 1)]);
  take(MONTH_RE, (x) => {
    const mm = x[1] ? TH_MONTH.indexOf(x[1]) : x[2] ? TH_MON.indexOf(x[2]) : EN_MONTH.indexOf(x[3] ?? x[4]);
    const yy = x[5] ? ce(x[5]) : x[6] ? y - k01([, x[6]] as string[]) : mm <= m ? y : y - 1; // no year: the latest such month
    return [at(yy, mm, 1), at(yy, mm + 1, 1)];
  }, false); // month names stay terms: dated text (timeline, notes) spells them out
  take(new RegExp(`(?:สัปดาห์|อาทิตย์)\\s*(นี้|ที่แล้ว|ก่อน)|${W('(this|last) week')}`), (x) => [at(y, m, d - dow - 7 * k01(x)), at(y, m, d - dow - 7 * k01(x) + 7)]);
  take(new RegExp(`เดือน\\s*(นี้|ที่แล้ว|ก่อน)|${W('(this|last) month')}`), (x) => [at(y, m - k01(x), 1), at(y, m - k01(x) + 1, 1)]);
  take(new RegExp(`ปี\\s*(นี้|ที่แล้ว|ก่อน)|${W('(this|last) year')}`), (x) => [at(y - k01(x), 0, 1), at(y - k01(x) + 1, 0, 1)]);
  take(/(?:ปี|พ\.ศ\.|ค\.ศ\.|\bin)\s*((?:20|25)\d\d)\b/, (x) => [at(ce(x[1]), 0, 1), at(ce(x[1]) + 1, 0, 1)]);
  return { from, to, recent, rest };
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
  // DELETE, not TRUNCATE: TRUNCATE's ACCESS EXCLUSIVE lock stalled every search for the ~0.8 s of ts_stat; readers now keep
  // the old rows (MVCC) until COMMIT. ponytail: ~120k dead rows per refresh (hourly), autovacuum reclaims them
  await db.query(`BEGIN; SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':memhub-termdf')); DELETE FROM term_df; -- 2 refreshes at once: 2nd waits, else term_df_pkey
    INSERT INTO term_df SELECT word, ndoc FROM ts_stat('SELECT words FROM chunks WHERE source_id NOT IN
      (SELECT id FROM sources WHERE coalesce(hide_as, tool) IN (${[...PRIVATE_TOOLS].map((t) => `''${t}''`).join(', ')}))');
    COMMIT; ANALYZE chunks; ANALYZE term_df;`);
  CATALOGUE.delete(db);
}

/** ≤ max chars around the first query term, whitespace collapsed. */
export function snippet(text: string, query: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const low = normalize(flat);
  const terms = words(query).sort((a, b) => b.length - a.length);
  const at = terms.map((t) => low.indexOf(t)).find((i) => i >= 0) ?? 0;
  const [s, e] = keepCmd(text, flat.length, at, Math.max(0, Math.min(at - Math.floor(max / 4), flat.length - max)), max);
  return (s > 0 ? '…' : '') + flat.slice(s, e) + (e < flat.length ? '…' : '');
}

// ลุงจืด 2026-10-18: a recalled `[shell] ssh … && systemctl restart …` cut mid-command is useless to re-run
const CMD_MAX = 350;
const TURN_HEAD = /^(?:[A-Z]: |\[[A-Za-z][\w -]*\] )/;
/** The window [s, e) of the flattened text around flat offset `at` (from `start`, `max` long), moved to hold the whole command
 *  at `at` when it is ≤ CMD_MAX chars (widened to it when longer than max): a shell tool-call line with its continuation lines
 *  (a multi-line command, up to the next turn / tool line) or one line inside a ``` fence. */
export function keepCmd(text: string, flatLen: number, at: number, start: number, max: number): [number, number] {
  const units: [number, number][] = []; // flat offsets: the text's non-empty lines, each whitespace-collapsed, joined by ' '
  let pos = 0, fence = false, cmd = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const s = pos, e = s + line.length, ticks = /^(?:[A-Z]: )?```/.test(line);
    pos = e + 1;
    if (fence && !ticks) units.push([s, e]);
    else if (CMD_LINE.test(line)) { units.push([s, e]); cmd = true; continue; }
    else if (cmd && !ticks && !TURN_HEAD.test(line)) { units[units.length - 1][1] = e; continue; }
    cmd = false;
    if (ticks) fence = !fence;
  }
  const unit = units.find(([s, e]) => s <= at && at < e && e - s <= CMD_MAX);
  if (unit && unit[1] - unit[0] > max) return unit;
  let s = unit ? Math.max(0, Math.min(unit[0] < start ? unit[0] : unit[1] > start + max ? unit[1] - max : start, flatLen - max)) : start, e = s + max;
  // another command cut by the window's edge: dropped whole (its first half reads as a complete command); the anchor stays,
  // and the room a dropped command at the end frees shows what came before
  const short = units.filter(([u0, u1]) => u1 - u0 <= CMD_MAX);
  for (const [u0, u1] of short) if (u0 < e && e < u1 && u0 > at) e = u0 - 1;
  s = Math.max(0, Math.min(s, e - max));
  for (const [u0, u1] of short) if (u0 < s && s < u1 && u1 < at) s = u1 + 1;
  return [s, e];
}

/** YYYY-MM-DD in Thai time (UTC+7): a turn at 02:00 his time is that day, not yesterday (UTC). */
export const day = (d: Date | null) => (d ? new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' }) : '????-??-??');
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
/** `[id] 2026-09-12 19d proj-a | ✓ใช้ได้ decision | src claude:1a2b3c4d#42 | used 7x, last 2d` — old vs new, where it came from
 *  (origins(); omitted when not given) and how often it was recalled. */
export function hitLine(h: Hit, now = Date.now(), o?: Origin): string {
  const proj = projectName(h.fact_project ?? h.project ?? '') || 'global';
  let what = h.kind ? (h.kind === 'card' ? 'session card' : h.kind) : PRIVATE_TOOLS.has(h.tool) ? privateLabel(h) : h.project?.startsWith('obsidian/') ? (h.src_kind === 'daily' ? 'daily note' : 'note')
    : h.tool === 'github' ? `github ${/#\d+$/.test(h.session_id) ? 'issue/PR' : h.session_id.endsWith(':commits') ? 'commits' : 'repo'}`
    : h.src_kind === 'subagent' || h.src_kind === 'headless' ? `${h.src_kind} chat` : 'chat';
  if (h.status === 'superseded') what += ` OLD -> [${h.superseded_by ?? '?'}]`;
  else if (h.status === 'pending') what += ` PENDING-REVIEW vs [${h.review_target ?? '?'}]`;
  if (h.changed_to) what += ` (superseded by [${h.changed_to.join('] [')}]: decision here later changed)`;
  const parts = [`[${h.fid && h.kind !== 'card' ? h.fid : h.id}] ${day(h.ts)} ${age(h.ts, now)} ${proj}`, `${LABEL[h.layer ?? layerOf(h)]} ${what}`];
  if (h.why) parts.push(h.why);
  if (o) parts.push(originText(o));
  if (h.uses > 0) parts.push(`used ${h.uses}x, last ${age(h.last, now)}`);
  if (h.flags?.length) parts.push(h.flags.join(' · '));
  return parts.join(' | ');
}

/** Where a hit came from, for the reader to cite: app:session#turn (a subagent/headless run: app/sub:<its file>#turn), a GitHub
 *  ref, a note path; a fact/card: its preferred cited turn (his own words first, then the earliest) with that turn's date,
 *  ×N = sessions behind it, AI-only = no cited turn is his; memory_save = he asked to remember it (its own note is the source).
 *  Looked up after ranking, so it never moves a hit; hidden and Claude-only sources are never cited. */
export type Origin = { tag: string; ts?: Date | null; n?: number; ai?: boolean };
const CITED = `FROM unnest(fa.source_uuids) u(uuid) JOIN turns t ON t.uuid = u.uuid JOIN sources ps ON ps.id = t.source_id
  WHERE u.uuid NOT LIKE 'obs:%' AND coalesce(ps.hide_as, ps.tool) <> ALL($2::text[])`;
const SQL_ORIGIN = `
SELECT c.id, c.seq_from seq, c.turn_uuid turn, s.tool, s.kind, s.session_id sid, s.path, fa.fid IS NOT NULL fact,
       NOT EXISTS (SELECT 1 FROM unnest(fa.source_uuids) x WHERE x NOT LIKE 'obs:%') saved, p.*, q.*
FROM chunks c JOIN sources s ON s.id = c.source_id LEFT JOIN facts fa ON fa.source_id = c.source_id
LEFT JOIN LATERAL (SELECT t.seq pseq, t.uuid pturn, t.ts pts, ps.tool ptool, ps.kind pkind, ps.session_id psid, ps.path ppath ${CITED}
                   ORDER BY t.role = 'user' DESC, t.ts, t.seq LIMIT 1) p ON true
LEFT JOIN LATERAL (SELECT count(DISTINCT t.source_id)::int n, coalesce(bool_or(t.role = 'user'), false) his ${CITED}) q ON true
WHERE c.id = ANY($1::text[])`;

/** origins of these chunk ids (hits, a memory_get chunk) for a caller that may not see `hide`. One query. */
export async function origins(db: pg.Pool, ids: string[], hide: string[]): Promise<Map<string, Origin>> {
  const out = new Map<string, Origin>();
  if (!ids.length) return out;
  for (const r of (await db.query(SQL_ORIGIN, [ids, hide])).rows) {
    if (PRIVATE_TOOLS.has(r.tool)) continue; // Claude-only: the private label is all such a hit shows
    if (!r.fact) out.set(r.id, { tag: place(r.tool, r.kind, r.sid, r.path, r.seq, r.turn) });
    else if (r.saved) out.set(r.id, { tag: 'memory_save' });
    else if (r.ptool && !PRIVATE_TOOLS.has(r.ptool)) out.set(r.id, { tag: place(r.ptool, r.pkind, r.psid, r.ppath, r.pseq, r.pturn), ts: r.pts, n: r.n, ai: !r.his });
  }
  return out;
}

/** The citation of one turn: github:owner/repo@sha7 | #N, note:<vault>/<path> (≤ 56 chars), app[/sub]:<last 8 of the session
 *  (a subagent/headless run shares its main session's id and restarts seq: its own file names it)>#seq. */
export function place(tool: string, kind: string, sid: string, path: string, seq: number, turn: string): string {
  if (tool === 'github') {
    const sha = /@([0-9a-f]{7,40})$/.exec(turn)?.[1], issue = /#\d+$/.exec(sid)?.[0];
    return `github:${sid.replace(/^github:/, '').replace(/:commits$|#\d+$/, '')}${sha ? `@${sha.slice(0, 7)}` : issue ?? ''}`;
  }
  if (tool === 'obsidian') return `note:${sid.length <= 56 ? sid : `${sid.split('/')[0]}/…/${sid.split('/').at(-1)}`.slice(0, 56)}`;
  const unit = kind === 'main' ? sid : path.split(/[\\/]/).at(-1)!.replace(/\.\w+$/, '');
  return `${tool}${kind === 'main' ? '' : `/${kind === 'subagent' ? 'sub' : kind}`}:${unit.slice(-8)}#${seq}`;
}

/** `src claude:1a2b3c4d#42 2026-09-12 ×3 AI-only` ('' without an origin). */
export const originText = (o?: Origin) =>
  (o ? `src ${o.tag}${o.ts ? ` ${day(o.ts)}` : ''}${(o.n ?? 0) > 1 ? ` ×${o.n}` : ''}${o.ai ? ' AI-only' : ''}` : '');
