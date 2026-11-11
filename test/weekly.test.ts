// Weekly review (src/weekly.ts): the request holds the week's visible cards and his rules, the answer is checked against it,
// accepted insights become notes of kind `insight` linked to their evidence chats. Throwaway schema + temp vault, no LLM.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-weekly-'));
const SCHEMA = `memhub_weekly_test_${process.pid}`;
const ENV: Record<string, string> = { ...(process.env as Record<string, string>), MEMHUB_PG_SCHEMA: SCHEMA, MEMHUB_MEMORY_VAULT: join(tmp, 'vault'),
  MEMHUB_VAULTS: '', MEMHUB_NO_REINDEX: '1', MEMORY_HUB_INTERNAL: '1' };
Object.assign(process.env, ENV);
const { connect, ROOT } = await import('../src/db.ts');
const { store } = await import('../src/importer.ts');
const { md5, MEMORY_VAULT, parseNote, writeNote } = await import('../src/notes.ts');
const { indexVault } = await import('../src/obsidian.ts');
const { checkWeekly, saveWeekly, weeklyRequest, WEEKLY_MAX } = await import('../src/weekly.ts');

const db = connect('rw');
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing');
const NOW = new Date('2026-03-15T01:30:00+07:00');
const at = (daysAgo: number) => new Date(+NOW - daysAgo * 86400_000).toISOString();

/** One finished chat + the card the dream wrote for it. */
async function card(sid: string, project: string, daysAgo: number, title: string, o: { open?: string; decision?: string; hideAs?: string; status?: string } = {}) {
  await guard();
  await store(db, { tool: 'claude', path: join(tmp, 'raw', `${sid}.jsonl`), kind: 'main', sessionId: sid, project, size: 1, mtimeMs: 1, sha256: sid,
    label: project, replace: true, hideAs: o.hideAs }, [{ uuid: `${sid}-u0`, parentUuid: null, seq: 0, role: 'user', ts: at(daysAgo), text: `งาน ${title}` }]);
  const sec = (h: string, x?: string) => (x ? `\n## ${h}\n- ${x}\n` : '');
  writeNote(`sessions/2026-11/${sid}.md`, { memhub: 'card', id: `S${md5(sid).slice(0, 8)}`, project, session: sid, tool: 'claude', status: o.status ?? 'active',
    outcome: 'done', valid_at: at(daysAgo), created_at: at(daysAgo), source_uuids: [`${sid}-u0`], run: 'r1' },
    `# ${title}\n\nสรุป ${title}\n\n**Outcome:** done\n${sec('Decisions', o.decision)}${sec('Open', o.open)}${sec('Facts', '[[Fzzzzzzzz wkfactlink]]')}${sec('Files', '`src/wkfile.ts`')}\nproject:: [[demo]]\n`);
}
function rule(id: string, text: string, status = 'active') {
  writeNote(`facts/_global/${id} ${text.slice(0, 30)}.md`, { memhub: 'fact', id, kind: 'rule', scope: 'global', project: '', status, run: 'r1',
    source_uuids: ['wk1-u0'], md5: md5(text), valid_at: at(30), created_at: at(30) }, `${text}\n`);
}
const insight = (o: object = {}) => ({ type: 'repeat', title: 'ต้องย้ำเรื่อง wkpattern ซ้ำ', text: 'ลุงจืดต้องบอกเรื่องเดิมใน wkalpha และ wkbeta', rule: 'ทำ wkpattern ทุกครั้ง', cards: ['C1', 'C3'], ...o });

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  await db.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO memhub_ro; GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO memhub_ro`);
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('a quiet week (fewer than 5 cards) asks nothing', async () => {
  for (const [i, d] of [6, 5, 4, 3].entries()) await card(`wk${i + 1}`, i % 2 ? 'd:/wkbeta' : 'd:/wkalpha', d, `wktitle${i + 1}`, i === 0 ? { open: 'wkopenitem ยังไม่ได้ทำ', decision: 'wkdecision ใช้ทางแรก' } : {});
  await indexVault(db, MEMORY_VAULT);
  assert.equal(await weeklyRequest(db, { now: NOW }), null);
});

test('the request: the week\'s visible active cards oldest first with their decisions and open items, his active rules; nothing older, hidden or retired', async () => {
  await card('wk5', 'd:/wkalpha', 2, 'wktitle5');
  await card('wk6', 'd:/wkgamma', 1, 'wktitle6');
  await card('wkold', 'd:/wkalpha', 8, 'wktitleold');                           // before the week
  await card('wkhid', 'd:/wkalpha', 2, 'wktitlehidden', { hideAs: 'google' });  // a Claude-only chat: an insight note would show it to every app
  await card('wkgone', 'd:/wkalpha', 2, 'wktitlegone', { status: 'superseded' });
  rule('F0000wk1', 'wkrule ตอบภาษาไทยเสมอ');
  rule('F0000wk2', 'wkruleold เลิกใช้แล้ว', 'superseded');
  await indexVault(db, MEMORY_VAULT);
  const req = (await weeklyRequest(db, { now: NOW }))!;
  assert.deepEqual(Object.keys(req.cards), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
  assert.deepEqual(Object.values(req.cards).map((c) => c.note), ['wk1', 'wk2', 'wk3', 'wk4', 'wk5', 'wk6']);
  assert.equal(req.cards.C1.uuid, 'wk1-u0');
  assert.match(req.user, /^Week: 2026-03-08 to 2026-03-15 \(Asia\/Bangkok\)\. 6 session cards, 3 projects\./);
  assert.match(req.user, /C1 \[2026-03-09, wkalpha\]\n# wktitle1\n\nสรุป wktitle1[^]*## Decisions\n- wkdecision ใช้ทางแรก\n\n## Open\n- wkopenitem ยังไม่ได้ทำ\n\nC2 \[2026-03-10, wkbeta\]/);
  assert.match(req.user, /R1 \[global\]: wkrule ตอบภาษาไทยเสมอ/);
  for (const absent of ['wktitleold', 'wktitlehidden', 'wktitlegone', 'wkruleold', 'wkfactlink', 'wkfile.ts', 'project::'])
    assert.ok(!req.user.includes(absent), absent);
  assert.equal(req.run, '2026-03-15-weekly');
  assert.equal((await weeklyRequest(db, { now: NOW }))!.id, req.id, 'same week, same request id');
  assert.match(req.system, /at most 3 insights/);
  assert.equal((req.schema as { properties: { insights: { maxItems: number } } }).properties.insights.maxItems, WEEKLY_MAX);
});

test('an answer is refused for: more than 3 insights, an id not in the request, a pattern seen in one chat, two insights with one title', async () => {
  const req = (await weeklyRequest(db, { now: NOW }))!;
  assert.deepEqual(checkWeekly(req, { insights: [] }), [], 'nothing found is a valid answer');
  assert.deepEqual(checkWeekly(req, { insights: [insight(), insight({ type: 'open', title: 'งานค้าง wkopen', rule: undefined, cards: ['C1'] })] }), []);
  assert.equal(checkWeekly(req, { insights: [1, 2, 3, 4].map((i) => insight({ title: `t${i}` })) }).length, 1);
  assert.match(checkWeekly(req, { insights: [insight({ cards: ['C1', 'C99'] })] })[0], /not in the request: C99/);
  assert.match(checkWeekly(req, { insights: [insight({ cards: ['C1', 'C1'] })] })[0], /two or more different cards/);
  assert.match(checkWeekly(req, { insights: [insight({ type: 'conflict', cards: ['C2'] })] })[0], /two or more different cards/);
  assert.match(checkWeekly(req, { insights: [insight(), insight({ cards: ['C2', 'C4'] })] })[0], /same as an earlier insight/);
  assert.match(checkWeekly(req, { insights: [insight({ text: 'path D:\books' })] })[0], /control character/);
  assert.match(checkWeekly(req, { sessions: [] })[0], /insights/);
});

test('saving: a refused answer writes nothing; an accepted one becomes insight notes linked to their evidence chats, once', async () => {
  const req = (await weeklyRequest(db, { now: NOW }))!;
  const dir = join(MEMORY_VAULT, 'insights');
  await assert.rejects(() => saveWeekly(db, req, { insights: [insight(), insight({ cards: ['C9', 'C1'], title: 'x' })] }, NOW), /answer rejected:\ninsights\.1\.cards/);
  assert.ok(!existsSync(dir), 'the valid first insight of a refused answer is not written either');
  const answer = { insights: [insight(), insight({ type: 'open', title: 'งานค้าง: wkopenitem', text: 'wkalpha ค้าง wkopenitem ตั้งแต่ 2026-11-09', rule: null, cards: ['C1'] })] };
  const out = await saveWeekly(db, req, answer, NOW);
  assert.deepEqual(out.map((x) => x.type), ['repeat', 'open']);
  await saveWeekly(db, req, answer, NOW); // a retry of the same answer
  assert.equal(readdirSync(dir).length, 2);
  const { fm, body } = parseNote(readFileSync(join(MEMORY_VAULT, out[0].rel), 'utf8'));
  assert.equal(fm.memhub, 'insight');
  assert.equal(fm.insight, 'repeat');
  assert.equal(body, 'ลุงจืดต้องบอกเรื่องเดิมใน wkalpha และ wkbeta\nเสนอกฎ: ทำ wkpattern ทุกครั้ง\n\n- from:: [[wk1]]\n- from:: [[wk3]]\n');
  const rows = (await db.query(`SELECT f.fid, f.kind, f.scope, f.session_ids, f.user_owned, s.status FROM facts f JOIN sources s ON s.id = f.source_id WHERE f.kind = 'insight' ORDER BY s.path`)).rows;
  assert.equal(rows.length, 2);
  const repeat = rows.find((r) => r.fid === fm.id)!;
  assert.deepEqual([repeat.scope, repeat.status, repeat.user_owned, [...repeat.session_ids].sort()], ['global', 'active', false, ['wk1', 'wk3']]);
  assert.deepEqual((await db.query(`SELECT v->>'run' run, v->>'insights' n FROM state WHERE k = 'weekly:last'`)).rows[0], { run: '2026-03-15-weekly', n: '2' });
});

test('the script: digest writes the request file and says pending; save checks the answer; the same run is then done', async () => {
  const script = join(ROOT, 'scripts', 'weekly.ts');
  const run = (...a: string[]) => spawnSync(process.execPath, ['--no-warnings', script, ...a], { encoding: 'utf8', env: ENV, cwd: ROOT });
  // the script reads the clock: six cards in its last hour, asked for with a 72-minute window (the cards above are months old)
  for (let i = 1; i <= 6; i++) {
    await store(db, { tool: 'claude', path: join(tmp, 'raw', `wn${i}.jsonl`), kind: 'main', sessionId: `wn${i}`, project: 'd:/wkalpha', size: 1, mtimeMs: 1, sha256: `wn${i}`,
      label: 'p', replace: true }, [{ uuid: `wn${i}-u0`, parentUuid: null, seq: 0, role: 'user', ts: new Date(Date.now() - i * 600e3).toISOString(), text: 'งาน' }]);
    writeNote(`sessions/now/wn${i}.md`, { memhub: 'card', id: `S${md5(`wn${i}`).slice(0, 8)}`, project: 'd:/wkalpha', session: `wn${i}`, status: 'active',
      valid_at: new Date(Date.now() - i * 600e3).toISOString(), created_at: new Date().toISOString(), source_uuids: [`wn${i}-u0`], run: 'r1' }, `# wnowtitle${i}\n\nสรุป\n`);
  }
  await indexVault(db, MEMORY_VAULT);
  const RUN = `wk-script-${process.pid}`, dirRel = `tmp/weekly/${RUN}`;
  try {
    const d = JSON.parse(run('digest', '--run', RUN, '--days', '0.05').stdout);
    assert.deepEqual([d.status, d.cards, d.run], ['pending', 6, RUN]);
    assert.ok(d.request.startsWith(`${dirRel}/W-`) && existsSync(join(ROOT, d.request)));
    const ans = join(tmp, 'ans.json');
    writeFileSync(ans, JSON.stringify({ insights: [insight({ cards: ['C1'] })] }));
    const bad = run('save', d.request, ans);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /two or more different cards/);
    writeFileSync(ans, JSON.stringify({ insights: [insight({ title: 'wkscript insight', cards: ['C1', 'C2'] })] }));
    const ok = run('save', d.request, ans);
    assert.match(ok.stdout, /^ok → 1 insight\(s\)\nrepeat \| wkscript insight \| insights\//);
    assert.deepEqual(JSON.parse(run('digest', '--run', RUN, '--days', '0.05').stdout), { run: RUN, status: 'done', insights: 1 });
  } finally { rmSync(join(ROOT, dirRel), { recursive: true, force: true }); }
});
