// Share preview for LINE/Facebook/X: the brain in LIVE at 1200×630, dark theme → out/og.png (layout.tsx og:image).
// Serves out/ on 127.0.0.1 like scene-check, so the shot shows the export's own graph.json. Run after npm run build;
// `node src/cli.ts publish --build` runs it. usage: node scripts/og.mjs
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const OUT = join(import.meta.dirname, '..', 'out');
const MAX = 600 * 1024; // LINE/Facebook/X all take far more; small = fast unfurl on a phone
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const server = createServer((q, s) => {
  let rel = decodeURIComponent(q.url.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  if (rel === '/feed.json') {
    // the deployed site's feed with nothing new: the pill says สด as there (no feed = the 'snapshot' pill)
    const g = JSON.parse(readFileSync(join(OUT, 'graph.json'), 'utf8'));
    s.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return s.end(JSON.stringify({ v: g.v, mode: g.mode, at: g.at, stats: g.stats, nodes: [], links: [], events: [] }));
  }
  const p = join(OUT, rel);
  if (!p.startsWith(OUT) || !existsSync(p) || statSync(p).isDirectory()) {
    s.writeHead(404);
    return s.end();
  }
  s.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  s.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--ignore-gpu-blocklist'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await ctx.addInitScript(() => localStorage.setItem('mh-theme', 'dark'));
  const page = await ctx.newPage();
  // intro=0: straight to LIVE (the replay would own the first ~8 s); debug=1 only adds the window.__brain hooks
  await page.goto(`http://127.0.0.1:${server.address().port}/?intro=0&debug=1&q=high`);
  await page.waitForFunction(() => window.__brain?.firstFrameMs != null && document.querySelector('.pill')?.dataset.state === 'live', null, { timeout: 30000 });
  await page.waitForTimeout(4000); // the first framing flight lands and the bloom settles
  const png = await page.screenshot({ type: 'png' });
  if (png.length > MAX) throw new Error(`og.png ${(png.length / 1024).toFixed(0)} KB > ${MAX / 1024} KB`);
  writeFileSync(join(OUT, 'og.png'), png);
  console.log(`og.png ${(png.length / 1024).toFixed(0)} KB → ${join(OUT, 'og.png')}`);
} finally {
  await browser.close();
  server.close();
}
