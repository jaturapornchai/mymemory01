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
//   env: EVAL_BEFORE=ISO (freeze corpus + clock), EVAL_SPLIT=tune (one split only), EVAL_PER_SESSION, EVAL_PROJECT (raw set only),
//        EVAL_SEARCH=path (alternate search module, e.g. a baseline copy), EVAL_MCP=path (alternate searchText/hitText: the baseline's output format)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { connect } from '../src/db.ts';
import { embed } from '../src/embed.ts';
import * as view from '../src/mcp.ts';
import * as current from '../src/search.ts';
import type { Hit, Result, SearchOpts } from '../src/search.ts';
import { queryTerms, words } from '../src/thai.ts';
import { getTokens, tokens } from '../src/timeline.ts';

const { values: arg, positionals } = parseArgs({
  allowPositionals: true,
  options: { priority: { type: 'string', default: 'eval/priority.json' }, 'no-raw': { type: 'boolean' }, dump: { type: 'string' }, json: { type: 'string' }, brief: { type: 'boolean' } },
});
const mod: typeof current = process.env.EVAL_SEARCH ? await import(pathToFileURL(resolve(process.env.EVAL_SEARCH)).href) : current;
const { hitText, searchText }: typeof view = process.env.EVAL_MCP ? await import(pathToFileURL(resolve(process.env.EVAL_MCP)).href) : view;
type Gold = { source_id: number; seq: number; end_seq: number };
type Item = { id: string; type: string; split: string; question: string; gold?: any; answer?: string; skip?: boolean };
const db = connect('ro');
const K = 10;
const LIMITS = [3, 5, 6, 8];
const BRIEF_LIMITS = [3, 6, 8]; // --brief (MCP caps both modes at 8, default 6)
const perSession = process.env.EVAL_PER_SESSION ? Number(process.env.EVAL_PER_SESSION) : undefined;
const before = process.env.EVAL_BEFORE ? new Date(process.env.EVAL_BEFORE) : new Date();
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const out: Record<string, any> = { at: new Date().toISOString(), before: before.toISOString(), search: process.env.EVAL_SEARCH ?? 'src/search.ts', mcp: process.env.EVAL_MCP ?? 'src/mcp.ts', rank: mod.RANK ?? null, per_session: perSession ?? null };
out.corpus = (await db.query(`SELECT (SELECT count(*) FROM chunks WHERE ts < $1)::int chunks,
  (SELECT count(*) FROM facts f JOIN sources s ON s.id = f.source_id WHERE coalesce(s.status, 'active') = 'active' AND f.kind <> 'card'
     AND EXISTS (SELECT 1 FROM chunks c WHERE c.source_id = f.source_id AND c.ts < $1))::int facts`, [before])).rows[0]; // what search can see
// how many results real callers asked for (each search call logs one row per hit) → weight of each limit
const calls = (await db.query(`SELECT n, count(*)::int c FROM (SELECT max(rank) n FROM access_log WHERE kind = 'search' GROUP BY session, query, ts) z GROUP BY n`)).rows;
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
  B?: Record<string, { chars: number; tok: number; vis: number; get?: number; ans?: number }> }; // --brief: 'full@6', 'brief@6', …
const rows: Row[] = [];
const items: Item[] = [];
if (!arg['no-raw']) {
  const raw: Item[] = JSON.parse(readFileSync(positionals[0] ?? 'eval/questions.json', 'utf8')).filter((q: any) => !q.skip)
    .map((q: any) => ({ id: `raw-${q.source_id}-${q.seq}`, type: 'raw', question: q.question, answer: q.answer_gist, gold: q }));
  splitOf(raw);
  items.push(...raw);
}
if (existsSync(arg.priority!)) items.push(...JSON.parse(readFileSync(arg.priority!, 'utf8')).items.filter((x: Item) => !x.skip));
const todo = items.filter((x) => !process.env.EVAL_SPLIT || x.split === process.env.EVAL_SPLIT);
// a fact's source turns: finding one of them is finding the knowledge (anyRank)
const fids = todo.filter((x) => x.type === 'fact' || x.type === 'currency').map((x) => x.gold.fid);
const srcTurns = new Map<string, Gold[]>();
for (const t of (await db.query(`SELECT f.fid, t.source_id, t.seq FROM facts f JOIN turns t ON t.uuid = ANY(f.source_uuids) WHERE f.fid = ANY($1)`, [fids])).rows)
  srcTurns.set(t.fid, [...(srcTurns.get(t.fid) ?? []), { source_id: Number(t.source_id), seq: t.seq, end_seq: t.seq }]);
if (arg.dump) mkdirSync(arg.dump, { recursive: true });

for (const it of todo) {
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
console.log(`eval  search ${out.search} · before ${before.toISOString().slice(0, 16)} · limit weights ${LIMITS.map((l) => `${l}:${r1(W[l], 2)}`).join(' ')}`);
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
const mcp = (r: Row[]) => ({
  n: r.length, ...atL(r, 'chars'), chars8_p95: quant(r.map((x) => x.L[8].chars), 0.95),
  p50: Math.round(quant(r.map((x) => x.L[8].ms), 0.5)), p95: Math.round(quant(r.map((x) => x.L[8].ms), 0.95)),
  mix8: Object.fromEntries(Object.keys(r[0].L[8].mix).map((k) => [k, r1(mean(r.map((x) => x.L[8].mix[k])), 2)])),
});
R.mcp = Object.fromEntries(['tune', 'holdout', 'all'].map((s) => [s, rows.filter((x) => s === 'all' || x.split === s)]).filter(([, r]) => r.length).map(([s, r]) => [s, mcp(r as Row[])]));
for (const s of Object.keys(R.mcp)) { const { mix8, ...a } = R.mcp[s]; console.log(`mcp text ${s.padEnd(7)} n=${a.n}  ${fmt(a)}  mix@8 ${fmt(mix8)}`); }
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
R.items = rows.map(({ L, ms, ...r }) => ({ ...r, chars: Object.fromEntries(LIMITS.map((l) => [l, L[l].chars])), visL: Object.fromEntries(LIMITS.map((l) => [l, L[l].vis])) })); // per-question, no text
out.results = R;
out.keyword_only = keywordOnly;
if (keywordOnly) console.log(`WARNING: ${keywordOnly} searches stayed keyword-only after 2 retries (embedder down?)`);
if (arg.json) {
  const prev = existsSync(arg.json) ? JSON.parse(readFileSync(arg.json, 'utf8')) : { runs: [] };
  prev.runs.push(out);
  writeFileSync(arg.json, JSON.stringify(prev, null, 1));
}
await db.end();
