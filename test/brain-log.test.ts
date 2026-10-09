// Public system log: dream records and log rows must carry counts only (no fact text, run ids, paths or names). No DB.
// Also the per-app counts, the activity heatmap, the last dream run and the GitHub hub (buildBrain on a stub DB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { activityOf, assertAnonymous, buildBrain, dreamLog, feedOf, forShare, lastDream } from '../src/brain.ts';
import { MEMORY_PROJECT } from '../src/notes.ts';

test('dreamLog: whitelisted counters only; old, broken and text lines dropped', () => {
  const record = JSON.stringify({
    run: 'D:/clients/acme-secret-run', at: '2026-10-01T23:58:17.014Z',
    stats: { sessions: 7, batches: 2, ADD: 1, pending_review: 0, kept_user_edit: 3, note: 'ลุงจืด said acme' },
    batches: [{ sessions: ['s-1'], candidates: [{ text: 'acme password rule', kind: 'rule' }] }],
  });
  const old = JSON.stringify({ at: '2026-09-01T00:00:00Z', stats: { ADD: 9 } });
  const rows = dreamLog([record, old, 'not json', 'null', '{"at":"x","stats":{}}', ''].join('\n'), Date.parse('2026-10-01T00:00:00Z') / 1000);
  assert.deepEqual(rows, [{ t: Date.parse('2026-10-01T23:58:17Z') / 1000, k: 'dream', c: { sessions: 7, batches: 2, ADD: 1, pending_review: 0 } }]);
  assert.doesNotMatch(JSON.stringify(rows), /acme|ลุงจืด|password|D:|s-1/);
});

test('assertAnonymous: public log rows are counts only', async () => {
  const db = { query: async () => ({ rows: [{ v: 'D:/clients/acme-secret/notes.md' }] }) } as unknown as pg.Pool;
  const brain = (log: unknown[]) => JSON.stringify({ v: 1, mode: 'public', at: 0, stats: {}, nodes: [], links: [], events: [], log });
  await assertAnonymous(db, brain([{ t: 2, k: 'ingest', c: { sessions: 1, subagents: 4, turns: 3 } }, { t: 1, k: 'dream', c: { ADD: 1, pending_review: 0 } }]));
  for (const bad of [
    { t: 1, k: 'ingest', c: { turns: 3 }, p: ['x'] }, // project names are local only
    { t: 1, k: 'publish', c: {} }, // local-only kind
    { t: 1, k: 'dream', c: { ADD: 'a fact' } }, // text as a counter
    { t: 1, k: 'dream', c: {}, text: 'a fact' }, // extra field
    { t: 1, k: 'ingest', c: { 'acme-secret': 1 } }, // a real name as a key
    { t: 1, k: 'dream', c: { 'remember the deploy rule': 1 } }, // text as a key, matching no needle
    { t: 'free text', k: 'dream', c: {} }, // text as the time
    { t: 1, k: 'dream', c: [1, 2] }, // not an object
  ]) await assert.rejects(assertAnonymous(db, brain([bad])), /public brain leaks/, JSON.stringify(bad));
});

test('assertAnonymous: the log vocabulary is not a leak (notes named update.md / review)', async () => {
  const db = { query: async () => ({ rows: [{ v: 'obsidian/vault/update.md' }, { v: 'D:/work/review/x.md' }] }) } as unknown as pg.Pool;
  const log = [{ t: 1, k: 'dream', c: { UPDATE: 0, pending_review: 0 } }, { t: 2, k: 'recall', c: { searches: 1 } }];
  await assertAnonymous(db, JSON.stringify({ v: 1, mode: 'public', at: 0, stats: {}, nodes: [], links: [], events: [], log }));
});

test('assertAnonymous: folder/file names of Windows (backslash) paths are needles too', async () => {
  const db = { query: async () => ({ rows: [{ v: String.raw`C:\Users\x\ai-archive\raw\codex\secret-folder\note.md` }] }) } as unknown as pg.Pool;
  const brain = (label: string) => JSON.stringify({ v: 1, mode: 'public', at: 0, stats: {}, nodes: [{ id: 'a', type: 'note', p: label }], links: [], events: [], log: [] });
  await assertAnonymous(db, brain('P1'));
  await assert.rejects(assertAnonymous(db, brain('secret-folder')), /public brain leaks: secret-folder/);
});

test('activityOf: 371 Bangkok days, oldest first, the last = today', () => {
  const at = (iso: string) => Date.parse(iso) / 1000;
  const now = at('2026-10-01T17:30:00Z'); // 00:30 on 2 Oct in Bangkok, still 1 Oct in UTC
  const { start, turns } = activityOf([
    { t: at('2026-10-01T17:00:00Z'), n: 2 }, // 00:00 +07 → today
    { t: at('2026-10-01T16:00:00Z'), n: 3 }, // 23:00 +07 the day before
    { t: at('2025-09-26T17:00:00Z'), n: 4 }, // 00:00 +07 of the first day
    { t: at('2025-09-26T16:00:00Z'), n: 99 }, // a day too old
    { t: at('2026-10-02T17:00:00Z'), n: 99 }, // tomorrow
  ], now);
  assert.equal(turns.length, 371);
  assert.equal(start, at('2025-09-27T00:00:00+07:00'));
  assert.deepEqual([turns[0], turns[369], turns[370]], [4, 3, 2]);
  assert.equal(turns.reduce((a, b) => a + b), 9);
});

test('lastDream: the latest record of the newest run file, any age; none → undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memhub-dream-'));
  try {
    const run = (f: string, mtime: number, ...lines: string[]) => {
      writeFileSync(join(dir, f), lines.join('\n') + '\n');
      utimesSync(join(dir, f), mtime, mtime);
    };
    const rec = (at: string, stats: object) => JSON.stringify({ at, stats, batches: [{ candidates: [{ text: 'acme fact' }] }] });
    assert.equal(lastDream(dir), undefined);
    run('old.json', 1000, rec('2025-01-01T00:00:00Z', { ADD: 1 }));
    run('new.json', 2000, rec('2025-01-02T00:00:00Z', { ADD: 2 }), rec('2025-01-03T00:00:00Z', { ADD: 3, note: 'text' }));
    run('broken.json', 3000, 'not json');
    assert.deepEqual(lastDream(dir), { t: Date.parse('2025-01-03T00:00:00Z') / 1000, c: { ADD: 3 } });
    assert.equal(lastDream(join(dir, 'missing')), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildBrain: per-app counts, node app, unmapped GitHub repos under one hub per owner (public: one shared hub); feedOf carries apps/activity/dream', async () => {
  const day = (d: number) => new Date(Date.UTC(2026, 8, d));
  const src = (id: number, tool: string, kind: string, project: string, n: number, d: number, session_id = `s${id}`) =>
    ({ id, tool, kind, session_id, project, status: null, n, ne: id === 7 ? 0 : n, t0: day(d), t1: day(d + 1), first: 'hi' }); // 7: not embedded yet
  const sources = [
    src(1, 'claude', 'main', 'd:/work/app', 5, 1), src(2, 'claude', 'subagent', 'd:/work/app', 2, 2, 's1'),
    src(3, 'codex', 'headless', 'd:/work/app', 1, 3), src(4, 'github', 'doc', 'github/acme/widget-repo', 1, 4),
    src(5, 'github', 'doc', 'github/other/gadget-repo', 3, 5), src(6, 'github', 'doc', 'd:/work/app', 1, 6), // a cloned repo
    src(7, 'obsidian', 'note', 'obsidian/vault', 2, 7), src(8, 'obsidian', 'note', MEMORY_PROJECT, 1, 8),
  ];
  const hour = Math.floor(Date.now() / 3600_000) * 3600;
  const vec = (id: number) => { // a source's centroid as pgvector's vector_send
    const b = Buffer.alloc(4 + 16);
    b.writeUInt16BE(4, 0);
    [1, id % 3, id % 2, id / 8].forEach((x, j) => b.writeFloatBE(x, 4 + 4 * j));
    return b;
  };
  const db = { query: async (sql: string) => ({ rows:
    sql.includes('vector_send') ? sources.filter((r) => r.ne).map((r) => ({ id: String(r.id), e: vec(r.id) }))
    :     sql.includes('FROM sources s JOIN chunks') ? sources
    : sql.startsWith('SELECT s.tool, count(*)') ? [{ tool: 'claude', n: 40 }, { tool: 'github', n: 4 }, { tool: 'mystery', n: 1 }]
    : sql.includes(`date_bin('1 hour'`) ? [{ t: String(hour), n: 6 }]
    : sql.includes('pg_database_size') ? [{ turns: 0, chunks: 0, vectors: 0, hits7d: 0, recalls7d: 0, sessions7d: 0, db: 0 }]
    : sql.includes(`k = 'layout'`) ? [{ v: { 'source:6': [999, 999, 999], 'source:4': [777, 777, 777] } }] // pins: the cloned repo's (its project's cluster), a repo's in the shared hub
    : [] }) } as unknown as pg.Pool;
  const b = await buildBrain(db, 'local');
  const hubs = b.nodes.filter((n) => n.type === 'project');
  assert.equal(hubs.length, 5); // app, GitHub · acme, GitHub · other, the vault, the memory vault
  const under = (label: string) => b.nodes.filter((n) => n.p === hubs.find((h) => h.label === label)!.id).map((n) => n.id);
  assert.deepEqual([under('GitHub · acme'), under('GitHub · other')], [['source:4@owner'], ['source:5@owner']]);
  assert.notDeepEqual(b.nodes.find((n) => n.id === 'source:4@owner')!.xyz, [777, 777, 777], 'local: a spot by its owner hub, not the shared-hub pin');
  assert.equal(b.nodes.find((n) => n.id === 'source:6')!.p, 'project:d:/work/app');
  const t1 = (d: number) => day(d + 1).getTime() / 1000;
  assert.deepEqual(b.apps, {
    claude: { sessions: 1, subagents: 1, turns: 40, chunks: 7, t1: t1(2) },
    codex: { sessions: 0, subagents: 1, turns: 0, chunks: 1, t1: t1(3) },
    github: { sessions: 0, subagents: 0, turns: 4, chunks: 5, t1: t1(6) },
    obsidian: { sessions: 0, subagents: 0, turns: 0, chunks: 3, t1: t1(8) },
  });
  assert.deepEqual(b.nodes.map((n) => n.a), [undefined, undefined, undefined, undefined, undefined, // hubs
    'claude', 'claude', 'codex', 'github', 'github', 'github', 'obsidian', undefined]); // memory note: no app
  assert.equal(b.activity.turns.length, 371);
  assert.equal(b.activity.turns[370], 6);
  assert.equal(b.stats.chats, 41); // GitHub items are no chat
  const feed = feedOf(b, b.at - 7200);
  assert.deepEqual([feed.apps, feed.activity, feed.dream], [b.apps, b.activity, b.dream]);
  // public: the cloned repo leaves its project's hub too (exact public commit times would name the project's alias)
  process.env.MEMHUB_PUBLIC_SALT ??= 'test-salt'; // never append one to the real .env
  const pb = await buildBrain(db, 'public');
  const ghHubs = pb.nodes.filter((n) => n.a === 'github').map((n) => n.p);
  assert.deepEqual([ghHubs.length, new Set(ghHubs).size], [3, 1]);
  assert.deepEqual(b.nodes.find((n) => n.id === 'source:6')!.xyz, [999, 999, 999]);
  assert.ok(!pb.nodes.some((n) => n.xyz?.[0] === 999), 'public: a fresh spot by the GitHub hub, not the shared pin');
  assert.ok(pb.nodes.some((n) => String(n.xyz) === '777,777,777'), 'public keys unchanged: a non-cloned repo keeps its pin');
  // semantic layout: every node with vectors (none for the unembedded note); public GitHub items get none (see hubOf)
  assert.deepEqual(b.nodes.filter((n) => n.type !== 'project' && !n.s).map((n) => n.id), ['source:7']);
  assert.deepEqual(pb.nodes.filter((n) => n.type !== 'project' && n.s).map((n) => n.a), ['claude', 'claude', 'codex', undefined]);
  assert.ok(pb.nodes.filter((n) => n.s).flatMap((n) => n.s!).every(Number.isInteger));
  await assertAnonymous(db, JSON.stringify(pb));
});

test('assertAnonymous: app names are public, project/repo names still are not', async () => {
  const db = { query: async () => ({ rows: [{ v: 'github/acme/widget-repo' }, { v: 'obsidian/vault' }, { v: 'D:/work/secret-app/CLAUDE.md' },
    { v: String.raw`C:\Users\x\ai-archive\raw\gemini\lmstudio\antigravity\codex\zcode\x.jsonl` }] }) } as unknown as pg.Pool;
  const app = { sessions: 1, subagents: 0, turns: 3, chunks: 2, t1: 5 };
  const brain = (x: object = {}) => JSON.stringify({ v: 1, mode: 'public', at: 0, stats: {},
    apps: { github: app, obsidian: app, gemini: app, lmstudio: app, antigravity: app, codex: app, zcode: app, claude: app },
    activity: { start: 0, turns: [0, 1] }, dream: { t: 1, c: { UPDATE: 0 } },
    nodes: [{ id: 'a', type: 'note', p: 'b', a: 'github' }, { id: 'b', type: 'project', label: 'P1' }], links: [], events: [], log: [], ...x });
  await assertAnonymous(db, brain());
  for (const bad of [
    { nodes: [{ id: 'a', type: 'note', a: 'widget-repo' }] }, // a repo name as the app
    { nodes: [{ id: 'a', type: 'note', a: 'remember the rule' }] }, // free text as the app, matching no needle
    { apps: { 'secret-app': app } }, // a project name as an app key
    { apps: { 'some text': app } },
    { stats: { 'widget-repo': 1 } }, // a repo name anywhere else
    { stats: { 'secret-app': 1 } },
    { dream: { t: 1, c: { ADD: 'a fact' } } }, // dream: counts only
    { dream: { t: 1, c: {}, text: 'a fact' } },
    { nodes: [{ id: 'a', type: 'note', p: 'b', a: 'github' }, { id: 'c', type: 'note', p: 'd', a: 'github' }] }, // GitHub nodes in two hubs
  ]) await assert.rejects(assertAnonymous(db, brain(bad)), /public brain leaks/, JSON.stringify(bad));
});

test('forShare (brain-serve --share): the owner\'s own AI searches / recalls never reach a friend; chat turns stay', () => {
  const b = { events: [[1, 'source:1', 'turn', 2], [1, 'source:1', 'search', 1], [2, 'source:2', 'recall', 1]], log: [{ t: 1, k: 'recall', c: {} }, { t: 2, k: 'ingest', c: {} }] };
  const s = forShare(b as unknown as Parameters<typeof forShare>[0]);
  assert.deepEqual(s.events, [[1, 'source:1', 'turn', 2]]);
  assert.deepEqual(s.log.map((l) => l.k), ['ingest']);
});
