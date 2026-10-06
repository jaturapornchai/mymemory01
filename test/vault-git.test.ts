// Local git history of the memory-hub vault: lazy repo + baseline, one commit per machine batch, ลุงจืด's Obsidian edits as
// their own snapshot first, git failures swallowed, undo. Temp vault + own throwaway schema (for the .git indexing check).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-vaultgit-'));
const SCHEMA = `memhub_vaultgit_test_${process.pid}`;
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMHUB_MEMORY_VAULT = join(tmp, 'vault');
process.env.MEMHUB_VAULTS = '';
process.env.MEMHUB_NO_REINDEX = '1';
const { connect, ROOT } = await import('../src/db.ts');
const { saveNote, writeNote, MEMORY_VAULT } = await import('../src/notes.ts');
const { indexVault } = await import('../src/obsidian.ts');
const vg = await import('../src/vault-git.ts');

const db = connect('rw');
const git = (...a: string[]) => execFileSync('git', ['-c', 'core.quotePath=false', ...a], { cwd: MEMORY_VAULT, encoding: 'utf8' }).trim();
const subjects = () => git('log', '--format=%s').split('\n');
const filesOf = (rev: string) => git('show', '--name-only', '--format=', rev).split('\n').filter(Boolean);
const NOW = new Date('2026-10-02T00:00:00Z');
const note = (fid: string, body: string) => writeNote(`facts/demo/${fid}.md`, { memhub: 'fact', id: fid, status: 'active' }, body);

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('first machine write: repo + local identity + .gitignore + baseline, then exactly one memory_save commit', () => {
  mkdirSync(join(MEMORY_VAULT, '.obsidian'), { recursive: true });
  writeFileSync(join(MEMORY_VAULT, 'old note.md'), 'written before history existed\n');
  writeFileSync(join(MEMORY_VAULT, '.obsidian', 'app.json'), '{}');
  writeFileSync(join(MEMORY_VAULT, '.obsidian', 'workspace.json'), '{"volatile":1}');
  const rel = saveNote('memhub vault มีประวัติ git ในเครื่อง', { client: 'test-client', now: NOW });
  assert.ok(existsSync(join(MEMORY_VAULT, '.git')));
  assert.equal(git('config', '--local', 'user.name'), 'memory-hub');
  assert.equal(git('config', '--local', 'user.email'), 'memory-hub@localhost');
  assert.equal(git('remote'), '', 'never a remote');
  assert.deepEqual(subjects(), [`memory_save (test-client): ${rel}`, 'baseline: memory-hub vault history starts']);
  assert.deepEqual(filesOf('HEAD~1').sort(), ['.gitignore', '.obsidian/app.json', 'old note.md']); // workspace.json ignored
  assert.deepEqual(filesOf('HEAD'), [rel]);
  saveNote('memhub vault มีประวัติ git ในเครื่อง', { client: 'test-client', now: NOW }); // same fact: file unchanged → no commit
  assert.equal(subjects().length, 2);
});

test('a batch of writeNote calls → one commit (not one per note)', () => {
  note('F00000001', 'first\n');
  note('F00000002', 'second\n');
  vg.commitBatch(MEMORY_VAULT, 'dream t1: +2 ADD, 0 UPDATE, 0 SUPERSEDE');
  assert.equal(subjects()[0], 'dream t1: +2 ADD, 0 UPDATE, 0 SUPERSEDE');
  assert.deepEqual(filesOf('HEAD').sort(), ['facts/demo/F00000001.md', 'facts/demo/F00000002.md']);
  vg.commitBatch(MEMORY_VAULT, 'dream t2: nothing written'); // no write since → no commit
  assert.equal(subjects()[0], 'dream t1: +2 ADD, 0 UPDATE, 0 SUPERSEDE');
});

test('ลุงจืด edits in Obsidian, then a machine write → his snapshot commit first, machine commit after', () => {
  writeFileSync(join(MEMORY_VAULT, 'old note.md'), 'ลุงจืดแก้โน้ตนี้เอง\n');
  const rel = saveNote('memhub เก็บประวัติแยก คน/เครื่อง', { client: 'codex-mcp-client', now: NOW });
  assert.deepEqual(subjects().slice(0, 2), [`memory_save (codex-mcp-client): ${rel}`, vg.HUMAN]);
  assert.deepEqual(filesOf('HEAD~1'), ['old note.md']);
  assert.deepEqual(filesOf('HEAD'), [rel]);
  assert.deepEqual(vg.log(MEMORY_VAULT, 3).map((c) => [c.kind, c.files]), [['save', 1], ['human', 1], ['dream', 2]]);
});

test('vault undo reverts a machine commit (file content restored); a human snapshot needs --force', () => {
  note('F00000001', 'first, updated by a bad dream\n');
  vg.commitBatch(MEMORY_VAULT, 'dream t3: +0 ADD, 1 UPDATE, 0 SUPERSEDE');
  const bad = git('rev-parse', '--short', 'HEAD');
  assert.match(vg.undo(MEMORY_VAULT, bad), /^dream t3/);
  assert.match(readFileSync(join(MEMORY_VAULT, 'facts/demo/F00000001.md'), 'utf8'), /\nfirst\n$/);
  assert.equal(vg.log(MEMORY_VAULT, 1)[0].kind, 'undo');
  const human = git('log', '-n1', '--format=%h', `--grep=${vg.HUMAN}`, '--fixed-strings');
  assert.throws(() => vg.undo(MEMORY_VAULT, human), /human commit .*--force/);
  assert.throws(() => vg.undo(MEMORY_VAULT, git('rev-list', '--max-parents=0', 'HEAD')), /baseline commit/);
});

test('cli: vault log / diff (default = last dream)', () => {
  const cli = (...a: string[]) => spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'vault', ...a], { encoding: 'utf8', env: process.env });
  const log = cli('log', '-n', '3');
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /^\w+ {2}\d{4}-\d\d-\d\d \d\d:\d\d {2}undo {5}Revert "dream t3/);
  const diff = cli('diff');
  assert.equal(diff.status, 0, diff.stderr);
  assert.match(diff.stdout, /dream t3: \+0 ADD, 1 UPDATE/);
  assert.match(diff.stdout, /\+2 -2 {2}facts\/demo\/F00000001\n1 notes, \+2 -2 lines/); // body line + body_sha
  assert.match(cli('diff', '--full').stdout, /^-first\n\+first, updated by a bad dream$/m);
  const refused = cli('undo', git('rev-list', '--max-parents=0', 'HEAD'));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /baseline commit/);
});

test('indexing skips .git (and the non-.md .gitignore)', async () => {
  assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');
  writeFileSync(join(MEMORY_VAULT, '.git', 'decoy.md'), '# not a note\n');
  await indexVault(db, MEMORY_VAULT);
  const paths = (await db.query(`SELECT path FROM sources WHERE tool = 'obsidian'`)).rows.map((r) => r.path.replace(/\\/g, '/'));
  assert.equal(paths.length, 5); // old note + 2 saved + 2 dream facts
  assert.ok(!paths.some((p) => /\/\.git(\/|ignore)/.test(p)), paths.join('\n'));
});

test('his Obsidian edit made mid-batch stays out of the machine commit (next snapshot), so undoing the dream keeps it', () => {
  note('F00000004', 'fourth\n'); // the batch's first write: snapshot (clean tree)
  writeFileSync(join(MEMORY_VAULT, 'old note.md'), 'plan v2: typed in Obsidian while the dream ran\n');
  note('F00000005', 'fifth\n');
  vg.commitBatch(MEMORY_VAULT, 'dream t5: +2 ADD, 0 UPDATE, 0 SUPERSEDE');
  assert.deepEqual(filesOf('HEAD').sort(), ['facts/demo/F00000004.md', 'facts/demo/F00000005.md']);
  vg.undo(MEMORY_VAULT, 'HEAD');
  assert.equal(readFileSync(join(MEMORY_VAULT, 'old note.md'), 'utf8'), 'plan v2: typed in Obsidian while the dream ran\n');
  assert.deepEqual(subjects().slice(1, 3), [vg.HUMAN, 'dream t5: +2 ADD, 0 UPDATE, 0 SUPERSEDE']);
  assert.deepEqual(filesOf('HEAD~1'), ['old note.md']);
});

test('a save that throws still closes its batch: the next save snapshots his edit first (long-lived MCP server)', () => {
  const lock = join(MEMORY_VAULT, '.git', 'memhub.lock');
  mkdirSync(lock); // left by a process killed mid-commit
  utimesSync(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  const rel = saveNote('ข้อเท็จจริง A', { now: NOW }); // stale lock cleared
  assert.equal(subjects()[0], `memory_save (unknown): ${rel}`);
  const blocker = `${join(MEMORY_VAULT, rel)}.tmp-${process.pid}`;
  mkdirSync(blocker); // its atomic write now throws (a locked note → EPERM in real life)
  try { assert.throws(() => saveNote('ข้อเท็จจริง A', { kind: 'rule' }), /EISDIR|EPERM/); } // a change (same text keeps its dates)
  finally { rmSync(blocker, { recursive: true }); }
  writeFileSync(join(MEMORY_VAULT, 'old note.md'), 'plan v3\n');
  const rel2 = saveNote('ข้อเท็จจริง B', { now: NOW });
  assert.deepEqual(subjects().slice(0, 2), [`memory_save (unknown): ${rel2}`, vg.HUMAN]);
  assert.deepEqual(filesOf('HEAD~1'), ['old note.md']);
  assert.deepEqual(filesOf('HEAD'), [rel2]);
});

test('another process mid-batch (dream): a memory_save takes none of its notes; a dead process\'s leftovers go to the snapshot', async () => {
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(join(MEMORY_VAULT, '.git', `memhub-batch-${deadPid}`), 'facts/demo/F00000007.md\n');
  writeFileSync(join(MEMORY_VAULT, 'facts/demo/F00000007.md'), 'left by a dream killed mid-batch\n');
  const src = (f: string) => JSON.stringify(pathToFileURL(join(ROOT, 'src', f)).href);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { writeNote, MEMORY_VAULT } = await import(${src('notes.ts')});
    const vg = await import(${src('vault-git.ts')});
    if (MEMORY_VAULT !== process.argv[1]) process.exit(2); // never the real vault
    writeNote('facts/demo/F00000006.md', { memhub: 'fact', id: 'F00000006', status: 'active' }, 'sixth, by another process\\n');
    console.log('written');
    process.stdin.once('data', () => { vg.commitBatch(MEMORY_VAULT, 'dream t6: +1 ADD, 0 UPDATE, 0 SUPERSEDE'); process.exit(0); });
  `, MEMORY_VAULT], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  const [out] = await Promise.race([once(child.stdout, 'data'), once(child, 'exit')]);
  assert.match(String(out), /written/);
  const rel = saveNote('memory_save ระหว่าง dream รัน ไม่กวาดโน้ตของ dream', { now: NOW });
  assert.deepEqual(filesOf('HEAD'), [rel]);
  assert.deepEqual(filesOf('HEAD~1'), ['facts/demo/F00000007.md']); // his snapshot: the dead batch's leftover, not the live one's note
  assert.ok(!existsSync(join(MEMORY_VAULT, '.git', `memhub-batch-${deadPid}`)));
  child.stdin.write('go\n');
  assert.deepEqual(await once(child, 'exit'), [0, null]);
  assert.equal(subjects()[0], 'dream t6: +1 ADD, 0 UPDATE, 0 SUPERSEDE');
  assert.deepEqual(filesOf('HEAD'), ['facts/demo/F00000006.md']);
});

test('git failures never fail a machine write (mocked runner: git missing, index.lock)', () => {
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (s: string) => warns.push(s);
  const old = vg.setGitRunner(() => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) }));
  try {
    const rel = saveNote('git หายไป memory_save ยังต้องสำเร็จ', { now: NOW });
    assert.ok(existsSync(join(MEMORY_VAULT, rel)));
    vg.setGitRunner(() => ({ status: 128, stdout: '', stderr: "fatal: Unable to create '.git/index.lock': File exists.\n" }));
    note('F00000003', 'third\n');
    vg.commitBatch(MEMORY_VAULT, 'dream t4: +1 ADD, 0 UPDATE, 0 SUPERSEDE');
    assert.ok(existsSync(join(MEMORY_VAULT, 'facts/demo/F00000003.md')));
  } finally { vg.setGitRunner(old); console.warn = warn; }
  assert.deepEqual(warns, ['vault history skipped: git status: spawn git ENOENT', 'vault history skipped: git add: spawn git ENOENT',
    "vault history skipped: git status: fatal: Unable to create '.git/index.lock': File exists.",
    "vault history skipped: git add: fatal: Unable to create '.git/index.lock': File exists."]);
});

test('a note the global secret-scan hook blocks (his paste, a machine note quoting a DSN) stays out, named; history goes on', () => {
  vg.snapshot(MEMORY_VAULT); // leftovers of the mocked-failure test
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (s: string) => warns.push(s);
  const saved: string[] = [];
  try {
    writeFileSync(join(MEMORY_VAULT, 'pasted.md'), `key sk-${randomBytes(16).toString('hex')}\n`); // human paste; built at runtime
    saved.push(saveNote('hook บล็อกได้ แต่ save ต้องผ่าน', { now: NOW }));
    // redacted to memhub_ro:[REDACTED:connstr]@ : still "DB/URI with password" to the hook
    saved.push(saveNote(`DSN ของ memory-hub: ${'postgres'}://memhub_ro:${randomBytes(8).toString('hex')}@127.0.0.1:5441/memhub`, { now: NOW }));
    saved.push(saveNote('Ollama bge-m3 ทำ embedding', { now: NOW }));
  } finally { console.warn = warn; }
  assert.ok(saved.every((r) => existsSync(join(MEMORY_VAULT, r))));
  assert.match(readFileSync(join(MEMORY_VAULT, saved[1]), 'utf8'), /memhub_ro:\[REDACTED:connstr\]@/);
  if (!spawnSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).stdout.trim()) return; // no global hook: all committed
  const [rel, dsn, next] = saved;
  assert.deepEqual(subjects().slice(0, 2), [`memory_save (unknown): ${next}`, `memory_save (unknown): ${rel}`]);
  assert.deepEqual([filesOf('HEAD'), filesOf('HEAD~1')], [[next], [rel]]);
  assert.deepEqual(git('ls-files', '--others', '--exclude-standard').split('\n').sort(), [dsn, 'pasted.md']);
  assert.equal(git('diff', '--cached', '--name-only'), ''); // unstaged: never re-blocks a later commit
  assert.ok(warns.some((w) => w.includes('hook blocked pasted.md:')), warns.join('\n'));
  assert.ok(warns.some((w) => w.includes(`hook blocked ${dsn}:`)), warns.join('\n'));
});
