// node --test for lib/store.ts: how feed events become fired events. Run: npm test (in web/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Brain, BrainEvent, BrainNode } from './brain.ts';
import { BrainStore } from './store.ts';

const node: BrainNode = { id: 'a', type: 'session', n: 1, t0: 0, t1: 0, u: 0 };
const brain = (events: BrainEvent[], mode: Brain['mode'] = 'local'): Brain => ({ v: 1, mode, at: 1000, stats: {}, nodes: [node], links: [], events });
const fire = (s: BrainStore) => s.pending.splice(0).map((e) => e[3]);

test('a minute bucket that grows fires only the new requests', () => {
  const s = new BrainStore();
  s.merge(brain([]), 'graph');
  s.merge(brain([[60, 'a', 'search', 1]]), 'feed');
  assert.deepEqual(fire(s), [1]);
  s.merge(brain([[60, 'a', 'search', 3]]), 'feed'); // two more requests in the same minute on the same source
  assert.deepEqual(fire(s), [2]);
  s.merge(brain([[60, 'a', 'search', 3]]), 'feed'); // the same poll again
  assert.deepEqual(fire(s), []);
  s.merge(brain([[60, 'a', 'search', 2]]), 'feed'); // a smaller count (a restarted server) never fires
  assert.deepEqual(fire(s), []);
  assert.equal(s.events.reduce((n, e) => n + e[3], 0), 3); // the history holds the bucket's total
});

test('the graph snapshot sets what was already seen', () => {
  const s = new BrainStore();
  s.merge(brain([[60, 'a', 'recall', 2]]), 'graph');
  s.merge(brain([[60, 'a', 'recall', 2]]), 'feed');
  assert.deepEqual(fire(s), []);
  s.merge(brain([[60, 'a', 'recall', 3]]), 'feed');
  assert.deepEqual(fire(s), [1]);
});

test('with /live.json answering, search and recall only join the history; chat turns still fire', () => {
  const s = new BrainStore();
  s.merge(brain([]), 'graph');
  s.liveOwns = true;
  s.merge(brain([[60, 'a', 'search', 1], [60, 'a', 'recall', 1], [60, 'a', 'turn', 4]]), 'feed');
  assert.deepEqual(s.pending.map((e) => e[2]), ['turn']);
  assert.equal(s.events.length, 3);
});

test('an event is fired once its node is known, not lost', () => {
  const s = new BrainStore();
  s.merge({ ...brain([]), nodes: [] }, 'graph');
  s.merge(brain([[60, 'a', 'search', 1]]), 'feed'); // the feed brings node a with its event
  assert.deepEqual(fire(s), [1]);
});
