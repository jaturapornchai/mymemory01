// 1) sync: copy live ~/.claude/projects into the append-only archive (never deletes, never overwrites history)
// 2) index: archive JSONL → redact → turns + chunks (idempotent: unchanged files skipped, rows keyed by uuid / content hash)
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, utimesSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import type pg from 'pg';
import { parseClaude, parseSubagent, type Msg } from './claude.ts';
import { chunkTurns, CHUNKER_VER, type Turn } from './chunk.ts';
import { PRIVATE_TOOLS } from './guard.ts';
import { redact, redactPersonal, stripPrivate } from './redact.ts';
import { bigramRuns, bigramTsvector, toTsvector, words } from './thai.ts';
import * as antigravity from './tools/antigravity.ts';
import * as codex from './tools/codex.ts';
import * as gemini from './tools/gemini.ts';
import * as github from './tools/github.ts';
import * as google from './tools/google.ts';
import * as googleTimeline from './tools/google-timeline.ts';
import * as lmstudio from './tools/lmstudio.ts';
import * as zcode from './tools/zcode.ts';

const HOME = homedir();
export const LIVE_DIR = process.env.MEMHUB_LIVE_DIR ?? join(HOME, '.claude', 'projects');
export const ARCHIVE_DIR = process.env.MEMHUB_ARCHIVE_DIR ?? join(HOME, 'ai-archive', 'raw', 'claude', 'projects');
// Other AI apps (src/tools/*.ts) archive into <root>/<tool>; tests that move the Claude archive move this too.
export const ARCHIVE_ROOT = process.env.MEMHUB_ARCHIVE_ROOT ??
  (process.env.MEMHUB_ARCHIVE_DIR ? dirname(process.env.MEMHUB_ARCHIVE_DIR) : join(HOME, 'ai-archive', 'raw'));
export const SNAPSHOT_DIRS = [join(HOME, 'ai-archive', 'raw', 'claude-projects-2026-10-01')];
// Comma-separated project prefixes that must never be indexed, e.g. "d:/secret-client,c:/x".
const EXCLUDE = (process.env.MEMHUB_EXCLUDE_PROJECTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/** Lines split on \n only: readline also breaks on U+2028/U+2029, which serde_json leaves raw inside strings. */
export async function* readLines(path: string) {
  const input = createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 22 });
  let rest = '';
  try {
    for await (const chunk of input as AsyncIterable<string>) {
      if (!chunk.includes('\n')) { rest += chunk; continue; } // 30 MB lines: only the new chunk is scanned
      const parts = chunk.split('\n');
      parts[0] = rest + parts[0];
      rest = parts.pop()!;
      yield* parts;
    }
    if (rest) yield rest;
  } finally { input.destroy(); }
}

// ---------------- archive sync ----------------

function copy(file: string, dst: string, s: ReturnType<typeof statSync>) {
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(file, dst);
  utimesSync(dst, s.atime, s.mtime);
}

export const archivePath = (liveFile: string) => join(ARCHIVE_DIR, relative(LIVE_DIR, liveFile));

const BLOCK = 1 << 24; // 16 MB: Codex rollouts reach 1 GB, never load a whole file to compare/copy it
/** Does file `a` start with the first `n` bytes of file `b`? */
function hasPrefix(a: string, b: string, n: number) {
  const fa = openSync(a, 'r'), fb = openSync(b, 'r');
  try {
    const x = Buffer.allocUnsafe(Math.min(BLOCK, n)), y = Buffer.allocUnsafe(Math.min(BLOCK, n));
    for (let pos = 0; pos < n;) {
      const k = readSync(fb, y, 0, Math.min(BLOCK, n - pos), pos);
      if (k <= 0 || readSync(fa, x, 0, k, pos) !== k || !x.subarray(0, k).equals(y.subarray(0, k))) return false;
      pos += k;
    }
    return true;
  } finally { closeSync(fa); closeSync(fb); }
}
/** Append bytes [from, to) of `src` to `dst`. */
function appendRange(src: string, dst: string, from: number, to: number) {
  const fs = openSync(src, 'r'), fd = openSync(dst, 'a');
  try {
    const buf = Buffer.allocUnsafe(Math.min(BLOCK, to - from));
    for (let pos = from; pos < to;) {
      const k = readSync(fs, buf, 0, Math.min(BLOCK, to - pos), pos);
      if (k <= 0) break;
      writeSync(fd, buf, 0, k);
      pos += k;
    }
  } finally { closeSync(fs); closeSync(fd); }
}

export type SyncResult = 'copied' | 'appended' | 'replaced' | 'conflicts' | 'unchanged';
/**
 * Copy one live file to its archive path: new → copy, grown with the old bytes as prefix → append the tail,
 * rewritten → keep the old copy as <dst>.<mtime>.bak (keepOld) or overwrite it (metadata: latest wins).
 */
export function syncFile(file: string, dst: string, keepOld = true): SyncResult {
  const s = statSync(file);
  if (!existsSync(dst)) return copy(file, dst, s), 'copied';
  const d = statSync(dst);
  if (s.size === d.size && Math.abs(s.mtimeMs - d.mtimeMs) < 2) return 'unchanged';
  if (s.size >= d.size && hasPrefix(file, dst, d.size)) {
    if (s.size > d.size) appendRange(file, dst, d.size, s.size);
    utimesSync(dst, s.atime, s.mtime);
    return s.size > d.size ? 'appended' : 'unchanged';
  }
  if (keepOld) renameSync(dst, `${dst}.${Math.round(d.mtimeMs)}.bak`);
  copy(file, dst, s);
  return keepOld ? 'conflicts' : 'replaced';
}

/** Copy one live Claude file into the archive: transcripts keep rewritten versions, metadata: latest wins. */
export const syncOne = (file: string) => syncFile(file, archivePath(file), file.endsWith('.jsonl'));

export function syncArchive() {
  const stats = { copied: 0, appended: 0, replaced: 0, conflicts: 0, unchanged: 0 };
  // Snapshots only seed files the archive doesn't have yet (live copies are newer).
  for (const src of SNAPSHOT_DIRS) {
    for (const file of walk(src)) {
      const dst = join(ARCHIVE_DIR, relative(src, file));
      if (!existsSync(dst)) { copy(file, dst, statSync(file)); stats.copied++; }
    }
  }
  for (const file of walk(LIVE_DIR)) stats[syncOne(file)]++;
  const tools: Record<string, Record<string, number | string> | string> = {};
  for (const t of TOOLS) { // one broken app never stops the others
    try { tools[t.tool] = t.sync(join(ARCHIVE_ROOT, t.tool)); } catch (e) { tools[t.tool] = `failed: ${(e as Error).message}`; }
  }
  return { ...stats, tools };
}

// ---------------- other AI apps ----------------

/** One archived session of another AI app. msgs[].uuid must be globally unique and stable across re-parses. */
export type Parsed = { sessionId: string; cwd?: string; kind?: 'main' | 'subagent' | 'headless' | 'doc'; msgs: Msg[] }; // headless = run by a script/another AI, doc = not a chat (GitHub): searchable, never dreamed
/** src/tools/<tool>.ts: live history → ARCHIVE_ROOT/<tool> (append-only, never deletes) → sessions. */
export type ToolModule = {
  tool: string;                                      // sources.tool
  sync(archiveDir: string): Record<string, number | string>;  // copy/export new live data (syncFile); counts (+ skipped/stopped reason) for the log
  isTranscript(path: string): boolean;               // which archived files to index
  parse(path: string): Promise<Parsed | null>;       // null = junk / nothing worth remembering
};
export const TOOLS: ToolModule[] = [codex, gemini, antigravity, zcode, lmstudio, github, google, googleTimeline];

/** sha256 of a file in blocks (archived sessions can be 1 GB). */
function fileSha(path: string) {
  const h = createHash('sha256'), fd = openSync(path, 'r'), buf = Buffer.allocUnsafe(BLOCK);
  try { for (let k; (k = readSync(fd, buf, 0, BLOCK, null)) > 0;) h.update(buf.subarray(0, k)); } finally { closeSync(fd); }
  return h.digest('hex');
}

export async function indexToolFile(db: pg.Pool, t: ToolModule, path: string, force = false): Promise<'skip' | 'excluded' | 'indexed' | 'empty'> {
  const st = statSync(path);
  const old = (await db.query('SELECT id, size, mtime_ms, sha256 FROM sources WHERE path = $1', [path])).rows[0];
  if (!force && old && Number(old.size) === st.size && Number(old.mtime_ms) === Math.round(st.mtimeMs)) return 'skip';
  const hash = fileSha(path);
  if (!force && old && old.sha256 === hash) {
    await db.query('UPDATE sources SET mtime_ms = $2 WHERE id = $1', [old.id, Math.round(st.mtimeMs)]);
    return 'skip';
  }
  const p = await t.parse(path);
  const project = p?.cwd ? normProject(p.cwd) : '';
  if (!p?.msgs.length || EXCLUDE.some((x) => project.startsWith(x)) || await isForgotten(db, p.sessionId, project)) {
    if (old) await db.query('DELETE FROM sources WHERE id = $1', [old.id]);
    return p?.msgs.length ? 'excluded' : 'empty';
  }
  const turns = p.msgs.map((m, i) => ({ uuid: m.uuid, parentUuid: m.parentUuid, seq: i, role: m.role, ts: m.ts, text: clean(m.text, PRIVATE_TOOLS.has(t.tool)) }));
  await store(db, {
    tool: t.tool, path, kind: p.kind ?? 'main', sessionId: p.sessionId, project, size: st.size, mtimeMs: st.mtimeMs, sha256: hash,
    label: `${projectName(project) || '(no project)'} · ${t.tool}`, isSub: p.kind === 'subagent',
    replace: !!old, // exports/JSON docs are rewritten, not appended: re-insert (uuids are stable, so facts still resolve)
  }, turns);
  return 'indexed';
}

// ---------------- index ----------------

const roots = new Map<string, string>();
/** Project = the repo a cwd belongs to: Claude worktrees → their main repo, subdirs → nearest git root, else the cwd. */
export function normProject(cwd: string): string {
  const p = cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase().replace(/\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/, '');
  let root = roots.get(p);
  if (root === undefined) {
    root = p;
    for (let d = p; d.includes('/'); d = d.slice(0, d.lastIndexOf('/'))) if (existsSync(`${d}/.git`)) { root = d; break; }
    roots.set(p, root);
  }
  return root;
}
export const projectName = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p;
/** Text as the index may hold it: no <private>, no secrets; personal = redactPersonal first (Claude-only Google sources). */
export const clean = (t: string, personal = false) => { // PG text can't hold NUL
  const s = stripPrivate(t.replaceAll('\u0000', ''));
  return redact(personal ? redactPersonal(s).text : s).text;
};

export type SourceMeta = {
  tool: string; path: string; kind: string; sessionId: string; project: string;
  size: number; mtimeMs: number; sha256: string;
  label: string;      // shown in chunk headers (project name / vault+note)
  replace: boolean;   // delete this source's old turns first (rewritten file, edited note)
  isSub?: boolean;
  hideAs?: string | null; // a chat that quoted a Claude-only hit: that private tool (sticky, never cleared by a re-index)
};
export type StoredTurn = Turn & { parentUuid: string | null };

/** Upsert one source with its (already redacted) turns + chunks in one transaction. Returns source id. */
export async function store(db: pg.Pool, m: SourceMeta, turns: StoredTurn[], inTx?: (c: pg.PoolClient, sourceId: string) => Promise<void>) {
  const seen = new Set<string>(); // same text twice in one source = one chunk (its first place), as ON CONFLICT DO NOTHING kept it
  const chunks = chunkTurns(turns, m.label).filter((k) => !seen.has(k.id) && !!seen.add(k.id));
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [m.path]); // concurrent hooks on one file
    const src = await c.query(
      `INSERT INTO sources (tool, path, kind, session_id, project, size, mtime_ms, sha256, hide_as)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (path) DO UPDATE SET size = EXCLUDED.size, mtime_ms = EXCLUDED.mtime_ms, sha256 = EXCLUDED.sha256,
         session_id = EXCLUDED.session_id, project = EXCLUDED.project, imported_at = now(), hide_as = coalesce(sources.hide_as, EXCLUDED.hide_as)
       RETURNING id`,
      [m.tool, m.path, m.kind, m.sessionId, m.project, m.size, Math.round(m.mtimeMs), m.sha256, m.hideAs ?? null],
    );
    const sourceId = src.rows[0].id;
    if (m.replace) await c.query('DELETE FROM turns WHERE source_id = $1', [sourceId]);

    for (let i = 0; i < turns.length; i += 1000) {
      const b = turns.slice(i, i + 1000);
      await c.query(
        `INSERT INTO turns (uuid, source_id, seq, session_id, parent_uuid, role, ts, project, text_redacted, is_subagent)
         SELECT u, $1, s, $2, p, r, NULLIF(t, '')::timestamptz, $3, x, $4
         FROM unnest($5::text[], $6::int[], $7::text[], $8::text[], $9::text[], $10::text[]) AS v(u, s, p, r, t, x)
         ON CONFLICT (uuid) DO UPDATE SET text_redacted = EXCLUDED.text_redacted, project = EXCLUDED.project, session_id = EXCLUDED.session_id
           WHERE turns.source_id = EXCLUDED.source_id AND (turns.text_redacted, turns.project, turns.session_id)
             IS DISTINCT FROM (EXCLUDED.text_redacted, EXCLUDED.project, EXCLUDED.session_id)`, // import --force re-applies redaction/project rules
        [sourceId, m.sessionId, m.project, !!m.isSub, b.map((t) => t.uuid), b.map((t) => t.seq),
          b.map((t) => t.parentUuid), b.map((t) => t.role), b.map((t) => t.ts), b.map((t) => t.text)],
      );
    }

    const ids = chunks.map((k) => k.id);
    await c.query('DELETE FROM chunks WHERE source_id = $1 AND NOT (id = ANY($2::text[]))', [sourceId, ids]);
    for (let i = 0; i < chunks.length; i += 500) {
      const b = chunks.slice(i, i + 500);
      await c.query(
        `INSERT INTO chunks (id, source_id, turn_uuid, seq_from, seq_to, session_id, project, ts, ctx_header, text, words, bigrams, chunker_ver)
         SELECT id, $1, tu, sf, st, $2, $3, NULLIF(t, '')::timestamptz, h, x, w::tsvector, bg::tsvector, $4
         FROM unnest($5::text[], $6::text[], $7::int[], $8::int[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[])
           AS v(id, tu, sf, st, t, h, x, w, bg)
         ON CONFLICT (id) DO UPDATE SET turn_uuid = EXCLUDED.turn_uuid, seq_from = EXCLUDED.seq_from, seq_to = EXCLUDED.seq_to
           WHERE chunks.source_id = EXCLUDED.source_id AND (chunks.turn_uuid, chunks.seq_from, chunks.seq_to)
             IS DISTINCT FROM (EXCLUDED.turn_uuid, EXCLUDED.seq_from, EXCLUDED.seq_to)`, // a rewritten source (replace) renumbers its turns
        [sourceId, m.sessionId, m.project, CHUNKER_VER, b.map((k) => k.id), b.map((k) => k.turnUuid), b.map((k) => k.seqFrom),
          b.map((k) => k.seqTo), b.map((k) => k.ts), b.map((k) => k.ctxHeader), b.map((k) => k.text),
          b.map((k) => toTsvector(words(`${k.ctxHeader}
${k.text}`))), b.map((k) => bigramTsvector(bigramRuns(k.text)))],
      );
    }
    if (inTx) await inTx(c, sourceId);
    await c.query('COMMIT');
    return sourceId as string;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function indexFile(db: pg.Pool, path: string, force = false): Promise<'skip' | 'excluded' | 'indexed' | 'empty'> {
  const st = statSync(path);
  const prev = await db.query('SELECT id, size, mtime_ms, sha256 FROM sources WHERE path = $1', [path]);
  const old = prev.rows[0];
  if (!force && old && Number(old.size) === st.size && Number(old.mtime_ms) === Math.round(st.mtimeMs)) return 'skip';

  const buf = readFileSync(path);
  const hash = sha256(buf);
  if (!force && old && old.sha256 === hash) {
    await db.query('UPDATE sources SET mtime_ms = $2 WHERE id = $1', [old.id, Math.round(st.mtimeMs)]);
    return 'skip';
  }
  const isSub = path.split(sep).includes('subagents');
  const hub: string[] = [];
  const msgs: Msg[] = isSub ? parseSubagent(buf.toString('utf8'), hub) : parseClaude(buf.toString('utf8'), undefined, hub);
  // subagent / workflow journal: <project dir>/<parent session>/subagents/... — journals carry no sessionId or cwd
  const parts = path.split(sep);
  const parent = isSub ? parts[parts.indexOf('subagents') - 1] : undefined;
  const sessionId = msgs.find((m) => m.sessionId)?.sessionId || parent || basename(path, '.jsonl');
  const cwd = msgs.find((m) => m.cwd)?.cwd;
  const project = cwd ? normProject(cwd) : parent ? await parentProject(db, parts.slice(0, parts.indexOf('subagents')).join(sep), parent) : '';
  if (EXCLUDE.some((x) => project.startsWith(x)) || await isForgotten(db, sessionId, project)) {
    if (old) await db.query('DELETE FROM sources WHERE id = $1', [old.id]);
    return 'excluded';
  }
  const turns = msgs.map((m, i) => ({ uuid: m.uuid, parentUuid: m.parentUuid, seq: i, role: m.role, ts: m.ts, text: clean(m.text) }));
  // memory-hub showed this chat a Claude-only chunk (its id in a reply / a get) → its answers, /compact summaries and Agent
  // results may quote it: the whole session (main + subagents) is hidden wherever that tool is (sources.hide_as).
  // ids and the 8+ hex prefixes memory_get/timeline/related accept. ponytail: a hit re-chunked before this transcript is
  // indexed no longer resolves; match its labels too if that shows up
  const ids = [...new Set(hub.join('\n').match(/\b[0-9a-f]{8,16}\b/g) ?? [])].map((id) => `${id}%`);
  const hideAs: string | null = ids.length ? (await db.query(`SELECT s.tool FROM sources s JOIN chunks c ON c.source_id = s.id
    WHERE s.tool = ANY($2::text[]) AND c.id LIKE ANY($1) LIMIT 1`, [ids, [...PRIVATE_TOOLS]])).rows[0]?.tool ?? null : null;
  await store(db, {
    tool: 'claude', path, kind: isSub ? 'subagent' : 'main', sessionId, project,
    size: st.size, mtimeMs: st.mtimeMs, sha256: hash, label: projectName(project), isSub, hideAs,
    replace: !!old && st.size < Number(old.size), // rewritten (not appended): drop rows so seq numbers stay consistent
  }, turns, (c) => c.query(`UPDATE sources s SET hide_as = x.h FROM (SELECT max(hide_as) h FROM sources WHERE tool = 'claude' AND session_id = $1) x
    WHERE s.tool = 'claude' AND s.session_id = $1 AND s.hide_as IS NULL AND x.h IS NOT NULL`, [sessionId]).then(() => {}));
  return msgs.length ? 'indexed' : 'empty';
}

/** Project of the main session that spawned a subagent/workflow (indexed row, else its transcript's first cwd). */
async function parentProject(db: pg.Pool, sessionDir: string, sessionId: string): Promise<string> {
  const row = (await db.query(`SELECT project FROM sources WHERE kind = 'main' AND session_id = $1 AND project <> '' LIMIT 1`, [sessionId])).rows[0];
  if (row) return normProject(row.project);
  const main = `${sessionDir}.jsonl`;
  const cwd = existsSync(main) ? parseClaude(readFileSync(main, 'utf8')).find((m) => m.cwd)?.cwd : undefined;
  return cwd ? normProject(cwd) : '';
}

const isForgotten = async (db: pg.Pool, sessionId: string, project: string) => !!(await db.query(
  `SELECT 1 FROM forgotten WHERE key = 'session:' || $1 OR (key LIKE 'project:%' AND ($2 = substr(key, 9) OR starts_with($2, substr(key, 9) || '/')))`,
  [sessionId, project])).rowCount;

/** Drop a session or project (path prefix) from the index and tombstone it so imports skip it. Raw archive untouched.
 *  Facts/cards the dream distilled from it go too, unless another chat still backs them (dream.retireForgotten). */
export async function forget(db: pg.Pool, what: 'session' | 'project', value: string) {
  const v = what === 'project' ? normProject(value) : value;
  if (!v) throw new Error('empty value');
  await db.query('INSERT INTO forgotten (key) VALUES ($1) ON CONFLICT DO NOTHING', [`${what}:${v}`]);
  // a folder and what is under it, never a sibling that merely starts the same (d:/app ≠ d:/app2): the cascade deletes notes
  const where = what === 'session' ? 'session_id = $1' : `(project = $1 OR starts_with(project, $1 || '/'))`;
  const doomed = (await db.query(`SELECT id, session_id FROM sources WHERE ${where}`, [v])).rows;
  // Before the delete (its turns name the cited uuids). For a session, session_ids also finds facts of one forgotten before
  // this cascade existed (or a crashed run); a project rerun cannot (its sources are gone): lint lists those as orphans.
  // keep = cited turns that stay indexed; obs: = a note citing itself, never a chat.
  const facts = (await db.query(
    `SELECT f.fid, s.path, array(SELECT u FROM unnest(f.source_uuids) u WHERE u LIKE 'obs:%'
              OR EXISTS (SELECT 1 FROM turns t WHERE t.uuid = u AND t.source_id <> ALL($1::bigint[]))) keep
     FROM facts f JOIN sources s ON s.id = f.source_id
     WHERE f.session_ids && $2::text[] OR f.source_uuids && array(SELECT uuid FROM turns WHERE source_id = ANY($1::bigint[]))`,
    [doomed.map((s) => s.id), what === 'session' ? [v] : [...new Set(doomed.map((s) => s.session_id).filter(Boolean))]])).rows;
  const r = await db.query(`DELETE FROM sources WHERE ${where} RETURNING id, project`, [v]);
  // and their layout pins (src/layout.ts): forgotten raw keys must not linger in state, and the pin store stays bounded
  const pins = r.rows.flatMap((s) => [`source:${s.id}`, `source:${s.id}@github`]); // @github: a cloned repo's public spot (brain.ts)
  if (what === 'project') pins.push(...new Set(r.rows.map((s) => `project:${s.project ?? '?'}`))); // ponytail: a session forget keeps its hub's pin
  if (pins.length) await db.query(`UPDATE state SET v = v - $1::text[] WHERE k = 'layout'`, [pins]);
  await db.query('DELETE FROM access_log a WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = a.chunk_id)'); // queries may quote it
  // the SessionStart log names the project and the chats it showed (session-start.ts); absent before migrate
  await db.query(`DELETE FROM injections WHERE ${what === 'session' ? `session = $1 OR 'session:' || $1 = ANY(ids)` : `project = $1 OR starts_with(project, $1 || '/')`}`, [v])
    .catch(() => {});
  // after the delete: the review note lists edited notes whose chats are all gone. Dynamic: dream.ts imports this module
  const notes = facts.length ? await (await import('./dream.ts')).retireForgotten(db, facts, `${what} ${v}`) : { retired: [], trimmed: [], review: [] };
  // hubs/_lint.md keeps a week of sections naming notes; label = `${fid} ${note title}` (retireForgotten)
  await (await import('./lint.ts')).pruneLint(db, notes.retired.map((l) => l.slice(l.indexOf(' ') + 1)), `forget ${what} ${v}: _lint.md`);
  // daily notes quote prompts, card titles and fact names: rewritten without what is gone now (daily.ts)
  const daily = await (await import('./daily.ts')).rewriteDailies(db, `forget ${what} ${v}: daily notes`); // a rerun redoes them too
  return { sources: r.rowCount ?? 0, ...notes, daily };
}

export async function indexArchive(db: pg.Pool, force = false) {
  const stats: Record<string, number> = { skip: 0, excluded: 0, indexed: 0, empty: 0, failed: 0 };
  for (const f of walk(ARCHIVE_DIR)) {
    if (!f.endsWith('.jsonl') || f.split(sep).includes('tool-results')) continue;
    try { stats[await indexFile(db, f, force)]++; }
    catch (e) { stats.failed++; console.error(`index failed: ${f}: ${(e as Error).message}`); }
  }
  for (const t of TOOLS) {
    for (const f of walk(join(ARCHIVE_ROOT, t.tool))) {
      if (!t.isTranscript(f)) continue;
      try { stats[await indexToolFile(db, t, f, force)]++; }
      catch (e) { stats.failed++; console.error(`index failed: ${f}: ${(e as Error).message}`); }
    }
  }
  return stats;
}
