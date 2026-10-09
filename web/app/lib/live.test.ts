// node --test for lib/live.ts: runSearch reads the server's "unfamiliar" flag. Run: npm test (in web/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSearch } from './live.ts';

const answer = (body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
};
const base = { q: 'x', ms: 12, semantic: true, stages: { embed: 5 }, hits: [{ type: 'chat', node: null, label: 'a' }] };

test('runSearch passes unfamiliar through, and only a literal true counts (an older server, no flag: never "ไม่รู้")', async () => {
  answer({ ...base, unfamiliar: true });
  assert.equal((await runSearch('x')).unfamiliar, true);
  answer({ ...base, unfamiliar: false });
  assert.equal((await runSearch('x')).unfamiliar, false);
  answer(base);
  assert.equal((await runSearch('x')).unfamiliar, false);
  answer({ ...base, unfamiliar: 'true' });
  assert.equal((await runSearch('x')).unfamiliar, false);
});

test('runSearch explain: kept field by field; a malformed item is dropped, never half-shown; an older server has none', async () => {
  answer(base);
  assert.equal((await runSearch('x')).explain, undefined);
  const row = { type: 'fact', node: 'source:1', label: 'r', kw: 2, bi: null, vec: 1, cos: 0.7, score: 0.03, why: 'ai', ev: 1, status: null };
  answer({
    ...base,
    explain: {
      corpus: 100, time: { from: '2026-10-01T00:00:00.000Z', to: null, recent: false }, terms: [{ key: 'sort', df: 9, used: true }, { df: 1 }], unseen: ['zz', 3], fused: 2,
      signal: { cos1: 0.7, cos10: 'x', cosMean: 0.6, kw: 1, unseen: 0 },
      kw: { n: 2, top: [{ type: 'fact', node: null, label: 'k', r: 1, cos: null }, { type: 'fact', label: 'no rank' }] }, bi: null, vec: { n: 1, top: [] },
      rows: [row, { ...row, why: 3 }, { ...row, type: 'secret' }],
      linked: [{ type: 'chat', node: null, label: 'l', via: 1, kind: 'prov', act: 0.4, sim: null }, { type: 'chat', label: 'no kind' }],
    },
  });
  const x = (await runSearch('x')).explain!;
  assert.deepEqual(x.terms, [{ key: 'sort', df: 9, used: true }]);
  assert.deepEqual(x.unseen, ['zz']);
  assert.deepEqual(x.signal, { cos1: 0.7, cos10: null, cosMean: 0.6, kw: 1, unseen: 0 });
  assert.deepEqual([x.kw.top.length, x.bi, x.vec.n], [1, { n: 0, top: [] }, 1]);
  assert.deepEqual(x.rows, [row]);
  assert.deepEqual(x.linked.map((l) => [l.kind, l.via, l.sim]), [['prov', 1, null]]);
  assert.deepEqual(x.time, { from: '2026-10-01T00:00:00.000Z', to: null, recent: false });
});
