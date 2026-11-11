// Weekly review: once a week a Claude session (prompts/session-weekly.md) reads the week's session cards as a whole and keeps
// at most WEEKLY_MAX insight notes: something ลุงจืด had to tell the AI in two or more chats, two decisions that cannot both
// hold, work left open that no later chat picked up. The nightly dream reads one chat at a time and cannot see any of these.
// No LLM call here (as the dream's files runner): weeklyRequest() says what to ask, a subagent answers, saveWeekly() checks
// the answer against the request (ids, evidence) and writes the notes. Cards and rules go in as indexed: already redacted.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type pg from 'pg';
import { z } from 'zod';
import { ACTIVE, VISIBLE } from './accuracy.ts';
import { ROOT } from './db.ts';
import { PRIVATE_TOOLS } from './guard.ts';
import { projectName } from './importer.ts';
import { cutAtWord, fileName, md5, MEMORY_VAULT, sha, writeNote } from './notes.ts';
import { indexVault, resolveLinks } from './obsidian.ts';
import { commitBatch } from './vault-git.ts';

export const WEEKLY_MAX = 3; // he reads every one himself, and the review queue already held 55 he had not got to (2026-11-12)
// MIN_CARDS: under five chats there is no "again" to find. Caps: the busiest week so far had 182 cards of ~1250 chars (2026-10-05).
const DAYS = 7, MIN_CARDS = 5, CARD_CAP = 150, CARD_CHARS = 1500, RULE_CAP = 80, RULE_CHARS = 220;
const bkk = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' }); // YYYY-MM-DD

export const SchemaW = z.object({
  insights: z.array(z.object({
    type: z.enum(['repeat', 'conflict', 'open']),
    title: z.string().min(1).max(80), text: z.string().min(1).max(600), rule: z.string().max(300).nullable().optional(),
    cards: z.array(z.string().regex(/^C\d+$/)).min(1).max(8),
  })).max(WEEKLY_MAX),
});
/** The files-runner shape (id / system / user / schema: what the subagent is shown) + what only saveWeekly needs. */
export type WeeklyRequest = { id: string; system: string; user: string; schema: unknown; run: string; cards: Record<string, { note: string; uuid: string }> };

// note text as indexed = "# <file name>\n<body>"; a card's body ends in its fact links, files and project link: noise for a pattern over weeks
const cardText = (t: unknown) => cutAtWord(String(t ?? '').replace(/^# [^\n]*\n/, '').split(/\n## (?:Facts|Files)\n|\nproject:: /)[0].trim(), CARD_CHARS);
const ruleText = (t: unknown) => cutAtWord(String(t ?? '').replace(/^# [^\n]*\n/, '').split('\n\n- ')[0].replace(/\s+/g, ' ').trim(), RULE_CHARS);

/** What to ask about the `days` before `now`. null = too few chats to hold a pattern: a quiet week costs no tokens. */
export async function weeklyRequest(db: pg.Pool, o: { now?: Date; days?: number; run?: string } = {}): Promise<WeeklyRequest | null> {
  const now = o.now ?? new Date(), from = new Date(+now - (o.days ?? DAYS) * 86400_000);
  const q = async (sql: string, ...p: unknown[]) => (await db.query(sql, [[...PRIVATE_TOOLS], ...p])).rows;
  const BODY = `(SELECT t.text_redacted FROM turns t WHERE t.source_id = s.id ORDER BY t.seq LIMIT 1)`;
  // newest first under the cap, shown oldest first: "no later card picks it up" needs the order of time
  const cards = (await q(`SELECT f.project, f.valid_at, f.source_uuids, s.path, ${BODY} body FROM facts f JOIN sources s ON s.id = f.source_id
    WHERE f.kind = 'card' AND ${ACTIVE} AND ${VISIBLE('$1')} AND f.valid_at >= $2 AND f.valid_at < $3
    ORDER BY f.valid_at DESC, f.fid LIMIT ${CARD_CAP}`, from, now)).reverse();
  if (cards.length < MIN_CARDS) return null;
  // the rules he already gave: without them the first answer every week is a rule he has had for months
  const rules = await q(`SELECT f.scope, f.project, ${BODY} body FROM facts f JOIN sources s ON s.id = f.source_id
    WHERE f.kind = 'rule' AND ${ACTIVE} AND ${VISIBLE('$1')}
    ORDER BY f.pinned DESC, f.importance DESC NULLS LAST, f.created_at DESC, f.fid LIMIT ${RULE_CAP}`);
  const ids: WeeklyRequest['cards'] = {};
  const blocks = cards.map((c, i) => {
    ids[`C${i + 1}`] = { note: basename(String(c.path).replace(/\\/g, '/'), '.md'), uuid: c.source_uuids[0] };
    return `C${i + 1} [${bkk(new Date(c.valid_at))}, ${projectName(c.project ?? '') || 'no project'}]\n${cardText(c.body)}`;
  });
  const user = [`Week: ${bkk(from)} to ${bkk(now)} (Asia/Bangkok). ${cards.length} session cards, ${new Set(cards.map((c) => c.project)).size} projects.`,
    `== EXISTING RULES ==\n${rules.map((r, i) => `R${i + 1} [${r.scope === 'global' || !r.project ? 'global' : projectName(r.project)}]: ${ruleText(r.body)}`).join('\n') || '(none)'}`,
    `== SESSION CARDS (oldest first) ==\n${blocks.join('\n\n')}`].join('\n\n');
  const schema = z.toJSONSchema(SchemaW) as Record<string, unknown>;
  delete schema.$schema;
  return { id: `W-${sha(user)}`, system: readFileSync(join(ROOT, 'prompts', 'weekly-review.md'), 'utf8'), user, schema, run: o.run ?? `${bkk(now)}-weekly`, cards: ids };
}

/** What is wrong with an answer ([] = accepted): the schema, card ids of this request, enough evidence, titles that make distinct files. */
export function checkWeekly(req: WeeklyRequest, answer: unknown): string[] {
  const r = SchemaW.safeParse(answer);
  if (!r.success) return r.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`);
  const errs: string[] = [], files = new Set<string>();
  r.data.insights.forEach((x, i) => {
    const used = [...new Set(x.cards)], unknown = used.filter((c) => !req.cards[c]);
    if (unknown.length) errs.push(`insights.${i}.cards: not in the request: ${unknown.join(', ')}`);
    // one chat is an event, not a pattern; "open" is about one piece of work, so one card is its evidence
    if (x.type !== 'open' && used.length < 2) errs.push(`insights.${i}: "${x.type}" needs two or more different cards as evidence`);
    // "D:\books" in JSON is D: + backspace + "ooks": the backslash must be written \\
    if (/[\x00-\x09\x0b-\x1f]/.test(`${x.title}${x.text}${x.rule ?? ''}`)) errs.push(`insights.${i}: control character (unescaped backslash? write \\\\ in JSON)`);
    const file = fileName(x.title, 60).toLowerCase();
    if (files.has(file)) errs.push(`insights.${i}.title: same as an earlier insight's`);
    files.add(file);
  });
  return errs;
}

/** Check the answer, write each insight as a note (memhub: insight, linked to its evidence cards), index them. Throws on a rejected answer: nothing written. */
export async function saveWeekly(db: pg.Pool, req: WeeklyRequest, answer: unknown, now = new Date()) {
  const errs = checkWeekly(req, answer);
  if (errs.length) throw new Error(`answer rejected:\n${errs.join('\n')}`);
  const out: { type: string; title: string; rel: string }[] = [];
  try {
    for (const x of SchemaW.parse(answer).insights) {
      const ev = [...new Set(x.cards)].map((c) => req.cards[c]);
      const text = `${x.text.trim()}${x.rule?.trim() ? `\nเสนอกฎ: ${x.rule.trim()}` : ''}`; // one paragraph: the claim of a note ends at its first "\n\n- "
      const rel = `insights/${bkk(now)} ${fileName(x.title, 60)}.md`;
      // scope global + no project: it is about several projects; source_uuids = one turn of each evidence chat (provenance, forget cascade)
      writeNote(rel, { memhub: 'insight', id: 'I' + md5(text).slice(0, 8), insight: x.type, scope: 'global', project: '', lang: 'th', importance: '6',
        status: 'active', valid_at: now.toISOString(), created_at: now.toISOString(), source_uuids: ev.map((e) => e.uuid), run: req.run, md5: md5(text),
        tags: ['memhub/insight'] }, `${text}\n\n${ev.map((e) => `- from:: [[${e.note}]]`).join('\n')}\n`);
      out.push({ type: x.type, title: x.title, rel });
    }
  } finally { commitBatch(MEMORY_VAULT, `weekly review ${req.run}: ${out.length} insight(s)`); } // a failed write must still close the batch
  await indexVault(db, MEMORY_VAULT);
  await resolveLinks(db);
  // the week is answered, also with no insight at all: digest of the same run says done instead of asking again
  await db.query(`INSERT INTO state (k, v) VALUES ('weekly:last', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [JSON.stringify({ run: req.run, at: now.toISOString(), insights: out.length })]);
  return out;
}
