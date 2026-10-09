> **TL;DR (ไทย):** ใช้ three.js 0.186.1 WebGLRenderer (WebGL2) คู่กับ pmndrs postprocessing 6.39.5 เขียน shader เองใน BrainScene ไม่ใช้ R3F, drei หรือ WebGPU ในรอบนี้ เพราะ bench แล้ว CPU ต่ำสุด, bundle เล็กสุด และ first frame เร็วสุด ตำแหน่ง node คำนวณไว้ตั้งแต่ตอน export (d3-force-3d, pin ไว้ใน DB) ลูกเล่นแบบเกมเลือกเฉพาะที่ไม่ทำให้สี category เพี้ยน ได้แก่ เส้น Bézier ribbon, comet pulse วิ่งตามเส้น, bloom, shockwave และ fly-to แบบโค้ง ส่วน DOF, GodRays และ nebula เลื่อนไปทำรอบหน้า

# BrainScene renderer: final build spec (2026-10-02)

Base: Proposal 1, which won 2 of 3 judges for its engine, robustness and picking. Grafted on top:
- From Proposal 0: the visual layer.
- From Proposal 2: the URL override, unit-tested pure modules and the prefix fast path.

Anything a judge flagged as unverifiable or too risky has been dropped (see the list at the end of §4).

---

## 1. Decision

**Engine:** three.js **WebGLRenderer (WebGL2)** plus pmndrs **postprocessing**. It is imperative code inside one client component. There is no R3F, no drei and no WebGPU in this build.

| Package | Exact pin (no `^`) | License | Where |
|---|---|---|---|
| three | 0.186.1 | MIT | web dependency |
| @types/three | 0.186.0 | MIT | web devDependency |
| postprocessing | 6.39.5 | Zlib | web dependency. Its peer range is `three >=0.168.0 <0.187.0`, so three stays on 0.186.x |
| d3-force-3d | 3.0.6 | MIT | root dependency, used only by the Node layout bake |
| playwright-core | 1.63.0 | Apache-2.0 | web devDependency, used only by `scene-check.mjs` |
| **remove** react-force-graph-3d | 1.29.2 | MIT | This also drops 3d-force-graph, three-forcegraph, three-render-objects and their bundled `three/webgpu` |

I re-checked all versions and licenses with `npm view` on 2026-10-02. Camera controls come from `OrbitControls` in `three/addons`, which costs 0 KB extra. Picking is done in screen space, so no extra dependency is needed.

**Why: bench results** (`D:\memoryhub\tmp\bench`, same scene, x4 = 10,160 nodes / 12,268 links, uncapped fps, JS CPU ms per frame):

| Path | Desktop x1 / x4 | Mobile-emulated x1 / x4 | gzip | First frame |
|---|---|---|---|---|
| **three WebGLRenderer + postprocessing** | **4,470 / 2,003 (0.08 / 0.18 ms)** | **1,126 / 956 (0.49 / 0.63 ms)** | **149 KB** | **111 ms** |
| three WebGPURenderer + TSL | 1,423 / 1,274 (0.41 / 0.56) | 277 / 291 (2.56 / 2.49) | 248 KB | 240 ms |
| the same, on its WebGL2 fallback | 1,392 / 851 (0.62 / 1.08) | 533 / 500 | 248 KB | 348 ms |
| Babylon 9.29 WebGL2 | 4,746 / 2,304 | 1,115 / 968 | 418 KB fetched | 243 ms |

- The GPU took only 0.17–0.54 ms per frame on every native path, so nothing is GPU-bound. WebGPU buys no speed here.
- WebGPURenderer costs about 5× the CPU per frame.
- WebGPURenderer's own WebGL2 fallback, which iOS below 26 and Firefox on Android and Linux would get, ran at 851 fps against 2,003 for plain WebGL2.
- Babylon fetched wasm from cdn.babylonjs.com, which breaks the no-third-party rule.
- At 10k nodes, a one-mesh-per-node design hits three.js issues https://github.com/mrdoob/three.js/issues/30560 and /33821. The placeholder does exactly that.

**Backend strategy**
- WebGL2 only. caniuse lists 96.44% global support, including iOS Safari 15+ (https://caniuse.com/webgl2). WebGPU support is about 87% and needs iOS 26 (https://caniuse.com/webgpu).
- If `getContext('webgl2')` fails, the device gets tier **T0**: a notice "3D ไม่รองรับบนอุปกรณ์นี้ / 3D unavailable", while the HUD, timeline and tables keep working.

**When to revisit WebGPU:** once postprocessing v7 is stable (https://github.com/pmndrs/postprocessing/releases), or once we need TSL compute or TRAA. The migration would only touch the 3 GLSL shaders and `fx.ts`; scene structure, data flow and tiers stay as they are.

---

## 2. Module layout and props contract

```
web/app/components/BrainScene.tsx      React shell, same path → page.tsx's next/dynamic({ssr:false}) is unchanged
web/app/components/brain/
  engine.ts    createEngine(): owns its own <canvas> + WebGLRenderer, loop (demand / 30 fps cap), setSize + 0×0 pause,
               visibility pause, contextlost → onLost, tier apply, debug hooks (window.__brain only with ?debug=1)
  style.ts     PURE: palette→linear, shape/size table, link-kind style, fire constants + fireColor() TS mirror, tier table
  slots.ts     PURE: id→slot diff (prefix fast path), Fibonacci fallback placement, node→edge adjacency
  quality.ts   PURE initialTier() + Governor class (downgrade-only, persisted)
  nodes.ts     5 InstancedMeshes + node ShaderMaterial
  edges.ts     1 instanced Bézier ribbon mesh + comet shader, pulse dispatch
  fx.ts        EffectComposer chain per tier, dust Points, ShockWave
  camera.ts    OrbitControls, framing, intro, arc fly-to, follow, idle orbit, user override
  pick.ts      screen-space nearest-node picking
  brain.test.ts  node --test for slots/style/quality
web/scripts/scene-check.mjs            headless browser acceptance checks (§9)
src/layout.ts                          Node layout bake (§3)
test/layout.test.ts                    bake determinism + pinning (root `npm test`)
```

**Rules**
- `BrainScene.tsx` and `components/brain/*` are the only modules that may import three or postprocessing. Update the header comment to say so.
- The pure modules (`style.ts`, `slots.ts`, `quality.ts`) import with explicit `.ts` extensions and use only erasable TS syntax, so `node --test` runs them directly. This needs `"allowImportingTsExtensions": true` in `web/tsconfig.json`, which is legal because `noEmit` is true. Verify in step 1.
- Reuse what already exists: `FAMILY_COLOR`, `linkKey`, `BrainNode`/`BrainLink`/`BrainEvent` from `lib/brain.ts`; `useSize` from `lib/hooks.ts`; and the placeholder constants `FLY_MS=1500`, `FLY_EVERY_MS=4000`, `USER_PAUSE_MS=20000`, `TAP_RADIUS=28`.

**Props contract: unchanged** from `BrainScene.tsx` today:

```ts
graph: { nodes; links; rev }        activeEvents: readonly BrainEvent[]   follow: boolean   reducedMotion: boolean
selectedNodeId?: string|null        focus?: {nodeId}|null                 onHover(node|null, xy|null)
onSelect(node|null)                 onAutoFollowPause?(untilEpochMs)
```

There is one header edit: "ids only, no positions" becomes "**positions baked as optional `xyz`**; nodes without `xyz` are placed by the scene".

**Engine API** (internal to the folder):

```ts
createEngine(host: HTMLElement, o: {tier, reducedMotion, debug, probe, view?}): Engine
engine.setGraph(g) · fire(events) · setFollow(b) · setReducedMotion(b) · setSelected(id) · focus(id)
engine.setSize(w, h)                         // 0×0 → paused
engine.cb = {hover, select, autoFollowPause, lost(reason: 'context'|'tier', view)}
engine.getView() / dispose()                 // dispose: remove canvas, dispose GPU objects, renderer.forceContextLoss()
```

**What the shell does**
- Keeps the latest props in a ref, the same way the placeholder's `P` ref works, so callbacks never re-create the engine.
- Processes each distinct `activeEvents` array identity exactly once.
- On `lost`, bumps a React key so the engine remounts on a fresh canvas, passing the old camera `view` through. This one path covers context restore, a tier change that crosses the composer/antialias boundary, and StrictMode double-mounts. The engine owns its canvas, so `forceContextLoss` on dispose is safe.

---

## 3. Layout: baked at export time, client runs zero ticks

**Change in `src/brain.ts`** (R1, the HUD and data engineer must agree)
- Add `xyz?: [number, number, number]` to `BrainNode`: integer world units, stable across exports. Mirror the same field and comment in `web/app/lib/brain.ts`.
- In `buildBrain`, wrap `id()` so it records `rawOf.set(finalId, raw)`, then call `await bakeLayout(db, nodes, links, rawOf)` before `return`.
- This covers every caller of `buildBrain`: `brain --out` (npm run data), `brain-serve` and `publish`. It is also why the bake lives in `buildBrain` and not only in the CLI.

**Pin store:** `state` table, `k = 'layout'`, `v = { [rawKey]: [x,y,z] }`. It reuses the table that `publish` already uses, and holds about 300 KB at 10k nodes.
- I checked `brain.ts`: public and local graphs are structurally identical. Only the id hash and labels differ.
- Because the store is keyed by raw key, both modes get the same coordinates.
- The coordinates come only from nodes and links that are already published, so they leak nothing new. Raw keys stay in the local DB.

**Pure core:** `relax(nodes, links, ticks)` in `src/layout.ts`.
1. Sort nodes by `(t0, rawKey)` and use d3-force-3d's `randomSource` with a seeded LCG. Same input, same output (https://github.com/vasturiano/d3-force-3d).
2. Nodes that are already pinned get `fx/fy/fz`.
3. Each new node is seeded at its parent's position ± 2 units (seeded jitter). The parent is the subagent's spawn source if there is one, otherwise `p`. Projects get a Fibonacci shell around the origin.
4. Forces: `numDimensions 3`, `forceLink` (short and strong for spawn and in, weak for link, similar and coaccess), `forceManyBody().theta(0.9)` and `forceCenter`. The constants are starting values; tune them once by eye and record them in `layout.ts`.
5. Ticks: **300** when no pins exist (first bake, or `--rebake`, which deletes `state.layout`), **60** when at least one node is new, **0** otherwise. Because of the 0-tick case, `brain-serve` rebuilding every 5 s costs nothing unless a node is new.
6. Write rounded integers to `n.xyz` and upsert the pin store when it changed.

Measured in research: full bake 4.3 s at 2.5k nodes and 25.8 s at 10k (first time only); +72 new nodes in 0.93 s; pinned nodes move 0. Payload grows by about 13 KB gzip at 2.5k and about 54 KB at 10k.

**Client side**
- `feedOf` copies node objects, so `xyz` flows through. `store.ts` keeps node objects whole, so no change is needed there.
- Its change detection ignores `xyz` on purpose: positions never change except after a full re-bake, and a reload handles that.
- A live node without `xyz` gets `slots.placeFallback(parentPos, parentR, ordinal)`: golden-angle direction `k`, radius `4·parentR + 6·floor(k/48)`. It is deterministic and costs 0 ticks. The next export relaxes it.

---

## 4. Rendering

**Common to all scene materials**
- Use `ShaderMaterial`, not Raw, so three injects `instanceMatrix`. Programs compile as GLSL 3.00, so `gl_InstanceID` is available.
- End the fragment shader with `#include <colorspace_fragment>`. Set `toneMapped:false` and `NoToneMapping`; Neutral tone mapping would compress #3987e5, whose blue channel is 0.784 linear, above the 0.76 knee (https://github.com/KhronosGroup/ToneMapping/blob/main/PBR_Neutral/README.md).
- The clear colour is `#07090f`. The time uniform is `performance.now()/1000` measured from engine start.

### Nodes (`nodes.ts`): 5 draw calls, one InstancedMesh per type, `frustumCulled=false`

| type | hue (uniform per mesh) | geometry (secondary encoding) | triangles | base r |
|---|---|---|---|---|
| project | #3987e5 | icosahedron, detail 1 (2 on ultra) | 80 | 6 |
| session | #199e70 | octahedron | 8 | 2.5 |
| subagent | #199e70 | tetrahedron | 4 | 1.2 |
| note | #d95926 | box | 12 | 1.8 |
| memory | #d95926 | diamond (octahedron with y × 1.6) | 8 | 1.8 |

**Size:** `r = base × min(3, 1 + 0.25·log2(1+n))`, stored in `instanceMatrix`.

**Instance attributes:**
- `aTime = vec3(born, dead, fire)`; `dead = 1e9` means alive.
- `aParent` (vec3).
- `aExtra = vec2(fireAmp, rimLevel)`.

**Vertex shader**
- Birth: `k = clamp((t-born)/0.6)`, position `mix(aParent, pos, easeOutBack(k))`, scale × `k`.
- Death: shrink over 0.25 s.
- Hover and selected (per-mesh uniforms `uHoverId`/`uSelId` compared with `gl_InstanceID`): scale ×1.4.
- Low tier, while firing: scale ×1.3.

**Fragment shader** (flat face normals give a faceted, crystal look):

```glsl
act  = exp(-(t - fire) * 3.0) * fireAmp;                  // reduced motion: step(t-fire, 1.5) * fireAmp * 0.5
col  = mix(uBase, vec3(1), 0.55 * act) * (1.0 + 2.5 * act);   // goes toward WHITE, so a clip yields white, never cyan
col += vec3(1) * rimLevel * pow(1.0 - abs(dot(N, V)), 3.0);   // white fresnel rim; rimLevel = 0.12 + 0.3*min(1, log2(1+u)/5)
col *= mix(1.0, 0.5, smoothstep(uDimNear, uDimFar, viewDepth));   // depth cue that changes luminance only
// u < 0 (superseded): col *= 0.45, rim off.  Selected: rim += 0.6 (pulses with sin(4t) unless reduced motion)
```

- Base colours stay at or below 0.784 linear, and base plus rim stays at luminance 0.73 or less, so **resting nodes never cross bloom threshold 1**. Only firing nodes glow.
- `style.ts` exports the same constants plus a `fireColor()` mirror, which the unit test checks.

### Edges (`edges.ts`): 1 draw call, an instanced ribbon for every link

**Geometry**
- The base strip has `(S+1)×2` vertices. `position = (t, side, 0)`; `S` comes from the tier, and `S=1` gives a straight quad.
- Instance attributes: `aA, aB, aColA, aColB` (linear endpoint hues), `aTime = vec4(born, dead, fire, dir)` and `aStyle = vec3(gain, widthPx, dashed)`.

**Vertex shader**
- Quadratic Bézier with control point `C = mid + normalize(mid - uCentroid)·0.15·|B-A|`.
- Project `P(t)` and `P(t+ε)`, then offset sideways in screen space by `side·widthPx` (independent of DPR). This works on every GPU, unlike `gl.lineWidth`.

**Colour rule:** the body is **neutral grey-white**, `0.55·gain`, and only the last 20% at each end tints toward that endpoint's hue.

**Blending: `CustomBlending` + `MaxEquation`**, with premultiplied rgb, `depthWrite:false` and `depthTest:true`.
- This is a spec decision on top of the proposals.
- Max blending cannot pile up overlapping edges. That rules out both the cyan/mint mixing seen in `shot-three-webgl-desktop.png` and the 874-link hub blooming into a white blob.
- `MaxEquation` exists in r186 (`src/constants.js:205`).

| kind | gain | width | style |
|---|---|---|---|
| spawn | 0.25 | 1.2 px | solid |
| in | 0.35 | 1.2 px | solid |
| link | 0.5 | 1.0 px | solid |
| similar | 0.15 | 1.0 px | dashed (`fract(u·len/4) > .5` → discard) |
| coaccess | 0.1 + 0.4·w | (0.8 + w) px | solid |

Link kinds differ by brightness, width and dash. **Never by hue.**

**Growth:** a new link draws from source to target, `u < clamp((t-born)/0.5)`, and fades out over 0.25 s after `dead`.

**Event pulses (comets)**
- An event on node X sets `aFire = now` and `dir = ±1` on up to `fanout` incident edges, within a per-batch `budget`.
- These are sparse `addUpdateRange` writes, using the adjacency map from `slots.ts`.
- Events over the budget only light up the node.
- Fragment shader: `h = (t-fire)·speed/len`; `d = h - u'`, where `u' = dir<0 ? 1-u : u`; `c = (0<d<0.25) ? (1-d/0.25)² : 0`; `col += mix(srcHue, white, .7)·(1+3c)·c`, so the head goes past 1 and blooms.
- At S ≥ 6 the vertex shader widens the ribbon ×(1 + 1.5c) at the head.

**Ambient comets** (replace particle "sparks"; no extra geometry or buffers)
- Edges with `hash(gl_InstanceID) < uAmbient` carry a faint white comet: `h = fract(t·0.15 + hash2)`, intensity 0.7, or 1.3 on ultra so they bloom slightly.
- They only ever run on visible edges, so the brain never looks dead.

**Reduced motion:** no ambient comets. An event pulse becomes a static brightening of the whole edge for 1.5 s, with no movement.

### Backdrop (`fx.ts`)
- Dust: one `Points` shell between 1.1R and 2.5R. Neutral white at 0.35, 1–2 px, round mask, additive.
- It drifts in the vertex shader by `0.02R·sin(0.05t + seed)` and is frozen under reduced motion.
- No nebula and no HDRI.

### Post chain (`fx.ts`, postprocessing 6.39.5)
- `EffectComposer(renderer, {frameBufferType: HalfFloatType, multisampling: 4})` → `RenderPass` → `EffectPass(camera, bloom, shockwave?, vignette?, noise?)`.
- Bloom is `BloomEffect({mipmapBlur:true, luminanceThreshold:1, luminanceSmoothing:0.03, intensity, radius, levels})`.
- **Do not use `resolutionScale` on bloom.** The 6.39.5 typings mark it "Deprecated. Use mipmapBlur instead", so tiers scale bloom through `levels` and DPR.
- `NoiseEffect` is monochrome (`vec3(rand)`). Set its opacity through `blendMode.opacity`, with `premultiply:true`.
- `ShockWaveEffect(camera, pos, {amplitude ≤0.05})` calls `.explode()` when a project or session is born, at most once every 2 s, and not during fade-mode bursts (§6). If `EffectPass` rejects the merge, give it its own `EffectPass`.
- **Never used:** chromatic aberration (it adds new-hue fringes), DOF, GodRays, nebula, TRAA, camera shake.

**Dropped as unverifiable or too risky:**
- R3F, drei and matcap: a +85 KB bundle, CDN traps, and a less game-like look.
- camera-controls: OrbitControls is enough. Revisit if touch feels bad on real phones.
- CPU-interpolated spark meshes.
- A separate spark `Points` system: ambient comets replace it.
- Promote-to-ULTRA governor: frame rate is capped, so spare headroom can't be measured.
- Swap-remove slots.
- Bloom threshold 0.55.
- Additive edges tinted with the source hue.
- Bloom `resolutionScale` per tier.
- Shake.
- Nebula, DOF and GodRays: deferred.

---

## 5. Quality tiers

| | ULTRA (opt-in only) | HIGH | MEDIUM | LOW | T0 |
|---|---|---|---|---|---|
| Typical device | desktop dGPU, Apple M Pro | desktop, M1/M2, Iris Xe | phones, weak iGPU | budget Android, old iPhone, no half-float | no WebGL2 |
| Context | antialias:false | antialias:false | antialias:false | **antialias:true**, no composer | none |
| DPR cap / floor | 2 / 1.25 | 1.5 / 1 | 1.5 / 1 | 1 / 0.75 | none |
| Composer | MSAA 4, bloom (intensity 1.2, radius .75, levels 8), ShockWave, vignette (.3/.45), noise .025 | MSAA 4, bloom (1.0/.7/6), ShockWave, vignette, noise | MSAA 4 (cheap on tile GPUs), bloom (0.9/.6/5), vignette | none; fake glow = whitening + scale ×1.3 | none |
| Ribbon segments S | 24 | 12 | 6 | 1 | none |
| Ambient comet fraction | 0.30 | 0.15 | 0.06 | 0 | none |
| Pulse fan-out per event / budget per batch | 24 / 256 | 16 / 128 | 8 / 64 | 4 / 16 | none |
| Dust | 40k | 15k | 4k | 0 | none |
| Target / GPU budget (**estimated, unmeasured**) | 60 fps / ≤8 ms | 60 / ≤10 ms | 30 on coarse pointer, else 60 / ≤20 ms | 30 / ≤25 ms | none |

**Starting tier** (`quality.initialTier`, pure):
1. `?q=low|medium|high|ultra` wins. `?q=auto` clears the persisted tier.
2. Otherwise use `localStorage.brainTier` if set.
3. Otherwise detect:
   - `navigator.connection.saveData` → LOW.
   - Coarse pointer and (`hardwareConcurrency ≤ 4` or `deviceMemory ≤ 3`) → LOW. Undefined values are ignored.
   - Coarse pointer → MEDIUM.
   - Fine pointer with `hardwareConcurrency ≤ 4` → MEDIUM.
   - Otherwise HIGH.
4. Finally, if neither `EXT_color_buffer_half_float` nor `EXT_color_buffer_float` is present, or the composer throws while being built, use LOW.

**Governor** (PerformanceMonitor-style, downgrade-only):
- Takes the median rAF delta over 2 s windows.
- Ignores deltas over 250 ms (hidden tab), the first 3 s after load, and the time spent in a fly-to.
- If the median exceeds 1.25× the target for 2 windows in a row, it scales DPR by 0.85 until it reaches the tier floor, then drops one tier.
- It locks after 3 downgrades and persists the tier.
- It never promotes.
- When a change crosses the MEDIUM↔LOW boundary, it calls `lost('tier', view)` and the shell remounts with a new context (§2).

**Loop**
- Pauses when `document.hidden` or the canvas is 0×0 (the bench found that a hidden 0×0 pane breaks WebGPU and rAF).
- On 30 fps targets it renders every other frame.
- **It renders on demand** when nothing is animating: no fire or comet within its decay window, no tween, no orbit, no dust, no damping.

**Reduced motion (the `reducedMotion` prop)**
- No intro, orbit, ShockWave, noise, dust motion or ambient comets.
- Births and deaths are instant.
- Pulses become static 1.5 s brightness steps; the engine invalidates at the start and end of each step.
- Camera moves are cuts.
- Follow flights are suppressed. The contract says "may fly", so only explicit focus or select moves the camera.
- The scene renders only on demand.

---

## 6. Camera and animation semantics

**Camera (`camera.ts`)**
- Uses `OrbitControls` with damping and the default touch gestures (one finger rotates, two fingers dolly and pan).
- R is the bounding radius of the baked positions. `maxDistance = 3R`, `near = 0.5`, `far = 10R`, fov 50.
- **Framing:** the first graph frames the centroid at 2.2R.
- **Intro** (ULTRA, HIGH, MEDIUM): dolly in from 2.5× that distance over 2.5 s with easeOutCubic. Any user input cancels it.
- **Fly-to(node):** a tween over `FLY_MS` with easeInOutCubic that moves the camera and `controls.target` together.
  - The end point keeps the current viewing direction, at distance `max(6r, 0.08R)`.
  - When the move is longer than 0.3R, the distance to the target is scaled by `1 + 0.35·sin(πk)`, which pulls back mid-flight like a two-phase cinematic move in one tween.
  - User input cancels it. Under reduced motion it is a cut.
- **Triggers:** a new `focus` object identity; a click (fly, then `onSelect(node)`); and follow.
- **Follow:** on a new batch, if `follow`, not reduced motion, `now > pausedUntil` and `now - lastFly ≥ FLY_EVERY_MS`, fly to the visible node with the largest summed event `n` in the batch.
- **Idle orbit:** `autoRotate` when `follow` is on, motion is allowed, the camera is not paused and nothing is flying. Use `autoRotateSpeed 0.4` with `update(dt)`, which is about 0.04 rad/s (r186 `OrbitControls.js:936`: angle = 2π/60·speed·dt).
- **User override:** the controls `start` event sets `pausedUntil = now + USER_PAUSE_MS`, calls `onAutoFollowPause(pausedUntil)`, cancels the tween and stops orbiting.

**Replay and live diff (`slots.ts`)**
- Slots are allocated per type (and per link key via `linkKey`) in order of first appearance and are **never freed**. `mesh.count` is the highest live slot.
- Capacity is `nextPow2(1.25·n)`. When it overflows, that one geometry's typed arrays are reallocated.
- **Prefix fast path:** pointer-compare `next.nodes[i] === prev.nodes[i]` to find the first divergence `d`, then id-diff only the tails.
- The store re-slices one sorted array, so `d` is usually near the end. A live mid-array insert falls back to a full diff, at about 0.5 ms at 10k nodes (estimated).
- **New node:**
  - `born = now`, `aParent` = the parent's current position, giving an extrude-from-parent animation over 0.6 s with easeOutBack.
  - **More than 300 births in one diff** (replay jump): `born = now - 0.45`, a 0.15 s settle instead of a pop-in.
  - **First graph** after mount: `born = -1e6`, which is instant.
  - Reduced motion: instant.
- **Removed (scrub back):** `dead = now`, shrinking over 0.25 s. A node that reappears revives its old slot.
- **Replaced object** (`n`, `u` or label changed): rewrite only that slot's scale and rim.
- **Events:** ignore ids not in `graph`. `fireAmp = min(1, 0.4 + 0.2·log2(1+n))`. All event kinds look the same; no kind is encoded by hue.

---

## 7. Picking and hover (`pick.ts`)

- Picking is screen-space nearest, not a raycast. It suits tiny tetrahedra and fingers.
- On `pointermove`, throttled to one per rAF, project the live slots' positions from the CPU `Float32Array` (target positions).
- **Hit radius:** `max(projectedRadius, 10 px)` for a mouse, `max(projectedRadius, TAP_RADIUS=28 px)` for touch. Ties go to the smaller depth.
- **Callbacks:**
  - `onHover(node, {x,y})`, with CSS px relative to the scene, on change and on every move while a node stays hovered.
  - `onHover(null, null)` on leave.
  - Click is a move under 5 px and under 500 ms: `onSelect(node)` after starting the fly, or `onSelect(null)` on empty space.
- **Highlight:** per-mesh uniforms `uHoverId`/`uSelId`, with no buffer writes.
- **Labels** stay in the HTML HUD. No troika or Text, which carry CDN traps.
- **Cost** at 10k nodes is estimated at about 0.3 ms on desktop and about 2 ms on a phone; not measured.
- `// ponytail:` at about 100k nodes, switch to a GPU id-buffer pass.

---

## 8. Implementation plan (one engineer, in order)

| # | Task | Verification |
|---|---|---|
| 0 | Agree on the `xyz` contract change with the HUD/data engineer (R1) | Written OK |
| 1 | Deps: web pins `three@0.186.1`, `@types/three@0.186.0`, `postprocessing@6.39.5`, devDep `playwright-core@1.63.0`; root `d3-force-3d@3.0.6`. Add `allowImportingTsExtensions` to tsconfig and web scripts `"test": "node --test app/components/brain/brain.test.ts"`, `"check": "node scripts/scene-check.mjs"`. **Keep react-force-graph-3d until step 11.** | `npm ls three` shows a single 0.186.1; `npm run typecheck && npm run build` pass |
| 2 | `src/layout.ts` (`relax` + `bakeLayout`), the `rawOf` hook in `buildBrain`, the `xyz` type in both `brain.ts` files, and the `--rebake` flag | `npm test` (root) passes `test/layout.test.ts`: same input gives byte-identical xyz, adding nodes moves pinned ones by 0, no NaN, every node gets integer xyz. `npm run data` shows xyz on 100% of nodes, a logged bake time, and a gzip delta of ≤ +20 KB. A public build plus `assertAnonymous` still passes |
| 3 | `style.ts`, `slots.ts`, `quality.ts` + `brain.test.ts` | `npm test` (web): diff cases (append, scrub back, revive, live mid-insert, replaced object, prefix fast path equals full diff); deterministic fallback placement; `fireColor` for each base hue at act 0…1 stays within ±15° of base hue or has saturation < 0.15 after clipping; `initialTier` truth table |
| 4 | `engine.ts` + `nodes.ts` + the new `BrainScene.tsx` shell (T0 notice, own canvas, remount key) | Pixel probe passes (§9) for the 5 types and the background; `?debug=1` exposes `__brain.{tier,frames,cpuMs,firstFrameMs,calls}` |
| 5 | `edges.ts`: ribbon, max blend, growth, comets, ambient comets | Screenshot review; the hue-histogram check passes at x1 and x4; the hub check passes (pixels with all channels ≥250 are < 0.5% of the frame) |
| 6 | `fx.ts`: composer per tier, dust, capability gate | `?q=low|medium|high|ultra` each render with no errors; scene draw calls ≤ 8 |
| 7 | `camera.ts` | scene-check: a focus change settles within `FLY_MS + 200 ms`; dragging fires `onAutoFollowPause`; under reduced motion the camera matrix stays static over 3 s idle |
| 8 | `pick.ts` + hover/select wiring | scene-check: the mouse at a probe node's projected position gives a `__brain.lastHover` id match; a click calls `onSelect`; a touch-emulated tap 20 px away still hits |
| 9 | `Governor`, persistence, MEDIUM↔LOW remount, context-loss remount, 0×0 and hidden pause | scene-check: `__brain.debugSlowMs = 40` drops the tier, locks it and persists it; `WEBGL_lose_context` lose and restore resumes frames within 2 s; `display:none` for 2 s and back gives no errors |
| 10 | Showpiece layer: ShockWave on births, intro dolly, ULTRA tier, final constants tuned in `style.ts` | Screenshot checklist (§9) plus FPS thresholds still pass |
| 11 | Cleanup: delete the placeholder engine code, remove `react-force-graph-3d`, update the header comment | `grep -r "react-force-graph\|UnrealBloom" web/app` is empty; build gate (§9) passes; flag `tmp/bench/node_modules` (136 MB) to ลุงจืด for deletion |
| 12 | Manual device matrix | See §9 item 9 |

---

## 9. Acceptance tests (`web/scripts/scene-check.mjs`)

**Harness**
- `next build` (static export), then serve `out/` on localhost.
- Launch system Chrome headless with the real GPU through playwright-core, using the same launch path as `tmp/bench/run.mjs`. Do not use the Browser pane: it is hidden, 0×0, and rAF never fires there.
- `page.route('**/graph.json')` serves fixtures: the real data, the x4 synthetic set (about 10k nodes / 15k links), and a 5-node probe fixture.
- Views: desktop 1600×900 at DPR 1; mobile 390×844 at DPR 3 with a 4× CPU throttle.
- Uncapped runs use `--disable-gpu-vsync --disable-frame-rate-limit`.

| # | Check | Pass criteria |
|---|---|---|
| 1 | Build | `npm run typecheck`, `npm test`, `npm run build` all exit 0; `out/index.html` exists |
| 2 | Console | 0 page errors, 0 console errors, 0 warnings matching `/THREE\|WebGL\|GL_\|shader/` in every case |
| 3 | Network | Every request is same-origin, `data:` or `blob:`. Any other origin, or any failed request, fails. Build gate: `grep -rE "cdn\.\|unpkg\|jsdelivr\|githack\|gstatic\|googleapis\|babylonjs\|fonts\." out/` returns nothing |
| 4 | Bundle | gzip -9 sum of `out/_next/static/chunks/*.js` files containing `isWebGLRenderer` or `BloomEffect` is **≤ 175 KB** (bench: 149) |
| 5 | Performance (`?q=high` desktop, `?q=medium` mobile) | Uncapped: desktop x4 ≥ 500 fps, mobile x4 ≥ 240 fps (about 25% of bench; GPU is shared with the local LLM). CPU p95 ≤ 2 ms desktop, ≤ 8 ms throttled. `firstFrameMs` ≤ 500 desktop, ≤ 1500 mobile. After the first green run, store a baseline and fail below 75% of it |
| 6 | Palette: probe | `?probe=1` with the 5-node fixture turns off rim, depth dimming, pulses, dust, vignette, noise and intro, and fixes the camera. The centre pixel of each type equals its `FAMILY_COLOR` ±2/255, and the background equals `#07090f` ±2/255. Run at `q=low` and `q=high` |
| 7 | Palette: no new hues | `__brain.hueStats()` reads pixels in the render frame. ≥ 97% of saturated pixels (S > 0.35, V > 0.15) fall within ±18° of 213° (blue), 159° (green) or 17° (orange). Run on the default view at x1 and x4, and during a burst (`__brain.fire(ids)` × 64). An off-palette pixel whose 3×3 neighbourhood holds two different families is an MSAA resolve between two nodes: counted as `blend` and left out of the ratio (2026-10-06: x4 was 0.967 on every commit since the first; MSAA off gives 0.999; an orange shifted to 41° still fails) |
| 8 | Reduced motion | `emulateMedia({reducedMotion:'reduce'})` with an idle fixture: `__brain.frames` grows by fewer than 5 over 3 s, two readbacks 1 s apart are identical, and the camera does not move after an event batch |
| 9 | Manual devices (before publishing) | iPhone on iOS 26 Safari, iPhone on iOS 17/18, a mid-range Android on Chrome, an Intel UHD laptop, Firefox desktop. Record the tier, steady fps after 5 min (thermal) and touch picking, using `?debug=1` |

**Screenshots** (saved to `tmp/scene-check/`): desktop overview, desktop x4, firing burst, focused node after a fly, replay at about 25% growth, mobile portrait, `q=low`, reduced motion.

Review checklist:
- The three hues are distinct.
- No cyan, mint, purple or yellow regions.
- The 874-link hub is not a white blob.
- Comet heads are visible in the burst shot.
- Node shapes are distinguishable when focused.
- Edges are subdued against the `#07090f` background.

---

## 10. Risks and fallbacks

| Risk | Fallback |
|---|---|
| three is stuck below 0.187 until postprocessing widens its peer range | Exact pins; upgrade both together on purpose. WebGPU/TSL migration covers 3 shaders plus `fx.ts` |
| Custom GLSL (node, ribbon, dust) misbehaves on some mobile GPU | `?q=low` (S=1, no composer) is the escape hatch for users. The pixel probe and hue checks catch colour-space mistakes |
| Max blending makes dense fans look flat | Try additive with lower gains, kept only if check 7 and the hub check still pass |
| Phone GPU cost is unmeasured; all ms budgets are estimates | Downgrade-only governor, `?q=` override, manual device matrix before publishing |
| Half-float or MSAA render targets missing or broken on old iOS | Capability gate plus a try/catch around composer construction, forcing LOW (native antialias, no composer) |
| iOS and Safari lose the context when backgrounded | Remount path, which rebuilds everything from the current props |
| Governor downgrades by mistake (shared GPU, hiccups) | Ignore deltas over 250 ms and a warm-up window; `?q=auto` resets |
| Pinned layout crowds hubs over a year | `--rebake`: one visible reshuffle, then reload |
| Bake time at 10k (about 26 s first bake) and `brain-serve` relaxing every 5 s | 0 ticks when nothing is new; 60-tick incremental is about 1 s |
| Determinism depends on node order and the seed | Sort by `(t0, rawKey)`, seeded LCG, determinism test in step 2 |
| `allowImportingTsExtensions` conflicts with the Next build | Verified in step 1. If it fails, run the pure-module tests through the scene-check page instead |
| Bloom whites out during fast replay (64 events/batch at 30 Hz) | Per-batch pulse budget, `fireAmp` cap, threshold 1; check 7 runs on the burst view |
| Screen-space picking is approximate under occlusion | Depth tie-break; GPU id buffer only if ever needed |
| The `xyz` contract change touches the HUD engineer's data layer | Optional field; the scene places any node without it, so old graph.json files still render |

Sources:
- https://caniuse.com/webgl2
- https://caniuse.com/webgpu
- https://github.com/mrdoob/three.js/issues/33821
- https://github.com/mrdoob/three.js/issues/30560
- https://github.com/mrdoob/three.js/issues/31250
- https://github.com/pmndrs/postprocessing/releases
- https://github.com/pmndrs/react-three-fiber/releases
- https://github.com/graphty-org/graphty-monorepo/blob/master/graphty-element/docs/decisions/renderer-webgpu.md
- https://github.com/vasturiano/d3-force-3d
- https://github.com/KhronosGroup/ToneMapping/blob/main/PBR_Neutral/README.md
- Measured: `npm view` (2026-10-02); postprocessing 6.39.5 `build/types/index.d.ts` (BloomEffect options, multisampling, ShockWaveEffect); three r186 `src/constants.js`, `OrbitControls.js`.

Files referenced:
- `D:\memoryhub\web\app\components\BrainScene.tsx`
- `D:\memoryhub\web\app\lib\brain.ts`
- `D:\memoryhub\web\app\lib\store.ts`
- `D:\memoryhub\src\brain.ts`
- `D:\memoryhub\src\cli.ts`
- `D:\memoryhub\sql\schema.sql`
- `D:\memoryhub\tmp\bench\`