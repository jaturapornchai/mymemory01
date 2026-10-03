// Nightly lint (no LLM, report only: nothing in the index or the notes is changed): what in the memory vault needs ลุงจืด's eye.
// Written to hubs/_lint.md, a machine note of its own: hubs/_review.md is rebuilt whole by every consolidate, so a section
// there would vanish by morning. Newest dated section first, the last KEEP kept; an edited _lint.md is his → never rewritten.
// Ids/titles only; Claude-only sources (guard.PRIVATE_TOOLS, hide_as) are filtered out of every query.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type pg from 'pg';
import { ORPHAN } from './dream.ts';
import { PRIVATE_TOOLS } from './guard.ts';
import { ago } from './handoff.ts';
import { projectName } from './importer.ts';
import { MEMORY_PROJECT, MEMORY_VAULT, parseNote, writeNote } from './notes.ts';
import { indexVault } from './obsidian.ts';
import { commitBatch } from './vault-git.ts';

const CAP = 20, KEEP = 7, DUP = 0.95, STALE_HOURS = 48; // stale = nobody claimed it in 2 days (it expires after handoff.DAYS)
export const LINT_REL = 'hubs/_lint.md';
const PUBLIC = 'coalesce(s.hide_as, s.tool) <> ALL($1::text[])'; // $1 = PRIVATE_TOOLS in every source query
// a fact note is an obsidian source (never hide_as): what may be Claude-only is the chat it was dreamed from (= daily.ts)
const PUBLIC_FACT = `${PUBLIC} AND NOT EXISTS (SELECT 1 FROM sources h WHERE h.session_id = ANY(f.session_ids) AND coalesce(h.hide_as, h.tool) = ANY($1::text[]))`;
const title = (path: string) => basename(String(path).replace(/\\/g, '/'), '.md');
const day = (d: Date) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' }); // YYYY-MM-DD
type Row = Record<string, any>;

export async function lintReport(db: pg.Pool, now = new Date()) {
  const q = async (sql: string, ...params: unknown[]): Promise<Row[]> => (await db.query(sql, [[...PRIVATE_TOOLS], ...params])).rows;
  const active = `coalesce(s.status, 'active') = 'active'`;
  return {
    // stated end passed: invalid_at = world time it stopped being true (dream), expired_at = learned it is no longer current
    expired: await q(`SELECT f.fid, s.path, least(f.invalid_at, f.expired_at) ended, count(*) OVER () total FROM facts f JOIN sources s ON s.id = f.source_id
      WHERE ${PUBLIC_FACT} AND ${active} AND f.kind <> 'card' AND (f.invalid_at < $2 OR f.expired_at <= $2) ORDER BY 3, 1 LIMIT ${CAP}`, now),
    // same project + kind, cosine ≥ DUP on the note's first embedded chunk. ponytail: all pairs per group (~800 facts = ms);
    // an HNSW lateral join if the vault grows to tens of thousands
    dups: await q(`WITH v AS (SELECT f.fid, f.kind, coalesce(f.project, '') project, s.path,
        (SELECT c.embedding FROM chunks c WHERE c.source_id = s.id AND c.embedding IS NOT NULL ORDER BY c.seq_from, c.id LIMIT 1) e
        FROM facts f JOIN sources s ON s.id = f.source_id WHERE ${PUBLIC_FACT} AND ${active} AND f.kind <> 'card')
      SELECT a.fid a, a.path apath, b.fid b, b.path bpath, 1 - (a.e <=> b.e) sim, count(*) OVER () total
      FROM v a JOIN v b ON b.project = a.project AND b.kind = a.kind AND a.fid < b.fid
      WHERE a.e <=> b.e <= $2 ORDER BY a.e <=> b.e, a.fid LIMIT ${CAP}`, 1 - DUP),
    // every chat it came from is forgotten / no longer indexed (the forget cascade retires these unless ลุงจืด edited them)
    orphans: await q(`SELECT f.fid, s.path, count(*) OVER () total FROM facts f JOIN sources s ON s.id = f.source_id
      WHERE ${PUBLIC_FACT} AND coalesce(s.status, 'active') IN ('active', 'pending') AND ${ORPHAN} ORDER BY s.path LIMIT ${CAP}`),
    // [[links]] in notes that resolve to no note in any vault; hubs/ is rebuilt every night, so its links are skipped
    broken: await q(`SELECT s.path, l.dst_name, count(*) OVER () total FROM links l JOIN sources s ON s.id = l.src_id
      WHERE ${PUBLIC} AND s.tool = 'obsidian' AND s.project = $2 AND l.dst_id IS NULL AND NOT starts_with(s.session_id, $3)
      ORDER BY s.path, l.dst_name LIMIT ${CAP}`, MEMORY_PROJECT, `${basename(MEMORY_VAULT)}/hubs/`),
    handoffs: (await db.query(`SELECT id, from_app, to_app, project, title, created_at, count(*) OVER () total FROM handoffs
      WHERE status = 'open' AND created_at < $1::timestamptz - make_interval(hours => ${STALE_HOURS}) ORDER BY created_at, id LIMIT ${CAP}`, [now])).rows as Row[],
  };
}
export type LintReport = Awaited<ReturnType<typeof lintReport>>;

const total = (rows: Row[]) => Number(rows[0]?.total ?? 0);
export const lintSummary = (r: LintReport) =>
  `เลยวันหมดอายุ ${total(r.expired)} · อาจซ้ำ ${total(r.dups)} คู่ · แชตต้นทางหายหมด ${total(r.orphans)} · ลิงก์เสีย ${total(r.broken)} · งานส่งต่อค้าง ${total(r.handoffs)}`;

/** One dated section (Asia/Bangkok day). Wikilinks to notes; a broken target is plain code (a link would be broken itself). */
export function renderLint(r: LintReport, now = new Date()): string {
  const sec = (h: string, rows: Row[], line: (x: Row) => string) =>
    (rows.length ? `\n### ${h} (${total(rows)}${total(rows) > rows.length ? `, แสดง ${rows.length}` : ''})\n${rows.map((x) => `- ${line(x)}`).join('\n')}\n` : '');
  return `## ${day(now)}\n${lintSummary(r)}\n` +
    sec('ข้อเท็จจริงเลยวันหมดอายุแต่ยัง active', r.expired, (x) => `[[${title(x.path)}]] · หมด ${day(x.ended)}`) +
    sec(`อาจซ้ำกัน (โปรเจกต์ + ชนิดเดียวกัน, cosine ≥ ${DUP})`, r.dups, (x) => `[[${title(x.apath)}]] ≈ [[${title(x.bpath)}]] · ${Number(x.sim).toFixed(3)}`) +
    sec('แชตต้นทางถูกลืม/หายจากดัชนีหมดแล้ว', r.orphans, (x) => `[[${title(x.path)}]]`) +
    sec('ลิงก์เสีย', r.broken, (x) => `[[${title(x.path)}]] → \`${String(x.dst_name).replace(/`/g, '')}\``) +
    sec(`งานส่งต่อค้าง (เปิดเกิน ${STALE_HOURS} ชม.)`, r.handoffs, (x) => `#${x.id} ${x.from_app} ${ago(x.created_at, +now)} · ` +
      `${x.project ? projectName(x.project) : 'global'}: ${x.to_app ? `(ส่งถึง ${x.to_app})` : x.title}`); // targeted: only that app may read it
}

/** forget: older sections (KEEP days) still link the notes it just deleted → drop those lines. An edited _lint.md is his. */
export async function pruneLint(db: pg.Pool, titles: string[], msg: string) {
  const path = join(MEMORY_VAULT, LINT_REL);
  if (!titles.length || !existsSync(path)) return;
  const { body } = parseNote(readFileSync(path, 'utf8'));
  const pruned = body.split('\n').filter((l) => !titles.some((t) => l.includes(`[[${t}]]`))).join('\n');
  if (pruned === body) return;
  let res;
  try { res = writeNote(LINT_REL, {}, pruned); } finally { commitBatch(MEMORY_VAULT, msg); }
  if (res === 'written') await indexVault(db, MEMORY_VAULT); // searchable until re-indexed
}

/** lint [--dry]: dry = print the section; else hubs/_lint.md (one vault commit). Never fails on what it finds. */
export async function runLint(db: pg.Pool, o: { dry?: boolean; now?: Date } = {}): Promise<string> {
  const now = o.now ?? new Date();
  const r = await lintReport(db, now);
  const section = renderLint(r, now);
  if (o.dry) return section;
  const path = join(MEMORY_VAULT, LINT_REL);
  const DATED = /^## \d{4}-\d{2}-\d{2}\n/;
  const older = (existsSync(path) ? parseNote(readFileSync(path, 'utf8')).body : '').split(/^(?=## \d{4}-\d{2}-\d{2}\n)/m)
    .filter((s) => DATED.test(s) && !s.startsWith(`## ${day(now)}\n`)); // a rerun the same day replaces its section
  const body = `# Lint\n\nตรวจสุขภาพความจำทุกคืน (\`node src/cli.ts lint\`): รายงานอย่างเดียว ไม่แก้อะไร · ใหม่สุดอยู่บน เก็บ ${KEEP} วัน\n\n` +
    [section, ...older].slice(0, KEEP).map((s) => `${s.trimEnd()}\n`).join('\n');
  let res;
  try { res = writeNote(LINT_REL, { memhub: 'hub', tags: ['memhub/lint'] }, body); }
  finally { commitBatch(MEMORY_VAULT, `lint ${day(now)}: ${lintSummary(r)}`); }
  return res === 'kept-user-edit' ? `${LINT_REL} was edited by ลุงจืด: left alone. Tonight's report:\n${section}` : `${LINT_REL} ${res}: ${lintSummary(r)}`;
}
