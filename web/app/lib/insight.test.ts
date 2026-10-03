// node --test for lib/insight.ts. Run: npm test (in web/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrainNode, LogEntry } from './brain.ts';
import { calendar, dayT, dreamNodes, level, monthly } from './insight.ts';

const BKK = 7 * 3600;
// 371 Bangkok days from Sat 27 Sep 2025 (00:00 +07): a 3 on the 1st of each month, 9 on the last day
const start = Date.UTC(2025, 8, 27) / 1000 - BKK;
const turns: number[] = Array.from({ length: 371 }, (_, i) => (new Date((start + i * 86400 + BKK) * 1000).getUTCDate() === 1 ? 3 : 0));
turns[370] = 9;
const a = { start, turns };

test('calendar: Sunday-first weeks, Bangkok dates, month labels skip a stub first month', () => {
  const c = calendar(a);
  assert.equal(new Date(dayT(a, 0) * 1000).toISOString().slice(0, 10), '2025-09-27');
  assert.equal(c.off, 6); // Saturday
  assert.equal(c.cols, 54);
  // Sep has 2 columns before October's first Sunday (5 Oct, column 2): too short for a label
  assert.equal(new Date(c.months[0].t * 1000).toISOString().slice(0, 10), '2025-10-05');
  assert.equal(c.months[0].col, 2);
  assert.equal(c.months.length, 12); // Oct 2025 … Sep 2026: October 2026's first Sunday is past the end
  assert.deepEqual([c.total, c.active, c.max], [13 * 3 + 9, 14, 370]); // 1 Oct 2025 … 1 Oct 2026, then 2 Oct
});

test('level: 0 = none, quartile cuts, above the top cut = 4', () => {
  const cuts = [20, 30, 40];
  assert.deepEqual([0, 1, 20, 21, 30, 40, 41].map((v) => level(v, cuts)), [0, 1, 1, 2, 2, 3, 4]);
});

test('monthly: Bangkok months oldest first, totals add up', () => {
  const m = monthly(a);
  assert.equal(m.length, 14); // Sep 2025 … Oct 2026
  assert.equal(new Date(m[0].t * 1000).toISOString().slice(0, 10), '2025-09-27');
  assert.deepEqual([m[1].turns, m[1].days], [3, 1]);
  assert.equal(m.reduce((s, r) => s + r.turns, 0), 13 * 3 + 9);
});

test('dreamNodes: memory nodes since the previous run (≤ 3 h back) up to 10 min after', () => {
  const t = 1_790_000_000;
  const mem = (id: string, t0: number, type: BrainNode['type'] = 'memory'): BrainNode => ({ id, type, n: 1, t0, t1: t0, u: 0 });
  const nodes = [mem('before-prev', t - 4000), mem('in', t - 100), mem('late', t + 500), mem('too-late', t + 700), mem('note', t - 100, 'note')];
  const log: LogEntry[] = [{ t: t + 9000, k: 'dream', c: {} }, { t, k: 'dream', c: {} }, { t: t - 3600, k: 'dream', c: {} }];
  assert.deepEqual(dreamNodes(nodes, { t }, log), ['in', 'late']);
  // no previous run in the log: 3 h back
  assert.deepEqual(dreamNodes(nodes, { t }, []), ['before-prev', 'in', 'late']);
});
