// Smoke-check the PUBLISHED site like a friend would open it: desktop + phone, no login, no third-party requests, no errors,
// the brain actually renders, tap opens details on the phone, the share card (og.png) is there, no private names.
// Needs the local memory-hub DB (read-only) for the names. usage: node scripts/public-check.mjs [url]
import { chromium, devices } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { assertAnonymous } from '../../src/brain.ts';
import { connect } from '../../src/db.ts';
import { textLeak } from './public-names.mjs';

const URL_ = process.argv[2] ?? 'https://memory-hub-brain.vercel.app/';
const OUT = join(import.meta.dirname, '..', '..', 'tmp', 'public-check');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--ignore-gpu-blocklist'] });
const origin = new URL(URL_).origin;
let failed = 0;
const ok = (name, cond, info = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${info}`); if (!cond) failed++; };
const LEAK = /\b\d{1,3}(\.\d{1,3}){3}\b|[a-z]:[\\/]|@[\w-]+\.\w/i; // IP, drive path, email
const hit = (re, s) => { const m = s.match(re); return m ? `"${s.slice(Math.max(0, m.index - 20), m.index + 30)}"` : ''; };
// AI app names are public now (public-names.mjs); project/repo names, session ids, path parts are not: the DB needles
const db = connect('ro');

// the raw data a visitor can download (feed.json: only where a live feed is deployed; a static snapshot has none)
for (const file of ['graph.json', 'feed.json']) {
  const r = await fetch(`${origin}/${file}`);
  if (file === 'feed.json' && r.status === 404) { console.log('SKIP feed.json: 404 (static snapshot)'); continue; }
  const raw = await r.text();
  ok(`${file}: fetched`, r.ok && raw.length > 2, `${r.status} ${raw.length} B`);
  const leak = await assertAnonymous(db, raw).then(() => '', (e) => e.message); // the publish gate itself
  ok(`${file}: no project/repo names`, !leak, leak);
  ok(`${file}: no IP/path/email`, !LEAK.test(raw), hit(LEAK, raw));
}

// share card for LINE/Facebook/X: the page's og:image is /og.png, a real 1200×630 PNG (scripts/og.mjs, publish --build)
const ogUrl = (await (await fetch(URL_)).text()).match(/<meta property="og:image" content="([^"]+)"/)?.[1];
ok('og:image → /og.png', !!ogUrl && new URL(ogUrl, URL_).pathname === '/og.png', ogUrl ?? 'no og:image');
const og = await fetch(`${origin}/og.png`);
const img = Buffer.from(await og.arrayBuffer());
const size = img.length > 24 ? [img.readUInt32BE(16), img.readUInt32BE(20)] : [];
ok('og.png: served, PNG, 1200×630', og.ok && img.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && size.join('×') === '1200×630',
  `${og.status} ${size.join('×')} ${(img.length / 1024).toFixed(0)} KB`);

for (const [name, ctxOpts] of [
  ['desktop', { viewport: { width: 1440, height: 900 } }],
  ['phone', { ...devices['iPhone 13'], defaultBrowserType: undefined }],
]) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [], foreign = [], failedReq = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => { const u = r.url(); if (!u.startsWith(origin) && !/^(data|blob):/.test(u)) foreign.push(u); });
  page.on('requestfailed', (r) => failedReq.push(r.url()));
  const res = await page.goto(URL_, { waitUntil: 'networkidle' });
  ok(`${name}: HTTP 200 without login`, res.status() === 200 && page.url().startsWith(origin), `${res.status()} ${page.url()}`);
  await page.waitForSelector('canvas', { timeout: 20000 });
  // every load opens with the ~8 s intro replay: read its text, then the rest only once it is LIVE
  // ('snapshot' = the same end state without a feed.json, e.g. a local static server)
  const inIntro = await page.waitForFunction(() => document.querySelector('.stage')?.dataset.phase === 'intro', null, { timeout: 20000, polling: 50 }).then(() => true, () => false);
  ok(`${name}: opens with the intro`, inIntro);
  const introText = await page.evaluate(() => document.body.innerText);
  const live = await page.waitForFunction(() => !document.querySelector('.stage')?.dataset.phase && /^(live|snapshot)$/.test(document.querySelector('.pill')?.dataset.state), null, { timeout: 30000 }).then(() => true, () => false);
  ok(`${name}: intro ends in LIVE`, live);
  await page.waitForTimeout(2000);
  // non-blank: sample the canvas through a screenshot of its box and count non-background pixels
  const box = await page.locator('canvas').first().boundingBox();
  const png = await page.screenshot({ path: join(OUT, `${name}.png`) });
  ok(`${name}: canvas sized`, box && box.width > 300 && box.height > 300, JSON.stringify(box));
  ok(`${name}: screenshot taken`, png.length > 50_000, `${(png.length / 1024).toFixed(0)} KB`);
  const lit = await page.evaluate(() => {
    const c = document.querySelector('canvas'); const g = c.getContext('webgl2', { preserveDrawingBuffer: true }) ?? c.getContext('webgl2');
    return { w: c.width, h: c.height, ctx: !!g };
  });
  ok(`${name}: WebGL2 canvas`, lit.ctx, JSON.stringify(lit));
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  ok(`${name}: no horizontal scroll`, scroll <= 0, `${scroll}px`);
  if (name === 'phone') {
    // tap around the centre until the details sheet opens (nodes are dense there)
    let opened = false;
    for (const [dx, dy] of [[0, 0], [20, 10], [-25, 30], [40, -30], [-50, -10], [10, 60]]) {
      await page.touchscreen.tap(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
      await page.waitForTimeout(700);
      opened = await page.evaluate(() => !!document.querySelector('[class*="sheet"], [class*="details"], [role="dialog"]'));
      if (opened) break;
    }
    ok('phone: tap opens node details', opened);
    await page.screenshot({ path: join(OUT, 'phone-tap.png') });
  }
  const liveText = await page.evaluate(() => document.body.innerText);
  // the "ระบบนี้ทำงานยังไง?" panel with its monthly table open: its text goes through the same rules
  await page.keyboard.press('Escape'); // the phone's tap left a node selected
  await page.getByRole('button', { name: 'ระบบนี้ทำงานยังไง?' }).click();
  await page.locator('#how .heat__table summary').click();
  const panelText = await page.evaluate(() => document.body.innerText);
  await page.screenshot({ path: join(OUT, `${name}-how.png`) });
  ok(`${name}: 0 console/page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  ok(`${name}: 0 third-party requests`, foreign.length === 0, foreign.slice(0, 3).join(' '));
  ok(`${name}: 0 failed requests`, failedReq.length === 0, failedReq.slice(0, 3).join(' '));
  for (const [when, text] of [['intro', introText], ['LIVE', liveText], ['panel', panelText]]) {
    ok(`${name}: no IP/path/email in visible text (${when})`, !LEAK.test(text), hit(LEAK, text));
    const leak = await textLeak(db, text, userInfo().username);
    ok(`${name}: no project/person/repo names in visible text (${when})`, !leak, leak);
  }
  await ctx.close();
}
await browser.close();
await db.end();
console.log(failed ? `${failed} FAILED` : 'all passed', '| screenshots:', OUT);
process.exit(failed ? 1 : 0);
