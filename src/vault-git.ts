// Local git history of the memory-hub vault (idea from ai-memory / letta-code): each machine write batch (a dream run,
// a memory_save) is one commit, and ลุงจืด's own Obsidian edits found before it are committed first as their own snapshot,
// so `vault log / diff / undo` can tell them apart. Local only: never a remote, never pushed (the notes are private).
// A git failure (git missing, index.lock, the global secret-scan hook) only warns: it never fails a dream or a save.
// A machine commit stages only the notes its batch wrote; processes (nightly dream, MCP servers, CLI) take turns on the index.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HUMAN = 'ลุงจืด แก้เอง (snapshot)';
const BASELINE = 'baseline: memory-hub vault history starts';
const IGNORE = '# memory-hub: Obsidian volatile state + atomic-write temp files\n.obsidian/workspace*.json\n.obsidian/cache\n.trash/\n*.tmp-*\n';

export type GitRun = (args: string[], cwd: string, input?: string) => { status: number | null; stdout: string; stderr: string; error?: Error };
let runner: GitRun = (args, cwd, input) =>
  spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, input, encoding: 'utf8', windowsHide: true, maxBuffer: 256 << 20 });
/** Tests swap the runner (never core.hooksPath: the global secret-scan hook always runs). Returns the previous one. */
export function setGitRunner(r: GitRun) { const old = runner; runner = r; return old; }

function check(args: string[], r: ReturnType<GitRun>) {
  if (r.error || r.status !== 0) throw new Error(`git ${args[0]}: ${(r.error?.message ?? `${r.stderr}${r.stdout}`).trim().split('\n')[0] || `exit ${r.status}`}`);
  return r.stdout;
}
const git = (cwd: string, ...args: string[]) => check(args, runner(args, cwd));
/** `git <args>` on these notes only: names on stdin (no Windows command-line limit), taken literally. None → no-op (never "all"). */
const gitPaths = (cwd: string, paths: string[], ...args: string[]) => (paths.length
  ? check(args, runner([...args, '--pathspec-from-file=-'], cwd, paths.map((p) => `:(literal)${p}`).join('\n'))) : '');

/**
 * Commit what is staged; false when nothing is. Notes the global secret-scan hook blocks are unstaged and named in a warning,
 * the rest still committed: one note quoting a (redacted) DSN must not stop the history. Any other failure: index back to HEAD.
 */
function commitIndex(vault: string, msg: string) {
  if (runner(['diff', '--cached', '--quiet'], vault).status === 0) return false;
  const r = runner(['commit', '-q', '-m', msg], vault);
  if (r.status === 0) return true;
  const blocked = [...new Set([...`${r.stderr}`.matchAll(/^ {2}\[[^\]\n]+\] (.+?) -> /gm)].map((m) => m[1]))]; // secret-scan.pl findings
  try {
    if (!blocked.length) check(['commit'], r);
    gitPaths(vault, blocked, 'reset', '-q');
    console.warn(`vault history: secret-scan hook blocked ${blocked.join(', ')}: left uncommitted (take the secret out of the note; never --no-verify)`);
    if (runner(['diff', '--cached', '--quiet'], vault).status === 0) return false;
    git(vault, 'commit', '-q', '-m', msg);
    return true;
  } catch (e) { runner(['reset', '-q'], vault); throw e; } // the next commit must not carry this one's staged notes
}

/**
 * One memory-hub git section at a time across processes (they share one index). ponytail: mkdir lock, 50 ms polling, 15 s
 * give-up; a lock older than 60 s is a crashed holder's (two waiters clearing the same stale lock can both enter: rare).
 */
function locked<T>(vault: string, f: () => T): T {
  const lock = join(vault, '.git', 'memhub.lock');
  for (let waited = 0; ; waited += 50) {
    try { mkdirSync(lock); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > 60_000) rmSync(lock, { recursive: true, force: true });
      else if (waited >= 15_000) throw new Error('busy: .git/memhub.lock held by another memory-hub process');
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return f(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

/** .git/memhub-batch-<pid>: the notes that process's open batch writes. Its own commit takes them, not ลุงจืด's snapshot. */
const marker = (vault: string, pid = process.pid) => join(vault, '.git', `memhub-batch-${pid}`);
function othersWriting(vault: string) {
  return readdirSync(join(vault, '.git')).flatMap((f) => {
    const pid = Number(/^memhub-batch-(\d+)$/.exec(f)?.[1]);
    if (!pid) return [];
    try { process.kill(pid, 0); } catch (e) { // signal 0 = "alive?"; EPERM = alive, not ours
      if ((e as NodeJS.ErrnoException).code !== 'EPERM') { rmSync(marker(vault, pid), { force: true }); return []; } // died mid-batch: leftovers
    }
    try { return readFileSync(marker(vault, pid), 'utf8').split('\n').filter(Boolean); } catch { return []; } // committed + closed just now
  });
}

/** Create the repo on first use (baseline commit), else commit whatever is uncommitted (ลุงจืด's Obsidian edits) as its own snapshot. */
export function snapshot(vault: string): 'baseline' | 'human' | null {
  if (!existsSync(join(vault, '.git'))) {
    mkdirSync(vault, { recursive: true });
    git(vault, 'init', '-q');
    git(vault, 'config', 'user.name', 'memory-hub'); // repo-local identity; no remote is ever added
    git(vault, 'config', 'user.email', 'memory-hub@localhost');
    git(vault, 'config', 'core.autocrlf', 'false'); // Git for Windows defaults to true: an undo would rewrite notes as CRLF
    if (!existsSync(join(vault, '.gitignore'))) writeFileSync(join(vault, '.gitignore'), IGNORE);
  }
  return locked(vault, () => {
    const st = git(vault, 'status', '--porcelain=v2', '--branch');
    if (!/^[^#]/m.test(st)) return null; // clean (only "# branch.*" headers)
    const fresh = st.includes('# branch.oid (initial)');
    git(vault, 'add', '-A');
    gitPaths(vault, othersWriting(vault), 'reset', '-q'); // read after the add: a note written in between is already listed
    return commitIndex(vault, fresh ? BASELINE : HUMAN) ? (fresh ? 'baseline' : 'human') : null;
  });
}

const batches = new Map<string, Set<string>>(); // vault → notes this process's open batch wrote
const quiet = (f: () => unknown) => { try { f(); } catch (e) { console.warn(`vault history skipped: ${(e as Error).message}`); } };

/**
 * Before a machine write of `rel`: the batch's first write snapshots ลุงจืด's pending edits (once per batch, not per note).
 * ponytail: "uncommitted when a batch starts" = human; notes of a machine batch whose own commit failed (or whose process died)
 * get labelled human by the next snapshot. Per-file attribution if that ever matters.
 */
export function beforeMachineWrite(vault: string, rel: string) {
  let open = batches.get(vault);
  if (!open) { batches.set(vault, (open = new Set())); quiet(() => snapshot(vault)); }
  if (open.has(rel)) return;
  open.add(rel);
  if (existsSync(join(vault, '.git'))) quiet(() => appendFileSync(marker(vault), `${rel}\n`)); // before the write: see othersWriting
}

/** End of a machine write batch → one commit of exactly the notes it wrote (his edits meanwhile wait for the next snapshot). */
export function commitBatch(vault: string, msg: string) {
  const open = batches.get(vault);
  if (!open) return; // the batch wrote nothing
  batches.delete(vault);
  const paths = [...open].filter((p) => existsSync(join(vault, p))); // a write that failed before its rename: nothing to stage
  quiet(() => locked(vault, () => { gitPaths(vault, paths, 'add'); return commitIndex(vault, msg); }));
  quiet(() => rmSync(marker(vault), { force: true })); // only after the commit: until then no snapshot may take these notes
}

export const kindOf = (s: string) => (/^(dream|consolidate)\b/.test(s) ? 'dream' : s.startsWith('memory_save') ? 'save' : s === HUMAN ? 'human'
  : s.startsWith('Revert') ? 'undo' : s === BASELINE ? 'baseline' : 'other');

export function log(vault: string, n = 20) {
  return git(vault, 'log', `-n${n}`, '--date=format:%Y-%m-%d %H:%M', '--format=%x1e%h%x1f%ad%x1f%s', '--shortstat')
    .split('\x1e').slice(1).map((c) => {
      const [head, ...stat] = c.split('\n');
      const [hash, date, subject] = head.split('\x1f');
      return { hash, date, subject, kind: kindOf(subject), files: Number(stat.join(' ').match(/(\d+) files? changed/)?.[1] ?? 0) };
    });
}

/** What one commit changed (default: the last dream): per note, lines added / removed. */
export function show(vault: string, rev?: string) {
  rev ||= git(vault, 'log', '-n1', '--format=%h', '--grep=^dream ').trim();
  if (!rev) throw new Error('no dream commit yet');
  const [head, ...rows] = git(vault, 'show', '--no-renames', '--numstat', '--date=format:%Y-%m-%d %H:%M', '--format=%h %ad %s', rev, '--')
    .trim().split('\n');
  return { rev, head, files: rows.filter(Boolean).map((l) => {
    const [added, removed, path] = l.split('\t');
    return { path, added: Number(added) || 0, removed: Number(removed) || 0 };
  }) };
}

export const patch = (vault: string, rev: string) => git(vault, 'show', '--no-color', rev, '--');

/** `git revert` a machine commit (dream / memory_save / undo); ลุงจืด's own snapshot or the baseline only with force. */
export function undo(vault: string, rev: string, force = false) {
  const hash = git(vault, 'rev-parse', '--verify', '-q', `${rev}^{commit}`).trim();
  const subject = git(vault, 'log', '-n1', '--format=%s', hash).trim();
  const kind = kindOf(subject);
  if (!['dream', 'save', 'undo'].includes(kind) && !force) throw new Error(`${rev} is a ${kind} commit ("${subject}"), not a machine write: add --force to revert it anyway`);
  snapshot(vault); // pending Obsidian edits → their own commit first (a dirty tree blocks the revert)
  locked(vault, () => {
    try { git(vault, 'revert', '--no-edit', hash); }
    catch (e) { runner(['revert', '--abort'], vault); throw e; } // conflict (a later edit of the same lines): tree left as it was
  });
  return subject;
}
