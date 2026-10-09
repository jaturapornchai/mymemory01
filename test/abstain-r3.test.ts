// search.ts unfamiliar(), round 3 (tmp/abstain3): a query that names a catalogued project (h = 1) is also judged by agree + pun.
// Signal values are real round-2 tune items (tmp/abstain3/parity.ts runs), rounded to 4 dp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unfamiliar } from '../src/search.ts';

// real project + a topic it never discussed: the vector/keyword features look familiar (first rule alone says no), but 76 % of the
// query's IDF sits in terms the project's own chunks never hold
const C_STYLE = { cos1: 0.5834, cos10: 0.5579, cosMean: 0.5499, kw: 0.3982, unseen: 0, h: 1 as const, agree: 0, pun: 0.7593 };
// real project + a topic it holds: strong peaked match, every other term found in the project
const ANSWERABLE = { cos1: 0.7274, cos10: 0.6647, cosMean: 0.6449, kw: 0.6832, unseen: 0, h: 1 as const, agree: 1, pun: 0 };

test('unfamiliar: project-naming query with most of its other terms absent from that project = ไม่รู้; same project, terms present = รู้', () => {
  assert.equal(unfamiliar(C_STYLE), true);
  assert.equal(unfamiliar(ANSWERABLE), false);
  assert.equal(unfamiliar({ ...C_STYLE, pun: 0 }), false); // pun alone decides: the same vector/keyword features, every term present
  assert.equal(unfamiliar({ ...ANSWERABLE, pun: 0.7593 }), false); // a strong match is not overruled by a few absent terms
});

test('unfamiliar: agree/pun count only with h = 1; a Signal without them is h = 0 (old 5-field callers keep the first rule)', () => {
  const { agree, pun } = C_STYLE, five = { cos1: C_STYLE.cos1, cos10: C_STYLE.cos10, cosMean: C_STYLE.cosMean, kw: C_STYLE.kw, unseen: C_STYLE.unseen };
  assert.equal(unfamiliar(five), false); // 5 fields: first rule only
  assert.equal(unfamiliar({ ...five, h: 0, agree, pun }), false); // h = 0: agree/pun ignored
  assert.equal(unfamiliar({ ...five, h: 1 }), false); // h = 1 without agree/pun = 0/0: the second rule scores +0.57 here
  assert.equal(unfamiliar({ ...five, h: 1, agree, pun }), true);
  assert.equal(unfamiliar(undefined), false);
  assert.equal(unfamiliar({ cos1: null, cos10: null, cosMean: null, kw: 0, unseen: 0, h: 1, agree: 0, pun: 1 }), false); // keyword-only: no evidence either way
  assert.equal(unfamiliar({ cos1: 0.75, cos10: 0.6, cosMean: 0.5, kw: 0.9, unseen: 0 }), false); // strong peaked match
  assert.equal(unfamiliar({ cos1: 0.42, cos10: 0.4, cosMean: 0.38, kw: 0.2, unseen: 0 }), true); // weak flat match: the first rule alone
});
