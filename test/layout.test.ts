import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import type { BrainNode } from '../src/brain.ts';
import { bakeSemantic, fitSemantic, placeNear, procrustes, relax, rerank, type LayoutLink, type LayoutNode, type Vec3 } from '../src/layout.ts';

// Small brain: 3 projects, 4 sessions each, 5 subagents per session, cross links between sessions.
function graph(extraSessions = 0) {
  const nodes: LayoutNode[] = [], links: LayoutLink[] = [];
  let t = 1_700_000_000;
  for (let p = 0; p < 3; p++) {
    nodes.push({ key: `project:p${p}`, t0: t++ });
    for (let s = 0; s < 4 + extraSessions; s++) {
      const sk = `source:s${p}-${s}`;
      nodes.push({ key: sk, t0: t++, parent: `project:p${p}` });
      links.push({ source: sk, target: `project:p${p}`, k: 'in', w: 1 });
      for (let a = 0; a < 5; a++) {
        nodes.push({ key: `${sk}-a${a}`, t0: t, parent: sk }); // same t0 on purpose: ties break on key
        links.push({ source: `${sk}-a${a}`, target: sk, k: 'spawn', w: 1 });
      }
      if (s) links.push({ source: sk, target: `source:s${(p + 1) % 3}-${s - 1}`, k: 'similar', w: 0.7 });
    }
  }
  return { nodes, links };
}

test('relax: same input (any order) → byte-identical integer xyz on every node, no NaN', () => {
  const { nodes, links } = graph();
  const a = relax(nodes, links, 300);
  const b = relax([...nodes].reverse(), [...links].reverse(), 300);
  assert.equal(JSON.stringify([...a].sort()), JSON.stringify([...b].sort()));
  assert.equal(a.size, nodes.length);
  for (const xyz of a.values()) assert.ok(xyz.length === 3 && xyz.every(Number.isInteger), `bad xyz ${xyz}`);
});

test('relax: adding nodes moves pinned ones by exactly 0; new ones land near the graph', () => {
  const first = relax(graph().nodes, graph().links, 300);
  const { nodes, links } = graph(2); // 2 new sessions (+ subagents) per project
  const pinned = nodes.map((n) => ({ ...n, pin: first.get(n.key) }));
  const next = relax(pinned, links, 60);
  for (const [k, xyz] of first) assert.deepEqual(next.get(k), xyz, k);
  const fresh = nodes.filter((n) => !first.has(n.key));
  assert.ok(fresh.length > 0);
  const r = Math.max(...[...first.values()].map((v) => Math.hypot(...v)));
  for (const n of fresh) {
    const xyz = next.get(n.key)!;
    assert.ok(xyz.every(Number.isInteger) && Math.hypot(...xyz) < 3 * r, `${n.key} ${xyz}`);
  }
});

test('relax: prov/next links (strength 0) never move a node, on a first bake or an incremental one', () => {
  const synapses = (links: LayoutLink[], keys: string[]): LayoutLink[] => [...links, ...keys.slice(1).flatMap((k, i): LayoutLink[] =>
    [{ source: keys[i], target: k, k: 'next', w: 1 }, { source: k, target: keys[(i * 7) % keys.length], k: 'prov', w: 1 }])];
  const g = graph(), keys = g.nodes.filter((n) => n.key.split('-').length === 2).map((n) => n.key); // sessions
  const first = relax(g.nodes, g.links, 300);
  assert.deepEqual([...relax(g.nodes, synapses(g.links, keys), 300)], [...first]);
  const g2 = graph(2), pinned = g2.nodes.map((n) => ({ ...n, pin: first.get(n.key) }));
  const keys2 = g2.nodes.filter((n) => n.key.split('-').length === 2).map((n) => n.key);
  assert.deepEqual([...relax(pinned, synapses(g2.links, keys2), 60)], [...relax(pinned, g2.links, 60)]);
});

test('relax: 0 ticks with everything pinned returns the pins', () => {
  const nodes: LayoutNode[] = [{ key: 'project:a', t0: 1, pin: [1, -2, 3] }, { key: 'source:1', t0: 2, parent: 'project:a', pin: [4, 5, -6] }];
  assert.deepEqual([...relax(nodes, [], 0)], [['project:a', [1, -2, 3]], ['source:1', [4, 5, -6]]]);
});

// ── semantic layout ──
const lcg = (s: number) => () => (s = (1664525 * s + 1013904223) % 4294967296) / 4294967296;
const d3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** 3 well-apart topics in 48-d, `per` centroids each; keys like the export's ('source:<id>'). */
function topics(per = 20, d = 48) {
  const rand = lcg(7);
  const centers = [0, 1, 2].map(() => Float32Array.from({ length: d }, () => rand() * 2 - 1));
  return centers.flatMap((c, k) => Array.from({ length: per }, (_, i) => ({ key: `source:${k * 100 + i}`, k, v: c.map((x) => x + (rand() * 2 - 1) * 0.3) })));
}
/** Share of each point's `n` nearest (3D) that are of its own topic. */
function purity(pts: { k: number; p: Vec3 }[], n = 5) {
  let same = 0;
  for (const x of pts) same += pts.filter((y) => y !== x).sort((u, w) => d3(u.p, x.p) - d3(w.p, x.p)).slice(0, n).filter((y) => y.k === x.k).length;
  return same / (pts.length * n);
}

test('fitSemantic: same rows in any order → identical integer xyz; topics stay apart; p95 radius = the given one', () => {
  const rows = topics();
  const a = fitSemantic(rows, 100), b = fitSemantic([...rows].reverse(), 100);
  assert.equal(JSON.stringify([...a.pos].sort()), JSON.stringify([...b.pos].sort()));
  assert.equal(a.pos.size, rows.length);
  for (const p of a.pos.values()) assert.ok(p.every(Number.isInteger), `bad xyz ${p}`);
  assert.ok(purity(rows.map((r) => ({ k: r.k, p: a.pos.get(r.key)! }))) > 0.95);
  const r = [...a.pos.values()].map((p) => Math.hypot(...p)).sort((x, y) => x - y);
  assert.ok(Math.abs(r[Math.floor(r.length * 0.95)] - 100) <= 2, `p95 radius ${r[Math.floor(r.length * 0.95)]}`);
});

test('procrustes: a rotated, mirrored, scaled and shifted copy maps back in place', () => {
  const rand = lcg(3);
  const pts: Vec3[] = Array.from({ length: 30 }, () => [rand() * 100 - 50, rand() * 100 - 50, rand() * 100 - 50]);
  const [c, s] = [Math.cos(0.7), Math.sin(0.7)];
  const copy = pts.map(([x, y, z]) => [2.5 * (c * x - s * y) + 10, 2.5 * (s * x + c * y) - 4, -2.5 * z + 7] as Vec3);
  const t = procrustes(copy, pts);
  assert.ok(Math.abs(t.s - 0.4) < 1e-9, `scale ${t.s}`);
  copy.forEach((q, i) => t.map(q).forEach((x, k) => assert.ok(Math.abs(x - pts[i][k]) < 1e-6, `${i}: ${t.map(q)} vs ${pts[i]}`)));
  const self = procrustes(pts, pts);
  pts.forEach((p) => self.map(p).forEach((x, k) => assert.ok(Math.abs(x - p[k]) < 1e-9)));
});

test('fitSemantic: a refit warm-started from the old galaxy stays close; new nodes land by their topic', () => {
  const rows = topics(), old = rows.filter((_, i) => i % 4);
  const a = fitSemantic(old, 100), b = fitSemantic(rows, 100, a.pos, a.scale);
  const shift = (at: (k: string) => Vec3) => old.reduce((s, r) => s + d3(a.pos.get(r.key)!, at(r.key)), 0) / old.length;
  const cold = fitSemantic(rows, 100), t = procrustes(old.map((r) => cold.pos.get(r.key)!), old.map((r) => a.pos.get(r.key)!));
  const [warm, coldAligned] = [shift((k) => b.pos.get(k)!), shift((k) => t.map(cold.pos.get(k)!))];
  assert.ok(warm < 10 && warm < coldAligned / 2, `mean shift ${warm} (cold fit + Procrustes: ${coldAligned})`);
  assert.ok(purity(rows.map((r) => ({ k: r.k, p: b.pos.get(r.key)! }))) > 0.95);
});

test('placeNear: a new node lands among its topic, the same spot every time', () => {
  const rows = topics(), old = rows.filter((_, i) => i % 4), fresh = rows.filter((_, i) => !(i % 4));
  const a = fitSemantic(old, 100);
  const placed = old.map((r) => ({ k: r.k, z: a.z.get(r.key)!, xyz: a.pos.get(r.key)! }));
  for (const r of fresh) {
    const { xyz } = placeNear(a.pca, placed, r.key, r.v);
    assert.deepEqual(placeNear(a.pca, placed, r.key, r.v).xyz, xyz);
    const near = [...placed].sort((u, w) => d3(u.xyz, xyz) - d3(w.xyz, xyz)).slice(0, 3);
    assert.ok(near.every((q) => q.k === r.k), `${r.key} → ${xyz}`);
  }
});

test('rerank: keeps the candidates nearest by exact cosine, whatever their length or order', () => {
  const rand = lcg(5), rows = Array.from({ length: 30 }, () => Float32Array.from({ length: 48 }, () => rand() * 2 - 1));
  const cos = (a: Float32Array, b: Float32Array) => a.reduce((s, x, j) => s + x * b[j], 0) / Math.hypot(...a) / Math.hypot(...b);
  const cand = rows.map((_, i) => Int32Array.from(rows.keys()).filter((j) => j !== i).reverse());
  rows[3] = rows[3].map((x) => x * 7); // length doesn't count
  rerank(rows, cand, 4).forEach((got, i) => {
    const want = cand[i].slice().sort((a, b) => cos(rows[i], rows[b]) - cos(rows[i], rows[a])).slice(0, 4);
    assert.deepEqual([...got], [...want], `node ${i}`);
  });
});

test('bakeSemantic: no vectors → no s, hubs = the mean of their children, unchanged → no write, a grown node alone is re-placed, hidden → no s', async () => {
  const rows = topics(8);
  const send = (v: Float32Array) => { // pgvector's vector_send
    const b = Buffer.alloc(4 + 4 * v.length);
    b.writeUInt16BE(v.length, 0);
    v.forEach((x, j) => b.writeFloatBE(x, 4 + 4 * j));
    return b;
  };
  const make = (): BrainNode[] => [
    ...[0, 1, 2].map((k) => ({ id: `project:t${k}`, type: 'project' as const, n: 0, t0: 0, t1: 0, u: 0, xyz: [k * 50, 0, 0] as Vec3 })),
    ...rows.map((r) => ({ id: r.key, type: 'session' as const, p: `project:t${r.k}`, n: 4, t0: 0, t1: 0, u: 0, xyz: [0, 40, r.k] as Vec3 })),
    { id: 'source:900', type: 'note', p: 'project:t0', n: 1, t0: 0, t1: 0, u: 0 }, // chunks without embeddings
  ];
  const rawOf = new Map(make().map((n) => [n.id, n.id]));
  const vectors = new Map(rows.map((r) => [r.key, 4]));
  let state: Record<string, unknown> | undefined;
  const writes: string[][] = [];
  const db = { query: async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT v FROM state')) return { rows: state ? [{ v: structuredClone(state) }] : [] };
    if (sql.includes('vector_send')) {
      const ids = params[0] as string[] | null;
      return { rows: rows.filter((r) => !ids || ids.includes(r.key.slice(7))).map((r) => ({ id: r.key.slice(7), e: send(r.v) })) };
    }
    if (sql.startsWith('INSERT INTO state')) {
      const put = JSON.parse(params[1] as string);
      writes.push(Object.keys(put));
      state = sql.includes('state.v ||') ? { ...state, ...put } : put;
      return { rows: [] };
    }
    throw new Error(sql);
  } } as unknown as pg.Pool;

  const first = make();
  await bakeSemantic(db, first, rawOf, vectors);
  assert.deepEqual(writes.map((w) => w.length), [rows.length + 1]); // '#' + every node with vectors
  assert.equal(first.find((n) => n.id === 'source:900')!.s, undefined);
  for (const n of first.filter((n) => n.type === 'session')) assert.ok(n.s!.every(Number.isInteger));
  const kids = first.filter((n) => n.p === 'project:t1' && n.s);
  assert.deepEqual(first.find((n) => n.id === 'project:t1')!.s, [0, 1, 2].map((c) => Math.round(kids.reduce((s, n) => s + n.s![c], 0) / kids.length)));

  const again = make();
  await bakeSemantic(db, again, rawOf, vectors);
  assert.equal(writes.length, 1, 'unchanged: no write');
  assert.deepEqual(again.map((n) => n.s), first.map((n) => n.s));

  vectors.set(rows[0].key, 10); // grew 2.5×
  const grown = make();
  await bakeSemantic(db, grown, rawOf, vectors, (n) => n.id === rows[1].key);
  assert.deepEqual(writes.at(-1), [rows[0].key]);
  grown.forEach((n, i) => n.type === 'session' && n.id !== rows[0].key && n.id !== rows[1].key && assert.deepEqual(n.s, first[i].s, n.id));
  assert.equal(grown.find((n) => n.id === rows[1].key)!.s, undefined);
  assert.ok(Array.isArray(state![rows[1].key]), 'a hidden node keeps its spot in the state');
});
