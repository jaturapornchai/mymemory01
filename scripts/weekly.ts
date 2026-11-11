// Weekly review helper (prompts/session-weekly.md; no LLM call here, a Claude subagent answers the request file):
//   node scripts/weekly.ts digest [--run <id>] [--days <n>]         → tmp/weekly/<run>/W-<sha>.request.json + one JSON status line
//   node scripts/weekly.ts save <W-….request.json> <answer.json>    → check the answer, write the insight notes
// Unpack the request for the subagent with scripts/dream-files.ts unpack (same file shape).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, ROOT } from '../src/db.ts';
import { saveWeekly, weeklyRequest, type WeeklyRequest } from '../src/weekly.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };

if (cmd === 'digest') {
  const db = connect('ro');
  try {
    const req = await weeklyRequest(db, { run: flag('run'), days: flag('days') ? Number(flag('days')) : undefined });
    const last = (await db.query(`SELECT v FROM state WHERE k = 'weekly:last'`)).rows[0]?.v;
    if (!req) console.log(JSON.stringify({ status: 'skipped', why: 'fewer than 5 session cards this week' }));
    else if (last?.run === req.run) console.log(JSON.stringify({ run: req.run, status: 'done', insights: last.insights }));
    else {
      const rel = `tmp/weekly/${req.run}/${req.id}.request.json`;
      mkdirSync(join(ROOT, 'tmp', 'weekly', req.run), { recursive: true });
      writeFileSync(join(ROOT, rel), JSON.stringify(req));
      console.log(JSON.stringify({ run: req.run, status: 'pending', request: rel, cards: Object.keys(req.cards).length }));
    }
  } finally { await db.end(); }
} else if (cmd === 'save' && rest.length >= 2) {
  const req = JSON.parse(readFileSync(rest[0], 'utf8')) as WeeklyRequest;
  let answer: unknown;
  try { answer = JSON.parse(readFileSync(rest[1], 'utf8')); } catch (e) { console.error(`ANSWER IS NOT JSON: ${String(e).slice(0, 200)}`); process.exit(1); }
  const db = connect('rw');
  try {
    const notes = await saveWeekly(db, req, answer);
    console.log(`ok → ${notes.length} insight(s)`);
    for (const n of notes) console.log(`${n.type} | ${n.title} | ${n.rel}`);
  } catch (e) {
    console.error(String((e as Error).message ?? e));
    process.exitCode = 1;
  } finally { await db.end(); }
} else console.log('usage: weekly.ts digest [--run <id>] [--days <n>] | save <request.json> <answer.json>');
