// Nightly lint (no LLM, report only: nothing in the index or the notes is changed): what in the memory vault needs ลุงจืด's eye.
// Written to hubs/_lint.md, a machine note of its own: hubs/_review.md is rebuilt whole by every consolidate, so a section
// there would vanish by morning. Newest dated section first, the last KEEP kept; an edited _lint.md is his → never rewritten.
// Ids/titles only; Claude-only sources (guard.PRIVATE_TOOLS, hide_as) are filtered out of every query.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type pg from 'pg';
import { ORPHAN } from './dream.ts';
import { PRIVATE_TOOLS } from './guard.ts';
import { projectName } from './importer.ts';
import { MEMORY_PROJECT, MEMORY_VAULT, parseNote, writeNote } from './notes.ts';
import { indexVault } from './obsidian.ts';
import { commitBatch } from './vault-git.ts';

const CAP = 20, KEEP = 7, DUP = 0.95;
const CONFLICT = 0.8; // same project, cosine CONFLICT..DUP: close enough to be about one thing, not a duplicate
export const LINT_REL = 'hubs/_lint.md';
const PUBLIC = 'coalesce(s.hide_as, s.tool) <> ALL($1::text[])'; // $1 = PRIVATE_TOOLS in every source query
// a fact note dreamed from a Claude-only chat gets hide_as too (importer.hideDreamed); this also checks the chats themselves (= daily.ts)
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
    // a dream fact vs the turns it cites: are its hard anchors (numbers, ids, paths, versions) there? (the citation is only checked to exist)
    support: unsupported(await q(`SELECT f.fid, s.path, (SELECT t.text_redacted FROM turns t WHERE t.source_id = s.id ORDER BY t.seq LIMIT 1) body,
        (SELECT string_agg(t.text_redacted, ' ') FROM turns t WHERE t.uuid = ANY(f.source_uuids) AND t.uuid NOT LIKE 'obs:%') src
      FROM facts f JOIN sources s ON s.id = f.source_id WHERE ${PUBLIC_FACT} AND ${active} AND f.kind <> 'card' AND f.run IS NOT NULL ORDER BY s.path`)),
    // close same-project pairs (not duplicates) whose numbers or negation differ: one may have replaced the other unnoticed
    // (the dream only compares a NEW fact with ≤ 5 neighbours). Same shape as dups, all kinds.
    conflicts: conflicting(await q(`WITH v AS (SELECT f.fid, coalesce(f.project, '') project, s.path,
        (SELECT t.text_redacted FROM turns t WHERE t.source_id = s.id ORDER BY t.seq LIMIT 1) body,
        (SELECT c.embedding FROM chunks c WHERE c.source_id = s.id AND c.embedding IS NOT NULL ORDER BY c.seq_from, c.id LIMIT 1) e
        FROM facts f JOIN sources s ON s.id = f.source_id WHERE ${PUBLIC_FACT} AND ${active} AND f.kind <> 'card')
      SELECT a.fid a, a.path apath, a.body abody, b.fid b, b.path bpath, b.body bbody, 1 - (a.e <=> b.e) sim
      FROM v a JOIN v b ON b.project = a.project AND a.fid < b.fid
      WHERE a.e <=> b.e <= $2 AND a.e <=> b.e > $3 ORDER BY a.e <=> b.e, a.fid, b.fid LIMIT 500`, 1 - CONFLICT, 1 - DUP)),
    // a fact whose text says it replaces another ("แทน F…", "ยกเลิก") while that one is still active: the replacement was only
    // written in the text, nothing retired the old one, and SessionStart kept showing both (3 global rules, 2026-10-09)
    replaced: await q(`WITH v AS (SELECT f.fid, s.path, split_part((SELECT t.text_redacted FROM turns t WHERE t.source_id = s.id ORDER BY t.seq LIMIT 1), E'\\n\\n- ', 1) body
        FROM facts f JOIN sources s ON s.id = f.source_id WHERE ${PUBLIC_FACT} AND ${active} AND f.kind <> 'card')
      SELECT npath, opath, count(*) OVER () total FROM (SELECT DISTINCT n.path npath, o.path opath
        FROM v n CROSS JOIN LATERAL regexp_matches(n.body, 'F[0-9a-f]{8}', 'g') m JOIN v o ON o.fid = m[1]
        WHERE o.fid <> n.fid AND n.body ~* '(แทน|ยกเลิก|replac|supersed)') x ORDER BY 1, 2 LIMIT ${CAP}`),
  };
}

/** Body of a fact note's text ('# title\nbody\n- from:: [[…]]'): the title repeats the body, links are not claims. */
const factText = (t: string) => String(t ?? '').replace(/^# [^\n]*\n/, '').replace(/^\s*- [a-z_]+:: .*$/gm, '');
/** Hard anchors a paraphrase keeps verbatim: Latin/digit tokens with a digit, _ . / : or an inner '-' (dates, fids: the note's own). */
const anchors = (s: string) => [...new Set((s.match(/[A-Za-z0-9_./:-]+/g) ?? []).map((w) => w.replace(/^[.:/-]+|[.:/-]+$/g, '').toLowerCase())
  .filter((w) => w.length >= 3 && /[0-9_./:]|[a-z0-9]-[a-z0-9]/.test(w) && !/^\d{4}-\d\d-\d\d/.test(w) && !/^[fsi][0-9a-f]{8}$/.test(w)))];
const withTotal = (rows: Row[]) => rows.slice(0, CAP).map((r) => ({ ...r, total: rows.length }));
/** Facts with ≥ 2 anchors, more than half of them absent from every cited turn. ponytail: substring match on redacted text, Latin only. */
function unsupported(rows: Row[]) {
  return withTotal(rows.flatMap((r) => {
    const a = anchors(factText(r.body)), src = String(r.src ?? '').toLowerCase(), miss = a.filter((w) => !src.includes(w));
    return a.length >= 2 && miss.length * 2 > a.length ? [{ fid: r.fid, path: r.path, have: a.length - miss.length, of: a.length, miss: miss.slice(0, 3) }] : [];
  }));
}
const NUMS = (s: string) => new Set(s.match(/\d[\d.,:]*\d/g) ?? []);
const NEG = /ไม่|ห้าม|อย่า|ยกเลิก|เลิก|\b(?:not|no|never|don't|doesn't|removed?|stop(?:ped)?|instead)\b/i;
/** Pairs where each side has a number the other lacks, or only one side negates/cancels. */
function conflicting(rows: Row[]) {
  return withTotal(rows.flatMap((r) => {
    const a = factText(r.abody), b = factText(r.bbody), na = NUMS(a), nb = NUMS(b);
    const why = [...na].some((x) => !nb.has(x)) && [...nb].some((x) => !na.has(x)) ? 'ตัวเลขต่างกัน' : NEG.test(a) !== NEG.test(b) ? 'ปฏิเสธ/ยกเลิก' : '';
    return why ? [{ a: r.a, apath: r.apath, b: r.b, bpath: r.bpath, sim: r.sim, why }] : [];
  }));
}
export type LintReport = Awaited<ReturnType<typeof lintReport>>;

const total = (rows: Row[]) => Number(rows[0]?.total ?? 0);
export const lintSummary = (r: LintReport) =>
  `เลยวันหมดอายุ ${total(r.expired)} · อาจซ้ำ ${total(r.dups)} คู่ · แชตต้นทางหายหมด ${total(r.orphans)} · ลิงก์เสีย ${total(r.broken)}` +
  ` · หลักฐานไม่ตรง ${total(r.support)} · อาจขัดกัน ${total(r.conflicts)} · บอกว่าแทนแล้วแต่ของเก่ายัง active ${total(r.replaced)}`;

/** One dated section (Asia/Bangkok day). Wikilinks to notes; a broken target is plain code (a link would be broken itself). */
export function renderLint(r: LintReport, now = new Date()): string {
  const sec = (h: string, rows: Row[], line: (x: Row) => string) =>
    (rows.length ? `\n### ${h} (${total(rows)}${total(rows) > rows.length ? `, แสดง ${rows.length}` : ''})\n${rows.map((x) => `- ${line(x)}`).join('\n')}\n` : '');
  return `## ${day(now)}\n${lintSummary(r)}\n` +
    sec('ข้อเท็จจริงเลยวันหมดอายุแต่ยัง active', r.expired, (x) => `[[${title(x.path)}]] · หมด ${day(x.ended)}`) +
    sec(`อาจซ้ำกัน (โปรเจกต์ + ชนิดเดียวกัน, cosine ≥ ${DUP})`, r.dups, (x) => `[[${title(x.apath)}]] ≈ [[${title(x.bpath)}]] · ${Number(x.sim).toFixed(3)}`) +
    sec('แชตต้นทางถูกลืม/หายจากดัชนีหมดแล้ว', r.orphans, (x) => `[[${title(x.path)}]]`) +
    sec('ข้อความไม่ตรงกับแชตที่อ้าง (ตัวเลข/ชื่อเฉพาะส่วนใหญ่หาไม่พบในแชตต้นทาง)', r.support,
      (x) => `[[${title(x.path)}]] · พบ ${x.have}/${x.of} · ไม่พบ \`${x.miss.join(' ').replace(/`/g, '')}\``) +
    sec(`อาจขัดกัน (โปรเจกต์เดียวกัน, cosine ${CONFLICT}–${DUP})`, r.conflicts,
      (x) => `[[${title(x.apath)}]] ↔ [[${title(x.bpath)}]] · ${x.why} · ${Number(x.sim).toFixed(3)}`) +
    sec('บอกว่าแทนอีกข้อแล้ว แต่ข้อเก่ายัง active', r.replaced, (x) => `[[${title(x.npath)}]] → [[${title(x.opath)}]]`) +
    sec('ลิงก์เสีย', r.broken, (x) => `[[${title(x.path)}]] → \`${String(x.dst_name).replace(/`/g, '')}\``);
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
