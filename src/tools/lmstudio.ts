// LM Studio chats: ~/.lmstudio/conversations/**/<createdAtMs>.conversation.json (** = app folders), one JSON doc per chat rewritten
// whole on every change (format officially unstable: unknown fields/steps ignored, never throws on content).
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Msg } from '../claude.ts';
import { syncFile, walk, type Parsed } from '../importer.ts';

export const tool = 'lmstudio';
export const isTranscript = (path: string) => path.endsWith('.conversation.json'); // not the <file>.<mtime>.bak copies

/** Only conversations/ is read: settings/credentials elsewhere in ~/.lmstudio hold tokens. */
export function sync(archiveDir: string): Record<string, number> {
  const live = join(process.env.MEMHUB_LMSTUDIO_HOME ?? join(homedir(), '.lmstudio'), 'conversations');
  const stats: Record<string, number> = {};
  const add = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
  for (const f of walk(live)) {
    if (!isTranscript(f)) continue;
    // A doc caught mid-rewrite would be archived as junk and index as null (= its source, turns and edges dropped): next sync.
    // ponytail: parses every chat each sync (ms per MB); compare size/mtime with the archive first if it ever gets slow
    if (!complete(f)) { add('partial'); continue; }
    // Flat by file name (= createdAt ms, the chat id): dragging a chat between folders moves its file, and a folder path
    // would archive + index it twice. Rewritten chats keep the old as .bak.
    add(syncFile(f, join(archiveDir, 'conversations', basename(f))));
  }
  return stats;
}
const complete = (f: string) => { try { JSON.parse(readFileSync(f, 'utf8')); return true; } catch { return false; } };

const MAX = 20000;
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const ms = (v: unknown) => { const n = Number(v); return n > 0 && n < 8.64e15 ? n : 0; }; // valid Date range only
// Inline reasoning when LM Studio doesn't split it out: only where an answer starts (prompts and answers may mention <think>).
const THINK = /^\s*<think>[\s\S]*?(?:<\/think>|$)/;
const tidy = (t: string) => {
  t = t.replace(/data:[\w.+/-]+;base64,[A-Za-z0-9+/=]+/g, '[data-url]').trim();
  return t.length > MAX ? t.slice(0, MAX) + ' …[truncated]' : t;
};
const toolLine = (c: any) => `[${String(c.name)}] ${JSON.stringify(c.parameters ?? {})}`.slice(0, 300);

/** Text of the shown version: user content[] text, assistant visible contentBlocks + tool calls (no thinking/results/debug). */
function versionText(v: any): string {
  const parts = arr(v.content).filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text);
  for (const s of arr(v.steps)) {
    if (s?.type !== 'contentBlock' || s.style?.type === 'thinking' || s.roleOverride === 'tool') continue;
    let text = '';
    const flush = () => { text = text.replace(THINK, ''); if (text.trim()) parts.push(text); text = ''; };
    for (const c of arr(s.content)) { // one block can hold text then a call: keep that order
      if (c?.type === 'text' && typeof c.text === 'string' && !c.isStructural) text += c.text;
      else if (c?.type === 'toolCallRequest') { flush(); parts.push(toolLine(c)); }
    }
    flush();
  }
  return parts.join('\n');
}

export async function parse(path: string): Promise<Parsed | null> {
  let j: any;
  try { j = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  if (!Array.isArray(j?.messages)) return null;
  const stem = basename(path, '.conversation.json');
  const sessionId = `lmstudio-${stem}`; // stem = createdAt epoch ms
  // No per-message timestamps: createdAt + 1 ms per message keeps order, capped at the chat's last-messaged time.
  const t0 = ms(j.createdAt) || ms(stem) || statSync(path).mtimeMs;
  const last = Math.max(ms(j.userLastMessagedAt), ms(j.assistantLastMessagedAt)) || Infinity;
  const msgs: Msg[] = [];
  j.messages.forEach((m: any, i: number) => {
    const v = arr(m?.versions)[Number(m?.currentlySelected) || 0]; // other versions = discarded regenerations
    if (v?.role !== 'user' && v?.role !== 'assistant') return;
    const text = tidy(versionText(v));
    if (!text) return;
    const uuid = `${tool}:${stem}:${i}`; // raw message index: stable across re-parses
    msgs.push({ uuid, parentUuid: msgs.at(-1)?.uuid ?? null, sessionId, ts: new Date(Math.min(t0 + i, last)).toISOString(), cwd: '', role: v.role, text });
  });
  return msgs.length ? { sessionId, msgs } : null;
}
