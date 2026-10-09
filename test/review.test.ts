// Adversarial review of tonight's three tracks (hygiene + daily + search-api, applied together with until = $21).
// Each test states the property that SHOULD hold; a failing test = a real defect. Throwaway schema + temp vault.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-review-'));
const SCHEMA = `memhub_review_test_${process.pid}`;
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMHUB_MEMORY_VAULT = join(tmp, 'vault');
process.env.MEMHUB_VAULTS = '';
process.env.MEMHUB_NO_REINDEX = '1';
process.env.MEMORY_HUB_INTERNAL = '1';
const { connect, ROOT } = await import('../src/db.ts');
const { store, forget } = await import('../src/importer.ts');
const { md5, MEMORY_VAULT, writeNote } = await import('../src/notes.ts');
const { indexVault } = await import('../src/obsidian.ts');
const { commitBatch } = await import('../src/vault-git.ts');
const { search } = await import('../src/search.ts');
const { writeDaily } = await import('../src/daily.ts');
const { lintReport } = await import('../src/lint.ts');

const db = connect('rw');
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing');
const bkk = (day: string, hm: string) => new Date(`${day}T${hm}:00+07:00`).toISOString();
async function chat(sid: string, project: string, turns: [ts: string, text: string][], hideAs?: string) {
  await guard();
  await store(db, { tool: 'claude', path: join(tmp, 'raw', `${sid}.jsonl`), kind: 'main', sessionId: sid, project, size: 1, mtimeMs: 1, sha256: sid,
    label: project, replace: true, hideAs }, turns.map(([ts, text], i) => ({ uuid: `${sid}-u${i}`, parentUuid: null, seq: i, role: 'user', ts, text })));
}
/** A dream-written note (run set, body_sha matches = machine-owned file). */
function dreamNote(rel: string, id: string, kind: string, uuids: string[], text: string, extra: Record<string, string> = {}) {
  writeNote(rel, { memhub: 'fact', id, kind, scope: 'project', project: 'd:/demo', status: 'active', run: 'r1', source_uuids: uuids,
    md5: md5(text), valid_at: '2026-09-20T00:00:00.000Z', created_at: '2026-09-21T00:00:00.000Z', ...extra }, `${text}\n`);
}
const ids = (hits: { session_id: string }[]) => [...new Set(hits.map((h) => h.session_id))].sort();

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('hygiene: forget must not delete+tombstone a dream rule ลุงจืด restated in another chat (NOOP never adds provenance to owned facts)', async () => {
  const RULE = 'ห้ามใช้ float กับตัวเลขบัญชี';
  await chat('r-s1', 'd:/demo', [[bkk('2026-09-01', '10:00'), `กฎ: ${RULE}`]]);
  await chat('r-s2', 'd:/demo', [[bkk('2026-09-15', '10:00'), `ย้ำอีกที ${RULE}`]]); // same rule, later chat: dream.ts NOOP skips owned targets
  const rel = `facts/demo/F0000r01 ${RULE}.md`;
  dreamNote(rel, 'F0000r01', 'rule', ['r-s1-u0'], RULE);
  commitBatch(MEMORY_VAULT, 'dream r1: +1 ADD');
  await indexVault(db, MEMORY_VAULT);
  assert.equal((await db.query(`SELECT user_owned FROM facts WHERE fid = 'F0000r01'`)).rows[0].user_owned, true, 'a rule is user-owned in the index');
  await forget(db, 'session', 'r-s1');
  const tomb = (await db.query(`SELECT 1 FROM forgotten WHERE key = $1`, [`fact:${md5(RULE)}`])).rowCount;
  assert.ok(existsSync(join(MEMORY_VAULT, rel)) && !tomb,
    `rule note deleted=${!existsSync(join(MEMORY_VAULT, rel))}, tombstoned=${!!tomb}: a user-owned rule still stated in r-s2 must go to _review, not be deleted for good`);
});

test('daily × hygiene: forget --session must not leave the forgotten chat quoted (and searchable by every app) in its daily note', async () => {
  await chat('f-s1', 'd:/demo', [[bkk('2026-10-01', '10:00'), 'โปรเจกต์ลับ ZZFORGETME ห้ามใครรู้']]);
  assert.equal(await writeDaily(db, '2026-10-01'), 'written');
  await indexVault(db, MEMORY_VAULT);
  const path = join(MEMORY_VAULT, 'daily', '2026-10-01.md');
  assert.match(readFileSync(path, 'utf8'), /ZZFORGETME/);
  await forget(db, 'session', 'f-s1');
  await indexVault(db, MEMORY_VAULT); // the next hourly sync
  const { hits } = await search(db, 'ZZFORGETME', { semantic: false, limit: 8 }); // non-Claude caller (showPrivate unset)
  const quoted = existsSync(path) && readFileSync(path, 'utf8').includes('ZZFORGETME'); // nothing else that day → no note at all
  assert.ok(!quoted && !hits.length, `after forget: daily note still quotes it=${quoted}, search hits=${hits.map((h) => h.session_id).join(',')}`);
});

test('hygiene × lint: forget drops the retired note from the older sections of hubs/_lint.md (kept KEEP days)', async () => {
  const { runLint } = await import('../src/lint.ts');
  await chat('l-s1', 'd:/demo', [[bkk('2026-09-02', '10:00'), 'ZZLINTGONE']]);
  dreamNote('facts/demo/F0000l01 ZZLINTGONE ended.md', 'F0000l01', 'fact', ['l-s1-u0'], 'ZZLINTGONE ended', { invalid_at: '2026-09-03T00:00:00.000Z' });
  commitBatch(MEMORY_VAULT, 'dream r1: +1 ADD');
  await indexVault(db, MEMORY_VAULT);
  await runLint(db, { now: new Date('2026-10-03T00:00:00Z') });
  const lint = join(MEMORY_VAULT, 'hubs', '_lint.md');
  assert.match(readFileSync(lint, 'utf8'), /\[\[F0000l01 ZZLINTGONE ended\]\]/);
  assert.deepEqual((await forget(db, 'session', 'l-s1')).retired, ['F0000l01 F0000l01 ZZLINTGONE ended']);
  assert.doesNotMatch(readFileSync(lint, 'utf8'), /ZZLINTGONE/);
});

test('daily × hygiene: forget --project must also drop the SessionStart injection log of that project', async () => {
  await chat('i-s1', 'd:/secretproj', [[bkk('2026-09-03', '10:00'), 'งานลูกค้า']]);
  await db.query(`INSERT INTO injections (client, project, session, ids, chars) VALUES ('codex', 'd:/secretproj', 'i-s2', ARRAY['session:i-s1'], 100)`);
  await forget(db, 'project', 'd:/secretproj');
  const left = (await db.query(`SELECT count(*)::int n FROM injections WHERE project = 'd:/secretproj' OR 'session:i-s1' = ANY(ids)`)).rows[0].n;
  assert.equal(left, 0, 'forgotten project path / session id still stored in injections');
});

test('search-api: a date-only since/until range is ลุงจืด\'s day (Asia/Bangkok, like timeWindow and the daily note), not the UTC day', async () => {
  await chat('d-early', 'd:/range', [[bkk('2026-09-10', '06:30'), 'ZZRANGE ตอนเช้ามืด']]); // 2026-09-09T23:30Z
  await chat('d-mid', 'd:/range', [[bkk('2026-09-10', '12:00'), 'ZZRANGE ตอนเที่ยง']]);
  await chat('d-late', 'd:/range', [[bkk('2026-09-11', '02:00'), 'ZZRANGE ตีสองวันถัดไป']]); // 2026-09-10T19:00Z
  const { hits } = await search(db, 'ZZRANGE', { semantic: false, limit: 8, since: '2026-09-10', until: '2026-09-10' });
  assert.deepEqual(ids(hits), ['d-early', 'd-mid'], 'since=until=2026-09-10 should be 10 Sep 00:00–24:00 Bangkok');
});

test('hygiene: forget --project rerun after an earlier (pre-cascade or crashed) forget still retires its facts', { todo: "not fixed: project forget finds facts only through the sources it deletes now; lint lists the leftovers as orphans" }, async () => {
  await chat('p-s1', 'd:/oldproj', [[bkk('2026-09-04', '10:00'), 'เรื่องเก่า']]);
  const rel = 'facts/oldproj/F0000p01 old.md';
  dreamNote(rel, 'F0000p01', 'fact', ['p-s1-u0'], 'old project fact', { project: 'd:/oldproj' });
  commitBatch(MEMORY_VAULT, 'dream r1: +1 ADD');
  await indexVault(db, MEMORY_VAULT);
  // what forget did before the cascade (or a crash right after its DELETE)
  await db.query(`INSERT INTO forgotten (key) VALUES ('project:d:/oldproj'); DELETE FROM sources WHERE starts_with(project, 'd:/oldproj')`);
  const r = await forget(db, 'project', 'd:/oldproj');
  assert.deepEqual(r.retired, ['F0000p01 F0000p01 old'], 'CHANGES: "session_ids also finds facts of a session forgotten before this cascade existed (or a crashed run)"');
});

test('hygiene: forget --project d:/app must not cascade into d:/app2 (starts_with has no path boundary; now it deletes vault notes too)', async () => {
  await chat('b-s1', 'd:/app', [[bkk('2026-09-07', '10:00'), 'งาน app']]);
  await chat('b-s2', 'd:/app2', [[bkk('2026-09-07', '11:00'), 'งาน app2 คนละโปรเจกต์']]);
  const rel = 'facts/app2/F0000b02 app2 fact.md';
  dreamNote(rel, 'F0000b02', 'fact', ['b-s2-u0'], 'app2 fact', { project: 'd:/app2' });
  commitBatch(MEMORY_VAULT, 'dream r1: +1 ADD');
  await indexVault(db, MEMORY_VAULT);
  const r = await forget(db, 'project', 'd:/app');
  assert.ok(existsSync(join(MEMORY_VAULT, rel)) && r.sources === 1,
    `forget d:/app removed ${r.sources} sources and retired [${r.retired.join(', ')}] (d:/app2's note deleted=${!existsSync(join(MEMORY_VAULT, rel))})`);
});

test('daily: an unreadable Timeline export (EISDIR / EBUSY / EPERM) must not throw: hourly sync calls dataAgeDays before it indexes', async () => {
  const { dataAgeDays } = await import('../src/tools/google-timeline.ts');
  const dir = join(tmp, 'gt');
  mkdirSync(join(dir, 'timeline.json'), { recursive: true }); // readFileSync → EISDIR, like a locked file → EBUSY
  assert.equal(dataAgeDays(dir), null);
});

test('hygiene lint: a fact distilled from a chat later hidden (Google seen) must stay out of hubs/_lint.md, like daily.ts does', async () => {
  await chat('g-s1', 'd:/demo', [[bkk('2026-09-05', '10:00'), 'ZZHIDDENFACT']], 'google');
  dreamNote('facts/demo/F0000g01 ZZHIDDENFACT expired.md', 'F0000g01', 'fact', ['g-s1-u0'], 'ZZHIDDENFACT expired', { invalid_at: '2026-09-06T00:00:00.000Z' });
  commitBatch(MEMORY_VAULT, 'dream r1: +1 ADD');
  await indexVault(db, MEMORY_VAULT);
  const r = await lintReport(db, new Date('2026-10-04T00:00:00Z'));
  assert.ok(!r.expired.some((x) => String(x.path).includes('ZZHIDDENFACT')), 'lint lists a fact whose only source chat is hide_as=google');
});

test('a fact is dated by the chat it came from (since/until, age, recency), not by its file; memory_save by when he said it', async () => {
  await chat('dt-s1', 'd:/demo', [[bkk('2026-08-02', '10:00'), 'ZZDATED เริ่มคุย'], [bkk('2026-08-03', '09:00'), 'ZZDATED ตกลงใช้ท่าแรก']]);
  dreamNote('facts/demo/F0000d01 dated.md', 'F0000d01', 'decision', ['dt-s1-u1', 'dt-s1-u0'], 'ZZDATED ตัดสินใจใช้ท่าแรก');
  writeNote('facts/demo/F0000d02 saved.md', { memhub: 'fact', id: 'F0000d02', kind: 'fact', scope: 'project', project: 'd:/demo', status: 'active',
    source_uuids: ['obs:self'], md5: md5('ZZDATED จำไว้'), valid_at: '2026-08-05T00:00:00.000Z', created_at: '2026-08-05T03:00:00.000Z' }, 'ZZDATED จำไว้\n');
  commitBatch(MEMORY_VAULT, 'dream r1: dated');
  await indexVault(db, MEMORY_VAULT);
  const ts = async (fid: string) => (await db.query(`SELECT c.ts FROM facts f JOIN chunks c ON c.source_id = f.source_id WHERE f.fid = $1`, [fid])).rows[0].ts.toISOString();
  assert.equal(await ts('F0000d01'), bkk('2026-08-02', '10:00'), 'its earliest cited turn, not the file written today');
  assert.equal(await ts('F0000d02'), '2026-08-05T03:00:00.000Z', 'memory_save cites its own note: created_at');
  const { hits } = await search(db, 'ZZDATED', { semantic: false, limit: 8, since: '2026-08-01', until: '2026-08-31' });
  assert.ok(hits.some((h) => h.fid === 'F0000d01') && hits.some((h) => h.fid === 'F0000d02'), 'an August range finds both facts written in October');
});
