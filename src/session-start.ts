// SessionStart hook: inject ≤2000 chars — ลุงจืด's rules/pinned facts for this project (+ global), cross-AI handoffs, the
// last session cards, and prompts of sessions not dreamt yet. Not logged as a use (access_log); the ids it injected go to
// injections (cli stats --injected). Any failure → inject nothing.
// Claude Code runs it as is; Codex / Gemini CLI / ZCode with `--app <name>` (same stdin JSON, same hookSpecificOutput reply).
import { connect } from './db.ts';
import { offsiteBackend, PRIVATE_TOOLS } from './guard.ts';
import { DATA_NOTE, handoffLines } from './handoff.ts';
import { normProject } from './importer.ts';

const MAX_CHARS = 2000;
const flat = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// health line: hours before a job counts as stale, and the fix for a known error
const STALE: Record<string, number> = { sync: 3, dream: 36 };
// matched against "<job>: <err>"; Ollama down reaches embed as a bare "fetch failed" / ECONNREFUSED
const HINTS: [RegExp, string][] = [[/oauth|authenticat|credential|\/login/i, ' (แก้: claude /login)'], [/ollama|^embed: .*(?:fetch failed|ECONNREFUSED)/i, ' (เปิด Ollama)']];
const app = process.argv.includes('--app') ? process.argv[process.argv.indexOf('--app') + 1] ?? '' : 'claude-code';

try {
  // memory never goes to a non-Anthropic backend / a non-Claude app when MEMHUB_ANTHROPIC_ONLY=1 (same rule as mcp.ts)
  if (process.env.MEMORY_HUB_INTERNAL || offsiteBackend() || (process.env.MEMHUB_ANTHROPIC_ONLY === '1' && !/^claude/i.test(app))) process.exit(0);
  let raw = '';
  for await (const c of process.stdin) raw += c;
  const ev = JSON.parse(raw);
  const project = normProject(String(ev.cwd ?? process.cwd()));
  const session = String(ev.session_id ?? '');
  const db = connect('ro');
  const body = `(SELECT t.text_redacted FROM turns t WHERE t.source_id = s.id LIMIT 1)`;
  const unmuted = `NOT EXISTS (SELECT 1 FROM state m WHERE m.k = 'mute:' || f.fid)`; // memory_save mute (cli.ts mute)
  const [rules, cards, recent, handoffs, health] = await Promise.all([
    db.query(
      `SELECT f.fid, f.kind, ${body} txt FROM facts f JOIN sources s ON s.id = f.source_id
       WHERE (f.project = $1 OR f.scope = 'global') AND (f.pinned OR f.kind IN ('rule', 'feedback'))
         AND coalesce(s.status, 'active') = 'active' AND ${unmuted}
       ORDER BY f.pinned DESC, f.importance DESC NULLS LAST, f.created_at DESC LIMIT 8`, [project]),
    db.query(
      `SELECT f.fid, f.valid_at, ${body} txt FROM facts f JOIN sources s ON s.id = f.source_id
       WHERE f.kind = 'card' AND f.project = $1 AND coalesce(s.status, 'active') = 'active' AND ${unmuted} ORDER BY f.valid_at DESC LIMIT 3`, [project]),
    db.query( // sessions the dream hasn't carded yet: their first prompt (never a Claude-only Google source, for any app)
      `SELECT DISTINCT ON (t.session_id) t.session_id, t.ts, t.text_redacted q
       FROM turns t JOIN sources s ON s.id = t.source_id
       WHERE s.kind = 'main' AND coalesce(s.hide_as, s.tool) <> ALL($3::text[]) AND t.project = $1 AND t.role = 'user' AND t.session_id <> $2 AND left(t.text_redacted, 1) <> '['
         AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.kind = 'card' AND t.session_id = ANY(f.session_ids))
       ORDER BY t.session_id, t.seq`, [project, session, [...PRIVATE_TOOLS]]),
    handoffLines(db, project, app, session, 3).catch(() => [] as string[]), // table missing before migrate → the rest still shows
    db.query(`SELECT k, v FROM state WHERE k LIKE 'health:%' ORDER BY k`).catch(() => ({ rows: [] })), // cli.ts health(): last run of each background job
  ]);
  // fact note text = "# <file name>\n<fact>\n\n- from:: …"; card = "# <file>\n# <title>\n\n<summary>…"
  const factText = (t: string) => t.replace(/^# [^\n]*\n/, '').split('\n\n- ')[0];
  const head = '[memory-hub] (memory_search / memory_get(id) ได้รายละเอียด)';
  // one line, only when a background job failed or went stale; job names + redacted error only, so the same line for every app
  const now = Date.now();
  const issues = health.rows.flatMap(({ k, v }) => {
    const job = k.slice(7), hours = (now - Date.parse(v.at)) / 3600e3;
    if (!v.ok) return [`${job} ล้มเหลว${HINTS.find(([re]) => re.test(`${job}: ${v.err ?? ''}`))?.[1] ?? ''}: ${flat(String(v.err ?? '?'), 60)}`];
    return hours > (STALE[job] ?? Infinity) ? [`${job} ไม่ได้รันมา ${Math.floor(hours)} ชม.`] : [];
  });
  const warn = issues.length ? `\n${flat(`งานเบื้องหลังมีปัญหา: ${issues.join(' · ')}`, 150)}` : '';
  let room = MAX_CHARS - head.length - warn.length;
  /** "\n<title>\n<line>…" with as many whole lines as still fit ('' if none), + the ids of the lines that made it. */
  const block = (title: string, lines: [id: string, line: string][]): [string, string[]] => {
    let out = '';
    const ids: string[] = [];
    for (const [id, l] of lines) { const next = `${out || `\n${title}`}\n${l}`; if (next.length > room) break; out = next; if (id) ids.push(id); }
    room -= out.length;
    return [out, ids];
  };
  // budget order: handoffs (≤4 short lines, time-critical) → rules → cards → recent; shown rules first
  const [hand, handIds] = block(`ส่งต่องานข้าม AI — ${DATA_NOTE} (memory_handoff action=claim id=N = รับงานต่อ):`,
    handoffs.map((l) => [l.match(/^#\d+/)?.[0] ?? '', flat(l, 200)])); // the "another app worked here" line has no id
  const [rule, ruleIds] = block('กฎ/ข้อตกลงที่ลุงจืดให้ไว้:', rules.rows.map((r) => [r.fid, `- [${r.fid}] ${flat(factText(r.txt ?? ''), 180)}`]));
  const [card, cardIds] = block('session ล่าสุด:', cards.rows.map((r) => {
    const t = String(r.txt ?? '');
    const title = t.match(/\n# ([^\n]+)/)?.[1] ?? '';
    const summary = t.split('\n\n')[1] ?? '';
    return [r.fid, `- ${r.valid_at.toISOString().slice(0, 10)} [${r.fid}] ${flat(title, 70)}: ${flat(summary, 160)}`];
  }));
  const [fresh, freshIds] = block('งานล่าสุดที่ยังไม่สรุป:', recent.rows.sort((a, b) => b.ts - a.ts).slice(0, cards.rows.length ? 3 : 5)
    .map((x) => [`session:${x.session_id}`, `- ${x.ts.toISOString().slice(0, 10)} ${flat(x.q, 90)}`]));
  const ctx = warn + rule + hand + card + fresh;
  if (ctx) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: head + ctx },
    }));
    // what this chat was given, ids only (cli stats --injected): one local round trip after the reply; table missing → skipped
    await db.query(`INSERT INTO injections (client, project, session, ids, chars) VALUES ($1, $2, $3, $4, $5)`,
      [app, project, session, [...ruleIds, ...handIds, ...cardIds, ...freshIds], (head + ctx).length]).catch(() => {});
  }
  await db.end();
} catch {
  // best-effort
}
// no process.exit here: on Windows, stdout to a pipe is async and would be cut off
