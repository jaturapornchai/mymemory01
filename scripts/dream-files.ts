// Helper for answering dream requests by hand / by Claude agents (files runner).
//   node scripts/dream-files.ts unpack <x.request.json>            → x.system.md, x.user.txt, x.schema.json next to it
//   node scripts/dream-files.ts answer <x.request.json> <ans.json> → validate (schema + ids) and write x.result.json
import { readFileSync, writeFileSync } from 'node:fs';
import { SchemaA, SchemaB } from '../src/dream.ts';

const [cmd, reqPath, ansPath] = process.argv.slice(2);
const req = JSON.parse(readFileSync(reqPath, 'utf8'));
const base = reqPath.replace(/\.request\.json$/, '');
if (cmd === 'unpack') {
  writeFileSync(`${base}.system.md`, req.system);
  writeFileSync(`${base}.user.txt`, req.user);
  writeFileSync(`${base}.schema.json`, JSON.stringify(req.schema, null, 1));
  console.log(`${base}.system.md / .user.txt (${req.user.split('\n').length} lines, ${req.user.length} chars) / .schema.json`);
} else if (cmd === 'answer') {
  const ans = JSON.parse(readFileSync(ansPath, 'utf8'));
  const isA = req.id.startsWith('A-');
  const r = (isA ? SchemaA : SchemaB).safeParse(ans);
  if (!r.success) { console.error('SCHEMA ERRORS:\n' + JSON.stringify(r.error.issues.slice(0, 15), null, 1)); process.exit(1); }
  const ctrl: string[] = []; // "D:\books" in JSON is D: + backspace + "ooks": the backslash must be written \\
  JSON.stringify(ans, (_k, v) => { if (typeof v === 'string' && /[\x00-\x09\x0b-\x1f]/.test(v)) ctrl.push(JSON.stringify(v).slice(0, 80)); return v; });
  if (ctrl.length) { console.error(`CONTROL CHARACTERS (unescaped backslash? write \\\\ in JSON):\n${ctrl.join('\n')}`); process.exit(1); }
  const known = new Set(req.user.match(isA ? /\b[ST]\d+\b/g : /\b[NE]\d+\b/g));
  const used = JSON.stringify(ans).match(isA ? /"[ST]\d+"/g : /"[NE]\d+"/g) ?? [];
  const bad = [...new Set(used.map((x) => x.slice(1, -1)).filter((x) => !known.has(x)))];
  if (bad.length) { console.error(`UNKNOWN IDS (not in the request): ${bad.join(', ')}`); process.exit(1); }
  writeFileSync(`${base}.result.json`, JSON.stringify(ans));
  console.log(`ok → ${base}.result.json`);
} else console.log('usage: dream-files.ts unpack|answer <request.json> [answer.json]');
