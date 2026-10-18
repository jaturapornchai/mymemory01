// The nightly hub page as a playbook (ลุงจืด 2026-10-18 "ตอน dream ต้องสรุปเป็น kms หรือ skill ที่ ai เอาไปใช้ได้เลย … คิดเหมือนลุงจืด"):
// current items only, in rules / ห้ามทำ / his preferences / knowledge / howto; replaced ones only as "→ X แทน"; unresolved
// conflicts and pending proposals under ถามลุงจืดก่อน; every line [fid] day คำลุงจืด|AI-only. Scratch schema + temp vault.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'memhub-plbk-'));
const SCHEMA = `memhub_plbk_test_${process.pid}`;
Object.assign(process.env, { MEMHUB_PG_SCHEMA: SCHEMA, MEMHUB_MEMORY_VAULT: join(tmp, 'vault'), MEMHUB_VAULTS: '', MEMHUB_NO_REINDEX: '1', MEMORY_HUB_INTERNAL: '1' });
const { connect, ROOT } = await import('../src/db.ts');
const { md5, writeNote, MEMORY_VAULT } = await import('../src/notes.ts');
const { indexVault } = await import('../src/obsidian.ts');
const { consolidate, hubName } = await import('../src/dream.ts');

const db = connect('rw');
type O = { at?: string; his?: boolean; global?: boolean; status?: string; superseded_by?: string; review_target?: string };
/** his = no chat behind it (a memory_save note); otherwise a dreamed fact citing a turn that is not his = AI-only. */
function fact(fid: string, kind: string, text: string, o: O = {}) {
  const at = `${o.at ?? '2026-10-01'}T03:00:00Z`;
  writeNote(`facts/plbk/${fid}.md`, { memhub: 'fact', id: fid, kind, scope: o.global ? 'global' : 'project', ...(o.global ? {} : { project: 'd:/plbk' }),
    status: o.status ?? 'active', valid_at: at, created_at: at, md5: md5(text), ...(o.his ? {} : { source_uuids: [`u-${fid}`], run: 'r1' }),
    ...(o.superseded_by ? { superseded_by: o.superseded_by } : {}), ...(o.review_target ? { review_target: o.review_target } : {}) }, `${text}\n`);
}
const F = { rule: 'Fa1000001', dont: 'Fa1000002', pref: 'Fa1000003', howto: 'Fa1000004', pick: 'Fa1000005', oldHost: 'Fa1000006', port1: 'Fa1000007',
  port2: 'Fa1000008', c1: 'Fa1000009', c2: 'Fa100000a', a1: 'Fa100000b', a2: 'Fa100000c', pend: 'Fa100000d', glob: 'Fa100000e' };

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  fact(F.rule, 'rule', 'plbktest: ทุกครั้งก่อน deploy ต้องรัน zorbacheck', { his: true });
  fact(F.dont, 'rule', 'plbktest: ห้าม push ตรงเข้า main ของ zorba', { his: true });
  fact(F.pref, 'preference', 'plbktest: ลุงจืดชอบรายงาน zorba สั้นเป็นข้อ ๆ');
  fact(F.howto, 'howto', 'plbktest: deploy zorba ด้วย zorbactl up --prod');
  fact(F.pick, 'decision', 'plbktest: เลือกใช้ new-zorba.example แทน old-zorba.example', { his: true, at: '2026-10-05' });
  fact(F.oldHost, 'fact', 'plbktest: API ของ zorba อยู่ที่ old-zorba.example', { at: '2026-09-10' });
  fact(F.port1, 'fact', 'plbktest: zorba ใช้พอร์ต 7001', { status: 'superseded', superseded_by: F.port2, at: '2026-09-02' });
  fact(F.port2, 'fact', 'plbktest: zorba ใช้พอร์ต 7002', { at: '2026-09-12' });
  fact(F.c1, 'decision', 'plbktest: zorba ไม่ส่งข้อมูลให้ quxsys', { his: true, at: '2026-09-01' });
  fact(F.c2, 'decision', 'plbktest: zorba ส่งยอดให้ quxsys ทุกคืน', { his: true, at: '2026-09-20' });
  fact(F.a1, 'fact', 'plbktest: zorba เก็บไฟล์ไว้ที่ blobsys', { his: true, at: '2026-09-01' });
  fact(F.a2, 'fact', 'plbktest: zorba ย้ายไฟล์ออกจาก blobsys หมดแล้ว', { at: '2026-09-20' });
  fact(F.pend, 'rule', 'plbktest: ก่อน deploy zorba ต้องรัน zorbacheck --full', { status: 'pending', review_target: F.rule });
  fact(F.glob, 'rule', 'plbktest: ทุกโปรเจกต์ตอบเป็นภาษาไทย', { his: true, global: true });
  await indexVault(db, MEMORY_VAULT);
  for (const [x, y, on] of [[F.c1, F.c2, 'quxsys'], [F.a1, F.a2, 'blobsys']]) // accuracy.ts flags, both ways
    await db.query(`INSERT INTO state (k, v) VALUES ($1, $2), ($3, $4)`, [`conflict:${x}`, { with: [y], on: [on] }, `conflict:${y}`, { with: [x], on: [on] }]);
  await consolidate(db);
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

const hub = (name: string) => readFileSync(join(MEMORY_VAULT, 'hubs', `${name} hub.md`), 'utf8');
const section = (body: string, title: string) => body.split(/^## /m).find((s) => s.startsWith(title)) ?? '';

test('hub = playbook: each current item in its section, every line [fid] day คำลุงจืด|AI-only', () => {
  const b = hub('plbk');
  const rules = section(b, 'กฎล่าสุด'), dont = section(b, 'ห้ามทำ'), pref = section(b, 'ลุงจืดชอบ'), know = section(b, 'ความรู้'), how = section(b, 'วิธีทำ');
  assert.match(rules, new RegExp(`- \\[${F.rule}\\] 2026-10-01 คำลุงจืด — plbktest: ทุกครั้งก่อน deploy ต้องรัน zorbacheck`), b);
  assert.match(dont, new RegExp(`- \\[${F.dont}\\] 2026-10-01 คำลุงจืด — plbktest: ห้าม push`));
  assert.match(pref, new RegExp(`- \\[${F.pref}\\] 2026-10-01 AI-only — plbktest: ลุงจืดชอบ`));
  assert.match(how, new RegExp(`- \\[${F.howto}\\] 2026-10-01 AI-only — plbktest: deploy zorba`));
  for (const id of [F.pick, F.port2, F.c2]) assert.match(know, new RegExp(`- \\[${id}\\] `), id);
  const main = rules + dont + pref + know + how;
  for (const id of [F.port1, F.oldHost, F.c1, F.a1, F.a2, F.pend, F.glob]) assert.doesNotMatch(main, new RegExp(id), id);
  assert.doesNotMatch(rules, new RegExp(F.dont));
  for (const l of b.split('\n').filter((x) => /^\s*- \[/.test(x))) assert.match(l, /^\s*- \[[FS][0-9a-f]{8}\] \d{4}-\d{2}-\d{2} (คำลุงจืด|AI-only|การ์ดเซสชัน)/, l);
});

test('replaced → its replacement; unresolved conflicts and pending proposals → ask him first', () => {
  const b = hub('plbk'), old = section(b, 'เลิกใช้แล้ว'), ask = section(b, 'ถามลุงจืดก่อน');
  assert.match(old, new RegExp(`- \\[${F.port1}\\] 2026-09-02 AI-only — plbktest: zorba ใช้พอร์ต 7001 → ใช้ \\[${F.port2}\\] แทน`), b);
  assert.match(old, new RegExp(`- \\[${F.c1}\\] 2026-09-01 คำลุงจืด — [^\\n]* → น่าจะเลิกใช้: \\[${F.c2}\\] 2026-09-20 ใหม่กว่า 19 วัน`));
  assert.match(old, new RegExp(`- \\[${F.oldHost}\\] 2026-09-10 AI-only — [^\\n]* → น่าจะเลิกใช้: \\[${F.pick}\\] 2026-10-05 บอกว่า old-zorba\\.example เลิกใช้แล้ว`));
  // his older fact vs an AI-only one 19 days newer: no verdict, he decides
  assert.match(ask, new RegExp(`- \\[${F.a2}\\] 2026-09-20 AI-only — [^\\n]*ขัดกันเรื่อง blobsys กับ:\\n\\s+- \\[${F.a1}\\] 2026-09-01 คำลุงจืด — `), b);
  assert.match(ask, new RegExp(`- \\[${F.pend}\\] 2026-10-01 AI-only — [^\\n]*AI เสนอให้แทน \\[${F.rule}\\]`));
});

test('global rules live in the global hub; a project hub points there', () => {
  assert.match(section(hub('global'), 'กฎล่าสุด'), new RegExp(`- \\[${F.glob}\\] 2026-10-01 คำลุงจืด — `));
  assert.doesNotMatch(hub('plbk'), new RegExp(F.glob));
  assert.match(hub('plbk'), /\[\[global hub\]\]/);
  assert.equal(hubName(''), 'global hub'); // a card of no project links the file the global hub is written to
});
