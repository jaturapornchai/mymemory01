import {
  appearAt,
  eventKey,
  linkKey,
  type Brain,
  type BrainEvent,
  type BrainLink,
  type BrainNode,
  type LogEntry,
} from './brain.ts'; // .ts: node --test loads this file (store.test.ts)

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
  /**
   * Light for one MCP call each (lib/live.ts: /live.json, local only): one event per node it hit. Fired by the driver at
   * the moment of the request, only while LIVE (a replay playhead never plays them), and never part of `events`: the
   * feed brings the same requests later as minute buckets.
   */
  flash: BrainEvent[] = [];
  /** /live.json answers: it fires search/recall at the request itself, so the feed's copies of those only join the history */
  liveOwns = false;
  /** system log, newest first (graph and feed both carry the whole log) */
  log: LogEntry[] = [];
  /** per-app counts, daily activity, last dream run: latest export wins (graph and feed both carry them) */
  apps: NonNullable<Brain['apps']> = {};
  activity: Brain['activity'] = undefined;
  dream: Brain['dream'] = undefined;
  model: Brain['model'] = undefined;
  /** bumped whenever nodes/links membership or any node field changes */
  rev = 0;

  /** eventKey → the count already seen: events are per-minute buckets that grow as requests arrive */
  private seenEvents = new Map<string, number>();
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
      this.seenEvents = new Map(this.events.map((e) => [eventKey(e), e[3]]));
    } else {
      let sorted = true;
      for (const e of b.events) {
        const key = eventKey(e);
        const seen = this.seenEvents.get(key) ?? 0;
        if (e[3] <= seen || !this.nodes.has(e[1])) continue; // unknown node: retry on a later merge
        this.seenEvents.set(key, e[3]);
        // a bucket that grew (2nd, 3rd … request in the same minute on one source) fires only what is new
        const fresh: BrainEvent = seen ? [e[0], e[1], e[2], e[3] - seen] : e;
        if (this.events.length && fresh[0] < this.events[this.events.length - 1][0]) sorted = false;
        this.events.push(fresh);
        if (!(this.liveOwns && fresh[2] !== 'turn')) this.pending.push(fresh);
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
