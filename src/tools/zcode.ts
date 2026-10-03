// ZCode (z.ai coding agent): history lives in a mutable SQLite DB (~/.zcode/cli/db/db.sqlite, WAL, rows updated in place,
// deleting a task cascade-deletes its messages). sync() exports each session to an append-only <archive>/<session id>.jsonl
// (one line per message, junk dropped before archiving); parse() reads that export, never the live DB.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Msg, Role } from '../claude.ts';
import { syncFile, type Parsed } from '../importer.ts';

export const tool = 'zcode';
const MAX_TEXT = 20000, MAX_RESULT = 4000; // summaries / notifications capped like Claude's
const SETTLE_MS = 3_600_000; // an unfinished assistant step younger than this is still streaming: not exported yet

/** One exported message. `text` = the message's text parts, `tools` = compact lines for calls worth recalling. */
type Line = { session: string; parent?: string; cwd: string; id: string; role: Role; time: number; text: string; tools?: string[] };

const str = (v: unknown, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
const json = (t: unknown) => { try { return JSON.parse(String(t)); } catch { return null; } };
const noDataUrls = (t: string) => t.replace(/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, '[data-url]');

// ZCode uses Claude Code's tool names and inputs. ponytail: copy of claude.ts toolLine (not exported there) + node_repl.
function toolLine(name: string, input: any): string | null {
  switch (name) {
    case 'Bash': return `[Bash] ${str(input?.description, 120)} $ ${str(input?.command)}`;
    case 'Write': case 'Edit': return `[${name}] ${str(input?.file_path)}`;
    case 'WebSearch': return `[WebSearch] ${str(input?.query)}`;
    case 'WebFetch': return `[WebFetch] ${str(input?.url)}`;
    case 'Agent': return `[Agent] ${str(input?.description, 200)}`;
    case 'mcp__node_repl__js': return `[js] ${str(input?.title || input?.source || input?.code)}`; // older calls: {source} only
    case 'AskUserQuestion':
      return `[Ask] ${(Array.isArray(input?.questions) ? input.questions : []).map((q: any) => str(q?.question, 200)).join(' | ')}`;
    default: return null;
  }
}

type SessionRow = { id: string; parent_id: string | null; task_type: string; directory: string };

/** message row + its text/tool parts → export line; null = junk (reminders, goal nudges, reasoning-only steps). */
function toLine(s: SessionRow, id: string, time: number, d: any, parts: any[]): Line | null {
  const kind = d?.semantics?.kind ?? d?.metadata?.source; // older rows only carry metadata.source
  const role: Role | null = d?.role === 'assistant' ? 'assistant'
    : d?.role !== 'user' ? null
    : kind === 'compact_summary' ? 'summary'
    : kind === 'background_notification' || kind === 'background_task' ? 'notice'
    : d.synthetic ? null : 'user'; // todo/system reminders, goal nudges; typed /goal <objective> (controlOnly) is kept
  if (!role || !Number.isFinite(time)) return null;
  const texts: string[] = [], tools: string[] = [];
  for (const p of parts) {
    if (p?.type === 'text' && typeof p.text === 'string' && !(role === 'user' && p.synthetic)) texts.push(noDataUrls(p.text));
    else if (p?.type === 'tool' && role === 'assistant') { // input only: outputs are huge and mostly noise
      const l = toolLine(String(p.tool), p.state?.input);
      if (l) tools.push(l);
      const answer = p.tool === 'AskUserQuestion' ? str(p.state?.output).trim() : ''; // the user's decision
      if (answer) tools.push(`[Ask result] ${answer}`);
    }
  }
  const text = texts.join('\n').trim();
  if (!text && !tools.length) return null;
  const parent = s.task_type === 'subagent_child' && s.parent_id ? s.parent_id : undefined;
  return { session: s.id, parent, cwd: s.directory, id, role, time, text, ...(tools.length ? { tools } : {}) };
}

/** Read-only handle on the live DB; if its WAL refuses a read-only reader, read a private copy in `tmp` instead. */
function open(file: string, tmp: string): DatabaseSync {
  // lazy: hooks that import importer.ts must not pay for (or print the ExperimentalWarning of) node:sqlite
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.prepare('SELECT 1 FROM session LIMIT 1').get();
    return db;
  } catch {
    db?.close();
    for (const x of ['', '-wal', '-shm']) if (existsSync(file + x)) copyFileSync(file + x, join(tmp, `db.sqlite${x}`));
    return new DatabaseSync(join(tmp, 'db.sqlite'));
  }
}

export function sync(archiveDir: string): Record<string, number> {
  const file = join(process.env.MEMHUB_ZCODE_HOME ?? join(homedir(), '.zcode'), 'cli', 'db', 'db.sqlite');
  if (!existsSync(file)) return {};
  const stats: Record<string, number> = {};
  const inc = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };
  const tmp = mkdtempSync(join(tmpdir(), 'memhub-zcode-'));
  try {
    const db = open(file, tmp);
    try {
      const msgsOf = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id');
      const partsOf = db.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY message_id, sequence, id');
      for (const s of db.prepare('SELECT id, parent_id, task_type, directory FROM session ORDER BY id').all() as SessionRow[]) {
        // messages before parts: a message read as completed already has its final parts by the time they are read
        const rows = msgsOf.all(s.id) as { id: string; time_created: number; data: string }[];
        const parts = new Map<string, any[]>();
        for (const p of partsOf.iterate(s.id) as Iterable<{ message_id: string; data: string }>) {
          const d = json(p.data);
          if (d?.type !== 'text' && d?.type !== 'tool') continue; // reasoning, step-*, file (inline images), compaction, timeline
          if (d.tool !== 'AskUserQuestion') delete d.state?.output; // tool outputs are most of the DB: don't hold them
          const list = parts.get(p.message_id) ?? parts.set(p.message_id, []).get(p.message_id)!;
          list.push(d);
        }
        const lines: Line[] = [];
        for (const m of rows) {
          const d = json(m.data), time = Number(m.time_created);
          // a step still streaming (or waiting on AskUserQuestion) would rewrite its line → 'conflicts' + a .bak of the whole
          // session next sync. Stop here; interrupted steps never complete, so give up waiting after SETTLE_MS.
          if (d?.role === 'assistant' && !d.time?.completed && Date.now() - time < SETTLE_MS) break;
          const l = toLine(s, m.id, time, d, parts.get(m.id) ?? []);
          if (l) lines.push(l);
        }
        if (!lines.some((l) => l.role === 'user')) { inc('empty'); continue; }
        const name = `${String(s.id).replace(/[^\w.-]/g, '_')}.jsonl`;
        writeFileSync(join(tmp, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
        inc(syncFile(join(tmp, name), join(archiveDir, name))); // grown → appended; edited history → old kept as .bak
      }
    } finally { db.close(); }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return stats;
}

export const isTranscript = (path: string) => path.endsWith('.jsonl'); // not the <file>.<mtime>.bak versions

const cap = (t: string, n: number) => (t.length > n ? t.slice(0, n) + ' …[truncated]' : t);
const ROLES = new Set(['user', 'assistant', 'summary', 'notice']);

export async function parse(path: string): Promise<Parsed | null> {
  const lines: Line[] = [], seen = new Set<string>();
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const o = raw.trim() ? json(raw) : null;
    if (typeof o?.id !== 'string' || seen.has(o.id) || !ROLES.has(o.role) || typeof o.text !== 'string') continue;
    if (typeof o.time !== 'number' || Number.isNaN(new Date(o.time).getTime())) continue;
    seen.add(o.id); // a duplicated line would collide on turns.uuid
    lines.push(o);
  }
  if (!lines.length) return null;
  const parent = lines.find((l) => typeof l.parent === 'string')?.parent;
  const sessionId = parent ?? (typeof lines[0].session === 'string' ? lines[0].session : basename(path, '.jsonl'));
  const cwd = typeof lines[0].cwd === 'string' ? lines[0].cwd : '';
  const msgs: Msg[] = [];
  const push = (l: Line, role: Role, text: string) => msgs.push({
    uuid: `zcode:${sessionId}:${l.id}`, parentUuid: msgs.at(-1)?.uuid ?? null, sessionId, ts: new Date(l.time).toISOString(), cwd, role, text,
  });

  if (parent) { // subagent: only its task and final answer, intermediate steps are noise (like Claude's parseSubagent)
    const task = lines.find((l) => l.role === 'user' && l.text.trim());
    const result = lines.findLast((l) => l.role === 'assistant' && l.text.trim());
    if (task) push(task, 'tool', `[subagent task] ${cap(task.text.trim(), 2000)}`);
    if (result) push(result, 'tool', `[subagent result] ${cap(result.text.trim(), MAX_RESULT)}`);
    return msgs.length ? { sessionId, cwd, kind: 'subagent', msgs } : null;
  }
  for (const l of lines) {
    const tools = Array.isArray(l.tools) ? l.tools.filter((t) => typeof t === 'string') : [];
    const text = cap([l.text, ...tools].join('\n').trim(), l.role === 'summary' || l.role === 'notice' ? MAX_RESULT : MAX_TEXT);
    const last = msgs.at(-1);
    if (!text || (last?.role === l.role && last.text === text)) continue; // re-sent prompt
    push(l, l.role, text);
  }
  return msgs.length ? { sessionId, cwd, kind: 'main', msgs } : null;
}
