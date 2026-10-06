'use client';
/**
 * BrainScene — the React shell of the 3D view. This file and components/brain/* are the ONLY modules allowed to import
 * three / postprocessing. Everything else (data, replay clock, HUD) is engine-agnostic and talks to the 3D view through
 * the props below, so the renderer can be swapped without touching anything else. The engine (brain/engine.ts) is
 * three.js WebGLRenderer (WebGL2) + pmndrs postprocessing with custom shaders; see docs/research/brain-renderer-spec.md.
 *
 * ─── CONTRACT ────────────────────────────────────────────────────────────────────────────────────────────────
 *  graph          What exists at the current playhead (LIVE = everything). Plain data; positions baked as optional
 *                 `xyz`; nodes without `xyz` are placed by the scene.
 *                 - `graph.rev` changes whenever membership or any node field (n, u, label, …) changed.
 *                 - BrainNode objects are replaced, never mutated, when a field changes (`next !== prev` = changed).
 *                 - Replay grows the brain: nodes are appended in `t0` order; scrubbing backwards removes them.
 *                   The array is re-sliced whenever the visible count changes → diff by id, don't rebuild the world.
 *                 - Every link's endpoints are in `nodes`. Link kinds: in | spawn (structural), link (wikilink),
 *                   similar (semantic), coaccess (Hebbian, `w` = strength), prov (fact/card ↔ the session it came
 *                   from), next (the next session in a project).
 *  activeEvents   Events that fired since the previous batch (replay: the playhead passed them; LIVE: arrived via
 *                 feed). A NEW array identity is a NEW batch — process each distinct array exactly once; an unchanged
 *                 reference means nothing new. ≤ 64 per batch, busiest-first is NOT guaranteed, ids may be absent
 *                 from `graph` (ignore those). Semantics of one event [t, nodeId, kind, n]: "this node just fired
 *                 n times" → pulse the node, send signals along its links, optionally fly to the busiest one.
 *                 A search/recall also lights its link/prov/next/coaccess neighbours at 0.4×, 150 ms later.
 *  follow         true → the scene may fly to an active node (≤ once / 4 s) and idle-orbit. Any user drag/zoom pauses
 *                 both for 20 s (scene-internal; announced through onAutoFollowPause).
 *  reducedMotion  true → no orbit, no particles/pulse motion, camera moves instantly.
 *  selectedNodeId Node to highlight (set by the parent from onSelect / feed / table).
 *  focus          Fly to `focus.nodeId` whenever this object's IDENTITY changes (parent creates a new object per request).
 *  onHover        (node | null, xy | null): node under the pointer; xy = pointer in CSS px relative to the scene's
 *                 top-left. Called on change and on pointer move while a node stays hovered.
 *  onSelect       (node | null): click on a node (scene has already flown there) or on empty background (null).
 *  onAutoFollowPause?(untilEpochMs)  user took control; auto-follow resumes at that time.
 *  intro          Non-null while the page-load intro (or a ▶ from the start) replays: `world` = all nodes (baked xyz →
 *                 final bounds from the first frame), `from` = replay start (the opening shot frames the first births
 *                 from there), `progress()` 0..1 read every frame for the camera pull-out. Follow flights wait.
 *  beat           The intro reached LIVE; acted on once per object IDENTITY (like focus). natural: ShockWave + bloom
 *                 pulse; skipped: a 600 ms flight to the overview. Follow resumes 2 s later.
 *  theme          'dark' | 'light'. The engine reads it once; a change remounts a fresh engine on the current view and
 *                 tier (the context-loss path), and the new canvas fades in over the page background.
 *  lens           true → "สีตาม AI": nodes take their app's colour (BrainNode.a; none: grey). Survives remounts.
 *  semantic       true → "จัดตามความหมาย": nodes morph to their position by meaning (BrainNode.s; none, and project
 *                 hubs: hidden) and the camera re-frames; false morphs back. A remount jumps straight there. Keep it
 *                 false while `intro` runs (the shot frames the baked layout).
 *  spotlight      Fade every node but `ids` while non-null; acted on per object IDENTITY (a new object with `pulse` fires
 *                 the ids again, comets on their links, never a camera flight; no pulse under reducedMotion). A remount
 *                 re-applies it without the pulse.
 *  onReady?()     the first engine exists (or WebGL2 is unsupported): the intro waits for it, so engine creation does
 *                 not stall its opening second. May be called again on a remount.
 *  HUD insets     NOT a prop: measured from the HUD's DOM (.strip bottom; .timeline top, phones ≤ 719 px also the
 *                 .details sheet top; ≤ 480 px tall the intro's .caption top; above 719 px the laid-out .side panel's
 *                 left edge; the open .how panel: a phone's bottom sheet its top, elsewhere a right drawer its left edge) to fit the overview between them. Renaming those classes, the breakpoints or .stage's
 *                 data-phase / data-table breaks the framing silently; scene-check asserts the insets are > 0.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { memo, useEffect, useRef, useState } from 'react';
import { useSize } from '../lib/hooks';
import type { BrainEvent, BrainLink, BrainNode } from '../lib/brain';
import { createEngine, type Engine, type View } from './brain/engine';
import { initialTier } from './brain/quality';
import type { Theme, Tier } from './brain/style';

export interface SceneGraph {
  nodes: readonly BrainNode[];
  links: readonly BrainLink[];
  rev: number;
}
export interface Spotlight {
  ids: ReadonlySet<string>;
  pulse: boolean;
}
export interface BrainSceneProps {
  graph: SceneGraph;
  activeEvents: readonly BrainEvent[];
  follow: boolean;
  reducedMotion: boolean;
  selectedNodeId?: string | null;
  focus?: { nodeId: string } | null;
  onHover: (node: BrainNode | null, xy: { x: number; y: number } | null) => void;
  onSelect: (node: BrainNode | null) => void;
  onAutoFollowPause?: (untilEpochMs: number) => void;
  intro?: { world: readonly BrainNode[]; from: number; progress: () => number } | null;
  beat?: { natural: boolean } | null;
  theme: Theme;
  lens?: boolean;
  semantic?: boolean;
  spotlight?: Spotlight | null;
  onReady?: () => void;
}

/** One engine generation: a new key = a fresh canvas + context (context loss, tier or theme change, StrictMode). */
interface Mount {
  key: number;
  tier: Tier;
  theme: Theme;
  view: View | null;
  /** createEngine failures in a row; a successful remount (tier drop, context loss) resets it */
  fails: number;
}

function startTier(): Tier {
  const q = new URLSearchParams(location.search).get('q');
  let stored: string | null = null;
  try {
    if (q === 'auto') localStorage.removeItem('brainTier');
    stored = localStorage.getItem('brainTier');
  } catch {
    /* storage blocked (private mode): detect every visit */
  }
  const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
  return initialTier({
    q,
    stored,
    saveData: nav.connection?.saveData,
    coarse: matchMedia('(pointer: coarse)').matches,
    cores: nav.hardwareConcurrency,
    memory: nav.deviceMemory,
    halfFloat: true, // the engine checks the real extension on its own context and falls back to LOW
  });
}

function BrainSceneImpl(props: BrainSceneProps) {
  const { graph, activeEvents, follow, reducedMotion, selectedNodeId, focus, intro, beat, theme, lens = false, semantic = false, spotlight = null } = props;
  const P = useRef(props);
  useEffect(() => {
    P.current = props;
  });
  const [hostRef, size] = useSize<HTMLDivElement>();
  const [mount, setMount] = useState<Mount | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const engine = useRef<Engine | null>(null);
  const firedEvents = useRef(activeEvents);
  const flownFocus = useRef(focus);
  const doneBeat = useRef(beat);

  useEffect(() => setMount({ key: 0, tier: startTier(), theme: P.current.theme, view: null, fails: 0 }), []);
  useEffect(() => {
    const e = engine.current;
    setMount((m) => m && m.theme !== theme ? { key: m.key + 1, tier: e?.tier ?? m.tier, theme, view: e?.getView() ?? m.view, fails: 0 } : m);
  }, [theme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!mount || !host) return;
    const q = new URLSearchParams(location.search);
    let e: Engine;
    try {
      e = createEngine(host, { tier: mount.tier, theme: mount.theme, reducedMotion: P.current.reducedMotion, debug: q.get('debug') === '1', probe: q.get('probe') === '1', view: mount.view });
    } catch {
      // After a context loss (key > 0) a new context can be refused for a moment (GPU reset, iOS in background): retry.
      if (mount.key > 0 && mount.fails < 5) {
        const id = setTimeout(() => setMount((m) => m && { ...m, key: m.key + 1, fails: m.fails + 1 }), 1000);
        return () => clearTimeout(id);
      }
      setUnsupported(true); // T0: HUD, timeline and tables keep working
      P.current.onReady?.();
      return;
    }
    e.cb = {
      hover: (n, xy) => P.current.onHover(n, xy),
      select: (n) => P.current.onSelect(n),
      autoFollowPause: (until) => P.current.onAutoFollowPause?.(until),
      lost: (_reason, view, tier) => setMount((m) => m && { ...m, key: m.key + 1, tier, view, fails: 0 }),
    };
    document.documentElement.dataset.tier = e.tier; // CSS drops the HUD's backdrop blur on LOW
    // a fresh engine starts from the current props; past event batches, focus requests and beats are not replayed
    const p = P.current;
    e.setSize(host.clientWidth, host.clientHeight);
    e.setFollow(p.follow);
    e.setIntro(p.intro ?? null); // before the graph: the intro's bounds frame the first nodes
    e.setSemantic(!!p.semantic, false); // before the graph too: the first framing is the layout shown
    e.setGraph(p.graph);
    e.setSelected(p.selectedNodeId ?? null);
    e.setLens(!!p.lens);
    e.spotlight(p.spotlight?.ids ?? null, false);
    engine.current = e;
    p.onReady?.();
    return () => {
      engine.current = null;
      e.dispose();
    };
  }, [mount, hostRef]);

  useEffect(() => engine.current?.setSize(size.width, size.height), [size, mount]);
  // HUD insets: the stat strip's bottom and the timeline's top (phones: the open details sheet's top) bound the band the
  // camera frames the brain in, the side panel (tablet and up) its right edge. offset* = layout boxes, unaffected by the
  // panels' rise-in transform. The side panel hides by visibility (intro, table) and the short intro by display: watch the flags.
  useEffect(() => {
    const host = hostRef.current;
    const stage = host?.parentElement;
    if (!host || !stage) return;
    const phone = matchMedia('(max-width: 719px)');
    const short = matchMedia('(max-height: 480px)');
    const box = (sel: string) => stage.querySelector<HTMLElement>(sel);
    const measure = () => {
      const h = host.clientHeight;
      const strip = box('.strip');
      // short viewports' intro: the caption is the bottom edge (the timeline is hidden; mid-band it covered the brain)
      const caption = short.matches && stage.dataset.phase === 'intro' ? box('.caption') : null;
      // the open "how it works" panel: a bottom sheet on phones (short ones too: their drawer is on the right, see below)
      const how = box('.how');
      const sheet = phone.matches && !short.matches;
      const edges = [box('.timeline'), phone.matches ? box('.details') : null, caption, sheet ? how : null].map((el) => (el?.offsetHeight ? h - el.offsetTop : 0));
      // the intro hides the side panel by visibility, its box stays: reserved from the start, the reveal does not move
      // the brain (shown() measured it only at LIVE: a slide on desktop, a flight back on tablets). The table covers it.
      const side = box('.side');
      const right = Math.max(
        !phone.matches && side?.getClientRects().length && stage.dataset.table !== 'on' ? Math.max(0, host.clientWidth - side.offsetLeft) : 0,
        !sheet && how ? Math.max(0, host.clientWidth - how.offsetLeft) : 0,
      );
      engine.current?.setInsets(strip?.offsetHeight ? strip.offsetTop + strip.offsetHeight : 0, Math.max(...edges), right);
    };
    const ro = new ResizeObserver(measure);
    for (const el of [host, box('.hud-header'), box('.strip'), box('.timeline'), box('.details'), box('.side')]) if (el) ro.observe(el);
    const mo = new MutationObserver(measure);
    mo.observe(stage, { attributes: true, attributeFilter: ['data-phase', 'data-table', 'data-hud', 'data-how'] });
    measure();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [mount, hostRef, selectedNodeId]);
  useEffect(() => engine.current?.setIntro(intro ?? null), [intro]); // declared before setGraph: same commit, bounds first
  useEffect(() => engine.current?.setGraph(graph), [graph]);
  useEffect(() => engine.current?.setFollow(follow), [follow]);
  useEffect(() => engine.current?.setReducedMotion(reducedMotion), [reducedMotion, mount]);
  useEffect(() => engine.current?.setSelected(selectedNodeId ?? null), [selectedNodeId]);
  useEffect(() => engine.current?.setLens(lens), [lens]);
  useEffect(() => engine.current?.setSemantic(semantic), [semantic]); // after setIntro's: the shot's flag decides the camera
  useEffect(() => engine.current?.spotlight(spotlight?.ids ?? null, !!spotlight?.pulse && !P.current.reducedMotion), [spotlight]);
  // before fire: the landing commit also carries the replay's last batch, and beat's 2 s follow hold must already be set
  // or that batch flies the camera off the reveal
  useEffect(() => {
    if (!beat || beat === doneBeat.current) return;
    doneBeat.current = beat;
    engine.current?.beat(beat.natural);
  }, [beat]);
  useEffect(() => {
    if (activeEvents === firedEvents.current) return; // each batch exactly once (StrictMode re-runs effects)
    firedEvents.current = activeEvents;
    engine.current?.fire(activeEvents);
  }, [activeEvents]);
  useEffect(() => {
    if (!focus || focus === flownFocus.current) return;
    flownFocus.current = focus;
    engine.current?.focus(focus.nodeId);
  }, [focus]);

  // the notice sits outside role=img (an image's children are presentational: it was never announced), and without a
  // canvas there is no image to label
  return (
    <>
      <div ref={hostRef} className="scene" role={unsupported ? undefined : 'img'} aria-label={unsupported ? undefined : 'กราฟ 3 มิติของความจำระยะยาวที่ AI หลายตัวใช้ร่วมกัน ดูแบบตารางได้จากปุ่มตาราง (บนมือถือ กดปุ่มข้อมูลก่อน)'} />
      <p className={unsupported ? 'scene__loading' : undefined} role="status">
        {unsupported && 'อุปกรณ์นี้แสดงภาพ 3 มิติไม่ได้ ดูแบบตารางได้จากปุ่มตาราง (บนมือถือ กดปุ่มข้อมูลก่อน)'}
      </p>
    </>
  );
}

const BrainScene = memo(BrainSceneImpl);
export default BrainScene;
