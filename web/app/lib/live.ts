// Local viewer only (`brain-serve` on 127.0.0.1): what each MCP call did, from /live.json, and one traced search from
// /search (src/brain-live.ts). The public static site has neither endpoint and never asks for them. No React, no three.
import type { BrainEvent } from './brain.ts';

export type HitType = 'rule' | 'fact' | 'chat' | 'note' | 'github' | 'daily' | 'private';
export type LiveHit = { type: HitType; node: string | null };
/** One real MCP request from an AI app. `query` null = a private source was touched: never shown. */
export type LiveCall = { t: number; kind: string; client: string | null; project: string | null; query: string | null; ms: number | null; hits: LiveHit[] };
export type Stages = { embed?: number; keyword?: number; vector?: number; synapse?: number; other?: number };
export type TraceHit = { type: HitType; node: string | null; label: string };
/** a candidate's rank in each leg of the search (null = that leg did not find it) and its cosine to the question */
export type Ranks = { kw: number | null; bi: number | null; vec: number | null; cos: number | null };
/** every row the search scored after RRF, in rank order. why: ai = in memory_search's default answer (6), more = next in
 *  line (a caller asking for more gets these), fold:<fact> = attached under that fact, cap = its chat already has 3, full */
export type TraceRow = TraceHit & Ranks & { score: number; why: string; ev: number; status: string | null };
export type LegItem = TraceHit & { r: number; cos: number | null };
export type TraceLeg = { n: number; top: LegItem[] };
/** reached through the synapse graph from answer #via (1-based), not by the search itself */
export type Linked = TraceHit & { via: number; kind: string; act: number; sim: number | null };
export type Signal = { cos1: number | null; cos10: number | null; cosMean: number | null; kw: number; unseen: number };
/** what each step of the search saw (the test-ask log) */
export type Explain = {
  corpus: number;
  time: { from: string | null; to: string | null; recent: boolean } | null;
  terms: { key: string; df: number; used: boolean }[];
  unseen: string[];
  fused: number;
  signal: Signal | null;
  kw: TraceLeg;
  bi: TraceLeg;
  vec: TraceLeg;
  rows: TraceRow[];
  linked: Linked[];
};
/** unfamiliar = the server's "ไม่รู้" rule (same as memory_search): the memory probably has nothing on it, the hits are near misses */
export type Trace = { q: string; ms: number; semantic: boolean; unfamiliar: boolean; stages: Stages; hits: TraceHit[]; explain?: Explain };

export const HIT_TYPES: readonly HitType[] = ['rule', 'fact', 'chat', 'note', 'github', 'daily', 'private'];
const MAX_CALLS = 40; // the ticker's history
const POLL_MS = 1000;
const FIRST_LOOKBACK_MS = 90_000; // first poll: the ticker starts with the last minute and a half (shown, never fired)
const FRESH_MS = 8000; // a call older than this on arrival (tab was hidden, first poll) is history: no light
const OVERLAP_MS = 3000; // re-ask a little before the last server time: a row committed late is still caught (de-duplicated)

const isHitType = (x: unknown): x is HitType => typeof x === 'string' && (HIT_TYPES as readonly string[]).includes(x);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);

function toCall(x: unknown): LiveCall | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  const t = num(o.t);
  if (t === null || typeof o.kind !== 'string' || !Array.isArray(o.hits)) return null;
  const hits: LiveHit[] = [];
  for (const h of o.hits) {
    const r = (h ?? {}) as Record<string, unknown>;
    if (isHitType(r.type)) hits.push({ type: r.type, node: str(r.node) });
  }
  return { t, kind: o.kind, client: str(o.client), project: str(o.project), query: str(o.query), ms: num(o.ms), hits };
}

/** Light for the 3D map: one event per distinct node a call hit, counted by hits (private hits have no node). */
export function callEvents(c: LiveCall): BrainEvent[] {
  const by = new Map<string, number>();
  for (const h of c.hits) if (h.node) by.set(h.node, (by.get(h.node) ?? 0) + 1);
  const kind = c.kind === 'search' ? 'search' : 'recall';
  return [...by].map(([node, n]) => [Math.floor(c.t / 1000), node, kind, n]);
}

const CLIENT_NAME: Record<string, string> = { 'claude-code': 'Claude Code', 'codex-mcp-client': 'Codex', 'antigravity-client': 'Antigravity', zcode: 'ZCode' };
export const clientName = (c: string | null) => (c ? (CLIENT_NAME[c] ?? c) : 'ไม่ทราบแอป');

/** Polls /live.json (1 s while the tab is visible). Calls are oldest first; `on` also gets `fresh` (worth animating). */
export class LiveFeed {
  /** /live.json answered at least once: the ticker and the search box are meaningful */
  available = false;
  calls: LiveCall[] = [];
  private after = 0;
  private seen = new Set<string>();
  private first = true;
  private subs = new Set<(c: LiveCall, fresh: boolean) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private stopped = true;
  private run = 0; // a stop + start (StrictMode) must not leave the old loop's pending timer running beside the new one
  private onAvailable: () => void;
  /** `onAvailable` runs once, with the first answer */
  constructor(onAvailable: () => void) {
    this.onAvailable = onAvailable;
  }

  on(cb: (c: LiveCall, fresh: boolean) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop(++this.run);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async loop(run: number) {
    if (!document.hidden) {
      try {
        await this.poll();
        this.failures = 0;
      } catch {
        this.failures++; // no endpoint (an older server): back off to 30 s instead of 404-ing every second
      }
    }
    if (!this.stopped && run === this.run) this.timer = setTimeout(() => void this.loop(run), POLL_MS * Math.min(30, 2 ** this.failures));
  }

  private async poll() {
    const after = this.after || Date.now() - FIRST_LOOKBACK_MS;
    const r = await fetch(`live.json?after=${Math.floor(after)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`live.json: ${r.status}`);
    const j: unknown = await r.json();
    const o = (j ?? {}) as Record<string, unknown>;
    const now = num(o.now);
    if (now === null || !Array.isArray(o.calls)) throw new Error('live.json: not a live export');
    if (this.stopped) return;
    this.after = now - OVERLAP_MS;
    const first = this.first;
    this.first = false;
    for (const x of o.calls) {
      const c = toCall(x);
      const key = c && `${c.t}|${c.kind}`;
      if (!c || !key || this.seen.has(key)) continue;
      this.seen.add(key);
      this.calls.push(c);
      for (const cb of this.subs) cb(c, !first && now - c.t < FRESH_MS);
    }
    if (this.calls.length > MAX_CALLS) {
      this.calls = this.calls.slice(-MAX_CALLS);
      this.seen = new Set(this.calls.map((c) => `${c.t}|${c.kind}`));
    }
    if (!this.available) {
      this.available = true;
      this.onAvailable();
    }
  }
}

/** One real search, not logged (no effect on the memory's usage statistics). Throws on any failure, or after 15 s. */
export async function runSearch(q: string): Promise<Trace> {
  const r = await fetch(`search?q=${encodeURIComponent(q)}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(r.status === 422 ? 'secret' : r.status === 429 ? 'busy' : `search: ${r.status}`); // brain-serve --share
  const o = (await r.json()) as Record<string, unknown>;
  const st = (o.stages ?? {}) as Record<string, unknown>;
  const stages: Stages = {};
  for (const k of ['embed', 'keyword', 'vector', 'synapse', 'other'] as const) {
    const v = num(st[k]);
    if (v !== null) stages[k] = Math.max(0, v);
  }
  const hits = list(o.hits, toHit);
  const explain = toExplain(o.explain);
  return { q: str(o.q) ?? q, ms: num(o.ms) ?? 0, semantic: o.semantic === true, unfamiliar: o.unfamiliar === true, stages, hits, ...(explain && { explain }) };
}

// the trace parser keeps only fields of the expected type: a malformed item is dropped, never shown half-filled
type Rec = Record<string, unknown>;
const rec = (x: unknown): Rec | null => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Rec) : null);
const list = <T,>(x: unknown, f: (o: Rec) => T | null): T[] => (Array.isArray(x) ? x.map((i) => { const o = rec(i); return o ? f(o) : null; }).filter((i): i is T => i !== null) : []);
const toHit = (x: Rec): TraceHit | null => (isHitType(x.type) ? { type: x.type, node: str(x.node), label: str(x.label) ?? '' } : null);
const ranks = (x: Rec): Ranks => ({ kw: num(x.kw), bi: num(x.bi), vec: num(x.vec), cos: num(x.cos) });
const toLeg = (x: unknown): TraceLeg => {
  const o = rec(x) ?? {};
  return { n: num(o.n) ?? 0, top: list(o.top, (i) => { const h = toHit(i), r = num(i.r); return h && r !== null ? { ...h, r, cos: num(i.cos) } : null; }) };
};

function toExplain(x: unknown): Explain | undefined {
  const o = rec(x);
  if (!o) return undefined;
  const t = rec(o.time), s = rec(o.signal);
  return {
    corpus: num(o.corpus) ?? 0,
    time: t ? { from: str(t.from), to: str(t.to), recent: t.recent === true } : null,
    terms: list(o.terms, (i) => (typeof i.key === 'string' ? { key: i.key, df: num(i.df) ?? 0, used: i.used === true } : null)),
    unseen: Array.isArray(o.unseen) ? o.unseen.filter((w): w is string => typeof w === 'string') : [],
    fused: num(o.fused) ?? 0,
    signal: s ? { cos1: num(s.cos1), cos10: num(s.cos10), cosMean: num(s.cosMean), kw: num(s.kw) ?? 0, unseen: num(s.unseen) ?? 0 } : null,
    kw: toLeg(o.kw),
    bi: toLeg(o.bi),
    vec: toLeg(o.vec),
    rows: list(o.rows, (i) => { const h = toHit(i); return h && typeof i.why === 'string' ? { ...h, ...ranks(i), score: num(i.score) ?? 0, why: i.why, ev: num(i.ev) ?? 0, status: str(i.status) } : null; }),
    linked: list(o.linked, (i) => { const h = toHit(i); return h && typeof i.kind === 'string' ? { ...h, via: num(i.via) ?? 0, kind: i.kind, act: num(i.act) ?? 0, sim: num(i.sim) } : null; }),
  };
}
