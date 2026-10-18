// Dream end-to-end with a scripted fake LLM (no network): cards, facts, ADD/NOOP/SUPERSEDE/UPDATE, late-arriving facts,
// other AI apps (codex) + the per-run cap, review routing for ลุงจืด-owned notes, user edits win, tombstones, id validation, files runner, co-access edges.
// Needs the memhub-pg container; throwaway schema + temp vault.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-dream-'));
const SCHEMA = `memhub_dream_test_${process.pid}`; // per run: a concurrent run must never drop our schema (writes would fall through to public)
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMHUB_MEMORY_VAULT = join(tmp, 'vault');
process.env.MEMHUB_DREAM_RUNS = join(tmp, 'runs');
process.env.MEMHUB_VAULTS = '';
process.env.MEMHUB_NO_REINDEX = '1';
process.env.MEMORY_HUB_INTERNAL = '1';
process.env.MEMHUB_DREAM_LIMIT = '25';
const { connect, ROOT } = await import('../src/db.ts');
const { indexFile, indexToolFile } = await import('../src/importer.ts');
const { dream, deepseekRunner, filesRunner, buildDigests, packBatches, deepseekPeak, repairSession, repairOp, SchemaA, SchemaB, DREAM_LIMIT } = await import('../src/dream.ts');
const { rebuildSynapses } = await import('../src/synapse.ts');
const { parseNote, saveNote, fileName, MEMORY_VAULT, MEMORY_PROJECT } = await import('../src/notes.ts');
const { indexVault } = await import('../src/obsidian.ts');
const { search, hitLine } = await import('../src/search.ts');
const { searchText } = await import('../src/mcp.ts');
type LlmReq = { id: string; system: string; user: string; schema: object };

const db = connect('rw');
let n = 0;
function session(id: string, day: string, said: string[], append = false) {
  const path = join(tmp, 'proj', `${id}.jsonl`);
  mkdirSync(join(tmp, 'proj'), { recursive: true });
  let body = '';
  for (const s of said) {
    for (const [type, content] of [['user', s], ['assistant', [{ type: 'text', text: `รับทราบครับ: ${s}` }]]] as const) {
      body += JSON.stringify({ type, uuid: `${id}-u${++n}`, sessionId: id, timestamp: new Date(Date.parse(`${day}T00:00:00Z`) + n * 60_000).toISOString(), cwd: 'D:\\demo',
        message: { role: type, content } }) + '\n';
    }
  }
  (append ? appendFileSync : writeFileSync)(path, body);
  return path;
}

/** Fake Claude. Pass A: every user line "FACT: x" → a fact citing that turn (+ one bogus T id). Pass B: marker words pick the op. */
const calls: string[] = [];
async function fake(req: LlmReq): Promise<unknown> {
  calls.push(req.id);
  if (req.id.startsWith('A-')) {
    const sessions = req.user.split(/^=== /m).slice(1).map((blk) => {
      const s = blk.match(/^(S\d+)/)![1];
      const facts = [...blk.matchAll(/^(T\d+) U: .*?FACT: (.+)$/gm)].map((m) => ({
        text: m[2].trim(), kind: /^กฎ/.test(m[2]) ? 'rule' : /ตัดสินใจ|decide/.test(m[2]) ? 'decision' : 'fact', scope: 'project', lang: 'th',
        importance: 6, confidence: 0.9, valid_at: /เก่า/.test(m[2]) ? '2026-01-01T00:00:00+07:00' : null, source_turns: [m[1]],
      }));
      facts.push({ ...(facts[0] ?? { text: 'x', kind: 'fact', scope: 'project', lang: 'th', importance: 5, confidence: 0.5, valid_at: null }), text: 'bogus', source_turns: ['T999'] });
      return { s, card: { title: `การ์ด ${s}`, summary: 'สรุปสั้น', outcome: 'done', decisions: [], open: [] }, facts };
    });
    return { sessions };
  }
  const ops = req.user.split(/\n\n/).map((blk) => {
    const nid = blk.match(/^(N\d+)/)![1];
    const words = (s: string) => new Set(s.toLowerCase().split(/\s+/));
    const mine = words(blk.split('\n')[0]);
    const overlap = (l: string) => [...words(l)].filter((w) => mine.has(w)).length;
    const e = [...blk.matchAll(/^\s+(E\d+)(.*)$/gm)].sort((a, b) => overlap(b[2]) - overlap(a[2]))[0]?.[1] ?? null; // closest existing fact
    const op = /แทน|SUPERSEDE/.test(blk.split('\n')[0]) ? 'SUPERSEDE' : /เพิ่มเติม/.test(blk.split('\n')[0]) ? 'UPDATE' : /ซ้ำ/.test(blk.split('\n')[0]) ? 'NOOP' : 'ADD';
    return { n: nid, op, target: op === 'ADD' ? null : e, text: op === 'UPDATE' ? 'memhub port 5441 bound to 127.0.0.1 only' : undefined, why: 'test' };
  });
  return { ops };
}
const NOW = new Date('2026-09-25T00:00:00Z');
const run = (name: string) => dream(db, { llm: fake, run: name, force: true, now: NOW, log: () => {} });
const notes = (dir: string) => (existsSync(join(MEMORY_VAULT, dir)) ? readdirSync(join(MEMORY_VAULT, dir), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.md')) : []);
const factRows = async () => (await db.query(`SELECT f.fid, f.kind, s.status, f.superseded_by, f.review_target, f.source_uuids, f.session_ids, f.user_owned
  FROM facts f JOIN sources s ON s.id = f.source_id WHERE f.kind <> 'card' ORDER BY f.created_at, f.fid`)).rows;

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('digest: user turns kept, tool lines + bracket turns dropped, files listed', () => {
  const [d, more] = buildDigests('s', 'd:/demo', [
    { uuid: 'a', role: 'user', ts: new Date(), text: 'ช่วยแก้ไฟล์ให้หน่อยครับ' },
    { uuid: 'b', role: 'assistant', ts: new Date(), text: '[Edit] D:/demo/x.ts' },
    { uuid: 'c', role: 'assistant', ts: new Date(), text: 'แก้แล้วครับ\n[Bash] run $ npm test' },
    { uuid: 'd', role: 'user', ts: new Date('2026-09-01T01:02:03.456Z'), text: '[Request interrupted by user]' },
  ]);
  assert.deepEqual(d.turns.map((t) => [t.uuid, t.text]), [['a', 'ช่วยแก้ไฟล์ให้หน่อยครับ'], ['c', 'แก้แล้วครับ']]);
  assert.deepEqual(d.files, ['D:/demo/x.ts']);
  assert.equal(more, undefined);
  assert.equal(d.upto, '2026-09-01T01:02:03.456Z'); // covers the trailing bracket turn too
  assert.equal(d.card, 'Ss');
  assert.deepEqual(buildDigests('s', 'p', [{ uuid: 'x', role: 'user', ts: new Date(), text: 'ok' }]), []); // nothing worth a card
});

test('digest: his pick from an AI multiple-choice question is a user turn (Claude tool row, ZCode line); dismissed = nothing', () => {
  const ts = new Date();
  const [d] = buildDigests('s', 'd:/demo', [
    { uuid: 'a', role: 'user', ts, text: 'ช่วยวางแผนให้หน่อยครับ' },
    { uuid: 'b', role: 'assistant', ts, text: 'มี 2 ทาง\n[Ask] จะเอาแบบไหน?' },
    { uuid: 'c', role: 'tool', ts, text: '[AskUserQuestion result] Your questions have been answered: "จะเอาแบบไหน?"="B ช้าแต่ชัวร์". You can now continue with these answers in mind.' },
    { uuid: 'd', role: 'assistant', ts, text: 'ทำแบบ B แล้วครับ' },
    { uuid: 'e', role: 'tool', ts, text: '[AskUserQuestion result] [User dismissed — do not proceed]' },
    { uuid: 'f', role: 'tool', ts, text: '[Agent result] done' },
    { uuid: 'g', role: 'user', ts, text: 'ต่อเลย' },
    { uuid: 'h', role: 'assistant', ts, text: 'ถามก่อน\n[Ask result] User has answered your questions: "พอร์ต?"="5441 (แนะนำ)". You can now continue with the user\'s answers in mind.\nใช้ 5441 แล้ว' },
  ]);
  assert.deepEqual(d.turns.map((t) => [t.uuid, t.role, t.text]), [
    ['a', 'user', 'ช่วยวางแผนให้หน่อยครับ'],
    ['c', 'user', '[ตอบตัวเลือกของ AI] "จะเอาแบบไหน?"="B ช้าแต่ชัวร์"'],
    ['d', 'assistant', 'ทำแบบ B แล้วครับ'],
    ['g', 'user', 'ต่อเลย'],
    ['h', 'user', '[ตอบตัวเลือกของ AI] "พอร์ต?"="5441 (แนะนำ)"'],
    ['h', 'assistant', 'ใช้ 5441 แล้ว'],
  ]);
});

test('note file names never carry path or control characters (a JSON "D:\\books" decodes to a backspace)', () => {
  assert.equal(fileName('`D:\books-model` = เอกสาร\tmodel'), 'D ooks-model = เอกสาร model');
  assert.equal(fileName(String.raw`C:\Program Files\x`), 'C Program Files x');
});

// a long session: 40 rounds × (1500-char question + 1200-char answer) ≈ 4 windows
const longRows = (sid: string, day = 11) => Array.from({ length: 40 }, (_, i) => [
  { uuid: `${sid}-q${i}`, role: 'user', ts: new Date(Date.UTC(2026, 6, day, 0, i * 2)), text: `คำถาม ${i} ` + 'ก'.repeat(1500) },
  { uuid: `${sid}-t${i}`, role: 'assistant', ts: new Date(Date.UTC(2026, 6, day, 0, i * 2, 30)), text: `[Edit] D:/x/f${i}.ts` },
  { uuid: `${sid}-a${i}`, role: 'assistant', ts: new Date(Date.UTC(2026, 6, day, 0, i * 2 + 1)), text: `คำตอบ ${i} ` + 'ข'.repeat(1200) },
]).flat();

test('long session → consecutive windows, nothing dropped from the middle, contiguous coverage', () => {
  const rows = longRows('abcd1234-0000');
  const ws = buildDigests('abcd1234-0000', 'd:/x', rows);
  assert.ok(ws.length >= 3, `windows: ${ws.length}`);
  const users = ws.flatMap((w) => w.turns.filter((t) => t.role === 'user').map((t) => t.uuid));
  assert.deepEqual(users, rows.filter((r) => r.role === 'user').map((r) => r.uuid)); // every question, once, in order
  assert.ok(ws.every((w) => w.turns.every((t) => t.uuid && !t.text.includes('omitted'))));
  assert.ok(ws.every((w) => w.turns.reduce((a, t) => a + t.text.length + 8, 0) <= 20_000 + 2_700));
  for (let k = 1; k < ws.length; k++) { // contiguous: each window ends right before the next one's first row
    assert.equal(ws[k - 1].upto, rows[rows.findIndex((r) => r.uuid === ws[k].turns[0].uuid) - 1].ts.toISOString());
  }
  assert.equal(ws.at(-1)!.upto, rows.at(-1)!.ts.toISOString());
  assert.equal(ws[0].card, 'Sabcd1234');
  assert.equal(new Set(ws.map((w) => w.card)).size, ws.length);
  assert.match(ws[1].note, /^part 2\/\d+ of a long session$/);
  assert.deepEqual(ws.flatMap((w) => w.files), rows.filter((r) => r.text.startsWith('[Edit]')).map((r) => r.text.slice(7))); // each file in its own window
  const cont = buildDigests('abcd1234-0000', 'd:/x', longRows('abcd1234-0000', 12).slice(0, 6), true);
  assert.notEqual(cont[0].card, 'Sabcd1234'); // a continuation gets its own card
  assert.match(cont[0].note, /continues a session already summarised/);
});

test('packing: oldest first; a later window of a session never shares or precedes the batch of an earlier one', () => {
  const ws = buildDigests('abcd1234-0000', 'd:/x', longRows('abcd1234-0000'));
  const small = buildDigests('ffff0000-1111', 'd:/y', [{ uuid: 'y1', role: 'user', ts: new Date(Date.UTC(2026, 6, 10)), text: 'คำถามสั้น ๆ ของอีกเซสชัน' }]);
  const bs = packBatches([...ws].reverse().concat(small));
  const at = (key: string) => bs.findIndex((b) => b.some((d) => d.key === key));
  for (let k = 1; k < ws.length; k++) assert.ok(at(ws[k].key) > at(ws[k - 1].key), `window ${k}`);
  assert.equal(at(small[0].key), 0); // the oldest digest goes first
  assert.ok(bs.every((b) => b.reduce((a, d) => a + d.turns.reduce((x, t) => x + t.text.length + 8, 0), 0) <= 60_000 || b.length === 1));
});

test('pass A → card + facts ADDed with real provenance; bogus turn ids rejected', async () => {
  await indexFile(db, session('s1', '2026-09-10', ['FACT: memhub ใช้ postgres port 5441 เท่านั้น', 'FACT: ตัดสินใจใช้ bge-m3 สำหรับ vector', 'ขอบคุณ']));
  const r = await run('t1');
  assert.equal(r.status, 'done');
  assert.equal(r.stats.ADD, 2);
  assert.ok(r.stats.rejected_ids >= 1, JSON.stringify(r.stats));
  assert.equal(notes('sessions').length, 1);
  const rows = await factRows();
  assert.equal(rows.length, 2);
  for (const f of rows) {
    assert.equal(f.status, 'active');
    assert.match(f.source_uuids[0], /^s1-u\d+$/);           // T id mapped back to the real turn uuid
    assert.deepEqual(f.session_ids, ['s1']);                // provenance → session (graph join)
  }
  const card = parseNote(readFileSync(join(MEMORY_VAULT, 'sessions', notes('sessions')[0]), 'utf8'));
  assert.equal(card.fm.memhub, 'card');
  assert.match(card.body, /\[\[F[0-9a-f]{8} /);           // card links its facts
});

test('priority order: a fact outranks its own source chat, which is folded under it (↳) instead of taking a slot', async () => {
  const q = 'memhub postgres port 5441';
  const { hits } = await search(db, q, { semantic: false, limit: 8 });
  const [top] = hits;
  assert.equal(top.kind, 'fact', hitLine(top));
  const src = top.evidence?.find((e) => e.session_id === 's1');
  assert.ok(src && !src.fid, 'its source chat is attached');
  assert.ok(!hits.some((h) => h.id === src.id), 'and has no slot of its own');
  const [line, , source] = searchText(hits, q, true).split('\n'); // header, snippet, then the ↳ source line
  assert.ok(line.startsWith(`[${top.fid}] `) && line.includes('| ✓ใช้ได้ fact'), line);
  assert.ok(source.startsWith(`↳ source chat [${src.id}] `), source);
  assert.match(source, /\d{4}-\d\d-\d\d: .*5441/, 'the first ↳ carries text, not just an id');
});

test('rerun with unchanged sessions does no LLM work (idempotent)', async () => {
  const before = calls.length;
  const r = await run('t1b');
  assert.equal(r.stats.sessions, 0);
  assert.equal(calls.length, before);
});

test('SUPERSEDE: new value wins, old one is kept but marked OLD and ranks lower', async () => {
  await indexFile(db, session('s2', '2026-09-15', ['FACT: เปลี่ยนแทน memhub ใช้ postgres port 5442 แล้ว']));
  const r = await run('t2');
  assert.equal(r.stats.SUPERSEDE, 1, JSON.stringify(r.stats));
  const rows = await factRows();
  const old = rows.find((f) => f.status === 'superseded')!;
  const cur = rows.find((f) => f.fid === old.superseded_by)!;
  assert.ok(cur && cur.status === 'active');
  const { hits } = await search(db, 'memhub postgres port', { semantic: false, limit: 8, project: MEMORY_PROJECT });
  const iCur = hits.findIndex((h) => h.fid === cur.fid), iOld = hits.findIndex((h) => h.fid === old.fid);
  assert.ok(iCur >= 0 && iOld >= 0 && iCur < iOld, `current ${iCur} should rank above old ${iOld}`);
  assert.match(hitLine(hits[iOld]), new RegExp(`OLD -> \\[${cur.fid}\\]`));
  const vaultLog = execFileSync('git', ['log', '--format=%s'], { cwd: MEMORY_VAULT, encoding: 'utf8' }).split('\n');
  assert.equal(vaultLog[0], 'dream t2: +0 ADD, 0 UPDATE, 1 SUPERSEDE'); // the whole run (notes + hubs) = one vault commit
});

test('late-arriving older fact is born superseded (Zep rule)', async () => {
  await indexFile(db, session('s3', '2026-09-16', ['FACT: แทน memhub ใช้ postgres port 5440 สมัยเก่า']));
  await run('t3');
  const born = (await factRows()).find((f) => f.source_uuids.some((u: string) => u.startsWith('s3-')))!;
  assert.equal(born.status, 'superseded');
});

test('identical fact = NOOP: provenance merged, no new note, hub Knowledge Page shows full text + ×2 proof count + freshness', async () => {
  const before = notes('facts').length;
  await indexFile(db, session('s4', '2026-09-17', ['FACT: ตัดสินใจใช้ bge-m3 สำหรับ vector']));
  const r = await run('t4');
  assert.equal(r.stats.NOOP, 1);
  assert.equal(notes('facts').length, before);
  const f = (await factRows()).find((x) => x.source_uuids.some((u: string) => u.startsWith('s4-')))!;
  assert.ok(f.source_uuids.some((u: string) => u.startsWith('s1-')), 'kept the original provenance too');
  const hub = parseNote(readFileSync(join(MEMORY_VAULT, 'hubs', 'demo hub.md'), 'utf8'));
  assert.equal(hub.fm.freshness, 'up_to_date');
  assert.ok(Number(hub.fm.active_facts) >= 2);
  assert.match(hub.body, /ความจำ active \d+ รายการ · การ์ดเซสชัน \d+ ใบ · สถานะ: สด \(ฝันครบทุกแชต\)/);
  assert.match(hub.body, /## ความรู้และการตัดสินใจล่าสุด\n(?:- [^\n]*\n)*- \[F[0-9a-f]{8}\] \d{4}-\d{2}-\d{2} คำลุงจืด ×2 — ตัดสินใจใช้ bge-m3 สำหรับ vector\n/);
  assert.match(hub.body, /## งานล่าสุด[^\n]*\n(?:- [^\n]*\n)*- \[S\w+\] \d{4}-\d{2}-\d{2} การ์ดเซสชัน — การ์ด S\d+: สรุปสั้น/);
});

test('ลุงจืด-owned target → proposal goes to review (pending), target untouched', async () => {
  saveNote('ลุงจืดสั่ง: memhub backup ทุกคืนตอนตีสาม', { project: 'd:/demo', kind: 'rule', now: NOW });
  await indexVault(db, MEMORY_VAULT);
  await indexFile(db, session('s5', '2026-09-18', ['FACT: แทน memhub backup ทุกคืนตอนตีสาม เปลี่ยนเป็นตีสี่']));
  const r = await run('t5');
  assert.equal(r.stats.pending_review, 1, JSON.stringify(r.stats));
  const rows = await factRows();
  const p = rows.find((f) => f.status === 'pending')!;
  const target = rows.find((f) => f.fid === p.review_target)!;
  assert.equal(target.status, 'active');
  assert.ok(target.user_owned);
  assert.match(readFileSync(join(MEMORY_VAULT, 'hubs', '_review.md'), 'utf8'), new RegExp(p.fid));
});

test('a note ลุงจืด edited is never rewritten by the machine', async () => {
  const rel = notes('facts').find((f) => readFileSync(join(MEMORY_VAULT, 'facts', f), 'utf8').includes('5442'))!;
  const path = join(MEMORY_VAULT, 'facts', rel);
  writeFileSync(path, readFileSync(path, 'utf8').replace('5442 แล้ว', '5442 แล้ว (ยืนยันโดยลุงจืด)'));
  await indexVault(db, MEMORY_VAULT);
  const mine = readFileSync(path, 'utf8');
  await indexFile(db, session('s6', '2026-09-19', ['FACT: แทน memhub ใช้ postgres port 6000 ตอนทดสอบ']));
  await run('t6');
  assert.equal(readFileSync(path, 'utf8'), mine);
});

test('deleted fact file → tombstone → never re-created', async () => {
  const rel = notes('facts').find((f) => readFileSync(join(MEMORY_VAULT, 'facts', f), 'utf8').includes('6000'))!;
  unlinkSync(join(MEMORY_VAULT, 'facts', rel));
  await indexVault(db, MEMORY_VAULT);
  await indexFile(db, session('s7', '2026-09-20', ['FACT: แทน memhub ใช้ postgres port 6000 ตอนทดสอบ']));
  const r = await run('t7');
  assert.equal(r.stats.dropped, 1, JSON.stringify(r.stats));
  assert.ok(!notes('facts').some((f) => readFileSync(join(MEMORY_VAULT, 'facts', f), 'utf8').includes('6000')));
});

test('files runner: writes requests, stops, continues once results exist', async () => {
  await indexFile(db, session('s8', '2026-09-21', ['FACT: memhub web ใช้ Next.js 16 static export']));
  const dir = join(tmp, 'req');
  const runner = filesRunner(dir);
  const r1 = await dream(db, { llm: runner, run: 'f1', force: true, now: NOW, log: () => {} });
  assert.equal(r1.status, 'pending');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.request.json'))) {
    const req = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    writeFileSync(join(dir, f.replace('.request.', '.result.')), JSON.stringify(await fake(req)));
  }
  let r2 = await dream(db, { llm: runner, run: 'f1', force: true, now: NOW, log: () => {} });
  for (let i = 0; r2.status === 'pending' && i < 3; i++) { // pass B may need its own round
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.request.json') && !existsSync(join(dir, x.replace('.request.', '.result.'))))) {
      writeFileSync(join(dir, f.replace('.request.', '.result.')), JSON.stringify(await fake(JSON.parse(readFileSync(join(dir, f), 'utf8')))));
    }
    r2 = await dream(db, { llm: runner, run: 'f1', force: true, now: NOW, log: () => {} });
  }
  assert.equal(r2.status, 'done');
  assert.ok(notes('facts').some((f) => readFileSync(join(MEMORY_VAULT, 'facts', f), 'utf8').includes('Next.js 16')));
});

test('files runner resumes a multi-batch run with a fixed plan (request ids never change)', async () => {
  for (let i = 0; i < 13; i++) await indexFile(db, session(`m${i}`, '2026-09-22', [`FACT: โมดูล mod${i} ใช้พอร์ต ${7000 + i}`]));
  const dir = join(tmp, 'req-multi');
  const runner = filesRunner(dir);
  const answer = async () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.request.json') && !existsSync(join(dir, x.replace('.request.', '.result.'))))) {
      writeFileSync(join(dir, f.replace('.request.', '.result.')), JSON.stringify(await fake(JSON.parse(readFileSync(join(dir, f), 'utf8')))));
    }
  };
  let r = await dream(db, { llm: runner, run: 'multi', force: true, now: NOW, log: () => {} });
  assert.equal(r.stats.batches, 2);
  for (let i = 0; r.status === 'pending' && i < 8; i++) { await answer(); r = await dream(db, { llm: runner, run: 'multi', force: true, now: NOW, log: () => {} }); }
  assert.equal(r.status, 'done');
  // counters of the whole run, not of the last restart (each pass-B request stops a files runner once)
  assert.deepEqual([r.stats.sessions, r.stats.cards, r.stats.ADD], [13, 13, 13], JSON.stringify(r.stats));
  assert.equal(readdirSync(dir).filter((x) => x.startsWith('A-') && x.endsWith('.request.json')).length, 2); // no re-packing
  assert.ok(notes('sessions').length >= 13);
  const done = (await db.query(`SELECT count(*)::int n FROM state WHERE k LIKE 'dream:session:m%' AND v->>'run' = 'multi'`)).rows[0].n;
  assert.equal(done, 13);
});

test('co-access: sources opened together in one session get a Hebbian edge; search impressions do not', async () => {
  const ch = (await db.query(`SELECT DISTINCT ON (source_id) id, turn_uuid, source_id FROM chunks ORDER BY source_id, id LIMIT 3`)).rows;
  const ins = (kind: string, c: { id: string; turn_uuid: string }, session: string) =>
    db.query(`INSERT INTO access_log (kind, chunk_id, turn_uuid, session, ts) VALUES ($1, $2, $3, $4, now())`, [kind, c.id, c.turn_uuid, session]);
  await ins('get', ch[0], 'm1'); await ins('related', ch[1], 'm1');
  await ins('search', ch[0], 'm2'); await ins('search', ch[2], 'm2');
  await rebuildSynapses(db, { plastic: true });
  const e = (await db.query(`SELECT a, b, w FROM edges WHERE kind = 'coaccess'`)).rows;
  assert.equal(e.length, 1);
  assert.deepEqual([String(e[0].a), String(e[0].b)].sort(), [String(ch[0].source_id), String(ch[1].source_id)].sort());
  assert.ok(Math.abs(e[0].w - 0.1) < 0.01);
});

test('a dream-recorded rule yields to ลุงจืด\'s own newer words (no review needed)', async () => {
  await indexFile(db, session('s9', '2026-09-20', ['FACT: กฎ memhub dream รันตอนตีสามครึ่ง']));
  await run('t9');
  const rule = (await factRows()).find((f) => f.source_uuids.some((u: string) => u.startsWith('s9-')))!;
  assert.equal(rule.kind, 'rule');
  assert.ok(rule.user_owned, 'rules are owned (protected from assistant-sourced changes)');
  await indexFile(db, session('s10', '2026-09-21', ['FACT: กฎ แทน memhub dream รันตอนตีสามครึ่ง เปลี่ยนเป็นตีสี่ครึ่ง']));
  const r = await run('t10');
  assert.equal(r.stats.pending_review, 0, JSON.stringify(r.stats));
  const rows = await factRows();
  assert.equal(rows.find((f) => f.fid === rule.fid)!.status, 'superseded');
});

const sessionState = async (id: string) => (await db.query(`SELECT v FROM state WHERE k = $1`, [`dream:session:${id}`])).rows[0]?.v;
const maxTs = async (id: string) => (await db.query(`SELECT max(ts) m FROM turns WHERE session_id = $1`, [id])).rows[0].m.toISOString();

test('a session that grows is dreamed again for its new turns only, with its own card', async () => {
  const p = session('g1', '2026-09-23', ['FACT: บริการ alpha ใช้พอร์ต 8100']);
  await indexFile(db, p);
  const seen: string[] = [];
  const spy = (req: LlmReq) => { if (req.id.startsWith('A-')) seen.push(req.user); return fake(req); };
  const go = (r: string) => dream(db, { llm: spy, run: r, force: true, now: NOW, log: () => {} });
  await go('g-1');
  assert.ok(seen.join('\n').includes('alpha'));
  assert.equal((await sessionState('g1')).upto, await maxTs('g1'));
  session('g1', '2026-09-23', ['FACT: บริการ beta ใช้พอร์ต 8200 แทน alpha'], true);
  await indexFile(db, p);
  seen.length = 0;
  await go('g-2');
  const text = seen.join('\n');
  assert.ok(text.includes('beta') && !text.includes('alpha ใช้พอร์ต 8100'), 'only the new turns are sent');
  assert.match(text, /continues a session already summarised/);
  assert.equal((await sessionState('g1')).upto, await maxTs('g1'));
  const cards = notes('sessions').filter((f) => readFileSync(join(MEMORY_VAULT, 'sessions', f), 'utf8').includes('session `g1`'));
  assert.equal(cards.length, 2, cards.join()); // the first card is kept, the new part gets its own
  seen.length = 0;
  await go('g-3');
  assert.equal(seen.length, 0, 'nothing new → no LLM work');
});

test('a session resumed from another folder (two transcripts) is one session, merged in time order', async () => {
  await indexFile(db, session('r1', '2026-09-23', ['FACT: บริการ theta ใช้พอร์ต 8600']));
  const p2 = join(tmp, 'proj2', 'r1.jsonl');
  mkdirSync(join(tmp, 'proj2'), { recursive: true });
  writeFileSync(p2, (['user', 'assistant'] as const).map((type, i) => JSON.stringify({ type, uuid: `r1-x${i}`, sessionId: 'r1', timestamp: `2026-09-23T23:00:0${i}.000Z`, cwd: tmp,
    message: { role: type, content: type === 'user' ? 'FACT: บริการ iota ใช้พอร์ต 8700' : [{ type: 'text', text: 'รับทราบ' }] } })).join('\n') + '\n');
  await indexFile(db, p2);
  const seen: string[] = [];
  await dream(db, { llm: (req) => { if (req.id.startsWith('A-')) seen.push(req.user); return fake(req); }, run: 'r-1', force: true, now: NOW, log: () => {} });
  const blk = seen.join('\n').split(/^=== /m).find((b) => b.includes('theta'))!;
  assert.ok(blk.includes('iota') && blk.indexOf('theta') < blk.indexOf('iota'), 'one digest, in time order');
  assert.equal((await sessionState('r1')).upto, '2026-09-23T23:00:01.000Z');
});

test('legacy state without `upto` counts as covered up to its card write time', async () => {
  const p = session('h1', '2026-09-23', ['FACT: บริการ eta ใช้พอร์ต 8500']);
  await indexFile(db, p);
  await run('h-1');
  const st = await sessionState('h1');
  await db.query(`UPDATE state SET v = v - 'upto' WHERE k = 'dream:session:h1'`); // as written before windows existed
  await db.query(`UPDATE facts SET created_at = '2026-09-24T00:00:00Z' WHERE fid = $1`, [st.card]);
  const seen: string[] = [];
  await dream(db, { llm: (req) => { seen.push(req.user); return fake(req); }, run: 'h-2', force: true, now: NOW, log: () => {} });
  assert.ok(!seen.join().includes('eta'), 'old turns are not re-dreamed');
});

test('files runner: a session that grows while a run is pending keeps the frozen plan', async () => {
  const p = session('z1', '2026-09-23', ['FACT: บริการ gamma ใช้พอร์ต 8300']);
  await indexFile(db, p);
  const dir = join(tmp, 'req-frozen');
  const runner = filesRunner(dir);
  const answer = async () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.request.json') && !existsSync(join(dir, x.replace('.request.', '.result.'))))) {
      writeFileSync(join(dir, f.replace('.request.', '.result.')), JSON.stringify(await fake(JSON.parse(readFileSync(join(dir, f), 'utf8')))));
    }
  };
  const go = () => dream(db, { llm: runner, run: 'frozen', force: true, now: NOW, log: () => {} });
  let r = await go();
  assert.equal(r.status, 'pending');
  const reqsA = () => readdirSync(dir).filter((x) => x.startsWith('A-') && x.endsWith('.request.json'));
  const first = reqsA();
  session('z1', '2026-09-23', ['FACT: บริการ delta ใช้พอร์ต 8400'], true); // ลุงจืด keeps talking meanwhile
  await indexFile(db, p);
  for (let i = 0; r.status === 'pending' && i < 6; i++) { await answer(); r = await go(); }
  assert.equal(r.status, 'done');
  assert.deepEqual(reqsA(), first); // same request ids
  assert.ok((await sessionState('z1')).upto < await maxTs('z1'), 'the new turns wait for the next run');
});

/** A session of another AI app, stored through the real indexToolFile with a stub ToolModule (uuids per the importer rule). */
async function appSession(tool: string, id: string, day: string, said: string[], reply = (s: string) => `รับทราบครับ: ${s}`) {
  const msgs = said.flatMap((s) => (['user', 'assistant'] as const).map((role) => {
    const k = ++n;
    return { uuid: `${tool}:${id}:${k}`, parentUuid: null, sessionId: id, ts: new Date(Date.parse(`${day}T00:00:00Z`) + k * 60_000).toISOString(),
      cwd: 'D:\\demo', role, text: role === 'user' ? s : reply(s) };
  }));
  const path = join(tmp, tool, `${id}.json`);
  mkdirSync(join(tmp, tool), { recursive: true });
  writeFileSync(path, JSON.stringify(msgs));
  return indexToolFile(db, { tool, sync: () => ({}), isTranscript: () => true, parse: async () => ({ sessionId: id, cwd: 'D:\\demo', msgs }) }, path);
}
const answerAll = async (dir: string) => {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.request.json') && !existsSync(join(dir, x.replace('.request.', '.result.'))))) {
    writeFileSync(join(dir, f.replace('.request.', '.result.')), JSON.stringify(await fake(JSON.parse(readFileSync(join(dir, f), 'utf8')))));
  }
};

test('a Codex session is dreamed like a Claude one: header + card name the app, its tool lines are dropped', async () => {
  const id = '0199d3a4-7f00-7000-8000-00000000c0de';
  assert.equal(await appSession('codex', id, '2026-09-24', ['FACT: codex sandbox ของ memhub ตั้งเป็น workspace-write'],
    (s) => `[shell] git status\n[apply_patch] D:/demo/codex.ts\nตั้งค่าแล้วครับ: ${s}`), 'indexed');
  const seen: string[] = [];
  const r = await dream(db, { llm: (req) => { if (req.id.startsWith('A-')) seen.push(req.user); return fake(req); }, run: 'codex-1', force: true, now: NOW, log: () => {} });
  assert.equal(r.status, 'done');
  const blk = seen.join('\n').split(/^=== /m).find((b) => b.includes('workspace-write'))!;
  assert.match(blk, /^S\d+ \| demo \| codex \| 2026-09-24 /);
  assert.ok(!blk.includes('[shell]') && blk.includes('[files edited: D:/demo/codex.ts]'));
  const f = (await factRows()).find((x) => x.session_ids.includes(id))!;
  assert.ok(f?.source_uuids[0].startsWith(`codex:${id}:`), 'fact provenance → the codex turn');
  const card = notes('sessions').map((x) => parseNote(readFileSync(join(MEMORY_VAULT, 'sessions', x), 'utf8'))).find((c) => c.fm.session === id)!;
  assert.equal(card.fm.tool, 'codex');
  assert.ok(card.body.includes(`· codex · session \`${id}\``));
  assert.match(String(card.fm.id), /^S[0-9a-f]{8}$/); // memory_get-able
  // Codex ids are UUIDv7 (time-ordered): two sessions a minute apart share their first 8 hex chars, never a card id
  const cardOf = (sid: string) => buildDigests(sid, 'd:/demo', [{ uuid: `${sid}-q`, role: 'user', ts: new Date(), text: 'คำถามที่ยาวพอสำหรับการ์ด' }], false, 'codex')[0].card;
  assert.notEqual(cardOf('0199d3a4-1111'), cardOf('0199d3a4-2222'));
});

test('default cap: a backlog goes DREAM_LIMIT sessions per run, newest first; junk is marked done without counting; plan resumes', async () => {
  const ids = Array.from({ length: DREAM_LIMIT + 3 }, (_, i) => `0199e000-0000-7000-8000-${String(i).padStart(12, '0')}`);
  for (const id of ids) await appSession('codex', id, '2026-09-24', [`งานค้าง codex ลำดับที่ ${id.slice(-4)} ครับ`]);
  await appSession('codex', 'junk-0001', '2026-09-24', ['ok']); // newest of all, nothing worth a card
  const dir = join(tmp, 'req-cap');
  const go = () => dream(db, { llm: filesRunner(dir), run: 'cap', force: true, now: NOW, log: () => {} });
  let r = await go();
  assert.equal(r.status, 'pending');
  assert.equal(r.stats.sessions, DREAM_LIMIT);
  const junk = await sessionState('junk-0001');
  assert.ok(junk?.upto && !junk.run, 'junk marked done, not dreamed');
  for (let i = 0; r.status === 'pending' && i < 8; i++) { await answerAll(dir); r = await go(); }
  assert.equal(r.status, 'done');
  const done = (await db.query(`SELECT k FROM state WHERE v->>'run' = 'cap' ORDER BY k`)).rows.map((x) => x.k.slice(14));
  assert.deepEqual(done, ids.slice(3)); // the newest DREAM_LIMIT
  await run('cap-2');
  const rest = await db.query(`SELECT count(*)::int n FROM state WHERE k = ANY($1) AND v->>'run' = 'cap-2'`, [ids.slice(0, 3).map((x) => `dream:session:${x}`)]);
  assert.equal(rest.rows[0].n, 3); // the next run picks up the remainder
});

test('a session the model returns no card for is retried next run, and its later windows do not jump over it', async () => {
  await indexFile(db, session('nc1', '2026-09-24', ['FACT: งาน nc1 ใช้พอร์ต 9101']));
  // ~5 windows → one per batch; the model drops the first: the batches holding only later lw1 windows wait for the next run too
  await indexFile(db, session('lw1', '2026-09-24', Array.from({ length: 40 }, (_, i) => `${i ? `รอบ ${i}` : 'เริ่ม lw1'} ${'ก'.repeat(1500)}`)));
  const drop = async (req: LlmReq) => {
    const r: any = await fake(req);
    if (!req.id.startsWith('A-')) return r;
    const blk = new Map(req.user.split(/^=== /m).slice(1).map((b) => [b.match(/^(S\d+)/)![1], b]));
    return { sessions: r.sessions.filter((s: any) => !blk.get(s.s)!.includes('เริ่ม lw1')) };
  };
  const r = await dream(db, { llm: drop, run: 'nc-1', force: true, now: NOW, log: () => {} });
  assert.equal(r.stats.no_card, 1, JSON.stringify(r.stats));
  assert.deepEqual([r.stats.windows >= 3, r.stats.cards], [true, 1], JSON.stringify(r.stats)); // nc1 only
  assert.equal((await sessionState('nc1')).run, 'nc-1');
  assert.equal(await sessionState('lw1'), undefined, 'neither the skipped window nor the ones after it are marked done');
  await run('nc-2');
  assert.equal((await sessionState('lw1')).upto, await maxTs('lw1'));
});

test('deepseekPeak: weekday 01-04 and 06-10 UTC only', () => {
  const at = (iso: string) => deepseekPeak(new Date(iso));
  assert.deepEqual(['2026-10-12T01:00Z', '2026-10-12T03:59Z', '2026-10-12T06:00Z', '2026-10-16T09:59Z'].map(at), [true, true, true, true]);
  assert.deepEqual(['2026-10-12T00:59Z', '2026-10-12T04:00Z', '2026-10-12T10:00Z', '2026-10-12T20:30Z', '2026-10-10T02:00Z', '2026-10-11T07:00Z'].map(at),
    [false, false, false, false, false, false]); // 20:30Z = the 03:30 BKK nightly; 10-10/11 = Sat/Sun
});

test('repairSession: over-long card fields, null arrays, float importance, or one bad fact no longer drop the session', () => {
  const fact = { text: 'ok', kind: 'fact', scope: 'project', lang: 'en', importance: 5, confidence: 0.9, source_turns: ['T1'] };
  const floatFact = { ...fact, text: 'คำอธิบายภาษาไทย '.repeat(30), importance: 8.6, confidence: 9, valid_at: '' };
  const bad = { s: 'S1', card: { title: 'x'.repeat(95), summary: 's', outcome: 'done', decisions: Array(7).fill('d'.repeat(250)), open: null },
    facts: [floatFact, { ...fact, kind: 'gossip' }, ...Array(8).fill(fact)] };
  const El = SchemaA.shape.sessions.element;
  assert.equal(El.safeParse(bad).success, false);
  const r = El.safeParse(repairSession(bad));
  assert.ok(r.success);
  assert.equal(r.data!.card.title.length, 80);
  assert.equal(r.data!.card.decisions!.length, 5);
  assert.equal(r.data!.card.open, undefined);
  assert.equal(r.data!.facts.length, 8);
  assert.equal(r.data!.facts[0].importance, 9);
  assert.equal(r.data!.facts[0].confidence, 0.9);
  assert.ok(r.data!.facts[0].text.length <= 400 && r.data!.facts[0].text.endsWith('…'));
  assert.equal(El.safeParse(repairSession({ s: null, card: bad.card, facts: [] })).success, false); // unknown session: still dropped
});

test('repairOp: an over-long UPDATE becomes ADD instead of losing the fact; other ops just drop the text; DeepSeek nulls/long why repaired at word boundary', () => {
  const El = SchemaB.shape.ops.element, long = 'x'.repeat(1500);
  const up = { n: 'N1', op: 'UPDATE', target: 'E2', text: long, links: [{ to: 'E3', rel: 'related' }], why: 'merge' };
  assert.equal(El.safeParse(up).success, false);
  const r = El.safeParse(repairOp(up));
  assert.ok(r.success);
  assert.deepEqual([r.data!.op, r.data!.target, r.data!.text, r.data!.links], ['ADD', null, undefined, [{ to: 'E3', rel: 'related' }]]);
  assert.deepEqual(El.safeParse(repairOp({ n: 'N2', op: 'NOOP', target: 'E1', text: long })).data, { n: 'N2', op: 'NOOP', target: 'E1', text: undefined });
  const ds = { n: 'N3', op: 'SUPERSEDE', target: 'E1', text: null, links: null, why: 'เหตุผลภาษาไทยยาว '.repeat(15) };
  assert.equal(El.safeParse(ds).success, false);
  const rDs = El.safeParse(repairOp(ds));
  assert.ok(rDs.success);
  assert.ok(rDs.data!.why!.length <= 160 && rDs.data!.why!.endsWith('ยาว…'), rDs.data!.why);
  assert.equal(rDs.data!.text, undefined);
  assert.equal(rDs.data!.links, undefined);
  assert.equal(El.safeParse(repairOp({ n: 'X', op: 'UPDATE', target: 'E1', text: long })).success, false); // a bad id is never repaired
});

test('intra-batch duplicate facts merge provenance; batch-wide E# targets resolve; Pass A cached on Pass B failure; stale dream:plan pruned', async () => {
  await db.query(`INSERT INTO state (k, v) VALUES ('dream:plan:2026-08-01-claude', '{}'), ('dream:plan:2026-09-25-deepseek', '{}')`);
  await indexFile(db, session('dup1', '2026-09-24', ['FACT: กฎช่อง Botstery ห้ามเดาข้อมูลเด็ดขาด']));
  await indexFile(db, session('dup2', '2026-09-24', ['FACT: กฎช่อง Botstery ห้ามเดาข้อมูลเด็ดขาด']));
  let callsA = 0, failB = true;
  const flakyLlm = async (req: Parameters<typeof fake>[0]) => {
    if (req.id.startsWith('A-')) callsA++;
    if (req.id.startsWith('B-') && failB) { failB = false; throw new Error('network drop in Pass B'); }
    return fake(req);
  };
  await assert.rejects(() => dream(db, { llm: flakyLlm, run: 'dup-run', force: true, now: NOW, log: () => {} }), /network drop in Pass B/);
  assert.equal(callsA, 1, 'Pass A called once before Pass B failed');
  const r = await dream(db, { llm: flakyLlm, run: 'dup-run', force: true, now: NOW, log: () => {} });
  assert.equal(callsA, 1, 'Pass A result reused from dream:plan:<run> on retry without re-billing');
  assert.equal(r.stats.ADD, 1, JSON.stringify(r.stats));
  assert.equal(r.stats.NOOP, 1, JSON.stringify(r.stats));
  const f = (await factRows()).find((x) => x.session_ids.includes('dup1') && x.session_ids.includes('dup2'));
  assert.ok(f, 'both sessions merged into the single note provenance');
  const stale = (await db.query(`SELECT k FROM state WHERE k LIKE 'dream:plan:%'`)).rows.map((x) => x.k);
  assert.deepEqual(stale, ['dream:plan:2026-09-25-deepseek']);
});

test('deepseek runner: no key-shaped token leaves, JSON mode with an example, retries empty/503, thinking + checklist on pass A only', async () => {
  const sent: { url: string; body: any }[] = [];
  const replies: { status?: number; content: string }[] = [{ status: 503, content: 'overloaded' }, { content: '' }, { content: '{"sessions":[]}' }, { content: '{"sessions":[]}' }];
  const realFetch = globalThis.fetch, realKey = process.env.MEMHUB_DEEPSEEK_KEY;
  process.env.MEMHUB_DEEPSEEK_KEY = 'test-key'; // fetch is stubbed: nothing reaches the API
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    const next = replies.shift()!;
    if (next.status) return new Response(next.content, { status: next.status });
    return new Response(JSON.stringify({ choices: [{ message: { content: next.content }, finish_reason: 'stop' }], usage: {} }));
  }) as typeof fetch;
  try {
    const leak = 'aB3dE5gH7jK9mN1pQ2rS4tU6v'; // 25-char key shape the import redaction keeps
    const out = await deepseekRunner('deepseek-flash', () => {}, 1)({ id: 'x', system: 'SYS', user: `KEY=${leak} ใช้ตัวนี้ cut \uD83D`,
      schema: { type: 'object', properties: { s: { type: 'string', pattern: '^S\\d+$' } } } });
    assert.deepEqual(out, { sessions: [] });
    assert.equal(sent.length, 3);
    const b = sent[0].body;
    assert.equal(sent[0].url, 'https://api.deepseek.com/chat/completions');
    assert.deepEqual(b.thinking, { type: 'disabled' });
    assert.equal(b.response_format.type, 'json_object');
    assert.ok(!JSON.stringify(b).includes(leak));
    assert.match(b.messages[0].content, /"s":"S1"/);
    assert.ok(b.messages[1].content.isWellFormed()); // a lone surrogate made DeepSeek answer 400
    assert.ok(!b.messages[0].content.includes('Final check'));
    await deepseekRunner('deepseek-flash', () => {}, 1)({ id: 'A-1', system: 'SYS', user: 'u', schema: { type: 'object' } }); // pass A: thinking + checklist
    assert.deepEqual(sent[3].body.thinking, { type: 'enabled' });
    assert.match(sent[3].body.messages[0].content, /^SYS\n\nFinal check before you answer/);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.MEMHUB_DEEPSEEK_KEY; else process.env.MEMHUB_DEEPSEEK_KEY = realKey;
  }
});

test('an UPDATE whose new text is the target itself is a NOOP: the fact is never superseded by itself', async () => {
  await indexFile(db, session('upd1', '2026-09-24', ['FACT: memhub port 5441 bound to 127.0.0.1 only']));
  await run('upd-a');
  await indexFile(db, session('upd2', '2026-09-24', ['FACT: เพิ่มเติม memhub port 5441 bound to 127.0.0.1 only นะ']));
  const r = await run('upd-b');
  const f = (await factRows()).find((x) => x.source_uuids.some((u: string) => u.startsWith('upd1-')))!;
  assert.equal(f.status, 'active', JSON.stringify(r.stats));
  assert.ok(!f.superseded_by, 'not superseded by itself');
  assert.ok(f.source_uuids.some((u: string) => u.startsWith('upd2-')), 'the new mention is merged into it');
  assert.equal(r.stats.UPDATE ?? 0, 0, JSON.stringify(r.stats));
});

test('two chats in one run repeating an existing fact both count: the second NOOP keeps the first one\'s provenance', async () => {
  await indexFile(db, session('rep0', '2026-09-24', ['FACT: memhub ใช้ Caddy เป็น reverse proxy บน box77']));
  await run('rep-a');
  await indexFile(db, session('rep1', '2026-09-24', ['FACT: memhub ใช้ Caddy เป็น reverse proxy บน box77']));
  await indexFile(db, session('rep2', '2026-09-24', ['FACT: memhub ใช้ Caddy เป็น reverse proxy บน box77']));
  const r = await run('rep-b');
  const f = (await factRows()).find((x) => x.source_uuids.some((u: string) => u.startsWith('rep0-')))!;
  for (const s of ['rep1-', 'rep2-']) assert.ok(f.source_uuids.some((u: string) => u.startsWith(s)), `${s} merged: ${JSON.stringify(r.stats)}`);
});

test('a session with one hidden transcript (Google seen) dreams only its visible one: hidden turns never reach the model', async () => {
  await indexFile(db, session('hd1', '2026-09-24', ['FACT: บริการ kappa ใช้พอร์ต 8800']));
  const p2 = join(tmp, 'proj3', 'hd1.jsonl');
  mkdirSync(join(tmp, 'proj3'), { recursive: true });
  writeFileSync(p2, (['user', 'assistant'] as const).map((type, i) => JSON.stringify({ type, uuid: `hd1-x${i}`, sessionId: 'hd1', timestamp: `2026-09-24T00:00:0${i}.000Z`, cwd: tmp,
    message: { role: type, content: type === 'user' ? 'FACT: SECRET-GMAIL ใบแจ้งหนี้ lambda' : [{ type: 'text', text: 'รับทราบ' }] } })).join('\n') + '\n');
  await indexFile(db, p2);
  await db.query(`UPDATE sources SET hide_as = 'google' WHERE path = $1`, [p2]);
  const seen: string[] = [];
  await dream(db, { llm: (req) => { seen.push(req.user); return fake(req); }, run: 'hd-1', force: true, now: NOW, log: () => {} });
  assert.ok(seen.join('\n').includes('kappa'), 'the visible transcript is dreamed');
  assert.ok(!seen.join('\n').includes('SECRET-GMAIL'));
});

test('two chats in one run replacing the same fact chain onto each other: one stays active, none is orphaned', async () => {
  await indexFile(db, session('sup0', '2026-09-20', ['FACT: memhub เก็บ backup ไว้ที่ไดรฟ์ E ทุกคืน']));
  await run('sup-a');
  await indexFile(db, session('sup1', '2026-09-21', ['FACT: เปลี่ยนแทน memhub เก็บ backup ไว้ที่ไดรฟ์ F ทุกคืน']));
  await indexFile(db, session('sup2', '2026-09-22', ['FACT: เปลี่ยนแทน memhub เก็บ backup ไว้ที่ไดรฟ์ G ทุกคืน']));
  const r = await run('sup-b');
  assert.equal(r.stats.SUPERSEDE, 2, JSON.stringify(r.stats));
  const of = (s: string) => async () => (await factRows()).find((x) => x.source_uuids.some((u: string) => u.startsWith(`${s}-`)))!;
  const [e, f, g] = await Promise.all(['sup0', 'sup1', 'sup2'].map((s) => of(s)()));
  assert.deepEqual([e.status, f.status, g.status], ['superseded', 'superseded', 'active']);
  assert.equal(f.superseded_by, g.fid); // G replaced F, not the already-replaced E
});
