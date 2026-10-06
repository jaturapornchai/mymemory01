// Correct / mute from chat (memory_save replaces / mute), through real stdio MCP servers: an AI-owned note is superseded at once,
// ลุงจืด's own notes go to the review queue untouched, very similar facts are hinted (never replaced), a mute hides a fact from
// SessionStart but not from search, and a non-Claude app can neither replace nor mute a Claude-only fact. Own schema + temp vault.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-correct-'));
const SCHEMA = `memhub_correct_test_${process.pid}`;
const ENV: Record<string, string> = { ...(process.env as Record<string, string>), MEMHUB_PG_SCHEMA: SCHEMA, MEMHUB_MEMORY_VAULT: join(tmp, 'vault'),
  MEMHUB_VAULTS: '', MEMHUB_NO_REINDEX: '1' };
for (const k of ['MEMORY_HUB_INTERNAL', 'MEMHUB_ANTHROPIC_ONLY', 'MEMHUB_PRIVATE_SOURCES', 'ANTHROPIC_BASE_URL']) delete ENV[k];
Object.assign(process.env, ENV);
const { connect, ROOT } = await import('../src/db.ts');
const { normProject } = await import('../src/importer.ts');
const { md5, noteFid, parseNote, renderNote, saveNote, writeNote, MEMORY_VAULT } = await import('../src/notes.ts');
const { indexVault } = await import('../src/obsidian.ts');

const db = connect('rw');
const PROJECT = normProject(ROOT); // MCP server + hook run with cwd = ROOT
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');
const file = (rel: string) => join(MEMORY_VAULT, rel);
const index = async () => { await guard(); await indexVault(db, MEMORY_VAULT); };
const status = async (fid: string) => (await db.query(`SELECT s.status, f.superseded_by, f.review_target FROM facts f JOIN sources s ON s.id = f.source_id WHERE f.fid = $1`, [fid])).rows[0];

async function mcp(name: string) {
  const client = new Client({ name, version: '0' });
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
    p.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's-correct', cwd: ROOT }));
  });
}
/** A dream-written (AI-owned) note: run set, owner not user. */
function dreamNote(rel: string, fid: string, kind: string, body: string) {
  const at = new Date(Date.now() - 86400e3).toISOString();
  writeNote(rel, { memhub: kind === 'card' ? 'card' : 'fact', id: fid, kind, scope: 'project', project: PROJECT, status: 'active', valid_at: at, created_at: at,
    source_uuids: ['u-' + fid], run: 'r1', md5: md5(body), ...(kind === 'card' ? { session: 'c-' + fid, tool: 'claude' } : {}) }, body);
}

let claude: Awaited<ReturnType<typeof mcp>>, codex: Awaited<ReturnType<typeof mcp>>;
let rule = '', ruleRel = '';
before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  await db.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO memhub_ro; GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO memhub_ro`);
  dreamNote('facts/demo/Fa1a1a1a1 port.md', 'Fa1a1a1a1', 'fact', 'memhub ใช้พอร์ต pg 5433 (corrtest-old)\n');
  dreamNote('sessions/2026-10/2026-10-03 card b2b2b2b2.md', 'Sb2b2b2b2', 'card', '# corrtestcard\n\nตั้งพอร์ต 5433 ให้ memhub\n');
  dreamNote('facts/demo/Fe3e3e3e3 edited.md', 'Fe3e3e3e3', 'fact', 'memhub backup ตีสอง (corrtest-edited)\n');
  ruleRel = saveNote('กฎ corrtestrule: ห้ามแตะพอร์ต 5434 เด็ดขาด', { project: PROJECT, kind: 'rule' });
  rule = ruleRel.match(/(F[0-9a-f]{8})/)![1];
  saveNote('ลุงจืดชอบกาแฟดำ ไม่ใส่น้ำตาล ทุกเช้า ที่ออฟฟิศ corrtestcoffee', { project: PROJECT, kind: 'preference' });
  saveNote('ข้อมูลส่วนตัวจาก Gmail corrtestprivate', { project: PROJECT, kind: 'fact' });
  await index();
  // his edit after the last index: the file says so, the DB doesn't know yet
  const e = parseNote(readFileSync(file('facts/demo/Fe3e3e3e3 edited.md'), 'utf8'));
  writeFileSync(file('facts/demo/Fe3e3e3e3 edited.md'), renderNote(e.fm, e.body.replace('ตีสอง', 'ตีสาม')));
  // a Claude-only fact (dreamed from / hidden as a Google source)
  await db.query(`UPDATE sources s SET hide_as = 'google' FROM facts f WHERE f.source_id = s.id AND f.fid = (SELECT fid FROM facts f2 JOIN sources s2 ON s2.id = f2.source_id
    JOIN turns t ON t.source_id = s2.id WHERE t.text_redacted LIKE '%corrtestprivate%' LIMIT 1)`);
  [claude, codex] = await Promise.all([mcp('claude-code'), mcp('codex-mcp-client')]);
});
after(async () => {
  await Promise.all([claude?.close(), codex?.close()]);
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('replaces on AI-owned notes → superseded at once (file + facts row + the supersedes link the dream writes), no longer injected; unknown fid listed, save still done', async () => {
  assert.match(await sessionStart(), /corrtestcard/);
  const r = await claude.call('memory_save', { content: 'memhub ใช้พอร์ต pg 5441 (corrtest-new)', replaces: ['Fa1a1a1a1', 'Sb2b2b2b2', 'F00000000'] });
  assert.match(r, /^saved: facts\/.* \(searchable in new sessions\)$/m);
  assert.match(r, /^replaced \(now OLD\): \[Fa1a1a1a1\] \[Sb2b2b2b2\]$/m);
  assert.match(r, /^not found: F00000000$/m);
  const fid = r.match(/\/(F[0-9a-f]{8}) /)![1];
  assert.equal(parseNote(readFileSync(file('facts/demo/Fa1a1a1a1 port.md'), 'utf8')).fm.superseded_by, fid);
  const saved = readFileSync(file(r.match(/^saved: (facts\/.*\.md) \(/m)![1]), 'utf8');
  assert.match(saved, /^- supersedes:: \[\[Fa1a1a1a1 port\]\]\n- supersedes:: \[\[2026-10-03 card b2b2b2b2\]\]$/m); // as dream.ts writes it
  assert.equal(fid, noteFid('memhub ใช้พอร์ต pg 5441 (corrtest-new)'), 'the link lines never change the fid');
  await index();
  assert.deepEqual(await status('Fa1a1a1a1'), { status: 'superseded', superseded_by: fid, review_target: null });
  assert.equal((await status('Sb2b2b2b2')).status, 'superseded');
  assert.equal((await status(fid)).status, 'active');
  assert.ok((await db.query(`SELECT 1 FROM links l JOIN facts f ON f.source_id = l.src_id WHERE f.fid = $1 AND l.dst_name = lower('Fa1a1a1a1 port')`, [fid])).rowCount, 'old→new link edge');
  assert.doesNotMatch(await sessionStart(), /corrtestcard/);
});

test('replaces on his own notes (memory_save rule, edited dream note) → review queue, files untouched', async () => {
  const before = readFileSync(file(ruleRel), 'utf8');
  const r = await claude.call('memory_save', { content: 'กฎ corrtestrule: ห้ามแตะพอร์ต 5434 และ 5435', kind: 'rule', replaces: [rule] });
  assert.match(r, /\(pending: waits for his approval\)/);
  assert.match(r, new RegExp(`\\[${rule}\\] เป็นโน้ตของลุงจืด`));
  assert.equal(readFileSync(file(ruleRel), 'utf8'), before, 'his note is never rewritten');
  const edited = readFileSync(file('facts/demo/Fe3e3e3e3 edited.md'), 'utf8');
  assert.match(await claude.call('memory_save', { content: 'memhub backup ตีสี่ (corrtest-edited2)', replaces: ['Fe3e3e3e3'] }), /\[Fe3e3e3e3\] เป็นโน้ตของลุงจืด/);
  assert.equal(readFileSync(file('facts/demo/Fe3e3e3e3 edited.md'), 'utf8'), edited);
  await index();
  assert.equal((await status(rule)).status, 'active');
  const q = (await db.query(`SELECT fid, review_target FROM review_queue ORDER BY review_target`)).rows;
  assert.deepEqual(q.map((x) => x.review_target).sort(), ['Fe3e3e3e3', rule].sort());
  assert.match(await sessionStart(), /ห้ามแตะพอร์ต 5434 เด็ดขาด/, 'the old rule stays until he approves');
});

test('a very similar fact of the same kind is hinted, never replaced', async () => {
  const r = await claude.call('memory_save', { content: 'ลุงจืดชอบกาแฟดำ ไม่ใส่น้ำตาล ทุกเช้า ที่บ้าน corrtestcoffee', kind: 'preference' });
  const hint = r.match(/^คล้าย \[(F[0-9a-f]{8})\] (.*) — ส่ง replaces:\[\1\] ถ้าจะแทน$/m);
  assert.ok(hint, r);
  assert.ok(hint[2].startsWith('ลุงจืดชอบกาแฟดำ') && hint[2].length <= 60);
  await index();
  assert.equal((await status(hint[1])).status, 'active');
});

test('mute → gone from SessionStart, still found by memory_search / memory_get; -fid unmutes', async () => {
  assert.match(await sessionStart(), /เด็ดขาด/);
  assert.match(await claude.call('memory_save', { mute: [rule] }), new RegExp(`^muted: ${rule}`));
  assert.doesNotMatch(await sessionStart(), /เด็ดขาด/);
  assert.match(await claude.call('memory_search', { query: 'corrtestrule เด็ดขาด' }), /เด็ดขาด/);
  assert.match(await claude.call('memory_get', { id: rule }), /เด็ดขาด/);
  assert.match(await claude.call('memory_save', { mute: [`-${rule}`] }), new RegExp(`unmuted: ${rule}`));
  assert.match(await sessionStart(), /เด็ดขาด/);
});

test('a non-Claude app cannot replace or mute a Claude-only fact (= not found); Claude can see it', async () => {
  const priv = (await db.query(`SELECT f.fid, s.path FROM facts f JOIN sources s ON s.id = f.source_id WHERE s.hide_as = 'google'`)).rows[0];
  const before = readFileSync(priv.path, 'utf8');
  const r = await codex.call('memory_save', { content: 'แก้ข้อมูล corrtest-codex', replaces: [priv.fid], mute: [priv.fid] });
  assert.match(r, new RegExp(`^not found: ${priv.fid}$`, 'm'));
  assert.doesNotMatch(r, /muted|replaced|โน้ตของลุงจืด/);
  assert.equal(readFileSync(priv.path, 'utf8'), before);
  assert.equal((await db.query(`SELECT count(*)::int n FROM state WHERE k = $1`, [`mute:${priv.fid}`])).rows[0].n, 0);
  assert.match(await claude.call('memory_save', { mute: [priv.fid] }), new RegExp(`^muted: ${priv.fid}`));
});

// --- edge cases of replaces (after the tests above: pinned / pending notes here would change their SessionStart / review queue)
const fmOf = (rel: string) => parseNote(readFileSync(file(rel), 'utf8')).fm;

test('replaces on a dream note he pinned, not indexed yet → review (the dream\'s ownership test), file untouched', async () => {
  dreamNote('facts/demo/Fc4c4c4c4 pinned.md', 'Fc4c4c4c4', 'fact', 'memhub nightly ตีสาม (corrtest-pinned)\n');
  await index();
  writeNote('facts/demo/Fc4c4c4c4 pinned.md', { pinned: 'true' }); // his pin: the file says so, the DB doesn't know yet
  const before = readFileSync(file('facts/demo/Fc4c4c4c4 pinned.md'), 'utf8');
  const r = await claude.call('memory_save', { content: 'memhub nightly ตีสี่ (corrtest-pinned2)', replaces: ['Fc4c4c4c4'] });
  assert.match(r, /\(pending: waits for his approval\)/);
  assert.match(r, /^\[Fc4c4c4c4\] เป็นโน้ตของลุงจืด/m);
  assert.equal(readFileSync(file('facts/demo/Fc4c4c4c4 pinned.md'), 'utf8'), before);
});

test('replaces on an already-OLD fact → left as is (its superseded_by chain kept), named in the reply', async () => {
  const chain = fmOf('facts/demo/Fa1a1a1a1 port.md').superseded_by;
  const r = await claude.call('memory_save', { content: 'memhub ใช้พอร์ต pg 5442 (corrtest-newer)', replaces: ['Fa1a1a1a1'] });
  assert.match(r, /^already OLD, left as is: \[Fa1a1a1a1\] superseded$/m);
  assert.doesNotMatch(r, /replaced \(now OLD\)/);
  assert.equal(fmOf('facts/demo/Fa1a1a1a1 port.md').superseded_by, chain);
});

test('mixed replaces [AI note, his rule] → new note pending, the AI note stays current (not replaced by a pending note)', async () => {
  dreamNote('facts/demo/Fd5d5d5d5 mixed.md', 'Fd5d5d5d5', 'fact', 'memhub backup เก็บ 7 วัน (corrtest-mixed)\n');
  await index();
  const r = await claude.call('memory_save', { content: 'กฎ corrtestrule: backup เก็บ 30 วัน ห้ามแตะ 5434', kind: 'rule', replaces: ['Fd5d5d5d5', rule] });
  assert.match(r, /\(pending: waits for his approval\)/);
  assert.match(r, /^ยังไม่แทน \[Fd5d5d5d5\]: /m);
  assert.doesNotMatch(r, /replaced \(now OLD\)/);
  assert.equal(fmOf('facts/demo/Fd5d5d5d5 mixed.md').status, 'active');
  await index();
  assert.equal((await status('Fd5d5d5d5')).status, 'active');
});

test('re-saving the text of an active note with replaces:[his note] keeps it active, no review_target', async () => {
  const content = 'memhub ใช้ Ollama bge-m3 ทำ embedding (corrtest-resave)';
  const rel = (await claude.call('memory_save', { content })).match(/^saved: (facts\/.*\.md) \(/m)![1];
  const r = await claude.call('memory_save', { content, replaces: [rule] });
  assert.match(r, /\(searchable in new sessions\)/);
  assert.match(r, new RegExp(`^\\[${rule}\\]: ไม่ได้เสนอแทน`, 'm'));
  assert.equal(fmOf(rel).status, 'active');
  assert.equal(fmOf(rel).review_target, '');
});
