// Codex (CLI / desktop / VS Code share ~/.codex) rollouts: sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl, moved to
// archived_sessions/ (flat) on archive and back on unarchive. One JSONL record per line {timestamp, ordinal, type, payload}.
// Format is internal and may change: unknown records/fields ignored, malformed lines skipped, never throws on content.
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Msg, Role } from '../claude.ts';
import { readLines, syncFile, walk, type Parsed } from '../importer.ts';

export const tool = 'codex';
const HOME = process.env.MEMHUB_CODEX_HOME ?? join(homedir(), '.codex');
const SNAPSHOT = 'codex-sessions-2026-10-01'; // older copy of sessions/ next to the archive (~/ai-archive/raw)
const NAME = /^rollout-(\d{4})-(\d{2})-(\d{2})T.+\.jsonl$/;
const MAX_LINE = 4 << 20; // single lines reach 30 MB of base64 screenshots
const MAX = 20000, MAX_RESULT = 4000;

// Not the <file>.<mtime>.bak copies syncFile keeps of rewritten rollouts.
export const isTranscript = (path: string) => NAME.test(basename(path));
/** Archive copy keyed by file name, not live folder: a thread moving to/from archived_sessions/ is never duplicated. */
const dest = (archiveDir: string, name: string) => {
  const m = NAME.exec(name);
  return m ? join(archiveDir, m[1], m[2], m[3], name) : null;
};

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const s = (v: unknown, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
const json = (v: unknown): any => { try { return JSON.parse(String(v)); } catch { return {}; } };
const isGuardian = (m: any) => m?.thread_source === 'guardian_review' || m?.source?.subagent?.other === 'guardian';

/** Guardian threads (automatic approval reviewers, ~120 MB) are noise: decided from the first line, never copied. */
function guardianFile(f: string) {
  const fd = openSync(f, 'r'), b = Buffer.allocUnsafe(1 << 18); // session_meta lines are ≤ 50 KB
  try {
    const n = readSync(fd, b, 0, b.length, 0), nl = b.subarray(0, n).indexOf(10);
    return nl > 0 && isGuardian(JSON.parse(b.toString('utf8', 0, nl)).payload);
  } catch { return false; } finally { closeSync(fd); }
}

/** Only sessions/ and archived_sessions/ are read: ~/.codex also holds auth.json, secrets/ and live SQLite stores. */
export function sync(archiveDir: string): Record<string, number> {
  const stats: Record<string, number> = {}, live = new Set<string>();
  const add = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };
  const copy = (f: string, dst: string) => (existsSync(dst) || !guardianFile(f) ? syncFile(f, dst) : 'guardian');
  for (const f of [...walk(join(HOME, 'sessions')), ...walk(join(HOME, 'archived_sessions'))]) {
    const dst = dest(archiveDir, basename(f));
    if (!dst) continue;
    live.add(basename(f));
    try { add(copy(f, dst)); } catch { add('failed'); } // moved/archived mid-run: next run catches up
  }
  // The snapshot only seeds threads ~/.codex no longer has (live copies are newer).
  for (const f of walk(join(dirname(archiveDir), SNAPSHOT))) {
    const dst = dest(archiveDir, basename(f));
    if (dst && !live.has(basename(f)) && !existsSync(dst) && copy(f, dst) === 'copied') add('seeded');
  }
  return stats;
}

/** Drop base64 "data:" JSON strings without a regex (a 30 MB match overflows the regexp stack). */
function dropDataUrls(line: string) {
  let out = '', i = 0;
  for (let j; (j = line.indexOf('"data:', i)) >= 0;) {
    const end = line.indexOf('"', j + 1); // base64 never holds a quote or backslash
    if (end < 0 || !line.slice(j, j + 100).includes(';base64,')) { out += line.slice(i, j + 6); i = j + 6; continue; }
    out += line.slice(i, j) + '""';
    i = end + 1;
  }
  return out + line.slice(i);
}

const tidy = (t: string, n = MAX) => {
  t = t.replace(/data:[\w.+/-]+;base64,[A-Za-z0-9+/=]+/g, '[data-url]').trim();
  return t.length > n ? t.slice(0, n) + ' …[truncated]' : t;
};

// Context Codex injects as "user" parts (AGENTS.md, environment, plugin/skill lists, abort notices, image wrappers).
const BOILER = /^(?:# AGENTS\.md instructions|<(?:environment_context|recommended_plugins|user_instructions|turn_aborted|skill)>|<(?:codex_internal_context|heartbeat)\b|<\/?image\b[^\n>]*>$)/;
// Re-sent on every automation tick / goal continuation: keep the instructions / objective once per session.
const REPEAT = /^<(?:heartbeat>[\s\S]*?<instructions>([\s\S]*?)<\/instructions>|codex_internal_context source="goal">[\s\S]*?<objective>([\s\S]*?)<\/objective>)/;
const REQUEST = /^## My request(?: for Codex)?:[^\S\n]*$/m; // IDE / browser / attached-files preamble ends here

function userText(content: unknown, beats: Set<string>) {
  const out: string[] = [];
  for (const c of arr(content)) {
    if (c?.type !== 'input_text' || typeof c.text !== 'string') continue; // input_image: dropped
    let t = c.text.trim();
    const rep = REPEAT.exec(t);
    if (rep) {
      t = (rep[1] ?? rep[2]).trim();
      if (!t || beats.has(t)) continue;
      beats.add(t);
      t = `[${rep[1] !== undefined ? 'automation' : 'goal'}] ${t}`;
    } else if (BOILER.test(t)) continue;
    const r = REQUEST.exec(t);
    if (r) t = t.slice(r.index + r[0].length).trim();
    if (t) out.push(t);
  }
  return out.join('\n');
}

const texts = (content: unknown, type: string) => arr(content).filter((c) => c?.type === type && typeof c.text === 'string').map((c) => c.text).join('\n');

const webLine = (a: any, q?: unknown) => {
  const fetch = a?.type === 'open_page' || a?.type === 'find_in_page';
  const v = fetch ? a?.url || q : q || a?.query || a?.queries?.[0];
  return v ? `[${fetch ? 'web_fetch' : 'web_search'}] ${s(v)}` : null;
};

/** Normalized tool view: calls made from code-mode `exec` show up only here. MCP/reads/waits: noise. */
function itemLine(it: any): string | null {
  switch (it?.type) {
    case 'CommandExecution': return `[shell] ${s(Array.isArray(it.command) ? it.command.at(-1) : it.command)}`; // [pwsh, -Command, cmd]
    case 'FileChange': return `[edit] ${s(Object.keys(it.changes ?? {}).join(' '))}`;
    case 'WebSearch': return webLine(it.action, it.query);
    default: return null;
  }
}

/** Direct calls: shell_command never gets an item; apply_patch's FileChange item shares its call_id (skipped in parse);
 * web_search_call has no id, so `raw` ones only count when the file has no WebSearch items (≤ 0.125). */
function callLine(p: any): { text: string; raw?: boolean } | null {
  const a = p.type === 'function_call' ? json(p.arguments) : {};
  if (p.type === 'web_search_call') { const t = webLine(p.action); return t ? { text: t, raw: true } : null; }
  if (p.type === 'custom_tool_call' && p.name === 'apply_patch') {
    const files = [...String(p.input ?? '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
    return files.length ? { text: `[edit] ${s(files.join(' '))}` } : null;
  }
  if (p.type !== 'function_call') return null;
  switch (p.name) {
    case 'shell_command': case 'shell': return { text: `[shell] ${s(Array.isArray(a.command) ? a.command.at(-1) : a.command)}` };
    case 'spawn_agent': return { text: `[agent] ${s(a.task_name, 80)}: ${s(a.message, 200)}` };
    case 'followup_task': return { text: `[agent] ${s(a.target, 80)}: ${s(a.message, 200)}` };
    case 'request_user_input_async': return { text: `[ask] ${arr(a.questions).map((q) => s(q?.title ?? q?.question, 200)).join(' | ')}` }; // real calls: {title, options?}
    default: return null;
  }
}

type Entry = { id: string; ord: number; ts: string; role: Role; text: string; tool?: boolean; raw?: boolean; task?: boolean };

export async function parse(path: string): Promise<Parsed | null> {
  const out: Entry[] = [], beats = new Set<string>(), ords = new Set<number>();
  let meta: any, me: unknown, webItems = false, n = 0, ms = 0;
  const calls = new Set<string>(); // call_ids already logged from the direct call
  for await (let line of readLines(path)) {
    n++;
    if (line.length > MAX_LINE) { line = dropDataUrls(line); if (line.length > MAX_LINE) continue; } // keeps prompts with screenshots
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o?.payload;
    if (!p || typeof p !== 'object') continue;
    if (!meta) {
      if (o.type !== 'session_meta') continue;
      meta = p;
      if (isGuardian(p)) return null;
      me = p.source?.subagent?.thread_spawn?.agent_path ?? p.agent_path;
      ms = Date.parse(p.timestamp) || 0;
      continue;
    }
    // a repeated ordinal (seen once in real data) falls back to the line: a duplicate uuid fails the session's whole insert
    const ord = typeof o.ordinal === 'number' && !ords.has(o.ordinal) ? o.ordinal : null;
    if (ord !== null) ords.add(ord);
    ms = Math.max(ms, Date.parse(o.timestamp) || 0); // never backwards: dream windows rely on increasing ts
    const push = (role: Role, text: string, e: Partial<Entry> = {}) => {
      text = tidy(text);
      if (text) out.push({ id: ord !== null ? String(ord) : `L${n}`, ord: ord ?? -1, ts: new Date(ms).toISOString(), role, text, ...e });
    };
    if (o.type === 'event_msg') { // event_msg user/agent messages duplicate response_item messages: only tools here
      const l = p.type === 'item_completed' && !calls.has(p.item?.id) ? itemLine(p.item) : null;
      if (l) { webItems ||= p.item.type === 'WebSearch'; push('assistant', l, { tool: true }); }
      continue;
    }
    if (o.type !== 'response_item') continue; // compacted (replays history), world_state, turn_context, token counts
    if (p.type === 'message' && p.role === 'user') push('user', userText(p.content, beats));
    else if (p.type === 'message' && p.role === 'assistant') push('assistant', texts(p.content, 'output_text'));
    else if (p.type === 'agent_message') push('tool', `[agent ${s(p.author, 120)}] ${tidy(texts(p.content, 'input_text'), MAX_RESULT)}`, { task: !!me && p.recipient === me });
    else { const c = callLine(p); if (c) { if (typeof p.call_id === 'string') calls.add(p.call_id); push('assistant', c.text, { tool: true, raw: c.raw }); } }
  }
  if (!meta) return null;

  const own = typeof meta.id === 'string' && meta.id ? meta.id : /([0-9a-f-]{36})\.jsonl$/i.exec(path)?.[1];
  if (!own) return null;
  const parent = meta.source?.subagent?.thread_spawn?.parent_thread_id ?? meta.parent_thread_id;
  const sub = typeof parent === 'string' && !!parent && parent !== own;
  // ponytail: a thread resumed across a Codex upgrade loses its pre-upgrade web_search_call lines; split per turn_id if it matters
  let es = webItems ? out.filter((e) => !e.raw) : out;
  if (sub) { // like Claude subagents: the task it got and its final answer (the parent file has the rest)
    // The file first replays the forked parent history; its own part starts at the agent_message addressed to it.
    // subagent_history_start_ordinal should mark it too, but Codex ≤ 0.149 mostly wrote one past the last ordinal.
    const i = es.findIndex((e) => e.task);
    const mine = i >= 0 ? es.slice(i) : es.filter((e) => e.ord >= (Number(meta.subagent_history_start_ordinal) || 0));
    const task = mine.find((e) => e.role === 'user' || e.role === 'tool');
    const result = mine.findLast((e) => e.role === 'assistant' && !e.tool);
    const body = (e: Entry) => e.text.replace(/^\[agent [^\]]*\] /, '');
    es = [
      ...(task ? [{ ...task, role: 'tool' as Role, text: `[subagent task] ${tidy(body(task), 2000)}` }] : []),
      ...(result ? [{ ...result, role: 'tool' as Role, text: `[subagent result] ${tidy(result.text, MAX_RESULT)}` }] : []),
    ];
  }
  // depth ≥ 2: parent is another subagent; session_id names the root conversation (= parent at depth 1)
  const root = typeof meta.session_id === 'string' && meta.session_id && meta.session_id !== own ? meta.session_id : parent;
  const sessionId = sub ? root : own, cwd = typeof meta.cwd === 'string' ? meta.cwd : '';
  const msgs: Msg[] = [];
  for (const e of es) {
    // uuid namespace = this file's own thread id: subagents share the parent's sessionId and ordinals restart per file
    msgs.push({ uuid: `${tool}:${own}:${e.id}`, parentUuid: msgs.at(-1)?.uuid ?? null, sessionId, ts: e.ts, cwd, role: e.role, text: e.text });
  }
  return msgs.length ? { sessionId, cwd: cwd || undefined, kind: sub ? 'subagent' : meta.originator === 'codex_exec' || meta.source === 'exec' ? 'headless' : 'main', msgs } : null;
}
