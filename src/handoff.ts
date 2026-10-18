// Automatic "another app worked here" line at session start: when the last imported session in this project (≤ 48 h)
// came from another AI app (Claude Code, Codex, Gemini, …) than the caller, say so — no save needed.
import type pg from 'pg';

const RECENT_HOURS = 48;                                           // "another app worked here" window
const APPS = ['antigravity', 'claude', 'codex', 'gemini', 'zcode', 'lmstudio']; // = sources.tool

/** App of an MCP clientInfo.name or hook --app (= sources.tool): codex-mcp-client → codex, antigravity-client → antigravity. */
export const appOf = (client: string) => { const c = client.toLowerCase().replace(/[^a-z]/g, ''); return APPS.find((a) => c.includes(a)) ?? (c || 'unknown'); };
const flat = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const ago = (d: Date) => {
  const m = Math.max(1, Math.round((Date.now() - new Date(d).getTime()) / 60_000));
  return m < 60 ? `${m} นาทีก่อน` : m < 2880 ? `${Math.round(m / 60)} ชม.ก่อน` : `${Math.round(m / 1440)} วันก่อน`;
};

/** "ล่าสุด codex ทำงานนี้ 3 ชม.ก่อน: <card title or first prompt>" when the last session in this
 *  project (≤ 48 h, imported) came from another app than the caller. */
export async function lastOtherApp(db: pg.Pool, project: string | string[], client: string, sessionId = ''): Promise<string | null> {
  const projects = (Array.isArray(project) ? project : [project]).filter(Boolean);
  if (!projects.length) return null;
  const last = (await db.query(
    `SELECT s.tool, c.source_id, c.session_id, max(c.ts) ts FROM chunks c JOIN sources s ON s.id = c.source_id
     WHERE c.project = ANY($1::text[]) AND c.ts > now() - make_interval(hours => $2) AND s.kind = 'main' AND s.hide_as IS NULL AND c.session_id <> $3
     GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 1`, [projects, RECENT_HOURS, sessionId])).rows[0];
  if (!last || last.tool === appOf(client)) return null;
  // card note text = "# <file>\n# <title>\n\n<summary>" (dream); else the session's first real prompt
  const r = (await db.query(
    `SELECT (SELECT t.text_redacted FROM facts f JOIN turns t ON t.source_id = f.source_id
             WHERE f.kind = 'card' AND $2 = ANY(f.session_ids) ORDER BY f.valid_at DESC NULLS LAST LIMIT 1) card, -- long session: newest card
            (SELECT text_redacted FROM turns WHERE source_id = $1 AND role = 'user' AND left(text_redacted, 1) <> '['
             ORDER BY seq LIMIT 1) prompt`, [last.source_id, last.session_id])).rows[0];
  const what = r.card?.match(/\n# ([^\n]+)/)?.[1] ?? r.prompt ?? '';
  return `ล่าสุด ${last.tool} ทำงานนี้ ${ago(last.ts)}${what ? `: ${flat(what, 110)}` : ''}`;
}
