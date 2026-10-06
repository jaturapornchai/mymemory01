// Dream: distil finished AI sessions (every app: sources.tool except obsidian) into session cards + facts (notes in the
// memory-hub vault), reconcile new facts with existing ones (ADD / NOOP / UPDATE / SUPERSEDE, never delete), then rebuild the synapses (synapse.ts) and hub notes.
// LLM = Claude only (claude -p with Anthropic auth, or answered by Claude agents through request/result files).
// Design + sources: docs/research/phase4-design.md §3–5.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type pg from 'pg';
import { z } from 'zod';
import { ROOT } from './db.ts';
import { backfill } from './embed.ts';
import { offsiteBackend } from './guard.ts';
import { projectName } from './importer.ts';
import { fileName, type Fm, isEdited, isHis, md5, MEMORY_PROJECT, MEMORY_VAULT, parseNote, projectSlug, sha, writeNote } from './notes.ts';
import { indexVault, resolveLinks } from './obsidian.ts';
import { search } from './search.ts';
import { rebuildSynapses } from './synapse.ts';
import { beforeMachineWrite, commitBatch } from './vault-git.ts';

export const RUNS_DIR = process.env.MEMHUB_DREAM_RUNS ?? join(homedir(), 'ai-archive', 'raw', 'memhub-dream');
const PROMPT = (name: string) => readFileSync(join(ROOT, 'prompts', `${name}.md`), 'utf8');
const BKK = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' }); // YYYY-MM-DD
const SESSION_CAP = 20_000, BATCH_CHARS = 60_000, BATCH_SESSIONS = 12;
// Sessions per run without --limit: other apps brought ~1000 never-dreamed sessions; the nightly drains them newest first.
// ponytail: caps sessions, not windows — one huge session still goes whole; a window budget if a night runs too long
export const DREAM_LIMIT = 25;
const KIND_ASSERTIVE = new Set(['rule', 'feedback', 'decision', 'preference']); // "newer is not truer" for assistant output

// ---------------- LLM runners ----------------

export type LlmReq = { id: string; system: string; user: string; schema: object };
export type Llm = (req: LlmReq) => Promise<unknown>;
export class Pending extends Error {}

/** Request/result files: a Claude agent reads <id>.request.json and writes <id>.result.json; rerun continues. */
export const filesRunner = (dir: string): Llm => async (req) => {
  mkdirSync(dir, { recursive: true });
  const res = join(dir, `${req.id}.result.json`);
  if (existsSync(res)) return JSON.parse(readFileSync(res, 'utf8'));
  writeFileSync(join(dir, `${req.id}.request.json`), JSON.stringify(req, null, 1));
  throw new Pending(req.id);
};

const CLAUDE_BIN = process.env.MEMHUB_CLAUDE_BIN
  ?? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

/**
 * Headless `claude -p`. User settings are skipped (--setting-sources project) and ANTHROPIC_BASE_URL/AUTH_TOKEN are
 * dropped, so a settings.json "env" pointing at another vendor can't receive the transcripts; auth = the CLI's
 * Anthropic login. No tools, no MCP, no session persistence (the dream's own run never becomes input).
 */
export const claudeRunner = (model = process.env.MEMHUB_DREAM_MODEL ?? 'sonnet', log = console.log): Llm => async (req) => {
  const env: NodeJS.ProcessEnv = { ...process.env, MEMORY_HUB_INTERNAL: '1' };
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_OAUTH_SCOPES',
    'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID']) delete env[k];
  const off = offsiteBackend(env);
  if (off) throw new Error(`refusing dream: backend ${off} is not Anthropic`);
  const cwd = mkdtempSync(join(tmpdir(), 'memhub-dream-'));
  try {
    const sys = join(cwd, 'system.md');
    writeFileSync(sys, req.system);
    const args = ['-p', '--model', model, '--output-format', 'json', '--json-schema', JSON.stringify(req.schema),
      '--system-prompt-file', sys, '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
      '--setting-sources', 'project', '--no-session-persistence'];
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(CLAUDE_BIN, args, { cwd, env, windowsHide: true });
      let o = '', e = '';
      p.stdout.on('data', (d) => (o += d));
      p.stderr.on('data', (d) => (e += d));
      p.on('error', reject);
      p.on('close', (code) => (o.trim() ? resolve(o) : reject(new Error(`claude exited ${code}: ${e.slice(0, 300)}`))));
      p.stdin.end(req.user);
    });
    const r = JSON.parse(out);
    if (r.is_error) throw new Error(`claude: ${String(r.result).slice(0, 300)}`);
    log(`  ${req.id}: in ${r.usage?.input_tokens ?? '?'} + cache ${r.usage?.cache_read_input_tokens ?? 0}/${r.usage?.cache_creation_input_tokens ?? 0}, out ${r.usage?.output_tokens ?? '?'} tokens, ${r.duration_ms} ms`);
    return r.structured_output ?? JSON.parse(r.result);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

// ---------------- schemas (JSON schema for the LLM; validation per item in Node: reject, never repair ids) ----------------

const FACT_KINDS = ['rule', 'feedback', 'decision', 'preference', 'fact', 'howto'] as const;
export const SchemaA = z.object({
  sessions: z.array(z.object({
    s: z.string().regex(/^S\d+$/),
    card: z.object({
      title: z.string().max(80), summary: z.string().max(600), outcome: z.enum(['done', 'partial', 'abandoned', 'unknown']),
      decisions: z.array(z.string().max(200)).max(5).optional(), open: z.array(z.string().max(200)).max(5).optional(),
    }),
    facts: z.array(z.object({
      text: z.string().min(1).max(400), kind: z.enum(FACT_KINDS), scope: z.enum(['project', 'global']), lang: z.enum(['th', 'en', 'mixed']),
      importance: z.number().int().min(1).max(10), confidence: z.number().min(0).max(1),
      valid_at: z.string().nullable().optional(), invalid_at: z.string().nullable().optional(),
      source_turns: z.array(z.string().regex(/^T\d+$/)).min(1),
    })).max(8),
  })),
});
export const SchemaB = z.object({
  ops: z.array(z.object({
    n: z.string().regex(/^N\d+$/), op: z.enum(['ADD', 'NOOP', 'UPDATE', 'SUPERSEDE']),
    target: z.string().regex(/^E\d+$/).nullable().optional(), text: z.string().max(400).optional(),
    links: z.array(z.object({ to: z.string().regex(/^E\d+$/), rel: z.enum(['supports', 'related']) })).max(3).optional(),
    why: z.string().max(160).optional(),
  })),
});
const jsonSchema = (s: z.ZodType) => { const j = z.toJSONSchema(s) as Record<string, unknown>; delete j.$schema; return j; };

// ---------------- digests ----------------

type DTurn = { uuid: string; role: 'user' | 'assistant'; ts: Date; i: number; text: string }; // i = row index
/** One window of one session. key = plan entry; card = its card id; upto = ISO time of the last turn it covers; note = header hint for pass A. */
export type Digest = { sessionId: string; tool: string; project: string; date: string; t0: Date; t1: Date; turns: DTurn[]; files: string[]; key: string; card: string; upto: string; note: string };
type Row = { uuid: string; role: string; ts: Date; text: string };

// Compact tool-call lines of any app ("[Bash] …", "[shell] …", "[apply_patch] …"); file edits = names with write/edit/patch.
const TOOL_LINE = /^\[[A-Za-z][\w-]*\](?: [^\n]*)?$/gm;
const FILE_LINE = /^\[\w*(?:write|edit|patch)\w*\] (.+)$/gim;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Deterministic digests of a session's turns (all its main transcripts, in time order): user turns verbatim (≤2000), the
 *  final assistant reply per user turn (≤1500, ≤600 in long sessions), edited files — split into consecutive windows
 *  ≤ SESSION_CAP. Nothing is dropped from the middle: ลุงจืด often reverses a choice hours later, and the reversal must reach
 *  the dream. continued = earlier turns were dreamed already. */
export function buildDigests(sessionId: string, project: string, rows: Row[], continued = false, tool = 'claude'): Digest[] {
  const turns: DTurn[] = [];
  const files = new Map<string, number>(); // path → row index first edited
  let pend: DTurn | null = null;
  const flush = () => {
    if (pend) { const t = pend.text.replace(TOOL_LINE, '').replace(/\n{3,}/g, '\n\n').trim(); if (t) turns.push({ ...pend, text: cut(t, 1500) }); }
    pend = null;
  };
  for (const [i, r] of rows.entries()) {
    if (r.role === 'user') {
      const t = r.text.trim();
      if (!t || t.startsWith('[')) continue; // interrupts / notifications, not ลุงจืด speaking
      flush();
      turns.push({ uuid: r.uuid, role: 'user', ts: r.ts, i, text: cut(t, 2000) });
    } else if (r.role === 'assistant') {
      for (const m of r.text.matchAll(FILE_LINE)) if (!files.has(m[1].trim())) files.set(m[1].trim(), i);
      pend = { uuid: r.uuid, role: 'assistant', ts: r.ts, i, text: r.text };
    }
  }
  flush();
  if (!turns.some((t) => t.role === 'user' && t.text.length >= 10)) return []; // nothing ลุงจืด said worth a card
  const size = (t: DTurn) => t.text.length + 8;
  if (turns.reduce((a, t) => a + size(t), 0) > SESSION_CAP) for (const t of turns) if (t.role === 'assistant') t.text = cut(t.text, 600);
  const wins: DTurn[][] = [[]];
  let chars = 0;
  for (const t of turns) { // cut only before a user turn, so an answer stays with its question
    if (t.role === 'user' && chars + size(t) > SESSION_CAP && wins.at(-1)!.length) { wins.push([]); chars = 0; }
    wins.at(-1)!.push(t); chars += size(t);
  }
  const sid8 = sessionId.replace(/-/g, '').slice(0, 8);
  return wins.map((w, k) => {
    const lo = k ? w[0].i : 0, hi = k + 1 < wins.length ? wins[k + 1][0].i - 1 : rows.length - 1; // rows this window covers
    const t0 = k ? w[0].ts : rows[0].ts;
    const note = [wins.length > 1 && `part ${k + 1}/${wins.length} of a long session`, continued && 'continues a session already summarised'].filter(Boolean).join('; ');
    return { sessionId, tool, project, date: BKK(t0), t0, t1: w.at(-1)!.ts, turns: w, key: `${sessionId}#${k}`, upto: rows[hi].ts.toISOString(), note,
      // a Claude session's first window keeps the old card id; other apps' ids may be time-ordered (UUIDv7) or non-hex → hash
      card: 'S' + (tool === 'claude' && !continued && !k ? sid8 : md5(`${sessionId}:${w[0].uuid}`).slice(0, 8)),
      files: [...files].filter(([, i]) => i >= lo && i <= hi).map(([f]) => f).slice(0, 30) };
  });
}

type TRef = { uuid: string; role: 'user' | 'assistant'; ts: Date; s: string };
type Batch = { digests: Digest[]; text: string; tmap: Map<string, TRef>; smap: Map<string, Digest> };

export function renderBatch(digests: Digest[]): Batch {
  const tmap = new Map<string, TRef>(), smap = new Map<string, Digest>();
  let t = 0;
  const parts = digests.map((d, i) => {
    const s = `S${i + 1}`;
    smap.set(s, d);
    const lines = d.turns.map((x) => {
      if (!x.uuid) return x.text;
      const id = `T${++t}`;
      tmap.set(id, { uuid: x.uuid, role: x.role, ts: x.ts, s });
      return `${id} ${x.role === 'user' ? 'U' : 'A'}: ${x.text}`;
    });
    return `=== ${s} | ${projectName(d.project)} | ${d.tool} | ${d.date} (Asia/Bangkok)${d.note ? ` | ${d.note}` : ''} ===\n${lines.join('\n')}` +
      (d.files.length ? `\n[files edited: ${d.files.join(', ')}]` : '');
  });
  return { digests, text: parts.join('\n\n'), tmap, smap };
}

/** Oldest first, first fit; a later window of a session always lands in a later batch than the one before it,
 *  so its pass B sees the earlier window's facts and can supersede them. */
export function packBatches(digests: Digest[]): Digest[][] {
  const out: { ds: Digest[]; chars: number }[] = [];
  const prev = new Map<string, number>(); // session → batch of its previous window
  for (const d of [...digests].sort((a, b) => +a.t0 - +b.t0)) {
    const n = d.turns.reduce((a, t) => a + t.text.length + 8, 0);
    let i = (prev.get(d.sessionId) ?? -1) + 1;
    while (i < out.length && out[i].ds.length && (out[i].ds.length >= BATCH_SESSIONS || out[i].chars + n > BATCH_CHARS)) i++;
    (out[i] ??= { ds: [], chars: 0 }).ds.push(d);
    out[i].chars += n;
    prev.set(d.sessionId, i);
  }
  return out.map((b) => b.ds);
}

// ---------------- notes ----------------

export const factId = (text: string) => 'F' + md5(text).slice(0, 8);
const cardRel = (d: Digest) => `sessions/${d.date.slice(0, 7)}/${d.date} ${projectSlug(d.project)} ${d.card.slice(1)}.md`;
const factRel = (fid: string, text: string, scope: string, project: string) =>
  `facts/${scope === 'global' ? '_global' : projectSlug(project)}/${fid} ${fileName(text.replace(/`/g, ''), 40)}.md`;
const hubName = (project: string) => `${projectSlug(project)} hub`;
const link = (rel: string) => `[[${basename(rel, '.md')}]]`;

type Existing = { fid: string; kind: string; status: string | null; text: string; rel: string; owned: boolean; hand: boolean; pinned: boolean; validAt: Date; uuids: string[] };

async function existingFacts(db: pg.Pool, where: string, params: unknown[]): Promise<Existing[]> {
  return (await db.query(
    `SELECT f.fid, f.kind, s.status, f.user_owned owned, (f.edited OR f.pinned OR f.run IS NULL) hand, f.pinned, f.valid_at, f.source_uuids uuids, s.path,
            (SELECT t.text_redacted FROM turns t WHERE t.source_id = s.id LIMIT 1) body
     FROM facts f JOIN sources s ON s.id = f.source_id WHERE ${where}`, params)).rows.map((r) => ({
    fid: r.fid, kind: r.kind, status: r.status, owned: r.owned, hand: r.hand, pinned: r.pinned, validAt: r.valid_at, uuids: r.uuids,
    rel: r.path.replace(/\\/g, '/').slice(MEMORY_VAULT.replace(/\\/g, '/').length + 1),
    text: String(r.body ?? '').replace(/^# [^\n]*\n/, '').split('\n\n- ')[0].trim(),
  }));
}

// ---------------- the run ----------------

export type DreamOpts = { llm: Llm; run: string; force?: boolean; limit?: number; now?: Date; log?: (s: string) => void };
export type DreamStats = Record<string, number>;

export async function dream(db: pg.Pool, o: DreamOpts): Promise<{ status: 'done' | 'pending' | 'skipped' | 'locked'; stats: DreamStats; pending?: string[] }> {
  const log = o.log ?? console.log;
  const now = o.now ?? new Date();
  const stats: DreamStats = { sessions: 0, batches: 0, cards: 0, proposed: 0, rejected_ids: 0, dropped: 0, ADD: 0, NOOP: 0, UPDATE: 0, SUPERSEDE: 0, pending_review: 0, kept_user_edit: 0 };
  const lock = await db.connect();
  try {
    if (!(await lock.query(`SELECT pg_try_advisory_lock(hashtext(current_schema() || ':memhub-dream')) ok`)).rows[0].ok) return { status: 'locked', stats };
    // The plan (turn ranges + batches) is frozen per run id, so a files-runner run resumes with the same digests →
    // the same request ids, whatever ลุงจืด said in the meantime.
    const planKey = `dream:plan:${o.run}`;
    let plan: { ranges: Range[]; batches: string[][]; stats?: DreamStats } | undefined = (await db.query('SELECT v FROM state WHERE k = $1', [planKey])).rows[0]?.v;
    let batches: Batch[];
    if (plan?.ranges) {
      const all = new Map((await loadDigests(db, plan.ranges)).map((d) => [d.key, d]));
      batches = plan.batches.map((ks) => renderBatch(ks.map((k) => all.get(k)!).filter(Boolean)));
      Object.assign(stats, plan.stats); // counters of the batches promoted by earlier invocations of this run
    } else {
      // newest first up to the cap; a session with nothing worth a card is marked done and doesn't count
      const limit = o.limit ?? DREAM_LIMIT, ranges: Range[] = [], digests: Digest[] = [];
      for (const r of await newRanges(db, now)) {
        if (ranges.length >= limit) break;
        const ds = await loadDigests(db, [r]);
        if (ds.length) { ranges.push(r); digests.push(...ds); } else await markDone(db, r.sessionId, { upto: r.to });
      }
      stats.sessions = ranges.length;
      const oldest = digests.reduce((m, d) => Math.min(m, +d.t1), Infinity);
      if (!o.force && ranges.length < 5 && now.getTime() - oldest < 24 * 3600_000) { // quiet night = 0 tokens
        log(`dream: ${ranges.length} finished session(s) waiting, below the gate`);
        await consolidate(db, now);
        return { status: 'skipped', stats };
      }
      if (!digests.length) { await consolidate(db, now); return { status: 'done', stats }; }
      batches = packBatches(digests).map(renderBatch);
      plan = { ranges, batches: batches.map((x) => x.digests.map((d) => d.key)) };
      await db.query('INSERT INTO state (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [planKey, JSON.stringify(plan)]);
    }
    stats.sessions = plan.ranges.length;
    stats.windows = plan.batches.flat().length;
    stats.batches = batches.length;
    const doneHere = new Map<string, string>((await db.query(`SELECT k, v->>'upto' upto FROM state WHERE k LIKE 'dream:session:%' AND v->>'run' = $1`, [o.run])).rows.map((r) => [r.k.slice(14), r.upto]));
    const record: Record<string, unknown>[] = [];

    // Pass A for every batch first (independent → a files runner can have them all answered in parallel).
    const sysA = PROMPT('dream-extract'), schemaA = jsonSchema(SchemaA);
    const pending: string[] = [];
    const resultsA = await Promise.all(batches.map(async (b) => {
      try {
        return await o.llm({ id: `A-${sha(b.text)}`, system: sysA, user: `Current date: ${BKK(now)} (Asia/Bangkok)\n\n${b.text}`, schema: schemaA });
      } catch (e) { if (e instanceof Pending) { pending.push(e.message); return null; } throw e; }
    }));
    if (pending.length) return { status: 'pending', stats, pending };

    // Then reconcile + promote batch by batch, re-indexing in between so later batches see earlier facts.
    for (const [i, b] of batches.entries()) {
      if (b.digests.every((d) => (doneHere.get(d.sessionId) ?? '') >= d.upto)) continue; // promoted in an earlier invocation of this run
      const bs = { ...stats }; // a batch stopped by Pending reruns whole: only a finished batch adds its counts
      try { record.push(await promoteBatch(db, o, b, resultsA[i], bs, now)); }
      catch (e) { if (e instanceof Pending) return { status: 'pending', stats, pending: [e.message] }; throw e; }
      Object.assign(stats, bs);
      // a files runner stops at every pass-B request: kept with the plan, the run record counts the whole run, not its last invocation
      await db.query('UPDATE state SET v = $2 WHERE k = $1', [planKey, JSON.stringify({ ...plan, stats })]);
    }
    await db.query('DELETE FROM state WHERE k = $1', [planKey]);
    mkdirSync(RUNS_DIR, { recursive: true });
    appendFileSync(join(RUNS_DIR, `${o.run}.json`), JSON.stringify({ run: o.run, at: now.toISOString(), stats, batches: record }) + '\n');
    await consolidate(db, now);
    return { status: 'done', stats };
  } finally {
    // one vault commit per run, whatever path it left by (done / skipped / pending / error): all of it is machine work
    commitBatch(MEMORY_VAULT, `dream ${o.run}: +${stats.ADD} ADD, ${stats.UPDATE} UPDATE, ${stats.SUPERSEDE} SUPERSEDE`);
    await lock.query(`SELECT pg_advisory_unlock(hashtext(current_schema() || ':memhub-dream'))`).catch(() => {});
    lock.release();
  }
}

// Turns with from < ts ≤ to (ISO). ponytail: exact because transcript timestamps carry ms only, like JS Dates.
type Range = { sessionId: string; project: string; from: string | null; to: string };

/** Finished sessions (last turn > 1 h ago) with turns not dreamed yet, newest first. A session that grows is dreamed again
 *  for its new turns only; one resumed from another folder has several transcripts, merged by time (project = the first's).
 *  Legacy state (before `upto`): covered up to its card's write time. */
async function newRanges(db: pg.Pool, now: Date): Promise<Range[]> {
  return (await db.query(
    `SELECT g.session_id "sessionId", g.project, g.last "to",
            coalesce((st.v->>'upto')::timestamptz, (SELECT max(f.created_at) FROM facts f WHERE f.fid = st.v->>'card'),
                     CASE WHEN st.k IS NOT NULL THEN g.last END) "from"
     FROM (SELECT s.session_id, (array_agg(coalesce(s.project, '') ORDER BY m.first))[1] project, max(m.last) last
           FROM sources s CROSS JOIN LATERAL (SELECT min(ts) first, max(ts) last FROM turns t WHERE t.source_id = s.id) m
           WHERE s.tool <> 'obsidian' AND s.kind = 'main' AND s.hide_as IS NULL AND m.last IS NOT NULL GROUP BY s.session_id) g
     LEFT JOIN state st ON st.k = 'dream:session:' || g.session_id
     WHERE g.last < $1::timestamptz - interval '1 hour'
     ORDER BY g.last DESC`, [now])).rows
    .filter((r) => !r.from || r.from < r.to)
    .map((r) => ({ sessionId: r.sessionId, project: r.project, from: r.from?.toISOString() ?? null, to: r.to.toISOString() }));
}

async function loadDigests(db: pg.Pool, ranges: Range[]): Promise<Digest[]> {
  const out: Digest[] = [];
  for (const r of ranges) {
    const rows = (await db.query(
      `SELECT t.uuid, t.role, t.ts, t.text_redacted text, s.tool FROM turns t JOIN sources s ON s.id = t.source_id
       WHERE s.session_id = $1 AND s.tool <> 'obsidian' AND s.kind = 'main' AND ($2::timestamptz IS NULL OR t.ts > $2) AND t.ts <= $3
       ORDER BY t.ts, s.id, t.seq`, [r.sessionId, r.from, r.to])).rows;
    // one session never spans apps in practice; if two ever share an id, it stays one digest naming both
    const tool = [...new Set(rows.map((x) => x.tool))].join('+');
    if (rows.length) out.push(...buildDigests(r.sessionId, r.project, rows, r.from !== null, tool));
  }
  return out;
}

const markDone = (db: pg.Pool, sessionId: string, v: Record<string, unknown>) =>
  db.query(`INSERT INTO state (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = state.v || EXCLUDED.v`, [`dream:session:${sessionId}`, v]);

type Cand = { n: string; text: string; kind: string; scope: string; lang: string; importance: number; confidence: number;
  validAt: Date; invalidAt: Date | null; uuids: string[]; byUser: boolean; s: string; d: Digest; card: string; E: Existing[] };

async function promoteBatch(db: pg.Pool, o: DreamOpts, b: Batch, rawA: unknown, stats: DreamStats, now: Date) {
  const log = o.log ?? console.log;
  const a = SchemaA.safeParse(rawA);
  const sessions = a.success ? a.data.sessions : (z.object({ sessions: z.array(z.unknown()) }).safeParse(rawA).data?.sessions ?? [])
    .map((x) => SchemaA.shape.sessions.element.safeParse(x)).filter((x) => x.success).map((x) => x.data!);
  const cands: Cand[] = [];
  const cards = new Map<string, { d: Digest; card: (typeof sessions)[number]['card']; facts: string[] }>();
  for (const s of sessions) {
    const d = b.smap.get(s.s);
    if (!d) { stats.rejected_ids++; continue; }
    cards.set(s.s, { d, card: s.card, facts: [] });
    for (const f of s.facts) {
      stats.proposed++;
      const refs = f.source_turns.map((t) => b.tmap.get(t));
      if (refs.some((r) => !r || r.s !== s.s)) { stats.rejected_ids++; continue; } // unknown / other session's turn: reject
      const valid = (v?: string | null) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
      cands.push({
        n: `N${cands.length + 1}`, text: f.text.trim(), kind: f.kind, scope: f.scope, lang: f.lang, importance: f.importance,
        confidence: f.confidence, validAt: valid(f.valid_at) ?? new Date(Math.min(...refs.map((r) => +r!.ts))),
        invalidAt: valid(f.invalid_at), uuids: [...new Set(refs.map((r) => r!.uuid))], byUser: refs.some((r) => r!.role === 'user'),
        s: s.s, d, card: cardRel(d), E: [],
      });
    }
  }

  // Fast path (no LLM): tombstoned / rejected → drop; identical text → NOOP; no similar fact → ADD.
  const ops = new Map<string, { op: string; target?: Existing; text?: string; links: { e: Existing; rel: string }[]; why?: string }>();
  for (const c of cands) {
    const h = md5(c.text);
    if ((await db.query(`SELECT 1 FROM forgotten WHERE key = $1`, [`fact:${h}`])).rowCount) { stats.dropped++; ops.set(c.n, { op: 'DROP', links: [] }); continue; }
    const same = await existingFacts(db, 'f.md5 = $1', [h]);
    if (same.some((e) => e.status === 'rejected')) { stats.dropped++; ops.set(c.n, { op: 'DROP', links: [] }); continue; }
    const live = same.find((e) => e.status !== 'superseded');
    if (live) { ops.set(c.n, { op: 'NOOP', target: live, links: [] }); continue; }
    // tier 0: neighbours by similarity only (the priority tier pushed owned notes above closer dream facts → duplicate ADDs)
    const { hits } = await search(db, c.text, { project: MEMORY_PROJECT, limit: 12, semantic: true, perSession: 1, tier: 0 });
    const fids = [...new Set(hits.filter((x) => x.fid && x.kind !== 'card' && x.status !== 'superseded' && x.status !== 'rejected').map((x) => x.fid!))].slice(0, 5);
    c.E = fids.length ? await existingFacts(db, 'f.fid = ANY($1)', [fids]) : [];
    if (!c.E.length) ops.set(c.n, { op: 'ADD', links: [] });
  }

  // Pass B: reconcile the rest with Claude.
  const needB = cands.filter((c) => !ops.has(c.n));
  if (needB.length) {
    const emap = new Map<string, Existing>(), eid = new Map<string, string>();
    const lines = needB.map((c) => {
      const es = c.E.map((e) => {
        if (!eid.has(e.fid)) { const id = `E${eid.size + 1}`; eid.set(e.fid, id); emap.set(id, e); }
        return `  ${eid.get(e.fid)} [${e.kind}${e.owned ? ' owned' : ''}${e.pinned ? ' pinned' : ''}, valid ${BKK(e.validAt)}]: ${e.text}`;
      });
      return `${c.n} [${c.kind}, ${projectName(c.d.project)}, valid ${BKK(c.validAt)}]: ${c.text}\n${es.join('\n')}`;
    });
    const rawB = await o.llm({ id: `B-${sha(lines.join('\n'))}`, system: PROMPT('dream-reconcile'), user: lines.join('\n\n'), schema: jsonSchema(SchemaB) }); // Pending propagates
    const parsed = z.object({ ops: z.array(z.unknown()) }).safeParse(rawB).data?.ops ?? [];
    for (const x of parsed) {
      const r = SchemaB.shape.ops.element.safeParse(x);
      if (!r.success) { stats.rejected_ids++; continue; }
      const c = needB.find((k) => k.n === r.data.n);
      const allowed = (e?: string | null) => (e ? c?.E.find((k) => k.fid === emap.get(e)?.fid) : undefined);
      const target = allowed(r.data.target);
      if (!c || ops.has(c.n) || (r.data.op !== 'ADD' && !target)) { stats.rejected_ids++; continue; } // reject, never repair
      ops.set(c.n, { op: r.data.op, target, text: r.data.text, why: r.data.why,
        links: (r.data.links ?? []).map((l) => ({ e: allowed(l.to)!, rel: l.rel })).filter((l) => l.e) });
    }
  }

  // Promote: write notes. Only machine-owned keys change; ลุงจืด's own notes are never rewritten.
  const written = new Map<string, string>(); // md5 → rel (same text twice in one batch)
  for (const c of cands) {
    const op = ops.get(c.n);
    if (!op || op.op === 'DROP') continue;
    stats[op.op]++;
    const base: Fm = { memhub: 'fact', kind: c.kind, scope: c.scope, project: c.scope === 'global' ? '' : c.d.project, lang: c.lang,
      importance: String(c.importance), confidence: String(c.confidence), pinned: 'false', run: o.run, created_at: now.toISOString(),
      tags: [`memhub/${c.kind}`, `project/${projectSlug(c.d.project)}`] };
    const body = (text: string, extra: string[] = []) =>
      `${text}\n\n- from:: ${link(c.card)}\n${[...extra, ...op.links.map((l) => `- ${l.rel}:: ${link(l.e.rel)}`)].join('\n')}${extra.length || op.links.length ? '\n' : ''}`;
    const addNote = (text: string, uuids: string[], fm: Fm, extra: string[] = []) => {
      const h = md5(text);
      if (written.has(h)) return written.get(h)!;
      const fid = factId(text);
      const rel = factRel(fid, text, c.scope, c.d.project);
      const res = writeNote(rel, { ...base, id: fid, md5: h, status: 'active', valid_at: c.validAt.toISOString(),
        invalid_at: c.invalidAt?.toISOString() ?? '', expired_at: '', superseded_by: '', review_target: '', source_uuids: uuids, ...fm }, body(text, extra));
      if (res === 'kept-user-edit') stats.kept_user_edit++;
      written.set(h, rel);
      return rel;
    };
    let rel: string;
    if (op.op === 'ADD') rel = addNote(c.text, c.uuids, {});
    else if (op.op === 'NOOP') {
      rel = op.target!.rel;
      if (!op.target!.owned) writeNote(rel, { source_uuids: [...new Set([...op.target!.uuids, ...c.uuids])] }); // mention count
    } else {
      const t = op.target!;
      const text = op.op === 'UPDATE' && op.text ? op.text.trim() : c.text;
      const uuids = op.op === 'UPDATE' ? [...new Set([...c.uuids, ...t.uuids])] : c.uuids;
      // a note ลุงจืด wrote/edited/pinned is never changed; a dream-recorded rule yields only to ลุงจืด's own newer words
      const review = t.hand || (t.owned && !c.byUser) || (KIND_ASSERTIVE.has(c.kind) && !c.byUser);
      if (review) {
        stats.pending_review++;
        rel = addNote(text, uuids, { status: 'pending', review_target: t.fid }, [`- review:: ${op.op} ${link(t.rel)} — ${op.why ?? ''}`]);
      } else if (op.op === 'SUPERSEDE' && c.validAt < t.validAt) { // late-arriving older fact: born superseded (Zep §2.2.3)
        rel = addNote(text, uuids, { status: 'superseded', superseded_by: t.fid, expired_at: now.toISOString(), invalid_at: t.validAt.toISOString() },
          [`- superseded_by:: ${link(t.rel)}`]);
      } else {
        rel = addNote(text, uuids, {}, [`- supersedes:: ${link(t.rel)}`]);
        const newFid = parseNote(readFileSync(join(MEMORY_VAULT, rel), 'utf8')).fm.id as string;
        if (writeNote(t.rel, { status: 'superseded', superseded_by: newFid, expired_at: now.toISOString(), invalid_at: c.validAt.toISOString() }) === 'kept-user-edit') stats.kept_user_edit++;
      }
    }
    cards.get(c.s)?.facts.push(rel);
  }

  // Session cards.
  for (const { d, card, facts } of cards.values()) {
    const sec = (h: string, xs?: string[]) => (xs?.length ? `\n## ${h}\n${xs.map((x) => `- ${x}`).join('\n')}\n` : '');
    const userUuids = d.turns.filter((t) => t.role === 'user' && t.uuid).map((t) => t.uuid).slice(0, 20);
    const body = `# ${card.title}\n\n${card.summary}\n\n**Outcome:** ${card.outcome} · ${d.date} · ${d.tool} · session \`${d.sessionId}\`${d.note ? ` · ${d.note}` : ''}\n` +
      sec('Decisions', card.decisions) + sec('Open', card.open) + sec('Facts', [...new Set(facts)].map(link)) +
      sec('Files', d.files.map((f) => `\`${f}\``)) + `\nproject:: [[${hubName(d.project)}]]\n`;
    const r = writeNote(cardRel(d), { memhub: 'card', id: d.card, project: d.project, session: d.sessionId, tool: d.tool, status: 'active',
      outcome: card.outcome, valid_at: d.t0.toISOString(), created_at: now.toISOString(), source_uuids: userUuids.length ? userUuids : [d.turns[0].uuid],
      run: o.run, tags: ['memhub/card', `project/${projectSlug(d.project)}`] }, body);
    if (r === 'kept-user-edit') stats.kept_user_edit++; else stats.cards++;
  }

  // Index what was written (later batches dedupe against it), then mark the sessions done.
  await indexVault(db, MEMORY_VAULT);
  await resolveLinks(db);
  await backfill(db, 8, () => {}).catch(() => 0);
  for (const d of b.digests) await markDone(db, d.sessionId, { run: o.run, card: d.card, upto: d.upto });
  log(`dream batch: ${b.digests.length} sessions, ${cands.length} candidate facts`);
  return { sessions: b.digests.map((d) => d.sessionId), candidates: cands.map((c) => ({ n: c.n, text: c.text, kind: c.kind, uuids: c.uuids, op: ops.get(c.n)?.op, target: ops.get(c.n)?.target?.fid })) };
}

// ---------------- nightly consolidation (no LLM) ----------------

/** Approvals, synapse rebuild ('sleep': structural kinds + co-access with downscaling, synapse.ts), hub + review notes. Safe to run every night. */
export async function consolidate(db: pg.Pool, now = new Date()) {
  await applyApprovals(db, now);
  await rebuildSynapses(db, { structural: true, plastic: true, now });
  await writeHubs(db);
}

/** A pending note ลุงจืด set to active = accept: apply exactly the target's status change. */
async function applyApprovals(db: pg.Pool, now: Date) {
  const rows = (await db.query(
    `SELECT f.fid, f.review_target, s.path, t.fid tfid, ts.path tpath FROM facts f JOIN sources s ON s.id = f.source_id
     JOIN facts t ON t.fid = f.review_target JOIN sources ts ON ts.id = t.source_id
     WHERE s.status = 'active' AND f.review_target IS NOT NULL AND ts.status IS DISTINCT FROM 'superseded'`)).rows;
  const vault = MEMORY_VAULT.replace(/\\/g, '/');
  let changed = 0;
  for (const r of rows) {
    const rel = (p: string) => p.replace(/\\/g, '/').slice(vault.length + 1);
    if (writeNote(rel(r.tpath), { status: 'superseded', superseded_by: r.fid, expired_at: now.toISOString() }) !== 'kept-user-edit') changed++;
    writeNote(rel(r.path), { review_target: '' }); // ponytail: an edited approval note keeps its review_target; harmless (target already superseded)
  }
  if (changed) { await indexVault(db, MEMORY_VAULT); await resolveLinks(db); }
}


/** SQL on `facts f`: no cited turn is indexed any more (forgotten / gone). obs: = a note citing itself, not a chat. */
export const ORPHAN = `NOT EXISTS (SELECT 1 FROM unnest(f.source_uuids) u WHERE u LIKE 'obs:%' OR EXISTS (SELECT 1 FROM turns t WHERE t.uuid = u))`;

/**
 * forget cascade (importer.forget, after its delete): facts/cards that cited the forgotten chats. keep = cited turns still
 * indexed → the note stays, its provenance trimmed to keep. Nothing left → the note file is deleted (indexVault then drops and
 * tombstones it, as when ลุงจืด deletes one), unless he edited/pinned/wrote it: never touched, listed in hubs/_review.md instead.
 */
export async function retireForgotten(db: pg.Pool, facts: { fid: string; path: string; keep: string[] }[], what: string) {
  const out = { retired: [] as string[], trimmed: [] as string[], review: [] as string[] };
  const vault = MEMORY_VAULT.replace(/\\/g, '/');
  const projects = new Set<string>((await db.query(`SELECT DISTINCT coalesce(project, '') p FROM facts WHERE fid = ANY($1)`, [facts.map((f) => f.fid)])).rows.map((r) => r.p));
  try {
    for (const f of facts) {
      const rel = f.path.replace(/\\/g, '/').slice(vault.length + 1);
      const file = join(MEMORY_VAULT, rel);
      if (!existsSync(file)) continue; // deleted meanwhile: indexVault below drops it
      const { fm, body } = parseNote(readFileSync(file, 'utf8'));
      // = existingFacts' "hand", + owned (indexFact's user_owned): a NOOP never adds provenance to an owned fact, so a rule he
      // restated in later chats still cites only the first one; deleting it would tombstone the rule for good → _review instead
      const hand = isHis(fm, body);
      const label = `${f.fid} ${basename(rel, '.md')}`;
      if (!f.keep.length && !hand) {
        beforeMachineWrite(MEMORY_VAULT, rel); // vault history: this deletion is the forget commit, not "ลุงจืด แก้เอง"
        try { unlinkSync(file); out.retired.push(label); } catch (e) { console.warn(`forget: kept ${rel}: ${(e as Error).message}`); }
        continue;
      }
      if (f.keep.length && !hand) writeNote(rel, { source_uuids: f.keep });
      // his file stays as he left it; the index forgets the session either way (timeline / related read session_ids)
      await db.query(`UPDATE facts SET source_uuids = CASE WHEN cardinality($2::text[]) > 0 THEN $2::text[] ELSE source_uuids END,
        session_ids = coalesce((SELECT array_agg(DISTINCT session_id) FROM turns WHERE uuid = ANY($2::text[])), '{}') WHERE fid = $1`, [f.fid, f.keep]);
      (f.keep.length ? out.trimmed : out.review).push(label);
    }
    await indexVault(db, MEMORY_VAULT);
    // a project this forget left with no notes: writeHubs skips it, so its hub would keep listing the forgotten titles
    const left = new Set((await db.query(`SELECT DISTINCT coalesce(project, '') p FROM facts WHERE coalesce(project, '') = ANY($1)`, [[...projects]])).rows.map((r) => r.p));
    for (const p of [...projects].filter((x) => !left.has(x))) {
      const hub = `hubs/${hubName(p || 'global')}.md`;
      const { fm, body } = existsSync(join(MEMORY_VAULT, hub)) ? parseNote(readFileSync(join(MEMORY_VAULT, hub), 'utf8')) : { fm: {} as Fm, body: '' };
      if (fm.memhub !== 'hub' || fm.project !== p || isEdited(fm, body)) continue; // another project's hub (same slug) / his edit
      beforeMachineWrite(MEMORY_VAULT, hub);
      try { unlinkSync(join(MEMORY_VAULT, hub)); } catch (e) { console.warn(`forget: kept ${hub}: ${(e as Error).message}`); }
    }
    await writeHubs(db); // hubs stop linking retired notes; _review.md gains the edited ones
  } finally {
    commitBatch(MEMORY_VAULT, `forget ${what}: -${out.retired.length} notes, ${out.trimmed.length} trimmed, ${out.review.length} to review`);
  }
  return out;
}

/** hubs/<project> hub.md (pinned, ใช้บ่อย, ใหม่, ถูกแทนที่, recent cards) + hubs/_review.md. SQL only, no LLM. */
async function writeHubs(db: pg.Pool) {
  const rel = (p: string) => basename(p.replace(/\\/g, '/'), '.md');
  const rows = (await db.query(
    `SELECT f.fid, f.kind, coalesce(f.project, '') project, f.pinned, f.created_at, f.superseded_by, f.review_target, s.status, s.path,
            (SELECT count(DISTINCT a.session) FROM access_log a JOIN chunks c ON c.turn_uuid = a.turn_uuid
             WHERE c.source_id = s.id AND a.kind IN ('get', 'related') AND a.ts > now() - interval '30 days') uses
     FROM facts f JOIN sources s ON s.id = f.source_id`)).rows;
  const byProject = new Map<string, typeof rows>();
  for (const r of rows) (byProject.get(r.project) ?? byProject.set(r.project, []).get(r.project)!).push(r);
  const fidRel = new Map(rows.map((r) => [r.fid, rel(r.path)]));
  for (const [project, rs] of byProject) {
    const facts = rs.filter((r) => r.kind !== 'card');
    const list = (xs: typeof rows, f = (r: (typeof rows)[number]) => `[[${rel(r.path)}]]`) => (xs.length ? xs.map((r) => `- ${f(r)}`).join('\n') : '- (none)');
    const body = `# ${project ? projectName(project) : 'global'} hub\n\n` +
      `## Pinned / rules\n${list(facts.filter((r) => r.status === 'active' && (r.pinned || ['rule', 'feedback'].includes(r.kind))))}\n\n` +
      `## ใช้บ่อย (30 วัน)\n${list(facts.filter((r) => r.uses > 0).sort((a, b) => b.uses - a.uses).slice(0, 10), (r) => `[[${rel(r.path)}]] · ${r.uses} sessions`)}\n\n` +
      `## ใหม่\n${list(facts.filter((r) => r.status === 'active').sort((a, b) => +b.created_at - +a.created_at).slice(0, 10))}\n\n` +
      `## ถูกแทนที่ล่าสุด\n${list(facts.filter((r) => r.status === 'superseded').sort((a, b) => +b.created_at - +a.created_at).slice(0, 10), (r) => `[[${rel(r.path)}]] → [[${fidRel.get(r.superseded_by) ?? r.superseded_by}]]`)}\n\n` +
      `## Recent sessions\n${list(rs.filter((r) => r.kind === 'card').sort((a, b) => +b.created_at - +a.created_at).slice(0, 10))}\n`;
    writeNote(`hubs/${hubName(project || 'global')}.md`, { memhub: 'hub', project, tags: ['memhub/hub'] }, body);
  }
  const pending = rows.filter((r) => r.status === 'pending');
  // forget cascade left these alone: ลุงจืด edited/pinned/wrote them, yet every chat they cite is gone (retireForgotten)
  const orphans = (await db.query(`SELECT s.path FROM facts f JOIN sources s ON s.id = f.source_id
    WHERE (f.edited OR f.pinned OR f.run IS NULL OR f.user_owned) AND coalesce(s.status, 'active') IN ('active', 'pending') AND ${ORPHAN} ORDER BY s.path`)).rows;
  writeNote('hubs/_review.md', { memhub: 'hub', tags: ['memhub/review'] },
    `# Review queue\n\nDream proposals that touch your own notes or assistant-only claims. Open one and set **status**:\n` +
    `- \`active\` = accept (the target gets superseded tonight)\n- \`rejected\` = reject (never proposed again)\n\n` +
    (pending.length ? pending.map((r) => `- [[${rel(r.path)}]] vs [[${fidRel.get(r.review_target) ?? r.review_target}]]`).join('\n') : '- (empty)') + '\n' +
    (orphans.length ? `\n## Forgotten chats, your notes\nEvery chat these notes came from was forgotten (\`forget\`), but they are yours (edited, pinned, saved, or a rule/feedback), so they were kept. ` +
      `Delete the note = forget it too · status \`rejected\` = hide it from search · remove the \`source_uuids\` property = keep it as your own\n\n` +
      orphans.map((r) => `- [[${rel(r.path)}]]`).join('\n') + '\n' : ''));
  await indexVault(db, MEMORY_VAULT);
  await resolveLinks(db);
}
