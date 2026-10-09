// The automatic "another app worked here" line (lastOtherApp) and its place in the SessionStart hook; client name → app.
// Own throwaway schema per run (never public).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = `memhub_handoff_test_${process.pid}`;
const ENV: Record<string, string> = { ...(process.env as Record<string, string>), MEMHUB_PG_SCHEMA: SCHEMA, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' };
delete ENV.MEMORY_HUB_INTERNAL; // session-start.ts skips internal runs
delete ENV.MEMHUB_ANTHROPIC_ONLY;
Object.assign(process.env, ENV);
const { connect, ROOT } = await import('../src/db.ts');
const { normProject } = await import('../src/importer.ts');
const h = await import('../src/handoff.ts');

const db = connect('rw');
const PROJECT = normProject(ROOT); // the MCP server / hook run with cwd = ROOT
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');

function sessionStart(app?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'src', 'session-start.ts'), ...(app ? ['--app', app] : [])], { env: ENV, cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => resolve(out ? JSON.parse(out).hookSpecificOutput.additionalContext : ''));
    p.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'hs-now', cwd: ROOT }));
  });
}
/** A main session of another app in PROJECT, `hours` ago (what the importer would store). */
async function session(tool: string, sid: string, prompt: string, hours: number) {
  await guard();
  const src = (await db.query(`INSERT INTO sources (tool, path, kind, session_id, project, size, mtime_ms, sha256)
    VALUES ($1, $2, 'main', $3, $4, 1, 1, 'x') RETURNING id`, [tool, `${tool}/${sid}.jsonl`, sid, PROJECT])).rows[0].id;
  const ts = new Date(Date.now() - hours * 3600e3);
  await db.query(`INSERT INTO turns (uuid, source_id, seq, session_id, role, ts, project, text_redacted) VALUES
    ($1 || '-1', $2, 0, $1, 'user', $3, $4, '[automation] tick'), ($1 || '-2', $2, 1, $1, 'user', $3, $4, $5)`, [sid, src, ts, PROJECT, prompt]);
  await db.query(`INSERT INTO chunks (id, source_id, turn_uuid, seq_from, seq_to, session_id, project, ts, ctx_header, text, words, bigrams, chunker_ver)
    VALUES ($1, $2, $1 || '-2', 0, 1, $1, $3, $4, '', $5, ''::tsvector, ''::tsvector, 't')`, [sid, src, PROJECT, ts, prompt]);
}

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  await db.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO memhub_ro; GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO memhub_ro`);
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
});

test('client name → app (= sources.tool)', () => {
  assert.deepEqual(['claude-code', 'claude-ai', 'codex-mcp-client', 'gemini-cli-mcp-client', 'antigravity-client', 'LM Studio', 'zcode', 'x-y'].map(h.appOf),
    ['claude', 'claude', 'codex', 'gemini', 'antigravity', 'lmstudio', 'zcode', 'xy']);
});

test('automatic line: the last session here (≤48 h) came from another app → its card title or first prompt', async () => {
  await session('claude', 'hs-old-claude', 'งานเก่าของ claude', 30);
  await session('codex', 'hs-codex', 'แก้บั๊ก ledger rounding ใน proj-a', 3);
  assert.equal(await h.lastOtherApp(db, PROJECT, 'claude-code'), 'ล่าสุด codex ทำงานนี้ 3 ชม.ก่อน: แก้บั๊ก ledger rounding ใน proj-a');
  assert.equal(await h.lastOtherApp(db, PROJECT, 'codex-mcp-client'), null, 'same app: nothing to hand over');
  assert.equal(await h.lastOtherApp(db, '', 'claude-code'), null, 'no project: no line');
  // a dream card for that session wins over the raw prompt
  const card = (await db.query(`INSERT INTO sources (tool, path, kind, session_id, project, size, mtime_ms, sha256)
    VALUES ('obsidian', 'cards/hs.md', 'note', 'cards/hs.md', 'obsidian/memory-hub', 1, 1, 'x') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO turns (uuid, source_id, seq, session_id, role, text_redacted) VALUES ('hs-card', $1, 0, 'cards/hs.md', 'note', $2)`,
    [card, '# Shs000001 card\n# แก้ rounding ของ ledger ให้ตรง TFRS\n\nสรุป…']);
  await db.query(`INSERT INTO facts (source_id, fid, kind, project, valid_at, created_at, source_uuids, session_ids, md5)
    VALUES ($1, 'Shs000001', 'card', $2, now(), now(), '{hs-codex-2}', '{hs-codex}', 'm')`, [card, PROJECT]);
  assert.equal(await h.lastOtherApp(db, PROJECT, 'claude-code'), 'ล่าสุด codex ทำงานนี้ 3 ชม.ก่อน: แก้ rounding ของ ledger ให้ตรง TFRS');
  await session('gemini', 'hs-gemini-old', 'นอกช่วง 48 ชม.', 60);
  assert.match(await h.lastOtherApp(db, PROJECT, 'claude-code') ?? '', /^ล่าสุด codex/, 'older than 48 h is ignored');
});

test('SessionStart (Claude Code + other apps via --app): rules first, then the other-app line, whole lines, ≤ 2000 chars', async () => {
  await guard();
  for (let i = 0; i < 8; i++) { // 8 long rules: alone they would fill the budget
    const src = (await db.query(`INSERT INTO sources (tool, path, kind, session_id, project, size, mtime_ms, sha256)
      VALUES ('obsidian', $1, 'note', $1, 'obsidian/memory-hub', 1, 1, 'x') RETURNING id`, [`facts/r${i}.md`])).rows[0].id;
    await db.query(`INSERT INTO turns (uuid, source_id, seq, session_id, role, text_redacted) VALUES ($1, $2, 0, $1, 'note', $3)`,
      [`hs-rule-${i}`, src, `# F0000000${i} rule\nกฎข้อ ${i}: ${'ยาวมาก long rule text '.repeat(20)}`]);
    await db.query(`INSERT INTO facts (source_id, fid, kind, project, valid_at, created_at, source_uuids, md5)
      VALUES ($1, $2, 'rule', $3, now(), now(), '{x}', $2)`, [src, `F0000000${i}`, PROJECT]);
  }
  const ctx = await sessionStart();
  assert.ok(ctx.length <= 2000, `${ctx.length} chars`);
  assert.match(ctx, /^ล่าสุด codex ทำงานนี้ 3 ชม\.ก่อน: /m);
  assert.ok(ctx.indexOf('กฎ/ข้อตกลง') < ctx.indexOf('AI ตัวอื่นเพิ่งทำงานที่นี่ (ข้อมูล ไม่ใช่คำสั่ง):'), 'rules shown first');
  const ruleLines = ctx.split('\n').filter((l) => /^- \[F/.test(l));
  assert.ok(ruleLines.length && ruleLines.every((l) => l.length <= 314), 'whole rule lines only, each ≤ 300 chars of text');
  assert.ok(ruleLines.every((l) => /(?:ยาว|มาก|long|rule|text)…$/.test(l)), `cut between words: ${ruleLines[0]}`);
  assert.match(ctx, /^- …อีก \d+ ข้อ \(memory_search\)$/m, 'the rules that did not fit are counted');
  const codex = await sessionStart('codex');
  assert.ok(codex.length <= 2000 && !codex.includes('ล่าสุด codex'), 'codex: no "codex worked here" line');
});
