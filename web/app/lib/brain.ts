// Data model (mirrors ../../src/brain.ts) + palette + small pure helpers. No three.js here.

export type NodeType = 'project' | 'session' | 'subagent' | 'note' | 'memory';
/** The AI app a source came from (= sources.tool). Names are public; counts only. */
export type App = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'zcode' | 'lmstudio' | 'github' | 'obsidian';
export type AppStats = { sessions: number; subagents: number; turns: number; chunks: number; t1: number }; // t1 = last activity
export type BrainNode = {
  id: string;
  type: NodeType;
  label?: string;
  a?: App; // session/subagent/note: the app its source came from (absent on hubs and memories)
  p?: string; // parent hub (project/vault) node id
  n: number; // chunks
  t0: number; // first activity, unix s
  t1: number; // last activity, unix s
  u: number; // recall count; -1 = superseded
  xyz?: [number, number, number]; // baked layout (src/layout.ts): integer world units, stable across exports; absent → the scene places it
  s?: [number, number, number]; // position by meaning (bge-m3 embeddings → 3D, src/layout.ts bakeSemantic); absent: none (no embedded chunks, public GitHub items)
};
export type LinkKind = 'in' | 'spawn' | 'link' | 'similar' | 'coaccess';
export type BrainLink = { source: string; target: string; k: LinkKind; w: number };
export type EventKind = 'turn' | 'search' | 'recall';
/** [t unix s, node id, kind, count] */
export type BrainEvent = [t: number, node: string, kind: EventKind, n: number];
export type Brain = {
  v: 1;
  mode: 'public' | 'local';
  at: number;
  stats: Record<string, number>;
  nodes: BrainNode[];
  links: BrainLink[];
  events: BrainEvent[];
  log?: LogEntry[]; // absent in exports made before the system log existed
  // absent in exports made before the per-app breakdown existed
  apps?: Partial<Record<App, AppStats>>;
  /** turns per Bangkok (UTC+7) day, oldest first, the last = the export's day; start = 00:00 +07 of entry 0 */
  activity?: { start: number; turns: number[] };
  /** the last dream run, any age (counters as in log rows k='dream') */
  dream?: { t: number; c: Record<string, number> };
  /** embedding model of the vectors (absent in older exports / without vectors) */
  model?: string;
};
export type LogKind = 'ingest' | 'recall' | 'dream' | 'publish';
/** System log row, newest first: counts only; `p` = project names (local mode only). */
export type LogEntry = { t: number; k: LogKind; c: Record<string, number>; p?: string[] };

/** Validated categorical palette (dark surface, CVD-safe). Nothing else may be used for node families. */
export const COLOR = { blue: '#3987e5', aqua: '#199e70', orange: '#d95926' } as const;
export const FAMILY_COLOR: Record<NodeType, string> = {
  project: COLOR.blue,
  session: COLOR.aqua,
  subagent: COLOR.aqua,
  note: COLOR.orange,
  memory: COLOR.orange,
};
export const TYPE_NAME: Record<NodeType, string> = {
  project: 'โปรเจ็กต์',
  session: 'บทสนทนา',
  subagent: 'เอเจนต์ย่อย',
  note: 'โน้ต',
  memory: 'ความจำ',
};
export const NODE_TYPES = Object.keys(TYPE_NAME) as NodeType[];

/**
 * "สีตาม AI" lens: the dataviz reference categorical palette (dark steps, slot order kept), the same in both themes like
 * FAMILY_COLOR. validate_palette.js: dark #07090f and #0c0e14 all PASS; light #f5f5f7 PASS, 3 slots WARN < 3:1 (relief:
 * names always shown). All-pairs (a scatter) fails past 3 slots: the 3 biggest node groups take slots 1-3, and an app
 * row spotlights its own nodes, so identity never rests on colour alone.
 */
export const APP_COLOR: Record<App, string> = {
  github: '#3987e5',
  claude: '#d95926',
  codex: '#199e70',
  zcode: '#c98500',
  antigravity: '#d55181',
  lmstudio: '#008300',
  obsidian: '#9085e9',
  gemini: '#e66767',
};
export const APP_NAME: Record<App, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  zcode: 'ZCode',
  lmstudio: 'LM Studio',
  github: 'GitHub',
  obsidian: 'Obsidian',
};
export const isApp = (a: unknown): a is App => typeof a === 'string' && Object.hasOwn(APP_NAME, a);

/** Nodes show up this many seconds before t0 so the first (10-minute-bucketed) event of a node is never dropped. */
export const APPEAR_SLACK = 600;
export const appearAt = (n: BrainNode) => n.t0 - APPEAR_SLACK;

export const eventKey = (e: BrainEvent) => `${e[0]}|${e[1]}|${e[2]}`;
export const linkKey = (l: BrainLink) => `${l.source}|${l.target}|${l.k}`;

/** Light shape check for fetched JSON (untrusted input). */
export function isBrain(x: unknown): x is Brain {
  if (typeof x !== 'object' || x === null) return false;
  const b = x as Partial<Brain>;
  return (
    b.v === 1 &&
    (b.mode === 'public' || b.mode === 'local') &&
    typeof b.at === 'number' &&
    typeof b.stats === 'object' &&
    b.stats !== null &&
    Array.isArray(b.nodes) &&
    Array.isArray(b.links) &&
    Array.isArray(b.events) &&
    (b.log === undefined || Array.isArray(b.log)) &&
    (b.apps === undefined || (typeof b.apps === 'object' && b.apps !== null)) &&
    (b.activity === undefined || (typeof b.activity?.start === 'number' && Array.isArray(b.activity.turns))) &&
    (b.dream === undefined || (typeof b.dream?.t === 'number' && typeof b.dream.c === 'object' && b.dream.c !== null))
  );
}

/** First index in sorted `a` whose key is > x. */
export function upperBound<T>(a: readonly T[], x: number, key: (v: T) => number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(a[mid]) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
