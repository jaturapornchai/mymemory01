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

// The vault's git runs ลุงจืด's global secret-scan hook (~/.githooks/secret-scan.pl): a public IP, a real email or a URI with a
// password in a note blocks its commit for good. So machine notes (body, frontmatter, file name) mask exactly those shapes, with
// the hook's own allow lists; the session archive keeps the originals (memory_search still finds them in the chats).
const IP = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;
const OK_IP = /^(?:0|10|127|2(?:2[4-9]|[3-5]\d))\.|^(?:169\.254|192\.168|192\.0\.2|198\.51\.100|203\.0\.113)\.|^172\.(?:1[6-9]|2\d|3[01])\.|^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^(?:1\.1\.1\.1|1\.0\.0\.1|8\.8\.8\.8|8\.8\.4\.4|9\.9\.9\.9)$|(?:^|\.)(?:25[6-9]|2[6-9]\d|[3-9]\d\d)(?:\.|$)/;
const EMAIL = /\b[A-Za-z0-9._%+-]+(@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;
const OK_EMAIL = /^(?:no-?reply|git)@|@(?:[\w.-]+\.)?(?:example\.(?:com|org|net)|users\.noreply\.github\.com)$|\.(?:example|test|invalid|localhost|local|png|jpe?g|gif|svg|webp|ico|js|mjs|ts|tsx|css|json|md|html?)$|^(?:x{6,}|your|example|changeme|placeholder|dummy|fake|sample|test|redacted)/i;
const URI_PW = /\b((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|rediss?|amqps?|mssql|sqlserver|clickhouse|ftp|smtps?):\/\/[^/\s:@'"`]+):[^@\s'"`/]{3,}@/gi;
/** Public IP → x.x.x.x, email → ***@its-domain, URI password (even a redacted one) dropped. */
export const vaultSafe = (s: string) => s.replace(URI_PW, '$1@')
  .replace(EMAIL, (e, at) => (OK_EMAIL.test(e) ? e : `***${at}`))
  .replace(IP, (ip) => (OK_IP.test(ip) ? ip : 'x.x.x.x'));

/** Obsidian-safe file name (Thai kept); trailing .md stripped so adding .md never makes .md.md. */
export const fileName = (s: string, max = 80) =>
  cutAtWord(vaultSafe(s).replace(/[\\/:*?"<>|#^[\]\x00-\x1f`]+/g, ' ').replace(/\s+/g, ' ').trim(), max).replace(/(?:\.md)+$/i, '').trim() || 'untitled';

/** Truncate on a word boundary (Thai-aware) so names/IPs/numbers are never cut into a different-looking value. */
export function cutAtWord(s: string, max: number) {
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
/** ลุงจืด's note, read from the file (an edit not indexed yet counts): edited, pinned, not dream-written, rule/feedback, owner user. */
export const isHis = (fm: Fm, body: string) =>
  isEdited(fm, body) || fmStr(fm.pinned) === 'true' || !fmStr(fm.run) || ['rule', 'feedback'].includes(fmStr(fm.kind)) || fmStr(fm.owner) === 'user';

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
  // CRLF text (a Windows-written Claude memory file): parseNote reads \n only, so a \r kept here = body_sha never matches = "his edit"
  const nextBody = vaultSafe((body ?? cur ?? '').replace(/\r\n/g, '\n'));
  const safeFm = Object.fromEntries(Object.entries({ ...fm, ...meta }).map(([k, v]) => [k, Array.isArray(v) ? v.map(vaultSafe) : vaultSafe(v)]));
  const next = renderNote({ ...safeFm, body_sha: sha(nextBody) }, nextBody);
  if (cur !== undefined && existsSync(path) && readFileSync(path, 'utf8').replace(/\r\n/g, '\n') === next) return 'unchanged';
  beforeMachineWrite(MEMORY_VAULT, rel); // git history: ลุงจืด's pending edits get their own commit before the batch's first write
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, next);
  renameSync(tmp, path); // atomic: Obsidian never sees a half-written note
  return 'written';
}

export const projectSlug = (project?: string | null) => (project ? fileName(project.split('/').filter(Boolean).at(-1) ?? project, 40) : '_global');

/** Keywords indicating a fact/rule/preference is cross-project or personal to ลุงจืด → defaults to scope: global when opts.global is omitted. */
export const STRONG_GLOBAL_HINT = /(?:ทุกโปรเจกต์|ทุก\s*(?:project|repo|เครื่อง|ระบบ)|ทุก\s*AI(?:\s*ในเครื่อง|\s*ทุก\s*model)?|ทั้งเครื่อง|ทั้ง\s*Antigravity|ในโปรเจกต์ที่กำลังทำอยู่|ตอบทุกอย่าง|กฎกลาง|\bIRON\s*(?:RULE)?\s*\d+\b|all\s+projects|every\s+project|global\s+rule|ข้ามโปรเจกต์|\.agents[\\/]AGENTS\.md|google\s+timeline|ประวัติการเดินทาง|ข้อมูลส่วนตัวลุงจืด|(?:บ้าน|เบอร์โทร|อีเมล)ลุงจืด|ลุงจืดชอบ(?:กาแฟ|กิน|เที่ยว|ดื่ม|ให้สรุปท้ายงาน))/i;
const PROJECT_SCOPED_HINT = /(?:โปรเจ[กค]ต์\s+[\w.-]+|(?:^|[\s(`])[d-z]:[\\/][a-z0-9_-]{3,})/i;
export const GLOBAL_HINT = STRONG_GLOBAL_HINT;
export const isGlobalFact = (text: string, title = '') => {
  const s = `${title}\n${text}`;
  if (STRONG_GLOBAL_HINT.test(s)) return true;
  return /กฎเหล็ก/.test(s) && !PROJECT_SCOPED_HINT.test(s);
};

/** memory_save: ลุงจืด asked to remember → a user-owned fact note (redacted), indexed in the background. replaces (mcp.ts):
 *  supersede = AI-owned notes it corrects, made OLD at once as the dream does; review = fid of his own note it would replace →
 *  this note is saved pending with review_target (hubs/_review.md: he sets it active = accept, consolidate applies it).
 *  A pending note supersedes nothing yet (else neither would be current); the same text already active stays active. */
export function saveNote(content: string, opts: { title?: string; project?: string; relatedProjects?: string[]; kind?: string; global?: boolean; client?: string; now?: Date;
  supersede?: string[]; review?: string; activate?: boolean; extra?: Fm; reindex?: boolean; commit?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const text = clean(content).trim();
  const fid = noteFid(content);
  // no project (an app that sent no cwd, 2026-10-18): global even when global:false, never `scope: project` with no project
  const scope = (!opts.project || (opts.global ?? isGlobalFact(text, opts.title))) ? 'global' : 'project';
  // the title is redacted like the text: it becomes the file name, the vault commit message and every search citation
  const rel = `facts/${scope === 'global' ? '_global' : projectSlug(opts.project)}/${fid} ${fileName(opts.title ? clean(opts.title) : text.split('\n')[0], 40)}.md`;
  const path = join(MEMORY_VAULT, rel);
  // the same text again keeps what the note already has: its status (a pending note stays pending until he approves it),
  // kind, importance and dates (a rule re-saved without kind stays a rule)
  const old = existsSync(path) ? parseNote(readFileSync(path, 'utf8')).fm : undefined;
  // activate (memory_save user_quote: he typed the correction himself) = active now, even over its own pending copy
  const status = opts.activate ? 'active' : old ? fmStr(old.status) || 'active' : opts.review ? 'pending' : 'active';
  const review = old || opts.activate ? '' : opts.review ?? '';
  const sup = status === 'active' ? opts.supersede ?? [] : [];
  // the dream's "- supersedes:: [[old]]" (link edges / synapses); fid and md5 come from the text alone
  const body = `${text}\n${sup.length ? `\n${sup.map((r) => `- supersedes:: [[${basename(r, '.md')}]]`).join('\n')}\n` : ''}`;
  try {
    writeNote(rel, {
      memhub: 'fact', id: fid, kind: opts.kind ?? (fmStr(old?.kind) || 'fact'), scope, project: scope === 'global' ? '' : opts.project ?? '',
      ...(scope !== 'global' && opts.relatedProjects?.length ? { related_projects: opts.relatedProjects } : {}),
      ...(old && !opts.activate ? {} : { status, review_target: review }),
      owner: 'user', importance: fmStr(old?.importance) || '8', valid_at: fmStr(old?.valid_at) || now.toISOString(), created_at: fmStr(old?.created_at) || now.toISOString(),
      source_uuids: [noteUuid(path)], tags: ['memhub/saved'], md5: md5(text), ...(opts.client ? { client: opts.client } : {}), ...opts.extra,
    }, body);
    for (const r of sup) // ponytail: an edit by him in the ms since mcp.ts checked it = writeNote keeps it
      writeNote(r, { status: 'superseded', superseded_by: fid, expired_at: now.toISOString(), invalid_at: now.toISOString() });
  } finally { // a failed write (EPERM on a locked note) must still close the batch, or this process never snapshots again
    if (opts.commit !== false) commitBatch(MEMORY_VAULT, `memory_save (${opts.client ?? 'unknown'}): ${rel}`);
  }
  if (opts.reindex !== false) reindexSoon(); // false: the caller indexes and waits (a search right after must see it)
  return rel;
}

/** fid saveNote gives this content (same text = same note). */
export const noteFid = (content: string) => 'F' + md5(clean(content).trim()).slice(0, 8);

/** Index the memory vault in a detached rw process (the MCP server only holds the read-only role). */
export function reindexSoon() {
  if (process.env.MEMHUB_NO_REINDEX) return; // tests index synchronously
  spawn(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'index-vault', MEMORY_VAULT], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, MEMORY_HUB_INTERNAL: '1' },
  }).unref();
}
