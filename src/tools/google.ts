// Google, READ-ONLY and Claude-only (ลุงจืด 2026-10-03): Gmail threads (starred + important + sent, minus promotions/social and
// OTP/reset subjects), Google Docs (markdown export) and Google Sheets (title + tabs + header row; full values only for the
// ids in sheets-allow.txt). Scopes gmail.readonly + drive.readonly only; every data call is one GET through api() to an
// allowlisted googleapis host; the only POSTs are oauth2.googleapis.com/token and /revoke.
// sync() exports into <archive>/gmail/<yyyy>/<threadId>.json, docs/<fileId>.json, sheets/<fileId>.json (append-only, a rewrite
// keeps a .bak); parse() turns each into one kind 'doc' session (searchable, never dreamed; guard.ts PRIVATE_TOOLS hides it from
// every non-Claude app). Credentials stay in %USERPROFILE%\.memory-hub\google\: client_secret*.json (ลุงจืด's, read only),
// token.dpapi (refresh token, Windows DPAPI CurrentUser), sheets-allow.txt. Access tokens live in memory; no token or body is logged.
// ToolModule.sync is synchronous and fetch is not, so sync() runs this file as a child process (import.meta.main).
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Msg, Role } from '../claude.ts';
import { syncFile, type Parsed, type SyncResult } from '../importer.ts';

export const tool = 'google';
export const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive.readonly'];
const [GMAIL_SCOPE, DRIVE_SCOPE] = SCOPES;
const HOSTS = new Set(['gmail.googleapis.com', 'www.googleapis.com', 'sheets.googleapis.com']);
const GAP: Record<string, number> = { 'gmail.googleapis.com': 500, 'sheets.googleapis.com': 1000 }; // ≈2 req/s; Sheets 60 reads/min/user
const OAUTH = 'https://oauth2.googleapis.com', FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me', DRIVE = 'https://www.googleapis.com/drive/v3', SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DOC = 'application/vnd.google-apps.document', SHEET = 'application/vnd.google-apps.spreadsheet';
export const GMAIL_Q = '(is:starred OR is:important OR in:sent) -category:promotions -category:social -label:no-memory '
  + '-subject:(OTP OR "verification code" OR "รหัส OTP" OR "reset your password" OR "รีเซ็ตรหัสผ่าน" OR "sign-in code" OR "login code" '
  + 'OR "security code" OR "confirmation code" OR "access code" OR "รหัสยืนยัน" OR "รหัสเข้าสู่ระบบ")';
// the query's subject filter, enforced again here (+ what a Gmail query can't say: "482913 is your Facebook code")
const OTP_SUBJECT = /\bOTP\b|(?:verification|security|sign-?in|log-?in|confirmation|access|auth\w*) code|is your [\w-]+ code|your [\w-]+ code is|reset your password|รีเซ็ตรหัสผ่าน|รหัส(?:ยืนยัน|เข้าสู่ระบบ|เข้าใช้)/i;
const SKIP_LABELS = new Set(['SPAM', 'TRASH', 'DRAFT', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL']);
const MAX_THREADS = 1500, MAX_ROWS = 2000, MAX_MAIL = 20_000, MAX_DOC = 200_000;
const HOUR = 3_600_000, DAY = 24 * HOUR;

class Stop extends Error {} // rate limit / offline / refused: end this run, keep what is written, retry next hour
class Skip extends Stop {}  // not set up / logged out: nothing was read
type Ctx = { fake: Record<string, unknown> | null; log: string; slow: number; token: string; last: Record<string, number>; calls: number };

const json = (t: string) => { try { return JSON.parse(t); } catch { return null; } };
const readJson = (f: string) => (existsSync(f) ? json(readFileSync(f, 'utf8')) : null);
const dir = () => process.env.MEMHUB_GOOGLE_DIR ?? join(homedir(), '.memory-hub', 'google');
const tokenPath = () => join(dir(), 'token.dpapi');
const short = (s: string) => s.split('/').at(-1)!;
const iso = (t: unknown) => (t !== undefined && t !== null && !Number.isNaN(new Date(t as string).getTime()) ? new Date(t as string).toISOString() : null);

function ctx(): Ctx {
  const fake = process.env.MEMHUB_GOOGLE_FAKE; // tests: { "<url without https:// (longest prefix wins)>": response } instead of the network
  return { fake: fake ? JSON.parse(readFileSync(fake, 'utf8')) : null, log: `${fake}.log`, slow: fake ? 0 : 1, token: '', last: {}, calls: 0 };
}

/**
 * The only door to the network. Fake mode logs method + URL (+ form field NAMES) to <fake>.log, never values or headers.
 * Fake values: a string = 200 text, { $status, $body } = an error, an array = one entry per call (the last one repeats).
 */
async function http(c: Ctx, method: 'GET' | 'POST', url: string, headers: Record<string, string> = {}, body?: string) {
  if (method !== 'GET' && !url.startsWith(`${OAUTH}/`)) throw new Error(`google: refused ${method} ${new URL(url).host}`);
  c.calls++;
  if (c.fake) {
    appendFileSync(c.log, `${method} ${url}${body ? ` ${[...new URLSearchParams(body).keys()].join(',')}` : ''}\n`);
    const u = url.replace(/^https:\/\//, '');
    const key = Object.keys(c.fake).filter((k) => u.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    let v: any = key === undefined ? { $status: 404 } : c.fake[key];
    if (Array.isArray(v)) v = v.length > 1 ? v.shift() : v[0];
    if (v?.$status) return { status: v.$status as number, body: JSON.stringify(v.$body ?? {}) };
    return { status: 200, body: typeof v === 'string' ? v : JSON.stringify(v) };
  }
  const r = await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(120_000) });
  return { status: r.status, body: await r.text() };
}

/** Every data read: GET, https, allowlisted host, bearer token. Rate limits / 5xx back off 1-2-4-8 s (Google's advice), then Stop.
 *  null = this item is not readable (404 gone, 403 no access / export too large): skip it. */
async function api(c: Ctx, url: string, text = false): Promise<any> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !HOSTS.has(u.host)) throw new Error(`google: refused host ${u.host}`);
  for (let i = 0; ; i++) {
    const wait = (c.last[u.host] ?? 0) + (GAP[u.host] ?? 0) * c.slow - Date.now();
    if (wait > 0) await sleep(wait);
    c.last[u.host] = Date.now();
    const r = await http(c, 'GET', url, { authorization: `Bearer ${c.token}` });
    if (r.status === 200) return text ? r.body : json(r.body);
    const reason = String(json(r.body)?.error?.errors?.[0]?.reason ?? '');
    const busy = r.status === 429 || r.status >= 500 || (r.status === 403 && /rateLimitExceeded/i.test(reason));
    if (busy && i < 4) { await sleep(1000 * 2 ** i * c.slow); continue; }
    if (busy || r.status === 401) throw new Stop(`HTTP ${r.status}${reason ? ` ${reason}` : ''} after ${i + 1} tries`);
    return null;
  }
}
/** A list call must succeed: a null page would look like "nothing there" and mark the run complete. */
const must = async (c: Ctx, url: string) => (await api(c, url)) ?? Promise.reject(new Stop(`list refused: ${new URL(url).pathname}`));

// ---------------- auth ----------------

/** The Desktop-app OAuth client ลุงจืด downloaded (exactly one client_secret*.json); read in place, never copied. */
function client(): { client_id: string; client_secret: string } | null {
  const files = existsSync(dir()) ? readdirSync(dir()).filter((f) => /^client_secret.*\.json$/i.test(f)) : [];
  const o = files.length === 1 ? readJson(join(dir(), files[0]))?.installed : null;
  return typeof o?.client_id === 'string' && typeof o?.client_secret === 'string' ? { client_id: o.client_id, client_secret: o.client_secret } : null;
}

/** Windows DPAPI (CurrentUser) through powershell; base64 both ways over stdin/stdout (never argv, no codepage issues). */
function dpapi(op: 'Protect' | 'Unprotect', b64: string): string {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String(`
    + `[Security.Cryptography.ProtectedData]::${op}([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()), $null, 'CurrentUser'))`],
    { input: b64, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (r.status !== 0 || !r.stdout?.trim()) throw new Stop(`DPAPI ${op} failed (another Windows user, or powershell missing)`);
  return r.stdout.trim();
}
type Token = { refresh_token: string; scope: string };
const loadToken = (): Token | null => (existsSync(tokenPath())
  ? json(Buffer.from(dpapi('Unprotect', readFileSync(tokenPath(), 'utf8').trim()), 'base64').toString('utf8')) : null);

/** Granted scopes → the ones to use. Anything beyond SCOPES (gmail.modify, openid, …) = refuse: store and read nothing. */
export function checkScopes(scope: unknown): string[] {
  const got = String(scope ?? '').split(/\s+/).filter(Boolean);
  const extra = got.filter((s) => !SCOPES.includes(s));
  if (extra.length) throw new Stop(`refused: extra scope(s) granted (${extra.map(short).join(', ')}); memory-hub takes only ${SCOPES.map(short).join(' + ')}`);
  return got;
}

/** Refresh → in-memory access token; returns the granted scopes (checked again on every refresh). */
async function access(c: Ctx): Promise<string[]> {
  const sec = client();
  if (!sec) throw new Skip(`no client_secret*.json in ${dir()} (setup: docs/google.md)`);
  const tok = loadToken();
  if (!tok) throw new Skip('not logged in: node src/cli.ts google login');
  const r = await http(c, 'POST', `${OAUTH}/token`, FORM, new URLSearchParams({ ...sec, refresh_token: tok.refresh_token, grant_type: 'refresh_token' }).toString());
  const j = json(r.body);
  if (j?.error === 'invalid_grant') throw new Skip('token expired or revoked: login again (node src/cli.ts google login)');
  if (r.status !== 200 || typeof j?.access_token !== 'string') throw new Stop(`token refresh failed: HTTP ${r.status} ${j?.error ?? ''}`.trim());
  const scopes = checkScopes(j.scope ?? tok.scope);
  c.token = j.access_token;
  return scopes;
}

function browse(url: string) {
  console.log(`opening the browser (if it does not open, paste this URL):\n${url}`);
  spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

/** One-time consent: loopback 127.0.0.1 + PKCE S256 + state → refresh token, scope-checked, DPAPI-encrypted into token.dpapi. */
export async function login(open: (url: string) => unknown = browse): Promise<string[]> {
  const sec = client();
  if (!sec) throw new Error(`put the Desktop-app client_secret*.json (exactly one) into ${dir()} first (docs/google.md)`);
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(16).toString('base64url');
  const server = createServer();
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('login timed out (5 min)')), 300_000);
      server.on('request', (req, res) => {
        const q = new URL(req.url ?? '/', redirect).searchParams;
        if (!q.has('state')) { res.writeHead(404); res.end(); return; } // favicon & co
        const code = q.get('state') === state ? q.get('code') : null;
        res.writeHead(code ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(code ? 'memory-hub: เสร็จแล้ว ปิดแท็บได้' : 'memory-hub: login ไม่สำเร็จ ลองใหม่ใน terminal');
        clearTimeout(timer);
        if (code) resolve(code); else reject(new Error(`login refused: ${q.get('error') ?? 'state mismatch'}`));
      });
      open(`https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: sec.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '), state, access_type: 'offline',
        prompt: 'consent', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`);
    });
    const r = await http(ctx(), 'POST', `${OAUTH}/token`, FORM, new URLSearchParams({
      ...sec, code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' }).toString());
    const j = json(r.body);
    if (r.status !== 200 || typeof j?.refresh_token !== 'string') throw new Error(`token exchange failed: HTTP ${r.status} ${j?.error ?? 'no refresh_token'}`);
    const scopes = checkScopes(j.scope); // before anything is stored
    mkdirSync(dir(), { recursive: true });
    writeFileSync(tokenPath(), dpapi('Protect', Buffer.from(JSON.stringify({ refresh_token: j.refresh_token, scope: scopes.join(' ') })).toString('base64')) + '\n');
    return scopes.map(short);
  } finally {
    server.close();
  }
}

/** Revoke at Google (POST /revoke) and delete token.dpapi. */
export async function revoke(): Promise<string> {
  const tok = loadToken();
  if (!tok) return 'no token stored';
  const r = await http(ctx(), 'POST', `${OAUTH}/revoke`, FORM, new URLSearchParams({ token: tok.refresh_token }).toString());
  rmSync(tokenPath(), { force: true });
  return r.status === 200 ? 'revoked at Google, token.dpapi deleted'
    : `Google answered HTTP ${r.status} (already revoked?); token.dpapi deleted. Check https://myaccount.google.com/linkedapps`;
}

/** sheets-allow.txt: one Sheets id or URL per line (# comments) whose full values may be archived. */
function allowList(): Set<string> {
  const f = join(dir(), 'sheets-allow.txt');
  return new Set(existsSync(f) ? readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
    .map((l) => /\/d\/([\w-]+)/.exec(l)?.[1] ?? l) : []);
}

const archived = (archive: string) => { // threadId → archive path
  const d = join(archive, 'gmail');
  return new Map(existsSync(d) ? readdirSync(d, { recursive: true, encoding: 'utf8' }).filter((f) => /^\d{4}[\\/][\w-]+\.json$/.test(f))
    .map((f) => [f.slice(5, -5), join(d, f)] as const) : []);
};

export async function status(archive: string, dry = false): Promise<string[]> {
  const out = [`credentials: ${dir()}`];
  const secrets = existsSync(dir()) ? readdirSync(dir()).filter((f) => /^client_secret.*\.json$/i.test(f)).length : 0;
  out.push(`client_secret: ${client() ? 'ok' : secrets > 1 ? `${secrets} files, keep exactly one` : 'missing or not a Desktop-app client (docs/google.md)'}`);
  let tok: Token | null = null;
  try { tok = loadToken(); out.push(tok ? `token: stored (DPAPI), scopes ${tok.scope.split(' ').map(short).join(' + ')}` : 'token: none (node src/cli.ts google login)'); }
  catch (e) { out.push(`token: ${(e as Error).message}`); }
  out.push(`sheets-allow.txt: ${allowList().size} sheet(s)`);
  const count = (d: string) => (existsSync(join(archive, d)) ? readdirSync(join(archive, d)).filter((f) => f.endsWith('.json')).length : 0);
  const st = readJson(join(archive, '_state.json')) ?? {};
  out.push(`archive ${archive}: ${archived(archive).size} threads · ${count('docs')} docs · ${count('sheets')} sheets`
    + ` · gmail ok ${st.gmail?.lastOk ?? '-'} (full ${st.gmail?.fullAt ?? '-'}) · drive ok ${st.drive?.lastOk ?? '-'}`);
  if (dry && tok) try { // the day-8 check: a refresh that still works = the token outlived Testing's 7 days
    const c = ctx();
    const scopes = await access(c);
    if (scopes.includes(GMAIL_SCOPE)) out.push(`gmail: ≈${(await must(c, `${GMAIL}/messages?${new URLSearchParams({ q: GMAIL_Q, maxResults: '1' })}`)).resultSizeEstimate ?? 0} messages match (resultSizeEstimate)`);
    if (scopes.includes(DRIVE_SCOPE)) {
      const files = await driveList(c, '');
      const keep = files.filter((f) => wanted(f, Date.now()));
      out.push(`drive: ${keep.filter((f) => f.mimeType === DOC).length} docs + ${keep.filter((f) => f.mimeType === SHEET).length} sheets in scope (of ${files.length})`);
    }
  } catch (e) { out.push(`live check: ${(e as Error).message}`); }
  return out;
}

// ---------------- sync ----------------

async function driveList(c: Ctx, since: string): Promise<any[]> {
  const q = `(mimeType='${DOC}' or mimeType='${SHEET}') and trashed=false${since ? ` and modifiedTime > '${since}'` : ''}`;
  const out: any[] = [];
  for (let page = ''; ;) {
    const r = await must(c, `${DRIVE}/files?${new URLSearchParams({ q, pageSize: '1000', ...(page && { pageToken: page }),
      fields: 'nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,ownedByMe,viewedByMeTime)' })}`);
    out.push(...(r.files ?? []).filter((f: any) => typeof f?.id === 'string' && /^[\w-]+$/.test(f.id)));
    if (!(page = r.nextPageToken)) return out;
  }
}
// his own files + shared ones he opened in the last 12 months; a name containing "no-memory" opts a file out
const wanted = (f: any, now: number) => (f.ownedByMe === true || Date.parse(f.viewedByMeTime) > now - 365 * DAY) && !/no-memory/i.test(f.name ?? '');

/** Archived message: as the API returned it minus what churns (.bak) or is not text: historyId, UNREAD, attachment bodies/ids. */
const slim = (p: any): any => ({ ...p, body: p.body && { size: p.body.size, ...(!p.filename && /^text\/(plain|html)/i.test(p.mimeType ?? '') && p.body.data && { data: p.body.data }) },
  ...(p.parts && { parts: p.parts.map(slim) }) });

export async function run(archive: string, opt: { full?: boolean } = {}): Promise<Record<string, number | string>> {
  const c = ctx(), start = Date.now();
  const stats: Record<string, number | string> = {};
  const inc = (k: string, n = 1) => { if (n) stats[k] = (Number(stats[k]) || 0) + n; };
  const tmp = mkdtempSync(join(tmpdir(), 'memhub-google-'));
  const put = (dst: string, data: unknown, keepOld = true): SyncResult => { // identical content is left alone (mtime too)
    const text = JSON.stringify(data, null, 2) + '\n';
    if (existsSync(dst) && readFileSync(dst, 'utf8') === text) return 'unchanged';
    writeFileSync(join(tmp, 'doc.json'), text);
    return syncFile(join(tmp, 'doc.json'), dst, keepOld);
  };
  const statePath = join(archive, '_state.json');
  const state = readJson(statePath) ?? {}; // lost/corrupt state = a full resync (archived threads are not fetched again)
  try {
    const scopes = await access(c);
    const missing = SCOPES.filter((s) => !scopes.includes(s)).map(short);
    if (missing.length) stats.missing = missing.join(' + '); // unticked on the consent page: sync the rest

    if (scopes.includes(GMAIL_SCOPE)) {
      const g = (state.gmail ??= {});
      const noMemory = new Set(((await must(c, `${GMAIL}/labels`)).labels ?? []).filter((l: any) => /^no-memory$/i.test(l?.name)).map((l: any) => l.id));
      const threads = async (q: string) => {
        const ids: string[] = [];
        for (let page = ''; ;) {
          const r = await must(c, `${GMAIL}/messages?${new URLSearchParams({ q, maxResults: '500', ...(page && { pageToken: page }) })}`);
          for (const m of r.messages ?? []) if (typeof m?.threadId === 'string' && /^[\w-]+$/.test(m.threadId)) ids.push(m.threadId);
          if (!(page = r.nextPageToken)) return ids;
        }
      };
      const have = archived(archive);
      // hourly: threads with mail since the last good run (−2 days: the date operator's time zone); weekly / first run / backfill:
      // every matching thread not archived yet (old mail starred later). ponytail: lists all ids each backfill run (500/call, cheap)
      const full = opt.full || !g.fullAt || start - Date.parse(g.fullAt) > 7 * DAY;
      const recent = g.lastOk ? await threads(`${GMAIL_Q} after:${new Date(Date.parse(g.lastOk) - 2 * DAY).toISOString().slice(0, 10).replaceAll('-', '/')}`) : [];
      const todo = new Set([...recent, ...(full ? (await threads(GMAIL_Q)).filter((id) => !have.has(id)) : [])]);
      let budget = MAX_THREADS, failed = false;
      for (const id of todo) {
        if (budget-- <= 0) { stats.more = todo.size - MAX_THREADS; break; } // next run continues
        try {
          const t = await api(c, `${GMAIL}/threads/${id}?format=full`);
          if (!Array.isArray(t?.messages)) { inc('gone'); continue; } // deleted between list and get
          if (t.messages.some((m: any) => (m.labelIds ?? []).some((l: string) => noMemory.has(l)))) { inc('nomemory'); continue; }
          const msgs = t.messages.filter((m: any) => !(m.labelIds ?? []).some((l: string) => SKIP_LABELS.has(l)) && !OTP_SUBJECT.test(words(header(m.payload, 'subject'))))
            .map((m: any) => ({ id: m.id, threadId: m.threadId, labelIds: (m.labelIds ?? []).filter((l: string) => l !== 'UNREAD'), internalDate: m.internalDate, payload: slim(m.payload ?? {}) }));
          if (!msgs.length) { inc('filtered'); continue; }
          const year = String(new Date(Number(msgs[0].internalDate) || 0).getUTCFullYear()).padStart(4, '0');
          inc('threads');
          inc(put(have.get(id) ?? join(archive, 'gmail', year, `${id}.json`), { id, messages: msgs }));
        } catch (e) {
          if (e instanceof Stop) throw e;
          inc('failed'); failed = true;
        }
      }
      if (!failed && !stats.more) { g.lastOk = new Date(start).toISOString(); if (full) g.fullAt = g.lastOk; }
    }

    if (scopes.includes(DRIVE_SCOPE)) {
      const d = (state.drive ??= {});
      const full = opt.full || !d.fullAt || start - Date.parse(d.fullAt) > 7 * DAY; // weekly: shared files opened lately, allowlist changes
      const files = await driveList(c, full || !d.lastOk ? '' : new Date(Date.parse(d.lastOk) - HOUR).toISOString());
      const allow = allowList();
      let failed = false;
      for (const f of files) {
        if (!wanted(f, start)) { inc('ignored'); continue; }
        const isDoc = f.mimeType === DOC, dst = join(archive, isDoc ? 'docs' : 'sheets', `${f.id}.json`), whole = allow.has(f.id);
        const old = readJson(dst);
        if (old?.meta?.modifiedTime === f.modifiedTime && (isDoc || old.full === whole)) { inc('unchanged'); continue; }
        const meta = { id: f.id, name: f.name ?? '', mimeType: f.mimeType, createdTime: f.createdTime ?? null, modifiedTime: f.modifiedTime ?? null, ownedByMe: f.ownedByMe === true };
        try {
          if (isDoc) {
            const markdown = await api(c, `${DRIVE}/files/${f.id}/export?mimeType=text%2Fmarkdown`, true); // ≤ 10 MB, else 403
            if (markdown === null) { inc('skipped'); continue; }
            inc('docs'); inc(put(dst, { meta, markdown }));
          } else {
            const s = await api(c, `${SHEETS}/${f.id}?fields=${encodeURIComponent('properties.title,sheets.properties(title,gridProperties)')}`);
            if (!s) { inc('skipped'); continue; }
            const tabs = (s.sheets ?? []).map((x: any) => x?.properties).filter((p: any) => typeof p?.title === 'string');
            // FORMATTED_VALUE: money stays the text the sheet shows ("1,234.50"), never a JSON float
            const ranges = tabs.map((p: any) => ['ranges', `'${p.title.replaceAll("'", "''")}'!1:${whole ? MAX_ROWS : 1}`]);
            const v = ranges.length ? await api(c, `${SHEETS}/${f.id}/values:batchGet?${new URLSearchParams([...ranges, ['valueRenderOption', 'FORMATTED_VALUE']])}`) : { valueRanges: [] };
            if (!v) { inc('skipped'); continue; }
            inc('sheets');
            inc(put(dst, { meta, full: whole, tabs: tabs.map((p: any, i: number) => ({
              title: p.title, rows: p.gridProperties?.rowCount ?? null, cols: p.gridProperties?.columnCount ?? null, values: v.valueRanges?.[i]?.values ?? [] })) }));
          }
        } catch (e) {
          if (e instanceof Stop) throw e;
          inc('failed'); failed = true;
        }
      }
      if (!failed) { d.lastOk = new Date(start).toISOString(); if (full) d.fullAt = d.lastOk; }
    }
  } catch (e) {
    if (e instanceof Skip) return { skipped: e.message };
    stats.stopped = e instanceof Stop ? e.message : `error: ${(e as Error).message}`;
  } finally {
    if (Object.keys(state).length) put(statePath, state, false);
    rmSync(tmp, { recursive: true, force: true });
  }
  stats.calls = c.calls;
  return stats;
}

/** ToolModule.sync: not set up → skipped without a child; else this file as a child (fetch is async). MEMHUB_GOOGLE_FULL=1 = full pass. */
export function sync(archiveDir: string): Record<string, number | string> {
  if (!client()) return { skipped: `no client_secret*.json in ${dir()} (setup: docs/google.md)` };
  if (!existsSync(tokenPath())) return { skipped: 'not logged in: node src/cli.ts google login' };
  const args = [import.meta.filename, 'sync', archiveDir, ...(process.env.MEMHUB_GOOGLE_FULL === '1' ? ['--full'] : [])];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 45 * 60_000, windowsHide: true });
  const out = json((r.stdout ?? '').trim().split('\n').at(-1) ?? '');
  if (out && typeof out === 'object') return out;
  throw new Error(`google sync child exited ${r.status ?? r.error?.message}`); // stderr is not echoed: it could quote a response
}

// ---------------- parse ----------------

export const isTranscript = (path: string) => /[\\/](?:gmail[\\/]\d{4}|docs|sheets)[\\/][\w-]+\.json$/.test(path); // not _state/.bak

const header = (p: any, name: string): string => String((p?.headers ?? []).find((h: any) => String(h?.name).toLowerCase() === name)?.value ?? '');
const decode = (b: Buffer, charset = 'utf-8') => { try { return new TextDecoder(charset).decode(b); } catch { return b.toString('utf8'); } }; // tis-620 / windows-874 ok
/** RFC 2047 encoded words (=?TIS-620?B?…?=), in case a header arrives undecoded. */
const words = (s: string) => s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=(?:\s+(?==\?))?/gi, (_m, cs: string, enc: string, t: string) => decode(enc.toUpperCase() === 'B'
  ? Buffer.from(t, 'base64') : Buffer.from(t.replace(/_/g, ' ').replace(/=([\da-f]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1'), cs));
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '' };
/** HTML entities → text (text/plain parts too: "&#52;&#56;…" must not hide a code from redactPersonal). */
const entities = (t: string) => t.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  const n = e[0] !== '#' ? NaN : /x/i.test(e[1]) ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return e[0] !== '#' ? ENT[e.toLowerCase()] ?? m : n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
});
const htmlText = (h: string) => entities(h.replace(/<blockquote[\s\S]*$/i, '') // quoted history (Gmail/Outlook put it last)
  .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h\d|table)>/gi, '\n').replace(/<[^>]*>/g, ''))
  .replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
/** Drop quoted history: '>' lines, the "On … wrote:" / "เมื่อ … เขียนว่า:" line before them, Outlook's "Original Message" tail. */
const unquote = (t: string) => t.replace(/\r\n?/g, '\n').split('\n').filter((l) => !/^\s*>/.test(l)).join('\n')
  .replace(/\n-{2,} ?Original Message ?-{2,}[\s\S]*$/i, '')
  .replace(/(?:^|\n)(?:On|เมื่อ) [^\n]*(?:\n[^\n]*)?(?:wrote|เขียนว่า):\s*$/i, '').trim();
const size = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const tidy = (t: string) => t.replace(/\r\n?/g, '\n').replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/g, '[image]')
  .replace(/<?data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+>?/g, '[data-url]').trim(); // Docs markdown inlines images as data URLs
const cap = (t: string, n: number) => (t.length > n ? t.slice(0, n) + ' …[truncated]' : t);

/** Body of one message: text/plain parts first, else HTML → text; attachments as "name size". */
function mailBody(payload: any): { text: string; files: string[] } {
  const plain: string[] = [], html: string[] = [], files: string[] = [];
  const walk = (p: any) => {
    if (p?.filename) files.push(`${p.filename} ${size(Number(p.body?.size) || 0)}`);
    else if (typeof p?.body?.data === 'string' && /^text\/(plain|html)/i.test(p.mimeType ?? '')) {
      const charset = /charset="?([\w.:-]+)/i.exec(header(p, 'content-type'))?.[1];
      (/html/i.test(p.mimeType) ? html : plain).push(decode(Buffer.from(p.body.data, 'base64url'), charset));
    }
    for (const q of p?.parts ?? []) walk(q);
  };
  walk(payload);
  return { text: unquote(plain.length ? entities(plain.join('\n\n')) : html.map(htmlText).join('\n\n')), files };
}

export async function parse(path: string): Promise<Parsed | null> {
  const d = readJson(path), p = path.replace(/\\/g, '/');
  const kind = /\/gmail\/\d{4}\/[^/]+$/.test(p) ? 'gmail' : /\/docs\/[^/]+$/.test(p) ? 'gdoc' : 'gsheet';
  const sessionId = `${kind}:${d?.id ?? d?.meta?.id}`, cwd = `google/${kind === 'gmail' ? 'gmail' : kind === 'gdoc' ? 'docs' : 'sheets'}`;
  const msgs: Msg[] = [];
  const push = (id: string, ts: string | null, role: Role, text: string) => {
    if (ts && text.trim()) msgs.push({ uuid: `google:${kind}:${id}`, parentUuid: msgs.at(-1)?.uuid ?? null, sessionId, ts, cwd, role, text });
  };
  if (kind === 'gmail') {
    if (!Array.isArray(d?.messages)) return null;
    const ms = d.messages.filter((m: any) => typeof m?.id === 'string' && iso(Number(m.internalDate)))
      .sort((a: any, b: any) => Number(a.internalDate) - Number(b.internalDate) || a.id.localeCompare(b.id));
    for (const m of ms) {
      const h = (n: string) => words(header(m.payload, n)).trim();
      const { text, files } = mailBody(m.payload);
      const to = [h('to'), h('cc')].filter(Boolean).join(', ');
      push(m.id, iso(Number(m.internalDate)), (m.labelIds ?? []).includes('SENT') ? 'user' : 'assistant', cap(
        `[mail] ${h('subject') || '(no subject)'}\n${h('from')}${to ? ` → ${to}` : ''}\n${text}${files.length ? `\n[แนบ: ${files.join(', ')}]` : ''}`, MAX_MAIL));
    }
  } else if (typeof d?.meta?.id === 'string') {
    const ts = iso(d.meta.modifiedTime) ?? iso(d.meta.createdTime), owner = d.meta.ownedByMe ? '' : ' (shared with me)';
    if (kind === 'gdoc' && typeof d.markdown === 'string') push(d.meta.id, ts, 'note', cap(`[doc] ${d.meta.name}${owner}\n${tidy(d.markdown)}`, MAX_DOC));
    if (kind === 'gsheet' && Array.isArray(d.tabs)) {
      const csv = (row: unknown[]) => row.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v))).join(',');
      const tabs = d.tabs.map((t: any) => {
        const head = `แท็บ ${t.title} (${t.rows ?? '?'}×${t.cols ?? '?'})`, rows: unknown[][] = Array.isArray(t.values) ? t.values : [];
        return d.full ? [head, ...rows.map(csv)].join('\n') : `${head}: ${(rows[0] ?? []).join(' | ')}`;
      });
      push(d.meta.id, ts, 'note', cap(`[sheet] ${d.meta.name}${owner}${d.full ? '' : ' · header row only'}\n${tabs.join(d.full ? '\n\n' : '\n')}`, MAX_DOC));
    }
  }
  return msgs.length ? { sessionId, cwd, kind: 'doc', msgs } : null;
}

if (import.meta.main && process.argv[2] === 'sync') console.log(JSON.stringify(await run(process.argv[3], { full: process.argv.includes('--full') })));
