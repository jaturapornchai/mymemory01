// Lint check: active facts that name a file path no longer in that fact's project repo (report only).
// pathRefs is pure; the report part needs the memhub-pg container (throwaway schema) + a temp git repo as the project.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-lintpaths-'));
const SCHEMA = `memhub_lintpaths_test_${process.pid}`;
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMHUB_MEMORY_VAULT = join(tmp, 'vault');
process.env.MEMHUB_VAULTS = '';
process.env.MEMHUB_NO_REINDEX = '1';
process.env.MEMORY_HUB_INTERNAL = '1';
const { connect, ROOT } = await import('../src/db.ts');
const { indexFile } = await import('../src/importer.ts');
const { md5, writeNote } = await import('../src/notes.ts');
const { indexVault } = await import('../src/obsidian.ts');
const { commitBatch } = await import('../src/vault-git.ts');
const { lintReport, lintSummary, pathRefs, renderLint } = await import('../src/lint.ts');

const db = connect('rw');
const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
const repo = join(tmp, 'repo');
const REPO = norm(repo);

test('pathRefs: accepts paths of the project', () => {
  const R = 'd:/memoryhub';
  assert.deepEqual(pathRefs('see `src/lint.ts` and `scripts\\serve.cmd`', R), ['src/lint.ts', 'scripts/serve.cmd']);
  assert.deepEqual(pathRefs('`src/dream.ts:428` `src/a.ts:10-20`', R), ['src/dream.ts', 'src/a.ts']);
  assert.deepEqual(pathRefs('`D:\\MemoryHub\\src\\x.ts` and `d:/memoryhub/y.ts:3`', R), ['src/x.ts', 'y.ts']);
  assert.deepEqual(pathRefs('`src/lint.ts` again `src/lint.ts`', R), ['src/lint.ts']);
});

test('pathRefs: rejects what is no repo file', () => {
  const R = 'd:/memoryhub';
  for (const s of ['lint.ts', 'https://a.com/x/y.ts', 'src/*.ts', 'src/{a,b}.ts', 'src/a?.ts', 'my dir/a.ts', '~/x/y.md', '../x/y.ts', 'a/../b.ts',
    'node_modules/a/b.js', 'tmp/x/y.json', 'logs/a.log', 'dist/a.js', '.git/config.x', 'd:/other/src/a.ts', '/usr/lib/a.so', 'src/folder', 'use the src/lib thing', 'Menu.cpp/.h', 'web/.env'])
    assert.deepEqual(pathRefs(`x \`${s}\` y`, R), [], s);
  assert.deepEqual(pathRefs('src/lint.ts without backticks', R), []);
});

before(async () => {
  mkdirSync(join(repo, 'pkg', 'app', 'src'), { recursive: true });mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'present.ts'), 'x');
  writeFileSync(join(repo, 'pkg', 'app', 'src', 'nested.ts'), 'x');
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', ...a], { cwd: repo, stdio: 'ignore' });
  git('init');
  git('add', '.');
  git('commit', '-m', 'init');
  writeFileSync(join(repo, 'src', 'old-helper.ts'), 'x'); // tracked once, then removed by a commit
  git('add', '.');
  git('commit', '-m', 'add');
  git('branch', 'old'); // an older branch still has it: the checked-out branch removed it, so it is gone
  git('rm', 'src/old-helper.ts');
  git('commit', '-m', 'remove');
  git('checkout', '-b', 'other'); // a file that lives only at the tip of a branch not checked out here
  writeFileSync(join(repo, 'src', 'on-branch.ts'), 'x');
  git('add', '.');
  git('commit', '-m', 'branch');
  git('checkout', '-');
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  const sid = 'cccc3333-0000-0000-0000-000000000000';
  mkdirSync(join(tmp, 'proj'), { recursive: true });
  const jsonl = join(tmp, 'proj', `${sid}.jsonl`);
  writeFileSync(jsonl, JSON.stringify({ type: 'user', uuid: 'cccc-u0', sessionId: sid, timestamp: '2026-09-20T00:00:00Z', cwd: repo, message: { role: 'user', content: 'x' } }) + '\n');
  await indexFile(db, jsonl);
  const fact = (id: string, text: string, project = REPO) => writeNote(`facts/demo/F0000${id} t.md`, { memhub: 'fact', id: `F0000${id}`, kind: 'fact',
    scope: 'project', project, status: 'active', run: 'r1', source_uuids: ['cccc-u0'], md5: md5(text), valid_at: '2026-09-20T00:00:00.000Z',
    created_at: '2026-09-21T00:00:00.000Z' }, `${text}\n`);
  fact('p01', 'the helper lives in `src/present.ts` now');
  fact('p02', 'the helper lives in `src/absent.ts` and `src/also-absent.ts`');
  fact('p03', 'the helper lives in `src/nested.ts` somewhere deeper');
  fact('p04', 'we dropped `src/absent2.ts` last week, ลบแล้ว');
  fact('p05', 'the helper lives in `src/absent3.ts`', 'd:/definitely-not-here-xyz');
  fact('p06', 'a fact about `src/absent4.ts` with no project', '');
  fact('p07', 'the helper lives in `src/on-branch.ts` on the other branch');
  fact('p08', 'the helper lives in `src/old-helper.ts` as before');
  commitBatch(join(tmp, 'vault'), 'facts');
  await indexVault(db, join(tmp, 'vault'));
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('lint report: names a missing file once per fact, nothing else', async () => {
  const r = await lintReport(db, new Date('2026-10-04T00:00:00Z'));
  // a file git removed comes first (certain); a file at the tip of another branch is not missing
  assert.deepEqual(r.gone.map((x) => [x.fid, x.path, x.deleted]), [['F0000p08', 'src/old-helper.ts', true], ['F0000p02', 'src/absent.ts', false]]);
  const md = renderLint(r, new Date('2026-10-04T00:00:00Z'));
  assert.match(md, /อ้างไฟล์ที่ไม่มีแล้ว 2\n/);
  assert.match(md, /### [^\n]*\n- \[\[F0000p08 t\]\] · ไม่พบ `src\/old-helper\.ts` · เคยอยู่ใน git แล้วถูกลบ\n- \[\[F0000p02 t\]\] · ไม่พบ `src\/absent\.ts` · ไม่เคยอยู่ใน git\n/);
});

test('lintSummary: count only when there is one', async () => {
  const r = await lintReport(db, new Date('2026-10-04T00:00:00Z'));
  assert.match(lintSummary(r), / · อ้างไฟล์ที่ไม่มีแล้ว 2$/);
  assert.doesNotMatch(lintSummary({ ...r, gone: [] }), /อ้างไฟล์/);
});
