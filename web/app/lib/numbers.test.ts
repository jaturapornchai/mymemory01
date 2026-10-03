// node --test for lib/numbers.ts (the "ตัวเลขสมอง" rows). Run: npm test (in web/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtBytes } from './format.ts';
import { numberGroups } from './numbers.ts';

const GB = 1024 ** 3, MB = 1024 ** 2;
const at = Date.UTC(2026, 9, 3, 12) / 1000;
const full = {
  textChars: 40_301_826, facts: 535, rules: 94, vaultNotes: 312, memories: 787, notes: 774, firstChat: Date.UTC(2026, 3, 30) / 1000,
  ghRepos: 368, ghPriv: 262, ghOrgs: 3, ghMine: 131, ghCmt: 3883, ghIss: 73,
  dbBytes: 1.1 * GB, turnsBytes: 72 * MB, chunksBytes: 360 * MB, hnswBytes: 115 * MB, idxBytes: 89 * MB, copyBytes: 449 * MB,
  rawBytes: 16.8 * GB, rawFiles: 17_046, vectors: 43_811, dims: 1024, p50ms: 60, p95ms: 2042, timed7d: 8,
};
const flat = (groups: ReturnType<typeof numberGroups>) => Object.fromEntries(groups.flatMap((g) => g.rows.map((r) => [r.label, r.value])));

test('fmtBytes: 1024-based, one decimal at most', () => {
  assert.deepEqual([0, 512, 1536, 95.2 * MB, 1.16 * GB, 16.83 * GB].map(fmtBytes), ['0 B', '512 B', '1.5 KB', '95.2 MB', '1.2 GB', '16.8 GB']);
});

test('numberGroups: every number, grouped, plain Thai', () => {
  const g = numberGroups(full, 'bge-m3', at);
  assert.deepEqual(g.map((x) => x.name), ['ความจำ', 'GitHub', 'พื้นที่เก็บ', 'ความเร็ว']);
  const v = flat(g);
  assert.equal(v['ข้อความที่จำไว้'], '40.3 ล้านตัวอักษร ≈ หนังสือ 81 เล่ม');
  assert.equal(v['เริ่มจำแชตตั้งแต่'], '30 เม.ย. 2569 (156 วัน)');
  assert.equal(v['repo ทั้งหมด'], '368 (ส่วนตัว 262)');
  assert.equal(v['commit ของเจ้าของ'], '3,883');
  assert.equal(v['ฐานข้อมูล PostgreSQL'], '1.1 GB');
  assert.equal(v['สำเนาไว้ทดสอบ'], '449 MB');
  assert.equal(v['ส่วนอื่น ๆ'], fmtBytes(1.1 * GB - (72 + 360 + 115 + 89 + 449) * MB));
  assert.equal(v['ไฟล์ต้นฉบับที่สำรองไว้'], '16.8 GB · 17,046 ไฟล์');
  assert.equal(v['เวกเตอร์'], '43,811 ชิ้น × 1,024 ตัวเลข (bge-m3)');
  // 8 timed searches: p95 would be the slowest one, so only the median shows, with a caveat
  assert.deepEqual([v['ปกติค้นเสร็จใน'], v['ครั้งที่ช้า ไม่เกิน']], ['0.06 วินาที', undefined]);
  assert.match(g[3].rows[0].tip, /วัดได้ 8 ครั้ง/);
  assert.equal(flat(numberGroups({ ...full, timed7d: 20 }, 'bge-m3', at))['ครั้งที่ช้า ไม่เกิน'], '2.04 วินาที');
  // the facts row explains the HUD's memory count; rules are a part of the facts, not added to them
  assert.match(g[0].rows[1].tip, /จาก 787 จุดความจำ/);
  assert.deepEqual([g[0].rows[2].value, g[0].rows[2].sub], ['94', true]);
  assert.match(g[2].rows[0].tip, /ความจำจริงราว /);
  // the storage breakdown: bars as shares of the database, together the whole of it
  const bars = g[2].rows.filter((r) => r.w !== undefined);
  assert.equal(bars.length, 6);
  assert.ok(Math.abs(bars.reduce((a, r) => a + r.w!, 0) - 1) < 1e-9);
  assert.ok(g.every((x) => x.rows.every((r) => r.tip.length > 0)));
  assert.match(g[0].rows[0].tip, /500,000 ตัวอักษร/); // the book assumption is stated
});

test('numberGroups: an older export (no new numbers) keeps only what it has', () => {
  const g = numberGroups({ dbBytes: 1.1 * GB, vectors: 10 }, undefined, at);
  assert.deepEqual(g.map((x) => [x.name, x.rows.map((r) => r.label)]), [['พื้นที่เก็บ', ['ฐานข้อมูล PostgreSQL']]]);
  assert.deepEqual(numberGroups({}, undefined, at), []);
});

test('numberGroups: no timed searches, no model, no private count, small text', () => {
  const { p50ms, p95ms, timed7d, ghPriv, ...rest } = full;
  const v = flat(numberGroups({ ...rest, textChars: 1200 }, undefined, at));
  assert.equal(v['ปกติค้นเสร็จใน'], undefined);
  assert.equal(v['repo ทั้งหมด'], '368');
  assert.equal(v['เวกเตอร์'], '43,811 ชิ้น × 1,024 ตัวเลข');
  assert.equal(v['ข้อความที่จำไว้'], '1,200 ตัวอักษร');
  assert.ok(!numberGroups(rest, undefined, at).some((x) => x.name === 'ความเร็ว'));
});
