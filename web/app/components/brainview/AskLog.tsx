'use client';
// The test-ask log: one traced search played as the steps memory_search takes (steps.ts), one at a time, each with its slow
// route over the brain, then every scored candidate grouped by what became of it. Remounted per ask (key), so a new ask
// cancels the old replay's timers.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Trace, TraceRow } from '../../lib/live';
import { HIT_NAME, REGION } from './regions';
import { planTrace, traceNote, type Plan } from './routes';
import { KIND_RGB, rgbCss } from './stage';
import { askSteps, dwellOf, origins, revealGap, revealPlan, rowGroups, rrf, stepPlan, type Item, type Step } from './steps';

const SPEEDS = [
  [0.5, 'ช้า'],
  [1, 'ปกติ'],
  [2, 'เร็ว'],
] as const;
const PRIVATE_TEXT = '(ข้อมูลส่วนตัว)';

/** shown: the steps on screen; reveal: answers shown in the last one (the answer step reveals them one by one) */
type At = { shown: number; reveal: number };

function Items({ items }: { items: readonly Item[] }) {
  return (
    <ol className="al__items">
      {items.map((it, i) => (
        <li key={i}>
          <span className="al__rank">{it.rank}</span>
          <span className="bv__chip">{HIT_NAME[it.type]}</span>
          <span className="al__label">{it.label}</span>
          {it.note && <span className="al__note">{it.note}</span>}
        </li>
      ))}
    </ol>
  );
}

function StepRow({ st, n, items, now }: { st: Step; n: number; items: readonly Item[]; now: boolean }) {
  return (
    <li className="al__step" data-tone={st.tone} data-now={now || undefined} style={{ '--c': rgbCss(KIND_RGB[st.kind]) } as CSSProperties}>
      <div className="al__head">
        <span className="al__n" aria-hidden="true">
          {n}
        </span>
        <b className="al__title">{st.title}</b>
        <span className="al__reg">{REGION[st.region].name}</span>
        {st.ms !== null && <span className="al__ms">{Math.round(st.ms)} ms</span>}
      </div>
      <p className="al__text">{st.text}</p>
      {st.facts.length > 0 && (
        <ul className="al__facts">
          {st.facts.map((f, i) => (
            <li key={i} data-tone={f.tone}>
              {f.label} <b>{f.value}</b>
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && <Items items={items} />}
    </li>
  );
}

/** every row the search scored, in its decision order (#), grouped by what became of it */
function Candidates({ rows }: { rows: readonly TraceRow[] }) {
  const at = new Map(rows.map((r, i) => [r, i + 1]));
  return (
    <section className="al__all" aria-label="ผู้เข้ารอบทั้งหมด">
      <h3 className="bv__h">ผู้เข้ารอบทั้งหมด {rows.length} ชิ้น · เรียงตามที่การค้นตัดสิน</h3>
      {rowGroups(rows).map((g) => (
        <details key={g.key} className="al__group" data-key={g.key} open>
          <summary>
            <b>{g.title}</b> {g.rows.length} · <span>{g.note}</span>
          </summary>
          <Items
            items={g.rows.map((r) => {
              const base = rrf(r);
              const note = [
                r.why.startsWith('fold:') ? `ใต้ ${r.why.slice(5)}` : '',
                ...origins(r),
                base ? `RRF ${base.toFixed(4)} → คะแนน ${r.score.toFixed(4)}` : `คะแนน ${r.score.toFixed(4)}`,
                r.ev ? `+แชตต้นทาง ${r.ev}` : '',
                r.status ?? '',
              ];
              return { rank: `#${at.get(r)}`, type: r.type, label: r.type === 'private' ? PRIVATE_TEXT : r.label, note: note.filter(Boolean).join(' · ') };
            })}
          />
        </details>
      ))}
    </section>
  );
}

export default function AskLog({ trace, launch, reduced }: { trace: Trace; launch: (p: Plan) => void; reduced: boolean }) {
  const [steps] = useState(() => askSteps(trace));
  const answer = steps[steps.length - 1];
  const end: At = { shown: steps.length, reveal: answer?.items.length ?? 0 };
  const [at, setAt] = useState<At>(() => (reduced ? end : { shown: 0, reveal: 0 }));
  const [playing, setPlaying] = useState(!reduced);
  const [speed, setSpeed] = useState(1);
  const done = at.shown === end.shown && at.reveal === end.reveal;
  const listRef = useRef<HTMLOListElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null); // stays mounted through play / pause / done: focus never drops to <body>

  // one move forward: the next answer of the answer step, or the next step (its route plays as it appears)
  const step = (a: At): At | null => {
    const cur = steps[a.shown - 1];
    if (cur === answer && a.reveal < end.reveal) {
      launch(revealPlan(answer.items[a.reveal].type));
      return { shown: a.shown, reveal: a.reveal + 1 };
    }
    if (a.shown >= steps.length) return null;
    launch(stepPlan(steps[a.shown], speed));
    return { shown: a.shown + 1, reveal: 0 };
  };

  useEffect(() => {
    if (!playing || done) return;
    const cur = steps[at.shown - 1];
    // the first answer waits for the route back to the thalamus; a step stays as long as its dwell
    const s = !cur ? 0.2 : cur === answer ? (at.reveal ? revealGap(speed) : stepPlan(cur, speed).total + 0.2) : dwellOf(cur, speed);
    const id = setTimeout(() => {
      const n = step(at);
      if (n) setAt(n);
    }, s * 1000);
    return () => clearTimeout(id);
  }, [at, playing, speed, done]); // not on every render: the ticker re-renders the view each new call and would restart the wait
  useEffect(() => {
    if (done) setPlaying(false);
  }, [done]);
  useEffect(() => {
    // follow inside the log's own scroll box only (on phones the whole view scrolls: the picture must stay put): a new step's
    // head under the bar, a new answer fully in view. Braces: Chrome's scroll methods return a promise, an effect only its cleanup
    const el = listRef.current?.lastElementChild, box = listRef.current?.closest('.bv__result');
    if (!el || !box || box.scrollHeight <= box.clientHeight) return;
    const r = el.getBoundingClientRect(), b = box.getBoundingClientRect(), bar = box.querySelector('.al__bar')?.clientHeight ?? 0;
    box.scrollBy({ top: at.reveal ? Math.max(0, r.bottom - b.bottom) : r.top - b.top - bar - 8, behavior: reduced ? 'auto' : 'smooth' });
  }, [at.shown, at.reveal, reduced]);

  if (!steps.length) return <p className="bv__wait">ตัวแสดงขั้นตอนต้องใช้ brain-serve รุ่นใหม่ (รีสตาร์ต brain-serve)</p>;

  const skip = () => {
    setPlaying(false);
    setAt(end);
    launch(planTrace(trace));
    firstRef.current?.focus(); // ข้ามไปผล / ถัดไป disappear at the end
  };
  const replay = () => {
    setAt({ shown: 0, reveal: 0 });
    setPlaying(true);
  };
  const next = () => {
    setPlaying(false);
    const n = step(at);
    if (n) setAt(n);
    if (!n || (n.shown === end.shown && n.reveal === end.reveal)) firstRef.current?.focus();
  };

  return (
    <div className="al">
      <div className="al__bar" role="toolbar" aria-label="ควบคุมการเล่น">
        <button ref={firstRef} type="button" className="btn" onClick={done ? replay : () => setPlaying((p) => !p)}>
          {done ? '↺ เล่นซ้ำ' : playing ? '⏸ หยุด' : '▶ เล่นต่อ'}
        </button>
        {!done && (
          <>
            <button type="button" className="btn" onClick={next}>
              ถัดไป
            </button>
            <button type="button" className="btn" onClick={skip}>
              ข้ามไปผล
            </button>
          </>
        )}
        <span className="al__speed" role="group" aria-label="ความเร็ว">
          {SPEEDS.map(([v, name]) => (
            <button key={v} type="button" className="al__sp" aria-pressed={speed === v} onClick={() => setSpeed(v)}>
              {name}
            </button>
          ))}
        </span>
        <span className="al__prog">
          ขั้น {at.shown}/{steps.length}
        </span>
      </div>
      <p className="al__sr" role="status">
        {done ? 'จบแล้ว' : (steps[at.shown - 1]?.title ?? '')}
      </p>
      {done && traceNote(trace).status && <p className="bv__unknown">{traceNote(trace).status}</p>}
      <ol ref={listRef} className="al__steps">
        {steps.slice(0, at.shown).map((st, i) => (
          <StepRow
            key={st.id}
            st={st}
            n={i + 1}
            now={!done && i === at.shown - 1}
            items={st === answer ? st.items.slice(0, at.reveal) : st.items}
          />
        ))}
      </ol>
      {done && trace.explain && <Candidates rows={trace.explain.rows} />}
    </div>
  );
}
