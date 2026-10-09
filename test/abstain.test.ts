// search.ts unfamiliar(): memory_search says "low familiarity" only with vector evidence of a weak, flat match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unfamiliar } from '../src/search.ts';

test('unfamiliar: needs vector evidence; strong peaked match = familiar, weak flat match = not', () => {
  assert.equal(unfamiliar(undefined), false);
  assert.equal(unfamiliar({ cos1: null, cos10: null, cosMean: null, kw: 0, unseen: 0 }), false); // keyword-only: no evidence either way
  assert.equal(unfamiliar({ cos1: 0.75, cos10: 0.6, cosMean: 0.5, kw: 0.9, unseen: 0 }), false);
  assert.equal(unfamiliar({ cos1: 0.42, cos10: 0.4, cosMean: 0.38, kw: 0.2, unseen: 0 }), true);
});
