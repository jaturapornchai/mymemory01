// Thai+English tokenization done app-side (Postgres has no Thai parser).
// Index and query MUST use these same functions, so lexemes always line up.

const seg = new Intl.Segmenter('th', { granularity: 'word' });
const THAI_RUN = /[฀-๿0-9]+/g;
const SCRIPT_EDGE = /(?<=[฀-๿])(?=[0-9A-Za-z])|(?<=[0-9A-Za-z])(?=[฀-๿])/;
// Code identifiers: snake_case, kebab, dotted, camelCase, HTTPServer → parts.
const IDENT_EDGE = /[_.\-:]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

// ํา typed as two chars → ำ; Thai digits → ASCII (ภ.ง.ด.๕๓ = ภ.ง.ด.53); common Thai loanword/tone spelling variants
// folded 1-for-1 in UTF-16 code units so snippet offsets into raw text stay aligned.
const fold = (s: string) => s.normalize('NFC')
  .replace(/ํา/g, 'ำ')
  .replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50))
  .replace(/สต๊อก/g, 'สต็อก')
  .replace(/ล๊อก/g, 'ล็อก')
  .replace(/บล๊อก/g, 'บล็อก')
  .replace(/ช๊อค/g, 'ช็อก')
  .replace(/แพ็คเกจ/g, 'แพ็กเกจ')
  .replace(/โปรเจ็ค/g, 'โปรเจ็ก')
  .replace(/เครม/g, 'เคลม')
  .replace(/อินวอยซ์/g, 'อินวอยส์');

export function normalize(s: string): string {
  return fold(s).toLowerCase();
}

const PURE_THAI = /^[\u0E01-\u0E4E]+$/;
// Thai word cannot end with a leading vowel (เ แ โ ใ ไ) or mai-han-akat / mai-taikhu (ั ็)
const NEEDS_GLUE_PREV = /[\u0E40-\u0E44\u0E31\u0E47]$/;
// Thai word cannot start with a combining mark, nor is a bare 1-consonant karan cluster (ต์ ร์ น์ ดิ์ ส์) standalone when directly attached
const NEEDS_GLUE_CUR = /^(?:[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]|[\u0E01-\u0E2E][\u0E31\u0E34-\u0E3A]?\u0E4C$)/;
const DOTTED_THAI_ABBR = /(?:[\u0E01-\u0E2E]\.){2,}\s*\d*/g;
const SPACED_THAI_ABBR = /(?<![\u0E00-\u0E7F])(ภงด|ภพ|กพอ|สปส|ปปง|สตง|ครม|พรบ|พรก)\s+(\d+)/g;

/**
 * ICU word segmentation (Thai dictionary + UAX#29 for Latin), then:
 *  - glue adjacent pure-Thai fragments that ICU split across a leading vowel or trailing karan mark (ซอฟ+ต์ → ซอฟต์, อิเล็กทรอนิก+ส์ → อิเล็กทรอนิกส์)
 *  - split Thai↔digit/Latin edges ICU leaves glued (ที่7, 53ภายใน)
 *  - emit collapsed Thai abbreviation tokens so "ภ.ง.ด. 53" == "ภ.ง.ด.53" == "ภงด 53" == "ภงด53"
 *  - code identifiers also emit their parts (getUserById → getuserbyid + get user by id;
 *    pg_advisory_xact_lock → … + advisory xact lock), so code is findable by whole name or by words.
 */
export function words(s: string): string[] {
  const folded = fold(s);
  const segs: string[] = [];
  let prevEnd = -1;
  for (const x of seg.segment(folded)) {
    if (!x.isWordLike) continue;
    const raw = x.segment.trim();
    if (!raw) continue;
    const prev = segs.at(-1);
    if (
      prev && prevEnd === x.index && PURE_THAI.test(prev) && PURE_THAI.test(raw)
      && (NEEDS_GLUE_PREV.test(prev) || NEEDS_GLUE_CUR.test(raw))
    ) {
      segs[segs.length - 1] = prev + raw;
    } else {
      segs.push(raw);
    }
    prevEnd = x.index + x.segment.length;
  }

  const out: string[] = [];
  for (const segWord of segs) {
    for (const w of segWord.split(SCRIPT_EDGE)) {
      if (!w || w.length > 64) continue;
      const low = w.toLowerCase();
      out.push(low);
      if (/^\d+$/.test(low) && out.length >= 2 && /^(?:ภงด|ภพ|กพอ|สปส|ปปง|สตง|ครม|พรบ|พรก)$/.test(out[out.length - 2])) {
        out.push(out[out.length - 2] + low);
      }
      if (!/[A-Za-z]/.test(w)) continue;
      const parts = w.split(IDENT_EDGE).map((p) => p.toLowerCase()).filter((p) => p.length >= 2 && p !== low);
      if (parts.length > 1) out.push(...parts);
    }
  }

  for (const m of folded.matchAll(DOTTED_THAI_ABBR)) {
    const letters = m[0].replace(/[\s.\d]+/g, '').toLowerCase();
    const digits = m[0].match(/\d+$/)?.[0] ?? '';
    if (letters.length >= 2 && !out.includes(letters)) out.push(letters);
    if (letters.length >= 2 && digits && !out.includes(letters + digits)) out.push(letters + digits);
  }
  for (const m of folded.matchAll(SPACED_THAI_ABBR)) {
    const comb = (m[1] + m[2]).toLowerCase();
    if (!out.includes(comb)) out.push(comb);
  }
  return out;
}

/**
 * Overlapping char bigrams over Thai/digit runs, with dots (and space before form number) inside Thai abbreviations removed
 * (ภ.ง.ด. 53 / ภ.ง.ด.53 / ภงด 53 → ภงด53 → ภง งด ด5 53) — catches abbreviations and short words ICU mangles.
 * Returns one array per run so callers can phrase-match within a run.
 */
export function bigramRuns(s: string): string[][] {
  const t = normalize(s)
    .replace(/((?:[\u0E01-\u0E2E]\.){2,})\s+(?=\d)/g, '$1')
    .replace(SPACED_THAI_ABBR, '$1$2')
    .replace(/(?<=[฀-๿])\.(?=[฀-๿0-9])/g, '');
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
  const out = ws.filter((w) => !STOP.has(w) || (loei && w === 'เลย'));
  // + the province's English name, only where เลย cannot mean "go ahead": the rule above, จ.เลย, จังหวัดเลย (not ไปเที่ยวเลย)
  if (loei || ws.includes('จ.เลย') || ws.some((w, i) => w === 'เลย' && /^(จ\.?|จังหวัด)$/.test(ws[i - 1] ?? ''))) out.push('loei');
  return [...new Set(out)].map((w) => ({
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
