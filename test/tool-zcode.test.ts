// Pure: a synthetic ZCode db.sqlite (real table shapes) in a temp dir → sync() export → parse(). No Postgres, no real ~/.zcode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTranscript, parse, sync } from '../src/tools/zcode.ts';

const root = mkdtempSync(join(tmpdir(), 'memhub-zcode-test-'));
const home = join(root, 'zcode'), archive = join(root, 'archive');
process.env.MEMHUB_ZCODE_HOME = home;
mkdirSync(join(home, 'cli', 'db'), { recursive: true });
const db = new DatabaseSync(join(home, 'cli', 'db', 'db.sqlite'));
db.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE session (id text primary key, project_id text not null, workspace_id text, parent_id text, slug text not null,
    directory text not null, path text, title text not null, version text not null, time_created integer not null,
    time_updated integer not null, time_archived integer, task_type text not null default 'interactive', trace_id text);
  CREATE TABLE message (id text primary key, session_id text not null references session(id) on delete cascade,
    time_created integer not null, time_updated integer not null, data text not null, sequence integer);
  CREATE TABLE part (id text primary key, message_id text not null references message(id) on delete cascade,
    session_id text not null, time_created integer not null, time_updated integer not null, data text not null, sequence integer);`);

const A = 'sess_aaaaaaaa-0000-4000-8000-000000000001', B = 'sess_bbbbbbbb-0000-4000-8000-000000000002', C = 'sess_cccccccc-0000-4000-8000-000000000003';
const DIR = 'D:\\work\\proj', T0 = Date.UTC(2026, 8, 1);
const addSession = (id: string, parent: string | null = null) => db.prepare(
  `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, task_type)
   VALUES (?, 'pro1', ?, 'slug', ?, 'title', '0.16.9', ?, ?, ?)`).run(id, parent, DIR, T0, T0, parent ? 'subagent_child' : 'interactive');
let seq = 0;
/** message + parts; `data`/part values may be raw strings to simulate corrupt rows. */
function addMsg(session: string, id: string, min: number, data: object | string, parts: (object | string)[] = []) {
  const t = T0 + min * 60_000;
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)').run(id, session, t, t, typeof data === 'string' ? data : JSON.stringify(data), seq++);
  parts.forEach((p, i) => db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(`part_${id}_${i}`, id, session, t, t, typeof p === 'string' ? p : JSON.stringify(p), i));
}
const text = (t: string, extra = {}) => ({ type: 'text', text: t, time: { start: 1, end: 2 }, ...extra });
const toolPart = (tool: string, input: object, output = '') => ({ type: 'tool', callID: 'c', tool, state: { status: 'completed', input, output, title: tool } });
const user = (extra = {}) => ({ role: 'user', time: { created: 1 }, agent: 'build', contextSnapshot: { envInfo: { cwd: DIR, gitUser: 'ENV-GIT-USER', gitStatus: 'M x' } }, ...extra });
const asst = (parentID: string) => ({ role: 'assistant', time: { created: 1, completed: 2 }, parentID, modelID: 'glm', providerID: 'zai', path: { cwd: DIR, root: DIR }, cost: 0.1, tokens: { total: 9, input: 5, output: 4 } });
const BIG = 'x'.repeat(25_000);

addSession(A); addSession(B, A); addSession(C);
addMsg(A, 'msg_01', 1, user({ semantics: { kind: 'user_prompt' } }), [text('please fix the login bug'),
  { type: 'file', mime: 'image/png', filename: 'a.png', url: 'data:image/png;base64,IMAGEBYTES' }]);
addMsg(A, 'msg_02', 2, user({ synthetic: true, semantics: { kind: 'todo_reminder' }, metadata: { source: 'todo_reminder' } }),
  [text('TODO-REMINDER boilerplate', { synthetic: true })]);
addMsg(A, 'msg_03', 3, asst('msg_01'), [{ type: 'step-start' }, { type: 'reasoning', text: 'SECRET-REASONING' }, text('I will look at auth.ts'),
  toolPart('Bash', { command: 'git status', description: 'Show status' }, 'TOOL-OUTPUT'),
  toolPart('Read', { file_path: 'D:\\work\\proj\\read-only.ts' }, 'TOOL-OUTPUT'),
  toolPart('Edit', { file_path: 'D:\\work\\proj\\auth.ts', old_string: 'EDIT-BODY', new_string: 'EDIT-BODY' }, 'TOOL-OUTPUT'),
  toolPart('mcp__node_repl__js', { source: 'await page.title()' }, 'TOOL-OUTPUT'), // older calls carry no title
  'not json {', { type: 'step-finish', tokens: {} }]);
addMsg(A, 'msg_04', 4, user({ synthetic: true }), [text('<system-reminder>SYSTEM-REMINDER</system-reminder>', { synthetic: true })]); // pre-semantics row
addMsg(A, 'msg_05', 5, user({ synthetic: true, metadata: { source: 'background_task' } }),
  [text('<task-notification>build finished</task-notification>', { synthetic: true })]);
addMsg(A, 'msg_06', 6, user(), [text('see data:image/png;base64,iVBORw0KGgoAAAA= here')]);
addMsg(A, 'msg_07', 7, user(), [text('see data:image/png;base64,iVBORw0KGgoAAAA= here')]); // re-sent prompt
addMsg(A, 'msg_08', 8, user({ metadata: { executionKind: 'controlOnly' } }), [text('/goal ship the importer')]); // typed by the user
addMsg(A, 'msg_09', 9, asst('msg_08'), [{ type: 'step-start' }, { type: 'reasoning', text: 'SECRET-REASONING' }]);
addMsg(A, 'msg_10', 10, asst('msg_06'), [toolPart('AskUserQuestion', { questions: [{ question: 'Which DB?' }] }, 'User answered: Postgres'),
  toolPart('Agent', { description: 'scan repo', prompt: 'long prompt', subagent_type: 'explore' }, 'AGENT-OUTPUT'), text('Done.')]);
addMsg(A, 'msg_11', 11, 'corrupt {', [text('CORRUPT-ROW')]);
addMsg(A, 'msg_12', 12, user({ semantics: { kind: 'compact_summary' }, summary: { title: 's', body: 'b', diffs: [] } }),
  [text('Summary of the conversation so far', { synthetic: true })]);
addMsg(A, 'msg_13', 13, asst('msg_12'), [text(BIG)]);
addMsg(B, 'msg_b1', 3, user(), [text('scan the repo for auth files')]);
addMsg(B, 'msg_b2', 4, asst('msg_b1'), [text('looking'), toolPart('Bash', { command: 'ls' }, 'TOOL-OUTPUT')]);
addMsg(B, 'msg_b3', 5, asst('msg_b1'), [text('found 3 files')]);
addMsg(C, 'msg_c1', 1, user({ synthetic: true, semantics: { kind: 'todo_reminder' } }), [text('TODO-REMINDER', { synthetic: true })]);
addMsg(C, 'msg_c2', 2, asst('msg_c1'), [text('ok')]);

const fileA = join(archive, `${A}.jsonl`), fileB = join(archive, `${B}.jsonl`);
const uuids = (p: Awaited<ReturnType<typeof parse>>) => p!.msgs.map((m) => m.uuid);
test.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

test('sync exports sessions with user text, drops junk before archiving', () => {
  assert.deepEqual(sync(archive), { copied: 2, empty: 1 });
  assert.deepEqual(readdirSync(archive).sort(), [`${A}.jsonl`, `${B}.jsonl`]);
  const raw = readFileSync(fileA, 'utf8');
  for (const junk of ['SECRET-REASONING', 'TOOL-OUTPUT', 'AGENT-OUTPUT', 'EDIT-BODY', 'IMAGEBYTES', 'base64', 'TODO-REMINDER', 'SYSTEM-REMINDER', 'ENV-GIT-USER', 'CORRUPT-ROW'])
    assert.ok(!raw.includes(junk), junk);
  assert.ok(isTranscript(fileA) && !isTranscript(`${fileA}.123.bak`));
});

test('parse: main session roles, tool lines, caps, uuids, ts order', async () => {
  const p = (await parse(fileA))!;
  assert.equal(p.sessionId, A); assert.equal(p.kind, 'main'); assert.equal(p.cwd, DIR);
  assert.deepEqual(p.msgs.map((m) => m.role), ['user', 'assistant', 'notice', 'user', 'user', 'assistant', 'summary', 'assistant']);
  const [prompt, step, notice, seen, goal, ask, summary, big] = p.msgs;
  assert.equal(prompt.text, 'please fix the login bug');
  assert.equal(step.text, 'I will look at auth.ts\n[Bash] Show status $ git status\n[Edit] D:\\work\\proj\\auth.ts\n[js] await page.title()');
  assert.match(notice.text, /^<task-notification>build finished/);
  assert.equal(seen.text, 'see [data-url] here');
  assert.equal(goal.text, '/goal ship the importer');
  assert.equal(ask.text, 'Done.\n[Ask] Which DB?\n[Ask result] User answered: Postgres\n[Agent] scan repo');
  assert.equal(summary.text, 'Summary of the conversation so far');
  assert.equal(big.text.length, 20_000 + ' …[truncated]'.length);
  assert.ok(p.msgs.every((m) => m.uuid.startsWith(`zcode:${A}:msg_`) && m.sessionId === A && m.cwd === DIR));
  assert.equal(new Set(uuids(p)).size, p.msgs.length);
  assert.deepEqual(p.msgs.map((m) => m.parentUuid), [null, ...uuids(p).slice(0, -1)]);
  const ts = p.msgs.map((m) => m.ts);
  assert.ok(ts.every((t) => new Date(t).toISOString() === t));
  assert.deepEqual([...ts].sort(), ts);
  assert.deepEqual(await parse(fileA), p, 'stable across re-parses');
});

test('parse: subagent child → task + result grouped under the parent session', async () => {
  const p = (await parse(fileB))!;
  assert.equal(p.kind, 'subagent'); assert.equal(p.sessionId, A);
  assert.deepEqual(p.msgs.map((m) => [m.role, m.text]), [['tool', '[subagent task] scan the repo for auth files'], ['tool', '[subagent result] found 3 files']]);
  const all = [...uuids(p), ...uuids(await parse(fileA))];
  assert.equal(new Set(all).size, all.length, 'uuids unique across sessions');
});

test('sync again: unchanged; growth appends; edits keep .bak; deleted sessions keep their archive', async () => {
  assert.deepEqual(sync(archive), { unchanged: 2, empty: 1 });
  const before = readFileSync(fileA, 'utf8'), oldIds = uuids(await parse(fileA));
  addMsg(A, 'msg_14', 14, user(), [text('one more thing')]);
  assert.deepEqual(sync(archive), { appended: 1, unchanged: 1, empty: 1 });
  assert.ok(readFileSync(fileA, 'utf8').startsWith(before));
  assert.deepEqual(uuids(await parse(fileA)), [...oldIds, `zcode:${A}:msg_14`]);

  db.prepare('UPDATE part SET data = ? WHERE id = ?').run(JSON.stringify(text('found 4 files')), 'part_msg_b3_0');
  assert.deepEqual(sync(archive), { unchanged: 1, conflicts: 1, empty: 1 });
  assert.equal(readdirSync(archive).filter((f) => f.startsWith(B) && f.endsWith('.bak')).length, 1);

  const files = readdirSync(archive).sort(), grownA = readFileSync(fileA, 'utf8');
  db.exec(`DELETE FROM part; DELETE FROM message; DELETE FROM session;`); // task deleted in ZCode
  assert.deepEqual(sync(archive), {});
  assert.deepEqual(readdirSync(archive).sort(), files);
  assert.equal(readFileSync(fileA, 'utf8'), grownA);
});

test('sync holds back a step still streaming, so finishing it appends instead of a .bak', () => {
  const D = 'sess_dddddddd-0000-4000-8000-000000000004', now = Date.now();
  addSession(D);
  const add = (id: string, t: number, data: object, part: object) => {
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)').run(id, D, t, t, JSON.stringify(data), seq++);
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)').run(`part_${id}`, id, D, t, t, JSON.stringify(part), 0);
  };
  add('msg_d1', now - 2000, user(), text('long job please'));
  add('msg_d2', now - 1000, { ...asst('msg_d1'), time: { created: now - 1000 } }, text('Working on'));
  assert.deepEqual(sync(archive), { copied: 1 });
  db.prepare('UPDATE message SET data = ? WHERE id = ?').run(JSON.stringify({ ...asst('msg_d1'), time: { created: now - 1000, completed: now } }), 'msg_d2');
  db.prepare('UPDATE part SET data = ? WHERE id = ?').run(JSON.stringify(text('Working on it: done')), 'part_msg_d2');
  assert.deepEqual(sync(archive), { appended: 1 });
  assert.equal(readdirSync(archive).filter((f) => f.startsWith(D)).length, 1, 'no .bak');
});

test('parse never throws on junk: malformed / duplicate / bad-time lines skipped, empty → null', async () => {
  const f = join(root, 'junk.jsonl');
  const ok = { session: 'sess_x', cwd: 'D:\\x', id: 'msg_1', role: 'user', time: T0, text: 'hello' };
  writeFileSync(f, ['{bad', 'null', '42', JSON.stringify(ok), JSON.stringify(ok), JSON.stringify({ ...ok, id: 'msg_2', time: 1e20 }),
    JSON.stringify({ ...ok, id: 'msg_3', role: 'system' }), JSON.stringify({ ...ok, id: 'msg_4', text: 7 }), ''].join('\n'));
  const p = (await parse(f))!;
  assert.deepEqual(p.msgs.map((m) => m.uuid), ['zcode:sess_x:msg_1']);
  writeFileSync(f, '');
  assert.equal(await parse(f), null);
});
