// "ตัวเลขสมอง": the export's big-picture numbers (src/brain-stats.ts) as plain-Thai rows in four groups. A number the
// export lacks (an older export, no timed searches yet) drops its row; a group left empty drops too.
import { fmtBytes, fmtDate, fmtInt } from './format.ts';

/** `w`: share of the database (storage breakdown rows, drawn as a bar) · `sub`: a part of the row above (indented, no bar) */
export type NumRow = { label: string; value: string; tip: string; w?: number; sub?: true };
export type NumGroup = { name: string; rows: NumRow[] };

const BOOK = 500_000; // characters in one book (~300 pages): the assumption is spelled out in the row's tooltip
const DEC = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 });
const SEC = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });
const MIN_P95 = 20; // fewer timed searches: p95 is just the slowest one, so that row stays out

export function numberGroups(s: Record<string, number | undefined>, model: string | undefined, at: number): NumGroup[] {
  const ok = (...keys: string[]) => keys.every((k) => Number.isFinite(s[k]));
  const n = (k: string) => s[k] as number;
  const rows = (...list: (NumRow | false)[]) => list.filter((r): r is NumRow => !!r);
  const parts = ['turnsBytes', 'chunksBytes', 'hnswBytes', 'idxBytes'];
  const share = (k: string) => (ok('dbBytes') && n('dbBytes') > 0 ? n(k) / n('dbBytes') : undefined);
  const copy = ok('copyBytes') ? n('copyBytes') : 0; // absent in older exports
  const rest = ok('dbBytes', ...parts) ? n('dbBytes') - copy - parts.reduce((a, k) => a + n(k), 0) : -1;
  const part = (k: string, label: string, tip: string) => ok(k) && { label, value: fmtBytes(n(k)), tip, w: share(k) };
  const secs = (ms: number) => `${SEC.format(ms / 1000)} วินาที`;
  const groups: NumGroup[] = [
    {
      name: 'ความจำ',
      rows: rows(
        ok('textChars') && {
          label: 'ข้อความที่จำไว้',
          value: (n('textChars') >= 1e6 ? `${DEC.format(n('textChars') / 1e6)} ล้านตัวอักษร` : `${fmtInt(n('textChars'))} ตัวอักษร`) +
            (n('textChars') >= BOOK ? ` ≈ หนังสือ ${fmtInt(n('textChars') / BOOK)} เล่ม` : ''),
          tip: `ทุกข้อความในแชต โน้ต และ GitHub รวมโค้ดและผลจากเครื่องมือ · คิดหนังสือ 1 เล่ม ≈ ${fmtInt(BOOK)} ตัวอักษร (ราว 300 หน้า)`,
        },
        ok('facts') && {
          label: 'ข้อเท็จจริงที่ยังใช้อยู่',
          value: fmtInt(n('facts')),
          tip: 'Claude อ่านแชตทุกคืนแล้วสรุปเป็นข้อสั้น ๆ หรือจดเมื่อเจ้าของสั่งให้จำ' +
            (ok('memories') ? ` · จาก ${fmtInt(n('memories'))} จุดความจำในสมอง ซึ่งรวมข้อที่ถูกแทนด้วยข้อใหม่แล้ว การ์ดสรุป และอื่น ๆ` : ''),
        },
        ok('rules') && { label: '└ ในนั้นเป็นกฎ/คำติชมจากเจ้าของ', value: fmtInt(n('rules')), tip: 'สิ่งที่เจ้าของสั่งให้ AI ทำหรือห้ามทำ นับรวมอยู่ในข้อเท็จจริงด้านบนแล้ว', sub: true },
        ok('vaultNotes') && {
          label: 'โน้ตใน Obsidian',
          value: fmtInt(n('vaultNotes')),
          tip: 'โน้ตในแอป Obsidian ไม่รวมความจำที่ระบบนี้เขียนเอง' + (ok('notes') ? ` · โน้ตอื่น ๆ ในสมอง (รวม ${fmtInt(n('notes'))}) มาจากไฟล์ในงานต่าง ๆ` : ''),
        },
        ok('firstChat') && {
          label: 'เริ่มจำแชตตั้งแต่',
          value: `${fmtDate(n('firstChat'))} (${fmtInt(Math.max(0, Math.floor((at - n('firstChat')) / 86400)))} วัน)`,
          tip: 'วันที่ของแชตแรกสุดที่เก็บไว้ จาก AI ตัวไหนก็ได้',
        },
      ),
    },
    {
      name: 'GitHub',
      rows: rows(
        ok('ghRepos') && {
          label: 'repo ทั้งหมด',
          value: fmtInt(n('ghRepos')) + (ok('ghPriv') ? ` (ส่วนตัว ${fmtInt(n('ghPriv'))})` : ''),
          tip: `repo = โฟลเดอร์โค้ดของแต่ละงาน นับทุก repo ที่เจ้าของเข้าถึงได้${ok('ghOrgs') ? ` จาก ${fmtInt(n('ghOrgs'))} บัญชีและองค์กร` : ''} · ในสมองรวมไว้เป็นจุดเดียว เพื่อไม่ให้เดาชื่อได้`,
        },
        ok('ghMine') && { label: 'repo ที่เจ้าของเขียนโค้ดเอง', value: fmtInt(n('ghMine')), tip: 'repo ที่มี commit ของเจ้าของอย่างน้อย 1 ครั้ง' },
        ok('ghCmt') && { label: 'commit ของเจ้าของ', value: fmtInt(n('ghCmt')), tip: 'commit = การบันทึกการแก้โค้ดหนึ่งครั้ง' },
        ok('ghIss') && { label: 'issue และ PR', value: fmtInt(n('ghIss')), tip: 'issue = เรื่องที่แจ้งไว้ · PR = คำขอรวมโค้ด นับเฉพาะที่เจ้าของเกี่ยวข้อง' },
      ),
    },
    {
      name: 'พื้นที่เก็บ',
      rows: rows(
        ok('dbBytes') && { label: 'ฐานข้อมูล PostgreSQL', value: fmtBytes(n('dbBytes')), tip: 'ฐานข้อมูลที่ AI ใช้ค้นความจำ ขนาดรวมบนดิสก์' + (copy > 0 ? ` · ความจำจริงราว ${fmtBytes(n('dbBytes') - copy)} ที่เหลือเป็นสำเนาไว้ทดสอบ` : '') },
        part('turnsBytes', 'ข้อความเต็ม (แชต โน้ต GitHub)', 'ข้อความเต็มของทุกแชต โน้ต และ GitHub'),
        part('chunksBytes', 'ชิ้นความจำ + เวกเตอร์', 'ชิ้นความจำ = แชตที่ตัดเป็นท่อนสั้นไว้ค้น · เวกเตอร์ = ชุดตัวเลขที่แทนความหมายของแต่ละท่อน'),
        part('hnswBytes', 'สารบัญค้นตามความหมาย', 'ดัชนี HNSW: หาท่อนที่ความหมายใกล้กันได้เร็ว โดยไม่ต้องเทียบทีละชิ้น'),
        part('idxBytes', 'สารบัญค้นตามคำ และอื่น ๆ', 'ดัชนีคำไทย/อังกฤษ และดัชนีทั่วไปของตาราง'),
        copy > 0 && part('copyBytes', 'สำเนาไว้ทดสอบ', 'สำเนาข้อมูลไว้ทดสอบความเร็ว ไม่ใช่ความจำจริง'),
        rest > 0 && { label: 'ส่วนอื่น ๆ', value: fmtBytes(rest), tip: 'ตารางเล็ก ๆ และข้อมูลระบบ', w: rest / n('dbBytes') },
        ok('rawBytes', 'rawFiles') && {
          label: 'ไฟล์ต้นฉบับที่สำรองไว้',
          value: `${fmtBytes(n('rawBytes'))} · ${fmtInt(n('rawFiles'))} ไฟล์`,
          tip: 'ไฟล์ต้นฉบับจาก AI ทุกตัวและ GitHub เก็บไว้ในเครื่องของเจ้าของ ไม่ลบทิ้ง',
        },
        ok('vectors', 'dims') && {
          label: 'เวกเตอร์',
          value: `${fmtInt(n('vectors'))} ชิ้น × ${fmtInt(n('dims'))} ตัวเลข${model ? ` (${model})` : ''}`,
          tip: `แต่ละชิ้นความจำถูกแปลงเป็นตัวเลข ${fmtInt(n('dims'))} ตัวที่แทนความหมาย${model ? ` ด้วยโมเดล ${model}` : ''} ที่รันในเครื่อง จึงค้นเจอแม้ใช้คำไม่ตรงกัน`,
        },
      ),
    },
    {
      name: 'ความเร็ว',
      rows: rows(
        ok('p50ms') && {
          label: 'ปกติค้นเสร็จใน',
          value: secs(n('p50ms')),
          tip: 'ครึ่งหนึ่งของการค้นใน 7 วันเร็วกว่านี้ (ค่ากลาง p50)' + (ok('timed7d') && n('timed7d') < MIN_P95 ? ` · วัดได้ ${fmtInt(n('timed7d'))} ครั้ง ตัวเลขยังแกว่ง` : ''),
        },
        ok('p95ms', 'timed7d') && n('timed7d') >= MIN_P95 && { label: 'ครั้งที่ช้า ไม่เกิน', value: secs(n('p95ms')), tip: '95 จาก 100 ครั้งเร็วกว่านี้ (p95)' },
        ok('timed7d') && { label: 'การค้นที่จับเวลา (7 วัน)', value: `${fmtInt(n('timed7d'))} ครั้ง`, tip: 'จำนวนครั้งที่ AI ค้นความจำ และวัดเวลาไว้ ใน 7 วันล่าสุด' },
      ),
    },
  ];
  return groups.filter((g) => g.rows.length);
}
