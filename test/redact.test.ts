import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, stripPrivate } from '../src/redact.ts';

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
  'xrdp 192.0.2.10 terminal (GTK4) เปิดไม่ขึ้น',
  'ssh 192.0.2.10 root access only via tunnel',
];

for (const s of KEEP) {
  test(`keeps: ${s.slice(0, 40)}`, () => {
    assert.equal(redact(s).text, s);
  });
}

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

test('code identifiers emit whole name + parts', () => {
  const w = words('call getUserById in src/search.ts and pg_advisory_xact_lock');
  for (const x of ['getuserbyid', 'user', 'search.ts', 'search', 'pg_advisory_xact_lock', 'advisory', 'lock']) assert.ok(w.includes(x), x);
});
