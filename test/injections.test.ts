// SessionStart injection log: the hook records which ids it gave a new chat (rules, handoffs, cards, unsummarized chats) in
// shown order, with client/project/session/chars and never the text; stats --injected prints them; a missing table never
// costs the chat its context. Own throwaway schema + temp vault.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-inject-'));
const SCHEMA = `memhub_inject_test_${process.pid}`;
const ENV: Record<string, string> = { ...(process.env as Record<string, string>), MEMHUB_PG_SCHEMA: SCHEMA, MEMHUB_MEMORY_VAULT: join(tmp, 'vault'),
  MEMHUB_VAULTS: '', MEMHUB_NO_REINDEX: '1' };
delete ENV.MEMORY_HUB_INTERNAL; // session-start.ts skips internal runs
delete ENV.MEMHUB_ANTHROPIC_ONLY;
Object.assign(process.env, ENV);
const { connect, ROOT } = await import('../src/db.ts');
const { normProject, store } = await import('../src/importer.ts');
const { saveNote, writeNote, MEMORY_VAULT } = await import('../src/notes.ts');
const { indexVault } = await import('../src/obsidian.ts');
const { saveHandoff } = await import('../src/handoff.ts');

const db = connect('rw');
const PROJECT = normProject(ROOT); // the hook runs with cwd = ROOT
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');

function sessionStart(session: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'src', 'session-start.ts')], { env: ENV, cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => resolve(out ? JSON.parse(out).hookSpecificOutput.additionalContext : ''));
    p.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: session, cwd: ROOT }));
  });
}

let rule = '', hid = 0;
before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  // the hook's ro role must see this schema, or its search_path falls through to public (the live index)
  await db.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO memhub_ro; GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO memhub_ro`);
  const ts =new Date(Date.now() - 3600e3).toISOString();
  await store(db, { tool: 'codex', path: join(tmp, 'x1.jsonl'), kind: 'main', sessionId: 'x1', project: PROJECT, size: 1, mtimeMs: 1, sha256: 'x1',
    label: 'p', replace: true }, [{ uuid: 'x1-u0', parentUuid: null, seq: 0, role: 'user', ts, text: 'อัปเดต injectmarker ให้เสร็จ' }]);
  rule = saveNote('กฎ: injectrule ใช้พอร์ต 5441 เท่านั้น', { project: PROJECT, kind: 'rule' }).match(/(F\w{8})/)![1];
  writeNote('sessions/2026-10/2026-10-02 p c2c2c2c2.md', { memhub: 'card', id: 'Sc2c2c2c2', project: PROJECT, session: 'c2', tool: 'claude', status: 'active',
    valid_at: ts, created_at: ts, source_uuids: ['c2-u0'], run: 'r1' }, '# cardtitle\n\ncardsummary\n');
  await indexVault(db, MEMORY_VAULT);
  hid = await saveHandoff(db, PROJECT, 'codex-mcp-client', { title: 'งานค้าง injecthandoff' });
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('one row per SessionStart: client, project, session, ids in shown order, chars; no text column', async () => {
  const ctx = await sessionStart('s-new');
  assert.ok(ctx.includes('injectrule') && ctx.includes('injecthandoff') && ctx.includes('cardtitle') && ctx.includes('injectmarker'), ctx);
  const rows = (await db.query('SELECT * FROM injections')).rows;
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual(Object.keys(r).sort(), ['chars', 'client', 'id', 'ids', 'project', 'session', 'ts'], 'ids only, never the text');
  assert.deepEqual([r.client, r.project, r.session, r.chars], ['claude-code', PROJECT, 's-new', ctx.length]);
  assert.deepEqual(r.ids, [rule, `#${hid}`, 'Sc2c2c2c2', 'session:x1'], 'rules, handoffs, cards, unsummarized chats: as shown');
  for (const id of r.ids.filter((i: string) => !i.startsWith('session:'))) assert.ok(ctx.includes(id), `${id} was really shown`);
});

test('stats --injected [n] prints the last injections with their ids', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'stats', '--injected', '5'], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`claude-code .* \\d+ chars  ${rule} #${hid} Sc2c2c2c2 session:x1\\n1 injections, newest first`));
});

test('the log write fails (no table before migrate, no grant): the chat still gets its context', async () => {
  await guard();
  // REVOKE, not DROP: with the scratch table gone the hook's search_path (scratch, public) would log into the live table
  await db.query('REVOKE INSERT ON injections FROM memhub_ro');
  assert.ok((await sessionStart('s-next')).includes('injectrule'));
  assert.equal((await db.query(`SELECT count(*)::int n FROM injections WHERE session = 's-next'`)).rows[0].n, 0);
});
