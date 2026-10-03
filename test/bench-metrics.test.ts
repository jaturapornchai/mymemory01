// scripts/bench.ts metric ports vs hand-computed values (LongMemEval eval_utils.py, LoCoMo recall_acc, mempalace session recall).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dcg, evaluateRetrieval, ndcg, recallAcc, sessionRecall, stratified } from '../scripts/bench.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);
const C = ['a', 'b', 'c', 'd']; // corpus; b and d are relevant

test('dcg: position 1 and 2 undiscounted, then 1/log2(i)', () => {
  near(dcg([1, 1, 1], 3), 2 + 1 / Math.log2(3));
  near(dcg([0, 1, 0, 1], 4), 1 + 0.5); // log2(4) = 2
  near(dcg([1, 1, 1], 1), 1);
  near(dcg([], 5), 0);
});

test('ndcg: ideal = all relevant corpus docs first', () => {
  near(ndcg([0, 1, 2, 3], ['b', 'd'], C, 3), 1 / 2);                      // a b c → 1 / (1 + 1)
  near(ndcg([2, 3, 1, 0], ['b', 'd'], C, 2), 1 / 2);                      // c d → 1 / 2
  near(ndcg([2, 3, 1, 0], ['b', 'd'], C, 4), (1 + 1 / Math.log2(3)) / 2); // c d b a
  near(ndcg([1, 3], ['b', 'd'], C, 2), 1);
  near(ndcg([3], ['b', 'd'], C, 5), 1 / 2);                               // a short ranking: the rest counts as misses
  near(ndcg([0, 1], [], C, 2), 0);
});

test('recall_any / recall_all at k', () => {
  const r = (k: number) => { const { any, all } = evaluateRetrieval([2, 3, 1, 0], ['b', 'd'], C, k); return [any, all]; };
  assert.deepEqual(r(1), [0, 0]);
  assert.deepEqual(r(2), [1, 0]);
  assert.deepEqual(r(3), [1, 1]);
  assert.deepEqual([evaluateRetrieval([0], [], C, 1).any, evaluateRetrieval([0], [], C, 1).all], [0, 1]); // Python any([]) / all([])
});

test('LoCoMo recall_acc: share of evidence dia_ids retrieved, literal ids', () => {
  near(recallAcc(['D1:3', 'D2:5'], ['D2:5', 'D1:1']), 0.5);
  near(recallAcc(['D1:3', 'D1:3', 'D2:5'], ['D1:3']), 2 / 3); // a list, as in evaluation.py
  near(recallAcc([], []), 1);
  near(recallAcc(['D8:6; D9:17'], ['D8:6', 'D9:17']), 0);     // malformed dataset entry never matches
});

test('mempalace session recall: distinct evidence sessions', () => {
  near(sessionRecall(['D1:3', 'D1:5', 'D4:2'], [4, 2]), 0.5);
  near(sessionRecall(['D8:6; D9:17'], [8]), 1); // re.match: first id only
  near(sessionRecall(['D:11:26'], []), 1);      // no parsable session → 1
});

test('stratified subset: fixed seed, every type, its share', () => {
  const items = [...Array(100)].map((_, i) => ({ id: i, question_type: i < 50 ? 'a' : i < 80 ? 'b' : 'c' }));
  const s = stratified(items, 10, 7);
  assert.deepEqual(s, stratified(items, 10, 7));
  assert.deepEqual(['a', 'b', 'c'].map((t) => s.filter((x) => x.question_type === t).length), [5, 3, 2]);
  assert.ok(stratified(items, 4, 7).every((x) => s.includes(x))); // a smaller run reuses the bigger run's projects
});
