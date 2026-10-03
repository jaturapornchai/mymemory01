// Camera: OrbitControls (default touch gestures: one finger rotates, two dolly + pan), framing, the page-load intro,
// arc fly-to, follow gating, idle orbit, and the user-override pause.
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const FLY_MS = 1500;
export const FLY_EVERY_MS = 4000;
export const USER_PAUSE_MS = 20000;
/** Overview distance in units of R (× `fit`: portrait, HUD band): first framing, intro, follow flights, scrub-back pull-out. */
const FRAME_D = 2.2;
/** Overview vs the HUD: fit ≥ BAND_FIT / (share of the height between the stat strip and the timeline). */
const BAND_FIT = 0.72;

export interface View {
  pos: [number, number, number];
  target: [number, number, number];
  /** the intro shot was running: a remount (theme, tier, context) carries it on instead of freezing mid-shot */
  intro?: boolean;
}
interface Tween {
  start: number;
  ms: number;
  from: Vector3;
  to: Vector3;
  dir: Vector3;
  /** end direction (a close-up's clear line of sight); the flight turns toward it */
  dir1: Vector3;
  /** dir → dir1, slerped: a lerp of near-opposite directions passes through 0 */
  turn: Quaternion;
  d0: number;
  d1: number;
  arc: boolean;
  ease: (k: number) => number;
}
export const easeInOutCubic = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

export class CameraRig {
  readonly camera = new PerspectiveCamera(50, 1, 0.5, 1000);
  readonly controls: OrbitControls;
  R = 100;
  framed = false;
  follow = false;
  reduced = false;
  /** probe mode: fixed camera, no orbit, no flights */
  fixed = false;
  pausedUntil = 0;
  /**
   * Page-load intro: as progress() goes 0→1 (replay head start→end) the target moves `from` (first nodes) → `to`
   * (final centroid) and the distance → 1 × the overview, while orbiting at 2.0. Any user input or flight ends it.
   * The shot follows the births: `from` eases toward `goal` (the born nodes' centroid) and the distance starts from
   * their spread `rb` (eased as `rbs`; at least 0.5 × the overview); both set by the engine on each graph change.
   */
  intro: { from: Vector3; to: Vector3; progress: () => number; goal: Vector3 | null; rb: number; rbs: number } | null = null;
  private lastFly = -Infinity;
  private tween: Tween | null = null;
  private dir = new Vector3();
  private tdir = new Vector3();
  private tq = new Quaternion();
  private w = 1;
  private h = 1;
  private top = 0;
  private bottom = 0;
  private right = 0;
  private sized = false;
  private inset = false;
  /** view offset in CSS px: eases toward offTo (the free band's centre; x: left of the side panel) */
  private offY = 0;
  private offTo = 0;
  private offX = 0;
  private offXTo = 0;
  onUser: (untilEpochMs: number) => void = () => {};

  constructor(dom: HTMLElement) {
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1;
    this.controls.addEventListener('start', this.onStart);
  }

  private onStart = () => {
    this.intro = null;
    this.endTween(false);
    this.controls.autoRotate = false;
    this.pausedUntil = Date.now() + USER_PAUSE_MS;
    this.onUser(this.pausedUntil);
  };

  get flying(): boolean {
    return this.tween !== null;
  }

  /**
   * FRAME_D·R fits the brain's height; a portrait canvas is narrower than tall, so back off until it fits the width too,
   * and until it fits the band the HUD leaves free (BAND_FIT; the width left of the side panel), at most 1.7× (or a
   * phone shows a speck). Max zoom-out scales with it. ponytail: 0.75 / 1.7 tuned on 360-390 px phones, BAND_FIT on
   * 1280×720 vs 1440×900.
   */
  private get fit(): number {
    const band = Math.max(0.25, (this.h - this.top - this.bottom) / this.h);
    const wide = Math.max(0.25, (this.w - this.right) / this.w);
    return Math.max(1, Math.min(1.7, Math.max(0.75 / (this.camera.aspect * wide), BAND_FIT / band)));
  }
  private get overviewD(): number {
    return FRAME_D * this.R * this.fit;
  }

  /** Canvas size in CSS px. */
  setViewport(w: number, h: number): void {
    const prev = this.fit;
    const first = !this.sized;
    [this.w, this.h, this.sized] = [w, h, true];
    this.camera.aspect = w / h;
    this.reframe(prev, first);
  }

  /**
   * CSS px of the canvas covered at the top (header + stat strip), bottom (timeline; a phone's details sheet) and right
   * (the side panel, tablet and up): the projection centre moves to the middle of the free area (eased in update()),
   * and the overview fits it.
   */
  setInsets(top: number, bottom: number, right: number): void {
    const prev = this.fit;
    const first = !this.inset;
    [this.top, this.bottom, this.right, this.inset] = [top, bottom, right, true];
    [this.offTo, this.offXTo] = [(bottom - top) / 2, right / 2];
    if (first || this.reduced) [this.offY, this.offX] = [this.offTo, this.offXTo]; // first layout (or a remount on the same view): no slide
    this.reframe(prev, first);
  }

  /** `first`: the initial size / insets of this rig (a remount carries the view over: never a flight then). */
  private reframe(prev: number, first: boolean): void {
    this.applyOffset();
    const d = this.camera.position.distanceTo(this.controls.target);
    if (!this.tween) this.limit();
    // more room needed (rotation to portrait, a taller HUD) while showing the overview under Follow: back off to fit.
    // 5 %: a phone's URL bar changing the height a little is not worth a flight. Close-ups and user control stay.
    const auto = !first && this.framed && this.follow && !this.intro && !this.tween && Date.now() > this.pausedUntil;
    if (auto && this.fit > prev * 1.05 && d >= 0.95 * FRAME_D * this.R * prev) this.flyTo(this.controls.target.clone(), 0, true);
  }

  /** Max zoom-out 3R·fit, never below the current distance: a shrinking fit (narrow → wide) made OrbitControls jump the camera in. */
  private limit(): void {
    this.controls.maxDistance = Math.max(3 * this.R * this.fit, this.camera.position.distanceTo(this.controls.target));
  }

  private applyOffset(): void {
    this.camera.setViewOffset(this.w, this.h, this.offX, this.offY, this.w, this.h);
    this.camera.updateProjectionMatrix();
  }

  setBounds(R: number): void {
    this.R = R;
    this.camera.far = 10 * R;
    this.camera.updateProjectionMatrix();
    if (!this.tween) this.limit();
  }

  /** First graph: centroid at the overview distance. */
  frame(center: Vector3, R: number): void {
    this.framed = true;
    this.setBounds(R);
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(this.dir.set(0, 0.25, 1).normalize(), this.overviewD);
    this.controls.update();
  }

  /** A close-up's distance to a node of radius r. */
  closeD(r: number): number {
    return Math.max(6 * r, 0.08 * this.R);
  }

  /**
   * Keeps the viewing direction (or turns to `end.dir`); ends at closeD(r); long moves pull back mid-flight
   * (1 + 0.35·sin πk). `overview` (follow, pull-out): re-centre on p at no less than the framing distance, no pull-back.
   * Deviation from spec §6: a close-up per batch hid the growing brain during replay, and inheriting the current
   * distance instead kept a tap's close-up for the rest of the session. `end.d`: exactly this distance.
   */
  flyTo(p: Vector3, r: number, overview = false, ms = FLY_MS, end: { dir?: Vector3; d?: number } = {}): void {
    if (this.fixed) return;
    const t = this.controls.target;
    const dir = this.camera.position.clone().sub(t);
    const d0 = dir.length() || 1;
    dir.divideScalar(d0);
    // overview: beyond the max zoom-out (left there by a narrow → wide resize) it eases back in during the flight
    const d1 = end.d ?? (overview ? Math.min(Math.max(d0, this.overviewD), 3 * this.R * this.fit) : this.closeD(r));
    const dir1 = end.dir ?? dir;
    this.lastFly = Date.now();
    if (this.reduced) {
      this.endTween(false);
      t.copy(p);
      this.camera.position.copy(p).addScaledVector(dir1, d1);
      this.controls.update();
      return;
    }
    this.start({ from: t.clone(), to: p.clone(), dir, dir1, turn: new Quaternion().setFromUnitVectors(dir, dir1), d0, d1, arc: !overview && t.distanceTo(p) > 0.3 * this.R, ms, ease: easeInOutCubic });
  }

  /** Follow may fly again `ms` from now (instead of FLY_EVERY_MS after the last flight). */
  followIn(ms: number): void {
    this.lastFly = Date.now() - FLY_EVERY_MS + ms;
  }

  /**
   * Scrub back under Follow: a close-up (tap, focus) may now look at a node that is gone, and scrubbing fires no
   * batch to move the camera, so return to the overview of `center`. Ignores the user pause and the fly rate limit:
   * scrubbing is itself the request to see the brain at that time. Under reduced motion flyTo makes it a cut.
   */
  pullOut(center: Vector3): void {
    const d = this.tween ? this.tween.d1 : this.camera.position.distanceTo(this.controls.target);
    if (this.follow && !this.intro && d < this.overviewD - 1e-3) this.flyTo(center, 0, true);
  }

  /**
   * The intro landed but the camera is not on the overview of `center` (a remount mid-intro onto a tier without the
   * shot, or a remount after the user's pause ran out; a short viewport's intro framed above its caption): fly there,
   * in too, unless the user has control.
   */
  settle(center: Vector3, ms: number): void {
    const d = this.camera.position.distanceTo(this.controls.target);
    const off = this.controls.target.distanceTo(center) > 0.05 * this.R || Math.abs(d - this.overviewD) > 0.05 * this.overviewD;
    if (off && Date.now() > this.pausedUntil) this.flyTo(center, 0, true, ms, { d: this.overviewD });
  }

  /** The overview of `center` at the framing distance, whoever has the camera (the semantic lens's reframe; a cut under reduced motion). */
  overview(center: Vector3, ms: number): void {
    this.flyTo(center, 0, true, ms, { d: this.overviewD });
  }

  /** Follow may fly at most once per FLY_EVERY_MS, never under reduced motion or while the user has control. */
  canFollow(): boolean {
    const now = Date.now();
    return this.follow && !this.reduced && !this.fixed && now > this.pausedUntil && now - this.lastFly >= FLY_EVERY_MS;
  }

  setReduced(b: boolean): void {
    this.reduced = b;
    if (b) {
      this.intro = null;
      this.endTween(true); // camera moves become cuts
    }
  }

  private start(t: Omit<Tween, 'start'>): void {
    this.intro = null;
    this.tween = { ...t, start: performance.now() };
    this.controls.maxDistance = Infinity; // the intro starts beyond 3R
    this.apply(0);
  }

  private apply(k: number): void {
    const tw = this.tween!;
    const e = tw.ease(k);
    this.controls.target.lerpVectors(tw.from, tw.to, e);
    const d = (tw.d0 + (tw.d1 - tw.d0) * e) * (tw.arc ? 1 + 0.35 * Math.sin(Math.PI * k) : 1);
    this.camera.position.copy(this.controls.target).addScaledVector(this.tdir.copy(tw.dir).applyQuaternion(this.tq.identity().slerp(tw.turn, e)), d);
  }

  private endTween(jump: boolean): void {
    if (!this.tween) return;
    if (jump) this.apply(1);
    this.tween = null;
    this.limit();
  }

  /** Returns true while the camera is moving (tween, orbit or damping), i.e. the frame loop must keep running. */
  update(dt: number): boolean {
    let moving = false;
    if (this.intro) {
      const it = this.intro;
      const k = easeInOutCubic(it.progress());
      const t = this.controls.target;
      this.dir.copy(this.camera.position).sub(t).normalize(); // keep the orbit's current angle
      // the opening cluster alone left a burst born elsewhere off screen (easeInOutCubic is still 0.12 a third in)
      const e = Math.min(1, 3 * dt);
      if (it.goal) it.from.lerp(it.goal, e);
      it.rbs += (it.rb - it.rbs) * e;
      t.lerpVectors(it.from, it.to, k);
      // the births' spread (1.1 × rbs / R at the overview's scale, at least 0.5) → 1 × the overview: lands on it exactly
      this.camera.position.copy(t).addScaledVector(this.dir, ((1 - k) * Math.max(0.5, (1.1 * it.rbs) / this.R) + k) * this.overviewD);
      moving = true;
    }
    if (this.tween) {
      const k = Math.min(1, (performance.now() - this.tween.start) / this.tween.ms);
      this.apply(k);
      if (k >= 1) this.endTween(false);
      moving = true;
    }
    if (this.offY !== this.offTo || this.offX !== this.offXTo) {
      // a phone's details sheet opening / closing, the side panel rising in: the picture slides over ~0.4 s, no jump
      const k = this.reduced ? 1 : Math.min(1, dt * 8);
      const ease = (a: number, b: number) => (Math.abs(b - a) < 0.5 ? b : a + (b - a) * k);
      [this.offY, this.offX] = [ease(this.offY, this.offTo), ease(this.offX, this.offXTo)];
      this.applyOffset();
      moving = true;
    }
    this.controls.autoRotateSpeed = this.intro ? 2 : 0.4; // idle ≈ 0.04 rad/s with update(dt); intro ≈ 70° over the replay
    this.controls.autoRotate = (this.follow || !!this.intro) && !this.reduced && !this.fixed && !this.tween && Date.now() > this.pausedUntil;
    return this.controls.update(dt) || moving || this.controls.autoRotate;
  }

  /** Mid-flight: the flight's end (a remount has no tween to finish it, and froze half-way). */
  getView(): View {
    const tw = this.tween;
    const t = tw ? tw.to : this.controls.target;
    const p = tw ? tw.to.clone().addScaledVector(tw.dir1, tw.d1) : this.camera.position;
    return { pos: [p.x, p.y, p.z], target: [t.x, t.y, t.z], intro: !!this.intro };
  }

  setView(v: View): void {
    this.framed = true;
    this.camera.position.set(...v.pos);
    this.controls.target.set(...v.target);
    this.controls.update();
  }

  dispose(): void {
    this.controls.removeEventListener('start', this.onStart);
    this.controls.dispose();
  }
}
