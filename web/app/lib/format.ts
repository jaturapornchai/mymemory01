import { TYPE_NAME, type BrainNode } from './brain.ts';

// Dates are UTC so they read the same everywhere (and match the timeline's UTC day/month bins); th-TH = Buddhist era.
const DATE = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const MONTH = new Intl.DateTimeFormat('th-TH', { month: 'short', timeZone: 'UTC' });
const MONTH_YEAR = new Intl.DateTimeFormat('th-TH', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const CLOCK = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); // viewer's zone
const INT = new Intl.NumberFormat('th-TH'); // toLocaleString builds a new formatter per call: 37× slower, ~30 calls per HUD render

/** "12 เม.ย. 2569" */
export const fmtDate = (unix: number) => DATE.format(unix * 1000);
/** timeline axis: "ต.ค.", or "ม.ค. 2570" when the year is shown */
export const fmtMonth = (unix: number, withYear: boolean) => (withYear ? MONTH_YEAR : MONTH).format(unix * 1000);
/** "2 ต.ค. 14:05" in the viewer's time zone */
export const fmtClock = (unix: number) => CLOCK.format(unix * 1000);

export function ago(deltaSec: number): string {
  const s = Math.max(0, Math.round(deltaSec));
  if (s < 60) return 'เมื่อสักครู่';
  if (s < 3600) return `${Math.floor(s / 60)} นาทีที่แล้ว`;
  if (s < 86400) return `${Math.floor(s / 3600)} ชั่วโมงที่แล้ว`;
  return `${Math.floor(s / 86400)} วันที่แล้ว`;
}

export const fmtInt = (n: number) => INT.format(Math.round(n));

const DEC = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 });
/** "1.1 GB": 1024-based, like Windows and pg_size_pretty */
export function fmtBytes(b: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  for (; b >= 1024 && i < units.length - 1; i++) b /= 1024;
  return `${DEC.format(b)} ${units[i]}`;
}

/** Label if the export has one, else "<type> · <hub label>" (public mode has aliases only). */
export function nodeTitle(n: BrainNode, hub?: BrainNode): string {
  if (n.label) return n.label;
  return hub?.label ? `${TYPE_NAME[n.type]} · ${hub.label}` : TYPE_NAME[n.type];
}
