// Brain layout, baked at export time so the web viewer runs zero physics ticks (docs/research/brain-renderer-spec.md §3).
// Positions are pinned per raw key in state 'layout': public and local exports share coordinates, and a node never
// moves once placed (only `brain --rebake` reshuffles). Raw keys stay in the local DB; only integer xyz is exported.
import { forceCenter, forceLink, forceManyBody, forceSimulation } from 'd3-force-3d';
import type pg from 'pg';
import type { BrainLink, BrainNode, LinkKind } from './brain.ts';

export type Vec3 = [number, number, number];
/** key = raw key (stable across modes); parent = spawn source or project hub; pin = stored position (never moves). */
export type LayoutNode = { key: string; t0: number; parent?: string; pin?: Vec3 };
export type LayoutLink = { source: string; target: string; k: LinkKind; w: number };

// Tuned once by eye on the real 2.9k-node graph (2026-10-02): R ~320, ~1% of nodes touch a neighbour, +19 KB gzip.
// World units ~ node radii (project 6..18, subagent 1.2..3.6).
const LINK: Record<LinkKind, { d: number; s: (w: number) => number }> = {
  spawn: { d: 3, s: () => 0.9 }, // short + strong: subagents cluster round their session
  in: { d: 14, s: () => 0.6 }, // clears the project hub's own radius (6..18)
  link: { d: 20, s: () => 0.15 }, // weak: cross-links shape the brain without collapsing it
  similar: { d: 30, s: (w) => 0.1 * w },
  coaccess: { d: 25, s: (w) => 0.05 + 0.1 * w },
  // strength 0: drawn, never a force (relax leaves them out), so they can't move a baked or pinned node
  prov: { d: 20, s: () => 0 },
  next: { d: 20, s: () => 0 },
};
const CHARGE = -15;
const CHARGE_MAX = 120; // no far-field push: without it the whole mass flings small projects out to R ~1100
const SHELL = 60; // projects seeded on a Fibonacci sphere of this radius
const JITTER = 2; // new node = parent ± this

/** Same LCG as d3-force-3d's own; seeded so the same input always gives the same layout. */
const lcg = (s = 1) => () => (s = (1664525 * s + 1013904223) % 4294967296) / 4294967296;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // not localeCompare: must not depend on locale

function shell(i: number, n: number): Vec3 {
  const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), a = i * Math.PI * (3 - Math.sqrt(5));
  return [SHELL * r * Math.cos(a), SHELL * y, SHELL * r * Math.sin(a)];
}

/** Pure core: pinned nodes stay put, new ones start next to their parent and relax for `ticks`. Returns integer xyz per key. */
export function relax(nodes: LayoutNode[], links: LayoutLink[], ticks: number): Map<string, Vec3> {
  type Sim = LayoutNode & { x?: number; y?: number; z?: number; fx?: number; fy?: number; fz?: number };
  const sim: Sim[] = nodes.map((n) => ({ ...n })).sort((a, b) => a.t0 - b.t0 || cmp(a.key, b.key));
  const byKey = new Map(sim.map((n) => [n.key, n]));
  const hubs = new Map(sim.filter((n) => !n.parent || !byKey.has(n.parent)).map((n, i) => [n, i]));
  const rand = lcg();
  // ponytail: recursion assumes acyclic parents (subagent → session → project), which buildBrain guarantees
  const place = (n: Sim): Sim => {
    if (n.x !== undefined) return n;
    if (n.pin) {
      [n.fx, n.fy, n.fz] = n.pin;
      [n.x, n.y, n.z] = n.pin;
    } else {
      const p = hubs.has(n) ? undefined : place(byKey.get(n.parent!)!);
      const [x, y, z] = p ? [p.x!, p.y!, p.z!] : shell(hubs.get(n)!, hubs.size);
      [n.x, n.y, n.z] = [x + (rand() * 2 - 1) * JITTER, y + (rand() * 2 - 1) * JITTER, z + (rand() * 2 - 1) * JITTER];
    }
    return n;
  };
  sim.forEach(place);

  if (ticks > 0) {
    // strength-0 links out: even with no force they'd add to forceLink's per-node degree (the other links' bias) and draw
    // jiggle() randoms for endpoints on one axis (the seeded sequence)
    const ls = links.filter((l) => byKey.has(l.source) && byKey.has(l.target) && LINK[l.k].s(l.w) > 0).map((l) => ({ ...l })) // forceLink mutates links
      .sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.k, b.k));
    const s = forceSimulation(sim, 3).stop().randomSource(rand)
      .alphaDecay(1 - Math.pow(0.001, 1 / ticks)) // cool fully within `ticks`, also on the short incremental run
      .force('link', forceLink(ls).id((n: Sim) => n.key).distance((l: LayoutLink) => LINK[l.k].d).strength((l: LayoutLink) => LINK[l.k].s(l.w)))
      .force('charge', forceManyBody().strength(CHARGE).theta(0.9).distanceMax(CHARGE_MAX));
    // With pins the frame is already anchored; centering would drag new nodes away from their pinned neighbours.
    if (!sim.some((n) => n.pin)) s.force('center', forceCenter());
    s.tick(ticks);
  }
  return new Map(sim.map((n) => [n.key, [Math.round(n.x!), Math.round(n.y!), Math.round(n.z!)] as Vec3]));
}

const isVec3 = (p: unknown): p is Vec3 => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

/** Drops the pins of sources that no longer exist (forget, a deleted or moved note, a re-imported file) from both stores, in
 *  every key form ('source:<id>', public '@github', local '@owner'): deletion paths call this instead of knowing the forms. */
export async function prunePins(db: pg.Pool): Promise<number> {
  const r = await db.query(`
    WITH dead AS (
      SELECT s.k, array_agg(key) keys FROM state s, jsonb_object_keys(s.v) key
      WHERE s.k IN ('layout', $1) AND key ~ '^source:[0-9]+'
        AND NOT EXISTS (SELECT 1 FROM sources WHERE id = substring(key from '^source:([0-9]+)')::bigint)
      GROUP BY s.k)
    UPDATE state s SET v = s.v - dead.keys FROM dead WHERE s.k = dead.k RETURNING cardinality(dead.keys) n`, [SEM_STATE]);
  return r.rows.reduce((t, x) => t + x.n, 0);
}

/** Sets `xyz` on every node. 300 ticks on a first bake / after --rebake, 60 when a node is new, 0 otherwise (brain-serve's 5 s rebuild stays free). */
export async function bakeLayout(db: pg.Pool, nodes: BrainNode[], links: BrainLink[], rawOf: Map<string, string>) {
  const t = performance.now();
  const store: Record<string, unknown> = (await db.query(`SELECT v FROM state WHERE k = 'layout'`)).rows[0]?.v ?? {};
  const raw = (id: string) => rawOf.get(id)!;
  const spawnOf = new Map(links.filter((l) => l.k === 'spawn').map((l) => [l.source, l.target]));
  const ln: LayoutNode[] = nodes.map((n) => {
    const parent = spawnOf.get(n.id) ?? n.p, pin = store[raw(n.id)];
    return { key: raw(n.id), t0: n.t0, parent: parent && raw(parent), pin: isVec3(pin) ? pin : undefined };
  });
  const fresh = ln.filter((n) => !n.pin);
  const ticks = fresh.length === ln.length ? 300 : fresh.length ? 60 : 0;
  const pos = relax(ln, links.map((l) => ({ ...l, source: raw(l.source), target: raw(l.target) })), ticks);
  nodes.forEach((n, i) => (n.xyz = pos.get(ln[i].key)));
  if (!fresh.length) return;
  // Merge (||) so a concurrent bake (brain-serve + npm run data) can't drop the other's new pins.
  await db.query(`INSERT INTO state (k, v) VALUES ('layout', $1) ON CONFLICT (k) DO UPDATE SET v = state.v || EXCLUDED.v`,
    [JSON.stringify(Object.fromEntries(fresh.map((n) => [n.key, pos.get(n.key)])))]);
  console.error(`layout: ${fresh.length}/${ln.length} new, ${ticks} ticks, ${Math.round(performance.now() - t)} ms`);
}

// ── Semantic layout `s`: the "galaxy of meaning" lens (idea: apple/embedding-atlas). Each node sits by its bge-m3 centroid:
// PCA (block power iteration) → kNN candidates in PCA space, re-ranked by exact cosine → UMAP-lite SGD in 3D. Same frame
// as xyz: integer world units, centred on 0, p95 radius = xyz's. State 'layout:semantic' (raw key → [vector count, x, y, z, PCA coords]) keeps it stable:
// unchanged nodes never move, new/grown ones land among their nearest neighbours, and a rare full refit (the galaxy grew
// by REFIT) starts from the old positions and is Procrustes-aligned onto them.
const SEM_DIMS = 32; // PCA dims for the kNN candidates
// re-ranked by exact 1024-d cosine: PCA-32 alone lost most note→session neighbours (eval, real 4.7k nodes: notes' kNN-10
// preservation 0.21 → 0.29, all 0.40 → 0.46; full fit 2.4 → 3.5 s; PCA-128 gave the notes the same at 6 s and a 4× state)
const SEM_CAND = 100;
const SEM_ITERS = 3; // block power iterations (≈ randomized SVD with 2 power steps)
const SEM_NN = 10; // neighbours per node
const SEM_EPOCHS = 200;
const SEM_NEG = 5; // negative samples per edge and epoch
// UMAP's curve 1 / (1 + a·d^2b) with b = 1.5, so d^(2b-2) is a sqrt (no Math.pow in the hot loop). Tuned on the real 4.7k
// nodes (tmp eval): Cauchy a = b = 1 collapsed clusters onto points (median nearest neighbour 1.0 units, 80 % within 1.5);
// a = 0.08 → median 4.1 (node radii 1.2..18), and kNN-10 preservation 0.40 → 0.42
const SEM_A = 0.08;
const WARM_LR = 0.1; // a refit starts from the old galaxy; a low rate keeps its shape (eval, +50 % nodes: old ones move 12 units mean, a cold fit + Procrustes 39)
const GROW = 1.25; // re-place a node once its vector count changed by this factor (an active session drifts as it grows)
const REFIT = 1.5; // full refit once the galaxy has this many times the nodes of the last fit
const SEM_JITTER = 3; // a placed node = mean of its neighbours ± this, so siblings don't stack
const SEM_STATE = 'layout:semantic';

export type Pca = { mean: Float32Array; basis: Float32Array }; // basis: k rows of d
type SemEntry = [n: number, x: number, y: number, z: number, pc: string]; // pc = base64 float32 PCA coords
type SemMeta = { n: number; scale: number; mean: string; basis: string }; // n = nodes at the last full fit

function unit(v: Float32Array): Float32Array {
  let s = 0;
  for (let j = 0; j < v.length; j++) s += v[j] * v[j];
  return v.map((x) => x / (Math.sqrt(s) || 1)); // cosine space: the centroid's length is just how focused the chunks are
}
const dotAt = (a: ArrayLike<number>, b: ArrayLike<number>, off: number, d: number) => {
  let s = 0;
  for (let j = 0; j < d; j++) s += a[j] * b[off + j];
  return s;
};
const dist2 = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let j = 0; j < a.length; j++) s += (a[j] - b[j]) * (a[j] - b[j]);
  return s;
};

/** Coordinates of one centroid in a fitted PCA (unit-normalised, centred, projected). */
export function project(p: Pca, v: Float32Array): Float32Array {
  const d = p.mean.length, x = unit(v).map((x, j) => x - p.mean[j]);
  return Float32Array.from({ length: p.basis.length / d }, (_, c) => dotAt(x, p.basis, c * d, d));
}

/** Seeded PCA of unit-normalised rows by block power iteration with Gram-Schmidt (no eigen solver needed). */
export function pca(rows: Float32Array[], dims = SEM_DIMS, rand = lcg()): Pca & { z: Float32Array[] } {
  const n = rows.length, d = rows[0]?.length ?? 0, k = Math.min(dims, n, d);
  const X = rows.map(unit), mean = new Float32Array(d);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j] / n;
  for (const x of X) for (let j = 0; j < d; j++) x[j] -= mean[j];
  let basis = Float32Array.from({ length: k * d }, () => rand() * 2 - 1);
  for (let it = 0; it < SEM_ITERS; it++) {
    const next = new Float64Array(k * d); // = (Xᵀ X basisᵀ)ᵀ, one pass over the rows
    for (const x of X) for (let c = 0; c < k; c++) {
      const w = dotAt(x, basis, c * d, d);
      for (let j = 0; j < d; j++) next[c * d + j] += w * x[j];
    }
    for (let c = 0; c < k; c++) { // orthonormalise: row 0 follows plain power iteration, so rows come out ≈ by variance
      const row = next.subarray(c * d, c * d + d);
      for (let b = 0; b < c; b++) {
        const w = dotAt(row, next, b * d, d);
        for (let j = 0; j < d; j++) row[j] -= w * next[b * d + j];
      }
      const len = Math.sqrt(dotAt(row, row, 0, d)) || 1;
      for (let j = 0; j < d; j++) row[j] /= len;
    }
    basis = Float32Array.from(next);
  }
  return { mean, basis, z: X.map((x) => Float32Array.from({ length: k }, (_, c) => dotAt(x, basis, c * d, d))) };
}

/** Keeps idx/dist (nearest first) the smallest seen; ties keep the earlier index (determinism). */
function offer(idx: Int32Array, dist: Float64Array, j: number, d2: number) {
  let p = idx.length - 1;
  if (p < 0 || d2 >= dist[p]) return;
  for (; p > 0 && dist[p - 1] > d2; p--) [idx[p], dist[p]] = [idx[p - 1], dist[p - 1]];
  [idx[p], dist[p]] = [j, d2];
}

/** Exact k nearest neighbours (Euclidean in PCA space of unit vectors ≈ cosine order). ponytail: O(n²·dims), ~0.3 s at 5k nodes; an ANN index past ~30k */
export function knn(z: Float32Array[], k = SEM_NN): Int32Array[] {
  const n = z.length, kk = Math.max(0, Math.min(k, n - 1));
  const idx = z.map(() => new Int32Array(kk).fill(-1)), dist = z.map(() => new Float64Array(kk).fill(Infinity));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d2 = dist2(z[i], z[j]);
    offer(idx[i], dist[i], j, d2);
    offer(idx[j], dist[j], i, d2);
  }
  return idx;
}

/** Keeps the k of each node's candidates that are nearest by exact cosine (Euclidean on unit vectors). */
export function rerank(rows: Float32Array[], cand: Int32Array[], k = SEM_NN): Int32Array[] {
  const U = rows.map(unit);
  return cand.map((c, i) => {
    const idx = new Int32Array(Math.min(k, c.length)).fill(-1), dist = new Float64Array(idx.length).fill(Infinity);
    for (const j of c) offer(idx, dist, j, dist2(U[i], U[j]));
    return idx;
  });
}

/** UMAP-lite: SGD on the kNN graph in 3D with negative sampling (UMAP's gradients, see SEM_A) → tight, separated clusters. */
export function embed(nbr: Int32Array[], init: Vec3[], epochs = SEM_EPOCHS, lr0 = 1, rand = lcg()): Vec3[] {
  const n = nbr.length, y = new Float64Array(n * 3);
  init.forEach((p, i) => y.set(p, i * 3));
  const clip = (g: number) => (g > 4 ? 4 : g < -4 ? -4 : g);
  const d2At = (a: number, b: number) => (y[a] - y[b]) ** 2 + (y[a + 1] - y[b + 1]) ** 2 + (y[a + 2] - y[b + 2]) ** 2;
  for (let e = 0; e < epochs; e++) {
    const lr = lr0 * (1 - e / epochs);
    for (let i = 0; i < n; i++) for (const j of nbr[i]) {
      const a = i * 3;
      let b = j * 3, d2 = d2At(a, b), r = Math.sqrt(d2), g = (-3 * SEM_A * r) / (1 + SEM_A * d2 * r);
      for (let c = 0; c < 3; c++) {
        const v = clip(g * (y[a + c] - y[b + c])) * lr;
        y[a + c] += v;
        y[b + c] -= v;
      }
      for (let s = 0; s < SEM_NEG; s++) {
        b = Math.floor(rand() * n) * 3;
        if (b === a) continue;
        d2 = d2At(a, b);
        r = Math.sqrt(d2);
        g = 3 / ((0.001 + d2) * (1 + SEM_A * d2 * r));
        for (let c = 0; c < 3; c++) y[a + c] += (d2 > 0 ? clip(g * (y[a + c] - y[b + c])) : 4) * lr;
      }
    }
  }
  return Array.from({ length: n }, (_, i) => [y[i * 3], y[i * 3 + 1], y[i * 3 + 2]]);
}

/** Orthogonal polar factor of a 3×3 matrix (Newton: X ← (X + X⁻ᵀ)/2); identity when degenerate. */
function polar(M: number[]): number[] {
  let X = M.slice();
  for (let it = 0; it < 100; it++) {
    const [a, b, c, d, e, f, g, h, i] = X;
    const C = [e * i - f * h, f * g - d * i, d * h - e * g, c * h - b * i, a * i - c * g, b * g - a * h, b * f - c * e, c * d - a * f, a * e - b * d];
    const det = a * C[0] + b * C[1] + c * C[2], norm2 = X.reduce((s, x) => s + x * x, 0);
    if (!(Math.abs(det) > 1e-12 * norm2 ** 1.5)) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const next = X.map((x, k) => (x + C[k] / det) / 2); // C / det = X⁻ᵀ
    const done = next.every((x, k) => Math.abs(x - X[k]) < 1e-12);
    X = next;
    if (done) break;
  }
  return X;
}

/** Least-squares similarity transform (rotation or mirror, uniform scale, shift) taking `from` onto `to` (orthogonal Procrustes). */
export function procrustes(from: Vec3[], to: Vec3[]): { s: number; map: (p: Vec3) => Vec3 } {
  const m = from.length || 1, mean = (ps: Vec3[]) => [0, 1, 2].map((c) => ps.reduce((s, p) => s + p[c], 0) / m);
  const cf = mean(from), ct = mean(to), M = new Array<number>(9).fill(0);
  let ff = 0;
  from.forEach((f, i) => {
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) M[a * 3 + b] += (f[a] - cf[a]) * (to[i][b] - ct[b]);
      ff += (f[a] - cf[a]) ** 2;
    }
  });
  const R = polar(M), s = ff ? R.reduce((t, r, k) => t + r * M[k], 0) / ff : 1;
  return { s, map: (p) => [0, 1, 2].map((b) => ct[b] + s * [0, 1, 2].reduce((t, a) => t + (p[a] - cf[a]) * R[a * 3 + b], 0)) as Vec3 };
}

const round = (x: number) => Math.round(x) + 0; // + 0: no -0, which a JSON round trip (the state) would turn into 0
const round3 = (p: Vec3): Vec3 => [round(p[0]), round(p[1]), round(p[2])];

/**
 * Full fit, deterministic for the same rows in any order. With `prev` (key → old world xyz; `scale` = old world units per
 * SGD unit) known nodes start where they were and the result is aligned onto them; else centred, p95 radius = `radius`.
 */
export function fitSemantic(rows: { key: string; v: Float32Array }[], radius: number, prev = new Map<string, Vec3>(), scale = 1) {
  rows = [...rows].sort((a, b) => cmp(a.key, b.key));
  const rand = lcg();
  const p = pca(rows.map((r) => r.v), SEM_DIMS, rand), nbr = rerank(rows.map((r) => r.v), knn(p.z, SEM_CAND));
  const old = rows.map((r) => prev.get(r.key)), known = old.filter(Boolean).length >= 4;
  let init: Vec3[];
  if (known) { // warm start: old spots; a new node starts at the mean of its known neighbours
    init = old.map((o) => (o ? (o.map((x) => x / scale) as Vec3) : [0, 0, 0]));
    old.forEach((o, i) => {
      const ks = [...nbr[i]].filter((j) => old[j]);
      if (!o && ks.length) init[i] = [0, 1, 2].map((c) => ks.reduce((s, j) => s + init[j][c], 0) / ks.length) as Vec3;
    });
  } else { // the top 3 principal axes, max |coord| = 10 (UMAP's spectral-init range)
    const top = Math.max(1e-9, ...p.z.flatMap((z) => [...z.subarray(0, 3)].map(Math.abs)));
    init = p.z.map((z) => [0, 1, 2].map((c) => ((z[c] ?? 0) / top) * 10) as Vec3);
  }
  const u = embed(nbr, init, SEM_EPOCHS, known ? WARM_LR : 1, rand);
  let pos: Vec3[];
  if (known) {
    const both = rows.map((_, i) => i).filter((i) => old[i]);
    const t = procrustes(both.map((i) => u[i]), both.map((i) => old[i]!));
    pos = u.map((q) => round3(t.map(q)));
    scale = t.s;
  } else {
    const c = [0, 1, 2].map((k) => u.reduce((s, q) => s + q[k], 0) / (u.length || 1));
    const r = u.map((q) => Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2])).sort((a, b) => a - b);
    scale = radius / (r[Math.floor(r.length * 0.95)] || 1);
    pos = u.map((q) => round3([0, 1, 2].map((k) => (q[k] - c[k]) * scale) as Vec3));
  }
  return { pca: p as Pca, scale, pos: new Map(rows.map((r, i) => [r.key, pos[i]])), z: new Map(rows.map((r, i) => [r.key, p.z[i]])) };
}

/** A new or grown node: its PCA coords, and the mean spot of its SEM_NN nearest placed nodes ± a per-key (order-free) jitter. */
export function placeNear(p: Pca, placed: { z: Float32Array; xyz: Vec3 }[], key: string, v: Float32Array): { z: Float32Array; xyz: Vec3 } {
  const z = project(p, v), idx = new Int32Array(Math.min(SEM_NN, placed.length)), dist = new Float64Array(idx.length).fill(Infinity);
  placed.forEach((q, j) => offer(idx, dist, j, dist2(z, q.z)));
  const rand = lcg([...key].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7));
  return { z, xyz: [0, 1, 2].map((c) => round([...idx].reduce((s, j) => s + placed[j].xyz[c], 0) / (idx.length || 1) + (rand() * 2 - 1) * SEM_JITTER)) as Vec3 };
}

const b64 = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const unb64 = (s: string) => new Float32Array(Uint8Array.from(Buffer.from(s, 'base64')).buffer); // copy: Float32Array needs 4-byte alignment
/** pgvector's binary form (vector_send): uint16 dims, uint16 unused, float32 big-endian. Faster than text, no float parsing. */
export function fromVectorSend(b: Buffer): Float32Array {
  const v = new Float32Array(b.readUInt16BE(0));
  for (let j = 0; j < v.length; j++) v[j] = b.readFloatBE(4 + 4 * j);
  return v;
}

/**
 * Sets `s` on every node with vectors (`vectors` = node id → embedded chunks) and on project hubs (their children's mean).
 * Unchanged nodes cost one state read: the hourly export pays only for new or grown nodes.
 * `hide` nodes keep their spot in the shared state but get no `s` (public GitHub items: see brain.ts hubOf).
 */
export async function bakeSemantic(db: pg.Pool, nodes: BrainNode[], rawOf: Map<string, string>, vectors: Map<string, number>, hide = (_: BrainNode) => false) {
  const t = performance.now();
  // one galaxy for both modes: meaning doesn't depend on the hub, so an '@github' / '@owner' key shares the home key's spot
  const keyOf = (n: BrainNode) => rawOf.get(n.id)!.replace(/@(github|owner)$/, '');
  const count = new Map(nodes.filter((n) => n.type !== 'project' && vectors.get(n.id)! > 0).map((n) => [keyOf(n), vectors.get(n.id)!]));
  if (!count.size) return;
  const store: Record<string, unknown> = (await db.query(`SELECT v FROM state WHERE k = $1`, [SEM_STATE])).rows[0]?.v ?? {};
  const meta = store['#'] as SemMeta | undefined;
  const entry = (k: string) => (Array.isArray(store[k]) && store[k].length === 5 ? (store[k] as SemEntry) : undefined);
  const fresh = [...count].filter(([k, n]) => { const e = entry(k); return !e || n > e[0] * GROW || n * GROW < e[0]; }).map(([k]) => k);
  const full = !meta || count.size > meta.n * REFIT;
  if (fresh.length || full) {
    const ids = full ? null : fresh.map((k) => k.slice('source:'.length));
    const rows = (await db.query(`SELECT source_id::text id, vector_send(avg(embedding)::vector) e FROM chunks
      WHERE embedding IS NOT NULL AND ($1::bigint[] IS NULL OR source_id = ANY($1)) GROUP BY 1`, [ids])).rows
      .map((r) => ({ key: 'source:' + r.id, v: fromVectorSend(r.e) })).filter((r) => count.has(r.key));
    const put: Record<string, unknown> = {};
    if (full) {
      const xyz = nodes.map((n) => (n.xyz ? Math.hypot(...n.xyz) : 0)).sort((a, b) => a - b);
      const prev = new Map(rows.filter((r) => entry(r.key)).map((r) => [r.key, entry(r.key)!.slice(1, 4) as Vec3]));
      const fit = fitSemantic(rows, xyz[Math.floor(xyz.length * 0.95)] || 300, prev, meta?.scale);
      put['#'] = { n: rows.length, scale: fit.scale, mean: b64(fit.pca.mean), basis: b64(fit.pca.basis) } satisfies SemMeta;
      for (const r of rows) put[r.key] = [count.get(r.key), ...fit.pos.get(r.key)!, b64(fit.z.get(r.key)!)];
    } else {
      const p: Pca = { mean: unb64(meta!.mean), basis: unb64(meta!.basis) };
      const set = new Set(fresh), pool = [...count.keys()].filter((k) => !set.has(k) && entry(k)).sort(cmp);
      const placed = pool.map((k) => ({ z: unb64(entry(k)![4]), xyz: entry(k)!.slice(1, 4) as Vec3 }));
      for (const r of rows) {
        const { z, xyz } = placeNear(p, placed, r.key, r.v);
        put[r.key] = [count.get(r.key), ...xyz, b64(z)];
      }
    }
    // full: replace (drops deleted sources); else merge (||), so a concurrent export (brain-serve + npm run data) keeps the other's nodes
    await db.query(`INSERT INTO state (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = ${full ? 'EXCLUDED.v' : 'state.v || EXCLUDED.v'}`,
      [SEM_STATE, JSON.stringify(put)]);
    Object.assign(store, put);
    console.error(`semantic: ${full ? 'full fit' : 'placed'} ${rows.length}/${count.size}, ${Math.round(performance.now() - t)} ms`);
  }
  const hubs = new Map<string, number[]>(); // hub id → x, y, z sums + count
  for (const n of nodes) {
    const e = n.type === 'project' || hide(n) || !count.has(keyOf(n)) ? undefined : entry(keyOf(n));
    if (!e) continue;
    n.s = [e[1], e[2], e[3]];
    if (!n.p) continue;
    const h = hubs.get(n.p) ?? hubs.set(n.p, [0, 0, 0, 0]).get(n.p)!;
    for (let c = 0; c < 3; c++) h[c] += n.s[c];
    h[3]++;
  }
  for (const n of nodes) {
    const h = n.type === 'project' ? hubs.get(n.id) : undefined;
    if (h) n.s = [round(h[0] / h[3]), round(h[1] / h[3]), round(h[2] / h[3])];
  }
}
