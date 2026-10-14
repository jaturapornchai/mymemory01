// Dream: distil finished AI sessions (every app: sources.tool except obsidian) into session cards + facts (notes in the
// memory-hub vault), reconcile new facts with existing ones (ADD / NOOP / UPDATE / SUPERSEDE, never delete), then rebuild the synapses (synapse.ts) and hub notes.
// LLM = Claude (claude -p with Anthropic auth, or answered by Claude agents through request/result files), or DeepSeek's API
// (ลุงจืด 2026-10-10, --runner deepseek). Claude-only sources (Google = kind 'doc', chats shown them = hide_as) are never dreamed.
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
import { hideDreamed, projectName } from './importer.ts';
import { redactOffsite } from './redact.ts';
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
export const DREAM_LIMIT = Number(process.env.MEMHUB_DREAM_LIMIT) || 40;
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

const CLAUDE_BIN = process.env.MEMHUB_CLAUDE_BIN ?? (process.platform === 'win32'
  ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : 'claude');

/**
 * Headless `claude -p`. User settings are skipped (--setting-sources project) and ANTHROPIC_BASE_URL/AUTH_TOKEN are
 * dropped, so a settings.json "env" pointing at another vendor can't receive the transcripts; auth = the CLI's
 * Anthropic login (or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token` on a server); ANTHROPIC_API_KEY is dropped too: in -p it
 * outranks the subscription token and would bill the API. No tools, no MCP, no session persistence (the dream's own run never becomes input).
 */
export const claudeRunner = (model = process.env.MEMHUB_DREAM_MODEL ?? 'sonnet', log = console.log): Llm => async (req) => {
  const env: NodeJS.ProcessEnv = { ...process.env, MEMORY_HUB_INTERNAL: '1' };
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_OAUTH_SCOPES',
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

/** DeepSeek bills double 01:00-04:00 and 06:00-10:00 UTC on weekdays (api-docs.deepseek.com pricing, 2026-10-10). Chinese
 *  holidays are off-peak too; treating them as peak only skips a night. */
export const deepseekPeak = (t: Date) => t.getUTCDay() >= 1 && t.getUTCDay() <= 5 && [1, 2, 3, 6, 7, 8, 9].includes(t.getUTCHours());

// One value per JSON-schema node: the first enum / anyOf branch, ids from their pattern (^S\d+$ → S1).
const sample = (s: Record<string, any>): unknown =>
  s.type === 'object' ? Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sample(v as Record<string, any>)]))
  : s.type === 'array' ? [sample(s.items)] : s.enum ? s.enum[0] : s.anyOf ? sample(s.anyOf[0])
  : s.type === 'string' ? (s.pattern ? String(s.pattern).replace(/^\^|\$$/g, '').replace('\\d+', '1') : '...')
  : s.type === 'integer' || s.type === 'number' ? (s.minimum ?? 0) : null;

/**
 * DeepSeek API ("ใช้แบบประหยัด"): non-thinking model, JSON mode, temperature 0. Prompt + schema go first so every batch of a
 * pass shares one cached prefix (cache hits bill at a fraction). Offsite, so every key-shaped token is scrubbed (redactOffsite).
 * JSON mode has no schema enforcement: an example object cut the pilot's invalid batches (s: 1/null, 9 facts) from 2/4 to 1/12.
 * JSON mode may return empty content: one retry.
 * Pass A only: thinking + a rule checklist (prompts/dream-extract-deepseek.md). 2026-10-10 blind opus judge, 3 batches / 25 sessions:
 * facts without evidence 13/88 -> 0/58, wrong kind 30 -> 2, ~3-4x output tokens. Claude never sees the checklist.
 */
export const deepseekRunner = (model = process.env.MEMHUB_DEEPSEEK_MODEL ?? 'deepseek-flash', log = console.log, retryMs = 1000): Llm => async (req) => {
  const key = process.env.MEMHUB_DEEPSEEK_KEY;
  if (!key) throw new Error('MEMHUB_DEEPSEEK_KEY is not set (.env)');
  if (process.env.MEMHUB_ANTHROPIC_ONLY === '1') throw new Error('refusing deepseek: MEMHUB_ANTHROPIC_ONLY=1');
  const passA = req.id.startsWith('A-');
  // thinking is on by default (billed as output); max_tokens defaults to 8K, too small for a 12-session pass A in Thai (thinking: up to 18K seen)
  const body = JSON.stringify({ model, thinking: { type: passA ? 'enabled' : 'disabled' }, temperature: 0, max_tokens: 65536, response_format: { type: 'json_object' }, messages: [
    { role: 'system', content: `${req.system}${passA ? `\n\n${PROMPT('dream-extract-deepseek')}` : ''}\n\nReply with one json object that follows this JSON schema:\n${JSON.stringify(req.schema)}\n\nExample json (format only):\n${JSON.stringify(sample(req.schema))}` },
    // a lone surrogate (an emoji cut by a length cap) becomes \ud83d in JSON, which DeepSeek's parser rejects with a 400
    { role: 'user', content: redactOffsite(req.user).toWellFormed() }] });
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', body, signal: AbortSignal.timeout(600_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } });
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, attempt * retryMs));
      continue;
    }
    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * retryMs));
        continue;
      }
      throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const r = await res.json() as { choices: { message: { content: string }; finish_reason: string }[]; usage?: Record<string, number> };
    const u = r.usage ?? {};
    log(`  ${req.id}: in ${u.prompt_cache_miss_tokens ?? '?'} + cache ${u.prompt_cache_hit_tokens ?? 0}, out ${u.completion_tokens ?? '?'} tokens, ${Date.now() - t0} ms`);
    try { return JSON.parse(r.choices[0].message.content); }
    catch (e) { if (attempt >= 3) throw new Error(`deepseek: no json (${r.choices[0]?.finish_reason}): ${String(e).slice(0, 200)}`); }
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
    n: z.string().regex(/^N\d+$/), op: z.enum(['UPDATE', 'ADD', 'NOOP', 'SUPERSEDE']),
    target: z.string().regex(/^E\d+$/).nullable().optional(), text: z.string().max(400).optional(),
    links: z.array(z.object({ to: z.string().regex(/^E\d+$/), rel: z.enum(['supports', 'related']) })).max(3).optional(),
    why: z.string().max(160).optional(),
  })),
});
// DeepSeek's JSON mode has no schema (pilot: one over-long title dropped a whole session): clip at word/cluster boundary, drop only bad facts
const SessionA = SchemaA.shape.sessions.element;
export const clip = (t: unknown, n: number) => {
  if (typeof t !== 'string') return t;
  const s = t.toWellFormed().trim();
  if (s.length <= n) return s;
  const raw = s.slice(0, n - 1);
  const cutAt = Math.max(raw.lastIndexOf(' '), raw.lastIndexOf('\n'));
  const base = (cutAt >= n * 0.8 ? raw.slice(0, cutAt) : raw).replace(/[\s\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]+$/u, '');
  return (base || raw) + '…';
};
const clipAll = (v: unknown, n: number) =>
  Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 5).map((t) => clip(t, n)) : undefined;
const repairFact = (f: any) => (!f || typeof f !== 'object' ? f : {
  ...f,
  text: clip(f.text, 400),
  importance: typeof f.importance === 'number' && Number.isFinite(f.importance) ? Math.min(10, Math.max(1, Math.round(f.importance))) : f.importance,
  confidence: typeof f.confidence === 'number' && Number.isFinite(f.confidence) ? Math.min(1, Math.max(0, f.confidence > 1 ? f.confidence / 10 : f.confidence)) : f.confidence,
  ...(f.valid_at === '' ? { valid_at: null } : {}),
  ...(f.invalid_at === '' ? { invalid_at: null } : {}),
});
export const repairSession = (x: any) => (!x?.card ? x : { ...x,
  card: { ...x.card, title: clip(x.card.title, 80), summary: clip(x.card.summary, 600), decisions: clipAll(x.card.decisions, 200), open: clipAll(x.card.open, 200) },
  facts: Array.isArray(x.facts) ? x.facts.map(repairFact).filter((f: unknown) => SessionA.shape.facts.element.safeParse(f).success).slice(0, 8) : x.facts });
// Pass B (trial 2026-10-10 + live 2026-10-13): DeepSeek JSON mode emits null for unused optional fields, >160-char Thai why,
// or >400-char UPDATE text. An over-long UPDATE becomes ADD ("if both do not fit … choose ADD"); non-UPDATE ops drop text.
const LinkB = SchemaB.shape.ops.element.shape.links.unwrap().element;
export const repairOp = (x: any) => {
  if (!x || typeof x !== 'object') return x;
  const over = typeof x.text === 'string' && x.text.length > 400;
  const op = over && x.op === 'UPDATE' ? 'ADD' : x.op;
  const out: Record<string, unknown> = { ...x, op, ...(op === 'ADD' || x.target === '' ? { target: null } : {}) };
  if (over || x.text === null || x.text === '' || (op !== 'UPDATE' && typeof x.text === 'string')) out.text = undefined;
  if (x.links === null || !Array.isArray(x.links)) delete out.links;
  else out.links = x.links.filter((l: unknown) => LinkB.safeParse(l).success).slice(0, 3);
  if (x.why === null || x.why === '') delete out.why;
  else if (typeof x.why === 'string' && x.why.length > 160) out.why = clip(x.why, 160);
  return out;
};
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
// ลุงจืด answering an AI's multiple-choice question: Claude's AskUserQuestion tool row, ZCode's "[Ask result]" line inside the
// assistant row. It is his decision, so it goes in as a user turn ("Q"="label"; a label with (Recommended)/(แนะนำ) = he took
// the AI's suggestion). Dismissed (no "="="), boilerplate cut.
const ASK = /^\[(?:AskUserQuestion|Ask) result\] (?:Your questions have been answered|The user answered|User has answered your questions): ?/;
const ASK_TAIL = /\.? (?:You can now continue|Read the answers carefully)[\s\S]*$/;
const choice = (s: string) => ASK.test(s) && s.includes('"="') ? `[ตอบตัวเลือกของ AI] ${s.replace(ASK, '').replace(ASK_TAIL, '').trim()}` : null;

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
      // ZCode: [before the question, "[Ask result] …", the reply after it, …]; only the last reply part stays (as with rows)
      for (const [k, part] of r.text.split(/^(\[Ask result\] .*)$/m).entries()) {
        const c = k % 2 ? choice(part) : null;
        if (c) { pend = null; turns.push({ uuid: r.uuid, role: 'user', ts: r.ts, i, text: cut(c, 2000) }); }
        else if (!(k % 2)) pend = { uuid: r.uuid, role: 'assistant', ts: r.ts, i, text: part };
      }
    } else if (r.role === 'tool') { // Claude: the asking reply is replaced by what follows, like any non-final assistant row
      const c = choice(r.text.trim());
      if (c) { pend = null; turns.push({ uuid: r.uuid, role: 'user', ts: r.ts, i, text: cut(c, 2000) }); }
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
    let plan: { ranges: Range[]; batches: string[][]; stats?: DreamStats; missed?: string[]; resultsA?: unknown[] } | undefined =
      (await db.query('SELECT v FROM state WHERE k = $1', [planKey])).rows[0]?.v;
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

    // Pass A for every batch first (independent → parallel; completed batches cached in plan so a mid-run failure never re-bills them).
    const sysA = PROMPT('dream-extract'), schemaA = jsonSchema(SchemaA);
    const pending: string[] = [];
    const resultsA: unknown[] = [...(plan.resultsA ?? [])];
    let errA: unknown;
    await Promise.all(batches.map(async (b, i) => {
      if (resultsA[i] !== undefined && resultsA[i] !== null) return;
      try {
        resultsA[i] = await o.llm({ id: `A-${sha(b.text)}`, system: sysA, user: `Current date: ${BKK(now)} (Asia/Bangkok)\n\n${b.text}`, schema: schemaA });
      } catch (e) {
        resultsA[i] = null;
        if (e instanceof Pending) pending.push(e.message);
        else errA ??= e;
      }
    }));
    plan = { ...plan, resultsA };
    await db.query('UPDATE state SET v = $2 WHERE k = $1', [planKey, JSON.stringify(plan)]);
    if (errA) throw errA;
    if (pending.length) return { status: 'pending', stats, pending };

    // Then reconcile + promote batch by batch, re-indexing in between so later batches see earlier facts.
    const missed = new Set(plan.missed); // sessions left without a card this run (promoteBatch)
    for (const [i, b] of batches.entries()) {
      // promoted in an earlier invocation of this run
      if (b.digests.every((d) => missed.has(d.sessionId) || (doneHere.get(d.sessionId) ?? '') >= d.upto)) continue;
      const bs = { ...stats }; // a batch stopped by Pending reruns whole: only a finished batch adds its counts
      try { record.push(await promoteBatch(db, o, b, resultsA[i], bs, now, missed)); }
      catch (e) { if (e instanceof Pending) return { status: 'pending', stats, pending: [e.message] }; throw e; }
      Object.assign(stats, bs);
      // a files runner stops at every pass-B request: kept with the plan, the run record counts the whole run, not its last invocation
      await db.query('UPDATE state SET v = $2 WHERE k = $1', [planKey, JSON.stringify({ ...plan, stats, missed: [...missed] })]);
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

async function promoteBatch(db: pg.Pool, o: DreamOpts, b: Batch, rawA: unknown, stats: DreamStats, now: Date, missed: Set<string>) {
  const log = o.log ?? console.log;
  const a = SchemaA.safeParse(rawA);
  const sessions = a.success ? a.data.sessions : (z.object({ sessions: z.array(z.unknown()) }).safeParse(rawA).data?.sessions ?? [])
    .map((x) => { const r = SessionA.safeParse(x); return r.success ? r : SessionA.safeParse(repairSession(x)); }).filter((x) => x.success).map((x) => x.data!);
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

  // Fast path (no LLM): tombstoned / rejected → drop; identical text → NOOP; same md5 in batch → merge into first; no similar fact → ADD.
  const ops = new Map<string, { op: string; target?: Existing; text?: string; links: { e: Existing; rel: string }[]; why?: string; sameAs?: string }>();
  const seenMd5 = new Map<string, Cand>();
  for (const c of cands) {
    const h = md5(c.text);
    if ((await db.query(`SELECT 1 FROM forgotten WHERE key = $1`, [`fact:${h}`])).rowCount) { stats.dropped++; ops.set(c.n, { op: 'DROP', links: [] }); continue; }
    const same = await existingFacts(db, 'f.md5 = $1', [h]);
    if (same.some((e) => e.status === 'rejected')) { stats.dropped++; ops.set(c.n, { op: 'DROP', links: [] }); continue; }
    const live = same.find((e) => e.status !== 'superseded');
    if (live) { ops.set(c.n, { op: 'NOOP', target: live, links: [] }); continue; }
    const first = seenMd5.get(h);
    if (first) {
      first.uuids = [...new Set([...first.uuids, ...c.uuids])];
      first.byUser ||= c.byUser;
      ops.set(c.n, { op: 'NOOP', sameAs: first.n, links: [] });
      continue;
    }
    seenMd5.set(h, c);
    // tier 0: neighbours by similarity only (the priority tier pushed owned notes above closer dream facts → duplicate ADDs)
    const { hits } = await search(db, c.text, { project: MEMORY_PROJECT, limit: 12, semantic: true, perSession: 1, tier: 0 });
    const fids = [...new Set(hits.filter((x) => x.fid && x.kind !== 'card' && x.status !== 'superseded' && x.status !== 'rejected').map((x) => x.fid!))].slice(0, 5);
    c.E = fids.length ? await existingFacts(db, 'f.fid = ANY($1)', [fids]) : [];
    if (!c.E.length) ops.set(c.n, { op: 'ADD', links: [] });
  }

  // Pass B: reconcile the rest with the LLM.
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
      let r = SchemaB.shape.ops.element.safeParse(x);
      if (!r.success) r = SchemaB.shape.ops.element.safeParse(repairOp(x));
      if (!r.success) { stats.rejected_ids++; continue; }
      const c = needB.find((k) => k.n === r.data.n);
      const allowed = (e?: string | null) => (e ? c?.E.find((k) => k.fid === emap.get(e)?.fid) ?? emap.get(e) : undefined);
      const target = r.data.op === 'ADD' ? undefined : allowed(r.data.target);
      if (!c || ops.has(c.n) || (r.data.op !== 'ADD' && !target)) { stats.rejected_ids++; continue; } // reject, never repair
      ops.set(c.n, { op: r.data.op, target, text: r.data.text, why: r.data.why,
        links: (r.data.links ?? []).map((l) => ({ e: allowed(l.to)!, rel: l.rel })).filter((l) => l.e) });
    }
  }

  // Promote: write notes. Only machine-owned keys change; ลุงจืด's own notes are never rewritten.
  const written = new Map<string, string>(), candRel = new Map<string, string>(); // md5 → rel, c.n → rel
  for (const c of cands) {
    const op = ops.get(c.n);
    if (!op || op.op === 'DROP') continue;
    if (op.sameAs) {
      const prevRel = candRel.get(op.sameAs);
      if (prevRel) { stats.NOOP++; candRel.set(c.n, prevRel); cards.get(c.s)?.facts.push(prevRel); }
      continue;
    }
    stats[op.op]++;
    const base: Fm = { memhub: 'fact', kind: c.kind, scope: c.scope, project: c.scope === 'global' ? '' : c.d.project, lang: c.lang,
      importance: String(c.importance), confidence: String(c.confidence), pinned: 'false', run: o.run, created_at: now.toISOString(),
      tags: [`memhub/${c.kind}`, `project/${projectSlug(c.d.project)}`] };
    const body = (text: string, extra: string[] = []) =>
      `${text}\n\n- from:: ${link(c.card)}\n${[...extra, ...op.links.map((l) => `- ${l.rel}:: ${link(l.e.rel)}`)].join('\n')}${extra.length || op.links.length ? '\n' : ''}`;
    const addNote = (text: string, uuids: string[], fm: Fm, extra: string[] = []) => {
      const h = md5(text);
      if (written.has(h)) {
        const prev = written.get(h)!;
        const cur = parseNote(readFileSync(join(MEMORY_VAULT, prev), 'utf8')).fm.source_uuids;
        writeNote(prev, { source_uuids: [...new Set([...(Array.isArray(cur) ? cur : []), ...uuids])] });
        return prev;
      }
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
    candRel.set(c.n, rel);
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
  // The prompt asks for one card per session: one left without (the model skipped it) stays undone and is retried next run,
  // and so are its later windows, or marking those would jump over the skipped turns.
  const carded = new Set([...cards.values()].map((c) => c.d)), noCard = b.digests.filter((d) => !carded.has(d));
  for (const d of noCard) missed.add(d.sessionId);
  if (noCard.length) stats.no_card = (stats.no_card ?? 0) + noCard.length;
  for (const d of b.digests) if (!missed.has(d.sessionId)) await markDone(db, d.sessionId, { run: o.run, card: d.card, upto: d.upto });
  log(`dream batch: ${b.digests.length} sessions, ${cands.length} candidate facts${noCard.length ? `, ${noCard.length} without a card (retried next run)` : ''}`);
  return { sessions: b.digests.map((d) => d.sessionId), candidates: cands.map((c) => ({ n: c.n, text: c.text, kind: c.kind, uuids: c.uuids, op: ops.get(c.n)?.op, target: ops.get(c.n)?.target?.fid })) };
}

// ---------------- nightly consolidation (no LLM) ----------------

/** Approvals, synapse rebuild ('sleep': structural kinds + co-access with downscaling, synapse.ts), hub + review notes. Safe to run every night. */
export async function consolidate(db: pg.Pool, now = new Date()) {
  await db.query(`DELETE FROM state WHERE k ~ '^dream:plan:\\d{4}-\\d{2}-\\d{2}-' AND k < $1`, [`dream:plan:${BKK(new Date(+now - 2 * 86400_000))}`]);
  await hideDreamed(db); // catch-all before synapses/hubs: a chat hidden after its facts were dreamed
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
  // a fact dreamed from a chat hidden later (importer.hideDreamed) is no hub line, and an arrow to it shows [[?]]
  const HID = (col: string) => `CASE WHEN EXISTS (SELECT 1 FROM facts t JOIN sources ts ON ts.id = t.source_id WHERE t.fid = ${col} AND ts.hide_as IS NOT NULL) THEN '?' ELSE ${col} END`;
  const rel = (p: string) => basename(p.replace(/\\/g, '/'), '.md');
  const rows = (await db.query(
    `SELECT f.fid, f.kind, coalesce(f.project, '') project, f.pinned, f.created_at, ${HID('f.superseded_by')} superseded_by, ${HID('f.review_target')} review_target, s.status, s.path,
            (SELECT count(DISTINCT a.session) FROM access_log a JOIN chunks c ON c.turn_uuid = a.turn_uuid
             WHERE c.source_id = s.id AND a.kind IN ('get', 'related') AND a.ts > now() - interval '30 days') uses
     FROM facts f JOIN sources s ON s.id = f.source_id WHERE s.hide_as IS NULL`)).rows; // hubs are read by every app
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
