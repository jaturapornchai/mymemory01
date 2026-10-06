// Progressive disclosure (idea from thedotmack/claude-mem: search index → timeline → full fetch): every line says what a
// memory_get would cost, so the calling model reads a cheap overview first and spends tokens only on what it needs.
import type pg from 'pg';
import { projectName } from './importer.ts';
import { day, snippet } from './search.ts';

/** ≈ tokens of `text` for the calling model — an ESTIMATE (no tokenizer dependency): Thai letters ÷ 0.95 + other chars ÷ 2.2.
 *  Calibrated 2026-10-02 on 651 text-only Claude Code replies in ลุงจืด's local transcripts (real usage.output_tokens minus
 *  thinking_tokens), least-squares fit on (Thai chars, other chars): Thai 0.94–1.0 and other 2.0–2.2 chars/token for the
 *  current Claude models (claude-opus-5-5 n=253: 0.95 / 2.19, median error 3 %, p90 8 %); English-only replies ≈ 2.8.
 *  "Other" is mostly code, paths and markdown here, so it sits below Anthropic's old 3.5 chars/token English rule of thumb.
 *  Other apps' models count fewer: a Qwen3 tokenizer (Ollama typhoon2.5) gave 0.67× this on 120 corpus chunks — read the
 *  number as an upper bound for Codex / Gemini / local models. */
export function tokens(text: string): number {
  const thai = text.match(/[฀-๿]/g)?.length ?? 0;
  return Math.round(thai / 0.95 + (text.length - thai) / 2.2);
}

const GET_MAX = 6000; // memory_get's default max_chars

/** ≈ tokens memory_get(id) returns with its defaults (around=1, max_chars=6000): the same turns, header and fact provenance. */
export async function getTokens(db: pg.Pool, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = (await db.query(
    `SELECT c.id, left(c.ctx_header || ' | session ' || c.session_id || ' | ' || coalesce(c.project, '') ||
       CASE WHEN f.fid IS NULL THEN ' | src claude:abcdefgh#12' ELSE ' | src claude:abcdefgh#12 2026-01-01 ×2' END || '\n\n' ||
       coalesce(f.fid || ' ' || f.kind || ' active · valid: 2026-01-01 → present\n\n', '') ||
       coalesce((SELECT string_agg('U: ' || t.text_redacted || CASE WHEN t.uuid LIKE 'github:%' THEN '\nhttps://github.com/' || repeat('x', 50) ELSE '' END,
                   '\n\n' ORDER BY t.seq) FROM turns t
                 WHERE t.source_id = c.source_id AND t.seq BETWEEN c.seq_from - 1 AND c.seq_to + 1), c.text) ||
       coalesce('\n\nfrom (3 turns, 1 session):\n' || (SELECT string_agg('A 2026-01-01 claude:abcdefgh#12: ' || left(p.text_redacted, 240), '\n')
                 FROM (SELECT text_redacted FROM turns p WHERE p.uuid = ANY(f.source_uuids) AND p.uuid NOT LIKE 'obs:%'
                       ORDER BY p.role = 'user' DESC, p.ts LIMIT 6) p), ''), $2) txt
     FROM chunks c LEFT JOIN facts f ON f.source_id = c.source_id WHERE c.id = ANY($1)`, [ids, GET_MAX + 1])).rows;
  return new Map(rows.map((r) => [r.id, tokens(r.txt.slice(0, GET_MAX)) + (r.txt.length > GET_MAX ? 15 : 0)])); // + the "[cut at …]" tail
}

export const TIMELINE_MAX = 1500; // chars: the farthest lines are dropped first
const NEAR_DAYS = 7;
/** Chunk header 'label 2026-09-12 — first line' → the first line (a fact/card note: without '# F<id>'). */
const gist = (header: string, n: number) => snippet(header.replace(/^.*? — /, '').replace(/^# (?:[FSI][0-9a-f]{8} )?/, ''), '', n);
const hm = (ts: Date | null) => (ts ? new Date(ts).toISOString().slice(5, 16).replace('T', ' ') : '??-?? ??:??');
const role = (r: string) => (r === 'note' ? 'D' : r[0].toUpperCase());
const app = (tool: string, kind: string) => (kind === 'main' || kind === 'note' ? tool : `${tool} ${kind}`);

type Line = { t: string; p: number; ids: string[]; near?: boolean }; // p: drop priority (lowest first), Infinity = always kept

/**
 * memory_timeline: the rounds (user prompt + its answer) before/after an id in its session, the facts/cards distilled from
 * that session (under the round they came from), and the same project in other sessions/apps near then. A fact/card id
 * centres on the chat it was distilled from. ≤ TIMELINE_MAX chars, every line with ≈tokens of memory_get. null = unknown id.
 */
export async function timeline(db: pg.Pool, id: string, o: { before?: number; after?: number; until?: Date; hide?: string[]; own?: { since: Date; tool: string; project: string } } = {}) {
  const { before = 3, after = 3, until = null, hide = [], own } = o; // own: search.ts SearchOpts.own — hide the caller's own live session // hide: guard.PRIVATE_TOOLS for callers that must not see them
  const q = async (sql: string, p: unknown[]) => (await db.query(sql, p)).rows;
  const [hit] = await q(
    `SELECT c.id, c.turn_uuid, c.source_id, c.seq_from, c.ts, c.project, c.session_id, s.tool, s.kind, f.fid, f.source_uuids, f.project fproject
     FROM chunks c JOIN sources s ON s.id = c.source_id LEFT JOIN facts f ON f.source_id = c.source_id
     WHERE ${/^[FSI]/.test(id) ? 'f.fid = $1' : id.length === 16 ? 'c.id = $1' : `c.id LIKE $1 || '%'`} AND coalesce(s.hide_as, s.tool) <> ALL($2::text[]) ORDER BY c.seq_from, c.id LIMIT 1`, [id, hide]); // full id: = uses the pkey, LIKE does not
  if (!hit) return null;
  // a fact/card note → the chat turn it was distilled from first; a hand-saved fact has none → the note itself
  const [chat] = hit.fid ? await q(
    `SELECT c.id, c.source_id, c.seq_from, c.ts, c.project, c.session_id, s.tool, s.kind FROM turns t
     JOIN sources s ON s.id = t.source_id AND s.tool <> 'obsidian' JOIN chunks c ON c.source_id = t.source_id AND t.seq BETWEEN c.seq_from AND c.seq_to
     WHERE t.uuid = ANY($1) AND coalesce(s.hide_as, s.tool) <> ALL($2::text[]) ORDER BY t.ts, t.seq, c.seq_from, c.id LIMIT 1`, [hit.source_uuids, hide]) : [];
  const a = chat ?? hit;
  const project: string | null = hit.fid && !chat ? hit.fproject : a.project;
  const [rounds, facts, near] = await Promise.all([
    // a round starts at a user prompt / summary / note (as in chunk.ts); its id = its first chunk (the anchor: the asked chunk)
    q(`WITH h AS (SELECT seq, ts, role, lead(seq) OVER (ORDER BY seq) nxt FROM turns
                  WHERE source_id = $1 AND (role IN ('user', 'summary', 'note') OR seq = (SELECT min(seq) FROM turns WHERE source_id = $1))),
            r AS (SELECT h.*, row_number() OVER (ORDER BY seq) i FROM h),
            a AS (SELECT i FROM r WHERE seq <= $2 ORDER BY seq DESC LIMIT 1)
       SELECT r.seq, r.nxt, r.ts, r.role, (r.i - a.i)::int d, k.id, k.ctx_header FROM r CROSS JOIN a
       CROSS JOIN LATERAL (SELECT c.id, c.ctx_header FROM chunks c WHERE c.source_id = $1 AND c.seq_from >= r.seq AND (r.nxt IS NULL OR c.seq_from < r.nxt)
                           ORDER BY c.seq_from, c.seq_to, c.id LIMIT 1) k
       WHERE r.i BETWEEN a.i - $3 AND a.i + $4 AND ($5::timestamptz IS NULL OR r.ts IS NULL OR r.ts < $5) ORDER BY r.seq`,
    [a.source_id, a.seq_from, before, after, own && a.tool === own.tool && a.project === own.project ? own.since : until]),
    q(`SELECT f.fid, f.kind, coalesce(s.status, 'active') status, f.superseded_by, k.id, k.ctx_header,
              (SELECT min(t.seq) FROM turns t WHERE t.uuid = ANY(f.source_uuids) AND t.source_id = $2) seq
       FROM facts f JOIN sources s ON s.id = f.source_id
       CROSS JOIN LATERAL (SELECT c.id, c.ctx_header FROM chunks c WHERE c.source_id = f.source_id ORDER BY c.seq_from, c.id LIMIT 1) k
       WHERE f.session_ids @> ARRAY[$1]::text[] AND s.status IS DISTINCT FROM 'rejected' ORDER BY seq NULLS LAST, f.fid LIMIT 40`,
    [a.session_id, a.source_id]),
    // other sessions (any app) of the same project: each one's chunk nearest in time
    project && a.ts ? q(`SELECT * FROM (
         SELECT DISTINCT ON (c.session_id) c.id, c.ts, c.ctx_header, s.tool, s.kind, abs(extract(epoch FROM c.ts - $2)) dist
         FROM chunks c JOIN sources s ON s.id = c.source_id
         WHERE c.project = $1 AND c.session_id <> $3 AND s.tool <> 'obsidian' AND coalesce(s.hide_as, s.tool) <> ALL($6::text[]) AND ($4::timestamptz IS NULL OR c.ts < $4)
           AND ($7::timestamptz IS NULL OR c.ts < $7 OR s.tool IS DISTINCT FROM $8 OR c.project IS DISTINCT FROM $9)
           AND c.ts BETWEEN $2::timestamptz - make_interval(days => $5) AND $2::timestamptz + make_interval(days => $5)
         ORDER BY c.session_id, dist, c.id) z ORDER BY dist, id LIMIT 4`, [project, a.ts, a.session_id, until, NEAR_DAYS, hide, own?.since ?? null, own?.tool ?? null, own?.project ?? null]) : [],
  ]);
  const cards = facts.filter((f) => f.kind === 'card');
  const inRound = (f: { seq: number | null }) => rounds.find((r) => f.seq !== null && r.seq <= f.seq && (r.nxt === null || f.seq < r.nxt));
  const outside = facts.filter((f) => f.kind !== 'card' && !inRound(f)), more = outside.slice(0, 6);
  const cost = await getTokens(db, [...rounds.map((r) => (r.d === 0 ? a.id : r.id)), ...facts.map((f) => f.id), ...near.map((n) => n.id)]);
  const t = (cid: string) => `≈${cost.get(cid) ?? '?'}t`;

  const lines: Line[] = cards.map((f) => ({ t: `session card [${f.fid}] ${t(f.id)}: ${gist(f.ctx_header, 64)}`, p: 90, ids: [f.id] }));
  for (const r of rounds) {
    const d: number = r.d, cid = d === 0 ? a.id : r.id;
    const p = d === 0 ? Infinity : 80 - 10 * Math.abs(d) + (d > 0 ? 1 : 0); // dropped far first; at equal distance "before" first
    lines.push({ t: `${d === 0 ? '▶' : d > 0 ? `+${d}` : d} [${cid}] ${hm(r.ts)} ${role(r.role)} ${t(cid)}: ${gist(r.ctx_header, 64)}`, p, ids: [cid] });
    for (const f of facts.filter((x) => x.kind !== 'card' && inRound(x) === r)) {
      const flag = f.status === 'superseded' ? ` OLD -> [${f.superseded_by ?? '?'}]` : f.status === 'pending' ? ' PENDING' : '';
      lines.push({ t: `   ⇢ [${f.fid}] ${f.kind}${flag} ${t(f.id)}: ${gist(f.ctx_header, 56)}`, p: d === 0 ? 85 : p - 1, ids: [f.id] });
    }
  }
  if (more.length) lines.push({ t: `more facts from this session: ${more.map((f) => `[${f.fid}] ${t(f.id)}`).join(' ')}${outside.length > 6 ? ` +${outside.length - 6}` : ''}`, p: 45, ids: more.map((f) => f.id) });
  // nearest in time kept longest (rows come by distance), printed in time order
  near.map((n, i) => ({ n, p: 72 - 10 * i })).sort((x, y) => +x.n.ts - +y.n.ts).forEach(({ n, p }) => lines.push({
    t: ` [${n.id}] ${hm(n.ts)} ${app(n.tool, n.kind)} ${t(n.id)}: ${gist(n.ctx_header, 56)}`, p, ids: [n.id], near: true }));

  const head = `timeline [${id}]${chat ? ' → its source chat' : ''}: ${projectName(project ?? '') || 'global'} · ${app(a.tool, a.kind)} · ${day(a.ts)} ` +
    `(times UTC) · ≈t = est. tokens of memory_get(id)`;
  const render = (ls: Line[]) => {
    const out = [head, ...ls.map((l) => l.t)];
    const n = ls.findIndex((l) => l.near);
    if (n >= 0) out.splice(n + 1, 0, `same project, other sessions/apps (±${NEAR_DAYS}d):`);
    const ids = [...new Set(ls.flatMap((l) => l.ids))];
    out.push(`total ≈${ids.reduce((s, i) => s + (cost.get(i) ?? 0), 0)}t to memory_get all ${ids.length} listed` +
      (ls.length < lines.length ? ` · ${lines.length - ls.length} more cut to fit ${TIMELINE_MAX} chars` : ''));
    return out.join('\n');
  };
  let kept = lines;
  for (let s = render(kept); s.length > TIMELINE_MAX; s = render(kept)) {
    const low = kept.reduce((m, l, i) => (l.p < kept[m].p ? i : m), 0);
    if (kept[low].p === Infinity) break;
    kept = kept.filter((_, i) => i !== low);
  }
  const text = render(kept);
  return { text: text.length > TIMELINE_MAX ? text.slice(0, TIMELINE_MAX - 1) + '…' : text, hit: { id: hit.id as string, turn_uuid: hit.turn_uuid as string } };
}
