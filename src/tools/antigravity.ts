// Google Antigravity (2.0 app, IDE, CLI share one format): ~/.gemini/antigravity{,-ide,-cli}/brain/<conversationId>/
// .system_generated/logs/transcript.jsonl (+ transcript_full.jsonl: untruncated, but only from the step it was introduced).
// One line = one step; steps are replayed and a step_index is reused after a rewind, so the last line wins.
// Not importable: conversations/*.pb (AES-encrypted) and the CLI's 0-byte transcripts (text only in protobuf .db rows).
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Msg, Role } from '../claude.ts';
import { readLines, syncFile, type Parsed } from '../importer.ts';

export const tool = 'antigravity';
const APPS = ['antigravity', 'antigravity-ide', 'antigravity-cli']; // order = tie-break when one conversation is in two apps
const FILES = ['transcript.jsonl', 'transcript_full.jsonl'];
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const home = () => process.env.MEMHUB_ANTIGRAVITY_HOME ?? join(homedir(), '.gemini');
const ls = (d: string) => (existsSync(d) ? readdirSync(d) : []);
const stat = (p: string) => (existsSync(p) ? statSync(p) : undefined);

/** Rows from a live app SQLite db, read from a temp copy (db + -wal) so the app's files are never opened or locked. */
function query(db: string, sql: string): any[] {
  if (!existsSync(db)) return [];
  const tmp = mkdtempSync(join(tmpdir(), 'memhub-ag-'));
  try {
    // not -shm: the running app byte-locks it (copy → EBUSY) and SQLite rebuilds it from -wal anyway
    for (const s of ['', '-wal']) if (existsSync(db + s)) copyFileSync(db + s, join(tmp, `c.db${s}`));
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite'); // lazy: it warns "experimental" on load
    const d = new DatabaseSync(join(tmp, 'c.db'), { readOnly: true });
    try { return d.prepare(sql).all(); } finally { d.close(); }
  } catch { return []; } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** First length-delimited field `want` of a protobuf message (enough to read one nested string). */
function pbField(b: Uint8Array, want: number): Uint8Array | undefined {
  let i = 0;
  const varint = () => { let v = 0, m = 1, x; do { x = b[i++]; v += (x & 127) * m; m *= 128; } while (x & 128 && i < b.length); return v; };
  while (i < b.length) {
    const tag = varint(), wt = tag & 7;
    if (wt === 0) varint(); else if (wt === 1) i += 8; else if (wt === 5) i += 4;
    else if (wt === 2) { const n = varint(); if (tag >>> 3 === want) return b.subarray(i, i + n); i += n; } else return;
  }
}

const uriPath = (u: unknown) => { try { return typeof u === 'string' && u ? fileURLToPath(u) : ''; } catch { return ''; } };
const firstUri = (json: unknown) => { try { return JSON.parse(String(json))[0]; } catch { return ''; } };
/** IDE/CLI conversations have no summaries row: workspace URI = trajectory_metadata_blob field 1.1. */
function dbWorkspace(db: string) {
  const blob = query(db, 'SELECT data FROM trajectory_metadata_blob LIMIT 1')[0]?.data;
  const f1 = blob instanceof Uint8Array ? pbField(blob, 1) : undefined, uri = f1 && pbField(f1, 1);
  return uri ? uriPath(Buffer.from(uri).toString('utf8')) : '';
}

type Meta = { app?: string; cwd?: string; parent?: string };

export function sync(archiveDir: string): Record<string, number> {
  const root = home();
  const stats: Record<string, number> = { copied: 0, appended: 0, replaced: 0, conflicts: 0, unchanged: 0, noText: 0 };
  const best = new Map<string, { app: string; logs: string; size: number; mtime: number }>();
  const seen = new Set<string>();
  for (const app of APPS) {
    for (const f of ls(join(root, app, 'conversations'))) seen.add(f.replace(/\.(?:pb|db)$/, ''));
    for (const id of ls(join(root, app, 'brain'))) {
      if (!UUID.test(id)) continue;
      seen.add(id);
      const logs = join(root, app, 'brain', id, '.system_generated', 'logs');
      const [t, f] = FILES.map((n) => stat(join(logs, n)));
      if (!t?.size) continue;
      const c = { app, logs, size: t.size + (f?.size ?? 0), mtime: Math.max(t.mtimeMs, f?.mtimeMs ?? 0) };
      const b = best.get(id); // same conversation in two apps (IDE → 2.0 migration): one copy, bigger then newer then app order
      if (!b || c.size > b.size || (c.size === b.size && c.mtime > b.mtime)) best.set(id, c);
    }
  }
  stats.noText = [...seen].filter((id) => UUID.test(id) && !best.has(id)).length; // encrypted .pb / CLI .db only
  if (!best.size) return stats;

  // cwd + parent: 2.0 app's conversation_summaries.db; IDE/CLI fall back to the conversation .db (until found)
  const rows = new Map<string, any>();
  for (const app of APPS) {
    for (const r of query(join(root, app, 'conversation_summaries.db'),
      'SELECT conversation_id id, workspace_uris ws, parent_conversation_id parent FROM conversation_summaries')) rows.set(r.id, r);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'memhub-ag-'));
  try {
    for (const [id, b] of best) {
      const dst = join(archiveDir, id, 'meta.json'), was = existsSync(dst) ? readFileSync(dst, 'utf8') : '';
      let old: Meta = {};
      try { old = JSON.parse(was); } catch {}
      const kept = FILES.reduce((n, f) => n + (stat(join(archiveDir, id, f))?.size ?? 0), 0);
      if (old.app && old.app !== b.app && b.size < kept) continue; // a stale copy left in another app never replaces the archive
      for (const n of FILES) if (existsSync(join(b.logs, n))) stats[syncFile(join(b.logs, n), join(archiveDir, id, n))]++;
      const r = rows.get(id);
      const meta: Meta = {
        app: b.app,
        cwd: r ? uriPath(firstUri(r.ws)) : old.cwd || dbWorkspace(join(root, b.app, 'conversations', `${id}.db`)),
        parent: r ? (UUID.test(r.parent ?? '') ? r.parent : undefined) : old.parent,
      };
      const text = JSON.stringify(meta);
      if (text !== was) { writeFileSync(join(tmp, 'meta.json'), text); syncFile(join(tmp, 'meta.json'), dst, false); }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return stats;
}

export const isTranscript = (path: string) => basename(path) === 'transcript.jsonl'; // its sibling _full is merged in parse()

const CAP = 20000, OUT = 300, LONG = 4000; // LONG: compaction summaries, agent reports (like Claude's results)
const cap = (t: string, n: number) => (t.length > n ? t.slice(0, n) + ' …[truncated]' : t);
const str = (v: unknown, n = OUT) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)).slice(0, n);
const DATA_URL = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g;
// transcript.jsonl stores each tool arg as JSON text ("\"git status\"", "12"), _full plain values.
// A truncated one is `"<JSON text cut, maybe mid-escape>\n<truncated N bytes>`.
function unjson(v: unknown) {
  if (typeof v !== 'string') return v;
  const cut = v.replace(/\s*<truncated \d+ bytes>$/, '');
  for (const s of [v, cut + '"', cut.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, '') + '"']) try { return JSON.parse(s); } catch {}
  return v;
}

// tool call → one compact line; only tools whose arguments say something worth recalling.
function toolLine(name: unknown, a: any): string | null {
  switch (name) {
    case 'run_command': return `[shell] ${str(a?.CommandLine)}`;
    case 'write_to_file': return `[write] ${str(a?.TargetFile)}`;
    case 'replace_file_content': case 'multi_replace_file_content': return `[edit] ${str(a?.TargetFile)}`;
    case 'search_web': return `[search] ${str(a?.query)}`;
    case 'read_url_content': return `[fetch] ${str(a?.Url)}`;
    case 'invoke_subagent': return `[subagent] ${str(a?.Subagents)}`;
    case 'browser_subagent': return `[browser] ${str(a?.TaskName, 100)}: ${str(a?.Task)}`;
    case 'ask_question': return `[ask] ${str(a?.questions)}`;
    case 'call_mcp_tool': return `[mcp] ${str(a?.ServerName, 100)} ${str(a?.ToolName, 100)}`;
    case 'generate_image': return `[image] ${str(a?.Prompt)}`;
    case 'send_message': return `[message] ${str(a?.Message)}`; // to another agent (a subagent's report to its parent)
    default: return null; // view_file, grep_search, list_dir, find_by_name, manage_task, schedule…
  }
}

/** USER_INPUT = <USER_REQUEST> typed text + app-injected <ADDITIONAL_METADATA> (local time, open files…) / settings changes. */
function userText(c: string) {
  c = c.replace(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?(?:<\/\1>|$)/g, '');
  const req = [...c.matchAll(/<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/g)].map((m) => m[1]); // truncated → no close tag
  return req.length ? req.join('\n') : c;
}
const META = /<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\1>/g; // closed only: a summary goes on after it
const result = (c: string) => cap(c.replace(/^(?:(?:Created|Completed) At: .*\n)+/, '').trim(), OUT);
// another agent's send_message arrives as a system message; background-task/system senders are not conversation ids
const AGENT_MSG = /\[Message\] timestamp=\S* sender=[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12} priority=\S* content=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/i;

function stepMsg(o: any, jsonArgs: boolean): [Role, string] | null {
  const c = typeof o.content === 'string' ? o.content : '';
  switch (o.type) {
    case 'USER_INPUT': return ['user', userText(c)];
    case 'PLANNER_RESPONSE': // thinking dropped
      return ['assistant', [c, ...(Array.isArray(o.tool_calls) ? o.tool_calls : []).map((t: any) => toolLine(t?.name,
        jsonArgs && t?.args ? Object.fromEntries(Object.entries(t.args).map(([k, v]) => [k, unjson(v)])) : t?.args))].filter(Boolean).join('\n')];
    // compaction summary, kept like Claude's; its "# User Requests" quote the raw inputs
    case 'CHECKPOINT': return ['summary', cap(c.replace(META, '').replace(/<\/?USER_REQUEST>/g, ''), LONG)];
    case 'ASK_QUESTION': return result(c) ? ['tool', `[ask result] ${result(c)}`] : null;
    case 'BROWSER_SUBAGENT': return result(c) ? ['tool', `[browser result] ${result(c)}`] : null;
    case 'SYSTEM_MESSAGE': { const m = AGENT_MSG.exec(c)?.[1].trim(); return m ? ['tool', `[agent message] ${cap(m, LONG)}`] : null; }
    default: return null; // tool outputs (GENERIC, VIEW_FILE, RUN_COMMAND…), system/ephemeral/error messages, injected history
  }
}

/** step_index → its last line (replays + rewinds: last wins), reduced to the msg: tool outputs make transcripts huge. */
async function readSteps(path: string, jsonArgs: boolean) {
  const steps = new Map<number, { status: unknown; at: unknown; m: [Role, string] | null }>();
  if (!existsSync(path)) return steps;
  for await (const line of readLines(path)) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (Number.isInteger(o?.step_index)) steps.set(o.step_index, { status: o.status, at: o.created_at, m: stepMsg(o, jsonArgs) });
  }
  return steps;
}

export async function parse(path: string): Promise<Parsed | null> {
  const dir = dirname(path), id = dir.split(/[\\/]/).reverse().find((s) => UUID.test(s)) ?? basename(dir); // archive or live layout
  const steps = await readSteps(path, true);
  // _full wins (untruncated) except where the short transcript says the step was CLEARED (only it records that)
  for (const [k, o] of await readSteps(join(dir, 'transcript_full.jsonl'), false)) if (steps.get(k)?.status !== 'CLEARED') steps.set(k, o);
  let meta: Meta = {};
  try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch {}
  const sessionId = meta.parent || id, cwd = meta.cwd ?? '';
  const msgs: Msg[] = [];
  let ts = '';
  for (const k of [...steps.keys()].sort((a, b) => a - b)) {
    const { status, at, m } = steps.get(k)!;
    if (status === 'CLEARED') continue;
    const text = m?.[1].replace(DATA_URL, '[image]').trim();
    if (!m || !text) continue;
    // a queued user input carries the time it was typed (before the answer it follows): keep ts non-decreasing
    const t = Date.parse(String(at));
    if (!Number.isNaN(t) && new Date(t).toISOString() > ts) ts = new Date(t).toISOString();
    msgs.push({ uuid: `antigravity:${id}:${k}`, parentUuid: msgs.at(-1)?.uuid ?? null, sessionId, ts, cwd, role: m[0], text: cap(text, CAP) });
  }
  return msgs.length ? { sessionId, cwd, kind: meta.parent ? 'subagent' : 'main', msgs } : null;
}
