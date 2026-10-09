// PURE (runs under `node --test`): the brain view's regions on /brain-anatomy.webp (left lateral view, the front faces left),
// their Thai meaning, and the pathways between them. Only erasable TS syntax.
import type { HitType } from '../../lib/live.ts';

/** brain-anatomy.webp: the 1672×941 master cropped to its non-background bounding box (luminance > 30) + 3 % margin (tmp/brainview2/crop.mjs).
 *  The view's aspect ratio follows these; every anchor below is a 0..1 position in this picture. */
export const IMAGE = { w: 1120, h: 904 } as const;

export type RegionId = 'prefrontal' | 'thalamus' | 'hippocampus' | 'amygdala' | 'temporal' | 'parietal' | 'occipital' | 'cerebellum' | 'brainstem';
export interface Region {
  id: RegionId;
  /** position in the image, 0..1 of its width / height */
  x: number;
  y: number;
  /** anatomical name */
  name: string;
  /** what it does in memory-hub */
  role: string;
  text: string;
}

export const REGIONS: readonly Region[] = [
  { id: 'thalamus', x: 0.51518, y: 0.42925, name: 'ทาลามัส', role: 'ประตูรับคำขอ', text: 'request จาก AI เข้า / ออก' },
  { id: 'hippocampus', x: 0.57191, y: 0.54687, name: 'ฮิปโปแคมปัส', role: 'ความจำเหตุการณ์', text: 'แชต AI ทุกแอป' },
  { id: 'temporal', x: 0.34947, y: 0.65721, name: 'กลีบขมับ', role: 'ความรู้ระยะยาว', text: 'fact โน้ต GitHub' },
  { id: 'cerebellum', x: 0.76896, y: 0.73424, name: 'สมองน้อย', role: 'กฎและวิธีทำ', text: 'rule, howto' },
  { id: 'amygdala', x: 0.41665, y: 0.54687, name: 'อะมิกดาลา', role: 'ความสำคัญ', text: 'คะแนนสำคัญ + ใช้บ่อยจำแน่น' },
  { id: 'prefrontal', x: 0.15241, y: 0.33661, name: 'กลีบหน้าผาก', role: 'ตัดสินใจ จัดอันดับ', text: 'แข่งชิงช่อง' },
  { id: 'parietal', x: 0.67939, y: 0.18151, name: 'กลีบขม่อม', role: 'เส้นเชื่อมโยง', text: 'synapse' },
  { id: 'occipital', x: 0.89138, y: 0.44486, name: 'กลีบท้ายทอย', role: 'แผนที่สมอง', text: 'หน้าจอนี้' },
  { id: 'brainstem', x: 0.59878, y: 0.83521, name: 'ก้านสมอง', role: 'ระบบเบื้องหลัง', text: 'ฐานข้อมูล, sync ทุกชั่วโมง, dream กลางคืน' },
];
export const REGION = Object.fromEntries(REGIONS.map((r) => [r.id, r])) as Record<RegionId, Region>;

/** Pathway between two regions (undirected); `bow` = how far the curve bends sideways, as a fraction of its length. */
export interface Edge {
  a: RegionId;
  b: RegionId;
  bow: number;
  /** drawn only: no route travels it */
  decor?: boolean;
}
export const EDGES: readonly Edge[] = [
  { a: 'thalamus', b: 'temporal', bow: 0.16 },
  { a: 'thalamus', b: 'hippocampus', bow: -0.2 },
  { a: 'temporal', b: 'amygdala', bow: 0.2 },
  { a: 'hippocampus', b: 'amygdala', bow: 0.2 },
  { a: 'amygdala', b: 'prefrontal', bow: -0.18 },
  { a: 'prefrontal', b: 'parietal', bow: 0.2 },
  { a: 'parietal', b: 'thalamus', bow: -0.15 },
  { a: 'thalamus', b: 'cerebellum', bow: 0.2 },
  { a: 'thalamus', b: 'prefrontal', bow: -0.12 },
  { a: 'parietal', b: 'hippocampus', bow: 0.16 },
  { a: 'parietal', b: 'temporal', bow: -0.14 },
  { a: 'hippocampus', b: 'prefrontal', bow: 0.2 },
  { a: 'temporal', b: 'prefrontal', bow: -0.22 },
  { a: 'cerebellum', b: 'prefrontal', bow: 0.2 },
  { a: 'brainstem', b: 'hippocampus', bow: 0.16 },
  { a: 'parietal', b: 'occipital', bow: -0.18, decor: true },
  { a: 'brainstem', b: 'cerebellum', bow: 0.2, decor: true },
];
export const edgeOf = (x: RegionId, y: RegionId): Edge | undefined => EDGES.find((e) => (e.a === x && e.b === y) || (e.a === y && e.b === x));

/** Which region a kind of memory lives in; private sources light nothing. */
export const HIT_REGION: Record<HitType, RegionId | null> = {
  chat: 'hippocampus',
  daily: 'hippocampus',
  fact: 'temporal',
  note: 'temporal',
  github: 'temporal',
  rule: 'cerebellum',
  private: null,
};
export const HIT_NAME: Record<HitType, string> = { rule: 'กฎ', fact: 'ข้อเท็จจริง', chat: 'แชต', note: 'โน้ต', github: 'GitHub', daily: 'บันทึกประจำวัน', private: 'ส่วนตัว' };
