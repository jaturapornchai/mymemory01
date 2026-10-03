// PURE (runs under `node --test`): the "how it works" panel's numbers — activity calendar layout, heat levels, monthly
// totals, and which memory nodes belong to the last dream run. Only erasable TS syntax.
import type { Brain, BrainNode, LogEntry } from './brain.ts';

const DAY = 86400;
const BKK = 7 * 3600; // Brain.activity days are Bangkok (UTC+7) days
export type Activity = NonNullable<Brain['activity']>;

/** Day i as a time format.ts (UTC formatters) prints as its Bangkok date: 00:00 +07 shifted to 00:00 UTC. */
export const dayT = (a: Activity, i: number) => a.start + i * DAY + BKK;
const month = (t: number) => new Date(t * 1000).getUTCFullYear() * 12 + new Date(t * 1000).getUTCMonth();

/**
 * GitHub-style layout: one column per week (Sunday on top), `off` empty cells before entry 0. `cuts` = quartiles of the
 * non-zero days (levels 1-4, 0 = none). `months` = the columns where a month starts (its first Sunday), a first partial
 * month only if it has 3+ columns before the next label.
 */
export function calendar(a: Activity) {
  const n = a.turns.length;
  const off = new Date(dayT(a, 0) * 1000).getUTCDay();
  const cols = Math.ceil((off + n) / 7);
  const nz = a.turns.filter((v) => v > 0).sort((x, y) => x - y);
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] ?? 0;
  const months: { col: number; t: number }[] = [];
  for (let c = 0; c < cols; c++) {
    const t = dayT(a, Math.max(0, c * 7 - off));
    if (c === 0 || month(t) !== month(dayT(a, Math.max(0, (c - 1) * 7 - off)))) months.push({ col: c, t });
  }
  if (months.length > 1 && months[1].col - months[0].col < 3) months.shift();
  let max = 0;
  for (let i = 1; i < n; i++) if (a.turns[i] > a.turns[max]) max = i;
  return { off, cols, cuts: [q(0.25), q(0.5), q(0.75)] as const, months, total: nz.reduce((s, v) => s + v, 0), active: nz.length, max };
}

export const level = (v: number, cuts: readonly number[]) => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);

/** Per calendar month (Bangkok), oldest first: the heatmap's table alternative. `t` = its first day (dayT). */
export function monthly(a: Activity): { t: number; turns: number; days: number }[] {
  const out: { t: number; turns: number; days: number }[] = [];
  a.turns.forEach((v, i) => {
    const t = dayT(a, i);
    const last = out[out.length - 1];
    const row = last && month(last.t) === month(t) ? last : out[out.push({ t, turns: 0, days: 0 }) - 1];
    row.turns += v;
    if (v > 0) row.days++;
  });
  return out;
}

/**
 * Memory nodes first recorded during the last dream run: t0 after the previous run (at most 3 h before this one) and up
 * to 10 min after it (the run's notes are ingested right after). A time window: the export has no per-run node list.
 */
export function dreamNodes(nodes: Iterable<BrainNode>, dream: { t: number }, log: readonly LogEntry[]): string[] {
  const prev = log.find((e) => e.k === 'dream' && e.t < dream.t)?.t ?? -Infinity; // the log is newest first
  const lo = Math.max(prev, dream.t - 3 * 3600);
  const out: string[] = [];
  for (const n of nodes) if (n.type === 'memory' && n.t0 > lo && n.t0 <= dream.t + 600) out.push(n.id);
  return out;
}
