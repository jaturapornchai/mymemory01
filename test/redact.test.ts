import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, REDACT_VER, redactOffsite, stripPrivate } from '../src/redact.ts';

// Fake fixtures, split with + so secret scanners (GitHub push protection) don't read them as real tokens.
const SECRETS: [string, string][] = [
  ['pem', '-----BEGIN RSA PRIVATE' + ' KEY-----\nMIIEowIBAAKCAQEA1234\nabcd\n-----END RSA PRIVATE KEY-----'], // pragma: allowlist secret
  ['pem', '-----BEGIN OPENSSH PRIVATE' + ' KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA (truncated'], // pragma: allowlist secret
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'], // pragma: allowlist secret
  ['anthropic', 'sk-ant-' + 'api03-AbCdEf1234567890_xyzXYZ-abcdefghij'], // pragma: allowlist secret
  ['sk', 'sk-' + 'proj-abcdefghijklmnopqrstuvwxyz123456'], // pragma: allowlist secret
  ['stripe', 'sk_' + 'live_51HabcdefGHIJKLmnop1234'],
  ['github', 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789'], // pragma: allowlist secret
  ['github', 'github_' + 'pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP'],
  ['aws', 'AKIA' + 'IOSFODNN7EXAMPLE'], // pragma: allowlist secret
  ['google', 'AIza' + 'SyA-1234567890abcdefghijklmnopqrstu'], // pragma: allowlist secret
  ['slack', 'xoxb-' + '123456789012-abcdefghijkl'], // pragma: allowlist secret
  ['telegram', '1234567890:' + 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1'], // pragma: allowlist secret
  ['npm', 'npm_' + 'abcdefghijklmnopqrstuvwxyz0123456789'],
  ['hf', 'hf_' + 'abcdefghijklmnopqrstuvwxyzABCDEF12'],
  ['hex64', '0x' + '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'],
  ['digitalocean', 'dop_v1_' + '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'],
  ['ark', 'ark-' + '5f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b-12345'],
  ['ollama', '67117a0b1c2d3e4f5a6b7c8d9e0f1a2b.' + 'Zx9_Qw-ErTyUiOpAsDfGhJkLI'],
  ['syn', 'syn_' + '0f1e2d3c4b5a69788796a5b4c3d2e1f0'], // pragma: allowlist secret
  ['ollama', '67117a0b1c2d3e4f5a6b7c8d9e0f1a2b.' + 'Zx9QwErTyUiOpAsD'], // z.ai GLM: 16 after the dot. pragma: allowlist secret
  ['sk', 'sk_' + '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978'], // ElevenLabs. pragma: allowlist secret
  ['sk', 'mcp_sk_' + '0f1e2d3c4b5a69788796a5b4c3d2e1f0'], // pragma: allowlist secret
  ['pem', '-----BEGIN PGP PRIVATE' + ' KEY BLOCK-----\nlQOYBF/abc+def/ghi0123\n-----END PGP PRIVATE KEY BLOCK-----'], // pragma: allowlist secret
];

for (const [kind, secret] of SECRETS) {
  test(`redacts ${kind}: ${secret.slice(0, 18)}…`, () => {
    const { text, hits } = redact(`before ${secret} after`);
    assert.ok(!text.includes(secret.slice(8, 24)), text);
    assert.ok(hits[kind] >= 1, JSON.stringify(hits));
    assert.match(text, /^before /);
  });
}

const VALUE_CASES: [string, string][] = [
  ['postgres://memhub:' + 'S3cr3tPass@127.0.0.1:5441/memhub', 'S3cr3tPass'], // pragma: allowlist secret
  ['mongodb+srv://admin:' + 'hunter22@cluster0.example.net/db', 'hunter22'], // pragma: allowlist secret
  ['Authorization: Bearer abc.def-ghi_jkl123456', 'abc.def-ghi_jkl123456'],
  ['PGPASSWORD=Sup3rS3cret psql -h localhost', 'Sup3rS3cret'],
  ['export DB_PASSWORD="p@ssw0rd!"', 'p@ssw0rd!'], // pragma: allowlist secret
  ['{"password": "hunter2xx", "user": "a"}', 'hunter2xx'], // pragma: allowlist secret
  ['api_key: 9f8e7d6c5b4a', '9f8e7d6c5b4a'],
  ['BINANCE_SECRET_KEY=abcdef0123456789abcdef', 'abcdef0123456789abcdef'],
  ['พิมพ์ password `hunterx2` ตอนถาม', 'hunterx2'],
  ['รหัสผ่านคือ "Hors3-99xyz"', 'Hors3-99xyz'],
  ['Server=db;User Id=sa;Password=MyPass123;', 'MyPass123'],
  ['psql --password=topsecret1', 'topsecret1'],
  ['รหัสผ่าน: Abc12345', 'Abc12345'],
  ['password=123456', '123456'],
  ['key is Xk9mQ2vL8pR4tW7yB3nF6hJ1cD5gA0sZ in env', 'Xk9mQ2vL8pR4tW7yB3nF6hJ1cD5gA0sZ'],
  ["HOST = '10.1.2.3'; pw = 'demoUser'", 'demoUser'],
  ['PW: Tunn3lPass', 'Tunn3lPass'],
  ['net use \\\\SRV /user:admin /pass:Sh4reKey', 'Sh4reKey'],
  ['เข้า 203.0.113.7 root Zx9#kLm2 แล้ว', 'Zx9#kLm2'],
  ['WEATHER_KEY=' + '0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'], // pragma: allowlist secret
  ['MAPS_KEY=' + 'AbCdEf123456', 'AbCdEf123456'], // pragma: allowlist secret
  ['DB_PASS=' + 'hunter2x', 'hunter2x'], // pragma: allowlist secret
  ['SMTP_PASS: ' + 'Mail2024!', 'Mail2024!'], // pragma: allowlist secret
  ['{"key": "' + 'Zq8x3LmP0aB7cD2e"}', 'Zq8x3LmP0aB7cD2e'], // pragma: allowlist secret
  ['auth: { user: "a@b.c", pass: "' + 'Zx9!kq2Lm" }', 'Zx9!kq2Lm'], // pragma: allowlist secret
  ['redis://:' + 'S3cretPassw0rd@localhost:6379', 'S3cretPassw0rd'], // pragma: allowlist secret
  ['mysql://root:' + 'ab/cd12EF@127.0.0.1/x', 'cd12EF'], // pragma: allowlist secret
  ['postgres://app:' + 'p@ssW0rd1@h/db', 'ssW0rd1'], // pragma: allowlist secret
  ['authorization: bearer ' + 'abcdEFGH12345678xyz', 'abcdEFGH12345678xyz'], // pragma: allowlist secret
  ["[shell] $env:SML_REMOTE_PW = '" + "Qz7$kLm2Wx9'", 'Qz7$kLm2Wx9'], // pragma: allowlist secret
  ["cd deploy && DEPLOY_PW='" + "Rt5#nB8vQ' node x", 'Rt5#nB8vQ'], // pragma: allowlist secret
  ["c.connect('192.0.2.10', 22, 'root', '" + "Hy6@pL3mZ')", 'Hy6@pL3mZ'], // pragma: allowlist secret
  ['SSH: `root@192.0.2.10` / password: `' + 'Kd4%wE7rT`', 'Kd4%wE7rT'], // pragma: allowlist secret
  ['use server `192.0.2.10` (root / `' + 'Vb2!xN9qL`)', 'Vb2!xN9qL'], // pragma: allowlist secret
  ['HOST = "192.0.2.10" USER = "root" PASS = "' + 'Mn8&cX4zP"', 'Mn8&cX4zP'], // pragma: allowlist secret
  ['MinIO accesskey=`' + 'ak-demo7x`', 'ak-demo7x'], // pragma: allowlist secret
  ['ClickHouse `h:8123` user `admin` pass `' + 'Pq7xLm2w` ok', 'Pq7xLm2w'], // pragma: allowlist secret
  ['- Secret key: `' + 'Zx9-demo-Key4`', 'Zx9-demo-Key4'], // pragma: allowlist secret
  ['| S3 Secret Key | `' + 'Fk3-demo-Sec8` |', 'Fk3-demo-Sec8'], // pragma: allowlist secret
  ["caddy hash-password --plaintext '" + "Hw4!demoPw')", 'Hw4!demoPw'], // pragma: allowlist secret
  ["curl -s -u 'demo:" + "Cu7!demoPw' http://127.0.0.1/", 'Cu7!demoPw'], // pragma: allowlist secret
];

for (const [input, secret] of VALUE_CASES) {
  test(`redacts value in: ${input.slice(0, 40)}`, () => {
    const { text } = redact(input);
    assert.ok(!text.includes(secret), text);
    assert.match(text, /\[REDACTED:/);
  });
}

const KEEP = [
  'session 5b7c1e90-4d2a-4f63-9e18-0a6c3d7b2f41 started',
  'commit a4e19f02c7d84b5e9a3f61c0d82e7b5f1234abcd',
  'sha256:4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
  'C:/Users/alice/.claude/projects/D--proj/subagents/workflows',
  'node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts',
  'getUserAccountBalanceHistoryWithRetries',
  'max_tokens: 4096',
  'MAX_MCP_OUTPUT_TOKENS=25000',
  'token: string; password: string | null',
  'password: process.env.DB_PASSWORD',
  'secret: ${{ secrets.API_KEY }}',
  'ต้องยื่นแบบ ภ.ง.ด.53 ทุกเดือน',
  'ประหยัด token: ห้ามอ่านไฟล์ซ้ำ',
  'https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically',
  'pgvector/pgvector:0.8.6-pg18',
  'tool-use-id toolu_01AbCdEfGhIjKlMnOpQrStUv done',
  'cd "C:/Users/alice/.claude/projects/D--proj/e3a1c7d2-8b4f-4e19-a6d0-5f2c9b8e1a73/subagents"',
  'hired on upwork = good rates',
  'You are the third pass: read the file again',
  'vnc 192.0.2.10 window เปิดไม่ขึ้น',
  'ssh 192.0.2.10 root access only via tunnel',
  'the key is to pass the test: pass: true',
  'press the key: Enter',
  'monkey=banana',
  '{ "key": "ctrl+shift+p", "command": "x" }',
  'open http://localhost:5173/@vite/client and http://localhost:8080?u=a@b.com',
  'Bearer authentication is the basic configuration',
  'SSH_KEY_PATH=~/.ssh/id_ed25519',
  'const LS_KEY = "memhub.graph.v2"; SORT_KEY=name',
  'map (input / `output`) then ws.connect(url, 22)',
  "transcribe(ROOT/'tmp-1/a.wav')",
  'PASS  src/foo.test.ts',
  "grep -E 'AIza|mongodb\\+srv://|://[^/]*:[^@]*@|BEGIN'",
  'img = (tmp / "frame_1.png") and (RUNTIME / "run_2/a.json")',
  'DEEPSEEK_KEY=\n.env.example:12:# key',
  '- Secrets: `JWT_SECRET`, token: `--max-2`, credentials=`include`',
  'password: `src/auth/login.ts:12-34`',
  'SSH_KEY: /tmp/id_ed25519',
  'PG_PW=\\$(cat /run/pw) psql',
  'const STORAGE_KEY = "bc_grid_v1"',
  'pass `--force` to git push, the secret key `SECRET_KEY` env var',
  'docker run -u 1000:1000 img; ps -u www-data:www-data',
  '[shell] python -u D:\\tools\\x9\\run_2.py',
];

test('known secrets: a listed value goes in any context (table cell, grep arg); one under 8 chars is ignored', async () => {
  const f = join(tmpdir(), `memhub-known-${process.pid}.txt`), v = 'Kn0wn-' + 'demo-Value'; // pragma: allowlist secret
  writeFileSync(f, `${v}\nshort\n`);
  process.env.MEMHUB_KNOWN_SECRETS = f;
  const m = await import('../src/redact.ts?known'); // own module instance: reads the list at load
  delete process.env.MEMHUB_KNOWN_SECRETS;
  rmSync(f);
  const out = m.redact(`| minio | bc/${v} | grep -rl "${v}" short`).text;
  assert.ok(!out.includes(v) && out.includes('[REDACTED:known]') && out.includes('short'), out);
  assert.notEqual(m.REDACT_VER, REDACT_VER, 'a list change re-queues stored rows');
});

test('connstr: the password stops at a \\n escape and at the next scheme://', () => {
  const s = 'postgres://app:' + 'Pw7xk@db:5432/x#redis://u:' + 'Rq8zz@cache "mongodb://u:' + 'Mz9qq@h:27017/db\\n-X=y@z"'; // pragma: allowlist secret
  const out = redact(s).text;
  for (const v of ['Pw7xk', 'Rq8zz', 'Mz9qq']) assert.ok(!out.includes(v), out);
  assert.ok(out.includes('@db:5432/x#redis://') && out.includes('@h:27017/db'), out);
});

for (const s of KEEP) {
  test(`keeps: ${s.slice(0, 40)}`, () => {
    assert.equal(redact(s).text, s);
  });
}

test('offsite: short / low-entropy key shapes the import rules let through never leave the machine', () => {
  const r = (n: number, a = 'abcdef0123456789') => Array.from({ length: n }, (_, i) => a[(i * 7 + 3) % a.length]).join('');
  const AL = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zC';
  const fakes = [r(25, AL), r(24, AL), r(40, AL + '_-'), r(32), r(64), r(24, 'abcdefghijklmnopqrstuvwxyz0123456789')];
  for (const v of fakes) for (const ctx of [`ใช้ตัวนี้ ${v} นะ`, `ELEVEN=${v}`, `"${v}"`])
    assert.ok(!redactOffsite(ctx).includes(v), ctx);
  for (const s of ['deploy v2.3 ไป port 5434 แล้ว', 'getUserByIdAndProjectName()', 'commit 5d72ad9 fixed it', '2026-10-10T07:30:00Z'])
    assert.equal(redactOffsite(s), s);
});

test('idempotent', () => {
  const once = redact('PGPASSWORD=Sup3rS3cret and ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789').text; // pragma: allowlist secret
  assert.equal(redact(once).text, once);
});

test('stripPrivate removes tagged spans, including unclosed', () => {
  assert.equal(stripPrivate('a <private>ลูกค้า X โทร 081</private> b'), 'a [PRIVATE] b');
  assert.equal(stripPrivate('a <PRIVATE>x\ny'), 'a [PRIVATE]');
});

import { words } from '../src/thai.ts';
test('tokenizer splits Thai↔digit/Latin boundaries ICU leaves glued', () => {
  const w = words('ยื่นภ.ง.ด.53ภายในวันที่7 ใช้Claudeค้น');
  for (const x of ['ที่', '7', '53', 'ภายใน', 'claude']) assert.ok(w.includes(x), `${x} in ${w.join('|')}`);
});

import { bigramQuery as bq, bigramRuns, normalize, queryTerms as qt } from '../src/thai.ts';
test('Thai digits fold to ASCII in the step index and query share: ภ.ง.ด.๕๓ = ภ.ง.ด.53', () => {
  assert.deepEqual(words('ยื่นภ.ง.ด.๕๓ภายในวันที่๗'), words('ยื่นภ.ง.ด.53ภายในวันที่7')); // index side (words)
  assert.deepEqual(bigramRuns('ภ.ง.ด.๕๓'), bigramRuns('ภ.ง.ด.53'));                       // index side (bigrams)
  assert.equal(bq('ภ.ง.ด.๕๓'), bq('ภ.ง.ด.53'));                                         // query side
  const k = (q: string) => qt(q).map((t) => t.key);
  assert.deepEqual(k('ภาษี ๒๕๖๘ งวด 3 รอบ ๒๕68'), k('ภาษี 2568 งวด 3 รอบ 2568'));        // mixed digits
  assert.equal(normalize('๐๑๒๓๔๕๖๗๘๙'), '0123456789');
  const ascii = 'ยื่น ภ.ง.ด.53 ปี 2568 getUserById ๆ ฯ'; // no Thai digit (ๆ ฯ are not digits): unchanged, same length
  assert.equal(normalize(ascii), ascii.toLowerCase());
  assert.equal(normalize('ปี ๒๕๖๘').length, 'ปี ๒๕๖๘'.length, 'snippet offsets index the raw text');
});

test('code identifiers emit whole name + parts', () => {
  const w = words('call getUserById in src/search.ts and pg_advisory_xact_lock');
  for (const x of ['getuserbyid', 'user', 'search.ts', 'search', 'pg_advisory_xact_lock', 'advisory', 'lock']) assert.ok(w.includes(x), x);
});

import { bigramQuery, queryTerms } from '../src/thai.ts';
const keys = (q: string) => queryTerms(q).map((t) => t.key);
test('query terms: เลย stays when the rest only asks when/how often; question words stay (timeline headers ask them)', () => {
  assert.ok(keys('ไปเลยเมื่อไหร่').includes('เลย'));
  assert.ok(keys('ไปเลยเมื่อไหร่').includes('ไหร่'));
  assert.notEqual(bigramQuery('ภงด'), null, 'a bare Thai abbreviation keeps its bigram leg');
});

test('loei: the province alias only where เลย cannot mean "go ahead"', () => {
  for (const q of ['ไปเลยเมื่อไหร่', 'ไปจังหวัดเลยกี่ครั้ง', 'ไป จ.เลย ล่าสุด']) assert.ok(keys(q).includes('loei'), q);
  for (const q of ['แก้ bug ไปเลย', 'ทำต่อเลยครับ', 'deploy เลย', 'ไปเที่ยวเลย']) assert.ok(!keys(q).includes('loei'), q);
});

import { timeWindow } from '../src/search.ts';
test('relative time: a window from the anchor; relative words leave the terms, month names, years and case stay', () => {
  const now = new Date('2026-10-03T12:00:00Z'), iso = (x?: Date) => x?.toISOString(); // 19:00 in Bangkok
  let t = timeWindow('เมื่อวานแก้ bug อะไร', now);
  assert.deepEqual([iso(t.from), iso(t.to)], ['2026-10-01T17:00:00.000Z', '2026-10-02T17:00:00.000Z']); // Bangkok days
  assert.ok(!t.rest.includes('เมื่อวาน') && t.rest.includes('bug'));
  t = timeWindow('เดือนสิงหาทำวิดีโอ', now);
  assert.deepEqual([iso(t.from), iso(t.to)], ['2026-07-31T17:00:00.000Z', '2026-08-31T17:00:00.000Z']);
  assert.ok(t.rest.includes('สิงหา'));
  t = timeWindow('ปีที่แล้ว deploy getUserById', now);
  assert.equal(iso(t.from), '2024-12-31T17:00:00.000Z');
  assert.ok(t.rest.includes('getUserById') && !t.rest.includes('ปี'));
  assert.ok(timeWindow('ภาษีปี 2568', now).rest.includes('2568'));
  assert.equal(iso(timeWindow('มกราปีนี้', now).from), '2025-12-31T17:00:00.000Z');
  assert.ok(timeWindow('last time we fixed it', now).recent);
  t = timeWindow('ไปเลยเมื่อไหร่', now);
  assert.deepEqual([t.from, t.recent, t.rest], [undefined, false, 'ไปเลยเมื่อไหร่']);
});
