// Pure: recorded gh api responses (MEMHUB_GITHUB_FAKE) + fake clones in a temp dir → sync() → parse(). No network, no Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isTranscript, parse, remoteRepo, sync } from '../src/tools/github.ts';

const root = mkdtempSync(join(tmpdir(), 'memhub-github-test-'));
const archive = join(root, 'archive'), fakeFile = join(root, 'fake.json');
const norm = (d: string) => d.replace(/\\/g, '/').toLowerCase();
const clone = (name: string, config: string | null) => {
  const d = join(root, 'clones', name);
  mkdirSync(join(d, '.git'), { recursive: true });
  if (config) writeFileSync(join(d, '.git', 'config'), config);
  return d;
};
const A = clone('alpha', '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/other/alpha.git\n[remote "origin"]\n\turl = https://github.com/Alice/Alpha.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
const B = clone('beta', '[remote "origin"]\n\turl = git@github.com:acme/beta.git\n');
const C = clone('nogit-config', null), D = clone('gitlab', '[remote "origin"]\n\turl = https://gitlab.com/x/y.git\n');
process.env.MEMHUB_GITHUB_CLONES = [A, B, C, D].join(',');
process.env.MEMHUB_GITHUB_FAKE = fakeFile;

const page = (path: string, params: Record<string, string> = {}) => `${path}?${new URLSearchParams({ ...params, per_page: '100', page: '1' })}`;
const searchKey = (q: string) => `search/issues?${new URLSearchParams({ q, sort: 'updated', order: 'asc', per_page: '100', page: '1' })}`;
const REPOS = page('user/repos', { affiliation: 'owner,collaborator,organization_member', sort: 'full_name' });
const repo = (full_name: string, pushed_at: string | null, extra = {}) => ({
  full_name, description: `about ${full_name}`, language: 'Go', topics: ['erp'], private: true, fork: false, archived: false,
  created_at: '2024-01-01T00:00:00Z', pushed_at, default_branch: 'main', html_url: `https://github.com/${full_name}`, stargazers_count: 1, ...extra,
});
const commit = (sha: string, date: string, message: string) => ({ sha, commit: { author: { date }, committer: { date }, message } });
const item = (full: string, number: number, user: string, updated_at: string, extra = {}) => ({
  repository_url: `https://api.github.com/repos/${full}`, number, title: `title ${number}`, state: 'open', labels: [], user: { login: user },
  created_at: '2026-09-01T00:00:00Z', updated_at, closed_at: null, body: `body ${number}`, comments: 0, ...extra,
});
const README = '# Alpha\n![badge](https://img.shields.io/x.svg)\n' + 'r'.repeat(5000);
const SHA = (c: string) => c.repeat(40);
const issue1 = item('Alice/Alpha', 1, 'alice', '2026-09-10T10:00:00Z', { labels: [{ name: 'bug' }], comments: 2 });
const pr2 = item('acme/beta', 2, 'bob', '2026-09-12T08:00:00Z', { pull_request: { merged_at: '2026-09-12T08:00:00Z' }, state: 'closed' });
const issue3 = item('Alice/Alpha', 3, 'carol', '2026-09-15T12:00:00Z', {
  body: 'see ![shot](https://x/y.png) <img src="https://x/z.png"> data:image/png;base64,iVBORw0KGgo= \r\n```go\nfmt.Println(1)\n```\n' + 'b'.repeat(25_000),
});
const world: Record<string, unknown> = {
  rate_limit: { resources: { core: { remaining: 5000 }, search: { remaining: 30 } } },
  user: { login: 'alice' },
  [REPOS]: [repo('Alice/Alpha', '2026-09-05T00:00:00Z'), repo('acme/beta', '2026-09-02T00:00:00Z'), repo('acme/gamma', null)],
  'repos/Alice/Alpha/readme': { content: Buffer.from(README).toString('base64'), encoding: 'base64' },
  [page('repos/Alice/Alpha/commits', { author: 'alice' })]: [commit(SHA('b'), '2026-09-05T00:00:00Z', 'feat: second\n\nbody line'), commit(SHA('a'), '2026-09-01T00:00:00Z', 'init')],
  // his legacy noreply address: author=<login> alone misses these (REST); 56 real commits on 2026-10-02
  [page('repos/Alice/Alpha/commits', { author: 'alice@users.noreply.github.com' })]: [commit(SHA('e'), '2026-09-03T00:00:00Z', 'web edit')],
  [page('repos/acme/beta/commits', { author: 'alice' })]: [commit(SHA('c'), '2026-09-02T00:00:00Z', 'fix beta')],
  [searchKey('involves:alice')]: { total_count: 2, items: [issue1, pr2] },
  [searchKey('user:alice')]: { total_count: 2, items: [issue1, issue3] },
  [page('repos/Alice/Alpha/issues/1/comments')]: [
    { id: 11, user: { login: 'alice' }, created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z', body: 'my note' },
    { id: 12, user: { login: 'bob' }, created_at: '2026-09-03T00:00:00Z', updated_at: '2026-09-03T00:00:00Z', body: 'bob reply' },
  ],
};
const save = () => writeFileSync(fakeFile, JSON.stringify(world));
const SINCE = '2026-09-15T11:00:00Z'; // newest issue update − 1 h overlap
const alpha = join(archive, 'alice', 'alpha'), beta = join(archive, 'acme', 'beta');
const files = (d: string): string[] => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();
test.after(() => rmSync(root, { recursive: true, force: true }));

test('remoteRepo: https / ssh / scp / credentials / non-github', () => {
  assert.equal(remoteRepo('https://github.com/Alice/Alpha.git'), 'alice/alpha');
  assert.equal(remoteRepo('git@github.com:acme/beta.git'), 'acme/beta');
  assert.equal(remoteRepo('ssh://git@github.com/acme/beta.git/'), 'acme/beta');
  assert.equal(remoteRepo('https://user:SECRET@github.com/o/my.repo.github.io'), 'o/my.repo.github.io');
  assert.equal(remoteRepo('https://gitlab.com/x/y.git'), null);
  assert.equal(remoteRepo('https://github.com.evil.com/x/y'), null);
  assert.equal(remoteRepo('https://notgithub.com/x/y'), null);
  assert.equal(remoteRepo('https://evil.com/github.com/x/y'), null);
  assert.equal(remoteRepo('https://www.github.com/o/r'), 'o/r');
  assert.equal(remoteRepo('ssh://git@github.com:22/o/r.git'), 'o/r');
});

test('sync: repo cards, README head, commits, issues/PRs + comments, local clone map', () => {
  save();
  assert.deepEqual(sync(archive), { repos: 3, readmes: 1, copied: 6, commits: 4, issues: 2, prs: 1, comments: 2, calls: 14 });
  assert.deepEqual(JSON.parse(readFileSync(join(archive, '_local.json'), 'utf8')), { 'alice/alpha': norm(A), 'acme/beta': norm(B) });
  const card = JSON.parse(readFileSync(join(alpha, 'repo.json'), 'utf8'));
  assert.equal(card.readme, README.slice(0, 4000));
  assert.equal(card.local, norm(A));
  assert.ok(!('stargazers_count' in card), 'only card fields, no hourly-changing counters');
  assert.equal(JSON.parse(readFileSync(join(archive, 'acme', 'gamma', 'repo.json'), 'utf8')).readme, null);
  assert.deepEqual(readFileSync(join(alpha, 'commits.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).sha), [SHA('a'), SHA('e'), SHA('b')], 'date order, noreply commits included');
  assert.deepEqual(readdirSync(join(alpha, 'issues')).sort(), ['1.json', '3.json']);
  assert.ok(isTranscript(join(alpha, 'repo.json')) && isTranscript(join(alpha, 'commits.jsonl')) && isTranscript(join(alpha, 'issues', '1.json')));
  assert.ok(!isTranscript(join(archive, '_state.json')) && !isTranscript(join(archive, '_local.json')) && !isTranscript(join(alpha, 'repo.json.1.bak')));
});

test('parse: shapes, roles, caps, project mapping, uuids unique + stable', async () => {
  const card = (await parse(join(alpha, 'repo.json')))!;
  assert.equal(card.sessionId, 'github:alice/alpha'); assert.equal(card.kind, 'doc'); assert.equal(card.cwd, norm(A));
  assert.equal(card.msgs.length, 1); assert.equal(card.msgs[0].role, 'note');
  assert.match(card.msgs[0].text, /^\[repo Alice\/Alpha\] about Alice\/Alpha\nGo · private · topics erp · created 2024-01-01 · pushed 2026-09-05 · branch main · local .*\nREADME:\n# Alpha\n\[image\]\nrrr/);
  assert.equal((await parse(join(archive, 'acme', 'gamma', 'repo.json')))!.cwd, 'github/acme/gamma', 'not cloned');

  const commits = (await parse(join(alpha, 'commits.jsonl')))!;
  assert.equal(commits.sessionId, 'github:alice/alpha:commits');
  assert.deepEqual(commits.msgs.map((m) => [m.role, m.text, m.uuid]), [
    ['user', '[commit aaaaaaa] init', `github:alice/alpha@${SHA('a')}`],
    ['user', '[commit eeeeeee] web edit', `github:alice/alpha@${SHA('e')}`],
    ['user', '[commit bbbbbbb] feat: second\n\nbody line', `github:alice/alpha@${SHA('b')}`]]);

  const i1 = (await parse(join(alpha, 'issues', '1.json')))!;
  assert.equal(i1.sessionId, 'github:alice/alpha#1');
  assert.deepEqual(i1.msgs.map((m) => [m.role, m.text]), [['user', '[issue #1] title 1 (open)\nlabels: bug\nbody 1'], ['user', 'my note'], ['assistant', 'bob: bob reply']]);
  assert.deepEqual(i1.msgs.map((m) => m.uuid), ['github:alice/alpha#1', 'github:alice/alpha#1/c11', 'github:alice/alpha#1/c12']);
  assert.deepEqual(i1.msgs.map((m) => m.parentUuid), [null, 'github:alice/alpha#1', 'github:alice/alpha#1/c11']);

  const pr = (await parse(join(beta, 'issues', '2.json')))!;
  assert.equal(pr.cwd, norm(B), 'ssh clone maps too');
  assert.deepEqual(pr.msgs.map((m) => [m.role, m.text]), [['assistant', '[PR #2] title 2 (merged)\nbob: body 2']]);

  const i3 = (await parse(join(alpha, 'issues', '3.json')))!.msgs[0];
  assert.match(i3.text, /^\[issue #3\] title 3 \(open\)\ncarol: see \[image\] \[image\] \[data-url\] \n```go\nfmt\.Println\(1\)\n```\nbbb/);
  assert.equal(i3.text.length, 20_000 + ' …[truncated]'.length);

  const all = [];
  for (const f of files(archive).filter(isTranscript)) {
    const p = (await parse(f))!;
    assert.deepEqual(await parse(f), p, 'stable across re-parses');
    const ts = p.msgs.map((m) => m.ts);
    assert.ok(ts.every((t) => new Date(t).toISOString() === t)); assert.deepEqual([...ts].sort(), ts);
    all.push(...p.msgs.map((m) => m.uuid));
  }
  assert.equal(new Set(all).size, all.length, 'uuids unique across files');
});

test('sync again: cheap and unchanged; a new commit appends; an edited issue keeps a .bak; nothing is ever deleted', async () => {
  world[searchKey(`user:alice updated:>=${SINCE}`)] = { total_count: 1, items: [issue3] }; // overlap window repeats it
  save();
  const before = files(archive).map((f) => [f, readFileSync(f, 'utf8')]);
  assert.deepEqual(sync(archive), { repos: 3, unchanged: 4, calls: 3 }); // repo list + 2 searches, no per-repo / comment calls
  assert.deepEqual(files(archive).map((f) => [f, readFileSync(f, 'utf8')]), before);

  const oldCommits = readFileSync(join(alpha, 'commits.jsonl'), 'utf8');
  (world[REPOS] as any[])[0].pushed_at = '2026-09-20T00:00:00Z';
  world[page('repos/Alice/Alpha/commits', { author: 'alice', since: '2026-08-29T00:00:00Z' })] = [commit(SHA('d'), '2026-09-20T00:00:00Z', 'new work'), commit(SHA('b'), '2026-09-05T00:00:00Z', 'feat: second\n\nbody line'),
    { sha: SHA('f'), commit: { author: { date: '2026-09-05T00:00:00Z' }, committer: { date: '2026-09-21T00:00:00Z' }, message: 'feat: second\n\nbody line' } }]; // f = b rebased
  save();
  assert.deepEqual(sync(archive), { repos: 3, readmes: 1, conflicts: 1, unchanged: 3, commits: 2, calls: 6 });
  const grown = readFileSync(join(alpha, 'commits.jsonl'), 'utf8');
  assert.ok(grown.startsWith(oldCommits) && grown.slice(oldCommits.length).includes(SHA('d')));
  assert.ok(grown.includes(SHA('f')), 'the rebased copy is archived (raw truth)');
  assert.deepEqual((await parse(join(alpha, 'commits.jsonl')))!.msgs.map((m) => m.text.slice(0, 16)),
    ['[commit aaaaaaa]', '[commit eeeeeee]', '[commit bbbbbbb]', '[commit ddddddd]'], 'b rebased as f: one msg, the first archived sha');
  assert.equal(readdirSync(alpha).filter((f) => f.startsWith('repo.json.') && f.endsWith('.bak')).length, 1, 'pushed_at change keeps the old card');

  world[searchKey(`user:alice updated:>=${SINCE}`)] = { total_count: 1, items: [{ ...issue3, body: 'edited body', updated_at: '2026-09-21T00:00:00Z' }] };
  save();
  assert.deepEqual(sync(archive), { repos: 3, unchanged: 3, issues: 1, conflicts: 1, calls: 3 });
  assert.equal(readdirSync(join(alpha, 'issues')).filter((f) => f.startsWith('3.json.') && f.endsWith('.bak')).length, 1);
  assert.match((await parse(join(alpha, 'issues', '3.json')))!.msgs[0].text, /carol: edited body$/);

  const kept = files(archive).filter((f) => !f.endsWith('_state.json')).map((f) => [f, readFileSync(f, 'utf8')]);
  world[REPOS] = []; // repos deleted / access lost on GitHub
  for (const k of Object.keys(world)) if (k.startsWith('search/')) delete world[k];
  save();
  assert.deepEqual(sync(archive), { calls: 3 });
  assert.deepEqual(files(archive).filter((f) => !f.endsWith('_state.json')).map((f) => [f, readFileSync(f, 'utf8')]), kept);
});

test('rate limit: stops before eating the 500-call reserve, keeps state, resumes next run', () => {
  const fresh = join(root, 'archive-rate');
  world[REPOS] = [repo('Alice/Alpha', '2026-09-05T00:00:00Z')];
  world.rate_limit = { resources: { core: { remaining: 502 }, search: { remaining: 30 } } };
  save();
  assert.deepEqual(sync(fresh), { repos: 1, stopped: 'rate limit: 500 calls kept in reserve', calls: 2 }); // user + repo list
  assert.equal(JSON.parse(readFileSync(join(fresh, '_state.json'), 'utf8')).login, 'alice');
  world.rate_limit = { resources: { core: { remaining: 400 }, search: { remaining: 30 } } };
  save();
  assert.deepEqual(sync(fresh), { skipped: 'rate limit: 400 calls left' });
  world.rate_limit = { resources: { core: { remaining: 5000 }, search: { remaining: 30 } } };
  save();
  assert.equal(sync(fresh).commits, 3, 'resumed');
});

test('gh missing / offline → skipped, never throws', () => {
  const { MEMHUB_GITHUB_FAKE: fake, PATH: path } = process.env;
  delete process.env.MEMHUB_GITHUB_FAKE;
  process.env.PATH = '';
  try { assert.deepEqual(sync(join(root, 'archive-nogh')), { skipped: 'gh not installed' }); }
  finally { process.env.MEMHUB_GITHUB_FAKE = fake; process.env.PATH = path; }
});

test('a hard kill mid-sync (shutdown during the long first run) keeps the repos already done', () => {
  const dir = join(root, 'archive-kill');
  world[REPOS] = [repo('Alice/Alpha', '2026-09-05T00:00:00Z'), repo('acme/beta', '2026-09-02T00:00:00Z')];
  save();
  // the child exits hard (no finally) on its 2nd commits append = beta, after alpha is done
  const code = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
let n = 0; const append = fs.appendFileSync;
fs.appendFileSync = (...a) => { if (++n === 2) process.exit(9); return append(...a); };
syncBuiltinESMExports();
(await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'src', 'tools', 'github.ts')).href)})).sync(${JSON.stringify(dir)});`;
  const temp = join(root, 'temp'); // its scratch dir survives the kill: keep it under root
  mkdirSync(temp);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp } });
  assert.equal(r.status, 9, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '_state.json'), 'utf8')).repos, { 'alice/alpha': '2026-09-05T00:00:00Z' });
});

test('a 5xx on one repo / one issue fails that item only; both are retried next run', () => {
  const dir = join(root, 'archive-5xx');
  world[REPOS] = [repo('Alice/Alpha', '2026-09-05T00:00:00Z'), repo('acme/beta', '2026-09-02T00:00:00Z')];
  const alphaCommits = world[page('repos/Alice/Alpha/commits', { author: 'alice' })];
  const comments = world[page('repos/Alice/Alpha/issues/1/comments')];
  world[page('repos/Alice/Alpha/commits', { author: 'alice' })] = 'HTTP 502';
  world[page('repos/Alice/Alpha/issues/1/comments')] = 'HTTP 502';
  world[searchKey('involves:alice')] = { total_count: 2, items: [issue1, pr2] };
  world[searchKey('user:alice')] = { total_count: 1, items: [issue1] };
  save();
  const s1 = sync(dir), st1 = JSON.parse(readFileSync(join(dir, '_state.json'), 'utf8'));
  assert.equal(s1.failed, 2, JSON.stringify(s1));
  assert.equal(s1.stopped, undefined);
  assert.deepEqual(st1.repos, { 'acme/beta': '2026-09-02T00:00:00Z' }, 'beta (after alpha) still synced');
  assert.equal(st1.issuesSince, undefined, 'cursor kept: issue 1 is retried');
  world[page('repos/Alice/Alpha/commits', { author: 'alice' })] = alphaCommits;
  world[page('repos/Alice/Alpha/issues/1/comments')] = comments;
  save();
  const s2 = sync(dir);
  assert.equal(s2.failed, undefined);
  assert.equal(s2.comments, 2);
  assert.ok(JSON.parse(readFileSync(join(dir, '_state.json'), 'utf8')).repos['alice/alpha']);
});
