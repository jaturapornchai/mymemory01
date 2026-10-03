// Pure: a synthetic Maps Timeline export (fake coordinates: a home province, a 3-day trip to another one, a fuel stop,
// a trip abroad with flights) + synthetic GeoNames-format rows (test/fixtures/geonames) → sync() → parse(). No network, no Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clean } from '../src/importer.ts';
import { isTranscript, parse, sync } from '../src/tools/google-timeline.ts';

process.env.MEMHUB_GEONAMES_DIR = join(import.meta.dirname, 'fixtures', 'geonames');
const root = mkdtempSync(join(tmpdir(), 'memhub-timeline-test-'));
const archive = join(root, 'ai-archive', 'raw', 'google-timeline'), inbox = join(root, 'ai-archive', 'inbox', 'google-timeline');
const other = join(root, 'onedrive', 'Timeline.json');
test.after(() => rmSync(root, { recursive: true, force: true }));

const HOME = 'geo:10.000500,100.000500', NEAR = 'geo:10.001000,100.001000', TOWN = 'geo:10.030000,100.030000';
const SURAT = 'geo:11.000500,100.000500', SEOUL = 'geo:35.000500,135.000500';
const t = (day: string, hm: string, tz = '+07:00') => `${day}T${hm}:00.000${tz}`;
const visit = (s: string, e: string, at: string, semanticType = 'Unknown', placeID = 'fakePlace', hierarchyLevel = '0') =>
  ({ startTime: s, endTime: e, visit: { hierarchyLevel, probability: '0.9', topCandidate: { probability: '0.8', semanticType, placeID, placeLocation: at } } });
const home = (s: string, e: string) => visit(s, e, HOME, 'Home', 'fakeHomeId');
const act = (s: string, e: string, from: string, to: string, type: string, m: number) =>
  ({ startTime: s, endTime: e, activity: { probability: '0.9', start: from, end: to, distanceMeters: String(m), topCandidate: { type, probability: '0.9' } } });

const feb = Array.from({ length: 28 }, (_, i) => `2026-02-${String(i + 1).padStart(2, '0')}`).map((d) => home(t(d, '00:00'), t(d, '23:59')));
const march = [
  home(t('2026-03-01', '00:00'), t('2026-03-01', '09:00')),
  act(t('2026-03-01', '09:00'), t('2026-03-01', '09:15'), HOME, NEAR, 'walking', 300),
  visit(t('2026-03-01', '09:15'), t('2026-03-01', '10:00'), NEAR), // ≈ 80 m from home → บ้าน
  act(t('2026-03-01', '10:00'), t('2026-03-01', '10:20'), NEAR, TOWN, 'in passenger vehicle', 6000),
  visit(t('2026-03-01', '10:20'), t('2026-03-01', '12:00'), TOWN),
  home(t('2026-03-01', '12:20'), t('2026-03-01', '23:59')),
  home(t('2026-03-05', '00:00'), t('2026-03-05', '07:00')),
  act(t('2026-03-05', '07:00'), t('2026-03-05', '13:00'), HOME, SURAT, 'in passenger vehicle', 150_000),
  visit(t('2026-03-05', '13:00'), t('2026-03-06', '09:00'), SURAT), // crosses midnight
  visit(t('2026-03-06', '10:00'), t('2026-03-06', '18:00'), SURAT),
  visit(t('2026-03-06', '18:30'), t('2026-03-07', '08:00'), SURAT),
  act(t('2026-03-07', '08:00'), t('2026-03-07', '14:00'), SURAT, HOME, 'in passenger vehicle', 150_000),
  home(t('2026-03-07', '14:00'), t('2026-03-07', '23:59')),
  home(t('2026-03-20', '00:00'), t('2026-03-20', '10:00')),
  visit(t('2026-03-20', '10:30'), t('2026-03-20', '10:35'), SURAT), // 5-min stop: no trip
  home(t('2026-03-20', '11:00'), t('2026-03-20', '23:59')),
];
const april = [
  home(t('2026-04-10', '00:00'), t('2026-04-10', '06:00')),
  act(t('2026-04-10', '08:00'), t('2026-04-10', '16:00', '+09:00'), HOME, SEOUL, 'flying', 4_000_000),
  visit(t('2026-04-10', '17:00', '+09:00'), t('2026-04-11', '09:00', '+09:00'), SEOUL),
  visit(t('2026-04-11', '10:00', '+09:00'), t('2026-04-11', '20:00', '+09:00'), SEOUL),
  visit(t('2026-04-11', '11:00', '+09:00'), t('2026-04-11', '12:00', '+09:00'), SEOUL, 'Unknown', 'fakeNested', '1'), // nested: dropped
  visit(t('2026-04-11', '21:00', '+09:00'), t('2026-04-12', '08:00', '+09:00'), SEOUL),
  visit(t('2026-04-11', '21:00', '+09:00'), t('2026-04-12', '08:00', '+09:00'), SEOUL, 'Unknown', 'fakeTwin', '1'), // same times as its parent: both merged
  act(t('2026-04-12', '10:00', '+09:00'), t('2026-04-12', '14:00'), SEOUL, HOME, 'flying', 4_000_000),
  home(t('2026-04-12', '16:00'), t('2026-04-12', '23:59')),
  { startTime: t('2026-04-12', '14:00'), endTime: t('2026-04-12', '16:00'), timelinePath: [{ point: HOME, durationMinutesOffsetFromStartTime: '0' }] },
];
const write = (f: string, segs: unknown[], mtime: number) => {
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, JSON.stringify(segs, null, 2));
  utimesSync(f, mtime, mtime);
};
const exportsDir = join(archive, 'exports');
const snap = (f: string) => [readFileSync(f, 'utf8'), statSync(f).mtimeMs];

test('sync: nothing there → no throw, inbox created', () => {
  delete process.env.MEMHUB_TIMELINE_FILES;
  assert.deepEqual(sync(archive), {});
  assert.deepEqual(readdirSync(inbox), []);
});

test('sync: inbox + MEMHUB_TIMELINE_FILES copied append-only, merged de-duplicated, sources never touched', () => {
  write(join(inbox, 'Timeline.json'), [...feb, ...march], 1_770_000_000); // older export: Feb–Mar
  write(other, [...feb, ...march, ...april], 1_780_000_000);             // newer superset, same file name
  writeFileSync(join(inbox, 'notes.json'), '{"not":"a timeline"}');
  process.env.MEMHUB_TIMELINE_FILES = `${other}; ${join(root, 'gone.json')}`;
  const before = [snap(join(inbox, 'Timeline.json')), snap(other)];
  assert.deepEqual(sync(archive), { copied: 3, missing: 1, invalid: 1, merged: 1, segments: feb.length + march.length + april.length - 1 });
  assert.equal(readdirSync(exportsDir).filter((f) => f.endsWith('-Timeline.json')).length, 2, 'two sources named Timeline.json, two archive copies');
  assert.deepEqual(sync(archive), { unchanged: 3, missing: 1 }, 'hourly no-change path: no merge');

  write(join(inbox, 'Timeline.json'), [...feb, ...march, ...april], 1_790_000_000); // re-export with the same name
  assert.deepEqual(sync(archive), { conflicts: 1, unchanged: 2, missing: 1, invalid: 1, segments: feb.length + march.length + april.length - 1 }, 'same segments: merged file untouched');
  assert.equal(readdirSync(exportsDir).filter((f) => f.endsWith('.bak')).length, 1, 'old copy kept');
  assert.deepEqual(snap(other), before[1], 'source export never modified');
  const merged = JSON.parse(readFileSync(join(archive, 'timeline.json'), 'utf8'));
  assert.ok(merged.every((s: any) => !s.timelinePath), 'raw GPS trail stays in the raw copies only');
  assert.ok(isTranscript(join(archive, 'timeline.json')));
  for (const f of readdirSync(exportsDir)) assert.ok(!isTranscript(join(exportsDir, f)), f);
});

test('parse: trips, days, months, places — Thai + English names, home = บ้าน, no coordinates or place ids', async () => {
  const p = (await parse(join(archive, 'timeline.json')))!;
  assert.equal(p.sessionId, 'google-timeline'); assert.equal(p.kind, 'doc'); assert.equal(p.cwd, 'google/timeline');
  assert.ok(p.msgs.every((m, i) => m.role === 'note' && m.parentUuid === (p.msgs[i - 1]?.uuid ?? null)));
  assert.equal(new Set(p.msgs.map((m) => m.uuid)).size, p.msgs.length);
  const text = (id: string) => p.msgs.find((m) => m.uuid === `google-timeline:${id}`)?.text ?? '';
  const all = p.msgs.map((m) => m.text).join('\n');
  assert.doesNotMatch(all, /geo:|\d\.\d{4,}|fake(Home|Place|Nested)/);
  assert.ok(p.msgs.every((m) => clean(m.text, true) === m.text), 'personal redaction leaves the timeline text alone');

  assert.match(text('places'), /^สถานที่ที่เคยไป · ข้อมูล Google Maps Timeline 1 ก.พ.–12 เม.ย. 2026 .*\nไปต่างประเทศครั้งล่าสุดเมื่อไหร่: 10–12 เม.ย. 2026 เกาหลีใต้ \(South Korea\)\nต่างประเทศ: เกาหลีใต้ \(South Korea\) 10–12 เม.ย. 2026\nจังหวัด: ระนอง, สุราษฎร์ธานี \(สุราษฎร์\)$/);
  assert.match(text('place:TH.02'), /^ไปสุราษฎร์ธานีเมื่อไหร่ · ไปสุราษฎร์เมื่อไหร่ · เคยไปสุราษฎร์ธานีไหม\nเคยไป สุราษฎร์ธานี \(สุราษฎร์, Surat Thani\) 1 ครั้ง: 5–7 มี.ค. 2026\n/, 'the 5-min stop on 20 Mar is no trip');
  assert.match(text('place:KR'), /^ไปเกาหลีใต้เมื่อไหร่ · เคยไปเกาหลีใต้ไหม\nเคยไป เกาหลีใต้ \(South Korea\) 1 ครั้ง: 10–12 เม.ย. 2026\n/);
  assert.match(text('place:TH.01'), /^ไประนองเมื่อไหร่ · เคยไประนองไหม\nระนอง \(Ranong\) = จังหวัดที่อยู่ \(บ้าน\) · ไป 34 จาก 36 วันที่มีข้อมูล/);
  assert.equal(p.msgs.filter((m) => m.uuid.includes(':trip:')).length, 2);
  assert.equal(text('trip:2026-04-10:KR'), [
    'ทริป เกาหลีใต้ (South Korea) 10–12 เม.ย. 2026 · 3 วัน (2026-04-10 → 2026-04-12)',
    'เกาหลีใต้ (South Korea) 10–12 เม.ย.: โซล (Seoul)',
    'บิน: 10 เม.ย. 08:00 ระนอง → เกาหลีใต้ โซล (Seoul) 4,000 กม.; 12 เม.ย. 10:00 เกาหลีใต้ โซล (Seoul) → ระนอง 4,000 กม.',
    'เดินทาง (อย่างน้อย): เครื่องบิน 8,000 กม.',
  ].join('\n'));
  assert.match(text('trip:2026-03-05:TH.02'), /^ทริป สุราษฎร์ธานี \(สุราษฎร์, Surat Thani\) 5–7 มี.ค. 2026 · 3 วัน .*\n.*\nเดินทาง \(อย่างน้อย\): ขับรถ\/นั่งรถ 300 กม\.$/);

  assert.equal(text('day:2026-03-01'), [
    'Google Maps Timeline อา. 1 มี.ค. 2026 (2026-03-01) · ระนอง',
    '00:00–09:00 9ชม. บ้าน', '09:15–10:00 45น. บ้าน', '↳ ขับรถ/นั่งรถ 6.0 กม.', '10:20–12:00 1ชม.40น. อ.เมืองระนอง จ.ระนอง',
    '12:20–23:59 11ชม.39น. บ้าน', 'รวม (อย่างน้อย): ขับรถ/นั่งรถ 6.0 กม.',
  ].join('\n'), 'a walk < 1 km is not a line; the visit 80 m from home is บ้าน');
  assert.equal(text('day:2026-03-06').split('\n').slice(1).join('\n'),
    '00:00–09:00 9ชม. อ.เมืองสุราษฎร์ธานี จ.สุราษฎร์ธานี\n10:00–18:00 8ชม. อ.เมืองสุราษฎร์ธานี จ.สุราษฎร์ธานี\n18:30–24:00 5ชม.30น. อ.เมืองสุราษฎร์ธานี จ.สุราษฎร์ธานี', 'split at local midnight, no duplicates across exports');
  assert.match(text('day:2026-04-11'), /^Google Maps Timeline ส\. 11 เม\.ย\. 2026 \(2026-04-11\) · เกาหลีใต้ \(South Korea\)\n00:00–09:00 9ชม\. โซล \(Seoul\), Seoul เกาหลีใต้\n10:00–20:00 /, 'Korea local time');
  assert.doesNotMatch(text('day:2026-04-11'), /11:00–12:00/, 'hierarchyLevel 1 dropped');
  assert.match(text('day:2026-04-11'), /\n21:00–24:00 3ชม\. โซล/, 'a level-0 visit survives the merge next to its same-time level-1 twin');
  assert.equal(text('year:2026'), 'สรุปปี 2026 (พ.ศ. 2569) ไปต่างจังหวัด/ต่างประเทศที่ไหนบ้าง: 2 ทริป (trips in 2026) · Google Maps Timeline\n' +
    '5–7 มี.ค. 2026 สุราษฎร์ธานี\n10–12 เม.ย. 2026 เกาหลีใต้\nจำนวนวัน: สุราษฎร์ธานี 3 วัน, เกาหลีใต้ 3 วัน');
  assert.equal(p.msgs.find((m) => m.uuid === 'google-timeline:year:2026')?.ts, '2026-04-12T00:00:00.000Z', 'the year\'s last day with data');
  assert.match(text('month:2026-04'), /^สรุปเดือนเมษายน 2026 ไปไหนมาบ้าง \(เม\.ย\. 2026, April 2026, 2026-04\) · Google Maps Timeline · มีข้อมูล 3\/30 วัน\nจังหวัด: ระนอง 2 วัน\nต่างประเทศ: เกาหลีใต้ \(South Korea\) 3 วัน\nทริป: เกาหลีใต้ 10–12 เม\.ย\. 2026\n/);
  assert.equal(text('flights'), 'ขึ้นเครื่องบินกี่ครั้ง: 2 เที่ยว (ครั้ง) · เที่ยวบิน (flights) 10–12 เม.ย. 2026 · ข้อมูล Google Maps Timeline 1 ก.พ.–12 เม.ย. 2026');
  // 00:00 UTC keeps the local date and is never "future" for an MCP server started later that day
  for (const m of p.msgs.filter((m) => /:(day|trip):/.test(m.uuid))) assert.equal(m.ts, `${/\d{4}-\d\d-\d\d/.exec(m.uuid)![0]}T00:00:00.000Z`);
});
