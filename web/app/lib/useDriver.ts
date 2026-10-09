'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { appearAt, upperBound, type BrainEvent } from './brain';
import type { BrainStore } from './store';
import type { SceneGraph } from '../components/BrainScene';

export const SPEEDS = [1, 4, 16] as const; // days of history per real second
const DAY = 86400;
const WARP = 4; // intro: quiet stretches (next birth > 2 days ahead) pass this many times faster
const MAX_BATCH = 64;
const EMPTY_GRAPH: SceneGraph = { nodes: [], links: [], rev: 0 };
const NO_EVENTS: readonly BrainEvent[] = [];

/**
 * head === null → LIVE (everything visible, feed events fire); otherwise unix-second playhead.
 * intro: the page-load replay. 'run' = playing 16× from `from`, goes LIVE by itself at the end ('live'); ข้าม / Esc / สด
 * during it → 'skip'. Any other clock control (play, pause, speed, scrub) hands the clock to the user → null.
 */
export interface Replay {
  head: number | null;
  playing: boolean;
  speed: number;
  intro: 'run' | 'live' | 'skip' | null;
  /** intro gap warp on (WARP×), for the caption: it follows the warp only after 300 ms in a new state */
  warp: boolean;
  /** start of the replay with the camera shot (intro, or ▶ from the beginning), unix s */
  from: number;
  /**
   * the camera plays the intro's shot (first nodes → whole brain): the page-load intro, and ▶ from LIVE or the end (a
   * whole-brain overview of the first few nodes is a speck). Pause, scrub and สด end it; a speed change keeps it.
   */
  shot: boolean;
}

/** Every load and refresh, except reduced motion, ?intro=0 (tests) and ?probe=1. */
function introWanted(): boolean {
  const q = new URLSearchParams(location.search);
  return q.get('intro') !== '0' && q.get('probe') !== '1' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Events with prev < t <= head (events are sorted by t). */
function between(events: readonly BrainEvent[], prev: number, head: number): BrainEvent[] {
  const lo = upperBound(events, prev, (e) => e[0]);
  const hi = upperBound(events, head, (e) => e[0]);
  return events.slice(lo, hi);
}

/**
 * Replay clock + scene driver. One rAF loop: advances the playhead, computes the visible graph
 * (nodes/links whose appear time <= playhead), and batches fired events into `activeEvents`.
 * React state is touched only when something actually changed (graph slice, events, playhead); while playing, all three
 * land in one commit per ~30 Hz tick, whatever the display's refresh rate.
 * `sceneReady`: the 3D engine exists; data is held back until then. `ready` turns true in the same commit as the first
 * data (and the intro, if any), so the page can keep its boot screen until then: no non-intro HUD flashes first.
 */
export function useDriver(store: BrainStore, sceneReady: boolean) {
  const clock = useRef<Replay>({ head: null, playing: false, speed: SPEEDS[0], intro: null, warp: false, from: 0, shot: false });
  const [replay, setReplay] = useState<Replay>({ ...clock.current });
  const [graph, setGraph] = useState<SceneGraph>(EMPTY_GRAPH);
  const [activeEvents, setActive] = useState<readonly BrainEvent[]>(NO_EVENTS);
  const [ready, setReady] = useState(false);
  const scene = useRef(sceneReady);
  useEffect(() => {
    scene.current = sceneReady;
  }, [sceneReady]);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    let nodeCount = -1;
    let linkCount = -1;
    let rev = -1;
    let introPending = true; // decided on the first frame with data and an engine, before any data reaches the scene
    let warpSince = -1; // the warp flips every 60-400 ms; its caption label waits for 300 ms in the new state
    let fired: BrainEvent[] = []; // events passed since the last commit (playing: held between ~30 Hz ticks)

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (introPending && !(store.at > 0 && scene.current)) return;
      const c = clock.current;
      let uiDirty = false;

      if (introPending) {
        introPending = false;
        setReady(true);
        if (store.byAppear.length && introWanted()) {
          const from = store.domain()[0]; // the domain is capped, so the intro stays ≤ 10 s at 16×
          Object.assign(c, { head: from, playing: true, speed: 16, intro: 'run', from, shot: true });
          uiDirty = true;
        }
      }

      // live-call light is for the moment of the request: dropped, not held, while a replay owns the clock
      const flash = store.flash.length ? store.flash.splice(0) : null;
      if (c.head === null) {
        if (store.pending.length) fired = fired.concat(store.pending.splice(0));
        if (flash) fired = fired.concat(flash);
      } else if (c.playing) {
        const end = store.domain()[1];
        const prev = c.head;
        const next = store.byAppear[upperBound(store.byAppear, prev, appearAt)];
        const warp = c.intro === 'run' && (!next || appearAt(next) - prev > 2 * DAY);
        if (warp === c.warp) warpSince = -1;
        else if (warpSince < 0) warpSince = now;
        else if (now - warpSince > 300) [c.warp, warpSince] = [warp, -1];
        c.head = Math.min(end, prev + dt * DAY * c.speed * (warp ? WARP : 1));
        fired = fired.concat(between(store.events, prev, c.head));
        // live arrivals are in the history too: the playhead fires the ones it passes, the rest wait for LIVE
        if (store.pending.length) store.pending = store.pending.filter((e) => e[0] <= prev || e[0] > c.head!);
        if (c.head >= end) {
          c.playing = c.warp = c.shot = false;
          if (c.intro === 'run') Object.assign(c, { head: null, intro: 'live' });
        }
        uiDirty ||= now - lastUi > 33 || !c.playing;
        // graph and events wait for the same tick: a 120 Hz display committed them every frame for a scene drawing ≤ 60
        if (!uiDirty) return;
      }

      const limit = c.head ?? Infinity;
      const nc = upperBound(store.byAppear, limit, appearAt);
      const lc = upperBound(store.linksByAppear, limit, (l) => store.linkAppear.get(l)!);
      if (nc !== nodeCount || lc !== linkCount || store.rev !== rev) {
        [nodeCount, linkCount, rev] = [nc, lc, store.rev];
        setGraph({ nodes: store.byAppear.slice(0, nc), links: store.linksByAppear.slice(0, lc), rev: store.rev });
      }
      if (fired.length) {
        setActive(fired.length > MAX_BATCH ? [...fired].sort((a, b) => b[3] - a[3]).slice(0, MAX_BATCH) : fired);
        fired = [];
      }
      if (uiDirty) {
        lastUi = now;
        setReplay({ ...c });
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [store]);

  const actions = useMemo(() => {
    // the user took the clock: the intro ends where it is (no warp, no auto-LIVE)
    const sync = (userOwns = true) => {
      const c = clock.current;
      if (userOwns) Object.assign(c, { intro: null, warp: false });
      setReplay({ ...c });
    };
    return {
      play() {
        const [start, end] = store.domain();
        const c = clock.current;
        c.shot = c.head === null || c.head >= end;
        if (c.shot) c.head = c.from = start;
        c.playing = true;
        sync();
      },
      pause() {
        clock.current.playing = clock.current.shot = false;
        sync();
      },
      /** LIVE now; during the intro this is the skip (ข้าม, Esc, สด) */
      live() {
        const c = clock.current;
        Object.assign(c, { head: null, playing: false, warp: false, shot: false, intro: c.intro === 'run' ? 'skip' : c.intro });
        sync(false);
      },
      scrub(t: number) {
        const [start, end] = store.domain();
        Object.assign(clock.current, { head: Math.min(end, Math.max(start, t)), shot: false });
        sync();
      },
      speed(v: number) {
        clock.current.speed = v;
        sync();
      },
      /** camera shot progress 0..1 (head between `from` and the end; 1 when LIVE). Read per frame by the scene. */
      introProgress() {
        const c = clock.current;
        if (c.head === null) return 1;
        const end = store.domain()[1];
        return end > c.from ? Math.min(1, Math.max(0, (c.head - c.from) / (end - c.from))) : 1;
      },
    };
  }, [store]);

  return { graph, activeEvents, replay, actions, ready };
}
