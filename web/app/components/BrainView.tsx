'use client';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { BrainEvent, EventKind } from '../lib/brain';
import { clientName, runSearch, type HitType, type LiveCall, type LiveFeed, type Trace } from '../lib/live';
import type { BrainStore } from '../lib/store';
import { HIT_NAME, IMAGE, REGION, REGIONS, type RegionId } from './brainview/regions';
import AskLog from './brainview/AskLog';
import { hitOfNode, planCall, planGet, planSearch, planTurn, type Plan } from './brainview/routes';
import { KIND_RGB, PathwayStage, rgbCss } from './brainview/stage';
import './BrainView.css';

const TICKER_ROWS = 20;
const TIME = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); // viewer's zone
const KIND_NAME: Record<string, string> = { search: 'ค้น', get: 'เปิดอ่าน', related: 'หาที่เกี่ยวข้อง' };
const PRIVATE_TEXT = '(ข้อมูลส่วนตัว)';
/** a get / related call has no query text of its own (not a secret: only a private source hides it) */
const NO_QUERY: Record<string, string> = { get: '(เปิดอ่านรายการ)', related: '(หาที่เกี่ยวข้อง)' };
const REPLAY_EVERY_MS = 2600;

/** hits of one call as chips: one per type with its count, most first */
function hitChips(types: readonly HitType[]): [HitType, number][] {
  const by = new Map<HitType, number>();
  for (const t of types) by.set(t, (by.get(t) ?? 0) + 1);
  return [...by].sort((a, b) => b[1] - a[1]);
}

function Chip({ type, n }: { type: HitType; n?: number }) {
  return (
    <span className="bv__chip">
      {HIT_NAME[type]}
      {n && n > 1 ? ` ×${n}` : ''}
    </span>
  );
}

function kindOf(c: LiveCall): keyof typeof KIND_RGB {
  return c.kind === 'search' ? 'search' : c.kind === 'related' ? 'related' : 'get';
}

function CallRow({ c }: { c: LiveCall }) {
  const kind = kindOf(c);
  const hidden = c.query === null && (c.kind === 'search' || c.hits.some((h) => h.type === 'private'));
  const text = hidden ? PRIVATE_TEXT : (c.query ?? NO_QUERY[c.kind] ?? `(${c.kind})`);
  return (
    <li className="bv__call" style={{ '--c': rgbCss(KIND_RGB[kind]) } as CSSProperties}>
      <span className="bv__time">{TIME.format(c.t)}</span>
      <span className="bv__app">
        <span className="bv__dot" aria-hidden="true" />
        {clientName(c.client)}
      </span>
      <span className="bv__kind">{KIND_NAME[c.kind] ?? c.kind}</span>
      <span className="bv__ms">{c.ms === null ? '' : `${Math.round(c.ms)} ms`}</span>
      <span className={hidden ? 'bv__q bv__q--private' : 'bv__q'}>{text}</span>
      <span className="bv__chips">
        {hitChips(c.hits.map((h) => h.type)).map(([t, n]) => (
          <Chip key={t} type={t} n={n} />
        ))}
      </span>
    </li>
  );
}

type Search = { phase: 'idle' } | { phase: 'wait'; q: string } | { phase: 'done'; trace: Trace; seq: number } | { phase: 'error'; q: string; why: string };
const REFUSED: Record<string, string> = { secret: 'ไม่ตอบคำถามเรื่องรหัสผ่าน คีย์ หรือข้อมูลลับ ลองถามเรื่องอื่น', busy: 'มีคนถามอยู่ รอสักครู่แล้วลองใหม่' };

/** The view over the whole stage: the anatomy picture with the canvas of pathways on it, and the legend / ticker / search beside it. */
/** ask: opened by ทดสอบถาม (focus lands in the ask box instead of on ปิด) */
export default function BrainView(props: { store: BrainStore; feed: LiveFeed; live: boolean; ask?: boolean; events: readonly BrainEvent[]; reduced: boolean; onClose: () => void }) {
  const { store, feed, live, ask, events, reduced, onClose } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stage = useRef<PathwayStage | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const askRef = useRef<HTMLInputElement>(null);
  const [calls, setCalls] = useState<LiveCall[]>(() => feed.calls.slice(-TICKER_ROWS));
  const [pinned, setPinned] = useState<RegionId | null>(null);
  const [hovered, setHovered] = useState<RegionId | null>(null);
  const [search, setSearch] = useState<Search>({ phase: 'idle' });
  const searchSeq = useRef(0);
  const marked = hovered ?? pinned;

  const launch = useCallback((p: Plan) => stage.current?.launch(p), []);

  // canvas: exactly the image box; rebuilt on every size change (window, phone rotation, browser zoom)
  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    const st = new PathwayStage(canvas);
    stage.current = st;
    const fit = () => st.resize(box.clientWidth, box.clientHeight, window.devicePixelRatio || 1);
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    fit();
    return () => {
      ro.disconnect();
      st.dispose();
      stage.current = null;
    };
  }, []);
  useEffect(() => {
    if (stage.current) stage.current.reduced = reduced;
  }, [reduced]);
  useEffect(() => stage.current?.mark(marked), [marked]);

  // focus lands on ปิด, or the ask box (the page puts it back where it was on close); Esc closes (capture + stop: the page's own Esc handlers must not also run)
  useEffect(() => {
    (ask && askRef.current ? askRef.current : closeRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [onClose, ask]);

  // LOCAL: every real call is a route the moment it arrives (older ones, from before the view opened, only fill the ticker)
  useEffect(() => {
    if (!live) return;
    return feed.on((c, fresh) => {
      setCalls(feed.calls.slice(-TICKER_ROWS));
      if (fresh) launch(planCall(c.kind, c.ms, c.hits.map((h) => h.type)));
    });
  }, [feed, live, launch]);

  // feed events: new chat turns always; searches / recalls only where there is no live feed (the public site: counts only,
  // so one route per batch, lit where the node types say)
  const seenEvents = useRef(events);
  useEffect(() => {
    if (events === seenEvents.current) return;
    seenEvents.current = events;
    const found: Record<EventKind, HitType[] | null> = { turn: null, search: null, recall: null };
    for (const e of events) {
      if (live && e[2] !== 'turn') continue;
      const t = hitOfNode(store.nodes.get(e[1]));
      (found[e[2]] ??= []).push(...(t ? [t] : []));
    }
    if (found.turn) launch(planTurn());
    if (found.search) launch(planSearch(found.search, null));
    if (found.recall) launch(planGet(found.recall, null));
  }, [events, live, store, launch]);

  // no live feed: the recent activity from the feed's own history, one request at a time, so the view is never a still picture
  const [replaying, setReplaying] = useState(false);
  useEffect(() => {
    if (live) return;
    const recent = store.events.slice(-12).filter((e) => store.nodes.has(e[1]));
    if (!recent.length) return;
    setReplaying(true);
    let i = 0;
    const play = () => {
      const e = recent[i++ % recent.length];
      const t = hitOfNode(store.nodes.get(e[1]));
      launch(e[2] === 'turn' ? planTurn() : e[2] === 'search' ? planSearch(t ? [t] : [], null) : planGet(t ? [t] : [], null));
    };
    const first = setTimeout(play, 500);
    const id = setInterval(play, REPLAY_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
      setReplaying(false);
    };
  }, [live, store, launch]);

  // TEST-ASK (local): one traced search; while it runs the thalamus keeps charging, then AskLog plays it step by step
  const onSearch = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
      if (!q) return;
      const seq = ++searchSeq.current;
      setSearch({ phase: 'wait', q });
      const charge = setInterval(() => launch({ kind: 'search', legs: [], blooms: [{ region: 'thalamus', at: 0, amp: 0.7 }], total: 0 }), 700);
      launch({ kind: 'search', legs: [], blooms: [{ region: 'thalamus', at: 0, amp: 0.7 }], total: 0 });
      try {
        const trace = await runSearch(q);
        if (seq !== searchSeq.current) return;
        setSearch({ phase: 'done', trace, seq });
      } catch (e) {
        if (seq === searchSeq.current) setSearch({ phase: 'error', q, why: (e as Error).message });
      } finally {
        clearInterval(charge);
      }
    },
    [launch],
  );

  const onPointer = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const id = stage.current?.regionAt(ev.clientX - r.left, ev.clientY - r.top) ?? null;
    if (ev.type === 'pointerdown' && ev.pointerType !== 'mouse') setPinned((p) => (id === p ? null : id)); // touch: tap a region to read it, tap again to drop it
    else if (ev.pointerType === 'mouse') setHovered(id);
  };
  const tip = marked ? REGION[marked] : null;

  return (
    <section className="bv" role="dialog" aria-modal="true" aria-label="สมอง แผนที่ความคิดของ memory-hub">
      <header className="bv__head">
        <div>
          <h2 className="bv__title">สมอง</h2>
          <p className="bv__sub">{live ? 'ทุกครั้งที่ AI เรียกความจำ แสงจะวิ่งในสมองนี้ทันที' : replaying ? 'ย้อนดูกิจกรรมล่าสุดของสมองนี้ (นับจำนวนเท่านั้น ไม่มีเนื้อหา)' : 'แสงวิ่งเมื่อมีกิจกรรมใหม่ (นับจำนวนเท่านั้น ไม่มีเนื้อหา)'}</p>
        </div>
        <button ref={closeRef} type="button" className="btn" onClick={onClose}>
          ปิด
        </button>
      </header>
      <div className="bv__body" data-live={live || undefined} data-ask={(live && search.phase !== 'idle') || undefined}>
        <div className="bv__area">
          <div ref={boxRef} className="bv__box" style={{ '--img-w': IMAGE.w, '--img-h': IMAGE.h } as CSSProperties}>
            <img className="bv__img" src="brain-anatomy.webp" alt="" width={IMAGE.w} height={IMAGE.h} decoding="async" />
            <canvas ref={canvasRef} className="bv__canvas" aria-hidden="true" onPointerMove={onPointer} onPointerDown={onPointer} onPointerLeave={() => setHovered(null)} />
            {tip && (
              <div className="bv__tip" role="tooltip" data-below={tip.y < 0.3 || undefined} style={{ '--x': `${tip.x * 100}%`, '--y': `${tip.y * 100}%` } as CSSProperties}>
                <b>{tip.name}</b> · {tip.role}
                <span>{tip.text}</span>
              </div>
            )}
          </div>
        </div>
        <ul className="bv__legend" aria-label="ความหมายของแต่ละส่วนของสมอง">
          {REGIONS.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="bv__reg"
                aria-pressed={pinned === r.id}
                onClick={() => setPinned((p) => (p === r.id ? null : r.id))}
                onPointerEnter={() => setHovered(r.id)}
                onPointerLeave={() => setHovered(null)}
                onFocus={() => setHovered(r.id)}
                onBlur={() => setHovered(null)}
              >
                <b>{r.name}</b> = {r.role}
                <span>{r.text}</span>
              </button>
            </li>
          ))}
        </ul>
        {live && (
          <aside className="bv__side" aria-label="ทดสอบถาม และคำขอจาก AI">
            <form className="bv__search" onSubmit={onSearch} role="search">
              <input ref={askRef} name="q" type="search" className="bv__input" aria-label="ทดสอบถามความจำ" placeholder="ทดสอบถาม เช่น memory-hub ห้ามเดา" maxLength={300} autoComplete="off" />
              <button type="submit" className="btn" disabled={search.phase === 'wait'}>
                ถาม
              </button>
            </form>
            <div className="bv__result">
              {search.phase === 'wait' && (
                <p className="bv__wait" role="status" data-busy>
                  กำลังถาม… “{search.q}”
                </p>
              )}
              {search.phase === 'error' && (
                <p className="bv__wait" role="status">
                  {REFUSED[search.why] ?? 'ค้นไม่สำเร็จ ลองใหม่อีกครั้ง'}
                </p>
              )}
              {search.phase === 'done' && <AskLog key={search.seq} trace={search.trace} launch={launch} reduced={reduced} />}
            </div>
            <h3 className="bv__h">คำขอล่าสุดจาก AI</h3>
            <ol className="bv__ticker" aria-label="คำขอล่าสุดจาก AI" aria-live="off">
              {calls.length === 0 && <li className="bv__empty">ยังไม่มีคำขอ รอ AI เรียกความจำ…</li>}
              {[...calls].reverse().map((c) => (
                <CallRow key={`${c.t}|${c.kind}`} c={c} />
              ))}
            </ol>
          </aside>
        )}
      </div>
    </section>
  );
}
