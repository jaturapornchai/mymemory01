// Headless acceptance checks for the 3D scene (docs/research/brain-renderer-spec.md §9).
// System Chrome, real GPU (same launch path as tmp/bench/run.mjs), static export served on 127.0.0.1, fixtures via page.route.
// usage: node scripts/scene-check.mjs [--no-build] [--headed] [--only=a,b]   (cases: see CASES below)
// Screenshots + report.json + baseline.json → D:\memoryhub\tmp\scene-check\
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(WEB, 'out');
const SHOTS = resolve(WEB, '../tmp/scene-check');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}`));
const only = arg('only')?.split('=')[1]?.split(',');
mkdirSync(SHOTS, { recursive: true });

const results = [];
const record = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${id}] ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. build ──
if (!arg('no-build')) {
  // og.mjs too: next build wipes out/, and the share card belongs to a publishable out/ (as publish --build makes it)
  for (const cmd of ['npm run typecheck', 'npm test', 'npm run build', 'node scripts/og.mjs']) {
    try {
      execSync(cmd, { cwd: WEB, stdio: 'pipe' });
      record(1, cmd, true, 'exit 0');
    } catch (e) {
      record(1, cmd, false, String(e.stdout ?? e).slice(-600));
    }
  }
}
record(1, 'out/index.html exists', existsSync(join(OUT, 'index.html')), '');

// ── 3. build gate: no third-party origins baked into the export ──
const files = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
// spec regex had a bare `fonts\.`, which matches React DOM's own `document.fonts.status`; anchored to a URL instead
const THIRD = /cdn\.|unpkg|jsdelivr|githack|gstatic|googleapis|babylonjs|\/\/fonts\./;
const hits = files(OUT).filter((f) => /\.(js|html|css|json|txt)$/.test(f) && THIRD.test(readFileSync(f, 'utf8')));
record(3, 'build gate: no CDN/font/analytics strings in out/', hits.length === 0, hits.map((f) => f.slice(OUT.length)).join(' ') || 'clean');

// ── 4. bundle ──
const chunkDir = join(OUT, '_next/static/chunks');
const engineChunks = readdirSync(chunkDir).filter((f) => f.endsWith('.js') && /isWebGLRenderer|BloomEffect/.test(readFileSync(join(chunkDir, f), 'utf8')));
const gzKB = engineChunks.reduce((s, f) => s + gzipSync(readFileSync(join(chunkDir, f)), { level: 9 }).length, 0) / 1000;
record(4, 'bundle gzip (chunks with isWebGLRenderer|BloomEffect) ≤ 175 KB', gzKB <= 175 && engineChunks.length > 0, `${gzKB.toFixed(1)} KB in ${engineChunks.length} chunk(s)`);

// ── fixtures ──
const real = JSON.parse(readFileSync(join(WEB, 'public/graph.json'), 'utf8'));
const hasXyz = real.nodes.filter((n) => n.xyz).length;
function times(b, X) {
  const nodes = [];
  const links = [];
  for (let k = 0; k < X; k++) {
    const id = (s) => (k ? `${s}~${k}` : s);
    const a = (k * 2 * Math.PI) / X;
    const sc = 1 + 0.25 * k;
    for (const n of b.nodes) {
      const c = { ...n, id: id(n.id), p: n.p && id(n.p) };
      if (n.xyz) c.xyz = [Math.round((Math.cos(a) * n.xyz[0] - Math.sin(a) * n.xyz[2]) * sc), Math.round(n.xyz[1] * sc), Math.round((Math.sin(a) * n.xyz[0] + Math.cos(a) * n.xyz[2]) * sc)];
      nodes.push(c);
    }
    for (const l of b.links) links.push({ ...l, source: id(l.source), target: id(l.target) });
  }
  return { ...b, nodes, links, events: [] };
}
const x4 = times(real, 4);
const PROBE_TYPES = ['project', 'session', 'subagent', 'note', 'memory'];
const probe = {
  v: 1, mode: 'public', at: real.at, stats: {}, links: [], events: [],
  nodes: PROBE_TYPES.map((type, i) => ({ id: `probe-${type}`, type, n: 1, t0: real.at - 86400, t1: real.at - 86400, u: 0, xyz: [0, 40 - 20 * i, 0] })),
};
const empty = (b) => JSON.stringify({ v: 1, mode: b.mode, at: b.at, stats: b.stats, nodes: [], links: [], events: [] });
const degree = new Map();
for (const l of real.links) for (const e of [l.source, l.target]) degree.set(e, (degree.get(e) ?? 0) + 1);
const hubId = [...degree].sort((a, b) => b[1] - a[1])[0][0];
const FAMILY = { project: '#3987e5', session: '#199e70', subagent: '#199e70', note: '#d95926', memory: '#d95926' };
const BG = { dark: '#07090f', light: '#f5f5f7' }; // brain/style.ts THEME[*].bg; one node palette for both themes
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// ── static server for out/ ──
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.ico': 'image/x-icon' };
const server = createServer((q, s) => {
  let rel = decodeURIComponent(q.url.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const p = join(OUT, rel);
  if (!p.startsWith(OUT) || !existsSync(p) || statSync(p).isDirectory()) {
    s.writeHead(404);
    return s.end();
  }
  s.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  s.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !arg('headed'),
  args: ['--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const VIEWS = {
  desktop: { viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 },
  narrow: { viewport: { width: 420, height: 900 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  mobileShort: { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  mobileWide: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  mobile360: { viewport: { width: 360, height: 780 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  laptop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  tablet: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const WARN = /THREE|WebGL|GL_|shader/;

/**
 * One page: fixture routing, console + network capture (checks 2 and 3 for every case). `theme` = the saved visitor choice.
 * ?intro=0 unless `intro`: the page-load replay would otherwise own the first ~8 s (the intro case tests it).
 */
async function open(name, view, query, fixture, { reduced = false, allowWarn = null, theme = null, intro = false, routes = [] } = {}) {
  const ctx = await browser.newContext({ ...VIEWS[view], reducedMotion: reduced ? 'reduce' : 'no-preference' });
  if (theme) await ctx.addInitScript((t) => localStorage.setItem('mh-theme', t), theme);
  const page = await ctx.newPage();
  if (view.startsWith('mobile')) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const errors = [];
  const bad = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || (m.type() === 'warning' && WARN.test(t) && !(allowWarn && allowWarn.test(t)))) errors.push(`${m.type()}: ${t.slice(0, 200)}`);
  });
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(ORIGIN) && !u.startsWith('data:') && !u.startsWith('blob:')) bad.push(u);
  });
  page.on('requestfailed', (r) => bad.push(`failed ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => r.status() >= 400 && bad.push(`${r.status()} ${r.url()}`));
  await page.route('**/graph.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture) }));
  await page.route('**/feed.json*', (r) => r.fulfill({ contentType: 'application/json', body: empty(fixture) }));
  for (const [glob, handler] of routes) await page.route(glob, handler);
  await page.goto(`${ORIGIN}/?debug=1&${intro ? '' : 'intro=0&'}${query}`);
  await page.waitForFunction(() => window.__brain?.firstFrameMs != null, null, { timeout: 30000 });
  const done = async () => {
    record(2, `console clean: ${name}`, errors.length === 0, errors.slice(0, 4).join(' | ') || '0 errors/warnings');
    record(3, `network same-origin: ${name}`, bad.length === 0, bad.slice(0, 4).join(' | ') || 'ok');
    await ctx.close();
  };
  return { page, done, errors };
}
const B = (page, fn, a) => page.evaluate(fn, a);
const gpuUtil = () => {
  try {
    return execSync('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits', { stdio: 'pipe' }).toString().trim() + '%';
  } catch {
    return 'n/a';
  }
};
/** GPU busy % while none of our pages render = other processes (the local LLM): median of 5 reads, null without nvidia-smi. */
async function othersBusy() {
  // nvidia-smi averages over its last sample period (up to 1 s): read right after ctx.close() and it still counts our
  // own uncapped page, which sent free-GPU runs down the lenient busy-GPU branch
  await sleep(1500);
  const v = [];
  for (let i = 0; i < 5; i++) {
    const u = parseInt(gpuUtil(), 10);
    if (Number.isFinite(u)) v.push(u);
    await sleep(200);
  }
  return v.length ? v.sort((a, b) => a - b)[v.length >> 1] : null;
}
const BUSY = 10; // % from others above which uncapped fps measures the LLM more than us (19-23% already halved the median)
/**
 * Perf gate (§9 check 5) on a GPU shared with a local LLM. Idle GPU (others < BUSY before and after the page): the
 * MEDIAN 1 s window must meet the spec's fps (uncapped), and CPU p95 paced at 60 Hz must too. Busy GPU: fps and CPU p95 mostly measure the other process
 * (best desktop window 114 fps, CPU p95 20-36 ms from back-pressure, while our own frame costs ~0.75 ms of GPU), so the
 * gate judges our own GPU cost instead: timer-query min ≤ 1000 / spec fps. CPU cost is then left to the throttled
 * mobile case and to idle-GPU runs.
 */
function perfGate(view, p, fpsMin, cpuMax) {
  p.contended = p.othersBusy.some((u) => u !== null && u >= BUSY);
  if (p.contended) record(5, `perf ${view} x4: GPU busy ${p.othersBusy.join('/')}% from others → own GPU ms (timer min) ≤ ${(1000 / fpsMin).toFixed(2)}`, p.gpuMsMin !== null && p.gpuMsMin <= 1000 / fpsMin, p);
  else record(5, `perf ${view} x4: median 1 s window ≥ ${fpsMin} fps uncapped, cpu p95 ≤ ${cpuMax} ms paced`, p.medianFps >= fpsMin && p.pacedCpuP95 <= cpuMax, p);
}
/**
 * Samples 1 s windows for ~15 s with the governor held and rendering uncapped (fps headroom), then CPU p95 over 240
 * frames paced at 60 Hz: uncapped, the GPU runs at 100% and GL calls wait on it, so the same build read 0.2-4.5 ms
 * (back-pressure, not our CPU cost) from a 240-frame ring that covered ~0.2 s. The ring restarts when pacing starts and
 * is read once full (a fixed 5 s left a third of it uncapped at a 32 Hz rAF; a 30 fps target needs ≥ 4.8 s).
 */
async function perfWindows(page) {
  await B(page, () => (window.__brain.holdTier = window.__brain.uncapped = true));
  const wins = [];
  for (let i = 0; i < 15; i++) {
    const f0 = await B(page, () => window.__brain.frames);
    const t0 = Date.now();
    await sleep(1000);
    const [f1, p95, g] = await B(page, () => [window.__brain.frames, window.__brain.cpuP95, window.__brain.gpuMs]);
    wins.push({ fps: Math.round(((f1 - f0) * 1000) / (Date.now() - t0)), cpuP95: p95, gpu: gpuUtil(), gpuMs: g });
  }
  const best = wins.reduce((a, b) => (b.fps > a.fps ? b : a));
  // median over steady state: the first ~3 s include shader warm-up
  const steady = wins.slice(3);
  const med = [...steady].sort((a, b) => a.fps - b.fps)[steady.length >> 1];
  // GPU ms of our own frame: min over all windows ≈ uncontended cost; 1000/min = what the scene could do on an idle GPU
  const gpuMin = Math.min(...wins.map((w) => w.gpuMs?.[0] ?? Infinity));
  const p95s = steady.map((w) => w.cpuP95).sort((a, b) => a - b);
  await B(page, () => {
    Object.assign(window.__brain, { uncapped: false, paceMs: 1000 / 60 });
    window.__brain.resetCpu();
  });
  const full = await page.waitForFunction(() => window.__brain.cpuN >= 240, null, { timeout: 20000 }).then(() => true, () => false);
  const paced = await B(page, () => window.__brain.cpuP95);
  return { fps: best.fps, cpuP95: best.cpuP95, gpuBusyAtBest: best.gpu, medianFps: med.fps, pacedCpuP95: full ? paced : null, uncappedCpuP95: p95s[p95s.length >> 1], gpuMsMin: Number.isFinite(gpuMin) ? gpuMin : null, gpuMsMedian: med.gpuMs?.[1] ?? null };
}
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
/** a remount's engine is up: set window.__old = window.__brain before triggering it */
const fresh = (page) => page.waitForFunction(() => window.__brain && window.__brain !== window.__old && window.__brain.frames > 2, null, { timeout: 10000 });
async function fps(page, ms) {
  const f0 = await B(page, () => window.__brain.frames);
  await sleep(ms);
  const f1 = await B(page, () => window.__brain.frames);
  return ((f1 - f0) * 1000) / ms;
}

const perf = {};
const CASES = {
  async overview() {
    const { page, done } = await open('desktop x1 q=high', 'desktop', 'q=high', real);
    const info = await B(page, () => {
      const gl = window.__brain.gl;
      const e = gl.getExtension('WEBGL_debug_renderer_info');
      return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a';
    });
    console.log(`      GPU: ${info}; graph x1 ${real.nodes.length} nodes / ${real.links.length} links, baked xyz on ${hasXyz}`);
    await sleep(1500); // warm-up
    const ins = await B(page, () => window.__brain.insets);
    record(7.4, 'HUD insets measured (BrainScene reads .strip / .timeline from the DOM): top and bottom > 0', ins[0] > 0 && ins[1] > 0, ins);
    const hs = await B(page, () => window.__brain.hueStats());
    record(7, 'hues x1 default view: ≥97% of saturated px on palette', hs.onPalette >= 0.97, { onPalette: +hs.onPalette.toFixed(4), saturated: hs.saturated, blend: hs.blend, off: hs.off });
    record(5, 'hub not a white blob x1 (px ≥250 all channels < 0.5%)', hs.white250 < 0.005, `${(hs.white250 * 100).toFixed(3)}%`);
    await shot(page, '1-desktop-overview');
    // step 6: scene draw calls
    const calls = await B(page, () => window.__brain.calls);
    record(6, 'scene draw calls ≤ 8 (q=high)', calls <= 8, `${calls}`);
    // burst: 64 events incl. the biggest hub
    const ids = await B(page, (hub) => [hub, ...window.__brain.ids().filter((i) => i !== hub)].filter((_, i) => i % 7 === 0 || i === 0).slice(0, 64), hubId);
    await B(page, (ids) => window.__brain.fire(ids), ids);
    await sleep(350);
    await shot(page, '3-firing-burst');
    const hb = await B(page, () => window.__brain.hueStats());
    record(7, 'hues during burst (64 events): ≥97% on palette', hb.onPalette >= 0.97, { onPalette: +hb.onPalette.toFixed(4), saturated: hb.saturated, blend: hb.blend, white250: +(hb.white250 * 100).toFixed(3), off: hb.off });
    // camera: focus settles within FLY_MS + 200
    await sleep(2500);
    // timed in-page (rAF polling): CDP round trips would add ~100-250 ms of harness latency
    const settle = await B(page, (id) => new Promise((done) => {
      const t0 = performance.now();
      window.__brain.focus(id);
      const poll = () => (window.__brain.flying && performance.now() - t0 < 5000 ? requestAnimationFrame(poll) : done(Math.round(performance.now() - t0)));
      requestAnimationFrame(poll);
    }), hubId);
    record(7.1, 'camera: focus fly settles ≤ FLY_MS+200 (1700 ms)', settle <= 1700, `${settle} ms`);
    await sleep(400);
    await shot(page, '4-focused-node');
    // close-ups pick a clear line of sight: big neighbouring sessions once hid the selected one. Picking returns the
    // frontmost node under the pointer, so hovering the node's own screen point must return it
    const hidden = [];
    for (const id of real.nodes.filter((n) => n.type !== 'project').sort((a, b) => b.n - a.n).slice(0, 5).map((n) => n.id)) {
      await B(page, (id) => window.__brain.focus(id), id);
      await page.waitForFunction(() => !window.__brain.flying, null, { timeout: 5000, polling: 50 });
      await sleep(150);
      const q = await B(page, (id) => window.__brain.project(id), id);
      await page.mouse.move(q.x + 1, q.y + 1);
      await page.mouse.move(q.x, q.y);
      await sleep(100);
      const hov = await B(page, () => window.__brain.lastHover);
      if (hov !== id) hidden.push(`${id} under ${hov}`);
    }
    record(7.1, 'camera: a close-up of each of the 5 largest nodes shows it frontmost at its screen point', hidden.length === 0, hidden.join(' | ') || '5/5');
    // drag → onAutoFollowPause
    const c0 = await B(page, () => window.__brain.autoPauseCalls);
    await page.mouse.move(800, 450);
    await page.mouse.down();
    await page.mouse.move(900, 480, { steps: 6 });
    await page.mouse.up();
    const c1 = await B(page, () => ({ n: window.__brain.autoPauseCalls, until: window.__brain.pausedUntil }));
    record(7.2, 'camera: drag fires onAutoFollowPause', c1.n > c0 && c1.until > Date.now(), `${c1.n - c0} call(s), paused ${Math.round((c1.until - Date.now()) / 1000)} s`);
    await done();
  },

  async x4() {
    const before = await othersBusy();
    const { page, done } = await open('desktop x4 q=high', 'desktop', 'q=high', x4);
    const first = await B(page, () => window.__brain.firstFrameMs);
    await sleep(3500);
    perf.desktop = { ...(await perfWindows(page)), firstFrameMs: first };
    const hs = await B(page, () => window.__brain.hueStats());
    record(7, 'hues x4 default view: ≥97% on palette', hs.onPalette >= 0.97, { onPalette: +hs.onPalette.toFixed(4), saturated: hs.saturated, blend: hs.blend, off: hs.off });
    record(5, 'hub not a white blob x4', hs.white250 < 0.005, `${(hs.white250 * 100).toFixed(3)}%`);
    await shot(page, '2-desktop-x4');
    await done();
    perf.desktop.othersBusy = [before, await othersBusy()];
    perfGate('desktop', perf.desktop, 500, 2);
  },

  /** viewport changes after landing: the overview re-fits (portrait backs off 1.6×) instead of cutting off the sides */
  async rotate() {
    for (const [view, to] of [['mobileWide', { width: 390, height: 844 }], ['desktop', { width: 420, height: 900 }]]) {
      const { page, done } = await open(`rotate ${VIEWS[view].viewport.width}×${VIEWS[view].viewport.height} → ${to.width}×${to.height}`, view, 'q=medium', real);
      await sleep(2500);
      await page.setViewportSize(to);
      await sleep(2500); // a 1.5 s flight
      const on = await B(page, () => {
        const b = window.__brain;
        const p = b.ids().map((id) => b.project(id)).filter(Boolean);
        return p.filter((q) => q.onScreen).length / p.length;
      });
      record(7.3, `camera: ${VIEWS[view].viewport.width}×${VIEWS[view].viewport.height} → ${to.width}×${to.height} re-fits (≥ 99% of nodes on screen)`, on >= 0.99, `${(on * 100).toFixed(1)}%`);
      await done();
    }
  },

  /** narrow → wide leaves the camera beyond the new max zoom-out: the next follow flight eases in, never a one-frame jump */
  async widen() {
    const { page, done } = await open('widen 420 → 1440', 'narrow', 'q=medium', real);
    await sleep(2500);
    await page.setViewportSize({ width: 1440, height: 900 });
    await sleep(1000);
    const r = await B(page, (ids) => new Promise((res) => {
      const b = window.__brain;
      const d0 = b.distance;
      b.fire(ids);
      let prev = d0;
      let jump = 0;
      const t0 = performance.now();
      const poll = () => {
        const d = b.distance;
        jump = Math.max(jump, Math.abs(d / prev - 1));
        prev = d;
        if (performance.now() - t0 < 2500) requestAnimationFrame(poll);
        else res({ d0: +d0.toFixed(1), d1: +d.toFixed(1), maxStep: +(jump * 100).toFixed(2) });
      };
      requestAnimationFrame(poll);
    }), [hubId]);
    record(7.3, 'camera: 420 → 1440 wide, then a follow flight: distance never jumps > 2 % in one frame', r.maxStep <= 2, r);
    await done();
  },

  /** a theme switch mid-intro remounts the engine: the shot carries on and the landing still frames the whole brain */
  async introswitch() {
    for (const view of ['desktop', 'mobile']) {
      const { page, done } = await open(`intro theme switch ${view}`, view, view === 'desktop' ? 'q=high' : 'q=medium', real, { intro: true, theme: 'dark' });
      await page.waitForFunction(() => document.querySelector('.stage')?.dataset.phase === 'intro', null, { timeout: 30000, polling: 20 });
      await sleep(1500);
      await B(page, () => (window.__old = window.__brain));
      await page.click('.btn--theme');
      await fresh(page);
      const afterTheme = await B(page, () => window.__brain.shot);
      await B(page, () => (window.__old = window.__brain).remount()); // the governor's tier drop / context loss path
      await fresh(page);
      const afterDrop = await B(page, () => window.__brain.shot);
      record('i', `intro ${view}: a theme switch, then a tier-drop remount mid-intro: the camera shot carries on`, afterTheme && afterDrop, { afterTheme, afterDrop });
      await page.waitForFunction(() => document.querySelector('.caption--live'), null, { timeout: 30000, polling: 50 });
      const on = await B(page, () => {
        const b = window.__brain;
        const p = b.ids().map((id) => b.project(id)).filter(Boolean);
        return +(p.filter((q) => q.onScreen).length / p.length).toFixed(3);
      });
      record('i', `intro ${view}: theme switch at +1.5 s, the LIVE landing shows ≥ 99% of nodes`, on >= 0.99, `${(on * 100).toFixed(1)}%`);
      await shot(page, `11-intro-switch-${view}`);
      await done();
    }
  },

  /**
   * ▶ from LIVE / the end plays the intro's shot, after any remount too (it once read the mount-time view for the
   * engine's whole life); a remount mid-shot carries it on; reaching the end holds Follow (the last batch flew off it)
   */
  async shot() {
    const { page, done } = await open('▶ shot after remounts', 'desktop', 'q=high', real);
    await sleep(1500);
    const remount = async (how) => {
      await B(page, () => (window.__old = window.__brain));
      if (how === 'theme') await page.click('.btn--theme');
      else await B(page, () => window.__brain.remount());
      await fresh(page);
      await sleep(400);
    };
    const play = async () => {
      const d0 = await B(page, () => window.__brain.distance);
      await B(page, () => {
        const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
        vis('.seg__btn').find((x) => x.textContent.trim() === '16×').click(); // ≤ 10 s to the end
        vis('.btn--play')[0].click();
      });
      await sleep(300);
      return B(page, (d0) => ({ shot: window.__brain.shot, ratio: +(window.__brain.distance / d0).toFixed(2) }), d0);
    };
    await remount('theme');
    const a = await play();
    // 0.5 from an empty start; the nodes older than the replay domain widen it (the shot frames the born nodes)
    record('i', '▶ from LIVE after a theme switch: the shot plays (distance < 0.8 × overview at +300 ms)', a.shot && a.ratio < 0.8, a);
    await remount('drop');
    const carried = await B(page, () => window.__brain.shot);
    // timed in-page: the flight starts in the end commit itself
    const end = await B(page, () => new Promise((res) => {
      const btn = [...document.querySelectorAll('.btn--play')].find((x) => x.getClientRects().length);
      const t0 = performance.now();
      const wait = () => {
        if (btn.getAttribute('aria-label') !== 'เล่นซ้ำ') return void (performance.now() - t0 > 30000 ? res(null) : requestAnimationFrame(wait));
        const b = window.__brain;
        const t = b.target;
        const t1 = performance.now();
        let flew = false;
        let moved = 0;
        const poll = () => {
          flew ||= b.flying;
          moved = Math.max(moved, Math.hypot(...b.target.map((v, i) => v - t[i])));
          if (performance.now() - t1 < 1500) requestAnimationFrame(poll);
          else res({ flew, moved: +moved.toFixed(4), shot: b.shot, follow: document.querySelector('[aria-pressed][title^="กล้องตาม"]')?.getAttribute('aria-pressed') });
        };
        poll();
      };
      wait();
    }));
    record('i', '▶ from LIVE: a tier-drop remount mid-shot carries it on; the end holds still 1.5 s under ติดตาม (no flight, same target)', carried && end && !end.flew && end.moved < 1e-3 && !end.shot && end.follow === 'true', { carried, end });
    await remount('drop');
    const b = await play();
    record('i', '▶ from the end after a tier-drop remount: the shot plays again', b.shot && b.ratio < 0.8, b);
    await done();
  },

  async firstframe() {
    const { page, done } = await open('desktop x1 first frame', 'desktop', 'q=high', real);
    const first = await B(page, () => window.__brain.firstFrameMs);
    perf.desktopFirstFrameX1 = first;
    record(5, 'firstFrameMs desktop x1 ≤ 500', first <= 500, `${first} ms`);
    await done();
  },

  async mobile() {
    const { page, done } = await open('mobile x1 q=medium', 'mobile', 'q=medium', real);
    const first = await B(page, () => window.__brain.firstFrameMs);
    perf.mobileFirstFrameX1 = first;
    record(5, 'firstFrameMs mobile x1 ≤ 1500', first <= 1500, `${first} ms`);
    await sleep(4000);
    const scroll = await B(page, () => ({ sw: document.scrollingElement.scrollWidth, w: innerWidth }));
    record('m', 'mobile: no horizontal scroll', scroll.sw <= scroll.w, scroll);
    const ins = await B(page, () => window.__brain.insets);
    record(7.4, 'HUD insets measured on a phone: top and bottom > 0', ins[0] > 0 && ins[1] > 0, ins);
    await shot(page, '6-mobile-portrait');
    await done();
  },

  /** both themes on 390×844 and 390×664 (4× CPU throttle): the governor must not drop q=medium, no horizontal scroll */
  async mobilethemes() {
    for (const theme of ['dark', 'light']) {
      for (const view of ['mobile', 'mobileShort']) {
        const { page, done } = await open(`mobile ${theme} ${VIEWS[view].viewport.height}`, view, 'q=medium', real, { theme });
        await sleep(9000); // warm-up 3 s + two 2 s governor windows + probe
        const r = await B(page, () => ({ theme: document.documentElement.dataset.theme, tier: window.__brain.tier, sw: document.scrollingElement.scrollWidth, w: innerWidth }));
        record('m', `mobile ${theme} 390×${VIEWS[view].viewport.height}: tier holds medium, no horizontal scroll`, r.theme === theme && r.tier === 'medium' && r.sw <= r.w, r);
        await shot(page, `6-mobile-${theme}-${VIEWS[view].viewport.height}`);
        await done();
      }
    }
  },

  /** runtime switch: fresh engine on the same view and tier, page background follows, and back again */
  async themeswitch() {
    const { page, done } = await open('theme switch', 'desktop', 'q=high', real);
    await sleep(1500); // warm-up
    await page.getByRole('button', { name: 'ติดตาม' }).click(); // no idle orbit: the view must carry over exactly
    await sleep(600);
    for (const [to, label] of [['light', 'เปลี่ยนเป็นธีมสว่าง'], ['dark', 'เปลี่ยนเป็นธีมมืด']]) {
      const cam0 = await B(page, () => window.__brain.camera());
      const gl0 = await page.evaluateHandle(() => window.__brain.gl);
      await page.getByRole('button', { name: label }).click();
      await page.waitForFunction((old) => window.__brain && window.__brain.gl !== old && window.__brain.frames > 2, gl0, { timeout: 5000 });
      await sleep(400); // canvas fade-in 300 ms
      const r = await B(page, () => ({ theme: document.documentElement.dataset.theme, stored: localStorage.getItem('mh-theme'), meta: document.querySelector('meta[name="theme-color"]')?.content, tier: window.__brain.tier, cam: window.__brain.camera(), css: getComputedStyle(document.querySelector('.scene')).backgroundColor, bg: window.__brain.pixel(innerWidth * 0.15, innerHeight * 0.5) }));
      const moved = Math.hypot(...[12, 13, 14].map((i) => r.cam[i] - cam0[i])) / Math.hypot(cam0[12], cam0[13], cam0[14]);
      // the canvas pixel only on light: dark has vignette + dust there (the probe case checks dark exactly)
      const bgOk = r.css === `rgb(${rgb(BG[to]).join(', ')})` && (to === 'dark' || r.bg.every((v, i) => Math.abs(v - rgb(BG[to])[i]) <= 2));
      record(10, `theme switch → ${to}: new engine, same tier + view, background ${BG[to]}`, r.theme === to && r.stored === to && r.meta === BG[to] && r.tier === 'high' && moved < 1e-3 && bgOk, { ...r, cam: undefined, moved: +moved.toFixed(5) });
      if (to === 'light') await shot(page, '10-theme-light');
    }
    await done();
  },

  async mobilex4() {
    const before = await othersBusy();
    const { page, done } = await open('mobile x4 q=medium', 'mobile', 'q=medium', x4);
    const first = await B(page, () => window.__brain.firstFrameMs);
    await sleep(3500);
    perf.mobile = { ...(await perfWindows(page)), firstFrameMs: first };
    await done();
    perf.mobile.othersBusy = [before, await othersBusy()];
    perfGate('mobile (4× CPU throttle, q=medium)', perf.mobile, 240, 8);
  },

  async probe() {
    for (const [theme, q] of [['dark', 'low'], ['dark', 'high'], ['light', 'low'], ['light', 'high']]) {
      const { page, done } = await open(`probe ${theme} q=${q}`, 'desktop', `q=${q}&probe=1`, probe, { theme });
      await sleep(500);
      const px = await B(page, (types) => {
        const out = {};
        for (const t of types) {
          const p = window.__brain.project(`probe-${t}`);
          out[t] = p ? window.__brain.pixel(p.x, p.y) : null;
        }
        out.background = window.__brain.pixel(innerWidth * 0.15, innerHeight * 0.5);
        return out;
      }, PROBE_TYPES);
      const want = { ...Object.fromEntries(PROBE_TYPES.map((t) => [t, rgb(FAMILY[t])])), background: rgb(BG[theme]) };
      const bad = Object.entries(want).filter(([k, w]) => !px[k] || px[k].some((v, i) => Math.abs(v - w[i]) > 2));
      record(6, `palette probe ${theme} q=${q}: 5 types + background ${BG[theme]} within ±2/255`, bad.length === 0, bad.length ? bad.map(([k]) => `${k} got ${px[k]} want ${want[k]}`).join('; ') : 'exact');
      if (theme === 'dark' && q === 'high') {
        // picking: mouse on the subagent's projected centre
        const p = await B(page, () => window.__brain.project('probe-subagent'));
        await page.mouse.move(p.x, p.y);
        await sleep(150);
        const hov = await B(page, () => window.__brain.lastHover);
        record(8, 'pick: mouse at projected position hovers that node', hov === 'probe-subagent', `${hov}`);
        await page.mouse.click(p.x, p.y);
        await sleep(100);
        const sel = await B(page, () => window.__brain.lastSelect);
        const panel = await page.locator('section.details').count();
        record(8, 'pick: click calls onSelect (details panel open)', sel === 'probe-subagent' && panel === 1, `${sel}, panel ${panel}`);
      }
      await done();
    }
    const { page, done } = await open('probe mobile tap', 'mobile', 'q=medium&probe=1', probe);
    await sleep(500);
    const p = await B(page, () => window.__brain.project('probe-subagent'));
    await page.touchscreen.tap(p.x + 20, p.y);
    await sleep(200);
    const sel = await B(page, () => window.__brain.lastSelect);
    record(8, 'pick: touch tap 20 px away still hits', sel === 'probe-subagent', `${sel}`);
    await done();
  },

  async reduced() {
    const { page, done } = await open('reduced motion', 'desktop', 'q=high', real, { reduced: true });
    await sleep(2000);
    const f0 = await B(page, () => window.__brain.frames);
    await sleep(3000);
    const f1 = await B(page, () => window.__brain.frames);
    record(8, 'reduced motion: < 5 frames over 3 s idle', f1 - f0 < 5, `${f1 - f0} frames`);
    const a = await B(page, () => window.__brain.checksum());
    await sleep(1000);
    const b = await B(page, () => window.__brain.checksum());
    record(8, 'reduced motion: two readbacks 1 s apart identical', a === b, `${a} vs ${b}`);
    const cam0 = await B(page, () => window.__brain.camera());
    await B(page, (hub) => window.__brain.fire([hub, ...window.__brain.ids().slice(0, 40)]), hubId);
    await sleep(1200);
    const cam1 = await B(page, () => window.__brain.camera());
    record(8, 'reduced motion: camera static after an event batch', cam0.every((v, i) => v === cam1[i]), '');
    await shot(page, '8-reduced-motion');
    await done();
  },

  async tiers() {
    for (const q of ['low', 'medium', 'high', 'ultra']) {
      const { page, done } = await open(`q=${q}`, 'desktop', `q=${q}`, real);
      await sleep(3000);
      const r = await B(page, () => ({ tier: window.__brain.tier, calls: window.__brain.calls }));
      record(6, `q=${q} renders, scene draw calls ≤ 8`, r.tier === q && r.calls <= 8, r);
      if (q === 'low') await shot(page, '7-q-low');
      if (q === 'ultra') await shot(page, '9-q-ultra');
      await done();
    }
  },

  async replay() {
    const { page, done } = await open('replay ~25%', 'desktop', 'q=high', real);
    await sleep(3000);
    // a focus close-up (tap, panel, list) must not stick under Follow: scrub back and the next batch return to the overview
    const shown = () => B(page, () => {
      const ids = window.__brain.ids();
      return +(ids.filter((i) => window.__brain.project(i)?.onScreen).length / ids.length).toFixed(3);
    });
    const newest = real.nodes.filter((n) => n.type === 'memory' || n.type === 'note').reduce((a, b) => (b.t0 > a.t0 ? b : a)).id;
    await B(page, (id) => window.__brain.focus(id), newest);
    await sleep(1800);
    const closeUp = await shown();
    const box = await page.locator('[aria-label="ตำแหน่งเล่นซ้ำ"]').boundingBox();
    const total = real.nodes.length;
    let lo = 0;
    let hi = 1;
    let frac = 0;
    for (let i = 0; i < 8; i++) {
      const k = (lo + hi) / 2;
      await page.mouse.click(box.x + k * box.width, box.y + box.height / 2);
      await sleep(250);
      frac = (await B(page, () => window.__brain.live)) / total;
      if (Math.abs(frac - 0.25) < 0.05) break;
      if (frac < 0.25) lo = k;
      else hi = k;
    }
    await sleep(1800);
    record('r', 'replay scrubbed to ~25% growth', Math.abs(frac - 0.25) < 0.08, `${(frac * 100).toFixed(1)}% of nodes live`);
    const afterScrub = await shown();
    record(7.3, 'camera: scrub back after a focus close-up shows ≥ 90% of live nodes', afterScrub >= 0.9, { closeUp, afterScrub });
    await shot(page, '5-replay-25pct');
    const live = await B(page, () => window.__brain.ids());
    await B(page, (id) => window.__brain.focus(id), live[live.length - 1]);
    await sleep(4200); // FLY_EVERY_MS since the focus flight
    const focused = await shown();
    await B(page, (ids) => window.__brain.fire(ids), live.slice(0, 5));
    await sleep(1800);
    const afterBatch = await shown();
    // follow centres the batch node (not the centroid) at ≥ 2.2R, so part of the brain may sit off-screen: 89% measured
    record(7.3, 'camera: follow batch after a focus close-up shows ≥ 75% of live nodes', afterBatch >= 0.75, { focused, afterBatch });
    await done();
  },

  /** page-load intro: replays from the start at 16× and goes LIVE by itself ≤ 10 s; Esc at 1 s → LIVE ≤ 1 s; reduced motion opens in LIVE */
  async intro() {
    const total = real.nodes.length;
    // nodes older than the 150-day replay domain (imported GitHub history) are there from the start
    const preBorn = real.nodes.filter((n) => n.t0 - 600 < real.at - 150 * 86400).length;
    const state = (page) => B(page, () => ({ phase: document.querySelector('.stage').dataset.phase ?? null, pill: document.querySelector('.pill').dataset.state, live: window.__brain.live, caption: document.querySelector('.caption')?.innerText ?? null }));
    // ms from the first frame with nodes (≈ data ready) until the pill says สด and the intro phase is gone; timed in-page
    const untilLive = (page) => B(page, () => new Promise((res) => {
      const poll = () => {
        const ms = performance.now() - window.__brain.firstFrameMs;
        if (document.querySelector('.pill').dataset.state === 'live' && !document.querySelector('.stage').dataset.phase) res(Math.round(ms));
        else if (ms > 20000) res(null);
        else requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }));
    // share of the born nodes on screen and not under a shown HUD panel, `ms` after the first frame with nodes (≈ the
    // intro's start); timed in-page
    const visibleAt = (page, ms) => B(page, (ms) => new Promise((res) => {
      const poll = () => {
        const b = window.__brain;
        if (performance.now() - b.firstFrameMs < ms) return void requestAnimationFrame(poll);
        const boxes = [...document.querySelectorAll('.hud .panel')].filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').map((el) => el.getBoundingClientRect());
        const ps = b.ids().map((id) => b.project(id)).filter(Boolean);
        const ok = ps.filter((q) => q.onScreen && !boxes.some((r) => q.x >= r.left && q.x <= r.right && q.y >= r.top && q.y <= r.bottom)).length;
        res({ phase: document.querySelector('.stage').dataset.phase ?? null, born: ps.length, visible: +(ok / ps.length).toFixed(3) });
      };
      poll();
    }), ms);
    for (const [view, theme] of [['desktop', 'dark'], ['mobile', 'dark'], ['mobile', 'light']]) {
      const name = `${view}-${theme}`;
      const { page, done } = await open(`intro ${name}`, view, view === 'desktop' ? 'q=high' : 'q=medium', real, { intro: true, theme });
      await sleep(500);
      const s0 = await state(page);
      await shot(page, `11-intro-${name}-0.5s`);
      // the opening shot once stayed on the first cluster while the main project's burst was born off screen / under the timeline
      const seen = await visibleAt(page, 1500);
      record('i', `intro ${name} at +1.5 s: the shot follows the births, ≥ 75 % of the born nodes on screen and clear of the HUD panels`, seen.phase === 'intro' && seen.visible >= 0.75, seen);
      await sleep(1500);
      const mid = await state(page);
      await shot(page, `11-intro-${name}-mid`);
      const ms = await untilLive(page);
      // the reveal holds: no follow flight in the 1.5 s after landing (the landing batch once flew the camera off it)
      const flew = await B(page, () => new Promise((res) => {
        const t0 = performance.now();
        const poll = () => (window.__brain.flying ? res(true) : performance.now() - t0 > 1500 ? res(false) : requestAnimationFrame(poll));
        poll();
      }));
      const s1 = await state(page); // the LIVE caption is still up (fades after 1.8 s)
      await shot(page, `11-intro-${name}-live`);
      record('i', `intro ${name}: starts replaying (phase intro, few nodes), LIVE by itself ≤ 10 s with every node, no flight for 1.5 s after`, s0.phase === 'intro' && s0.pill === 'replay' && s0.live < preBorn + 0.05 * total && ms !== null && ms <= 10000 && s1.live === total && s1.phase === null && !flew, { at500ms: s0, mid, liveAfterMs: ms, flew, after: s1 });
      await done();
    }
    {
      const { page, done } = await open('intro Esc', 'desktop', 'q=high', real, { intro: true });
      await sleep(1000);
      const t0 = Date.now();
      await page.keyboard.press('Escape');
      const ok = await page.waitForFunction(() => document.querySelector('.pill').dataset.state === 'live', null, { timeout: 1000 }).then(() => true, () => false);
      record('i', 'intro: Esc at 1 s reaches LIVE ≤ 1 s', ok && (await state(page)).live === total, `${Date.now() - t0} ms`);
      await done();
    }
    {
      // a camera drag ends only the choreography (the replay still lands in LIVE); pause hands the clock over (no auto-LIVE)
      const { page, done } = await open('intro drag', 'desktop', 'q=high', real, { intro: true });
      await sleep(1000);
      await page.mouse.move(800, 450);
      await page.mouse.down();
      await page.mouse.move(900, 480, { steps: 6 });
      await page.mouse.up();
      const ms = await untilLive(page);
      record('i', 'intro: a camera drag still lands in LIVE ≤ 10 s', ms !== null && ms <= 10000, `${ms} ms`);
      await done();
    }
    {
      const { page, done } = await open('intro pause', 'desktop', 'q=high', real, { intro: true });
      await sleep(1000);
      await page.getByRole('button', { name: 'หยุดเล่นซ้ำ' }).click();
      await sleep(9000);
      const s = await state(page);
      record('i', 'intro: pause hands the clock over (no auto-LIVE, phase gone)', s.phase === null && s.pill === 'replay' && s.live < total && s.caption === null, s);
      await done();
    }
    {
      const { page, done } = await open('intro reduced motion', 'desktop', 'q=high', real, { intro: true, reduced: true });
      await page.waitForFunction(() => document.querySelector('.pill').dataset.state === 'live', null, { timeout: 5000 }).catch(() => {});
      const s = await state(page);
      record('i', 'intro under reduced motion: opens in LIVE, no replay, no caption', s.phase === null && s.pill === 'live' && s.live === total && s.caption === null, s);
      await shot(page, '11-intro-reduced');
      await done();
    }
  },

  /**
   * The reveal holds the camera: the hidden side panel's column is reserved from the intro's first frame (measured only
   * at LIVE it slid the brain ~160 px on desktop and flew a portrait tablet back out). Short viewports (≤ 480 px tall)
   * hide the timeline in the intro and frame the brain above the caption, which once covered ~75 % of the born nodes.
   */
  async reveal() {
    for (const view of ['laptop', 'tablet']) {
      const { page, done } = await open(`reveal ${view}`, view, 'q=high', real, { intro: true });
      // in-page per frame: the projected centroid of the last intro frame vs 0.6 s after the LIVE caption appeared (the
      // slide took ~0.4 s; later the idle orbit drifts it), flights for 2 s
      const r = await B(page, () => new Promise((res) => {
        let land = null;
        let before = null;
        let flew = false;
        let moved = null;
        // the same nodes before and after: the landing batch's births would move an all-nodes centroid by itself
        let sample = [];
        const centroid = () => {
          const b = window.__brain;
          if (land === null) sample = b.ids().filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 300)) === 0);
          let [x, y, n] = [0, 0, 0];
          for (const id of sample) {
            const q = b.project(id);
            if (q) [x, y, n] = [x + q.x, y + q.y, n + 1];
          }
          return [x / n, y / n];
        };
        const t0 = performance.now();
        const tick = () => {
          const t = performance.now();
          if (land === null && document.querySelector('.caption--live')) land = t;
          const c = centroid();
          if (land === null) before = c;
          else flew ||= window.__brain.flying;
          if (land !== null && moved === null && t - land >= 600) moved = Math.round(Math.hypot(c[0] - before[0], c[1] - before[1]));
          if (land !== null && t - land >= 2000) return res({ moved, flew });
          if (t - t0 > 30000) return res(null);
          requestAnimationFrame(tick);
        };
        tick();
      }));
      record('i', `reveal ${view}: no flight within 2 s of landing, the brain's centroid moves < 40 px by +0.6 s`, !!r && !r.flew && r.moved < 40, r);
      await done();
    }
    {
      const { page, done } = await open('short intro 844×390', 'mobileWide', 'q=medium', real, { intro: true });
      await page.waitForFunction(() => document.querySelector('.stage')?.dataset.phase === 'intro', null, { timeout: 30000, polling: 20 });
      await sleep(3000);
      const r = await B(page, () => {
        const b = window.__brain;
        const boxes = [...document.querySelectorAll('.caption, .timeline')].filter((el) => el.getClientRects().length).map((el) => el.getBoundingClientRect());
        const ps = b.ids().map((id) => b.project(id)).filter(Boolean);
        const under = ps.filter((q) => boxes.some((r) => q.x >= r.left && q.x <= r.right && q.y >= r.top && q.y <= r.bottom)).length;
        const sk = document.querySelector('.caption__skip').getBoundingClientRect();
        const hit = document.elementFromPoint(sk.x + sk.width / 2, sk.y + sk.height / 2);
        return { phase: document.querySelector('.stage').dataset.phase, under: +(under / ps.length).toFixed(3), skipHit: !!hit?.closest('.caption__skip'), overflow: document.querySelector('.hud').scrollHeight - innerHeight };
      });
      record('i', 'short intro 844×390 at +3 s: < 40 % of the born nodes under the caption / timeline, ข้าม on top and in view', r.phase === 'intro' && r.under < 0.4 && r.skipHit && r.overflow <= 0, r);
      await shot(page, '11-intro-short-844');
      // a tap focuses ข้าม too (Chrome): the keyboard hand-off to สด once scrolled the HUD column and put the timeline over the reveal
      await page.tap('.caption__skip');
      await sleep(2500);
      const t = await B(page, () => {
        const b = window.__brain;
        const tl = document.querySelector('.timeline').getBoundingClientRect();
        const ps = b.ids().map((id) => b.project(id)).filter(Boolean);
        const under = ps.filter((q) => q.x >= tl.left && q.x <= tl.right && q.y >= tl.top && q.y <= tl.bottom).length;
        return { phase: document.querySelector('.stage').dataset.phase ?? null, scroll: Math.round(document.querySelector('.hud').scrollTop), under: +(under / ps.length).toFixed(3) };
      });
      record('i', 'short 844×390: a tap on ข้าม lands with the HUD column unscrolled, < 10 % of the nodes under the timeline', t.phase === null && t.scroll < 8 && t.under < 0.1, t);
      await shot(page, '11-intro-short-844-tap');
      await done();
    }
    {
      // a node tapped during the intro opens the details panel in the caption's grid cell: the caption once covered its buttons
      const { page, done } = await open('intro pick 768×1024', 'tablet', 'q=high', real, { intro: true });
      await page.waitForFunction(() => document.querySelector('.stage')?.dataset.phase === 'intro', null, { timeout: 30000, polling: 20 });
      await sleep(1500);
      const p = await B(page, () => {
        const b = window.__brain;
        return b.ids('project').map((id) => b.project(id)).find((q) => q?.onScreen) ?? null;
      });
      if (p) await page.touchscreen.tap(p.x, p.y);
      await page.waitForSelector('.details .btn', { timeout: 3000 }).catch(() => {});
      const r = await B(page, () => ({
        phase: document.querySelector('.stage').dataset.phase ?? null,
        onTop: [...document.querySelectorAll('.details .btn')].map((el) => {
          const q = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(q.x + q.width / 2, q.y + q.height / 2));
        }),
      }));
      record('i', 'intro 768×1024: a node tapped mid-intro opens details with every button on top (not under the caption)', r.phase === 'intro' && r.onTop.length >= 2 && r.onTop.every(Boolean), r);
      await shot(page, '11-intro-pick-tablet');
      await done();
    }
  },

  async robustness() {
    // governor: fake 40 ms frames → tier drops, persists, never comes back up
    {
      const { page, done } = await open('governor', 'desktop', 'q=high', real);
      await B(page, () => (window.__brain.debugSlowMs = 40));
      await page.waitForFunction(() => window.__brain?.tier !== 'high', null, { timeout: 20000 }).catch(() => {});
      const r = await B(page, () => ({ tier: window.__brain?.tier, stored: localStorage.getItem('brainTier') }));
      await page.goto(`${ORIGIN}/?debug=1&intro=0`); // no ?q → the persisted tier must win (locked)
      await page.waitForFunction(() => window.__brain?.firstFrameMs != null, null, { timeout: 30000 });
      const after = await B(page, () => window.__brain.tier);
      record(9, 'governor: debugSlowMs=40 drops tier, persists, sticks on reload', r.tier !== 'high' && r.stored === r.tier && after === r.tier, { ...r, afterReload: after });
      await B(page, () => localStorage.removeItem('brainTier'));
      await done();
    }
    // context loss → remount on a fresh canvas
    {
      const { page, done } = await open('context loss', 'desktop', 'q=high', real, { allowWarn: /CONTEXT_LOST|loseContext/ });
      await sleep(1500);
      await B(page, () => {
        window.__lost = window.__brain.gl.getExtension('WEBGL_lose_context');
        window.__lost.loseContext();
      });
      await sleep(300);
      await B(page, () => {
        try {
          window.__lost.restoreContext();
        } catch {
          /* old context already disposed by the remount */
        }
      });
      const t0 = Date.now();
      const ok = await page
        .waitForFunction(() => window.__brain && window.__brain.frames > 2 && !window.__brain.gl.isContextLost(), null, { timeout: 2000 })
        .then(() => true)
        .catch(() => false);
      record(9, 'context loss: frames resume within 2 s', ok, `${Date.now() - t0} ms`);
      await done();
    }
    // display:none for 2 s and back
    {
      const { page, done, errors } = await open('display:none', 'desktop', 'q=high', real);
      await sleep(1500);
      await B(page, () => (document.querySelector('.scene').style.display = 'none'));
      await sleep(2000);
      await B(page, () => (document.querySelector('.scene').style.display = ''));
      const f = await fps(page, 1000);
      record(9, 'display:none 2 s and back: resumes, no errors', f > 10 && errors.length === 0, `${f.toFixed(0)} fps after`);
      await done();
    }
  },

  /** "ระบบนี้ทำงานยังไง?" by keyboard: focus lands on ปิด, Tab reaches the heatmap slider (← = a week), Esc closes it and
   *  focus returns to the opener. On a 360 px phone the sheet opens without horizontal scroll and the brain keeps a band */
  async how() {
    const OPEN = 'ระบบนี้ทำงานยังไง?';
    const active = () => B(page, () => ({ how: !!document.activeElement?.closest('#how'), role: document.activeElement?.getAttribute('role'),
      text: document.activeElement?.textContent.trim(), now: Number(document.activeElement?.getAttribute('aria-valuenow')) }));
    let { page, done } = await open('how panel keyboard', 'laptop', 'q=medium', real);
    await page.getByRole('button', { name: OPEN }).focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#how');
    const first = await active();
    record('h', 'how panel: Enter opens it, focus on ปิด', first.how && first.text === 'ปิด', first);
    let slider = first;
    for (let i = 0; i < 40 && !(slider.how && slider.role === 'slider'); i++) {
      await page.keyboard.press('Tab');
      slider = await active();
    }
    await page.keyboard.press('ArrowLeft');
    const after = await active();
    record('h', 'how panel: Tab reaches the heatmap slider, ← steps a week', slider.role === 'slider' && after.now === slider.now - 7, `${slider.now} → ${after.now}`);
    await page.keyboard.press('Escape');
    await sleep(300);
    const back = await active();
    const gone = await B(page, () => !document.getElementById('how'));
    record('h', 'how panel: Esc closes it, focus back on the opener', gone && back.text === OPEN, back);
    await done();

    ({ page, done } = await open('how panel 360', 'mobile360', 'q=medium', real));
    await page.getByRole('button', { name: OPEN }).click();
    await page.waitForSelector('#how');
    await sleep(1500); // BrainScene re-frames above the sheet
    const r = await B(page, () => ({ ins: window.__brain.insets, sw: document.scrollingElement.scrollWidth, w: innerWidth }));
    record('h', 'how sheet on 360 px: insets > 0, no horizontal scroll', r.ins[0] > 0 && r.ins[1] > 0 && r.sw <= r.w, r);
    await shot(page, 'h-how-360');
    await done();
  },
  /**
   * "จัดตามความหมาย" (semantic lens): the toggle moves sampled nodes onto their `s` within 2 s and back onto `xyz`; a
   * click after the morph selects the node under it (picking uses the morphed positions); reduced motion = a cut (every
   * rendered frame has uMorph 0 or 1); the intro holds it off until LIVE; a theme remount lands on it with no morph.
   * Frame cost during the morph at 1440 and on a 4× CPU throttled phone; screenshots off / on / + สีตาม AI, both themes.
   */
  async semantic() {
    const SEM = 'จัดตามความหมาย';
    const byId = new Map(real.nodes.map((n) => [n.id, n]));
    const withS = real.nodes.filter((n) => n.s && n.type !== 'project');
    const sample = withS.filter((_, i) => i % 97 === 0).map((n) => n.id);
    const hidden = real.nodes.filter((n) => !n.s || n.type === 'project').map((n) => n.id);
    const near = (p, q) => !!p && !!q && Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.5;
    const toggle = (page, name = SEM) => page.getByRole('button', { name, exact: true }).first().click();
    // ms from now until every sampled node is drawn at its `key` position (s | xyz), null after 3 s
    const reach = async (page, key) => {
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) {
        const ps = await B(page, (ids) => ids.map((id) => window.__brain.pos(id)), sample);
        if (ps.every((p, i) => near(p, byId.get(sample[i])[key]))) return Date.now() - t0;
        await sleep(25);
      }
      return null;
    };
    const settled = (page) => page.waitForFunction(() => !window.__brain.flying && (window.__brain.morph === 0 || window.__brain.morph === 1), null, { timeout: 5000 });
    // frames and CPU ms per frame (paced at 60 Hz: the harness's Chrome has no vsync) over one morph
    const morphCost = async (page, key) => {
      await B(page, () => {
        Object.assign(window.__brain, { holdTier: true, paceMs: 1000 / 60 });
        window.__brain.resetCpu();
      });
      const f0 = await B(page, () => window.__brain.frames);
      const t0 = Date.now();
      await toggle(page);
      const ms = await reach(page, key);
      const [f1, n, p95, mean] = await B(page, () => [window.__brain.frames, window.__brain.cpuN, window.__brain.cpuP95, window.__brain.cpuMs]);
      const trace = await B(page, () => window.__brain.morphTrace);
      return { ms, fps: Math.round(((f1 - f0) * 1000) / (Date.now() - t0)), frames: n, cpuP95: p95, cpuMean: mean, steps: trace.filter((v) => v > 0 && v < 1).length };
    };

    // ── 1440×900: morph there and back, pick, combine with สีตาม AI ──
    for (const theme of ['dark', 'light']) {
      const { page, done } = await open(`semantic 1440 ${theme}`, 'laptop', 'q=high', real, { theme });
      await sleep(1500);
      await shot(page, `sem-1440-${theme}-0-off`);
      const on = await morphCost(page, 's');
      record('sem', `${theme} 1440: toggling moves the nodes onto s within 2 s, eased (intermediate frames)`, on.ms !== null && on.ms <= 2000 && on.steps > 5, on);
      if (theme === 'dark') record('sem', '1440 morph frame cost: ≥ 30 fps, CPU p95 ≤ 4 ms', on.fps >= 30 && on.cpuP95 <= 4, on);
      await settled(page);
      const hid = await B(page, (ids) => ids.filter((id) => window.__brain.shown(id) === 0).length, hidden);
      record('sem', `${theme} 1440: nodes without s and project hubs shrink away (all ${hidden.length})`, hid === hidden.length, { hid });
      await shot(page, `sem-1440-${theme}-1-on`);
      await toggle(page, 'สีตาม AI');
      await sleep(400);
      await shot(page, `sem-1440-${theme}-2-on-ai`);
      // picking after the morph: close up on a node by meaning (a view no other node blocks), then click where it is drawn
      const id = sample[3];
      await B(page, (id) => window.__brain.focus(id), id);
      await sleep(100);
      await settled(page);
      const at = await B(page, (id) => window.__brain.project(id), id);
      await page.mouse.click(at.x, at.y);
      await sleep(150);
      const picked = await B(page, () => window.__brain.lastSelect);
      record('sem', `${theme} 1440: a click after the morph selects the node under the cursor`, picked === id, { id, at, picked });
      await page.keyboard.press('Escape');
      await toggle(page);
      const off = await reach(page, 'xyz');
      record('sem', `${theme} 1440: toggling again moves them back onto xyz within 2 s`, off !== null && off <= 2000, { off });
      if (theme === 'dark') {
        // theme remount with the lens on: the new engine lands on it, no morph frames
        await toggle(page);
        await reach(page, 's');
        await B(page, () => (window.__old = window.__brain));
        await page.click('.btn--theme');
        await fresh(page);
        const r = await B(page, () => ({ trace: window.__brain.morphTrace, morph: window.__brain.morph }));
        record('sem', 'theme switch with the lens on: the remounted engine starts on s (every frame uMorph = 1)', r.morph === 1 && r.trace.length > 0 && r.trace.every((v) => v === 1), { frames: r.trace.length, morph: r.morph });
        record('sem', 'theme switch: nodes still on s', (await reach(page, 's')) !== null, '');
      }
      await done();
    }

    // ── reduced motion: a cut ──
    {
      const { page, done } = await open('semantic reduced', 'laptop', 'q=high', real, { reduced: true });
      await toggle(page);
      const ms = await reach(page, 's');
      await sleep(300);
      const trace = await B(page, () => window.__brain.morphTrace);
      record('sem', 'reduced motion: no intermediate frames (uMorph only 0 / 1), on s at once', ms !== null && ms < 500 && trace.length > 0 && trace.every((v) => v === 0 || v === 1), { ms, frames: trace.length, values: [...new Set(trace)] });
      await done();
    }

    // ── intro: held off until LIVE ──
    {
      const { page, done } = await open('semantic intro', 'laptop', 'q=high', real, { intro: true });
      await page.waitForFunction(() => document.querySelector('.stage').dataset.phase === 'intro', null, { timeout: 10000 });
      await toggle(page);
      await sleep(600);
      const during = await B(page, () => ({ morph: window.__brain.morph, phase: document.querySelector('.stage').dataset.phase ?? null }));
      await page.keyboard.press('Escape');
      const after = await reach(page, 's');
      record('sem', 'intro: the lens waits for LIVE (uMorph 0 mid-intro), then morphs onto s', during.phase === 'intro' && during.morph === 0 && after !== null, { during, after });
      await done();
    }

    // ── phones: 390×844 (4× CPU throttle) both themes, 360 strip wrap ──
    for (const theme of ['dark', 'light']) {
      const { page, done } = await open(`semantic 390 ${theme}`, 'mobile', 'q=medium', real, { theme });
      await sleep(1500);
      await shot(page, `sem-390-${theme}-0-off`);
      const on = await morphCost(page, 's');
      record('sem', `${theme} 390 (4× CPU): onto s within 2 s${theme === 'dark' ? ', ≥ 24 fps, CPU p95 ≤ 12 ms' : ''}`, on.ms !== null && on.ms <= 2000 && (theme !== 'dark' || (on.fps >= 24 && on.cpuP95 <= 12)), on);
      await settled(page);
      await shot(page, `sem-390-${theme}-1-on`);
      await toggle(page, 'สีตาม AI');
      await sleep(600);
      await shot(page, `sem-390-${theme}-2-on-ai`);
      await done();
    }
    // ── 360 / 844×390 landscape / 768 tablet: strip in one row, the เชื่อม step's toggle in the how panel works ──
    for (const view of ['mobile360', 'mobileWide', 'tablet']) {
      const { page, done } = await open(`semantic ${view}`, view, 'q=medium', real);
      const r = await B(page, () => ({ sw: document.scrollingElement.scrollWidth, w: innerWidth, btns: [...document.querySelectorAll('.howrow__btns .btn')].map((b) => b.getBoundingClientRect().right <= innerWidth), tops: new Set([...document.querySelectorAll('.howrow__btns .btn')].map((b) => b.offsetTop)).size }));
      record('sem', `${view}: the three strip buttons fit in one row, no horizontal scroll`, r.sw <= r.w && r.btns.length === 3 && r.btns.every(Boolean) && r.tops === 1, r);
      await page.getByRole('button', { name: 'ระบบนี้ทำงานยังไง?' }).click();
      await page.waitForSelector('#how');
      const more = page.locator('#how .flow__more');
      await more.scrollIntoViewIfNeeded();
      await more.getByRole('button', { name: SEM, exact: true }).click();
      const ms = await reach(page, 's');
      const pressed = await B(page, () => [...document.querySelectorAll('[aria-pressed]')].filter((b) => b.textContent.trim() === 'จัดตามความหมาย').map((b) => b.getAttribute('aria-pressed')));
      record('sem', `${view}: the how panel's เชื่อม toggle morphs onto s, both toggles pressed`, ms !== null && ms <= 2000 && pressed.length === 2 && pressed.every((p) => p === 'true'), { ms, pressed });
      await settled(page);
      await shot(page, `sem-${view}-how`);
      await done();
    }
  },
  /** ทดสอบถาม (local viewer: /live.json + /search stubbed): the traced search plays as 8 steps, then every candidate grouped; nothing crashes */
  async ask() {
    const leg = (type, label, r, cos = null) => ({ type, node: null, label, r, cos });
    const row = (why, type, label, kw, vec, score) => ({ type, node: null, label, kw, bi: null, vec, cos: vec === null ? null : 0.6, score, id: label, why, ev: 0, status: null });
    const trace = {
      q: 'sort', ms: 41, semantic: true, unfamiliar: false, stages: { embed: 2, keyword: 15, vector: 24, synapse: 5 },
      hits: [{ type: 'rule', node: null, label: 'r1' }],
      explain: {
        corpus: 48000, time: null, terms: [{ key: 'sort', df: 120, used: true }], unseen: [], fused: 4,
        signal: { cos1: 0.57, cos10: 0.54, cosMean: 0.5, kw: 1, unseen: 0 },
        kw: { n: 3, top: [leg('chat', 'k1', 1)] }, bi: { n: 0, top: [] }, vec: { n: 60, top: [leg('github', 'v1', 1, 0.57)] },
        rows: [row('ai', 'rule', 'r1', 1, 2, 0.03), row('ai', 'chat', 'r2', 2, null, 0.02), row('full', 'chat', 'r3', null, 1, 0.016), row('cap', 'chat', 'r4', 3, null, 0.015)],
        linked: [{ type: 'fact', node: null, label: 'l1', via: 1, kind: 'link', act: 0.4, sim: 0.3 }],
      },
    };
    const json = (body) => (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(typeof body === 'function' ? body() : body) });
    const { page, done, errors } = await open('ask (local)', 'desktop', '', { ...real, mode: 'local' }, { routes: [['**/live.json*', json(() => ({ now: Date.now(), calls: [] }))], ['**/search?*', json(trace)]] });
    await page.getByRole('button', { name: 'ทดสอบถาม' }).locator('visible=true').first().click();
    const focused = await page.locator('.bv__input').evaluate((el) => el === document.activeElement);
    await page.locator('.bv__input').fill('sort');
    await page.locator('.bv__input').press('Enter');
    await page.getByRole('button', { name: 'เร็ว' }).click();
    const t0 = Date.now();
    const end = await page.locator('.al__all').waitFor({ timeout: 25000 }).then(() => Date.now() - t0, () => null);
    const steps = await page.locator('.al__step').count();
    const groups = await page.locator('.al__group summary b').allInnerTexts();
    record('ask', 'test-ask: focus in the box, 8 steps play out (not at once), then every candidate grouped, no errors', focused && steps === 8 && end !== null && end > 3000 && groups.length === 3 && errors.length === 0, { focused, steps, endMs: end, groups, errors });
    await shot(page, 'ask-desktop');
    await done();
  },
};

// T0: a browser without WebGL2 gets the notice; HUD, timeline and tables keep working
CASES.t0 = async () => {
  const b2 = await chromium.launch({ executablePath: CHROME, headless: !arg('headed'), args: ['--disable-webgl2', '--disable-webgl'] });
  const page = await b2.newPage({ viewport: VIEWS.desktop.viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
  await page.route('**/graph.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(real) }));
  await page.route('**/feed.json*', (r) => r.fulfill({ contentType: 'application/json', body: empty(real) }));
  await page.goto(`${ORIGIN}/?debug=1&intro=0`);
  const webgl2 = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  const notice = await page.getByText('อุปกรณ์นี้แสดงภาพ 3 มิติไม่ได้').waitFor({ state: 'visible', timeout: 10000 }).then(() => true, () => false);
  // the boot screen holds the HUD until the driver's next frame after the notice
  const hud = await page.locator('[aria-label="ตำแหน่งเล่นซ้ำ"]').waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
  record('t0', 'no WebGL2: T0 notice, HUD + timeline still work', !webgl2 && notice && hud && errors.length === 0, { webgl2, notice, hud, errors });
  await b2.close();
};

for (const [name, fn] of Object.entries(CASES)) {
  if (only && !only.includes(name)) continue;
  try {
    await fn();
  } catch (e) {
    record('x', `case ${name} crashed`, false, String(e).slice(0, 400));
  }
}
await browser.close();
server.close();

// baseline: after the first green perf run, fail below 75% of it (median fps on an idle GPU, own GPU ms on a busy one)
const basePath = join(SHOTS, 'baseline.json');
if (perf.desktop && perf.mobile) {
  const green = () => results.filter((r) => String(r.id) === '5').every((r) => r.pass);
  if (existsSync(basePath)) {
    const base = JSON.parse(readFileSync(basePath, 'utf8'));
    let seeded = false;
    for (const v of ['desktop', 'mobile']) {
      const p = perf[v];
      const b = base[v];
      if (!p.contended) record(5, `perf ${v} median ≥ 75% of baseline (${b.medianFps} fps)`, p.medianFps >= 0.75 * b.medianFps, `${p.medianFps} fps`);
      else if (b.gpuMsMin) record(5, `perf ${v} own GPU ms ≤ baseline / 0.75 (${b.gpuMsMin} ms)`, p.gpuMsMin !== null && p.gpuMsMin <= b.gpuMsMin / 0.75, `${p.gpuMsMin} ms`);
      else if (p.gpuMsMin !== null) [b.gpuMsMin, seeded] = [p.gpuMsMin, true]; // first busy-GPU run seeds the GPU-cost baseline
    }
    if (seeded && green()) writeFileSync(basePath, JSON.stringify(base, null, 2));
  } else if (green()) writeFileSync(basePath, JSON.stringify(perf, null, 2));
}
writeFileSync(join(SHOTS, 'report.json'), JSON.stringify({ at: new Date().toISOString(), perf, gzKB, results }, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map((r) => `[${r.id}] ${r.name}`).join(' · ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
