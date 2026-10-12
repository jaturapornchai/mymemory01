// Judged synapses (edges kind 'sem'), nightly and incremental: the local Gemma 4 (llama-server, MEMHUB_GEMMA_URL) judges the
// top-cosine pairs of visible nodes that no other edge or link joins and that were never judged; rel ≠ none AND strength 3 → a
// sem edge (w 1). Every verdict, none too, goes to judged_pairs, so a pair is judged once; a deleted source drops its rows.
// The rule as measured 2026-10-11 (synapse.ts header): candidates = per node its top 8 unconnected pairs with cosine ≥ 0.45,
// one pair per prompt (prompts/sem-judge.md), thinking off, strength 3 only: blind opus P 0.86 vs cosine 0.38; batching
// and strength 2 failed that gate. Claude-only sources (guard.PRIVATE_TOOLS, also via hide_as, and facts citing them) are
// never a node, so their text never reaches Gemma.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type pg from 'pg';
import { ROOT } from './db.ts';
import { PRIVATE_TOOLS } from './guard.ts';
import { MEMORY_PROJECT, MEMORY_VAULT } from './notes.ts';

const K = 8, MIN_COS = 0.45;
const LIMIT = 1500; // pairs per night ≈ 35 min at the measured 1.4 s/pair on 2 slots (cli sem --limit n)
const REL = ['same_task', 'fixes', 'explains', 'uses', 'updates', 'none'];

export type Node = { id: number; label: string; text: string };
export type Verdict = { rel: string; strength: number };
export type Judge = (anchor: Node, candidate: Node) => Promise<Verdict>;
type Pair = { a: number; b: number; cos: number };

/** Visible nodes: main sessions (described by their card, else their user lines), facts/rules/notes, GitHub docs; each with
 *  its descriptor text and the unit mean vector of its first 8 chunks. No hubs/daily scaffolding, rejected or superseded. */
async function nodes(db: pg.Pool) {
  const hide = [...PRIVATE_TOOLS];
  const HIDDEN_CITE = (f: string) => `EXISTS (SELECT 1 FROM sources h WHERE h.session_id = ANY(${f}.session_ids) AND coalesce(h.hide_as, h.tool) = ANY($1::text[]))`;
  const rows = (await db.query(`
    SELECT s.id::int id, s.kind, s.tool, coalesce(s.project, '') project, coalesce(s.session_id, s.path, '') sid, f.kind fkind, f.fid,
           (SELECT max(cs.id)::int FROM facts cf JOIN sources cs ON cs.id = cf.source_id WHERE s.kind = 'main' AND cf.kind = 'card'
              AND s.session_id = ANY(cf.session_ids) AND coalesce(cs.status, 'active') NOT IN ('rejected', 'superseded')
              AND coalesce(cs.hide_as, cs.tool) <> ALL($1::text[]) AND NOT ${HIDDEN_CITE('cf')}) card
    FROM sources s LEFT JOIN facts f ON f.source_id = s.id
    WHERE (s.kind IN ('main', 'note') OR (s.tool = 'github' AND s.kind = 'doc'))
      AND coalesce(s.hide_as, s.tool) <> ALL($1::text[]) AND coalesce(s.status, 'active') NOT IN ('rejected', 'superseded')
      AND NOT coalesce(s.project = $2 AND starts_with(s.session_id, $3), false)
      AND (f.kind IS NULL OR f.kind <> 'card') AND (f.source_id IS NULL OR NOT ${HIDDEN_CITE('f')})
    ORDER BY s.id`, [hide, MEMORY_PROJECT, `${basename(MEMORY_VAULT)}/hubs/`])).rows;
  const dsrc = (n: { id: number; card: number | null }) => n.card ?? n.id;
  const vec = new Map<number, Float32Array>(), txt = new Map<number, string[]>();
  for (let i = 0; i < rows.length; i += 200) {
    const r = await db.query(`SELECT source_id::int s, array_agg(text ORDER BY r) texts, avg(embedding::vector)::text v
      FROM (SELECT source_id, text, embedding, row_number() OVER (PARTITION BY source_id ORDER BY seq_from, id) r FROM chunks
            WHERE source_id = ANY($1::bigint[])) x
      WHERE r <= 8 GROUP BY 1`, [rows.slice(i, i + 200).map(dsrc)]);
    for (const x of r.rows.filter((y) => y.v)) { // no embedded chunk yet: not a node until the next night
      const v = Float32Array.from(JSON.parse(x.v) as number[]);
      const nrm = Math.hypot(...v) || 1;
      vec.set(x.s, v.map((y) => y / nrm));
      txt.set(x.s, x.texts);
    }
  }
  const clip = (s: string, n = 700) => (s.length > n ? s.slice(0, n) + '…' : s);
  const live = new Map<number, Node & { card: number | null; v: Float32Array }>();
  for (const n of rows) {
    const t = txt.get(dsrc(n)) ?? [], v = vec.get(dsrc(n));
    const text = n.kind === 'main' && !n.card
      ? clip(t.join('\n').split('\n').filter((l) => l.startsWith('U: ')).join('\n') || t[0] || '')
      : clip(t.slice(0, 2).join('\n').replace(/^D: /, ''));
    const label = n.kind === 'main' ? `${n.tool} session · ${n.project}` : n.tool === 'github' ? `GitHub · ${n.sid}` : n.fid ? `${n.fkind} ${n.fid}` : `note · ${n.sid}`;
    if (v && text.length >= 40) live.set(n.id, { id: n.id, label, text, card: n.card, v });
  }
  return live;
}

/** Per node its top K pairs with cosine ≥ MIN_COS that no edge (other than sem itself: its pairs stay in the set, so the set
 *  stays the measured one) or resolved link joins; never two sessions described by one card. a < b. */
async function candidates(db: pg.Pool, live: Awaited<ReturnType<typeof nodes>>) {
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const conn = new Set((await db.query(`SELECT a::int a, b::int b FROM edges WHERE kind <> 'sem'
    UNION SELECT least(src_id, dst_id)::int, greatest(src_id, dst_id)::int FROM links WHERE dst_id IS NOT NULL`)).rows.map((r) => key(r.a, r.b)));
  const pairs = new Map<string, Pair>(), list = [...live.values()];
  // ponytail: O(n²) scan in JS (~2k nodes: seconds); a pgvector kNN per node when the node count grows past ~10k
  for (const x of list) {
    const best: [typeof x, number][] = [];
    for (const y of list) {
      if (x === y || (x.card && x.card === y.card)) continue;
      let s = 0;
      for (let d = 0; d < x.v.length; d++) s += x.v[d] * y.v[d];
      if (s >= MIN_COS && !conn.has(key(x.id, y.id))) best.push([y, s]);
    }
    best.sort((p, q) => q[1] - p[1]);
    for (const [y, s] of best.slice(0, K)) pairs.set(key(x.id, y.id), { a: Math.min(x.id, y.id), b: Math.max(x.id, y.id), cos: s });
  }
  return [...pairs.values()];
}

/** The Gemma behind llama-server (MEMHUB_GEMMA_URL, key MEMHUB_GEMMA_KEY) as a Judge, or why not (down, or another model loaded). */
async function gemma(): Promise<{ judge: Judge; model: string } | string> {
  const url = process.env.MEMHUB_GEMMA_URL ?? 'http://127.0.0.1:8080', key = process.env.MEMHUB_GEMMA_KEY;
  const headers = { 'content-type': 'application/json', ...(key && { authorization: `Bearer ${key}` }) };
  let model: string | undefined;
  try { model = (await (await fetch(`${url}/v1/models`, { headers, signal: AbortSignal.timeout(5000) })).json()).data?.[0]?.id; }
  catch { return `${url} not reachable`; }
  if (!/gemma/i.test(model ?? '')) return `${url} serves ${model ?? 'no model'}, not Gemma`;
  const system = readFileSync(join(ROOT, 'prompts', 'sem-judge.md'), 'utf8').trim();
  const schema = { type: 'object', properties: { links: { type: 'array', items: { type: 'object', properties: {
    c: { type: 'integer' }, shared: { type: 'string' }, rel: { type: 'string', enum: REL }, strength: { type: 'integer', enum: [0, 1, 2, 3] } },
    required: ['c', 'shared', 'rel', 'strength'] } } }, required: ['links'] };
  const show = (n: Node) => `[${n.label}]\n${n.text}`;
  const judge: Judge = async (x, y) => {
    const res = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, signal: AbortSignal.timeout(600_000),
      body: JSON.stringify({ model, max_tokens: 1200, temperature: 0.2,
        messages: [{ role: 'system', content: system }, { role: 'user', content: `ANCHOR\n${show(x)}\n\nCANDIDATE 1\n${show(y)}` }],
        chat_template_kwargs: { enable_thinking: false }, response_format: { type: 'json_schema', json_schema: { name: 'links', schema } } }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const l = JSON.parse((await res.json()).choices[0].message.content).links?.find((z: { c: number }) => z.c === 1);
    if (!l) throw new Error('no verdict for candidate 1');
    return { rel: l.rel, strength: l.strength };
  };
  return { judge, model: model! };
}

// one statement: the verdict, and the sem edge only when that verdict row went in (both endpoints still exist)
const RECORD = `WITH j AS (INSERT INTO judged_pairs (a, b, verdict, strength, model)
    SELECT $1, $2, $3, $4, $5 WHERE EXISTS (SELECT 1 FROM sources WHERE id = $1) AND EXISTS (SELECT 1 FROM sources WHERE id = $2)
    ON CONFLICT DO NOTHING RETURNING a, b, verdict, strength)
  INSERT INTO edges (a, b, kind, w, updated_at) SELECT a, b, 'sem', 1, now() FROM j WHERE verdict <> 'none' AND strength = 3 ON CONFLICT DO NOTHING`;

/** Nightly: judge up to `limit` pending pairs (highest cosine first) on 2 workers (llama-server's 2 slots). dry = counts only,
 *  no judge needed (read-only role is enough). No judge given → the local Gemma, or { skipped } when it is not up. */
export async function runSem(db: pg.Pool, o: { dry?: boolean; limit?: number; judge?: Judge; model?: string } = {}) {
  let { judge, model = 'unknown' } = o;
  if (!o.dry && !judge) {
    const g = await gemma();
    if (typeof g === 'string') return { skipped: g };
    ({ judge, model } = g);
  }
  const live = await nodes(db), cands = await candidates(db, live);
  const open = new Set((await db.query(`SELECT p.a::int a, p.b::int b FROM unnest($1::bigint[], $2::bigint[]) p(a, b)
    WHERE NOT EXISTS (SELECT 1 FROM judged_pairs j WHERE j.a = p.a AND j.b = p.b)`, [cands.map((c) => c.a), cands.map((c) => c.b)])).rows.map((r) => `${r.a}-${r.b}`));
  const pending = cands.filter((c) => open.has(`${c.a}-${c.b}`)).sort((p, q) => q.cos - p.cos);
  const r = { nodes: live.size, candidates: cands.length, pending: pending.length, judged: 0, sem: 0, failed: 0 };
  if (o.dry || !judge) return r;
  // anchor = the endpoint with more candidates, as in the measured build (prompt order matters a little)
  const deg = new Map<number, number>();
  for (const c of cands) for (const x of [c.a, c.b]) deg.set(x, (deg.get(x) ?? 0) + 1);
  const queue = pending.slice(0, o.limit ?? LIMIT);
  let streak = 0;
  const one = async ({ a, b }: Pair) => {
    const [x, y] = deg.get(a)! >= deg.get(b)! ? [a, b] : [b, a];
    let v: Verdict;
    try {
      v = await judge(live.get(x)!, live.get(y)!);
      if (!REL.includes(v.rel) || ![0, 1, 2, 3].includes(v.strength)) throw new Error(`bad verdict ${JSON.stringify(v).slice(0, 80)}`);
    } catch (e) {
      r.failed++;
      console.log(`sem: ${a}-${b} failed: ${String((e as Error).message ?? e).slice(0, 120)}`);
      if (++streak >= 5) queue.length = 0; // the server went away: stop, the rest stays pending for the next night
      return;
    }
    streak = 0;
    const q = await db.query(RECORD, [a, b, v.rel, v.rel === 'none' ? 0 : v.strength, model]); // await before +=: two workers share r
    r.sem += q.rowCount ?? 0;
    r.judged++;
  };
  await Promise.all([0, 1].map(async () => { for (let p = queue.shift(); p; p = queue.shift()) await one(p); }));
  return r;
}
