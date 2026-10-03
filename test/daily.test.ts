// Daily activity note (daily.ts): one local day per project — apps, sessions, first/last time, topics (card title, else first
// prompt), GitHub, facts created/superseded, handoffs — with nothing Claude-only and no place; the vault write keeps ลุงจืด's
// edit, commits via vault-git, and the note ranks below the chats it lists. Own throwaway schema + temp vault, keyword-only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-daily-'));
const SCHEMA = `memhub_daily_test_${process.pid}`;
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMHUB_MEMORY_VAULT = join(tmp, 'vault');
process.env.MEMHUB_VAULTS = '';
process.env.MEMHUB_NO_REINDEX = '1';
const { connect, ROOT } = await import('../src/db.ts');
const { store } = await import('../src/importer.ts');
const { writeNote, MEMORY_VAULT } = await import('../src/notes.ts');
const { indexVault } = await import('../src/obsidian.ts');
const { search, hitLine } = await import('../src/search.ts');
const { dailyNote, writeDaily, placeGuard, yesterday } = await import('../src/daily.ts');
const { commitBatch, kindOf } = await import('../src/vault-git.ts');

const db = connect('rw');
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');
const D = '2026-10-01'; // a Thursday
const at = (hm: string, day = D) => new Date(`${day}T${hm}:00+07:00`).toISOString();
type T = [role: 'user' | 'assistant' | 'note', ts: string, text: string, uuid?: string];
async function sess(tool: string, sid: string, project: string, kind: string, turns: T[], hideAs?: string) {
  await guard();
  await store(db, { tool, path: join(tmp, 'raw', tool, `${sid}.jsonl`), kind, sessionId: sid, project, size: 1, mtimeMs: 1, sha256: sid,
    label: project, replace: true, hideAs }, turns.map(([role, ts, text, uuid], i) => ({ uuid: uuid ?? `${sid}-u${i}`, parentUuid: null, seq: i, role, ts, text })));
}
const fact = (rel: string, fm: Record<string, string | string[]>, body: string) =>
  writeNote(rel, { memhub: 'fact', kind: 'fact', scope: 'project', project: 'd:/proj-a', status: 'active', importance: '5', source_uuids: [`${fm.id}-src`], run: 'r1', ...fm }, body);
const vaultGit = (...a: string[]) => execFileSync('git', ['-c', 'core.quotePath=false', ...a], { cwd: MEMORY_VAULT, encoding: 'utf8' }).trim();

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  await sess('claude', 'c1', 'd:/proj-a', 'main', [['user', at('09:00'), 'แก้บั๊ก login หน้าแรก'], ['assistant', at('11:00'), 'done']]);
  await sess('codex', 'x1', 'd:/proj-a', 'main', [['user', at('14:00'), '[automation] tick'], ['user', at('14:01'), 'ทำ README ภาษาไทย [[ลิงก์]] #tag'],
    ['assistant', at('14:30'), 'ok']]);
  await sess('codex', 'x2', 'd:/proj-a', 'headless', [['user', at('15:00'), 'scripted run']]);
  await sess('claude', 'h1', 'd:/proj-a', 'main', [['user', at('16:00'), 'SECRETHIDDEN ask']], 'google-timeline'); // shown a Timeline hit
  await sess('zcode', 'z1', 'd:/proj-b', 'main', [['user', at('20:00'), 'ผมไปนราธิวาสล่าสุดเมื่อไหร่']]);
  await sess('claude', 'p1', 'd:/proj-a', 'main', [['user', at('23:30'), 'ดึก งานสุดท้าย']]);
  await sess('claude', 'n1', 'd:/proj-a', 'main', [['user', at('00:10', '2026-10-02'), 'NEXTDAY only']]);
  await sess('github', 'github:me/proj-a:commits', 'd:/proj-a', 'doc', [['user', at('10:00'), '[commit abc1234] fix login\n\nlong body']]);
  await sess('github', 'github:me/trip:commits', 'd:/นราธิวาส', 'doc', [['user', at('21:00'), '[commit def5678] init']]); // a folder named after a place
  await sess('github', 'github:me/proj-a#7', 'd:/proj-a', 'doc', [['user', at('10:30'), '[issue #7] login broken (open)\nsteps']]);
  await sess('google-timeline', 'google-timeline', 'google/timeline', 'doc', [
    ['note', `${D}T00:00:00.000Z`, 'ไปนราธิวาสเมื่อไหร่ · เคยไปนราธิวาสไหม\nเคยไป นราธิวาส (Narathiwat) 1 ครั้ง: 1 ต.ค.', 'google-timeline:place:TH.31'],
    ['note', `${D}T00:00:00.000Z`, 'Google Maps Timeline พฤ. 1 ต.ค. 2026\n09:00–12:00 3ชม. อ.ตากใบ จ.นราธิวาส', `google-timeline:day:${D}`]]);
  writeNote('sessions/2026-10/2026-10-01 proj-a c1c1c1c1.md', { memhub: 'card', id: 'Sc1c1c1c1', project: 'd:/proj-a', session: 'c1', tool: 'claude',
    status: 'active', valid_at: at('09:00'), created_at: at('03:30', '2026-10-02'), source_uuids: ['c1-u0'], run: 'r1' }, '# แก้บั๊ก login\n\nสรุป: แก้ redirect\n');
  fact('facts/proj-a/F11111111 ใช้ Postgres 5441.md', { id: 'F11111111', created_at: at('12:00') }, 'ใช้ Postgres 5441\n');
  fact('facts/proj-a/F22222222 ใช้ Postgres 5432.md', { id: 'F22222222', created_at: at('09:00', '2026-09-20'), status: 'superseded',
    superseded_by: 'F11111111', expired_at: at('13:00') }, 'ใช้ Postgres 5432\n');
  fact('facts/proj-a/F33333333 ทริปนราธิวาส 3 วัน.md', { id: 'F33333333', created_at: at('12:05') }, 'ทริปนราธิวาส 3 วัน\n'); // memory_save'd from a Timeline answer
  fact('facts/proj-a/F44444444 older fact.md', { id: 'F44444444', created_at: at('12:00', '2026-09-30') }, 'older fact\n');
  commitBatch(MEMORY_VAULT, 'test seed');
  await indexVault(db, MEMORY_VAULT);
  await db.query(`INSERT INTO handoffs (project, from_app, to_app, title, body, created_at) VALUES ('d:/proj-a', 'codex-mcp-client', 'claude', 'ต่อ README', 'next: x', $1)`, [at('17:00')]);
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('one day per project: apps + counts, first–last time, topics, GitHub, facts, handoffs (local Asia/Bangkok day)', async () => {
  const n = (await dailyNote(db, D))!;
  assert.equal(n.rel, `daily/${D}.md`);
  assert.deepEqual([n.fm.memhub, n.fm.date, n.fm.sessions, n.fm.valid_at], ['daily', D, '4', at('23:30')]); // c1 x1 z1 p1; last event 23:30
  const b = n.body;
  assert.match(b, /^# 2026-10-01 พฤ\.\n/);
  assert.ok(b.includes('\n## proj-a · 09:00–23:30 · claude 2 · codex 1 · codex exec 1\n'), b);
  assert.ok(b.includes('- 09:00 claude [[2026-10-01 proj-a c1c1c1c1|แก้บั๊ก login]]\n'), 'a carded session links its card, titled');
  assert.ok(b.includes('- 14:00 codex ทำ README ภาษาไทย ลิงก์ # tag\n'), 'first real prompt; no [[link]] or #tag of its own');
  assert.ok(b.includes('- 23:30 claude ดึก งานสุดท้าย\n'));
  assert.ok(b.includes('- commits 1: abc1234 fix login\n'));
  assert.ok(b.includes('- issue/PR: #7 login broken (open)\n'));
  assert.ok(b.includes('- ความจำใหม่ 2: [[F11111111 ใช้ Postgres 5441]] · +1 ([[proj-a hub]])\n'), 'the trip fact counts but is not named');
  assert.ok(b.includes('- ถูกแทนที่ 1: [[F22222222 ใช้ Postgres 5432]]\n'));
  assert.ok(b.includes('- ส่งต่องาน #1 codex-mcp-client → claude: (ส่งถึงแอปเดียว) (open)\n'), 'a targeted handoff: only claude may read its title');
  assert.ok(b.includes('\n## proj-b · 20:00–20:00 · zcode 1\n- 20:00 zcode (ซ่อน: สถานที่)\n'), 'a non-Claude chat asking about a trip: no place');
  assert.ok(b.indexOf('## proj-a') < b.indexOf('## proj-b'), 'projects in order of first activity');
  assert.ok(b.includes('\n## (ซ่อน: สถานที่)\n- commits 1: def5678 init\n'), 'a project folder named after a place: no name, no hub link');
  for (const no of ['SECRETHIDDEN', 'นราธิวาส', 'Narathiwat', 'ตากใบ', 'NEXTDAY', 'older fact', 'scripted run'])
    assert.ok(!b.toLowerCase().includes(no.toLowerCase()), `must not contain ${no}`);
  assert.equal(await dailyNote(db, '2026-09-01'), null, 'nothing that day → no note');
  await assert.rejects(dailyNote(db, '2026-13-45'), /not a date/);
  await assert.rejects(dailyNote(db, '2026-02-31'), /not a date/, 'no roll-over to March');
  await assert.rejects(dailyNote(db, "2026-10-01'; DROP TABLE x"), /not a date/);
  assert.match(yesterday(new Date('2026-10-02T20:00:00Z')), /^2026-10-02$/, 'yesterday in Bangkok: 03:00 on the 3rd → the 2nd');
});

test('place guard: every place the Timeline names (regions, districts, English labels), any country, trip words; everyday words pass', async () => {
  const ok = await placeGuard(db);
  for (const s of ['ไปนราธิวาสมา', 'Narathiwat', 'แถวตากใบมีอะไร', 'ไปไอซ์แลนด์ล่าสุด', 'Iceland', 'ทริปหน้า', 'ไปเที่ยวมา', 'my last trip', 'Google Timeline บอกว่า'])
    assert.equal(ok(s), false, s);
  for (const s of ['แก้บั๊ก login', 'เผยแพร่ขึ้น Vercel เลย', 'เช็กสถานะ', 'ภาษาไทย', 'timezone Asia/Bangkok', 'memory_timeline'])
    assert.equal(ok(s), true, s);
});

test('vault write: new → one "daily" commit; same again → unchanged; edited by ลุงจืด → kept; --out → preview only', async () => {
  const path = join(MEMORY_VAULT, 'daily', `${D}.md`);
  assert.equal(await writeDaily(db, D), 'written');
  assert.equal(vaultGit('log', '-n1', '--format=%s'), `daily ${D}`);
  assert.equal(kindOf(`daily ${D}`), 'daily');
  assert.deepEqual(vaultGit('show', '--name-only', '--format=', 'HEAD').split('\n'), [`daily/${D}.md`]);
  const commits = vaultGit('rev-list', '--count', 'HEAD');
  assert.equal(await writeDaily(db, D), 'unchanged');
  assert.equal(vaultGit('rev-list', '--count', 'HEAD'), commits, 'nothing new → no commit');
  const mine = readFileSync(path, 'utf8') + '\nโน้ตของลุงจืดเอง\n';
  writeFileSync(path, mine);
  assert.equal(await writeDaily(db, D), 'kept-user-edit');
  assert.equal(readFileSync(path, 'utf8'), mine, 'his edit is never overwritten');
  const out = join(tmp, 'preview');
  assert.equal(await writeDaily(db, '2026-10-01', out), join(out, `${D}.md`));
  assert.match(readFileSync(join(out, `${D}.md`), 'utf8'), /^---\nmemhub: daily\ndate: 2026-10-01\n[\s\S]*body_sha: \w{16}\n---\n# 2026-10-01/);
  assert.equal(readFileSync(path, 'utf8'), mine, '--out never touches the vault');
  assert.equal(await writeDaily(db, '2026-09-01'), 'empty');
  assert.ok(!existsSync(join(MEMORY_VAULT, 'daily', '2026-09-01.md')));
});

test('indexed as kind daily, dated by its day, ranked below the chats it lists, labelled "daily note"', async () => {
  await indexVault(db, MEMORY_VAULT);
  const src = (await db.query(`SELECT s.kind, min(c.ts) ts FROM sources s JOIN chunks c ON c.source_id = s.id WHERE s.session_id LIKE '%/daily/${D}.md' GROUP BY 1`)).rows;
  assert.deepEqual(src.map((r) => [r.kind, r.ts.toISOString()]), [['daily', at('23:30')]], 'not the file mtime (written at 03:30 the next day)');
  const { hits } = await search(db, 'README ภาษาไทย', { semantic: false, limit: 8, now: new Date(at('12:00', '2026-10-02')) });
  const chat = hits.findIndex((h) => h.session_id === 'x1'), daily = hits.findIndex((h) => h.src_kind === 'daily');
  assert.ok(chat >= 0 && daily >= 0 && chat < daily, `chat #${chat + 1} above daily note #${daily + 1}`);
  assert.match(hitLine(hits[daily]), / \| daily note/);
  const { briefLine } = await import('../src/mcp.ts'); // memory_search detail:"brief"
  assert.match(briefLine(hits[daily], 'README', new Map()), / daily note ≈/);
});

test('cli: daily <day> --out writes the preview; a bad date fails with a message', () => {
  const env = { ...process.env };
  const run = (...a: string[]) => spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'daily', ...a], { encoding: 'utf8', env });
  const out = join(tmp, 'cli-out');
  const r = run(D, '--out', out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `daily ${D}: ${join(out, `${D}.md`)}`);
  assert.ok(existsSync(join(out, `${D}.md`)));
  const bad = run('2026-02-31x');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /not a date/);
});
