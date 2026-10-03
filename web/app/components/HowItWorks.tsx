'use client';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { APP_COLOR, APP_NAME, isApp, type App, type Brain, type BrainNode } from '../lib/brain';
import { ago, fmtClock, fmtDate, fmtInt, fmtMonth } from '../lib/format';
import { calendar, dayT, dreamNodes, level, monthly, type Activity } from '../lib/insight';
import { numberGroups } from '../lib/numbers';
import type { BrainStore } from '../lib/store';
import type { Spotlight } from './BrainScene';
import { usePanelFocus } from './Panels';
import './HowItWorks.css';

type Step = 'keep' | 'search' | 'dream' | 'link';
/** what a hovered / pinned item spotlights in the brain */
type Key = `step:${Step}` | `app:${App}` | 'dream';
type ItemProps = { 'aria-pressed': boolean; onPointerEnter(): void; onPointerLeave(): void; onFocus(): void; onBlur(): void; onClick(): void };

const STEPS: { key: Step; name: string; text: string; count: (s: Record<string, number>) => string }[] = [
  { key: 'keep', name: 'เก็บ', text: 'ทุกแชตกับ AI ทุกตัว เก็บไว้ในเครื่องของเจ้าของตลอดไป', count: (s) => `${fmtInt(s.chats ?? s.turns ?? 0)} ข้อความ` },
  { key: 'search', name: 'ค้น', text: 'ก่อนตอบ AI ค้นความจำก่อน ได้ทั้งไทย อังกฤษ และโค้ด', count: (s) => `${fmtInt(s.hits7d ?? 0)} ครั้งใน 7 วัน` },
  { key: 'dream', name: 'ฝัน', text: 'Claude อ่านแชตของแต่ละวัน แล้วกลั่นเป็นข้อเท็จจริงสั้น ๆ', count: (s) => `${fmtInt(s.memories ?? 0)} ความจำ` }, // nbsp: ๆ never wraps alone
  { key: 'link', name: 'เชื่อม', text: 'ความจำโยงกันเป็นสมองนี้ ยิ่งใช้บ่อย ยิ่งแน่น', count: (s) => `${fmtInt(s.links ?? 0)} เส้นเชื่อม` },
];
const WEEKDAYS = ['', 'จ.', '', 'พ.', '', 'ศ.', '']; // Sunday-first rows, every other label (GitHub style)

/** Apps in the export, most messages first. */
function appsByTurns(apps: Brain['apps']): App[] {
  return (Object.keys(apps ?? {}) as App[]).filter(isApp).sort((a, b) => (apps![b]?.turns ?? 0) - (apps![a]?.turns ?? 0));
}

function Toggle(props: { on: boolean; onClick: () => void; title: string; label: string }) {
  return (
    <button type="button" className="btn btn--sm" aria-pressed={props.on} onClick={props.onClick} title={props.title}>
      <span className="btn__dot" aria-hidden="true" />
      {props.label}
    </button>
  );
}
const LENS = { title: 'ระบายสีจุดในสมองตาม AI ที่สร้าง', label: 'สีตาม AI' };
const SEMANTIC = { title: 'ย้ายแต่ละจุดไปอยู่ตามความหมาย เรื่องที่คล้ายกันอยู่ใกล้กัน', label: 'จัดตามความหมาย' };

/**
 * Last row of the stat strip: opens the panel, toggles the lenses (colour by AI, layout by meaning) and, with the colour
 * lens on, shows its key (names always written: colour alone never identifies an app). memo: the page memoizes its props,
 * not per replay frame.
 */
export const HowRow = memo(function HowRow(props: { apps: Brain['apps']; open: boolean; onOpen: () => void; lens: boolean; onLens: () => void; semantic: boolean; onSemantic: () => void }) {
  return (
    <div className="howrow">
      <div className="howrow__btns">
        <button type="button" className="btn btn--sm howrow__open" aria-expanded={props.open} aria-controls="how" onClick={props.onOpen}>
          ระบบนี้ทำงานยังไง?
        </button>
        <Toggle on={props.lens} onClick={props.onLens} {...LENS} />
        <Toggle on={props.semantic} onClick={props.onSemantic} {...SEMANTIC} />
      </div>
      {props.lens && (
        <ul className="appkey" aria-label="สีของ AI แต่ละตัว">
          {appsByTurns(props.apps).map((a) => (
            <li key={a}>
              <span className="appkey__dot" style={{ '--c': APP_COLOR[a] } as CSSProperties} aria-hidden="true" />
              {APP_NAME[a]}
            </li>
          ))}
          <li>
            <span className="appkey__dot appkey__dot--none" aria-hidden="true" />
            โปรเจ็กต์ · ความจำ
          </li>
        </ul>
      )}
    </div>
  );
});

function idsOf(key: Key, store: BrainStore): Set<string> {
  const out = new Set<string>();
  const add = (keep: (n: BrainNode) => boolean) => store.nodes.forEach((n) => keep(n) && out.add(n.id));
  if (key === 'step:keep') add((n) => n.type === 'session' || n.type === 'subagent');
  else if (key === 'step:search') {
    add((n) => n.u > 0);
    for (const e of store.events) if (e[2] !== 'turn') out.add(e[1]);
  } else if (key === 'step:dream') add((n) => n.type === 'memory');
  else if (key === 'step:link') {
    for (const l of store.links) if (l.k !== 'in' && l.k !== 'spawn') out.add(l.source).add(l.target);
  } else if (key === 'dream') {
    if (store.dream) for (const id of dreamNodes(store.nodes.values(), store.dream, store.log)) out.add(id);
  } else add((n) => n.a === key.slice(4));
  return out;
}

/**
 * "ระบบนี้ทำงานยังไง": the 4-step flow, per-app breakdown, daily heatmap and the last dream. Hovering / focusing an item
 * spotlights its nodes in the brain; a click pins it. Desktop: a drawer over the side panel; phones: a bottom sheet.
 * Esc closes it first (capture phase: the page's own Esc would also clear the selection).
 */
export const HowPanel = memo(function HowPanel(props: {
  store: BrainStore;
  /** store versions: `rev` (nodes / links), `tick` (any merge: stats, apps, activity, dream) */
  rev: number;
  tick: number;
  now: number;
  lens: boolean;
  onLens: () => void;
  semantic: boolean;
  onSemantic: () => void;
  onSpot: (s: Spotlight | null) => void;
  onClose: () => void;
  reduced: boolean;
}) {
  const { store, rev, now, onSpot, onClose, reduced } = props;
  const ref = usePanelFocus<HTMLElement>();
  const [pinned, setPinned] = useState<Key | null>(null);
  const [hovered, setHovered] = useState<Key | null>(null);
  const active = hovered ?? pinned;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ids = useMemo(() => (active ? idsOf(active, store) : null), [active, store, rev]);
  const pulsed = useRef<Key | null>(null);
  useEffect(() => {
    // a new item pulses once; new data under the same item (a LIVE merge) only refreshes the set
    onSpot(ids && { ids, pulse: active !== pulsed.current });
    pulsed.current = active;
  }, [ids, active, onSpot]);
  useEffect(() => () => onSpot(null), [onSpot]);
  // the dream run lights up in three waves (none under reduced motion: the spotlight alone stays)
  useEffect(() => {
    if (active !== 'dream' || !ids || reduced) return;
    const timers = [900, 1800].map((ms) => setTimeout(() => onSpot({ ids, pulse: true }), ms));
    return () => timers.forEach(clearTimeout);
  }, [active, ids, reduced, onSpot]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const item = (key: Key): ItemProps => ({
    'aria-pressed': pinned === key,
    onPointerEnter: () => setHovered(key),
    onPointerLeave: () => setHovered((h) => (h === key ? null : h)),
    onFocus: () => setHovered(key),
    onBlur: () => setHovered((h) => (h === key ? null : h)),
    onClick: () => setPinned((p) => (p === key ? null : key)),
  });

  const apps = appsByTurns(store.apps);
  const notes = useMemo(() => {
    const by: Partial<Record<App, number>> = {};
    store.nodes.forEach((n) => n.type === 'note' && isApp(n.a) && (by[n.a] = (by[n.a] ?? 0) + 1));
    return by;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, rev]);
  const top = Math.max(1, ...apps.map((a) => store.apps[a]?.turns ?? 0));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dreamCount = useMemo(() => (store.dream ? dreamNodes(store.nodes.values(), store.dream, store.log).length : 0), [store, rev, store.dream]);

  return (
    <section ref={ref} id="how" className="how panel" aria-label="ระบบนี้ทำงานยังไง">
      <div className="panel__head">
        <span>ระบบนี้ทำงานยังไง</span>
        <button type="button" className="btn" onClick={onClose}>
          ปิด
        </button>
      </div>
      <div className="how__body">
        <p className="how__lead">สมุดความจำกลางที่ AI หลายตัวใช้ร่วมกัน ชี้หรือแตะแต่ละข้อ เพื่อดูส่วนนั้นในสมอง</p>
        <ol className="flow">
          {STEPS.map((s, i) => (
            <li key={s.key}>
              <button type="button" className="flow__step" {...item(`step:${s.key}`)}>
                <span className="flow__n" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="flow__name">{s.name}</span>
                <span className="flow__count">{s.count(store.stats)}</span>
                <span className="flow__text">{s.text}</span>
              </button>
              {s.key === 'link' && (
                <p className="flow__more">
                  <Toggle on={props.semantic} onClick={props.onSemantic} {...SEMANTIC} />
                  <span>เรื่องที่คล้ายกันจะลอยมาอยู่ใกล้กัน ไม่ว่ามาจาก AI ตัวไหน (จุดที่จัดไม่ได้ เช่น โปรเจ็กต์ ซ่อนไว้)</span>
                </p>
              )}
            </li>
          ))}
        </ol>

        <Numbers store={store} now={now} />

        <section className="how__sec" aria-labelledby="how-apps">
          <div className="how__sechead">
            <h2 id="how-apps">AI ที่ใช้ความจำนี้</h2>
            <Toggle on={props.lens} onClick={props.onLens} {...LENS} />
          </div>
          {apps.length ? (
            <ul className="apps">
              {apps.map((a) => {
                const s = store.apps[a]!;
                const what = s.sessions ? `${fmtInt(s.sessions)} บทสนทนา${s.subagents ? ` · ${fmtInt(s.subagents)} เอเจนต์ย่อย` : ''}` : `${fmtInt(notes[a] ?? 0)} โน้ต`;
                return (
                  <li key={a}>
                    <button type="button" className="approw" style={{ '--c': APP_COLOR[a], '--w': s.turns / top } as CSSProperties} {...item(`app:${a}`)}>
                      <span className="appkey__dot" aria-hidden="true" />
                      <span className="approw__name">{APP_NAME[a]}</span>
                      <span className="approw__num">{fmtInt(s.turns)} ข้อความ</span>
                      <span className="approw__bar" aria-hidden="true" />
                      <span className="approw__meta">
                        {what} · ล่าสุด {ago(now - s.t1)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="how__note">ข้อมูลชุดนี้ยังไม่แยกตาม AI</p>
          )}
        </section>

        <section className="how__sec" aria-labelledby="how-heat">
          <h2 id="how-heat">แชตรายวัน ย้อนหลัง 1 ปี</h2>
          {store.activity?.turns.length ? <Heatmap a={store.activity} /> : <p className="how__note">ยังไม่มีข้อมูล</p>}
        </section>

        <section className="how__sec" aria-labelledby="how-dream">
          <h2 id="how-dream">ฝันล่าสุดได้อะไร</h2>
          {store.dream ? (
            <DreamCard dream={store.dream} now={now} count={dreamCount} item={item('dream')} />
          ) : (
            <p className="how__note">ยังไม่เคยฝัน</p>
          )}
        </section>
      </div>
    </section>
  );
});

/**
 * "ตัวเลขสมอง": counts and sizes in four groups. Each row explains itself in plain Thai: a hover tooltip (title) on
 * desktop, and a native disclosure so a tap (phones) or Enter shows the same text.
 */
function Numbers({ store, now }: { store: BrainStore; now: number }) {
  const groups = numberGroups(store.stats, store.model, now);
  if (!groups.length) return null;
  return (
    <section className="how__sec" aria-labelledby="how-nums">
      <h2 id="how-nums">ตัวเลขสมอง</h2>
      <div className="nums">
        {groups.map((g) => (
          <div key={g.name} className="nums__group">
            <h3>{g.name}</h3>
            <ul>
              {g.rows.map((r) => (
                <li key={r.label} data-part={r.w !== undefined || undefined} data-sub={r.sub} style={r.w !== undefined ? ({ '--w': r.w } as CSSProperties) : undefined}>
                  <details className="nums__row">
                    <summary title={r.tip}>
                      <span>{r.label}</span>
                      <b>{r.value}</b>
                    </summary>
                    <p>{r.tip}</p>
                  </details>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="how__note">แตะหรือชี้ที่แถวเพื่อดูคำอธิบาย · นับเฉพาะจำนวน ไม่มีชื่องานหรือเนื้อหา</p>
    </section>
  );
}

const DREAM_TILES: [key: string, label: string][] = [
  ['sessions', 'แชตที่อ่าน'],
  ['ADD', 'จำเพิ่ม'],
  ['UPDATE', 'ปรับของเดิม'],
  ['NOOP', 'รู้แล้ว คงเดิม'],
];

function DreamCard({ dream, now, count, item }: { dream: NonNullable<Brain['dream']>; now: number; count: number; item: ItemProps }) {
  const age = now - dream.t;
  const extra = [dream.c.SUPERSEDE ? `แทนที่ของเก่า ${fmtInt(dream.c.SUPERSEDE)}` : '', dream.c.pending_review ? `รอเจ้าของตรวจ ${fmtInt(dream.c.pending_review)}` : ''].filter(Boolean);
  return (
    <div className="dream">
      {/* honest about when: a run older than a day is not "last night" */}
      <p className="dream__when">
        {age < 86400 ? `รอบล่าสุด ${ago(age)} (${fmtClock(dream.t)})` : `เมื่อคืนไม่ได้ฝัน · รอบล่าสุด ${fmtClock(dream.t)} (${ago(age)})`}
      </p>
      <dl className="dream__tiles">
        {DREAM_TILES.map(([k, label]) => (
          <div key={k}>
            <dt>{label}</dt>
            <dd>{fmtInt(dream.c[k] ?? 0)}</dd>
          </div>
        ))}
      </dl>
      {extra.length > 0 && <p className="how__note">{extra.join(' · ')}</p>}
      <button type="button" className="btn btn--sm dream__show" disabled={!count} {...item}>
        {/* a time window, not the run's own list (see dreamNodes): "recorded around this run", not "added by it"; no count
            next to the run's own tiles (cards and hubs land in the window too) */}
        ดูความจำที่บันทึกช่วงเวลาเดียวกันในสมอง
      </button>
    </div>
  );
}

/**
 * GitHub-style calendar: a column per week, Sunday on top, Bangkok days. One tab stop: a slider over the days (←/→ a
 * week, ↑/↓ a day, Home/End), its value text = the tooltip; the monthly table below is the screen-reader view.
 */
const Heatmap = memo(function Heatmap({ a }: { a: Activity }) {
  const cal = useMemo(() => calendar(a), [a]);
  const months = useMemo(() => monthly(a), [a]);
  const n = a.turns.length;
  const [cur, setCur] = useState(n - 1);
  const [tip, setTip] = useState<number | null>(null);
  const focused = useRef(false);
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const day = Math.min(cur, n - 1);
  const text = (i: number) => `${fmtDate(dayT(a, i))} · ${fmtInt(a.turns[i])} ข้อความ`;
  const cell = (i: number) => wrap.current?.querySelector<HTMLElement>(`[data-i="${i}"]`);

  // newest weeks in view first (the grid scrolls sideways when the panel is narrower than a year)
  useEffect(() => {
    const s = scroller.current;
    if (s) s.scrollLeft = s.scrollWidth;
  }, []);
  // the tooltip sits above its cell, clamped inside the card; scrolling moves it along
  const place = () => {
    const el = tip === null ? null : cell(tip);
    const t = tipRef.current;
    const w = wrap.current;
    if (!el || !t || !w) return;
    const r = el.getBoundingClientRect();
    const wr = w.getBoundingClientRect();
    t.style.left = `${Math.max(0, Math.min(r.left - wr.left + r.width / 2 - t.offsetWidth / 2, wr.width - t.offsetWidth))}px`;
    t.style.top = `${r.top - wr.top - t.offsetHeight - 6}px`;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(place, [tip]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = ({ ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1, PageUp: -28, PageDown: 28 } as Record<string, number>)[e.key];
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : step !== undefined ? day + step : null;
    if (to === null) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(n - 1, to));
    setCur(i);
    setTip(i);
    cell(i)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const at = (t: EventTarget) => {
    const i = Number((t as HTMLElement).dataset?.i);
    return Number.isInteger(i) ? i : null;
  };

  return (
    <div className="heat" ref={wrap}>
      <div className="heat__days" aria-hidden="true">
        {WEEKDAYS.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className="heat__scroll" ref={scroller} onScroll={place}>
        <div className="heat__months" style={{ '--cols': cal.cols } as CSSProperties} aria-hidden="true">
          {cal.months.map((m) => (
            <span key={m.col} style={{ gridColumn: `${m.col + 1} / span 3` }}>
              {fmtMonth(m.t, false)}
            </span>
          ))}
        </div>
        <div
          className="heat__grid"
          style={{ '--cols': cal.cols } as CSSProperties}
          role="slider"
          tabIndex={0}
          aria-label="แชตรายวัน ใช้ปุ่มลูกศรเลื่อนทีละวันหรือสัปดาห์"
          aria-valuemin={0}
          aria-valuemax={n - 1}
          aria-valuenow={day}
          aria-valuetext={text(day)}
          onKeyDown={onKey}
          onFocus={() => {
            focused.current = true;
            setTip(day);
          }}
          onBlur={() => {
            focused.current = false;
            setTip(null);
          }}
          onPointerMove={(e) => {
            const i = at(e.target);
            if (i !== null) setTip(i);
          }}
          onPointerDown={(e) => {
            const i = at(e.target);
            if (i !== null) setCur(i);
          }}
          onPointerLeave={() => setTip(focused.current ? day : null)}
        >
          {Array.from({ length: cal.off }, (_, k) => (
            <span key={`pad${k}`} className="heat__pad" />
          ))}
          {a.turns.map((v, i) => (
            <span key={i} data-i={i} data-l={level(v, cal.cuts)} data-cur={i === day || undefined} />
          ))}
        </div>
      </div>
      <div ref={tipRef} className="heat__tip" aria-hidden="true" hidden={tip === null}>
        {tip !== null && text(tip)}
      </div>
      <div className="heat__foot">
        <p className="how__note">
          รวม {fmtInt(cal.total)} ข้อความ · มีแชต {fmtInt(cal.active)} จาก {fmtInt(n)} วัน · มากสุด {fmtDate(dayT(a, cal.max))} ({fmtInt(a.turns[cal.max])})
        </p>
        <span className="heat__legend" aria-hidden="true">
          น้อย
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} data-l={l} />
          ))}
          มาก
        </span>
      </div>
      <details className="heat__table">
        <summary>ดูเป็นตาราง (รายเดือน)</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">เดือน</th>
              <th scope="col" className="num">
                ข้อความ
              </th>
              <th scope="col" className="num">
                วันที่มีแชต
              </th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.t}>
                <th scope="row">{fmtMonth(m.t, true)}</th>
                <td className="num">{fmtInt(m.turns)}</td>
                <td className="num">{fmtInt(m.days)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
});
