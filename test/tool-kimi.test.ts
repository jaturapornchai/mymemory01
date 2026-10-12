// Pure tests for src/tools/kimi.ts: synthetic wire logs shaped like real Kimi Code ones, temp dirs only (no DB, no real ~/.kimi-code).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'memhub-kimi-'));
const HOME = join(root, 'kimi-home'), ARCHIVE = join(root, 'raw', 'kimi');
process.env.KIMI_CODE_HOME = HOME; // read at module load
const kimi = await import('../src/tools/kimi.ts');
test.after(() => rmSync(root, { recursive: true, force: true }));

const WD = join(HOME, 'sessions', 'wd_proj_0123456789ab');
const T0 = Date.parse('2026-08-01T10:00:00.000Z');
let sec = 0;
const at = () => T0 + 1000 * sec++;
const rec = (type: string, o: object) => JSON.stringify({ type, ...o, time: at() });
const msg = (role: string, content: object[], origin?: string) => rec('context.append_message', { message: { role, content, toolCalls: [], ...(origin ? { origin: { kind: origin } } : {}) } });
const txt = (text: string) => ({ type: 'text', text });
const ev = (event: object) => rec('context.append_loop_event', { event: { uuid: `u${sec}`, turnId: 't1', step: 1, ...event } });
const part = (type: 'text' | 'think', v: string) => ev({ type: 'content.part', stepUuid: 's1', part: type === 'text' ? { type, text: v } : { type, think: v } });
const call = (name: string, args: object, id = `c${sec}`) => ev({ type: 'tool.call', stepUuid: 's1', toolCallId: id, name, args, description: 'x' });
const result = (id: string, output: string) => ev({ type: 'tool.result', parentUuid: 'p', toolCallId: id, result: { output, note: '' } });
const end = () => ev({ type: 'step.end', usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 }, finishReason: 'stop' });
const state = (extra = {}) => JSON.stringify({ createdAt: '2026-08-01T09:59:00.000Z', updatedAt: '2026-08-01T11:00:00.000Z', title: 't', workDir: 'D:\\proj', lastPrompt: 'p', agents: { main: { homedir: 'h', type: 'main', parentAgentId: null } }, ...extra });

function write(dir: string, name: string, body: string | string[]) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, Array.isArray(body) ? body.join('\n') + '\n' : body);
  return p;
}
const session = (id: string, lines: string[], st = state(), agent = 'main') => {
  const dir = join(WD, id);
  write(dir, 'state.json', st);
  return write(join(dir, 'agents', agent), 'wire.jsonl', lines);
};

const MAIN = 'session_00000000-0000-4000-8000-000000000001';
function mainLog() {
  sec = 0;
  return [
    JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: at() }),
    rec('config.update', { modelAlias: 'k2' }),
    msg('user', [txt('<system-reminder>auto permission notice</system-reminder>')], 'injection'),
    rec('turn.prompt', { input: [txt('fix the login bug')], origin: { kind: 'user' } }),
    msg('user', [txt('fix the login bug'), { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }], 'user'),
    ev({ type: 'step.begin' }),
    part('think', 'planning quietly'),
    part('text', 'Looking at '),
    part('text', 'the auth module.'),
    call('Bash', { command: 'git status', description: 'Show status' }),
    result('c9', 'clean'),
    call('Edit', { path: 'D:\\proj\\src\\auth.ts', old_string: 'a', new_string: 'b' }),
    call('FetchURL', { url: 'https://example.com/docs' }),
    call('Read', { path: 'D:\\proj\\README.md' }),
    call('AskUserQuestion', { questions: [{ header: 'h', question: 'Keep the old token format?', options: [] }] }, 'ask1'),
    result('ask1', 'User chose: keep it'),
    part('text', 'Done, the bug was a stale cookie.'),
    end(),
    '{"type":"context.append_message","message":', // truncated / malformed line
    msg('user', [txt('<notification>task finished</notification>')], 'background_task'),
    msg('user', [txt('cron: check the deploy')], 'cron_job'),
    msg('assistant', [{ type: 'think', think: 'thinking only' }]),
    msg('user', [txt('now add a test')], 'user'),
    msg('user', [txt('now add a test')], 'user'), // re-sent after a cancel
    part('text', 'Added the test.'),
    // no step.end: still streaming when synced, the text so far is kept
  ];
}

test('main log: real prompts, one reply per step, tool lines, junk dropped', async () => {
  const p = await kimi.parse(session(MAIN, mainLog()));
  assert.ok(p);
  assert.equal(p.sessionId, MAIN);
  assert.equal(p.cwd, 'D:\\proj');
  assert.equal(p.kind, 'main');
  assert.deepEqual(p.msgs.map((m) => [m.role, m.text]), [
    ['user', 'fix the login bug'],
    ['assistant', 'Looking at the auth module.'],
    ['assistant', '[Bash] Show status $ git status'],
    ['assistant', '[Edit] D:\\proj\\src\\auth.ts'],
    ['assistant', '[WebFetch] https://example.com/docs'],
    ['assistant', '[Ask] Keep the old token format?'],
    ['assistant', '[Ask result] User chose: keep it'],
    ['assistant', 'Done, the bug was a stale cookie.'],
    ['user', 'now add a test'],
    ['assistant', 'Added the test.'],
  ]);
  assert.ok(p.msgs.every((m) => m.cwd === 'D:\\proj' && m.sessionId === MAIN));
  const ts = p.msgs.map((m) => Date.parse(m.ts));
  assert.ok(ts.every((t, i) => t >= T0 && (i === 0 || t >= ts[i - 1])), 'ts from record time, never backwards');
  assert.equal(p.msgs[0].parentUuid, null);
  assert.ok(p.msgs.slice(1).every((m, i) => m.parentUuid === p.msgs[i].uuid));
});

test('uuids are unique and stable across re-parses and appends', async () => {
  const f = session(MAIN, mainLog());
  const a = await kimi.parse(f);
  appendFileSync(f, end() + '\n' + msg('user', [txt('ship it')], 'user') + '\n');
  const b = await kimi.parse(f);
  assert.ok(a && b);
  assert.equal(new Set(b.msgs.map((m) => m.uuid)).size, b.msgs.length);
  assert.deepEqual(b.msgs.slice(0, a.msgs.length).map((m) => m.uuid), a.msgs.map((m) => m.uuid));
  assert.equal(b.msgs.at(-1)!.text, 'ship it');
  assert.ok(b.msgs.every((m) => m.uuid.startsWith(`kimi:${MAIN}:main:`)));
});

test('migrated 1.0 log (ses_ dir): no origin, no time, whole replies as messages', async () => {
  const id = 'ses_00000000-0000-4000-8000-000000000002';
  const lines = [
    JSON.stringify({ type: 'metadata', protocol_version: '1.0', created_at: Date.parse('2026-05-04T08:00:00.000Z') }),
    JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [txt('<system-reminder>rules</system-reminder>')] } }),
    JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [txt('summarize the backtest')] } }),
    JSON.stringify({ type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'think', think: 'hmm' }, txt('Win rate is flat.')] } }),
    JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [txt('<notification>done</notification>')] } }),
  ];
  const p = await kimi.parse(session(id, lines, state({ createdAt: '2026-05-04T07:00:00.000Z' })));
  assert.ok(p);
  assert.equal(p.sessionId, id);
  assert.deepEqual(p.msgs.map((m) => [m.role, m.text, m.ts]), [
    ['user', 'summarize the backtest', '2026-05-04T08:00:00.000Z'],
    ['assistant', 'Win rate is flat.', '2026-05-04T08:00:00.000Z'],
  ]);
});

test('subagent log: parent session id, task + final answer only', async () => {
  const id = 'session_00000000-0000-4000-8000-000000000003';
  const st = state({ agents: { main: { type: 'main', parentAgentId: null }, 'agent-0': { type: 'sub', parentAgentId: 'main' } } });
  sec = 0;
  const p = await kimi.parse(session(id, [
    msg('user', [txt('Find every caller of parseDate')], 'system_trigger'),
    msg('user', [txt('<system-reminder>x</system-reminder>')], 'injection'),
    part('text', 'Searching.'), end(),
    call('Grep', { pattern: 'parseDate' }),
    part('text', 'Three callers: a.ts, b.ts, c.ts.'), end(),
  ], st, 'agent-0'));
  assert.ok(p);
  assert.equal(p.kind, 'subagent');
  assert.equal(p.sessionId, id);
  assert.deepEqual(p.msgs.map((m) => [m.role, m.text]), [
    ['tool', '[subagent task] Find every caller of parseDate'],
    ['tool', '[subagent result] Three callers: a.ts, b.ts, c.ts.'],
  ]);
  assert.ok(p.msgs.every((m) => m.uuid.includes(':agent-0:')));
});

test('junk files: nothing worth remembering, missing state.json', async () => {
  assert.equal(await kimi.parse(session('session_empty', [JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: T0 }), msg('user', [txt('<system-reminder>x</system-reminder>')], 'injection')])), null);
  const dir = join(root, 'loose', 'wd_x', 'session_nostate', 'agents', 'main');
  const p = await kimi.parse(write(dir, 'wire.jsonl', [msg('user', [txt('hello')], 'user')]));
  assert.ok(p);
  assert.equal(p.cwd, undefined);
  assert.equal(p.msgs[0].text, 'hello');
});

test('state.json version 2 (sessions moved from ~/.kimi) names the folder cwd, not workDir', async () => {
  const st = JSON.stringify({ id: 'x', version: 2, cwd: 'd:/proj2', createdAt: '2026-08-01T09:59:00.000Z', agents: { main: { type: 'main' } } });
  const p = await kimi.parse(session('session_v2state', [msg('user', [txt('hello from a moved session')], 'user')], st));
  assert.equal(p?.cwd, 'd:/proj2');
});

test('state.json without a folder: workspaces.json names it by the wd_ folder', async () => {
  write(HOME, 'workspaces.json', JSON.stringify({ version: 1, workspaces: { wd_proj_0123456789ab: { root: 'd:\\proj3', name: 'proj3' } } }));
  const st = JSON.stringify({ createdAt: '2026-08-01T09:59:00.000Z', title: 't', agents: { main: { type: 'main' } } });
  const p = await kimi.parse(session('ses_nofolder', [msg('user', [txt('hello from an old session')], 'user')], st));
  assert.equal(p?.cwd, 'd:\\proj3');
});

test('import <file>: an archived Kimi log goes to the Kimi parser, a Claude transcript to none', async () => {
  const { ARCHIVE_ROOT, toolFor } = await import('../src/importer.ts');
  assert.equal(toolFor(join(ARCHIVE_ROOT, 'kimi', 'wd_proj_0123456789ab', MAIN, 'agents', 'main', 'wire.jsonl'))?.tool, 'kimi');
  assert.equal(toolFor(join(ARCHIVE_ROOT, 'claude', 'projects', 'd--proj', 'x.jsonl')), undefined);
  assert.equal(toolFor(join(root, 'elsewhere', 'agents', 'main', 'wire.jsonl')), undefined); // outside the archive
});

test('isTranscript: agents/<id>/wire.jsonl only, not .bak copies or metadata', () => {
  const s = join(ARCHIVE, 'wd_proj_0123456789ab', MAIN);
  assert.ok(kimi.isTranscript(join(s, 'agents', 'main', 'wire.jsonl')));
  assert.ok(kimi.isTranscript(join(s, 'agents', 'agent-0', 'wire.jsonl')));
  assert.ok(!kimi.isTranscript(join(s, 'agents', 'main', 'wire.jsonl.1717000000000.bak')));
  assert.ok(!kimi.isTranscript(join(s, 'state.json')));
  assert.ok(!kimi.isTranscript(join(ARCHIVE, 'session_index.jsonl')));
});

test('sync: wire logs + state.json only, idempotent, append, never deletes', () => {
  rmSync(join(HOME, 'sessions'), { recursive: true, force: true });
  const live = session(MAIN, mainLog());
  session('session_00000000-0000-4000-8000-000000000004', [msg('user', [txt('second')], 'user')]);
  write(join(WD, MAIN, 'logs'), 'kimi-code.log', 'debug log');
  write(join(HOME, 'credentials'), 'token.json', '{"token":"never read"}');
  write(HOME, 'config.toml', 'api_key = "never read"');
  write(HOME, 'session_index.jsonl', '{}\n');

  const files = () => [...readdirSync(ARCHIVE, { recursive: true, withFileTypes: true })].filter((e) => e.isFile())
    .map((e) => relative(ARCHIVE, join(e.parentPath, e.name)).replaceAll('\\', '/')).sort();
  assert.deepEqual(kimi.sync(ARCHIVE), { copied: 2 });
  assert.deepEqual(files(), [
    `wd_proj_0123456789ab/${MAIN}/agents/main/wire.jsonl`, `wd_proj_0123456789ab/${MAIN}/state.json`,
    'wd_proj_0123456789ab/session_00000000-0000-4000-8000-000000000004/agents/main/wire.jsonl',
    'wd_proj_0123456789ab/session_00000000-0000-4000-8000-000000000004/state.json',
  ]);
  assert.deepEqual(kimi.sync(ARCHIVE), { unchanged: 2 });

  appendFileSync(live, msg('user', [txt('one more')], 'user') + '\n');
  assert.deepEqual(kimi.sync(ARCHIVE), { appended: 1, unchanged: 1 });

  const before = files();
  rmSync(join(WD, 'session_00000000-0000-4000-8000-000000000004'), { recursive: true }); // user deletes a session
  writeFileSync(live, 'rewritten\n'); // a migration rewrites the log
  assert.deepEqual(kimi.sync(ARCHIVE), { conflicts: 1 });
  const after = files();
  assert.ok(before.every((f) => after.includes(f)), 'sync never deletes archived files');
  assert.ok(after.some((f) => f.endsWith('.bak')), 'rewritten log keeps the old copy');
});
