// Accuracy of the curated memory (ลุงจืด 2026-10-18): two current facts saying opposite things about
// one name (CONFLICT), a fact citing a local path that is gone (STALE), a pending correction of a shown fact, the project
// identity shown first at SessionStart + the project's old names (aliases), notes on raw chunks, near-duplicate saves, "did he
// type this" for memory_save user_quote, and "where is X" lookups. Flags are state rows like mute: — conflict:<fid>,
// stale:<fid>, identity:<project>, note:<turn uuid> — so no schema change and a re-index never loses them; lint --fix
// recomputes conflict:/stale: every night, memory_save adds conflict: at once.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type pg from 'pg';
import { embed, toVec } from './embed.ts';
import { catchAll, LIVE_DIR, projectTree, sameTree } from './importer.ts';
import { day } from './search.ts';
import { words } from './thai.ts';

type Row = Record<string, any>;
/** fact note text (DB first turn) → its claim: no '# title' line, no '- from:: [[…]]' link lines. */
export const claim = (t: string) => String(t ?? '').replace(/^# [^\n]*\n/, '').split('\n\n- ')[0];
const ACTIVE = `coalesce(s.status, 'active') = 'active'`;
const VISIBLE = (p: string) => `coalesce(s.hide_as, s.tool) <> ALL(${p}::text[]) AND NOT EXISTS (SELECT 1 FROM sources h WHERE h.session_id = ANY(f.session_ids) AND coalesce(h.hide_as, h.tool) = ANY(${p}::text[]))`;
const TEXT = `(SELECT t.text_redacted FROM turns t WHERE t.source_id = s.id ORDER BY t.seq LIMIT 1)`;

// ---- CONFLICT: one name, opposite polarity ("POS sync กับ BC AI Account" vs "myapp ไม่เกี่ยวกับ BC") ----
// A name = a capitalized word or acronym (BC, CHAMP, ObjectBox), not inside a path; generic tech words name nothing.
const STOP = new Set('ai api ui ux url id db sql json http https ok pr git mcp cli llm os pc the this that and for with from use it is if'.split(' '));
// exclusion of a thing ("ไม่เกี่ยวกับ BC", "ห้ามนำ CHAMP", "ไม่ต้องใช้ Gemma", "not BC"), not any negation: "ไม่ต้อง commit" names
// nothing. อย่าง (= like) is no อย่า.
const CUE = /ไม่(?:ได้)?(?:เกี่ยว(?:ข้อง)?|ยุ่ง)(?:กับ)?|ไม่ใช่|ไม่(?:ต้อง)?(?:ใช้|พึ่ง)|เลิกใช้|ยกเลิก|ห้าม(?:นำ|ใช้|แก้|ปน|อ้างอิง)?|อย่า(?!ง)|\b(?:not|never|no longer|instead of|without)\b|n't\b/gi;
const CLAUSE = /[,;!?()\n]|\.\s|\s(?:and|but)\s|และ|แต่/i;
// a clause about the past or a rename asserts nothing now: "(แทนการยกเลิก Futures ก่อนหน้า)", "เปลี่ยนชื่อ BC AI เป็น SML AI";
// nor does what someone calls it: "แม้ลุงจืดพูดว่า 'BC Ai Account' ก็หมายถึงระบบใน repo นี้"
const HIST = /เปลี่ยนชื่อ|rename|แทน|instead|เดิม|ก่อนหน้า|previous|formerly|เคย|พูดว่า|เรียกว่า/i;
const RUN = /(?<![\w\\/.:-])[A-Z][A-Za-z0-9]+(?: [A-Z][A-Za-z0-9]*)*(?![\w-])/g;
const GLUE = /^[\s"'`(]*(?:(?:หรือ|or|\/|&)[\s"'`(]*)?$/i; // "ไม่ใช้ X", "ห้ามนำ X หรือ Y": the cue or a negated name, then this one
/** name → pos | neg | mix. A name = the first word of a run of capitalized words ("BC Ai Account" = bc: "Account" alone names
 *  nothing); negated when it comes right after an exclusion cue, or after a negated name joined by หรือ/or/slash. "เลิกใช้ระบบข่าวของ
 *  BotTread" negates the ระบบข่าว, not BotTread. ponytail: clause = split on และ/แต่/punctuation. */
export function polarity(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const cl of text.split(CLAUSE)) {
    if (HIST.test(cl)) continue;
    const cues = new Set([...cl.matchAll(CUE)].map((c) => c.index! + c[0].length));
    let last = -1, negEnd = -1; // end of the previous run, and of the previous negated run
    for (const m of cl.matchAll(RUN)) {
      const k = m[0].split(' ')[0].toLowerCase(), at = m.index!;
      const after = (e: number) => e >= 0 && e <= at && GLUE.test(cl.slice(e, at));
      const neg = [...cues].some((e) => e <= at && /^[\s"'`(]*$/.test(cl.slice(e, at))) || (negEnd === last && after(negEnd));
      last = at + m[0].length;
      if (neg) negEnd = last;
      if (STOP.has(k)) continue;
      const p = neg ? 'neg' : 'pos';
      out.set(k, out.has(k) && out.get(k) !== p ? 'mix' : p);
    }
  }
  return out;
}
export type FactText = { fid: string; project: string; kind: string; text: string };
const NORM = new Set(['rule', 'feedback', 'decision', 'preference']);
/** One subject: the same project, or a global fact about the project: the first folder it names is the project's ("d:\myapp
 *  ไม่เกี่ยวกับ BC (D:\bccode)" is about myapp, not bccode), else it names the project at all (≥ 4 chars: "io" names
 *  everything). Two global facts are not compared. ponytail: a subject inside one project = the project itself, and a project
 *  is its folder tree (sameTree: d:/x and d:/x/api are one subject, like search ranks them). */
const sameSubject = (a: FactText, b: FactText) => {
  if (a.project && b.project) return sameTree(a.project, b.project);
  const [g, p] = a.project ? [b, a] : [a, b];
  if (!p.project) return false;
  const names = projectTree(p.project).map((d) => basename(d).toLowerCase()).filter((n) => n.length >= 4);
  const first = claim(g.text).match(/\b[a-z]:[\\/]+([\w.-]+)/i)?.[1].toLowerCase();
  return first ? names.includes(first) : names.some((n) => g.text.toLowerCase().includes(n));
};
/** Pairs (a.fid < b.fid) of one subject where a name is excluded in one ("ไม่เกี่ยวกับ BC") and used in the other ("sync กับ BC"),
 *  and one of them is a rule/decision (two event facts are history, not a contradiction to warn about). */
export function conflictPairs(facts: FactText[], only?: string): { a: string; b: string; name: string }[] {
  const pol = new Map(facts.map((f) => [f.fid, polarity(claim(f.text))]));
  const byName = new Map<string, FactText[]>();
  for (const f of facts) for (const [k, p] of pol.get(f.fid)!) if (p !== 'mix') (byName.get(k) ?? byName.set(k, []).get(k)!).push(f);
  const out = new Map<string, { a: string; b: string; name: string }>();
  for (const [k, fs] of byName) {
    const neg = fs.filter((f) => pol.get(f.fid)!.get(k) === 'neg');
    for (const n of neg) for (const p of fs) {
      if (pol.get(p.fid)!.get(k) !== 'pos' || (only && n.fid !== only && p.fid !== only) || !sameSubject(n, p)) continue;
      if (!NORM.has(n.kind) && !NORM.has(p.kind)) continue;
      const [a, b] = n.fid < p.fid ? [n.fid, p.fid] : [p.fid, n.fid];
      if (!out.has(`${a} ${b}`)) out.set(`${a} ${b}`, { a, b, name: k });
    }
  }
  return [...out.values()];
}
/** Current visible facts (not cards) of this project's tree (sameTree) + global ones (all of them for a global fact), for conflictPairs. */
export async function factTexts(db: pg.Pool, hide: string[], project?: string | null): Promise<FactText[]> {
  return (await db.query(`SELECT f.fid, coalesce(f.project, '') project, f.kind, ${TEXT} text FROM facts f JOIN sources s ON s.id = f.source_id
    WHERE ${ACTIVE} AND f.kind <> 'card' AND ${VISIBLE('$1')}
      AND ($2::text IS NULL OR f.project = ANY($3::text[]) OR starts_with(f.project, $4::text || '/') OR f.scope = 'global')`,
  [hide, project || null, project ? projectTree(project) : [], project && !catchAll(project) ? project : null]))
    .rows.map((r) => ({ fid: r.fid, project: r.project, kind: r.kind, text: String(r.text ?? '') }));
}

// ---- STALE: a local path the fact cites is gone ----
const ABS = /\b[A-Za-z]:[\\/][^\s"'`<>|*?,;()[\]{}\u0E00-\u0E7F]*/g;
const REL = /(?<![\w.:\\/~-])(?:[\w-][\w.-]*\/)+[\w-]+\.[A-Za-z]\w{0,4}(?![\w/])/g;
const subdirs = new Map<string, string[]>();
/** "C:\Program" of "C:\Program Files\…": the path went on after a space. */
const cutAtSpace = (p: string) => {
  const i = p.search(/[^\\/]+$/), dir = p.slice(0, i), last = p.slice(i);
  return !!last && existsSync(dir) && readdirSync(dir).some((n) => n.startsWith(last + ' '));
};
/** Paths in `text` that do not exist here: absolute ones on a drive this machine has; relative ones (docs/x.md) only when their
 *  first folder is in the fact's project folder or one of its top-level folders (else it is relative to somewhere deeper or
 *  is no path: owner/repo.js). URLs are skipped. */
export function missingPaths(text: string, project?: string | null): string[] {
  const out = new Set<string>();
  const t = text.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, ' ');
  for (const m of t.match(ABS) ?? []) {
    const p = m.replace(/\\\\+/g, '\\').replace(/:\d+(?::\d+)?$/, '').replace(/[.:\\/]+$/, '');
    if (p.length > 3 && existsSync(p.slice(0, 3)) && !existsSync(p) && !cutAtSpace(p)) out.add(p);
  }
  const root = project && /^[a-z]:\//.test(project) && existsSync(project) ? project : '';
  if (!root) return [...out];
  if (!subdirs.has(root)) subdirs.set(root, readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name)));
  for (const m of t.match(REL) ?? []) {
    const base = [root, ...subdirs.get(root)!].filter((d) => existsSync(join(d, m.split('/')[0])));
    if (base.length && !base.some((d) => existsSync(join(d, m)))) out.add(m);
  }
  return [...out];
}

export type AccuracyFlags = { pairs: { a: string; b: string; name: string; apath: string; bpath: string }[]; stale: { fid: string; path: string; paths: string[] }[] };
/** CONFLICT pairs and STALE paths of the current facts a caller hiding `hide` may see (lint: the report, and with --fix the flags). */
export async function accuracyFlags(db: pg.Pool, hide: string[]): Promise<AccuracyFlags> {
  const facts = await factTexts(db, hide);
  const paths = new Map((await db.query(`SELECT f.fid, s.path FROM facts f JOIN sources s ON s.id = f.source_id WHERE f.fid = ANY($1)`,
    [facts.map((f) => f.fid)])).rows.map((r) => [r.fid as string, String(r.path)]));
  const stale = facts.flatMap((f) => { // the note file is the truth: redaction may have masked a path in the DB text
    const p = paths.get(f.fid) ?? '', body = p && existsSync(p) ? claim(readFileSync(p, 'utf8').replace(/^---\n[\s\S]*?\n---\n?/, '')) : claim(f.text);
    const miss = missingPaths(body, f.project);
    return miss.length ? [{ fid: f.fid, path: p, paths: miss }] : [];
  });
  return { pairs: conflictPairs(facts).map((x) => ({ ...x, apath: paths.get(x.a) ?? '', bpath: paths.get(x.b) ?? '' })), stale };
}
/** lint --fix: every conflict:/stale: row replaced by these (a fixed or retired fact loses its flag). One transaction. */
export async function saveFlags(db: pg.Pool, f: AccuracyFlags) {
  const rows = new Map<string, Row>();
  for (const { a, b, name } of f.pairs) for (const [x, y] of [[a, b], [b, a]]) {
    const r = rows.get(`conflict:${x}`) ?? { with: [], on: [] };
    r.with.push(y); r.on.push(name); rows.set(`conflict:${x}`, r);
  }
  for (const s of f.stale) rows.set(`stale:${s.fid}`, { paths: s.paths });
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(`DELETE FROM state WHERE k LIKE 'conflict:%' OR k LIKE 'stale:%'`);
    if (rows.size) await c.query(`INSERT INTO state (k, v) SELECT * FROM jsonb_each($1::jsonb)`, [Object.fromEntries(rows)]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
/** memory_save: flag a new contradiction both ways at once (cli.ts conflict). */
export async function addConflict(db: pg.Pool, fid: string, others: [string, string][]) {
  for (const [x, y, name] of others.flatMap(([o, n]) => [[fid, o, n], [o, fid, n]]))
    await db.query(`INSERT INTO state (k, v) VALUES ($1, jsonb_build_object('with', jsonb_build_array($2::text), 'on', jsonb_build_array($3::text)))
      ON CONFLICT (k) DO UPDATE SET v = CASE WHEN state.v->'with' ? $2 THEN state.v
        ELSE jsonb_build_object('with', (state.v->'with') || to_jsonb($2::text), 'on', (state.v->'on') || to_jsonb($3::text)) END`, [`conflict:${x}`, y, name]);
}

// ---- identity + aliases ----
export type Alias = { old: string; new: string; since: string; fid?: string; match?: string };
export type Identity = { project: string; fid: string; text: string; aliases: Alias[] };
/** The identity fact of the first project in `chain` that has one (state identity:<project>), with its text if still current. */
export async function identityOf(db: pg.Pool, chain: string[], hide: string[] = []): Promise<Identity | null> {
  if (!chain.length) return null;
  const rows = (await db.query(`SELECT k, v FROM state WHERE k = ANY($1)`, [chain.map((p) => `identity:${p}`)])).rows;
  const r = chain.map((p) => rows.find((x) => x.k === `identity:${p}`)).find(Boolean);
  if (!r) return null;
  const t = r.v.fid ? (await db.query(`SELECT ${TEXT} txt FROM facts f JOIN sources s ON s.id = f.source_id WHERE f.fid = $1 AND ${ACTIVE} AND ${VISIBLE('$2')}`,
    [r.v.fid, hide])).rows[0]?.txt : '';
  return { project: r.k.slice(9), fid: t ? r.v.fid : '', text: t ? claim(t) : '', aliases: r.v.aliases ?? [] };
}
export const aliasRe = (a: Alias) => new RegExp(a.match ?? a.old.split(/\s+/).slice(0, 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'i');
const aliasNote = (a: Alias) => `${a.old} ในข้อความนี้ = ${a.new} (ชื่อเก่า ก่อนเปลี่ยนชื่อทั้ง repo${a.fid ? ` ตาม [${a.fid}]` : ''} ${a.since})`;
/** "this repo is not BC/CHAMP" → the global BC/CHAMP rules every AI loads do not apply here; where to look instead. */
export function notBcLine(id: Identity | null): string {
  if (!id?.text || !/ไม่(?:เกี่ยว(?:ข้อง)?กับ|ใช่)\s*(?:ระบบ\s*)?BC|\bnot\s+(?:related\s+to\s+)?BC\b/i.test(id.text)) return '';
  const ref = id.text.match(/อ้างอิง[^\n]*?([A-Za-z]:\\[\w\\.-]*\w)/)?.[1];
  return `⚠ กฎกลางส่วน BC/CHAMP (~/.agents/AGENTS.md: Identity, ข้อ 18, UI Baseline ข้อ 3) ไม่ใช้กับ project นี้${ref ? ` — อ้างอิง ${ref} แทน` : ''}`;
}

// ---- per-item warnings for search hits and SessionStart lines ----
export type Item = { key: string; fid?: string | null; turn?: string | null; project?: string | null; ts?: Date | null; text?: string };
export type Flags = { tags: string[]; lines: string[] };
/** tags (header: CONFLICT, STALE, pending correction) and lines (the conflicting fact, notes, alias notes) per item key. */
export async function flagsFor(db: pg.Pool, items: Item[], hide: string[]): Promise<Map<string, Flags>> {
  const out = new Map<string, Flags>();
  if (!items.length) return out;
  const fids = [...new Set(items.map((i) => i.fid).filter(Boolean) as string[])];
  const projects = [...new Set(items.map((i) => i.project).filter(Boolean) as string[])];
  const keys = [...fids.flatMap((f) => [`conflict:${f}`, `stale:${f}`]), ...items.filter((i) => i.turn).map((i) => `note:${i.turn}`), ...projects.map((p) => `identity:${p}`)];
  const [st, fix] = await Promise.all([db.query(`SELECT k, v FROM state WHERE k = ANY($1)`, [keys]),
    db.query(`SELECT f.review_target t, f.fid FROM facts f JOIN sources s ON s.id = f.source_id
      WHERE s.status = 'pending' AND f.review_target = ANY($1) AND ${VISIBLE('$2')} ORDER BY f.fid`, [fids, hide])]);
  const state = new Map(st.rows.map((r) => [r.k as string, r.v]));
  const partners = [...new Set(fids.flatMap((f) => state.get(`conflict:${f}`)?.with ?? []))] as string[];
  // + the shown facts' own dates: a CONFLICT tag says which side is newer (ลุงจืด 2026-10-18)
  const ptxt = new Map(partners.length ? (await db.query(`SELECT f.fid, f.valid_at, ${TEXT} txt FROM facts f JOIN sources s ON s.id = f.source_id
    WHERE f.fid = ANY($1) AND ${ACTIVE} AND ${VISIBLE('$2')}`, [[...partners, ...fids], hide])).rows
    .map((r) => [r.fid as string, { txt: claim(r.txt).replace(/\s+/g, ' ').trim(), at: r.valid_at as Date }]) : []);
  for (const i of items) {
    const f: Flags = { tags: [], lines: [] }, c = i.fid ? state.get(`conflict:${i.fid}`) : null;
    (c?.with ?? []).forEach((o: string, n: number) => {
      const p = ptxt.get(o);
      if (!p) return; // the other one is no longer current
      const ta = ptxt.get(i.fid!)?.at ?? i.ts ?? null;
      const newer = day(p.at) === day(ta) ? 'วันเดียวกัน' : new Date(p.at) > new Date(ta ?? 0) ? 'ใหม่กว่า' : 'เก่ากว่า';
      f.tags.push(`⚠CONFLICT ↔ [${o}] (${c.on[n]}) · อันนี้ ${day(ta)} · [${o}] ${day(p.at)} ${newer}`);
      f.lines.push(`⚠ ขัดกับ [${o}] เรื่อง ${c.on[n]}: ${p.txt.slice(0, 160)}`);
    });
    const s = i.fid ? state.get(`stale:${i.fid}`) : null;
    if (s) f.tags.push(`STALE: ไม่พบ ${s.paths.slice(0, 2).join(', ')}`);
    const p = fix.rows.filter((r) => r.t === i.fid).map((r) => `[${r.fid}]`);
    if (p.length) f.tags.push(`มีฉบับแก้รออนุมัติ ${p.join(' ')}`);
    const note = i.turn ? state.get(`note:${i.turn}`) : null;
    if (note) f.lines.push(`หมายเหตุ: ${note.text}`);
    for (const a of (i.project ? state.get(`identity:${i.project}`)?.aliases ?? [] : []) as Alias[])
      if (i.ts && new Date(i.ts) < new Date(a.since) && aliasRe(a).test(i.text ?? '') && !note?.text.includes(aliasNote(a))) f.lines.push(`หมายเหตุ: ${aliasNote(a)}`);
    if (f.tags.length || f.lines.length) out.set(i.key, f);
  }
  return out;
}

// ---- near-duplicates (memory_save, Claude memory import) ----
/** ≤ `n` current facts (not cards) of this project or global that say nearly the same: cosine ≥ `min` on the first chunk, or
 *  ≥ 60 % shared words (embedder down > 1.5 s, or a fact not embedded yet). `kind` = only that kind. */
export async function nearFacts(db: pg.Pool, content: string, project: string, hide: string[], skip: string[], o: { kind?: string; min?: number; n?: number } = {}) {
  const vec = await embed([content], 1500).then((e) => toVec(e[0]), () => null);
  const rows = (await db.query(
    `SELECT f.fid, ${TEXT} txt,
            1 - ((SELECT c.embedding FROM chunks c WHERE c.source_id = s.id AND c.embedding IS NOT NULL ORDER BY c.seq_from, c.id LIMIT 1) <=> $5::halfvec) sim
     FROM facts f JOIN sources s ON s.id = f.source_id
     WHERE f.kind <> 'card' AND ($1::text IS NULL OR f.kind = $1) AND (f.project = $2 OR f.scope = 'global') AND ${ACTIVE} AND f.fid <> ALL($3)
       AND ${VISIBLE('$4')} ORDER BY sim DESC NULLS LAST, f.created_at DESC LIMIT 300`, [o.kind ?? null, project, skip, hide, vec])).rows;
  const bag = (t: string) => new Set(words(t));
  const mine = bag(content), min = o.min ?? 0.85;
  const overlap = (t: string) => { const b = bag(t); let k = 0; for (const w of b) if (mine.has(w)) k++; return k / Math.max(1, new Set([...mine, ...b]).size); };
  // the same exclusion ("… ไม่เกี่ยวกับ BC" in both, mix = negated somewhere) is the same claim in other words: bge-m3 put Ffd83584a ↔ F7b071c82 at 0.79
  const neg = (t: string) => [...polarity(t)].filter(([, p]) => p !== 'pos').map(([k]) => k), myNeg = new Set(neg(content));
  return rows.map((r) => ({ fid: r.fid as string, sim: r.sim as number | null, txt: claim(r.txt) }))
    .filter((r) => (r.sim ?? 0) >= min || overlap(r.txt) >= 0.6 || ((r.sim ?? 0) >= min - 0.1 && neg(r.txt).some((k) => myNeg.has(k)))).slice(0, o.n ?? 2)
    .map((r) => ({ fid: r.fid, sim: r.sim, txt: r.txt.replace(/\s+/g, ' ').trim().slice(0, 60) }));
}

// ---- user_quote: did ลุงจืด type this? ----
const RECENT = 30 * 60e3, TAIL = 4 << 20;
const userText = (o: Row): string | null => { // a Claude Code user line he typed (a tool result is not his: a web page could say anything)
  if (o?.type !== 'user' || o.message?.role !== 'user' || o.isMeta) return null;
  const c = o.message.content;
  return typeof c === 'string' ? c : Array.isArray(c) && !c.some((b) => b?.type === 'tool_result') ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : null;
};
/** memory_save user_quote: his words (≥ 6 chars, whitespace-insensitive) in a user turn of a main chat from the last 2 days, or in a live
 *  Claude Code transcript written in the last 30 min (this turn is not indexed yet). ponytail: other apps' live files are not read;
 *  their quote counts once the Stop hook indexed the turn, else the correction waits for review as before. */
export async function userSaid(db: pg.Pool, quote: string, liveDir = LIVE_DIR): Promise<boolean> {
  const q = quote.replace(/\s+/g, ' ').trim();
  if (q.length < 6) return false;
  if ((await db.query(`SELECT 1 FROM sources s JOIN turns t ON t.source_id = s.id WHERE s.kind = 'main' AND t.role = 'user'
    AND t.ts > now() - interval '2 days' AND left(t.text_redacted, 1) <> '[' AND strpos(regexp_replace(t.text_redacted, '\\s+', ' ', 'g'), $1) > 0 LIMIT 1`, [q])).rowCount) return true;
  const probe = q.split(' ').sort((a, b) => b.length - a.length)[0];
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const e of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 1) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl') && Date.now() - statSync(p).mtimeMs < RECENT) files.push(p);
    }
  };
  walk(liveDir, 0);
  for (const f of files) {
    const size = statSync(f).size, fd = openSync(f, 'r'), b = Buffer.allocUnsafe(Math.min(size, TAIL));
    try { readSync(fd, b, 0, b.length, size - b.length); } finally { closeSync(fd); }
    for (const line of b.toString('utf8').split('\n')) {
      if (!line.includes(probe)) continue;
      try { if (userText(JSON.parse(line))?.replace(/\s+/g, ' ').includes(q)) return true; } catch { /* a cut first line */ }
    }
  }
  return false;
}

// ---- "X อยู่ไหน / path X" ----
const WHERE_Q = /อยู่(?:ที่)?ไหน|ที่อยู่|ตำแหน่ง|โฟลเดอร์|folder|director(?:y|ies)|\bpath\b|\bwhere\b|\blocation\b|\brepo\b/i;
const WHERE_W = new Set('path where folder directory location repo github local machine find code source the file files'.split(' '));
/** Local folders and GitHub repos named in the query, from past tool calls (shell / Read / Glob text in chats) and GitHub sources:
 *  `ตำแหน่ง "x": C:\…\x (มีในเครื่องนี้, 12 แชต, ล่าสุด 2026-10-18) · GitHub owner/x`. '' when the query asks no "where" or nothing
 *  matches. ponytail: computed per query from the words index (≤ 300 newest chunks per term), no table to keep fresh. */
export async function locations(db: pg.Pool, query: string, hide: string[]): Promise<string> {
  if (!WHERE_Q.test(query)) return '';
  const terms = [...new Set(query.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])].filter((t) => !WHERE_W.has(t)).slice(0, 4);
  const out: string[] = [];
  for (const term of terms) {
    const [chunks, gh] = await Promise.all([
      db.query(`SELECT c.text, c.ts FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.words @@ to_tsquery('simple', $1)
        AND coalesce(s.hide_as, s.tool) <> ALL($2::text[]) ORDER BY c.ts DESC NULLS LAST LIMIT 300`, [term, hide]),
      db.query(`SELECT DISTINCT substring(session_id from '^github:([\\w.-]+/[\\w.-]+)') r FROM sources WHERE tool = 'github' AND session_id ILIKE $1`, [`github:%${term}%`]),
    ]);
    const local = new Map<string, { p: string; n: number; last: Date | null }>();
    const repos = new Set<string>(gh.rows.map((r) => r.r).filter((r) => r && r.split('/')[1].toLowerCase().includes(term)));
    for (const c of chunks.rows) {
      const seen = new Set<string>();
      for (const m of String(c.text).match(ABS) ?? []) {
        const segs = m.replace(/\\\\+/g, '\\').split(/[\\/]/), i = segs.findIndex((s) => s.toLowerCase().includes(term));
        if (i < 1) continue;
        const p = segs.slice(0, i + 1).join('\\'), k = p.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        const x = local.get(k) ?? local.set(k, { p, n: 0, last: c.ts }).get(k)!;
        x.n++;
      }
      for (const m of String(c.text).matchAll(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?![\w.-])/gi)) if (m[1].split('/')[1].toLowerCase().includes(term)) repos.add(m[1]);
    }
    const top = [...local.values()].sort((a, b) => b.n - a.n).slice(0, 3);
    if (!top.length && !repos.size) continue;
    out.push(`ตำแหน่ง "${term}" (จาก tool call/GitHub ในความจำ): ` + [...top.map((x) => `${x.p} (${existsSync(x.p) ? 'มีในเครื่องนี้' : 'ไม่พบในเครื่องนี้แล้ว'}, ${x.n} chunk, ล่าสุด ${day(x.last)})`),
      ...(repos.size ? [`GitHub ${[...repos].slice(0, 3).join(', ')}`] : [])].join(' · '));
  }
  return out.join('\n');
}
