// Kimi Code (~/.kimi-code, or KIMI_CODE_HOME like the CLI): sessions/wd_<dir>_<hash>/<session>/ holds state.json (workDir,
// agents map) and agents/<agent>/wire.jsonl, an append-only event log, one JSON record per line. <session> = session_<uuid>,
// or ses_<uuid> for the ones Kimi migrated from the legacy ~/.kimi (protocol 1.0: no origin, no time, whole replies as
// messages). The legacy ~/.kimi/sessions format is not read. User-turn and step rules follow Orca's Kimi parser
// (stablyai/orca src/main/ai-vault/session-scanner-kimi-parser.ts, MIT License, Copyright (c) 2026 Lovecast Inc.).
// Unknown records ignored, malformed lines skipped.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { toolLine, type Msg, type Role } from '../claude.ts';
import { readLines, syncFile, walk, type Parsed } from '../importer.ts';

export const tool = 'kimi';
const SESSIONS = join(process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code'), 'sessions');
const MAX = 20000, MAX_RESULT = 4000;
// 1.0 user messages carry no origin: the injected ones are told apart by their tag
const INJECTED = /^<(?:system-reminder|system|notification)\b/;

// Not the <file>.<mtime>.bak copies syncFile keeps of rewritten logs.
export const isTranscript = (path: string) => basename(path) === 'wire.jsonl' && basename(dirname(dirname(path))) === 'agents';

/** Only sessions/ is read (~/.kimi-code also holds credentials/, config.toml, mcp.json): wire logs + each session's state.json. */
export function sync(archiveDir: string): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const f of walk(SESSIONS)) {
    const rel = relative(SESSIONS, f), meta = basename(f) === 'state.json' && rel.split(/[\\/]/).length === 3;
    if (!meta && !isTranscript(f)) continue; // per-session logs/
    let r: string;
    try { r = syncFile(f, join(archiveDir, rel), !meta); } catch { r = 'failed'; } // metadata: latest wins
    if (!meta || r === 'failed') stats[r] = (stats[r] ?? 0) + 1;
  }
  return stats;
}

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const texts = (content: unknown) => arr(content).filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
const tidy = (t: string, n = MAX) => {
  t = t.replace(/data:[\w.+/-]+;base64,[A-Za-z0-9+/=]+/g, '[data-url]').trim();
  return t.length > n ? t.slice(0, n) + ' …[truncated]' : t;
};

type Entry = { n: number; ms: number; role: Role; text: string; tool?: boolean };

function workspaceRoot(wd: string): unknown {
  try { return JSON.parse(readFileSync(join(dirname(SESSIONS), 'workspaces.json'), 'utf8')).workspaces?.[wd]?.root; } catch { return undefined; }
}

export async function parse(path: string): Promise<Parsed | null> {
  const agent = basename(dirname(path)), sessionDir = dirname(dirname(dirname(path))), sessionId = basename(sessionDir);
  let state: any = {};
  try { state = JSON.parse(readFileSync(join(sessionDir, 'state.json'), 'utf8')) ?? {}; } catch { /* no state: no cwd */ }
  const sub = (state.agents?.[agent]?.type ?? (agent === 'main' ? 'main' : 'sub')) !== 'main';
  const out: Entry[] = [], asks = new Set<unknown>();
  let ms = Date.parse(state.createdAt) || 0, n = 0, step: Entry | null = null;
  const push = (role: Role, text: string, e: Partial<Entry> = {}, cap = MAX) => {
    text = tidy(text, cap);
    if (text) out.push({ n, ms, role, text, ...e });
  };
  const flush = () => { // streamed text parts of one step = one reply
    if (step && (step.text = tidy(step.text))) out.push(step);
    step = null;
  };
  for await (const line of readLines(path)) {
    n++;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const t = typeof o?.time === 'number' ? o.time : o?.created_at; // 1.0: no time, metadata.created_at only
    if (typeof t === 'number') ms = Math.max(ms, t); // never backwards: dream windows rely on increasing ts
    if (o?.type === 'context.append_message') {
      const m = o.message, kind = m?.origin?.kind, text = texts(m?.content);
      if (m?.role === 'assistant') { flush(); push('assistant', text); } // 1.0 replies; later ones hold thinking only
      // real prompts only: injection (reminders), background_task, cron_job, skill_activation, system_trigger, task are Kimi's
      else if (m?.role === 'user' && (kind === 'user' || (kind === undefined && !INJECTED.test(text.trimStart()))
        || (sub && kind === 'system_trigger'))) { flush(); push('user', text); } // a subagent's task arrives as system_trigger
    } else if (o?.type === 'context.append_loop_event') {
      const e = o.event;
      if (e?.type === 'content.part' && e.part?.type === 'text' && typeof e.part.text === 'string') {
        step ??= { n, ms, role: 'assistant', text: '' };
        step.text += e.part.text;
      } else if (e?.type === 'step.end') flush();
      else if (e?.type === 'tool.call') { // input only: results are huge and mostly noise
        flush();
        const a = e.args && typeof e.args === 'object' ? e.args : {}; // Claude Code's tool names, path instead of file_path
        const l = toolLine(e.name === 'FetchURL' ? 'WebFetch' : String(e.name), { ...a, file_path: a.path, questions: arr(a.questions) });
        if (l) push('assistant', l, { tool: true });
        if (e.name === 'AskUserQuestion') asks.add(e.toolCallId);
      } else if (e?.type === 'tool.result' && asks.has(e.toolCallId) && typeof e.result?.output === 'string') {
        push('assistant', `[Ask result] ${e.result.output}`, { tool: true }, MAX_RESULT); // the user's decision
      }
    }
  }
  flush();

  let es = out;
  if (sub) { // like Claude subagents: the task it got and its final answer (the main agent's log has the rest)
    const task = out.find((e) => e.role === 'user'), result = out.findLast((e) => e.role === 'assistant' && !e.tool);
    es = [
      ...(task ? [{ ...task, role: 'tool' as Role, text: `[subagent task] ${tidy(task.text, 2000)}` }] : []),
      ...(result ? [{ ...result, role: 'tool' as Role, text: `[subagent result] ${tidy(result.text, MAX_RESULT)}` }] : []),
    ];
  }
  // version 2 (moved from ~/.kimi) says cwd; some older ones say neither: Kimi's workspaces.json names the wd_ folder
  const cwd = [state.workDir, state.cwd, workspaceRoot(basename(dirname(sessionDir)))].find((d) => typeof d === 'string') ?? '';
  const msgs: Msg[] = [];
  for (const e of es) {
    const last = msgs.at(-1);
    if (last?.role === e.role && last.text === e.text) continue; // re-sent prompt
    // line number: the log is append-only, so it is stable across re-parses
    msgs.push({ uuid: `${tool}:${sessionId}:${agent}:${e.n}`, parentUuid: last?.uuid ?? null, sessionId, ts: new Date(e.ms).toISOString(), cwd, role: e.role, text: e.text });
  }
  return msgs.length ? { sessionId, cwd: cwd || undefined, kind: sub ? 'subagent' : 'main', msgs } : null;
}
