// Rounds (one user prompt + everything until the next prompt) → chunks of ≤ MAX chars.
// Code fences are kept whole unless a single fence alone exceeds the limit.
import { createHash } from 'node:crypto';
import type { Role } from './claude.ts';

export const CHUNKER_VER = 'c1';
const MAX = 1200; // ≈ 300–500 bge-m3 tokens for mixed Thai/English
const HARD_SPLIT = new RegExp(`[\\s\\S]{1,${MAX}}`, 'gu'); // by code point, never splits a surrogate pair

export type Turn = { uuid: string; seq: number; role: Role; ts: string; text: string };
export type Chunk = { id: string; turnUuid: string; seqFrom: number; seqTo: number; ts: string; ctxHeader: string; text: string };

const LABEL: Record<Role, string> = { user: 'U', assistant: 'A', tool: 'T', summary: 'S', notice: 'N', note: 'D' };

/** Split text into pieces ≤ MAX, never cutting inside a ``` fence that fits. */
function pieces(text: string): string[] {
  const segs: string[] = [];
  const re = /```[\s\S]*?(?:```|$)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    segs.push(...text.slice(last, m.index).split(/\n{2,}/), m[0]);
    last = m.index! + m[0].length;
  }
  segs.push(...text.slice(last).split(/\n{2,}/));
  const out: string[] = [];
  for (const s of segs.map((x) => x.trim()).filter(Boolean)) {
    if (s.length <= MAX) { out.push(s); continue; }
    const lines = s.split('\n').flatMap((l) => (l.length > MAX ? l.match(HARD_SPLIT)! : [l]));
    let cur = '';
    for (const line of lines) {
      if (cur && cur.length + line.length + 1 > MAX) { out.push(cur); cur = ''; }
      cur = cur ? cur + '\n' + line : line;
    }
    if (cur) out.push(cur);
  }
  return out;
}

const firstLine = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 80);

export function chunkTurns(turns: Turn[], projectName: string): Chunk[] {
  const rounds: Turn[][] = [];
  for (const t of turns) {
    if (!rounds.length || t.role === 'user' || t.role === 'summary' || t.role === 'note') rounds.push([]);
    rounds.at(-1)!.push(t);
  }
  const chunks: Chunk[] = [];
  for (const round of rounds) {
    const head = round[0];
    const ctxHeader = `${projectName} ${head.ts.slice(0, 10)} — ${firstLine(head.text)}`;
    let buf = '', from = head, to = head;
    const emit = () => {
      if (!buf) return;
      const id = createHash('sha256').update(`${CHUNKER_VER}\0${ctxHeader}\0${buf}`).digest('hex').slice(0, 16);
      chunks.push({ id, turnUuid: from.uuid, seqFrom: from.seq, seqTo: to.seq, ts: from.ts, ctxHeader, text: buf });
      buf = '';
    };
    for (const t of round) {
      let label = `${LABEL[t.role]}: `;
      for (const p of pieces(t.text)) {
        const add = label + p;
        label = '';
        if (buf && buf.length + add.length + 1 > MAX) emit();
        if (!buf) from = t;
        buf = buf ? buf + '\n' + add : add;
        to = t;
      }
    }
    emit();
  }
  return chunks;
}
