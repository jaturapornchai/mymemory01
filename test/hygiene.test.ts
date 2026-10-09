// Vault hygiene: the forget cascade (facts/cards dreamed from a forgotten chat) and the nightly lint report.
// Needs the memhub-pg container; throwaway schema + temp vault (its local git included).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-hygiene-'));
const SCHEMA = `memhub_hygiene_test_${process.pid}`; // per run: a concurrent run must never drop our schema
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMHUB_MEMORY_VAULT = join(tmp, 'vault');
process.env.MEMHUB_VAULTS = '';
process.env.MEMHUB_NO_REINDEX = '1';
process.env.MEMORY_HUB_INTERNAL = '1';
const { connect, ROOT } = await import('../src/db.ts');
const { indexFile, forget } = await import('../src/importer.ts');
const { consolidate } = await import('../src/dream.ts');
const { md5, MEMORY_VAULT, parseNote, renderNote, writeNote } = await import('../src/notes.ts');
const { indexVault, resolveLinks } = await import('../src/obsidian.ts');
const { commitBatch } = await import('../src/vault-git.ts');
const { LINT_REL, lintReport, runLint } = await import('../src/lint.ts');

const db = connect('rw');
const A = 'aaaa1111-0000-0000-0000-000000000000', B = 'bbbb2222-0000-0000-0000-000000000000';

function session(id: string, cwd: string, said: string[]) {
  mkdirSync(join(tmp, 'proj'), { recursive: true });
  const path = join(tmp, 'proj', `${id}.jsonl`);
  writeFileSync(path, said.map((s, i) => JSON.stringify({ type: 'user', uuid: `${id.slice(0, 4)}-u${i}`, sessionId: id,
    timestamp: `2026-09-2${i}T00:00:00Z`, cwd, message: { role: 'user', content: s } }) + '\n').join(''));
  return path;
}
/** A dream-written note (machine-owned: body_sha matches). */
function note(rel: string, id: string, uuids: string[], extra: Record<string, string> = {}, text = `fact ${id} text`) {
  writeNote(rel, { memhub: rel.startsWith('sessions/') ? 'card' : 'fact', id, kind: rel.startsWith('sessions/') ? 'card' : 'fact', scope: 'project',
    project: 'd:/demo', status: 'active', run: 'r1', source_uuids: uuids, md5: md5(text), valid_at: '2026-09-20T00:00:00.000Z',
    created_at: '2026-09-21T00:00:00.000Z', ...extra }, `${text}\n`);
}
const file = (rel: string) => join(MEMORY_VAULT, rel);
const read = (rel: string) => readFileSync(file(rel), 'utf8');
const row = async (fid: string) => (await db.query('SELECT source_uuids, session_ids FROM facts WHERE fid = $1', [fid])).rows[0];
const git = (...a: string[]) => execFileSync('git', ['-c', 'core.quotePath=false', ...a], { cwd: MEMORY_VAULT, encoding: 'utf8' });

const SINGLE = 'facts/demo/F0000aaa single.md', MULTI = 'facts/demo/F0000bbb multi.md', EDITED = 'facts/demo/F0000ccc edited.md';
const CARD = 'sessions/2026-09/2026-09-20 demo aaaa1111.md', ONLY = 'facts/gone/F0000ddd only.md';

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  await indexFile(db, session(A, 'D:\\demo', ['คุยเรื่องลับที่อยากลืม', 'อีกเรื่อง']));
  await indexFile(db, session(B, 'D:\\demo', ['เรื่องที่ยังจำได้']));
  note(SINGLE, 'F0000aaa', ['aaaa-u0']);
  note(MULTI, 'F0000bbb', ['aaaa-u1', 'bbbb-u0']);
  note(EDITED, 'F0000ccc', ['aaaa-u0']);
  note(CARD, 'Saaaa1111', ['aaaa-u0', 'aaaa-u1'], { session: A });
  note(ONLY, 'F0000ddd', ['aaaa-u1'], { project: 'd:/gone' });
  commitBatch(MEMORY_VAULT, 'dream r1: +4 ADD, 0 UPDATE, 0 SUPERSEDE');
  const { fm, body } = parseNote(read(EDITED));
  writeFileSync(file(EDITED), renderNote(fm, `${body.trim()} — แก้เองโดยลุงจืด\n`)); // his edit: body no longer matches body_sha
  await indexVault(db, MEMORY_VAULT);
  await consolidate(db); // hubs for d:/demo and d:/gone
  commitBatch(MEMORY_VAULT, 'consolidate t');
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('forget --session: single-source fact + card retired, multi-source trimmed, edited note → _review, idempotent', async () => {
  assert.deepEqual((await row('F0000bbb')).session_ids.sort(), [A, B]);
  assert.ok(existsSync(file('hubs/gone hub.md')));
  const edited = read(EDITED);
  const r = await forget(db, 'session', A);
  assert.equal(r.sources, 1);
  assert.deepEqual(r.retired.sort(), ['F0000aaa F0000aaa single', 'F0000ddd F0000ddd only', 'Saaaa1111 2026-09-20 demo aaaa1111']);
  assert.deepEqual(r.trimmed, ['F0000bbb F0000bbb multi']);
  assert.deepEqual(r.review, ['F0000ccc F0000ccc edited']);

  // retired: file gone, index row gone, text tombstoned (a later dream never re-creates it); cards are never tombstoned
  for (const rel of [SINGLE, CARD, ONLY]) assert.ok(!existsSync(file(rel)), rel);
  assert.equal(await row('F0000aaa'), undefined);
  assert.equal(await row('Saaaa1111'), undefined);
  const tomb = (await db.query(`SELECT key FROM forgotten WHERE key LIKE 'fact:%' ORDER BY key`)).rows.map((x) => x.key);
  assert.deepEqual(tomb, [`fact:${md5('fact F0000aaa text')}`, `fact:${md5('fact F0000ddd text')}`].sort());
  // multi-source: stays, the forgotten session dropped from its provenance (file + index)
  assert.deepEqual(parseNote(read(MULTI)).fm.source_uuids, ['bbbb-u0']);
  assert.deepEqual(await row('F0000bbb'), { source_uuids: ['bbbb-u0'], session_ids: [B] });
  // edited: byte-for-byte untouched, still indexed (without the session), listed for ลุงจืด
  assert.equal(read(EDITED), edited);
  assert.deepEqual((await row('F0000ccc')).session_ids, []);
  const review = read('hubs/_review.md');
  assert.match(review, /## Forgotten chats, your notes[\s\S]*\[\[F0000ccc edited\]\]/);
  assert.doesNotMatch(review, /single|multi\]\]/);
  // a project left with no notes loses its hub (it listed the forgotten titles); one with notes keeps it, minus the retired ones
  assert.ok(!existsSync(file('hubs/gone hub.md')));
  assert.doesNotMatch(read('hubs/demo hub.md'), /F0000aaa|aaaa1111/);
  // vault history: one forget commit holding the deletions, not a "ลุงจืด แก้เอง" snapshot
  assert.match(git('log', '-1', '--format=%s'), /^forget session aaaa1111-0000-0000-0000-000000000000: -3 notes, 1 trimmed, 1 to review/);
  const changed = git('show', '--name-status', '--format=', 'HEAD');
  for (const rel of [SINGLE, CARD, ONLY, 'hubs/gone hub.md']) assert.match(changed, new RegExp(`^D\\t${rel.replace(/[.]/g, '[.]')}$`, 'm'));
  assert.equal(git('status', '--porcelain'), '');

  const again = await forget(db, 'session', A);
  assert.deepEqual(again, { sources: 0, retired: [], trimmed: [], review: [], daily: [] });
  assert.equal(read(EDITED), edited);
  assert.equal(read('hubs/_review.md'), review);
  assert.equal(git('status', '--porcelain'), '');
});

test('lint: expired, duplicate pair, orphan, broken link — private sources never listed', async () => {
  note('facts/demo/F0000eee old.md', 'F0000eee', ['bbbb-u0'], { invalid_at: '2026-09-01T00:00:00.000Z' });
  note('facts/demo/F0000f01 twin one.md', 'F0000f01', ['bbbb-u0'], {}, 'twin one');
  note('facts/demo/F0000f02 twin two.md', 'F0000f02', ['bbbb-u0'], {}, 'twin two');
  note('facts/demo/F0000f03 rule.md', 'F0000f03', ['bbbb-u0'], { kind: 'rule' }, 'twin three'); // same vector, other kind
  note('facts/demo/F0000f04 links.md', 'F0000f04', ['bbbb-u0'], {}, 'see [[F0000bbb multi]] and [[no such note]]');
  note('facts/demo/F0000f05 secret.md', 'F0000f05', ['bbbb-u0'], { invalid_at: '2026-09-01T00:00:00.000Z' }, 'from a mail');
  commitBatch(MEMORY_VAULT, 'dream r2');
  await indexVault(db, MEMORY_VAULT);
  await resolveLinks(db);
  const vec = (x: number) => `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : i === 1 ? x : 0)).join(',')}]`;
  await db.query(`UPDATE chunks c SET embedding = $1::halfvec FROM facts f WHERE f.source_id = c.source_id AND f.fid IN ('F0000f01', 'F0000f02', 'F0000f03')`, [vec(0)]);
  await db.query(`UPDATE chunks c SET embedding = $1::halfvec FROM facts f WHERE f.source_id = c.source_id AND f.fid = 'F0000bbb'`, [vec(1)]); // cos 0.71
  // a note that only Claude may see (hide_as): its expiry must not reach the vault / other apps
  await db.query(`UPDATE sources s SET hide_as = 'google' FROM facts f WHERE f.source_id = s.id AND f.fid = 'F0000f05'`);
  const NOW = new Date('2026-10-03T20:00:00Z'); // 2026-10-04 in Bangkok

  const r = await lintReport(db, NOW);
  assert.deepEqual(r.expired.map((x) => x.fid), ['F0000eee']);
  assert.deepEqual(r.dups.map((x) => [x.a, x.b]), [['F0000f01', 'F0000f02']]);
  assert.deepEqual(r.orphans.map((x) => x.fid), ['F0000ccc']); // the edited note whose chat was forgotten
  assert.deepEqual(r.broken.map((x) => x.dst_name), ['no such note']);

  const dry = await runLint(db, { dry: true, now: NOW });
  assert.match(dry, /^## 2026-10-04\nเลยวันหมดอายุ 1 · อาจซ้ำ 1 คู่ · แชตต้นทางหายหมด 1 · ลิงก์เสีย 1 · หลักฐานไม่ตรง \d+ · อาจขัดกัน \d+ · บอกว่าแทนแล้วแต่ของเก่ายัง active 0\n/);
  assert.match(dry, /\[\[F0000f01 twin one\]\] ≈ \[\[F0000f02 twin two\]\] · 1\.000/);
  assert.match(dry, /\[\[F0000f04 links\]\] → `no such note`/);
  assert.doesNotMatch(dry, /F0000f05|secret|from a mail/);
  assert.ok(!existsSync(file(LINT_REL)), 'dry writes nothing');

  assert.match(await runLint(db, { now: NOW }), /hubs\/_lint\.md written: เลยวันหมดอายุ 1/);
  await runLint(db, { now: NOW }); // same day again: replaces its section
  await runLint(db, { now: new Date('2026-10-05T01:00:00Z') });
  const lint = read(LINT_REL);
  assert.deepEqual([...lint.matchAll(/^## (\S+)$/gm)].map((m) => m[1]), ['2026-10-05', '2026-10-04']);
  assert.match(git('log', '-1', '--format=%s'), /^lint 2026-10-05: /);

  // ลุงจืด edited the lint note → never rewritten; the report goes to stdout (nightly.log) instead
  const { fm, body } = parseNote(lint);
  writeFileSync(file(LINT_REL), renderNote(fm, `${body}\nจดเอง\n`));
  const mine = read(LINT_REL);
  assert.match(await runLint(db, { now: new Date('2026-10-06T01:00:00Z') }), /edited by ลุงจืด: left alone[\s\S]*## 2026-10-06/);
  assert.equal(read(LINT_REL), mine);
});

test('forget --project: every chat under the path, its facts with it (edited one kept)', async () => {
  const ids = async () => (await db.query(`SELECT id FROM sources WHERE tool <> 'obsidian'`)).rows.map((x) => `source:${x.id}`); // notes get re-indexed
  const keys = (ks: string[]) => ks.flatMap((k) => [k, k + '@github', k + '@owner']).sort();
  const before = await ids();
  await db.query(`INSERT INTO state (k, v) VALUES ('layout', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [Object.fromEntries(keys(before).map((k) => [k, [1, 2, 3]]))]);
  const r = await forget(db, 'project', 'D:\\demo');
  assert.equal(r.sources, 1); // session B (A went in the first test)
  assert.deepEqual(Object.keys((await db.query(`SELECT v FROM state WHERE k = 'layout'`)).rows[0].v).filter((k) => keys(before).includes(k)).sort(), keys(await ids()),
    'its layout pins go in every mode (brain.ts: public @github, local @owner); the others stay');
  assert.ok(r.retired.includes('F0000bbb F0000bbb multi') && r.retired.includes('F0000f01 F0000f01 twin one'), r.retired.join());
  assert.deepEqual(r.trimmed, []);
  // F0000ccc no longer cites a live chat: nothing new to route. The dream-written rule is his (user_owned): reviewed, not deleted
  assert.deepEqual(r.review, ['F0000f03 F0000f03 rule']);
  assert.deepEqual((await db.query(`SELECT fid FROM facts WHERE kind <> 'card' ORDER BY fid`)).rows.map((x) => x.fid), ['F0000ccc', 'F0000f03']);
  assert.match(read('hubs/_review.md'), /## Forgotten chats, your notes[\s\S]*\[\[F0000f03 rule\]\]/);
  assert.ok(existsSync(file('hubs/demo hub.md'))); // the edited note keeps the project alive
});

test('prunePins: a source deleted outside forget (a removed note, a moved file) leaves both pin stores, every key form', async () => {
  const { prunePins } = await import('../src/layout.ts');
  const live = `source:${(await db.query(`SELECT id FROM sources ORDER BY id LIMIT 1`)).rows[0].id}`;
  const gone = `source:${(await db.query(`SELECT coalesce(max(id), 0) + 1000 id FROM sources`)).rows[0].id}`;
  const kept = [live, `${live}@owner`, 'project:d:/x', '#'];
  for (const k of ['layout', 'layout:semantic']) {
    await db.query(`INSERT INTO state (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
      [k, Object.fromEntries([...kept, gone, `${gone}@github`, `${gone}@owner`].map((x) => [x, [1, 2, 3]]))]);
  }
  assert.equal(await prunePins(db), 6);
  for (const k of ['layout', 'layout:semantic']) {
    assert.deepEqual(Object.keys((await db.query(`SELECT v FROM state WHERE k = $1`, [k])).rows[0].v).sort(), [...kept].sort(), k);
  }
  assert.equal(await prunePins(db), 0, 'nothing left to prune: no write');
});
