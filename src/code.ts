// Source code of ลุงจืด's GitHub repos (his own + smlsoft, no forks) for code_search, kept apart from the memory itself:
// own tables, so no dream / brain / daily / memory_search noise. Shallow bare clones in <archive>/code/<owner>/<repo>.git,
// fetched again only when GitHub's pushed_at moves; gh's token goes through git's credential helper and is never stored.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { ARCHIVE_ROOT, clean } from './importer.ts';
import { queryTerms, toTsvector, words } from './thai.ts';

export const CODE_DIR = process.env.MEMHUB_CODE_DIR ?? join(ARCHIVE_ROOT, 'code');
const OWNERS = (process.env.MEMHUB_CODE_OWNERS ?? 'jaturapornchai,smlsoft').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const AUTH = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
const PARALLEL = 6;

export type Repo = { full: string; branch: string; pushed: string };
type State = Record<string, { pushed: string; branch: string; error?: string }>;
const statePath = () => join(CODE_DIR, '_state.json');
const readState = (): State => (existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), 'utf8')) : {});
export const repoDir = (full: string) => join(CODE_DIR, ...full.toLowerCase().split('/')) + '.git';

// ---- what gets indexed: hand-written text only ----
const JUNK_DIR = /(^|\/)(node_modules|vendor|dist|build|out|\.next|\.nuxt|\.dart_tool|\.gradle|\.idea|\.vs|Pods|coverage|__pycache__|target|bin|obj|packages|bower_components|\.git|site-packages|python\d[\d.]*|venv|\.venv|virtualenv)\//i;
const JUNK_FILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|go\.sum|pubspec\.lock|Podfile\.lock|composer\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock)$|\.(min\.(js|css)|map|g\.dart|freezed\.dart|pb\.go|designer\.cs)$/i;
// secrets never enter the index even when someone committed one (redact() still runs on everything kept)
const SECRET_FILE = /(^|\/)(\.env(\.[^/]*)?|id_[rd]sa[^/]*|credentials[^/]*\.json|[^/]*\.(pem|key|p12|pfx|jks|keystore))$/i;
const BINARY = /\.(png|jpe?g|gif|bmp|ico|webp|svg|tiff?|psd|ai|pdf|docx?|xlsx?|pptx?|zip|7z|rar|gz|tgz|bz2|xz|jar|war|apk|aab|ipa|exe|dll|so|dylib|a|lib|o|obj|pdb|class|pyc|wasm|bin|dat|db|sqlite3?|mdb|ttf|otf|woff2?|eot|mp[34]|m4a|wav|ogg|mov|avi|mkv|webm|flac|ds_store|lockb|cache|resx|nupkg|snk|dfm|res|frx|crx)$/i;
export const MAX_BYTES = 256 * 1024;
/** One ls-tree entry worth indexing: a regular file (not a submodule/symlink), small, not generated, not binary, not a secret file. */
export const keepPath = (path: string, size: number, mode: string) =>
  (mode === '100644' || mode === '100755') && size > 0 && size <= MAX_BYTES &&
  !JUNK_DIR.test(path) && !JUNK_FILE.test(path) && !SECRET_FILE.test(path) && !BINARY.test(path);

/** Repos to mirror: owner in OWNERS, not a fork, not empty (GitHub size 0). */
export function listRepos(): Repo[] {
  const r = spawnSync('gh', ['api', '--paginate', 'user/repos?affiliation=owner,collaborator,organization_member&per_page=100',
    '--jq', '.[] | [.full_name, .default_branch, .pushed_at, .fork, .size] | @tsv'], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  if (r.status !== 0) throw new Error(`gh api user/repos: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('\t'))
    .filter(([full, , , fork, size]) => OWNERS.includes(full.split('/')[0].toLowerCase()) && fork === 'false' && Number(size) > 0)
    .map(([full, branch, pushed]) => ({ full, branch, pushed }));
}

function git(args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn('git', args, { env: ENV, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', fail);
    p.on('close', (c) => (c === 0 ? ok() : fail(new Error(err.trim().split('\n').pop() || `git exit ${c}`))));
  });
}

/** Clone new repos, re-fetch the ones GitHub says were pushed since; one failure never stops the rest. */
export async function syncRepos(log = (s: string) => console.log(s)): Promise<Record<string, number>> {
  mkdirSync(CODE_DIR, { recursive: true });
  const state = readState(), stats = { cloned: 0, fetched: 0, unchanged: 0, failed: 0 };
  const repos = listRepos();
  let i = 0;
  const one = async (r: Repo) => {
    const dir = repoDir(r.full), old = state[r.full], t0 = Date.now();
    if (existsSync(join(dir, 'HEAD')) && old && !old.error && old.pushed === r.pushed && old.branch === r.branch) { stats.unchanged++; return; }
    const ref = `+refs/heads/${r.branch}:refs/heads/${r.branch}`;
    try {
      if (!existsSync(join(dir, 'HEAD'))) {
        mkdirSync(dir, { recursive: true });
        await git([...AUTH, 'clone', '--bare', '--depth', '1', '--single-branch', '--no-tags', '--branch', r.branch, `https://github.com/${r.full}.git`, dir]);
        stats.cloned++;
      } else {
        await git([...AUTH, '-C', dir, 'fetch', '--depth', '1', '--no-tags', '--prune', 'origin', ref]);
        await git(['-C', dir, 'symbolic-ref', 'HEAD', `refs/heads/${r.branch}`]); // default branch renamed on GitHub
        stats.fetched++;
      }
      state[r.full] = { pushed: r.pushed, branch: r.branch };
      log(`${++i}/${repos.length} ${r.full} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      stats.failed++;
      state[r.full] = { pushed: r.pushed, branch: r.branch, error: (e as Error).message }; // retried next run
      log(`${++i}/${repos.length} ${r.full} FAILED ${(e as Error).message}`);
    }
  };
  let next = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => { while (next < repos.length) await one(repos[next++]); }));
  writeFileSync(statePath(), JSON.stringify(state, null, 1));
  return stats;
}

// ---- index: bare clones → code_files / code_chunks ----
const CHUNK_LINES = 60, CHUNK_CHARS = 4000, BATCH = 2000;
const utf8 = new TextDecoder('utf-8', { fatal: true }), thai = new TextDecoder('windows-874'); // old Thai C#/VB files are TIS-620

/** Text of a blob, or null for binary (has a NUL); not UTF-8 → Windows-874. */
export function blobText(b: Buffer): string | null {
  if (b.includes(0)) return null;
  try { return utf8.decode(b); } catch { return thai.decode(b); }
}

/** ≤60 lines / ≤4000 chars per chunk (a longer line is cut); blank chunks dropped. */
export function chunkCode(text: string): { line0: number; text: string }[] {
  const out: { line0: number; text: string }[] = [];
  let buf: string[] = [], len = 0, start = 1;
  const flush = () => { const t = buf.join('\n'); if (t.trim()) out.push({ line0: start, text: t }); };
  text.replace(/\r?\n$/, '').split(/\r?\n/).forEach((raw, i) => { // a final newline ends the last line, it is not one more
    const l = raw.slice(0, CHUNK_CHARS);
    if (buf.length && (buf.length >= CHUNK_LINES || len + l.length > CHUNK_CHARS)) { flush(); buf = []; len = 0; start = i + 1; }
    buf.push(l); len += l.length + 1;
  });
  flush();
  return out;
}

/** path → blob sha of every kept file at HEAD. */
function tree(dir: string): Map<string, string> {
  const r = spawnSync('git', ['-C', dir, 'ls-tree', '-r', '-l', '-z', 'HEAD'], { encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
  if (r.status !== 0) throw new Error(`ls-tree ${dir}: ${r.stderr.trim()}`);
  const m = new Map<string, string>();
  for (const e of r.stdout.split('\0')) {
    const tab = e.indexOf('\t');
    if (tab < 0) continue;
    const [mode, , sha, size] = e.slice(0, tab).split(/\s+/), path = e.slice(tab + 1);
    if (keepPath(path, Number(size), mode)) m.set(path, sha);
  }
  return m;
}

/** Blob contents by sha in one `git cat-file --batch` call. */
function readBlobs(dir: string, shas: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!shas.length) return out;
  const r = spawnSync('git', ['-C', dir, 'cat-file', '--batch'], { input: shas.join('\n') + '\n', maxBuffer: 1 << 30, windowsHide: true });
  if (r.status !== 0) throw new Error(`cat-file ${dir}: ${r.stderr.toString().trim()}`);
  const b = r.stdout;
  for (let at = 0; at < b.length;) {
    const nl = b.indexOf(10, at), [sha, type, size] = b.toString('latin1', at, nl).split(' ');
    if (type === 'missing') { at = nl + 1; continue; }
    out.set(sha, b.subarray(nl + 1, nl + 1 + Number(size)));
    at = nl + 1 + Number(size) + 1;
  }
  return out;
}

/** Every cloned repo → index; only paths whose blob changed are read. Gone paths and unreferenced blobs are removed.
 *  ponytail: repos dropped from GitHub (or from MEMHUB_CODE_OWNERS) stay indexed; delete their rows by hand if it matters. */
export async function indexCode(db: pg.Pool, log = (s: string) => console.log(s)) {
  const stats = { repos: 0, files: 0, gone: 0, blobs: 0, chunks: 0 };
  for (const full of Object.keys(readState())) {
    const dir = repoDir(full);
    if (!existsSync(join(dir, 'HEAD'))) continue;
    const now = tree(dir);
    const old = new Map<string, string>((await db.query('SELECT path, blob FROM code_files WHERE repo = $1', [full])).rows.map((r) => [r.path, r.blob]));
    const changed = [...now].filter(([p, b]) => old.get(p) !== b), gone = [...old.keys()].filter((p) => !now.has(p));
    if (!changed.length && !gone.length) continue;
    const want = [...new Set(changed.map(([, b]) => b))];
    const have = new Set<string>((await db.query('SELECT DISTINCT blob FROM code_chunks WHERE blob = ANY($1)', [want])).rows.map((r) => r.blob));
    const rows: [string, number, string, string][] = [];
    for (const [sha, buf] of readBlobs(dir, want.filter((b) => !have.has(b)))) {
      const text = blobText(buf);
      if (text === null) continue;
      for (const c of chunkCode(clean(text))) rows.push([sha, c.line0, c.text, toTsvector(words(c.text))]);
      stats.blobs++;
    }
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      for (let i = 0; i < rows.length; i += BATCH) {
        const part = rows.slice(i, i + BATCH);
        await c.query(`INSERT INTO code_chunks (blob, line0, text, words) SELECT b, l, t, w::tsvector FROM unnest($1::text[], $2::int[], $3::text[], $4::text[]) v(b, l, t, w)
          ON CONFLICT DO NOTHING`, [part.map((r) => r[0]), part.map((r) => r[1]), part.map((r) => r[2]), part.map((r) => r[3])]);
      }
      await c.query(`INSERT INTO code_files (repo, path, blob) SELECT $1, p, b FROM unnest($2::text[], $3::text[]) v(p, b)
        ON CONFLICT (repo, path) DO UPDATE SET blob = EXCLUDED.blob`, [full, changed.map(([p]) => p), changed.map(([, b]) => b)]);
      await c.query('DELETE FROM code_files WHERE repo = $1 AND path = ANY($2)', [full, gone]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    stats.repos++; stats.files += changed.length; stats.gone += gone.length; stats.chunks += rows.length;
    log(`code index ${full}: ${changed.length} files, ${gone.length} gone, ${rows.length} chunks`);
  }
  if (stats.repos) await db.query('DELETE FROM code_chunks c WHERE NOT EXISTS (SELECT 1 FROM code_files f WHERE f.blob = c.blob)');
  return stats;
}

// ---- search ----
export type CodeHit = { line0: number; text: string; files: { repo: string; path: string }[] };
const like = (s?: string) => (s ? `%${s.replace(/[\\%_]/g, (m) => '\\' + m)}%` : '%');

/** Every query word must appear in the chunk; none does → any word. repo / path = substring filters. */
export async function codeSearch(db: pg.Pool, q: string, o: { repo?: string; path?: string; limit?: number } = {}): Promise<CodeHit[]> {
  const terms = queryTerms(q).map((t) => t.lit);
  if (!terms.length) return [];
  const repo = o.repo ? like(o.repo) : null, path = o.path ? like(o.path) : null;
  const filtered = Boolean(repo || path);
  const args = (op: string) => (filtered ? [terms.join(op), repo, path, o.limit ?? 10] : [terms.join(op), o.limit ?? 10]);
  const sql = filtered
    ? `SELECT c.blob, c.line0, c.text FROM code_chunks c
       WHERE c.words @@ $1::tsquery AND c.blob IN (SELECT f.blob FROM code_files f WHERE ($2::text IS NULL OR f.repo ILIKE $2) AND ($3::text IS NULL OR f.path ILIKE $3))
       ORDER BY ts_rank(c.words, $1::tsquery) DESC, c.blob, c.line0 LIMIT $4`
    : `SELECT c.blob, c.line0, c.text FROM code_chunks c
       WHERE c.words @@ $1::tsquery AND EXISTS (SELECT 1 FROM code_files f WHERE f.blob = c.blob)
       ORDER BY ts_rank(c.words, $1::tsquery) DESC, c.blob, c.line0 LIMIT $2`;
  let rows = (await db.query(sql, args(' & '))).rows;
  if (!rows.length && terms.length > 1) rows = (await db.query(sql, args(' | '))).rows;
  if (!rows.length) return [];
  const files = (await db.query('SELECT blob, repo, path FROM code_files WHERE blob = ANY($1) AND ($2::text IS NULL OR repo ILIKE $2) AND ($3::text IS NULL OR path ILIKE $3) ORDER BY repo, path',
    [rows.map((r) => r.blob), repo, path])).rows;
  return rows.map((r) => ({ line0: r.line0, text: r.text, files: files.filter((f) => f.blob === r.blob).map(({ repo, path }) => ({ repo, path })) }))
    .filter((h) => h.files.length); // the hourly index replaced that file between the two queries
}

/** Hit as text: first file's GitHub link, other copies counted, ≤12 lines around the line holding the most query words
 *  (vaultSafe = vaultsafe + vault + safe: its own line, not the first line that only says "vault"); earliest on a tie. */
export function codeHitText(h: CodeHit, q: string): string {
  const keys = queryTerms(q).map((t) => t.key), lines = h.text.split('\n');
  const score = lines.map((l) => { const ws = words(l); return keys.filter((k) => ws.some((w) => w.startsWith(k))).length; });
  const at = score.indexOf(Math.max(...score));
  const from = Math.max(0, at - 4), to = Math.min(lines.length, from + 12);
  const [f, ...more] = h.files, a = h.line0 + from, b = h.line0 + to - 1;
  const url = `https://github.com/${f.repo}/blob/HEAD/${f.path.split('/').map(encodeURIComponent).join('/')}#L${a}-L${b}`;
  const also = more.length ? ` (+${more.length} copies: ${more.slice(0, 3).map((m) => `${m.repo}/${m.path}`).join(', ')}${more.length > 3 ? ', …' : ''})` : '';
  return `${f.repo}/${f.path}:${a}-${b}${also}\n${url}\n` + lines.slice(from, to).map((l, i) => `${String(a + i).padStart(5)}| ${l.slice(0, 200)}`).join('\n');
}
