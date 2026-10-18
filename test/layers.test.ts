// What memory_search tells the calling AI (ลุงจืด 2026-10-18): ✓ใช้ได้ / บันทึก / ✗เลิกใช้ in that order, conflicts > 7 days
// apart, a fact saying X เลิกใช้, ops queries + index tags, command lines a snippet keeps whole, Thai dates. Own throwaway
// schema + temp vault, keyword-only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-layers-'));
const SCHEMA = `memhub_layers_test_${process.pid}`;
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMHUB_MEMORY_VAULT = join(tmp, 'vault');
process.env.MEMHUB_VAULTS = '';
process.env.MEMHUB_NO_REINDEX = '1';
process.env.MEMORY_HUB_INTERNAL = '1';
const { connect, ROOT } = await import('../src/db.ts');
const { indexFile } = await import('../src/importer.ts');
const { writeNote, md5, saveNote, MEMORY_VAULT } = await import('../src/notes.ts');
const { indexVault } = await import('../src/obsidian.ts');
const { search, hitLine, snippet, day, deprecatedNames } = await import('../src/search.ts');
const { hitText, briefLine, nowLine } = await import('../src/mcp.ts');
const { flagsFor } = await import('../src/accuracy.ts');
const { toTsvector, words } = await import('../src/thai.ts');

const db = connect('rw');
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');
const P = 'd:/laytest';
const fact = (fid: string, text: string, at: string, extra: Record<string, string | string[]> = {}) => writeNote(`facts/laytest/${fid}.md`, {
  memhub: 'fact', id: fid, kind: 'fact', scope: 'project', project: P, status: 'active', importance: '5',
  valid_at: at, created_at: at, source_uuids: [`${fid}-src`], md5: md5(text), run: 'r1', ...extra,
}, `${text}\n`);
/** One chat: his line, then the AI's reply with Bash tool calls (claude.ts renders them as "[Bash] run $ <command>"). */
const chat = async (id: string, text: string, o: { ts?: string; cwd?: string; bash?: string[] } = {}) => {
  const row = (type: string, uuid: string, content: unknown) => JSON.stringify({ type, uuid, sessionId: id, timestamp: o.ts ?? '2026-09-20T00:00:00Z',
    cwd: o.cwd ?? 'D:\\laytest', message: { role: type, content } }) + '\n';
  const tools = (o.bash ?? []).map((command, i) => ({ type: 'tool_use', id: `${id}-t${i}`, name: 'Bash', input: { command, description: 'run' } }));
  writeFileSync(join(tmp, 'proj', `${id}.jsonl`), row('user', `${id}-u1`, text) + row('assistant', `${id}-u2`, [{ type: 'text', text: 'ok' }, ...tools]));
  await guard();
  await indexFile(db, join(tmp, 'proj', `${id}.jsonl`));
};
const conflict = async (a: string, b: string, on: string) => {
  for (const [x, y] of [[a, b], [b, a]]) await db.query(`INSERT INTO state (k, v) VALUES ($1, $2)`, [`conflict:${x}`, { with: [y], on: [on] }]);
};
const find = async (q: string, o: Record<string, unknown> = {}) => (await search(db, q, { semantic: false, currentProject: P, limit: 6, ...o })).hits;
const key = (h: any) => h.fid && h.kind !== 'card' ? h.fid : h.session_id;

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  mkdirSync(join(tmp, 'proj'), { recursive: true });
  // layers: 14 chats match both terms, the fact one → on score it sits in the curated slot (#2), not first
  for (let i = 0; i < 14; i++) await chat(`h${i}`, `heronport heronlog ${i}`);
  fact('Fh0000001', 'heronport note', '2026-09-20T00:00:00Z');
  // an OLD fact, its replacement, and a chat
  fact('Fo0000001', 'otterport 7001', '2026-09-01T00:00:00Z', { status: 'superseded', superseded_by: 'Fo0000002' });
  fact('Fo0000002', 'otterport 7002 now', '2026-09-20T00:00:00Z');
  await chat('o1', 'otterport ตั้งไว้ก่อน');
  // conflicts: newer side his (memory_save: obs: uuids only) 19 days later / AI-only 19 days later / his but 1 day later
  fact('Fk0000001', 'kitepay ใช้ stripe เป็นหลัก', '2026-09-01T00:00:00Z');
  fact('Fk0000002', 'kitepay ไม่ใช้ stripe แล้ว', '2026-09-20T00:00:00Z', { source_uuids: ['obs:k2'] });
  fact('Fk0000003', 'kiteship ใช้ dhlexpress ส่งของ', '2026-09-01T00:00:00Z');
  fact('Fk0000004', 'kiteship ไม่ใช้ dhlexpress แล้ว', '2026-09-20T00:00:00Z');
  fact('Fk0000005', 'kitemail ใช้ smtprelay', '2026-09-19T00:00:00Z');
  fact('Fk0000006', 'kitemail ไม่ใช้ smtprelay', '2026-09-20T00:00:00Z', { source_uuids: ['obs:k6'] });
  // 7 days and 33 minutes apart (live: F84e8d0eb vs F00bf0c33): over 7 days, though it rounds to 7
  fact('Fk0000007', 'kitesync ใช้ gemmalocal', '2026-10-11T01:05:00Z');
  fact('Fk0000008', 'kitesync ไม่ใช้ gemmalocal', '2026-10-18T01:38:00Z', { source_uuids: ['obs:k8'] });
  // deprecation: his rule says a domain is no longer used; an AI-only fact says a cache is
  fact('Fz0000001', 'zebrasite: โดเมน oldzebra.app เลิกใช้แล้ว ให้ใช้ newzebra.app เสมอ', '2026-09-20T00:00:00Z', { kind: 'rule', source_uuids: ['obs:z1'] });
  fact('Fz0000002', 'zebrasite: เลิกใช้ cache.grizzly.io แล้ว', '2026-09-20T00:00:00Z');
  await chat('z-old', 'zebrasite เปิดเว็บ oldzebra.app ได้แล้ว', { ts: '2026-09-10T00:00:00Z' });
  await chat('z-other', 'zebrasite oldzebra ตั้งค่า log เสร็จ', { ts: '2026-09-10T00:00:00Z' });
  await chat('z-new', 'zebrasite redirect oldzebra.app ไป newzebra.app แล้ว', { ts: '2026-09-25T00:00:00Z' });
  await chat('z-cache', 'zebrasite ใช้ cache.grizzly.io อยู่', { ts: '2026-09-10T00:00:00Z' });
  // ops: the real deploy ran scp + systemctl restart and never says "deploy"; a chat only talks; a README repo names both words
  await chat('ops1', 'ospreyapp อัปเดตเวอร์ชันใหม่ขึ้นเครื่อง', { bash: ['scp ospreyapp root@10.0.0.9:/opt/ospreyapp', 'ssh root@10.0.0.9 "systemctl restart ospreyapp"'] });
  await chat('ops2', 'ospreyapp ยังไม่ได้ทำอะไร คุยเฉยๆ');
  const gh = Number((await db.query(`INSERT INTO sources (tool, path, kind, session_id, project, size, mtime_ms, sha256)
    VALUES ('github', 'gh/ospreyapp.json', 'doc', 'github:o/ospreyapp', $1, 0, 0, '') RETURNING id`, [P])).rows[0].id);
  const readme = 'D: [repo o/ospreyapp] ospreyapp deploy server README';
  await db.query(`INSERT INTO turns (uuid, source_id, seq, session_id, role, ts, project, text_redacted) VALUES ('gh-1', $1, 0, 'github:o/ospreyapp', 'note', '2026-09-20', $2, $3)`, [gh, P, readme]);
  await db.query(`INSERT INTO chunks (id, source_id, turn_uuid, seq_from, seq_to, session_id, project, ts, ctx_header, text, words, bigrams, chunker_ver)
    VALUES ('ab00000000000001', $1, 'gh-1', 0, 0, 'github:o/ospreyapp', $2, '2026-09-20', '', $3, $4::tsvector, ''::tsvector, 't')`, [gh, P, readme, toTsvector(words(readme))]);
  // a global fact (saved by an app that sent no project) naming the project vs 8 chats in it
  for (let i = 0; i < 8; i++) await chat(`pel${i}`, `pelicanapp ขั้นตอน ${i}`, { cwd: 'D:\\pelicanapp' });
  writeNote('facts/_global/Fg0000001.md', { memhub: 'fact', id: 'Fg0000001', kind: 'fact', scope: 'global', project: '', status: 'active', importance: '5',
    valid_at: '2026-09-20T00:00:00Z', created_at: '2026-09-20T00:00:00Z', source_uuids: ['Fg0000001-src'], md5: md5('g'), run: 'r1' }, 'pelicanapp ขั้นตอน ปล่อยงาน\n');
  // a fact long enough for 2 chunks, the query word in both
  fact('Fq0000001', `quailport ขั้นแรก ${'build step detail '.repeat(70)}\n\nquailport ขั้นสอง ${'upload step detail '.repeat(70)}`, '2026-09-20T00:00:00Z');
  await chat('q1', 'quailport chat');
  await guard();
  await indexVault(db, MEMORY_VAULT);
  await conflict('Fk0000001', 'Fk0000002', 'stripe');
  await conflict('Fk0000003', 'Fk0000004', 'dhlexpress');
  await conflict('Fk0000005', 'Fk0000006', 'smtprelay');
  await conflict('Fk0000007', 'Fk0000008', 'gemmalocal');
});

after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('layers: ✓ใช้ได้ facts first, บันทึก chats next, ✗เลิกใช้ last; a question about the past keeps the score order', async () => {
  const h = await find('heronport heronlog');
  assert.equal(key(h[0]), 'Fh0000001');
  assert.deepEqual(h.map((x) => x.layer), ['use', 'memo', 'memo', 'memo', 'memo', 'memo']);
  assert.match(hitLine(h[0]), /\| ✓ใช้ได้ fact\b/);
  assert.doesNotMatch(hitLine(h[0]), / cur\b/);
  assert.match(hitLine(h[1]), /\| บันทึก chat\b/);
  const past = await find('เคย heronport heronlog');
  assert.equal(key(past[1]), 'Fh0000001', 'history: the curated slot (#2), as before');
  assert.equal(past[0].layer, 'memo', 'labels stay');
  const o = await find('otterport');
  assert.deepEqual(o.map(key), ['Fo0000002', 'o1', 'Fo0000001']);
  assert.deepEqual(o.map((x) => x.layer), ['use', 'memo', 'old']);
  assert.match(hitLine(o[2]), /\| ✗เลิกใช้ fact OLD -> \[Fo0000002\]/);
  assert.match(briefLine(o[0], 'otterport', new Map()), /✓ใช้ได้/);
});

test('conflict > 7 days: the older side → ✗เลิกใช้ only when the newer side is his words; AI-only or 1 day apart → dates only', async () => {
  const k = await find('kitepay stripe');
  assert.deepEqual(k.map(key), ['Fk0000002', 'Fk0000001']);
  assert.deepEqual(k.map((x) => x.layer), ['use', 'old']);
  assert.match(hitLine(k[1]), /น่าจะเลิกใช้: \[Fk0000002\] 2026-09-20 ใหม่กว่า 19 วัน \(คำลุงจืด\) ขัดกันเรื่อง stripe/);
  const s = await find('kiteship dhlexpress');
  assert.deepEqual(s.map((x) => x.layer), ['use', 'use']);
  const older = s.find((x) => x.fid === 'Fk0000003')!;
  assert.match(hitLine(older), /ขัดกับ \[Fk0000004\] 2026-09-20 ที่ใหม่กว่า 19 วัน แต่เป็น AI-only: ยังใช้ได้ ถามลุงจืดก่อนเลือก/);
  const f = await flagsFor(db, [{ key: 'x', fid: 'Fk0000003', ts: older.ts }], []);
  assert.match(f.get('x')!.tags[0], /⚠CONFLICT ↔ \[Fk0000004\] \(dhlexpress\) · อันนี้ 2026-09-01 · \[Fk0000004\] 2026-09-20 ใหม่กว่า/);
  const m = await find('kitemail smtprelay');
  assert.deepEqual(m.map((x) => x.layer), ['use', 'use']);
  assert.ok(m.every((x) => !x.why), 'same week: no verdict');
  const g = await find('kitesync gemmalocal');
  assert.deepEqual(g.map(key), ['Fk0000008', 'Fk0000007']);
  assert.equal(g[1].layer, 'old', '7 d 33 min > 7 days');
});

test('deprecation: an older hit naming what a current fact of his says เลิกใช้ → ✗เลิกใช้; an AI-only one only warns', async () => {
  assert.deepEqual(deprecatedNames('zebrasite: โดเมน oldzebra.app เลิกใช้แล้ว ให้ใช้ newzebra.app เสมอ'), ['oldzebra.app']);
  assert.deepEqual(deprecatedNames('เลิกใช้ cache.grizzly.io แล้ว'), ['cache.grizzly.io']);
  assert.deepEqual(deprecatedNames('ใช้ pnpm.example แทน yarn.example ทุกที่'), ['yarn.example']);
  assert.deepEqual(deprecatedNames('ไม่ใช้ webpackx.dev แล้ว\nส่วน vitebuild.dev ยังใช้'), ['webpackx.dev']);
  assert.deepEqual(deprecatedNames('ไม่ใช้ 10.0.0.9:8080 แล้ว'), ['10.0.0.9:8080']);
  // a plain word names too much (one project's "เลิกใช้ mongodb" would ✗ every older hit naming it): not read
  assert.deepEqual(deprecatedNames('เลิกใช้ mongodb แล้ว ใช้ codex แทน claude, ปรับ 0.85 แทน'), []);
  const z = await find('zebrasite oldzebra.app', { limit: 8 });
  const by = (k: string) => z.find((x) => key(x) === k)!;
  assert.equal(key(z[0]), 'Fz0000001');
  assert.equal(by('z-old').layer, 'old');
  assert.match(hitLine(by('z-old')), /น่าจะเลิกใช้: \[Fz0000001\] 2026-09-20 บอกว่า oldzebra\.app เลิกใช้แล้ว/);
  assert.equal(by('z-other').layer, 'memo', 'does not name it');
  assert.equal(by('z-new').layer, 'memo', 'after the rule');
  assert.equal(z.at(-1)!.layer, 'old');
  const c = await find('zebrasite cache.grizzly.io');
  const cache = c.find((x) => key(x) === 'z-cache')!;
  assert.equal(cache.layer, 'memo');
  assert.match(hitLine(cache), /ตรวจก่อนใช้: \[Fz0000002\] 2026-09-20 \(AI-only\) บอกว่า cache\.grizzly\.io เลิกใช้แล้ว/);
});

test('ops: "deploy" finds the chat that ran scp + systemctl restart (index tags) above a README repo', async () => {
  assert.equal((await db.query(`SELECT count(*)::int n FROM chunks WHERE session_id = 'ops1' AND words @@ 'deploy & service'::tsquery`)).rows[0].n, 1);
  assert.equal((await db.query(`SELECT count(*)::int n FROM chunks WHERE session_id = 'ops2' AND words @@ 'deploy'::tsquery`)).rows[0].n, 0);
  const h = await find('deploy ospreyapp');
  const at = (k: string) => h.findIndex((x) => key(x) === k);
  assert.ok(at('ops1') >= 0, JSON.stringify(h.map(key)));
  assert.ok(at('ops1') < at('github:o/ospreyapp'), JSON.stringify(h.map(key)));
});

test('a global fact naming the current project ranks like one of it (saved by an app that sent no project)', async () => {
  const h = await find('pelicanapp ขั้นตอน', { currentProject: 'd:/pelicanapp' });
  assert.equal(key(h[0]), 'Fg0000001', JSON.stringify(h.map(key)));
  assert.equal(h[0].layer, 'use');
});

test('snippet keeps a whole command line (≤ 350 chars) around the match, in [shell]/[Bash] lines and ``` blocks', () => {
  const cmd = 'A: [shell] ssh root@10.0.0.9 "cd /opt/app && tar -xzf app.tgz && rm -f app.tgz && systemctl restart app-api app-web && systemctl is-active app-api app-web"';
  const text = `A: ${'ข้อความนำ filler '.repeat(30)}\n${cmd}\nU: ${'ต่อท้าย more words '.repeat(30)}`;
  const h: any = { id: 'abc', ts: new Date('2026-09-20'), project: P, session_id: 's', text, score: 1, status: null, fid: null, kind: null,
    fact_project: null, superseded_by: null, changed_to: null, src_kind: 'main', tool: 'codex', uses: 0, last: null };
  for (const max of [400, 200]) assert.ok(hitText(h, 'tar systemctl', max).includes(cmd), `max ${max}: ${hitText(h, 'tar systemctl', max)}`);
  assert.ok(snippet(text, 'systemctl', 200).includes(cmd));
  const bash = `A: [Bash] run $ ${'x'.repeat(200)} kubectl rollout restart deploy/app ${'y'.repeat(200)}`; // 400+ chars: cut as before
  assert.ok(!snippet(`${'filler '.repeat(40)}\n${bash}\n${'tail '.repeat(40)}`, 'kubectl', 200).includes(bash));
  const fenced = `${'อธิบาย '.repeat(40)}\n\`\`\`\nsudo nginx -t && sudo nginx -s reload && curl -sf https://example.test/health\n\`\`\`\n${'ท้าย '.repeat(40)}`;
  assert.ok(snippet(fenced, 'reload', 120).includes('sudo nginx -t && sudo nginx -s reload && curl -sf https://example.test/health'));
  // another command at the window's edge: dropped whole, never its first half (it would read as a complete command)
  const next = 'A: [shell] ssh root@10.0.0.9 "systemctl cat app-web; ls -la /opt/app/web"';
  const edge = snippet(`A: anchorword ${'pad '.repeat(30)}\n${next}\nU: ${'tail '.repeat(40)}`, 'anchorword', 150);
  assert.ok(!edge.includes('[shell]') || edge.includes(next), edge);
});

test('a fact split into 2 chunks takes one slot (memory_get prints it whole)', async () => {
  const h = await find('quailport');
  assert.equal(h.filter((x) => x.fid === 'Fq0000001').length, 1, JSON.stringify(h.map(key)));
});

test('dates for the AI: Thai calendar day, and the reply says what now is', () => {
  assert.equal(day(new Date('2026-10-17T20:00:00Z')), '2026-10-18');
  assert.equal(nowLine(new Date('2026-10-18T10:30:00Z')), 'ตอนนี้ 2026-10-18 17:30 (เวลาไทย)');
});

test('memory_save without a project is global even when global:false (no project-scoped fact without a project)', () => {
  const rel = saveNote('laytest note with no project', { global: false });
  assert.match(rel, /^facts\/_global\//);
  assert.match(readFileSync(join(MEMORY_VAULT, rel), 'utf8'), /^scope: global$/m);
});

test('nightly review: a conflict pair > 7 days apart names the newer side and suggests the supersede', async () => {
  await (await import('../src/dream.ts')).consolidate(db);
  const review = readFileSync(join(MEMORY_VAULT, 'hubs', '_review.md'), 'utf8');
  assert.match(review, /- \[\[Fk0000001\]\] ↔ \[\[Fk0000002\]\] · stripe → \[\[Fk0000002\]\] ใหม่กว่า 19 วัน: ถ้าข้อใหม่ถูก ให้ supersede ข้อเก่า \(memory_save replaces:\[Fk0000001\]\)/, review);
  assert.match(review, /- \[\[Fk0000005\]\] ↔ \[\[Fk0000006\]\] · smtprelay\n/, 'same week: no suggestion');
  assert.match(review, /- \[\[Fk0000007\]\] ↔ \[\[Fk0000008\]\] · gemmalocal → \[\[Fk0000008\]\] ใหม่กว่า 7 วัน: /, '7 d 33 min: over 7 days');
});
