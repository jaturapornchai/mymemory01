// MCP stdio server (user scope). Output is plain compact text, not JSON — fewer tokens for the calling model.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { connect } from './db.ts';
import { warmUp } from './embed.ts';
import { offsiteBackend, PRIVATE_TOOLS, privateOk } from './guard.ts';
import { canonicalProject, clean, normProject, projectName, resolveProjectChain } from './importer.ts';
import { redact } from './redact.ts';
import { aliasRe, conflictPairs, factTexts, type Flags, flagsFor, identityOf, locations, nearFacts, userSaid } from './accuracy.ts';
import { fmStr, isEdited, isGlobalFact, isHis, MEMORY_VAULT, noteFid, parseNote, saveNote } from './notes.ts';
import { day, HIDDEN, hitLine, isOtherProject, keepCmd, LABEL, layerOf, type Origin, origins, originText, place, privateLabel, projectCatalogue, search, SEARCH_KINDS, snippet, type Hit, unfamiliar, hiddenNameMask } from './search.ts';
import { type Assoc, associate, compete, proposals } from './synapse.ts';
import { normalize, queryTerms, words } from './thai.ts';
import { getTokens, timeline } from './timeline.ts';

const db = connect('ro');
// Desktop apps (LM Studio, Antigravity, ZCode…) may start us in their install dir or home: that is no project → global.
const NO_PROJECT = /^[a-z]:$|^[a-z]:\/(?:program files[^/]*|windows)(?:\/|$)|^[a-z]:\/users\/[^/]+(?:\/appdata(?:\/.*)?)?$/;
const toProject = (cwd: string) => ((p) => (NO_PROJECT.test(p) ? '' : p))(normProject(cwd));
const currentProject = toProject(process.cwd());
let canonProj: Promise<string> | null = null;
const getProject = () => (canonProj ??= currentProject ? canonicalProject(db, currentProject) : Promise.resolve(''));
const startedAt = new Date();
const session = `mcp-${process.pid}-${startedAt.getTime()}`; // one MCP process = one session of the calling AI app
// Freshness: search / timeline / related hide only the caller's own live session (its app's chunks in this project since server
// start), so what other apps did meanwhile is found at once. Gateway clients (GATEWAY below) have no live session in the index:
// they see everything (their own memory_save is found at once). Other unknown clients (e.g. a gateway serving many callers) keep the old rule: nothing
// newer than server start. own.project = the importer's unmapped normProject(cwd) (home/temp too), not currentProject.
const TOOL_OF: Record<string, string> = { 'claude-code': 'claude', 'claude-ai': 'claude', 'codex-mcp-client': 'codex',
  'gemini-cli-mcp-client': 'gemini', 'antigravity-client': 'antigravity', zcode: 'zcode', lmstudio: 'lmstudio', 'kimi-code': 'kimi', kimi: 'kimi' };
const ownProject = normProject(process.cwd());
const GATEWAY = new Set(['remote', 'claude-remote', 'chatgpt', 'web-claude-ai']);
const freshness = (): { before?: Date; own?: { since: Date; tool: string; project: string } } => GATEWAY.has(client()) ? {} : ((tool?: string) => tool ? { own: { since: startedAt, tool, project: ownProject } } : { before: startedAt })(TOOL_OF[client()]);
const internal = !!process.env.MEMORY_HUB_INTERNAL;           // eval / dream / tests: don't count as real use
const offsite = offsiteBackend();

/** Usage signal for ranking + brain, plus the call's latency (fire-and-forget: never slows or fails a tool call).
 *  call: tool = MCP tool or memory_get view (timeline/related log kind 'related'), t0 = performance.now() at the call's start, semantic = search only. */
// ponytail: a call with no rows (0 hits / not found) leaves no latency row; add a separate call log if those matter
function logAccess(kind: 'search' | 'get' | 'related', rows: { id: string; turn_uuid: string }[],
  call: { tool: string; t0: number; query?: string; semantic?: boolean; chars?: number }) {
  if (!rows.length || internal) return;
  const { tool, t0, query, semantic = null, chars = null } = call;
  db.query(
    `INSERT INTO access_log (kind, chunk_id, turn_uuid, rank, query, session, project, client, tool, ms, semantic, chars)
     SELECT $1, id, t, ord, $4, $5, $6, $7, $8, $9, $10, $11 FROM unnest($2::text[], $3::text[]) WITH ORDINALITY u(id, t, ord)`,
    [kind, rows.map((r) => r.id), rows.map((r) => r.turn_uuid), query ? clean(query).slice(0, 300) : null, session, currentProject, client(),
      tool, Math.round(performance.now() - t0), semantic, chars],
  ).catch(() => {});
}

// every tool reply passes here: rows indexed before a redact rule existed (or a sync that has not re-imported them yet) never leave raw
export const text = (t: string) => ({ content: [{ type: 'text' as const, text: redact(t).text }] });
const OFFSITE = `memory-hub is off in this session: its model backend (${offsite}) is not Anthropic and MEMHUB_ANTHROPIC_ONLY=1 is set.`;
/** Which AI app is calling (MCP clientInfo.name: claude-code, codex-mcp-client, gemini-cli-mcp-client, …). */
const client = () => server.server.getClientVersion()?.name ?? 'unknown';
/** Why memory is off for this caller, else null. MEMHUB_ANTHROPIC_ONLY=1 = Claude apps (claude-code, claude-ai) on Anthropic only. */
const off = () => offsite ? OFFSITE : process.env.MEMHUB_ANTHROPIC_ONLY === '1' && !/^claude/i.test(client())
  ? `memory-hub is off for ${client()}: MEMHUB_ANTHROPIC_ONLY=1 serves Claude apps only.` : null;
/** Tools this caller must not see (guard.privateOk): every tool reply leaves them out; a hidden id is "not found". */
const hidden = () => (privateOk(client()) ? [] : [...PRIVATE_TOOLS]);
const ID = z.string().regex(/^(?:[0-9a-f]{8,16}|[FSI][0-9a-f]{8})$/);
const FID = /^[FSI][0-9a-f]{8}$/;
const run = promisify(execFile);
/** SQL on facts f / sources s: a fact this caller may see: not a hidden tool's note, not dreamed from a hidden chat (lint.ts PUBLIC_FACT). */
const factVisible = (p: string) => `coalesce(s.hide_as, s.tool) <> ALL(${p}::text[]) AND NOT EXISTS (SELECT 1 FROM sources h WHERE h.session_id = ANY(f.session_ids) AND coalesce(h.hide_as, h.tool) = ANY(${p}::text[]))`;

/** Chunk for a search id (hex prefix) or a fact id (F/S/I + 8 hex); not one of the hidden tools' sources. */
async function chunkOf(id: string, hide: string[]) {
  const visible = `c.source_id NOT IN (${HIDDEN('$2')})`;
  return (await db.query(
    /^[FSI]/.test(id)
      ? `SELECT c.* FROM facts f JOIN chunks c ON c.source_id = f.source_id WHERE f.fid = $1 AND ${visible} ORDER BY c.seq_from, c.id LIMIT 1`
      : id.length === 16 ? `SELECT * FROM chunks c WHERE id = $1 AND ${visible}` // full id: the pkey (LIKE can't use it under en_US collation)
      : `SELECT * FROM chunks c WHERE id LIKE $1 || '%' AND ${visible} ORDER BY c.seq_from, c.id LIMIT 1`, [id, hide])).rows[0];
}

const server = new McpServer({ name: 'memory-hub', version: '0.2.0' }, {
  instructions:
    'memory-hub = ลุงจืด\'s long-term memory shared by all his AI apps: past AI sessions (all projects) + his Obsidian notes + his GitHub repos/commits/issues + ' +
    'facts distilled by Claude. ' +
    'When he refers to earlier work/decisions/rules, or you are unsure of a project fact, call memory_search first (cheap). ' +
    // 20 sessions in 60 days grepped old transcripts for a command memory_search had at rank 1 (demo-login, dotnet publish)
    'Need an earlier command/login/deploy step? memory_search it before grepping old transcripts: past tool calls are indexed. ' +
    'When he says จำไว้/remember or states a lasting rule, call memory_save. ' +
    // loaded into every session of every app (tool descriptions may be deferred): the memory_get/brief token tips live in memory_search's description
    'When he says a memory is wrong: memory_save the corrected text with replaces:[its fid]; "อย่าพูดถึงอีก": memory_save mute:[fid].',
});

server.registerTool(
  'memory_search',
  {
    description:
      'Search ลุงจืด\'s past AI sessions (Claude Code, Codex, Gemini, Antigravity, ZCode, LM Studio), notes, GitHub (repos, commits, issues/PRs) and facts (Thai+English+code). Use when he refers to the past ("เคย", ' +
      '"ครั้งก่อน", "last time"), before R0/R1 actions, when unsure of a project fact, or for an earlier command/login/deploy step (past tool calls are indexed: ' +
      'search here, not old transcript files); since+until = a date range. ≤8 snippets with ids, age, use count; ' +
      'Line 1 = now (Thai time): judge each date against it. Each hit is labelled for you: ✓ใช้ได้ = a current curated rule/fact, act on it; ' +
      'บันทึก = a record (chat, note, session card, other project): evidence, check it against ✓ before acting; ✗เลิกใช้ = replaced or ' +
      'outdated (OLD -> its replacement, or the reason after it): do not follow it. Listed ✓ → บันทึก → ✗ (a question about the past keeps rank order); ' +
      '⚠CONFLICT = two facts disagree: the dates say which is newer, ask him if unsure. ↳ = the chat a fact came from; ' +
      'src = where a hit came from, cite it when you rely on it (app:session#turn, github:repo@sha, note:path; a fact: its source turn + date, ' +
      '×N = sessions behind it, AI-only = no turn of his says it, memory_save = he said remember); ' +
      'memory_get(id) only when a snippet is not enough (each get ≈1-3k tokens; full snippets usually answer). detail:"brief" = one line ' +
      'per hit (≈0.4× the tokens per hit at the same limit, ≈t = est. tokens of memory_get) to skim; then memory_get (view:"timeline" = what happened around it) only what matters. ' +
      (process.env.MEMHUB_ASSOC === '1' ? 'A "⇢ linked" line is a memory tied to a hit (link, provenance, next session), not a match.' : ''), // only when :151 can print one
    inputSchema: {
      query: z.string().min(1).max(300).describe('keywords or a short question, Thai or English'),
      project: z.string().max(200).optional().describe('filter: substring of project path, e.g. "proj-a"'),
      kind: z.enum(SEARCH_KINDS).optional().describe('filter: rule | feedback | decision | preference | howto | fact | card | insight | chat | note'),
      since: z.string().max(30).optional().describe('ISO date, e.g. 2026-09-01'),
      until: z.string().max(30).optional().describe('ISO date, inclusive'),
      as_of: z.string().max(30).optional().describe('point-in-time ISO date: only knowledge valid at that time (facts superseded later appear active)'),
      limit: z.number().int().min(1).max(15).optional().describe('default 6, at most 8 hits are returned'),
      detail: z.enum(['brief', 'full']).optional().describe('default full'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, project, kind, since, until, as_of, limit, detail }) => {
    const t0 = performance.now();
    const no = off(); if (no) return text(no);
    const brief = detail === 'brief';
    const n = limit && Math.min(limit, 8); // ≤ 8 hits in both modes; default = search()'s 6
    const filters = { project, kind, since, until, asOf: as_of, ...freshness() };
    const curProj = await getProject();
    const scopeProj = project ? undefined : curProj;
    const res = await search(db, query, { ...filters, limit: n, currentProject: curProj, now: new Date(), showPrivate: privateOk(client()) });
    const { semantic } = res;
    // Synapse competition (MEMHUB_COMPETE=0 turns it off): 1-hop graph neighbours of the top 6 compete with results 7..n for
    // those slots (no extra lines). Fresh N1b holdout: linked answer visible 13.5 → 22.4 % vs plain limit 8 (+22 −1), shuffled
    // graph no gain; detail set −3 net (n.s.). docs/decisions/0004
    const hits = process.env.MEMHUB_COMPETE !== '0' && n > 6 && res.hits.length > 0 && res.qvec
      ? compete(res.hits, await proposals(db, res.hits, res.qvec, { hide: hidden(), filters, theta: Number(process.env.MEMHUB_COMPETE_THETA ?? 0.05), pool: Number(process.env.MEMHUB_COMPETE_POOL ?? 16), currentProject: scopeProj, query })
        .catch(() => ({ props: [], sims: new Map<string, number>() })), { n, theta: Number(process.env.MEMHUB_COMPETE_THETA ?? 0.05), bonus: Number(process.env.MEMHUB_COMPETE_BONUS ?? 0.3), currentProject: scopeProj, query })
      : res.hits;
    // an old name of this project in the query ("BC Ai" in a renamed repo) = what the repo is comes first, whatever ranked
    const [id, loc] = await Promise.all([curProj ? resolveProjectChain(db, curProj).then((c) => identityOf(db, c, hidden())).catch(() => null) : null,
      locations(db, query, hidden()).catch(() => '')]);
    if (id?.fid && !kind && id.aliases.some((a) => aliasRe(a).test(query))) {
      const at = hits.findIndex((h) => h.fid === id.fid && h.kind !== 'card');
      const top = at >= 0 ? hits.splice(at, 1)[0] : (await db.query(`SELECT c.id, c.turn_uuid, c.ts, c.project, c.session_id, c.ctx_header header, c.text,
          s.status, s.tool, s.kind src_kind, 0 uses, NULL::timestamptz last, f.fid, f.kind, f.project fact_project, f.superseded_by, f.review_target,
          NULL::text[] changed_to, NULL::text[] ev_of FROM facts f JOIN chunks c ON c.source_id = f.source_id JOIN sources s ON s.id = f.source_id
          WHERE f.fid = $1 ORDER BY c.seq_from, c.id LIMIT 1`, [id.fid])).rows[0];
      if (top) { hits.unshift({ ...top, score: hits[0]?.score ?? 1 }); if (at < 0 && hits.length > (n ?? 6)) hits.pop(); }
    }
    const ids = hits.map((h) => h.id); // origins after ranking: a citation never moves a hit; a failed lookup only drops the src parts
    const [og, cost, mask, flags] = await Promise.all([origins(db, ids, hidden()).catch(() => new Map<string, Origin>()), brief ? getTokens(db, ids) : undefined,
      hiddenNameMask(db, hidden()), flagsFor(db, hits.map((h) => ({ key: h.id, fid: h.kind !== 'card' ? h.fid : null, turn: h.turn_uuid,
        project: h.fact_project || h.project, ts: h.ts, text: h.text })), hidden()).catch(() => new Map<string, Flags>())]);
    for (const h of hits) { const f = flags.get(h.id); if (f) { h.flags = f.tags; h.notes = f.lines; } }
    // mask before passage(): its window may start inside a hidden note's [[id title]], after the id the output mask needs
    for (const h of hits) for (const x of [h, ...(h.evidence ?? [])]) x.text = mask(x.text);
    const parts = [brief ? briefText(hits, query, semantic, cost!, og, scopeProj) : searchText(hits, query, semantic, og, scopeProj)];
    // metamemory "ไม่รู้": measured unfiltered and with a project filter (holdout: 0.6 % wrong); a date range never was
    if (hits.length && !loc && !since && !until && !as_of && !kind && unfamiliar(res.signal)) parts.unshift(UNFAMILIAR_HEAD);
    if (loc) parts.unshift(loc); // "X อยู่ไหน": the paths/repos tool calls named, before the hits
    parts.unshift(nowLine()); // ลุงจืด 2026-10-18 "ควรมีวัน เวลา ai จะได้เข้าใจ": ages and dates are read against it
    const linked = process.env.MEMHUB_ASSOC === '1' && hits.length ? await associate(db, hits.slice(0, 3).map((h) => ({ chunkId: h.id, a: h.score / hits[0].score })),
      { hide: hidden(), exclude: hits.flatMap((h) => [h.id, ...(h.evidence ?? []).map((e) => e.id)]), filters, currentProject: scopeProj, query }).catch(() => []) : [];
    for (const r of linked) r.chunk.text = mask(r.chunk.text);
    if (linked.length) parts.push(assocText(linked, query, scopeProj));
    const out = mask(parts.join(brief ? '\n' : '\n\n'));
    logAccess('search', hits, { tool: 'search', t0, query, semantic, chars: out.length });
    return text(out);
  },
);

/** The id a reply prints for a row: the fact id for a fact, else the chunk id. */
const idOf = (h: { id: string; fid: string | null; kind: string | null }) => (h.fid && h.kind !== 'card' ? h.fid : h.id);
const whatOf = (h: Pick<Hit, 'kind' | 'tool' | 'project' | 'session_id' | 'src_kind'>) => h.kind ?? (PRIVATE_TOOLS.has(h.tool) ? privateLabel(h)
  : h.project?.startsWith('obsidian/') ? (h.src_kind === 'daily' ? 'daily note' : 'note') : h.tool === 'github' ? 'github'
  : h.src_kind === 'main' ? h.tool : `${h.tool} ${h.src_kind}`);

// '⇢ linked' = a memory tied to the hits through the synapse graph (wiki link, fact provenance, subagent, next session, co-use),
// not a search hit: `⇢ linked [id] 2026-09-12 proj-a codex · via [hit id] prov→next: passage`, ≤ 220 chars.
// memory_get view:"related" lists them without the prefix and the via (always the id asked about).
const ASSOC_LINE = 220;
function assocLine(r: Assoc, query: string, inSearch = true, currentProject?: string): string {
  const c = r.chunk, fact = c.fid && c.kind !== 'card';
  const proj = projectName(c.fact_project ?? c.project ?? '') || 'global';
  const outTag = isOtherProject(c, currentProject, query) ? `นอกโปรเจกต์ (เคยคุยใน "${proj}"): ` : '';
  const head = `${inSearch ? '⇢ linked ' : ''}[${idOf(c)}] ${day(c.ts)} ${proj} ${whatOf(c)}` +
    `${c.status === 'superseded' ? ' OLD' : ''} · ${inSearch ? `via [${r.via}] ` : ''}${r.kind}: ${outTag}`;
  return (head + passage(fact ? factBody(c.text) : c.text, fact ? '' : query, Math.max(40, Math.min(180, ASSOC_LINE - head.length - 2)))).slice(0, ASSOC_LINE);
}
/** memory_search's linked lines — exported so scripts/eval.ts measures exactly what the calling model reads. */
export const assocText = (rows: Assoc[], query: string, currentProject?: string) => rows.map((r) => assocLine(r, query, true, currentProject)).join('\n');

// A fact with its source chat (↳): the fact gets ≤ this, the ↳ line the rest of the 400 chars of one result.
// eval tune: 250 kept the most question terms visible in the gold entry (200/300 lost some; chars equal).
const FACT_EV_CHARS = 250;
const PROV = 6; // memory_get(fact): cited turns shown in full (max cited today: 11 for a fact, 24 for a card); the rest as src ids
/** A GitHub turn's permalink (commit, issue/PR — /issues/N redirects to a PR —, comment, repo) on its own line; '' otherwise. */
const ghUrl = (uuid: string) => {
  const m = /^github:([\w.-]+\/[\w.-]+)(?:@([0-9a-f]{7,40})|#(\d+)(?:\/c(\d+))?)?$/.exec(uuid);
  return m ? `\nhttps://github.com/${m[1]}${m[2] ? `/commit/${m[2]}` : m[3] ? `/issues/${m[3]}${m[4] ? `#issuecomment-${m[4]}` : ''}` : ''}` : '';
};
// Fact note chunk = 'D: # F<id> <title>' (title = the body's first words) + body + wiki links '- from:: [[…]]' → body only.
const factBody = (t: string) => t.replace(/^D: # [FSI][0-9a-f]{8}[^\n]*\n?/, '').replace(/^\s*- [a-z_]+::.*\[\[.*$/gm, ''); // link lines (from::, related::, review:: UPDATE [[…]]) = metadata

/** memory_search's first line when search.ts unfamiliar(): the hits are near misses, not an answer (ลุงจืด: ถ้าไม่รู้ก็บอกไม่รู้ ห้ามเดา). */
export const UNFAMILIAR_HEAD = 'ไม่รู้ (not in memory): nothing stored matches this query. Tell the user memory has no record of it; do not answer from ' +
  'the near misses below unless one clearly is the thing asked.';

/** memory_search's first line: the calling model's clock may be off or absent, and every date shown is Thai time. */
export const nowLine = (d = new Date()) => `ตอนนี้ ${d.toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 16)} (เวลาไทย)`;

/** memory_search reply text — exported so scripts/eval.ts measures exactly what the calling model reads. */
export function searchText(hits: Hit[], query: string, semantic: boolean, og?: Map<string, Origin>, currentProject?: string): string {
  if (!hits.length) return semantic ? 'no matches' : 'no matches (keyword-only: embedder busy)';
  const max = budgets(hits.length);
  return (semantic ? '' : '(keyword-only: embedder busy)\n') + hits.map((h, i) => hitText(h, query, max[i], og?.get(h.id), currentProject) + notes(h)).join('\n\n');
}

/** Chars per result: 400 each, but rank 1 +300 and rank 2 +100, paid evenly by ranks ≥ 3 (≥ 200 each); total unchanged.
 *  eval tune, frozen ranking: buried-detail answer terms visible (fine.json ans@w) 68.0 → 76.0, raw 67.9 → 68.8, chars −1 %. */
function budgets(n: number): number[] {
  const max = Array<number>(n).fill(400);
  if (n < 3) return max;
  const pool = Math.min(400, (n - 2) * 200), first = Math.round((pool * 3) / 4);
  max[0] += first; max[1] += pool - first;
  for (let i = 2; i < n; i++) max[i] -= Math.ceil(pool / (n - 2));
  return max;
}

/** snippet() for the caller: the same anchor (longest query word found) and window, but at the anchor's occurrence whose window
 *  holds the most DISTINCT query terms (ties → the first = snippet() exactly), so a detail next to several query words beats a
 *  passing first mention. eval tune with budgets(): fine ans@w 76.0 → 80.0 (Thai questions +1), raw 68.8 → 69.0; windows over
 *  any term: fine 78.7 but Thai −10, length-weighted 80.3 but Thai −5 (IDF-weighted −0.9, two windows −1.9 earlier). */
// ponytail: O(anchor hits × term hits) per text; fine for chunk-sized texts, cap the hit lists if huge chunks ever show in latency
function passage(text: string, query: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max || !query) return snippet(text, query, max);
  const low = normalize(flat), occ: { i: number; k: string }[] = [];
  for (const { key: k } of queryTerms(query)) for (let i = low.indexOf(k); i >= 0; i = low.indexOf(k, i + 1)) occ.push({ i, k });
  const anchor = words(query).sort((a, b) => b.length - a.length).find((t) => low.includes(t));
  let best = 0, most = -1, bestAt = 0;
  for (let i = anchor ? low.indexOf(anchor) : -1; i >= 0; i = low.indexOf(anchor!, i + 1)) {
    const s = Math.max(0, Math.min(i - Math.floor(max / 4), flat.length - max));
    const n = new Set(occ.filter((p) => p.i >= s && p.i + p.k.length <= s + max).map((p) => p.k)).size;
    if (n > most) { most = n; best = s; bestAt = i; }
  }
  const [s, e] = keepCmd(text, flat.length, bestAt, best, max);
  return (s > 0 ? '…' : '') + flat.slice(s, e) + (e < flat.length ? '…' : '');
}

/** One result: line + passage (a fact from its head), then its best source chat (↳) in the rest of its `max` chars.
 *  More source chats are only counted (+N): memory_get(fact id) lists its provenance. */
export function hitText(h: Hit, query: string, max = 400, o?: Origin, currentProject?: string): string {
  const [e, ...more] = h.evidence ?? [];
  const fact = h.fid && h.kind !== 'card';
  const text = fact ? factBody(h.text) : h.text, q = fact ? '' : query;
  if (isOtherProject(h, currentProject, query)) {
    const proj = projectName(h.fact_project ?? h.project ?? '') || (h.fact_project ?? h.project);
    return `${hitLine(h, undefined, o)} | นอกโปรเจกต์\nเคยคุยในโปรเจกต์ "${proj}" (${day(h.ts)}, ${whatOf(h)}): ${passage(text, q, 140)}`;
  }
  if (!e) return `${hitLine(h, undefined, o)}\n${passage(text, q, max)}`;
  // a source chat whose decision a later fact replaced keeps the warning it has as a result of its own (not when that fact is h)
  const later = e.changed_to?.filter((f) => f !== h.fid) ?? [];
  const ev = `\n↳ source chat [${e.id}] ${day(e.ts)}${later.length ? ` (superseded by [${later.join('] [')}]: later changed)` : ''}` +
    `${more.length ? ` +${more.length} more` : ''}: `;
  // the ↳ header is sized first, so a long one (changed_to ids, +N) shortens the fact, not the total: body + ev + chat ≤ max
  const body = passage(text, q, Math.max(60, Math.min(Math.round((FACT_EV_CHARS * max) / 400), max - ev.length - 60)));
  return `${hitLine(h, undefined, o)}\n${body}${ev}${passage(e.text, query, Math.max(60, max - body.length - ev.length))}`;
}

// brief = progressive disclosure: same hits and order as full, one line each, gist last so the line cap only shortens the gist
export const BRIEF_LINE = 200;
const BRIEF_HEAD = 'brief: ≈t = est. tokens of memory_get(id); memory_get view:"timeline" = what happened around it';

/** memory_search detail:"brief" text. cost = getTokens() of the hits' chunk ids. */
export function briefText(hits: Hit[], query: string, semantic: boolean, cost: Map<string, number>, og?: Map<string, Origin>, currentProject?: string): string {
  if (!hits.length) return searchText(hits, query, semantic);
  return (semantic ? '' : '(keyword-only: embedder busy)\n') + `${BRIEF_HEAD}\n` + hits.map((h) => briefLine(h, query, cost, og?.get(h.id), currentProject) + notes(h)).join('\n');
}
/** flagsFor lines under a hit: the fact it contradicts, his note, the old-name note (a passage cap never cuts them). */
const notes = (h: Hit) => (h.notes?.length ? `\n${h.notes.join('\n')}` : '');

/** `[id] 2026-09-12 proj-a codex subagent src codex:1a2b3c4d#7 ≈850t ↳[source chat id]: gist` — OLD / PENDING / changed
 *  warnings kept from hitLine; src only when given (origins()). */
export function briefLine(h: Hit, query: string, cost: Map<string, number>, o?: Origin, currentProject?: string): string {
  const fact = h.fid && h.kind !== 'card', what = whatOf(h);
  const flag = h.status === 'superseded' ? ` OLD -> [${h.superseded_by ?? '?'}]` : h.status === 'pending' ? ` PENDING vs [${h.review_target ?? '?'}]`
    : h.changed_to ? ` (superseded by [${h.changed_to.join('] [')}])` : '';
  const tags = h.flags?.length ? ` [${h.flags.join(' · ')}]` : '';
  const ev = h.evidence?.length ? ` ↳[${h.evidence[0].id}]${h.evidence.length > 1 ? `+${h.evidence.length - 1}` : ''}` : '';
  // brief = cheap: the src tag names the app/kind of a raw hit (what is dropped) and a fact's tag goes without date / ×N
  const src = o ? ` src ${o.tag}${o.ai ? ' AI-only' : ''}` : '';
  const proj = projectName(h.fact_project ?? h.project ?? '') || 'global';
  const outTag = isOtherProject(h, currentProject, query) ? `นอกโปรเจกต์ (เคยคุยใน "${proj}"): ` : '';
  const head = `[${idOf(h)}] ${day(h.ts)} ${proj} ${LABEL[h.layer ?? layerOf(h)]}${o && !h.kind ? '' : ` ${what}`}${flag}${h.why ? ` (${h.why})` : ''}${tags}${src}` +
    ` ≈${cost.get(h.id) ?? '?'}t${ev}: ${outTag}`;
  return (head + passage(fact ? factBody(h.text) : h.text, fact ? '' : query, 100)).slice(0, BRIEF_LINE);
}

server.registerTool(
  'memory_get',
  {
    description: 'A memory_search hit (or fact id like F3fa2c1d0). view "text" (default): full text plus surrounding turns / fact provenance ' +
      '(its source turns with src ids, his first) and GitHub permalinks. "timeline": what happened around it — rounds before/after in its ' +
      'session, facts/cards from that session, the same project in other sessions/apps near then; one line each, ≈t = est. tokens of a ' +
      'text get, ≤1500 chars; a fact id centres on the chat it came from. "related": [[links]], backlinks, facts from the same session, ' +
      'memories used together, synapse-linked (≤2 hops) and most similar — to follow a thread.',
    inputSchema: {
      id: ID.describe('id from memory_search / memory_get'),
      view: z.enum(['text', 'timeline', 'related']).optional().describe('default text'),
      around: z.number().int().min(0).max(10).optional().describe('turns (text, default 1) / rounds (timeline, default 3) before+after'),
      max_chars: z.number().int().min(500).max(20000).optional().describe('text: default 6000'),
      limit: z.number().int().min(1).max(8).optional().describe('related: similar items (default 5)'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ id, view = 'text', around, max_chars = 6000, limit = 5 }) => {
    const t0 = performance.now();
    const no = off(); if (no) return text(no);
    const hide = hidden();
    const c = await chunkOf(id, hide);
    if (!c) return text(`not found: ${id}`);
    const mask = await hiddenNameMask(db, hide); // names of notes hidden from this caller inside visible text
    if (view === 'related') return text(mask(await related(c, hide, limit, t0)));
    if (view === 'timeline') {
      const fr = freshness();
      // the resolved full id (a fact id stays: timeline centres on its chat), so timeline() never re-resolves a short prefix
      const t = await timeline(db, /^[FSI]/.test(id) ? id : c.id, { before: around, after: around, until: fr.before, own: fr.own, hide });
      if (!t) return text(`not found: ${id}`);
      const out = mask(t.text);
      logAccess('related', [t.hit], { tool: 'timeline', t0, chars: out.length }); // exploring around it = a recall, like view related
      return text(out);
    }
    around ??= 1;
    const [turns, og] = await Promise.all([db.query(
      `SELECT uuid, seq, role, ts, text_redacted FROM turns WHERE source_id = $1 AND seq BETWEEN $2 AND $3 ORDER BY seq`,
      [c.source_id, c.seq_from - around, c.seq_to + around],
    ).then((r) => r.rows), origins(db, [c.id], hide).catch(() => new Map<string, Origin>())]);
    let body = turns.map((t) => `${t.role === 'user' ? 'U' : t.role === 'assistant' ? 'A' : t.role[0].toUpperCase()}: ${t.text_redacted}${ghUrl(t.uuid)}`).join('\n\n');
    const f = (await db.query(
      `SELECT f.*, s.status FROM facts f JOIN sources s ON s.id = f.source_id WHERE f.source_id = $1`, [c.source_id])).rows[0];
    if (f) { // a fact/card note: its validity and where it came from — his words first, ≤ PROV turns in full, the rest as src ids
      const prov = (await db.query(
        `SELECT t.uuid, t.seq, t.role, t.ts, s.tool, s.kind, s.session_id, s.path, t.source_id, left(t.text_redacted, 240) txt
         FROM turns t JOIN sources s ON s.id = t.source_id WHERE t.uuid = ANY($1) AND t.uuid NOT LIKE 'obs:%'
         AND coalesce(s.hide_as, s.tool) <> ALL($2::text[]) ORDER BY t.role = 'user' DESC, t.ts, t.seq`, [f.source_uuids, hide])).rows;
      const src = (p: Record<string, any>) => place(p.tool, p.kind, p.session_id, p.path, p.seq, p.uuid);
      const shown = prov.slice(0, PROV).sort((a, b) => +a.ts - +b.ts), rest = prov.slice(PROV), n = new Set(prov.map((p) => p.source_id)).size;
      const from = f.source_uuids.every((u: string) => u.startsWith('obs:')) ? '\n\nfrom: memory_save (he asked to remember it)'
        : prov.length ? `\n\nfrom (${prov.length} turn${prov.length > 1 ? 's' : ''}, ${n} session${n > 1 ? 's' : ''}${prov.some((p) => p.role === 'user') ? '' : ', AI-only'}):\n` +
          shown.map((p) => `${p.role === 'user' ? 'U' : 'A'} ${day(p.ts)} ${src(p)}: ${p.txt}`).join('\n') +
          (rest.length ? `\n+${rest.length} more: ${rest.slice(0, 10).map(src).join(' ')}` : '') : '';
      body = `${f.fid} ${f.kind} ${f.status ?? 'active'} · valid: ${day(f.valid_at)} → ${f.invalid_at ? day(f.invalid_at) : 'present'}` +
        (f.superseded_by ? ` · superseded by [${f.superseded_by}]` : '') + (f.review_target ? ` · review vs [${f.review_target}]` : '') +
        `\n\n${body}${from}`;
    }
    const o = og.get(c.id);
    const out = `${c.ctx_header} | session ${c.session_id} | ${c.project}${o ? ` | ${originText(o)}` : ''}\n\n${body || c.text}`;
    const reply = mask(out.length > max_chars ? out.slice(0, max_chars) + `\n…[cut at ${max_chars}; raise max_chars or around=0]` : out);
    logAccess('get', [c], { tool: 'get', t0, chars: reply.length });
    return text(reply);
  },
);

/** memory_get view:"related": brain-style links of a visible chunk (from chunkOf). */
async function related(c: Record<string, any>, hide: string[], limit: number, t0: number): Promise<string> {
  const first = '(SELECT min(id) FROM chunks WHERE source_id = s.id)';
  // fan-normalised order (ACT-R S − ln fan, HippoRAG 1/|P|): a link to a specific note before one into a hub
  const fan = `greatest(1, (SELECT count(*) FROM links x WHERE x.src_id = s.id OR x.dst_id = s.id) + (SELECT count(*) FROM edges x WHERE x.a = s.id OR x.b = s.id))`;
  const q = async (sql: string, p: unknown[]) => (await db.query(sql, p)).rows;
  const fresh = freshness(), own = fresh.own;
  const [out, back, prov, together, similar] = await Promise.all([
    q(`SELECT l.dst_name name, ${first} cid FROM links l LEFT JOIN sources s ON s.id = l.dst_id WHERE l.src_id = $1 AND coalesce(s.hide_as, s.tool, '') <> ALL($2::text[])
       ORDER BY s.id IS NULL, ${fan}, 1`, [c.source_id, hide]),
    q(`SELECT s.session_id name, ${first} cid FROM links l JOIN sources s ON s.id = l.src_id WHERE l.dst_id = $1 AND coalesce(s.hide_as, s.tool) <> ALL($2::text[])
       ORDER BY ${fan}, 1`, [c.source_id, hide]),
    // provenance both ways: facts/cards distilled from this chat session, or the chat sessions a fact came from
    q(`SELECT f.fid || ' ' || f.kind || ' ' || coalesce(s.status, 'active') || ': ' || regexp_replace(s.session_id, '^.*/|[.]md$', '', 'g') name, ${first} cid
       FROM facts f JOIN sources s ON s.id = f.source_id WHERE $1 = ANY(f.session_ids) AND f.source_id <> $2 AND ${factVisible('$3')}
       UNION ALL
       SELECT 'session ' || s.session_id || ' (' || s.project || ')', ${first}
       FROM facts f JOIN sources s ON s.kind = 'main' AND s.session_id = ANY(f.session_ids) WHERE f.source_id = $2 AND coalesce(s.hide_as, s.tool) <> ALL($3::text[])
       LIMIT 8`, [c.session_id, c.source_id, hide]),
    q(`SELECT coalesce(s.session_id, '') || ' (' || coalesce(s.project, '') || ') w=' || round(e.w::numeric, 2) name, ${first} cid
       FROM edges e JOIN sources s ON s.id = CASE WHEN e.a = $1 THEN e.b ELSE e.a END
       WHERE e.kind = 'coaccess' AND (e.a = $1 OR e.b = $1) AND coalesce(s.hide_as, s.tool) <> ALL($2::text[]) ORDER BY e.w / ${fan} DESC, 1`, [c.source_id, hide]),
    q(`SELECT c2.id, c2.ts, c2.project, c2.text FROM chunks c2
       WHERE c2.source_id <> $1 AND c2.embedding IS NOT NULL AND c2.source_id NOT IN (${HIDDEN('$5')})
         AND ($3::timestamptz IS NULL OR c2.ts < $3) -- freshness as memory_search: hide the own live session (search.ts OWN) or all after start
         AND ($6::timestamptz IS NULL OR c2.ts < $6 OR c2.project IS DISTINCT FROM $7::text OR c2.source_id NOT IN (SELECT id FROM sources WHERE tool = $8::text))
       ORDER BY c2.embedding <=> (SELECT embedding FROM chunks WHERE id = $2) LIMIT $4`,
      [c.source_id, c.id, fresh.before ?? null, limit, hide, own?.since ?? null, own?.project ?? null, own?.tool ?? null]),
  ]);
  const listed = [c.id, ...[out, back, prov, together].flat().map((r) => r.cid), ...similar.map((h) => h.id)].filter(Boolean);
  const linked = await associate(db, [{ chunkId: c.id, sourceId: Number(c.source_id), a: 1 }],
    { hide, exclude: listed, filters: fresh, limit: 5, theta: 0.05 }).catch(() => []);
  const fmt = (r: { name: string; cid: string | null }) => (r.cid ? `[${r.cid}] ${r.name}` : `${r.name} (no note yet)`);
  const cap = (rows: string[]) => rows.slice(0, 8).join('\n') + (rows.length > 8 ? `\n+${rows.length - 8} more` : '');
  const parts: string[] = [];
  if (out.length) parts.push('links →\n' + cap(out.map(fmt)));
  if (back.length) parts.push('backlinks ←\n' + cap(back.map(fmt)));
  if (prov.length) parts.push('same session ⇢\n' + prov.map(fmt).join('\n'));
  if (together.length) parts.push('used together ⇄\n' + cap(together.map(fmt)));
  if (linked.length) parts.push('linked ⇢\n' + linked.map((r) => assocLine(r, '', false)).join('\n'));
  logAccess('related', [c], { tool: 'related', t0 });
  if (similar.length) parts.push('similar ≈\n' + similar.map((h) => `[${h.id}] ${day(h.ts)} ${projectName(h.project ?? '')}: ${snippet(factBody(h.text), '', 160)}`).join('\n'));
  return parts.join('\n\n') || 'no related memories';
}

server.registerTool(
  'memory_save',
  {
    description:
      'Remember something across ALL future sessions (a fact note in the memory-hub Obsidian vault, owned by ลุงจืด). Use when he ' +
      'says "จำไว้"/"remember this" or states a lasting rule, decision or preference. Self-contained text; secrets are redacted. ' +
      'Never copy Gmail / Google Docs / Maps timeline text into it: those are Claude-only, saved notes reach every app. ' +
      'He says a memory is wrong → save the corrected text with replaces:[old fid] (from memory_search / session start): the old ' +
      'one is marked OLD at once; his own notes go to his review queue instead. He says "อย่าพูดถึงอีก"/stop bringing it up → ' +
      'mute:[fid] (content not needed): never shown at session start again, still searchable; mute:["-<fid>"] = unmute. ' +
      'A near-duplicate of an existing fact is NOT saved: the reply names it — merge into it with replaces:[fid] (the merged text), ' +
      'or send confirm_new:true if it is really a new claim. He typed the correction himself in this chat → pass his words as ' +
      'user_quote: replaces then takes effect at once, even on his own notes (no review queue).',
    inputSchema: {
      content: z.string().min(1).max(4000).optional().describe('the fact/decision/rule, self-contained, in his language (omit only for a mute-only call)'),
      title: z.string().max(80).optional().describe('short note title'),
      kind: z.enum(['rule', 'preference', 'decision', 'fact', 'howto']).optional().describe('default fact'),
      global: z.boolean().optional().describe('applies to all projects (default: this project)'),
      replaces: z.array(z.string().regex(FID)).max(10).optional().describe('fids this corrects: they stop counting as current'),
      mute: z.array(z.string().regex(/^-?[FSI][0-9a-f]{8}$/)).max(20).optional().describe('fids to keep out of session start; "-<fid>" = unmute'),
      user_quote: z.string().max(500).optional().describe("his exact words in this chat that ask for the change (verified against the chat log)"),
      confirm_new: z.boolean().optional().describe('save even though a near-duplicate exists (it is a different claim)'),
    },
  },
  async ({ content, title, kind, global, replaces = [], mute = [], user_quote, confirm_new }) => {
    const no = off(); if (no) return text(no);
    // zod drops unknown keys: {text: …} arrives as nothing at all, so name the real ones
    if (!content && !mute.length) return text('nothing to do: memory_save takes content (the text to remember — not text/fact/note/memory), ' +
      'plus optional title, kind, global, replaces, mute, user_quote, confirm_new');
    const hide = hidden();
    const want = [...new Set([...replaces, ...mute.map((m) => m.replace(/^-/, ''))])];
    const seen = new Map(want.length ? (await db.query( // a fid this app may not see (Claude-only) = not found, as in memory_get
      `SELECT f.fid, f.user_owned OR f.edited his, s.path, s.status FROM facts f JOIN sources s ON s.id = f.source_id
       WHERE f.fid = ANY($1) AND ${factVisible('$2')}`, [want, hide])).rows.map((r) => [r.fid, r]) : []);
    const out: string[] = [];
    const proj = content ? await getProject() : '';
    const isGlobal = !proj || (global ?? isGlobalFact(content ?? '', title)); // no cwd: a project fact has nowhere to go
    const body = clean(content ?? '').trim(), fid = noteFid(content ?? '');
    // a near-duplicate waits for the caller to say which: replaces (merge into it) or confirm_new (a different claim)
    const near = content && !replaces.length && !confirm_new ? await nearFacts(db, body, isGlobal ? '' : proj, hide, [fid], { n: 3 }) : [];
    if (near.length) out.push(`ยังไม่บันทึก: มีความจำที่คล้ายกันอยู่แล้ว`, ...near.map((x) => `คล้าย [${x.fid}] ${x.txt} — ใช้ replaces:[${x.fid}] เพื่อแทน/รวม?`),
      'ถ้าเป็นเรื่องใหม่จริง ส่งซ้ำพร้อม confirm_new:true');
    // he typed it himself (checked against the chat log, not taken on the caller's word) = his correction takes effect now
    const said = !!(content && !near.length && user_quote && replaces.length) && await userSaid(db, user_quote!);
    if (user_quote && replaces.length && !near.length && !said) out.push('user_quote: ไม่พบข้อความนี้ในแชทที่ลุงจืดพิมพ์ (2 วันล่าสุด / แชทที่เปิดอยู่) — ใช้ flow รออนุมัติตามเดิม');
    if (content && !near.length) {
      const vault = MEMORY_VAULT.replace(/\\/g, '/') + '/';
      const sup: { fid: string; rel: string }[] = [], review: string[] = [], old: string[] = [];
      for (const r of replaces.map((x) => seen.get(x)).filter((r) => r && r.fid !== fid)) {
        const path = String(r.path).replace(/\\/g, '/');
        const n = path.startsWith(vault) && existsSync(path) ? parseNote(readFileSync(path, 'utf8')) : null;
        // only a current note is replaced: an OLD one keeps its superseded_by chain (the file wins over a stale index)
        const st = n ? fmStr(n.fm.status) : r.status ?? '';
        if (st && st !== 'active') { old.push(`[${r.fid}] ${st}`); continue; }
        // the machine rewrites only its own notes; his (the dream's isHis, read from the file: a pin/edit not indexed yet
        // counts; other vaults) go to the existing review path
        // his user_quote reaches his notes too, but never one he edited by hand (writeNote keeps those)
        if (n && ((!r.his && !isHis(n.fm, n.body)) || (said && !isEdited(n.fm, n.body)))) sup.push({ fid: r.fid, rel: path.slice(vault.length) }); else review.push(r.fid);
      }
      const now = new Date();
      const rel = saveNote(content, { title, kind, global: isGlobal, project: proj, client: client(), now, supersede: sup.map((x) => x.rel), review: review[0],
        ...(said ? { activate: !review.length, extra: { user_quote: user_quote!.slice(0, 300), quoted_at: now.toISOString() }, reindex: false } : {}) });
      if (said && !process.env.MEMHUB_NO_REINDEX) await run(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'index-vault', MEMORY_VAULT],
        { env: { ...process.env, MEMORY_HUB_INTERNAL: '1' }, windowsHide: true, timeout: 120_000 }); // rw child; a search right after sees the new note
      // saveNote decides: pending (his note to review) supersedes nothing yet; the same text already active stays active
      const pending = fmStr(parseNote(readFileSync(join(MEMORY_VAULT, rel), 'utf8')).fm.status) === 'pending';
      const ids = (xs: string[]) => xs.map((x) => `[${x}]`).join(' ');
      out.push(`saved: ${rel} (${pending ? 'pending: waits for his approval' : 'searchable in new sessions'})`);
      if (sup.length) out.push(pending ? `ยังไม่แทน ${ids(sup.map((x) => x.fid))}: โน้ตใหม่ยังรออนุมัติ — อนุมัติแล้วส่งข้อความเดิมพร้อม replaces อีกครั้ง`
        : `replaced (now OLD): ${ids(sup.map((x) => x.fid))}`);
      if (review.length) out.push(!pending ? `${ids(review)}: ไม่ได้เสนอแทน — ข้อความนี้เป็นโน้ต active อยู่แล้ว`
        : `[${review[0]}] เป็นโน้ตของลุงจืด: ไม่แก้ไฟล์ให้ — โน้ตใหม่เป็น pending รอลุงจืดอนุมัติ (คิว hubs/_review.md อัปเดตตอนกลางคืน; ตั้ง status: active = แทน [${review[0]}])` +
        (review.length > 1 ? `; ยังไม่ได้เสนอแทน ${ids(review.slice(1))}: เสนอได้ทีละโน้ต` : ''));
      if (old.length) out.push(`already OLD, left as is: ${old.join(' · ')}`);
      if (said) out.push(`user_quote ตรงกับที่ลุงจืดพิมพ์: มีผลทันที${sup.length ? '' : ' (ไม่มีโน้ตที่แทนได้)'}`);
      // a contradiction with a current fact of the same subject (accuracy.ts): flag both now, the nightly lint recomputes them
      const facts = (await factTexts(db, hide, isGlobal ? null : proj)).filter((f) => f.fid !== fid && !replaces.includes(f.fid));
      const pairs = conflictPairs([...facts, { fid, project: isGlobal ? '' : proj, kind: kind ?? 'fact', text: body }], fid);
      const other = (p: { a: string; b: string }) => (p.a === fid ? p.b : p.a);
      if (pairs.length) {
        out.push(`⚠ CONFLICT: ขัดกับ ${pairs.map((p) => `[${other(p)}] เรื่อง ${p.name}`).join(' · ')} — ถ้าตัวเก่าผิด ส่ง replaces:[…] พร้อม user_quote; ติดธงทั้งคู่แล้ว (hubs/_review.md)`);
        await run(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'conflict', fid, ...pairs.map((p) => `${other(p)}:${p.name}`)],
          { env: { ...process.env, MEMORY_HUB_INTERNAL: '1' }, windowsHide: true, timeout: 20_000 });
      }
    }
    const lost = want.filter((x) => !seen.has(x));
    if (lost.length) out.push(`not found: ${lost.join(' ')}`);
    const mutes = mute.filter((m) => seen.has(m.replace(/^-/, '')));
    if (mutes.length) out.push((await run(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'mute', ...mutes],
      { env: { ...process.env, MEMORY_HUB_INTERNAL: '1' }, windowsHide: true, timeout: 20_000 })).stdout.trim()); // rw child: we hold ro only
    return text(out.join('\n'));
  },
);

if (import.meta.main) { // imported by scripts/eval.ts for searchText → no stdio server there
  server.server.oninitialized = () => console.error(`memory-hub: Claude-only sources (Google) ${privateOk(client()) ? 'shown' : 'hidden'} for ${client()}`);
  await server.connect(new StdioServerTransport());
  if (!offsite) { // the first memory_search pays no cold start: bge-m3 load (seconds), PG connection + catalog caches (~20 ms)
    warmUp();
    projectCatalogue(db).catch(() => {});
    search(db, 'warm up', { semantic: false, limit: 1 }).catch(() => {});
  }
}
