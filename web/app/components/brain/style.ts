// PURE (runs under `node --test`): palette in linear space, node shape/size table, link styles, fire constants
// mirrored by the node shader, and the quality-tier table. No three.js import, only erasable TS syntax.
import { APP_COLOR, FAMILY_COLOR, NODE_TYPES, isApp, type BrainNode, type LinkKind, type NodeType } from '../../lib/brain.ts';

export type Vec3 = [number, number, number];

export type Theme = 'dark' | 'light';
/**
 * Per-theme scene constants; the node palette is the same in both (FAMILY_COLOR). `bg` is also the HUD's --bg and the
 * meta theme-color. Fire whitens + boosts on dark (an over-bright pixel clips to WHITE, never to a new hue, and blooms);
 * on light it darkens by a scalar (hue kept exactly), with the shader's scale pulse doing the "pop".
 * Dark tuned by brain.test.ts: the spec start (0.55 / 2.5) clipped blue toward cyan at act≈0.4; 0.85 / 1.5 stays on-hue
 * and still peaks at luminance ≈ 2.2, so firing nodes bloom.
 */
export const THEME = {
  dark: { bg: '#07090f', whiten: 0.85, boost: 1.5, accent: '#a594ff' }, // accent = globals.css --accent: the selected node
  light: { bg: '#f5f5f7', whiten: 0, boost: -0.4, accent: '#5b4ce0' },
} as const;
/** localStorage key of the visitor's choice; layout.tsx's inline script applies it before first paint (default dark). */
export const THEME_KEY = 'mh-theme';
export const FIRE_DECAY = 3;
export const TYPES: readonly NodeType[] = NODE_TYPES; // index = instanced mesh / slot group
export const TYPE_INDEX = Object.fromEntries(TYPES.map((t, i) => [t, i])) as Record<NodeType, number>;

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const srgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
export function hexToLinear(hex: string): Vec3 {
  const v = parseInt(hex.slice(1), 16);
  return [lin(((v >> 16) & 255) / 255), lin(((v >> 8) & 255) / 255), lin((v & 255) / 255)];
}
/** Linear base colour per node type. Max channel is #3987e5's blue at 0.784, so resting nodes stay under bloom threshold 1. */
export const BASE_LINEAR = Object.fromEntries(TYPES.map((t) => [t, hexToLinear(FAMILY_COLOR[t])])) as Record<NodeType, Vec3>;
/** "สีตาม AI" lens colour of a node (linear); null = no app (hubs, memories, an unknown tool): the shader greys it. */
export const appLinear = (n: BrainNode): Vec3 | null => (isApp(n.a) ? hexToLinear(APP_COLOR[n.a]) : null);

/** Shape is the secondary encoding (hue is per family). `r` = base radius in world units. */
export const SHAPE: Record<NodeType, { geo: 'ico' | 'octa' | 'tetra' | 'box' | 'diamond'; r: number }> = {
  project: { geo: 'ico', r: 3.2 }, // spec start 6: nearly every project has n > 255 (size cap), r 18 hid whole clusters
  session: { geo: 'octa', r: 2.5 },
  subagent: { geo: 'tetra', r: 1.2 },
  note: { geo: 'box', r: 1.8 },
  memory: { geo: 'diamond', r: 1.8 },
};
export const nodeRadius = (type: NodeType, n: number) => SHAPE[type].r * Math.min(3, 1 + 0.25 * Math.log2(1 + Math.max(0, n)));
/** White fresnel rim strength from recall count; < 0 marks a superseded node (shader dims it and turns the rim off). */
export const rimLevel = (u: number) => (u < 0 ? -1 : 0.12 + 0.3 * Math.min(1, Math.log2(1 + u) / 5));
export const fireAmp = (n: number) => Math.min(1, 0.4 + 0.2 * Math.log2(1 + Math.max(0, n)));

/** Node fire colour at activation `act` (0..1); the node shader uses the same THEME numbers. */
export const fireColor = (base: readonly number[], act: number, theme: Theme): Vec3 =>
  base.map((c) => (c + (1 - c) * THEME[theme].whiten * act) * (1 + THEME[theme].boost * act)) as Vec3;

/** Link kinds differ by brightness, width and dash. Never by hue. Returns [gain, widthPx, dashed]. */
export function linkStyle(k: LinkKind, w: number): Vec3 {
  switch (k) {
    case 'spawn': return [0.25, 1.2, 0];
    case 'in': return [0.35, 1.2, 0];
    case 'link': return [0.5, 1, 0];
    case 'similar': return [0.08, 1, 1];
    case 'coaccess': {
      const s = Math.min(1, Math.max(0, w));
      return [0.1 + 0.4 * s, 0.8 + s, 0];
    }
  }
}

export type Tier = 'ultra' | 'high' | 'medium' | 'low';
export const TIER_ORDER: readonly Tier[] = ['low', 'medium', 'high', 'ultra'];
export interface TierSpec {
  antialias: boolean;
  dprCap: number;
  dprFloor: number;
  /** null = no composer (LOW): fake glow is whitening + scale ×1.3 */
  post: null | { bloom: Vec3; shock: boolean; vignette: boolean };
  segments: number;
  ambient: number;
  ambientI: number;
  fanout: number;
  budget: number;
  dust: number;
  /** target fps for [fine pointer, coarse pointer]; 30 is time-paced (engine.ts frame), not rAF parity */
  fps: [number, number];
  intro: boolean;
  icoDetail: number;
}
export const TIERS: Record<Tier, TierSpec> = {
  ultra: { antialias: false, dprCap: 2, dprFloor: 1.25, post: { bloom: [1.2, 0.75, 8], shock: true, vignette: true }, segments: 24, ambient: 0.3, ambientI: 1.3, fanout: 24, budget: 256, dust: 20000, fps: [60, 60], intro: true, icoDetail: 2 },
  high: { antialias: false, dprCap: 1.5, dprFloor: 1, post: { bloom: [1, 0.7, 6], shock: true, vignette: true }, segments: 12, ambient: 0.15, ambientI: 0.7, fanout: 16, budget: 128, dust: 7500, fps: [60, 60], intro: true, icoDetail: 1 },
  medium: { antialias: false, dprCap: 1.5, dprFloor: 1, post: { bloom: [0.9, 0.6, 5], shock: false, vignette: true }, segments: 6, ambient: 0.06, ambientI: 0.7, fanout: 8, budget: 64, dust: 2000, fps: [60, 30], intro: true, icoDetail: 1 },
  low: { antialias: true, dprCap: 1, dprFloor: 0.75, post: null, segments: 1, ambient: 0, ambientI: 0, fanout: 4, budget: 16, dust: 0, fps: [30, 30], intro: false, icoDetail: 1 },
};
