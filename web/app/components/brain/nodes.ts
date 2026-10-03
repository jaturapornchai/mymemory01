// Nodes: one InstancedMesh per type (5 draw calls). Position + radius live in instanceMatrix (also the CPU copy that
// picking projects); birth/death/fire animate in the shader from per-instance timestamps, so a frame uploads nothing.
// The semantic lens ("จัดตามความหมาย") too: aSem holds the position by meaning, the shader mixes toward it by uMorph.
import {
  BoxGeometry,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  OctahedronGeometry,
  PlaneGeometry,
  ShaderMaterial,
  TetrahedronGeometry,
  Vector3,
  type BufferAttribute,
  type BufferGeometry,
  type IUniform,
  type Scene,
} from 'three';
import { BASE_LINEAR, FIRE_DECAY, SHAPE, THEME, TYPES, type Vec3 } from './style';

export type Uniforms = Record<string, IUniform>;
export const ALIVE = 1e9;
export const NEVER = -1e6;

// Attributes switched to one full upload; cleared by three's upload callback. (Can't infer it from updateRanges:
// a buffer's first upload goes through createBuffer, which never clears them.)
const fullPending = new WeakSet<BufferAttribute>();
function uploaded(this: BufferAttribute) {
  fullPending.delete(this);
}
/** Queue a sparse upload of one item; past 128 ranges a single full upload is cheaper than many bufferSubData calls. */
export function mark(a: BufferAttribute, slot: number): void {
  a.needsUpdate = true;
  if (fullPending.has(a)) return;
  if (a.updateRanges.length < 128) return a.addUpdateRange(slot * a.itemSize, a.itemSize);
  a.clearUpdateRanges(); // no ranges = full upload
  fullPending.add(a);
  a.onUpload(uploaded);
}
export const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(64, n)));

const VERT = /* glsl */ `
attribute vec3 aTime;   // born, dead (1e9 = alive), fire
attribute vec3 aParent; // birth extrudes from here
attribute vec2 aExtra;  // fireAmp, rimLevel (< 0 = superseded)
attribute vec4 aApp;    // "สีตาม AI" lens colour (x < 0 = no app), spotlight flag
attribute vec4 aSem;    // semantic lens position, w = has one (0: shrinks away while the lens is on)
uniform vec3 uBase;
uniform float uTime, uHover, uSel, uLow, uLight, uReduced, uLens, uSpot, uMorph;
varying vec3 vView;
flat varying vec3 vBase;
flat varying float vAct, vRim, vSel, vDim;
float easeOutBack(float x) { float y = x - 1.0; return 1.0 + 2.70158 * y * y * y + 1.70158 * y * y; }
void main() {
  vec3 center = mix(instanceMatrix[3].xyz, aSem.xyz, uMorph * aSem.w);
  float k = clamp((uTime - aTime.x) / 0.6, 0.0, 1.0);
  float alive = 1.0 - clamp((uTime - aTime.y) / 0.25, 0.0, 1.0);
  float since = uTime - aTime.z;
  float act = since < 0.0 ? 0.0 : (uReduced > 0.5 ? step(since, 1.5) * 0.5 : exp(-since * ${FIRE_DECAY.toFixed(1)})) * aExtra.x;
  float id = float(gl_InstanceID);
  float sel = abs(id - uSel) < 0.5 ? 1.0 : 0.0;
  float hi = (sel > 0.5 || abs(id - uHover) < 0.5) ? 1.4 : 1.0;
  float s = instanceMatrix[0].x * k * alive * hi * (1.0 - uMorph * (1.0 - aSem.w)) * (1.0 + 0.3 * max(uLow, uLight) * act); // no bloom: fire pops by size
  // selected: at least 1.2% of the viewport height in radius (~22 px across at 900 px), so it stays findable zoomed out
  if (sel > 0.5) s = max(s, 0.024 * -(modelViewMatrix * vec4(center, 1.0)).z / projectionMatrix[1][1] * k * alive);
  vec4 mv = modelViewMatrix * vec4(mix(aParent, center, easeOutBack(k)) + position * s, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
  vAct = act;
  vRim = aExtra.y;
  vSel = sel;
  // lens: the app's hue; no app (hubs, memories) greys out at its family's luminance, so it recedes behind the hues
  vBase = uLens > 0.5 ? (aApp.x < 0.0 ? vec3(dot(uBase, vec3(0.2126, 0.7152, 0.0722))) : aApp.xyz) : uBase;
  vDim = uSpot * (1.0 - aApp.w);
}`;

const FRAG = /* glsl */ `
uniform vec3 uBase, uBg, uAccent;
uniform float uTime, uDimNear, uDimFar, uProbe, uReduced, uLight;
varying vec3 vView;
flat varying vec3 vBase;
flat varying float vAct, vRim, vSel, vDim;
void main() {
  vec3 N = normalize(cross(dFdx(vView), dFdy(vView))); // flat face normal: faceted crystal look, no normal attribute
  vec3 V = normalize(-vView);
  // fire: dark whitens + boosts (a clip yields white, never a new hue), light darkens by a scalar (style.ts THEME)
  vec2 F = uLight > 0.5 ? vec2(${THEME.light.whiten.toFixed(3)}, ${THEME.light.boost.toFixed(3)}) : vec2(${THEME.dark.whiten.toFixed(3)}, ${THEME.dark.boost.toFixed(3)});
  vec3 col = mix(vBase, vec3(1.0), F.x * vAct) * (1.0 + F.y * vAct);
  float sup = step(vRim, -0.5);
  float rim = (max(vRim, 0.0) + vSel * 0.6 * (uReduced > 0.5 ? 1.0 : 0.75 + 0.25 * sin(4.0 * uTime))) * (1.0 - uProbe);
  float fres = rim * pow(1.0 - abs(dot(N, V)), 3.0);
  col = mix(col, uBg, 0.55 * sup); // superseded fade before the rim and key light: the selection rim and facets survive it
  col = uLight > 0.5 ? col * (1.0 - 0.5 * fres) : col + fres; // light: an ink edge instead of a white glow
  // luminance-only key light per facet so shapes read as solids (scalar: hue unchanged; max ×1.0 keeps rest < bloom)
  col *= mix(0.65 + 0.35 * max(dot(N, normalize(vec3(-0.4, 0.7, 0.6))), 0.0), 1.0, uProbe);
  // light: the ink rim is faint on flat facets, so a selected node also darkens (scalar: hue unchanged); dark's white
  // rim reads on its own
  col *= 1.0 - 0.3 * vSel * uLight;
  // the accent on the selection's silhouette only: the face keeps its family hue (a 40 % mix turned aqua into project
  // blue); the reticle (RING_*) finds it from afar
  col = mix(col, uAccent, vSel * smoothstep(0.25, 0.75, 1.0 - abs(dot(N, V))));
  col = mix(col, uBg, 0.5 * smoothstep(uDimNear, uDimFar, -vView.z) * (1.0 - uProbe) * (1.0 - vSel)); // depth cue (not the selection)
  col = mix(col, uBg, 0.9 * vDim * (1.0 - vSel)); // spotlight: everything else fades toward the page (rim included; linear: 0.8 still read as half)
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

// Selection reticle: a camera-facing accent ring over everything (no depth test), so a selected node stays findable
// zoomed out behind nearer nodes. Radius 1.8× the node as drawn (VERT: 1.4r, at least 1.2 % of the height; encloses the
// diamond's tips), at least 14 px; a ~2 px line.
const RING_VERT = /* glsl */ `
uniform vec3 uAt;
uniform float uR;
uniform vec2 uRes;
varying vec2 vUv;
void main() {
  vec4 mv = viewMatrix * vec4(uAt, 1.0);
  float node = max(1.4 * uR, 0.024 * -mv.z / projectionMatrix[1][1]);
  float rad = max(1.8 * node, 14.0 * 2.0 * -mv.z / (projectionMatrix[1][1] * uRes.y));
  vUv = position.xy * 1.25; // the ring at |uv| = 1, room for its anti-aliased edge
  mv.xy += vUv * rad;
  gl_Position = projectionMatrix * mv;
}`;
const RING_FRAG = /* glsl */ `
uniform vec3 uAccent;
varying vec2 vUv;
void main() {
  float d = length(vUv);
  float a = clamp(1.5 - abs(d - 1.0) / fwidth(d), 0.0, 1.0);
  if (a <= 0.0) discard;
  gl_FragColor = vec4(uAccent, a);
  #include <colorspace_fragment>
}`;

function shape(kind: (typeof SHAPE)[keyof typeof SHAPE]['geo'], icoDetail: number): BufferGeometry {
  switch (kind) {
    case 'ico': return new IcosahedronGeometry(1, icoDetail);
    case 'octa': return new OctahedronGeometry(1);
    case 'tetra': return new TetrahedronGeometry(1);
    case 'box': return new BoxGeometry(1.15, 1.15, 1.15); // circumradius ≈ 1 like the others
    case 'diamond': return new OctahedronGeometry(1).scale(1, 1.6, 1);
  }
}
const INSTANCED = [['aTime', 3, [NEVER, ALIVE, NEVER]], ['aParent', 3, [0, 0, 0]], ['aExtra', 2, [0, 0]], ['aApp', 4, [-1, -1, -1, 0]], ['aSem', 4, [0, 0, 0, 0]]] as const;

export class Nodes {
  readonly meshes: InstancedMesh[] = [];
  private readonly mats: ShaderMaterial[] = [];
  private readonly geos: BufferGeometry[] = [];
  private readonly scene: Scene;
  private readonly ring: Mesh<PlaneGeometry, ShaderMaterial>;
  /** semantic lens mix 0..1, mirrors uMorph (the engine owns both): pos() and shown() follow it as the shader does */
  morph = 0;

  /** `res`: canvas size in CSS px (the reticle's 14 px floor) */
  constructor(scene: Scene, shared: Uniforms, icoDetail: number, res: IUniform) {
    this.scene = scene;
    this.ring = new Mesh(
      new PlaneGeometry(2, 2),
      new ShaderMaterial({
        uniforms: { uAccent: shared.uAccent, uRes: res, uAt: { value: new Vector3() }, uR: { value: 1 } },
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 10;
    this.ring.visible = false;
    scene.add(this.ring);
    TYPES.forEach((t, g) => {
      this.geos[g] = shape(SHAPE[t].geo, icoDetail);
      this.mats[g] = new ShaderMaterial({
        uniforms: { ...shared, uBase: { value: new Vector3(...BASE_LINEAR[t]) }, uHover: { value: -1 }, uSel: { value: -1 } },
        vertexShader: VERT,
        fragmentShader: FRAG,
        toneMapped: false,
      });
      this.meshes[g] = this.make(g, 64);
    });
  }

  private make(g: number, cap: number): InstancedMesh {
    const geo = this.geos[g].clone();
    for (const [name, size, init] of INSTANCED) {
      const a = new Float32Array(cap * size);
      for (let i = 0; i < a.length; i++) a[i] = init[i % size];
      geo.setAttribute(name, new InstancedBufferAttribute(a, size).setUsage(DynamicDrawUsage));
    }
    const m = new InstancedMesh(geo, this.mats[g], cap);
    m.instanceMatrix.setUsage(DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    this.scene.add(m);
    return m;
  }

  /** Capacity nextPow2(1.25·n); on overflow only this type's buffers are reallocated (new mesh, old one disposed). */
  ensure(g: number, n: number): void {
    const old = this.meshes[g];
    if (n <= old.instanceMatrix.count) return;
    const m = this.make(g, nextPow2(1.25 * n));
    (m.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array);
    for (const [name] of INSTANCED) (m.geometry.getAttribute(name).array as Float32Array).set(old.geometry.getAttribute(name).array);
    m.count = old.count;
    this.scene.remove(old);
    old.geometry.dispose();
    old.dispose();
    this.meshes[g] = m;
  }

  private attr(g: number, name: string) {
    return this.meshes[g].geometry.getAttribute(name) as InstancedBufferAttribute;
  }

  /** `app`: the lens colour (linear), null = none; `sem`: the position by meaning, null = none (hidden under that lens) */
  place(g: number, slot: number, p: Vec3, r: number, rim: number, born: number, parent: Vec3, app: Vec3 | null, sem: Vec3 | null): void {
    const m = this.meshes[g].instanceMatrix;
    const a = m.array as Float32Array;
    a.fill(0, slot * 16, slot * 16 + 16);
    a[slot * 16] = a[slot * 16 + 5] = a[slot * 16 + 10] = r;
    a.set(p, slot * 16 + 12);
    a[slot * 16 + 15] = 1;
    mark(m, slot);
    const pa = this.attr(g, 'aParent');
    (pa.array as Float32Array).set(parent, slot * 3);
    mark(pa, slot);
    const aa = this.attr(g, 'aApp');
    (aa.array as Float32Array).set(app ?? [-1, -1, -1], slot * 4);
    mark(aa, slot);
    const sa = this.attr(g, 'aSem');
    (sa.array as Float32Array).set(sem ? [...sem, 1] : [0, 0, 0, 0], slot * 4);
    mark(sa, slot);
    this.restyle(g, slot, r, rim);
    this.life(g, slot, born, ALIVE);
  }

  restyle(g: number, slot: number, r: number, rim: number): void {
    const m = this.meshes[g].instanceMatrix;
    const a = m.array as Float32Array;
    a[slot * 16] = a[slot * 16 + 5] = a[slot * 16 + 10] = r;
    mark(m, slot);
    const e = this.attr(g, 'aExtra');
    e.array[slot * 2 + 1] = rim;
    mark(e, slot);
  }

  life(g: number, slot: number, born: number | null, dead: number): void {
    const t = this.attr(g, 'aTime');
    if (born !== null) t.array[slot * 3] = born;
    t.array[slot * 3 + 1] = dead;
    mark(t, slot);
  }

  fire(g: number, slot: number, now: number, amp: number): void {
    const t = this.attr(g, 'aTime');
    t.array[slot * 3 + 2] = now;
    mark(t, slot);
    const e = this.attr(g, 'aExtra');
    e.array[slot * 2] = amp;
    mark(e, slot);
  }

  /** Spotlight membership (the shader fades the rest while uSpot is on); unchanged slots upload nothing. */
  spot(g: number, slot: number, on: boolean): void {
    const a = this.attr(g, 'aApp');
    if (a.array[slot * 4 + 3] === +on) return;
    a.array[slot * 4 + 3] = +on;
    mark(a, slot);
  }

  /** Position as drawn (birth / fire aside): the instance matrix's, mixed toward aSem by the semantic lens. */
  pos(g: number, slot: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const a = this.meshes[g].instanceMatrix.array;
    const s = this.attr(g, 'aSem').array;
    const k = this.morph * s[slot * 4 + 3];
    for (let i = 0; i < 3; i++) out[i] = a[slot * 16 + 12 + i] + (s[slot * 4 + i] - a[slot * 16 + 12 + i]) * k;
    return out;
  }
  /** The baked layout's position (the lens off). */
  home(g: number, slot: number): Vec3 {
    const a = this.meshes[g].instanceMatrix.array;
    return [a[slot * 16 + 12], a[slot * 16 + 13], a[slot * 16 + 14]];
  }
  /** [x, y, z, has] by meaning (has 0: none) */
  sem(g: number, slot: number): [number, number, number, number] {
    const s = this.attr(g, 'aSem').array;
    return [s[slot * 4], s[slot * 4 + 1], s[slot * 4 + 2], s[slot * 4 + 3]];
  }
  /** 1 = drawn, 0 = shrunk away by the semantic lens (no position by meaning) */
  shown(g: number, slot: number): number {
    return 1 - this.morph * (1 - this.attr(g, 'aSem').array[slot * 4 + 3]);
  }
  radius(g: number, slot: number): number {
    return this.meshes[g].instanceMatrix.array[slot * 16];
  }

  setCount(g: number, n: number): void {
    this.meshes[g].count = n;
  }

  /** Highlights are per-mesh uniforms compared with gl_InstanceID: no buffer writes. The selection also moves the reticle. */
  highlight(which: 'uHover' | 'uSel', g: number, slot: number): void {
    this.mats.forEach((m, i) => (m.uniforms[which].value = i === g ? slot : -1));
    if (which !== 'uSel') return;
    this.ring.visible = g >= 0;
    if (g < 0) return;
    const u = this.ring.material.uniforms;
    (u.uAt.value as Vector3).set(...this.pos(g, slot));
    u.uR.value = this.radius(g, slot);
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      m.dispose();
    }
    this.mats.forEach((m) => m.dispose());
    this.geos.forEach((g) => g.dispose());
    this.ring.geometry.dispose();
    this.ring.material.dispose();
  }
}
