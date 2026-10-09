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
// fact/card notes (writeNote, consolidate) and memory_save go to a throwaway vault, never the real one; no background re-index
const VAULT = join(tmpdir(), `memhub-private-vault-${process.pid}`, 'memory-hub');
const ENV: Record<string, string> = { ...(process.env as Record<string, string>), MEMHUB_PG_SCHEMA: SCHEMA, MEMHUB_PUBLIC_SALT: 'test-salt',
  MEMHUB_MEMORY_VAULT: VAULT, MEMHUB_NO_REINDEX: '1' };
for (const k of ['MEMORY_HUB_INTERNAL', 'MEMHUB_ANTHROPIC_ONLY', 'MEMHUB_PRIVATE_SOURCES', 'ANTHROPIC_BASE_URL']) delete ENV[k];
Object.assign(process.env, ENV);
for (const k of ['MEMHUB_ANTHROPIC_ONLY', 'MEMHUB_PRIVATE_SOURCES', 'ANTHROPIC_BASE_URL']) delete process.env[k];
const { connect, ROOT } = await import('../src/db.ts');
const { clean, hideDreamed, indexToolFile, normProject } = await import('../src/importer.ts');
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
  rmSync(join(VAULT, '..'), { recursive: true, force: true });
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
      brief: await m.call('memory_search', { query: WORD, detail: 'brief' }), related: await m.call('memory_get', { view: 'related', id: ids['zc-1'].chunk }),
      // a date range around the fake sources' day (2026-09-20) must not open the gate either, in either mode
      dated: await m.call('memory_search', { query: WORD, since: '2026-09-20', until: '2026-09-20', limit: 8 }),
      'dated brief': await m.call('memory_search', { query: WORD, until: '2026-09-21', detail: 'brief' }),
      early: await m.call('memory_search', { query: WORD, until: '2026-09-19' }),
      'bad until': await m.call('memory_search', { query: WORD, until: 'yesterday' }) };
    for (const sid of ['gmail:t1', 'google-timeline']) {
      const id = ids[sid].chunk;
      for (const k of [id, id.slice(0, 8)]) {
        out[`get ${sid} ${k.length}`] = await m.call('memory_get', { id: k });
        out[`related ${sid} ${k.length}`] = await m.call('memory_get', { view: 'related', id: k });
        out[`timeline ${sid} ${k.length}`] = await m.call('memory_get', { view: 'timeline', id: k });
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

test('memory_get view timeline: an id prefix shared by a hidden and a visible chunk centres on the visible one', async () => {
  await guard();
  const [P, V] = ['aaaaaaaa00000000', 'aaaaaaaaffffffff']; // same 8-char prefix; the hidden one sorts first
  await db.query(`UPDATE chunks SET id = $1 WHERE id = $2`, [P, ids['google-timeline'].chunk]);
  await db.query(`UPDATE chunks SET id = $1 WHERE id = $2`, [V, ids['zc-1'].chunk]);
  ids['google-timeline'].chunk = P; ids['zc-1'].chunk = V;
  const { timeline } = await import('../src/timeline.ts');
  assert.equal((await timeline(db, 'aaaaaaaa'))?.hit.id, P, 'precondition: resolved by timeline() alone, the prefix lands on the hidden chunk');
  const m = await mcp('codex-mcp-client');
  try {
    const out = await m.call('memory_get', { view: 'timeline', id: 'aaaaaaaa' });
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

test('synapses: linked lines and memory_get view related never show or relay through a Claude-only source', async () => {
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
      brief: await m.call('memory_search', { ...q, detail: 'brief' }), related: await m.call('memory_get', { view: 'related', id: ids['zc-1'].chunk }) };
    assert.match(out.first, /⇢ linked \[[0-9a-f]{16}\] [^\n]*visiblelinked/, 'the channel works for codex through visible synapses');
    for (const [k, v] of Object.entries(out)) {
      assert.doesNotMatch(v, PRIV, k);
      for (const p of hiddenIds) assert.ok(!v.includes(p), `${k}: hidden id ${p}`);
    }
  } finally { await m.close(); }
  // control: Claude on Anthropic may see the hidden nodes, so B is reachable through them
  const c = await mcp('claude-code', env);
  try { assert.match(await c.call('memory_get', { view: 'related', id: ids['zc-1'].chunk }), /linked ⇢\n[^]*relaytarget/); } finally { await c.close(); }
});

test('a fact / card dreamed from a chat that was hidden later is Claude-only too: search, get, timeline, related, save hint, SessionStart', async (t) => {
  const { fileName, md5, MEMORY_VAULT, projectSlug, writeNote } = await import('../src/notes.ts');
  const { indexVault, resolveLinks } = await import('../src/obsidian.ts');
  const { consolidate, factId } = await import('../src/dream.ts');
  const { commitBatch } = await import('../src/vault-git.ts');
  const { refreshTermDf, search } = await import('../src/search.ts');
  assert.equal(MEMORY_VAULT, VAULT, 'notes go to the throwaway vault');
  await guard();
  const MARK = 'zorbleflux'; // only hidden data holds it: chat X, its fact H and its card S (+ any note that copies their names)
  const [X, Y] = ['c0ffee11-aaaa-4bbb-8ccc-000000000001', 'beadfeed-aaaa-4bbb-8ccc-000000000002'];
  await index('claude', X, 'main', ROOT, `${MARK} chat: we agreed to always deploy staging through gateway blue port 7311`);
  await index('claude', Y, 'main', ROOT, 'yonderchat earlier: deploy staging through gateway green port 7311');
  // the dream's notes (dream.ts promote, while X was visible): V from Y; H from X, also mentioned in Y, supersedes V; S = X's card;
  // later runs: W from Y linked to H (- related::); P from Y proposes to update H (a rule: his, so pending review, dream.ts review)
  const slug = projectSlug(PROJECT), link = (rel: string) => `[[${rel.replace(/^.*\/|\.md$/g, '')}]]`;
  const vText = 'yonderchat rule: deploy staging through gateway green port 7311', hText = `${MARK} rule: always deploy staging through gateway blue port 7311`;
  const wText = 'yonderchat howto: check the gateway colour before a staging deploy', pText = 'yonderchat rule: deploy staging through gateway blue port 7312 now';
  const [V, H, S, W, P] = [factId(vText), factId(hText), `S${X.slice(0, 8)}`, factId(wText), factId(pText)];
  const rel = (fid: string, t: string) => `facts/${slug}/${fid} ${fileName(t, 40)}.md`;
  const [vRel, hRel, sRel] = [rel(V, vText), rel(H, hText), `sessions/2026-09/2026-09-20 ${slug} ${X.slice(0, 8)}.md`];
  const base = { memhub: 'fact', kind: 'rule', scope: 'project', project: PROJECT, lang: 'en', importance: '7', confidence: '0.9', pinned: 'false', run: 'r1',
    created_at: '2026-09-21T00:00:00.000Z', valid_at: '2026-09-20T05:00:00.000Z', invalid_at: '', expired_at: '', review_target: '' };
  writeNote(vRel, { ...base, id: V, md5: md5(vText), status: 'superseded', superseded_by: H, expired_at: base.created_at, source_uuids: [`${Y}-1`] }, `${vText}\n`);
  writeNote(hRel, { ...base, id: H, md5: md5(hText), status: 'active', superseded_by: '', source_uuids: [`${X}-1`, `${Y}-1`] },
    `${hText}\n\n- from:: ${link(sRel)}\n- supersedes:: ${link(vRel)}\n`);
  writeNote(sRel, { memhub: 'card', id: S, project: PROJECT, session: X, tool: 'claude', status: 'active', outcome: 'done', valid_at: base.valid_at,
    created_at: base.created_at, source_uuids: [`${X}-1`], run: 'r1' },
    `# ${MARK} gateway session\n\n${MARK} summary: agreed to deploy staging through gateway blue\n\n**Outcome:** done · 2026-09-20 · claude · session \`${X}\`\n` +
    `\n## Facts\n- ${link(hRel)}\n\nproject:: [[${slug} hub]]\n`);
  writeNote(rel(W, wText), { ...base, kind: 'howto', id: W, md5: md5(wText), status: 'active', superseded_by: '', source_uuids: [`${Y}-1`] },
    `${wText}\n\n- related:: ${link(hRel)}\n`);
  writeNote(rel(P, pText), { ...base, id: P, md5: md5(pText), status: 'pending', superseded_by: '', review_target: H, source_uuids: [`${Y}-1`] },
    `${pText}\n\n- review:: UPDATE ${link(hRel)} — port changed\n`);
  // Y's card lists H too (H also cites Y), then a note whose word 'quillwort' sits 100 chars after the window start passage()
  // picks for it (max 400 → anchor − 100): 2 chars into H's title, past the id, so masking after the cut would miss it
  const SY = `S${Y.slice(0, 8)}`, yHead = `# yonderchat gateway session\n\nyonderchat summary: deploy staging through gateway green\n\n` +
    `**Outcome:** done · 2026-09-20 · claude · session \`${Y}\`\n\n## Facts\n- ${link(hRel)}\n\n## Notes\n`;
  const at = yHead.replace(/\s+/g, ' ').indexOf(`${H} `) + H.length + 3, need = at + 100 - yHead.replace(/\s+/g, ' ').length;
  writeNote(`sessions/2026-09/2026-09-20 ${slug} ${Y.slice(0, 8)}.md`, { memhub: 'card', id: SY, project: PROJECT, session: Y, tool: 'claude', status: 'active',
    outcome: 'done', valid_at: base.valid_at, created_at: base.created_at, source_uuids: [`${Y}-1`], run: 'r1' },
    `${yHead}${'tidy note '.repeat(30).slice(0, need - 1).replace(/ $/, '.')} quillwort checklist: ${'confirm the colour, then ship. '.repeat(12)}\n`);
  commitBatch(MEMORY_VAULT, 'dream r1');
  await indexVault(db, MEMORY_VAULT);
  await resolveLinks(db);
  const sess = async (fid: string) => (await db.query(`SELECT session_ids FROM facts WHERE fid = $1`, [fid])).rows[0]?.session_ids.sort();
  assert.deepEqual([await sess(H), await sess(S), await sess(V)], [[Y, X], [X], [Y]], 'precondition: the notes cite their chats');
  // later: X was shown a Claude-only hit → hidden (importer.indexFile); the next night re-links synapses and rewrites hubs
  await db.query(`UPDATE sources SET hide_as = 'google' WHERE session_id = $1`, [X]);
  const noteHidden = async (fid: string) => (await db.query(`SELECT s.hide_as FROM facts f JOIN sources s ON s.id = f.source_id WHERE f.fid = $1`, [fid])).rows[0].hide_as;
  await hideDreamed(db, Y); // the importer's per-chat call for another chat: H/S untouched
  assert.deepEqual([await noteHidden(H), await noteHidden(S)], [null, null]);
  await hideDreamed(db, X); // = what importer.indexFile runs when it hides X
  assert.deepEqual([await noteHidden(H), await noteHidden(S), await noteHidden(V)], ['google', 'google', null], 'notes dreamed from X hide like X');
  // a note dreamed from X after X was hidden: hidden by its own indexing (obsidian.ts), not only by the next night's sweep
  const nText = `${MARK} howto: the blue gateway needs the staging token first`, N = factId(nText);
  writeNote(rel(N, nText), { ...base, kind: 'howto', id: N, md5: md5(nText), status: 'active', superseded_by: '', source_uuids: [`${X}-1`] }, `${nText}\n`);
  commitBatch(MEMORY_VAULT, 'dream r2');
  await indexVault(db, MEMORY_VAULT);
  assert.equal(await noteHidden(N), 'google', 'a note from a hidden chat is hidden once indexed');
  // a Claude chat shown the hidden fact's id is hidden like a chat shown a Claude-only chunk (importer.hideAsOf)
  const { indexFile } = await import('../src/importer.ts');
  const Z = 'cs-z', zl = (i: number, o: object) => JSON.stringify({ sessionId: Z, cwd: ROOT, timestamp: `2026-09-22T05:0${i}:00Z`, uuid: `${Z}-${i}`, parentUuid: i ? `${Z}-${i - 1}` : null, ...o });
  const zPath = join(tmp, 'proj', `${Z}.jsonl`);
  mkdirSync(join(zPath, '..'), { recursive: true });
  writeFileSync(zPath, [zl(0, { type: 'user', message: { content: 'which gateway for staging?' } }),
    zl(1, { type: 'assistant', message: { content: [{ type: 'tool_use', id: `${Z}t`, name: 'mcp__memory-hub__memory_search', input: { query: 'staging gateway' } }] } }),
    zl(2, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `${Z}t`, content: `[${H}] 2026-09-20 1d | ${MARK} rule: gateway blue` }] } }),
    zl(3, { type: 'assistant', message: { content: [{ type: 'text', text: `${MARK} answer: the blue gateway, port 7311` }] } })].join('\n') + '\n');
  await indexFile(db, zPath);
  assert.equal((await db.query(`SELECT hide_as FROM sources WHERE session_id = $1`, [Z])).rows[0]?.hide_as, 'google', 'a chat shown a hidden fact id is hidden');
  const embed = () => db.query(`UPDATE chunks SET embedding = array_fill(0.03, ARRAY[1024])::halfvec WHERE embedding IS NULL`);
  await embed();
  await consolidate(db);
  commitBatch(MEMORY_VAULT, 'consolidate t');
  const src = async (fid: string) => (await db.query(`SELECT source_id FROM facts WHERE fid = $1`, [fid])).rows[0].source_id;
  await db.query(`INSERT INTO edges (a, b, kind, w) VALUES (least($1::bigint, $2::bigint), greatest($1::bigint, $2::bigint), 'coaccess', 1)`, [await src(H), await src(W)]); // used together while H was visible
  await embed();
  await refreshTermDf(db); // hourly
  const chunkOfFid = async (fid: string) => (await db.query(`SELECT c.id FROM facts f JOIN chunks c ON c.source_id = f.source_id WHERE f.fid = $1
    ORDER BY c.seq_from, c.id LIMIT 1`, [fid])).rows[0].id as string;
  const hiddenIds = [await chunkOfFid(H), await chunkOfFid(S), await chunkOfFid(N), ids[X].chunk];
  const vis: Record<string, string> = { 'chat Y': ids[Y].chunk, 'fact V': await chunkOfFid(V), 'fact W': await chunkOfFid(W), 'pending P': await chunkOfFid(P),
    'card Y': await chunkOfFid(SY) };
  const PRIV = new RegExp(`${MARK.slice(2)}|${H}|${S}|${N}|${X.slice(0, 8)}`); // slice: a window cut 2 chars into H's title
  const save = 'always deploy staging through gateway blue port 7311 please'; // ≥ 60 % of H's words: memory_save's "คล้าย" hint
  const env = { MEMHUB_ASSOC: '1', MEMHUB_ASSOC_THETA: '0.01' };

  // control first (so the codex checks are not vacuous): Claude on Anthropic sees H on every surface checked below
  const c = await mcp('claude-code', env);
  try {
    assert.match(await c.call('memory_search', { query: MARK, limit: 8 }), new RegExp(`\\[${H}\\]`), 'claude: search');
    assert.doesNotMatch(await c.call('memory_get', { id: H }), /^not found/, 'claude: get');
    assert.match(await c.call('memory_get', { view: 'timeline', id: vis['chat Y'] }), new RegExp(`\\[${H}\\]`), 'claude: timeline of Y');
    assert.match(await c.call('memory_get', { view: 'related', id: vis['chat Y'] }), new RegExp(`same session ⇢\\n[^]*${H}`), 'claude: related of Y');
    assert.match(await c.call('memory_save', { content: save, kind: 'rule' }), new RegExp(`คล้าย \\[${H}\\]`), 'claude: save hint');
    assert.match(await c.call('memory_search', { query: 'quillwort', limit: 1 }), new RegExp(`\\n…${MARK.slice(2)}`), "claude: card Y's passage starts past H's id");
  } finally { await c.close(); }
  assert.equal((await search(db, MARK, { semantic: false, showPrivate: true })).signal?.unseen, 0, 'claude: the word is known');

  // codex: every surface, collected so one run lists every leak
  const out: Record<string, string> = {};
  const m = await mcp('codex-mcp-client', env);
  try {
    for (const q of [MARK, `${MARK} gateway blue`, 'yonderchat', 'yonderchat gateway green']) {
      out[`search "${q}"`] = await m.call('memory_search', { query: q, limit: 8 });
      out[`brief "${q}"`] = await m.call('memory_search', { query: q, limit: 8, detail: 'brief' });
    }
    out['search "quillwort" limit 1'] = await m.call('memory_search', { query: 'quillwort', limit: 1 }); // card Y, window cut inside H's link
    for (const view of ['text', 'timeline', 'related']) {
      for (const id of [H, S, ...hiddenIds]) out[`get ${view} hidden ${id}`] = await m.call('memory_get', { view, id });
      for (const [k, id] of Object.entries(vis)) out[`get ${view} of visible ${k}`] = await m.call('memory_get', { view, id });
    }
    out['save hint'] = await m.call('memory_save', { content: save, kind: 'rule' });
  } finally { await m.close(); }
  out['SessionStart codex'] = await sessionStart('codex');
  assert.match(out['SessionStart codex'], /^\[memory-hub\]/, 'SessionStart ran');
  const leaks: string[] = [];
  for (const [k, v] of Object.entries(out)) {
    if (k.includes(' hidden ')) { if (!/^not found: /.test(v)) leaks.push(`${k}: found`); continue; } // "not found: <id>" echoes the id
    for (const line of v.split('\n')) if (PRIV.test(line) || hiddenIds.some((p) => line.includes(p))) leaks.push(`${k}: ${line.slice(0, 170)}`); // every leaking line = the to-do list
  }
  // known residual (closing it = an index change, so an eval first): a visible note's link line still names the hidden note
  // ([[<fid> <title>]]), so its title words stay in the index (term_df, signal.unseen) though every output above masks them.
  // Asserted to be only that: any other visible text holding the word is a leak.
  const holders = (await db.query(`SELECT c.text FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.text ILIKE $1 AND coalesce(s.hide_as, s.tool) <> ALL($2::text[])`,
    [`%${MARK}%`, ['google', 'google-timeline']])).rows;
  for (const { text } of holders) for (const line of text.split('\n'))
    if (line.toLowerCase().includes(MARK) && !/^\s*- (?:[a-z_]+::.*)?\[\[/.test(line)) leaks.push(`visible text holds the hidden word: ${line.slice(0, 120)}`);
  t.diagnostic(`known residual: ${holders.length} visible note(s) name the hidden note in a link line (term_df / signal.unseen still count its title words)`);
  assert.deepEqual(leaks, []);
});
