// PURE (runs under `node --test`): turns one request into a timed route over the brain's regions. A route is legs (a
// pulse travelling a pathway) and blooms (a region lighting up); times are seconds from the start of the run. Only
// erasable TS syntax.
import type { BrainNode } from '../../lib/brain.ts';
import type { HitType, Stages, Trace } from '../../lib/live.ts';
import { HIT_REGION, type RegionId } from './regions.ts';

export type RouteKind = 'search' | 'get' | 'related' | 'turn';
export interface Leg {
  from: RegionId;
  to: RegionId;
  t0: number;
  dur: number;
}
export interface Bloom {
  region: RegionId;
  at: number;
  /** 0.6 (a stage charging) … 1.4 (a memory found there) */
  amp: number;
}
export interface Plan {
  kind: RouteKind;
  legs: Leg[];
  blooms: Bloom[];
  /** seconds until the last bloom starts (the view lets it fade after this) */
  total: number;
}

/** Real ms × SCALE seconds, kept within [MIN_S, MAX_S]: a 150 ms search must still be readable, a 3 s one must not drag. */
const SCALE = 4;
const MIN_S = 1.6;
const MAX_S = 4.5;
const MIN_LEG_S = 0.38; // the cheap ranking legs of a real search are a few ms: this keeps them to see
const TAIL_S = 0.45; // the found memories light up this long after the pulse is back
const DEFAULT_MS = 400;

type Pair = readonly [RegionId, RegionId];
interface Phase {
  /** relative length */
  w: number;
  legs: readonly Pair[];
  /** a region working (not travelling) during the phase */
  charge?: RegionId;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Hit types → regions with a count each (private sources are not counted: they light nothing). */
export function regionCounts(types: readonly HitType[]): Map<RegionId, number> {
  const by = new Map<RegionId, number>();
  for (const t of types) {
    const r = HIT_REGION[t];
    if (r) by.set(r, (by.get(r) ?? 0) + 1);
  }
  return by;
}

function build(kind: RouteKind, phases: readonly Phase[], ms: number, found: Map<RegionId, number> | null): Plan {
  const sum = phases.reduce((a, p) => a + p.w, 0);
  const span = clamp((ms * SCALE) / 1000, MIN_S, MAX_S);
  const legs: Leg[] = [];
  const blooms: Bloom[] = [];
  let t = 0;
  for (const p of phases) {
    const dur = Math.max(MIN_LEG_S, (p.w / sum) * span);
    if (p.charge) blooms.push({ region: p.charge, at: t, amp: 0.6 });
    for (const [from, to] of p.legs) {
      legs.push({ from, to, t0: t, dur });
      blooms.push({ region: to, at: t + dur, amp: 0.8 });
    }
    t += dur;
  }
  for (const [region, n] of found ?? []) blooms.push({ region, at: t + 0.05, amp: Math.min(1.4, 0.8 + 0.15 * n) });
  return { kind, legs, blooms, total: t + (found?.size ? TAIL_S : 0) };
}

/** the ranking legs a search ends with: both finds converge on amygdala, then prefrontal, parietal, back to thalamus */
const RANK: readonly (readonly Pair[])[] = [[['temporal', 'amygdala'], ['hippocampus', 'amygdala']], [['amygdala', 'prefrontal']], [['prefrontal', 'parietal']], [['parietal', 'thalamus']]];

/**
 * search: thalamus → temporal (keyword) ∥ hippocampus (vector) → amygdala → prefrontal → parietal → thalamus, then the
 * regions the hits live in. With real `stages` (a traced search): embed ∥ keyword, then vector, then the ranking legs,
 * each as long as its real ms (a floor keeps the cheap ones visible).
 */
export function planSearch(types: readonly HitType[], ms: number | null, stages?: Stages): Plan {
  const found = regionCounts(types);
  if (!stages) {
    const front: Phase = { w: 1.4, legs: [['thalamus', 'temporal'], ['thalamus', 'hippocampus']] };
    return build('search', [front, ...RANK.map((legs, i) => ({ w: i ? 0.7 : 1, legs }))], ms ?? DEFAULT_MS, found);
  }
  const s = stages;
  const sum = (s.embed ?? 0) + (s.keyword ?? 0) + (s.vector ?? 0) + (s.synapse ?? 0) + (s.other ?? 0) || DEFAULT_MS;
  const floor = 0.2 * sum;
  const back = Math.max(floor, ((s.synapse ?? 0) + (s.other ?? 0)) / RANK.length);
  const phases: Phase[] = [
    { w: Math.max(floor, s.embed ?? 0, s.keyword ?? 0), legs: [['thalamus', 'temporal']], charge: 'thalamus' },
    { w: Math.max(floor, s.vector ?? 0), legs: [['thalamus', 'hippocampus']] },
    ...RANK.map((legs) => ({ w: back, legs })),
  ];
  return build('search', phases, phases.reduce((t, p) => t + p.w, 0), found);
}

/**
 * The route of one traced search (the search box). When the memory is unfamiliar with the query ("ไม่รู้": the server's
 * rule, same as memory_search) nothing was found: the signal only reaches thalamus → hippocampus (the recall attempt) and
 * fades, no ranking legs and no cortex lights; otherwise the normal planSearch.
 */
export function planTrace(t: Pick<Trace, 'hits' | 'ms' | 'stages' | 'unfamiliar'>): Plan {
  if (!t.unfamiliar) return planSearch(t.hits.map((h) => h.type), t.ms, t.stages);
  return build('search', [{ w: 1, legs: [['thalamus', 'hippocampus']], charge: 'thalamus' }], t.ms, null);
}

export const UNFAMILIAR_STATUS = 'ไม่รู้ — ความจำไม่มีเรื่องนี้';
export const NEAREST_TITLE = 'ใกล้เคียงที่สุด (ไม่ตรง)';
/** What the search box says on top of the results: only an unfamiliar search has a status, and a title for the near misses. */
export const traceNote = (t: Pick<Trace, 'hits' | 'unfamiliar'>): { status: string | null; title: string | null } =>
  t.unfamiliar ? { status: UNFAMILIAR_STATUS, title: t.hits.length ? NEAREST_TITLE : null } : { status: null, title: null };

/** get / recall: thalamus → the region of the item's type → prefrontal → thalamus (a private item: straight to prefrontal). */
export function planGet(types: readonly HitType[], ms: number | null): Plan {
  const where = [...regionCounts(types).keys()].slice(0, 3);
  const phases: Phase[] = where.length
    ? [{ w: 1, legs: where.map((r) => ['thalamus', r] as const) }, { w: 1, legs: where.map((r) => [r, 'prefrontal'] as const) }, { w: 1, legs: [['prefrontal', 'thalamus']] }]
    : [{ w: 1.4, legs: [['thalamus', 'prefrontal']] }, { w: 1, legs: [['prefrontal', 'thalamus']] }];
  return build('get', phases, ms ?? DEFAULT_MS, null);
}

/** related: thalamus → parietal (synapses) → hippocampus ∥ temporal → thalamus. */
export function planRelated(types: readonly HitType[], ms: number | null): Plan {
  const phases: Phase[] = [
    { w: 1, legs: [['thalamus', 'parietal']] },
    { w: 1.2, legs: [['parietal', 'hippocampus'], ['parietal', 'temporal']] },
    { w: 1.2, legs: [['hippocampus', 'thalamus'], ['temporal', 'thalamus']] },
  ];
  return build('related', phases, ms ?? DEFAULT_MS, regionCounts(types));
}

/** A new chat turn indexed: brainstem (the background system) → hippocampus. */
export const planTurn = (): Plan => build('turn', [{ w: 1, legs: [['brainstem', 'hippocampus']] }], 0, null);

/** The route for one logged MCP call. */
export function planCall(kind: string, ms: number | null, types: readonly HitType[]): Plan {
  return kind === 'search' ? planSearch(types, ms) : kind === 'related' ? planRelated(types, ms) : planGet(types, ms);
}

/** What a public node stands for: no private text there, only its type. */
export function hitOfNode(n: BrainNode | undefined): HitType | null {
  return n?.type === 'session' || n?.type === 'subagent' ? 'chat' : n?.type === 'note' ? 'note' : n?.type === 'memory' ? 'fact' : null;
}
