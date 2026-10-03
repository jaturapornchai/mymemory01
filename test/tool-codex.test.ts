// Pure tests for src/tools/codex.ts: synthetic rollouts shaped like real Codex ones, temp dirs only (no DB, no real ~/.codex).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'memhub-codex-'));
const HOME = join(root, 'codex-home'), ARCHIVE = join(root, 'raw', 'codex'), SNAP = join(root, 'raw', 'codex-sessions-2026-10-01');
process.env.MEMHUB_CODEX_HOME = HOME; // read at module load
const codex = await import('../src/tools/codex.ts');
test.after(() => rmSync(root, { recursive: true, force: true }));

const MAIN = '019e0000-0000-7000-8000-000000000001', SUB = '019e0000-0000-7000-8000-000000000002';
const OLD = '019e0000-0000-7000-8000-000000000003', GUARD = '019e0000-0000-7000-8000-000000000004';
const SUB2 = '019e0000-0000-7000-8000-000000000005';
const name = (id: string, t = '2026-06-04T17-45-35') => `rollout-${t}-${id}.jsonl`;
const B64 = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(500_000); // ~5.5 MB: pushes its line over the 4 MB cap

let ord = 0, sec = 0;
const rec = (type: string, payload: object, o: { ordinal?: number | null } = {}) => {
  const ordinal = o.ordinal === undefined ? ord++ : o.ordinal;
  return JSON.stringify({ timestamp: `2026-06-04T10:00:${String(sec++ % 60).padStart(2, '0')}.000Z`, ...(ordinal === null ? {} : { ordinal }), type, payload });
};
const msg = (role: string, content: object[], extra = {}) => rec('response_item', { type: 'message', role, content, ...extra });
const ut = (text: string) => ({ type: 'input_text', text });
const say = (text: string, phase = 'final_answer') => msg('assistant', [{ type: 'output_text', text }], { phase });
const item = (it: object) => rec('event_msg', { type: 'item_completed', thread_id: MAIN, turn_id: 't', item: { id: 'i', ...it } });
const meta = (id: string, extra = {}) => rec('session_meta', {
  id, session_id: id, timestamp: '2026-06-04T10:00:00.000Z', cwd: 'D:\\proj', originator: 'Codex Desktop', cli_version: '0.147.0',
  source: 'vscode', thread_source: 'user', base_instructions: { text: 'You are Codex.' }, creator_user_id: 'u', ...extra,
});
const beat = (t: string) => msg('user', [ut(`<heartbeat><automation_id>a1</automation_id><current_time_iso>${t}</current_time_iso><instructions>check the deploy</instructions></heartbeat>`)]);

function mainFile() {
  ord = 0;
  return [
    meta(MAIN),
    rec('world_state', { full: true, state: { agents_md: { text: 'rules' } } }),
    rec('turn_context', { turn_id: 't', cwd: 'D:\\proj', model: 'gpt' }),
    msg('developer', [ut('<permissions instructions>sandboxed</permissions instructions>')]),
    msg('user', [ut('# AGENTS.md instructions for D:\\proj\n\n<INSTRUCTIONS>be terse</INSTRUCTIONS>'), ut('<environment_context>\n<cwd>D:\\proj</cwd>\n</environment_context>')]),
    rec('event_msg', { type: 'user_message', message: 'fix the bug', images: [] }),
    msg('user', [ut('# Context from my IDE setup:\n\n## Active file: src/a.ts\n\n## My request for Codex:\nfix the bug'), { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]),
    item({ type: 'UserMessage', content: [{ type: 'text', text: 'fix the bug' }] }),
    rec('response_item', { type: 'reasoning', summary: [], content: null, encrypted_content: 'gAAAA' }),
    say('Looking at the repo.', 'commentary'),
    rec('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.shell_command({command: "git status"}); text(r)' }),
    item({ type: 'CommandExecution', command: ['pwsh.exe', '-Command', 'git status'], cwd: 'D:\\proj', aggregated_output: 'clean', status: 'completed' }),
    rec('response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }),
    rec('response_item', { type: 'function_call', name: 'shell_command', arguments: '{"command":"git diff","workdir":"D:\\\\proj"}', call_id: 'c2' }), // direct call: never gets an item
    rec('response_item', { type: 'function_call_output', call_id: 'c2', output: 'secret output' }),
    item({ type: 'FileChange', changes: { 'D:\\proj\\src\\a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@', move_path: null } }, status: 'completed' }),
    item({ type: 'WebSearch', query: 'node sqlite readOnly', action: { type: 'search', query: 'node sqlite readOnly' } }),
    item({ type: 'WebSearch', query: '', action: { type: 'other' } }),
    item({ type: 'McpToolCall', server: 'node_repl', tool: 'js', arguments: { code: '1+1' } }),
    item({ type: 'Reasoning', content: [] }),
    '{"timestamp":"2026-06-04T10:01:00.000Z","ordinal":', // truncated / malformed line
    msg('user', [ut('look at this screenshot'), { type: 'input_image', image_url: B64 }]), // > 4 MB line: prompt kept
    rec('response_item', { type: 'custom_tool_call_output', call_id: 'c3', output: [{ type: 'input_text', text: 'x'.repeat(5 << 20) }] }), // > 4 MB, no image: skipped
    rec('response_item', { type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'scout', message: 'scan the repo' }), call_id: 'c4' }),
    rec('response_item', { type: 'function_call', name: 'wait_agent', arguments: '{"timeout_ms":1000}', call_id: 'c5' }),
    rec('response_item', { type: 'agent_message', author: '/root/scout', recipient: '/root', content: [ut('found 3 files'), { type: 'encrypted_content', encrypted_content: 'gAAAA' }] }),
    beat('2026-06-04T10:02:00Z'),
    say('Deploy is fine.'),
    beat('2026-06-04T11:02:00Z'), // same automation instructions again: dropped
    msg('user', [ut('<turn_aborted>\nThe user interrupted.\n</turn_aborted>')]),
    msg('user', [ut('<recommended_plugins>\n- a\n</recommended_plugins>')]),
    rec('event_msg', { type: 'task_complete', turn_id: 't', last_agent_message: 'Deploy is fine.' }),
    rec('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1 } }, rate_limits: { credits: 1 } }),
    rec('compacted', { message: 'summary', replacement_history: [{ type: 'message', role: 'user', content: [ut('fix the bug')] }] }),
    msg('user', [ut('no ordinal on this line')], {}).replace(/"ordinal":\d+,/, ''),
    say('y'.repeat(25000)),
  ].join('\n') + '\n';
}

function subFile() {
  ord = 0;
  return [
    meta(SUB, { session_id: MAIN, thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: MAIN, depth: 1, agent_path: '/root/scout' } } },
      parent_thread_id: MAIN, forked_from_id: MAIN, subagent_history_start_ordinal: 4 }),
    meta(MAIN), // forked parent's own session_meta (replayed)
    msg('user', [ut('fix the bug')]), // replayed parent history: ordinals < 4
    say('Looking at the repo.'),
    rec('response_item', { type: 'agent_message', author: '/root', recipient: '/root/scout', content: [ut('scan the repo')] }),
    say('checking', 'commentary'),
    item({ type: 'CommandExecution', command: ['pwsh.exe', '-Command', 'rg foo'], status: 'completed' }),
    say('found 3 files'),
  ].join('\n') + '\n';
}

function subOldFile() { // Codex ≤ 0.149: start ordinal is one past the last record, so the task message marks the own part
  ord = 0;
  const lines = [
    rec('compacted', { message: 'summary', replacement_history: [] }),
    msg('user', [ut('fix the bug')]), // replayed parent history
    say('Parent answer before the spawn.'),
    rec('response_item', { type: 'agent_message', author: '/root/scout', recipient: '/root', content: [ut('found 3 files')] }), // parent's inbox
    rec('response_item', { type: 'agent_message', author: '/root', recipient: '/root/fixer', content: [ut('patch a.ts')] }),
    say('working', 'commentary'),
    rec('response_item', { type: 'agent_message', author: '/root', recipient: '/root/fixer', content: [ut('also b.ts')] }), // followup
    say('patched a.ts and b.ts'),
  ];
  return [meta(SUB2, { cli_version: '0.147.0', thread_source: 'subagent', subagent_history_start_ordinal: ord + 1,
    source: { subagent: { thread_spawn: { parent_thread_id: MAIN, depth: 1, agent_path: '/root/fixer' } } } }), ...lines].join('\n') + '\n';
}

function oldFile() { // codex 0.125: no item_completed, tools only as raw calls
  ord = 0;
  return [
    meta(OLD, { cli_version: '0.125.0', source: 'exec', thread_source: undefined, originator: 'codex_exec' }),
    msg('user', [ut('show history')]),
    rec('event_msg', { type: 'user_message', message: 'show history' }),
    rec('response_item', { type: 'function_call', name: 'shell_command', arguments: '{"command":"git log -1","timeout_ms":1000}', call_id: 'a' }),
    rec('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'b', input: '*** Begin Patch\n*** Update File: D:\\p\\x.ts\n@@\n-a\n+b\n*** Add File: D:\\p\\y.ts\n+c\n*** End Patch' }),
    rec('response_item', { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://nodejs.org/api/sqlite.html' } }),
    say('Last commit is abc.'),
  ].join('\n') + '\n';
}

const guardFile = () => { ord = 0; return [meta(GUARD, { thread_source: 'guardian_review', source: { subagent: { other: 'guardian' } } }), msg('user', [ut('review this')]), say('approve')].join('\n') + '\n'; };

const fx = join(root, 'fixtures');
mkdirSync(fx, { recursive: true });
const write = (dir: string, n: string, body: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, n), body); return join(dir, n); };
const mainPath = write(fx, name(MAIN), mainFile()), subPath = write(fx, name(SUB), subFile());
const sub2Path = write(fx, name(SUB2), subOldFile());
const oldPath = write(fx, name(OLD), oldFile()), guardPath = write(fx, name(GUARD), guardFile());

test('main rollout: real turns once, boilerplate/duplicates/junk dropped', async () => {
  const p = (await codex.parse(mainPath))!;
  assert.equal(p.sessionId, MAIN);
  assert.equal(p.kind, 'main');
  assert.equal(p.cwd, 'D:\\proj');
  const got = p.msgs.map((m) => [m.role, m.text.length > 200 ? `${m.text.slice(0, 5)}…${m.text.length}` : m.text]);
  assert.deepEqual(got, [
    ['user', 'fix the bug'],
    ['assistant', 'Looking at the repo.'],
    ['assistant', '[shell] git status'],
    ['assistant', '[shell] git diff'],
    ['assistant', '[edit] D:\\proj\\src\\a.ts'],
    ['assistant', '[web_search] node sqlite readOnly'],
    ['user', 'look at this screenshot'],
    ['assistant', '[agent] scout: scan the repo'],
    ['tool', '[agent /root/scout] found 3 files'],
    ['user', '[automation] check the deploy'],
    ['assistant', 'Deploy is fine.'],
    ['user', 'no ordinal on this line'],
    ['assistant', `yyyyy…${20000 + ' …[truncated]'.length}`],
  ]);
  assert.ok(p.msgs.every((m) => !m.text.includes('base64') && !m.text.includes('AGENTS.md') && !m.text.includes('secret output')));
  assert.ok(p.msgs.every((m) => m.sessionId === MAIN && /^\d{4}-\d\d-\d\dT.*Z$/.test(m.ts)));
  assert.ok(p.msgs.every((m, i) => i === 0 || m.ts >= p.msgs[i - 1].ts), 'ts never goes backwards');
  assert.equal(p.msgs[0].parentUuid, null);
  assert.ok(p.msgs.slice(1).every((m, i) => m.parentUuid === p.msgs[i].uuid));
  assert.match(p.msgs.find((m) => m.text === 'no ordinal on this line')!.uuid, new RegExp(`^codex:${MAIN}:L\\d+$`));
});

test('subagent rollout: parent session id, replayed parent history skipped, task + result only', async () => {
  const p = (await codex.parse(subPath))!;
  assert.equal(p.kind, 'subagent');
  assert.equal(p.sessionId, MAIN);
  assert.deepEqual(p.msgs.map((m) => [m.role, m.text]), [['tool', '[subagent task] scan the repo'], ['tool', '[subagent result] found 3 files']]);
  assert.ok(p.msgs.every((m) => m.uuid.startsWith(`codex:${SUB}:`)), 'own thread id namespaces the uuids');
  const q = (await codex.parse(sub2Path))!;
  assert.equal(q.sessionId, MAIN);
  assert.deepEqual(q.msgs.map((m) => m.text), ['[subagent task] patch a.ts', '[subagent result] patched a.ts and b.ts']);
});

test('old raw-call format, guardian threads, junk files', async () => {
  const p = (await codex.parse(oldPath))!;
  assert.equal(p.kind, 'headless'); // codex exec: searchable, never dreamed
  assert.deepEqual(p.msgs.map((m) => m.text), ['show history', '[shell] git log -1', '[edit] D:\\p\\x.ts D:\\p\\y.ts', '[web_fetch] https://nodejs.org/api/sqlite.html', 'Last commit is abc.']);
  assert.equal(await codex.parse(guardPath), null);
  assert.equal(await codex.parse(write(fx, name('019e0000-0000-7000-8000-00000000000f'), 'not json\n\n{}\n')), null);
  assert.equal(await codex.parse(write(fx, name('019e0000-0000-7000-8000-00000000000e'), '')), null);
});

test('uuids are unique across files and stable across re-parses', async () => {
  const all = async () => (await Promise.all([mainPath, subPath, sub2Path, oldPath].map((f) => codex.parse(f)))).flatMap((p) => p!.msgs);
  const a = await all(), b = await all();
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map((m) => m.uuid)).size, a.length);
  assert.ok(a.every((m) => m.uuid.startsWith('codex:')));
});

test('user text: raw U+2028 kept, goal continuations once, image wrappers dropped', async () => {
  const REV = '019e0000-0000-7000-8000-000000000006';
  const goal = (o: string) => msg('user', [ut(`<codex_internal_context source="goal">\nContinue toward the goal.\n<objective>\n${o}\n</objective>\n</codex_internal_context>`)]);
  ord = 0;
  const rev = write(fx, name(REV), [
    meta(REV),
    msg('user', [ut('pasted\u2028from a web page')]), // serde_json leaves U+2028 raw; readline split the record in two
    say('answer\u2029with a paragraph separator'),
    goal('ship the importer'),
    say('working on it'),
    goal('ship the importer'), // continuation re-sends the same objective
    msg('user', [ut('<image name=[Image #1] path="C:\\Users\\u\\.codex\\clip.png">'), { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }, ut('</image>'), ut('what is this?')]),
  ].join('\n') + '\n');
  const p = (await codex.parse(rev))!;
  assert.deepEqual(p.msgs.map((m) => [m.role, m.text]), [
    ['user', 'pasted\u2028from a web page'],
    ['assistant', 'answer\u2029with a paragraph separator'],
    ['user', '[goal] ship the importer'],
    ['assistant', 'working on it'],
    ['user', 'what is this?'],
  ]);
});

test('ids: nested subagent groups with the root conversation, a repeated ordinal never repeats a uuid', async () => {
  const DEEP = '019e0000-0000-7000-8000-000000000007', DUP = '019e0000-0000-7000-8000-000000000008';
  ord = 0; // depth 2: spawned by the subagent SUB; session_id names the root conversation MAIN
  const deep = write(fx, name(DEEP), [
    meta(DEEP, { session_id: MAIN, thread_source: 'subagent', subagent_history_start_ordinal: 1,
      source: { subagent: { thread_spawn: { parent_thread_id: SUB, depth: 2, agent_path: '/root/scout/deep' } } } }),
    rec('response_item', { type: 'agent_message', author: '/root/scout', recipient: '/root/scout/deep', content: [ut('dig deeper')] }),
    say('dug'),
  ].join('\n') + '\n');
  const q = (await codex.parse(deep))!;
  assert.equal(q.kind, 'subagent');
  assert.equal(q.sessionId, MAIN);
  assert.deepEqual(q.msgs.map((m) => m.text), ['[subagent task] dig deeper', '[subagent result] dug']);

  ord = 0; // one real file repeats an ordinal: the same uuid twice would fail the session's whole PG insert
  const dup = write(fx, name(DUP), [meta(DUP), msg('user', [ut('go')]), say('first'), rec('event_msg', { type: 'token_count' }, { ordinal: 2 }),
    say('second').replace(/"ordinal":\d+/, '"ordinal":2')].join('\n') + '\n');
  const d = (await codex.parse(dup))!;
  assert.deepEqual(d.msgs.map((m) => m.text), ['go', 'first', 'second']);
  assert.equal(new Set(d.msgs.map((m) => m.uuid)).size, 3);
});

test('ask line: request_user_input_async questions carry {title, options}', async () => {
  const ASK = '019e0000-0000-7000-8000-000000000009';
  ord = 0;
  const ask = write(fx, name(ASK), [meta(ASK), msg('user', [ut('plan it')]), rec('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'q',
    arguments: JSON.stringify({ questions: [{ title: 'Which DB?', options: [{ label: 'PG' }] }, { title: 'Deadline?' }] }) })].join('\n') + '\n');
  assert.equal((await codex.parse(ask))!.msgs[1].text, '[ask] Which DB? | Deadline?');
});

test('tool lines: direct shell calls kept beside items, item of a logged call and web_search_call twins dropped', async () => {
  const MIX = '019e0000-0000-7000-8000-00000000000b';
  ord = 0;
  const call = (name: string, call_id: string, more: object) => rec('response_item', { type: name === 'apply_patch' ? 'custom_tool_call' : 'function_call', name, call_id, ...more });
  const mix = write(fx, name(MIX), [
    meta(MIX, { cli_version: '0.144.0' }),
    msg('user', [ut('deploy')]),
    call('shell_command', 's1', { arguments: '{"command":"npm test"}' }), // 11 real threads: ~15.7k of these, items for 58 code-mode calls only
    call('apply_patch', 'p1', { input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch' }),
    item({ id: 'p1', type: 'FileChange', changes: { 'D:\\proj\\src\\a.ts': { type: 'update' } } }), // same call as p1
    rec('response_item', { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'pg 18' } }),
    item({ id: 'ws_1', type: 'WebSearch', query: 'pg 18', action: { type: 'search', query: 'pg 18' } }), // twin of the call above
    rec('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'x1', input: 'await tools.shell_command({command: "git push"})' }),
    item({ id: 'cmd_1', type: 'CommandExecution', command: ['pwsh.exe', '-Command', 'git push'], source: 'unified_exec_startup' }),
  ].join('\n') + '\n');
  assert.deepEqual((await codex.parse(mix))!.msgs.map((m) => m.text), ['deploy', '[shell] npm test', '[edit] src/a.ts', '[web_search] pg 18', '[shell] git push']);
});

test('isTranscript: rollout jsonl only, not .bak copies', () => {
  assert.ok(codex.isTranscript(join(ARCHIVE, '2026', '06', '04', name(MAIN))));
  assert.ok(!codex.isTranscript(join(ARCHIVE, '2026', '06', '04', `${name(MAIN)}.1717000000000.bak`)));
  assert.ok(!codex.isTranscript(join(ARCHIVE, 'session_index.jsonl')));
});

test('sync: archive keyed by file name, idempotent, append, move, never deletes', () => {
  const day = join(HOME, 'sessions', '2026', '06', '04');
  const live = write(day, name(MAIN), mainFile());
  write(join(HOME, 'archived_sessions'), name(SUB, '2026-06-05T08-00-00'), subFile());
  write(day, name(GUARD), guardFile());
  write(HOME, 'auth.json', '{"token":"never read"}');
  write(join(HOME, 'sessions'), 'notes.txt', 'x');
  const gone = '019e0000-0000-7000-8000-00000000000a'; // only in the snapshot → seeded; MAIN in the snapshot is ignored (live is newer)
  write(join(SNAP, '2026', '05', '01'), name(gone, '2026-05-01T00-00-00'), oldFile());
  write(join(SNAP, '2026', '06', '04'), name(MAIN), 'stale snapshot copy\n');

  const files = () => [...readdirSync(ARCHIVE, { recursive: true, withFileTypes: true })].filter((e) => e.isFile())
    .map((e) => relative(ARCHIVE, join(e.parentPath, e.name)).replaceAll('\\', '/')).sort();
  assert.deepEqual(codex.sync(ARCHIVE), { copied: 2, guardian: 1, seeded: 1 });
  assert.deepEqual(files(), [`2026/05/01/${name(gone, '2026-05-01T00-00-00')}`, `2026/06/04/${name(MAIN)}`, `2026/06/05/${name(SUB, '2026-06-05T08-00-00')}`]);
  assert.deepEqual(codex.sync(ARCHIVE), { unchanged: 2, guardian: 1 });

  appendFileSync(live, say('one more') + '\n');
  assert.deepEqual(codex.sync(ARCHIVE), { appended: 1, unchanged: 1, guardian: 1 });

  mkdirSync(join(HOME, 'archived_sessions'), { recursive: true }); // user archives the thread: file moves, no duplicate copy
  renameSync(live, join(HOME, 'archived_sessions', name(MAIN)));
  assert.deepEqual(codex.sync(ARCHIVE), { unchanged: 2, guardian: 1 });
  const before = files();

  rmSync(join(HOME, 'archived_sessions', name(SUB, '2026-06-05T08-00-00'))); // Codex prunes / user deletes a thread
  writeFileSync(join(HOME, 'archived_sessions', name(MAIN)), 'rewritten\n'); // migration rewrites a rollout
  assert.deepEqual(codex.sync(ARCHIVE), { conflicts: 1, guardian: 1 });
  const after = files();
  assert.ok(before.every((f) => after.includes(f)), 'sync never deletes archived files');
  assert.ok(after.some((f) => f.endsWith('.bak')), 'rewritten rollout keeps the old copy');
});
