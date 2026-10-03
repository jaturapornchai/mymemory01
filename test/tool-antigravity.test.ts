import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const T = mkdtempSync(join(tmpdir(), 'memhub-ag-test-'));
const LIVE = join(T, 'gemini'), ARCH = join(T, 'archive', 'antigravity');
process.env.MEMHUB_ANTIGRAVITY_HOME = LIVE; // never the real ~/.gemini
const ag = await import('../src/tools/antigravity.ts');
const { walk } = await import('../src/importer.ts');
after(() => { if (sum.isOpen) sum.close(); rmSync(T, { recursive: true, force: true }); }); // sum: the open app db below

const A = '11111111-1111-4111-8111-111111111111'; // main: 2.0 app + a smaller stale IDE copy
const S = '22222222-2222-4222-8222-222222222222'; // subagent of A
const B = '33333333-3333-4333-8333-333333333333'; // IDE only: cwd from its conversation .db
const C = '44444444-4444-4444-8444-444444444444'; // CLI: 0-byte transcripts
const D = '55555555-5555-4555-8555-555555555555'; // encrypted .pb only
const E = '66666666-6666-4666-8666-666666666666'; // identical copies in IDE and CLI → IDE (app order)

const at = (s: number) => new Date(Date.UTC(2026, 8, 1, 10, 0, s)).toISOString().replace('.000', '');
const st = (i: number, type: string, x: object = {}, sec = i * 10) =>
  JSON.stringify({ step_index: i, source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL', type, status: 'DONE', created_at: at(sec), ...x });
const req = (t: string, extra = '') => `<USER_REQUEST>\n${t}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-09-01T17:00:00+07:00.\n</ADDITIONAL_METADATA>${extra}`;
const LONG = 'x'.repeat(25000);
const J = JSON.stringify, T8 = '\n<truncated 8 bytes>'; // how transcript.jsonl cuts a long arg
const agentMsg = (sender: string, body: string) => 'The following is a <SYSTEM_MESSAGE> not sent by the user. It is sent by the system.\n\n' +
  `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-01T10:02:00Z sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=${body}\n</SYSTEM_MESSAGE>`;
const logs = (app: string, id: string) => join(LIVE, app, 'brain', id, '.system_generated', 'logs');
const put = (p: string, s: string | Buffer) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s); };

// short transcript: truncated text, CLEARED marks; _full starts late (step 2) like conversations older than it
const TR = [
  st(0, 'USER_INPUT', { content: req('fix the login bug') }),
  st(1, 'PLANNER_RESPONSE', { thinking: 'SECRET-THOUGHT', content: 'Looking at it', tool_calls: [ // args as JSON text, like the app
    { name: 'view_file', args: { AbsolutePath: J('d:\\x\\a.ts'), StartLine: '1', toolAction: J('Viewing') } },
    { name: 'run_command', args: { CommandLine: J('cd "d:\\x" && git status'), Cwd: J('d:\\x'), WaitMsBeforeAsync: '500' } },
    { name: 'write_to_file', args: { TargetFile: J('d:\\x\\c.ts'), CodeContent: J('CODE-BODY').slice(0, 5) + T8, Overwrite: 'true' } },
    { name: 'search_web', args: { query: J('jwt expiry\\n').slice(0, 12) + T8 } }] }), // truncated mid-escape
  'not json {',
  st(2, 'GENERIC', { content: 'Created At: x\nOUTPUT-NOISE' }),
  st(3, 'USER_INPUT', { content: '<USER_REQUEST>\nplease also han', truncated_fields: ['content'] }),
  st(8, 'USER_INPUT', { status: 'CLEARED' }),
];
const FULL = [
  st(2, 'GENERIC', { content: 'Created At: x\nOUTPUT-NOISE' }),
  st(3, 'USER_INPUT', { content: req('please also handle expired sessions ![s](data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==)',
    '\n<USER_SETTINGS_CHANGE>\nThe user changed setting X\n</USER_SETTINGS_CHANGE>') }),
  st(4, 'PLANNER_RESPONSE', { status: 'RUNNING' }),
  st(2, 'GENERIC', { content: 'Created At: x\nOUTPUT-NOISE' }), // replay
  st(4, 'PLANNER_RESPONSE', { content: 'Done: patched', tool_calls: [
    { name: 'write_to_file', args: { TargetFile: 'd:\\x\\b.ts', CodeContent: 'CODE-BODY' } },
    { name: 'replace_file_content', args: { TargetFile: 'd:\\x\\a.ts', ReplacementContent: 'CODE-BODY' } },
    { name: 'search_web', args: { query: 'jwt expiry' } },
    { name: 'run_command', args: { CommandLine: '"C:\\py.exe" -m pytest "a b"' } }] }), // plain value that looks like JSON
  st(5, 'SYSTEM_MESSAGE', { source: 'SYSTEM', content: agentMsg('bg/task-1', 'Output: OUTPUT-NOISE') }), // background task
  st(6, 'PLANNER_RESPONSE', { content: 'old branch' }),
  st(7, 'GENERIC', { content: 'old output' }),
  st(6, 'SYSTEM_MESSAGE', { content: 'rewound' }), // step_index reused after a rewind
  st(7, 'PLANNER_RESPONSE', { content: 'after rewind' }),
  st(8, 'USER_INPUT', { content: req('cleared request') }),
  st(9, 'CHECKPOINT', { content: `# Resuming from a compaction\n# User Requests\n- ${req('fix the login bug')}` }),
  st(10, 'ASK_QUESTION', { content: 'Created At: x\nCompleted At: y\nA1: yes' }),
  st(11, 'USER_INPUT', { content: req('queued message') }, 95), // typed before step 10 finished
  st(12, 'PLANNER_RESPONSE', { content: LONG }),
  st(13, 'SYSTEM_MESSAGE', { source: 'SYSTEM', content: agentMsg(S, 'REPORT: all 3 bugs fixed') }), // subagent S's send_message
  '',
];
const SUB = [st(0, 'USER_INPUT', { content: req('subagent task') }), st(1, 'PLANNER_RESPONSE', { content: 'subagent answer' }),
  st(2, 'PLANNER_RESPONSE', { tool_calls: [{ name: 'send_message', args: { Recipient: J(A), Message: J('REPORT: all 3 bugs fixed') } }] })];

const mainLogs = logs('antigravity', A);
put(join(mainLogs, 'transcript.jsonl'), TR.join('\n') + '\n');
put(join(mainLogs, 'transcript_full.jsonl'), FULL.join('\n') + '\n');
put(join(mainLogs, 'chunks', 'transcript', '00000000.jsonl'), TR.join('\n')); // copy of the transcript: not archived
put(join(LIVE, 'antigravity', 'brain', A, 'task.md'), '# artifact');
put(join(LIVE, 'antigravity', 'brain', 'tempmediaStorage', 'x.png'), 'png');
put(join(logs('antigravity-ide', A), 'transcript.jsonl'), TR.slice(0, 2).join('\n') + '\n');
put(join(logs('antigravity', S), 'transcript.jsonl'), SUB.join('\n') + '\n');
put(join(logs('antigravity-ide', B), 'transcript.jsonl'), SUB.join('\n') + '\n');
put(join(logs('antigravity-cli', C), 'transcript.jsonl'), '');
put(join(logs('antigravity-cli', C), 'transcript_full.jsonl'), '');
put(join(LIVE, 'antigravity', 'conversations', `${D}.pb`), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
for (const app of ['antigravity-ide', 'antigravity-cli']) {
  const p = join(logs(app, E), 'transcript.jsonl');
  put(p, SUB.join('\n') + '\n');
  utimesSync(p, new Date(2026, 0, 1), new Date(2026, 0, 1));
}

const URI_A = 'file:///d%3A/work/proj-a', URI_B = 'file:///d:/work/proj-b';
const sum = new DatabaseSync(join(LIVE, 'antigravity', 'conversation_summaries.db'));
sum.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, parent_conversation_id TEXT, nesting_depth INT)');
const ins = sum.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)');
ins.run(A, 't', JSON.stringify([URI_A]), '', 0);
ins.run(S, 't', JSON.stringify([URI_A]), A, 1);
sum.exec('PRAGMA journal_mode=WAL'); // like the app; the sync test holds it open mid-write
const pb = (field: number, b: Buffer) => Buffer.concat([Buffer.from([(field << 3) | 2, b.length]), b]);
mkdirSync(join(LIVE, 'antigravity-ide', 'conversations'), { recursive: true });
const conv = new DatabaseSync(join(LIVE, 'antigravity-ide', 'conversations', `${B}.db`));
conv.exec('CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB)');
conv.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('t', Buffer.concat([
  Buffer.from([0x18, 0x01]), pb(1, Buffer.concat([Buffer.from([0x10, 0x96, 0x01]), pb(1, Buffer.from(URI_B))]))]));
conv.close();

const snapshot = (dir: string) => [...walk(dir)].map((f) => `${relative(dir, f)}:${statSync(f).size}`).sort();

test('parse: keeps prompts, answers, compact tool lines; drops thinking, outputs, boilerplate, cleared/rewound steps', async () => {
  const p = (await ag.parse(join(mainLogs, 'transcript.jsonl')))!;
  assert.equal(p.sessionId, A);
  assert.equal(p.kind, 'main');
  assert.deepEqual(p.msgs.map((m) => `${m.uuid.split(':').at(-1)}:${m.role}`),
    ['0:user', '1:assistant', '3:user', '4:assistant', '7:assistant', '9:summary', '10:tool', '11:user', '12:assistant', '13:tool']);
  const [u0, a1, u3, a4, a7, s9, t10, , a12, t13] = p.msgs.map((m) => m.text);
  assert.equal(u0, 'fix the login bug');
  assert.equal(a1, 'Looking at it\n[shell] cd "d:\\x" && git status\n[write] d:\\x\\c.ts\n[search] jwt expiry'); // JSON args decoded
  assert.equal(u3, 'please also handle expired sessions ![s]([image])'); // _full beats the truncated line
  assert.equal(a4, 'Done: patched\n[write] d:\\x\\b.ts\n[edit] d:\\x\\a.ts\n[search] jwt expiry\n[shell] "C:\\py.exe" -m pytest "a b"');
  assert.equal(a7, 'after rewind');
  assert.ok(s9.includes('fix the login bug') && !s9.includes('USER_REQUEST'));
  assert.equal(t10, '[ask result] A1: yes');
  assert.equal(t13, '[agent message] REPORT: all 3 bugs fixed'); // a subagent's report reaches the main session
  const all = p.msgs.map((m) => m.text).join('\n');
  for (const junk of ['SECRET-THOUGHT', 'OUTPUT-NOISE', 'CODE-BODY', 'local time', 'changed setting', 'old branch', 'cleared request', 'base64'])
    assert.ok(!all.includes(junk), junk);
  assert.ok(a12.length < 20100 && a12.endsWith('…[truncated]'));
  const ts = p.msgs.map((m) => m.ts);
  assert.deepEqual(ts, [...ts].sort(), 'ts non-decreasing');
  assert.ok(ts.every((t) => !Number.isNaN(Date.parse(t))));
  assert.equal(p.msgs[1].parentUuid, p.msgs[0].uuid);
});

test('parse: junk-only transcript → null', async () => {
  const p = join(T, 'junk', A, 'transcript.jsonl');
  put(p, [st(0, 'SYSTEM_MESSAGE', { content: 'The following' }), st(1, 'GENERIC', { content: 'out' }), 'garbage'].join('\n'));
  assert.equal(await ag.parse(p), null);
});

test('parse: memory stays bounded by kept text, not tool outputs (64 MB transcript, 32 MB heap)', () => {
  const p = join(T, 'big', A, 'transcript.jsonl'), out = 'y'.repeat(1 << 20);
  put(p, [...Array.from({ length: 64 }, (_, i) => st(i, 'GENERIC', { content: out })), st(64, 'USER_INPUT', { content: req('hi') })].join('\n'));
  const code = `const m = await import(${J(new URL('../src/tools/antigravity.ts', import.meta.url).href)});
    console.log((await m.parse(${J(p)})).msgs.length);`;
  const r = spawnSync(process.execPath, ['--max-old-space-size=32', '--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '1', r.stderr.slice(0, 300));
  rmSync(join(T, 'big'), { recursive: true });
});

test('uuids: globally prefixed, unique, stable across parses', async () => {
  const f = join(mainLogs, 'transcript.jsonl');
  const a = (await ag.parse(f))!.msgs.map((m) => m.uuid), b = (await ag.parse(f))!.msgs.map((m) => m.uuid);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
  assert.ok(a.every((u) => u.startsWith(`antigravity:${A}:`)));
  const sub = (await ag.parse(join(logs('antigravity', S), 'transcript.jsonl')))!.msgs.map((m) => m.uuid);
  assert.equal(new Set([...a, ...sub]).size, a.length + sub.length);
});

test('sync: dedupe, metadata, idempotent, append, rewrite keeps .bak, never deletes', async () => {
  sum.exec('BEGIN IMMEDIATE; UPDATE conversation_summaries SET title = title'); // the app's lock: copying -shm → EBUSY
  const live0 = snapshot(LIVE);
  const s1 = ag.sync(ARCH);
  assert.deepEqual(live0, snapshot(LIVE), 'live app data untouched (no -wal/-shm/locks left behind)');
  sum.exec('COMMIT');
  sum.close();
  assert.equal(s1.copied, 5); // A ×2, S, B, E
  assert.equal(s1.noText, 2); // C (0-byte CLI), D (.pb only)
  assert.deepEqual(readdirSync(ARCH).sort(), [A, S, B, E].sort());
  assert.deepEqual(readdirSync(join(ARCH, A)).sort(), ['meta.json', 'transcript.jsonl', 'transcript_full.jsonl']);
  assert.equal(readFileSync(join(ARCH, A, 'transcript.jsonl'), 'utf8'), readFileSync(join(mainLogs, 'transcript.jsonl'), 'utf8'));
  assert.equal(JSON.parse(readFileSync(join(ARCH, A, 'meta.json'), 'utf8')).app, 'antigravity'); // bigger copy wins
  assert.equal(JSON.parse(readFileSync(join(ARCH, E, 'meta.json'), 'utf8')).app, 'antigravity-ide'); // tie → app order

  const pa = (await ag.parse(join(ARCH, A, 'transcript.jsonl')))!;
  assert.equal(pa.cwd, fileURLToPath(URI_A));
  assert.equal(pa.kind, 'main');
  const ps = (await ag.parse(join(ARCH, S, 'transcript.jsonl')))!;
  assert.deepEqual([ps.kind, ps.sessionId, ps.cwd], ['subagent', A, fileURLToPath(URI_A)]);
  assert.equal(ps.msgs.at(-1)!.text, '[message] REPORT: all 3 bugs fixed');
  assert.equal((await ag.parse(join(ARCH, B, 'transcript.jsonl')))!.cwd, fileURLToPath(URI_B));
  assert.deepEqual([...walk(ARCH)].filter(ag.isTranscript).length, 4);

  const s2 = ag.sync(ARCH);
  assert.deepEqual([s2.copied, s2.appended, s2.conflicts, s2.unchanged], [0, 0, 0, 5]);

  appendFileSync(join(mainLogs, 'transcript.jsonl'), st(14, 'USER_INPUT', { content: req('more') }) + '\n');
  const s3 = ag.sync(ARCH);
  assert.deepEqual([s3.appended, s3.unchanged], [1, 4]);
  assert.ok((await ag.parse(join(ARCH, A, 'transcript.jsonl')))!.msgs.some((m) => m.text === 'more'));

  const before = snapshot(ARCH);
  writeFileSync(join(logs('antigravity', S), 'transcript.jsonl'), SUB[0] + '\n'); // rewritten in place
  rmSync(join(LIVE, 'antigravity', 'brain', A), { recursive: true }); // deleted in the 2.0 app; the stale IDE copy remains
  const s4 = ag.sync(ARCH);
  assert.equal(s4.conflicts, 1);
  assert.ok(!readdirSync(join(ARCH, A)).some((f) => f.endsWith('.bak')), 'stale smaller copy did not replace the archive');
  assert.ok(readdirSync(join(ARCH, S)).some((f) => /^transcript\.jsonl\.\d+\.bak$/.test(f)));
  const names = new Set(snapshot(ARCH).map((x) => x.split(':')[0]));
  for (const f of before) assert.ok(names.has(f.split(':')[0]), `archive kept ${f}`);
  assert.ok(existsSync(join(ARCH, A, 'transcript_full.jsonl')));
});
