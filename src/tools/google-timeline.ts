// Google Maps Timeline ("where have I been"): the on-device export (iOS format: a top-level array of visit / activity /
// timelinePath segments) → kind 'doc' text, Claude-only (guard.PRIVATE_TOOLS). sync() copies exports from
// <ai-archive>/inbox/google-timeline/*.json + MEMHUB_TIMELINE_FILES (';'-separated) into <archive>/exports/ (append-only;
// a re-export keeps the old copy as .bak; the source file is only read) and merges them, de-duplicated, into
// <archive>/timeline.json. parse() names places offline (src/geo.ts, GeoNames) and writes one session: an index of every
// place, a flight count, one turn per year (its trips), one turn per place (how he asks it, then every trip's dates on one line), then per month a
// summary, its trips and its days.
// Home → "บ้าน" (no area); the text holds no coordinates and no placeIDs.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Msg } from '../claude.ts';
import { km, loadGeo, type Place } from '../geo.ts';
import { syncFile, type Parsed } from '../importer.ts';

export const tool = 'google-timeline';
const HOME_M = 200;   // a visit this close to a Home place is home too
const MIN_AWAY = 15;  // min: shorter visits (fuel / toilet stops) never start, extend or end a trip
const REGULAR = 0.1;  // regions on ≥ 10 % of data days (commute) = home region, never a trip
const PASS_MIN = 120; // < 2 h in a region during a trip = แวะผ่าน

const json = (t: string) => { try { return JSON.parse(t); } catch { return null; } };
const kindOf = (s: any) => (s?.visit ? 'visit' : s?.activity ? 'activity' : null); // timelinePath (raw GPS trail) is not used

export function sync(archiveDir: string): Record<string, number | string> {
  const inbox = join(archiveDir, '..', '..', 'inbox', tool); // <ai-archive>/inbox, next to <ai-archive>/raw
  mkdirSync(inbox, { recursive: true });
  const files = [...readdirSync(inbox).filter((f) => /\.json$/i.test(f)).map((f) => join(inbox, f)),
    ...(process.env.MEMHUB_TIMELINE_FILES ?? '').split(';').map((s) => s.trim()).filter(Boolean)];
  const stats: Record<string, number> = {};
  const inc = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };
  const dir = join(archiveDir, 'exports'), merged = join(archiveDir, 'timeline.json');
  for (const f of files) {
    if (!existsSync(f)) { inc('missing'); continue; }
    // one archive name per source path: two exports both called Timeline.json never overwrite each other
    const id = createHash('sha256').update(resolve(f).toLowerCase()).digest('hex').slice(0, 8);
    inc(syncFile(f, join(dir, `${id}-${basename(f)}`)));
  }
  if (!existsSync(dir) || (existsSync(merged) && !stats.copied && !stats.appended && !stats.conflicts)) return stats;

  // oldest export first: a newer export's copy of a segment wins. .bak = superseded by its own re-export (a superset).
  // ponytail: a day Google re-segmented between two differently named exports keeps both versions; dedupe by overlap if seen
  const segs = new Map<string, unknown>();
  const exports = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
  for (const f of exports.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)) {
    const a = json(readFileSync(f, 'utf8'));
    if (!Array.isArray(a)) { inc('invalid'); continue; }
    for (const s of a) if (kindOf(s) && typeof s.startTime === 'string' && typeof s.endTime === 'string') segs.set(`${s.startTime}|${s.endTime}|${kindOf(s)}|${s.visit?.hierarchyLevel ?? ''}`, s); // a level-1 visit can share its parent's times
  }
  const text = JSON.stringify([...segs.values()].sort((a: any, b: any) => Date.parse(a.startTime) - Date.parse(b.startTime)));
  if (!existsSync(merged) || readFileSync(merged, 'utf8') !== text) { writeFileSync(merged, text); inc('merged'); }
  stats.segments = segs.size;
  return stats;
}

export const isTranscript = (path: string) => /[\\/]timeline\.json$/.test(path); // the merged file, not exports/<id>-<name>.json

// The phone is the only copy and Google auto-deletes Timeline after 3 months by default (when it is first turned on):
// an export older than STALE_DAYS means the next gap is near. Only the age is ever printed: no place, no date.
export const STALE_DAYS = 30;
/** Whole days since the newest visit/activity end in the merged export; null = no export yet. */
export function dataAgeDays(archiveDir: string, now = Date.now()): number | null {
  let segs = null; // a read error (EBUSY / EPERM / a directory) = unknown age: the hourly sync calls this before it indexes
  try { segs = json(readFileSync(join(archiveDir, 'timeline.json'), 'utf8')); } catch { /* no export / unreadable */ }
  const newest = Array.isArray(segs) ? segs.reduce((n, s) => Math.max(n, Date.parse(s?.endTime) || 0), 0) : 0;
  return newest ? Math.floor((now - newest) / 864e5) : null;
}
export const staleWarning = (age: number | null) => (age !== null && age > STALE_DAYS
  ? `WARNING google-timeline: newest data point is ${age} days old (> ${STALE_DAYS}): export Timeline from the phone again (README: Google Maps Timeline)` : null);

// ---------------- Thai text helpers ----------------
const TM = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TMF = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const TD = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const ymd = (d: string) => d.split('-').map(Number);
const thDate = (d: string) => { const [y, m, dd] = ymd(d); return `${dd} ${TM[m - 1]} ${y}`; };
function thRange(a: string, b: string) {
  const [ya, ma, da] = ymd(a), [yb, mb, db] = ymd(b);
  if (a === b) return thDate(a);
  if (ya === yb && ma === mb) return `${da}–${db} ${TM[mb - 1]} ${yb}`;
  return ya === yb ? `${da} ${TM[ma - 1]}–${db} ${TM[mb - 1]} ${yb}` : `${thDate(a)}–${thDate(b)}`;
}
const noYear = (s: string) => s.replace(/ \d{4}$/, '');
const addDay = (d: string, n = 1) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const span = (a: string, b: string) => { const out = [a]; while (out.at(-1)! < b) out.push(addDay(out.at(-1)!)); return out; };
/** sorted days → [first, last] runs of consecutive days */
const ranges = (ds: string[]) => {
  const out: [string, string][] = [];
  for (const d of [...ds].sort()) if (out.length && addDay(out.at(-1)![1]) === d) out.at(-1)![1] = d; else out.push([d, d]);
  return out;
};
const dur = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}ชม.${m % 60 ? `${m % 60}น.` : ''}` : `${m}น.`);
const kmTxt = (k: number) => `${k >= 100 ? Math.round(k).toLocaleString('en') : k.toFixed(1)} กม.`;
const hm = (t: string) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const MODE: Record<string, string> = {
  'in passenger vehicle': 'ขับรถ/นั่งรถ', 'in vehicle': 'ขับรถ/นั่งรถ', walking: 'เดิน', running: 'วิ่ง', motorcycling: 'มอเตอร์ไซค์',
  'in train': 'รถไฟ', 'in subway': 'รถไฟฟ้าใต้ดิน', 'in tram': 'รถราง', 'in bus': 'รถบัส', 'in ferry': 'เรือ', sailing: 'เรือ',
  flying: 'เครื่องบิน', cycling: 'ปั่นจักรยาน',
};
const mode = (t: string) => MODE[t] ?? 'เดินทาง';
// ponytail: hand list of spoken short names (search matches whole ICU words: "สุราษฎร์" ≠ "สุราษฎร์ธานี"); add other common spoken short names as needed
const SHORT: Record<string, string> = {
  'อุดรธานี': 'อุดร', 'อุบลราชธานี': 'อุบล', 'สุราษฎร์ธานี': 'สุราษฎร์', 'นครราชสีมา': 'โคราช', 'กรุงเทพมหานคร': 'กรุงเทพ กทม.',
  'พระนครศรีอยุธยา': 'อยุธยา', 'นครศรีธรรมราช': 'นครศรี', 'ประจวบคีรีขันธ์': 'ประจวบ', 'กาญจนบุรี': 'กาญจน์', 'ฉะเชิงเทรา': 'แปดริ้ว',
  'หนองบัวลำภู': 'หนองบัว', 'ปทุมธานี': 'ปทุม', 'สมุทรปราการ': 'ปากน้ำ', 'สุพรรณบุรี': 'สุพรรณ', 'เลย': 'จังหวัดเลย', // เลย is a search stopword
};

// ---------------- model ----------------
type Visit = { start: string; end: string; days: string[]; min: number; home: boolean; w: Place }; // days: local, each time keeps its own offset
type Act = { start: string; mode: string; km: number; from: Place; to: Place };
type Trip = { from: string; to: string; visits: Visit[]; acts: Act[]; days: Map<string, string[]>; main: string[] };
const UNKNOWN: Place = { cc: '', country: 'ไม่ทราบ', countryEn: 'unknown', key: '?', province: '', provinceEn: '', district: '' };
const abroad = (w: Place) => w.cc !== 'TH';
const pt = (g: unknown) => { const [lat, lng] = String(g).replace('geo:', '').split(',').map(Number); return { lat, lng }; };
const mins = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 6e4);
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);

function load(segs: any[]) {
  const where = loadGeo();
  const at = (g: unknown) => { const p = pt(g); return (Number.isFinite(p.lat) && Number.isFinite(p.lng) && where(p.lat, p.lng)) || UNKNOWN; };
  const homes = [...new Map(segs.filter((s) => s?.visit?.topCandidate?.semanticType === 'Home')
    .map((s) => [s.visit.topCandidate.placeID, pt(s.visit.topCandidate.placeLocation)])).values()];
  const visits: Visit[] = [], acts: Act[] = [];
  for (const s of segs) {
    if (!(Date.parse(s?.startTime) <= Date.parse(s?.endTime))) continue;
    if (s.visit && !(+s.visit.hierarchyLevel > 0)) { // level 1 = a finer visit nested inside a level-0 one
      const tc = s.visit.topCandidate ?? {}, p = pt(tc.placeLocation);
      visits.push({ start: s.startTime, end: s.endTime, days: span(s.startTime.slice(0, 10), s.endTime.slice(0, 10)), min: mins(s.startTime, s.endTime), w: at(tc.placeLocation),
        home: tc.semanticType === 'Home' || homes.some((h) => km(h, p) * 1000 <= HOME_M) });
    } else if (s.activity) {
      const a = s.activity;
      acts.push({ start: s.startTime, mode: String(a.topCandidate?.type ?? ''), km: (+a.distanceMeters || 0) / 1000, from: at(a.start), to: at(a.end) });
    }
  }
  return { visits, acts };
}

function model(visits: Visit[], acts: Act[]) {
  const names = new Map<string, Place>();
  for (const w of [...visits.map((v) => v.w), ...acts.flatMap((a) => [a.from, a.to])]) names.set(w.key, w);
  const dataDays = [...new Set([...visits.flatMap((v) => v.days), ...acts.map((a) => a.start.slice(0, 10))])].sort();
  const presence = new Map<string, string[]>(); // region → local days with a ≥ MIN_AWAY visit there
  for (const v of visits) if (v.min >= MIN_AWAY && v.w !== UNKNOWN) for (const d of v.days) if (!presence.get(v.w.key)?.includes(d)) push(presence, v.w.key, d);
  const homeVisits = new Map<string, Visit[]>();
  for (const v of visits) if (v.home) push(homeVisits, v.w.key, v);
  const homeKey = [...homeVisits].sort((a, b) => b[1].length - a[1].length)[0]?.[0];
  const homeRegion = new Set([homeKey, ...[...presence].filter(([, ds]) => ds.length >= REGULAR * dataDays.length).map(([k]) => k)]);

  // trips: maximal runs of ≥ MIN_AWAY visits outside the home region, ended by a ≥ MIN_AWAY home-region visit
  const trips: Trip[] = [];
  let cur: Trip | null = null, lastHomeEnd = '';
  for (const v of visits) {
    if (v.min < MIN_AWAY || v.w === UNKNOWN) continue;
    if (v.home || homeRegion.has(v.w.key)) { cur = null; lastHomeEnd = v.end; continue; }
    if (!cur) trips.push(cur = { from: lastHomeEnd || v.start, to: '', visits: [], acts: [], days: new Map(), main: [] });
    cur.visits.push(v);
  }
  for (const t of trips) {
    const end = Date.parse(t.visits.at(-1)!.end), next = visits.find((v) => Date.parse(v.start) >= end && v.min >= MIN_AWAY);
    t.acts = acts.filter((a) => Date.parse(a.start) >= Date.parse(t.from) && (!next || Date.parse(a.start) < Date.parse(next.start))); // out, inside, back
    const minutes = new Map<string, number>();
    for (const v of t.visits) {
      minutes.set(v.w.key, (minutes.get(v.w.key) ?? 0) + v.min);
      for (const d of v.days) if (!t.days.get(v.w.key)?.includes(d)) push(t.days, v.w.key, d);
    }
    const all = [...t.days.values()].flat().sort();
    t.from = all[0]; t.to = all.at(-1)!;
    t.main = [...t.days.keys()].sort((a, b) => +abroad(names.get(b)!) - +abroad(names.get(a)!) || minutes.get(b)! - minutes.get(a)!);
  }
  return { visits, acts, names, dataDays, presence, homeKey, homeRegion, trips };
}
type M = ReturnType<typeof model>;

// ---------------- texts ----------------
/** 'สุราษฎร์ธานี (สุราษฎร์, Surat Thani)' / 'ไอซ์แลนด์ (Iceland)' */
const label = (m: M, k: string) => {
  const w = m.names.get(k)!, s = SHORT[w.province];
  return abroad(w) ? `${w.country} (${w.countryEn})` : `${w.province} (${s ? `${s}, ` : ''}${w.provinceEn})`;
};
const thName = (m: M, k: string) => { const w = m.names.get(k)!; return abroad(w) ? w.country : w.province; };
/** How he asks, for every name form: memory_search's bigram leg matches a Thai run of the query ('ไปสุราษฎร์เมื่อไหร่') as one phrase. */
const asked = (m: M, k: string) => {
  const ns = [thName(m, k), ...(SHORT[thName(m, k)]?.split(' ') ?? [])];
  return `${ns.map((n) => `ไป${n}เมื่อไหร่`).join(' · ')} · เคยไป${ns[0]}ไหม`;
};
const region = (m: M, k: string) => (m.homeRegion.has(k) ? thName(m, k) : label(m, k));
const town = (w: Place) => (abroad(w) ? `${w.country} ${w.district}`.trim() : w.province);
function placeTxt(v: Visit) {
  const w = v.w;
  if (v.home) return 'บ้าน';
  if (w === UNKNOWN) return 'ไม่ทราบที่';
  if (abroad(w)) return `${w.district}${w.province ? `, ${w.province}` : ''} ${w.country}`;
  if (w.provinceEn === 'Bangkok') return `${w.district ? `เขต${w.district} ` : ''}กรุงเทพฯ`;
  return `${w.district ? `อ.${w.district} ` : ''}จ.${w.province}`;
}
const modeKm = (as: Act[]) => {
  const k = new Map<string, number>();
  for (const a of as) k.set(mode(a.mode), (k.get(mode(a.mode)) ?? 0) + a.km);
  return [...k].sort((a, b) => b[1] - a[1]).filter(([, n]) => n >= 0.5).map(([n, x]) => `${n} ${kmTxt(x)}`).join(' · ');
};
const flights = (as: Act[]) => as.filter((a) => a.mode === 'flying')
  .map((a) => `${noYear(thDate(a.start.slice(0, 10)))} ${a.start.slice(11, 16)} ${town(a.from)} → ${town(a.to)} ${kmTxt(a.km)}`).join('; ');

function dayText(m: M, d: string) {
  const vs = m.visits.filter((v) => v.days.includes(d)), as = m.acts.filter((a) => a.start.startsWith(d));
  const regions = [...new Set(vs.filter((v) => v.w !== UNKNOWN).map((v) => v.w.key))];
  const lines = [`Google Maps Timeline ${TD[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${thDate(d)} (${d}) · ${regions.map((k) => region(m, k)).join(' · ') || 'ไม่มีจุดแวะ'}`];
  const items = [...vs.map((v) => ({ t: v.start.startsWith(d) ? v.start.slice(11, 16) : '00:00', v, a: null })),
    ...as.map((a) => ({ t: a.start.slice(11, 16), v: null, a }))].sort((x, y) => x.t.localeCompare(y.t));
  for (const { t, v, a } of items) {
    if (a && (a.km >= 1 || a.mode === 'flying')) lines.push(`↳ ${mode(a.mode)} ${kmTxt(a.km)}${a.mode === 'flying' ? ` (${town(a.from)} → ${town(a.to)})` : ''}`);
    if (!v || (v.min < 5 && !v.home)) continue; // traffic stops: the header still names the region
    const e = v.end.startsWith(d) ? v.end.slice(11, 16) : '24:00';
    lines.push(`${t}–${e} ${dur(hm(e) - hm(t))} ${placeTxt(v)}`);
  }
  const tot = modeKm(as);
  return [...lines, tot && `รวม (อย่างน้อย): ${tot}`].filter(Boolean).join('\n');
}

const tripTitle = (m: M, t: Trip) => `ทริป ${t.main.slice(0, 3).map((k) => label(m, k)).join(' · ')}${t.main.length > 3 ? ` +${t.main.length - 3}` : ''} ${thRange(t.from, t.to)}`;
function tripText(m: M, t: Trip) {
  const per = t.main.map((k) => {
    const towns = [...new Set(t.visits.filter((v) => v.w.key === k).map((v) => v.w.district).filter(Boolean))].slice(0, 4);
    return `${label(m, k)} ${ranges(t.days.get(k)!).map(([a, b]) => noYear(thRange(a, b))).join(', ')}: ${towns.join(', ')}`;
  });
  const fl = flights(t.acts);
  return [`${tripTitle(m, t)} · ${span(t.from, t.to).length} วัน (${t.from} → ${t.to})`, ...per, fl && `บิน: ${fl}`,
    `เดินทาง (อย่างน้อย): ${modeKm(t.acts) || '-'}`].filter(Boolean).join('\n');
}

function monthText(m: M, mo: string) {
  const [y, mm] = ymd(`${mo}-01`), days = m.dataDays.filter((d) => d.startsWith(mo));
  const vs = m.visits.filter((v) => v.start.startsWith(mo)), as = m.acts.filter((a) => a.start.startsWith(mo));
  const regDays = [...m.presence].map(([k, ds]) => [k, ds.filter((d) => d.startsWith(mo)).length] as const).filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
  const list = (rs: typeof regDays) => rs.map(([k, n]) => `${region(m, k)} ${n} วัน`).join(', ');
  const th = regDays.filter(([k]) => !abroad(m.names.get(k)!)), ab = regDays.filter(([k]) => abroad(m.names.get(k)!));
  const area = new Map<string, number>();
  for (const v of vs) area.set(placeTxt(v), (area.get(placeTxt(v)) ?? 0) + v.min);
  const ts = m.trips.filter((t) => t.from.startsWith(mo) || t.to.startsWith(mo)), fl = flights(as);
  return [
    `สรุปเดือน${TMF[mm - 1]} ${y} ไปไหนมาบ้าง (${TM[mm - 1]} ${y}, ${new Date(`${mo}-01`).toLocaleString('en', { month: 'long', timeZone: 'UTC' })} ${y}, ${mo}) · Google Maps Timeline · มีข้อมูล ${days.length}/${new Date(Date.UTC(y, mm, 0)).getUTCDate()} วัน`,
    `จังหวัด: ${list(th) || '-'}`, ab.length && `ต่างประเทศ: ${list(ab)}`,
    ts.length && `ทริป: ${ts.map((t) => `${t.main.slice(0, 3).map((k) => thName(m, k)).join('·')} ${thRange(t.from, t.to)}`).join('; ')}`,
    `เวลามากสุด: ${[...area].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, n]) => `${a} ${Math.round(n / 60)}ชม.`).join(' · ')}`,
    `ระยะทาง (อย่างน้อย): ${modeKm(as) || '-'}`, fl && `บิน: ${fl}`,
  ].filter(Boolean).join('\n');
}

/** One turn per calendar year: "ปีนี้ / ปี 2026 ไปต่างจังหวัดที่ไหนบ้าง" — every trip of the year with its dates, then days per region. */
function yearText(m: M, y: string) {
  const ts = m.trips.filter((t) => t.from.startsWith(y) || t.to.startsWith(y));
  const days = [...m.presence].filter(([k]) => !m.homeRegion.has(k)).map(([k, ds]) => [k, ds.filter((d) => d.startsWith(y)).length] as const)
    .filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
  return [`สรุปปี ${y} (พ.ศ. ${+y + 543}) ไปต่างจังหวัด/ต่างประเทศที่ไหนบ้าง: ${ts.length} ทริป (trips in ${y}) · Google Maps Timeline`,
    ...ts.map((t) => `${thRange(t.from, t.to)} ${t.main.map((k) => thName(m, k)).join(', ')}`),
    `จำนวนวัน: ${days.map(([k, n]) => `${thName(m, k)} ${n} วัน`).join(', ') || '-'}`].join('\n');
}

const cover = (m: M) => `ข้อมูล Google Maps Timeline ${thRange(m.dataDays[0], m.dataDays.at(-1)!)}`;
function placeText(m: M, k: string) {
  const days = m.presence.get(k)!;
  if (m.homeRegion.has(k)) {
    const byMo = new Map<string, number>();
    for (const d of days) byMo.set(d.slice(0, 7), (byMo.get(d.slice(0, 7)) ?? 0) + 1);
    return `${asked(m, k)}\n${label(m, k)} = ${k === m.homeKey ? 'จังหวัดที่อยู่ (บ้าน)' : 'พื้นที่ไปประจำ'} · ไป ${days.length} จาก ${m.dataDays.length} วันที่มีข้อมูล (${cover(m)})\n` +
      `ครั้งแรก ${thDate(days[0])} · ล่าสุด ${thDate(days.at(-1)!)} · รายเดือน: ${[...byMo].map(([mo, n]) => `${mo} ${n} วัน`).join(', ')}`;
  }
  // first–last day there per trip, all on the first line: memory_search's full snippet is 400 chars
  const one = m.trips.filter((t) => t.days.has(k)).map((t) => {
    const ds = t.days.get(k)!.sort(), min = t.visits.filter((v) => v.w.key === k).reduce((n, v) => n + v.min, 0);
    return { t, own: thRange(ds[0], ds.at(-1)!), pass: min < PASS_MIN, whole: t.from !== ds[0] || t.to !== ds.at(-1) };
  });
  return `${asked(m, k)}\nเคยไป ${label(m, k)} ${one.length} ครั้ง: ${one.map((o) => o.own + (o.pass ? ' (แวะผ่าน)' : '')).join(', ')}\n(${cover(m)})\n` + one.map((o, i) => {
    const with_ = o.t.main.filter((x) => x !== k).slice(0, 3).map((x) => thName(m, x));
    return `ครั้งที่ ${i + 1}: ${o.own}${o.whole ? ` ในทริป ${thRange(o.t.from, o.t.to)}` : ''}${with_.length ? ` กับ ${with_.join(', ')}` : ''}`;
  }).join('\n');
}
function indexText(m: M, keys: string[]) {
  const ab = keys.filter((k) => abroad(m.names.get(k)!)), th = keys.filter((k) => !abroad(m.names.get(k)!));
  const been = (k: string) => ranges(m.presence.get(k)!).map(([a, b]) => thRange(a, b));
  const last = [...ab].sort((a, b) => m.presence.get(b)!.at(-1)!.localeCompare(m.presence.get(a)!.at(-1)!))[0];
  return `สถานที่ที่เคยไป · ${cover(m)} (ไม่มีในรายการ = ไม่เคยแวะเกิน ${MIN_AWAY} นาทีในช่วงนี้)\n` +
    (last ? `ไปต่างประเทศครั้งล่าสุดเมื่อไหร่: ${been(last).at(-1)} ${label(m, last)}\n` : '') +
    `ต่างประเทศ: ${ab.map((k) => `${label(m, k)} ${been(k).join(', ')}`).join(' · ') || '-'}\n` +
    `จังหวัด: ${th.map((k) => (SHORT[thName(m, k)] ? `${thName(m, k)} (${SHORT[thName(m, k)]})` : thName(m, k))).join(', ') || '-'}`;
}

export async function parse(path: string): Promise<Parsed | null> {
  const segs = json(readFileSync(path, 'utf8'));
  if (!Array.isArray(segs) || !segs.length) return null;
  const { visits, acts } = load(segs);
  const m = model(visits, acts);
  if (!m.dataDays.length) return null;
  const sessionId = tool, cwd = 'google/timeline', msgs: Msg[] = [];
  // ts = 00:00 UTC of the local day: search.ts day() prints the UTC date (local midnight +07:00 would show the day before);
  // not noon: an MCP server hides chunks newer than its own start (search before=startedAt), and noon UTC is 19:00 here
  const add = (id: string, day: string, text: string) =>
    msgs.push({ uuid: `${tool}:${id}`, parentUuid: msgs.at(-1)?.uuid ?? null, sessionId, ts: `${day}T00:00:00.000Z`, cwd, role: 'note', text });
  const keys = [...m.presence.keys()].sort((a, b) => m.presence.get(b)!.length - m.presence.get(a)!.length);
  add('places', m.dataDays.at(-1)!, indexText(m, keys));
  // a short turn of its own: a line in the long index left its vector far from "how many flights" (each flight: trip / month)
  const fl = m.acts.filter((a) => a.mode === 'flying').map((a) => a.start.slice(0, 10));
  if (fl.length) add('flights', m.dataDays.at(-1)!, `ขึ้นเครื่องบินกี่ครั้ง: ${fl.length} เที่ยว (ครั้ง) · เที่ยวบิน (flights) ${thRange(fl[0], fl.at(-1)!)} · ${cover(m)}`);
  // ts = the year's last day with data: this year outranks last year's turn on recency
  for (const y of new Set(m.dataDays.map((d) => d.slice(0, 4)))) add(`year:${y}`, m.dataDays.filter((d) => d.startsWith(y)).at(-1)!, yearText(m, y));
  for (const k of keys) add(`place:${k}`, m.presence.get(k)!.at(-1)!, placeText(m, k));
  for (const mo of [...new Set(m.dataDays.map((d) => d.slice(0, 7)))]) {
    add(`month:${mo}`, `${mo}-01`, monthText(m, mo));
    for (const t of m.trips.filter((t) => t.from.startsWith(mo))) add(`trip:${t.from}:${t.main[0]}`, t.from, tripText(m, t));
    for (const d of m.dataDays.filter((d) => d.startsWith(mo))) add(`day:${d}`, d, dayText(m, d));
  }
  return { sessionId, cwd, kind: 'doc', msgs };
}
