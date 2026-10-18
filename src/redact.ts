// Secret redaction — runs before anything is written to the DB or embedded.
// Raw archive keeps originals; the index only ever sees redacted text.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ลุงจืด's real secrets no shape rule can catch (a bare value in a table cell, grep "<pw>"): one per line, outside git.
// ≥8 chars only: a short or word-like one would wipe that word from every chat.
export const KNOWN_FILE = process.env.MEMHUB_KNOWN_SECRETS ?? join(homedir(), '.memory-hub', 'known-secrets.txt');
const KNOWN = (() => {
  try { return readFileSync(KNOWN_FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length >= 8).sort((a, b) => b.length - a.length); }
  catch { return []; }
})();
/** Changes whenever what redact() removes may change (this file's rules or the known list): importer.requeueUnredacted. */
export const REDACT_VER = createHash('sha256').update(readFileSync(new URL(import.meta.url))).update(KNOWN.join('\n')).digest('hex');

type Rule = { kind: string; re: RegExp; group?: number };

// Order matters: multi-line / most specific first, generic entropy last.
const RULES: Rule[] = [
  { kind: 'pem', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g }, // BLOCK: PGP
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'sk', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'stripe', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'google', re: /\b(?:AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z._-]{20,}|1\/\/[0-9A-Za-z_-]{40,})/g }, // API key, access (ya29.c.…), refresh token
  { kind: 'slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'telegram', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g },
  { kind: 'npm', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'hf', re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { kind: 'hex64', re: /\b0x[0-9a-fA-F]{64}\b/g },
  { kind: 'digitalocean', re: /\bdo[opr]_v1_[0-9a-f]{64}\b/g },
  { kind: 'ark', re: /\bark-(?=(?:[\w-]*\d){4})[0-9a-z-]{30,}/gi }, // BytePlus/Volcengine Ark keys (hex+dash: entropy rule skips them)
  { kind: 'ollama', re: /\b[0-9a-f]{32}\.[A-Za-z0-9_-]{16,}/g }, // Ollama cloud keys, Zhipu GLM / z.ai (16 after the dot)
  { kind: 'sk', re: /\b(?:mcp_)?sk_[0-9a-f]{32,}\b/g }, // ElevenLabs sk_ + 48 hex, mcp_sk_ + 32 hex: pure hex, so entropy skips them
  { kind: 'syn', re: /\bsyn_[0-9a-f]{32}\b/gi }, // syn_ + 32 hex: pure hex, so the entropy rule skips it (one reached the index)
  // natural language: password `x` / รหัสผ่าน "x" (quoted value, no = or :)
  { kind: 'kv', re: /(\b(?:password|passwd|pwd)\s+(?:is\s+)?|(?:รหัสผ่าน|พาสเวิร์ด)\s*(?:คือ\s*)?)[`'"]([^`'"\s]{3,})[`'"]/gi, group: 2 },
  // scheme://user:PASSWORD@host  → only the password part, up to the last @ (passwords hold @ and /; the user may be empty);
  // host:port/… is not a password (localhost:5173/@vite, :8080?u=a@b.com), nor a scanner regex (mongodb\+srv://|://[^/]*:[^@]*@)
  // the password never spans a \n escape or a second scheme:// (one JSON string holding several URLs)
  { kind: 'connstr', re: /(\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"`|]*:)(?!\d+(?:[/?#]|$)|\/)((?:(?!:\/\/)[^\s'"`\\])+)(?=@)/gi, group: 2 },
  // a digit is required: "Bearer authentication", "basic configuration" are prose
  { kind: 'bearer', re: /(\b(?:Bearer|Basic)\s+)((?=[A-Za-z._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,})/gi, group: 2 },
  { kind: 'cli', re: /(--(?:password|passwd|token|api-key|apikey|secret|client-secret|plaintext)[= ]+["']?)([^\s"'`]{3,})/gi, group: 2 },
  // curl -u user:PASSWORD (a letter and a digit/symbol: docker -u 1000:1000, -u www-data:www-data stay; python -u D:\x.py is a path)
  { kind: 'cli', re: /(\s-u\s+["']?[\w.@-]{2,}:)(?![\\/])((?=[^\s"']*[A-Za-z])(?=[^\s"']*[\d!@#$%^&*+=?~])[^\s"']{6,})(?=["'\s]|$)/g, group: 2 },
  // key = value / key: value / "key": "value" (env, yaml, json, ini, ADO.NET)
  {
    kind: 'kv',
    re: /(\b[\w.-]*?(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credentials?|pgpassword)[\w-]*["']?\s*[:=]\s*["'`]?)([^\s"'`,;&)}\]]{3,})/gi,
    group: 2,
  },
  { kind: 'kv', re: /((?:รหัสผ่าน|พาสเวิร์ด)\s*[:=：]?\s*)(\S{3,})/g, group: 2 },
  // short keys the substring rule above must not use (pw would hit "upwork", pass: is English prose): pw = 'x' / net use /pass:x
  { kind: 'kv', re: /((?:\bpw|\/pass)["']?\s*[:=]\s*["']?)([^\s"'`,;&)}\]]{3,})/gi, group: 2 },
  // env names (case-sensitive): WEATHER_KEY=…, DB_PASS=…; SSH_KEY_PATH does not end in _KEY; a *_KEY value needs a digit (SORT_KEY=name)
  // [ \t]: an empty DEEPSEEK_KEY= must not take the next line as its value
  { kind: 'kv', re: /(\b[A-Z][A-Z0-9_]*_KEY[ \t]*[:=][ \t]*["']?)((?=[^\s"'`,;&)}\]\d]*\d)[^\s"'`,;&)}\]]{3,})/g, group: 2 },
  { kind: 'kv', re: /(\b[A-Z][A-Z0-9_]*_(?:PASS|PASSWD|PWD|PW)[ \t]*[:=][ \t]*["'`]?)([^\s"'`,;&)}\]]{3,})/g, group: 2 },
  // bare key/pass only with a quoted secret-shaped value: "key": "<16+ alnum with a digit>", pass: "<6+ with a digit/symbol>"
  { kind: 'kv', re: /(["']?\bkey["']?\s*:\s*["'])((?=[A-Za-z]*\d)[A-Za-z0-9]{16,})(?=["'])/gi, group: 2 },
  { kind: 'kv', re: /(["']?\bpass["']?\s*[:=]\s*["'`])((?=[^"'`\s]*[\d!@#$%^&*+=?~])[^"'`\s]{6,})(?=["'`])/gi, group: 2 },
  // markdown credentials: user `admin` pass `PW`, Secret key: `PW`, | S3 Secret Key | `PW` |
  { kind: 'kv', re: /(\buser(?:name)?\s+[`'"][^`'"\s]+[`'"]\s*[,/]?\s*(?:pass(?:word)?|pwd|pw)\s*[:=]?\s*[`'"])([^`'"\s]{3,})(?=[`'"])/gi, group: 2 },
  { kind: 'kv', re: /(\b(?:secret|access)[ _-]?key\s*[:=|]\s*[`'"])([^`'"\s|]{6,})(?=[`'"])/gi, group: 2 },
  // paramiko/ssh2 positional: .connect('host', 22, 'user', 'PASSWORD'); prose "(root / `PASSWORD`)"
  { kind: 'login', re: /(\.connect\(\s*["'][^"'\s]+["']\s*,\s*\d+\s*,\s*["'][^"'\s]+["']\s*,\s*["'])([^"'\s]{3,})(?=["'])/g, group: 2 },
  // backtick only: (tmp / "frame_1.png") is a Python pathlib join
  { kind: 'login', re: /(\(\s*[a-z_][\w-]{1,31}\s+\/\s+`)((?=[^`\s]*[A-Za-z])(?=[^`\s]*[\d!@#$%^&*+=?~])[^`\s]{6,})(?=`)/gi, group: 2 },
  // "<ip> <user> <password>" in prose; the value needs a letter and a digit/symbol, so "1.2.3.4 root access" stays
  { kind: 'login', re: /(\b\d{1,3}(?:\.\d{1,3}){3}\s+[a-z_][\w-]{1,31}\s+)((?=\S*[A-Za-z])(?=\S*[\d!@#$%^&*+=?~])[^\s"'`()[\]{}<>]{6,})(?![^\s])/gi, group: 2 },
];

// Values that are clearly not secrets (code types, placeholders, env lookups).
const PLACEHOLDER =
  /^(?:\*+|x{3,}|<.*>|\$.*|%.*%|\{.*|process\.env.*|os\.environ.*|getenv.*|env\..*|string|number|boolean|bool|str|int|null|none|nil|undefined|true|false|required|optional|any|empty|redacted.*|\[redacted.*|\[private\]|z\..*|type|text|varchar.*|\.\.\.)$/i;
const PASSWORDISH = /pass|pwd|pin/i;

// '/' excluded: paths/URLs are the main false positive; base64 secrets still leave ≥28-char pieces.
// '=' only as trailing base64 padding, so KEY=value splits and each side is judged alone.
const ENTROPY_CANDIDATE = /[A-Za-z0-9+_-]{28,}={0,2}/g;
// Random but public object ids (Anthropic/OpenAI/Stripe/etc.).
const PUBLIC_ID = /^(?:toolu|srvtoolu|msg|req|call|chatcmpl|resp|run|thread|asst|file|batch|evt|cus|pi|ch|txn|agent|wf)_/;

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// High-entropy blob = upper+lower+3 digits and ≥4.3 bits/char.
// Pure hex (git/sha digests, uuids) and word-like identifiers stay searchable.
function looksSecret(tok: string): boolean {
  const core = tok.replace(/^[-_=/+]+|[-_=/+]+$/g, '');
  if (core.length < 28) return false;
  if (!/[A-Z]/.test(core) || !/[a-z]/.test(core) || (core.match(/\d/g)?.length ?? 0) < 3) return false; // camelCase names rarely have 3+ digits
  if (PUBLIC_ID.test(core)) return false;
  if (/^(?:[a-zA-Z]+[-_/]){2,}[a-zA-Z0-9]+$/.test(core)) return false; // path/kebab/snake words
  return entropy(core) >= 4.3;
}

export type RedactResult = { text: string; hits: Record<string, number> };

export function redact(input: string): RedactResult {
  const hits: Record<string, number> = {};
  const hit = (k: string) => (hits[k] = (hits[k] ?? 0) + 1);
  let text = input;
  for (const k of KNOWN) if (text.includes(k)) { text = text.split(k).join('[REDACTED:known]'); hit('known'); }

  for (const { kind, re, group } of RULES) {
    text = text.replace(re, (...m: string[]) => {
      if (!group) return hit(kind), `[REDACTED:${kind}]`;
      const [whole, prefix, value] = m;
      if (kind === 'kv' || kind === 'cli') {
        if (PLACEHOLDER.test(value) || /[฀-๿]/.test(value) || /\$[({]/.test(value)) return whole; // types, placeholders, Thai prose, $(cmd)
        if (/^\d[\d.,]*[kKmMbB%]?$/.test(value) && !PASSWORDISH.test(prefix)) return whole; // max_tokens: 4096, tokens: 25k
        if (/^[a-z][a-z0-9]*(?:[._][a-z0-9]+){2,}$/.test(value) && !PASSWORDISH.test(prefix)) return whole; // LS_KEY = "memhub.view.v1", STORAGE_KEY = "bc_grid_v1"
        // markdown `code` after token:/secret:/credentials= is prose (`--flag`, `include`); only password/key names quote a secret that way
        if (prefix.endsWith('`') && (!/pass|pwd|(?:secret|access|api|private)[ _-]?key/i.test(prefix) || /[^\x21-\x7e]/.test(value))) return whole;
        if (/^(?:[\w.-]+[/\\])+[\w.-]+\.[a-z]{1,5}(?::\d+(?:-\d+)?)?$/i.test(value)) return whole; // file ref: src/auth.ts:12-34
        if (/^(?:~?\/|\.\.?\/|[A-Za-z]:\\)/.test(value) && !PASSWORDISH.test(prefix)) return whole; // SSH_KEY: /root/.ssh/id_ed25519
      }
      hit(kind);
      return `${prefix}[REDACTED:${kind}]`;
    });
  }

  text = text.replace(ENTROPY_CANDIDATE, (tok, off: number, all: string) =>
    looksSecret(tok) && !/^.[a-z]{1,5}/i.test(all.slice(off + tok.length)) ? (hit('entropy'), '[REDACTED:entropy]') : tok, // name.ext = file
  );
  return { text, hits };
}

// <private>…</private> is dropped entirely (unclosed tag → drop to end).
export function stripPrivate(input: string): string {
  return input.replace(/<private>[\s\S]*?(?:<\/private>|$)/gi, '[PRIVATE]');
}

// ---------------- personal data: Claude-only Google sources (guard.PRIVATE_TOOLS), before redact() ----------------
// Red-team corpus: tmp/google/redact-corpus (83 fake cases, 0 false positives on its traps). Phone numbers stay (shops, couriers).

const luhn = (d: string) => [...d].reverse().reduce((t, c, i) => t + (i % 2 ? [0, 2, 4, 6, 8, 1, 3, 5, 7, 9][+c] : +c), 0) % 10 === 0;
const thaiid = (d: string) => (11 - ([...d.slice(0, 12)].reduce((t, c, i) => t + +c * (13 - i), 0) % 11)) % 10 === +d[12];
const digits = (s: string) => s.replace(/\D/g, '');

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
// keyword at the start of a path word: reset-password, loginwithemail, unsub.php; 'authors' is not auth
const TOKEN_PATH = /(?:^|[/_.-])(?:reset|verif|confirm|log-?in|sign-?in|magic|token|auth(?!or)|unsub|activat|callback|recover|passw)/i;
// 2-6 = Visa/MC/Amex/Diners/JCB/Discover/UnionPay; keeps 1xxx epoch-ms and 0/7/8/9 ids out; groups split by 1-2 of space . - newline
const CARD = /(?<![\d-])(?:[2-6]\d{12,18}|[2-6]\d{3}(?:[ .\n-]{1,2}\d{4}){2}[ .\n-]{1,2}\d{1,4}(?:[ .\n-]{1,2}\d{1,3})?|3\d{3}[ .\n-]{1,2}\d{6}[ .\n-]{1,2}\d{4,5})(?![\d-])/g;
const THAIID = /(?<![\d-])[0-8](?:\d{12}|([ -])\d{4}\1\d{5}\1\d{2}\1\d)(?![\d-])/g;
const BANK_SHAPE = /(?<![\d-])\d{3}([ -])(?:\d\1\d{5}|\d{6})\1\d(?![\d-])/g; // 123-4-56789-0, 123-456789-0, 123 4 56789 0
const BANK_KW = /((?:เลขที่บัญชี|เลขบัญชี|บัญชี|พร้อมเพย์|PromptPay)[^\d\n[]{0,25}?|\b(?:a\/c|acct|account)(?:\s*(?:no\.?|number))?[\s:#.]*)(\d(?:[ -]?\d){9,11})(?!\d)/gi;
const PASSPORT = /((?:[Pp]assport|PASSPORT|หนังสือเดินทาง)[^\n]{0,30}?)(?<![A-Za-z0-9])([A-Z]{1,2}\d{6,8})(?![A-Za-z0-9])/g;
const CVV = /(\b(?:CVV2?|CVC2?)\s*[:=]?\s*)(\d{3,4})\b/gi;
const OTP_KW = /\b(?:OTP|(?:verification|security|sign-?in|log-?in|confirmation|access|2FA|auth\w*) code|is your [\w-]+ code|your [\w-]+ code is|one[- ]time (?:code|password|passcode)|passcode)\b|รหัส(?:ยืนยัน|ผ่านใช้ครั้งเดียว|เข้าสู่ระบบ|เข้าใช้)/gi;
// standalone 4-8 digits (or 4 8 2 9 1 3 / 482 913 / 482-913 / 1234 5678): not glued to letters, not part of a date/time/price
// (1,250 / 03/10 / 14:35 / 2026-10-03)
const OTP_NUM = /(?<!\w|\d[/:,.-])(?:\d(?: \d){3,7}|\d{3,4}[ \n-]\d{3,4}|\d{4,8})(?!\w|[/:,.-]\d)/g;
const NOT_OTP_BEFORE = /(?:฿|\$|THB|ปี|พ\.ศ\.|ค\.ศ\.|[ก-๙]{1,3}\.[ก-๙]{1,2}\.|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s*\d{1,2},?)?)\s*$/i;
const NOT_OTP_AFTER = /^\s*(?:บาท|THB|baht|USD|นาที|ครั้ง|min)/i;
const OTP_WINDOW = 50, OTP_FAR = 120; // far: only when nothing is near, "Your verification code (valid for 10 minutes; …) is: 482913"
// a password in prose (redact()'s Thai kv rule stops at the first Thai word, its English one needs ':' '=' or quotes): every
// non-Thai token ≥ 6 chars with a letter and a digit (or an inner symbol) ≤ 40 chars after the keyword; URLs are not one
const PASSWORD = /(รหัสผ่าน|พาสเวิร์ด|\bpass(?:word|code)s?\b)([^\n]{0,40}\S*)/gi;
const PASSWORD_TOKEN = /(?<![^\s:=：฀-๿"'(])(?!\S*\/\/)(?=[^\s฀-๿]*[A-Za-z])(?=[^\s฀-๿]*(?:\d|[!@#$%^&*+=~_-][^\s฀-๿]))[^\s฀-๿]{6,}/g;

/** Strict pass for mail/docs (importer.clean of PRIVATE_TOOLS only): one-time codes, login/reset links, every URL query, cards
 *  (Luhn), Thai ID (mod 11), bank/PromptPay accounts and passports near their keywords. Over-masks on purpose: an order id that
 *  passes Luhn, a 4-8 digit number next to "OTP". */
export function redactPersonal(input: string): RedactResult {
  const hits: Record<string, number> = {};
  const tag = (k: string) => ((hits[k] = (hits[k] ?? 0) + 1), `[REDACTED:${k}]`);

  // Thai / full-width digits → ASCII, invisible separators (soft hyphen, zero-width) out, NBSP → space: the rules see plain digits
  let text = input.replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0xe50)).replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10))
    .replace(/[\u00ad\u200b\u2060\ufeff]/g, '').replace(/\u00a0/g, ' ');
  text = text.replace(URL_RE, (url) => {
    const tail = url.match(/[.,;:!?)\]]+$/)?.[0] ?? '';
    const u = url.slice(0, url.length - tail.length);
    const [, base, path = ''] = u.match(/^(https?:\/\/[^/?#]+)([^?#]*)/i)!;
    if (TOKEN_PATH.test(path)) return `${base}/${tag('link')}${tail}`;
    return u.length > base.length + path.length ? `${base}${path}${tag('query')}${tail}` : url;
  });
  text = text.replace(CARD, (m) => (luhn(digits(m)) ? tag('card') : m));
  text = text.replace(THAIID, (m) => (thaiid(digits(m)) ? tag('thaiid') : m));
  text = text.replace(BANK_SHAPE, () => tag('bank'));
  text = text.replace(BANK_KW, (_, kw: string) => kw + tag('bank'));
  text = text.replace(PASSPORT, (_, kw: string) => kw + tag('passport'));
  text = text.replace(CVV, (_, kw: string) => kw + tag('cvv'));
  text = text.replace(PASSWORD, (_, kw: string, win: string) => kw + win.replace(PASSWORD_TOKEN, () => tag('password')));

  // OTP: first candidate after the keyword, else the nearest one before it ("484623 คือรหัสยืนยัน"), else a farther one after
  const spans: [number, number][] = [];
  const candidates = (from: number, to: number) =>
    [...text.slice(from, to).matchAll(OTP_NUM)]
      .map((m) => [from + m.index!, from + m.index! + m[0].length] as [number, number])
      .filter(([s, e]) => !NOT_OTP_BEFORE.test(text.slice(Math.max(0, s - 16), s)) && !NOT_OTP_AFTER.test(text.slice(e, e + 8)));
  for (const k of text.matchAll(OTP_KW)) {
    const end = k.index! + k[0].length;
    const pick = candidates(end, end + OTP_WINDOW)[0] ?? candidates(Math.max(0, k.index! - OTP_WINDOW), k.index!).at(-1)
      ?? candidates(end, end + OTP_FAR)[0];
    if (pick && !spans.some(([s]) => s === pick[0])) spans.push(pick);
  }
  for (const [s, e] of spans.sort((a, b) => b[0] - a[0])) text = text.slice(0, s) + tag('otp') + text.slice(e);
  return { text, hits };
}

// Key shapes too short or too regular for the import rules: mixed case + digit 20+, 24+ alnum with 4+ digits, hex 32+.
const OFFSITE = /\b(?:(?=[\w-]*\d)(?=[\w-]*[a-z])(?=[\w-]*[A-Z])[\w-]{20,}|(?=(?:[a-zA-Z]*\d){4})[a-zA-Z\d]{24,}|[\da-fA-F]{32,})\b/g;

/** Text that leaves the machine (DeepSeek dream, ลุงจืด 2026-10-10: "api key หรืออะไรที่ผมจะเสียเงิน ห้ามส่งไป"): both passes
 *  above, then every remaining key-shaped token. Over-masks on purpose (full commit hashes, long mixed-case ids). */
export const redactOffsite = (s: string) => redact(redactPersonal(s).text).text.replace(OFFSITE, '[REDACTED:offsite]');
