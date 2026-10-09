import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Trace, TraceRow } from '../../lib/live.ts';
import { edgeOf } from './regions.ts';
import { askSteps, dwellOf, linkName, origins, revealPlan, rowGroups, rrf, stepPlan } from './steps.ts';

const row = (why: string, kw: number | null, vec: number | null, type: TraceRow['type'] = 'chat'): TraceRow =>
  ({ type, node: null, label: `${why} ${kw} ${vec}`, kw, bi: null, vec, cos: vec === null ? null : 0.7, score: 0.02, why, ev: 0, status: null });
const leg = (n: number) => ({ n, top: [{ type: 'fact' as const, node: 'source:1', label: 'top', r: 1, cos: 0.8 }] });
const trace = (o: Partial<Trace> = {}): Trace => ({
  q: 'memory-hub ห้ามเดา', ms: 90, semantic: true, unfamiliar: false, stages: { embed: 5, keyword: 50, vector: 30, synapse: 20 },
  hits: [],
  explain: {
    corpus: 48000, time: null, terms: [{ key: 'memory', df: 3471, used: false }, { key: 'เดา', df: 998, used: true }, { key: 'zq', df: 1, used: true }], unseen: ['zq'], fused: 24,
    signal: { cos1: 0.76, cos10: 0.66, cosMean: 0.65, kw: 0.78, unseen: 0 },
    kw: leg(60), bi: leg(12), vec: leg(60),
    rows: [row('ai', 5, 1, 'rule'), row('ai', 2, null, 'note'), row('ai', null, 3), row('fold:Fabc12345', 9, 9), row('cap', 1, null), row('full', 7, null), row('out', null, 50)],
    linked: [{ type: 'fact', node: 'source:9', label: 'linked fact', via: 1, kind: 'prov→next', act: 0.42, sim: 0.37 }],
  },
  ...o,
});

test('askSteps: the 8 steps in pipeline order; every leg travels a real (non-decor) pathway', () => {
  const steps = askSteps(trace());
  assert.deepEqual(steps.map((s) => s.id), ['ask', 'terms', 'keyword', 'vector', 'fuse', 'decide', 'links', 'answer']);
  for (const s of steps) for (const ph of s.route) for (const [a, b] of ph) assert.ok(edgeOf(a, b) && !edgeOf(a, b)!.decor, `${s.id}: ${a}→${b}`);
});

test('askSteps: no explain (older brain-serve) → nothing to tell', () => {
  assert.deepEqual(askSteps(trace({ explain: undefined })), []);
});

test('askSteps: the time window end is exclusive: shown as the day before', () => {
  const t = trace();
  const terms = askSteps({ ...t, explain: { ...t.explain!, time: { from: '2026-09-30T17:00:00.000Z', to: '2026-10-01T17:00:00.000Z', recent: false } } })[1];
  assert.match(terms.facts.at(-1)!.value, /^1 ต.ค. 69 – 1 ต.ค. 69/);
});

test('askSteps: what each step says comes from the trace', () => {
  const [, terms, keyword, , fuse, decide, links, answer] = askSteps(trace());
  assert.deepEqual(terms.facts.map((f) => [f.label, f.tone]), [['memory', 'dim'], ['เดา', 'ok'], ['zq', 'warn']], 'a too-common term only scores; an unseen one shows no (clamped) count');
  assert.match(keyword.text, /60 ชิ้น \(เพดาน 60\).*12 ชิ้น/);
  assert.deepEqual(fuse.facts.map((f) => f.value), ['2 ชิ้น', '3 ชิ้น', '2 ชิ้น'], 'both / words only / meaning only');
  assert.equal(decide.tone, 'ok');
  assert.deepEqual(links.items.map((i) => [i.rank, i.note]), [['จาก #1', 'ที่มา (ข้อเท็จจริง ↔ แชตต้นทาง) → แชตถัดไป · แรง 0.42']]);
  assert.deepEqual(links.found, ['temporal']);
  assert.equal(answer.items.length, 3, 'the answer lists exactly the rows marked ai');
  assert.equal(answer.items[0].note, 'คำ #5 · ความหมาย #1 · 0.70');
});

test('askSteps: keyword-only cannot decide (never a green "รู้"); "ไม่รู้" says so', () => {
  const kwOnly = askSteps(trace({ semantic: false, unfamiliar: false })); // what the server sends when the embedder is out
  const vector = kwOnly.find((s) => s.id === 'vector')!;
  assert.deepEqual([vector.tone, vector.route], ['warn', []]);
  const decide = kwOnly.find((s) => s.id === 'decide')!;
  assert.equal(decide.tone, 'dim');
  assert.match(decide.text, /^ตัดสินไม่ได้/);
  assert.notEqual(kwOnly.find((s) => s.id === 'answer')!.tone, 'ok');
  const unknown = askSteps(trace({ unfamiliar: true }));
  assert.equal(unknown.find((s) => s.id === 'decide')!.tone, 'warn');
  assert.match(unknown.find((s) => s.id === 'answer')!.title, /ไม่ตรง/);
});

test('askSteps: no links found → the links step has no route into the cortex, answer returns from prefrontal', () => {
  const t = trace();
  const steps = askSteps({ ...t, explain: { ...t.explain!, linked: [] } });
  assert.deepEqual(steps.find((s) => s.id === 'links')!.route, [[['prefrontal', 'parietal']]]);
  assert.deepEqual(steps.find((s) => s.id === 'answer')!.route, [[['prefrontal', 'thalamus']]]);
});

test('origins / rrf: the leg ranks as shown and RRF k=60 as search.ts sums it', () => {
  assert.deepEqual(origins({ kw: 5, bi: null, vec: 1, cos: 0.7622 }), ['คำ #5', 'ความหมาย #1 · 0.76']);
  assert.deepEqual(origins({ kw: null, bi: null, vec: null, cos: null }), []);
  assert.equal(rrf({ kw: 5, bi: 3, vec: null, cos: null }), 1 / 65 + 1 / 63);
});

test('rowGroups: every row in exactly one group, in decision order, empty groups dropped', () => {
  const rows = trace().explain!.rows;
  const g = rowGroups(rows);
  assert.deepEqual(g.map((x) => [x.key, x.rows.length]), [['ai', 3], ['fold', 1], ['cap', 1], ['full', 1], ['out', 1]]);
  assert.equal(g.reduce((a, x) => a + x.rows.length, 0), rows.length);
  assert.deepEqual(rowGroups(rows.slice(0, 3)).map((x) => x.key), ['ai']);
});

test('stepPlan: phases run one after another, slower at a lower speed; a step without a route charges its region', () => {
  const fuse = askSteps(trace()).find((s) => s.id === 'fuse')!;
  const p = stepPlan(fuse);
  assert.deepEqual(p.legs.map((l) => [l.from, l.to, l.t0]), [['temporal', 'amygdala', 0], ['hippocampus', 'amygdala', 0], ['amygdala', 'prefrontal', 1.1]]);
  assert.equal(stepPlan(fuse, 0.5).legs[2].t0, 2.2);
  const ask = stepPlan(askSteps(trace())[0]);
  assert.deepEqual([ask.legs.length, ask.blooms.map((b) => b.region)], [0, ['thalamus']]);
  for (const s of askSteps(trace())) assert.ok(dwellOf(s) >= stepPlan(s).total, `${s.id}: the next step never starts mid-route`);
});

test('revealPlan / linkName', () => {
  assert.deepEqual(revealPlan('rule').blooms.map((b) => b.region), ['cerebellum']);
  assert.deepEqual(revealPlan('private').blooms, []);
  assert.equal(linkName('coaccess'), 'ถูกเรียกใช้คู่กัน');
  assert.equal(linkName('weird'), 'weird');
});
