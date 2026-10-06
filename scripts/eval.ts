// Retrieval eval. Raw set eval/questions.json (gold = source_id + seq range of the round) and priority set eval/priority.json
// (fact / currency gold = fid; cross / agent gold = a chat turn range of another app / a subagent or headless run; judge = no gold).
// Every set is split tune/holdout 60/40 by md5(id) (raw id = raw-<source_id>-<seq>): pick parameters on tune, read holdout once.
// Ranks at K=10 (chat gold):  direct = gold has a slot of its own — headline, with ans@w (answer terms the caller really reads)
//                             shown  = gold is a result or the first ↳ (the only folded chat printed) — credits folds
//                             fold   = gold is a result or any chat folded under a fact (beyond the first only counted: +N more)
//   fact gold: rank = the fact itself, any = the fact or a chat holding one of its source turns (knowledge level)
// MCP text at limits 3/5/6/8 (exactly what memory_search prints): chars, vis = % with the gold visible (fact: in the results,
//   chat: shown), ans = % of the raw answer_gist terms visible anywhere in the text; "w" = weighted by real calls in access_log.
// usage: node scripts/eval.ts [questions.json] [--priority eval/priority.json] [--no-raw] [--dump dir] [--json file] [--brief]
//   --dump: write each judge question's limit-8 MCP output to dir/<id>.txt   --json: append this run's metrics to file
//   --brief: also memory_search detail:"brief" vs full at limits 3/6/8: chars, ≈tokens, % gold visible by id, ≈tokens of search +
//            memory_get(gold) and how often that beats full alone, % answer terms visible (raw) (extra searches)
//   env: EVAL_BEFORE=ISO (freeze corpus + clock), EVAL_SPLIT=tune|holdout|all (one split only), EVAL_PER_SESSION, EVAL_PROJECT (raw set only),
//        EVAL_SEARCH=path (alternate search module, e.g. a baseline copy), EVAL_MCP=path (alternate searchText/hitText: the baseline's output format)
//        EVAL_EXACT=1 (vector leg = exact scan, no HNSW noise: mandatory for decision runs), EVAL_EF_SEARCH=n (ANN mode only)
//   --set raw (default: questions/fine format + priority) | detail (fine format, the file's split) | assoc (N1: B-visible at limit 6 / 8 /
//        6 + '⇢ linked' lines (EVAL_ASSOC=1 → src/synapse.ts associate + mcp assocText; EVAL_ASSOC_SHUFFLE=seed = shuffled-graph control, EVAL_SHUFFLE_KINDS=a,b = shuffle only those kinds),
//        B/A direct@10, all@10, ans, chars, per stratum + edge kind). New sets read EVAL_SPLIT=tune unless told holdout|all.
//   Every run touching a holdout split appends {ts, set, split, config, who (EVAL_WHO), src diff} to EVAL_LEDGER (eval/holdout-reads.jsonl).
//   result JSON: state snapshot (index oid/options, frozen chunk ids md5, term_df, facts, src diff) + per-item outcomes `o`
// node scripts/eval.ts --compare a.json b.json: last run of each → per-question rank diffs, discordant counts, exact McNemar p,
//   bootstrap 95% CI (10k, seed 1) of the paired mean difference per outcome; warns when the state snapshots differ
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { connect, ROOT } from '../src/db.ts';
import { embed } from '../src/embed.ts';
import { PRIVATE_TOOLS } from '../src/guard.ts';
import * as view from '../src/mcp.ts';
import * as current from '../src/search.ts';
import type { Hit, Result, SearchOpts } from '../src/search.ts';
import { queryTerms, words } from '../src/thai.ts';
import { getTokens, tokens } from '../src/timeline.ts';

const { values: arg, positionals } = parseArgs({
  allowPositionals: true,
  options: { priority: { type: 'string', default: 'eval/priority.json' }, 'no-raw': { type: 'boolean' }, dump: { type: 'string' }, json: { type: 'string' }, brief: { type: 'boolean' },
    set: { type: 'string', default: 'raw' }, compare: { type: 'boolean' } },
});
if (arg.compare) { compare(positionals[0], positionals[1]); process.exit(); }
if (!['raw', 'detail', 'assoc'].includes(arg.set!)) throw new Error(`--set raw|detail|assoc, not ${arg.set}`);
const mod: typeof current = process.env.EVAL_SEARCH ? await import(pathToFileURL(resolve(process.env.EVAL_SEARCH)).href) : current;
const ui: any = process.env.EVAL_MCP ? await import(pathToFileURL(resolve(process.env.EVAL_MCP)).href) : view;
const { hitText, searchText }: typeof view = ui;
type Gold = { source_id: number; seq: number; end_seq: number };
type Item = { id: string; type: string; split: string; question: string; gold?: any; answer?: string; skip?: boolean; cue?: Gold; stratum?: string; edge_kinds_at_build?: string[] };
const db = connect('ro');
// startup options, not a SET on pool 'connect' (pg 8 deprecates a query issued from that event): every pooled connection gets them
if (process.env.EVAL_EXACT) (db as any).options.options += ' -c enable_indexscan=off'; // HNSW has no bitmap path → exact seq scan
if (process.env.EVAL_EF_SEARCH) (db as any).options.options += ` -c hnsw.ef_search=${Number(process.env.EVAL_EF_SEARCH)}`;
const hide = [...PRIVATE_TOOLS]; // what search() hides from eval (showPrivate unset)
const K = 10;
const LIMITS = [3, 5, 6, 8];
const BRIEF_LIMITS = [3, 6, 8]; // --brief (MCP caps both modes at 8, default 6)
const perSession = process.env.EVAL_PER_SESSION ? Number(process.env.EVAL_PER_SESSION) : undefined;
const before = process.env.EVAL_BEFORE ? new Date(process.env.EVAL_BEFORE) : new Date();
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const out: Record<string, any> = { at: new Date().toISOString(), before: before.toISOString(), search: process.env.EVAL_SEARCH ?? 'src/search.ts', mcp: process.env.EVAL_MCP ?? 'src/mcp.ts', rank: mod.RANK ?? null, per_session: perSession ?? null,
  set: arg.set, exact: !!process.env.EVAL_EXACT, ef_search: process.env.EVAL_EF_SEARCH ?? null, assoc: process.env.EVAL_ASSOC ?? null, compete: process.env.EVAL_COMPETE ?? null, shuffle: process.env.EVAL_ASSOC_SHUFFLE ?? null, shuffle_kinds: process.env.EVAL_SHUFFLE_KINDS ?? null, compete_kinds: process.env.MEMHUB_COMPETE_KINDS ?? null, schema: process.env.MEMHUB_PG_SCHEMA ?? null };
// the code itself: HEAD + md5 of the uncommitted src/ diff (untracked files not included)
const git = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
const srcDiff = (() => { try { return `${git('rev-parse', '--short', 'HEAD').trim()}+${md5(git('diff', 'HEAD', '--', 'src'))}`; } catch { return 'n/a'; } })();
/** Everything results depend on besides the code: index identity + options, session settings, frozen corpus, IDF table, facts. */
const snapshot = async () => ({ ...(await db.query(`SELECT c.oid::int idx, c.reloptions::text opts, i.indisvalid valid,
    current_setting('hnsw.ef_search') ef_search, current_setting('enable_indexscan') indexscan,
    (SELECT count(*)::int FROM chunks WHERE ts < $1) frozen, (SELECT md5(string_agg(id, ',' ORDER BY id)) FROM chunks WHERE ts < $1) frozen_md5,
    (SELECT count(*)::int || '/' || coalesce(sum(ndoc), 0) FROM term_df) term_df, (SELECT count(*)::int FROM facts) facts
  FROM (SELECT to_regclass('chunks_embedding') r) x LEFT JOIN pg_class c ON c.oid = x.r LEFT JOIN pg_index i ON i.indexrelid = x.r`, [before])).rows[0], src: srcDiff });
out.state = await snapshot();
if (process.env.EVAL_EXACT) { // proof: a vector-leg-shaped query (search.ts v CTE) no longer touches the HNSW index
  const plan = (await db.query(`EXPLAIN SELECT id FROM chunks WHERE embedding IS NOT NULL AND ts < $1
    ORDER BY embedding <=> (SELECT embedding FROM chunks WHERE embedding IS NOT NULL LIMIT 1) LIMIT 60`, [before])).rows.map((r) => r['QUERY PLAN']).join('\n');
  if (plan.includes('chunks_embedding')) throw new Error(`EVAL_EXACT but the vector leg still scans chunks_embedding:\n${plan}`);
}
out.corpus = (await db.query(`SELECT (SELECT count(*) FROM chunks WHERE ts < $1)::int chunks,
  (SELECT count(*) FROM facts f JOIN sources s ON s.id = f.source_id WHERE coalesce(s.status, 'active') = 'active' AND f.kind <> 'card'
     AND EXISTS (SELECT 1 FROM chunks c WHERE c.source_id = f.source_id AND c.ts < $1))::int facts`, [before])).rows[0]; // what search can see
// how many results real callers asked for (each search call logs one row per hit) → weight of each limit
const calls = (await db.query(`SELECT n, count(*)::int c FROM (SELECT max(rank) n FROM access_log WHERE kind = 'search' AND ts < $1 GROUP BY session, query, ts) z GROUP BY n`, [before])).rows;
const W: Record<number, number> = Object.fromEntries(LIMITS.map((l) => [l, 0]));
for (const r of calls) W[LIMITS.find((l) => l >= r.n) ?? 8] += r.c;
const wsum = Object.values(W).reduce((s, x) => s + x, 0) || 1;
for (const l of LIMITS) W[l] = calls.length ? W[l] / wsum : 1 / LIMITS.length;
out.limit_weights = W;

// warm embedder + PG caches so latency is the steady state, not a cold start
await embed(['warm-up'], 60_000).catch(() => console.log('WARNING: embedder down → every search is keyword-only'));
for (const w of ['warm-up', 'deploy production', 'กฎ']) await mod.search(db, w, { limit: K, before });

let keywordOnly = 0;
/** search with the hot-path embed timeout; a query that fell back to keyword-only (GPU hiccup) is retried twice. */
async function run(q: string, o: SearchOpts): Promise<Result & { ms: number }> {
  for (let i = 0; ; i++) {
    const t0 = performance.now();
    const r = await mod.search(db, q, { perSession, before, ...o });
    if (r.semantic || i === 2) { if (!r.semantic) keywordOnly++; return { ...r, ms: performance.now() - t0 }; }
  }
}
/** Chunk ids (results and their ↳) that hold a turn of `golds`. */
async function goldIds(hits: Hit[], golds: Gold[]): Promise<Set<string>> {
  const ids = hits.flatMap((h) => [h, ...(h.evidence ?? [])]).map((h) => h.id);
  if (!ids.length || !golds.length) return new Set();
  const meta = (await db.query('SELECT id, source_id, seq_from, seq_to FROM chunks WHERE id = ANY($1)', [ids])).rows;
  return new Set(meta.filter((m) => golds.some((g) => Number(m.source_id) === g.source_id && m.seq_from <= g.end_seq && m.seq_to >= g.seq)).map((m) => m.id));
}
const first = (hits: Hit[], f: (h: Hit) => boolean | undefined) => hits.findIndex((h) => f(h)) + 1;
async function chatRanks(hits: Hit[], g: Gold) {
  const ok = await goldIds(hits, [g]);
  return {
    fold: first(hits, (h) => ok.has(h.id) || h.evidence?.some((e) => ok.has(e.id))),
    shown: first(hits, (h) => ok.has(h.id) || (h.evidence?.length && ok.has(h.evidence[0].id))),
    direct: first(hits, (h) => ok.has(h.id)),
  };
}
/** % of `terms` among the words of `text`. */
const seen = (terms: string[], text: string) => { if (!terms.length) return 0; const w = new Set(words(text)); return (100 * terms.filter((t) => w.has(t)).length) / terms.length; };
const pct = (r: number[], k: number) => (100 * r.filter((x) => x && x <= k).length) / r.length;
const mrr = (r: number[]) => r.reduce((s, x) => s + (x ? 1 / x : 0), 0) / r.length;
const quant = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length * p)]; };
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
const r1 = (x: number, d = 1) => Number(x.toFixed(d));
const splitOf = (items: Item[]) => { // per type: first 60% by md5(id) → tune (same rule as eval/priority.json)
  const g = [...items].sort((a, b) => md5(a.id).localeCompare(md5(b.id)));
  g.forEach((x, i) => (x.split ??= i < Math.round(0.6 * g.length) ? 'tune' : 'holdout'));
};

// ---- collect: one K=10 search for ranks + one search per MCP limit for what the caller reads ----
type Row = { id: string; type: string; split: string; r: Record<string, number>; stale: number; vis: number; ms: number;
  L: Record<number, { chars: number; vis: number; ans: number; ms: number; mix: Record<string, number> }>;
  B?: Record<string, { chars: number; tok: number; vis: number; get?: number; ans?: number }>; // --brief: 'full@6', 'brief@6', …
  o?: Record<string, number>; stratum?: string; kinds?: string[];                                // o: paired outcomes (--compare)
  X?: Record<string, { chars: number; vis: number; ans: number; ms: number; sw?: number }>;     // assoc: '6', '8', '6L' (+ linked), '8C…'
  C?: Record<string, { chars: number; vis: number; ans: number; ms: number; sw: number }> };       // other sets: limit 8 with C2 competition
const rows: Row[] = [];
const items: Item[] = [];
const files: string[] = [];
const fresh = arg.set !== 'raw'; // new sets carry their own split and read tune unless EVAL_SPLIT=holdout|all (logged)
const SPLIT = process.env.EVAL_SPLIT ?? (fresh ? 'tune' : 'all');
if (arg.set === 'assoc') {
  if (arg.brief) throw new Error('--brief is not measured on --set assoc');
  const j = JSON.parse(readFileSync(positionals[0], 'utf8'));
  items.push(...(Array.isArray(j) ? j : j.items).filter((q: any) => !q.skip).map((q: any) => ({ ...q, type: 'assoc', answer: q.answer_gist })));
  files.push(positionals[0]);
} else if (!arg['no-raw']) {
  const f = positionals[0] ?? 'eval/questions.json';
  const raw: Item[] = JSON.parse(readFileSync(f, 'utf8')).filter((q: any) => !q.skip)
    .map((q: any) => ({ id: `raw-${q.source_id}-${q.seq}`, type: 'raw', question: q.question, answer: q.answer_gist, gold: q, ...(fresh && { split: q.split }) }));
  splitOf(raw);
  items.push(...raw);
  files.push(f);
}
if (!fresh && existsSync(arg.priority!)) { items.push(...JSON.parse(readFileSync(arg.priority!, 'utf8')).items.filter((x: Item) => !x.skip)); files.push(arg.priority!); }
const want = items.filter((x) => SPLIT === 'all' || x.split === SPLIT);
if (!want.length) console.log(`no ${SPLIT} items in ${files.join(' + ')} (EVAL_SPLIT=holdout|all to read the rest: logged)`);

// gold reachability first: a gold turn no visible pre-freeze chunk covers any more (a re-indexed note got a new ts, a forgotten
// session) cannot be found by any change → excluded and counted, never scored as a miss. Assoc cue A = any chunk of its source.
const spans = [...want.filter((x) => x.gold?.source_id !== undefined).map((x) => [x.id, x.gold] as const),
  ...want.filter((x) => x.cue).map((x) => [`${x.id}#cue`, { source_id: x.cue!.source_id, seq: 0, end_seq: 2 ** 31 - 1 }] as const)];
const covered = new Map<string, string[]>(); // span key → visible pre-freeze chunk ids holding it
for (const r of (await db.query(`SELECT g.i, array_agg(c.id ORDER BY c.id) ids FROM unnest($1::bigint[], $2::int[], $3::int[]) WITH ORDINALITY g(s, q, e, i)
    JOIN chunks c ON c.source_id = g.s AND c.seq_from <= g.e AND c.seq_to >= g.q AND c.ts < $4
    WHERE c.source_id NOT IN (SELECT id FROM sources WHERE coalesce(hide_as, tool) = ANY($5::text[])) GROUP BY g.i`,
  [spans.map(([, g]) => g.source_id), spans.map(([, g]) => g.seq), spans.map(([, g]) => g.end_seq ?? g.seq), before, hide])).rows)
  covered.set(spans[Number(r.i) - 1][0], r.ids);
const factOk = new Set((await db.query(`SELECT fid FROM facts f WHERE fid = ANY($1) AND EXISTS (SELECT 1 FROM chunks c WHERE c.source_id = f.source_id AND c.ts < $2)`,
  [want.filter((x) => x.gold?.fid).map((x) => x.gold.fid), before])).rows.map((r) => r.fid));
const lost = want.filter((x) => x.gold?.fid ? !factOk.has(x.gold.fid) : x.gold && (!covered.has(x.id) || (x.cue && !covered.has(`${x.id}#cue`))));
console.log(`gold reachability: ${want.length} items, ${lost.length} unreachable (excluded)${lost.length ? `: ${lost.map((x) => x.id).join(' ')}` : ''}`);
out.unreachable = lost.map((x) => x.id);
const todo = want.filter((x) => !lost.includes(x));

// holdout discipline: every run that reads a holdout split is logged first (no question text); a repeat read is contaminated
if (todo.some((x) => x.split === 'holdout')) {
  const ledger = process.env.EVAL_LEDGER ?? 'eval/holdout-reads.jsonl';
  const set = files.map((f) => f.replace(/\\/g, '/').split('/').pop()).join('+');
  const prior = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter((l) => l && JSON.parse(l).set === set).length : 0;
  if (prior) console.log(`!!! CONTAMINATED: the holdout of ${set} was already read ${prior}× before (${ledger})`);
  mkdirSync(dirname(resolve(ledger)), { recursive: true });
  const { before: b, search, mcp: m, exact, ef_search, assoc, shuffle, per_session, schema } = out;
  appendFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), set, split: SPLIT, n: todo.filter((x) => x.split === 'holdout').length,
    config: { before: b, search, mcp: m, exact, ef_search, assoc, shuffle, per_session, schema, project: process.env.EVAL_PROJECT ?? null },
    who: process.env.EVAL_WHO ?? 'unknown', diff: srcDiff }) + '\n');
}
// a fact's source turns: finding one of them is finding the knowledge (anyRank)
const fids = todo.filter((x) => x.type === 'fact' || x.type === 'currency').map((x) => x.gold.fid);
const srcTurns = new Map<string, Gold[]>();
for (const t of (await db.query(`SELECT f.fid, t.source_id, t.seq FROM facts f JOIN turns t ON t.uuid = ANY(f.source_uuids) WHERE f.fid = ANY($1)`, [fids])).rows)
  srcTurns.set(t.fid, [...(srcTurns.get(t.fid) ?? []), { source_id: Number(t.source_id), seq: t.seq, end_seq: t.seq }]);
if (arg.dump) mkdirSync(arg.dump, { recursive: true });

// ---- assoc (N1): the question cues A and asks for a detail only B holds; is B's gold chunk printed? ----
// (c) needs Track B: associate() (src/synapse.ts) + assocText() (src/mcp.ts); EVAL_ASSOC_SHUFFLE = its degree-preserving shuffled graph
let syn: any = null, graph: unknown = null;
if (arg.set === 'assoc' && process.env.EVAL_ASSOC) {
  syn = await import('../src/synapse.ts').catch((e) => (console.log(`NOTICE: variant (c) skipped: src/synapse.ts not loadable (${e.code ?? e.message})`), null));
  if (syn && typeof ui.assocText !== 'function') { console.log('NOTICE: variant (c) skipped: the mcp module has no assocText()'); syn = null; }
  // one graph for the whole run (the per-pool cache could reload mid-run); the shuffled control throws if shuffled() is missing
  if (syn) graph = await syn.loadGraph(db);
  if (syn && process.env.EVAL_ASSOC_SHUFFLE) graph = syn.shuffled(graph, Number(process.env.EVAL_ASSOC_SHUFFLE), process.env.EVAL_SHUFFLE_KINDS?.split(","));
} else if (arg.set === 'assoc') console.log('NOTICE: variant (c) skipped (EVAL_ASSOC unset)');
// C2 equal-slot competition (src/synapse.ts proposals + compete): EVAL_COMPETE="θ:bonus[:margin],…" → one arm '8Cθ:bonus' each (assoc: X,
// bvis/ans; other sets: vis@/ans@ at limit 8); one candidate pool per item at the lowest θ (≤ EVAL_COMPETE_POOL by act, default 8)
const C2 = (process.env.EVAL_COMPETE ?? '').split(',').filter(Boolean).map((v) => { const [theta, bonus = 0, margin = 0] = v.split(':').map(Number); return { name: `8C${v}`, theta, bonus, margin }; });
if (C2.length && !syn) {
  syn = await import('../src/synapse.ts');
  graph = await syn.loadGraph(db);
  if (process.env.EVAL_ASSOC_SHUFFLE) graph = syn.shuffled(graph, Number(process.env.EVAL_ASSOC_SHUFFLE), process.env.EVAL_SHUFFLE_KINDS?.split(","));
}
async function competeArms(res: Result): Promise<Map<string, { hits: Hit[]; ms: number; sw: number }>> {
  const m = new Map<string, { hits: Hit[]; ms: number; sw: number }>();
  if (!C2.length) return m;
  const t0 = performance.now();
  const c = res.qvec ? await syn.proposals(db, res.hits, res.qvec, { hide, filters: { before }, theta: Math.min(...C2.map((v) => v.theta)),
    pool: Number(process.env.EVAL_COMPETE_POOL ?? 8), graph }) : { props: [], sims: new Map() };
  const ms = performance.now() - t0; // = added by the competition (pool + rival similarities)
  for (const v of C2) { const hits: Hit[] = syn.compete(res.hits, c, { n: 8, theta: v.theta, bonus: v.bonus, margin: v.margin }); m.set(v.name, { hits, ms, sw: hits.filter((h) => !res.hits.includes(h)).length }); }
  return m;
}
async function assocRow(it: Item): Promise<Row> {
  const k = await run(it.question, { limit: K });
  const b = (await chatRanks(k.hits, it.gold)).direct, a = (await chatRanks(k.hits, { source_id: it.cue!.source_id, seq: 0, end_seq: 2 ** 31 - 1 })).direct;
  const gold = covered.get(it.id)!;
  // a non-card fact prints as [fid], not its chunk id → also credit the gold source's fid, but only as an entry header
  // (result line or '⇢ linked'), not a pointer like 'OLD -> [fid]' / 'changed -> [fid]'
  const fids: string[] = (await db.query(`SELECT fid FROM facts WHERE source_id = $1 AND kind <> 'card'`, [it.gold.source_id])).rows.map((r) => r.fid);
  const vis = (t: string) => (gold.some((id) => t.includes(`[${id}]`)) || fids.some((f) => `\n${t}`.includes(`\n[${f}]`) || t.includes(`⇢ linked [${f}]`)) ? 1 : 0);
  const ans = (t: string) => (it.answer ? seen(queryTerms(it.answer).map((x) => x.key), t) : 0);
  const X: Row['X'] = {};
  for (const l of [6, 8]) {
    const res = await run(it.question, { limit: l });
    const t = searchText(res.hits, it.question, res.semantic);
    X[l] = { chars: t.length, vis: vis(t), ans: ans(t), ms: res.ms };
    if (l === 8) for (const [name, c] of await competeArms(res)) { const tc = searchText(c.hits, it.question, res.semantic); X[name] = { chars: tc.length, vis: vis(tc), ans: ans(tc), ms: c.ms, sw: c.sw }; }
    if (l !== 6 || !syn || !process.env.EVAL_ASSOC) continue;
    // + linked lines, seeded and excluded like memory_search: seeds = top 3 sources (a = score / score₁), exclude every rendered source
    const shown = res.hits.flatMap((h) => [h, ...(h.evidence ?? [])]);
    const src = new Map((await db.query('SELECT id, source_id FROM chunks WHERE id = ANY($1)', [shown.map((h) => h.id)])).rows.map((r) => [r.id, Number(r.source_id)]));
    const t0 = performance.now();
    const linked = await syn.associate(db, res.hits.slice(0, 3).map((h) => ({ sourceId: src.get(h.id), chunkId: h.id, a: h.score / res.hits[0].score })),
      { hide, exclude: shown.map((h) => h.id), filters: { before }, limit: 2, graph });
    const tl = [t, ui.assocText(linked, it.question)].filter(Boolean).join('\n');
    X['6L'] = { chars: tl.length, vis: vis(tl), ans: ans(tl), ms: performance.now() - t0 }; // ms = added by the linked lines
  }
  const o: Record<string, number> = { bvis6: X[6].vis, bvis8: X[8].vis, bdirect10: b && b <= K ? 1 : 0, adirect10: a && a <= K ? 1 : 0,
    all10: a && a <= K && b && b <= K ? 1 : 0, ans6: X[6].ans, ans8: X[8].ans };
  if (X['6L']) Object.assign(o, { bvis6L: X['6L'].vis, ans6L: X['6L'].ans });
  for (const v of C2) Object.assign(o, { [`bvis${v.name}`]: X[v.name].vis, [`ans${v.name}`]: X[v.name].ans });
  return { id: it.id, type: 'assoc', split: it.split, r: { b, a }, stale: 0, vis: 0, ms: k.ms, L: {}, o, X,
    stratum: it.stratum ?? '?', kinds: it.edge_kinds_at_build?.length ? it.edge_kinds_at_build : ['none'] };
}

for (const it of todo) {
  if (it.type === 'assoc') { rows.push(await assocRow(it)); continue; }
  const project = it.type === 'raw' ? process.env.EVAL_PROJECT : undefined;
  const row: Row = { id: it.id, type: it.type, split: it.split, r: {}, stale: 0, vis: 0, ms: 0, L: {} };
  if (it.type !== 'judge') {
    const { hits, ms } = await run(it.question, { limit: K, project });
    row.ms = ms;
    if (it.type === 'fact' || it.type === 'currency') {
      const at = (fid: string) => first(hits, (h) => h.fid === fid);
      const ok = await goldIds(hits, srcTurns.get(it.gold.fid) ?? []);
      row.r = { rank: at(it.gold.fid), any: first(hits, (h) => h.fid === it.gold.fid || ok.has(h.id) || h.evidence?.some((e) => ok.has(e.id))) };
      if (it.gold.stale) row.stale = at(it.gold.stale);
    } else {
      row.r = await chatRanks(hits, it.gold);
      // % of the question's terms visible in the gold result as printed (its own slot, or the fact whose first ↳ it is)
      if (row.r.shown && row.r.shown <= 8) row.vis = seen(queryTerms(it.question).map((x) => x.key), hitText(hits[row.r.shown - 1], it.question));
    }
  }
  for (const l of LIMITS) {
    const res = await run(it.question, { limit: l, project });
    const text = searchText(res.hits, it.question, res.semantic);
    if (arg.dump && it.type === 'judge' && l === 8) writeFileSync(join(arg.dump, `${it.id}.txt`), `# ${it.id} ${it.question}\n\n${text}\n`);
    const mix: Record<string, number> = { fact: 0, card: 0, note: 0, chat: 0, agent: 0, github: 0, old: 0, ev: 0 };
    for (const h of res.hits) {
      mix[h.kind === 'card' ? 'card' : h.kind ? 'fact' : h.project?.startsWith('obsidian/') ? 'note' : h.tool === 'github' ? 'github'
        : h.src_kind === 'subagent' || h.src_kind === 'headless' ? 'agent' : 'chat']++;
      if (h.status === 'superseded') mix.old++;
      mix.ev += h.evidence?.length ?? 0;
    }
    let vis = 0;
    if (it.type === 'fact' || it.type === 'currency') vis = res.hits.some((h) => h.fid === it.gold.fid) ? 100 : 0;
    else if (it.type !== 'judge') vis = (await chatRanks(res.hits, it.gold)).shown ? 100 : 0;
    row.L[l] = { chars: text.length, vis, ans: it.answer ? seen(queryTerms(it.answer).map((x) => x.key), text) : 0, ms: res.ms, mix };
    if (l === 8 && it.type !== 'judge') for (const [name, c] of await competeArms(res)) {
      const tc = searchText(c.hits, it.question, res.semantic);
      const v = it.type === 'fact' || it.type === 'currency' ? c.hits.some((h) => h.fid === it.gold.fid) : (await chatRanks(c.hits, it.gold)).shown;
      (row.C ??= {})[name] = { chars: tc.length, vis: v ? 100 : 0, ans: it.answer ? seen(queryTerms(it.answer).map((x) => x.key), tc) : 0, ms: c.ms, sw: c.sw };
    }
  }
  if (arg.brief) {
    row.B = {};
    for (const l of BRIEF_LIMITS) {
      const res = await run(it.question, { limit: l, project });
      // gold visible by id = the id the caller would pass to memory_timeline / memory_get is printed (result or ↳)
      const ids = it.type === 'fact' || it.type === 'currency' ? [it.gold.fid] : it.type === 'judge' ? [] : [...await goldIds(res.hits, [it.gold])];
      // chunk memory_get(gold id) reads: the fact's own chunk, else the chat chunk (getTokens = its ≈tokens)
      const getId = it.type === 'fact' || it.type === 'currency' ? res.hits.find((h) => h.fid === it.gold.fid)?.id : ids[0];
      const cost = await getTokens(db, [...res.hits.map((h) => h.id), ...(getId ? [getId] : [])]);
      const texts = { full: searchText(res.hits, it.question, res.semantic), brief: view.briefText(res.hits, it.question, res.semantic, cost) };
      for (const [mode, t] of Object.entries(texts)) {
        const vis = ids.some((x) => t.includes(`[${x}]`));
        row.B[`${mode}@${l}`] = { chars: t.length, tok: tokens(t), vis: vis ? 100 : 0,
          get: vis && getId ? tokens(t) + (cost.get(getId) ?? 0) : undefined, // search + memory_get(gold)
          ans: it.answer ? seen(queryTerms(it.answer).map((x) => x.key), t) : undefined };
      }
    }
  }
  rows.push(row);
}

// ---- report ----
const R: Record<string, any> = {};
const PRIMARY = ['direct1', 'direct5', 'direct10', 'directMrr', 'ans@w'];
const fmt = (o: Record<string, number>) => Object.entries(o).filter(([k]) => k !== 'n').map(([k, v]) => `${k} ${v}`).join('  ');
const atL = (r: Row[], key: 'vis' | 'ans' | 'chars') => {
  const m = Object.fromEntries(LIMITS.map((l) => [l, mean(r.map((x) => x.L[l][key]))]));
  return { ...Object.fromEntries(LIMITS.map((l) => [`${key}@${l}`, r1(m[l], key === 'chars' ? 0 : 1)])), [`${key}@w`]: r1(LIMITS.reduce((s, l) => s + W[l] * m[l], 0), key === 'chars' ? 0 : 1) };
};
console.log(`eval  search ${out.search}${out.exact ? ' · EXACT vector' : ''}${out.ef_search ? ` · ef_search ${out.ef_search}` : ''} · before ${before.toISOString().slice(0, 16)} · limit weights ${LIMITS.map((l) => `${l}:${r1(W[l], 2)}`).join(' ')}`);
for (const type of ['raw', 'fact', 'currency', 'cross', 'agent']) {
  R[type] = {};
  for (const split of ['tune', 'holdout', 'all']) {
    const r = rows.filter((x) => x.type === type && (split === 'all' || x.split === split));
    if (!r.length) continue;
    const rk = (k: string) => r.map((x) => x.r[k]);
    let m: Record<string, number>;
    if (type === 'fact' || type === 'currency') {
      m = { r1: pct(rk('rank'), 1), r3: pct(rk('rank'), 3), mrr: mrr(rk('rank')), any1: pct(rk('any'), 1), any3: pct(rk('any'), 3), anyMrr: mrr(rk('any')) };
      if (type === 'currency') Object.assign(m, { pass: (100 * r.filter((x) => x.r.rank && (!x.stale || x.r.rank < x.stale)).length) / r.length, stale10: (100 * r.filter((x) => x.stale).length) / r.length });
    } else {
      m = {};
      for (const k of ['direct', 'shown', 'fold']) Object.assign(m, { [`${k}1`]: pct(rk(k), 1), [`${k}5`]: pct(rk(k), 5), [`${k}10`]: pct(rk(k), 10), [`${k}Mrr`]: mrr(rk(k)) });
      m.vis = mean(r.map((x) => x.vis));
    }
    Object.assign(m, atL(r, 'vis'));
    if (type === 'raw') Object.assign(m, atL(r, 'ans'));
    R[type][split] = { n: r.length, ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, r1(v, /mrr/i.test(k) ? 3 : 1)])) };
    const { n, ...rest } = R[type][split], main = PRIMARY.filter((k) => k in rest); // primary first: own slot + answer visible
    console.log(`${type.padEnd(8)} ${split.padEnd(7)} n=${String(n).padStart(3)}  ${main.map((k) => `${k} ${rest[k]}`).join('  ')}${main.length ? '  |' : ''}  ${fmt(Object.fromEntries(Object.entries(rest).filter(([k]) => !main.includes(k))))}`);
  }
}
/** Paired 0/1 outcomes x vs y over the same questions: +x-only −y-only, net and the exact McNemar p. */
const paired = (r: Row[], x: string, y: string) => {
  const xo = r.filter((q) => q.o![x] > q.o![y]).length, yo = r.filter((q) => q.o![x] < q.o![y]).length;
  return `${x} vs ${y} +${xo} −${yo} net ${xo - yo} p ${mcnemar(xo, yo).toPrecision(2)}`;
};
const assoc = rows.filter((x) => x.type === 'assoc');
if (assoc.length) { // N1: overall, per split (if both), per stratum, per edge kind at build (a question counts under each of its kinds)
  R.assoc = {};
  const V = ['6', '8', '6L', ...C2.map((v) => v.name)].filter((v) => assoc[0].X![v]);
  const groups = new Map<string, Row[]>([['all', assoc]]);
  const splits = new Set(assoc.map((x) => x.split)).size > 1;
  for (const x of assoc) for (const g of [...(splits ? [`split:${x.split}`] : []), `stratum:${x.stratum}`, ...x.kinds!.map((k) => `kind:${k}`)]) groups.set(g, [...(groups.get(g) ?? []), x]);
  for (const [g, r] of [...groups].sort(([x], [y]) => (x === 'all' ? -1 : y === 'all' ? 1 : x.localeCompare(y)))) {
    const per = (f: (x: Row, v: string) => number, d = 1) => Object.fromEntries(V.map((v) => [v, r1(mean(r.map((x) => f(x, v))), d)]));
    const m: Record<string, any> = { n: r.length, Bvis: per((x, v) => 100 * x.X![v].vis), Bd10: r1(100 * mean(r.map((x) => x.o!.bdirect10))),
      Ad10: r1(100 * mean(r.map((x) => x.o!.adirect10))), all10: r1(100 * mean(r.map((x) => x.o!.all10))), ans: per((x, v) => x.X![v].ans), chars: per((x, v) => x.X![v].chars, 0) };
    if (V.includes('6L')) Object.assign(m, { chars6L_p95: quant(r.map((x) => x.X!['6L'].chars), 0.95), linked_ms_p50: r1(quant(r.map((x) => x.X!['6L'].ms), 0.5)), linked_ms_p95: r1(quant(r.map((x) => x.X!['6L'].ms), 0.95)) });
    m.paired = [...(V.includes('6L') ? [paired(r, 'bvis6L', 'bvis8'), paired(r, 'bvis6L', 'bvis6')] : []), ...C2.map((v) => paired(r, `bvis${v.name}`, 'bvis8')), paired(r, 'bvis8', 'bvis6')];
    m.c2 = Object.fromEntries(C2.map((v) => [v.name, { added_chars_p50: quant(r.map((x) => x.X![v.name].chars - x.X![8].chars), 0.5), added_chars_p95: quant(r.map((x) => x.X![v.name].chars - x.X![8].chars), 0.95),
      ms_p50: r1(quant(r.map((x) => x.X![v.name].ms), 0.5)), ms_p95: r1(quant(r.map((x) => x.X![v.name].ms), 0.95)), swapped_pct: r1(100 * mean(r.map((x) => (x.X![v.name].sw ? 1 : 0)))) }]));
    R.assoc[g] = m;
    console.log(`assoc ${g.padEnd(18)} n=${String(m.n).padStart(3)}  B-visible@${V.map((v) => `${v} ${m.Bvis[v]}`).join(' / ')}  Bd@10 ${m.Bd10}  Ad@10 ${m.Ad10}  all@10 ${m.all10}` +
      `  ans ${V.map((v) => m.ans[v]).join('/')}  chars ${V.map((v) => m.chars[v]).join('/')}${V.includes('6L') ? `  6L p95 ${m.chars6L_p95} ch, +${m.linked_ms_p50}/${m.linked_ms_p95} ms` : ''}  | ${m.paired.join(' · ')}`);
  }
}
for (const [name, c] of Object.entries((assoc.length && R.assoc.all.c2) || {}) as [string, any][])
  console.log(`c2 ${name.padEnd(12)} all: added chars p50 ${c.added_chars_p50} p95 ${c.added_chars_p95}  ms p50 ${c.ms_p50} p95 ${c.ms_p95}  items with a graph slot ${c.swapped_pct}%`);
/** Per-question paired outcomes for --compare: 1/0 = hit within the cut; rr (1/rank) and ans@w are continuous. */
const outcomes = (x: Row): Record<string, number> => {
  if (x.type === 'judge') return {};
  const hit = (k: string, n: number) => (x.r[k] && x.r[k] <= n ? 1 : 0);
  const fact = x.type === 'fact' || x.type === 'currency', key = fact ? 'rank' : 'direct';
  const o: Record<string, number> = fact ? { rank1: hit('rank', 1), rank3: hit('rank', 3), any3: hit('any', 3) }
    : { direct1: hit('direct', 1), direct5: hit('direct', 5), direct10: hit('direct', K), shown10: hit('shown', K) };
  o.rr = x.r[key] ? 1 / x.r[key] : 0;
  for (const l of LIMITS) o[`vis@${l}`] = x.L[l].vis / 100;
  if (x.type === 'raw') o['ans@w'] = LIMITS.reduce((s, l) => s + W[l] * x.L[l].ans, 0);
  if (x.C) { o['ans@8'] = x.L[8].ans; for (const [k, c] of Object.entries(x.C)) Object.assign(o, { [`vis@${k}`]: c.vis / 100, [`ans@${k}`]: c.ans }); }
  return o;
};
const mcp = (r: Row[]) => ({
  n: r.length, ...atL(r, 'chars'), chars8_p95: quant(r.map((x) => x.L[8].chars), 0.95),
  p50: Math.round(quant(r.map((x) => x.L[8].ms), 0.5)), p95: Math.round(quant(r.map((x) => x.L[8].ms), 0.95)),
  mix8: Object.fromEntries(Object.keys(r[0].L[8].mix).map((k) => [k, r1(mean(r.map((x) => x.L[8].mix[k])), 2)])),
});
const lim = rows.filter((x) => x.L[8]); // assoc rows have their own text metrics
R.mcp = Object.fromEntries(['tune', 'holdout', 'all'].map((s) => [s, lim.filter((x) => s === 'all' || x.split === s)]).filter(([, r]) => r.length).map(([s, r]) => [s, mcp(r as Row[])]));
for (const s of Object.keys(R.mcp)) { const { mix8, ...a } = R.mcp[s]; console.log(`mcp text ${s.padEnd(7)} n=${a.n}  ${fmt(a)}  mix@8 ${fmt(mix8)}`); }
// C2 on the other sets: limit-8 visibility / answer terms / chars, plain vs competition, per split
for (const v of C2) for (const split of ['tune', 'holdout', 'all']) {
  const r = rows.filter((x) => x.C?.[v.name] && (split === 'all' || x.split === split)).map((x) => ({ ...x, o: outcomes(x) }));
  if (!r.length || (split === 'all' && r.length === rows.filter((x) => x.C && x.split === r[0].split).length)) continue;
  const d = r.map((x) => x.C![v.name].chars - x.L[8].chars);
  console.log(`c2 ${v.name.padEnd(12)} ${split.padEnd(7)} n=${r.length}  vis@8 ${r1(mean(r.map((x) => x.L[8].vis)))} → ${r1(mean(r.map((x) => x.C![v.name].vis)))}  ${paired(r, `vis@${v.name}`, 'vis@8')}` +
    `  ans@8 ${r1(mean(r.map((x) => x.L[8].ans)))} → ${r1(mean(r.map((x) => x.C![v.name].ans)))}  added chars p50 ${quant(d, 0.5)} p95 ${quant(d, 0.95)}  ms p95 ${r1(quant(r.map((x) => x.C![v.name].ms), 0.95))}` +
    `  graph slot ${r1(100 * mean(r.map((x) => (x.C![v.name].sw ? 1 : 0))))}%  lost: ${r.filter((x) => x.o['vis@8'] > x.o[`vis@${v.name}`]).map((x) => x.id).join(' ') || '-'}`);
}
const k10 = rows.filter((x) => x.type === 'raw').map((x) => x.ms);
if (k10.length) console.log(`raw search latency (K=10) p50 ${Math.round(quant(k10, 0.5))}ms p95 ${Math.round(quant(k10, 0.95))}ms`);
if (arg.brief) { // chars/tokens over every item; visibility over items with a gold (not judge)
  R.brief = {};
  const def = (v: (number | undefined)[]) => v.filter((x): x is number => x !== undefined);
  for (const k of Object.keys(rows[0].B!)) {
    const g = rows.filter((x) => x.type !== 'judge');
    const got = rows.filter((x) => x.B![k].get !== undefined), full = k.replace('brief', 'full'); // get = only where gold is visible
    R.brief[k] = { chars: r1(mean(rows.map((x) => x.B![k].chars)), 0), tok: r1(mean(rows.map((x) => x.B![k].tok)), 0), vis: r1(mean(g.map((x) => x.B![k].vis))),
      get: r1(mean(got.map((x) => x.B![k].get!)), 0), getN: got.length, ans: r1(mean(def(rows.map((x) => x.B![k].ans)))),
      // brief only pays off when search + memory_get(gold) is cheaper than the full search alone
      ...(k !== full && got.length ? { getOverFull: r1((100 * got.filter((x) => x.B![k].get! > x.B![full].tok).length) / got.length) } : {}) };
  }
  console.log(`brief vs full (n=${rows.length}, vis n=${rows.filter((x) => x.type !== 'judge').length}, ans n=${def(rows.map((x) => x.B![`full@${BRIEF_LIMITS[0]}`].ans)).length}, ≈t = timeline.ts estimate):\n` +
    Object.entries(R.brief).map(([k, v]: [string, any]) => `  ${k.padEnd(9)} chars ${String(v.chars).padStart(5)}  ≈t ${String(v.tok).padStart(5)}  gold visible ${v.vis}%` +
      `  +get(gold) ≈t ${String(v.get).padStart(5)} (n=${v.getN})  answer terms ${v.ans}%${v.getOverFull !== undefined ? `  brief+get > full alone ${v.getOverFull}%` : ''}`).join('\n'));
  for (const type of ['raw', 'fact', 'currency', 'cross', 'agent']) {
    const g = rows.filter((x) => x.type === type);
    if (g.length) console.log(`  vis ${type.padEnd(8)} n=${String(g.length).padStart(3)}  ${Object.keys(R.brief).map((k) => `${k} ${r1(mean(g.map((x) => x.B![k].vis)))}`).join('  ')}`);
  }
}
R.items = rows.map((x) => { const { L, ms, ...r } = x; return { ...r, o: r.o ?? outcomes(x), ...(L[8] && { chars: Object.fromEntries(LIMITS.map((l) => [l, L[l].chars])), visL: Object.fromEntries(LIMITS.map((l) => [l, L[l].vis])) }) }; }); // per-question, no text
const end = await snapshot(); // the hourly sync may refresh term_df / facts mid-run
if (JSON.stringify(end) !== JSON.stringify(out.state)) { out.state_end = end; console.log(`!!! WARNING: state changed during the run: ${Object.keys(end).filter((k) => end[k] !== out.state[k]).join(', ')}`); }
out.results = R;
out.keyword_only = keywordOnly;
if (keywordOnly) console.log(`WARNING: ${keywordOnly} searches stayed keyword-only after 2 retries (embedder down?)`);
if (arg.json) {
  const prev = existsSync(arg.json) ? JSON.parse(readFileSync(arg.json, 'utf8')) : { runs: [] };
  prev.runs.push(out);
  writeFileSync(arg.json, JSON.stringify(prev, null, 1));
}
await db.end();

/** Exact two-sided McNemar test: discordant pairs b (only a) vs c (only b) ~ Binomial(b + c, ½). */
function mcnemar(b: number, c: number): number {
  const n = b + c;
  let lp = n * Math.log(0.5), tail = 0; // log pmf, so n in the thousands doesn't underflow 0.5^n
  for (let i = 0; i <= Math.min(b, c); i++) { tail += Math.exp(lp); lp += Math.log((n - i) / (i + 1)); }
  return Math.min(1, 2 * tail);
}
/** Bootstrap 95% CI of the mean of paired differences d (10k resamples, LCG seed 1 = reproducible). */
function bootCI(d: number[], n = 10_000, seed = 1): [number, number] {
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const m: number[] = [];
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < d.length; j++) s += d[Math.floor(rnd() * d.length)]; m.push(s / d.length); }
  m.sort((x, y) => x - y);
  return [m[Math.floor(0.025 * n)], m[Math.ceil(0.975 * n) - 1]];
}
/** --compare a.json b.json (last run of each): state/config differences, per-question rank diffs, per outcome a vs b paired. */
function compare(fa: string, fb: string) {
  const [a, b] = [fa, fb].map((f) => JSON.parse(readFileSync(f, 'utf8')).runs.at(-1));
  if (!a.state || !b.state) console.log('!!! WARNING: a run has no state snapshot (older eval.ts): comparability unknown');
  for (const k of new Set([...Object.keys(a.state ?? {}), ...Object.keys(b.state ?? {})])) if (a.state?.[k] !== b.state?.[k])
    console.log(k === 'src' ? `note: code differs (src ${a.state?.[k]} → ${b.state?.[k]})` : `!!! WARNING: state.${k} differs: ${a.state?.[k]} → ${b.state?.[k]} (not the same index / corpus / settings)`);
  for (const r of [a, b]) if (r.state_end) console.log(`!!! WARNING: state changed during the run at ${r.at}`);
  for (const k of ['before', 'search', 'mcp', 'set', 'exact', 'ef_search', 'assoc', 'shuffle', 'per_session', 'schema'])
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) console.log(`config ${k}: ${a[k]} → ${b[k]}`);
  const ia = new Map<string, any>(a.results.items.map((x: any) => [x.id, x])), ib = new Map<string, any>(b.results.items.map((x: any) => [x.id, x]));
  const ids = [...ia.keys()].filter((id) => ib.has(id));
  if (ids.length < Math.max(ia.size, ib.size)) console.log(`!!! WARNING: unpaired items skipped: only in a ${ia.size - ids.length}, only in b ${ib.size - ids.length}`);
  const diff = ids.filter((id) => JSON.stringify(ia.get(id).r) !== JSON.stringify(ib.get(id).r));
  console.log(`per-question rank diffs: ${diff.length} of ${ids.length}`);
  for (const id of diff.slice(0, 40)) console.log(`  ${id}  ${JSON.stringify(ia.get(id).r)} → ${JSON.stringify(ib.get(id).r)}`);
  if (diff.length > 40) console.log(`  … +${diff.length - 40} more`);
  const keys = [...new Set(ids.flatMap((id) => Object.keys(ia.get(id).o ?? {})))];
  for (const k of keys) {
    const p = ids.filter((id) => ia.get(id).o?.[k] !== undefined && ib.get(id).o?.[k] !== undefined).map((id) => [ia.get(id).o[k], ib.get(id).o[k]]);
    if (!p.length) continue;
    const bin = p.every(([x, y]) => (x === 0 || x === 1) && (y === 0 || y === 1)), sc = bin ? 100 : 1; // binary → percentage points
    const avg = (i: number) => (sc * p.reduce((s, x) => s + x[i], 0)) / p.length, f = (x: number) => x.toFixed(bin ? 1 : 3);
    const [lo, hi] = bootCI(p.map(([x, y]) => sc * (y - x)));
    const won = p.filter(([x, y]) => y > x).length, lost = p.filter(([x, y]) => y < x).length;
    console.log(`${k.padEnd(9)} n=${p.length}  a ${f(avg(0))}  b ${f(avg(1))}  Δ ${f(avg(1) - avg(0))} CI95 [${f(lo)}, ${f(hi)}]` +
      (bin ? `  b-only ${won}  a-only ${lost}  net ${won - lost}  McNemar p ${mcnemar(won, lost).toPrecision(3)}` : `  b>a ${won}  b<a ${lost}`));
  }
}
