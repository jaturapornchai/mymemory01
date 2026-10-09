// Engine: owns its <canvas> + WebGLRenderer, turns graph diffs / event batches into instance writes, and runs the
// frame loop (on demand when idle, time-paced to ~30 fps on 30 fps targets, paused when hidden or 0×0). Context loss and
// tier changes are not repaired in place: cb.lost() makes the React shell remount a fresh engine (one code path).
import { Color, Scene, Vector2, Vector3, WebGLRenderer } from 'three';
import { appearAt, linkKey, upperBound, type BrainEvent, type BrainLink, type BrainNode } from '../../lib/brain';
import { CameraRig, easeInOutCubic, type View } from './camera';
import { Edges } from './edges';
import { createFx, type Fx } from './fx';
import { ALIVE, NEVER, Nodes, type Uniforms } from './nodes';
import { pick } from './pick';
import { Governor, type GovAction } from './quality';
import { addAdjacency, echoOf, placeFallback, SlotTable, type Slot } from './slots';
import { BASE_LINEAR, THEME, TIERS, TYPE_INDEX, TYPES, appLinear, fireAmp, hexToLinear, linkStyle, nodeRadius, rimLevel, type Theme, type Tier, type Vec3 } from './style';

export type { View };
export interface EngineCallbacks {
  hover(node: BrainNode | null, xy: { x: number; y: number } | null): void;
  select(node: BrainNode | null): void;
  autoFollowPause(untilEpochMs: number): void;
  lost(reason: 'context' | 'tier' | 'clock', view: View | null, tier: Tier): void;
}
export interface EngineOptions {
  tier: Tier;
  /** read once: a theme switch remounts a fresh engine */
  theme: Theme;
  reducedMotion: boolean;
  /** ?debug=1: window.__brain hooks for scene-check */
  debug: boolean;
  /** ?probe=1: flat colours, fixed camera, no pulses/dust/vignette/intro (pixel-exact palette check) */
  probe: boolean;
  view?: View | null;
}
export interface Engine {
  cb: EngineCallbacks;
  /** current tier (the governor or a missing capability may have lowered the requested one) */
  readonly tier: Tier;
  setGraph(g: { nodes: readonly BrainNode[]; links: readonly BrainLink[] }): void;
  fire(events: readonly BrainEvent[]): void;
  setFollow(b: boolean): void;
  setReducedMotion(b: boolean): void;
  setSelected(id: string | null): void;
  /** "สีตาม AI": nodes take their app's colour (no app: grey), edges lose their family tints */
  setLens(on: boolean): void;
  /**
   * "จัดตามความหมาย": every node morphs (MORPH_S, eased) from its baked xyz to its position by meaning (BrainNode.s) and
   * back; nodes without one (and project hubs) shrink away with their links; the camera flies to the new overview.
   * `animate` false (a remount): jump there, camera untouched. Reduced motion: a cut.
   */
  setSemantic(on: boolean, animate?: boolean): void;
  /** Fades every node but `ids` (null = none faded); `pulse` also fires them (comets on their links), never a flight */
  spotlight(ids: ReadonlySet<string> | null, pulse: boolean): void;
  focus(id: string): void;
  /**
   * Page-load intro running (null = not, or over): `world` = every node with baked xyz, so the camera, dust and comet
   * speed use the final brain's bounds from the first frame; `progress` 0..1 drives the camera (tiers with intro).
   */
  setIntro(i: { world: readonly BrainNode[]; from: number; progress: () => number } | null): void;
  /** The intro reached LIVE: natural → ShockWave + bloom pulse at the centroid; skipped → 600 ms flight to the overview. */
  beat(natural: boolean): void;
  setSize(w: number, h: number): void;
  /** CSS px of the canvas the HUD covers at the top / bottom / right: the overview fits and centres in the area left */
  setInsets(top: number, bottom: number, right: number): void;
  getView(): View | null;
  dispose(): void;
}

const ROOT_R = 40; // fallback "parent radius" for hubs placed around the origin
const BURST = 300; // more births than this in one diff = replay jump: settle instead of pop-in
const SHOCK_EVERY_S = 2;
const MORPH_S = 1.6;
const TIER_KEY = 'brainTier';
const PROBE_RAFS = 12; // governor cap probe: bare rAF intervals measured with rendering paused
// uTime is a float32 uniform: past ~1 day its step exceeds 8 ms and every shader animation starts to stutter
// (62 ms steps after a week). A remount restarts the clock; the view and tier carry over.
const CLOCK_REBASE_S = 86400;
// a search/recall also lights the node's 1-hop synapse neighbours, dimmer and a beat later (viewer-only: no data)
const ECHO_KINDS: ReadonlySet<BrainLink['k']> = new Set(['link', 'prov', 'next', 'coaccess']);
const ECHO_GAIN = 0.4;
const ECHO_DELAY_S = 0.15;
const NOOP_CB: EngineCallbacks = { hover() {}, select() {}, autoFollowPause() {}, lost() {} };

/** Throws when WebGL2 is unavailable (the shell shows the T0 notice). */
export function createEngine(host: HTMLElement, o: EngineOptions): Engine {
  const canvas = document.createElement('canvas');
  const light = o.theme === 'light';
  // light tiers without a ShockWave have no composer, hence no MSAA: ask the canvas for it instead
  const antialias = TIERS[o.tier].antialias || (light && !TIERS[o.tier].post?.shock);
  const ctx = canvas.getContext('webgl2', { antialias, alpha: false, stencil: false, powerPreference: 'high-performance' });
  if (!ctx) throw new Error('WebGL2 unavailable');
  const gl: WebGL2RenderingContext = ctx; // non-null for the hoisted functions below
  host.appendChild(canvas);
  const renderer = new WebGLRenderer({ canvas, context: gl, antialias, stencil: false });
  const scene = new Scene();
  scene.background = new Color(THEME[o.theme].bg);
  const rig = new CameraRig(canvas);

  // capability gate: no half/float colour buffers → no HDR composer → LOW (remount for a natively antialiased context)
  const halfFloat = !!(gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float'));
  let tier: Tier = halfFloat ? o.tier : 'low';
  let spec = TIERS[tier];
  const coarse = matchMedia('(pointer: coarse)').matches;
  const dprMax = Math.min(devicePixelRatio || 1, spec.dprCap);
  let dpr = dprMax;
  renderer.setPixelRatio(dpr);

  const U: Uniforms = {
    uTime: { value: 0 },
    uReduced: { value: o.reducedMotion ? 1 : 0 },
    uProbe: { value: o.probe ? 1 : 0 },
    uLow: { value: spec.post ? 0 : 1 },
    uLight: { value: light ? 1 : 0 },
    uBg: { value: new Vector3(...hexToLinear(THEME[o.theme].bg)) },
    uAccent: { value: new Vector3(...hexToLinear(THEME[o.theme].accent)) },
    uDimNear: { value: 0 },
    uDimFar: { value: 1 },
    uLens: { value: 0 },
    uSpot: { value: 0 },
    uMorph: { value: 0 },
  };
  const EU: Uniforms = { uSpeed: { value: 50 }, uAmbient: { value: spec.ambient }, uAmbI: { value: spec.ambientI }, uCentroid: { value: new Vector3() }, uRes: { value: new Vector2(1, 1) } };
  const nodes = new Nodes(scene, U, spec.icoDetail, EU.uRes);
  const edges = new Edges(scene, U, spec.segments, EU, light);
  let fx: Fx;
  let lostQueued = !halfFloat && o.tier !== 'low';
  try {
    fx = createFx(renderer, scene, rig.camera, spec, U, o.probe, light);
  } catch {
    tier = 'low';
    spec = TIERS.low;
    U.uLow.value = 1;
    fx = createFx(renderer, scene, rig.camera, spec, U, o.probe, light);
    lostQueued = true;
  }

  const startMs = performance.now();
  const clock = () => (performance.now() - startMs) / 1000;
  const gov = new Governor(tier, dpr, 1000 / spec.fps[coarse ? 1 : 0], Math.min(spec.dprFloor, dprMax), startMs);

  // ── graph state ──
  const nodeSlots = new SlotTable<BrainNode>((n) => n.id, (n) => TYPE_INDEX[n.type], TYPES.length);
  const linkSlots = new SlotTable<BrainLink>(linkKey, () => 0);
  const adj = new Map<string, number[]>();
  const fanCursor = new Map<string, number>();
  const spawnParent = new Map<string, string>();
  const kids = new Map<string, number>();
  const center = new Vector3();
  let R = 0;
  let reduced = o.reducedMotion;
  let selectedId: string | null = null;
  let spot: ReadonlySet<string> | null = null;
  let hovered: Slot<BrainNode> | null = null;
  let animUntil = 0;
  let lastShock = -Infinity;
  let intro = false; // no follow flights while the page-load intro runs
  // a remount (theme, tier, context) carries a running shot on in its first setIntro (the mount's) only: every later ▶
  // is a new shot (reading o.view for the engine's whole life left ▶ shot-less after any remount)
  let carryShot = !o.view || !!o.view.intro;
  let semantic = false;
  const morph = { from: 0, to: 0, t0: 0, dur: 0 }; // uMorph eases from → to over dur s from t0
  const cFrom = new Vector3(); // the edges' bow centroid before the morph (eased to the new one along with it)
  const timers = new Set<ReturnType<typeof setTimeout>>();

  rig.reduced = reduced;
  rig.fixed = o.probe;
  fx.setReduced(reduced);
  if (o.view) rig.setView(o.view);

  const tmp: Vec3 = [0, 0, 0];
  const v3 = new Vector3();
  const posOf = (s: Slot<BrainNode>) => nodes.pos(s.group, s.slot, [0, 0, 0]);
  const shown = (s: Slot<BrainNode>) => nodes.shown(s.group, s.slot) >= 0.5;
  // project hubs have an s (their children's mean), but there they float unlinked to anything by meaning, and their
  // "in" spokes crossed the whole galaxy: they shrink away like nodes without one
  const semOf = (n: BrainNode): Vec3 | null => (n.s && n.type !== 'project' ? [n.s[0], n.s[1], n.s[2]] : null);
  // in / spawn record where a node came from, not what it is about: by meaning they drew bundles across the galaxy
  const semLink = (l: BrainLink) => l.k !== 'in' && l.k !== 'spawn';

  function applySelected() {
    const s = selectedId ? nodeSlots.byKey.get(selectedId) : undefined;
    nodes.highlight('uSel', s?.live ? s.group : -1, s?.slot ?? -1);
  }

  function flyToSlot(s: Slot<BrainNode>, overview = false) {
    const p = new Vector3(...posOf(s));
    const r = nodes.radius(s.group, s.slot);
    rig.flyTo(p, r, overview, undefined, overview ? {} : { dir: clearView(s, p, r) });
    invalidate();
  }

  /**
   * A close-up's view direction: the current one, else the nearest of 128 spread over the sphere (none steeper than
   * ±58°, where the orbit turns about the pole) with no other live node in front of `s` whose sphere (+25 %: the idle
   * orbit drifts) the sight line crosses. Big neighbouring sessions, often overlapping it, hid a selected one; "in
   * front" = centre nearer the camera, as picking decides. Once per tap, ≤ 129 × N sphere tests (a few ms at 4k).
   * undefined: all blocked, keep the current direction.
   */
  function clearView(s: Slot<BrainNode>, p: Vector3, r: number): Vector3 | undefined {
    const d1 = rig.closeD(r);
    const base = rig.camera.position.clone().sub(rig.controls.target).normalize();
    const tries: Vector3[] = [];
    for (let i = 0; i < 128; i++) {
      const y = 1 - (2 * i + 1) / 128; // Fibonacci sphere
      const q = Math.sqrt(1 - y * y);
      if (Math.abs(y) < 0.85) tries.push(new Vector3(Math.cos(i * 2.39996) * q, y, Math.sin(i * 2.39996) * q));
    }
    tries.sort((a, b) => b.dot(base) - a.dot(base)).unshift(base);
    const c = new Vector3();
    const blocked = (dir: Vector3) => {
      for (const o of nodeSlots.byKey.values()) {
        if (o === s || !o.live || !shown(o)) continue;
        c.set(...nodes.pos(o.group, o.slot, tmp)).sub(p);
        const along = c.dot(dir);
        const ro = 1.25 * nodes.radius(o.group, o.slot);
        if (along > 0 && c.distanceToSquared(v3.copy(dir).multiplyScalar(Math.min(d1, along))) < ro * ro) return true;
      }
      return false;
    };
    return tries.find((d) => !blocked(d));
  }

  function setGraph(g: { nodes: readonly BrainNode[]; links: readonly BrainLink[] }) {
    const t = clock();
    const nd = nodeSlots.diff(g.nodes);
    const ld = linkSlots.diff(g.links);
    for (const s of ld.added) {
      const l = s.item;
      if (l.k !== 'spawn') continue;
      const childIsSource = nodeSlots.byKey.get(l.source)?.item.type === 'subagent';
      spawnParent.set(childIsSource ? l.source : l.target, childIsSource ? l.target : l.source);
    }
    const births = nd.added.length + nd.revived.length;
    const instant = R === 0 || reduced; // first graph after mount, or reduced motion: no pop-in
    const born = instant ? NEVER : births > BURST ? t - 0.45 : t;
    const dead = reduced ? t - 1 : t;

    TYPES.forEach((_, gi) => nodes.ensure(gi, nodeSlots.count[gi]));
    for (const s of nd.added) {
      const n = s.item;
      const parentId = spawnParent.get(n.id) ?? n.p;
      const ps = parentId ? nodeSlots.byKey.get(parentId) : undefined;
      const pp = ps ? posOf(ps) : ([0, 0, 0] as Vec3);
      let p: Vec3;
      if (n.xyz) p = [n.xyz[0], n.xyz[1], n.xyz[2]];
      else {
        const key = parentId ?? '';
        const k = kids.get(key) ?? 0;
        kids.set(key, k + 1);
        p = placeFallback(ps ? nodes.home(ps.group, ps.slot) : pp, ps ? nodes.radius(ps.group, ps.slot) : ROOT_R, k); // home: pp may be by meaning
      }
      const sem = semOf(n);
      const here = sem ? (p.map((v, i) => v + (sem[i] - v) * nodes.morph) as Vec3) : p; // no parent: born in place
      nodes.place(s.group, s.slot, p, nodeRadius(n.type, n.n), rimLevel(n.u), born, ps ? pp : here, appLinear(n), sem);
      if (spot?.has(n.id)) nodes.spot(s.group, s.slot, true);
    }
    for (const s of nd.revived) {
      nodes.restyle(s.group, s.slot, nodeRadius(s.item.type, s.item.n), rimLevel(s.item.u));
      nodes.life(s.group, s.slot, born, ALIVE);
    }
    for (const s of nd.replaced) nodes.restyle(s.group, s.slot, nodeRadius(s.item.type, s.item.n), rimLevel(s.item.u));
    for (const s of nd.removed) nodes.life(s.group, s.slot, null, dead);
    TYPES.forEach((_, gi) => nodes.setCount(gi, nodeSlots.count[gi]));

    edges.ensure(linkSlots.count[0]);
    for (const s of ld.added) {
      const l = s.item;
      const a = nodeSlots.byKey.get(l.source);
      const b = nodeSlots.byKey.get(l.target);
      if (!a || !b) continue; // the store guarantees endpoints; a zero-length instance is invisible anyway
      edges.place(s.slot, nodes.home(a.group, a.slot), nodes.home(b.group, b.slot), nodes.sem(a.group, a.slot), nodes.sem(b.group, b.slot), BASE_LINEAR[a.item.type], BASE_LINEAR[b.item.type], [...linkStyle(l.k, l.w), +semLink(l)], born);
      addAdjacency(adj, l.source, l.target, s.slot);
    }
    for (const s of ld.revived) edges.life(s.slot, born, ALIVE);
    for (const s of ld.removed) edges.life(s.slot, null, dead);
    edges.setCount(linkSlots.count[0]);

    if (R === 0 && nodeSlots.byKey.size) frameFirst();
    else if (nd.added.length) {
      for (const s of nd.added) if (shown(s)) R = Math.max(R, center.distanceTo(new Vector3(...nodes.pos(s.group, s.slot, tmp))));
      rig.setBounds(R);
    }
    if (nd.removed.length) rig.pullOut(center);
    if (rig.intro && births) {
      // the intro shot follows the births: centroid + spread (centre distance + radius) of the live nodes
      const live = [...nodeSlots.byKey.values()].filter((s) => s.live);
      const goal = new Vector3();
      for (const s of live) goal.add(v3.set(...nodes.pos(s.group, s.slot, tmp)));
      goal.divideScalar(live.length);
      let rb = 0;
      for (const s of live) rb = Math.max(rb, goal.distanceTo(v3.set(...nodes.pos(s.group, s.slot, tmp))) + nodes.radius(s.group, s.slot));
      [rig.intro.goal, rig.intro.rb] = [goal, rb];
    }
    if (!instant && births + nd.removed.length + ld.added.length) animUntil = Math.max(animUntil, t + 0.7);
    // ShockWave on a hub birth, ≤ 1 per 2 s, never during a replay-jump burst
    if (!instant && births <= BURST && t - lastShock >= SHOCK_EVERY_S) {
      const hub = [...nd.added, ...nd.revived].find((s) => s.item.type === 'project' || s.item.type === 'session');
      if (hub) {
        lastShock = t;
        fx.explode(new Vector3(...posOf(hub)), t);
      }
    }
    applySelected();
    if (hovered && !hovered.live && setHovered(null)) engine.cb.hover(null, null); // scrubbed away under the pointer
    invalidate();
  }

  function frameFirst() {
    setWorld(worldPts());
  }
  /**
   * [position, radius] of every node drawn at the current nodes.morph, live or not: scrubbed-back or not-yet-replayed
   * nodes count, as in the first frame (setGraph grows R for new nodes only), or the lens toggled in the past framed the
   * few nodes at the playhead and capped the zoom-out once the rest came back
   */
  function worldPts(): [Vec3, number][] {
    const pts: [Vec3, number][] = [];
    nodeSlots.byKey.forEach((s) => {
      if (shown(s)) pts.push([posOf(s), nodes.radius(s.group, s.slot)]);
    });
    return pts;
  }

  /** Semantic lens frame step: the reticle and the edges' bow centroid ride along. */
  function tickMorph(t: number) {
    if (U.uMorph.value === morph.to) return;
    const e = easeInOutCubic(morph.dur ? Math.min(1, (t - morph.t0) / morph.dur) : 1);
    U.uMorph.value = nodes.morph = e >= 1 ? morph.to : morph.from + (morph.to - morph.from) * e;
    (EU.uCentroid.value as Vector3).lerpVectors(cFrom, center, e);
    applySelected();
  }

  /** Bounds from [position, radius] pairs → centroid + R: framing, depth cue range, comet speed, dust shell. */
  function setWorld(pts: [Vec3, number][]) {
    center.set(0, 0, 0);
    for (const [p] of pts) center.add(v3.set(...p));
    center.divideScalar(Math.max(1, pts.length));
    R = 20;
    for (const [p, r] of pts) R = Math.max(R, center.distanceTo(v3.set(...p)) + r);
    (EU.uCentroid.value as Vector3).copy(center);
    EU.uSpeed.value = 0.5 * R;
    if (rig.framed) rig.setBounds(R);
    else rig.frame(center, R);
    fx.setDust(center, R, dpr);
  }

  function fire(events: readonly BrainEvent[], fly = true) {
    if (o.probe || !events.length) return;
    const t = clock();
    const sums = new Map<string, number>();
    const asked = new Set<string>(); // nodes a search / recall hit: a request, not a chat turn being indexed
    for (const e of events) {
      if (!nodeSlots.byKey.get(e[1])?.live) continue;
      sums.set(e[1], (sums.get(e[1]) ?? 0) + e[3]);
      if (e[2] !== 'turn') asked.add(e[1]);
    }
    let budget = spec.budget;
    let best: Slot<BrainNode> | null = null;
    let bestN = -1;
    for (const [id, n] of sums) {
      const s = nodeSlots.byKey.get(id)!;
      const strong = asked.has(id);
      nodes.fire(s.group, s.slot, t, strong ? Math.max(0.9, fireAmp(n)) : fireAmp(n));
      // comets on up to `fanout` incident edges (rotating, so repeats light other edges), within the batch budget;
      // events over budget only light the node
      const list = adj.get(id);
      if (list && budget > 0) {
        const start = fanCursor.get(id) ?? 0;
        let fan = Math.min(spec.fanout, budget);
        let i = 0;
        for (; i < list.length && fan > 0; i++) {
          const v = list[(start + i) % list.length];
          const slot = Math.abs(v) - 1;
          if (!linkSlots.items[0][slot].live) continue;
          const travel = edges.fire(slot, t, v > 0 ? 1 : -1, EU.uSpeed.value as number, strong);
          if (!reduced) animUntil = Math.max(animUntil, t + travel);
          fan--;
          budget--;
        }
        fanCursor.set(id, start + i);
      }
      if (n > bestN && shown(s)) [best, bestN] = [s, n];
    }
    // the echo, over adj (the neighbour index setGraph keeps); a node that fired itself keeps its own glow. The shader
    // starts a future fire time on time; reduced motion: no delay, it joins the same static step
    const from = new Map(events.filter((e) => e[2] !== 'turn' && sums.has(e[1])).map((e) => [e[1], fireAmp(sums.get(e[1])!)]));
    for (const [id, amp] of echoOf(adj, linkSlots.items[0], ECHO_KINDS, from, sums)) {
      const s = nodeSlots.byKey.get(id);
      if (s?.live) nodes.fire(s.group, s.slot, reduced ? t : t + ECHO_DELAY_S, ECHO_GAIN * amp);
    }
    if (reduced) {
      // static 1.5 s brightness step: render at its start (now) and at its end, nothing in between
      const id = setTimeout(() => {
        timers.delete(id);
        invalidate();
      }, 1550);
      timers.add(id);
    } else animUntil = Math.max(animUntil, t + 2.5);
    if (fly && best && !intro && rig.canFollow()) flyToSlot(best, true);
    invalidate();
  }

  // ── frame loop ──
  let raf = 0;
  let lastTs = 0;
  const frameMs = 1000 / spec.fps[coarse ? 1 : 0];
  let capProbe: number[] | null = null; // rAF timestamps while the governor's cap probe pauses rendering
  let wake: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let lost = false;
  let w = 0;
  let h = 0;
  let camMoving = false;
  let frames = 0;
  let firstFrameMs: number | null = null;
  const cpu = new Float32Array(240);
  let cpuN = 0;
  // debug only: GPU time per frame (TIME_ELAPSED). On a shared GPU the minimum is the honest "our cost" figure.
  const tq = o.debug ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  const queries: WebGLQuery[] = [];
  const gpu = new Float32Array(240);
  let gpuN = 0;

  const running = () => !disposed && !lost && w > 0 && h > 0 && !document.hidden;
  function invalidate() {
    if (!raf && running()) raf = requestAnimationFrame(frame);
  }
  function animating(t: number) {
    if (t < animUntil || t < fx.busyUntil || camMoving) return true;
    if (reduced || o.probe) return false;
    const sel = selectedId ? nodeSlots.byKey.get(selectedId) : undefined;
    return (spec.dust > 0 && R > 0) || (spec.ambient > 0 && linkSlots.count[0] > 0) || !!sel?.live;
  }
  function render(dt: number) {
    U.uTime.value = clock();
    tickMorph(U.uTime.value);
    if (o.debug && dbg.morphTrace.length < 4096) dbg.morphTrace.push(U.uMorph.value as number);
    camMoving = rig.update(dt);
    const d = rig.camera.position.distanceTo(rig.controls.target);
    U.uDimNear.value = d;
    U.uDimFar.value = d + 1.2 * R;
    const q = tq && queries.length < 4 ? gl.createQuery() : null;
    if (q) gl.beginQuery(tq.TIME_ELAPSED_EXT, q);
    fx.render(dt);
    if (q) {
      gl.endQuery(tq.TIME_ELAPSED_EXT);
      queries.push(q);
    }
    while (tq && queries.length && gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const done = queries.shift()!;
      if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) gpu[gpuN++ % gpu.length] = gl.getQueryParameter(done, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(done);
    }
  }
  function frame(ts: number) {
    raf = 0;
    if (!running()) {
      lastTs = 0;
      if (capProbe) capProbe = []; // hidden mid-probe: measure again once visible
      return;
    }
    if (clock() > CLOCK_REBASE_S) return lose('clock');
    if (capProbe) {
      capProbe.push(ts);
      if (capProbe.length <= PROBE_RAFS) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const d = capProbe.slice(1).map((t, i) => t - capProbe![i]).sort((a, b) => a - b);
      capProbe = null;
      lastTs = 0;
      if (govern(gov.probed(d[d.length >> 1]))) return;
    }
    const continuous = animating(clock());
    // 30 fps targets skip rAFs sooner than 0.6× the frame interval: every other one at 60 Hz, every one at a 30 Hz cap
    // (Energy Saver, Low Power Mode), every third at 120 Hz. rAF parity assumed 60 Hz: 15 fps at 30 Hz, 60 at 120 Hz.
    const gap = dbg.uncapped ? 0 : Math.max(dbg.paceMs, frameMs > 20 ? 0.6 * frameMs : 0);
    if (continuous && gap && lastTs && ts - lastTs < gap) {
      raf = requestAnimationFrame(frame);
      return;
    }
    const c0 = performance.now();
    const dt = lastTs ? (ts - lastTs) / 1000 : 0;
    render(dt);
    frames++;
    // CSS keeps the canvas transparent until a frame is really on screen: the first one composited black (a grey flash
    // through the light theme's fade-in)
    if (frames === 2) canvas.dataset.drawn = '';
    cpu[cpuN++ % cpu.length] = performance.now() - c0;
    if (firstFrameMs === null && nodeSlots.byKey.size) firstFrameMs = Math.round(performance.now());
    if (dt > 0 && !dbg.holdTier && govern(gov.sample(Math.max(dt * 1000, dbg.debugSlowMs), performance.now(), rig.flying))) return;
    if (frames < 2 || animating(clock())) invalidate(); // controls' 'change' may already have queued the next frame
    lastTs = raf ? ts : 0;
  }

  /** Applies a governor action; true = this frame stops here (cap probe started, or remount on a tier drop). */
  function govern(act: GovAction | null): boolean {
    if (act?.kind === 'probe') {
      capProbe = [];
      invalidate();
      return true;
    }
    if (act?.kind === 'dpr') {
      dpr = act.dpr;
      renderer.setPixelRatio(dpr);
      fx.setSize(w, h);
    } else if (act?.kind === 'tier') {
      tier = act.tier;
      try {
        localStorage.setItem(TIER_KEY, tier);
      } catch {
        /* storage blocked: the downgrade still applies to this session */
      }
      lose('tier');
      return true;
    }
    return false;
  }

  function lose(reason: 'context' | 'tier' | 'clock') {
    if (lost || disposed) return;
    lost = true;
    engine.cb.lost(reason, rig.framed ? rig.getView() : null, tier);
  }
  const onContextLost = (e: Event) => {
    e.preventDefault();
    if (!disposed) lose('context');
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  const onVisibility = () => {
    lastTs = 0;
    invalidate();
  };
  document.addEventListener('visibilitychange', onVisibility);
  rig.controls.addEventListener('change', invalidate);
  rig.onUser = (until) => {
    dbg.autoPauseCalls++;
    engine.cb.autoFollowPause(until);
    // idle orbit resumes at `until`, but an idle loop (LOW: no dust or comets) has no frame to notice it: wake it then
    clearTimeout(wake);
    wake = setTimeout(invalidate, until - Date.now() + 50);
    invalidate();
  };

  // ── picking ──
  const ptr = { x: 0, y: 0, touch: false };
  let down: { x: number; y: number; t: number } | null = null;
  let hoverRaf = 0;
  const locate = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    ptr.x = e.clientX - r.left;
    ptr.y = e.clientY - r.top;
    ptr.touch = e.pointerType === 'touch';
  };
  const pickAt = () => pick(rig.camera, w, h, ptr.x, ptr.y, ptr.touch, nodes.meshes, nodeSlots.items, nodes.morph);
  function setHovered(s: Slot<BrainNode> | null) {
    if (s === hovered) return false;
    hovered = s;
    nodes.highlight('uHover', s ? s.group : -1, s ? s.slot : -1);
    invalidate();
    return true;
  }
  const doHover = () => {
    hoverRaf = 0;
    const s = pickAt();
    const changed = setHovered(s);
    dbg.lastHover = s ? s.item.id : null;
    if (s) engine.cb.hover(s.item, { x: ptr.x, y: ptr.y });
    else if (changed) engine.cb.hover(null, null);
  };
  const onMove = (e: PointerEvent) => {
    locate(e);
    if (!ptr.touch && !hoverRaf) hoverRaf = requestAnimationFrame(doHover); // touch: tap selects instead
  };
  const onDown = (e: PointerEvent) => {
    down = null;
    if (!e.isPrimary || e.button !== 0) return; // right/middle drag = pan; a second finger = pinch, never a tap
    locate(e);
    down = { x: ptr.x, y: ptr.y, t: performance.now() };
  };
  const onUp = (e: PointerEvent) => {
    locate(e);
    const d = down;
    down = null;
    if (!d || Math.hypot(ptr.x - d.x, ptr.y - d.y) >= 5 || performance.now() - d.t >= 500) return;
    const s = pickAt();
    dbg.lastSelect = s ? s.item.id : null;
    if (s) flyToSlot(s);
    engine.cb.select(s ? s.item : null);
  };
  const onLeave = () => {
    if (setHovered(null)) engine.cb.hover(null, null);
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onLeave);

  // ── debug hooks (?debug=1 only) ──
  const readPixels = (x: number, y: number, pw: number, ph: number) => {
    render(0); // same task as the readback: the drawing buffer is still intact
    renderer.setRenderTarget(null);
    const px = new Uint8Array(pw * ph * 4);
    gl.readPixels(x, y, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, px);
    invalidate();
    return px;
  };
  const dbg = {
    debugSlowMs: 0,
    /** perf measurements on a shared GPU: keep the governor from downgrading mid-measurement */
    holdTier: false,
    /** perf measurements: render every rAF (no 30 fps pacing), so uncapped runs measure headroom */
    uncapped: false,
    /** perf measurements: render at most every paceMs (the harness's vsync-free Chrome has no display rate) */
    paceMs: 0,
    lastHover: null as string | null,
    lastSelect: undefined as string | null | undefined,
    autoPauseCalls: 0,
    /** uMorph per rendered frame since the last setSemantic (reduced motion: 0s and 1s only) */
    morphTrace: [] as number[],
    get morph() {
      return U.uMorph.value as number;
    },
    /** world position as drawn (semantic lens included), null when not live */
    pos(id: string) {
      const s = nodeSlots.byKey.get(id);
      return s?.live ? posOf(s) : null;
    },
    /** 1 drawn, 0 shrunk away by the semantic lens, null when not live */
    shown(id: string) {
      const s = nodeSlots.byKey.get(id);
      return s?.live ? nodes.shown(s.group, s.slot) : null;
    },
    /** last HUD insets [top, bottom, right] in CSS px (BrainScene measures them from the HUD's DOM) */
    insets: [0, 0, 0] as [number, number, number],
    /** the tier-drop / context-loss remount, at once (the governor needs ≥ 7 s of slow frames) */
    remount: () => lose('tier'),
    get tier() {
      return tier;
    },
    get frames() {
      return frames;
    },
    /** CPU ms ring: restart it (perf runs switching from uncapped to paced) */
    resetCpu() {
      cpuN = 0;
    },
    get cpuN() {
      return cpuN;
    },
    get cpuMs() {
      const n = Math.min(cpuN, cpu.length);
      return n ? +(cpu.slice(0, n).reduce((a, b) => a + b, 0) / n).toFixed(3) : null;
    },
    get cpuP95() {
      const a = Array.from(cpu.slice(0, Math.min(cpuN, cpu.length))).sort((x, y) => x - y);
      return a.length ? +a[Math.floor(a.length * 0.95)].toFixed(3) : null;
    },
    /** [min, median] GPU ms per frame over the last 240 timed frames (null without the timer extension) */
    get gpuMs() {
      const a = Array.from(gpu.slice(0, Math.min(gpuN, gpu.length))).sort((x, y) => x - y);
      return a.length ? [+a[0].toFixed(3), +a[a.length >> 1].toFixed(3)] : null;
    },
    get firstFrameMs() {
      return firstFrameMs;
    },
    get dpr() {
      return dpr;
    },
    get locked() {
      return gov.locked;
    },
    get flying() {
      return rig.flying;
    },
    /** the intro's camera shot is running */
    get shot() {
      return !!rig.intro;
    },
    get target() {
      return rig.controls.target.toArray();
    },
    /** camera ↔ orbit target */
    get distance() {
      return rig.camera.position.distanceTo(rig.controls.target);
    },
    get pausedUntil() {
      return rig.pausedUntil;
    },
    get live() {
      let n = 0;
      nodeSlots.byKey.forEach((s) => (n += s.live ? 1 : 0));
      return n;
    },
    get gl() {
      return gl;
    },
    /** draw calls of the scene alone (the composer's own passes excluded) */
    get calls() {
      renderer.info.autoReset = false;
      renderer.info.reset();
      renderer.setRenderTarget(null);
      renderer.render(scene, rig.camera);
      const c = renderer.info.render.calls;
      renderer.info.autoReset = true;
      invalidate();
      return c;
    },
    camera: () => Array.from(rig.camera.matrixWorld.elements),
    focus: (id: string) => engine.focus(id),
    fire: (ids: string[], kind: BrainEvent[2] = 'turn') => fire(ids.map((id): BrainEvent => [0, id, kind, 1])),
    ids: (type?: string) => [...nodeSlots.byKey.values()].filter((s) => s.live && (!type || s.item.type === type)).map((s) => s.item.id),
    project(id: string) {
      const s = nodeSlots.byKey.get(id);
      if (!s?.live) return null;
      const v = new Vector3(...posOf(s)).project(rig.camera);
      return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, onScreen: Math.abs(v.x) < 1 && Math.abs(v.y) < 1 && v.z < 1 };
    },
    pixel(x: number, y: number) {
      const W = gl.drawingBufferWidth;
      const H = gl.drawingBufferHeight;
      return Array.from(readPixels(Math.round((x * W) / w), H - 1 - Math.round((y * H) / h), 1, 1).slice(0, 3));
    },
    /** FNV-1a of a fresh full-frame readback: equal values = the scene renders identically */
    checksum() {
      const px = readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      let hsh = 2166136261;
      for (let i = 0; i < px.length; i++) hsh = Math.imul(hsh ^ px[i], 16777619);
      return hsh >>> 0;
    },
    /**
     * palette check over the whole frame: share of saturated pixels near the 3 family hues + near-white share. A pixel whose
     * 3x3 neighbourhood holds two different on-palette families is an antialiasing resolve between two nodes (the 4x MSAA
     * mix of blue|green|orange lands between their hues): counted in `blend`, left out of the ratio. A hue shift inside a
     * node (3+ px wide) has no such neighbours and still counts as off.
     */
    hueStats() {
      const W = gl.drawingBufferWidth;
      const H = gl.drawingBufferHeight;
      const px = readPixels(0, 0, W, H);
      const HUES = [213, 159, 17];
      const cls = new Int16Array(W * H).fill(-1); // -1 not saturated, 0..2 = HUES index, 100 + 10° bin = off palette
      let sat = 0;
      let on = 0;
      let white = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i];
        const g = px[i + 1];
        const b = px[i + 2];
        if (r >= 250 && g >= 250 && b >= 250) white++;
        const max = Math.max(r, g, b);
        const d = max - Math.min(r, g, b);
        if (max < 0.15 * 255 || d / max <= 0.35) continue;
        sat++;
        const hh = (((max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60) + 360) % 360;
        const k = HUES.findIndex((c) => Math.abs(((hh - c + 540) % 360) - 180) <= 18);
        cls[i >> 2] = k >= 0 ? k : 100 + Math.floor(hh / 10);
        if (k >= 0) on++;
      }
      const off: Record<number, number> = {};
      let blend = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const c = cls[y * W + x];
          if (c < 100) continue;
          let near = 0;
          for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++) {
            for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) if (cls[yy * W + xx] >= 0 && cls[yy * W + xx] < 100) near |= 1 << cls[yy * W + xx];
          }
          if (near & (near - 1)) blend++;
          else off[(c - 100) * 10] = (off[(c - 100) * 10] ?? 0) + 1;
        }
      }
      return { total: W * H, saturated: sat, blend, onPalette: sat > blend ? on / (sat - blend) : 1, white250: white / (W * H), off };
    },
  };
  if (o.debug) (window as unknown as { __brain?: unknown }).__brain = dbg;

  const engine: Engine = {
    cb: NOOP_CB,
    get tier() {
      return tier;
    },
    setGraph,
    fire,
    setFollow(b) {
      rig.follow = b;
      invalidate();
    },
    setReducedMotion(b) {
      reduced = b;
      if (b) morph.dur = 0; // a running morph cuts to its end
      U.uReduced.value = b ? 1 : 0;
      rig.setReduced(b);
      fx.setReduced(b);
      invalidate();
    },
    setSelected(id) {
      selectedId = id;
      applySelected();
      invalidate();
    },
    setLens(on) {
      U.uLens.value = on ? 1 : 0;
      invalidate();
    },
    setSemantic(on, animate = true) {
      if (on === semantic) return;
      semantic = on;
      const t = clock();
      const m = U.uMorph.value as number;
      const to = on ? 1 : 0;
      const dur = animate && !reduced && !o.probe && !intro ? MORPH_S * Math.abs(to - m) : 0;
      Object.assign(morph, { from: m, to, t0: t, dur });
      dbg.morphTrace = [];
      cFrom.copy(EU.uCentroid.value as Vector3);
      // the target layout's bounds (framing, depth cue, comet speed), the camera flies there alongside; the intro's
      // shot owns both (the page holds the lens off until it lands)
      nodes.morph = to;
      const pts = intro ? [] : worldPts();
      nodes.morph = m;
      if (pts.length) {
        setWorld(pts);
        if (animate) rig.overview(center, Math.max(1, dur * 1000));
      }
      animUntil = Math.max(animUntil, t + dur);
      invalidate();
    },
    spotlight(ids, pulse) {
      spot = ids;
      U.uSpot.value = ids ? 1 : 0;
      nodeSlots.byKey.forEach((s, id) => nodes.spot(s.group, s.slot, !!ids?.has(id)));
      if (ids && pulse) fire([...ids].map((id): BrainEvent => [0, id, 'turn', 1]), false);
      invalidate();
    },
    focus(id) {
      const s = nodeSlots.byKey.get(id);
      if (s?.live) flyToSlot(s);
    },
    setIntro(i) {
      const resume = carryShot;
      carryShot = true;
      const was = intro;
      intro = !!i && !o.probe;
      rig.intro = null;
      // the shot ended (a ▶ replay reached the end, pause): hold Follow like beat(), or the same commit's last batch flies
      // the camera off the overview the shot just landed on
      if (was && !intro) rig.followIn(2000);
      if (!i || !intro) return;
      const world = i.world.filter((n) => n.xyz);
      if (!world.length) return;
      setWorld(world.map((n) => [n.xyz!, nodeRadius(n.type, n.n)]));
      // a remount (theme, tier, context) carries the view over, and the shot only if it was still running (not dragged
      // away); ติดตาม off: the user keeps the camera (the page-load intro always starts under Follow)
      if (spec.intro && rig.follow && resume) {
        // opening shot: the first nodes born from the replay start on (a capped replay starts after older ones), up to
        // the first quiet gap (> 2 days, as the warp), at most 50; a fixed 50 also took in later clusters and left the
        // first one off-screen on a phone
        const i0 = Math.min(world.length - 1, upperBound(world, i.from - 1, appearAt));
        let n = i0 + 1;
        while (n < Math.min(i0 + 50, world.length) && appearAt(world[n]) - appearAt(world[n - 1]) <= 2 * 86400) n++;
        const from = new Vector3();
        for (const w of world.slice(i0, n)) from.add(v3.set(...w.xyz!));
        rig.intro = { from: from.divideScalar(n - i0), to: center.clone(), progress: i.progress, goal: null, rb: 0, rbs: 0 };
      }
      invalidate();
    },
    beat(natural) {
      intro = false;
      rig.intro = null;
      const t = clock();
      if (natural) {
        fx.explode(center, t);
        fx.pulse(t);
        rig.settle(center, 1200); // the shot normally lands on the overview: this only catches a remount that broke it
      } else rig.flyTo(center, 0, true, 600);
      rig.followIn(2000);
      invalidate();
    },
    setSize(nw, nh) {
      w = nw;
      h = nh;
      if (!w || !h) return; // 0×0 (hidden pane, display:none): the loop stays paused
      rig.setViewport(w, h);
      fx.setSize(w, h);
      (EU.uRes.value as Vector2).set(w, h);
      lastTs = 0;
      invalidate();
    },
    setInsets(top, bottom, right) {
      dbg.insets = [top, bottom, right];
      rig.setInsets(top, bottom, right);
      invalidate();
    },
    getView: () => (rig.framed ? rig.getView() : null),
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(hoverRaf);
      timers.forEach(clearTimeout);
      clearTimeout(wake);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      rig.dispose();
      nodes.dispose();
      edges.dispose();
      fx.dispose();
      renderer.dispose();
      if (!gl.isContextLost()) renderer.forceContextLoss(); // a lost context has no WEBGL_lose_context (three warns)
      canvas.remove();
      const win = window as unknown as { __brain?: unknown };
      if (win.__brain === dbg) delete win.__brain;
    },
  };
  if (lostQueued) queueMicrotask(() => lose('tier'));
  return engine;
}
