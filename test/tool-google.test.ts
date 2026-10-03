// Pure: recorded Google API responses (MEMHUB_GOOGLE_FAKE) + a temp credentials dir → login() / sync() → parse(). No network
// (the only real socket is the loopback login redirect), no Postgres. The token is really DPAPI-encrypted: Windows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkScopes, GMAIL_Q, isTranscript, login, parse, SCOPES, status, sync } from '../src/tools/google.ts';

const root = mkdtempSync(join(tmpdir(), 'memhub-google-test-'));
const cred = join(root, 'cred'), archive = join(root, 'archive'), fakeFile = join(root, 'fake.json'), callLog = `${fakeFile}.log`;
mkdirSync(cred);
process.env.MEMHUB_GOOGLE_DIR = cred;
process.env.MEMHUB_GOOGLE_FAKE = fakeFile;
const dpapi = { skip: process.platform !== 'win32' && 'DPAPI is Windows-only' };
test.after(() => rmSync(root, { recursive: true, force: true }));

const DOC = 'application/vnd.google-apps.document', SHEET = 'application/vnd.google-apps.spreadsheet';
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const tis620 = (s: string) => Buffer.from([...s].map((ch) => { const c = ch.codePointAt(0)!; return c >= 0x0e01 && c <= 0x0e5b ? c - 0x0d60 : c; }));
const H = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));
const text = (mimeType: string, data: string | Buffer, charset = 'UTF-8') =>
  ({ mimeType, headers: H({ 'Content-Type': `${mimeType}; charset="${charset}"` }), body: { size: Buffer.from(data).length, data: b64(data) } });
const msg = (id: string, threadId: string, date: string, labelIds: string[], headers: Record<string, string>, payload: object) =>
  ({ id, threadId, historyId: '987654', internalDate: String(Date.parse(date)), labelIds, snippet: 'snip', sizeEstimate: 1234,
    payload: { ...payload, headers: [...H(headers), ...((payload as any).headers ?? [])] } });
const ME = 'ลุงจืด <me@example.com>', BOB = 'Bob <bob@example.com>';

const t1 = { id: 't1', historyId: '987654', messages: [
  msg('m1', 't1', '2026-09-01T03:00:00Z', ['INBOX', 'IMPORTANT', 'UNREAD'], { From: BOB, To: ME, Subject: 'ใบเสนอราคา' }, { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'multipart/alternative', parts: [text('text/plain', 'สวัสดีครับ ลุงจืด\r\nใบเสนอราคาแนบมาครับ\r\n'), text('text/html', '<p>html copy</p>')] },
    { mimeType: 'application/pdf', filename: 'quote.pdf', headers: H({ 'Content-Type': 'application/pdf' }), body: { attachmentId: 'ANGjdJ_volatile_id', size: 125_952 } },
  ] }),
  msg('m2', 't1', '2026-09-01T04:00:00Z', ['SENT'], { From: ME, To: BOB, Subject: 'Re: ใบเสนอราคา' },
    text('text/plain', 'ได้ครับ ขอบคุณ\n\nเมื่อ วันจันทร์ที่ 1 ก.ย. 2569 เวลา 10:00 Bob <bob@example.com>\nเขียนว่า:\n> สวัสดีครับ ลุงจืด\n> ใบเสนอราคาแนบมาครับ\n')),
  msg('m3', 't1', '2026-09-01T05:00:00Z', ['INBOX'], { From: 'bank <no-reply@bank.example>', To: ME, Subject: 'Your OTP code' }, text('text/plain', 'OTP 123456')),
] };
const t2 = { id: 't2', messages: [msg('m21', 't2', '2025-03-10T02:00:00Z', ['INBOX', 'STARRED'],
  { From: 'shop@example.co.th', To: 'me@example.com', Subject: `=?TIS-620?B?${tis620('ใบแจ้งหนี้').toString('base64')}?=` },
  text('text/plain', tis620('เรียน ลุงจืด\nยอดชำระ 1,234.50 บาท'), 'TIS-620'))] };
const t3 = { id: 't3', messages: [msg('m31', 't3', '2026-09-05T01:00:00Z', ['INBOX', 'STARRED'], { From: 'Boss <boss@example.com>', To: 'me@example.com', Subject: 'นัดประชุม' },
  text('text/html', '<html><head><style>p{color:red}</style></head><body><p>นัดประชุม&nbsp;พรุ่งนี้ &amp; สรุปงาน&#x2705;</p><div>บรรทัด2<br>บรรทัด3</div><blockquote>old quoted text</blockquote></body></html>'))] };
const t4 = { id: 't4', messages: [msg('m41', 't4', '2026-09-06T01:00:00Z', ['INBOX', 'IMPORTANT'], { From: 'bank', To: 'me', Subject: 'รหัส OTP ของคุณ' }, text('text/plain', '654321'))] };
const t5 = { id: 't5', messages: [msg('m51', 't5', '2026-09-07T01:00:00Z', ['INBOX', 'STARRED', 'Label_9'], { From: 'x', To: 'me', Subject: 'private' }, text('text/plain', 'secret stuff'))] };

const G = 'gmail.googleapis.com/gmail/v1/users/me', D = 'www.googleapis.com/drive/v3', S = 'sheets.googleapis.com/v4/spreadsheets';
const list = (q: string) => `${G}/messages?${new URLSearchParams({ q, maxResults: '500' })}`;
const files = (q: string) => `${D}/files?${new URLSearchParams({ q })}&pageSize=1000`;
const DRIVE_Q = `(mimeType='${DOC}' or mimeType='${SHEET}') and trashed=false`;
const TOKEN = { access_token: 'ya29.fake-access', expires_in: 3599, refresh_token: '1//fake-refresh', scope: SCOPES.join(' '), token_type: 'Bearer' }; // pragma: allowlist secret
const rate = (code: number, reason = 'rateLimitExceeded') => ({ $status: code, $body: { error: { code, errors: [{ reason }] } } });
const recent = new Date(Date.now() - 10 * 86_400_000).toISOString();
const world: Record<string, unknown> = {
  'oauth2.googleapis.com/token': TOKEN,
  [`${G}/labels`]: { labels: [{ id: 'INBOX', name: 'INBOX' }, { id: 'Label_9', name: 'no-memory' }] },
  [list(GMAIL_Q)]: { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't1' }, { id: 'm41', threadId: 't4' }], nextPageToken: 'p2', resultSizeEstimate: 7 },
  [`${list(GMAIL_Q)}&pageToken=p2`]: { messages: [{ id: 'm21', threadId: 't2' }, { id: 'm31', threadId: 't3' }, { id: 'm51', threadId: 't5' }, { id: 'm61', threadId: 't6' }] },
  [`${G}/threads/t1?`]: t1, [`${G}/threads/t2?`]: t2, [`${G}/threads/t3?`]: t3, [`${G}/threads/t4?`]: t4, [`${G}/threads/t5?`]: t5, // t6: 404, deleted after listing
  [files(DRIVE_Q)]: { files: [
    { id: 'doc1', name: 'แผนงาน 2026', mimeType: DOC, createdTime: '2026-01-02T00:00:00.000Z', modifiedTime: '2026-09-20T03:00:00.000Z', ownedByMe: true, viewedByMeTime: recent },
    { id: 'doc2', name: 'shared long ago', mimeType: DOC, modifiedTime: '2026-09-01T00:00:00.000Z', ownedByMe: false, viewedByMeTime: '2024-01-01T00:00:00.000Z' },
    { id: 'doc3', name: 'diary no-memory', mimeType: DOC, modifiedTime: '2026-09-01T00:00:00.000Z', ownedByMe: true },
    { id: 'doc4', name: 'huge shared', mimeType: DOC, modifiedTime: '2026-09-01T00:00:00.000Z', ownedByMe: false, viewedByMeTime: recent },
    { id: 'sA', name: 'เงินเดือน', mimeType: SHEET, modifiedTime: '2026-09-10T00:00:00.000Z', ownedByMe: true },
    { id: 'sB', name: 'budget', mimeType: SHEET, modifiedTime: '2026-09-11T00:00:00.000Z', ownedByMe: true },
    { id: '../evil', name: 'path', mimeType: DOC, modifiedTime: '2026-09-11T00:00:00.000Z', ownedByMe: true },
  ] },
  [`${D}/files/doc1/export`]: [{ $status: 429 }, '# แผนงาน\r\n\r\nเนื้อหา ![][image1]\r\n\r\n[image1]: <data:image/png;base64,iVBORw0KGgo=>\r\n'],
  [`${D}/files/doc4/export`]: rate(403, 'exportSizeLimitExceeded'),
  [`${S}/sA?`]: { sheets: [{ properties: { title: '2026', gridProperties: { rowCount: 1000, columnCount: 26 } } }, { properties: { title: "ลุง's", gridProperties: { rowCount: 50, columnCount: 5 } } }] },
  [`${S}/sA/values:batchGet`]: [rate(403), { valueRanges: [{ values: [['ชื่อ', 'เงินเดือน']] }, { values: [['a', 'b']] }] }],
  [`${S}/sB?`]: { sheets: [{ properties: { title: 'Q1', gridProperties: { rowCount: 3, columnCount: 2 } } }] },
  [`${S}/sB/values:batchGet`]: { valueRanges: [{ values: [['item', 'amount'], ['ค่าไฟ', '1,234.50'], ['note, "x"', '0.10']] }] },
};
const save = () => writeFileSync(fakeFile, JSON.stringify(world));
const calls = () => (existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean) : []);
const fresh = () => { if (existsSync(callLog)) unlinkSync(callLog); };
const archived = (): string[] => (existsSync(archive) ? readdirSync(archive, { recursive: true, encoding: 'utf8' }).map((f) => f.replace(/\\/g, '/')).sort() : []);
const read = (f: string) => JSON.parse(readFileSync(join(archive, f), 'utf8'));
const secret = join(cred, 'client_secret_123-abc.apps.googleusercontent.com.json');

test('not set up / logged out: skipped (not failed), no child, no network', () => {
  save();
  assert.match(String(sync(archive).skipped), /no client_secret/);
  writeFileSync(secret, JSON.stringify({ installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'fake-client-secret', redirect_uris: ['http://localhost'] } }));
  assert.match(String(sync(archive).skipped), /not logged in: node src\/cli\.ts google login/);
  assert.deepEqual(calls(), []);
  assert.ok(!existsSync(archive));
});

test('checkScopes: exactly the two read-only scopes; any extra scope is refused; a missing one is allowed', () => {
  assert.deepEqual(checkScopes(SCOPES.join(' ')), SCOPES);
  assert.deepEqual(checkScopes(SCOPES[1]), [SCOPES[1]]);
  assert.throws(() => checkScopes(`${SCOPES.join(' ')} https://www.googleapis.com/auth/gmail.modify`), /refused: extra scope\(s\) granted \(gmail\.modify\)/);
  assert.throws(() => checkScopes(`openid ${SCOPES[0]}`), /refused/);
});

/** Plays the browser: checks the consent URL, then hits the loopback redirect like Google would. */
const browser = (seen: URL[], state?: string) => (url: string) => {
  const u = new URL(url);
  seen.push(u);
  const back = new URL(u.searchParams.get('redirect_uri')!);
  back.search = new URLSearchParams({ code: 'fake-code', state: state ?? u.searchParams.get('state')!, scope: SCOPES.join(' ') }).toString();
  fetch(back).catch(() => {});
};

test('login: loopback + PKCE S256 + state; extra scope or wrong state stores nothing; ok → DPAPI token', dpapi, async () => {
  const token = join(cred, 'token.dpapi');
  world['oauth2.googleapis.com/token'] = { ...TOKEN, scope: `${SCOPES.join(' ')} https://www.googleapis.com/auth/gmail.modify` };
  save(); fresh();
  const seen: URL[] = [];
  await assert.rejects(login(browser(seen)), /refused: extra scope/);
  assert.ok(!existsSync(token), 'extra scope: nothing stored');
  await assert.rejects(login(browser(seen, 'forged-state')), /state mismatch/);
  assert.equal(calls().length, 1, 'a forged state never reaches the token endpoint');

  world['oauth2.googleapis.com/token'] = TOKEN;
  save(); fresh();
  assert.deepEqual(await login(browser(seen)), ['gmail.readonly', 'drive.readonly']);
  const u = seen.at(-1)!, p = Object.fromEntries(u.searchParams);
  assert.equal(`${u.origin}${u.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.match(p.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual([p.scope, p.code_challenge_method, p.access_type, p.response_type], [SCOPES.join(' '), 'S256', 'offline', 'code']);
  assert.match(p.code_challenge, /^[\w-]{43}$/); assert.match(p.state, /^[\w-]{22}$/);
  assert.notEqual(seen[0].searchParams.get('state'), p.state, 'fresh state per login');
  assert.deepEqual(calls(), ['POST https://oauth2.googleapis.com/token client_id,client_secret,code,code_verifier,redirect_uri,grant_type']);
  const stored = readFileSync(token, 'utf8');
  assert.ok(!stored.includes('fake-refresh') && !Buffer.from(stored, 'base64').toString('latin1').includes('fake-refresh'), 'encrypted at rest');
});

test('sync: Gmail threads (filters, slim archive), Docs markdown, Sheets header-only vs allowlisted; GET-only; backoff', dpapi, () => {
  writeFileSync(join(cred, 'sheets-allow.txt'), '# full values ok\nhttps://docs.google.com/spreadsheets/d/sB/edit#gid=0\n');
  save(); fresh();
  assert.deepEqual(sync(archive), { threads: 3, copied: 6, filtered: 1, nomemory: 1, gone: 1, docs: 1, ignored: 2, skipped: 1, sheets: 2, calls: 19 });
  assert.deepEqual(archived(), ['_state.json', 'docs', 'docs/doc1.json', 'gmail', 'gmail/2025', 'gmail/2025/t2.json', 'gmail/2026', 'gmail/2026/t1.json',
    'gmail/2026/t3.json', 'sheets', 'sheets/sA.json', 'sheets/sB.json']);

  const raw = readFileSync(join(archive, 'gmail/2026/t1.json'), 'utf8'), a1 = JSON.parse(raw);
  assert.deepEqual(a1.messages.map((m: any) => m.id), ['m1', 'm2'], 'OTP message dropped');
  assert.ok(!/historyId|UNREAD|ANGjdJ_volatile_id|sizeEstimate|snippet/.test(raw), 'nothing that churns');
  assert.deepEqual(a1.messages[0].payload.parts[1].body, { size: 125_952 }, 'attachment = metadata only');
  assert.ok(a1.messages[0].payload.parts[0].parts[0].body.data, 'text bodies kept as the API sent them');

  const sA = read('sheets/sA.json'), sB = read('sheets/sB.json');
  assert.equal(sA.full, false);
  assert.deepEqual(sA.tabs.map((t: any) => t.values), [[['ชื่อ', 'เงินเดือน']], [['a', 'b']]]);
  assert.equal(sB.full, true);
  assert.equal(sB.tabs[0].values[1][1], '1,234.50', 'money stays the formatted string');
  assert.deepEqual(Object.keys(read('docs/doc1.json')), ['meta', 'markdown']);
  assert.ok(!('viewedByMeTime' in read('docs/doc1.json').meta), 'viewing a file must not rewrite the archive');

  const log = calls();
  assert.equal(log.length, 19);
  for (const l of log) assert.match(l, /^(GET https:\/\/(gmail|www|sheets)\.googleapis\.com\/\S+|POST https:\/\/oauth2\.googleapis\.com\/token client_id,client_secret,refresh_token,grant_type)$/);
  assert.ok(!/ya29|1\/\/|fake-client-secret/.test(log.join('\n')), 'no secret in the request log');
  assert.equal(log.filter((l) => l.includes('/files/doc1/export')).length, 2, '429 → backoff → retry');
  assert.equal(log.filter((l) => l.includes('/sA/values:batchGet')).length, 2, '403 rateLimitExceeded → retry');
  assert.ok(log.some((l) => l.includes('/sA/values:batchGet?ranges=%272026%27%211%3A1&ranges=%27%E0%B8%A5%E0%B8%B8%E0%B8%87%27%27s%27%211%3A1&valueRenderOption=FORMATTED_VALUE')), 'header row only');
  assert.ok(log.some((l) => l.includes('/sB/values:batchGet?ranges=%27Q1%27%211%3A2000&')), 'allowlisted: whole tab');
  assert.ok(!log.some((l) => /doc2|doc3|evil/.test(l)), 'out of scope files are never read');
});

test('parse: mail MIME/base64url/TIS-620/HTML/quotes/attachments, doc, sheets; roles, uuids, stable', dpapi, async () => {
  const m1 = (await parse(join(archive, 'gmail/2026/t1.json')))!;
  assert.deepEqual([m1.sessionId, m1.cwd, m1.kind], ['gmail:t1', 'google/gmail', 'doc']);
  assert.deepEqual(m1.msgs.map((m) => [m.uuid, m.parentUuid, m.role, m.text]), [
    ['google:gmail:m1', null, 'assistant', `[mail] ใบเสนอราคา\n${BOB} → ${ME}\nสวัสดีครับ ลุงจืด\nใบเสนอราคาแนบมาครับ\n[แนบ: quote.pdf 123 KB]`],
    ['google:gmail:m2', 'google:gmail:m1', 'user', `[mail] Re: ใบเสนอราคา\n${ME} → ${BOB}\nได้ครับ ขอบคุณ`]]);
  assert.equal((await parse(join(archive, 'gmail/2025/t2.json')))!.msgs[0].text, '[mail] ใบแจ้งหนี้\nshop@example.co.th → me@example.com\nเรียน ลุงจืด\nยอดชำระ 1,234.50 บาท');
  assert.equal((await parse(join(archive, 'gmail/2026/t3.json')))!.msgs[0].text,
    '[mail] นัดประชุม\nBoss <boss@example.com> → me@example.com\nนัดประชุม พรุ่งนี้ & สรุปงาน✅\nบรรทัด2\nบรรทัด3');
  const doc = (await parse(join(archive, 'docs/doc1.json')))!;
  assert.deepEqual([doc.sessionId, doc.cwd, doc.msgs[0].role, doc.msgs[0].ts], ['gdoc:doc1', 'google/docs', 'note', '2026-09-20T03:00:00.000Z']);
  assert.equal(doc.msgs[0].text, '[doc] แผนงาน 2026\n# แผนงาน\n\nเนื้อหา [image]\n\n[image1]: [data-url]');
  const sA = (await parse(join(archive, 'sheets/sA.json')))!;
  assert.deepEqual([sA.sessionId, sA.cwd], ['gsheet:sA', 'google/sheets']);
  assert.equal(sA.msgs[0].text, "[sheet] เงินเดือน · header row only\nแท็บ 2026 (1000×26): ชื่อ | เงินเดือน\nแท็บ ลุง's (50×5): a | b");
  assert.equal((await parse(join(archive, 'sheets/sB.json')))!.msgs[0].text, '[sheet] budget\nแท็บ Q1 (3×2)\nitem,amount\nค่าไฟ,"1,234.50"\n"note, ""x""",0.10');

  const paths = archived().map((f) => join(archive, f)).filter(isTranscript), all: string[] = [];
  assert.equal(paths.length, 6);
  assert.ok(!isTranscript(join(archive, '_state.json')) && !isTranscript(join(archive, 'docs', 'doc1.json.1759.bak')));
  for (const f of paths) {
    const p = (await parse(f))!;
    assert.deepEqual(await parse(f), p, 'stable across re-parses');
    assert.ok(p.msgs.every((m) => new Date(m.ts).toISOString() === m.ts));
    all.push(...p.msgs.map((m) => m.uuid));
  }
  assert.equal(new Set(all).size, all.length, 'uuids unique');
});

test('sync again: hourly window only + unchanged; lost state = full resync without refetching archived threads', dpapi, () => {
  const statePath = join(archive, '_state.json'), st = read('_state.json');
  st.gmail.lastOk = st.drive.lastOk = '2026-09-20T05:00:00.000Z';
  writeFileSync(statePath, JSON.stringify(st));
  world[list(`${GMAIL_Q} after:2026/09/18`)] = { messages: [{ id: 'm2', threadId: 't1' }] };
  world[files(`${DRIVE_Q} and modifiedTime > '2026-09-20T04:00:00.000Z'`)] = { files: (world[files(DRIVE_Q)] as any).files.slice(0, 1) };
  save(); fresh();
  const before = archived().filter((f) => f !== '_state.json').map((f) => [f, existsSync(join(archive, f)) && f.endsWith('.json') ? readFileSync(join(archive, f), 'utf8') : '']);
  assert.deepEqual(sync(archive), { threads: 1, unchanged: 2, calls: 5 });
  assert.ok(calls().some((l) => l.includes('after%3A2026%2F09%2F18')), 'Gmail window = last ok − 2 days');
  assert.deepEqual(archived().filter((f) => f !== '_state.json').map((f) => [f, existsSync(join(archive, f)) && f.endsWith('.json') ? readFileSync(join(archive, f), 'utf8') : '']), before);

  unlinkSync(statePath); fresh();
  const r = sync(archive);
  assert.deepEqual(r, { filtered: 1, nomemory: 1, gone: 1, ignored: 2, skipped: 1, unchanged: 3, calls: 9 });
  assert.ok(!calls().some((l) => /threads\/t[123]\?/.test(l)), 'archived threads are not fetched again');
  assert.ok(read('_state.json').gmail.fullAt && read('_state.json').drive.fullAt);
});

test('refresh: invalid_grant → skipped (login again); extra scope → stopped before any read; rate limit → stopped, cursor kept', dpapi, () => {
  const st = JSON.stringify(read('_state.json'));
  world['oauth2.googleapis.com/token'] = { $status: 400, $body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
  save(); fresh();
  assert.deepEqual(sync(archive), { skipped: 'token expired or revoked: login again (node src/cli.ts google login)' });

  world['oauth2.googleapis.com/token'] = { ...TOKEN, scope: `${SCOPES.join(' ')} https://www.googleapis.com/auth/gmail.modify` };
  save(); fresh();
  const r = sync(archive);
  assert.match(String(r.stopped), /refused: extra scope/);
  assert.equal(calls().length, 1, 'only the token call');

  world['oauth2.googleapis.com/token'] = TOKEN;
  world[`${G}/labels`] = { $status: 429 };
  save(); fresh();
  assert.deepEqual(sync(archive), { stopped: 'HTTP 429 after 5 tries', calls: 6 });
  assert.equal(JSON.stringify(read('_state.json')), st, 'cursor not advanced');
});

test('status --dry: setup, token, archive counts + live read-only estimates', dpapi, async () => {
  world[`${G}/messages?${new URLSearchParams({ q: GMAIL_Q, maxResults: '1' })}`] = { resultSizeEstimate: 7 };
  save(); fresh();
  const out = (await status(archive, true)).join('\n');
  for (const re of [/client_secret: ok/, /token: stored \(DPAPI\), scopes gmail\.readonly \+ drive\.readonly/, /sheets-allow\.txt: 1 sheet\(s\)/,
    /3 threads · 1 docs · 2 sheets/, /gmail: ≈7 messages match/, /drive: 2 docs \+ 2 sheets in scope \(of 6\)/]) assert.match(out, re);
  assert.deepEqual(calls().map((l) => l.split(/[ ?]/).slice(0, 2).join(' ')),
    ['POST https://oauth2.googleapis.com/token', 'GET https://gmail.googleapis.com/gmail/v1/users/me/messages', 'GET https://www.googleapis.com/drive/v3/files']);
});
