// Claude-only sources (guard.PRIVATE_TOOLS: Gmail/Docs/Sheets, Maps timeline): strict redaction at index time, and no other
// app ever reads them: MCP search/get/related/timeline per client (real stdio servers), SessionStart for every app, public
// brain = counts only. Own throwaway schema per run (never public). All secrets below are fake.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SCHEMA = `memhub_private_test_${process.pid}`;
const ENV: Record<string, string> = { ...(process.env as Record<string, string>), MEMHUB_PG_SCHEMA: SCHEMA, MEMHUB_PUBLIC_SALT: 'test-salt' };
for (const k of ['MEMORY_HUB_INTERNAL', 'MEMHUB_ANTHROPIC_ONLY', 'MEMHUB_PRIVATE_SOURCES', 'ANTHROPIC_BASE_URL']) delete ENV[k];
Object.assign(process.env, ENV);
for (const k of ['MEMHUB_ANTHROPIC_ONLY', 'MEMHUB_PRIVATE_SOURCES', 'ANTHROPIC_BASE_URL']) delete process.env[k];
const { connect, ROOT } = await import('../src/db.ts');
const { clean, indexToolFile, normProject } = await import('../src/importer.ts');
const { privateOk } = await import('../src/guard.ts');
const { assertAnonymous, buildBrain } = await import('../src/brain.ts');

const db = connect('rw');
const tmp = mkdtempSync(join(tmpdir(), 'memhub-private-'));
const PROJECT = normProject(ROOT); // the MCP server / hook run with cwd = ROOT
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');
const WORD = 'quagmirezeb'; // in every fake source: one query finds them all
const REFRESH = '1//0g' + 'Zx9-q'.repeat(9); // built so no literal token sits in the source
const SECRETS = ['482913', '4111 1111 1111 1111', REFRESH, 'reset-password', 'u=77'];
const MAIL = `${WORD} gmail marker: Your verification code is 482913. card 4111 1111 1111 1111, token ${REFRESH}, ` +
  'reset https://accounts.example.com/reset-password/x?u=77';
const CONTROL = `${WORD} control chat: paid with card 4111 1111 1111 1111`; // a non-private source keeps today's redaction
const ids: Record<string, { source: string; chunk: string }> = {};

/** Index one fake transcript through the real importer (indexToolFile → clean → store), as tool `tool`. */
async function index(tool: string, sessionId: string, kind: 'main' | 'doc', cwd: string, text: string, role: 'user' | 'note' = 'user') {
  const path = join(tmp, `${tool}-${sessionId.replace(/\W/g, '_')}.json`);
  writeFileSync(path, text);
  await guard();
  const parse = async () => ({ sessionId, cwd, kind, msgs: [{ uuid: `${sessionId}-1`, parentUuid: null, sessionId, ts: '2026-09-20T05:00:00Z', cwd, role, text }] });
  assert.equal(await indexToolFile(db, { tool, sync: () => ({}), isTranscript: () => true, parse }, path), 'indexed');
  const r = (await db.query(`SELECT s.id::text source, c.id chunk FROM sources s JOIN chunks c ON c.source_id = s.id WHERE s.path = $1`, [path])).rows[0];
  ids[sessionId] = r;
}

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  await db.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO memhub_ro; GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO memhub_ro`);
  // kind 'main' + a user turn in PROJECT: stricter than the real importer (doc), so SessionStart's own filter is what's tested
  await index('google', 'gmail:t1', 'main', ROOT, MAIL);
  await index('google-timeline', 'google-timeline', 'doc', 'google/timeline', `${WORD} timeline marker: ทริป ไอซ์แลนด์ (Iceland)`, 'note');
  await index('zcode', 'zc-1', 'main', ROOT, CONTROL);
  // every related leg has something private to show: a wiki link, a co-access edge, the same embedding
  const [m, c] = [ids['gmail:t1'].source, ids['zc-1'].source];
  await db.query(`INSERT INTO links (src_id, dst_name, dst_id) VALUES ($1, 'gmailthreadlink', $2)`, [c, m]);
  await db.query(`INSERT INTO edges (a, b, kind, w) VALUES (least($1::bigint, $2::bigint), greatest($1::bigint, $2::bigint), 'coaccess', 1)`, [c, m]);
  await db.query(`UPDATE chunks SET embedding = array_fill(0.03, ARRAY[1024])::halfvec`);
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('privateOk: a Claude app on Anthropic only; z.ai / proxies / other apps / unknown / MEMHUB_PRIVATE_SOURCES=0 → no', () => {
  const yes: [string, NodeJS.ProcessEnv][] = [['claude-code', {}], ['claude-ai', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }],
    ['claude-code', { ANTHROPIC_BASE_URL: ' https://API.anthropic.com/ ' }]];
  const no: [string | undefined, NodeJS.ProcessEnv][] = [['claude-code', { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }],
    ['claude-code', { ANTHROPIC_BASE_URL: 'http://localhost:4000' }], ['claude-code', { MEMHUB_PRIVATE_SOURCES: '0' }],
    ['codex-mcp-client', {}], ['gemini-cli-mcp-client', {}], ['antigravity-client', {}], ['zcode', {}], ['LM Studio', {}],
    ['some-bot', {}], ['unknown', {}], [undefined, {}], ['my-claude-code', {}]];
  for (const [c, env] of yes) assert.equal(privateOk(c, env), true, `${c} ${JSON.stringify(env)}`);
  for (const [c, env] of no) assert.equal(privateOk(c, env), false, `${c} ${JSON.stringify(env)}`);
});

test('index: the fake mail lands with no secret (turns, chunks, headers); a non-private source keeps today\'s redaction', async () => {
  const rows = (await db.query(`SELECT t.text_redacted || c.text || c.ctx_header x FROM turns t JOIN chunks c ON c.source_id = t.source_id
    WHERE t.source_id = $1`, [ids['gmail:t1'].source])).rows;
  assert.ok(rows.length && rows.every((r) => r.x.includes('gmail marker') && r.x.includes('[REDACTED:otp]')));
  for (const s of SECRETS) assert.ok(rows.every((r) => !r.x.includes(s)), `secret left: ${SECRETS.indexOf(s)}`);
  const ctl = (await db.query(`SELECT text_redacted FROM turns WHERE source_id = $1`, [ids['zc-1'].source])).rows[0].text_redacted;
  assert.equal(ctl, clean(CONTROL));
});

async function mcp(name: string, env: Record<string, string> = {}) {
  const client = new Client({ name, version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'src', 'mcp.ts')],
    env: { ...ENV, MEMORY_HUB_INTERNAL: '1', ...env }, cwd: ROOT, stderr: 'ignore' }));
  const call = async (tool: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name: tool, arguments: args })) as { content: { text: string }[] }).content[0].text;
  return { call, close: () => client.close() };
}
/** Everything a client can read about the private sources and the control chat linked/similar to them. */
async function look(name: string, env?: Record<string, string>) {
  const m = await mcp(name, env);
  try {
    const out: Record<string, string> = { search: await m.call('memory_search', { query: WORD, limit: 8 }),
      brief: await m.call('memory_search', { query: WORD, detail: 'brief' }), related: await m.call('memory_related', { id: ids['zc-1'].chunk }),
      // a date range around the fake sources' day (2026-09-20) must not open the gate either, in either mode
      dated: await m.call('memory_search', { query: WORD, since: '2026-09-20', until: '2026-09-20', limit: 8 }),
      'dated brief': await m.call('memory_search', { query: WORD, until: '2026-09-21', detail: 'brief' }),
      early: await m.call('memory_search', { query: WORD, until: '2026-09-19' }),
      'bad until': await m.call('memory_search', { query: WORD, until: 'yesterday' }) };
    for (const sid of ['gmail:t1', 'google-timeline']) {
      const id = ids[sid].chunk;
      for (const k of [id, id.slice(0, 8)]) {
        out[`get ${sid} ${k.length}`] = await m.call('memory_get', { id: k });
        out[`related ${sid} ${k.length}`] = await m.call('memory_related', { id: k });
        out[`timeline ${sid} ${k.length}`] = await m.call('memory_timeline', { id: k });
      }
    }
    return out;
  } finally { await m.close(); }
}

test('MCP: other apps, Claude on z.ai / a proxy, MEMHUB_PRIVATE_SOURCES=0 and unknown clients get nothing private', async () => {
  const hidden: [string, Record<string, string>?][] = [['codex-mcp-client'], ['gemini-cli-mcp-client'], ['antigravity-client'], ['zcode'],
    ['LM Studio'], ['some-bot', { MEMHUB_PRIVATE_SOURCES: '0' }], ['mystery-app'],
    ['claude-code', { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' }], ['claude-code', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000' }],
    ['claude-code', { MEMHUB_PRIVATE_SOURCES: '0' }]];
  const priv = [ids['gmail:t1'], ids['google-timeline']];
  await Promise.all(hidden.map(async ([name, env]) => {
    const o = await look(name, env), who = `${name} ${JSON.stringify(env ?? {})}`;
    assert.match(o.search, /control chat/, who); // the gate hides private sources, not memory
    assert.match(o.dated, /control chat/, who);
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('get ') || k.startsWith('related ') || k.startsWith('timeline ')) assert.match(v, /^not found: /, `${who} ${k}`);
      assert.doesNotMatch(v, /marker|gmailthreadlink|Gmail|Google|gmail:t1/, `${who} ${k}`);
      if (!/^(get|related|timeline) /.test(k)) for (const p of priv) assert.ok(!v.includes(p.chunk.slice(0, 8)), `${who} ${k}: private id`); // not found: <id> echoes it
    }
  }));
});

test('MCP: Claude Code / Claude Desktop on Anthropic see them, labelled, still redacted', async () => {
  for (const [name, env] of [['claude-code', {}], ['claude-ai', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }]] as const) {
    const o = await look(name, env);
    assert.match(o.search, /Gmail[^\n]*\n[^\n]*gmail marker/, name);
    assert.match(o.search, /Google Maps timeline[^\n]*\n[^\n]*timeline marker/, name);
    assert.match(o.brief, /Gmail/, name);
    assert.match(o.dated, /gmail marker/, name);
    assert.match(o['dated brief'], /Google Maps timeline/, name);
    assert.match(o.early, /^no matches/, name);
    assert.match(o['bad until'], /until must be an ISO date/, name);
    assert.match(o['get gmail:t1 16'], /gmail marker.*\[REDACTED:otp\]/s, name);
    assert.doesNotMatch(o['timeline google-timeline 8'], /^not found/, name);
    assert.match(o.related, /gmailthreadlink/, name);
    for (const [k, v] of Object.entries(o)) for (const s of SECRETS) { // the control chat keeps its card (not a private source)
      if (!CONTROL.includes(s) || k.startsWith('get gmail')) assert.ok(!v.includes(s), `${name} ${k}: secret ${SECRETS.indexOf(s)}`);
    }
  }
});

function sessionStart(app?: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'src', 'session-start.ts'), ...(app ? ['--app', app] : [])], { env: { ...ENV, ...env }, cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => resolve(out ? JSON.parse(out).hookSpecificOutput.additionalContext : ''));
    p.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'ss-now', cwd: ROOT }));
  });
}

test('SessionStart: never a private source, for any app (Claude on Anthropic included)', async () => {
  const outs = await Promise.all([sessionStart(), sessionStart(undefined, { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }),
    ...['codex', 'gemini', 'antigravity', 'zcode', 'lmstudio'].map((a) => sessionStart(a))]);
  for (const o of outs) {
    assert.match(o, /control chat/); // the same query does list the non-private session
    assert.doesNotMatch(o, /marker|REDACTED:otp/);
  }
});

test('public brain: no node, edge, label or time for private tools; counts only under "google"; assertAnonymous enforces it', async () => {
  const b = await buildBrain(db, 'public');
  const json = JSON.stringify(b);
  await assertAnonymous(db, json);
  assert.equal(b.apps.google?.chunks, 2);
  assert.equal(b.apps.google?.turns, 2);
  assert.equal(b.apps.google?.t1, 0);
  assert.equal(b.nodes.filter((n) => n.type !== 'project').length, 1); // the control chat only
  assert.doesNotMatch(json, /google\/timeline|gmail/i);
  const local = await buildBrain(db, 'local');
  assert.ok(!local.nodes.some((n) => [ids['gmail:t1'].source, ids['google-timeline'].source].some((s) => n.id === `source:${s}`)));
  // a private node slipping in (any id form, any app field) fails the publish check
  const leak = (n: object) => JSON.stringify({ ...b, nodes: [...b.nodes, { type: 'note', p: b.nodes[0].id, n: 1, t0: 0, t1: 0, u: 0, ...n }] });
  const { createHmac } = await import('node:crypto');
  const pid = createHmac('sha256', 'test-salt').update(`source:${ids['google-timeline'].source}`).digest('base64url').slice(0, 10);
  await assert.rejects(assertAnonymous(db, leak({ id: pid })), /Claude-only/);
  await assert.rejects(assertAnonymous(db, leak({ id: 'x1', a: 'google' })), /Claude-only/);
});

test('corpus stats (term_df) leave private sources out: Claude-only data never shifts another app\'s ranking', async () => {
  await guard();
  await (await import('../src/search.ts')).refreshTermDf(db);
  const df = (await db.query(`SELECT word, ndoc FROM term_df WHERE word LIKE 'quagmire%' OR word = 'marker'`)).rows;
  assert.deepEqual(df.map((r) => [r.word.startsWith('quagmire'), r.ndoc]), [[true, 1]], 'only the control chat counts; "marker" is private-only');
});

test('memory_timeline: an id prefix shared by a hidden and a visible chunk centres on the visible one', async () => {
  await guard();
  const [P, V] = ['aaaaaaaa00000000', 'aaaaaaaaffffffff']; // same 8-char prefix; the hidden one sorts first
  await db.query(`UPDATE chunks SET id = $1 WHERE id = $2`, [P, ids['google-timeline'].chunk]);
  await db.query(`UPDATE chunks SET id = $1 WHERE id = $2`, [V, ids['zc-1'].chunk]);
  ids['google-timeline'].chunk = P; ids['zc-1'].chunk = V;
  const { timeline } = await import('../src/timeline.ts');
  assert.equal((await timeline(db, 'aaaaaaaa'))?.hit.id, P, 'precondition: resolved by timeline() alone, the prefix lands on the hidden chunk');
  const m = await mcp('codex-mcp-client');
  try {
    const out = await m.call('memory_timeline', { id: 'aaaaaaaa' });
    assert.doesNotMatch(out, /^not found|google|ไอซ์แลนด์/i);
  } finally { await m.close(); }
});

test('a Claude chat shown a Claude-only hit is Claude-only too: its answers, summary and subagents, either order, sticky', async () => {
  const { indexFile } = await import('../src/importer.ts');
  const hub = 'mcp__memory-hub__memory_search';
  const line = (sid: string, i: number, o: object) => JSON.stringify({ sessionId: sid, cwd: ROOT, timestamp: `2026-09-21T05:0${i}:00Z`, uuid: `${sid}-${i}`, parentUuid: i ? `${sid}-${i - 1}` : null, ...o });
  const chat = (sid: string, hitId: string | null, words: string, input: object = { query: 'x' }) => [
    line(sid, 0, { type: 'user', message: { content: `${WORD} ${words} question` } }),
    ...(hitId ? [line(sid, 1, { type: 'assistant', message: { content: [{ type: 'tool_use', id: `${sid}t`, name: hub, input }] } }),
      line(sid, 2, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `${sid}t`, content: `[${hitId}] 2026-09-20 1d | hit` }] } })] : []),
    line(sid, 3, { type: 'assistant', message: { content: [{ type: 'text', text: `${WORD} ${words} answer` }] } }),
    line(sid, 4, { type: 'user', isCompactSummary: true, message: { content: `${WORD} ${words} summary` } }),
  ].join('\n') + '\n';
  const file = (sid: string, sub: boolean, text: string) => {
    const p = sub ? join(tmp, 'proj', sid, 'subagents', 'agent-a.jsonl') : join(tmp, 'proj', `${sid}.jsonl`);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
    return p;
  };
  const priv = ids['google-timeline'].chunk, pub = ids['zc-1'].chunk;
  await guard();
  await indexFile(db, file('cs-a', true, chat('cs-a', null, 'subamarker')));    // subagent first, its main got the hit
  await indexFile(db, file('cs-a', false, chat('cs-a', priv, 'mainamarker')));
  const mainB = file('cs-b', false, chat('cs-b', null, 'mainbmarker'));          // main first, its subagent got the hit
  await indexFile(db, mainB);
  await indexFile(db, file('cs-b', true, chat('cs-b', priv, 'subbmarker')));
  await indexFile(db, file('cs-c', false, chat('cs-c', pub, 'publicmarker')));   // a hub reply with a public id only
  await indexFile(db, file('cs-d', false, chat('cs-d', 'none', 'getmarker', { id: priv.slice(0, 8) }))); // asked for a private id prefix
  await indexFile(db, mainB, true);                                              // re-index: the flag stays
  const flags = (await db.query(`SELECT session_id || ' ' || kind || ' ' || coalesce(hide_as, '-') f FROM sources WHERE tool = 'claude' ORDER BY 1`)).rows.map((r) => r.f);
  assert.deepEqual(flags, ['cs-a main google-timeline', 'cs-a subagent google-timeline', 'cs-b main google-timeline', 'cs-b subagent google-timeline', 'cs-c main -', 'cs-d main google-timeline']);
  for (const [name, sees] of [['codex-mcp-client', false], ['claude-code', true]] as const) {
    const m = await mcp(name);
    try {
      const out = await m.call('memory_search', { query: `${WORD} answer summary question`, limit: 8 });
      assert.match(out, /publicmarker/, name);
      for (const k of ['subamarker', 'mainamarker', 'mainbmarker', 'subbmarker']) assert.equal(out.includes(k), sees, `${name} ${k}`);
    } finally { await m.close(); }
  }
  // both on disk, main indexed first and alone (ingest order; the subagent's commit may come later or never): hidden from its own commit
  file('cs-e', true, chat('cs-e', priv, 'subemarker'));
  await indexFile(db, file('cs-e', false, chat('cs-e', null, 'mainemarker')));
  assert.deepEqual((await db.query(`SELECT kind || ' ' || coalesce(hide_as, '-') f FROM sources WHERE session_id = 'cs-e'`)).rows.map((r) => r.f), ['main google-timeline']);
});

test('a rewritten source that gains a turn in front: kept chunks follow their turn (memory_get reads the right one)', async () => {
  const path = join(tmp, 'renumber.json');
  const msg = (k: string) => ({ uuid: `rn-${k}`, parentUuid: null, sessionId: 'rn', ts: '2026-09-20T05:00:00Z', cwd: 'google/timeline', role: 'note' as const, text: `${WORD} turn ${k}` });
  for (const ks of [['a', 'b'], ['new', 'a', 'b']]) {
    writeFileSync(path, ks.join());
    await guard();
    await indexToolFile(db, { tool: 'google-timeline', sync: () => ({}), isTranscript: () => true, parse: async () => ({ sessionId: 'rn', cwd: 'google/timeline', kind: 'doc', msgs: ks.map(msg) }) }, path);
  }
  const rows = (await db.query(`SELECT c.turn_uuid, t.uuid FROM chunks c JOIN sources s ON s.id = c.source_id AND s.path = $1
    LEFT JOIN turns t ON t.source_id = c.source_id AND t.seq = c.seq_from ORDER BY c.seq_from`, [path])).rows;
  assert.deepEqual(rows.map((r) => [r.turn_uuid, r.uuid]), [['rn-new', 'rn-new'], ['rn-a', 'rn-a'], ['rn-b', 'rn-b']]);
});

test('synapses: linked lines and memory_related never show or relay through a Claude-only source', async () => {
  await guard();
  // control chat A — Claude-only G (Gmail), T (Maps timeline), H (a Claude chat flagged above) — visible B; A — visible V
  await index('zcode', 'zc-b', 'main', ROOT, 'relaytarget zebra note');
  await index('zcode', 'zc-v', 'main', ROOT, 'visiblelinked zebra note');
  const [A, B, V, G, T] = ['zc-1', 'zc-b', 'zc-v', 'gmail:t1', 'google-timeline'].map((k) => ids[k].source);
  const H = (await db.query(`SELECT id::text FROM sources WHERE hide_as IS NOT NULL ORDER BY id LIMIT 1`)).rows[0].id;
  for (const [x, y, k] of [[A, H, 'prov'], [A, T, 'next'], [G, B, 'prov'], [H, B, 'spawn'], [T, B, 'next'], [A, V, 'next']]) {
    await db.query(`INSERT INTO edges (a, b, kind, w) VALUES (least($1::bigint, $2::bigint), greatest($1::bigint, $2::bigint), $3, 1)`, [x, y, k]);
  }
  const hiddenIds = (await db.query(`SELECT c.id FROM chunks c JOIN sources s ON s.id = c.source_id WHERE coalesce(s.hide_as, s.tool) = ANY($1)`,
    [['google', 'google-timeline']])).rows.map((r) => r.id); // full ids: an earlier test gave a hidden and a visible chunk one 8-char prefix
  const PRIV = /gmail marker|timeline marker|ไอซ์แลนด์|subamarker|mainamarker|mainbmarker|subbmarker|getmarker|relaytarget|Gmail|Google/;
  const env = { MEMHUB_ASSOC: '1', MEMHUB_ASSOC_THETA: '0.01' };
  const m = await mcp('codex-mcp-client', env);
  try {
    const q = { query: WORD, limit: 8 };
    const out = { first: await m.call('memory_search', q),
      brief: await m.call('memory_search', { ...q, detail: 'brief' }), related: await m.call('memory_related', { id: ids['zc-1'].chunk }) };
    assert.match(out.first, /⇢ linked \[[0-9a-f]{16}\] [^\n]*visiblelinked/, 'the channel works for codex through visible synapses');
    for (const [k, v] of Object.entries(out)) {
      assert.doesNotMatch(v, PRIV, k);
      for (const p of hiddenIds) assert.ok(!v.includes(p), `${k}: hidden id ${p}`);
    }
  } finally { await m.close(); }
  // control: Claude on Anthropic may see the hidden nodes, so B is reachable through them
  const c = await mcp('claude-code', env);
  try { assert.match(await c.call('memory_related', { id: ids['zc-1'].chunk }), /linked ⇢\n[^]*relaytarget/); } finally { await c.close(); }
});
