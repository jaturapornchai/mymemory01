// Edges: every link is one instance of a screen-space ribbon along a quadratic Bézier (1 draw call). Max blending (dark)
// means overlapping edges can't pile up into new hues or a white hub blob; only comet heads go past 1 and bloom. Light
// theme draws ink on paper with Min blending instead: brightness becomes ink density, and the darkest edge wins.
// Drawn FIRST (opaque pass, renderOrder -1) so nodes always paint over them: a grey edge max-blended over a blue or
// green node raised its red channel and shifted the node toward purple / yellow-green (failed the hue check).
import {
  BufferAttribute,
  CustomBlending,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  MaxEquation,
  Mesh,
  MinEquation,
  OneFactor,
  ShaderMaterial,
  type Scene,
} from 'three';
import { ALIVE, NEVER, mark, nextPow2, type Uniforms } from './nodes';
import type { Vec3 } from './style';

/** Comet travel time clamps: a pure world-speed comet would flash by on short edges and crawl on long ones. */
export const COMET_MIN_S = 0.5;
export const COMET_MAX_S = 1.6;

// A request's comet (strong: `aTime.w` is ±2, not ±1) trails longer, is wider and burns brighter than a chat turn's: one
// request in a 4,000-node cloud must still be seen. The sign of aTime.w is the direction, |w| - 1 the strength.
const COMMON = /* glsl */ `
float comet(float d, float L) { return (d > 0.0 && d < L) ? (1.0 - d / L) * (1.0 - d / L) : 0.0; }
float comet(float d) { return comet(d, 0.25); }
float travel(float since, float len) { return since / clamp(len / uSpeed, ${COMET_MIN_S.toFixed(2)}, ${COMET_MAX_S.toFixed(2)}); }
`;

const VERT = /* glsl */ `
attribute vec3 aA, aB, aColA, aColB;
attribute vec4 aTime;  // born, dead, fire, dir (+1 from A, -1 from B)
attribute vec4 aStyle; // gain, widthPx, dashed, kept by the semantic lens (1: a link by meaning; 0: in / spawn)
attribute vec4 aSA, aSB; // semantic lens ends, w = has one (an edge missing either, or not kept, fades out under that lens)
uniform float uTime, uSpeed, uAmbient, uReduced, uWiden, uLens, uMorph;
uniform vec3 uCentroid;
uniform vec2 uRes;     // CSS px, so widths don't depend on DPR
varying float vU;
flat varying vec3 vColA, vColB;
flat varying float vLen, vGain, vDash, vGrow, vFade, vAmb, vSince, vDir, vStr;
${COMMON}
float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
vec3 eA, eB;
vec3 bez(vec3 C, float t) { return mix(mix(eA, C, t), mix(C, eB, t), t); }
void main() {
  eA = mix(aA, aSA.xyz, uMorph * aSA.w);
  eB = mix(aB, aSB.xyz, uMorph * aSB.w);
  float t = position.x;
  float len = length(eB - eA);
  vec3 m = 0.5 * (eA + eB);
  vec3 off = m - uCentroid;
  vec3 C = m + (dot(off, off) > 1e-6 ? normalize(off) : vec3(0.0, 1.0, 0.0)) * 0.15 * len; // bow away from the centre
  mat4 pv = projectionMatrix * viewMatrix;
  vec4 c0 = pv * vec4(bez(C, t), 1.0);
  float t1 = t < 0.99 ? t + 0.01 : t - 0.01;
  vec4 c1 = pv * vec4(bez(C, t1), 1.0);
  vec2 d = (c1.xy / c1.w - c0.xy / c0.w) * uRes * (t1 > t ? 1.0 : -1.0);
  vec2 nrm = vec2(-d.y, d.x) / max(length(d), 1e-6);
  float since = uTime - aTime.z;
  float up = aTime.w < 0.0 ? 1.0 - t : t;
  float str = abs(aTime.w) - 1.0;
  float c = (uReduced > 0.5 || since < 0.0) ? 0.0 : comet(travel(since, len) - up, 0.25 + 0.2 * str);
  c0.xy += nrm * position.y * aStyle.y * (1.0 + 1.5 * c * uWiden * (1.0 + 1.4 * str)) * 2.0 / uRes * c0.w;
  float fade = (1.0 - clamp((uTime - aTime.y) / 0.25, 0.0, 1.0)) * (1.0 - uMorph * (1.0 - aSA.w * aSB.w * aStyle.w));
  gl_Position = fade > 0.0 ? c0 : vec4(2.0, 2.0, 2.0, 1.0);
  vU = t;
  // "สีตาม AI" lens: the end tints and comets go neutral (the family hues would compete with the app hues)
  vColA = uLens > 0.5 ? vec3(0.6) : aColA;
  vColB = uLens > 0.5 ? vec3(0.6) : aColB;
  vLen = len;
  vGain = aStyle.x;
  vDash = aStyle.z;
  vGrow = clamp((uTime - aTime.x) / 0.5, 0.0, 1.0);
  vFade = fade;
  float id = float(gl_InstanceID);
  vAmb = hash(id) < uAmbient ? hash(id + 17.0) : -1.0;
  vSince = since;
  vDir = aTime.w;
  vStr = str;
}`;

const FRAG = /* glsl */ `
uniform float uTime, uSpeed, uReduced, uAmbI, uLight, uSpot;
uniform vec3 uBg;
varying float vU;
flat varying vec3 vColA, vColB;
flat varying float vLen, vGain, vDash, vGrow, vFade, vAmb, vSince, vDir, vStr;
${COMMON}
vec3 hue(vec3 c) { return c / max(max(c.r, c.g), max(c.b, 1e-4)); }
void main() {
  if (vU > vGrow) discard; // growth: draws from source to target
  if (vDash > 0.5 && fract(vU * vLen / 4.0) > 0.5) discard;
  // neutral grey-white body; only the last 20% at each end tints toward that endpoint's hue
  vec3 tint = mix(hue(vColA), vec3(1.0), smoothstep(0.0, 0.2, vU));
  tint = mix(tint, hue(vColB), smoothstep(0.8, 1.0, vU));
  vec3 col = tint * 0.55 * vGain * (1.0 - 0.75 * uSpot); // spotlight: bodies fade, comets stay bright
  vec3 fam = vDir < 0.0 ? vColB : vColA;
  vec3 src = mix(fam, vec3(1.0), 0.7);
  float head = 0.0;
  if (vSince >= 0.0) {
    if (uReduced > 0.5) head = 0.5 * step(vSince, 1.5); // static 1.5 s brightening, no movement
    else head = comet(travel(vSince, vLen) - (vDir < 0.0 ? 1.0 - vU : vU), 0.25 + 0.2 * vStr);
    col += src * (1.0 + 3.0 * head * (1.0 - uReduced) * (1.0 + vStr)) * head * (1.0 + 0.6 * vStr); // head goes past 1 and blooms
  }
  if (vAmb >= 0.0 && uReduced < 0.5) col += uAmbI * comet(fract(uTime * 0.15 + vAmb) - vU);
  col *= vFade;
  if (uLight > 0.5) col = mix(uBg, mix(tint * 0.22, fam * 0.7, head), clamp(dot(col, vec3(0.2126, 0.7152, 0.0722)) * 4.0, 0.0, 0.85));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const INSTANCED = [['aA', 3], ['aB', 3], ['aColA', 3], ['aColB', 3], ['aTime', 4], ['aStyle', 4], ['aSA', 4], ['aSB', 4]] as const;

export class Edges {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  /** chord length per slot, the longer of both layouts (CPU copy for the comet's on-demand window) */
  lens = new Float32Array(0);
  private readonly strip: InstancedBufferGeometry;

  constructor(scene: Scene, shared: Uniforms, segments: number, extra: Uniforms, light: boolean) {
    // base strip: (S+1)×2 vertices, position = (t, side, 0); S = 1 is a straight quad
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= segments; i++) pos.push(i / segments, -0.5, 0, i / segments, 0.5, 0);
    for (let i = 0; i < segments; i++) idx.push(2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3);
    this.strip = new InstancedBufferGeometry();
    this.strip.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    this.strip.setIndex(idx);
    const mat = new ShaderMaterial({
      uniforms: { ...shared, ...extra, uWiden: { value: segments >= 6 ? 1 : 0 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      toneMapped: false,
      depthWrite: false,
      blending: CustomBlending,
      blendEquation: light ? MinEquation : MaxEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
    });
    this.mesh = new Mesh(this.make(0), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    scene.add(this.mesh);
  }

  private make(cap: number): InstancedBufferGeometry {
    const g = new InstancedBufferGeometry();
    g.index = this.strip.index;
    g.setAttribute('position', this.strip.getAttribute('position'));
    for (const [name, size] of INSTANCED) {
      const a = new Float32Array(cap * size);
      if (name === 'aTime') for (let i = 0; i < cap; i++) a.set([NEVER, ALIVE, NEVER, 1], i * 4);
      g.setAttribute(name, new InstancedBufferAttribute(a, size).setUsage(DynamicDrawUsage));
    }
    g.instanceCount = 0;
    return g;
  }

  ensure(n: number): void {
    const old = this.mesh.geometry;
    const cap = (old.getAttribute('aTime') as InstancedBufferAttribute).count;
    if (n <= cap) return;
    const g = this.make(nextPow2(1.25 * n));
    for (const [name] of INSTANCED) (g.getAttribute(name).array as Float32Array).set(old.getAttribute(name).array);
    g.instanceCount = old.instanceCount;
    const lens = new Float32Array((g.getAttribute('aTime') as InstancedBufferAttribute).count);
    lens.set(this.lens);
    this.lens = lens;
    this.mesh.geometry = g;
    old.dispose(); // shared strip index/position stay alive with the new geometry
  }

  private attr(name: string) {
    return this.mesh.geometry.getAttribute(name) as InstancedBufferAttribute;
  }

  /** `sa`, `sb`: the ends by meaning, [x, y, z, has]; `style`: linkStyle + kept by the semantic lens (0 | 1) */
  place(slot: number, a: Vec3, b: Vec3, sa: readonly number[], sb: readonly number[], colA: Vec3, colB: Vec3, style: readonly number[], born: number): void {
    for (const [name, v] of [['aA', a], ['aB', b], ['aColA', colA], ['aColB', colB], ['aStyle', style], ['aSA', sa], ['aSB', sb]] as const) {
      const at = this.attr(name);
      (at.array as Float32Array).set(v, slot * at.itemSize);
      mark(at, slot);
    }
    this.lens[slot] = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(sb[0] - sa[0], sb[1] - sa[1], sb[2] - sa[2]));
    this.life(slot, born, ALIVE);
  }

  life(slot: number, born: number | null, dead: number): void {
    const t = this.attr('aTime');
    if (born !== null) t.array[slot * 4] = born;
    t.array[slot * 4 + 1] = dead;
    mark(t, slot);
  }

  /** Comet from the source (dir +1) or the target end (dir -1); `strong` (a search / recall) = longer, wider, brighter. Returns its travel time, for on-demand rendering. */
  fire(slot: number, now: number, dir: number, speed: number, strong = false): number {
    const t = this.attr('aTime');
    t.array[slot * 4 + 2] = now;
    t.array[slot * 4 + 3] = strong ? 2 * dir : dir;
    mark(t, slot);
    return (strong ? 1.45 : 1.25) * Math.min(COMET_MAX_S, Math.max(COMET_MIN_S, this.lens[slot] / speed));
  }

  setCount(n: number): void {
    this.mesh.geometry.instanceCount = n;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.strip.dispose();
    this.mesh.material.dispose();
  }
}
