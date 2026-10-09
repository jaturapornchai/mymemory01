// End-to-end "does it really remember": the exact processes Claude Code runs, in a throwaway schema + temp dirs.
//   session ends → SessionEnd hook (stdin JSON) → detached ingest → a NEW MCP server (stdio) finds it in Thai/English,
//   memory_save → findable from the next session, SessionStart injects recent work, secrets never stored,
//   non-Anthropic backend → nothing served, forget → gone.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-e2e-'));
const SCHEMA = `memhub_e2e_test_${process.pid}`; // per run: a concurrent run must never drop our schema (writes would fall through to public)
const ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  MEMHUB_PG_SCHEMA: SCHEMA, MEMHUB_LIVE_DIR: join(tmp, 'live'), MEMHUB_ARCHIVE_DIR: join(tmp, 'archive'),
  MEMHUB_MEMORY_VAULT: join(tmp, 'vault'), MEMHUB_VAULTS: '', ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
};
delete ENV.MEMORY_HUB_INTERNAL;
Object.assign(process.env, ENV);
const { connect, ROOT } = await import('../src/db.ts');
const db = connect('rw');
const SRC = join(ROOT, 'src');
const SESSION = 'e2e00000-1111-2222-3333-444455556666';
const transcript = join(tmp, 'live', 'D--e2e-proj', `${SESSION}.jsonl`);

function runNode(script: string, args: string[], input: string, env = ENV): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(SRC, script), ...args], { env, cwd: tmp });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('error', reject);
    p.on('close', () => resolve(out));
    p.stdin.end(input);
  });
}
async function mcp(env = ENV, name = 'e2e', cwd = tmp) {
  const client = new Client({ name, version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(SRC, 'mcp.ts')], env, cwd, stderr: 'ignore' }));
  const call = async (name: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text;
  return { call, close: () => client.close() };
}
async function until(what: string, ok: () => Promise<boolean>, ms = 60_000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 500))) if (await ok()) return;
  throw new Error(`timeout waiting for ${what}`);
}

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  await db.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO memhub_ro; GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO memhub_ro`);
  mkdirSync(join(tmp, 'live', 'D--e2e-proj'), { recursive: true });
  let n = 0;
  const line = (type: string, content: unknown) => JSON.stringify({ type, uuid: `e2e-${++n}`, parentUuid: n > 1 ? `e2e-${n - 1}` : null,
    sessionId: SESSION, timestamp: `2026-09-30T0${n}:00:00Z`, cwd: 'D:\\e2e-proj', message: { role: type, content } }) + '\n';
  writeFileSync(transcript,
    line('user', 'ช่วยจำไว้ด้วย รหัสห้องประชุมลับของทีมคือ ม้าลายสีม่วง-7731 ใช้เปิดห้องประชุมชั้น 9') +
    line('assistant', [{ type: 'text', text: 'รับทราบครับ The e2e meeting-room codename is purple-zebra-7731 (floor 9).' }]) +
    line('user', 'ทดสอบความลับ PGPASSWORD=Sup3rS3cretE2E และ <private>ลูกค้าคุณสมชาย 0812345678</private> จบ') +
    line('assistant', [{ type: 'text', text: 'ok' }]));
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('SessionEnd hook → detached ingest → stored (secrets redacted, private dropped)', async () => {
  const t0 = Date.now();
  await runNode('hook.ts', [], JSON.stringify({ hook_event_name: 'SessionEnd', session_id: SESSION, transcript_path: transcript, cwd: 'D:\\e2e-proj' }));
  assert.ok(Date.now() - t0 < 3000, 'hook must return fast (ingest is detached)');
  await until('ingest', async () => Number((await db.query('SELECT count(*) FROM chunks')).rows[0].count) > 0);
  await until('embeddings', async () => Number((await db.query('SELECT count(*) FROM chunks WHERE embedding IS NULL')).rows[0].count) === 0, 90_000)
    .catch(() => {}); // Ollama busy → keyword search still works
  const all = (await db.query(`SELECT string_agg(text_redacted, ' ') t FROM turns`)).rows[0].t as string;
  assert.ok(all.includes('7731'));
  assert.ok(!all.includes('Sup3rS3cretE2E') && !all.includes('0812345678') && !all.includes('สมชาย'), 'secret/private text reached the DB');
});

test('a new session finds it: Thai paraphrase, English, and full text via memory_get', async () => {
  const m = await mcp();
  try {
    const th = await m.call('memory_search', { query: 'รหัสห้องประชุมลับ ชั้น 9 คืออะไร' });
    assert.match(th, /7731/, th);
    const en = await m.call('memory_search', { query: 'purple zebra codename' });
    assert.match(en, /7731/, en);
    const id = th.match(/^\[([0-9a-f]{16})\]/m)![1];
    const full = await m.call('memory_get', { id });
    assert.match(full, /ม้าลายสีม่วง-7731/);
    assert.doesNotMatch(await m.call('memory_search', { query: 'Sup3rS3cretE2E' }), /Sup3rS3cretE2E/);
    const used = await until('access_log', async () => Number((await db.query(`SELECT count(*) FROM access_log WHERE kind = 'get'`)).rows[0].count) > 0, 5000).then(() => true);
    assert.ok(used, 'recall was logged for ranking');
  } finally { await m.close(); }
});

test('progressive disclosure over stdio: brief search → memory_get view timeline → text, estimates match what get returns', async () => {
  const { tokens } = await import('../src/timeline.ts');
  const m = await mcp();
  try {
    const brief = await m.call('memory_search', { query: 'รหัสห้องประชุมลับ ชั้น 9', detail: 'brief' });
    const [, id, est] = brief.match(/^\[([0-9a-f]{16})\] .*? ≈(\d+)t/m) ?? [];
    assert.ok(id, brief);
    for (const l of brief.split('\n')) assert.ok(l.length <= 200, l);
    const tl = await m.call('memory_get', { view: 'timeline', id });
    assert.ok(tl.length <= 1500 && new RegExp(`^▶ \\[${id}\\] `, 'm').test(tl), tl);
    const got = tokens(await m.call('memory_get', { id }));
    assert.ok(Math.abs(Number(est) - got) <= Math.max(5, got * 0.1), `brief ≈${est}t vs memory_get ≈${got}t`);
    assert.equal(await m.call('memory_get', { view: 'timeline', id: 'F99999999' }), 'not found: F99999999');
  } finally { await m.close(); }
});

test('every read tool logs its latency (search: + keyword-only flag) → cli stats --latency', async () => {
  const m = await mcp();
  try {
    const id = (await m.call('memory_search', { query: 'รหัสห้องประชุมลับ ชั้น 9' })).match(/^\[([0-9a-f]{16})\]/m)![1];
    for (const view of ['text', 'related', 'timeline']) await m.call('memory_get', { id, view });
  } finally { await m.close(); }
  const timed = async () => (await db.query(`SELECT tool, kind, ms, semantic FROM access_log WHERE rank = 1 AND ms IS NOT NULL ORDER BY id`)).rows;
  await until('latency rows', async () => new Set((await timed()).map((r) => r.tool)).size === 4, 5000);
  const rows = await timed();
  assert.deepEqual([...new Set(rows.map((r) => r.tool))].sort(), ['get', 'related', 'search', 'timeline']);
  for (const r of rows) {
    assert.ok(r.ms >= 0 && r.ms < 60_000, `${r.tool} ${r.ms} ms`);
    assert.equal(typeof r.semantic, r.tool === 'search' ? 'boolean' : 'object', r.tool); // null unless search
  }
  assert.ok(rows.filter((r) => r.tool === 'timeline').every((r) => r.kind === 'related'), 'timeline still counts as a recall');
  const stats = await runNode('cli.ts', ['stats', '--latency'], '');
  for (const s of ['last 1 day', 'last 7 days', 'timeline', 'keyword_only_pct', "'all'"]) assert.ok(stats.includes(s), stats);
});

test('memory_save → indexed in the background → found by the next session', async () => {
  const m1 = await mcp();
  const saved = await m1.call('memory_save', { content: 'ลุงจืดชอบให้สรุปท้ายงานเป็น ข้อดี/ข้อเสีย/คำแนะนำ เสมอ (e2e-save-4242)', kind: 'preference' });
  await m1.close();
  assert.match(saved, /^saved: facts\//);
  await until('saved note indexed', async () => Number((await db.query(`SELECT count(*) FROM facts WHERE kind = 'preference'`)).rows[0].count) > 0);
  const m2 = await mcp();
  try { assert.match(await m2.call('memory_search', { query: 'e2e-save-4242 สรุปท้ายงาน' }), /4242/); } finally { await m2.close(); }
});

test('SessionStart hook injects recent work for the project (≤2000 chars)', async () => {
  const out = await runNode('session-start.ts', [], JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'other', cwd: 'D:\\e2e-proj' }));
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
  assert.ok(ctx.length <= 2000);
  assert.match(ctx, /ห้องประชุม/);
});

test('every AI app is served (another client, a z.ai-routed Claude) and its saves carry the client name', async () => {
  const zai = { ...ENV, ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' };
  const m = await mcp(zai, 'codex-mcp-client');
  try {
    assert.match(await m.call('memory_search', { query: 'ห้องประชุม' }), /ห้องประชุม/);
    const saved = await m.call('memory_save', { content: 'บันทึกจาก Codex ผ่าน memory-hub (e2e-client-5151)' });
    const note = readFileSync(join(ENV.MEMHUB_MEMORY_VAULT!, saved.replace(/^saved: /, '').replace(/ \(searchable.*$/, '')), 'utf8');
    assert.match(note, /^client: codex-mcp-client$/m);
  } finally { await m.close(); }
  await until('codex access logged', async () => Number((await db.query(`SELECT count(*) FROM access_log WHERE client = 'codex-mcp-client'`)).rows[0].count) > 0);
  assert.notEqual(await runNode('session-start.ts', [], JSON.stringify({ session_id: 'o', cwd: 'D:\\e2e-proj' }), zai), '');
});

test('MEMHUB_ANTHROPIC_ONLY=1: a non-Anthropic backend gets nothing', async () => {
  const strict = { ...ENV, ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', MEMHUB_ANTHROPIC_ONLY: '1' };
  const m = await mcp(strict);
  try { assert.match(await m.call('memory_search', { query: '7731' }), /memory-hub is off/); } finally { await m.close(); }
  assert.equal(await runNode('session-start.ts', [], JSON.stringify({ session_id: 'o', cwd: 'D:\\e2e-proj' }), strict), '');
  // Claude-only restored: other apps get nothing even on their own backend; Claude Code still does
  const only = { ...ENV, MEMHUB_ANTHROPIC_ONLY: '1' };
  for (const [name, off] of [['codex-mcp-client', true], ['claude-code', false]] as const) {
    const c = await mcp(only, name);
    try { assert.equal(/memory-hub is off/.test(await c.call('memory_search', { query: '7731' })), off, name); } finally { await c.close(); }
  }
});

test('freshness: what other apps did since server start is found at once (search, timeline, similar); the caller\'s own live session is not', async () => {
  const { indexToolFile } = await import('../src/importer.ts');
  // cwd ROOT = a project; cwd tmp (AppData temp) = currentProject '', but the importer still stores normProject(tmp) for its chats
  for (const [cwd, word] of [[ROOT, 'freshzebra'], [tmp, 'freshokapi']] as const) {
    const m = await mcp(ENV, 'codex-mcp-client', cwd);
    try {
      const at = new Date(Date.now() + 1000).toISOString();
      const add = async (tool: string, sid: string, dir: string, tag: string) => {
        const path = join(tmp, `${sid}.json`);
        writeFileSync(path, tag);
        const msgs = [{ uuid: `${sid}-1`, parentUuid: null, sessionId: sid, ts: at, cwd: dir, role: 'user' as const, text: `${word} ${tag}` }];
        assert.equal(await indexToolFile(db, { tool, sync: () => ({}), isTranscript: () => true, parse: async () => ({ sessionId: sid, cwd: dir, kind: 'main', msgs }) }, path), 'indexed');
        await db.query(`UPDATE chunks SET embedding = array_fill(0.1::real, ARRAY[1024])::vector::halfvec WHERE session_id = $1`, [sid]); // all alike → similar
        return (await db.query(`SELECT id FROM chunks WHERE session_id = $1`, [sid])).rows[0].id as string;
      };
      const other = await add('claude', `${word}-other`, cwd, 'otherapp');          // another app, same project → found
      const own = await add('codex', `${word}-own`, cwd, 'ownsession');             // this app, this project, after start → its own live session
      const elsewhere = await add('codex', `${word}-else`, 'D:\\elsewhere', 'ownelsewhere'); // this app, another project → found
      const out = await m.call('memory_search', { query: word, limit: 8 });
      assert.ok(out.includes(`${word} otherapp`), cwd);
      assert.ok(out.includes(`${word} ownelsewhere`), cwd);
      assert.ok(!out.includes(`${word} ownsession`), `${cwd}: ${out}`); // the other cwd's own session is not ours
      const tl = await m.call('memory_get', { view: 'timeline', id: other });
      assert.match(tl, new RegExp(`^▶ \\[${other}\\] `, 'm'), cwd); // was cut at server start
      assert.ok(!tl.includes(`[${own}]`), `${cwd}: ${tl}`); // 'other sessions near then' leaves out the caller's own live one
      const related = await m.call('memory_get', { view: 'related', id: elsewhere, limit: 8 });
      assert.ok(related.includes(`[${other}]`) && !related.includes(`[${own}]`), `${cwd}: ${related}`);
    } finally { await m.close(); }
  }
});

test('forget --session removes it for good (re-import skips it)', async () => {
  await runNode('cli.ts', ['forget', '--session', SESSION], '');
  await runNode('cli.ts', ['import'], '');
  const m = await mcp();
  try { assert.doesNotMatch(await m.call('memory_search', { query: 'ม้าลายสีม่วง 7731' }), /7731/); } finally { await m.close(); }
});
