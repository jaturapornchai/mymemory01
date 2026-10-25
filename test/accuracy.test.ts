// accuracy.ts end to end (ลุงจืด 2026-10-18): conflict / stale / identity / alias flags, memory_save near-duplicate gate,
// user_quote, conflict at save, the "X อยู่ไหน" locations line, Claude's per-project memory import. Scratch schema + temp vault.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-acc-'));
const SCHEMA = `memhub_acc_test_${process.pid}`;
const ENV: Record<string, string> = { ...(process.env as Record<string, string>), MEMHUB_PG_SCHEMA: SCHEMA, MEMHUB_MEMORY_VAULT: join(tmp, 'vault'),
  MEMHUB_VAULTS: '', MEMHUB_NO_REINDEX: '1', MEMHUB_LIVE_DIR: join(tmp, 'live') };
for (const k of ['MEMORY_HUB_INTERNAL', 'MEMHUB_ANTHROPIC_ONLY', 'MEMHUB_PRIVATE_SOURCES', 'ANTHROPIC_BASE_URL']) delete ENV[k];
Object.assign(process.env, ENV);
const { connect, ROOT } = await import('../src/db.ts');
const { normProject } = await import('../src/importer.ts');
const { md5, noteFid, parseNote, renderNote, saveNote, sha, writeNote, MEMORY_VAULT } = await import('../src/notes.ts');
const { indexVault } = await import('../src/obsidian.ts');
const { accuracyFlags, conflictPairs, missingPaths, polarity, saveFlags, userSaid } = await import('../src/accuracy.ts');
const { importClaudeMemory, parseMemory } = await import('../src/claude-memory.ts');

const db = connect('rw');
const PROJECT = normProject(ROOT);
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');
const index = async () => { await guard(); await indexVault(db, MEMORY_VAULT); };
const status = async (fid: string) => (await db.query(`SELECT s.status, f.superseded_by FROM facts f JOIN sources s ON s.id = f.source_id WHERE f.fid = $1`, [fid])).rows[0];

async function mcp() {
  const client = new Client({ name: 'claude-code', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'src', 'mcp.ts')], env: ENV, cwd: ROOT, stderr: 'ignore' }));
  const call = async (tool: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name: tool, arguments: args })) as { content: { text: string }[] }).content[0].text;
  return { call, close: () => client.close() };
}
function sessionStart(): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'src', 'session-start.ts')], { env: ENV, cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => resolve(out ? JSON.parse(out).hookSpecificOutput.additionalContext : ''));
    p.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's-acc', cwd: ROOT }));
  });
}
/** A dream-written rule (AI-owned, kind rule = his for the review path). */
function dreamRule(fid: string, body: string) {
  const at = new Date(Date.now() - 86400e3).toISOString();
  writeNote(`facts/demo/${fid} rule.md`, { memhub: 'fact', id: fid, kind: 'rule', scope: 'project', project: PROJECT, status: 'active', valid_at: at, created_at: at,
    source_uuids: ['u-' + fid], run: 'r1', md5: md5(body) }, body);
}

const ID_TEXT = 'acctest: โปรเจกต์ D:\\memoryhub (ระบบทดสอบ acctestsys) ไม่เกี่ยวข้องกับ BC Account โดยสิ้นเชิง อ้างอิง D:\\sml เท่านั้น';
const WRONG = 'Fd0d0d0d0';
let ID = '';
let c: Awaited<ReturnType<typeof mcp>>;
before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  await db.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO memhub_ro; GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO memhub_ro`);
  ID = noteFid(ID_TEXT);
  saveNote(ID_TEXT, { global: true, kind: 'rule' });
  dreamRule(WRONG, 'POS acctestpos ต้อง sync ข้อมูลกับ BC AI Account ทุกคืน\n');
  saveNote('acctestloc: ต้นแบบ POS อยู่ที่ C:\\temp\\acctestcashier (clone จาก GitHub)', { project: PROJECT });
  await index();
  const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10); // every fixture is "before the rename"
  await db.query(`INSERT INTO state (k, v) VALUES ($1, $2)`, [`identity:${PROJECT}`,
    { fid: ID, aliases: [{ old: 'BC AI Account', new: 'SML AI Account', since: tomorrow, match: 'bc\\s*ai' }] }]);
  await saveFlags(db, await accuracyFlags(db, [])); // the nightly lint --fix
  mkdirSync(join(tmp, 'live', 'p'), { recursive: true });
  writeFileSync(join(tmp, 'live', 'p', 's.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'acctest: PROJECT นี้ไม่เกี่ยวกับ BC นะ' } }) + '\n');
  c = await mcp();
});
after(async () => {
  await c?.close();
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('polarity: negation cues, "ทุกอย่าง" is not one, history clauses are skipped; conflictPairs needs a rule side', () => {
  assert.equal(polarity('POS sync ข้อมูลกับ BC AI Account').get('bc'), 'pos');
  assert.equal(polarity('โปรเจกต์นี้ไม่เกี่ยวข้องกับ BC Account').get('bc'), 'neg');
  assert.equal(polarity('ทุกอย่าง ใช้ Docker').get('docker'), 'pos');
  assert.equal(polarity('เปลี่ยนชื่อจาก BC AI เป็น SML AI').has('bc'), false);
  assert.equal(polarity("แม้ลุงจืดพูดว่า 'BC Ai Account/POS' ใน session นี้ ก็หมายถึงระบบใน repo นี้").has('bc'), false, 'what he calls it, not a claim');
  const a = { fid: 'Fa', project: 'd:/x1x1', kind: 'rule', text: 'x1x1 ไม่ใช้ Redis' }, b = { fid: 'Fb', project: 'd:/x1x1', kind: 'fact', text: 'cache ใช้ Redis' };
  assert.deepEqual(conflictPairs([a, b]).map((p) => p.name), ['redis']);
  assert.deepEqual(conflictPairs([{ ...a, kind: 'fact' }, b]), [], 'two plain facts: no flag');
  assert.deepEqual(conflictPairs([a, { ...b, project: 'd:/other' }]), [], 'another project');
});

test('missingPaths: an absolute path gone, a relative one under the project root gone; existing ones and URLs pass', () => {
  mkdirSync(join(tmp, 'docs'), { recursive: true });
  writeFileSync(join(tmp, 'docs', 'a.md'), '');
  const got = missingPaths(`see docs/a.md, docs/gone.md, ${tmp}\\docs, C:\\acctest-nope\\x.txt and https://x.io/docs/b.md`, normProject(tmp));
  assert.ok(got.some((p) => p.includes('gone.md')), String(got));
  assert.ok(got.some((p) => p.includes('acctest-nope')), String(got));
  assert.ok(!got.some((p) => /a\.md|x\.io|docs$/.test(p)), String(got));
  writeFileSync(join(tmp, 'docs', 'x.spec.ts'), ''); // a dotted name was cut to docs/x.spec and flagged STALE
  assert.deepEqual(missingPaths('docs/x.spec.ts and docs/gone.spec.ts', normProject(tmp)), ['docs/gone.spec.ts']);
  writeFileSync(join(tmp, 'docs', 'x.exe.bak-1-r2'), ''); // was cut at '-' to docs/x.exe.bak and flagged
  assert.deepEqual(missingPaths('backup docs/x.exe.bak-1-r2', normProject(tmp)), []);
});

test('SessionStart: the identity fact is line 1 (not one of the 5 rules), then the BC/CHAMP warning; the wrong rule carries its flags', async () => {
  const lines = (await sessionStart()).split('\n');
  assert.match(lines[0], new RegExp(`^\\[memory-hub\\] ตัวตนโปรเจกต์นี้ \\[${ID}\\]: acctest: โปรเจกต์`));
  assert.match(lines[1], /^⚠ กฎกลางส่วน BC\/CHAMP .* ไม่ใช้กับ project นี้ — อ้างอิง D:\\sml แทน$/);
  const wrong = lines.find((l) => l.includes(WRONG)) ?? '';
  assert.match(wrong, new RegExp(`⚠CONFLICT ↔ \\[${ID}\\] \\(bc\\)`), wrong);
  assert.equal(lines.filter((l) => l.includes(ID)).length, 2, 'not repeated among the rules (line 1 + the conflict tag)');
});

test('memory_search: an old name in the query puts the identity fact first; old hits get the alias note and the conflict pair', async () => {
  // his annotate already says what the alias note would: shown once, with his addition
  const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
  const turn = (await db.query(`SELECT c.turn_uuid FROM facts f JOIN chunks c ON c.source_id = f.source_id WHERE f.fid = $1 LIMIT 1`, [WRONG])).rows[0].turn_uuid;
  await db.query(`INSERT INTO state (k, v) VALUES ($1, $2)`, [`note:${turn}`, { text: `BC AI Account ในข้อความนี้ = SML AI Account (ชื่อเก่า ก่อนเปลี่ยนชื่อทั้ง repo ${tomorrow}); acctestnote` }]);
  const r = await c.call('memory_search', { query: 'acctestpos BC AI POS sync' });
  assert.equal(r.match(/หมายเหตุ: BC AI Account/g)?.length, 1, r);
  assert.match(r, /acctestnote/);
  assert.match(r, /^ตอนนี้ \d{4}-\d\d-\d\d \d\d:\d\d \(เวลาไทย\)\n\n/, 'line 1 = now, Thai time');
  assert.match(r.split('\n').find((l) => l.startsWith('[')) ?? '', new RegExp(`^\\[${ID}\\] `), r); // the first hit (after "embedder busy" if so)
  assert.match(r, new RegExp(`\\[${WRONG}\\][^\\n]*⚠CONFLICT ↔ \\[${ID}\\]`));
  assert.match(r, new RegExp(`⚠ ขัดกับ \\[${ID}\\] เรื่อง bc: acctest: โปรเจกต์`));
  assert.match(r, /หมายเหตุ: BC AI Account ในข้อความนี้ = SML AI Account \(ชื่อเก่า/);
});

test('memory_search "X อยู่ที่ไหน": the path tool calls / notes named comes first, not "ไม่รู้"', async () => {
  const r = await c.call('memory_search', { query: 'acctestcashier อยู่ที่ไหน' });
  assert.match(r.split('\n')[2], /^ตำแหน่ง "acctestcashier" .*: C:\\temp\\acctestcashier \(ไม่พบในเครื่องนี้แล้ว/, r);
  assert.doesNotMatch(r, /^ไม่รู้/m);
});

test('memory_save: wrong parameter name → the real names; a near-duplicate waits for confirm_new', async () => {
  assert.match(await c.call('memory_save', { text: 'x' }), /memory_save takes content \(the text to remember — not text/);
  const again = 'acctest: โปรเจกต์ D:\\memoryhub (ระบบทดสอบ acctestsys) ไม่เกี่ยวข้องกับ BC Account โดยสิ้นเชิง อ้างอิง D:\\sml เท่านั้นนะ';
  const r = await c.call('memory_save', { content: again, global: true });
  assert.match(r, new RegExp(`^ยังไม่บันทึก[^]*คล้าย \\[${ID}\\]`), r);
  await index();
  assert.equal(await status(noteFid(again)), undefined, 'not saved');
});

test('memory_save: a new fact that contradicts a current one is flagged CONFLICT at once, both ways', async () => {
  const t = 'acctestsync: POS ของ memoryhub ส่งยอดเข้า BC Account ทุกชั่วโมง';
  const r = await c.call('memory_save', { content: t, confirm_new: true });
  assert.match(r, new RegExp(`⚠ CONFLICT: ขัดกับ \\[${ID}\\] เรื่อง bc`), r);
  const st = (await db.query(`SELECT k, v FROM state WHERE k = ANY($1)`, [[`conflict:${noteFid(t)}`, `conflict:${ID}`]])).rows;
  assert.equal(st.length, 2);
  assert.ok(st.every((x) => x.v.with.includes(x.k === `conflict:${ID}` ? noteFid(t) : ID)));
  await index();
  await (await import('../src/dream.ts')).consolidate(db); // the nightly hubs: _review.md lists both pairs
  const review = readFileSync(join(MEMORY_VAULT, 'hubs', '_review.md'), 'utf8');
  assert.match(review, /## CONFLICT: ขัดกันเอง/);
  for (const o of [noteFid(t), WRONG]) assert.match(review, new RegExp(`- \\[\\[[^\\]]*(${ID}|${o})[^\\]]*\\]\\] ↔ \\[\\[[^\\]]*(${ID}|${o})[^\\]]*\\]\\] · bc`), review);
});

test('memory_save user_quote: his words not in his chat → review as before; found → his rule superseded now', async () => {
  const fixed = 'POS acctestpos ต้อง sync ข้อมูลกับ backend ของ repo นี้ทุกคืน';
  const no = await c.call('memory_save', { content: fixed, replaces: [WRONG], user_quote: 'ข้อความที่ลุงจืดไม่ได้พิมพ์ acctest' });
  assert.match(no, /user_quote: ไม่พบข้อความนี้/);
  assert.match(no, /pending/);
  const yes = await c.call('memory_save', { content: fixed, replaces: [WRONG], user_quote: 'PROJECT นี้ไม่เกี่ยวกับ BC นะ' });
  assert.match(yes, /user_quote ตรงกับที่ลุงจืดพิมพ์: มีผลทันที/, yes);
  assert.match(yes, new RegExp(`replaced \\(now OLD\\): \\[${WRONG}\\]`));
  await index();
  assert.deepEqual(await status(WRONG), { status: 'superseded', superseded_by: noteFid(fixed) });
  assert.equal((await status(noteFid(fixed))).status, 'active', 'its own pending copy activated');
  const dir = join(MEMORY_VAULT, 'facts', 'memoryhub'), file = readdirSync(dir).find((f) => f.startsWith(noteFid(fixed)))!;
  const fm = parseNote(readFileSync(join(dir, file), 'utf8')).fm;
  assert.equal(fm.user_quote, 'PROJECT นี้ไม่เกี่ยวกับ BC นะ');
});

test('user_quote: a URL the app turned into a markdown link still matches what the AI saw ("ให้ขึ้น www.x.com เลย")', async () => {
  const live = join(tmp, 'live-md'), dir = join(live, 'p');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 's.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'ตั้งกฏ ไม่ต้องขึ้น acctestfb ให้ขึ้น [www.acctest.com](https://www.acctest.com) เลย' } }) + '\n'
    + JSON.stringify({ type: 'user', message: { role: 'user', content: 'acctestplain ขึ้น www.acctest2.com เลย' } }) + '\n');
  assert.equal(await userSaid(db, 'ตั้งกฏ ไม่ต้องขึ้น acctestfb ให้ขึ้น www.acctest.com เลย', live), true, 'link in the chat, plain in the quote');
  assert.equal(await userSaid(db, 'acctestplain ขึ้น [www.acctest2.com](https://www.acctest2.com) เลย', live), true, 'plain in the chat, link in the quote');
  assert.equal(await userSaid(db, 'ไม่ต้องขึ้น acctestfb ให้ขึ้น www.other.com เลย', live), false);
  const src = (await db.query(`INSERT INTO sources (tool, path, kind, size, mtime_ms, sha256) VALUES ('claude', 'acctest-md.jsonl', 'main', 0, 0, '') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO turns (uuid, source_id, seq, session_id, role, text_redacted, ts) VALUES ('acctest-md', $1, 0, 's', 'user', $2, now())`,
    [src, 'ตั้งกฏ acctestdb ให้ขึ้น [www.acctest3.com](https://www.acctest3.com) เลย']);
  assert.equal(await userSaid(db, 'ตั้งกฏ acctestdb ให้ขึ้น www.acctest3.com เลย', join(tmp, 'none')), true, 'indexed turn with a link');
});

test('Claude memory import: new → fact of its project, unchanged → skipped, changed → supersedes, near-duplicate → skipped, deleted → superseded', async () => {
  const live = join(tmp, 'cm'), slug = tmp.replace(/[:\\/]/g, '-'), dir = join(live, slug, 'memory');
  mkdirSync(dir, { recursive: true });
  const proj = normProject(tmp);
  const mem = (body: string, type = 'feedback') => `---\nname: acctest-rule\ndescription: d\nmetadata:\n  node_type: memory\n  type: ${type}\n---\n\n${body}\n`;
  assert.deepEqual(parseMemory(mem('acctestmem body', 'user')), { title: 'acctest-rule', kind: 'preference', global: true, text: 'acctestmem body', modified: '' });
  writeFileSync(join(dir, 'a.md'), mem('acctestmem: ใช้ tab สองช่อง ในไฟล์ yaml ทุกไฟล์ของ repo'));
  writeFileSync(join(dir, 'MEMORY.md'), '- [a](a.md)\n');
  let r = await importClaudeMemory(db, { dir });
  assert.equal(r.saved.length, 0, 'dir = the memory folder itself: no slug folders under it');
  r = await importClaudeMemory(db, { dir: live });
  assert.deepEqual([r.saved.length, r.dup.length], [1, 0], JSON.stringify(r));
  const first = noteFid('acctestmem: ใช้ tab สองช่อง ในไฟล์ yaml ทุกไฟล์ของ repo');
  await index();
  assert.equal((await db.query(`SELECT kind, project FROM facts WHERE fid = $1`, [first])).rows[0]?.kind, 'feedback');
  assert.equal((await db.query(`SELECT project FROM facts WHERE fid = $1`, [first])).rows[0].project, proj);
  assert.equal((await importClaudeMemory(db, { dir: live })).saved.length, 0, 'unchanged');
  writeFileSync(join(dir, 'b.md'), mem('acctestmem: ใช้ tab สองช่อง ในไฟล์ yaml ทุกไฟล์ของ repo นะ'));
  writeFileSync(join(dir, 'a.md'), mem('acctestmem: ใช้ space สี่ช่อง ในไฟล์ yaml ทุกไฟล์ของ repo'));
  r = await importClaudeMemory(db, { dir: live });
  assert.equal(r.saved.length, 1, JSON.stringify(r));
  assert.match(r.dup.join(), new RegExp(`b\\.md ≈ \\[${first}\\]`), 'b repeats a (still current while this run reads it)');
  await index();
  const second = noteFid('acctestmem: ใช้ space สี่ช่อง ในไฟล์ yaml ทุกไฟล์ของ repo');
  assert.deepEqual(await status(first), { status: 'superseded', superseded_by: second });
  unlinkSync(join(dir, 'a.md'));
  assert.equal((await importClaudeMemory(db, { dir: live })).gone, 1);
  await index();
  assert.equal((await status(second)).status, 'superseded');
});

test('Claude memory import dates a fact by when Claude wrote it (metadata modified, else file mtime), not the import run', async () => {
  const live = join(tmp, 'cm2'), dir = join(live, tmp.replace(/[:\\/]/g, '-'), 'memory');
  mkdirSync(dir, { recursive: true });
  const mem = (body: string, extra = '') => `---\nname: acctest-dated\ndescription: d\nmetadata:\n  type: project\n${extra}---\n\n${body}\n`;
  writeFileSync(join(dir, 'm.md'), mem('acctestdated: zorbleq ย้ายไปเครื่อง qyxnode แล้ว', '  modified: 2026-10-09T05:00:00.000Z\n'));
  writeFileSync(join(dir, 't.md'), mem('acctestdated: flimbar ใช้คิว pruxq สำหรับงานกลางคืน'));
  utimesSync(join(dir, 't.md'), new Date('2026-10-03T05:00:00Z'), new Date('2026-10-03T05:00:00Z'));
  assert.equal((await importClaudeMemory(db, { dir: live })).saved.length, 2);
  await index();
  const at = async (text: string) => (await db.query(`SELECT valid_at::date::text d FROM facts WHERE fid = $1`, [noteFid(text)])).rows[0]?.d;
  assert.equal(await at('acctestdated: zorbleq ย้ายไปเครื่อง qyxnode แล้ว'), '2026-10-09');
  assert.equal(await at('acctestdated: flimbar ใช้คิว pruxq สำหรับงานกลางคืน'), '2026-10-03');
});

test('a CRLF text saves as a machine note (body_sha of the body parseNote returns), not as his edit', () => {
  const rel = saveNote('acctestcrlf: qorvane ใช้ cron\r\nบรรทัดสอง vexlo', { project: PROJECT, reindex: false });
  const raw = readFileSync(join(MEMORY_VAULT, rel), 'utf8'), { fm, body } = parseNote(raw);
  assert.ok(!raw.includes('\r'), 'no CR written');
  assert.equal(writeNote(rel, { importance: '7' }), 'written', 'still machine-owned');
  assert.equal(parseNote(readFileSync(join(MEMORY_VAULT, rel), 'utf8')).body, body);
  assert.ok(fm.body_sha);
});

test('backfill re-dates Claude memory facts imported with the run day, only valid_at/created_at, skipping gone/superseded/newer', async () => {
  const { backfillClaudeMemoryDates } = await import('../scripts/backfill-cmem-dates.ts');
  const live = join(tmp, 'cm3'), slug = tmp.replace(/[:\\/]/g, '-'), dir = join(live, slug, 'memory');
  mkdirSync(dir, { recursive: true });
  const mem = (body: string, extra = '') => `---\nname: acctest-bf\ndescription: d\nmetadata:\n  type: project\n${extra}---\n\n${body}\n`;
  const T = { mod: 'acctestbf: vonkle ใช้พอร์ต 7311', mtime: 'acctestbf: graspel รันบน qelbox', gone: 'acctestbf: trinmo เลิกใช้แล้ว',
    sup: 'acctestbf: plordex ย้ายไป zentra', newer: 'acctestbf: wubrik ใช้คิว moxa', crlf: 'acctestbf: snorvik ใช้ cron\r\nทุกคืน' };
  const day = (d: string) => new Date(`${d}T05:00:00Z`);
  writeFileSync(join(dir, 'bf-mod.md'), mem(T.mod, '  modified: 2026-10-09T05:00:00.000Z\n'));
  for (const [f, d] of [['mtime', '2026-10-03'], ['gone', '2026-10-04'], ['sup', '2026-10-05'], ['newer', '2026-10-25'], ['crlf', '2026-10-06']]) {
    writeFileSync(join(dir, `bf-${f}.md`), mem(T[f as keyof typeof T]));
    utimesSync(join(dir, `bf-${f}.md`), day(d), day(d));
  }
  assert.equal((await importClaudeMemory(db, { dir: live })).saved.length, 6);
  const rel = async (f: string) => (await db.query(`SELECT v->>'rel' r FROM state WHERE k = $1`, [`cmem:${slug}/bf-${f}.md`])).rows[0].r as string;
  const run = '2026-10-18T12:00:00.000Z'; // the pre-fix import stamped every note with its run time
  for (const f of Object.keys(T)) writeNote(await rel(f), { valid_at: run, created_at: run });
  writeNote(await rel('sup'), { status: 'superseded', superseded_by: 'Facctestbf0', expired_at: run, invalid_at: run });
  unlinkSync(join(dir, 'bf-gone.md'));
  // the old writeNote hashed a CRLF body as is → parseNote's body never matched body_sha → the note looked like his edit
  const crPath = join(MEMORY_VAULT, await rel('crlf')), crNote = parseNote(readFileSync(crPath, 'utf8')), cr = crNote.body.replace(/\n/g, '\r\n');
  writeFileSync(crPath, renderNote({ ...crNote.fm, body_sha: sha(cr) }, cr));
  await index();
  const at = async (f: keyof typeof T) => (await db.query(`SELECT valid_at::date::text v, created_at::date::text c FROM facts WHERE fid = $1`, [noteFid(T[f])])).rows[0];
  const before = readFileSync(join(MEMORY_VAULT, await rel('mod')), 'utf8');

  const dry = await backfillClaudeMemoryDates(db, { dir: live, dry: true });
  assert.deepEqual(dry.fixed.map((x) => x.key).filter((k) => k.includes('/bf-')).sort(), [`${slug}/bf-crlf.md`, `${slug}/bf-mod.md`, `${slug}/bf-mtime.md`]);
  assert.ok(dry.gone >= 1 && dry.superseded >= 1 && dry.notOlder >= 1, JSON.stringify(dry));
  assert.equal(readFileSync(join(MEMORY_VAULT, await rel('mod')), 'utf8'), before, 'dry run writes nothing');
  assert.deepEqual(await at('mod'), { v: '2026-10-18', c: '2026-10-18' });

  await backfillClaudeMemoryDates(db, { dir: live }); // writes the notes and indexes the vault itself
  assert.deepEqual(await at('mod'), { v: '2026-10-09', c: '2026-10-09' });
  assert.deepEqual(await at('mtime'), { v: '2026-10-03', c: '2026-10-03' });
  assert.deepEqual(await at('crlf'), { v: '2026-10-06', c: '2026-10-06' });
  assert.equal((await db.query(`SELECT edited FROM facts WHERE fid = $1`, [noteFid(T.crlf)])).rows[0].edited, false, 'CRLF note: machine-owned again');
  for (const f of ['gone', 'sup', 'newer'] as const) assert.deepEqual(await at(f), { v: '2026-10-18', c: '2026-10-18' }, f);
  const after = readFileSync(join(MEMORY_VAULT, await rel('mod')), 'utf8');
  const diff = (a: string, b: string) => a.split('\n').filter((l) => !b.split('\n').includes(l));
  assert.deepEqual(diff(after, before), ['valid_at: 2026-10-09T05:00:00.000Z', 'created_at: 2026-10-09T05:00:00.000Z']);
  assert.deepEqual(diff(before, after), [`valid_at: ${run}`, `created_at: ${run}`]);
  assert.equal((await backfillClaudeMemoryDates(db, { dir: live, dry: true })).fixed.filter((x) => x.key.includes('/bf-')).length, 0, 'second run: nothing left');
});

test('CONFLICT spans the project tree like search: parent ↔ sub-folder facts are compared, siblings and catch-alls are not', async () => {
  const r = (fid: string, project: string, text: string) => ({ fid, project, kind: 'rule', text });
  const neg = r('Fa', 'd:/x2x2', 'x2x2 ไม่ใช้ Redis'), pos = { fid: 'Fb', project: 'd:/x2x2/api', kind: 'fact', text: 'cache ใช้ Redis' };
  assert.deepEqual(conflictPairs([neg, pos]).map((p) => p.name), ['redis'], 'parent rule ↔ sub-folder fact');
  assert.deepEqual(conflictPairs([neg, { ...pos, project: 'd:/x2x2b' }]), [], 'a sibling sharing a prefix is another project');
  assert.deepEqual(conflictPairs([{ ...neg, project: 'c:/tmp' }, { ...pos, project: 'c:/tmp/api' }]), [], 'c:/tmp is a catch-all');
  assert.deepEqual(conflictPairs([{ ...neg, project: '', text: 'd:\\x2x2 ไม่ใช้ Redis' }, pos]).map((p) => p.name), ['redis'], 'a global fact about the parent');
  // memory_save from the parent project sees a current rule filed under its sub-folder
  saveNote('acctestsub ไม่ใช้ Kafka เด็ดขาด', { project: `${PROJECT}/acctestsub`, kind: 'rule' });
  await index();
  const saved = await c.call('memory_save', { content: 'acctestq: ส่ง event ผ่าน Kafka ทุกนาที', confirm_new: true });
  assert.match(saved, new RegExp(`⚠ CONFLICT: ขัดกับ \\[${noteFid('acctestsub ไม่ใช้ Kafka เด็ดขาด')}\\] เรื่อง kafka`), saved);
});
