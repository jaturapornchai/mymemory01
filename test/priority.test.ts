// Priority order in search(): project filter keeps curated facts, dream's neighbour lookup ignores the tier, curated slot,
// source chats under their fact (↳), and how memory_search prints them. Own throwaway schema + temp vault, keyword-only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-priority-'));
// own schema per run: a fixed name let a concurrent run DROP it mid-run → unqualified queries fell through to public (production)
const SCHEMA = `memhub_priority_test_${process.pid}`;
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
process.env.MEMHUB_MEMORY_VAULT = join(tmp, 'vault');
process.env.MEMHUB_VAULTS = '';
process.env.MEMHUB_NO_REINDEX = '1';
process.env.MEMORY_HUB_INTERNAL = '1';
const { connect, ROOT } = await import('../src/db.ts');
const { indexFile } = await import('../src/importer.ts');
const { saveNote, writeNote, md5, isGlobalFact, MEMORY_VAULT, MEMORY_PROJECT } = await import('../src/notes.ts');
const { indexVault } = await import('../src/obsidian.ts');
const { search, hitLine, isOtherProject, RANK } = await import('../src/search.ts');
const { searchText, briefLine, assocText } = await import('../src/mcp.ts');
const { compete } = await import('../src/synapse.ts');

const db = connect('rw');
/** Refuse to write anywhere but the scratch schema (search_path = <schema>,public falls back to public if it is gone). */
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');
const NOW = new Date('2026-09-25T00:00:00Z');
const dreamFact = (fid: string, text: string, extra: Record<string, string | string[]> = {}) => writeNote(`facts/demo/${fid}.md`, {
  memhub: 'fact', id: fid, kind: 'fact', scope: 'project', project: 'd:/demo', status: 'active', importance: '5',
  valid_at: NOW.toISOString(), created_at: NOW.toISOString(), source_uuids: [`${fid}-src`], md5: md5(text), run: 'r1', ...extra,
}, `${text}\n`);
const chat = async (id: string, text: string) => {
  const line = (type: string, uuid: string) => JSON.stringify({ type, uuid, sessionId: id, timestamp: '2026-09-20T00:00:00Z', cwd: 'D:\\demo',
    message: { role: type, content: type === 'user' ? text : [{ type: 'text', text: 'ok' }] } }) + '\n';
  writeFileSync(join(tmp, 'proj', `${id}.jsonl`), line('user', `${id}-u1`) + line('assistant', `${id}-u2`));
  await guard();
  await indexFile(db, join(tmp, 'proj', `${id}.jsonl`));
};

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  mkdirSync(join(tmp, 'proj'), { recursive: true });
  await chat('v1', 'quokkaport ต้องเป็น 5441');
  saveNote('กฎ: quokkaport ของ memhub คือ 5441 เท่านั้น', { project: 'd:/demo', kind: 'rule', now: NOW });
  // dream lookup: D matches 3 query terms, P 2 (superseded), R (ลุงจืด's rule, top tier) only 1
  dreamFact('Fd0000001', 'zuluterm yankeeterm xrayterm memo');
  dreamFact('Fd0000002', 'zuluterm yankeeterm placeholder', { status: 'superseded', superseded_by: 'Fd0000001' });
  saveNote('rule about zuluterm only', { project: 'd:/demo', kind: 'rule', now: NOW });
  // curated slot: 14 chats match both terms, the fact only one → it ranks below several chats on score alone
  for (let i = 0; i < 14; i++) await chat(`s${i}`, `walrusterm narwhalterm ${i}`);
  dreamFact('Fd0000003', 'walrusterm note');
  // fact text: a long body whose query term sits at its end, plus the wiki link lines dream writes
  dreamFact('Fd0000004', `HEADFIRST คำตอบอยู่ต้นข้อความ ${'ข้อความเติม filler '.repeat(30)}kiwiterm\n- from:: [[2026-09-20 demo abcd1234]]\n- related:: [[Fd0000003 some note]]`);
  // a chat is the source of an OLD decision (superseded by Fc0000002) and of an unrelated active fact
  await chat('c1', 'oryxport ตั้งเป็น 7001 ไปก่อน');
  dreamFact('Fc0000001', 'oryxport = 7001', { source_uuids: ['c1-u1'], status: 'superseded', superseded_by: 'Fc0000002' });
  dreamFact('Fc0000002', 'port moved to 7002 later', { source_uuids: ['c9-u1'] });
  dreamFact('Fc0000003', 'oryxport chat also set up logging', { source_uuids: ['c1-u1'] });
  // siblings: one chat is the source of a matching fact AND of a fact sharing only one query term
  await chat('sib', 'alphaq betaq gammaq deltaq');
  dreamFact('Fs0000001', 'alphaq betaq gammaq deltaq summary', { source_uuids: ['sib-u1'] });
  dreamFact('Fs0000002', 'gammaq unrelated memo', { source_uuids: ['sib-u1'] });
  await chat('ind1', 'alphaq betaq gammaq');
  await chat('ind2', 'alphaq betaq deltaq');
  for (let i = 0; i < 12; i++) await chat(`two${i}`, `alphaq betaq ${i}`); // 2 terms: between ind1 and the sibling on keyword rank
  // a source chat that says much more than its fact (steps) vs one that only repeats it
  await chat('long', 'mangoterm deploy: step 1 build the image with docker compose build, step 2 push it to the registry, step 3 restart the api service and watch the logs');
  dreamFact('Fm0000001', 'mangoterm deploy has 3 steps', { source_uuids: ['long-u1'] });
  await chat('dup', 'papayaterm port is 7100');
  dreamFact('Fm0000002', 'papayaterm port is 7100', { source_uuids: ['dup-u1'] });
  // token budget: a long fact with 4 long source chats, one marked as later changed
  for (let i = 0; i < 4; i++) await chat(`bud${i}`, `budgetterm ${'รายละเอียดยาวมาก long detail '.repeat(20)}${i}`);
  dreamFact('Fb0000001', `budgetterm ${'สรุปยาว summary '.repeat(40)}`, { source_uuids: ['bud0-u1', 'bud1-u1', 'bud2-u1', 'bud3-u1'] });
  dreamFact('Fb0000002', 'budgetterm old', { source_uuids: ['bud0-u1'], status: 'superseded', superseded_by: 'Fc0000002' });
  // supersede chain A → B → C: chat ch1 is the source of A (old) and of C (current); B came from another chat
  await chat('ch1', 'lynxport ตั้งเป็น 8001 ก่อน แล้วค่อยย้าย');
  dreamFact('Fa0000001', 'lynxport = 8001', { source_uuids: ['ch1-u1'], status: 'superseded', superseded_by: 'Fa0000002' });
  dreamFact('Fa0000002', 'lynxport = 8002', { source_uuids: ['ch2-u1'], status: 'superseded', superseded_by: 'Fa0000003' });
  dreamFact('Fa0000003', 'lynxport is 8003 now', { source_uuids: ['ch1-u1'] });
  // cross-project isolation: a chat in d:/demo matching 1 term vs a top-tier rule in d:/otherproj matching 2 terms
  await chat('inproj', 'falconkey ตั้งค่าในโปรเจกต์หลัก');
  dreamFact('Ff0000001', `falconkey eaglekey ในโปรเจกต์อื่น ${'รายละเอียดเพิ่มเติม '.repeat(25)}`, {
    project: 'd:/otherproj', kind: 'rule', pinned: 'true',
  });
  await guard();
  await indexVault(db, MEMORY_VAULT);
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

test('project filter keeps the curated facts of that project (their chunks live under obsidian/<vault>)', async () => {
  const { hits } = await search(db, 'quokkaport', { semantic: false, limit: 8, project: 'demo' });
  assert.ok(hits.some((h) => h.kind === 'rule'), JSON.stringify(hits.map((h) => h.kind ?? h.src_kind)));
  assert.ok(hits.some((h) => !h.fid), 'and its chats');
});

test('dream neighbour lookup (tier: 0) ranks by similarity, not by the priority tier', async () => {
  // 'เคย ': a question about the past keeps rank order (layers() would list the fact holding all 3 words first)
  const fids = async (tier?: number) => (await search(db, 'เคย zuluterm yankeeterm xrayterm', { project: MEMORY_PROJECT, limit: 12, semantic: false, perSession: 1, tier }))
    .hits.filter((x) => x.fid && x.status !== 'superseded').map((x) => x.kind);
  assert.equal((await fids(0))[0], 'fact');
  assert.equal((await fids())[0], 'rule', 'sanity: the tier alone lifts the rule above the closer fact');
});

test('curated slot: the best active fact close to the top result moves up to slot 2', async () => {
  const pos = async (past = '') => (await search(db, `${past}walrusterm narwhalterm`, { semantic: false, limit: 8 })).hits.findIndex((h) => h.fid === 'Fd0000003') + 1;
  const ratio = RANK.slotRatio;
  try { RANK.slotRatio = 99; assert.ok((await pos()) > 2, 'sanity: on score alone it is below slot 2'); }
  finally { RANK.slotRatio = ratio; }
  assert.equal(await pos('เคย '), RANK.slot, 'a question about the past keeps rank order: the slot');
  assert.equal(await pos(), 1, 'layers(): a ✓ fact that answers the query goes above the records');
});

test('a fact prints from its head: no "D: # F<id>" title line or wiki link lines, the fact id is the result id', async () => {
  const { hits } = await search(db, 'kiwiterm', { semantic: false, limit: 3 });
  assert.equal(hits[0]?.fid, 'Fd0000004');
  const [line, body] = searchText(hits, 'kiwiterm', true).split('\n');
  assert.ok(line.startsWith('[Fd0000004] '), line);
  assert.ok(body.startsWith('HEADFIRST'), body);
  assert.doesNotMatch(body, /D: #|from::|related::/);
});

test('a chat folded under a fact (↳) keeps its "later changed" warning', async () => {
  const q = 'oryxport';
  const { hits } = await search(db, q, { semantic: false, limit: 1 }); // limit 1: no room → the chat folds under the fact
  assert.equal(hits[0].fid, 'Fc0000003');
  assert.deepEqual(hits[0].evidence?.[0]?.changed_to, ['Fc0000002'], 'sanity: the chat is annotated as later changed');
  const lines = searchText(hits, q, true).split('\n');
  assert.match(lines.find((l) => l.startsWith('↳ source chat')) ?? '', /superseded by \[Fc0000002\]: later changed/);
  assert.ok(lines.slice(1).join('\n').length <= 402, 'one result stays within 400 chars (+ 2 cut marks) below its line');
});

test('"later changed" points at the current end of a supersede chain, never at an OLD link', async () => {
  const one = await search(db, 'lynxport', { semantic: false, limit: 1 });
  assert.equal(one.hits[0]?.fid, 'Fa0000003', 'sanity: the current fact is #1');
  const e = one.hits[0].evidence?.find((x) => x.session_id === 'ch1');
  assert.deepEqual(e?.changed_to, ['Fa0000003'], 'A → B → C resolves to C');
  const ev = searchText(one.hits, 'lynxport', true).split('\n').find((l) => l.startsWith('↳')) ?? '';
  assert.ok(ev, 'sanity: ↳ line printed');
  assert.doesNotMatch(ev, /later changed/, 'folded under C itself: no warning');
  assert.match(hitLine(e!), /superseded by \[Fa0000003\]: decision here later changed\)/, 'as a result of its own it points at C');
});

test('a fact with many long source chats still prints ≤ 400 chars (+ cut marks) below its line', async () => {
  const { hits } = await search(db, 'budgetterm', { semantic: false, limit: 1 });
  assert.equal(hits[0].fid, 'Fb0000001');
  assert.equal(hits[0].evidence?.length, 4, 'sanity: all 4 chats fold under it');
  const below = searchText(hits, 'budgetterm', true).split('\n').slice(1);
  assert.ok(below.join('\n').length <= 402, `${below.join('\n').length} chars: ${below.map((l) => l.length)}`);
  assert.match(below.at(-1)!, /^↳ source chat .*\+3 more: \S/);
});

test('a chat lifts only its best fact: a sibling matching 1 of 4 terms stays below an independent chat matching 3', async () => {
  const { hits } = await search(db, 'alphaq betaq gammaq deltaq', { semantic: false, limit: 8 });
  const weak = hits.findIndex((h) => h.fid === 'Fs0000002'), ind = hits.findIndex((h) => h.session_id === 'ind1');
  assert.ok(ind >= 0, 'sanity: the independent chat is shown');
  assert.ok(weak < 0 || ind < weak, JSON.stringify(hits.map((h) => h.fid ?? h.session_id)));
  assert.ok(hits.find((h) => h.fid === 'Fs0000001')?.evidence?.some((e) => e.session_id === 'sib'), 'the source chat folds under the best fact');
});

test('a source chat that says more than its fact keeps its own slot when it fits; a duplicate folds', async () => {
  const long = await search(db, 'mangoterm deploy', { semantic: false, limit: 8 });
  assert.equal(long.hits[0].fid, 'Fm0000001');
  assert.ok(long.hits.some((h) => h.session_id === 'long'), 'own slot at limit 8');
  const one = await search(db, 'mangoterm deploy', { semantic: false, limit: 1 });
  assert.ok(one.hits[0].evidence?.some((e) => e.session_id === 'long'), 'no room at limit 1 → folded');
  const dup = await search(db, 'papayaterm port', { semantic: false, limit: 8 });
  assert.equal(dup.hits[0].fid, 'Fm0000002');
  assert.ok(dup.hits[0].evidence?.some((e) => e.session_id === 'dup') && !dup.hits.some((h) => h.session_id === 'dup'), 'duplicate → ↳');
});

test('GitHub docs are labelled github repo / commits / issue/PR, not chat', async () => {
  const { hits } = await search(db, 'quokkaport', { semantic: false, limit: 1 });
  assert.ok(hits[0].tool, 'search returns the source tool');
  const doc = (session_id: string) => hitLine({ ...hits[0], fid: null, kind: null, project: 'github/o/r', tool: 'github', src_kind: 'doc', session_id, changed_to: null, layer: undefined });
  assert.match(doc('github:o/r'), /\| บันทึก github repo/);
  assert.match(doc('github:o/r:commits'), /\| บันทึก github commits/);
  assert.match(doc('github:o/r#12'), /\| บันทึก github issue\/PR/);
});

test('currentProject priority: in-project hit beats out-of-project rule; out-of-project hit prints compact summary', async () => {
  const { hits } = await search(db, 'falconkey eaglekey', { semantic: false, limit: 8, currentProject: 'd:/demo' });
  assert.equal(hits[0]?.session_id, 'inproj', 'currentProject chat ranks #1 ahead of other-project pinned rule');
  const other = hits.find((h) => h.fid === 'Ff0000001')!;
  assert.ok(other && hits.indexOf(other) > 0, 'other-project hit ranks below currentProject hit');
  const rendered = searchText(hits, 'falconkey eaglekey', true, undefined, 'd:/demo');
  assert.match(rendered, /\[Ff0000001\][^\n]*\| นอกโปรเจกต์\nเคยคุยในโปรเจกต์ "otherproj" \(2026-09-25, rule\): /);
  // [1] naming the other project explicitly in query lifts the penalty and renders full text
  const named = await search(db, 'otherproj falconkey eaglekey', { semantic: false, limit: 8, currentProject: 'd:/demo' });
  assert.equal(named.hits[0]?.fid, 'Ff0000001', 'explicitly named project in query is not penalized');
  const namedText = searchText(named.hits, 'otherproj falconkey eaglekey', true, undefined, 'd:/demo');
  assert.doesNotMatch(namedText, /\| นอกโปรเจกต์|เคยคุยในโปรเจกต์/, 'explicitly named project renders full content');
  // [2] briefLine and assocText tag out-of-project hits when currentProject is active
  const bl = briefLine(other, 'falconkey', new Map([[other.id, 50]]), undefined, 'd:/demo');
  assert.match(bl, /นอกโปรเจกต์ \(เคยคุยใน "otherproj"\): /);
  const al = assocText([{ chunk: { ...other, source_id: '1' }, via: 'inproj', kind: 'entity', act: 0.5 }], 'falconkey', 'd:/demo');
  assert.match(al, /นอกโปรเจกต์ \(เคยคุยใน "otherproj"\): /);
  // [3] compete() scales down out-of-project proposals vs in-project hits
  const top6 = Array.from({ length: 6 }, () => hits[0]);
  const comp = compete([...top6, hits[0]], {
    props: [{ chunk: { ...other, source_id: '2' }, via: 'inproj', kind: 'entity', act: 0.8, sim: 0.8 }],
    sims: new Map([[hits[0].id, 0.5]]),
  }, { n: 7, keep: 6, theta: 0.05, bonus: 0.3, currentProject: 'd:/demo', query: 'falconkey' });
  assert.equal(comp[6]?.session_id, 'inproj', 'in-project hit keeps slot 7 against out-of-project proposal');
  // [4] proj_basename SQL function and expression indexes exist on chunks and facts
  const idx = (await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname IN ('chunks_proj_name', 'facts_proj_name') ORDER BY 1`, [SCHEMA])).rows.map((r) => r.indexname);
  assert.deepEqual(idx, ['chunks_proj_name', 'facts_proj_name']);
  const bn = (await db.query(`SELECT proj_basename('D:\\work/My-App') a, proj_basename('/Users/jead/My-App') b`)).rows[0];
  assert.equal(bn.a, 'my-app');
  assert.equal(bn.b, 'my-app');
  // [5] saveNote auto-detects global rules and personal facts even when called inside a project
  assert.equal(isGlobalFact('กฎเหล็ก: ห้าม hardcode secret ทุกโปรเจกต์'), true);
  assert.equal(isGlobalFact('แก้บั๊กหน้าใบกำกับภาษีในระบบนี้'), false);
  const autoGlob = saveNote('กฎเหล็ก: ใช้กับทุกโปรเจกต์ autoglobtest', { project: 'd:/demo', kind: 'rule', now: NOW });
  assert.match(autoGlob, /^facts\/_global\//, 'global hint saves under facts/_global/ even when project is passed');
});

test('currentProject priority spans the project tree: a sub-folder session sees its parent project (and vice versa) as in-project; catch-alls never span', async () => {
  // ลุงจืด 2026-10-18: sessions in D:\botstery\stories\x work on botstery, so botstery memories must not rank as another project's
  const { hits } = await search(db, 'falconkey eaglekey', { semantic: false, limit: 8, currentProject: 'd:/demo/sub' });
  assert.equal(hits[0]?.session_id, 'inproj', 'parent-project chat ranks #1 from a sub-folder session');
  const rendered = searchText(hits, 'falconkey eaglekey', true, undefined, 'd:/demo/sub');
  assert.doesNotMatch(rendered, /เคยคุยในโปรเจกต์ "demo"/, 'parent-project hit is not tagged out-of-project');
  const h = (project: string) => ({ project, fact_project: undefined, fid: undefined, tool: 'claude' });
  assert.equal(isOtherProject(h('d:/demo'), 'd:/demo/sub'), false, 'parent folder is the same project');
  assert.equal(isOtherProject(h('d:/demo/sub/deep'), 'd:/demo'), false, 'child folder is the same project');
  assert.equal(isOtherProject(h('d:/demo2'), 'd:/demo'), true, 'sibling sharing a prefix is another project');
  // SQL side, child direction: a fact filed under d:/demo/sub beats another project's pinned rule when searched from d:/demo
  dreamFact('Ff0000002', 'kestrelkey อยู่ใน sub-folder ของโปรเจกต์หลัก', { project: 'd:/demo/sub' });
  dreamFact('Ff0000003', 'kestrelkey อยู่ในโปรเจกต์อื่น', { project: 'd:/otherproj', kind: 'rule', pinned: 'true' });
  await guard();
  await indexVault(db, MEMORY_VAULT);
  const sub = await search(db, 'kestrelkey', { semantic: false, limit: 8, currentProject: 'd:/demo' });
  assert.equal(sub.hits[0]?.fid, 'Ff0000002', 'child-folder fact ranks #1 from the parent project');
  assert.equal(isOtherProject(h('c:/tmp/scratch'), 'c:/tmp'), true, 'c:/tmp is a catch-all: its sub-folders are separate');
  assert.equal(isOtherProject(h('d:/otherproj'), 'd:'), true, 'drive root is a catch-all');
});
