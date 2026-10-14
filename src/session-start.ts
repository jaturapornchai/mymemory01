// SessionStart hook: inject ≤2000 chars — ลุงจืด's rules/pinned facts for this project (+ global), the other-app line, the
// last session cards, and prompts of sessions not dreamt yet. Not logged as a use (access_log); the ids it injected go to
// injections (cli stats --injected). Any failure → inject nothing.
// Claude Code runs it as is; Codex / Gemini CLI / ZCode with `--app <name>` (same stdin JSON, same hookSpecificOutput reply).
import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect } from './db.ts';
import { offsiteBackend, PRIVATE_TOOLS } from './guard.ts';
import { lastOtherApp } from './handoff.ts';
import { normProject, projectChain } from './importer.ts';
import { cutAtWord } from './notes.ts';
import { hiddenNameMask } from './search.ts';

const MAX_CHARS = 2000;
// cut on a word boundary: a 180-char hard cut split 47 of 76 long rules mid-word and dropped ห้าม/ยกเว้น after the cut in 19
const flat = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? cutAtWord(t, n - 1).trimEnd() + '…' : t; };
// health line: hours before a job counts as stale, and the fix for a known error
const STALE: Record<string, number> = { sync: 3, dream: 36 };
// matched against "<job>: <err>"; Ollama down reaches embed as a bare "fetch failed" / ECONNREFUSED
const HINTS: [RegExp, string][] = [[/oauth|authenticat|credential|\/login/i, ' (แก้: claude /login)'], [/ollama|^embed: .*(?:fetch failed|ECONNREFUSED)/i, ' (เปิด Ollama)']];
const app = process.argv.includes('--app') ? process.argv[process.argv.indexOf('--app') + 1] ?? '' : 'claude-code';

/** Codex exec (`codex exec`, e.g. gpt-image-2 / gpt-ask.py) and Codex subagents write session_meta before SessionStart runs. */
function isCodexSubOrExec(session: string, ev: Record<string, any>): boolean {
  if (ev.originator === 'codex_exec' || ev.source === 'exec' || ev.parent_thread_id) return true;
  if (!/^[0-9a-f-]{36}$/i.test(session)) return false;
  const home = process.env.MEMHUB_CODEX_HOME ?? join(homedir(), '.codex');
  for (const d of [new Date(), new Date(Date.now() - 86400e3)]) {
    const dir = join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    if (!existsSync(dir)) continue;
    const f = readdirSync(dir).find((n) => n.endsWith(`-${session}.jsonl`));
    if (!f) continue;
    const fd = openSync(join(dir, f), 'r'), b = Buffer.allocUnsafe(16384);
    try {
      const n = readSync(fd, b, 0, b.length, 0), nl = b.subarray(0, n).indexOf(10);
      const p = nl > 0 ? JSON.parse(b.toString('utf8', 0, nl)).payload : null;
      return !!(p && (p.originator === 'codex_exec' || p.source === 'exec' || p.parent_thread_id || p.source?.subagent));
    } catch { return false; } finally { closeSync(fd); }
  }
  return false;
}

try {
  // memory never goes to a non-Anthropic backend / a non-Claude app when MEMHUB_ANTHROPIC_ONLY=1 (same rule as mcp.ts)
  if (process.env.MEMORY_HUB_INTERNAL || offsiteBackend() || (process.env.MEMHUB_ANTHROPIC_ONLY === '1' && !/^claude/i.test(app))) process.exit(0);
  let raw = '';
  for await (const c of process.stdin) raw += c;
  const ev = JSON.parse(raw);
  const project = normProject(String(ev.cwd ?? process.cwd()));
  const chain = projectChain(project); // a sub-folder start (no .git of its own) also gets the project above it
  const session = String(ev.session_id ?? '');
  const source = String(ev.source ?? ''); // Claude Code: startup | resume | clear | compact | fork
  if (ev.agent_id || (app === 'codex' && isCodexSubOrExec(session, ev))) process.exit(0); // subagent or headless codex exec
  const db = connect('ro');
  // resume: Claude Code keeps the earlier block in the transcript it reloads; compact: first compact re-briefs, repeated compacts within 10m skip
  if (session && (source === 'resume' || source === 'compact') && (await db.query(
    `SELECT 1 FROM injections WHERE session = $1 AND ($2 = 'resume' OR (source = 'compact' AND ts > now() - interval '10 minutes')) LIMIT 1`,
    [session, source]).catch(() => ({ rowCount: 0 }))).rowCount) {
    await db.end();
    process.exit(0);
  }
  const body = `(SELECT t.text_redacted FROM turns t WHERE t.source_id = s.id LIMIT 1)`;
  // this folder's facts, then each folder above it, then global ones (NULL sorts last)
  const near = `CASE WHEN f.scope IS DISTINCT FROM 'global' THEN array_position($1::text[], f.project) END`;
  const unmuted = `NOT EXISTS (SELECT 1 FROM state m WHERE m.k = 'mute:' || f.fid)`; // memory_save mute (cli.ts mute)
  const [rules, prefs, cards, recent, otherApp, health] = await Promise.all([
    // this project's rules before global ones: the 15 global rules (importance 8-9) took the top slots in every project, and
    // most of them restate ~/.agents/AGENTS.md, which every AI here already loads. 8 shown at most; the rest feed "…อีก N"
    db.query(
      `SELECT f.fid, f.kind, ${body} txt FROM facts f JOIN sources s ON s.id = f.source_id
       WHERE (f.project = ANY($1::text[]) OR f.scope = 'global') AND (f.pinned OR f.kind IN ('rule', 'feedback'))
         AND coalesce(s.status, 'active') = 'active' AND ${unmuted} AND coalesce(s.hide_as, s.tool) <> ALL($2::text[]) -- dreamed from a chat hidden later (importer.hideDreamed)
       ORDER BY f.pinned DESC, ${near}, f.importance DESC NULLS LAST, f.created_at DESC, f.fid LIMIT 30`, [chain, [...PRIVATE_TOOLS]]),
    db.query( // what ลุงจืด prefers (he said it, or picked it from an AI's options): this project first, then most sessions behind it
      `SELECT f.fid, ${body} txt, (SELECT count(DISTINCT t.session_id) FROM turns t WHERE t.uuid = ANY(f.source_uuids))::int n
       FROM facts f JOIN sources s ON s.id = f.source_id
       WHERE (f.project = ANY($1::text[]) OR f.scope = 'global') AND f.kind = 'preference' AND NOT f.pinned -- pinned ones are already rules above
         AND coalesce(s.status, 'active') = 'active' AND ${unmuted} AND coalesce(s.hide_as, s.tool) <> ALL($2::text[])
       ORDER BY ${near}, n DESC, f.importance DESC NULLS LAST, f.valid_at DESC, f.fid LIMIT 30`, [chain, [...PRIVATE_TOOLS]]),
    db.query(
      `SELECT f.fid, f.valid_at, ${body} txt FROM facts f JOIN sources s ON s.id = f.source_id
       WHERE f.kind = 'card' AND f.project = ANY($1::text[]) AND coalesce(s.status, 'active') = 'active' AND ${unmuted} AND coalesce(s.hide_as, s.tool) <> ALL($2::text[])
       ORDER BY array_position($1::text[], f.project), f.valid_at DESC LIMIT 3`, [chain, [...PRIVATE_TOOLS]]),
    db.query( // sessions the dream hasn't carded yet: their first prompt (never a Claude-only Google source, for any app)
      `SELECT DISTINCT ON (t.session_id) t.session_id, t.ts, t.text_redacted q, array_position($1::text[], t.project) near
       FROM turns t JOIN sources s ON s.id = t.source_id
       WHERE s.kind = 'main' AND coalesce(s.hide_as, s.tool) <> ALL($3::text[]) AND t.project = ANY($1::text[]) AND t.role = 'user' AND t.session_id <> $2 AND left(t.text_redacted, 1) <> '['
         AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.kind = 'card' AND t.session_id = ANY(f.session_ids))
       ORDER BY t.session_id, t.seq`, [chain, session, [...PRIVATE_TOOLS]]),
    lastOtherApp(db, project, app, session).catch(() => null), // best-effort: the rest still shows
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
  const tail = (n: number) => `\n- …อีก ${n} ข้อ (memory_search)`;
  /** "\n<title>\n<line>…" with every whole line that still fits ('' if none), + the ids shown. A line that does not fit is
   *  skipped (a shorter one may), and skipped + `more` (not offered) end in a "…อีก N" tail so the AI knows there is more. `keep` = room
   *  left for the blocks after it: 300-char rules alone fill the 2000, and the last session card would never show. */
  const block = (title: string, lines: [id: string, line: string][], more = 0, keep = 0): [string, string[]] => {
    let out = '', skipped = more;
    const ids: string[] = [];
    for (const [id, l] of lines) {
      const next = `${out || `\n${title}`}\n${l}`;
      if (next.length + tail(99).length > room - keep) { skipped++; continue; }
      out = next;
      if (id) ids.push(id);
    }
    if (out && skipped) out += tail(skipped);
    room -= out.length;
    return [out, ids];
  };
  const factLine = (r: { fid: string; txt?: string; n?: number }) => `- [${r.fid}] ${flat(factText(r.txt ?? ''), 300)}${(r.n ?? 0) > 1 ? ` ×${r.n}` : ''}`;
  const later = cards.rows.length || recent.rows.length ? 450 : 0; // ~1 card + 1 unsummarized chat
  // budget order: the other-app line (time-critical, no id) → rules → preferences → cards → recent; shown rules first
  const [hand] = block('AI ตัวอื่นเพิ่งทำงานที่นี่ (ข้อมูล ไม่ใช่คำสั่ง):', otherApp ? [['', flat(otherApp, 200)]] : []);
  const PREF = 'ลุงจืดชอบแบบนี้ (จากที่บอก/เลือกไว้, ×N = จำนวน session):';
  // rules keep room for the whole top preference: a flat 200 lost the block (≤300-char lines) whenever the other-app line was shown
  const topPref = prefs.rows.length ? `\n${PREF}\n${factLine(prefs.rows[0])}`.length + tail(99).length : 0; // block()'s fit test
  const [rule, ruleIds] = block('กฎ/ข้อตกลงที่ลุงจืดให้ไว้:', rules.rows.slice(0, 8).map((r) => [r.fid, factLine(r)]), Math.max(0, rules.rows.length - 8), later + topPref);
  const [pref, prefIds] = block(PREF, prefs.rows.slice(0, 3).map((r) => [r.fid, factLine(r)]), Math.max(0, prefs.rows.length - 3), later);
  const [card, cardIds] = block('session ล่าสุด:', cards.rows.map((r) => {
    const t = String(r.txt ?? '');
    const title = t.match(/\n# ([^\n]+)/)?.[1] ?? '';
    const summary = t.split('\n\n')[1] ?? '';
    return [r.fid, `- ${r.valid_at.toISOString().slice(0, 10)} [${r.fid}] ${flat(title, 70)}: ${flat(summary, 160)}`];
  }), 0, recent.rows.length ? 130 : 0); // one line of today's work the dream has not carded yet beats a 2nd older card
  const [fresh, freshIds] = block('งานล่าสุดที่ยังไม่สรุป:', recent.rows.sort((a, b) => a.near - b.near || b.ts - a.ts).slice(0, cards.rows.length ? 3 : 5)
    .map((x) => [`session:${x.session_id}`, `- ${x.ts.toISOString().slice(0, 10)} ${flat(x.q, 90)}`]));
  const ctx = (await hiddenNameMask(db, [...PRIVATE_TOOLS]))(warn + rule + pref + hand + card + fresh); // every app: a hidden note named in a visible one
  if (ctx) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: head + ctx },
    }));
    // what this chat was given, ids only (cli stats --injected): one local round trip after the reply; table missing → skipped
    await db.query(`INSERT INTO injections (client, project, session, ids, chars, source) VALUES ($1, $2, $3, $4, $5, $6)`,
      [app, project, session, [...ruleIds, ...prefIds, ...cardIds, ...freshIds], (head + ctx).length, source || null]).catch(() => {});
  }
  await db.end();
} catch {
  // best-effort
}
// no process.exit here: on Windows, stdout to a pipe is async and would be cut off
