'use client';
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react';
import { APP_NAME, TYPE_NAME, isApp, upperBound, type BrainEvent, type BrainNode, type EventKind, type LinkKind, type LogEntry, type LogKind } from '../lib/brain';
import { ago, fmtClock, fmtDate, fmtInt, nodeTitle } from '../lib/format';
import { shown } from '../lib/hooks';
import type { BrainStore } from '../lib/store';
import { Glyph } from './Hud';

const FEED_ROWS = 8;
const EVENT_NAME: Record<EventKind, string> = { turn: 'ข้อความ', search: 'ค้นหา', recall: 'เรียกใช้' };
const LINK_NAME: Record<LinkKind, string> = { in: 'สังกัด', spawn: 'เอเจนต์ย่อย', link: 'ลิงก์โน้ต', similar: 'คล้ายกัน', coaccess: 'ใช้ร่วมกัน', prov: 'ที่มา', next: 'ต่อเนื่อง' };

export type SideTab = 'feed' | 'log';

/**
 * Right column: one panel, segmented "กิจกรรม | บันทึกระบบ". On phones it is the ข้อมูล sheet and also holds `tools`.
 * memo: during replay only `head` changes per frame (the page passes a fixed one while the panel is hidden).
 */
export const SidePanel = memo(function SidePanel(props: {
  store: BrainStore;
  /** store version (useBrainData tick): the store mutates in place, so this is what re-renders the memo on new data */
  tick: number;
  head: number | null;
  now: number;
  tab: SideTab;
  onTab: (t: SideTab) => void;
  onPick: (id: string) => void;
  tools: React.ReactNode;
}) {
  const { tab, onTab } = props;
  return (
    <section className="side panel" aria-label="กิจกรรมและบันทึกระบบ">
      <div className="side__tools">{props.tools}</div>
      <div className="side__head">
        <div className="tabs" role="group" aria-label="เลือกรายการ">
          <button type="button" className="tab" aria-pressed={tab === 'feed'} onClick={() => onTab('feed')}>
            กิจกรรม
          </button>
          <button type="button" className="tab" aria-pressed={tab === 'log'} onClick={() => onTab('log')}>
            บันทึกระบบ
          </button>
        </div>
        <span className="side__hint">{tab === 'log' ? (props.store.log.length ? `ล่าสุด ${ago(props.now - props.store.log[0].t)}` : '7 วันล่าสุด') : props.head === null ? 'ล่าสุด' : 'ณ จุดเล่นซ้ำ'}</span>
      </div>
      {tab === 'feed' ? <FeedList store={props.store} head={props.head} now={props.now} onPick={props.onPick} /> : <SystemLog log={props.store.log} now={props.now} />}
    </section>
  );
});

/**
 * Last FEED_ROWS rows at/before the reference time (playhead in replay, now when LIVE). Consecutive events that would
 * read the same (title + kind; public titles are per hub, so that is often several nodes) collapse into one row with
 * their summed count; the row picks the newest node.
 */
function FeedList({ store, head, now, onPick }: { store: BrainStore; head: number | null; now: number; onPick: (id: string) => void }) {
  const ref = head ?? now;
  const hi = head === null ? store.events.length : upperBound(store.events, head, (e) => e[0]);
  const rows: { e: BrainEvent; node: BrainNode; title: string; n: number }[] = [];
  // ponytail: scans at most 400 events back; a longer run of one node and kind just shows fewer rows
  for (let i = hi - 1; i >= Math.max(0, hi - 400); i--) {
    const e = store.events[i];
    const node = store.nodes.get(e[1]);
    if (!node) continue;
    const title = nodeTitle(node, store.hubOf(node));
    const last = rows[rows.length - 1];
    if (last && last.title === title && last.e[2] === e[2]) last.n += e[3];
    else if (rows.length === FEED_ROWS) break;
    else rows.push({ e, node, title, n: e[3] });
  }
  return (
    <ol className="feed__list">
      {/* keyed by slot: the 8 buttons stay mounted while the playhead / LIVE data shift their content, so a focused row
          keeps the focus (keyed by event it unmounted to <body>) */}
      {rows.map(({ e, node, title, n }, i) => (
        <li key={i} style={{ '--i': i } as CSSProperties}>
          <button type="button" className="feed__row" onClick={() => onPick(node.id)}>
            <Glyph type={node.type} size={14} />
            <span className="feed__what">{title}</span>
            <span className="feed__time">{ago(ref - e[0])}</span>
            <span className="feed__meta">
              {EVENT_NAME[e[2]]} ×{fmtInt(n)}
            </span>
          </button>
        </li>
      ))}
      {rows.length === 0 && <li className="feed__empty">ยังไม่มีกิจกรรม</li>}
    </ol>
  );
}

const LOG_KIND: Record<LogKind, string> = { ingest: 'นำเข้า', recall: 'เรียกใช้ความจำ', dream: 'ฝัน (กลั่นความจำ)', publish: 'เผยแพร่เว็บสาธารณะ' };
// word joiners: a phone's narrow row breaks a compound mid-word (รอ|ตรวจ); the row breaks at ' · ' instead
const LOG_COUNT: Record<string, string> = {
  sessions: 'บทสนทนา', subagents: 'เอเจนต์ย่อย', turns: 'ข้อความ', chunks: 'ชิ้นความ\u2060จำ', notes: 'โน้ต', searches: 'ค้นหา', recalls: 'เปิด\u2060อ่าน',
  windows: 'ช่วง', batches: 'ชุด', cards: 'การ์ด', ADD: 'เพิ่ม', NOOP: 'ซ้ำ', UPDATE: 'ปรับ', SUPERSEDE: 'แทนที่', pending_review: 'รอ\u2060ตรวจ',
};

/**
 * System log, newest first: hourly ingest / recall counts, dream runs, publishes. Always relative to now, not the playhead.
 * memo: re-renders only when the log or the 5 s clock changes — not on every ~30 Hz replay frame.
 */
const SystemLog = memo(function SystemLog({ log, now }: { log: LogEntry[]; now: number }) {
  // polite only once the first rows are in: the initial load (dozens of rows at once) is not read out, later rows are
  const [armed, setArmed] = useState(log.length > 0);
  useEffect(() => {
    if (log.length) setArmed(true);
  }, [log.length]);
  return (
    // the log role sits on a wrapper (on the <ol> it orphaned the items); focusable, so every browser can scroll it by keyboard
    <div className="syslog__list" role="log" aria-label="บันทึกระบบ" tabIndex={0} aria-live={armed ? 'polite' : 'off'} aria-relevant="additions">
      <ol className="syslog__ol">
        {log.map((e) => {
          const counts = Object.entries(e.c).filter(([, n]) => n > 0).map(([k, n]) => `${LOG_COUNT[k] ?? k}\u00a0${fmtInt(n)}`).join(' · '); // nbsp: label + number stay together
          // ingest/recall rows are per hour and their t moves with the last activity: key by the hour
          return (
            <li key={`${e.k}|${e.k === 'ingest' || e.k === 'recall' ? Math.floor(e.t / 3600) : e.t}`} className="syslog__row">
              <span className="syslog__kind">{LOG_KIND[e.k]}</span>
              <time className="syslog__time" dateTime={new Date(e.t * 1000).toISOString()} title={fmtClock(e.t)}>
                {ago(now - e.t)}
              </time>
              {counts && <span className="syslog__what">{counts}</span>}
              {e.p?.length ? <span className="syslog__where">{e.p.join(', ')}</span> : null}
            </li>
          );
        })}
        {log.length === 0 && <li className="feed__empty">ยังไม่มีบันทึก</li>}
      </ol>
    </div>
  );
});

function Facts({ node, hub }: { node: BrainNode; hub?: BrainNode }) {
  return (
    <dl className="facts">
      <dt>อยู่ใน</dt>
      <dd>{hub?.label ?? '—'}</dd>
      {isApp(node.a) && (
        <>
          <dt>มาจาก</dt>
          <dd>{APP_NAME[node.a]}</dd>
        </>
      )}
      <dt>ชิ้นความจำ</dt>
      <dd>{fmtInt(node.n)}</dd>
      <dt>เริ่ม</dt>
      <dd>{fmtDate(node.t0)}</dd>
      <dt>ล่าสุด</dt>
      <dd>{fmtDate(node.t1)}</dd>
      <dt>เรียกใช้</dt>
      <dd>{node.u < 0 ? 'ถูกแทนที่แล้ว' : fmtInt(node.u)}</dd>
    </dl>
  );
}

function Heading({ node, hub }: { node: BrainNode; hub?: BrainNode }) {
  return (
    <div className="card__head">
      <Glyph type={node.type} />
      <span className="card__type">{TYPE_NAME[node.type]}</span>
      <span className="card__title">{nodeTitle(node, hub)}</span>
    </div>
  );
}

/** Hover card. Position is written by the parent into --x/--y on `tipRef` (no per-move React render); memo: not per replay frame. */
export const HoverCard = memo(function HoverCard({ node, hub, tipRef }: { node: BrainNode | null; hub?: BrainNode; tipRef: Ref<HTMLDivElement> }) {
  return (
    <div ref={tipRef} className="tooltip panel" role="tooltip" hidden={!node}>
      {node && (
        <>
          <Heading node={node} hub={hub} />
          <Facts node={node} hub={hub} />
        </>
      )}
    </div>
  );
});

/**
 * A panel that opens takes the keyboard focus (its first button); when it closes with focus lost to <body> (its own
 * button, or a feed row in a sheet that closed, was removed), focus returns to the opener if visible, else to ข้อมูล
 * (phones) or สด. Passive cleanup on purpose: it runs after the commit, when data-table / data-hud already apply.
 * A new `content` while open (another node) takes focus only if it was lost: a phone's sheet closed under the feed row.
 */
export function usePanelFocus<T extends HTMLElement>(content?: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.querySelector('button')?.focus();
    return () => {
      if (document.activeElement && document.activeElement !== document.body) return;
      [opener, document.querySelector('.btn--hud'), document.querySelector('.btn--live')].find(shown)?.focus();
    };
  }, []);
  useEffect(() => {
    if (!shown(document.activeElement)) ref.current?.querySelector('button')?.focus();
  }, [content]);
  return ref;
}

export function DetailsPanel(props: { node: BrainNode; store: BrainStore; onClose: () => void; onFocus: () => void }) {
  const { node, store } = props;
  const ref = usePanelFocus<HTMLElement>(node.id);
  const hub = store.hubOf(node);
  const degree = useMemo(() => {
    const by: Record<string, number> = {};
    for (const l of store.links) if (l.source === node.id || l.target === node.id) by[l.k] = (by[l.k] ?? 0) + 1;
    return by;
  }, [node.id, store.rev, store]);
  const kinds = Object.entries(degree);
  return (
    <section ref={ref} className="details panel" aria-label="รายละเอียดโหนด">
      <Heading node={node} hub={hub} />
      <Facts node={node} hub={hub} />
      <p className="details__links">{kinds.length ? `ลิงก์ · ${kinds.map(([k, n]) => `${LINK_NAME[k as LinkKind]} ${n}`).join(' · ')}` : 'ไม่มีลิงก์'}</p>
      <div className="details__actions">
        <button type="button" className="btn" onClick={props.onFocus}>
          บินไปดู
        </button>
        <button type="button" className="btn" onClick={props.onClose}>
          ปิด
        </button>
      </div>
    </section>
  );
}

type SortKey = 'label' | 'sessions' | 'subagents' | 'notes' | 'chunks' | 't1';
const COLS: { key: SortKey; label: string; num: boolean }[] = [
  { key: 'label', label: 'ชื่อ', num: false },
  { key: 'sessions', label: 'บทสนทนา', num: true },
  { key: 'subagents', label: 'เอเจนต์ย่อย', num: true },
  { key: 'notes', label: 'โน้ต', num: true },
  { key: 'chunks', label: 'ชิ้นความ\u2060จำ', num: true }, // word joiner: a phone's two-line header breaks ชิ้น|ความจำ, never ความ|จำ
  { key: 't1', label: 'ใช้งานล่าสุด', num: false },
];

/** Accessible alternative to the 3D view: a plain table of hubs (projects / vaults). */
export function HubTable({ store, rev, onPick, onClose }: { store: BrainStore; rev: number; onPick: (id: string) => void; onClose: () => void }) {
  const ref = usePanelFocus<HTMLElement>();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'chunks', dir: -1 });
  const rows = useMemo(() => {
    const by = new Map<string, { hub: BrainNode; sessions: number; subagents: number; notes: number }>();
    for (const n of store.nodes.values()) if (n.type === 'project') by.set(n.id, { hub: n, sessions: 0, subagents: 0, notes: 0 });
    for (const n of store.nodes.values()) {
      const r = n.p ? by.get(n.p) : undefined;
      if (!r) continue;
      if (n.type === 'session') r.sessions++;
      else if (n.type === 'subagent') r.subagents++;
      else r.notes++; // notes + memories live in vault hubs
    }
    return [...by.values()].map((r) => ({ id: r.hub.id, label: r.hub.label ?? r.hub.id, sessions: r.sessions, subagents: r.subagents, notes: r.notes, chunks: r.hub.n, t1: r.hub.t1 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, rev]);
  const sorted = [...rows].sort((a, b) => {
    const x = a[sort.key];
    const y = b[sort.key];
    return (typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y, 'th', { numeric: true }) : (x as number) - (y as number)) * sort.dir;
  });
  return (
    <section ref={ref} className="table-panel panel" aria-label="ตารางโปรเจ็กต์และคลังโน้ต">
      <div className="panel__head">
        <span>โปรเจ็กต์และคลังโน้ต · {rows.length}</span>
        <button type="button" className="btn" onClick={onClose}>
          ปิด
        </button>
      </div>
      <div className="table-panel__scroll">
        <table className="hubs">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} scope="col" className={c.num ? 'num' : undefined} aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (-s.dir as 1 | -1) : c.num || c.key === 't1' ? -1 : 1 }))}>
                    {c.label}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                <th scope="row">
                  <button type="button" onClick={() => onPick(r.id)}>
                    {r.label}
                  </button>
                </th>
                <td className="num">{fmtInt(r.sessions)}</td>
                <td className="num">{fmtInt(r.subagents)}</td>
                <td className="num">{fmtInt(r.notes)}</td>
                <td className="num">{fmtInt(r.chunks)}</td>
                <td>{fmtDate(r.t1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
