'use client';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrainNode } from './lib/brain';
import { fmtDate } from './lib/format';
import { useNow, useReducedMotion } from './lib/hooks';
import { useBrainData } from './lib/useBrainData';
import { useDriver } from './lib/useDriver';
import { useTheme } from './lib/theme';
import { Header, StatStrip, ViewTools, type StatValues } from './components/Hud';
import { DetailsPanel, HoverCard, HubTable, SidePanel, type SideTab } from './components/Panels';
import { IntroCaption, Timeline } from './components/Timeline';
import { HowPanel, HowRow } from './components/HowItWorks';
import type { Spotlight } from './components/BrainScene';

// three / postprocessing touch `window` → client only. BrainScene is the single 3D entry point.
// BrainScene.tsx exports it memo'd: the intro re-renders the page per frame, the scene only needs its own props
const BrainScene = dynamic(() => import('./components/BrainScene'), {
  ssr: false,
  loading: () => <div className="scene scene--loading" aria-hidden="true" />,
});

export default function Page() {
  const { store, rev, tick, status } = useBrainData();
  const [sceneReady, setSceneReady] = useState(false);
  const { graph, activeEvents, replay, actions, ready } = useDriver(store, sceneReady);
  // the boot screen stays until the driver has the data (and starts the intro): the first HUD painted is the intro's
  const booting = status === 'loading' || (status !== 'error' && !ready);
  const reduced = useReducedMotion();
  const now = useNow(5000);
  const theme = useTheme();

  const [follow, setFollow] = useState(true);
  const [followPaused, setFollowPaused] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ nodeId: string } | null>(null);
  const [hover, setHover] = useState<BrainNode | null>(null);
  const [table, setTable] = useState(false);
  const [tab, setTab] = useState<SideTab>('feed');
  const [hud, setHud] = useState(false); // phones only: the ข้อมูล sheet (desktop always shows the side panel)
  const [how, setHow] = useState(false); // "ระบบนี้ทำงานยังไง?" panel
  const [lens, setLens] = useState(false); // "สีตาม AI"
  const [semantic, setSemantic] = useState(false); // "จัดตามความหมาย"
  const [spot, setSpot] = useState<Spotlight | null>(null); // nodes the how panel points at
  const stageRef = useRef<HTMLElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dismissed = useRef<string | null>(null); // Esc hid this node's card: it stays hidden until the pointer leaves it

  const onHover = useCallback((n: BrainNode | null, xy: { x: number; y: number } | null) => {
    if (n && n.id === dismissed.current) n = null;
    else dismissed.current = null;
    const tip = tipRef.current;
    const stage = stageRef.current;
    if (tip && stage && xy) {
      // Pointer-following position changes ~60×/s: write CSS variables directly instead of re-rendering.
      tip.style.setProperty('--x', `${Math.max(8, Math.min(xy.x + 16, stage.clientWidth - 256))}px`);
      tip.style.setProperty('--y', `${Math.max(8, Math.min(xy.y + 16, stage.clientHeight - 190))}px`);
    }
    setHover((prev) => (prev?.id === n?.id ? prev : n));
  }, []);
  const onSelect = useCallback((n: BrainNode | null) => setSelectedId(n?.id ?? null), []);
  const onSceneReady = useCallback(() => setSceneReady(true), []);
  const onHud = useCallback(() => {
    setHud((h) => !h);
    setHow(false); // one sheet at a time on phones
  }, []);
  const onHow = useCallback(() => {
    setHow((h) => !h);
    setHud(false);
    setTable(false);
  }, []);
  const closeHow = useCallback(() => setHow(false), []);
  const onLens = useCallback(() => setLens((l) => !l), []);
  const onSemantic = useCallback(() => setSemantic((v) => !v), []);
  const onAutoFollowPause = useCallback((until: number) => {
    setFollowPaused(true);
    clearTimeout(pauseTimer.current);
    pauseTimer.current = setTimeout(() => setFollowPaused(false), Math.max(0, until - Date.now()));
  }, []);
  useEffect(() => () => clearTimeout(pauseTimer.current), []);

  const pick = useCallback((id: string) => {
    setSelectedId(id);
    setFocus({ nodeId: id });
    setTable(false);
    setHud(false); // phones: the details sheet replaces the ข้อมูล sheet (desktop: always false)
  }, []);

  const live = replay.head === null;
  // page-load intro (useDriver starts it): camera choreography while it runs (also for ▶ from the start: replay.shot),
  // one LIVE beat when it lands or is skipped
  const introRunning = replay.intro === 'run';
  const intro = useMemo(() => (replay.shot ? { world: store.byAppear, from: replay.from, progress: actions.introProgress } : null), [replay.shot, store, replay.from, actions]);
  const landed = replay.intro === 'live' || replay.intro === 'skip';
  const beat = useMemo(() => (landed ? { natural: replay.intro === 'live' } : null), [landed, replay.intro]);
  // Esc skips the intro (an open table, on top, closes first); after it, hides the hover card (WCAG 1.4.13) and closes
  // the table, else the selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (introRunning && !table) return actions.live();
      if (hover) {
        dismissed.current = hover.id;
        setHover(null);
      }
      if (table) setTable(false);
      else setSelectedId(null);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [introRunning, actions, hover, table]);
  // short viewports scroll the HUD as one column: the side panel showing at the reveal or its feed regrowing under ▶
  // pushed the focused control below the fold (WCAG 2.4.11). Elsewhere it is already in view: a no-op. Keyboard focus
  // only: a clicked ▶ holds focus too, and the scroll put the timeline over the brain (the camera frames the unscrolled HUD).
  useEffect(() => {
    const side = stageRef.current?.querySelector('.side');
    if (!side) return;
    const ro = new ResizeObserver(() => {
      const a = document.activeElement;
      if (a instanceof HTMLElement && a.matches(':focus-visible') && a.closest('.hud') && !side.contains(a)) a.scrollIntoView({ block: 'nearest' });
    });
    ro.observe(side);
    return () => ro.disconnect();
  }, []);
  // counts of what is on screen (LIVE: everything), so the strip matches the glyphs it labels; recall, repos + DB size are LIVE-only
  const stats: StatValues = useMemo(() => {
    const c: StatValues = { project: 0, session: 0, subagent: 0, note: 0, memory: 0, chunks: 0, recalls7d: null, dbMB: null, repos: null };
    for (const n of graph.nodes) {
      c[n.type]++;
      if (n.type !== 'project') c.chunks += n.n;
    }
    if (live) {
      c.recalls7d = store.stats.recalls7d ?? 0;
      c.dbMB = (store.stats.dbBytes ?? 0) / 1048576;
      c.repos = store.stats.ghRepos ?? null; // absent in older exports
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, graph, store, tick]);
  // memoized with SidePanel: the replay re-renders the page ~30×/s, the side panel only needs it for its own inputs
  const tools = useMemo(() => <ViewTools follow={follow} followPaused={followPaused} onFollow={() => setFollow((f) => !f)} table={table} onTable={() => { setTable((t) => !t); setHow(false); }} />, [follow, followPaused, table]);
  const howRow = useMemo(() => <HowRow apps={store.apps} open={how} onOpen={onHow} lens={lens} onLens={onLens} semantic={semantic} onSemantic={onSemantic} />, [store.apps, how, onHow, lens, onLens, semantic, onSemantic]);

  const selected = selectedId ? (store.nodes.get(selectedId) ?? null) : null;
  const tip = hover && hover.id !== selectedId ? hover : null;

  return (
    <main ref={stageRef} className="stage" data-hud={hud ? 'on' : 'off'} data-table={table ? 'on' : 'off'} data-how={how ? 'on' : 'off'} data-selected={selected ? '' : undefined} data-phase={booting ? 'boot' : introRunning ? 'intro' : undefined}>
      <BrainScene
        graph={graph}
        activeEvents={activeEvents}
        follow={follow}
        reducedMotion={reduced}
        selectedNodeId={selectedId}
        focus={focus}
        onHover={onHover}
        onSelect={onSelect}
        onAutoFollowPause={onAutoFollowPause}
        intro={intro}
        beat={beat}
        theme={theme}
        lens={lens}
        semantic={semantic && !replay.shot} // the intro's shot frames the baked layout: by meaning once it lands
        spotlight={spot}
        onReady={onSceneReady}
      />

      <div className="hud">
        <Header mode={store.mode} status={booting ? 'loading' : status} replaySpeed={live ? null : replay.speed} playing={replay.playing} ring={landed} tools={tools} hud={hud} onHud={onHud} />
        <StatStrip stats={stats} instant={!live || reduced}>
          {howRow}
        </StatStrip>
        {/* hidden during the intro (CSS) unless the ข้อมูล sheet is open: a fixed head keeps the memo from re-rendering it */}
        <SidePanel store={store} tick={tick} head={introRunning && !hud ? null : replay.head} now={now} tab={tab} onTab={setTab} onPick={pick} tools={tools} />
        <div className="hud__bl">
          {selected && <DetailsPanel node={selected} store={store} onClose={() => setSelectedId(null)} onFocus={() => setFocus({ nodeId: selected.id })} />}
        </div>
        <IntroCaption
          replay={replay}
          end={store.domain()[1]}
          live={status === 'live'}
          liveText={status === 'live' ? `สด · อัปเดต${store.mode === 'public' ? 'ทุกชั่วโมง' : 'ทุก 2 วินาที'}` : `ข้อมูล ณ ${fmtDate(store.at)}`}
          onSkip={actions.live}
        />
        <Timeline store={store} domain={store.domain()} replay={replay} actions={actions} status={status} />
        {/* inside the HUD grid so phones can place it below the header, whatever its height */}
        {table && <HubTable store={store} rev={rev} onPick={pick} onClose={() => setTable(false)} />}
        {how && <HowPanel store={store} rev={rev} tick={tick} now={now} lens={lens} onLens={onLens} semantic={semantic} onSemantic={onSemantic} onSpot={setSpot} onClose={closeHow} reduced={reduced} />}
      </div>

      {/* not over the selected node: the details panel already shows the same facts */}
      <HoverCard node={tip} hub={tip ? store.hubOf(tip) : undefined} tipRef={tipRef} />
      {booting && (
        <div className="boot" role="status">
          <span className="boot__mark">memory-hub</span>
          <span className="boot__line" aria-hidden="true" />
          <span className="boot__text">กำลังโหลดความจำ…</span>
        </div>
      )}
      {status === 'error' && (
        <p className="fatal" role="alert">
          ไม่พบ graph.json — รัน <code>npm run data</code> ในโฟลเดอร์ web/
        </p>
      )}
    </main>
  );
}
