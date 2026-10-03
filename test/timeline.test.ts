// Progressive disclosure: memory_timeline (rounds around an id, facts/cards from its session, other apps near then, hard cap)
// and memory_search detail:"brief" (one capped line per hit; full mode byte-for-byte unchanged). Own throwaway schema + vault.
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-timeline-'));
const SCHEMA = `memhub_timeline_test_${process.pid}`; // per run: a fixed name let a concurrent run drop it → writes fell through to public
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMHUB_MEMORY_VAULT = join(tmp, 'vault');
process.env.MEMHUB_VAULTS = '';
process.env.MEMHUB_NO_REINDEX = '1';
process.env.MEMORY_HUB_INTERNAL = '1';
const { connect, ROOT } = await import('../src/db.ts');
const { store } = await import('../src/importer.ts');
const { writeNote, md5, MEMORY_VAULT } = await import('../src/notes.ts');
const { indexVault } = await import('../src/obsidian.ts');
const { hitLine, search, snippet } = await import('../src/search.ts');
const { timeline, getTokens, tokens, TIMELINE_MAX } = await import('../src/timeline.ts');
const { briefText, hitText, searchText, BRIEF_LINE } = await import('../src/mcp.ts');

const db = connect('rw');
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');
const src: Record<string, string> = {};
/** A session of `tool`: one round (user prompt + answer) per prompt, one minute apart from t0. */
async function session(name: string, tool: string, kind: string, sid: string, project: string, t0: string, prompts: string[]) {
  const turns = prompts.flatMap((p, i) => {
    const ts = new Date(Date.parse(t0) + i * 60_000).toISOString();
    return [{ uuid: `${name}-u${i}`, seq: 2 * i, role: 'user' as const, ts, text: p, parentUuid: null },
      { uuid: `${name}-a${i}`, seq: 2 * i + 1, role: 'assistant' as const, ts, text: `answer ${i}`, parentUuid: null }];
  });
  await guard();
  src[name] = await store(db, { tool, path: `${tool}/${name}.jsonl`, kind, sessionId: sid, project, size: 1, mtimeMs: 0, sha256: name,
    label: `${project.split('/').at(-1)} · ${tool}`, replace: false }, turns);
}
const NOW = '2026-09-25T00:00:00Z';
const note = (rel: string, meta: Record<string, string | string[]>, body: string) =>
  writeNote(rel, { scope: 'project', project: 'd:/demo', status: 'active', importance: '5', valid_at: NOW, created_at: NOW, md5: md5(body), run: 'r1', ...meta }, body);
/** chunk id of round i (user turn seq 2i) of a fixture session */
const chunk = async (name: string, i: number) => (await db.query('SELECT id FROM chunks WHERE source_id = $1 AND seq_from = $2', [src[name], 2 * i])).rows[0].id as string;
const offsets = (t: string) => t.split('\n').map((l) => l.match(/^(▶|[+-]\d+) \[/)?.[1]).filter(Boolean);

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  await session('a', 'claude', 'main', 'tl-a', 'd:/demo', '2026-09-20T10:00:00Z', Array.from({ length: 8 }, (_, i) => `round ${i} tlterm`));
  await session('asub', 'claude', 'subagent', 'tl-a', 'd:/demo', '2026-09-20T10:03:00Z', ['subagent of the same session']);
  await session('b', 'codex', 'main', 'tl-b', 'd:/demo', '2026-09-20T09:00:00Z', ['codex ran the migration']);
  await session('c', 'gemini', 'main', 'tl-c', 'd:/demo', '2026-09-21T08:00:00Z', ['gemini reviewed the docs']);
  await session('d', 'zcode', 'main', 'tl-d', 'd:/other', '2026-09-20T10:01:00Z', ['other project same time']);
  await session('e', 'antigravity', 'main', 'tl-e', 'd:/demo', '2026-08-01T10:00:00Z', ['same project long before']);
  await session('long', 'codex', 'main', 'tl-long', 'd:/demo', '2026-09-10T00:00:00Z',
    Array.from({ length: 30 }, (_, i) => `long round ${i} ${'รายละเอียดยาว long words '.repeat(12)}`));
  note('facts/demo/F0000a003.md', { memhub: 'fact', id: 'F0000a003', kind: 'decision', source_uuids: ['a-u3'] }, 'decided in round three\n');
  note('facts/demo/F0000a007.md', { memhub: 'fact', id: 'F0000a007', kind: 'fact', source_uuids: ['a-a7'] }, 'learned in round seven\n');
  note('sessions/tl-a.md', { memhub: 'card', id: 'S0000a000', source_uuids: ['a-u0', 'a-u5'] }, '# session tl-a\ncard of the demo session\n');
  note('facts/demo/F0000b001.md', { memhub: 'fact', id: 'F0000b001', kind: 'rule' }, 'hand-saved rule without a source chat\n');
  for (let i = 0; i < 12; i++) note(`facts/demo/F0000c0${String(i).padStart(2, '0')}.md`, { memhub: 'fact', id: `F0000c0${String(i).padStart(2, '0')}`, kind: 'fact',
    source_uuids: [`long-u${i * 2}`] }, `fact ${i} of the long session ${'ข้อเท็จจริงยาว '.repeat(8)}\n`);
  await guard();
  await indexVault(db, MEMORY_VAULT);
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('chunk id: rounds in time order around it (before/after), facts under the round they came from, the session card', async () => {
  const t = (await timeline(db, await chunk('a', 4), { before: 2, after: 1 }))!.text;
  assert.deepEqual(offsets(t), ['-2', '-1', '▶', '+1'], t);
  const lines = t.split('\n');
  const times = lines.filter((l) => /^(▶|[+-]\d+) \[/.test(l)).map((l) => l.split(' ')[2] + l.split(' ')[3]);
  assert.deepEqual(times, [...times].sort(), 'chronological');
  assert.match(lines[lines.findIndex((l) => l.startsWith('-1 ')) + 1], /^ {3}⇢ \[F0000a003\] decision ≈\d+t: decided in round three/, 'fact under its round');
  assert.match(t, /^more facts from this session: \[F0000a007\] ≈\d+t$/m, 'a fact from outside the window: id only');
  assert.match(t, /^session card \[S0000a000\] ≈\d+t: tl-a # session tl-a/m); // note title, then its body
  assert.ok(lines[0].startsWith(`timeline [`) && lines[0].includes('demo · claude ·'), lines[0]);
  const shown = (await timeline(db, await chunk('a', 4), { before: 0, after: 0 }))!.text;
  assert.deepEqual(offsets(shown), ['▶']);
  const live = (await timeline(db, await chunk('a', 4), { until: new Date('2026-09-20T10:05:30Z') }))!.text; // newer = in the caller's context
  assert.deepEqual(offsets(live), ['-3', '-2', '-1', '▶', '+1']);
});

test('fact and card ids centre on the chat they came from; a hand-saved fact on its own note', async () => {
  const f = (await timeline(db, 'F0000a003'))!.text;
  assert.match(f, new RegExp(`^▶ \\[${await chunk('a', 3)}\\]`, 'm'), f);
  assert.match(f.split('\n')[0], /^timeline \[F0000a003\] → its source chat: demo/);
  const card = (await timeline(db, 'S0000a000'))!.text;
  assert.deepEqual(offsets(card), ['▶', '+1', '+2', '+3'], 'the card starts at the first turn of its session');
  const hand = (await timeline(db, 'F0000b001'))!.text;
  assert.doesNotMatch(hand, /its source chat/);
  assert.match(hand, /^▶ \[[0-9a-f]{16}\] .* D ≈\d+t: hand-saved rule/m, hand);
});

test('cross-app neighbours: other sessions of the project near then (any app, time order); not other projects, far away or the same session', async () => {
  const t = (await timeline(db, await chunk('a', 4)))!.text;
  const near = t.split('\n').slice(t.split('\n').findIndex((l) => l.startsWith('same project, other sessions/apps')) + 1).filter((l) => l.startsWith(' ['));
  assert.deepEqual(near.map((l) => l.split(' ')[4]), ['codex', 'gemini'], t); // the long codex run (09-10) is > 7 days away
  assert.ok(near[0].startsWith(` [${await chunk('b', 0)}] 09-20 09:00 codex ≈`), near[0]);
  assert.doesNotMatch(t, /zcode|antigravity|subagent/);
});

test('hard cap: long rounds + many facts stay ≤ TIMELINE_MAX; the farthest go first, anchor + total stay', async () => {
  const r = (await timeline(db, await chunk('long', 15), { before: 10, after: 10 }))!;
  assert.ok(r.text.length <= TIMELINE_MAX, `${r.text.length}`);
  const off = offsets(r.text).map((o) => (o === '▶' ? 0 : Number(o)));
  assert.ok(off.includes(0) && off.length < 21, off.join());
  const lo = Math.min(...off), hi = Math.max(...off);
  assert.deepEqual(off, Array.from({ length: hi - lo + 1 }, (_, i) => lo + i), 'contiguous around the anchor');
  assert.ok(hi + lo === 0 || hi + lo === 1, `balanced, "after" kept first: ${lo}..${hi}`);
  assert.match(r.text.split('\n').at(-1)!, /^total ≈\d+t to memory_get all \d+ listed · \d+ more cut to fit 1500 chars$/);
  const listed = [...r.text.matchAll(/\[([0-9a-f]{16}|F[0-9a-f]{8})\] (?:[^≈\n]*)≈(\d+)t/g)];
  assert.equal(Number(r.text.match(/^total ≈(\d+)t/m)![1]), listed.reduce((s, m) => s + Number(m[2]), 0), 'total = sum of the listed estimates');
});

test('unknown ids → null', async () => {
  assert.equal(await timeline(db, 'F99999999'), null);
  assert.equal(await timeline(db, '0123456789abcdef'), null);
});

test('≈tokens: calibrated estimate (Thai ≈ 1 char/token, other ≈ 2.2) and getTokens covers the turns memory_get returns', async () => {
  assert.equal(tokens('ก'.repeat(95)), 100);
  assert.equal(tokens('a'.repeat(220)), 100);
  const id = await chunk('long', 3);
  const cost = (await getTokens(db, [id, 'nope'])).get(id)!;
  const turns = (await db.query('SELECT string_agg(text_redacted, \' \') t FROM turns WHERE source_id = $1 AND seq BETWEEN 5 AND 8', [src.long])).rows[0].t;
  assert.ok(cost > tokens(turns) && cost < tokens(turns) + 120, `${cost} vs ${tokens(turns)}`);
});

// Hits as search() returns them, one per output branch: fact + 2 source chats (one later changed), codex subagent chat,
// OLD fact, card, GitHub issue, pending fact.
const base = { turn_uuid: 'u', header: 'h', score: 1, uses: 0, last: null, status: null, fid: null, kind: null, fact_project: null,
  superseded_by: null, review_target: null, changed_to: null, src_kind: 'main', tool: 'claude', ev_of: null, project: 'd:/demo', session_id: 's1' };
const d = (s: string) => new Date(s);
const HITS: any[] = [
  { ...base, id: 'aaaaaaaaaaaaaaa1', ts: d('2026-09-20T10:00:00Z'), fid: 'F0000000a', kind: 'rule', fact_project: 'd:/demo', project: 'obsidian/memory-hub',
    text: 'D: # F0000000a กฎ port\nกฎ: goldenport ของ memhub คือ 7100 เท่านั้น ห้ามใช้ 7200\n- from:: [[x]]', uses: 3, last: d('2026-09-29T00:00:00Z'),
    evidence: [{ ...base, id: 'bbbbbbbbbbbbbbb2', ts: d('2026-09-19T08:00:00Z'), text: `U: ตั้ง goldenport เป็นอะไรดี ${'รายละเอียด detail '.repeat(30)}\nA: ใช้ 7100`, changed_to: ['F0000000c'] },
      { ...base, id: 'bbbbbbbbbbbbbbb3', ts: d('2026-09-18T08:00:00Z'), text: 'U: goldenport again' }] },
  { ...base, id: 'ccccccccccccccc4', ts: d('2026-09-01T00:00:00Z'), tool: 'codex', src_kind: 'subagent', session_id: 's2', text: `A: ${'goldenport codex long answer '.repeat(30)}` },
  { ...base, id: 'ddddddddddddddd5', ts: d('2025-01-01T00:00:00Z'), fid: 'F0000000b', kind: 'decision', status: 'superseded', superseded_by: 'F0000000c',
    project: 'obsidian/memory-hub', fact_project: 'd:/demo', text: 'D: # F0000000b old\ngoldenport = 7001' },
  { ...base, id: 'eeeeeeeeeeeeeee6', ts: d('2026-09-30T20:00:00Z'), fid: 'S0000000d', kind: 'card', project: 'obsidian/memory-hub', fact_project: 'd:/demo', text: 'D: # session card\nทำ goldenport' },
  { ...base, id: 'fffffffffffffff7', ts: d('2026-08-01T00:00:00Z'), tool: 'github', src_kind: 'doc', project: 'github/o/r', session_id: 'github:o/r#12', text: 'issue: goldenport broken', changed_to: ['F0000000c'] },
  { ...base, id: '0000000000000008', ts: d('2026-09-25T00:00:00Z'), fid: 'F0000000e', kind: 'fact', status: 'pending', review_target: 'F0000000a', project: 'obsidian/memory-hub', fact_project: null, text: 'D: # F0000000e p\npending goldenport 7300' },
];

// re-pinned 2026-10-03 for rank budgets + passage() (deliberate format change); any other change to it must stay byte-for-byte
test('full mode is byte-for-byte what it was before brief mode (golden hash of searchText on the fixture)', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T00:00:00Z') }); // hitLine prints ages
  try {
    const outs = [searchText(HITS, 'goldenport 7100', true), searchText(HITS.slice(0, 2), 'goldenport', false), searchText([], 'x', true)];
    assert.equal(createHash('sha256').update(outs.join('\0')).digest('hex'), '86f0bdb487a4c4c615ce6c6455d10ce4d1d8964ff34ed932b334781092487366', outs[0]);
  } finally { mock.timers.reset(); }
});

test('brief: one line per hit ≤ BRIEF_LINE, same ids/order as full, warnings + ↳ id + ≈tokens kept', async () => {
  const cost = new Map(HITS.map((h, i) => [h.id, 100 * (i + 1)]));
  const many = { ...HITS[4], id: '1111111111111119', changed_to: Array.from({ length: 12 }, (_, i) => `F00000${String(i).padStart(3, '0')}`) };
  const out = briefText([...HITS, many], 'goldenport 7100', true, cost);
  const lines = out.split('\n');
  assert.match(lines[0], /^brief: ≈t = est\. tokens of memory_get\(id\)/);
  assert.equal(lines.length, HITS.length + 2);
  for (const l of lines) assert.ok(l.length <= BRIEF_LINE, `${l.length}: ${l}`);
  const ids = (s: string) => [...s.matchAll(/^\[(\w+)\]/gm)].map((m) => m[1]);
  assert.deepEqual(ids(out).slice(0, HITS.length), ids(searchText(HITS, 'goldenport 7100', true)));
  assert.match(lines[1], /^\[F0000000a\] 2026-09-20 demo rule ≈100t ↳\[bbbbbbbbbbbbbbb2\]\+1: กฎ: goldenport/);
  assert.match(lines[2], /^\[ccccccccccccccc4\] 2026-09-01 demo codex subagent ≈200t: /);
  assert.match(lines[3], /OLD -> \[F0000000c\] ≈300t/);
  assert.match(lines[4], /^\[eeeeeeeeeeeeeee6\] .* card ≈400t/);
  assert.match(lines[5], /^\[fffffffffffffff7\] 2026-08-01 r github \(later changed -> \[F0000000c\]\) ≈500t: issue/);
  assert.match(lines[6], /PENDING vs \[F0000000a\] ≈600t/);
  assert.ok(briefText([], 'x', false, cost) === searchText([], 'x', false), 'no hits: same text as full');
  assert.match(briefText(HITS.slice(0, 1), 'x', false, cost), /^\(keyword-only: embedder busy\)\nbrief:/);
});

test('brief on real search results (MCP max 8 hits): all capped, each with an estimate from getTokens', async () => {
  const { hits, semantic } = await search(db, 'round tlterm', { semantic: false, limit: 8 });
  assert.ok(hits.length >= 5, `${hits.length}`);
  const out = briefText(hits, 'round tlterm', semantic, await getTokens(db, hits.map((h) => h.id)));
  const lines = out.split('\n').slice(2);
  assert.equal(lines.length, hits.length);
  for (const l of lines) assert.match(l, /^\[\S+\] \d{4}-\d{2}-\d{2} .* ≈\d+t/);
  assert.ok(out.length < searchText(hits, 'round tlterm', semantic).length, 'brief@8 costs less than full@8');
});

test('full mode: rank 1 gets +300 chars and rank 2 +100, paid by ranks ≥ 3, same total; the passage shows the detail next to the most query terms', () => {
  const long = (i: number) => ({ ...base, id: `${i}`.repeat(16), ts: d('2026-09-20T10:00:00Z'), text: `U: budgetterm ${'filler words here '.repeat(60)}` });
  const bodies = searchText([1, 2, 3, 4, 5, 6].map(long), 'budgetterm', true).split('\n\n').map((r) => r.split('\n')[1].length);
  assert.deepEqual(bodies.map((n) => n - 1), [700, 500, 300, 300, 300, 300], 'bodies (minus the trailing cut mark)');
  const detail = { ...base, id: 'abcdefabcdefabcd', ts: d('2026-09-20T10:00:00Z'),
    text: `U: alphaterm first ${'unrelated chat '.repeat(60)} A: alphaterm betaterm gammaterm = port 4242 ${'more chat '.repeat(60)}` };
  const q = 'alphaterm betaterm gammaterm';
  assert.doesNotMatch(snippet(detail.text, q, 400), /4242/, 'sanity: snippet() anchors on the first alphaterm');
  assert.match(hitText(detail, q), /alphaterm betaterm gammaterm = port 4242/);
  assert.equal(hitText(detail, ''), `${hitLine(detail)}\n${snippet(detail.text, '', 400)}`, 'empty query = snippet()');
});
