'use client';
import { memo, useEffect, useRef, useState } from 'react';
import { FAMILY_COLOR, NODE_TYPES, TYPE_NAME, type NodeType } from '../lib/brain';
import type { DataStatus } from '../lib/useBrainData';
import { fmtBytes, fmtInt } from '../lib/format';
import { useCountUp } from '../lib/hooks';
import { setTheme, useTheme } from '../lib/theme';

/**
 * Shape glyph: shape + color together encode the node family (color alone is never enough). Same shapes as the 3D
 * scene (brain/style.ts SHAPE): project icosahedron, session octahedron, subagent tetrahedron, note cube, memory
 * elongated octahedron.
 */
export const Glyph = memo(function Glyph({ type, size = 16 }: { type: NodeType; size?: number }) {
  const c = FAMILY_COLOR[type];
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {type === 'project' && (
        <>
          <polygon points="8,1 14.5,4.75 14.5,11.25 8,15 1.5,11.25 1.5,4.75" fill={c} fillOpacity="0.35" stroke={c} strokeWidth="1.3" />
          <polygon points="8,4.2 11.6,10.4 4.4,10.4" fill="none" stroke={c} strokeWidth="1" />
        </>
      )}
      {type === 'session' && <polygon points="8,1.5 14.5,8 8,14.5 1.5,8" fill={c} />}
      {type === 'subagent' && <polygon points="8,4 12.2,11.5 3.8,11.5" fill={c} />}
      {type === 'note' && <rect x="3" y="3" width="10" height="10" fill={c} />}
      {type === 'memory' && <polygon points="8,0.8 12.2,8 8,15.2 3.8,8" fill={c} />}
    </svg>
  );
});

/** ติดตาม + ตาราง: in the header on desktop, in the ข้อมูล sheet on phones (CSS shows one of the two copies). */
export function ViewTools(props: { follow: boolean; followPaused: boolean; onFollow: () => void; table: boolean; onTable: () => void }) {
  return (
    <>
      <button type="button" className="btn" aria-pressed={props.follow} data-paused={props.followPaused} aria-description={props.follow && props.followPaused ? 'พักการติดตามชั่วคราว' : undefined} onClick={props.onFollow} title="กล้องตามกิจกรรมล่าสุด ลากหรือซูมจะพักการติดตาม 20 วินาที">
        <span className="btn__dot" aria-hidden="true" />
        ติดตาม
      </button>
      <button type="button" className="btn" aria-pressed={props.table} onClick={props.onTable}>
        ตาราง
      </button>
    </>
  );
}

function ThemeToggle() {
  const theme = useTheme();
  return (
    <button type="button" className="btn btn--icon btn--theme" aria-label={theme === 'dark' ? 'เปลี่ยนเป็นธีมสว่าง' : 'เปลี่ยนเป็นธีมมืด'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
      {/* both icons always rendered; CSS shows the sun on dark, the moon on light (no hydration-time state) */}
      <svg className="i-sun" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <circle cx="9" cy="9" r="3.5" />
        <path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M3.7 14.3l1.4-1.4M12.9 5.1l1.4-1.4" />
      </svg>
      <svg className="i-moon" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <path d="M15 10.6A6.5 6.5 0 1 1 7.4 3a5.2 5.2 0 0 0 7.6 7.6z" />
      </svg>
    </button>
  );
}

/** memo: no prop follows the playhead (stable callbacks, memoized `tools`), so the intro's per-frame page renders skip it */
export const Header = memo(function Header(props: {
  mode: 'public' | 'local';
  status: DataStatus;
  /** replay speed while replaying, null when LIVE */
  replaySpeed: number | null;
  /** the replay is moving (paused or at its end: the pill says so, not "เล่น") */
  playing: boolean;
  /** the intro just reached LIVE: an accent ring expands from the status pill once */
  ring: boolean;
  tools: React.ReactNode;
  hud: boolean;
  onHud: () => void;
}) {
  const { status, replaySpeed } = props;
  const ready = status === 'live' || status === 'snapshot';
  const state = !ready ? status : replaySpeed !== null ? 'replay' : status;
  // snapshot = no feed: the public brain is an hourly static deploy, so that is its normal pace (friends read "offline" as broken)
  const snapshot = props.mode === 'public' ? 'อัปเดตรายชั่วโมง' : 'ออฟไลน์';
  // "เล่น" drops on 360 px phones so the header stays one row; one span = one flex item (no gap inside the word)
  const replay = props.playing ? (
    <span>
      <span className="pill__verb">เล่น</span>ย้อนหลัง {replaySpeed}×
    </span>
  ) : (
    'ย้อนหลัง · หยุด'
  );
  const text = { loading: 'กำลังโหลด', error: 'ไม่มีข้อมูล', snapshot, live: 'สด', replay }[state];
  return (
    <header className="hud-header">
      <div className="brand">
        <h1 className="brand__title">memory-hub</h1>
        <p className="brand__sub">สมองความจำระยะยาวที่ AI หลายตัวใช้ร่วมกัน{props.mode === 'public' && ' · สาธารณะ ปกปิดชื่อ'}</p>
      </div>
      <div className="hud-header__tools">
        <span className="pill" data-state={state} data-ring={props.ring || undefined} role="status">
          <span className="pill__dot" aria-hidden="true" />
          {text}
        </span>
        <span className="hud-header__wide">{props.tools}</span>
        <ThemeToggle />
        <button type="button" className="btn btn--hud" aria-pressed={props.hud} onClick={props.onHud} title="แสดงหรือซ่อนกิจกรรม บันทึกระบบ การติดตาม และตาราง">
          ข้อมูล
        </button>
      </div>
    </header>
  );
});

export type StatValues = Record<NodeType, number> & { chunks: number; recalls7d: number | null; dbMB: number | null; repos: number | null };

/** One legend cell: glyph + family name above the count. A LIVE increment flashes the value to the accent for 600 ms. */
function Cell({ type, value, instant }: { type: NodeType; value: number; instant: boolean }) {
  const v = useCountUp(value, instant);
  const prev = useRef(value);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (!instant && prev.current > 0 && value > prev.current) setFlash((f) => f + 1);
    prev.current = value;
  }, [value, instant]);
  return (
    <div className="stat">
      <dt className="stat__label">
        <Glyph type={type} size={12} />
        {TYPE_NAME[type]}
      </dt>
      {/* a new key restarts the flash animation */}
      <dd key={flash} className={flash ? 'stat__value stat__value--flash' : 'stat__value'}>
        {fmtInt(v)}
      </dd>
    </div>
  );
}

/** Stat strip, also the legend. `instant` = replay mode (values follow the playhead, no count-up). `children`: a last row. */
export const StatStrip = memo(function StatStrip({ stats, instant, children }: { stats: StatValues; instant: boolean; children?: React.ReactNode }) {
  const chunks = useCountUp(stats.chunks, instant);
  const recalls = useCountUp(stats.recalls7d ?? 0, instant);
  return (
    <section className="strip panel" aria-label="สถิติความจำและสัญลักษณ์">
      <dl className="strip__cells">
        {NODE_TYPES.map((t) => (
          <Cell key={t} type={t} value={stats[t]} instant={instant} />
        ))}
      </dl>
      <p className="strip__foot">
        {fmtInt(chunks)} ชิ้นความจำ
        {/* one span per item: a phone wraps between items, never inside one ("ฐาน | ข้อมูล"); the no-break space keeps
            each "·" at the end of a line, never starting the next */}
        {stats.recalls7d !== null && <>{'\u00a0· '}<span>เรียกใช้ 7 วัน {fmtInt(recalls)}</span></>}
        {stats.repos !== null && <>{'\u00a0· '}<span title="repo = โฟลเดอร์โค้ดของแต่ละงานบน GitHub">GitHub {fmtInt(stats.repos)} repo</span></>}
        {stats.dbMB !== null && <>{'\u00a0· '}<span title="ขนาดฐานข้อมูล PostgreSQL ทั้งหมดบนดิสก์ ดูแยกส่วนใน “ตัวเลขสมอง”">ฐานข้อมูล {fmtBytes(stats.dbMB * 1048576)}</span></>}
      </p>
      {children}
    </section>
  );
});
