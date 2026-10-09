// PURE (runs under `node --test`): the test-ask log. One traced search (src/brain-live.ts) told as the steps memory_search
// really takes, each with what it saw (the server's explain, never invented here) and a slow route over the brain's regions
// to play while it is read. Only erasable TS syntax.
import type { Explain, HitType, Ranks, Trace, TraceRow } from '../../lib/live.ts';
import { HIT_REGION, edgeOf, type RegionId } from './regions.ts';
import type { Bloom, Leg, Plan, RouteKind } from './routes.ts';

export type StepId = 'ask' | 'terms' | 'keyword' | 'vector' | 'fuse' | 'decide' | 'links' | 'answer';
export type Tone = 'ok' | 'warn' | 'dim';
/** a labelled value on a step (a term with its count, a measured signal) */
export interface Fact {
  label: string;
  value: string;
  tone?: Tone;
}
/** a memory a step found: its rank there, type, text, and a short note (where else it ranked, a cosine) */
export interface Item {
  rank: string;
  type: HitType;
  label: string;
  note?: string;
}
type Pair = readonly [RegionId, RegionId];
export interface Step {
  id: StepId;
  /** where the step happens: its dot and the region that charges while it is read */
  region: RegionId;
  kind: RouteKind;
  title: string;
  /** measured time of the step (SQL / embedder), null = not timed on its own */
  ms: number | null;
  text: string;
  tone?: Tone;
  facts: Fact[];
  items: Item[];
  /** the route: phases one after another, the legs of a phase together */
  route: readonly (readonly Pair[])[];
  /** regions holding what the step found: they light when the route arrives */
  found: RegionId[];
  /** seconds the step stays before the next one, at 1× */
  dwell: number;
}

/** AI_HITS = memory_search's default answer size (the server marks those rows `ai`) */
export const AI_HITS = 6;
const LEG_S = 1.1; // one pathway, at 1×: slow enough to follow the pulse
const REVEAL_S = 0.7; // between two answers appearing, at 1×
const LIST = 10;

export const LINK_KIND: Record<string, string> = {
  link: 'ลิงก์ในโน้ต',
  prov: 'ที่มา (ข้อเท็จจริง ↔ แชตต้นทาง)',
  spawn: 'เอเจนต์ย่อย',
  next: 'แชตถัดไป',
  entity: 'พูดถึงสิ่งเดียวกัน',
  cites: 'อ้างถึงกัน',
  coaccess: 'ถูกเรียกใช้คู่กัน',
};
/** 'prov→next' (two hops) reads as both names */
export const linkName = (k: string) => k.split('→').map((x) => LINK_KIND[x] ?? x).join(' → ');

const n0 = (x: number) => x.toLocaleString('th-TH');
const c2 = (x: number | null) => (x === null ? '–' : x.toFixed(2));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const DAY = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'Asia/Bangkok' });

/** where a candidate came from: its rank in each leg that found it */
export function origins(r: Ranks): string[] {
  const out: string[] = [];
  if (r.kw !== null) out.push(`คำ #${r.kw}`);
  if (r.bi !== null) out.push(`วลี #${r.bi}`);
  if (r.vec !== null) out.push(`ความหมาย #${r.vec}${r.cos === null ? '' : ` · ${c2(r.cos)}`}`);
  return out;
}
/** RRF (k = 60, search.ts) from the leg ranks: the score before any weight */
export const rrf = (r: Ranks) => [r.kw, r.bi, r.vec].reduce<number>((a, x) => a + (x === null ? 0 : 1 / (60 + x)), 0);

export interface RowGroup {
  key: string;
  title: string;
  note: string;
  rows: TraceRow[];
}
/** every scored candidate, grouped by what became of it, in the order the search decided */
export function rowGroups(rows: readonly TraceRow[]): RowGroup[] {
  const g = (key: string, title: string, note: string, test: (w: string) => boolean): RowGroup => ({ key, title, note, rows: rows.filter((r) => test(r.why)) });
  return [
    g('ai', 'AI ได้รับ', 'คำตอบค่าเริ่มต้นของ memory_search (6 ชิ้น) เมื่อถามแบบไม่ผูกโปรเจกต์ ไม่รวมข้อมูลส่วนตัว', (w) => w === 'ai'),
    g('fold', 'รวมไว้ใต้ข้อเท็จจริง', 'เป็นแชตต้นทางของข้อเท็จจริงที่ได้ที่นั่งแล้ว: ติดไปด้วยโดยไม่เสียที่นั่ง', (w) => w.startsWith('fold:')),
    g('cap', 'ตกรอบ: แชตเดียวกันครบ 3', 'จำกัด 3 ชิ้นต่อแชต เพื่อให้คำตอบหลากหลาย', (w) => w === 'cap'),
    g('full', 'ตกรอบ: เกินที่นั่ง', 'ที่นั่ง 6 ที่เต็มก่อนถึงอันดับนี้', (w) => w === 'full'),
    g('out', 'นอกรอบ: memory_search ไม่ได้ดู', 'เกินจำนวนอันดับที่ memory_search พิจารณา (แสดงไว้ให้ดูเพิ่ม)', (w) => w === 'out'),
  ].filter((x) => x.rows.length);
}

function item(rank: string, h: { type: HitType; label: string }, note?: string): Item {
  return { rank, type: h.type, label: h.type === 'private' ? '(ข้อมูลส่วนตัว)' : h.label, ...(note && { note }) };
}

/** The test-ask steps of one trace. Without the server's explain (an older brain-serve) there is nothing to tell: []. */
export function askSteps(t: Trace): Step[] {
  const x: Explain | undefined = t.explain;
  if (!x) return [];
  const s = t.stages;
  const sig = x.signal;
  const used = x.terms.filter((w) => w.used);
  const ai = x.rows.filter((r) => r.why === 'ai');
  const both = x.rows.filter((r) => (r.kw !== null || r.bi !== null) && r.vec !== null).length;
  const wordsOnly = x.rows.filter((r) => (r.kw !== null || r.bi !== null) && r.vec === null).length;
  const meaningOnly = x.rows.filter((r) => r.kw === null && r.bi === null && r.vec !== null).length;
  const linkRegions = regionsOf(x.linked.map((l) => l.type));
  const time = x.time
    ? x.time.recent && !x.time.from ? 'ล่าสุด (ของใหม่ได้คะแนนเพิ่ม)' : `${x.time.from ? DAY.format(new Date(x.time.from)) : '…'} – ${x.time.to ? DAY.format(new Date(Date.parse(x.time.to) - 1)) : '…'} (ได้คะแนนเพิ่ม ไม่ตัดทิ้ง)`
    : null;
  const steps: Step[] = [
    {
      id: 'ask', region: 'thalamus', kind: 'search', title: 'รับคำถาม', ms: t.ms, text: `“${t.q}”`,
      facts: [{ label: 'ค้นทั้งหมด', value: `${t.ms} ms` }, { label: 'ความจำ', value: `ประมาณ ${n0(x.corpus)} ชิ้น` }],
      items: [], route: [], found: [], dwell: 1.6,
    },
    {
      id: 'terms', region: 'thalamus', kind: 'search', title: 'แยกคำ', ms: null,
      text: x.terms.length ? `${x.terms.length} คำ · ใช้เลือกผู้สมัคร ${used.length} คำ (คำที่พบบ่อยเกินไปไม่ใช้เลือก แต่ยังช่วยให้คะแนน)` : 'ไม่มีคำให้ค้นตามคำ: ใช้ความหมายอย่างเดียว',
      facts: [
        ...x.terms.filter((w) => !x.unseen.includes(w.key)).map((w): Fact => ({ label: w.key, value: `พบ ${n0(w.df)} ชิ้น${w.used ? '' : ' · ให้คะแนนอย่างเดียว'}`, tone: w.used ? 'ok' : 'dim' })),
        ...x.unseen.map((w): Fact => ({ label: w, value: 'ไม่เคยเห็นในความจำ', tone: 'warn' })),
        ...(time ? [{ label: 'ช่วงเวลา', value: time }] : []),
      ],
      items: [], route: [], found: [], dwell: 2.4,
    },
    {
      id: 'keyword', region: 'temporal', kind: 'search', title: 'ค้นตามคำ', ms: s.keyword ?? null,
      text: `ตรงคำ ${capped(x.kw.n)} · ตรงวลีติดกัน ${capped(x.bi.n)}`,
      facts: [],
      items: [...x.kw.top.slice(0, LIST).map((h) => item(`#${h.r}`, h, 'คำ')), ...x.bi.top.slice(0, 5).map((h) => item(`#${h.r}`, h, 'วลี'))],
      route: [[['thalamus', 'temporal']]], found: [], dwell: 2.8,
    },
    t.semantic
      ? {
          id: 'vector', region: 'hippocampus', kind: 'search', title: 'ค้นตามความหมาย', ms: s.vector ?? null,
          text: `แปลงคำถามเป็นเวกเตอร์ (ทำคู่ไปกับค้นตามคำ) แล้วหาชิ้นที่ความหมายใกล้ที่สุด ${capped(x.vec.n)}`,
          facts: sig ? [{ label: 'ใกล้สุด', value: c2(sig.cos1) }, { label: 'อันดับ 10', value: c2(sig.cos10) }, { label: 'เฉลี่ย 60 อันดับ', value: c2(sig.cosMean) }] : [],
          items: x.vec.top.slice(0, LIST).map((h) => item(`#${h.r}`, h, h.cos === null ? undefined : `ใกล้ ${c2(h.cos)}`)),
          route: [[['thalamus', 'hippocampus']]], found: [], dwell: 2.8,
        }
      : {
          id: 'vector', region: 'hippocampus', kind: 'search', title: 'ค้นตามความหมาย', ms: null, tone: 'warn',
          text: 'ข้าม: ตัวแปลงความหมายไม่พร้อมหรือตอบไม่ทัน จึงค้นตามคำอย่างเดียว (ไม่ให้ AI รอ)',
          facts: [], items: [], route: [], found: [], dwell: 2,
        },
    {
      id: 'fuse', region: 'amygdala', kind: 'search', title: 'รวมอันดับ + ให้น้ำหนัก', ms: null,
      text: `รวม 3 ทางแบบ RRF แล้วคูณน้ำหนัก: ความสำคัญ ใช้บ่อย ความใหม่ ชนิด (กฎ/ข้อเท็จจริงได้เปรียบแชต) · memory_search ตัดสินจาก ${n0(x.fused)} อันดับแรก`,
      facts: [
        { label: 'เจอทั้งคำและความหมาย', value: `${both} ชิ้น`, tone: 'ok' },
        { label: 'คำอย่างเดียว', value: `${wordsOnly} ชิ้น` },
        { label: 'ความหมายอย่างเดียว', value: `${meaningOnly} ชิ้น` },
      ],
      items: [], route: [[['temporal', 'amygdala'], ['hippocampus', 'amygdala']], [['amygdala', 'prefrontal']]], found: [], dwell: 2.8,
    },
    {
      id: 'decide', region: 'prefrontal', kind: 'search', title: 'ตัดสิน: รู้หรือไม่รู้', ms: null, tone: !t.semantic ? 'dim' : t.unfamiliar ? 'warn' : 'ok',
      // keyword-only: the rule has no vector evidence, so memory_search says neither (search.ts unfamiliar())
      text: !t.semantic ? 'ตัดสินไม่ได้ — ไม่มีผลค้นตามความหมายให้เทียบ (memory_search ก็ไม่บอกทั้ง "รู้" และ "ไม่รู้")'
        : t.unfamiliar ? 'ไม่รู้ — ความจำไม่มีเรื่องนี้ ที่เจอเป็นแค่ใกล้เคียง (เกณฑ์เดียวกับ memory_search)' : 'รู้ — มีความจำที่ตรงเรื่อง (เกณฑ์เดียวกับ memory_search)',
      facts: sig
        ? [{ label: 'ความหมายใกล้สุด', value: c2(sig.cos1) }, { label: 'คำตรงสูงสุด', value: pct(sig.kw) }, { label: 'คำที่ไม่เคยเห็น', value: pct(sig.unseen), tone: sig.unseen > 0 ? 'warn' : undefined }]
        : [],
      items: [], route: [], found: [], dwell: 2.4,
    },
    {
      id: 'links', region: 'parietal', kind: 'related', title: 'ดึงต่อผ่านเส้นประสาท', ms: s.synapse ?? null,
      text: x.linked.length
        ? `จาก 3 อันดับแรก เส้นเชื่อมพาไปถึงอีก ${x.linked.length} ชิ้นที่การค้นไม่ได้ให้คะแนน`
        : 'ไม่มีเส้นเชื่อมที่แรงพอจาก 3 อันดับแรก',
      facts: [{ label: 'AI', value: 'ค่าเริ่มต้น 6 ชิ้นไม่ได้รับส่วนนี้ · ถ้าขอ 7–8 ชิ้น เพื่อนบ้านตามเส้นเชื่อมได้แข่งชิงที่ 7–8', tone: 'dim' }],
      items: x.linked.map((l) => item(`จาก #${l.via}`, l, `${linkName(l.kind)} · แรง ${c2(l.act)}`)),
      route: [[['prefrontal', 'parietal']], ...(linkRegions.length ? [linkRegions.filter((r) => edgeOf('parietal', r)).map((r): Pair => ['parietal', r])] : [])],
      found: linkRegions, dwell: 3,
    },
    {
      id: 'answer', region: 'thalamus', kind: 'search', title: t.unfamiliar ? 'ส่งคำตอบ: ใกล้เคียงที่สุด (ไม่ตรง)' : 'ส่งคำตอบให้ AI', ms: null, tone: t.unfamiliar || !ai.length ? 'warn' : t.semantic ? 'ok' : undefined,
      text: `AI ได้ ${ai.length} รายการ (ถามแบบไม่ผูกโปรเจกต์: AI ที่ถามจากในโปรเจกต์ได้โบนัส ×1.3 ให้ของโปรเจกต์ตัวเอง ลำดับจึงอาจต่าง) · ผู้เข้ารอบ ${x.rows.length} ชิ้นอยู่ในตารางด้านล่าง`,
      facts: [],
      items: ai.map((r, i) => item(`${i + 1}`, r, [...origins(r), r.ev ? `+แชตต้นทาง ${r.ev}` : ''].filter(Boolean).join(' · '))),
      route: [[[x.linked.length ? 'parietal' : 'prefrontal', 'thalamus']]], found: [], dwell: 1.4 + REVEAL_S * ai.length,
    },
  ];
  return steps.map((st) => ({ ...st, route: st.route.map((ph) => ph.filter(([a, b]) => edgeOf(a, b))).filter((ph) => ph.length) }));
}

const capped = (n: number) => (n >= 60 ? `${n} ชิ้น (เพดาน 60)` : `${n} ชิ้น`);
function regionsOf(types: readonly HitType[]): RegionId[] {
  return [...new Set(types.map((t) => HIT_REGION[t]).filter((r): r is RegionId => r !== null))];
}

/** The pulses of one step at `speed` (1 = normal): its phases one after another, a bloom where each leg arrives, the step's
 *  own region charging when it has no route, and the regions of what it found at the end. */
export function stepPlan(st: Step, speed = 1): Plan {
  const leg = LEG_S / speed;
  const legs: Leg[] = [];
  const blooms: Bloom[] = [];
  let t = 0;
  if (!st.route.length) blooms.push({ region: st.region, at: 0, amp: 0.7 });
  for (const ph of st.route) {
    for (const [from, to] of ph) {
      legs.push({ from, to, t0: t, dur: leg });
      blooms.push({ region: to, at: t + leg, amp: 0.8 });
    }
    t += leg;
  }
  for (const region of st.found) blooms.push({ region, at: t + 0.05, amp: 1.2 });
  return { kind: st.kind, legs, blooms, total: t + (st.found.length ? 0.45 : 0) };
}

/** one answer appearing: its region lights (a private one lights nothing) */
export function revealPlan(type: HitType): Plan {
  const region = HIT_REGION[type];
  return { kind: 'search', legs: [], blooms: region ? [{ region, at: 0, amp: 1.3 }] : [], total: 0 };
}

/** seconds a step stays at `speed`; never shorter than its own route */
export const dwellOf = (st: Step, speed = 1) => Math.max(st.dwell / speed, (st.route.length * LEG_S) / speed + 0.4);
/** seconds between two answers appearing at `speed` */
export const revealGap = (speed = 1) => REVEAL_S / speed;
