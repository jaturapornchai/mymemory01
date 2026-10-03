import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'memhub-lmstudio-'));
process.env.MEMHUB_LMSTUDIO_HOME = join(root, 'live');
const lm = await import('../src/tools/lmstudio.ts');
test.after(() => rmSync(root, { recursive: true, force: true }));

const T0 = 1777000000000;
const user = (text: string, extra: any[] = []) => ({ currentlySelected: 0, versions: [{ type: 'singleStep', role: 'user', content: [...extra, { type: 'text', text }] }] });
const block = (text: string, more: any = {}) => ({ type: 'contentBlock', stepIdentifier: 's', content: [{ type: 'text', text, isStructural: false }], ...more });
const assistant = (steps: any[]) => ({ type: 'multiStep', role: 'assistant', senderInfo: { senderName: 'm' }, steps });
const call = { type: 'toolCallRequest', callId: 1, toolCallRequestId: 'r1', name: 'brain_search', parameters: { query: 'pg index' }, pluginIdentifier: 'mcp/demo-brain' };

const chat = {
  name: 'n', pinned: false, createdAt: T0, preset: '', tokenCount: 9, systemPrompt: 'SYSTEM BOILERPLATE',
  userLastMessagedAt: T0 + 100000, assistantLastMessagedAt: T0 + 200000,
  messages: [
    user('hello lm', [{ type: 'file', fileIdentifier: 'img.png' }]),
    { currentlySelected: 1, versions: [ // regeneration: only the selected version counts
      assistant([block('OLD DRAFT')]),
      assistant([
        block('THINKING TEXT', { style: { type: 'thinking', ended: true, title: 't' }, prefix: '<think>', suffix: '</think>' }),
        block('answer one', { genInfo: { identifier: 'gemma', stats: { predictedTokensCount: 5 } } }),
        { type: 'contentBlock', stepIdentifier: 's2', content: [call] },
        { type: 'requestConfirmToolCall', stepIdentifier: 's3', request: { ...call, type: 'x' }, response: { type: 'approved' } },
        { type: 'toolStatus', stepIdentifier: 's4', callId: 1, statusState: { status: { type: 'toolCallSucceeded' } } },
        { type: 'contentBlock', stepIdentifier: 's5', roleOverride: 'tool', content: [{ type: 'toolCallResult', callId: 1, toolCallRequestId: 'r1', content: 'TOOL OUTPUT', name: 'brain_search' }] },
        { type: 'contentBlock', stepIdentifier: 's6', content: [{ type: 'text', text: '<|channel|>', isStructural: true }, { type: 'text', text: 'answer ' }, { type: 'text', text: 'two' }] },
        { type: 'debugInfoBlock', stepIdentifier: 's7', debugInfo: 'DEBUG INFO' },
        { type: 'someFutureStep', content: 42 },
      ]),
    ] },
    { versions: 'junk' },
    null,
    { currentlySelected: 0, versions: [assistant([block('ONLY THINKING', { style: { type: 'thinking' } })])] },
    user(`see data:image/png;base64,${'A'.repeat(200)} and ${'x'.repeat(25000)}`),
    { currentlySelected: 0, versions: [assistant([block('<think>INLINE REASONING</think>visible after')])] },
  ],
  plugins: ['mcp/demo-brain'], lastUsedModel: { identifier: 'gemma' }, notes: [], looseFiles: [],
};

const write = (p: string, o: unknown) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o)); return p; };
const fx = join(root, 'fx');

test('parse keeps prompts, visible answers and one-line tool calls; drops thinking/results/debug/junk', async () => {
  const p = (await lm.parse(write(join(fx, `${T0}.conversation.json`), chat)))!;
  assert.equal(p.sessionId, `lmstudio-${T0}`);
  assert.equal(p.cwd, undefined);
  assert.deepEqual(p.msgs.map((m) => m.uuid), [0, 1, 5, 6].map((i) => `lmstudio:${T0}:${i}`));
  assert.deepEqual(p.msgs.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(p.msgs[0].text, 'hello lm');
  assert.equal(p.msgs[1].text, 'answer one\n[brain_search] {"query":"pg index"}\nanswer two');
  assert.match(p.msgs[2].text, /^see \[data-url\] and x+ …\[truncated\]$/);
  assert.ok(p.msgs[2].text.length <= 20000 + 20);
  assert.equal(p.msgs[3].text, 'visible after');
  const all = JSON.stringify(p);
  for (const junk of ['SYSTEM BOILERPLATE', 'OLD DRAFT', 'THINKING', 'TOOL OUTPUT', 'DEBUG', 'channel', 'INLINE REASONING', 'AAAA']) assert.ok(!all.includes(junk), junk);
  const ts = p.msgs.map((m) => Date.parse(m.ts));
  assert.deepEqual(ts, [T0, T0 + 1, T0 + 5, T0 + 6]);
  assert.equal(p.msgs[0].parentUuid, null);
  assert.equal(p.msgs[1].parentUuid, p.msgs[0].uuid);
});

test('ts never passes the last-messaged time; empty / malformed chats are null', async () => {
  const msgs = [user('a'), { currentlySelected: 0, versions: [assistant([block('b')])] }, user('c'), user('d')];
  const p = (await lm.parse(write(join(fx, '5.conversation.json'), { createdAt: T0, userLastMessagedAt: T0 + 2, messages: msgs })))!;
  assert.deepEqual(p.msgs.map((m) => Date.parse(m.ts)), [T0, T0 + 1, T0 + 2, T0 + 2]);
  assert.equal(await lm.parse(write(join(fx, '6.conversation.json'), { createdAt: T0, messages: [] })), null);
  assert.equal(await lm.parse(write(join(fx, '7.conversation.json'), '{"messages": [')), null);
  assert.equal(await lm.parse(write(join(fx, '8.conversation.json'), { createdAt: 'bad', messages: [user('x')] })).then((r) => typeof r?.msgs[0].ts), 'string');
});

test('a <think> mention is kept, only leading inline reasoning goes; text before a call stays before it', async () => {
  const msgs = [
    user('why does <think> leak? keep all of this'),
    { currentlySelected: 0, versions: [assistant([
      { type: 'contentBlock', stepIdentifier: 's', content: [{ type: 'text', text: 'let me look' }, call, { type: 'text', text: 'the <think> tag wraps reasoning' }] },
      block('<think>UNCLOSED REASONING'),
    ])] },
  ];
  const p = (await lm.parse(write(join(fx, '9.conversation.json'), { createdAt: T0, messages: msgs })))!;
  assert.equal(p.msgs[0].text, 'why does <think> leak? keep all of this');
  assert.equal(p.msgs[1].text, 'let me look\n[brain_search] {"query":"pg index"}\nthe <think> tag wraps reasoning');
});

test('uuids are unique across chats and stable across re-parses', async () => {
  const a = join(fx, `${T0}.conversation.json`), b = write(join(fx, 'sub', `${T0 + 9}.conversation.json`), chat);
  const [a1, a2, b1] = [await lm.parse(a), await lm.parse(a), await lm.parse(b)];
  assert.deepEqual(a1, a2);
  const ids = [...a1!.msgs, ...b1!.msgs].map((m) => m.uuid);
  assert.equal(new Set(ids).size, ids.length);
});

test('sync: copy, unchanged, folder move, append, rewrite keeps .bak, mid-write skipped, never deletes', () => {
  const live = join(root, 'live', 'conversations'), arch = join(root, 'archive');
  const f1 = write(join(live, `${T0}.conversation.json`), chat);
  write(join(live, 'Folder A', `${T0 + 1}.conversation.json`), { createdAt: T0 + 1, messages: [] });
  write(join(live, 'notes.txt'), 'not a chat');
  assert.deepEqual(lm.sync(arch), { copied: 2 });
  assert.ok(existsSync(join(arch, 'conversations', `${T0 + 1}.conversation.json`))); // flat: chat id, not its folder
  assert.ok(!existsSync(join(arch, 'conversations', 'notes.txt')));
  assert.deepEqual(lm.sync(arch), { unchanged: 2 });
  mkdirSync(join(live, 'Folder B')); // chat dragged to another folder in the app = its file moves
  renameSync(join(live, 'Folder A', `${T0 + 1}.conversation.json`), join(live, 'Folder B', `${T0 + 1}.conversation.json`));
  assert.deepEqual(lm.sync(arch), { unchanged: 2 });
  appendFileSync(f1, '\n');
  assert.deepEqual(lm.sync(arch), { appended: 1, unchanged: 1 });
  writeFileSync(f1, JSON.stringify({ ...chat, messages: [] }));
  assert.deepEqual(lm.sync(arch), { conflicts: 1, unchanged: 1 });
  const files = (d: string) => readdirSync(d, { recursive: true }).map(String).sort();
  const before = files(arch);
  assert.equal(before.filter((f) => f.endsWith('.bak')).length, 1);
  assert.equal(before.filter(lm.isTranscript).length, 2); // the moved chat is not archived twice
  assert.ok(!lm.isTranscript(join(arch, before.find((f) => f.endsWith('.bak'))!)));
  const kept = readFileSync(join(arch, 'conversations', `${T0}.conversation.json`), 'utf8');
  writeFileSync(f1, JSON.stringify(chat).slice(0, 500)); // LM Studio mid-rewrite
  assert.deepEqual(lm.sync(arch), { partial: 1, unchanged: 1 });
  assert.equal(readFileSync(join(arch, 'conversations', `${T0}.conversation.json`), 'utf8'), kept);
  assert.deepEqual(files(arch), before);
  rmSync(live, { recursive: true });
  assert.deepEqual(lm.sync(arch), {});
  assert.deepEqual(files(arch), before);
});
