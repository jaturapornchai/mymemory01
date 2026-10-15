// GitHub (read-only REST through the gh CLI, so the token never leaves gh): every repo ลุงจืด can reach → a repo card
// (+ README head), the commits he authored, and the issues/PRs he is involved in or that live in his own repos.
// sync() exports them into <archive>/<owner>/<repo>/ (append-only; a rewritten file keeps its old copy as .bak);
// parse() turns each archived file into one kind 'doc' session: searchable, never dreamed.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Msg, Role } from '../claude.ts';
import { syncFile, type Parsed, type SyncResult } from '../importer.ts';

export const tool = 'github';
const MAX_TEXT = 20000, MAX_README = 4000;
const RESERVE = 500; // core API calls always left for ลุงจืด's own gh use
const COMMIT_OVERLAP = 7 * 86_400_000; // ponytail: commits older than (newest archived − 7 days) that land later are missed; widen if seen
const ISSUE_OVERLAP = 3_600_000;       // search index lag

class Stop extends Error {} // rate limit / offline / gh missing: end this run, keep what is written, retry next hour
type Ctx = { fake: Record<string, unknown> | null; core: number; search: number; calls: number };

const json = (t: string) => { try { return JSON.parse(t); } catch { return null; } };
const readJson = (f: string) => (existsSync(f) ? json(readFileSync(f, 'utf8')) : null);
const sec = (t: number) => new Date(t).toISOString().slice(0, 19) + 'Z';

/**
 * `gh api -i <path>` → parsed JSON (null = no access / gone / empty repo) + the call's own rate-limit headers, which are
 * the truth: on 2026-10-02 /rate_limit still said 5000 left while the calls' headers said 4201.
 */
function run(path: string): { data: any; left?: number; resource?: string } {
  const r = spawnSync('gh', ['api', '-i', path], { encoding: 'utf8', maxBuffer: 1 << 29, timeout: 120_000, windowsHide: true });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ETIMEDOUT') throw new Error(`timeout: ${path}`); // one slow repo: that item fails, the run goes on
  if (r.error) throw new Stop(code === 'ENOENT' ? 'gh not installed' : r.error.message);
  const out = r.stdout || '', cut = out.search(/\r?\n\r?\n/);
  const head = cut < 0 ? out : out.slice(0, cut), body = cut < 0 ? '' : out.slice(cut);
  const left = /^x-ratelimit-remaining:\s*(\d+)/im.exec(head)?.[1];
  const meta = { left: left === undefined ? undefined : Number(left), resource: /^x-ratelimit-resource:\s*(\w+)/im.exec(head)?.[1] };
  if (r.status === 0) return { data: json(body), ...meta };
  const err = (r.stderr || '').trim().split('\n').at(-1)!.slice(0, 200);
  if (/rate limit|HTTP 429/i.test(err + body.slice(0, 300))) throw new Stop(`rate limited: ${err}`);
  if (/HTTP (403|404|409|410|422|451)\b/.test(err)) return { data: null, ...meta }; // SAML-blocked, deleted, empty repo, DMCA
  // a 5xx is that one item (GitHub times out on huge repos): fail it, retry next run — a Stop would block every repo after it, forever
  if (/HTTP 5\d\d\b/.test(err)) throw new Error(err);
  throw new Stop(err || `gh exit ${r.status}`); // offline / not logged in
}

function gh(c: Ctx, path: string): any {
  const search = path.startsWith('search/');
  if ((search ? c.search : c.core) <= 0) throw new Stop(search ? 'search rate limit' : `rate limit: ${RESERVE} calls kept in reserve`);
  if (search) c.search--; else c.core--;
  c.calls++;
  if (c.fake) { const v = c.fake[path]; if (typeof v === 'string' && /^HTTP 5/.test(v)) throw new Error(v); return v ?? null; }
  const r = run(path);
  if (r.left !== undefined && r.resource === 'core') c.core = r.left - RESERVE;
  if (r.left !== undefined && r.resource === 'search') c.search = r.left;
  return r.data;
}

function pages(c: Ctx, path: string, params: Record<string, string>): any[] {
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const r = gh(c, `${path}?${new URLSearchParams({ ...params, per_page: '100', page: String(page) })}`);
    if (!Array.isArray(r)) return out;
    out.push(...r);
    if (r.length < 100) return out;
  }
}

/** Issue search, ≤ 1000 results per query: a bigger result is split by created date until each part fits. */
function search(c: Ctx, q: string, out: Map<string, any>, from?: number, to?: number) {
  const qq = from === undefined ? q : `${q} created:${sec(from)}..${sec(to!)}`;
  for (let page = 1; page <= 10; page++) {
    const r = gh(c, `search/issues?${new URLSearchParams({ q: qq, sort: 'updated', order: 'asc', per_page: '100', page: String(page) })}`);
    if (!Array.isArray(r?.items)) return;
    if (page === 1 && r.total_count > 1000) {
      const a = from ?? Date.UTC(2008, 0, 1), b = to ?? Date.now(), mid = a + Math.floor((b - a) / 2000) * 1000;
      if (b - a > 2000) return search(c, q, out, a, mid), search(c, q, out, mid + 1000, b);
    }
    for (const it of r.items) out.set(`${it.repository_url}#${it.number}`, it);
    if (r.items.length < 100) return;
  }
}

/** owner/repo (lowercase) of a github.com remote URL (https, ssh, scp-style; credentials in the URL are ignored). */
export function remoteRepo(url: string): string | null {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com(?::\d+)?[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

function origin(dir: string): string | null {
  try {
    const remote = /\[remote "origin"\]([^[]*)/.exec(readFileSync(join(dir, '.git', 'config'), 'utf8'))?.[1];
    const url = remote && /^\s*url\s*=\s*(.+)$/m.exec(remote)?.[1];
    return url ? remoteRepo(url) : null;
  } catch { return null; } // no repo, or .git is a file (worktree/submodule)
}

/**
 * Project roots memory-hub already knows (sources table, read-only role), busiest first: two clones of one repo map to the
 * one with the most AI sessions, deterministically (DISTINCT order could flip and churn repo.json .baks). A child process: sync() is synchronous.
 */
function dbProjects(): string[] {
  const db = JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'db.ts')).href);
  const code = `const db = (await import(${db})).connect('ro');
try { console.log(JSON.stringify((await db.query("SELECT project FROM sources WHERE project <> '' GROUP BY 1 ORDER BY count(*) DESC, 1")).rows.map((r) => r.project))); }
finally { await db.end(); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  return json(r.stdout ?? '') ?? [];
}

/** owner/repo → local clone dir (normalized like normProject), from the origin remotes of known project roots + D:\*. */
function clones(): Record<string, string> {
  const env = process.env.MEMHUB_GITHUB_CLONES; // tests: comma-separated dirs instead of the DB + D:\ scan
  let dirs = env !== undefined ? env.split(',').map((s) => s.trim()).filter(Boolean) : dbProjects();
  if (env === undefined) {
    try { dirs = [...dirs, ...readdirSync('D:/', { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `D:/${e.name}`)]; } catch {}
    dirs = dirs.filter((d) => !/(?:^|[\\/])tmp(?:[\\/]|$)/i.test(d));
  }
  const map: Record<string, string> = {};
  for (const d of dirs) {
    const full = origin(d);
    if (full && !map[full]) map[full] = d.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }
  return map;
}

export function sync(archiveDir: string): Record<string, number | string> {
  const fakeFile = process.env.MEMHUB_GITHUB_FAKE; // tests: { "<api path>": response } instead of the network
  const fake = fakeFile ? JSON.parse(readFileSync(fakeFile, 'utf8')) : null;
  let rate;
  try { rate = fake ? fake.rate_limit : run('rate_limit').data; } catch (e) { return { skipped: (e as Error).message }; } // free; probes gh
  // an upper bound only (see run): every call's headers then correct the budget
  const c: Ctx = { fake, core: (rate?.resources?.core?.remaining ?? 0) - RESERVE, search: rate?.resources?.search?.remaining ?? 0, calls: 0 };
  if (c.core <= 0) return { skipped: `rate limit: ${c.core + RESERVE} calls left` };

  const stats: Record<string, number | string> = {};
  const inc = (k: string, n = 1) => { if (n) stats[k] = (Number(stats[k]) || 0) + n; };
  const tmp = mkdtempSync(join(tmpdir(), 'memhub-github-'));
  /** Write a JSON doc via temp + syncFile; identical content is left alone (mtime too, so the index skips it). */
  const put = (dst: string, data: unknown, keepOld = true): SyncResult => {
    const text = JSON.stringify(data, null, 2) + '\n';
    if (existsSync(dst) && readFileSync(dst, 'utf8') === text) return 'unchanged';
    writeFileSync(join(tmp, 'doc.json'), text);
    return syncFile(join(tmp, 'doc.json'), dst, keepOld);
  };
  const statePath = join(archiveDir, '_state.json');
  const state = readJson(statePath) ?? {};
  state.repos ??= {}; // owner/repo → pushed_at whose README + commits are archived

  try {
    const local = clones();
    put(join(archiveDir, '_local.json'), local, false);
    state.login ??= gh(c, 'user')?.login;
    if (typeof state.login !== 'string') throw new Stop('no login');
    const me: string = state.login;

    const repos = pages(c, 'user/repos', { affiliation: 'owner,collaborator,organization_member', sort: 'full_name' });
    inc('repos', repos.length);
    for (const r of repos) {
      if (typeof r?.full_name !== 'string') continue;
      const full = r.full_name.toLowerCase(), dir = join(archiveDir, ...full.split('/'));
      const pushed = state.repos[full] !== r.pushed_at; // the hourly no-change path: no per-repo calls at all
      try {
        let readme = readJson(join(dir, 'repo.json'))?.readme ?? null;
        if (pushed) {
          const rd = gh(c, `repos/${r.full_name}/readme`);
          readme = typeof rd?.content === 'string' ? Buffer.from(rd.content, 'base64').toString('utf8').slice(0, MAX_README) : null;
          inc('readmes', readme === null ? 0 : 1);
        }
        inc(put(join(dir, 'repo.json'), {
          full_name: r.full_name, description: r.description ?? null, language: r.language ?? null, topics: r.topics ?? [],
          private: !!r.private, fork: !!r.fork, archived: !!r.archived, created_at: r.created_at ?? null, pushed_at: r.pushed_at ?? null,
          default_branch: r.default_branch ?? null, html_url: r.html_url ?? null, local: local[full] ?? null, readme,
        }));
        if (pushed) {
          inc('commits', syncCommits(c, r.full_name, join(dir, 'commits.jsonl'), me));
          state.repos[full] = r.pushed_at ?? null;
          put(statePath, state, false); // now, not only in finally: a shutdown during the long first run (~13 min) keeps the repos done
        }
      } catch (e) {
        if (e instanceof Stop) throw e;
        inc('failed');
      }
    }

    // issues/PRs: involving him anywhere + everything in his own repos, updated since the last run
    const since: string | undefined = state.issuesSince;
    const items = new Map<string, any>();
    for (const q of [`involves:${me}`, `user:${me}`]) search(c, since ? `${q} updated:>=${since}` : q, items);
    let newest = since ? Date.parse(since) + ISSUE_OVERLAP : 0, failed = false;
    for (const it of items.values()) {
      const full = String(it.repository_url ?? '').split('/repos/')[1];
      if (!full || !Number.isInteger(it.number)) continue;
      const file = join(archiveDir, ...full.toLowerCase().split('/'), 'issues', `${it.number}.json`);
      if (readJson(file)?.updated_at === it.updated_at) { inc('unchanged'); newest = Math.max(newest, Date.parse(it.updated_at) || 0); continue; } // overlap window: no comment calls
      let comments: any[];
      try { comments = it.comments > 0 ? pages(c, `repos/${full}/issues/${it.number}/comments`, {}) : []; }
      catch (e) { if (e instanceof Stop) throw e; inc('failed'); failed = true; continue; }
      newest = Math.max(newest, Date.parse(it.updated_at) || 0);
      inc(it.pull_request ? 'prs' : 'issues');
      inc('comments', comments.length);
      inc(put(file, {
        repo: full, number: it.number, pr: !!it.pull_request, title: it.title ?? '',
        state: it.pull_request?.merged_at ? 'merged' : it.state, state_reason: it.state_reason ?? null, draft: !!it.draft,
        labels: (it.labels ?? []).map((l: any) => l?.name).filter(Boolean), author: it.user?.login ?? null, viewer: me,
        created_at: it.created_at, updated_at: it.updated_at, closed_at: it.closed_at ?? null, html_url: it.html_url ?? null,
        body: it.body ?? '',
        comments: comments.map((x) => ({ id: x.id, author: x.user?.login ?? null, created_at: x.created_at, updated_at: x.updated_at, body: x.body ?? '' })),
      }));
    }
    if (newest && !failed) state.issuesSince = sec(newest - ISSUE_OVERLAP); // a failed item keeps the cursor: retried next run
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    stats.stopped = e.message;
  } finally {
    put(statePath, state, false);
    rmSync(tmp, { recursive: true, force: true });
  }
  stats.calls = c.calls;
  return stats;
}

/** Append his new commits (date order) to commits.jsonl; returns how many. */
function syncCommits(c: Ctx, repo: string, file: string, me: string): number {
  const have = new Set<string>();
  let newest = 0;
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n')) {
    const o = line.trim() ? json(line) : null;
    if (typeof o?.sha !== 'string') continue;
    have.add(o.sha);
    newest = Math.max(newest, Date.parse(o.committed) || 0);
  }
  const since = newest ? { since: sec(newest - COMMIT_OVERLAP) } : {};
  // author=<login> skips his legacy <login>@users.noreply.github.com commits (web edits/merges): 56 of 3883 on 2026-10-02
  const fresh = [me, `${me}@users.noreply.github.com`].flatMap((author) => pages(c, `repos/${repo}/commits`, { author, ...since }))
    .filter((x) => typeof x?.sha === 'string' && !have.has(x.sha) && have.add(x.sha))
    .map((x) => ({ sha: x.sha as string, date: x.commit?.author?.date ?? null, committed: x.commit?.committer?.date ?? null, message: String(x.commit?.message ?? '') }))
    .sort((a, b) => String(a.committed).localeCompare(String(b.committed)) || a.sha.localeCompare(b.sha));
  if (fresh.length) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, fresh.map((x) => JSON.stringify(x) + '\n').join(''));
  }
  return fresh.length;
}

export const isTranscript = (path: string) => /[\\/](repo\.json|commits\.jsonl|issues[\\/]\d+\.json)$/.test(path); // not _state/_local/.bak

const iso = (t: unknown) => (typeof t === 'string' && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : null);
const tidy = (t: string) => t.replace(/\r\n?/g, '\n')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]').replace(/<img\b[^>]*>/gi, '[image]')
  .replace(/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, '[data-url]').trim(); // code blocks stay
const cap = (t: string) => (t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + ' …[truncated]' : t);

export async function parse(path: string): Promise<Parsed | null> {
  const p = path.replace(/\\/g, '/');
  const issue = /([^/]+)\/([^/]+)\/issues\/(\d+)\.json$/.exec(p);
  const repoDir = issue ? dirname(dirname(path)) : dirname(path);
  const full = issue ? `${issue[1]}/${issue[2]}` : p.split('/').slice(-3, -1).join('/');
  const card = readJson(join(repoDir, 'repo.json'));
  const cwd = typeof card?.local === 'string' && card.local ? card.local : `github/${full}`; // cloned → same project as its AI sessions
  const sessionId = `github:${full}${issue ? `#${issue[3]}` : p.endsWith('/commits.jsonl') ? ':commits' : ''}`;
  const msgs: Msg[] = [];
  const push = (id: string, ts: string | null, role: Role, text: string) => {
    text = cap(tidy(text));
    if (ts && text) msgs.push({ uuid: `github:${id}`, parentUuid: msgs.at(-1)?.uuid ?? null, sessionId, ts, cwd, role, text });
  };

  if (p.endsWith('/repo.json')) {
    if (typeof card?.full_name !== 'string') return null;
    const meta = [card.language, ['private', 'fork', 'archived'].filter((k) => card[k] === true).join(' '),
      Array.isArray(card.topics) && card.topics.length ? `topics ${card.topics.join(', ')}` : '',
      card.created_at && `created ${String(card.created_at).slice(0, 10)}`, card.pushed_at && `pushed ${String(card.pushed_at).slice(0, 10)}`,
      card.default_branch && `branch ${card.default_branch}`, card.local && `local ${card.local}`].filter(Boolean).join(' · ');
    push(full, iso(card.pushed_at) ?? iso(card.created_at), 'note',
      [`[repo ${card.full_name}] ${card.description ?? ''}`.trim(), meta, typeof card.readme === 'string' ? `README:\n${card.readme}` : ''].filter(Boolean).join('\n'));
  } else if (p.endsWith('/commits.jsonl')) {
    const rows = new Map<string, { sha: string; ts: string; message: string }>();
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const o = line.trim() ? json(line) : null, ts = iso(o?.date) ?? iso(o?.committed);
      // a rebased/amended commit gets a new sha but keeps author date + message: one msg, the first archived (stable uuid)
      const key = typeof o?.date === 'string' ? `${o.date}\n${o.message}` : o?.sha;
      if (typeof o?.sha === 'string' && ts && typeof o.message === 'string' && !rows.has(key)) rows.set(key, { sha: o.sha, ts, message: o.message });
    }
    for (const o of [...rows.values()].sort((a, b) => a.ts.localeCompare(b.ts) || a.sha.localeCompare(b.sha))) {
      push(`${full}@${o.sha}`, o.ts, 'user', `[commit ${o.sha.slice(0, 7)}] ${o.message}`); // he authored them
    }
  } else if (issue) {
    const d = readJson(path);
    if (typeof d?.title !== 'string') return null;
    const n = issue[3], say = (who: unknown, body: unknown) => (who === d.viewer ? '' : `${who}: `) + String(body ?? '');
    const role = (who: unknown): Role => (who === d.viewer ? 'user' : 'assistant');
    const labels = Array.isArray(d.labels) && d.labels.length ? `\nlabels: ${d.labels.join(', ')}` : '';
    push(`${full}#${n}`, iso(d.created_at), role(d.author), `[${d.pr ? 'PR' : 'issue'} #${n}] ${d.title} (${d.state})${labels}\n${say(d.author, d.body)}`);
    const comments = (Array.isArray(d.comments) ? d.comments : []).filter((x: any) => iso(x?.created_at) && String(x.body ?? '').trim());
    comments.sort((a: any, b: any) => iso(a.created_at)!.localeCompare(iso(b.created_at)!) || Number(a.id) - Number(b.id));
    for (const x of comments) push(`${full}#${n}/c${x.id}`, iso(x.created_at), role(x.author), say(x.author, x.body));
  }
  return msgs.length ? { sessionId, cwd, kind: 'doc', msgs } : null;
}
