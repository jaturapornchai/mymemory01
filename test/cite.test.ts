// Citations (search.ts origins/originText, mcp.ts searchText/briefLine): every hit names where it came from — app:session#turn,
// a GitHub ref, a note path; a fact its preferred cited turn (his words first, then the earliest), ×N sessions, AI-only.
// Looked up after ranking; hidden and Claude-only sources are never cited. Own throwaway schema per run, fixtures inserted directly.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = `memhub_cite_test_${process.pid}`;
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMORY_HUB_INTERNAL = '1';
const { connect, ROOT } = await import('../src/db.ts');
const { PRIVATE_TOOLS } = await import('../src/guard.ts');
const { origins, originText, hitLine } = await import('../src/search.ts');
const { searchText, briefLine, BRIEF_LINE, text } = await import('../src/mcp.ts');

const db = connect('rw');
const HIDE = [...PRIVATE_TOOLS];
const T = Date.parse('2026-09-20T00:00:00Z'), H = 3600e3;
let n = 0;
const C: Record<string, string> = {}; // name → chunk id

/** One source with turns (role, seq, uuid) and a chunk over [from, to]. */
async function src(name: string, tool: string, kind: string, session: string, path: string, turns: [string, number, string][], from = 0, o: { hide_as?: string; at?: number } = {}) {
  const id = Number((await db.query(`INSERT INTO sources (tool, path, kind, session_id, project, size, mtime_ms, sha256, hide_as)
    VALUES ($1, $2, $3, $4, 'd:/p', 0, 0, '', $5) RETURNING id`, [tool, path, kind, session, o.hide_as ?? null])).rows[0].id);
  for (const [role, seq, uuid] of turns) await db.query(`INSERT INTO turns (uuid, source_id, seq, session_id, role, ts, project, text_redacted)
    VALUES ($1, $2, $3, $4, $5, $6, 'd:/p', $7)`, [uuid, id, seq, session, role, new Date((o.at ?? T) + seq * 60e3), `${name} ${seq}`]);
  const chunk = (++n).toString(16).padStart(16, 'c');
  await db.query(`INSERT INTO chunks (id, source_id, turn_uuid, seq_from, seq_to, session_id, project, ts, ctx_header, text, words, bigrams, chunker_ver)
    VALUES ($1, $2, $3, $4, $4, $5, 'd:/p', $6, '', $7, ''::tsvector, ''::tsvector, 't')`, [chunk, id, turns.find((t) => t[1] === from)?.[2] ?? turns[0][2], from, session, new Date(o.at ?? T), name]);
  C[name] = chunk;
  return id;
}
const fact = (id: number, fid: string, uuids: string[]) => db.query(`INSERT INTO facts (source_id, fid, kind, valid_at, created_at, source_uuids, md5)
  VALUES ($1, $2, 'fact', now(), now(), $3, $2)`, [id, fid, uuids]);

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA);
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  const S1 = '11111111-2222-3333-4444-5555aaaabbbb', S2 = '99999999-8888-7777-6666-0000ccccdddd';
  await src('main', 'claude', 'main', S1, 'a/s1.jsonl', [['user', 3, 'm3'], ['assistant', 4, 'm4'], ['user', 7, 'm7']], 4);
  await src('main2', 'codex', 'main', S2, 'a/s2.jsonl', [['assistant', 2, 'n2']], 2, { at: T + 48 * H });
  await src('sub', 'claude', 'subagent', S1, 'a/S1/agent-a452e1a5cf23e915d.jsonl', [['user', 0, 'x0']]);
  await src('commit', 'github', 'doc', 'github:o/r:commits', 'g/commits.jsonl', [['note', 5, 'github:o/r@4f3a9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b']], 5);
  await src('issue', 'github', 'doc', 'github:o/r#12', 'g/12.json', [['note', 0, 'github:o/r#12']]);
  await src('note', 'obsidian', 'note', 'vault-a/decisions/2026-09-01-ledger.md', 'v/x.md', [['note', 0, 'obs:n1']]);
  await src('gmail', 'google', 'doc', 'gmail:t1', 'g/t1', [['note', 0, 'gm0']]);
  await src('hid', 'claude', 'main', 'hidden-session-0000', 'a/h.jsonl', [['user', 1, 'h1']], 1, { hide_as: 'google' });
  // facts: f1 cites an AI turn of S2 and his + an AI turn of S1 → his earliest words (m3), ×2; f2 only AI turns; f3 = memory_save (own note);
  // f4 only a hidden chat → no source to show
  await fact(await src('f1', 'obsidian', 'note', 'memory-hub/facts/f1.md', 'v/f1.md', [['note', 0, 'obs:f1']]), 'F00000001', ['n2', 'm4', 'm3']);
  await fact(await src('f2', 'obsidian', 'note', 'memory-hub/facts/f2.md', 'v/f2.md', [['note', 0, 'obs:f2']]), 'F00000002', ['m4']);
  await fact(await src('f3', 'obsidian', 'note', 'memory-hub/facts/f3.md', 'v/f3.md', [['note', 0, 'obs:f3']]), 'F00000003', ['obs:f3']);
  await fact(await src('f4', 'obsidian', 'note', 'memory-hub/facts/f4.md', 'v/f4.md', [['note', 0, 'obs:f4']]), 'F00000004', ['h1']);
});
after(async () => { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await db.end(); });

test('origins: one tag per hit, from the chunk or (a fact) its cited turns', async () => {
  const o = await origins(db, Object.values(C), HIDE);
  const tag = (k: string) => o.get(C[k])?.tag;
  assert.equal(tag('main'), 'claude:aaaabbbb#4', 'main chat: app, last 8 of the session id, first turn of the chunk');
  assert.equal(tag('main2'), 'codex:ccccdddd#2');
  assert.equal(tag('sub'), 'claude/sub:f23e915d#0', 'a subagent shares the main session id: its own file names it');
  assert.equal(tag('commit'), 'github:o/r@4f3a9c1');
  assert.equal(tag('issue'), 'github:o/r#12');
  assert.equal(tag('note'), 'note:vault-a/decisions/2026-09-01-ledger.md');
  assert.equal(tag('gmail'), undefined, 'Claude-only: the private label is all a hit shows');
  assert.deepEqual(o.get(C.f1), { tag: 'claude:aaaabbbb#3', ts: new Date(T + 3 * 60e3), n: 2, ai: false }, 'his earliest words, 2 sessions');
  assert.equal(o.get(C.f2)?.ai, true, 'no turn of his among the cited ones');
  assert.equal(o.get(C.f3)?.tag, 'memory_save', 'he asked to remember it: the note is the source');
  assert.equal(o.get(C.f4), undefined, 'its only source is hidden from this caller');
  assert.equal((await origins(db, [C.f4], [])).get(C.f4)?.tag, 'claude:ion-0000#1', 'visible to a caller that may see it');
});

test('originText / hitLine / searchText: src after what, only when given; brief stays ≤ BRIEF_LINE', async () => {
  const o = await origins(db, [C.f1, C.f2, C.main], HIDE);
  assert.equal(originText(o.get(C.f1)), 'src claude:aaaabbbb#3 2026-09-20 ×2');
  assert.equal(originText(o.get(C.f2)), 'src claude:aaaabbbb#4 2026-09-20 AI-only');
  assert.equal(originText(o.get(C.main)), 'src claude:aaaabbbb#4');
  assert.equal(originText(undefined), '');
  const h = { id: C.main, turn_uuid: 'm4', ts: new Date(T), project: 'd:/p', session_id: 'x', header: '', text: 'hello world', score: 1, uses: 0, last: null,
    status: null, fid: null, kind: null, fact_project: null, superseded_by: null, review_target: null, changed_to: null, src_kind: 'main', tool: 'claude', ev_of: null };
  assert.match(hitLine(h, T, o.get(C.main)), /^\[c+\w+\] 2026-09-20 \S+ p \| บันทึก chat \| src claude:aaaabbbb#4$/);
  assert.doesNotMatch(hitLine(h, T), /src/, 'no origin passed: the old line (eval baselines, golden tests)');
  assert.match(searchText([h], 'hello', true, o), /\| src claude:aaaabbbb#4\nhello world/);
  const line = briefLine({ ...h, text: 'x'.repeat(500) }, 'x', new Map([[C.main, 42]]), o.get(C.main));
  assert.match(line, /\] 2026-09-20 p บันทึก src claude:aaaabbbb#4 ≈42t: x/, 'brief: the tag names the app, so what is dropped');
  assert.ok(line.length <= BRIEF_LINE);
});

test('lint: fact text vs the turns it cites (hard anchors) and close same-project pairs whose numbers or negation differ', async () => {
  const { lintReport, renderLint } = await import('../src/lint.ts');
  const vec = (x: number, y: number) => `[${[x, y, ...Array(1022).fill(0)].join(',')}]`;
  const note = async (name: string, fid: string, body: string, uuids: string[], e: string) => {
    const id = await src(name, 'obsidian', 'note', `memory-hub/facts/${name}.md`, `v/${name}.md`, [['note', 0, `obs:${name}`]]);
    await db.query(`UPDATE turns SET text_redacted = $2 WHERE uuid = $1`, [`obs:${name}`, `# ${fid} ${name}\n${body}\n- from:: [[S0000 card]]`]);
    await db.query(`UPDATE chunks SET embedding = $2::halfvec WHERE source_id = $1`, [id, e]);
    await db.query(`INSERT INTO facts (source_id, fid, kind, valid_at, created_at, source_uuids, md5, run, project)
      VALUES ($1, $2, 'fact', now(), now(), $3, $2, 'r1', 'd:/lint')`, [id, fid, uuids]);
  };
  await src('said', 'claude', 'main', 'lint-session-1', 'a/l1.jsonl', [['user', 0, 'l0']]);
  await db.query(`UPDATE turns SET text_redacted = 'memhub-pg runs on port 5441 (docker compose)' WHERE uuid = 'l0'`);
  await note('ok', 'F0000a001', 'ฐานข้อมูล memhub-pg ใช้พอร์ต 5441', ['l0'], vec(1, 0));
  await note('bad', 'F0000a002', 'deploy ด้วย vercel_cli 3.2 บนเครื่อง box77', ['l0'], vec(0, 1));
  await note('old', 'F0000a003', 'ฐานข้อมูล memhub-pg ใช้พอร์ต 5434', ['l0'], vec(0.9, Math.sqrt(1 - 0.81)));
  await note('same', 'F0000a004', 'deploy ผ่าน vercel_cli 3.2 บน box77 เสมอ', ['l0'], vec(0.1, 0.995));
  // says it replaces "old" (and only mentions "ok"): far from every other note, so no dup/conflict pair
  await note('new', 'F0000a005', 'memhub-pg ใช้พอร์ต 5441 แทน F0000a003 (ยกเลิกแล้ว)', ['l0'], `[${[0, 0, 1, ...Array(1021).fill(0)].join(',')}]`);
  await note('mention', 'F0000a006', 'memhub-pg เดิมจด F0000a001 ไว้', ['l0'], `[${[0, 0, 0, 1, ...Array(1020).fill(0)].join(',')}]`);
  await db.query(`UPDATE facts SET project = 'd:/lint/sub' WHERE fid = 'F0000a003'`); // a sub-folder is the same project (sameTree)
  const r = await lintReport(db, new Date(T));
  assert.deepEqual(r.support.map((x) => [x.fid, x.have, x.of]), [['F0000a002', 0, 3], ['F0000a004', 0, 3]], 'ok/old cite a turn holding their anchors');
  assert.deepEqual(r.conflicts.map((x) => [x.a, x.b, x.why]), [['F0000a001', 'F0000a003', 'ตัวเลขต่างกัน']], 'bad↔same: close, same numbers, no negation');
  assert.deepEqual(r.replaced.map((x) => [x.npath, x.opath]), [['v/new.md', 'v/old.md']], 'a bare mention is not a replacement');
  const md = renderLint(r, new Date(T));
  assert.match(md, /อาจขัดกัน 1 · บอกว่าแทนแล้วแต่ของเก่ายัง active 1 · CONFLICT 0 คู่ · STALE 0\n[\s\S]*\[\[ok\]\] ↔ \[\[old\]\] · ตัวเลขต่างกัน · 0\.900/);
  assert.match(md, /\n- \[\[new\]\] → \[\[old\]\]\n/);
});

test('every MCP reply is redacted on the way out: a row stored before its rule existed never leaves raw', () => {
  const pw = 'Zt8!' + 'qWe4Rk2'; // pragma: allowlist secret
  const out = text(`[S1] ssh root ok, SSH_PASS=${pw} (F1a2b3c4d)`).content[0].text;
  assert.ok(!out.includes(pw) && out.includes('[REDACTED:kv]') && out.includes('F1a2b3c4d'), out);
});
