// Offline reverse geocoder over GeoNames dumps (CC-BY 4.0, credit "GeoNames (geonames.org)"), downloaded once with
// ลุงจืด's permission: TH.txt (Thai places + provinces/districts), cities500.txt (world towns), admin1CodesASCII.txt,
// admin2Codes.txt. No network, no deps: coordinates never leave the machine.
// loadGeo() reads ≈90 MB (~1 s); the caller holds the returned function for one parse and then drops it (GC frees it).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Place = {
  cc: string; country: string; countryEn: string; // 'TH' 'ไทย' 'Thailand'
  key: string;                                     // region: 'TH.<admin1>' (a Thai province), abroad the country code
  province: string; provinceEn: string;            // Thai จังหวัด, abroad admin1 (English only)
  district: string;                                // TH อำเภอ/เขต, abroad the nearest town ('ไทย (English)' when GeoNames has a Thai name)
};
type Pt = { lat: number; lng: number; name: string; th: string; cc: string; a1: string; a2: string };
type LatLng = { lat: number; lng: number };

const THAI = /[฀-๿]/;
/** First Thai-script alternate name, admin prefix dropped: 'จังหวัดระนอง' → 'ระนอง'. */
const thai = (alt: string) => alt.split(',').find((n) => THAI.test(n))?.replace(/^(?:จังหวัด|อำเภอ|กิ่งอำเภอ|เขต)\s*/, '').trim() ?? '';
const en = (s: string) => s.replace(/^(?:Changwat|Amphoe|King Amphoe|Khet)\s+/, '');

/** km, equirectangular: exact enough below a few hundred km. */
export const km = (a: LatLng, b: LatLng) =>
  Math.hypot((b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180) * 111.32, (b.lat - a.lat) * 110.57);

/** Grid index → nearest point within maxKm (scans the square of cells around the query point). */
function nearest(pts: Pt[], cell: number) {
  const map = new Map<string, Pt[]>();
  for (const p of pts) {
    const k = `${Math.floor(p.lat / cell)},${Math.floor(p.lng / cell)}`;
    (map.get(k) ?? map.set(k, []).get(k)!).push(p);
  }
  return (q: LatLng, maxKm: number) => {
    const r = Math.ceil(maxKm / (cell * 110 * Math.cos(Math.min(Math.abs(q.lat), 85) * Math.PI / 180)));
    const y = Math.floor(q.lat / cell), x = Math.floor(q.lng / cell);
    let best: Pt | null = null, bd = maxKm;
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      for (const p of map.get(`${y + i},${x + j}`) ?? []) { const d = km(q, p); if (d <= bd) { best = p; bd = d; } }
    }
    return best && { p: best, d: bd };
  };
}

/** Load the dumps; returns where(lat, lng) → its province (Thailand) or country + town (abroad), null = nothing nearby. */
export function loadGeo(dir = process.env.MEMHUB_GEONAMES_DIR ?? join(homedir(), 'ai-archive', 'ref', 'geonames')) {
  const rows = (file: string) => readFileSync(join(dir, file), 'utf8').split('\n').map((l) => l.split('\t')).filter((f) => f.length >= 12);
  const pt = (f: string[]): Pt => ({ lat: +f[4], lng: +f[5], name: f[1], th: thai(f[3]), cc: f[8], a1: f[10], a2: f[11] });
  const thRows = rows('TH.txt');
  const thaiById = new Map(thRows.filter((f) => f[7] === 'ADM1' || f[7] === 'ADM2').map((f) => [f[0], thai(f[3])]));
  const admin = new Map<string, { en: string; th: string }>(); // 'TH.40' / 'TH.40.1015' / 'JP.40'
  for (const file of ['admin1CodesASCII.txt', 'admin2Codes.txt']) {
    for (const [code, , ascii, id] of readFileSync(join(dir, file), 'utf8').split('\n').map((l) => l.split('\t'))) {
      if (id) admin.set(code, { en: en(ascii), th: thaiById.get(id.trim()) ?? '' });
    }
  }
  const places = nearest(thRows.filter((f) => f[6] === 'P' && f[10]).map(pt), 0.05);
  const towns = nearest(rows('cities500.txt').filter((f) => f[8] !== 'TH').map(pt), 0.1);
  const thR = new Intl.DisplayNames('th', { type: 'region' }), enR = new Intl.DisplayNames('en', { type: 'region' });

  return (lat: number, lng: number): Place | null => {
    const q = { lat, lng }, pl = places(q, 30), tw = towns(q, 150);
    // ponytail: abroad = a foreign town nearer than any Thai village; a Mekong border town could flip it (none seen yet)
    if (tw && (!pl || tw.d < pl.d)) {
      const t = tw.p, a1 = admin.get(`${t.cc}.${t.a1}`)?.en ?? '';
      return { cc: t.cc, country: thR.of(t.cc) ?? t.cc, countryEn: enR.of(t.cc) ?? t.cc, key: t.cc, province: a1, provinceEn: a1,
        district: t.th ? `${t.th} (${t.name})` : t.name };
    }
    if (!pl) return null; // open sea / far from any town
    const p1 = admin.get(`TH.${pl.p.a1}`), p2 = admin.get(`TH.${pl.p.a1}.${pl.p.a2}`);
    return { cc: 'TH', country: 'ไทย', countryEn: 'Thailand', key: `TH.${pl.p.a1}`, province: p1?.th || p1?.en || '',
      provinceEn: p1?.en ?? '', district: p2?.th || p2?.en || '' };
  };
}
