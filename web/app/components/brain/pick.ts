// Screen-space nearest-node picking from the CPU instance matrices: suits tiny tetrahedra and fingers, no raycast.
// ponytail: O(live nodes) per pointer move (~0.3 ms at 10k on desktop, est.); at ~100k switch to a GPU id-buffer pass.
import type { InstancedMesh, PerspectiveCamera } from 'three';
import type { BrainNode } from '../../lib/brain';
import type { Slot } from './slots';

export const TAP_RADIUS = 28; // px, fat-finger picking for touch
const MOUSE_RADIUS = 10;

/**
 * A node whose projected disc contains the pointer wins over one that is merely within the fat radius; among those,
 * the nearest to the camera wins. Otherwise the smallest screen distance wins (ties → smaller depth).
 * `morph`: the semantic lens's mix (Nodes.morph): positions as drawn; a node it shrinks below half size is not pickable.
 */
export function pick(
  camera: PerspectiveCamera,
  w: number,
  h: number,
  x: number,
  y: number,
  touch: boolean,
  meshes: readonly InstancedMesh[],
  items: readonly (readonly Slot<BrainNode>[])[],
  morph = 0,
): Slot<BrainNode> | null {
  const minR = touch ? TAP_RADIUS : MOUSE_RADIUS;
  const v = camera.matrixWorldInverse.elements;
  const p = camera.projectionMatrix.elements;
  const focal = h / 2 / Math.tan((camera.fov * Math.PI) / 360);
  let best: Slot<BrainNode> | null = null;
  let bestInside = false;
  let bestDist = Infinity;
  let bestDepth = Infinity;
  meshes.forEach((m, g) => {
    const a = m.instanceMatrix.array;
    const sem = m.geometry.getAttribute('aSem').array;
    for (const s of items[g]) {
      if (!s.live) continue;
      const o = s.slot * 16;
      const q = s.slot * 4;
      const k = morph * sem[q + 3];
      const shown = 1 - morph + k;
      if (shown < 0.5) continue;
      const wx = a[o + 12] + (sem[q] - a[o + 12]) * k;
      const wy = a[o + 13] + (sem[q + 1] - a[o + 13]) * k;
      const wz = a[o + 14] + (sem[q + 2] - a[o + 14]) * k;
      const vx = v[0] * wx + v[4] * wy + v[8] * wz + v[12];
      const vy = v[1] * wx + v[5] * wy + v[9] * wz + v[13];
      const vz = v[2] * wx + v[6] * wy + v[10] * wz + v[14];
      const depth = -vz;
      if (depth <= camera.near) continue;
      // perspective projection only needs the diagonal + the -1 in w
      const sx = ((p[0] * vx + p[8] * vz) / depth + 1) * 0.5 * w;
      const sy = (1 - (p[5] * vy + p[9] * vz) / depth) * 0.5 * h;
      const dist = Math.hypot(sx - x, sy - y);
      const pr = (a[o] * shown * focal) / depth;
      if (dist > Math.max(pr, minR)) continue;
      const inside = dist <= pr;
      const better = inside !== bestInside ? inside : inside ? depth < bestDepth : dist < bestDist - 0.5 || (Math.abs(dist - bestDist) <= 0.5 && depth < bestDepth);
      if (!best || better) [best, bestInside, bestDist, bestDepth] = [s, inside, dist, depth];
    }
  });
  return best;
}
