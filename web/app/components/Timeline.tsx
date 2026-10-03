'use client';
import { useLayoutEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { fmtDate, fmtInt, fmtMonth } from '../lib/format';
import { shown, useSize } from '../lib/hooks';
import type { BrainStore } from '../lib/store';
import type { DataStatus } from '../lib/useBrainData';
import { SPEEDS, type Replay, type useDriver } from '../lib/useDriver';

const DAY = 86400;
const CHART_H = 56;
const AXIS_H = 18;

type Actions = ReturnType<typeof useDriver>['actions'];

/** Activity histogram (events per day over the replay domain) + scrubber + replay controls. The readout also carries the data status. */
export function Timeline(props: { store: BrainStore; domain: [number, number]; replay: Replay; actions: Actions; status: DataStatus }) {
  const { store, domain, replay, actions, status } = props;
  const [start, end] = domain;
  const [boxRef, { width: W }] = useSize<HTMLDivElement>();

  const day0 = Math.floor(start / DAY) * DAY;
  const days = Math.max(1, Math.ceil((end - day0) / DAY));
  const evCount = store.events.length;

  const { bins, max } = useMemo(() => {
    const b = new Array<number>(days).fill(0);
    for (const e of store.events) {
      const i = Math.floor((e[0] - day0) / DAY);
      if (i >= 0 && i < days) b[i] += e[3];
    }
    return { bins: b, max: Math.max(1, ...b) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, evCount, day0, days]);

  const xOf = (t: number) => ((t - day0) / (days * DAY)) * W;
  const bw = W / days;
  const barsD = useMemo(() => {
    if (!W) return '';
    const gap = bw > 3 ? 1 : 0;
    return bins
      .map((v, i) => {
        if (!v) return '';
        const h = Math.max(1, (v / max) * CHART_H);
        return `M${(i * bw).toFixed(1)} ${CHART_H}v${-h.toFixed(1)}h${(bw - gap).toFixed(1)}v${h.toFixed(1)}z`;
      })
      .join('');
  }, [bins, max, bw, W]);

  const months = useMemo(() => {
    const out: { t: number; label: string }[] = [];
    const d = new Date(day0 * 1000);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    for (let guard = 0; guard < 48; guard++) {
      const t = d.getTime() / 1000;
      if (t > end) break;
      if (t >= day0) out.push({ t, label: fmtMonth(t, d.getUTCMonth() === 0) });
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return out;
  }, [day0, end]);

  const live = replay.head === null;
  const headT = replay.head ?? end;
  const headX = xOf(headT);

  const seek = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const k = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    actions.scrub(day0 + k * days * DAY);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seek(e.clientX, e.currentTarget);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.buttons & 1) seek(e.clientX, e.currentTarget);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // ARIA slider keys: Up/Right forward, Down/Left back, Page keys a week (as Shift)
    const step = e.shiftKey || e.key.startsWith('Page') ? 7 * DAY : DAY;
    const dir = ({ ArrowRight: 1, ArrowUp: 1, PageUp: 1, ArrowLeft: -1, ArrowDown: -1, PageDown: -1 } as Record<string, number>)[e.key];
    if (dir) {
      const t = headT + dir * step;
      if (t >= end) actions.live(); // increase at max (LIVE) stays LIVE, as End
      else actions.scrub(t);
    }
    else if (e.key === 'Home') actions.scrub(start);
    else if (e.key === 'End') actions.live();
    else return;
    e.preventDefault();
  };

  return (
    <section className="timeline panel" aria-label="ไทม์ไลน์กิจกรรมและการเล่นซ้ำ">
      <div className="tl__controls">
        <button
          type="button"
          className="btn btn--icon btn--play"
          aria-label={replay.playing ? 'หยุดเล่นซ้ำ' : 'เล่นซ้ำ'}
          onClick={replay.playing ? actions.pause : actions.play}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
            {replay.playing ? <path d="M3 2h3v10H3zM8 2h3v10H8z" /> : <path d="M3 1.5v11l9-5.5z" />}
          </svg>
        </button>
        <div className="seg" role="group" aria-label="ความเร็วเล่นซ้ำ (วันต่อวินาที)" style={{ '--i': SPEEDS.indexOf(replay.speed as (typeof SPEEDS)[number]) } as CSSProperties}>
          <span className="seg__thumb" aria-hidden="true" />
          {SPEEDS.map((s) => (
            <button key={s} type="button" className="seg__btn" aria-pressed={replay.speed === s} onClick={() => actions.speed(s)} title={`เล่นประวัติ ${s} วันต่อวินาที`}>
              {s}×
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--live" aria-pressed={live} onClick={actions.live}>
          <span className="btn__dot" aria-hidden="true" />
          สด
        </button>
        <output className="tl__readout" aria-live="off">
          {!live ? fmtDate(headT) : status === 'error' ? 'ไม่มีข้อมูล' : status === 'snapshot' ? `ข้อมูล ณ ${fmtDate(store.at)}` : 'ตอนนี้'}
        </output>
      </div>
      <div
        ref={boxRef}
        className="tl__chart"
        role="slider"
        tabIndex={0}
        aria-label="ตำแหน่งเล่นซ้ำ"
        aria-valuemin={Math.round(start)}
        aria-valuemax={Math.round(end)}
        // fixed while playing: a value ticking at 30 Hz would be read out non-stop to a focused screen reader
        aria-valuenow={Math.round(replay.playing ? end : headT)}
        aria-valuetext={live ? (status === 'live' ? 'สด' : `ล่าสุด · ข้อมูล ณ ${fmtDate(store.at)}`) : replay.playing ? `กำลังเล่นซ้ำ ${replay.speed}×` : fmtDate(headT)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onKeyDown}
      >
        {W > 0 && (
          <svg width={W} height={CHART_H + AXIS_H} aria-hidden="true">
            <defs>
              <clipPath id="tl-played">
                <rect x="0" y="0" width={Math.max(0, headX)} height={CHART_H} />
              </clipPath>
            </defs>
            <line className="tl__base" x1="0" x2={W} y1={CHART_H + 0.5} y2={CHART_H + 0.5} />
            <path className="tl__bar" d={barsD} />
            <path className="tl__bar tl__bar--played" d={barsD} clipPath="url(#tl-played)" />
            {months.map((m) => (
              <g key={m.t}>
                <line className="tl__tick" x1={xOf(m.t)} x2={xOf(m.t)} y1={CHART_H} y2={CHART_H + 4} />
                {/* ponytail: ~7px per char at 12px estimate; a label that would be cut at the right edge is skipped, its tick stays */}
                {xOf(m.t) + 3 + m.label.length * 7 <= W && (
                  <text className="tl__xlabel" x={xOf(m.t) + 3} y={CHART_H + 15}>
                    {m.label}
                  </text>
                )}
              </g>
            ))}
            {live ? (
              <circle className="tl__live" cx={W - 4} cy={CHART_H} r="4" />
            ) : (
              <>
                <line className="tl__head" x1={headX} x2={headX} y1="0" y2={CHART_H} />
                <circle className="tl__handle" cx={Math.min(W - 4, Math.max(4, headX))} cy={CHART_H} r="4" />
              </>
            )}
          </svg>
        )}
      </div>
    </section>
  );
}

/**
 * Bottom-centre caption of the page-load intro: the replay date ticking (warp: "ข้ามช่วงเงียบ") with a ข้าม button that
 * appears at 600 ms; on landing, the LIVE line, which fades after 1.8 s.
 */
export function IntroCaption({ replay, end, live, liveText, onSkip }: { replay: Replay; end: number; live: boolean; liveText: string; onSkip: () => void }) {
  if (replay.intro === 'run') return <IntroRun replay={replay} end={end} live={live} onSkip={onSkip} />;
  if (replay.intro === 'live' || replay.intro === 'skip') {
    return (
      <div className="caption caption--live panel" role="status">
        {liveText}
      </div>
    );
  }
  return null;
}

function IntroRun({ replay, end, live, onSkip }: { replay: Replay; end: number; live: boolean; onSkip: () => void }) {
  const skipRef = useRef<HTMLButtonElement>(null);
  // ข้าม unmounts when the intro ends (skipped or landed): a keyboard user lands on สด instead of <body>, or on the first
  // visible fallback (a phone's details sheet hides the timeline). A layout cleanup runs before React removes the
  // button, while it still holds focus; the move waits for the commit's end, when .stage has left the intro phase
  // (short viewports hide the timeline until then). Keyboard focus only: a tap or click focuses the button too (Chrome),
  // and the move's scroll to สด put a short viewport's timeline over the reveal; a pointer user's focus falls to <body>.
  useLayoutEffect(() => {
    const btn = skipRef.current;
    return () => {
      if (btn?.matches(':focus-visible')) queueMicrotask(() => ['.btn--live', '.details .btn', '.btn--hud'].map((s) => document.querySelector(s)).find(shown)?.focus());
    };
  }, []);
  return (
    <div className="caption panel">
      <div className="caption__text">
        <span className="caption__date" aria-hidden="true">
          {fmtDate(replay.head ?? end)}
        </span>
        <span className="caption__sub">{replay.warp ? 'ข้ามช่วงเงียบ' : `ย้อนดูความจำ ${fmtInt((end - replay.from) / DAY)} วัน · ${replay.speed}×`}</span>
      </div>
      <button ref={skipRef} type="button" className="btn caption__skip" onClick={onSkip} aria-label={live ? 'ข้ามไปดูแบบสด' : 'ข้ามไปข้อมูลล่าสุด'}>
        ข้าม
      </button>
    </div>
  );
}
