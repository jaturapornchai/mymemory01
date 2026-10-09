// Daily activity note (no LLM): daily/YYYY-MM-DD.md in the memory-hub vault, the habit second-brain users keep longest.
// Per project: which AI apps ran how many sessions and when, each session's topic (its dream card, else its first prompt),
// GitHub commits / issues, facts created or superseded that day. SQL over what is already indexed.
// Every app reads the vault, so Claude-only data never gets in: no PRIVATE_TOOLS source and no chat that was shown one
// (hide_as), hence no places. The nightly writes yesterday; a note ลุงจืด edited is his (notes.writeNote keeps it).
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { PRIVATE_TOOLS } from './guard.ts';
import { clean, projectName } from './importer.ts';
import { type Fm, isEdited, MEMORY_VAULT, parseNote, projectSlug, renderNote, sha, writeNote, type WriteResult } from './notes.ts';
import { beforeMachineWrite, commitBatch } from './vault-git.ts';

const PRIVATE = [...PRIVATE_TOOLS];
const NOT_APPS = ['obsidian', 'github', ...PRIVATE]; // sources.tool that are no AI app
const CAP = { sessions: 8, commits: 5, issues: 5, facts: 3, superseded: 2 }; // lines per project stay short; the hub has the rest
const TD = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

/** YYYY-MM-DD in ลุงจืด's time zone (Asia/Bangkok, no DST). */
export const bkkDay = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
export const yesterday = (now = new Date()) => bkkDay(new Date(now.getTime() - 864e5));
const hm = (d: Date) => d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** One short line of someone's text: redacted, and no [[link]] / #tag / alias break of its own (the note's links are the machine's). */
const line = (s: string, n: number) => {
  const t = clean(s).replace(/[[\]|]+/g, ' ').replace(/#(?=[^\s#\d])/g, '# ').replace(/\s+/g, ' ').trim(); // #12 is no tag
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const base = (path: string) => path.replace(/\\/g, '/').replace(/^.*\//, '').replace(/\.md$/, '');
/** Up to cap shown items (null = hidden by placeGuard), then +N for the rest. */
const more = (xs: (string | null)[], cap: number, tail = '') => {
  const shown = xs.filter((x) => x !== null).slice(0, cap);
  return [...shown, ...(xs.length > shown.length ? [`+${xs.length - shown.length}${tail}`] : [])].join(' · ');
};
const HIDDEN = '(ซ่อน: สถานที่)';

// A line naming a place or a trip is not written: his own chats and memory_save notes can (a non-Claude app asking "ไปไอซ์แลนด์
// ล่าสุดเมื่อไหร่" is no hidden chat; a note saved while building the Timeline import quotes trips). Places = every country
// name + every place his Timeline text names (read here only to leave lines out): regions ("ไป<name>เมื่อไหร่"), อ./จ./เขต
// districts and provinces, "ไทย (English)" towns abroad, English labels. ponytail: a place he never went to that is no
// country is not caught; a common word that is also a place name hides a harmless line (safe side).
const TRIP = String.raw`ทริป|เที่ยว|ต่างประเทศ|ต่างจังหวัด|ไปไหนมา|ที่ไหนมาบ้าง|ที่พัก|บิน|google (?:maps )?timeline|ไทม์ไลน์|\btrips?\b|\btravel|\bvacation|\bflights?\b`;
const COMMON = new Set(['เลย', 'ตาก', 'แพร่', 'น่าน', 'เช็ก', 'ไทย', 'Thailand', 'บ้าน']); // place names that are everyday words (เผยแพร่, เช็ก = check)
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export async function placeGuard(db: pg.Pool): Promise<(s: string) => boolean> {
  const th = new Set<string>(), en = new Set<string>();
  const rows = (await db.query(`SELECT t.text_redacted txt FROM turns t JOIN sources s ON s.id = t.source_id WHERE s.tool = 'google-timeline'`)).rows;
  for (const { txt } of rows) {
    for (const m of String(txt).matchAll(/(?:เคย)?ไป([^\s·]+?)(?:เมื่อไหร่|ไหม)/g)) th.add(m[1]);
    for (const m of String(txt).matchAll(/(?:อ\.|จ\.|เขต)([฀-๿]{2,})/g)) th.add(m[1]);
    for (const m of String(txt).matchAll(/([฀-๿]{2,}) \(([A-Z][A-Za-z .'’-]+)\)/g)) { th.add(m[1]); en.add(m[2]); }
    for (const m of String(txt).matchAll(/\(([A-Z][A-Za-z .'’-]+)\)/g)) en.add(m[1]);
  }
  const thR = new Intl.DisplayNames('th', { type: 'region' }), enR = new Intl.DisplayNames('en', { type: 'region' });
  for (let a = 65; a < 91; a++) for (let b = 65; b < 91; b++) {
    const cc = String.fromCharCode(a, b);
    if (thR.of(cc) !== cc) { th.add(thR.of(cc)!); en.add(enR.of(cc)!); }
  }
  // ≥ 3 Thai / 4 Latin chars: a 2-letter district that is also an everyday word or a "(NaN)" label would hide every other line
  const alt = (xs: Set<string>, min: number) => [...xs].map((x) => x.trim()).filter((x) => x.length >= min && !COMMON.has(x)).map(esc).join('|');
  const re = new RegExp(`${TRIP}|${alt(th, 3)}|\\b(?:${alt(en, 4)})\\b`, 'i');
  return (s: string) => !re.test(s);
}

type Items = (string | null)[];
type Project = { t0?: Date; t1?: Date; apps: Map<string, number>; sessions: string[]; commits: Items; issues: Items; facts: Items; old: Items };

/** The note for one local day, or null when nothing happened. */
export async function dailyNote(db: pg.Pool, day: string): Promise<{ rel: string; fm: Fm; body: string } | null> {
  // round trip, not Date.parse alone: it rolls 2026-02-31 over to March 3 (a note named for a day that does not exist)
  const utc = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(utc.getTime()) || utc.toISOString().slice(0, 10) !== day) throw new Error(`not a date: ${day} (YYYY-MM-DD)`);
  const from = new Date(`${day}T00:00:00+07:00`), to = new Date(from.getTime() + 864e5);
  const q = async (sql: string, p: unknown[]) => (await db.query(sql, p)).rows;
  const sessions = await q(
    `SELECT s.tool, s.kind, s.session_id, coalesce(s.project, '') project, min(t.ts) t0, max(t.ts) t1
     FROM turns t JOIN sources s ON s.id = t.source_id
     WHERE t.ts >= $1 AND t.ts < $2 AND s.kind IN ('main', 'headless') AND s.tool <> ALL($3::text[])
       AND NOT EXISTS (SELECT 1 FROM sources h WHERE h.session_id = s.session_id AND coalesce(h.hide_as, h.tool) = ANY($4::text[]))
     GROUP BY 1, 2, 3, 4 ORDER BY t0`, [from, to, NOT_APPS, PRIVATE]);
  const ids = sessions.filter((s) => s.kind === 'main').map((s) => s.session_id);
  const [cards, prompts, github, facts] = await Promise.all([
    q(`SELECT DISTINCT ON (sid) sid, s.path, (SELECT t.text_redacted FROM turns t WHERE t.source_id = s.id ORDER BY t.seq LIMIT 1) txt
       FROM facts f JOIN sources s ON s.id = f.source_id CROSS JOIN unnest(f.session_ids) sid
       WHERE f.kind = 'card' AND f.session_ids && $1::text[] AND sid = ANY($1::text[]) ORDER BY sid, f.valid_at DESC`, [ids]),
    q(`SELECT DISTINCT ON (t.session_id) t.session_id, t.text_redacted q FROM turns t JOIN sources s ON s.id = t.source_id
       WHERE t.session_id = ANY($1::text[]) AND s.kind = 'main' AND t.role = 'user' AND left(t.text_redacted, 1) <> '['
       ORDER BY t.session_id, t.seq`, [ids]),
    q(`SELECT s.session_id, coalesce(s.project, '') project, t.ts, t.text_redacted txt,
              (SELECT h.text_redacted FROM turns h WHERE h.source_id = s.id ORDER BY h.seq LIMIT 1) head
       FROM turns t JOIN sources s ON s.id = t.source_id
       WHERE s.tool = 'github' AND t.ts >= $1 AND t.ts < $2 AND (s.session_id LIKE '%:commits' OR s.session_id ~ '#[0-9]+$')
       ORDER BY t.ts`, [from, to]),
    q(`SELECT coalesce(f.project, '') project, s.path, (SELECT t.text_redacted FROM turns t WHERE t.source_id = s.id LIMIT 1) txt, f.created_at >= $1 AND f.created_at < $2 AS created,
              s.status = 'superseded' AND f.expired_at >= $1 AND f.expired_at < $2 AS superseded, f.created_at, f.expired_at
       FROM facts f JOIN sources s ON s.id = f.source_id
       WHERE f.kind <> 'card' AND ((f.created_at >= $1 AND f.created_at < $2) OR (f.expired_at >= $1 AND f.expired_at < $2))
         AND NOT EXISTS (SELECT 1 FROM sources h WHERE h.session_id = ANY(f.session_ids) AND coalesce(h.hide_as, h.tool) = ANY($3::text[]))
       ORDER BY f.importance DESC NULLS LAST, f.created_at, f.fid`, [from, to, PRIVATE]), // a chat hidden after it was dreamt
  ]);

  const projects = new Map<string, Project>();
  // keyed by folder name, like the hub notes (hubs/<name> hub.md): two paths ending in one name share a section
  const at = (path: string, p = projectName(path)) => projects.get(p) ?? projects.set(p, { apps: new Map(), sessions: [], commits: [], issues: [], facts: [], old: [] }).get(p)!;
  const seen = (p: Project, t: Date) => { if (!p.t0 || t < p.t0) p.t0 = t; if (!p.t1 || t > p.t1) p.t1 = t; };
  const ok = await placeGuard(db);
  const say = (s: string, n: number) => { const t = line(s, n); return ok(t) ? t : null; };
  const card = new Map(cards.map((c) => [c.sid, c]));
  const prompt = new Map(prompts.map((r) => [r.session_id, r.q]));
  for (const s of sessions) {
    const p = at(s.project);
    seen(p, s.t0); seen(p, s.t1);
    const app = s.kind === 'headless' ? `${s.tool} exec` : s.tool; // codex exec runs: counted, no topic (scripts start them)
    p.apps.set(app, (p.apps.get(app) ?? 0) + 1);
    if (s.kind !== 'main') continue;
    const c = card.get(s.session_id);
    const title = c && String(c.txt ?? '').match(/\n# ([^\n]+)/)?.[1]; // card note text = "# <file>\n# <title>\n\n<summary>"
    const topic = c ? (ok(String(c.txt)) ? say(title || base(c.path), 70) : null) : say(prompt.get(s.session_id) ?? '-', 70); // whole card checked
    p.sessions.push(`${hm(s.t0)} ${s.tool} ${topic === null ? HIDDEN : c ? `[[${base(c.path)}|${topic}]]` : topic}`);
  }
  const issues = new Set<string>();
  for (const g of github) {
    const p = at(g.project);
    seen(p, g.ts);
    if (g.session_id.endsWith(':commits')) p.commits.push(say(String(g.txt).split('\n')[0].replace(/^\[commit (\w+)\]/, '$1'), 70));
    else if (!issues.has(g.session_id) && issues.add(g.session_id)) p.issues.push(say(String(g.head ?? '').split('\n')[0].replace(/^\[(?:issue|PR) (#\d+)\]/, '$1'), 80));
  }
  for (const f of facts) {
    const l = ok(`${base(f.path)}\n${f.txt ?? ''}`) ? `[[${base(f.path)}]]` : null; // its file name is its text: the whole note is checked
    if (f.created) at(f.project).facts.push(l);
    if (f.superseded) at(f.project).old.push(l);
  }
  if (!projects.size) return null;

  const last = [...sessions.map((s) => s.t1), ...github.map((g) => g.ts), ...facts.map((f) => (f.created ? f.created_at : f.expired_at))].reduce((a: Date, b: Date) => (b > a ? b : a), from);
  // projects in order of their first activity; facts without one (global) last
  const order = [...projects].sort(([a, x], [b, y]) => Number(!a) - Number(!b) || (x.t0?.getTime() ?? Infinity) - (y.t0?.getTime() ?? Infinity) || a.localeCompare(b));
  let body = `# ${day} ${TD[new Date(`${day}T12:00:00Z`).getUTCDay()]}\n\n` +
    `สรุปอัตโนมัติจากแชต AI, GitHub และความจำของวันนี้ (ไม่รวมข้อมูล Google) — แก้ไฟล์นี้ได้ เครื่องจะไม่เขียนทับ\n`;
  for (const [key, p] of order) {
    const named = ok(key); // a folder named after a place is a place too (no hub link: its file name carries it)
    const hub = named ? ` ([[${projectSlug(key || 'global')} hub]])` : '';
    const head = [named ? key || 'global' : HIDDEN, p.apps.size ? `${hm(p.t0!)}–${hm(p.t1!)}` : '', ...[...p.apps].map(([a, n]) => `${a} ${n}`)];
    const rows = [...p.sessions.slice(0, CAP.sessions), p.sessions.length > CAP.sessions && `+${p.sessions.length - CAP.sessions} sessions`,
      p.commits.length && `commits ${p.commits.length}: ${more(p.commits, CAP.commits)}`,
      p.issues.length && `issue/PR: ${more(p.issues, CAP.issues)}`,
      p.facts.length && `ความจำใหม่ ${p.facts.length}: ${more(p.facts, CAP.facts, hub)}`,
      p.old.length && `ถูกแทนที่ ${p.old.length}: ${more(p.old, CAP.superseded, hub)}`].filter(Boolean);
    body += `\n## ${head.filter(Boolean).join(' · ')}\n${rows.map((r) => `- ${r}\n`).join('')}`;
  }
  return {
    rel: `daily/${day}.md`,
    fm: { memhub: 'daily', date: day, valid_at: last.toISOString(), sessions: String(ids.length), tags: ['memhub/daily'] },
    body,
  };
}

/** Write (or regenerate) one day's note: into the vault (one vault-git commit), or with `out` a preview file only. */
export async function writeDaily(db: pg.Pool, day: string, out?: string): Promise<WriteResult | 'empty' | string> {
  const n = await dailyNote(db, day);
  if (!n) return 'empty';
  if (out) {
    mkdirSync(out, { recursive: true });
    const path = join(out, `${day}.md`);
    writeFileSync(path, renderNote({ ...n.fm, body_sha: sha(n.body) }, n.body));
    return path;
  }
  try { return writeNote(n.rel, n.fm, n.body); }
  finally { commitBatch(MEMORY_VAULT, `daily ${day}`); }
}

/**
 * forget (importer.ts): every daily note already written is rebuilt from what is still indexed, so a forgotten chat's prompt,
 * card title or fact name does not live on in it; a day with nothing left loses its note. One vault commit. A note ลุงจืด
 * edited is his: left as is and returned (it may still quote the forgotten chat). ponytail: all days, ~0.2 s each (forget is
 * rare and manual); only the touched days if the vault ever holds years of them.
 */
export async function rewriteDailies(db: pg.Pool, msg: string): Promise<string[]> {
  const dir = join(MEMORY_VAULT, 'daily');
  const days = existsSync(dir) ? readdirSync(dir).map((f) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f)?.[1]).filter((d): d is string => !!d) : [];
  const kept: string[] = [];
  let changed = false;
  try {
    for (const day of days) {
      const rel = `daily/${day}.md`, path = join(MEMORY_VAULT, rel);
      const n = await dailyNote(db, day);
      if (n) { const r = writeNote(rel, n.fm, n.body); if (r === 'kept-user-edit') kept.push(rel); changed ||= r === 'written'; continue; }
      const { fm, body } = parseNote(readFileSync(path, 'utf8'));
      if (isEdited(fm, body)) { kept.push(rel); continue; }
      beforeMachineWrite(MEMORY_VAULT, rel); // the deletion is this forget's commit (vault-git stages it), not "ลุงจืด แก้เอง"
      unlinkSync(path);
      changed = true;
    }
  } finally { commitBatch(MEMORY_VAULT, msg); }
  if (changed) await (await import('./obsidian.ts')).indexVault(db, MEMORY_VAULT); // drop / re-index now, not at the next sync
  return kept;
}
