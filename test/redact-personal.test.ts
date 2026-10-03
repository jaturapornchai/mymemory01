// Strict personal redaction for the Claude-only Google sources (redact.redactPersonal, applied by importer.clean for
// guard.PRIVATE_TOOLS only). All values are fake; the full red-team corpus is tmp/google/redact-corpus (run.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactPersonal } from '../src/redact.ts';
import { clean } from '../src/importer.ts';

const p = (s: string) => redactPersonal(s).text;
const th = (s: string) => s.replace(/\d/g, (d) => String.fromCharCode(0x0e50 + +d)), fw = (s: string) => s.replace(/\d/g, (d) => String.fromCharCode(0xff10 + +d));
/** A 13-digit Thai ID with a valid (ok) or wrong mod-11 check digit, built here so no real-looking number sits in the source. */
const thaiId = (ok: boolean, body = '123456789012') => {
  const check = (11 - ([...body].reduce((t, c, i) => t + +c * (13 - i), 0) % 11)) % 10;
  return body + ((check + (ok ? 0 : 1)) % 10);
};

test('masked: one-time codes, login/reset links, URL queries, Luhn cards, Thai ID, bank/PromptPay, passport, CVV', () => {
  for (const [input, want] of [
    ['Your verification code is 482913. It expires soon.', 'Your verification code is [REDACTED:otp]. It expires soon.'],
    ['G-582044 is your Google verification code', 'G-[REDACTED:otp] is your Google verification code'],
    ['รหัสยืนยันของคุณคือ 739104 ห้ามบอกใคร', 'รหัสยืนยันของคุณคือ [REDACTED:otp] ห้ามบอกใคร'],
    ['reset: https://accounts.example.com/reset-password/abc123?u=1.', 'reset: https://accounts.example.com/[REDACTED:link].'],
    ['https://shop.example.com/orders/42?id=99#frag', 'https://shop.example.com/orders/42[REDACTED:query]'],
    ['card 4111 1111 1111 1111 exp 12/29', 'card [REDACTED:card] exp 12/29'],
    [`บัตรประชาชน ${thaiId(true)}`, 'บัตรประชาชน [REDACTED:thaiid]'],
    ['โอนเข้าเลขบัญชี 123-4-56789-0 ได้เลย', 'โอนเข้าเลขบัญชี [REDACTED:bank] ได้เลย'],
    ['PromptPay 0812345678', 'PromptPay [REDACTED:bank]'],
    ['Passport no. AA1234567 valid', 'Passport no. [REDACTED:passport] valid'],
    ['CVV: 123', 'CVV: [REDACTED:cvv]'],
    ['รหัสผ่านชั่วคราวของคุณ: Xk9mP2qaZ', 'รหัสผ่านชั่วคราวของคุณ: [REDACTED:password]'],
    ['Your temporary password is Xk9mP2qaZ', 'Your temporary password is [REDACTED:password]'],
    [`บัตรประชาชน ${th(thaiId(true))}`, 'บัตรประชาชน [REDACTED:thaiid]'],
    [`หมายเลขบัตร ${th('4111 1111 1111 1111')} / ${fw('4111111111111111')}`, 'หมายเลขบัตร [REDACTED:card] / [REDACTED:card]'],
    ['card 4111.1111.1111.1111 or 4111  1111\n1111 1111', 'card [REDACTED:card] or [REDACTED:card]'],
    ['โอนมาที่ 123-456789-0 หรือ 123 4 56789 0 นะ', 'โอนมาที่ [REDACTED:bank] หรือ [REDACTED:bank] นะ'],
    ['482 913 is your Facebook code', '[REDACTED:otp] is your Facebook code'],
    ['Your sign-in code: 4 8 2 9 1 3', 'Your sign-in code: [REDACTED:otp]'],
    ['OTP: 482\u200b913 / 482\u00ad913', 'OTP: [REDACTED:otp] / 482913'], // invisible separators out; one code per keyword
    ['Your verification code (valid for 10 minutes; never share it, not even with our staff) is: 482913', 'Your verification code (valid for 10 minutes; never share it, not even with our staff) is: [REDACTED:otp]'],
  ]) assert.equal(p(input), want, input);
});

test('kept: phones, prices, dates, order refs, non-Luhn / bad-checksum numbers, plain links', () => {
  for (const s of [
    'โทร 081-234-5678 หรือ +66 81 234 5678',
    'OTP ยอดชำระ 4500 บาท วันที่ 03/10/2026 เวลา 14:35',
    'order 4111 1111 1111 1112 shipped', // fails Luhn
    `ref ${thaiId(false)}`,              // fails mod 11
    'model AB1234567 (no passport keyword)',
    'see https://github.com/acme/authors and https://example.com/maps/place/x',
    'Password must be at least 8 characters long', 'ลืมรหัสผ่าน กด Forgot password? ที่หน้า login',
    'verification code sent 2026-10-03, call 081-234-5678',
  ]) assert.equal(p(s), s, s);
});

test('central rules: Google access (ya29.c.…) and refresh (1//…) tokens, for every source', () => {
  const access = 'ya29.c.' + 'b0Aa'.repeat(8), refresh = '1//0g' + 'Zx9-q'.repeat(9);
  assert.equal(redact(`token ${access} end`).text, 'token [REDACTED:google] end');
  assert.equal(redact(`saved ${refresh}`).text, 'saved [REDACTED:google]');
});

test('clean(): the strict pass only when asked (PRIVATE_TOOLS); other sources keep their redaction byte for byte', () => {
  const s = 'card 4111 1111 1111 1111 <private>x</private> code 482913 OTP';
  assert.equal(clean(s), redact('card 4111 1111 1111 1111 [PRIVATE] code 482913 OTP').text);
  assert.equal(clean(s, true), 'card [REDACTED:card] [PRIVATE] code [REDACTED:otp] OTP');
});
