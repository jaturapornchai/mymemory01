// Needs the memhub-pg container. Runs in a throwaway schema so the real index is untouched.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCHEMA = `memhub_test_${process.pid}`; // per run: a concurrent run must never drop our schema (writes would fall through to public)
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
const { connect, ROOT } = await import('../src/db.ts');
const { indexFile } = await import('../src/importer.ts');
const { search, refreshTermDf } = await import('../src/search.ts');

const db = connect('rw');
const dir = mkdtempSync(join(tmpdir(), 'memhub-'));
const main = join(dir, 'proj', 'sess-1.jsonl');
const sub = join(dir, 'proj', 'sess-1', 'subagents', 'agent-x.jsonl');
let n = 0;
const line = (type: 'user' | 'assistant', content: unknown, extra = {}) =>
  JSON.stringify({ type, uuid: `u${++n}`, parentUuid: n > 1 ? `u${n - 1}` : null, sessionId: 'sess-1',
    timestamp: `2026-09-${String(10 + (n % 15)).padStart(2, '0')}T10:00:00Z`, cwd: 'D:\\demo', message: { role: type, content }, ...extra }) + '\n';
const say = (t: string) => line('assistant', [{ type: 'text', text: t }]);

const DOCS = [
  'ลุงจืดต้องยื่นแบบ ภ.ง.ด.53 ทุกเดือนภายในวันที่15',
  'ระบบความจำของ Claude ต้องค้นภาษาไทยได้เร็ว',
  'memory_search returns short snippets with ids to save tokens',
  'ตั้งค่า cleanupPeriodDays เป็น 3650 เพื่อไม่ให้ transcript หาย',
  'การจำแนกประเภทความจำ ไม่เกี่ยวกับภาษี',
];

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  mkdirSync(join(dir, 'proj', 'sess-1', 'subagents'), { recursive: true });
  let body = '';
  for (const d of DOCS) body += line('user', `เรื่อง ${n}`) + say(d);
  body += line('user', 'secret test PGPASSWORD=Sup3rS3cretValue and <private>ลูกค้าลับ 0812345678</private> ok');
  body += line('user', 'skill body', { isMeta: true });
  body += line('assistant', [{ type: 'thinking', thinking: 'hidden thoughts' }]);
  body += 'not json at all\n' + JSON.stringify({ type: 'brand-new-type', foo: 1 }) + '\n';
  writeFileSync(main, body);
  writeFileSync(sub, line('user', 'subagent task: ตรวจ redaction') + say('step 1 [Bash] ls') + say('subagent final: ผ่านหมดแล้ว'));
});

after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(dir, { recursive: true, force: true });
});

const count = async () => (await db.query('SELECT (SELECT count(*) FROM turns)::int t, (SELECT count(*) FROM chunks)::int c')).rows[0];

test('import is idempotent and incremental', async () => {
  assert.equal(await indexFile(db, main), 'indexed');
  assert.equal(await indexFile(db, sub), 'indexed');
  const first = await count();
  assert.equal(await indexFile(db, main), 'skip');
  assert.deepEqual(await count(), first);
  assert.equal(await indexFile(db, main, true), 'indexed'); // forced re-import → still no duplicates
  assert.deepEqual(await count(), first);
  appendFileSync(main, line('user', 'คำถามใหม่ที่ต่อท้าย') + say('คำตอบใหม่'));
  assert.equal(await indexFile(db, main), 'indexed');
  const after = await count();
  assert.equal(after.t, first.t + 2);
  assert.ok(after.c > first.c);
  await refreshTermDf(db);
});

test('meta, thinking, junk lines and subagent steps are not indexed', async () => {
  const all = (await db.query("SELECT string_agg(text_redacted, ' ') s FROM turns")).rows[0].s as string;
  for (const bad of ['skill body', 'hidden thoughts', 'brand-new-type', 'step 1']) assert.ok(!all.includes(bad), bad);
  assert.ok(all.includes('[subagent task]') && all.includes('subagent final'));
});

test('secrets and <private> never reach the DB', async () => {
  const r = (await db.query(`SELECT
    (SELECT count(*) FROM turns WHERE text_redacted LIKE '%Sup3rS3cret%' OR text_redacted LIKE '%0812345678%')::int t,
    (SELECT count(*) FROM chunks WHERE text LIKE '%Sup3rS3cret%' OR text LIKE '%0812345678%' OR words::text LIKE '%sup3rs3cret%')::int c`)).rows[0];
  assert.deepEqual(r, { t: 0, c: 0 });
});

const EXPECT: [string, number[]][] = [
  ['ความจำ', [1, 4]],
  ['ภ.ง.ด.53', [0]],
  ['ภงด 53', [0]],
  ['วันที่ 15', [0]],
  ['transcript หาย', [3]],
  ['snippets ids', [2]],
  ['ภาษี', [4, 0]],
  ['ภาษี เมื่อวาน', [4, 0]], // a time phrase only boosts: nothing here is from yesterday, nothing is filtered out
  ['ค้นภาษาไทย', [1]],
  ['cleanupPeriodDays', [3]],
];

for (const [q, ok] of EXPECT) {
  test(`search "${q}" → top hit is doc ${ok.join('/')}`, async () => {
    const { hits } = await search(db, q);
    assert.ok(hits.length, 'no hits');
    assert.ok(ok.some((i) => hits[0].text.includes(DOCS[i])), `top: ${hits[0].text.slice(0, 80)}`);
  });
}

test('project = repo root: worktrees and subdirs map to the main repo; cwd-less subagents inherit the parent session', async () => {
  const { normProject } = await import('../src/importer.ts');
  const repo = join(dir, 'Repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const want = repo.replace(/\\/g, '/').toLowerCase();
  assert.equal(normProject(join(repo, 'backend', 'internal')), want);
  assert.equal(normProject(join(repo, '.claude', 'worktrees', 'epic-x', 'src')), want);
  assert.equal(normProject('D:\\no-such-dir\\sub'), 'd:/no-such-dir/sub');

  const wf = join(dir, 'proj', 'sess-1', 'subagents', 'agent-nocwd.jsonl');
  writeFileSync(wf, [['user', 'workflow task: ตรวจ journal'], ['assistant', [{ type: 'text', text: 'journal final: ok' }]]]
    .map(([type, content], i) => JSON.stringify({ type, uuid: `w${i}`, parentUuid: null, timestamp: '2026-09-20T10:00:00Z', message: { role: type, content } })).join('\n') + '\n');
  await indexFile(db, main);
  await indexFile(db, wf);
  const r = (await db.query('SELECT session_id, project FROM sources WHERE path = $1', [wf])).rows[0];
  assert.deepEqual(r, { session_id: 'sess-1', project: 'd:/demo' });
});

test('a transcript that repeats a line (same uuid) imports: the first copy is the turn', async () => {
  const f = join(dir, 'proj', 'sess-dupuuid.jsonl');
  const a = say('dup answer uuidtwice');
  writeFileSync(f, line('user', 'dup question uuidtwice') + a + line('user', 'next question uuidtwice') + a);
  assert.equal(await indexFile(db, f), 'indexed');
  const rows = (await db.query(`SELECT t.seq FROM turns t JOIN sources s ON s.id = t.source_id WHERE s.path = $1 ORDER BY t.seq`, [f])).rows;
  assert.deepEqual(rows.map((r) => r.seq), [0, 1, 2]);
});

test('a changed parser that drops a turn mid-file keeps turns numbered like the chunks on the next append', async () => {
  const f = join(dir, 'proj', 'sess-renum.jsonl');
  const ls = [line('user', 'alpha question renum'), say('alpha answer renum'), line('user', 'beta question renum'), say('beta answer renum')];
  writeFileSync(f, ls.join(''));
  await indexFile(db, f);
  // line 3 now parses to nothing (as the interrupt marker does after the fix) and the file grew: no replace
  writeFileSync(f, ls[0] + ls[1] + ls[2].replace('{"type":"user"', '{"isMeta":true,"type":"user"') + ls[3] + say('gamma answer renum'));
  assert.equal(await indexFile(db, f), 'indexed');
  const rows = (await db.query(`SELECT t.seq, t.text_redacted FROM turns t JOIN sources s ON s.id = t.source_id
    WHERE s.path = $1 ORDER BY t.seq`, [f])).rows;
  assert.deepEqual(rows.map((r) => [r.seq, r.text_redacted]),
    [[0, 'alpha question renum'], [1, 'alpha answer renum'], [2, 'beta answer renum'], [3, 'gamma answer renum']]);
});
