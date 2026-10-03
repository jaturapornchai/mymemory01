// MCP stdio server (user scope). Output is plain compact text, not JSON — fewer tokens for the calling model.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { connect } from './db.ts';
import { warmUp } from './embed.ts';
import { offsiteBackend, PRIVATE_TOOLS, privateOk } from './guard.ts';
import { clean, normProject, projectName } from './importer.ts';
import { saveNote } from './notes.ts';
import { claimHandoff, DATA_NOTE, doneHandoff, handoffLines, saveHandoff } from './handoff.ts';
import { day, hitLine, privateLabel, search, snippet, type Hit } from './search.ts';
import { normalize, queryTerms, words } from './thai.ts';
import { getTokens, timeline } from './timeline.ts';

const db = connect('ro');
// Desktop apps (LM Studio, Antigravity, ZCode…) may start us in their install dir or home: that is no project → global.
const NO_PROJECT = /^[a-z]:\/(?:program files[^/]*|windows)(?:\/|$)|^[a-z]:\/users\/[^/]+(?:\/appdata(?:\/.*)?)?$/;
const toProject = (cwd: string) => ((p) => (NO_PROJECT.test(p) ? '' : p))(normProject(cwd));
const currentProject = toProject(process.cwd());
// ponytail: hides everything after server start, incl. other sessions running right now; per-session id filter if that matters
const startedAt = new Date();
const session = `mcp-${process.pid}-${startedAt.getTime()}`; // one MCP process = one session of the calling AI app
const internal = !!process.env.MEMORY_HUB_INTERNAL;           // eval / dream / tests: don't count as real use
const offsite = offsiteBackend();

/** Usage signal for ranking + brain, plus the call's latency (fire-and-forget: never slows or fails a tool call).
 *  call: tool = MCP tool (memory_timeline logs kind 'related'), t0 = performance.now() at the call's start, semantic = search only. */
// ponytail: a call with no rows (0 hits / not found) leaves no latency row; add a separate call log if those matter
function logAccess(kind: 'search' | 'get' | 'related', rows: { id: string; turn_uuid: string }[],
  call: { tool: string; t0: number; query?: string; semantic?: boolean }) {
  if (!rows.length || internal) return;
  const { tool, t0, query, semantic = null } = call;
  db.query(
    `INSERT INTO access_log (kind, chunk_id, turn_uuid, rank, query, session, project, client, tool, ms, semantic)
     SELECT $1, id, t, ord, $4, $5, $6, $7, $8, $9, $10 FROM unnest($2::text[], $3::text[]) WITH ORDINALITY u(id, t, ord)`,
    [kind, rows.map((r) => r.id), rows.map((r) => r.turn_uuid), query ? clean(query).slice(0, 300) : null, session, currentProject, client(),
      tool, Math.round(performance.now() - t0), semantic],
  ).catch(() => {});
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const OFFSITE = `memory-hub is off in this session: its model backend (${offsite}) is not Anthropic and MEMHUB_ANTHROPIC_ONLY=1 is set.`;
/** Which AI app is calling (MCP clientInfo.name: claude-code, codex-mcp-client, gemini-cli-mcp-client, …). */
const client = () => server.server.getClientVersion()?.name ?? 'unknown';
/** Why memory is off for this caller, else null. MEMHUB_ANTHROPIC_ONLY=1 = Claude apps (claude-code, claude-ai) on Anthropic only. */
const off = () => offsite ? OFFSITE : process.env.MEMHUB_ANTHROPIC_ONLY === '1' && !/^claude/i.test(client())
  ? `memory-hub is off for ${client()}: MEMHUB_ANTHROPIC_ONLY=1 serves Claude apps only.` : null;
/** Tools this caller must not see (guard.privateOk): every tool reply leaves them out; a hidden id is "not found". */
const hidden = () => (privateOk(client()) ? [] : [...PRIVATE_TOOLS]);
const ID = z.string().regex(/^(?:[0-9a-f]{8,16}|[FSI][0-9a-f]{8})$/);

/** Chunk for a search id (hex prefix) or a fact id (F/S/I + 8 hex); not one of the hidden tools' sources. */
async function chunkOf(id: string, hide: string[]) {
  const visible = `c.source_id NOT IN (SELECT id FROM sources WHERE coalesce(hide_as, tool) = ANY($2::text[]))`;
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
    'When he says จำไว้/remember or states a lasting rule, call memory_save. ' +
    'He switches AI apps mid-task: starting work in a project, call memory_handoff list; stopping unfinished, memory_handoff save. ' +
    (currentProject ? '' : 'This server runs outside any project: pass project=<absolute workspace path> to memory_handoff. ') +
    'Tokens: full memory_search snippets usually answer without memory_get (each get ≈1-3k tokens); detail:"brief" only skims; ' +
    'memory_timeline(id) = what happened around a hit.',
});

server.registerTool(
  'memory_search',
  {
    description:
      'Search ลุงจืด\'s past AI sessions (Claude Code, Codex, Gemini, Antigravity, ZCode, LM Studio), notes, GitHub (repos, commits, issues/PRs) and facts (Thai+English+code). Use when he refers to the past ("เคย", ' +
      '"ครั้งก่อน", "last time"), before R0/R1 actions, or when unsure of a project fact; since+until = a date range. ≤8 snippets with ids, age, use count; ' +
      'OLD = superseded. Priority order: curated rules/facts first, raw chats are evidence (↳ = the chat a fact came from); ' +
      'memory_get(id) only when a snippet is not enough (each get ≈1-3k tokens; full snippets usually answer). detail:"brief" = one line ' +
      'per hit (≈1/3 the tokens per hit at the same limit, ≈t = est. tokens of memory_get) to skim; then memory_timeline / memory_get only what matters.',
    inputSchema: {
      query: z.string().min(1).max(300).describe('keywords or a short question, Thai or English'),
      project: z.string().max(200).optional().describe('filter: substring of project path, e.g. "proj-a"'),
      since: z.string().max(30).optional().describe('ISO date, e.g. 2026-09-01'),
      until: z.string().max(30).optional().describe('ISO date, inclusive'),
      limit: z.number().int().min(1).max(15).optional().describe('default 6, at most 8 hits are returned'),
      detail: z.enum(['brief', 'full']).optional().describe('default full'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, project, since, until, limit, detail }) => {
    const t0 = performance.now();
    const no = off(); if (no) return text(no);
    const brief = detail === 'brief';
    const n = limit && Math.min(limit, 8); // ≤ 8 hits in both modes; default = search()'s 6
    const { hits, semantic } = await search(db, query, { project, since, until, limit: n, currentProject, before: startedAt, now: new Date(), showPrivate: privateOk(client()) });
    const out = brief ? briefText(hits, query, semantic, await getTokens(db, hits.map((h) => h.id))) : searchText(hits, query, semantic);
    logAccess('search', hits, { tool: 'search', t0, query, semantic });
    return text(out);
  },
);

// A fact with its source chat (↳): the fact gets ≤ this, the ↳ line the rest of the 400 chars of one result.
// eval tune: 250 kept the most question terms visible in the gold entry (200/300 lost some; chars equal).
const FACT_EV_CHARS = 250;
// Fact note chunk = 'D: # F<id> <title>' (title = the body's first words) + body + wiki links '- from:: [[…]]' → body only.
const factBody = (t: string) => t.replace(/^D: # [FSI][0-9a-f]{8}[^\n]*\n?/, '').replace(/^\s*- [a-z_]+:: \[\[.*$/gm, '');

/** memory_search reply text — exported so scripts/eval.ts measures exactly what the calling model reads. */
export function searchText(hits: Hit[], query: string, semantic: boolean): string {
  if (!hits.length) return semantic ? 'no matches' : 'no matches (keyword-only: embedder busy)';
  const max = budgets(hits.length);
  return (semantic ? '' : '(keyword-only: embedder busy)\n') + hits.map((h, i) => hitText(h, query, max[i])).join('\n\n');
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
  let best = 0, most = -1;
  for (let i = anchor ? low.indexOf(anchor) : -1; i >= 0; i = low.indexOf(anchor!, i + 1)) {
    const s = Math.max(0, Math.min(i - Math.floor(max / 4), flat.length - max));
    const n = new Set(occ.filter((p) => p.i >= s && p.i + p.k.length <= s + max).map((p) => p.k)).size;
    if (n > most) { most = n; best = s; }
  }
  return (best > 0 ? '…' : '') + flat.slice(best, best + max) + (best + max < flat.length ? '…' : '');
}

/** One result: line + passage (a fact from its head), then its best source chat (↳) in the rest of its `max` chars.
 *  More source chats are only counted (+N): memory_get(fact id) lists its provenance. */
export function hitText(h: Hit, query: string, max = 400): string {
  const [e, ...more] = h.evidence ?? [];
  const fact = h.fid && h.kind !== 'card';
  const text = fact ? factBody(h.text) : h.text, q = fact ? '' : query;
  if (!e) return `${hitLine(h)}\n${passage(text, q, max)}`;
  // a source chat whose decision a later fact replaced keeps the warning it has as a result of its own (not when that fact is h)
  const later = e.changed_to?.filter((f) => f !== h.fid) ?? [];
  const ev = `\n↳ source chat [${e.id}] ${day(e.ts)}${later.length ? ` (later changed -> [${later.join('] [')}])` : ''}` +
    `${more.length ? ` +${more.length} more` : ''}: `;
  // the ↳ header is sized first, so a long one (changed_to ids, +N) shortens the fact, not the total: body + ev + chat ≤ max
  const body = passage(text, q, Math.max(60, Math.min(Math.round((FACT_EV_CHARS * max) / 400), max - ev.length - 60)));
  return `${hitLine(h)}\n${body}${ev}${passage(e.text, query, Math.max(60, max - body.length - ev.length))}`;
}

// brief = progressive disclosure: same hits and order as full, one line each, gist last so the line cap only shortens the gist
export const BRIEF_LINE = 200;
const BRIEF_HEAD = 'brief: ≈t = est. tokens of memory_get(id); memory_timeline(id) = what happened around it';

/** memory_search detail:"brief" text. cost = getTokens() of the hits' chunk ids. */
export function briefText(hits: Hit[], query: string, semantic: boolean, cost: Map<string, number>): string {
  if (!hits.length) return searchText(hits, query, semantic);
  return (semantic ? '' : '(keyword-only: embedder busy)\n') + `${BRIEF_HEAD}\n` + hits.map((h) => briefLine(h, query, cost)).join('\n');
}

/** `[id] 2026-09-12 proj-a codex subagent ≈850t ↳[source chat id]: gist` — OLD / PENDING / changed warnings kept from hitLine. */
export function briefLine(h: Hit, query: string, cost: Map<string, number>): string {
  const fact = h.fid && h.kind !== 'card';
  const what = h.kind ?? (PRIVATE_TOOLS.has(h.tool) ? privateLabel(h) : h.project?.startsWith('obsidian/') ? (h.src_kind === 'daily' ? 'daily note' : 'note') : h.tool === 'github' ? 'github'
    : h.src_kind === 'main' ? h.tool : `${h.tool} ${h.src_kind}`);
  const flag = h.status === 'superseded' ? ` OLD -> [${h.superseded_by ?? '?'}]` : h.status === 'pending' ? ` PENDING vs [${h.review_target ?? '?'}]`
    : h.changed_to ? ` (later changed -> [${h.changed_to.join('] [')}])` : '';
  const ev = h.evidence?.length ? ` ↳[${h.evidence[0].id}]${h.evidence.length > 1 ? `+${h.evidence.length - 1}` : ''}` : '';
  const head = `[${fact ? h.fid : h.id}] ${day(h.ts)} ${projectName(h.fact_project ?? h.project ?? '') || 'global'} ${what}${flag} ≈${cost.get(h.id) ?? '?'}t${ev}: `;
  return (head + passage(fact ? factBody(h.text) : h.text, fact ? '' : query, 100)).slice(0, BRIEF_LINE);
}

server.registerTool(
  'memory_timeline',
  {
    description:
      'What happened around a memory id (from memory_search, brief or full): the rounds before/after it in its session ' +
      '(time, role, gist), facts/cards distilled from that session, and the same project in other sessions/apps near then. ' +
      'One line each with ≈t = est. tokens of memory_get; ≤1500 chars. A fact/card id centres on the chat it came from.',
    inputSchema: {
      id: ID.describe('id from memory_search / memory_timeline / memory_related'),
      before: z.number().int().min(0).max(10).optional().describe('rounds before (default 3)'),
      after: z.number().int().min(0).max(10).optional().describe('rounds after (default 3)'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ id, before, after }) => {
    const t0 = performance.now();
    const no = off(); if (no) return text(no);
    const t = await timeline(db, id, { before, after, until: startedAt, hide: hidden() }); // a hidden id = null = not found
    if (!t) return text(`not found: ${id}`);
    logAccess('related', [t.hit], { tool: 'timeline', t0 }); // exploring around it = a recall, like memory_related
    return text(t.text);
  },
);

server.registerTool(
  'memory_get',
  {
    description: 'Full text of a memory_search hit (or fact id like F3fa2c1d0) plus surrounding turns / fact provenance.',
    inputSchema: {
      id: ID.describe('id from memory_search'),
      around: z.number().int().min(0).max(5).optional().describe('extra turns before/after (default 1)'),
      max_chars: z.number().int().min(500).max(20000).optional().describe('default 6000'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ id, around = 1, max_chars = 6000 }) => {
    const t0 = performance.now();
    const no = off(); if (no) return text(no);
    const hide = hidden();
    const c = await chunkOf(id, hide);
    if (!c) return text(`not found: ${id}`);
    const turns = (await db.query(
      `SELECT seq, role, ts, text_redacted FROM turns WHERE source_id = $1 AND seq BETWEEN $2 AND $3 ORDER BY seq`,
      [c.source_id, c.seq_from - around, c.seq_to + around],
    )).rows;
    let body = turns.map((t) => `${t.role === 'user' ? 'U' : t.role === 'assistant' ? 'A' : t.role[0].toUpperCase()}: ${t.text_redacted}`).join('\n\n');
    const f = (await db.query(
      `SELECT f.*, s.status FROM facts f JOIN sources s ON s.id = f.source_id WHERE f.source_id = $1`, [c.source_id])).rows[0];
    if (f) { // a fact/card note: show its validity and where it came from (≤3 source turns)
      const prov = (await db.query(
        `SELECT t.role, t.ts, left(t.text_redacted, 300) txt FROM turns t WHERE t.uuid = ANY($1)
         AND t.source_id NOT IN (SELECT id FROM sources WHERE coalesce(hide_as, tool) = ANY($2::text[])) ORDER BY t.ts LIMIT 3`, [f.source_uuids, hide])).rows;
      body = `${f.fid} ${f.kind} ${f.status ?? 'active'} · valid: ${day(f.valid_at)} → ${f.invalid_at ? day(f.invalid_at) : 'present'}` +
        (f.superseded_by ? ` · superseded by [${f.superseded_by}]` : '') + (f.review_target ? ` · review vs [${f.review_target}]` : '') +
        `\n\n${body}` + (prov.length ? '\n\nfrom:\n' + prov.map((p) => `${p.role === 'user' ? 'U' : 'A'} ${day(p.ts)}: ${p.txt}`).join('\n') : '');
    }
    const out = `${c.ctx_header} | session ${c.session_id} | ${c.project}\n\n${body || c.text}`;
    logAccess('get', [c], { tool: 'get', t0 });
    return text(out.length > max_chars ? out.slice(0, max_chars) + `\n…[cut at ${max_chars}; raise max_chars or around=0]` : out);
  },
);

server.registerTool(
  'memory_related',
  {
    description:
      'Brain-style links for a memory id: [[links]] out, backlinks, facts/cards from the same session, memories used ' +
      'together before, and the most similar memories. Use to follow a thread from a memory_search hit.',
    inputSchema: {
      id: ID.describe('id from memory_search / memory_related'),
      limit: z.number().int().min(1).max(8).optional().describe('similar items (default 5)'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ id, limit = 5 }) => {
    const t0 = performance.now();
    const no = off(); if (no) return text(no);
    const hide = hidden();
    const c = await chunkOf(id, hide);
    if (!c) return text(`not found: ${id}`);
    const first = '(SELECT min(id) FROM chunks WHERE source_id = s.id)';
    const q = async (sql: string, p: unknown[]) => (await db.query(sql, p)).rows;
    const [out, back, prov, together, similar] = await Promise.all([
      q(`SELECT l.dst_name name, ${first} cid FROM links l LEFT JOIN sources s ON s.id = l.dst_id WHERE l.src_id = $1 AND coalesce(s.hide_as, s.tool, '') <> ALL($2::text[]) ORDER BY 1`, [c.source_id, hide]),
      q(`SELECT s.session_id name, ${first} cid FROM links l JOIN sources s ON s.id = l.src_id WHERE l.dst_id = $1 AND coalesce(s.hide_as, s.tool) <> ALL($2::text[]) ORDER BY 1`, [c.source_id, hide]),
      // provenance both ways: facts/cards distilled from this chat session, or the chat sessions a fact came from
      q(`SELECT f.fid || ' ' || f.kind || ' ' || coalesce(s.status, 'active') || ': ' || regexp_replace(s.session_id, '^.*/|[.]md$', '', 'g') name, ${first} cid
         FROM facts f JOIN sources s ON s.id = f.source_id WHERE $1 = ANY(f.session_ids) AND f.source_id <> $2 AND coalesce(s.hide_as, s.tool) <> ALL($3::text[])
         UNION ALL
         SELECT 'session ' || s.session_id || ' (' || s.project || ')', ${first}
         FROM facts f JOIN sources s ON s.kind = 'main' AND s.session_id = ANY(f.session_ids) WHERE f.source_id = $2 AND coalesce(s.hide_as, s.tool) <> ALL($3::text[])
         LIMIT 8`, [c.session_id, c.source_id, hide]),
      q(`SELECT coalesce(s.session_id, '') || ' (' || coalesce(s.project, '') || ') w=' || round(e.w::numeric, 2) name, ${first} cid
         FROM edges e JOIN sources s ON s.id = CASE WHEN e.a = $1 THEN e.b ELSE e.a END
         WHERE e.kind = 'coaccess' AND (e.a = $1 OR e.b = $1) AND coalesce(s.hide_as, s.tool) <> ALL($2::text[]) ORDER BY e.w DESC LIMIT 5`, [c.source_id, hide]),
      q(`SELECT c2.id, c2.ts, c2.project, c2.text FROM chunks c2
         WHERE c2.source_id <> $1 AND c2.embedding IS NOT NULL AND c2.ts < $3 AND c2.source_id NOT IN (SELECT id FROM sources WHERE coalesce(hide_as, tool) = ANY($5::text[]))
         ORDER BY c2.embedding <=> (SELECT embedding FROM chunks WHERE id = $2) LIMIT $4`, [c.source_id, c.id, startedAt, limit, hide]),
    ]);
    const fmt = (r: { name: string; cid: string | null }) => (r.cid ? `[${r.cid}] ${r.name}` : `${r.name} (no note yet)`);
    const parts: string[] = [];
    if (out.length) parts.push('links →\n' + out.map(fmt).join('\n'));
    if (back.length) parts.push('backlinks ←\n' + back.map(fmt).join('\n'));
    if (prov.length) parts.push('same session ⇢\n' + prov.map(fmt).join('\n'));
    if (together.length) parts.push('used together ⇄\n' + together.map(fmt).join('\n'));
    logAccess('related', [c], { tool: 'related', t0 });
    if (similar.length) parts.push('similar ≈\n' + similar.map((h) => `[${h.id}] ${day(h.ts)} ${projectName(h.project ?? '')}: ${snippet(h.text, '', 160)}`).join('\n'));
    return text(parts.join('\n\n') || 'no related memories');
  },
);

server.registerTool(
  'memory_save',
  {
    description:
      'Remember something across ALL future sessions (a fact note in the memory-hub Obsidian vault, owned by ลุงจืด). Use when he ' +
      'says "จำไว้"/"remember this" or states a lasting rule, decision or preference. Self-contained text; secrets are redacted. ' +
      'Never copy Gmail / Google Docs / Maps timeline text into it: those are Claude-only, saved notes reach every app.',
    inputSchema: {
      content: z.string().min(1).max(4000).describe('the fact/decision/rule, self-contained, in his language'),
      title: z.string().max(80).optional().describe('short note title'),
      kind: z.enum(['rule', 'preference', 'decision', 'fact', 'howto']).optional().describe('default fact'),
      global: z.boolean().optional().describe('applies to all projects (default: this project)'),
    },
  },
  async ({ content, title, kind, global }) => {
    const no = off(); if (no) return text(no);
    return text(`saved: ${saveNote(content, { title, kind, global, project: currentProject, client: client() })} (searchable in new sessions)`);
  },
);

server.registerTool(
  'memory_handoff',
  {
    description:
      'Hand unfinished work between ลุงจืด\'s AI apps for this project. list: open handoffs + which app worked here last; ' +
      'claim id: take one (only one app can) and get its text; save: when stopping mid-task (title + done/stopped/next/files); done id: finished.',
    inputSchema: {
      action: z.enum(['list', 'save', 'claim', 'done']),
      id: z.number().int().positive().optional().describe('claim / done'),
      title: z.string().max(300).optional().describe('save: the task in a few words'),
      done: z.string().max(4000).optional().describe('save: what is finished'),
      stopped: z.string().max(4000).optional().describe('save: where it stopped / what failed'),
      next: z.string().max(4000).optional().describe('save: next steps'),
      files: z.string().max(1000).optional().describe('save: key files'),
      to_app: z.enum(['claude', 'codex', 'gemini', 'antigravity', 'zcode', 'lmstudio']).optional().describe('save: only this app may take it'),
      project: z.string().max(300).regex(/^(?:[a-zA-Z]:)?[\\/]/, 'absolute path').optional()
        .describe('list / save: absolute workspace path, when this server does not run in your project (Antigravity, LM Studio); default its cwd'),
    },
  },
  async ({ action, id, title, done, stopped, next, files, to_app, project }) => {
    const no = off(); if (no) return text(no);
    const proj = project ? toProject(project) : currentProject;
    const where = proj || 'global';
    if (action === 'save') {
      if (!title?.trim() || !(done || stopped || next)) return text('save needs title + done/stopped/next');
      const n = await saveHandoff(db, proj, client(), { title, done, stopped, next, files, to: to_app });
      return text(`saved handoff #${n} (${where}): the next AI app sees it at session start / memory_handoff list`);
    }
    if (action === 'list') {
      const lines = await handoffLines(db, proj, client());
      if (!lines.length) return text(`no open handoffs (${where})`);
      return text(`${DATA_NOTE}:\n${lines.join('\n')}` + (lines.some((l) => l.startsWith('#')) ? '\ntake one: memory_handoff action=claim id=N' : ''));
    }
    if (!id) return text(`${action} needs id`);
    return text(await (action === 'claim' ? claimHandoff : doneHandoff)(db, id, client()));
  },
);

if (import.meta.main) { // imported by scripts/eval.ts for searchText → no stdio server there
  server.server.oninitialized = () => console.error(`memory-hub: Claude-only sources (Google) ${privateOk(client()) ? 'shown' : 'hidden'} for ${client()}`);
  await server.connect(new StdioServerTransport());
  if (!offsite) { // the first memory_search pays no cold start: bge-m3 load (seconds), PG connection + catalog caches (~20 ms)
    warmUp();
    search(db, 'warm up', { semantic: false, limit: 1 }).catch(() => {});
  }
}
