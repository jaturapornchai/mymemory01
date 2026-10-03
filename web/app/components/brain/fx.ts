// Post chain per tier and theme (pmndrs postprocessing), the dust shell and the ShockWave. Nothing here adds a hue:
// bloom spreads existing colours, vignette is luminance-only, dust is neutral white. Light theme: no bloom, vignette or
// dust; only ShockWave tiers keep a composer, the rest render straight to the canvas.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  HalfFloatType,
  Points,
  ShaderMaterial,
  Vector3,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { BloomEffect, EffectComposer, EffectPass, RenderPass, ShockWaveEffect, VignetteEffect, type Effect } from 'postprocessing';
import type { Uniforms } from './nodes';
import type { TierSpec } from './style';

const DUST_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime, uReduced, uR, uPx;
void main() {
  vec3 dir = vec3(sin(aSeed * 1.3), cos(aSeed * 2.1), sin(aSeed * 3.7));
  float t = uReduced > 0.5 ? 0.0 : uTime;
  vec4 mv = modelViewMatrix * vec4(position + dir * 0.02 * uR * sin(0.05 * t + aSeed), 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (1.0 + fract(aSeed)) * uPx;
}`;
const DUST_FRAG = /* glsl */ `
void main() {
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  gl_FragColor = vec4(vec3(0.21), 1.0);
  #include <colorspace_fragment>
}`;

const SHOCK_S = 1.4;
const PULSE_S = 0.9;

export interface Fx {
  render(dt: number): void;
  setSize(w: number, h: number): void;
  /** dust shell between 1.1R and 2.5R around the centroid; built once the first graph is framed */
  setDust(center: Vector3, R: number, dpr: number): void;
  setReduced(b: boolean): void;
  explode(at: Vector3, now: number): void;
  /** the intro's LIVE moment (dark only): bloom ×1.35 easing back to ×1 */
  pulse(now: number): void;
  busyUntil: number;
  dispose(): void;
}

/** Throws if the composer can't be built (caller falls back to LOW). */
export function createFx(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, spec: TierSpec, shared: Uniforms, probe: boolean, light: boolean): Fx {
  let composer: EffectComposer | null = null;
  let shock: ShockWaveEffect | null = null;
  let bloom: BloomEffect | null = null;
  let pulseAt = -Infinity;
  let reduced = false;
  const p = spec.post;
  if (p && (!light || (p.shock && !probe))) {
    composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: 4 });
    composer.addPass(new RenderPass(scene, camera));
    const effects: Effect[] = [];
    // no resolutionScale: deprecated in 6.39.5 (mipmapBlur); tiers scale bloom through levels + DPR
    if (!light) effects.push((bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1, luminanceSmoothing: 0.03, intensity: p.bloom[0], radius: p.bloom[1], levels: p.bloom[2] })));
    if (p.shock && !probe) effects.push((shock = new ShockWaveEffect(camera, new Vector3(), { speed: 1.2, maxRadius: 0.45, waveSize: 0.12, amplitude: light ? 0.02 : 0.035 })));
    if (p.vignette && !probe && !light) effects.push(new VignetteEffect({ offset: 0.3, darkness: 0.35 }));
    composer.addPass(new EffectPass(camera, ...effects));
  }

  let dust: Points<BufferGeometry, ShaderMaterial> | null = null;
  const fx: Fx = {
    busyUntil: 0,
    render(dt) {
      if (bloom) bloom.intensity = p!.bloom[0] * (1 + 0.35 * (1 - Math.min(1, ((shared.uTime.value as number) - pulseAt) / PULSE_S)) ** 3);
      if (composer) composer.render(dt);
      else renderer.render(scene, camera);
    },
    setSize(w, h) {
      if (composer) composer.setSize(w, h);
      else renderer.setSize(w, h);
      if (dust) dust.material.uniforms.uPx.value = renderer.getPixelRatio();
    },
    setDust(center, R, dpr) {
      if (dust || !spec.dust || probe || light) return;
      let seed = 99; // deterministic: screenshots and readbacks repeat
      const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
      const pos = new Float32Array(spec.dust * 3);
      const seeds = new Float32Array(spec.dust);
      for (let i = 0; i < spec.dust; i++) {
        const z = 2 * rnd() - 1;
        const a = rnd() * 2 * Math.PI;
        const s = Math.sqrt(1 - z * z);
        const r = R * (1.1 + 1.4 * Math.cbrt(rnd()));
        pos.set([center.x + r * s * Math.cos(a), center.y + r * z, center.z + r * s * Math.sin(a)], i * 3);
        seeds[i] = rnd() * 100;
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      g.setAttribute('aSeed', new BufferAttribute(seeds, 1));
      const m = new ShaderMaterial({
        uniforms: { uTime: shared.uTime, uReduced: shared.uReduced, uR: { value: R }, uPx: { value: dpr } },
        vertexShader: DUST_VERT,
        fragmentShader: DUST_FRAG,
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      dust = new Points(g, m);
      dust.frustumCulled = false;
      dust.renderOrder = 2;
      scene.add(dust);
    },
    setReduced(b) {
      reduced = b;
    },
    explode(at, now) {
      if (!shock || reduced) return;
      shock.position.copy(at);
      // ShockWave sizes its ring by camera distance; normalise so maxRadius reads as a fraction of the screen
      shock.uniforms.get('size')!.value = 0.1 * camera.position.distanceTo(at);
      shock.explode();
      fx.busyUntil = Math.max(fx.busyUntil, now + SHOCK_S);
    },
    pulse(now) {
      if (!bloom || reduced) return;
      pulseAt = now;
      fx.busyUntil = Math.max(fx.busyUntil, now + PULSE_S);
    },
    dispose() {
      composer?.dispose();
      if (dust) {
        scene.remove(dust);
        dust.geometry.dispose();
        dust.material.dispose();
      }
    },
  };
  return fx;
}
