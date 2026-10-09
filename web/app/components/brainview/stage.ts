// The brain view's canvas: faint pathways between the regions, pulses with a trailing glow travelling along them, regions
// blooming when reached. 2D canvas, additive blending, drawn only while a run is alive (idle = no frames). Everything
// is in the image's own box: the canvas is exactly as big as the picture, so a normalised (x, y) is the same spot on both.
import { EDGES, REGIONS, REGION, edgeOf, type Edge, type RegionId } from './regions.ts';
import type { Plan, RouteKind } from './routes.ts';

type Rgb = readonly [number, number, number];
/** one hue per kind of request, also used by the ticker's dots */
export const KIND_RGB: Record<RouteKind, Rgb> = { search: [110, 215, 255], get: [190, 165, 255], related: [255, 200, 110], turn: [110, 255, 190] };
export const rgbCss = (c: Rgb, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

const BLOOM_S = 1.6;
const REDUCED_S = 1.2; // reduced motion: every region of the route lights at once, holds, goes
const TRAIL = 0.3; // of the pathway's length
const TRAIL_STEPS = 14;
const MAX_RUNS = 8; // a replay at 16× would otherwise stack hundreds
const HIT_PX = 30;

interface Curve {
  edge: Edge;
  ax: number;
  ay: number;
  cx: number;
  cy: number;
  bx: number;
  by: number;
}
interface Run {
  plan: Plan;
  t0: number;
}

const easeInOut = (u: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, u)));

export class PathwayStage {
  reduced = false;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | null = null;
  private curves: Curve[] = [];
  private runs: Run[] = [];
  private raf = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private s = 1;
  private marked: RegionId | null = null;
  private font = 'system-ui, sans-serif';

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  /** CSS px size of the image box and the device pixel ratio: rebuilds the static layer */
  resize(w: number, h: number, dpr: number) {
    if (w < 1 || h < 1) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.font = getComputedStyle(this.canvas).fontFamily || this.font; // Thai glyphs: the page's own font stack
    this.s = Math.min(1.5, Math.max(0.6, w / 1000)); // pulses and dots keep their look from a phone to a 4K display
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.curves = EDGES.map((edge) => {
      const a = REGION[edge.a];
      const b = REGION[edge.b];
      const [ax, ay, bx, by] = [a.x * w, a.y * h, b.x * w, b.y * h];
      const len = Math.hypot(bx - ax, by - ay);
      return { edge, ax, ay, bx, by, cx: (ax + bx) / 2 - ((by - ay) / len) * edge.bow * len, cy: (ay + by) / 2 + ((bx - ax) / len) * edge.bow * len };
    });
    this.base = this.paintBase();
    this.schedule();
  }

  /** Starts a route. The oldest run gives way beyond MAX_RUNS. */
  launch(plan: Plan) {
    if (this.runs.length >= MAX_RUNS) this.runs.shift();
    this.runs.push({ plan, t0: performance.now() });
    this.schedule();
  }

  /** a region ringed by the legend / pointer */
  mark(id: RegionId | null) {
    if (id === this.marked) return;
    this.marked = id;
    this.schedule();
  }

  /** nearest region within a thumb's reach of a point in the box, CSS px */
  regionAt(x: number, y: number): RegionId | null {
    let best: RegionId | null = null;
    let bestD = HIT_PX * this.s;
    for (const r of REGIONS) {
      const d = Math.hypot(r.x * this.w - x, r.y * this.h - y);
      if (d < bestD) [best, bestD] = [r.id, d];
    }
    return best;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.runs = [];
  }

  private schedule() {
    if (!this.raf && this.w) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private point(c: Curve, from: RegionId, u: number): [number, number] {
    const t = c.edge.a === from ? u : 1 - u;
    const k = 1 - t;
    return [k * k * c.ax + 2 * k * t * c.cx + t * t * c.bx, k * k * c.ay + 2 * k * t * c.cy + t * t * c.by];
  }

  private curveOf(a: RegionId, b: RegionId): Curve | undefined {
    const e = edgeOf(a, b);
    return e && this.curves.find((c) => c.edge === e);
  }

  /** pathways + region dots: static, so they are painted once per size */
  private paintBase(): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = this.canvas.width;
    cv.height = this.canvas.height;
    const g = cv.getContext('2d')!;
    g.scale(this.dpr, this.dpr);
    const s = this.s;
    g.lineCap = 'round';
    for (const c of this.curves) {
      g.beginPath();
      g.moveTo(c.ax, c.ay);
      g.quadraticCurveTo(c.cx, c.cy, c.bx, c.by);
      g.strokeStyle = c.edge.decor ? 'rgba(120, 190, 255, 0.04)' : 'rgba(120, 200, 255, 0.07)';
      g.lineWidth = 7 * s;
      g.stroke();
      g.strokeStyle = c.edge.decor ? 'rgba(170, 220, 255, 0.16)' : 'rgba(180, 230, 255, 0.3)';
      g.lineWidth = 1.3 * s;
      g.stroke();
    }
    for (const r of REGIONS) {
      g.beginPath();
      g.arc(r.x * this.w, r.y * this.h, 8 * s, 0, 2 * Math.PI);
      g.fillStyle = 'rgba(5, 10, 24, 0.55)';
      g.fill();
      g.strokeStyle = 'rgba(210, 238, 255, 0.75)';
      g.lineWidth = 1.4 * s;
      g.stroke();
      g.beginPath();
      g.arc(r.x * this.w, r.y * this.h, 2.8 * s, 0, 2 * Math.PI);
      g.fillStyle = 'rgba(235, 247, 255, 0.95)';
      g.fill();
    }
    return cv;
  }

  private frame(now: number) {
    this.raf = 0;
    const { ctx, w, h, s } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (this.base) ctx.drawImage(this.base, 0, 0, w, h);

    const glow = new Map<RegionId, number>(); // strongest bloom per region this frame: its name shows while it glows
    ctx.globalCompositeOperation = 'lighter';
    this.runs = this.runs.filter((run) => {
      const el = (now - run.t0) / 1000;
      const rgb = KIND_RGB[run.plan.kind];
      if (el > (this.reduced ? REDUCED_S : run.plan.total + BLOOM_S)) return false;
      if (this.reduced) {
        const involved = new Set<RegionId>(run.plan.blooms.map((b) => b.region));
        for (const r of involved) this.bloom(r, rgb, 0.9, 0.55, 0, glow);
        return true;
      }
      for (const leg of run.plan.legs) {
        const u = (el - leg.t0) / leg.dur;
        if (u >= 0 && u <= 1) this.pulse(leg.from, leg.to, easeInOut(u), rgb);
      }
      for (const b of run.plan.blooms) {
        const e = (el - b.at) / BLOOM_S;
        if (e >= 0 && e <= 1) this.bloom(b.region, rgb, b.amp, (1 - e) ** 1.6 * Math.min(1, e * 14), e, glow);
      }
      return true;
    });
    ctx.globalCompositeOperation = 'source-over';

    // the glowing regions name themselves; the marked one has its tooltip (and ring) already
    const named = new Set<RegionId>([...glow].filter(([k, v]) => v > 0.25 && k !== this.marked).map(([k]) => k));
    ctx.font = `600 ${Math.round(13 * Math.max(0.9, s))}px ${this.font}`;
    ctx.textAlign = 'center';
    for (const id of named) {
      const r = REGION[id];
      const x = Math.min(w - 40, Math.max(40, r.x * w));
      const y = r.y * h - 17 * s;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(2, 5, 14, 0.85)';
      ctx.strokeText(r.name, x, y);
      ctx.fillStyle = '#f2f8ff';
      ctx.fillText(r.name, x, y);
    }
    if (this.marked) {
      const r = REGION[this.marked];
      ctx.beginPath();
      ctx.arc(r.x * w, r.y * h, 13 * s, 0, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    if (this.runs.length) this.schedule();
  }

  /** the pulse: a head with a tail of the pathway behind it, additive */
  private pulse(from: RegionId, to: RegionId, u: number, rgb: Rgb) {
    const c = this.curveOf(from, to);
    if (!c) return;
    const { ctx, s } = this;
    const fade = Math.min(1, u * 10, (1 - u) * 5 + 0.25); // rises quickly, thins out just before it lands
    ctx.lineCap = 'round';
    // two passes over the tail: a wide soft one under a bright core
    for (const [wide, alpha] of [[2.6, 0.3], [1, 1]] as const) {
      let prev = this.point(c, from, u);
      for (let j = 1; j <= TRAIL_STEPS; j++) {
        const uj = u - (j / TRAIL_STEPS) * TRAIL;
        if (uj < 0) break;
        const p = this.point(c, from, uj);
        const k = 1 - j / TRAIL_STEPS;
        ctx.beginPath();
        ctx.moveTo(prev[0], prev[1]);
        ctx.lineTo(p[0], p[1]);
        ctx.strokeStyle = rgbCss(rgb, alpha * k ** 1.4 * fade);
        ctx.lineWidth = (2 + 6 * k) * s * wide;
        ctx.stroke();
        prev = p;
      }
    }
    const [x, y] = this.point(c, from, u);
    const r = 32 * s;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255, 255, 255, ${fade})`);
    g.addColorStop(0.12, `rgba(255, 255, 255, ${0.9 * fade})`);
    g.addColorStop(0.3, rgbCss(rgb, 0.75 * fade));
    g.addColorStop(0.6, rgbCss(rgb, 0.25 * fade));
    g.addColorStop(1, rgbCss(rgb, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fill();
  }

  /** a region lit: soft glow, plus a ring that spreads (`e` 0..1 through its life; reduced motion: no ring) */
  private bloom(id: RegionId, rgb: Rgb, amp: number, alpha: number, e: number, glow: Map<RegionId, number>) {
    const { ctx, s } = this;
    const r = REGION[id];
    const [x, y] = [r.x * this.w, r.y * this.h];
    const a = Math.min(1, amp * alpha);
    glow.set(id, Math.max(glow.get(id) ?? 0, a));
    const rad = (36 + 30 * amp) * s * (1 + 0.35 * e);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(255, 255, 255, ${0.95 * a})`);
    g.addColorStop(0.25, rgbCss(rgb, 0.8 * a));
    g.addColorStop(0.6, rgbCss(rgb, 0.3 * a));
    g.addColorStop(1, rgbCss(rgb, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, 2 * Math.PI);
    ctx.fill();
    if (!this.reduced && e > 0) {
      ctx.beginPath();
      ctx.arc(x, y, (10 + 54 * amp * e) * s, 0, 2 * Math.PI);
      ctx.strokeStyle = rgbCss(rgb, 0.9 * (1 - e) * Math.min(1, amp));
      ctx.lineWidth = 2.5 * s;
      ctx.stroke();
    }
  }
}
