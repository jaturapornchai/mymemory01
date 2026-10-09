// node --test for the brain view's routes. Run: npm test (in web/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HitType } from '../../lib/live.ts';
import { edgeOf, EDGES, REGIONS } from './regions.ts';
import { hitOfNode, NEAREST_TITLE, planCall, planGet, planRelated, planSearch, planTrace, planTurn, traceNote, UNFAMILIAR_STATUS, type Plan } from './routes.ts';

const every: HitType[] = ['rule', 'fact', 'chat', 'note', 'github', 'daily', 'private'];
const plans = (): Plan[] => [
  planSearch(every, 300),
  planSearch([], null),
  planSearch(every, 400, { embed: 120, keyword: 80, vector: 60, other: 10 }),
  planRelated(every, 200),
  planTrace({ hits: [{ type: 'chat', node: null, label: '' }], ms: 300, stages: { embed: 100, vector: 50 }, unfamiliar: true }),
  planTurn(),
  ...every.map((t) => planGet([t], 250)),
  planGet(['chat', 'rule', 'fact', 'note'], 250),
  planCall('get', null, []),
];
const arrow = (p: Plan) => p.legs.map((l) => `${l.from}>${l.to}`);

test('every pulse travels a pathway that exists, and every region of the picture is on a pathway', () => {
  for (const p of plans()) for (const l of p.legs) assert.ok(edgeOf(l.from, l.to), `${p.kind}: ${l.from} → ${l.to}`);
  for (const r of REGIONS) assert.ok(EDGES.some((e) => e.a === r.id || e.b === r.id), r.id);
});

test('search: thalamus first (keyword and vector at once), back to thalamus last, legs in order', () => {
  const p = planSearch(['chat', 'fact'], 300);
  const [k, v] = p.legs;
  assert.deepEqual([k.from, k.to, v.from, v.to], ['thalamus', 'temporal', 'thalamus', 'hippocampus']);
  assert.equal(k.t0, v.t0);
  assert.deepEqual(p.legs.map((l) => l.to), ['temporal', 'hippocampus', 'amygdala', 'amygdala', 'prefrontal', 'parietal', 'thalamus']);
  for (const l of p.legs) assert.ok(l.t0 >= 0 && l.dur > 0);
  const last = p.legs[p.legs.length - 1];
  assert.ok(Math.abs(last.t0 + last.dur - p.blooms.filter((b) => b.region === 'thalamus').at(-1)!.at) < 1e-9);
});

test('a human can follow it: at least 1.2 s however quick the request, about 5 s at most however slow', () => {
  for (const ms of [0, 20, 150, 600, 5000, 60000]) {
    const p = planSearch(['chat'], ms);
    assert.ok(p.total >= 1.2 && p.total <= 5.2, `${ms} ms → ${p.total}`);
    for (const l of p.legs) assert.ok(l.dur >= 0.38 - 1e-9, `${ms} ms: leg ${l.dur}`);
  }
  assert.ok(planTurn().total >= 1.2);
});

test('a traced search keeps its real stage proportions (embed with keyword, then vector)', () => {
  const p = planSearch(['chat'], 0, { embed: 300, keyword: 50, vector: 100, other: 20 });
  const [keyword, vector] = p.legs;
  assert.ok(Math.abs(keyword.dur / vector.dur - 3) < 1e-9);
  assert.ok(Math.abs(vector.t0 - keyword.dur) < 1e-9);
  assert.equal(p.blooms[0].region, 'thalamus'); // the embedding charges the thalamus
});

test('private hits light nothing; found memories light their region after the loop', () => {
  assert.equal(planSearch(['private', 'private'], 300).blooms.length, planSearch([], 300).blooms.length);
  const p = planSearch(['rule', 'rule', 'daily'], 300);
  const end = p.legs[p.legs.length - 1];
  const lit = p.blooms.filter((b) => b.at >= end.t0 + end.dur);
  assert.deepEqual(lit.map((b) => b.region).sort(), ['cerebellum', 'hippocampus', 'thalamus']);
  assert.ok(lit.find((b) => b.region === 'cerebellum')!.amp > lit.find((b) => b.region === 'hippocampus')!.amp);
});

test('get goes through the region of the item type; a private one straight to prefrontal', () => {
  assert.deepEqual(arrow(planGet(['rule'], 200)), ['thalamus>cerebellum', 'cerebellum>prefrontal', 'prefrontal>thalamus']);
  assert.deepEqual(arrow(planGet(['private'], 200)), ['thalamus>prefrontal', 'prefrontal>thalamus']);
});

test('planCall picks the route by kind; turn is brainstem to hippocampus; public nodes map by type only', () => {
  assert.equal(planCall('search', 100, []).kind, 'search');
  assert.equal(planCall('related', 100, []).kind, 'related');
  assert.equal(planCall('get', 100, []).kind, 'get');
  assert.equal(planCall('timeline', 100, []).kind, 'get');
  assert.deepEqual(arrow(planTurn()), ['brainstem>hippocampus']);
  assert.equal(hitOfNode({ id: 'x', type: 'subagent', n: 1, t0: 0, t1: 0, u: 0 }), 'chat');
  assert.equal(hitOfNode({ id: 'x', type: 'project', n: 1, t0: 0, t1: 0, u: 0 }), null);
});

const trace = (unfamiliar: boolean, types: HitType[] = ['chat', 'rule']) => ({ hits: types.map((type) => ({ type, node: null, label: 'x' })), ms: 300, stages: { embed: 120, keyword: 80, vector: 60, other: 10 }, unfamiliar });

test('an unfamiliar search ("ไม่รู้") reaches thalamus and hippocampus and fades: no ranking legs, no cortex, no found memory lit', () => {
  for (const ms of [0, 20, 300, 60000]) {
    const p = planTrace({ ...trace(true), ms });
    assert.deepEqual(arrow(p), ['thalamus>hippocampus']);
    assert.deepEqual([...new Set(p.blooms.map((b) => b.region))].sort(), ['hippocampus', 'thalamus']);
    assert.ok(p.total >= 1.2, `${ms} ms → ${p.total}`);
  }
  // even with hits (they are near misses): nothing lights in rule's cerebellum
  assert.ok(!planTrace(trace(true, ['rule', 'rule'])).blooms.some((b) => b.region === 'cerebellum'));
});

test('a familiar search is exactly planSearch: nothing changes', () => {
  const t = trace(false);
  assert.deepEqual(planTrace(t), planSearch(['chat', 'rule'], t.ms, t.stages));
  assert.ok(planTrace(t).legs.some((l) => l.to === 'prefrontal'));
});

test('the search box note: only an unfamiliar search has a status; its near misses get a title, no title when there are none', () => {
  assert.deepEqual(traceNote(trace(true)), { status: UNFAMILIAR_STATUS, title: NEAREST_TITLE });
  assert.deepEqual(traceNote(trace(true, [])), { status: UNFAMILIAR_STATUS, title: null });
  assert.deepEqual(traceNote(trace(false)), { status: null, title: null });
  assert.equal(UNFAMILIAR_STATUS, 'ไม่รู้ — ความจำไม่มีเรื่องนี้');
  assert.equal(NEAREST_TITLE, 'ใกล้เคียงที่สุด (ไม่ตรง)');
});
