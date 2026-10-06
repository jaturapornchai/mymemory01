// node --test for the pure scene modules (slots / style / quality). Run: npm test (in web/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAMILY_COLOR, type BrainNode, type NodeType } from '../../lib/brain.ts';
import { addAdjacency, echoOf, placeFallback, SlotTable, type SlotDiff } from './slots.ts';
import { BASE_LINEAR, fireColor, hexToLinear, srgb, TYPE_INDEX } from './style.ts';
import { Governor, initialTier, type TierEnv } from './quality.ts';

const node = (id: string, type: NodeType = 'session', n = 1): BrainNode => ({ id, type, n, t0: 0, t1: 0, u: 0 });
const table = () => new SlotTable<BrainNode>((x) => x.id, (x) => TYPE_INDEX[x.type], 5);
const ids = (d: SlotDiff<BrainNode>) => ({
  added: d.added.map((s) => s.item.id),
  revived: d.revived.map((s) => s.item.id),
  removed: d.removed.map((s) => s.item.id),
  replaced: d.replaced.map((s) => s.item.id),
});

test('diff: append, scrub back, revive keeps the old slot', () => {
  const all = ['a', 'b', 'c', 'd'].map((id) => node(id));
  const t = table();
  assert.deepEqual(ids(t.diff(all.slice(0, 2))), { added: ['a', 'b'], revived: [], removed: [], replaced: [] });
  assert.deepEqual(ids(t.diff(all)), { added: ['c', 'd'], revived: [], removed: [], replaced: [] });
  assert.deepEqual(ids(t.diff(all.slice(0, 1))), { added: [], revived: [], removed: ['b', 'c', 'd'], replaced: [] });
  const slotC = t.byKey.get('c')!.slot;
  assert.deepEqual(ids(t.diff(all.slice(0, 3))), { added: [], revived: ['b', 'c'], removed: [], replaced: [] });
  assert.equal(t.byKey.get('c')!.slot, slotC);
  assert.equal(t.count[TYPE_INDEX.session], 4, 'slots are never freed or reused for other ids');
});

test('diff: live mid-array insert and replaced object', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((id) => node(id));
  const t = table();
  t.diff([a, c]);
  const b2 = { ...a, n: 9 };
  assert.deepEqual(ids(t.diff([b2, b, c])), { added: ['b'], revived: [], removed: [], replaced: ['a'] });
  assert.equal(t.byKey.get('a')!.item, b2);
});

test('diff: groups get independent slot ranges', () => {
  const t = table();
  t.diff([node('p', 'project'), node('s', 'session'), node('q', 'project')]);
  assert.deepEqual([t.byKey.get('p')!.slot, t.byKey.get('s')!.slot, t.byKey.get('q')!.slot], [0, 0, 1]);
  assert.deepEqual(t.count, [2, 1, 0, 0, 0]);
});

test('diff: prefix fast path equals a full diff', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pool = Array.from({ length: 300 }, (_, i) => node(`n${i}`, (['project', 'session', 'note'] as const)[i % 3]));
  const fast = table();
  const full = table();
  let cur = pool.slice(0, 100);
  for (let step = 0; step < 200; step++) {
    const r = rnd();
    if (r < 0.3) cur = pool.slice(0, Math.floor(rnd() * pool.length)); // scrub
    else if (r < 0.5) cur = [...cur.slice(0, 5), pool[200 + Math.floor(rnd() * 100)], ...cur.slice(5)].filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i); // mid insert
    else if (r < 0.7 && cur.length) {
      const i = Math.floor(rnd() * cur.length);
      cur = cur.map((x, j) => (j === i ? { ...x, n: x.n + 1 } : x)); // replaced object
    } else cur = cur.slice(); // same objects, new array
    assert.deepEqual(ids(fast.diff(cur)), ids(full.diff(cur, false)), `step ${step}`);
  }
  for (const [k, s] of fast.byKey) assert.deepEqual([s.slot, s.live], [full.byKey.get(k)!.slot, full.byKey.get(k)!.live]);
});

test('fallback placement is deterministic and shell-structured', () => {
  const p = [10, -5, 3];
  assert.deepEqual(placeFallback(p, 2, 17), placeFallback(p, 2, 17));
  const d = (k: number) => Math.hypot(...placeFallback(p, 2, k).map((v, i) => v - p[i]));
  assert.ok(Math.abs(d(0) - 8) < 1e-9 && Math.abs(d(47) - 8) < 1e-9);
  assert.ok(Math.abs(d(48) - 14) < 1e-9);
  const pts = Array.from({ length: 48 }, (_, k) => placeFallback(p, 2, k).join());
  assert.equal(new Set(pts).size, 48, 'no two children share a spot');
});

test('adjacency encodes direction', () => {
  const adj = new Map<string, number[]>();
  addAdjacency(adj, 'a', 'b', 0);
  addAdjacency(adj, 'b', 'c', 5);
  assert.deepEqual(adj.get('a'), [1]);
  assert.deepEqual(adj.get('b'), [-1, 6]);
  assert.deepEqual(adj.get('c'), [-6]);
});

test('echoOf: 1-hop over live links of the given kinds, both directions, strongest amp, fired nodes skipped', () => {
  const ls: [string, string, string, boolean][] = [['x', 'a', 'prov', true], ['b', 'x', 'next', true], ['x', 'hub', 'in', true],
    ['x', 'c', 'coaccess', false], ['y', 'a', 'link', true], ['x', 'y', 'link', true]];
  const adj = new Map<string, number[]>();
  const links = ls.map(([source, target, k, live], slot) => (addAdjacency(adj, source, target, slot), { slot, group: 0, live, item: { source, target, k } }));
  const kinds = new Set(['link', 'prov', 'next', 'coaccess']);
  const from = new Map([['x', 0.5], ['y', 0.9]]);
  assert.deepEqual([...echoOf(adj, links, kinds, from, from)].sort(), [['a', 0.9], ['b', 0.5]]); // no hub ('in'), no dead link, y fired itself
  assert.equal(echoOf(adj, links, kinds, new Map(), new Set()).size, 0);
});

function hueSat(lin: readonly number[]): [number, number] {
  const [r, g, b] = lin.map((c) => srgb(Math.min(1, Math.max(0, c))));
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max === 0 ? 0 : d / max];
}

test('palette: linear bases round-trip to FAMILY_COLOR and stay below bloom threshold', () => {
  for (const [t, hex] of Object.entries(FAMILY_COLOR)) {
    const back = BASE_LINEAR[t as NodeType].map((c) => Math.round(srgb(c) * 255));
    assert.deepEqual(back, hexToLinear(hex).map((c) => Math.round(srgb(c) * 255)));
    assert.ok(Math.max(...BASE_LINEAR[t as NodeType]) <= 0.785);
  }
});

test('fireColor never invents a hue (both themes): within ±15° of base or desaturated (< 0.15) after clipping', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const t of ['project', 'session', 'note'] as const) {
      const [h0] = hueSat(BASE_LINEAR[t]);
      for (let i = 0; i <= 100; i++) {
        const [h, s] = hueSat(fireColor(BASE_LINEAR[t], i / 100, theme));
        const dh = Math.abs(((h - h0 + 540) % 360) - 180);
        assert.ok(dh <= 15 || s < 0.15, `${theme} ${t} act=${i / 100}: hue ${h.toFixed(1)} vs ${h0.toFixed(1)}, sat ${s.toFixed(2)}`);
      }
    }
  }
});

test('initialTier truth table', () => {
  const env = (o: Partial<TierEnv>): TierEnv => ({ q: null, stored: null, coarse: false, halfFloat: true, ...o });
  const rows: [Partial<TierEnv>, string][] = [
    [{ q: 'ultra' }, 'ultra'],
    [{ q: 'low', stored: 'high' }, 'low'],
    [{ q: 'auto', stored: 'low', cores: 8 }, 'high'],
    [{ q: 'bogus', stored: 'medium' }, 'medium'],
    [{ stored: 'ultra' }, 'ultra'],
    [{ saveData: true, cores: 16 }, 'low'],
    [{ coarse: true, cores: 4 }, 'medium'], // iPhone: Safari says 4 for < 8 cores, no deviceMemory
    [{ coarse: true, cores: 4, memory: 4 }, 'low'], // Chromium reports both: cores are a real signal there
    [{ coarse: true, memory: 3, cores: 8 }, 'low'],
    [{ coarse: true, cores: 8, memory: 8 }, 'medium'],
    [{ coarse: true }, 'medium'],
    [{ cores: 4 }, 'medium'],
    [{ cores: 8 }, 'high'],
    [{}, 'high'],
    [{ q: 'ultra', halfFloat: false }, 'low'],
    [{ halfFloat: false }, 'low'],
  ];
  for (const [o, want] of rows) assert.equal(initialTier(env(o)), want, JSON.stringify(o));
});

/** Feeds constant frame intervals; every probe is answered with the given bare rAF interval (the browser cap). */
function run(g: Governor, frameMs: number, capMs: number, from: number, to: number): string[] {
  const acts: string[] = [];
  for (let t = from; t < to; t += frameMs) {
    let a = g.sample(frameMs, t, false);
    if (a?.kind === 'probe') a = g.probed(capMs);
    if (a) acts.push(a.kind === 'dpr' ? `dpr:${a.dpr.toFixed(3)}` : a.kind === 'tier' ? `tier:${a.tier}` : 'probe');
  }
  return acts;
}

test('Governor: warm-up ignored, DPR to floor first, then one tier at a time, never promotes, locks', () => {
  assert.deepEqual(run(new Governor('high', 1.5, 1000 / 60, 1, 0), 40, 1000 / 60, 0, 60000), ['dpr:1.275', 'dpr:1.084', 'dpr:1.000', 'tier:medium', 'tier:low']);
  assert.deepEqual(run(new Governor('high', 1, 1000 / 60, 1, 0), 16, 1000 / 60, 0, 30000), []);
  const locked = new Governor('ultra', 1.25, 1000 / 60, 1.25, 0);
  run(locked, 300, 1000 / 60, 0, 90000); // > 250 ms deltas are ignored (hidden tab)
  assert.equal(locked.tier, 'ultra');
  run(locked, 50, 1000 / 60, 90000, 200000);
  assert.equal(locked.tier, 'low');
  assert.ok(locked.locked);
});

test('Governor: a capped browser/display (30 Hz Energy Saver, 48 Hz panel) is not a slow GPU', () => {
  const hz30 = new Governor('high', 1, 1000 / 60, 1, 0);
  assert.deepEqual(run(hz30, 1000 / 30, 1000 / 30, 0, 60000), []);
  assert.equal(hz30.tier, 'high');
  assert.ok(!hz30.locked);
  assert.deepEqual(run(new Governor('high', 1, 1000 / 60, 1, 0), 1000 / 48, 1000 / 48, 0, 60000), []);
  // 15 fps on a 30 Hz cap is still too slow for us: drops
  assert.deepEqual(run(new Governor('medium', 1, 1000 / 30, 1, 0), 1000 / 15, 1000 / 30, 0, 20000), ['tier:low']);
});
