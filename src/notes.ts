// The memory-hub Obsidian vault: notes written by memory-hub itself (memory_save + dream). The .md file is the truth;
// the DB `facts` row is an index of it. ลุงจืด's edits win: a note whose body no longer matches its body_sha was edited
// by him and the machine never writes that file again. Every machine write batch is one commit in the vault's local git (vault-git.ts).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { clean } from './importer.ts';
import { beforeMachineWrite, commitBatch } from './vault-git.ts';

export const MEMORY_VAULT = process.env.MEMHUB_MEMORY_VAULT ?? 'D:/obsidian-vault/memory-hub';
export const MEMORY_PROJECT = `obsidian/${basename(MEMORY_VAULT)}`; // sources.project of its notes (as obsidian.ts names it)

export const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
/** Dedupe key of a fact's text: lowercase, whitespace collapsed. */
export const md5 = (s: string) => createHash('md5').update(s.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
/** Same uuid obsidian.ts gives a note → a saved note can cite itself as provenance. */
export const noteUuid = (path: string) => 'obs:' + createHash('sha256').update(path).digest('hex').slice(0, 24);

/** Obsidian-safe file name (Thai kept). */
export const fileName = (s: string, max = 80) =>
  cutAtWord(s.replace(/[\\/:*?"<>|#^[\]\x00-\x1f`]+/g, ' ').replace(/\s+/g, ' ').trim(), max).trim() || 'untitled';

/** Truncate on a word boundary (Thai-aware) so names/IPs/numbers are never cut into a different-looking value. */
function cutAtWord(s: string, max: number) {
  if (s.length <= max) return s;
  let end = 0;
  for (const { index } of new Intl.Segmenter('th', { granularity: 'word' }).segment(s)) { if (index > max) break; end = index; }
  return s.slice(0, end || max);
}

export type Fm = Record<string, string | string[]>;
const FM = /^---\n([\s\S]*?)\n---\n?/;

/** Flat YAML frontmatter: scalars, block lists (`- x`), inline lists (`[a, b]`). Enough for Obsidian Properties. */
export function parseNote(md: string): { fm: Fm; body: string } {
  const text = md.replace(/\r\n/g, '\n');
  const m = text.match(FM);
  if (!m) return { fm: {}, body: text };
  const fm: Fm = {};
  let list: string[] | null = null;
  for (const line of m[1].split('\n')) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && list) { list.push(unquote(item[1])); continue; }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    if (v === '') { list = []; fm[kv[1]] = list; continue; } // block list follows (or empty value)
    list = null;
    fm[kv[1]] = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean) : unquote(v);
  }
  for (const [k, v] of Object.entries(fm)) if (Array.isArray(v) && !v.length && !/uuids|tags/.test(k)) fm[k] = '';
  return { fm, body: text.slice(m[0].length) };
}
const unquote = (s: string) => (/^".*"$/.test(s) ? JSON.parse(s) : /^'.*'$/.test(s) ? s.slice(1, -1) : s);
const scalar = (v: string) => (/^[\w./:+@-][^#]*$/.test(v) && !/:\s|\s$/.test(v) ? v : JSON.stringify(v));

export function renderNote(fm: Fm, body: string): string {
  const lines = Object.entries(fm).map(([k, v]) =>
    Array.isArray(v) ? (v.length ? `${k}:\n${v.map((x) => `  - ${scalar(x)}`).join('\n')}` : `${k}: []`) : `${k}: ${v === '' ? '' : scalar(String(v))}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

export const fmStr = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(',') : v ?? '');
export const fmList = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

/** Body edited by ลุงจืด (or never machine-written)? */
export const isEdited = (fm: Fm, body: string) => !fm.body_sha || fm.body_sha !== sha(body);

export type WriteResult = 'written' | 'unchanged' | 'kept-user-edit';

/**
 * Create or update a machine note. `body` undefined = metadata-only update (keeps the existing body).
 * Existing keys not in `meta` are preserved; an edited file is never touched.
 */
export function writeNote(rel: string, meta: Fm, body?: string): WriteResult {
  const path = join(MEMORY_VAULT, rel);
  let fm: Fm = {}, cur: string | undefined;
  if (existsSync(path)) {
    const old = parseNote(readFileSync(path, 'utf8'));
    if (isEdited(old.fm, old.body)) return 'kept-user-edit';
    fm = old.fm;
    cur = old.body;
  }
  const nextBody = body ?? cur ?? '';
  const next = renderNote({ ...fm, ...meta, body_sha: sha(nextBody) }, nextBody);
  if (cur !== undefined && existsSync(path) && readFileSync(path, 'utf8').replace(/\r\n/g, '\n') === next) return 'unchanged';
  beforeMachineWrite(MEMORY_VAULT, rel); // git history: ลุงจืด's pending edits get their own commit before the batch's first write
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, next);
  renameSync(tmp, path); // atomic: Obsidian never sees a half-written note
  return 'written';
}

export const projectSlug = (project?: string | null) => (project ? fileName(project.split('/').filter(Boolean).at(-1) ?? project, 40) : '_global');

/** memory_save: ลุงจืด asked to remember → a user-owned fact note (redacted), indexed in the background. */
export function saveNote(content: string, opts: { title?: string; project?: string; kind?: string; global?: boolean; client?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const text = clean(content).trim();
  const fid = 'F' + md5(text).slice(0, 8);
  const scope = opts.global || !opts.project ? 'global' : 'project';
  const rel = `facts/${scope === 'global' ? '_global' : projectSlug(opts.project)}/${fid} ${fileName(opts.title || text.split('\n')[0], 40)}.md`;
  const path = join(MEMORY_VAULT, rel);
  const body = `${text}\n`;
  try {
    writeNote(rel, {
      memhub: 'fact', id: fid, kind: opts.kind ?? 'fact', scope, project: scope === 'global' ? '' : opts.project ?? '',
      status: 'active', owner: 'user', importance: '8', valid_at: now.toISOString(), created_at: now.toISOString(),
      source_uuids: [noteUuid(path)], tags: ['memhub/saved'], md5: md5(text), ...(opts.client ? { client: opts.client } : {}),
    }, body);
  } finally { // a failed write (EPERM on a locked note) must still close the batch, or this process never snapshots again
    commitBatch(MEMORY_VAULT, `memory_save (${opts.client ?? 'unknown'}): ${rel}`);
  }
  reindexSoon();
  return rel;
}

/** Index the memory vault in a detached rw process (the MCP server only holds the read-only role). */
export function reindexSoon() {
  if (process.env.MEMHUB_NO_REINDEX) return; // tests index synchronously
  spawn(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'index-vault', MEMORY_VAULT], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, MEMORY_HUB_INTERNAL: '1' },
  }).unref();
}
