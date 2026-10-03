import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'memhub-gemini-'));
const live = join(root, 'live'), archive = join(root, 'archive');
process.env.MEMHUB_GEMINI_HOME = live;
const gm = await import('../src/tools/gemini.ts');
const { walk } = await import('../src/importer.ts');
test.after(() => rmSync(root, { recursive: true, force: true }));

const SID = '11111111-2222-4333-8444-555555555555', SID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', SID3 = '99999999-8888-4777-8666-555555555555';
const CTX_ID = '0123456789abcdef0123456789abcdef'; // same fixed id in every real session
const t = (m: number) => new Date(Date.UTC(2026, 8, 1, 10, m)).toISOString();
const header = (sessionId: string, kind = 'main') => ({ sessionId, projectHash: 'f'.repeat(64), startTime: t(0), lastUpdated: t(0), kind });
const ctx = { $set: { messages: [{ id: CTX_ID, timestamp: t(0), type: 'user', content: [{ text: '<session_context>\nOS: win32\nFOLDER TREE' }] }], lastUpdated: t(0) } };
const user = (id: string, m: number, content: any, extra = {}) => ({ id, timestamp: t(m), type: 'user', content, ...extra });
const gem = (id: string, m: number, content: any, toolCalls?: any[]) => ({
  id, timestamp: t(m), type: 'gemini', content, model: 'gemini-x', tokens: { input: 1, output: 2, total: 3 },
  thoughts: [{ subject: 'THOUGHT SUBJECT', description: 'THOUGHT BODY', timestamp: t(m) }], ...(toolCalls ? { toolCalls } : {}),
});
const call = (name: string, args: any) => ({ id: `c-${name}`, name, args, status: 'success', result: [{ functionResponse: { id: 'r', name, response: { output: 'TOOL RESULT' } } }], resultDisplay: 'TOOL DISPLAY' });
const fnResp = [{ functionResponse: { id: 'r', name: 'run_shell_command', response: { output: 'SHELL OUTPUT' } } }];
const jsonl = (rows: any[]) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const put = (rel: string, body: string) => { const f = join(live, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, body); return f; };

const MAIN = 'tmp/proj/chats/session-2026-09-01T10-00-11111111.jsonl';
const mainRows = [
  header(SID), ctx,
  user('u1', 1, [{ text: 'hello gemini' }]),
  gem('g1', 2, '', [call('run_shell_command', { command: 'git status', description: 'd' }), call('read_file', { file_path: 'a.ts' })]),
  gem('g1', 2, 'answer one', [call('run_shell_command', { command: 'git status', description: 'd' }), call('read_file', { file_path: 'a.ts' })]), // upsert: last wins
  user('f1', 3, fnResp),
  { $set: { lastUpdated: t(3) } },
  'not json {',
  { id: 'i1', timestamp: t(3), type: 'info', content: 'INFO NOTICE' },
  user('u2', 4, [{ text: 'see @a.ts' }, { text: '\n--- Content from referenced files ---' }, { text: 'FILE BODY' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }]),
  user('u3', 5, [{ text: 'expanded prompt with FILE BODY' }], { displayContent: [{ text: 'typed prompt' }] }),
  gem('g2', 6, [{ text: 'PART THOUGHT', thought: true }, { text: `pic data:image/png;base64,${'A'.repeat(100)}` }],
    [call('write_file', { file_path: 'b.ts', content: 'BODY' }), call('replace', { file_path: 'c.ts', old_string: 'o', new_string: 'n' }),
      call('google_web_search', { query: 'node sqlite' }), call('web_fetch', { prompt: 'read https://x.test' }),
      call('invoke_agent', { agent_name: 'codebase_investigator', prompt: 'find x' })]),
  user('u5', 6, [{ text: 'x'.repeat(25000) }]),
  user('u4', 7, [{ text: 'REWOUND PROMPT' }]), gem('g4', 8, 'REWOUND ANSWER'), { $rewindTo: 'u4' },
  gem('g5', 9, 'final answer'),
];
// another session reusing the same raw message ids
const OTHER = 'tmp/other/chats/session-2026-09-02T10-00-aaaaaaaa.jsonl';
const otherRows = [header(SID2), ctx, user('c2', 1, '<session_context>\nSTRING CTX'), user('u1', 1, [{ text: 'other hello' }]), gem('g1', 2, 'other answer')];

// /compress: $set.messages = [env ctx, summary, canned ack, kept tail under NEW ids]; context-management prompts live only in $set
const SID4 = '44444444-5555-4666-8777-888888888888', COMP = 'tmp/proj/chats/session-2026-09-03T10-00-44444444.jsonl';
const ctxMsg = ctx.$set.messages[0];
const afterCompress = [ctxMsg, user('s1', 5, [{ text: '<state_snapshot>\nSUMMARY\n</state_snapshot>' }]),
  { id: 'k1', timestamp: t(5), type: 'gemini', content: [{ text: 'Got it. Thanks for the additional context!' }] },
  user('n2', 5, [{ text: 'second prompt' }]), { id: 'm2', timestamp: t(5), type: 'gemini', content: [{ text: 'second' }, { text: ' answer' }, { functionCall: { name: 'x' } }] }];
const agentOut = "Subagent 'codebase_investigator' finished.\nTermination Reason: GOAL\nResult:\nFOUND IT";
const compRows = [
  header(SID4), ctx,
  user('a1', 1, [{ text: 'first prompt' }]), gem('b1', 2, 'first answer'),
  user('a2', 3, [{ text: 'second prompt' }]), gem('b2', 4, 'second answer'),
  { $set: { messages: afterCompress } },
  user('a3', 6, [{ text: 'third prompt' }]), gem('b3', 7, '', [call('ask_user', { questions: [{ question: 'Pick?' }] }), call('invoke_agent', { agent_name: 'codebase_investigator', prompt: 'find y' })]),
  user('r3', 7, [{ functionResponse: { id: 'c-ask_user', name: 'ask_user', response: { output: JSON.stringify({ answers: { 0: 'option B' } }) } } },
    { functionResponse: { id: 'c-invoke_agent', name: 'invoke_agent', response: { output: agentOut } } }]),
  user('a4', 8, [{ text: 'REWOUND' }]), { $rewindTo: 'a4' },
  { $set: { messages: [...afterCompress, user('a3', 6, [{ text: 'third prompt' }]), user('p5', 9, [{ text: 'set-only prompt' }])] } },
];
const SUB2 = `tmp/proj/chats/${SID}/sub-2.jsonl`;
const sub2Rows = [header('sub-2', 'subagent'), user('t1', 1, [{ text: 'investigate x' }]), gem('t2', 2, 'STEP CHATTER', [call('read_file', { file_path: 'a.ts' })]),
  user('t3', 2, fnResp), user('t4', 3, [{ text: 'GRACE NUDGE' }]), gem('t5', 4, '', [{ id: 'c', name: 'complete_task', args: { report: { summary: 'FOUND', files: ['a.ts'] } } }])];

function seed() {
  put('tmp/proj/.project_root', 'd:\\work\\proj');
  put('tmp/other/.project_root', 'd:\\work\\other');
  put('tmp/proj/logs.json', '[]');
  put('oauth_creds.json', '{"token":"SECRET"}');
  put(MAIN, jsonl(mainRows));
  put(OTHER, jsonl(otherRows));
  put(`tmp/proj/chats/${SID}/sub-1.jsonl`, jsonl([header('sub-1', 'subagent'), user('s1', 1, [{ text: 'sub task' }]), gem('s2', 2, 'sub result')]));
  put('tmp/legacy/.project_root', 'd:\\work\\legacy');
  put('tmp/legacy/chats/session-2026-05-01T10-00-99999999.json', JSON.stringify({ ...header(SID3), messages: [ctx.$set.messages[0], user('l1', 1, [{ text: 'legacy q' }]), gem('l2', 2, 'legacy a')] }, null, 2));
  put('tmp/proj/chats/session-2026-07-02T23-12-a2a-serv.jsonl', jsonl([header('a2a-server'), ctx]));
  put('tmp/proj/chats/session-2026-09-19T23-43-skills-l.jsonl', jsonl([header('skills-list-session'), ctx, user('k1', 1, [{ text: 'x' }])]));
  put('tmp/proj/chats/session-2026-09-12T15-34-22222222.jsonl', jsonl([header('22222222-3333-4444-8555-666666666666'), ctx])); // no real turn yet
  put(COMP, jsonl(compRows));
  put(SUB2, jsonl(sub2Rows));
}
seed();
const arch = (rel: string) => join(archive, rel);

test('parse: replay, roles, drops, caps', async () => {
  const p = (await gm.parse(join(live, MAIN)))!;
  assert.equal(p.sessionId, SID);
  assert.equal(p.kind, 'main');
  assert.equal(p.cwd, 'd:\\work\\proj');
  assert.deepEqual(p.msgs.map((m) => m.role), ['user', 'assistant', 'user', 'user', 'assistant', 'user', 'assistant']);
  const [u1, g1, u2, u3, g2, u5, g5] = p.msgs;
  assert.equal(u1.text, 'hello gemini');
  assert.equal(g1.text, 'answer one\n[shell] git status'); // last upsert wins; read_file dropped
  assert.equal(u2.text, 'see @a.ts'); // @file expansion + image dropped
  assert.equal(u3.text, 'typed prompt');
  assert.equal(g2.text, 'pic [data-url]\n[write] b.ts\n[edit] c.ts\n[web_search] node sqlite\n[web_fetch] read https://x.test\n[agent] codebase_investigator: find x');
  assert.equal(u5.text, 'x'.repeat(20000) + ' …[truncated]');
  const all = p.msgs.map((m) => m.text).join('\n');
  for (const junk of ['session_context', 'THOUGHT', 'TOOL RESULT', 'TOOL DISPLAY', 'SHELL OUTPUT', 'INFO NOTICE', 'FILE BODY', 'REWOUND', 'BODY', 'QUJD', 'not json'])
    assert.ok(!all.includes(junk), junk);
  assert.equal(g5.text, 'final answer');
  assert.deepEqual(p.msgs.map((m) => m.uuid), ['u1', 'g1', 'u2', 'u3', 'g2', 'u5', 'g5'].map((id) => `gemini:${SID}:${id}`));
  assert.deepEqual(p.msgs.map((m) => m.parentUuid), [null, ...p.msgs.slice(0, -1).map((m) => m.uuid)]);
  for (let i = 0; i < p.msgs.length; i++) {
    assert.equal(new Date(p.msgs[i].ts).toISOString(), p.msgs[i].ts);
    if (i) assert.ok(p.msgs[i].ts >= p.msgs[i - 1].ts);
  }
});

test('parse: subagent, legacy json, junk', async () => {
  const sub = (await gm.parse(join(live, `tmp/proj/chats/${SID}/sub-1.jsonl`)))!;
  assert.equal(sub.sessionId, SID); // groups with the parent
  assert.equal(sub.kind, 'subagent');
  assert.deepEqual(sub.msgs.map((m) => m.uuid), ['gemini:sub-1:s1', 'gemini:sub-1:s2']);
  // the main agent's prompt is not ลุงจืด's: task + final answer as 'tool', like claude.ts parseSubagent
  assert.deepEqual(sub.msgs.map((m) => [m.role, m.text]), [['tool', '[subagent task] sub task'], ['tool', '[subagent result] sub result']]);
  const sub2 = (await gm.parse(join(live, SUB2)))!;
  assert.deepEqual(sub2.msgs.map((m) => [m.uuid, m.role, m.text]), [['gemini:sub-2:t1', 'tool', '[subagent task] investigate x'],
    ['gemini:sub-2:t5', 'tool', '[subagent result] {"summary":"FOUND","files":["a.ts"]}']]); // complete_task args, no steps
  assert.deepEqual((await gm.parse(join(live, OTHER)))!.msgs.map((m) => m.text), ['other hello', 'other answer']);
  const leg = (await gm.parse(join(live, 'tmp/legacy/chats/session-2026-05-01T10-00-99999999.json')))!;
  assert.equal(leg.sessionId, SID3);
  assert.deepEqual(leg.msgs.map((m) => m.text), ['legacy q', 'legacy a']);
  assert.equal(await gm.parse(join(live, 'tmp/proj/chats/session-2026-07-02T23-12-a2a-serv.jsonl')), null);
  assert.equal(await gm.parse(join(live, 'tmp/proj/chats/session-2026-09-19T23-43-skills-l.jsonl')), null);
  assert.equal(await gm.parse(join(live, 'tmp/proj/chats/session-2026-09-12T15-34-22222222.jsonl')), null);
  assert.equal(await gm.parse(join(root, 'missing.jsonl')), null);
});

test('parse: a history rewrite (/compress) keeps earlier turns; summary, ask/agent results', async () => {
  const p = (await gm.parse(join(live, COMP)))!;
  assert.deepEqual(p.msgs.map((m) => [m.uuid.split(':').at(-1), m.role, m.text]), [
    ['a1', 'user', 'first prompt'], ['b1', 'assistant', 'first answer'], ['a2', 'user', 'second prompt'], ['b2', 'assistant', 'second answer'],
    ['s1', 'summary', '<state_snapshot>\nSUMMARY\n</state_snapshot>'], // ack dropped, tail copies n2/m2 not duplicated
    ['a3', 'user', 'third prompt'], ['b3', 'assistant', '[ask] Pick?\n[agent] codebase_investigator: find y'],
    ['r3', 'tool', `[ask result] option B\n[agent result] ${agentOut}`],
    ['p5', 'user', 'set-only prompt'], // a4 rewound
  ]);
  for (let i = 1; i < p.msgs.length; i++) assert.ok(p.msgs[i].ts >= p.msgs[i - 1].ts);
});

test('uuids: unique across sessions, stable across parses', async () => {
  const files = [...walk(live)].filter(gm.isTranscript);
  const run = async () => (await Promise.all(files.map((f) => gm.parse(f)))).flatMap((p) => p?.msgs.map((m) => m.uuid) ?? []);
  const a = await run(), b = await run();
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
  assert.ok(a.includes(`gemini:${SID}:u1`) && a.includes(`gemini:${SID2}:u1`)); // same raw id, different sessions
});

test('sync: junk filtered, metadata copied, idempotent, append, never deletes', async () => {
  assert.deepEqual(gm.sync(archive), { copied: 6, junk: 2, empty: 1 });
  assert.ok(!existsSync(arch('tmp/proj/chats/session-2026-07-02T23-12-a2a-serv.jsonl')));
  assert.ok(!existsSync(arch('tmp/proj/chats/session-2026-09-12T15-34-22222222.jsonl')));
  assert.ok(!existsSync(arch('oauth_creds.json')) && !existsSync(arch('tmp/proj/logs.json')));
  assert.ok(existsSync(arch('tmp/proj/.project_root')) && existsSync(arch(`tmp/proj/chats/${SID}/sub-1.jsonl`)));
  const p = (await gm.parse(arch(MAIN)))!; // parse reads the archive only
  assert.equal(p.cwd, 'd:\\work\\proj');
  assert.equal(p.msgs.length, 7);

  assert.deepEqual(gm.sync(archive), { unchanged: 6, junk: 2, empty: 1 });

  appendFileSync(join(live, MAIN), jsonl([user('u6', 10, [{ text: 'next prompt' }])]));
  assert.deepEqual(gm.sync(archive), { appended: 1, unchanged: 5, junk: 2, empty: 1 });
  assert.equal((await gm.parse(arch(MAIN)))!.msgs.at(-1)!.text, 'next prompt');

  const before = [...walk(archive)];
  unlinkSync(join(live, OTHER)); // Gemini's 30-day retention deletes live chats
  put(MAIN, jsonl([header(SID), user('n1', 1, [{ text: 'rewritten' }])])); // rewritten, not appended
  const r = gm.sync(archive);
  assert.equal(r.conflicts, 1);
  const after = [...walk(archive)];
  for (const f of before) assert.ok(after.includes(f), f);
  assert.ok(existsSync(arch(OTHER)));
  assert.equal(after.filter((f) => f.endsWith('.bak')).length, 1);
  assert.ok(!after.filter((f) => f.endsWith('.bak')).some(gm.isTranscript)); // old version kept, not re-indexed

  // a big file is archived without the empty check (a >512 MB one can't even be read as a string: it would never be archived)
  const BIG = 'tmp/proj/chats/session-2026-09-20T10-00-55555555.jsonl';
  put(BIG, jsonl([header('55555555-6666-4777-8888-999999999999'), { $set: { lastUpdated: t(1), pad: 'p'.repeat(1 << 20) } }]));
  assert.equal(gm.sync(archive).copied, 1);
  assert.ok(existsSync(arch(BIG)));
});

test('a 30 MB inline data URL is dropped without overflowing the regexp stack', async () => {
  const file = join(root, 'big', 'session-2026-09-01T10-00-99999999.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, jsonl([header(SID3), user('b1', 1, [{ text: `see data:image/png;base64,${'A'.repeat(30e6)} ok` }]), gem('b2', 2, 'done')]));
  assert.deepEqual((await gm.parse(file))!.msgs.map((m) => m.text), ['see [data-url] ok', 'done']);
});

test("memory-hub's own SessionStart hook text (<hook_context>) is not indexed as part of the prompt", async () => {
  const f = put('tmp/hook/chats/session-2026-09-01T11-00-99999999.jsonl', jsonl([header(SID3),
    user('h1', 1, [{ text: '<hook_context>[memory-hub] rules + handoffs</hook_context> real prompt' }]), gem('h2', 2, 'ok')]));
  assert.deepEqual((await gm.parse(f))!.msgs.map((m) => [m.role, m.text]), [['user', 'real prompt'], ['assistant', 'ok']]);
});
