// Claude Code's own per-project memory (~/.claude/projects/<slug>/memory/*.md; MEMORY.md = its index) is read by Claude only:
// each file becomes a fact of that project in the memory vault, so every app sees it (ลุงจืด 2026-10-18). sync runs it hourly;
// state cmem:<slug>/<file> = {sha, fid, rel} | {sha, dup}: an unchanged file is skipped, a changed one supersedes its old note.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { nearFacts } from './accuracy.ts';
import { clean, LIVE_DIR, normProject } from './importer.ts';
import { md5, MEMORY_VAULT, noteFid, saveNote, writeNote } from './notes.ts';
import { commitBatch } from './vault-git.ts';

const KIND: Record<string, string> = { feedback: 'feedback', user: 'preference', project: 'fact', reference: 'fact' };

/** A memory file → title (its name), kind (its metadata type), global (type user = about him), text (the body), modified (when Claude wrote it). */
export function parseMemory(src: string) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) return null;
  const get = (k: string) => new RegExp(`^\\s*${k}:\\s*"?(.*?)"?\\s*$`, 'm').exec(m[1])?.[1] ?? '';
  const type = get('type'), text = m[2].trim() || get('description');
  return text ? { title: get('name'), kind: KIND[type] ?? 'fact', global: type === 'user', text, modified: get('modified') } : null;
}

/** When Claude wrote a memory file (its metadata modified, else the file mtime), not the import run: an old memory imported
 *  today must not look newer than his later words. */
export function writtenAt(m: { modified: string }, path: string) {
  const t = Date.parse(m.modified);
  return new Date(Number.isFinite(t) ? t : statSync(path).mtimeMs);
}

/** Claude's folder name for a cwd ("d--code-myapp" = D:/code/myapp or D:/code-myapp): the one on disk, else null. */
function slugDir(slug: string): string | null {
  const m = /^([a-z])--(.+)$/i.exec(slug);
  const walk = (base: string, rest: string[]): string | null => {
    if (!rest.length) return base;
    for (let i = 1; i <= rest.length; i++) {
      const p = join(base, rest.slice(0, i).join('-'));
      if (existsSync(p)) { const r = walk(p, rest.slice(i)); if (r) return r; }
    }
    return null;
  };
  return m ? walk(`${m[1]}:/`, m[2].split('-')) : null;
}

/** dry = only report what would be saved / skipped as a duplicate of an existing fact (cosine ≥ 0.92 or nearFacts' word rule). */
export async function importClaudeMemory(db: pg.Pool, o: { dir?: string; dry?: boolean } = {}) {
  const dir = o.dir ?? LIVE_DIR, out = { saved: [] as string[], dup: [] as string[], unmapped: [] as string[], gone: 0 };
  const state = new Map((await db.query(`SELECT k, v FROM state WHERE k LIKE 'cmem:%'`)).rows.map((r) => [r.k as string, r.v]));
  for (const slug of existsSync(dir) ? readdirSync(dir) : []) {
    const mdir = join(dir, slug, 'memory');
    const files = existsSync(mdir) ? readdirSync(mdir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md') : [];
    if (!files.length) continue;
    // the project its chats were indexed under (moved folders, worktrees already resolved there); none yet = next sync
    const project = (await db.query(`SELECT project FROM sources WHERE tool = 'claude' AND coalesce(project, '') <> ''
      AND strpos(lower(replace(path, '\\', '/')), lower($1)) > 0 GROUP BY project ORDER BY count(*) DESC LIMIT 1`, [`/projects/${slug}/`])).rows[0]?.project;
    const p = project ?? (slugDir(slug) ? normProject(slugDir(slug)!) : ''); // chats never archived (old projects): the folder itself
    if (!p) { out.unmapped.push(slug); continue; }
    for (const f of files) {
      const k = `cmem:${slug}/${f}`, src = readFileSync(join(mdir, f), 'utf8'), sha = md5(src), old = state.get(k);
      const m = old?.sha === sha ? null : parseMemory(src);
      if (!m) continue;
      const now = writtenAt(m, join(mdir, f));
      const fid = noteFid(m.text), prev = old?.rel && old.fid !== fid ? old.rel : '';
      const dup = prev ? null : (await nearFacts(db, clean(m.text).trim(), m.global ? '' : p, [], [fid], { min: 0.92, n: 1 }))[0];
      (dup ? out.dup : out.saved).push(`${slug}/${f}${dup ? ` ≈ [${dup.fid}] ${dup.sim?.toFixed(2) ?? 'words'}` : ''}`);
      if (o.dry) continue;
      const v = dup ? { sha, dup: dup.fid } : { sha, fid, rel: saveNote(m.text, { title: m.title, kind: m.kind, global: m.global, project: p, client: 'claude-memory', now,
        supersede: prev ? [prev] : [], extra: { tags: ['memhub/claude-memory'], claude_memory: `${slug}/${f}` }, reindex: false, commit: false }) };
      await db.query(`INSERT INTO state (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [k, v]);
    }
  }
  for (const [k, v] of o.dry ? [] : state) { // a deleted memory file: its note is superseded (kept as history), the state row goes
    if (existsSync(join(dir, ...k.slice(5).split('/').flatMap((p, i) => (i ? ['memory', p] : [p]))))) continue;
    if (v.rel && existsSync(join(MEMORY_VAULT, v.rel))) { const now = new Date().toISOString(); writeNote(v.rel, { status: 'superseded', expired_at: now, invalid_at: now }); }
    await db.query(`DELETE FROM state WHERE k = $1`, [k]);
    out.gone++;
  }
  if (!o.dry) commitBatch(MEMORY_VAULT, 'claude-memory import');
  return out;
}
