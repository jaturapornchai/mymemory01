// Defensive parser for Claude Code transcript JSONL (format is internal and may change:
// unknown types/fields are ignored, malformed lines skipped, never throws on content).

export type Role = 'user' | 'assistant' | 'tool' | 'summary' | 'notice' | 'note';
export type Msg = {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  ts: string;
  cwd: string;
  role: Role;
  text: string;
};

const MAX_RESULT = 4000; // subagent results / notices can be huge
const SKIP_TAG = /^<(?:system-reminder|local-command-stdout|local-command-caveat|bash-stdout|bash-stderr)>/;

// tool_use → one compact line; only tools whose input says something worth recalling.
export function toolLine(name: string, input: any): string | null {
  const s = (v: unknown, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
  switch (name) {
    case 'Bash': return `[Bash] ${s(input?.description, 120)} $ ${s(input?.command)}`;
    case 'Write': case 'Edit': case 'NotebookEdit': return `[${name}] ${s(input?.file_path ?? input?.notebook_path)}`;
    case 'WebSearch': return `[WebSearch] ${s(input?.query)}`;
    case 'WebFetch': return `[WebFetch] ${s(input?.url)}`;
    case 'Agent': case 'Task': return `[Agent] ${s(input?.description, 200)}`;
    case 'AskUserQuestion':
      return `[Ask] ${(input?.questions ?? []).map((q: any) => s(q?.question, 200)).join(' | ')}`;
    default: return null;
  }
}

function blockText(b: any): string {
  if (typeof b === 'string') return b;
  if (b?.type === 'text' && typeof b.text === 'string') return b.text;
  return '';
}

function resultText(content: unknown): string {
  const t = Array.isArray(content) ? content.map(blockText).join('\n') : typeof content === 'string' ? content : '';
  return t.length > MAX_RESULT ? t.slice(0, MAX_RESULT) + ' …[truncated]' : t;
}

const stripReminders = (t: string) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

// memory-hub's own tools (any MCP server name): their replies are never indexed, only scanned (importer: Claude-only hits)
const HUB_TOOL = /__memory_(?:search|get|related|timeline)$/;

/** Parse one transcript file's text. `toolNames` persists across calls for incremental (offset) parsing.
 *  hub: collects memory-hub tool inputs and replies (ids it was given / shown), for importer.indexFile. */
export function parseClaude(raw: string, toolNames = new Map<string, string>(), hub?: string[]): Msg[] {
  const out: Msg[] = [];
  const userSeen = new Set<string>(); // a queued prompt also sent as an earlier user line is indexed once
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    // typed while Claude was busy and injected mid-turn: this attachment is the only copy (peer/coordinator/notice origins are not his)
    const a = o?.type === 'attachment' ? o.attachment : undefined;
    const queued = a?.type === 'queued_command' && a.commandMode === 'prompt' && (a.origin?.kind ?? 'human') === 'human'; // no origin: older Claude Code
    if (queued) o = { ...o, type: 'user', message: { content: a.prompt } };
    if (!o || typeof o.uuid !== 'string' || (o.type !== 'user' && o.type !== 'assistant')) continue;
    if (o.isMeta) continue;
    const base = {
      uuid: o.uuid,
      parentUuid: typeof o.parentUuid === 'string' ? o.parentUuid : null,
      sessionId: String(o.sessionId ?? ''),
      ts: String(o.timestamp ?? ''),
      cwd: String(o.cwd ?? ''),
    };
    const push = (role: Role, text: string) => {
      text = text.trim();
      if (!text) return;
      if (role === 'user') {
        if (text.startsWith('[Request interrupted')) return; // the harness's Esc marker, not his words
        if (queued && userSeen.has(text)) return;
        userSeen.add(text);
      }
      out.push({ ...base, role, text });
    };
    const content = o.message?.content;

    if (o.type === 'assistant') {
      if (!Array.isArray(content)) continue;
      const parts: string[] = [];
      for (const b of content) {
        if (b?.type === 'text') parts.push(blockText(b));
        else if (b?.type === 'tool_use') {
          if (typeof b.id === 'string') toolNames.set(b.id, String(b.name));
          if (HUB_TOOL.test(String(b.name))) hub?.push(JSON.stringify(b.input ?? ''));
          const l = toolLine(String(b.name), b.input);
          if (l) parts.push(l);
        }
      }
      push('assistant', parts.join('\n'));
      continue;
    }

    // user line
    if (o.isCompactSummary) { push('summary', resultText(content)); continue; }
    if (typeof content === 'string') {
      const t = content.trimStart();
      if (SKIP_TAG.test(t)) continue;
      if (t.startsWith('<task-notification>')) { push('notice', resultText(t)); continue; }
      push('user', stripReminders(t.replace(/<\/?command-(?:message|args)>/g, '').replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')));
      continue;
    }
    if (!Array.isArray(content)) continue;
    const typed: string[] = [];
    for (const b of content) {
      if (b?.type === 'text') typed.push(blockText(b));
      else if (b?.type === 'tool_result') {
        const name = toolNames.get(b.tool_use_id);
        if (name === 'Agent' || name === 'Task' || name === 'AskUserQuestion') push('tool', `[${name} result] ${resultText(b.content)}`);
        else if (HUB_TOOL.test(name ?? '')) hub?.push(Array.isArray(b.content) ? b.content.map(blockText).join('\n') : String(b.content ?? ''));
      }
    }
    if (typed.length) push('user', stripReminders(typed.join('\n')));
  }
  return out;
}

const cap = (t: string, n: number) => (t.length > n ? t.slice(0, n) + ' …[truncated]' : t);

/** Subagent transcript → only its task prompt and final answer (intermediate steps are noise). */
export function parseSubagent(raw: string, hub?: string[]): Msg[] {
  const msgs = parseClaude(raw, undefined, hub);
  const task = msgs.find((m) => m.role === 'user');
  let result: Msg | undefined;
  for (let i = msgs.length - 1; i >= 0 && !result; i--) {
    const m = msgs[i];
    if (m.role !== 'assistant') continue;
    const text = m.text.split('\n').filter((l) => !/^\[(?:Bash|Write|Edit|NotebookEdit|WebSearch|WebFetch|Agent|Ask)\]/.test(l)).join('\n').trim();
    if (text) result = { ...m, text };
  }
  const out: Msg[] = [];
  if (task) out.push({ ...task, role: 'tool', text: `[subagent task] ${cap(task.text, 2000)}` });
  if (result) out.push({ ...result, role: 'tool', text: `[subagent result] ${cap(result.text, MAX_RESULT)}` });
  return out;
}
