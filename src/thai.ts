// Thai+English tokenization done app-side (Postgres has no Thai parser).
// Index and query MUST use these same functions, so lexemes always line up.

const seg = new Intl.Segmenter('th', { granularity: 'word' });
const THAI_RUN = /[฀-๿0-9]+/g;
const SCRIPT_EDGE = /(?<=[฀-๿])(?=[0-9A-Za-z])|(?<=[0-9A-Za-z])(?=[฀-๿])/;
// Code identifiers: snake_case, kebab, dotted, camelCase, HTTPServer → parts.
const IDENT_EDGE = /[_.\-:]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

const fold = (s: string) => s.normalize('NFC').replace(/ํา/g, 'ำ'); // ํา typed as two chars → ำ

export function normalize(s: string): string {
  return fold(s).toLowerCase();
}

/**
 * ICU word segmentation (Thai dictionary + UAX#29 for Latin), then:
 *  - split Thai↔digit/Latin edges ICU leaves glued (ที่7, 53ภายใน)
 *  - code identifiers also emit their parts (getUserById → getuserbyid + get user by id;
 *    pg_advisory_xact_lock → … + advisory xact lock), so code is findable by whole name or by words.
 */
export function words(s: string): string[] {
  const out: string[] = [];
  for (const x of seg.segment(fold(s))) {
    if (!x.isWordLike) continue;
    for (const w of x.segment.trim().split(SCRIPT_EDGE)) {
      if (!w || w.length > 64) continue;
      const low = w.toLowerCase();
      out.push(low);
      if (!/[A-Za-z]/.test(w)) continue;
      const parts = w.split(IDENT_EDGE).map((p) => p.toLowerCase()).filter((p) => p.length >= 2 && p !== low);
      if (parts.length > 1) out.push(...parts);
    }
  }
  return out;
}

/**
 * Overlapping char bigrams over Thai/digit runs, with dots inside Thai abbreviations removed
 * (ภ.ง.ด.53 → ภงด53 → ภง งด ด5 53) — catches abbreviations and short words ICU mangles.
 * Returns one array per run so callers can phrase-match within a run.
 */
export function bigramRuns(s: string): string[][] {
  const t = normalize(s).replace(/(?<=[฀-๿])\.(?=[฀-๿0-9])/g, '');
  const runs: string[][] = [];
  for (const m of t.matchAll(THAI_RUN)) {
    const r = [...m[0]];
    if (!/[฀-๿]/.test(m[0]) && r.length > 6) continue; // long pure numbers: words field covers them
    if (r.length === 1) runs.push(r);
    else runs.push(r.slice(0, -1).map((c, i) => c + r[i + 1]));
  }
  return runs;
}

const STOP = new Set(
  ('ที่ ของ และ ใน ได้ ให้ เป็น มี การ ว่า จะ ก็ ไม่ แล้ว กับ นี้ คือ ไป มา อยู่ ด้วย หรือ ซึ่ง ครับ ค่ะ คะ นะ เลย ทำ ยัง อะไร ไหม มั้ย ' +
    'the a an of to in is are was be and or for on with it this that at by from as do does did how what').split(' '),
);

// ---- tsvector / tsquery literals (positions kept → phrase search works) ----

const lit = (w: string) => `'${w.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
const MAX_POS = 16383;

export function toTsvector(tokens: string[]): string {
  return tokens.slice(0, MAX_POS).map((w, i) => `${lit(w)}:${i + 1}`).join(' ');
}

/** Bigram vector: runs are separated by a position gap so phrases never span runs. */
export function bigramTsvector(runs: string[][]): string {
  const parts: string[] = [];
  let pos = 1;
  for (const run of runs) {
    for (const b of run) {
      if (pos > MAX_POS) break;
      parts.push(`${lit(b)}:${pos++}`);
    }
    pos++;
  }
  return parts.join(' ');
}

export type Term = { key: string; lit: string }; // key = lexeme for df lookup, lit = tsquery literal

// 'เลย' is a stopword and a province (จ.เลย): kept when every other kept word only asks when/how often ("ไปเลยเมื่อไหร่")
const ASK = new Set('เมื่อ ไหร่ ตอน ไหน ช่วง กี่ ครั้ง เคย'.split(' '));

/** Distinct non-stopword query terms; Latin terms ≥3 chars prefix-match (redact → redaction). */
export function queryTerms(q: string): Term[] {
  const ws = words(q), kept = ws.filter((w) => !STOP.has(w));
  const loei = kept.length > 0 && kept.every((w) => ASK.has(w));
  return [...new Set(ws.filter((w) => !STOP.has(w) || (loei && w === 'เลย')))].map((w) => ({
    key: w,
    lit: /^[a-z][a-z0-9_]{2,}$/.test(w) ? `${lit(w)}:*` : lit(w),
  }));
}

/**
 * Bigram query for SHORT Thai/digit runs only (abbreviations, short words ICU mangles); each must appear
 * as a contiguous phrase. Long runs are sentences — the words list covers them, and a 40-bigram phrase never matches.
 */
export function bigramQuery(q: string): string | null {
  const runs = bigramRuns(q).filter((r) => r.length && r.length <= 10 && (r.length > 1 || /[฀-๿]{2}/.test(r[0])));
  if (!runs.length) return null;
  return runs.map((r) => (r.length === 1 ? lit(r[0]) : `(${r.map(lit).join(' <-> ')})`)).join(' & ');
}
