// Brain graph export for the web viewer (web/). Two modes:
//  - local:  real labels (project names, note titles, first prompt) — served only on 127.0.0.1
//  - public: same shape/stats/activity, but ids are HMAC'd and labels are aliases (P1, V1); no text, no paths, no names
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { brainStats } from './brain-stats.ts';
import { ROOT } from './db.ts';
import { RUNS_DIR } from './dream.ts';
import { PRIVATE_TOOLS } from './guard.ts';
import { bakeLayout, bakeSemantic } from './layout.ts';
import { MEMORY_PROJECT } from './notes.ts';

export type NodeType = 'project' | 'session' | 'subagent' | 'note' | 'memory';
/** The AI apps (= sources.tool). Approved for the public site by name; everything else stays an alias.
 *  google = the Claude-only tools (guard.PRIVATE_TOOLS): counts only, never a node, edge, label or time (local mode too). */
export const APPS = ['claude', 'codex', 'gemini', 'antigravity', 'zcode', 'lmstudio', 'github', 'obsidian', 'google'] as const;
export type App = (typeof APPS)[number];
export type BrainNode = {
  id: string; type: NodeType; label?: string;
  p?: string;          // parent project/vault node id
  a?: App;             // session/subagent/note: the app its source came from (absent on project and memory nodes)
  n: number;           // chunks (size)
  t0: number; t1: number; // first / last activity, unix seconds
  u: number;           // times recalled by Claude (memory_get/related)
  xyz?: [number, number, number]; // baked layout (src/layout.ts): integer world units, stable across exports; absent → the scene places it
  s?: [number, number, number];   // semantic layout (src/layout.ts bakeSemantic): by meaning, same units; absent = no vectors (hubs: children's mean)
};
export type LinkKind = 'in' | 'spawn' | 'link' | 'similar' | 'coaccess' | 'prov' | 'next';
export type BrainLink = { source: string; target: string; k: LinkKind; w: number };
export type EventKind = 'turn' | 'search' | 'recall';
export type BrainEvent = [t: number, node: string, kind: EventKind, n: number];
/** System log row: counts only (public); local mode adds project names in `p`. publish rows are local only. */
export type LogKind = 'ingest' | 'recall' | 'dream' | 'publish';
export type LogEntry = { t: number; k: LogKind; c: Record<string, number>; p?: string[] };
export type AppStats = { sessions: number; subagents: number; turns: number; chunks: number; t1: number }; // t1 = last activity
export type Brain = {
  v: 1; mode: 'public' | 'local'; at: number;
  stats: Record<string, number>;
  apps: Partial<Record<App, AppStats>>;
  activity: { start: number; turns: number[] }; // see activityOf
  dream?: { t: number; c: Record<string, number> }; // the last dream run, any age (counters as in log rows k='dream')
  model?: string; // embedding model of the vectors (brain-stats.ts; its counts/sizes are in stats)
  nodes: BrainNode[]; links: BrainLink[]; events: BrainEvent[];
  log: LogEntry[]; // newest first, last LOG_DAYS days, ≤ LOG_MAX rows
};

const sec = (d: Date | string | null) => (d ? Math.floor(new Date(d).getTime() / 1000) : 0);
const VAULT_MEMORY = MEMORY_PROJECT; // dream / memory_save notes live in this vault
const shortName = (p: string) => p.split('/').filter(Boolean).at(-1) ?? p;
const LOG_DAYS = 7, LOG_MAX = 200;
// dream run counters that may be published; the run id and batches[].candidates (fact text) never leave this file
const DREAM_STATS = ['sessions', 'windows', 'batches', 'cards', 'ADD', 'NOOP', 'UPDATE', 'SUPERSEDE', 'pending_review'];
const DAY = 86400, BKK = 7 * 3600, ACTIVITY_DAYS = 371; // heatmap: 53 weeks of Bangkok (UTC+7) days
// GitHub repos without a local clone (project 'github/<owner>/<repo>'): one hub per owner locally (~350 hubs of 1-3 nodes
// were clutter; one hub for all hid whose repos they are). Public: one shared hub for every GitHub item, cloned repos too.
// Their commit/issue times are public on GitHub to the second, so in their project's hub they would name its alias (and
// every AI session in it); in the shared hub they only show the repo is his
const GITHUB_HUB = 'github/*';
const ghOwner = (s: { tool: string; project: string | null }) => (s.tool === 'github' ? /^github\/([^/]+)/.exec(s.project ?? '')?.[1] : undefined);
const hubOf = (s: { tool: string; project: string | null }, pub: boolean) => {
  const owner = ghOwner(s);
  return s.tool === 'github' && pub ? GITHUB_HUB : owner ? `github/${owner}/*` : s.project ?? '?';
};
/** The hub a node had before per-owner hubs: its layout pin. A node in another hub gets a pin of its own (pins never move). */
const homeOf = (s: { tool: string; project: string | null }) => (ghOwner(s) ? GITHUB_HUB : s.project ?? '?');
const isApp = (a: unknown): a is App => (APPS as readonly unknown[]).includes(a);

/** Per-install secret so public ids can't be reversed by hashing known session ids. Lazily added to .env. */
function salt(): string {
  if (process.env.MEMHUB_PUBLIC_SALT) return process.env.MEMHUB_PUBLIC_SALT;
  const env = join(ROOT, '.env');
  const s = randomBytes(24).toString('base64url');
  if (!existsSync(env) || !/^MEMHUB_PUBLIC_SALT=\S/m.test(readFileSync(env, 'utf8'))) appendFileSync(env, `MEMHUB_PUBLIC_SALT=${s}\n`);
  return (process.env.MEMHUB_PUBLIC_SALT = s);
}
const pubId = (raw: string) => createHmac('sha256', salt()).update(raw).digest('base64url').slice(0, 10);

export async function buildBrain(db: pg.Pool, mode: 'public' | 'local', since?: Date): Promise<Brain> {
  const pub = mode === 'public';
  const rawOf = new Map<string, string>(); // node id → raw key: the layout pins by raw key so public and local share coordinates
  const id = (raw: string) => {
    const v = pub ? pubId(raw) : raw;
    rawOf.set(v, raw);
    return v;
  };

  const all = (await db.query(`
    SELECT s.id, s.tool, s.kind, s.session_id, s.project, s.status, s.hide_as,
           count(c.id)::int n, count(c.embedding)::int ne, min(c.ts) t0, max(c.ts) t1,
           (SELECT left(t.text_redacted, 80) FROM turns t WHERE t.source_id = s.id AND t.role = 'user' ORDER BY t.seq LIMIT 1) first
    FROM sources s JOIN chunks c ON c.source_id = s.id -- empty sources (meta-only sessions) are not brain cells
    GROUP BY s.id`)).rows;
  const sources = all.filter((s) => !PRIVATE_TOOLS.has(s.tool));
  // by turn, not chunk: chunk ids change on a re-chunk (turn uuids don't), and one turn can span several chunks
  const uses = new Map<string, number>((await db.query(`
    SELECT t.source_id::text sid, count(*)::int u FROM access_log a JOIN turns t ON t.uuid = a.turn_uuid
    WHERE a.kind <> 'search' GROUP BY 1`)).rows.map((r) => [r.sid, r.u]));

  const nodes: BrainNode[] = [];
  const links: BrainLink[] = [];
  const nodeOf = new Map<string, string>(); // source id → node id
  const vectors = new Map<string, number>(); // node id → embedded chunks
  const projects = new Map<string, BrainNode>();
  const mainBySession = new Map<string, string>();

  // Project / vault hubs, aliased in order of first activity (P1 = oldest).
  const byFirst = [...sources].sort((a, b) => sec(a.t0) - sec(b.t0));
  let pN = 0, vN = 0;
  for (const s of byFirst) {
    const p = hubOf(s, pub);
    if (projects.has(p)) continue;
    const vault = p.startsWith('obsidian/');
    const node: BrainNode = {
      id: id('project:' + p), type: 'project',
      label: pub ? (vault ? `V${++vN}` : `P${++pN}`) : vault ? p : p.startsWith('github/') ? `GitHub · ${p.split('/')[1]}` : shortName(p),
      n: 0, t0: Infinity, t1: 0, u: 0,
    };
    projects.set(p, node);
    nodes.push(node);
  }
  const apps: Brain['apps'] = {};
  for (const s of all) if (PRIVATE_TOOLS.has(s.tool)) (apps.google ??= { sessions: 0, subagents: 0, turns: 0, chunks: 0, t1: 0 }).chunks += s.n;
  for (const s of sources) {
    const h = hubOf(s, pub), hub = projects.get(h)!;
    // 'subagent' also takes Codex 'headless' runs (codex exec): on purpose, another agent or a script starts them
    const type: NodeType = s.tool === 'obsidian' ? (s.project === VAULT_MEMORY ? 'memory' : 'note') : s.kind === 'main' ? 'session' : s.kind === 'doc' ? 'note' : 'subagent';
    // a node outside its home hub gets a layout key of its own (pins never move, layout.ts): public moves cloned repos to the
    // GitHub hub ('@github'), local moves non-cloned ones to their owner's hub ('@owner'); public keys are unchanged
    const raw = 'source:' + s.id + (h === homeOf(s) ? '' : pub ? '@github' : '@owner');
    const n: BrainNode = { id: id(raw), type, p: hub.id, n: s.n, t0: sec(s.t0), t1: sec(s.t1), u: uses.get(String(s.id)) ?? 0 };
    if (!pub && type !== 'subagent') {
      n.label = type === 'session' ? (s.first ?? s.session_id).replace(/\s+/g, ' ').slice(0, 60) : String(s.session_id).replace(/^.*\/|\.md$/g, '');
    }
    if (s.status === 'superseded') n.u = -1; // ponytail: viewer dims u<0; a real flag when there's a 2nd status
    if (isApp(s.tool)) {
      if (type !== 'memory') n.a = s.tool;
      const a = (apps[s.tool] ??= { sessions: 0, subagents: 0, turns: 0, chunks: 0, t1: 0 });
      if (type === 'session') a.sessions++;
      if (type === 'subagent') a.subagents++;
      a.chunks += s.n;
      a.t1 = Math.max(a.t1, n.t1);
    }
    nodes.push(n);
    nodeOf.set(String(s.id), n.id);
    vectors.set(n.id, s.ne ?? 0);
    hub.n += s.n; hub.u += n.u > 0 ? n.u : 0;
    if (n.t0) hub.t0 = Math.min(hub.t0, n.t0);
    hub.t1 = Math.max(hub.t1, n.t1);
    if (type === 'session') mainBySession.set(s.session_id, n.id);
  }
  for (const h of projects.values()) if (h.t0 === Infinity) h.t0 = h.t1;
  for (const s of sources) {
    const n = nodeOf.get(String(s.id))!;
    const parent = s.kind === 'subagent' ? mainBySession.get(s.session_id) : undefined;
    links.push(parent ? { source: n, target: parent, k: 'spawn', w: 1 } : { source: n, target: projects.get(hubOf(s, pub))!.id, k: 'in', w: 1 });
  }
  let chats = 0; // AI chat turns: GitHub items and Obsidian notes are no chat (as in the heatmap below)
  for (const r of (await db.query(`SELECT s.tool, count(*)::int n FROM turns t JOIN sources s ON s.id = t.source_id GROUP BY 1`)).rows) {
    if (PRIVATE_TOOLS.has(r.tool)) { if (apps.google) apps.google.turns += r.n; continue; }
    if (isApp(r.tool) && apps[r.tool]) apps[r.tool]!.turns = r.n;
    if (r.tool !== 'github' && r.tool !== 'obsidian') chats += r.n;
  }

  // [[wikilinks]] between notes, the edges table (Hebbian co-access, fact/card provenance, next session in a project;
  // 'spawn' is derived above), and semantic neighbours (centroid cosine, top-2 per session/note).
  for (const r of (await db.query('SELECT src_id, dst_id FROM links WHERE dst_id IS NOT NULL AND dst_id <> src_id')).rows) {
    links.push({ source: nodeOf.get(String(r.src_id))!, target: nodeOf.get(String(r.dst_id))!, k: 'link', w: 1 });
  }
  // PRIVATE_TOOLS endpoints are no node (live() drops their edges); a hide_as session is a node (counts only), never a synapse
  const hidden = new Set(all.filter((s) => s.hide_as).map((s) => String(s.id)));
  // a synapse from a GitHub item (public times, shared hub: see GITHUB_HUB) out of that hub would name the other end's alias:
  // coaccess to a session of the cloned repo's project, prov to a fact citing it (next/spawn skip GitHub). Local builds drop it
  // too: both maps show the same synapses
  const gh = new Set(sources.filter((s) => s.tool === 'github').map((s) => String(s.id)));
  for (const r of (await db.query(`SELECT a, b, kind, w FROM edges WHERE kind IN ('coaccess', 'prov', 'next')`)).rows) {
    if (hidden.has(String(r.a)) || hidden.has(String(r.b))) continue;
    if (gh.has(String(r.a)) !== gh.has(String(r.b))) continue;
    links.push({ source: nodeOf.get(String(r.a))!, target: nodeOf.get(String(r.b))!, k: r.kind, w: Number(r.w) });
  }
  const sim = (await db.query(`
    WITH c AS (SELECT c.source_id id, avg(c.embedding) e FROM chunks c JOIN sources s ON s.id = c.source_id
               WHERE c.embedding IS NOT NULL AND s.kind IN ('main', 'note') AND s.tool <> ALL($1::text[]) AND s.hide_as IS NULL GROUP BY 1)
    SELECT a.id a, b.id b, b.sim FROM c a CROSS JOIN LATERAL (
      SELECT x.id, 1 - (a.e <=> x.e) sim FROM c x WHERE x.id <> a.id ORDER BY a.e <=> x.e LIMIT 2) b
    WHERE b.sim > 0.55 ORDER BY 1, 2`, [[...PRIVATE_TOOLS]])).rows; // ordered: which direction of a pair is seen first feeds the layout bake (determinism)
  const seen = new Set<string>();
  for (const r of sim) {
    const k = [r.a, r.b].sort().join('-');
    if (seen.has(k)) continue;
    seen.add(k);
    links.push({ source: nodeOf.get(String(r.a))!, target: nodeOf.get(String(r.b))!, k: 'similar', w: Number(Number(r.sim).toFixed(3)) });
  }

  // Activity: conversation turns per 10-minute bucket per source, plus Claude's searches/recalls.
  const after = since ?? new Date(0);
  const events: BrainEvent[] = [];
  for (const r of (await db.query(`
    SELECT source_id, extract(epoch FROM date_bin('10 minutes', ts, 'epoch'))::bigint t, count(*)::int n
    FROM turns WHERE ts > $1 GROUP BY 1, 2`, [after])).rows) {
    events.push([Number(r.t), nodeOf.get(String(r.source_id))!, 'turn', r.n]);
  }
  for (const r of (await db.query(`
    SELECT u.source_id, extract(epoch FROM date_bin('1 minute', a.ts, 'epoch'))::bigint t,
           CASE WHEN a.kind = 'search' THEN 'search' ELSE 'recall' END k, count(*)::int n
    FROM access_log a JOIN turns u ON u.uuid = a.turn_uuid WHERE a.ts > $1 GROUP BY 1, 2, 3`, [after])).rows) { // by turn, as uses above
    events.push([Number(r.t), nodeOf.get(String(r.source_id))!, r.k, r.n]);
  }
  events.sort((a, b) => a[0] - b[0]);
  // links/events can point at sources skipped above (no chunks) → drop them
  const live = (x?: string) => x !== undefined;
  links.splice(0, links.length, ...links.filter((l) => live(l.source) && live(l.target)));
  events.splice(0, events.length, ...events.filter((e) => live(e[1])));
  await bakeLayout(db, nodes, links, rawOf); // here, not in the CLI: covers brain --out, brain-serve and publish
  // public: GitHub items get no spot by meaning: next to their project's sessions it would name its alias (as hubOf)
  await bakeSemantic(db, nodes, rawOf, vectors, (n) => pub && n.a === 'github');

  const st = (await db.query(`SELECT
    (SELECT count(*) FROM turns)::int turns, (SELECT count(*) FROM chunks)::int chunks,
    (SELECT count(*) FROM chunks WHERE embedding IS NOT NULL)::int vectors,
    (SELECT count(DISTINCT ts) FROM access_log WHERE kind = 'search' AND ts > now() - interval '7 days')::int hits7d, -- searches, see systemLog
    (SELECT count(*) FROM access_log WHERE kind <> 'search' AND ts > now() - interval '7 days')::int recalls7d,
    (SELECT count(DISTINCT session) FROM access_log WHERE ts > now() - interval '7 days')::int sessions7d,
    pg_database_size(current_database())::bigint db`)).rows[0];
  const count = (t: NodeType) => nodes.filter((n) => n.type === t).length;
  const more = await brainStats(db);
  // hourly, not daily, in SQL: activityOf cuts the Bangkok days (whole-hour offset, so no hour straddles a day).
  // Chats only (the panel's แชตรายวัน): GitHub items keep their commit/issue times, notes their file mtime
  const hours = (await db.query(`SELECT extract(epoch FROM date_bin('1 hour', turns.ts, 'epoch'))::bigint t, count(*)::int n
    FROM turns JOIN sources s ON s.id = turns.source_id
    WHERE s.tool <> ALL($1::text[]) AND turns.ts > now() - interval '${ACTIVITY_DAYS + 1} days' GROUP BY 1`, [['github', 'obsidian', ...PRIVATE_TOOLS]])).rows;
  return {
    v: 1, mode, at: Math.floor(Date.now() / 1000),
    stats: {
      projects: nodes.filter((n) => n.type === 'project' && !n.label?.match(/^V\d|^obsidian\//)).length,
      sessions: count('session'), subagents: count('subagent'), notes: count('note'), memories: count('memory'),
      turns: st.turns, chats, chunks: st.chunks, vectors: st.vectors, hits7d: st.hits7d, recalls7d: st.recalls7d,
      sessions7d: st.sessions7d, dbBytes: Number(st.db), links: links.length, ...more.stats,
    },
    apps, activity: activityOf(hours.map((r) => ({ t: Number(r.t), n: r.n })), Date.now() / 1000), dream: lastDream(), model: more.model,
    nodes, links, events, log: await systemLog(db, pub),
  };
}

/** Turns per Bangkok (UTC+7) day: ACTIVITY_DAYS entries, oldest first, the last = today; start = 00:00 +07 of entry 0. */
export function activityOf(rows: { t: number; n: number }[], now: number): Brain['activity'] {
  const first = Math.floor((now + BKK) / DAY) - ACTIVITY_DAYS + 1; // Bangkok day number of entry 0
  const turns = new Array<number>(ACTIVITY_DAYS).fill(0);
  for (const r of rows) {
    const i = Math.floor((r.t + BKK) / DAY) - first;
    if (i >= 0 && i < ACTIVITY_DAYS) turns[i] += r.n;
  }
  return { start: first * DAY - BKK, turns };
}

/** The last dream run, any age. Run files are append-only, so the newest file holds the latest record. */
export function lastDream(dir = RUNS_DIR): Brain['dream'] {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f)) : [];
  for (const f of files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)) {
    const last = dreamLog(readFileSync(f, 'utf8'), 0).sort((a, b) => b.t - a.t)[0];
    if (last) return { t: last.t, c: last.c };
  }
}

/** Dream run records (RUNS_DIR/<run>.json, one JSON object per line) → log rows with whitelisted counters only. */
export function dreamLog(lines: string, since: number): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of lines.split('\n')) {
    let r: { at?: unknown; stats?: Record<string, unknown> } | null;
    try { r = JSON.parse(line); } catch { continue; }
    const t = typeof r?.at === 'string' ? sec(r.at) : NaN;
    if (!(t > since) || typeof r?.stats !== 'object' || !r.stats) continue;
    const c: Record<string, number> = {};
    for (const k of DREAM_STATS) if (Number.isFinite(r.stats[k])) c[k] = r.stats[k] as number;
    out.push({ t, k: 'dream', c });
  }
  return out;
}

/** The viewer's system log: hourly ingest + recall counts, dream runs, last publish (local only). */
async function systemLog(db: pg.Pool, pub: boolean): Promise<LogEntry[]> {
  // whole UTC days: the window moves once a day, not on every hourly publish (new rev → redeploy), and never splits an hour
  const since = Math.floor(Date.now() / 86400_000) * 86400 - LOG_DAYS * 86400;
  const after = [new Date(since * 1000)];
  // floor: ::bigint rounds, so 13:59:59.7 would land on the next hour's row
  const hour = (col: string) => `extract(epoch FROM date_trunc('hour', ${col}))::bigint h, floor(extract(epoch FROM max(${col})))::bigint t`;
  const names = (r: { projects: (string | null)[] }) => (pub ? {} : { p: r.projects.filter((p) => p !== null).map(shortName) });
  const ingest = new Map<number, LogEntry>(); // one row per hour, t = last activity in it
  const at = (r: { h: string; t: string }) => {
    const e = ingest.get(Number(r.h)) ?? { t: 0, k: 'ingest' as const, c: {} };
    ingest.set(Number(r.h), e);
    e.t = Math.max(e.t, Number(r.t));
    return e;
  };
  // conversations: the Stop hook ingests live, so turn time ≈ import time. Counted per source like the graph's nodes:
  // subagent transcripts carry their own session ids, so count(DISTINCT session_id) read as dozens of "conversations"
  for (const r of (await db.query(`SELECT ${hour('turns.ts')}, count(DISTINCT s.id) FILTER (WHERE s.kind = 'main')::int sessions,
    count(DISTINCT s.id) FILTER (WHERE s.kind = 'subagent')::int subagents, count(*)::int turns, array_agg(DISTINCT turns.project) projects
    FROM turns JOIN sources s ON s.id = turns.source_id WHERE turns.ts > $1 AND s.tool <> ALL($2::text[]) GROUP BY 1`, [...after, [...PRIVATE_TOOLS]])).rows) {
    const e = Object.assign(at(r), names(r));
    Object.assign(e.c, { sessions: r.sessions, subagents: r.subagents, turns: r.turns });
  }
  for (const r of (await db.query(`SELECT ${hour('c.ts')}, count(*)::int n FROM chunks c JOIN sources s ON s.id = c.source_id
    WHERE c.ts > $1 AND s.tool <> ALL($2::text[]) GROUP BY 1`, [...after, ['obsidian', ...PRIVATE_TOOLS]])).rows) at(r).c.chunks = r.n;
  // notes: imported_at only moves when the file changed
  for (const r of (await db.query(`SELECT ${hour('imported_at')}, count(*)::int n FROM sources
    WHERE tool = 'obsidian' AND imported_at > $1 GROUP BY 1`, after)).rows) at(r).c.notes = r.n;
  const log = [...ingest.values()];
  // one MCP call = one INSERT = one now(), so distinct ts counts calls (a call logs a row per returned chunk)
  for (const r of (await db.query(`SELECT ${hour('ts')}, count(DISTINCT ts) FILTER (WHERE kind = 'search')::int searches,
    count(DISTINCT ts) FILTER (WHERE kind <> 'search')::int recalls, array_agg(DISTINCT project) projects
    FROM access_log WHERE ts > $1 GROUP BY 1`, after)).rows) {
    log.push({ t: Number(r.t), k: 'recall', c: { searches: r.searches, recalls: r.recalls }, ...names(r) });
  }
  for (const f of existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR) : []) {
    const file = join(RUNS_DIR, f);
    if (f.endsWith('.json') && statSync(file).mtimeMs / 1000 > since) log.push(...dreamLog(readFileSync(file, 'utf8'), since));
  }
  // local only: in the public JSON the previous publish time would change the rev, so every publish would redeploy
  const published = pub ? undefined : (await db.query(`SELECT v->>'at' t FROM state WHERE k = 'publish'`)).rows[0]?.t;
  if (published) log.push({ t: sec(published), k: 'publish', c: {} });
  return log.filter((e) => e.t > since).sort((a, b) => b.t - a.t).slice(0, LOG_MAX);
}

/** Live feed for viewers: stats + events since `since` + nodes active since then (+ their links). Same Brain shape. */
export function feedOf(b: Brain, since: number): Brain {
  const nodes = b.nodes.filter((n) => n.t1 >= since || n.type === 'project');
  const ids = new Set(nodes.filter((n) => n.type !== 'project').map((n) => n.id));
  return { ...b, nodes, links: b.links.filter((l) => ids.has(l.source) || ids.has(l.target)), events: b.events.filter((e) => e[0] >= since) };
}

/**
 * Last line of defence before publishing: the public JSON must not contain any real project/vault/note name,
 * session id, or path. Throws with the offending strings.
 */
export async function assertAnonymous(db: pg.Pool, json: string) {
  const rows = (await db.query(`SELECT DISTINCT unnest(ARRAY[project, session_id, path]) v FROM sources`)).rows;
  const needles = new Set<string>();
  for (const { v } of rows) {
    if (!v) continue;
    const s = String(v).toLowerCase();
    if (!isApp(s)) needles.add(s);
    // generic folder/file names, some also the public schema's own words (stats keys projects/sessions/subagents): not leaks;
    // nor are the app names (approved public; also archive folder names raw/codex, github/<owner>/<repo>, and files like CLAUDE.md)
    for (const part of s.split(/[\\/]/)) {
      const name = part.replace(/\.(md|jsonl)$/, '');
      if (part.length >= 6 && !isApp(name) && !/^(users|claude|projects|sessions|subagents|workflows|obsidian-vault|ai-archive)$/.test(part)) needles.add(name);
    }
  }
  // the log and dream are checked field by field instead: their own words (update, review...) would hit needles like notes/update.md
  const { log = [], dream, ...rest } = JSON.parse(json) as Partial<Brain>;
  const low = JSON.stringify(rest).toLowerCase();
  const leaks = [...needles].filter((n) => n.length >= 6 && low.includes(n));
  if (/"(label|text|title|path|session_id|project)":"(?![PV]\d+")/.test(json.replace(/"label":"[PV]\d+"/g, ''))) leaks.push('label/text field');
  if (!(rest.nodes ?? []).every((n) => n.a === undefined || isApp(n.a)) || !Object.keys(rest.apps ?? {}).every(isApp)) leaks.push('app name');
  // every GitHub node in the one shared hub: see hubOf (exact public commit times would name a project's alias)
  if (new Set((rest.nodes ?? []).filter((n) => n.a === 'github').map((n) => n.p)).size > 1) leaks.push('github node outside the GitHub hub');
  // Claude-only sources: counts only (see APPS); their node id would be the HMAC of 'source:<id>' (google-timeline has no n.a)
  const priv = new Set((await db.query(`SELECT id FROM sources WHERE tool = ANY($1::text[])`, [[...PRIVATE_TOOLS]])).rows
    .flatMap((r) => [`source:${r.id}`, pubId(`source:${r.id}`)]));
  if ((rest.nodes ?? []).some((n) => n.a === 'google' || priv.has(n.id))) leaks.push('Claude-only (Google) node');
  // log rows are counts only, under fixed counter names: fact text from a dream record would not match any needle
  const counters = new Set(['sessions', 'subagents', 'turns', 'chunks', 'notes', 'searches', 'recalls', ...DREAM_STATS]);
  const countsOnly = (e: LogEntry) => Object.keys(e).sort().join() === 'c,k,t' && Number.isInteger(e.t) && /^(ingest|recall|dream)$/.test(e.k)
    && e.c?.constructor === Object && Object.entries(e.c).every(([k, n]) => counters.has(k) && Number.isFinite(n));
  if (!(Array.isArray(log) && log.every(countsOnly))) leaks.push('log row');
  if (dream !== undefined && !countsOnly({ ...dream, k: 'dream' })) leaks.push('dream');
  if (leaks.length) throw new Error(`public brain leaks: ${leaks.slice(0, 5).join(', ')}`);
}
