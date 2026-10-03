// Gemini CLI chats: ~/.gemini/tmp/<slug>/chats/session-*.jsonl (+ <parentSessionId>/<sub>.jsonl subagents, legacy
// session-*.json single docs). JSONL is an event log replayed like Gemini's own loadConversationRecord (0.44.1).
// Format is internal and may change: unknown records/fields ignored, malformed lines skipped, never throws on content.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { Msg, Role } from '../claude.ts';
import { syncFile, walk, type Parsed } from '../importer.ts';

export const tool = 'gemini';
// Not the <file>.<mtime>.bak copies, not .project_root metadata.
export const isTranscript = (path: string) => /[\\/]chats[\\/]/.test(path) && /(?:\.jsonl|[\\/]session-[^\\/]*\.json)$/.test(path);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // a2a-server / skills-list-session are not chats
const MAX = 20000, MAX_RESULT = 4000; // results / summaries capped like claude.ts
const REFS = '--- Content from referenced files ---'; // @file expansion Gemini appends to the prompt
const SNAPSHOT = '<state_snapshot>', ACK = 'Got it. Thanks for the additional context!'; // chat compression summary + its canned reply
const HOOK = /<hook_context>[\s\S]*?<\/hook_context>\s*/g; // SessionStart hook text (memory-hub's own) Gemini prepends to a prompt
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const s = (v: unknown, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');

/** First line's sessionId from a 4 KB read: a2a-server wrote ~100 KB of boilerplate a minute (6,700 files). */
function headId(f: string): unknown {
  const fd = openSync(f, 'r'), b = Buffer.alloc(4096);
  try { return JSON.parse(b.toString('utf8', 0, readSync(fd, b, 0, 4096, 0)).split('\n')[0]).sessionId; }
  catch { return undefined; } finally { closeSync(fd); }
}

/** Only tmp/<slug>/chats/** and tmp/<slug>/.project_root are read: ~/.gemini also holds OAuth creds. Junk is never copied. */
export function sync(archiveDir: string): Record<string, number> {
  const home = process.env.MEMHUB_GEMINI_HOME ?? join(homedir(), '.gemini');
  const stats: Record<string, number> = {}, slugs = new Set<string>();
  const add = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };
  for (const f of walk(join(home, 'tmp'))) {
    if (!isTranscript(f)) continue;
    const rel = relative(home, f), dst = join(archiveDir, rel);
    if (!existsSync(dst)) { // archived once = always kept in sync (append-only truth)
      const id = /[\\/]chats[\\/][^\\/]+$/.test(f) ? headId(f) : undefined; // subagent headers carry their own id
      if (typeof id === 'string' && !UUID.test(id)) { add('junk'); continue; }
      // no real turn yet: retried next run. Big files are never header-only: archive unread (a >512 MB file can't be a string)
      if (statSync(f).size < 1 << 20 && !load(f)) { add('empty'); continue; }
    }
    add(syncFile(f, dst));
    slugs.add(rel.split(sep).slice(0, 2).join(sep)); // tmp/<slug>
  }
  for (const d of slugs) { // cwd for parse(): latest wins
    const f = join(home, d, '.project_root');
    if (existsSync(f)) syncFile(f, join(archiveDir, d, '.project_root'), false);
  }
  return stats;
}

/** Replay like Gemini: headers/$set merge metadata, message lines upsert by id (last line wins, first position kept),
 *  $set.messages replaces the history, $rewindTo drops that id and everything after (unknown id: everything).
 *  cur = Gemini's own view (where $rewindTo cuts); all = every turn ever recorded, because a $set.messages history
 *  rewrite (/compress, auto-compression, resume) makes Gemini forget the older turns and memory must not. */
function replay(raw: string, legacy: boolean) {
  const meta: any = {}, all = new Map<string, any>(), known = new Set<string>();
  let cur = new Map<string, any>();
  const put = (ms: unknown) => { for (const m of arr(ms)) if (typeof m?.id === 'string') { cur.set(m.id, m); all.set(m.id, m); known.add(m.id); } };
  for (const line of legacy ? [raw] : raw.split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (typeof o.$rewindTo === 'string') {
      const ids = [...cur.keys()], i = ids.indexOf(o.$rewindTo);
      for (const id of i < 0 ? ids : ids.slice(i)) { cur.delete(id); all.delete(id); }
    } else if (typeof o.id === 'string') put([o]);
    else if (o.$set && typeof o.$set === 'object') {
      if (Array.isArray(o.$set.messages)) {
        const next = new Map(arr(o.$set.messages).filter((m) => typeof m?.id === 'string').map((m) => [m.id, m]));
        // compression re-adds the kept tail under new ids: skip copies of the turns this rewrite drops (for good: later
        // rewrites such as resume repeat those ids)
        const dropped = new Set([...cur].filter(([id]) => !next.has(id)).map(([, m]) => key(m)));
        for (const [id, m] of next) if (!known.has(id) && !dropped.has(key(m))) all.set(id, m);
        for (const id of next.keys()) known.add(id);
        cur = next; // ponytail: a rewind into a re-added tail keeps its original turns (keeps more, never less)
      }
      Object.assign(meta, o.$set);
    } else if (typeof o.sessionId === 'string') { Object.assign(meta, o); put(o.messages); } // header / legacy whole doc
  }
  return { meta, messages: [...all.values()] };
}

function toolLine(c: any): string | null {
  const a = c?.args ?? {};
  switch (c?.name) {
    case 'run_shell_command': return `[shell] ${s(a.command)}`;
    case 'write_file': return `[write] ${s(a.file_path)}`;
    case 'replace': return `[edit] ${s(a.file_path)}`;
    case 'google_web_search': return `[web_search] ${s(a.query)}`;
    case 'web_fetch': return `[web_fetch] ${s(a.prompt)}`;
    case 'invoke_agent': return `[agent] ${s(a.agent_name, 80)}: ${s(a.prompt, 200)}`;
    case 'ask_user': return `[ask] ${arr(a.questions).map((q) => s(q?.question, 200)).join(' | ')}`;
    default: return null; // reads/greps/listings/topic updates: noise
  }
}

/** Tool outputs are dropped except what claude.ts keeps too: subagent results and the user's ask_user answers. */
function resultLine(p: any): string | null {
  const r = p?.functionResponse, out = r?.response?.output;
  if (typeof out !== 'string') return null;
  if (r.name === 'invoke_agent') return `[agent result] ${out}`;
  if (r.name !== 'ask_user') return null;
  try { return `[ask result] ${Object.values(JSON.parse(out).answers ?? {}).map((a) => s(a, 1000)).join(' | ')}`; } catch { return `[ask result] ${s(out)}`; }
}

/** Visible text parts only: no thoughts, functionCall/Response, inlineData, or the <session_context> boilerplate. */
const partsText = (c: unknown) => (typeof c === 'string' ? [{ text: c }] : arr(c))
  .filter((p) => typeof p?.text === 'string' && !p.thought && !p.text.trimStart().startsWith('<session_context>')).map((p) => p.text).join('\n');
// same turn whether stored as a string or as history parts
const key = (m: any) => `${m?.type}\0${partsText(m?.content).replace(/\s+/g, '')}`;

const tidy = (t: string, n = MAX) => {
  t = t.replace(/data:[\w.+/-]+;base64,[A-Za-z0-9+/=]+/g, '[data-url]').trim();
  return t.length > n ? t.slice(0, n) + ' …[truncated]' : t;
};

function load(path: string): Parsed | null {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  const { meta, messages } = replay(raw, path.endsWith('.json'));
  const parts = path.split(/[\\/]/), c = parts.lastIndexOf('chats');
  const parent = c >= 0 && c < parts.length - 2 ? parts[c + 1] : undefined; // chats/<parentSessionId>/<sub>.jsonl
  const sessionId = parent ?? String(meta.sessionId ?? '');
  if (!UUID.test(sessionId)) return null;
  // uuid namespace = this file's own session id: the session_context id is the same in every session
  const own = typeof meta.sessionId === 'string' && meta.sessionId ? meta.sessionId : parts.at(-1)!.replace(/\.jsonl?$/, '');
  let cwd: string | undefined;
  try { cwd = readFileSync([...parts.slice(0, c), '.project_root'].join('/'), 'utf8').trim() || undefined; } catch {}
  const msgs: Msg[] = [];
  let ts = Date.parse(meta.startTime) || 0, task: string | undefined, result: [any, string] | undefined;
  const push = (o: any, role: Role, text: string) => {
    text = tidy(text, role === 'user' || role === 'assistant' ? MAX : MAX_RESULT);
    if (!text) return; // tool results, info/error/warning, empty turns
    ts = Math.max(ts, Date.parse(o.timestamp) || 0); // never backwards: dream windows rely on increasing ts
    msgs.push({ uuid: `${tool}:${own}:${o.id}`, parentUuid: msgs.at(-1)?.uuid ?? null, sessionId, ts: new Date(ts).toISOString(),
      cwd: cwd ?? '', role, text });
  };
  for (const o of messages) {
    if (o.type === 'user') {
      const res = arr(o.content).map(resultLine).filter(Boolean).join('\n');
      const text = partsText(o.displayContent ?? o.content).split(REFS)[0].replace(HOOK, ''); // displayContent = what was typed
      if (parent) { if (task === undefined && text.trim()) push(o, 'tool', `[subagent task] ${(task = tidy(text, 2000))}`); }
      else if (res) push(o, 'tool', res);
      else push(o, text.trimStart().startsWith(SNAPSHOT) ? 'summary' : 'user', text);
    } else if (o.type === 'gemini') {
      const say = partsText(o.content).trim(), calls = arr(o.toolCalls);
      if (parent) { // like claude.ts parseSubagent: the task it was given and its final answer (complete_task), not every step
        const done = calls.find((k) => k?.name === 'complete_task')?.args;
        const out = done && typeof done === 'object' ? Object.values(done).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n') : say;
        if (out.trim()) result = [o, out];
      } else push(o, 'assistant', [say === ACK ? '' : say, ...calls.map(toolLine)].filter(Boolean).join('\n'));
    }
  }
  if (result) push(result[0], 'tool', `[subagent result] ${result[1]}`);
  return msgs.length ? { sessionId, cwd, kind: parent ? 'subagent' : 'main', msgs } : null;
}

export const parse = async (path: string): Promise<Parsed | null> => load(path);
