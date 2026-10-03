import {
  appearAt,
  eventKey,
  linkKey,
  type Brain,
  type BrainEvent,
  type BrainLink,
  type BrainNode,
  type LogEntry,
} from './brain';

/** 150 days at 16× = 9.4 s: the intro and ▶ stay ≤ 10 s even with no quiet stretch to warp past */
const REPLAY_DAYS = 150;

/**
 * Engine-agnostic mutable store for the merged brain. Holds plain data only (no positions, no three objects).
 * Nodes are replaced (never mutated) when a field changes, so `node !== previous` is a valid change test.
 */
export class BrainStore {
  mode: Brain['mode'] = 'public';
  at = 0;
  stats: Record<string, number> = {};
  nodes = new Map<string, BrainNode>();
  links: BrainLink[] = [];
  /** nodes sorted by appearance time (hubs first on ties) — the replay "growth" order */
  byAppear: BrainNode[] = [];
  /** links sorted by the time both endpoints exist */
  linksByAppear: BrainLink[] = [];
  /** time a link becomes visible (both endpoints exist) */
  linkAppear = new Map<BrainLink, number>();
  /** full history, sorted by t */
  events: BrainEvent[] = [];
  /** unseen events from live feed merges, fired by the driver in LIVE (a replay playhead passing one fires it from `events` and drops it here) */
  pending: BrainEvent[] = [];
  /** system log, newest first (graph and feed both carry the whole log) */
  log: LogEntry[] = [];
  /** per-app counts, daily activity, last dream run: latest export wins (graph and feed both carry them) */
  apps: NonNullable<Brain['apps']> = {};
  activity: Brain['activity'] = undefined;
  dream: Brain['dream'] = undefined;
  model: Brain['model'] = undefined;
  /** bumped whenever nodes/links membership or any node field changes */
  rev = 0;

  private seenEvents = new Set<string>();
  private seenLinks = new Set<string>();

  /** `graph` = full snapshot (replaces stats/events); `feed` = recent delta (appends unseen events). Returns true if nodes/links changed. */
  merge(b: Brain, kind: 'graph' | 'feed'): boolean {
    let dirty = false;
    for (const n of b.nodes) {
      const ex = this.nodes.get(n.id);
      if (!ex) {
        this.nodes.set(n.id, n);
        dirty = true;
      } else if (ex.n !== n.n || ex.u !== n.u || ex.t0 !== n.t0 || ex.t1 !== n.t1 || ex.label !== n.label || ex.p !== n.p) {
        this.nodes.set(n.id, { ...ex, ...n });
        dirty = true;
      }
    }
    for (const l of b.links) {
      const key = linkKey(l);
      if (this.seenLinks.has(key) || !this.nodes.has(l.source) || !this.nodes.has(l.target)) continue; // unknown endpoint: retry on a later merge
      this.seenLinks.add(key);
      this.links.push(l);
      dirty = true;
    }

    if (kind === 'graph') {
      this.events = b.events.filter((e) => this.nodes.has(e[1])).sort((a, c) => a[0] - c[0]);
      this.seenEvents = new Set(this.events.map(eventKey));
    } else {
      let sorted = true;
      for (const e of b.events) {
        const key = eventKey(e);
        if (this.seenEvents.has(key) || !this.nodes.has(e[1])) continue;
        this.seenEvents.add(key);
        if (this.events.length && e[0] < this.events[this.events.length - 1][0]) sorted = false;
        this.events.push(e);
        this.pending.push(e);
      }
      if (!sorted) this.events.sort((a, c) => a[0] - c[0]);
    }

    this.stats = b.stats;
    if (b.log) this.log = b.log;
    if (b.apps) this.apps = b.apps;
    if (b.activity) this.activity = b.activity;
    if (b.dream) this.dream = b.dream;
    if (b.model) this.model = b.model;
    this.mode = b.mode;
    this.at = Math.max(this.at, b.at);
    if (dirty) {
      this.rev++;
      this.reindex();
    }
    return dirty;
  }

  private reindex() {
    const t = (id: string) => appearAt(this.nodes.get(id)!);
    this.byAppear = [...this.nodes.values()].sort((a, c) => appearAt(a) - appearAt(c) || (a.type === 'project' ? -1 : 0) - (c.type === 'project' ? -1 : 0));
    const at = new Map<BrainLink, number>(this.links.map((l) => [l, Math.max(t(l.source), t(l.target))]));
    this.linksByAppear = [...this.links].sort((a, c) => at.get(a)! - at.get(c)!);
    this.linkAppear = at;
  }

  /**
   * [start, end] of the replayable time range, unix s: the last REPLAY_DAYS at most. Imported GitHub history reaches
   * back years (an 11-year timeline, ▶ for minutes); older nodes are simply there at the start.
   */
  domain(): [number, number] {
    const last = Math.max(this.at, (this.events[this.events.length - 1]?.[0] ?? 0) + 600);
    const first = Math.max(last - REPLAY_DAYS * 86400, Math.min(this.events[0]?.[0] ?? Infinity, this.byAppear[0] ? appearAt(this.byAppear[0]) : Infinity));
    return Number.isFinite(first) ? [first, Math.max(last, first + 86400)] : [0, 86400];
  }

  hubOf(n: BrainNode): BrainNode | undefined {
    return n.p ? this.nodes.get(n.p) : undefined;
  }
}
