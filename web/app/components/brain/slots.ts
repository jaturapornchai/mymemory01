// PURE (runs under `node --test`): id → instance-slot bookkeeping, deterministic fallback placement, node → edge adjacency.

export interface Slot<T> {
  slot: number;
  group: number;
  item: T;
  live: boolean;
}
export interface SlotDiff<T> {
  added: Slot<T>[];
  revived: Slot<T>[];
  removed: Slot<T>[];
  /** still live, but the parent replaced the object (a field changed) */
  replaced: Slot<T>[];
}

/**
 * Slots are handed out per group in order of first appearance and never freed (scrub back = dead, scrub forward =
 * revive the same slot), so GPU buffers are only ever appended to. `count[g]` is the instance count to draw.
 */
export class SlotTable<T> {
  readonly byKey = new Map<string, Slot<T>>();
  readonly count: number[];
  readonly items: Slot<T>[][];
  private prev: readonly T[] = [];
  private readonly keyOf: (t: T) => string;
  private readonly groupOf: (t: T) => number;

  // no parameter properties: node --test only strips erasable TS syntax
  constructor(keyOf: (t: T) => string, groupOf: (t: T) => number, groups = 1) {
    this.keyOf = keyOf;
    this.groupOf = groupOf;
    this.count = new Array<number>(groups).fill(0);
    this.items = Array.from({ length: groups }, () => []);
  }

  /**
   * Prefix fast path: the store re-slices one sorted array, so `next[i] === prev[i]` for a long prefix and only the
   * tails need an id diff. A mid-array change just makes the prefix short (worst case: a full diff, same result).
   */
  diff(next: readonly T[], fast = true): SlotDiff<T> {
    const prev = this.prev;
    let d = 0;
    if (fast) for (const m = Math.min(prev.length, next.length); d < m && next[d] === prev[d]; ) d++;
    const out: SlotDiff<T> = { added: [], revived: [], removed: [], replaced: [] };
    const seen = new Set<string>();
    for (let i = d; i < next.length; i++) {
      const item = next[i];
      const key = this.keyOf(item);
      seen.add(key);
      let s = this.byKey.get(key);
      if (!s) {
        const g = this.groupOf(item);
        s = { slot: this.count[g]++, group: g, item, live: true };
        this.byKey.set(key, s);
        this.items[g].push(s);
        out.added.push(s);
      } else if (!s.live) {
        s.live = true;
        s.item = item;
        out.revived.push(s);
      } else if (s.item !== item) {
        s.item = item;
        out.replaced.push(s);
      }
    }
    for (let i = d; i < prev.length; i++) {
      const key = this.keyOf(prev[i]);
      const s = this.byKey.get(key);
      if (s?.live && !seen.has(key)) {
        s.live = false;
        out.removed.push(s);
      }
    }
    this.prev = next;
    return out;
  }
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
export const SHELL = 48;
/**
 * Where a node without baked `xyz` goes: the k-th child of a parent sits on a Fibonacci shell (golden-angle
 * direction k) of radius 4·parentR, 48 per shell, each further shell +6 units. Deterministic, 0 force ticks;
 * the next export relaxes it properly.
 */
export function placeFallback(parent: readonly number[], parentR: number, k: number): [number, number, number] {
  const y = 1 - (2 * ((k % SHELL) + 0.5)) / SHELL;
  const s = Math.sqrt(1 - y * y);
  const a = k * GOLDEN;
  const rad = 4 * parentR + 6 * Math.floor(k / SHELL);
  return [parent[0] + rad * s * Math.cos(a), parent[1] + rad * y, parent[2] + rad * s * Math.sin(a)];
}

/** node key → incident link slots, encoded +(slot+1) when the node is the source and -(slot+1) when it is the target. */
export function addAdjacency(adj: Map<string, number[]>, source: string, target: string, slot: number): void {
  for (const [id, v] of [[source, slot + 1], [target, -(slot + 1)]] as const) {
    const list = adj.get(id);
    if (list) list.push(v);
    else adj.set(id, [v]);
  }
}
