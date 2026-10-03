// PURE (runs under `node --test`): starting quality tier + the downgrade-only frame-time governor.
import { TIER_ORDER, type Tier } from './style.ts';

export interface TierEnv {
  /** `?q=` value */
  q: string | null;
  /** localStorage.brainTier */
  stored: string | null;
  saveData?: boolean;
  coarse: boolean;
  cores?: number;
  memory?: number;
  /** EXT_color_buffer_half_float || EXT_color_buffer_float: without it the HDR composer can't exist */
  halfFloat: boolean;
}
const isTier = (s: string | null): s is Tier => s !== null && (TIER_ORDER as readonly string[]).includes(s);

/**
 * `?q=` wins (`auto` ignores the stored tier), then the persisted tier, then a device guess. Undefined hints are ignored.
 * Deviation from spec §5: on a coarse pointer, cores count only next to deviceMemory. Safari reports 4 for any device
 * with < 8 cores (WebKit NavigatorBase.cpp) and has no deviceMemory, so the spec rule put every iPhone on LOW.
 */
export function initialTier(e: TierEnv): Tier {
  const small = (v: number | undefined, max: number) => v !== undefined && v <= max;
  let t: Tier;
  if (isTier(e.q)) t = e.q;
  else if (e.q !== 'auto' && isTier(e.stored)) t = e.stored;
  else if (e.saveData) t = 'low';
  else if (e.coarse && (small(e.memory, 3) || (e.memory !== undefined && small(e.cores, 4)))) t = 'low';
  else if (e.coarse) t = 'medium';
  else if (small(e.cores, 4)) t = 'medium';
  else t = 'high';
  return e.halfFloat ? t : 'low';
}

export type GovAction = { kind: 'dpr'; dpr: number } | { kind: 'tier'; tier: Tier } | { kind: 'probe' };

const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

/**
 * PerformanceMonitor-style: median rAF delta per 2 s window; two slow windows in a row (> 1.25× target) first shave
 * DPR by 0.85 down to the tier floor, then drop one tier. Never promotes. Locks after 3 tier drops or at LOW's floor.
 * A slow rAF can be the browser/display cap, not us (Chrome Energy Saver 30 Hz, iOS Low Power Mode, 48 Hz panels), and
 * the interval alone can't tell them apart. So before acting it asks for a 'probe': the engine pauses rendering for a few
 * rAFs, reports the bare cadence via probed(), and frames are only slow against max(target, that cap).
 * ponytail: drops reset on remount; the persisted tier + never-promote already bound it to ultra → low.
 */
export class Governor {
  locked = false;
  drops = 0;
  private win: number[] = [];
  private winStart = -1;
  private slow = 0;
  /** idle rAF interval from the last probe: the fastest the browser lets us go */
  private capMs = 0;
  /** slow window median waiting for a probe result */
  private pending: number | null = null;
  tier: Tier;
  dpr: number;
  private readonly targetMs: number;
  private readonly floor: number;
  private readonly startMs: number;

  constructor(tier: Tier, dpr: number, targetMs: number, floor: number, startMs: number) {
    this.tier = tier;
    this.dpr = dpr;
    this.targetMs = targetMs;
    this.floor = floor;
    this.startMs = startMs;
  }

  /** `skip`: frame belongs to a fly-to (expensive by design, not a device signal). */
  sample(dtMs: number, nowMs: number, skip: boolean): GovAction | null {
    if (this.locked || this.pending !== null || skip || dtMs > 250 || nowMs - this.startMs < 3000) return null;
    if (this.winStart < 0) this.winStart = nowMs;
    this.win.push(dtMs);
    if (nowMs - this.winStart < 2000) return null;
    const med = median(this.win);
    this.win = [];
    this.winStart = nowMs;
    this.slow = med > 1.25 * Math.max(this.targetMs, this.capMs) ? this.slow + 1 : 0;
    if (this.slow < 2) return null;
    this.slow = 0;
    this.pending = med;
    return { kind: 'probe' };
  }

  /** Bare rAF interval measured with rendering paused. Acts only if our frames are slow even against that cap. */
  probed(capMs: number): GovAction | null {
    const med = this.pending;
    this.pending = null;
    if (Number.isFinite(capMs)) this.capMs = capMs;
    if (med === null || med <= 1.25 * Math.max(this.targetMs, this.capMs)) return null; // the cap, not us
    if (this.dpr > this.floor + 1e-3) {
      this.dpr = Math.max(this.floor, this.dpr * 0.85);
      return { kind: 'dpr', dpr: this.dpr };
    }
    const i = TIER_ORDER.indexOf(this.tier);
    if (i <= 0) {
      this.locked = true;
      return null;
    }
    this.tier = TIER_ORDER[i - 1];
    if (++this.drops >= 3) this.locked = true;
    return { kind: 'tier', tier: this.tier };
  }
}
