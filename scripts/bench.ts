// Public memory benchmarks (LongMemEval_S, LoCoMo) through memory-hub's REAL pipeline: redaction → round chunks → Thai/English
// words + bigrams → bge-m3 vectors → search() (RRF of the keyword/bigram/vector legs + priors). Retrieval only: no LLM answers.
// Own schema memhub_bench (never the main one), created like `node src/cli.ts migrate`. It is also the embedding cache: a re-run
// only embeds new chunks, and bench_vec keeps vectors of projects a smaller run dropped (the corpus = exactly this run's data).
//   LongMemEval_S (cleaned): one project per question = its own ~50-session haystack; fixed-seed subset stratified by type.
//   LoCoMo (locomo10): one project per conversation, all 1,986 questions.
// Metric definitions, dataset URLs + sha256, results: docs/benchmarks.md.  Data files: bench/data/ (gitignored).
// usage: node scripts/bench.ts [--lme 54] [--locomo 10] [--seed 1] [--json bench/data/results.json]
//   embedding runs at MEMHUB_EMBED_RATE (default 10/s, keep ≤ 10): ~600 chunks per LongMemEval question ≈ 1 min each
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type pg from 'pg';
import type { Role } from '../src/claude.ts';
import { connect, ROOT } from '../src/db.ts';
import { backfill, embed, EMBED_MODEL, toVec } from '../src/embed.ts';
import { clean, projectName, store, type StoredTurn } from '../src/importer.ts';
import { refreshTermDf, search, type SearchOpts } from '../src/search.ts';

// ---------------- metrics: ports of the official code (test/bench-metrics.test.ts) ----------------

/** LongMemEval src/retrieval/eval_utils.py dcg: rel₁ + Σ_{i≥2} relᵢ / log2(i) — position 2 is not discounted. */
export const dcg = (rel: number[], k: number) => rel.slice(0, k).reduce((s, r, i) => s + (i ? r / Math.log2(i + 1) : r), 0);

/** eval_utils.ndcg: rankings = corpus indexes, best first; the ideal puts every relevant corpus doc first. */
export function ndcg(rankings: number[], correct: string[], corpusIds: string[], k: number) {
  const rel = corpusIds.map((id) => (correct.includes(id) ? 1 : 0));
  const ideal = dcg([...rel].sort((a, b) => b - a), k);
  return ideal ? dcg(rankings.slice(0, k).map((i) => rel[i]), k) / ideal : 0;
}

/** eval_utils.evaluate_retrieval: recall_any / recall_all = some / every correct doc among the top k. */
export function evaluateRetrieval(rankings: number[], correct: string[], corpusIds: string[], k: number) {
  const top = new Set(rankings.slice(0, k).map((i) => corpusIds[i]));
  return { any: Number(correct.some((d) => top.has(d))), all: Number(correct.every((d) => top.has(d))), ndcg: ndcg(rankings, correct, corpusIds, k) };
}

/** LoCoMo task_eval/evaluation.py recall_acc (dialog RAG): share of evidence dia_ids that were retrieved; no evidence → 1. */
export const recallAcc = (evidence: string[], retrieved: string[]) =>
  evidence.length ? evidence.filter((e) => retrieved.includes(e)).length / evidence.length : 1;

/** mempalace benchmarks/locomo_bench.py, session granularity: share of distinct evidence sessions among the retrieved ones. */
export function sessionRecall(evidence: string[], sessions: number[]) {
  const ev = new Set(evidence.map((e) => /^D(\d+):/.exec(e)?.[1]).filter((s) => s !== undefined).map(Number));
  return ev.size ? [...ev].filter((s) => sessions.includes(s)).length / ev.size : 1;
}

/** Fixed-seed sample of n, stratified by question_type: each type gets its share (largest remainder), shuffled within the type. */
export function stratified<T extends { question_type: string }>(items: T[], n: number, seed: number): T[] {
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const types = [...Map.groupBy(items, (x) => x.question_type)].map(([, g]) => ({ g, q: (n * g.length) / items.length, n: 0 }));
  for (const t of types) t.n = Math.floor(t.q);
  const left = n - types.reduce((s, t) => s + t.n, 0);
  for (const t of [...types].sort((a, b) => (b.q % 1) - (a.q % 1)).slice(0, left)) t.n++;
  const pick = new Set(types.flatMap(({ g, n }) => {
    const s = [...g];
    for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
    return s.slice(0, n);
  }));
  return items.filter((x) => pick.has(x));
}

/** 95 % Wilson interval of a proportion (the LongMemEval subset is small). */
const wilson = (p: number, n: number, z = 1.96) => {
  const d = 1 + (z * z) / n, c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
};

// ---------------- datasets → sessions of the real importer ----------------

type LmeQ = { question_id: string; question_type: string; question: string; question_date: string; answer_session_ids: string[];
  haystack_dates: string[]; haystack_session_ids: string[]; haystack_sessions: { role: Role; content: string; has_answer?: boolean }[][] };
type Dialog = { speaker: string; dia_id: string; text: string; blip_caption?: string };
type Conv = { sample_id: string; conversation: Record<string, any>; qa: { question: string; evidence?: string[]; category: number }[] };
type Sess = { path: string; project: string; sessionId: string; turns: StoredTurn[] };

/** "2023/05/20 (Sat) 02:21" → ms. Neither dataset has a time zone: read as UTC. */
const lmeTime = (s: string) => {
  const m = /^(\d+)\/(\d+)\/(\d+) \(\w+\) (\d+):(\d+)$/.exec(s);
  if (!m) throw new Error(`LongMemEval date: ${s}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
};
/** "1:56 pm on 8 May, 2023" → ms */
const locomoTime = (s: string) => {
  const m = /^(\d+):(\d+) (am|pm) on (\d+) (\w+), (\d+)$/.exec(s);
  if (!m) throw new Error(`LoCoMo date: ${s}`);
  return Date.UTC(+m[6], 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[5].slice(0, 3).toLowerCase()) / 3, +m[4], (+m[1] % 12) + (m[3] === 'pm' ? 12 : 0), +m[2]);
};
/** Messages → turns like every import (clean = strip <private> + redact); message i at session time + i ms (keeps the order). */
const session = (bench: string, project: string, key: string, t0: number, msgs: { id: string; role: Role; text: string }[]): Sess => ({
  path: `bench:${bench}:${key}`, project, sessionId: key,
  turns: msgs.map((m, i) => ({ uuid: `${key}|${m.id}`, parentUuid: i ? `${key}|${msgs[i - 1].id}` : null, seq: i, role: m.role, ts: new Date(t0 + i).toISOString(), text: clean(m.text) })),
});
const lmeProject = (q: LmeQ) => `bench/lme/${q.question_id.toLowerCase()}/`; // trailing / : search's project filter is a LIKE '%…%'
const locomoProject = (c: Conv) => `bench/locomo/${c.sample_id.toLowerCase()}/`;
// 13 haystacks hold one session twice (same id + text, another date): stored once, at its first date
const lmeSessions = (q: LmeQ) => q.haystack_sessions.flatMap((s, j) => q.haystack_session_ids.indexOf(q.haystack_session_ids[j]) < j ? [] :
  [session('lme', lmeProject(q), `${q.question_id}|${q.haystack_session_ids[j]}`, lmeTime(q.haystack_dates[j]), s.map((t, i) => ({ id: String(i), role: t.role, text: t.content })))]);
// a speaker_a turn opens a round (chunk), like a user prompt; text in LoCoMo's own dialog-RAG format (task_eval/gpt_utils.py)
const locomoSessions = (c: Conv) => Object.keys(c.conversation).filter((k) => /^session_\d+$/.test(k)).map((k) =>
  session('locomo', locomoProject(c), `${c.sample_id}|${k.slice(8)}`, locomoTime(c.conversation[`${k}_date_time`]),
    (c.conversation[k] as Dialog[]).map((d) => ({ id: d.dia_id, role: d.speaker === c.conversation.speaker_a ? 'user' : 'assistant',
      text: `${d.speaker} said, "${d.text}"${d.blip_caption ? ` and shared ${d.blip_caption}` : ''}` }))));

/** Store new/changed sessions with the importer's store(); drop sessions this run doesn't use (IDF is corpus-wide). */
async function ingest(db: pg.Pool, all: Sess[]) {
  const have = new Map((await db.query('SELECT path, sha256 FROM sources')).rows.map((r) => [r.path, r.sha256]));
  let stored = 0;
  for (const s of all) {
    const sha = createHash('sha256').update(JSON.stringify(s.turns)).digest('hex');
    if (have.get(s.path) === sha) continue;
    await store(db, { tool: 'bench', path: s.path, kind: 'main', sessionId: s.sessionId, project: s.project, size: 0, mtimeMs: 0, sha256: sha,
      label: projectName(s.project), replace: have.has(s.path) }, s.turns);
    if (++stored % 500 === 0) console.log(`stored ${stored} sessions`);
  }
  const dropped = (await db.query('DELETE FROM sources WHERE NOT (path = ANY($1))', [all.map((s) => s.path)])).rowCount;
  return { stored, dropped };
}

// ---------------- retrieval ----------------

const MODES = ['hybrid', 'keyword', 'semantic'] as const;
type Mode = (typeof MODES)[number];
type Ranked = { sessions: string[]; chunks: string[] }; // session_ids (best chunk per session), chunk ids (as search() returns them)
const RATE = Number(process.env.MEMHUB_EMBED_RATE) || 10; // query embeddings share Ollama's sockets with backfill (src/embed.ts)
// the vector leg of search() alone (its CTE v): HNSW cosine, same project/date filters
const VEC_SQL = `SELECT id, session_id FROM chunks WHERE embedding IS NOT NULL AND project LIKE '%' || $1 || '%' AND ($2::timestamptz IS NULL OR ts < $2)
  ORDER BY embedding <=> $3::halfvec LIMIT 60`;

function retriever(db: pg.Pool) {
  const t0 = Date.now(), lat = { hybrid: [] as number[], keyword: [] as number[] };
  let embeds = 0, keywordOnly = 0;
  const pace = async () => { const ahead = (++embeds * 1000) / RATE - (Date.now() - t0); if (ahead > 0) await new Promise((r) => setTimeout(r, ahead)); };
  /** search() as memory_search calls it; a hybrid call whose query embedding timed out (300 ms hot path) is retried twice. */
  async function run(mode: 'hybrid' | 'keyword', query: string, o: SearchOpts) {
    for (let i = 0; ; i++) {
      if (mode === 'hybrid') await pace();
      const t = performance.now();
      const r = await search(db, query, { ...o, semantic: mode === 'hybrid' });
      if (mode === 'keyword' || r.semantic || i === 2) { if (mode === 'hybrid' && !r.semantic) keywordOnly++; return { ...r, ms: performance.now() - t }; }
    }
  }
  async function rank(mode: Mode, query: string, project: string, before?: Date): Promise<Ranked> {
    if (mode === 'semantic') {
      await pace();
      const rows = (await db.query(VEC_SQL, [project, before ?? null, toVec((await embed([query]))[0])])).rows;
      return { sessions: [...new Set(rows.map((r) => r.session_id as string))], chunks: rows.map((r) => r.id) };
    }
    const o = { project, before, limit: 20 }; // 20 = search()'s cap
    const s = await run(mode, query, { ...o, perSession: 1 }), c = await run(mode, query, o); // c: default 3 chunks per session
    lat[mode].push(c.ms);
    return { sessions: s.hits.map((h) => h.session_id), chunks: c.hits.map((h) => h.id) };
  }
  return { rank, lat, stats: () => ({ keywordOnly }) };
}

/** chunk id → its turn uuids in order (a chunk is a part of one round). */
const chunkTurns = async (db: pg.Pool, project: string) => new Map<string, string[]>((await db.query(
  `SELECT c.id, array_agg(t.uuid ORDER BY t.seq) u FROM chunks c JOIN turns t ON t.source_id = c.source_id AND t.seq BETWEEN c.seq_from AND c.seq_to
   WHERE c.project = $1 GROUP BY c.id`, [project])).rows.map((r) => [r.id, r.u]));

const KS = [1, 3, 5, 10];
/** One LongMemEval question: official session + turn metrics (run_retrieval.py) and mempalace's session R@k. */
function lmeScore(q: LmeQ, r: Ranked, turns: Map<string, string[]>) {
  // official corpora (process_item_flat_index): evidence sessions' ids contain 'answer', renamed 'noans' (not a target) when no
  // user turn has_answer; the turn index holds user turns only, id = <session>_<position in session, 1-based>
  const userHas = (j: number) => q.haystack_sessions[j].some((t) => t.role === 'user' && t.has_answer);
  const sessIds = q.haystack_session_ids.map((s, j) => (s.includes('answer') && !userHas(j) ? s.replaceAll('answer', 'noans') : s));
  const turnIds: string[] = [], turnAt = new Map<string, number>();
  q.haystack_sessions.forEach((s, j) => s.forEach((t, i) => {
    if (t.role !== 'user') return;
    const id = `${q.haystack_session_ids[j]}_${i + 1}`;
    turnAt.set(id, turnIds.length);
    turnIds.push(id.includes('answer') && !t.has_answer ? id.replaceAll('answer', 'noans') : id);
  }));
  const sj = new Map(q.haystack_session_ids.map((s, j) => [s, j]));
  const sessRank = r.sessions.map((s) => sj.get(s.split('|')[1])!);
  // a chunk belongs to one round (a user turn + its replies) → it ranks that user turn
  const turnRank = [...new Set(r.chunks.flatMap((c) => {
    const [, sid, i] = turns.get(c)![0].split('|');
    const s = q.haystack_sessions[sj.get(sid)!];
    let k = Number(i);
    while (k >= 0 && s[k].role !== 'user') k--;
    return k < 0 ? [] : [turnAt.get(`${sid}_${k + 1}`)!];
  }))];
  const m: Record<string, number> = {};
  const cs = sessIds.filter((s) => s.includes('answer')), ct = turnIds.filter((s) => s.includes('answer'));
  for (const k of KS) {
    const s = evaluateRetrieval(sessRank, cs, sessIds, k), t = evaluateRetrieval(turnRank, ct, turnIds, k);
    Object.assign(m, { [`s_any@${k}`]: s.any, [`s_all@${k}`]: s.all, [`s_ndcg@${k}`]: s.ndcg, [`t_any@${k}`]: t.any, [`t_all@${k}`]: t.all, [`t_ndcg@${k}`]: t.ndcg });
  }
  // mempalace longmemeval_bench.py: any answer_session_id among the top-k sessions, every question counted
  for (const k of [5, 10]) m[`mp@${k}`] = Number(r.sessions.slice(0, k).some((s) => q.answer_session_ids.includes(s.split('|')[1])));
  return m;
}

/** One LoCoMo question: mempalace's session recall@k and LoCoMo's dialog recall_acc with k dialogs handed to the reader. */
function locomoScore(evidence: string[], r: Ranked, turns: Map<string, string[]>) {
  const sess = r.sessions.map((s) => Number(s.split('|')[1]));
  const dias = [...new Set(r.chunks.flatMap((c) => turns.get(c)!.map((u) => u.split('|')[2])))];
  return { 's@5': sessionRecall(evidence, sess.slice(0, 5)), 's@10': sessionRecall(evidence, sess.slice(0, 10)),
    'd@5': recallAcc(evidence, dias.slice(0, 5)), 'd@10': recallAcc(evidence, dias.slice(0, 10)), 'd@25': recallAcc(evidence, dias.slice(0, 25)) };
}

// ---------------- report ----------------

const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / (v.length || 1);
const quant = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length * p)]; };
const r1 = (x: number) => Number(x.toFixed(1));
/** Mean of each metric over rows, in % (nDCG ×100). */
const avg = (rows: Record<string, number>[], keys: string[]) => Object.fromEntries(keys.map((k) => [k, r1(100 * mean(rows.map((x) => x[k])))]));
const byMode = (rows: Record<Mode, Record<string, number>>[], keys: string[]) => Object.fromEntries(MODES.map((md) => [md, avg(rows.map((x) => x[md]), keys)]));

if (import.meta.main) {
  const { values: arg } = parseArgs({ options: {
    lme: { type: 'string', default: '54' }, locomo: { type: 'string', default: '10' }, seed: { type: 'string', default: '1' },
    json: { type: 'string', default: 'bench/data/results.json' } } });
  process.env.MEMHUB_PG_SCHEMA = 'memhub_bench';
  const db = connect('rw');
  await db.query('CREATE SCHEMA IF NOT EXISTS memhub_bench');
  // guard: schema.sql replaces a view — it must never run against the main schema
  if ((await db.query('SELECT current_schema() s')).rows[0].s !== 'memhub_bench') throw new Error('search_path is not memhub_bench');
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8')); // = node src/cli.ts migrate
  await db.query('CREATE TABLE IF NOT EXISTS bench_vec (id text, model text, e halfvec(1024), PRIMARY KEY (id, model))');
  const keepVecs = () => db.query('INSERT INTO bench_vec SELECT id, model_ver, embedding FROM chunks WHERE embedding IS NOT NULL ON CONFLICT DO NOTHING');

  const data = (f: string) => JSON.parse(readFileSync(join(ROOT, 'bench', 'data', f), 'utf8'));
  const allLme: LmeQ[] = data('longmemeval_s_cleaned.json');
  const lme = stratified(allLme, Number(arg.lme), Number(arg.seed));
  const convs: Conv[] = (data('locomo10.json') as Conv[]).slice(0, Number(arg.locomo));
  const sessions = [...lme.flatMap(lmeSessions), ...convs.flatMap(locomoSessions)];
  console.log(`LongMemEval_S ${lme.length}/${allLme.length} questions (seed ${arg.seed}), LoCoMo ${convs.length} conversations: ${sessions.length} sessions`);

  await keepVecs(); // vectors of a crashed run / projects about to be dropped
  console.log('ingest', await ingest(db, sessions));
  await db.query('UPDATE chunks c SET embedding = v.e, model_ver = v.model FROM bench_vec v WHERE c.embedding IS NULL AND v.id = c.id AND v.model = $1', [EMBED_MODEL]);
  const todo = (await db.query('SELECT count(*)::int n FROM chunks WHERE embedding IS NULL OR model_ver IS DISTINCT FROM $1', [EMBED_MODEL])).rows[0].n;
  console.log(`embedding ${todo} chunks ≈ ${Math.ceil(todo / RATE / 60)} min at ${RATE}/s`);
  await backfill(db);
  await keepVecs();
  await refreshTermDf(db);
  const corpus = (await db.query(`SELECT split_part(project, '/', 2) bench, count(DISTINCT project)::int projects, count(*)::int chunks
    FROM chunks GROUP BY 1 ORDER BY 1`)).rows;

  await embed(['warm-up'], 60_000); // a cold model load must not count as a timeout
  const R = retriever(db);
  const lmeRows: any[] = [];
  for (const q of lme) {
    const p = lmeProject(q), turns = await chunkTurns(db, p), day = lmeTime(q.question_date);
    // before = end of the question's day: 44 questions have answer sessions later on the question's own day (the dataset's
    // clock times within a day are inconsistent); no haystack session is dated after that day → this hides nothing
    const before = new Date(day - (day % 864e5) + 864e5);
    const row: any = { id: q.question_id, type: q.question_type,
      official: !q.question_id.includes('_abs') && q.haystack_sessions.flat().some((t) => t.role === 'user' && t.has_answer) };
    for (const md of MODES) row[md] = lmeScore(q, await R.rank(md, q.question, p, before), turns);
    lmeRows.push(row);
  }
  const loRows: any[] = [];
  for (const c of convs) {
    const p = locomoProject(c), turns = await chunkTurns(db, p);
    for (const [i, qa] of c.qa.entries()) {
      const row: any = { id: `${c.sample_id}#${i}`, category: qa.category };
      for (const md of MODES) row[md] = locomoScore(qa.evidence ?? [], await R.rank(md, qa.question, p), turns);
      loRows.push(row);
    }
    console.log(`LoCoMo ${c.sample_id}: ${c.qa.length} questions`);
  }

  const off = lmeRows.filter((x) => x.official);
  const sKeys = ['s_any@1', 's_any@3', 's_any@5', 's_any@10', 's_all@5', 's_all@10', 's_ndcg@5', 's_ndcg@10'];
  const tKeys = sKeys.map((k) => k.replace('s_', 't_'));
  const loKeys = ['s@5', 's@10', 'd@5', 'd@10', 'd@25'];
  const types = [...new Set(lmeRows.map((x) => x.type))];
  const mp5 = mean(lmeRows.map((x) => x.hybrid['mp@5']));
  const summary = {
    lme: lmeRows.length ? {
      n: lmeRows.length, official_n: off.length, mempalace_def: byMode(lmeRows, ['mp@5', 'mp@10']), hybrid_mp5_ci95: wilson(mp5, lmeRows.length).map((x) => r1(100 * x)),
      session: byMode(off, sKeys), turn: byMode(off, tKeys),
      by_type: Object.fromEntries(types.map((t) => { const g = lmeRows.filter((x) => x.type === t); return [t, { n: g.length, ...avg(g.map((x) => x.hybrid), ['mp@5', 'mp@10']) }]; })),
    } : null,
    locomo: loRows.length ? {
      n: loRows.length, all: byMode(loRows, loKeys),
      by_category: Object.fromEntries([1, 2, 3, 4, 5].map((c) => { const g = loRows.filter((x) => x.category === c); return [c, { n: g.length, ...avg(g.map((x) => x.hybrid), loKeys) }]; })),
    } : null,
    latency_ms: Object.fromEntries(Object.entries(R.lat).map(([m, v]) => [m, { p50: r1(quant(v, 0.5)), p95: r1(quant(v, 0.95)) }])),
    ...R.stats(), corpus,
  };
  if (summary.lme) {
    console.log(`\nLongMemEval_S subset ${lmeRows.length}/${allLme.length} — mempalace definition (session recall_any, all questions), hybrid R@5 95% CI ${summary.lme.hybrid_mp5_ci95.join('–')}`);
    console.table(summary.lme.mempalace_def);
    console.log(`official session level (n=${off.length}: no abstention, a user turn has_answer)`); console.table(summary.lme.session);
    console.log('official turn level'); console.table(summary.lme.turn);
    console.log('hybrid by question type'); console.table(summary.lme.by_type);
  }
  if (summary.locomo) {
    console.log(`\nLoCoMo ${loRows.length} questions — s@k mempalace session recall, d@k LoCoMo recall_acc over k dialogs`);
    console.table(summary.locomo.all); console.log('hybrid by category'); console.table(summary.locomo.by_category);
  }
  console.log('search() latency (limit 20)', summary.latency_ms, 'hybrid fell back to keyword-only:', summary.keywordOnly);
  writeFileSync(arg.json!, JSON.stringify({ at: new Date().toISOString(), args: arg, model: EMBED_MODEL, summary, lme_ids: lme.map((q) => q.question_id), lme: lmeRows, locomo: loRows }, null, 1));
  console.log(`wrote ${arg.json}`);
  await db.end();
}
