// Dry run: how often each redaction rule fires on the real archive, with masked context
// so false positives can be judged without printing the secret itself.
// usage: node scripts/redact-scan.ts <dir> [samplesPerKind]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaude, parseSubagent } from '../src/claude.ts';
import { redact } from '../src/redact.ts';

const dir = process.argv[2];
const per = Number(process.argv[3] ?? 4);
const files: string[] = [];
const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? e !== 'tool-results' && walk(p) : p.endsWith('.jsonl') && files.push(p); } };
walk(dir);

const total: Record<string, number> = {};
const samples: Record<string, string[]> = {};
let msgs = 0, chars = 0;
for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  for (const m of /[\\/]subagents[\\/]/.test(f) ? parseSubagent(raw) : parseClaude(raw)) {
    msgs++; chars += m.text.length;
    const { text, hits } = redact(m.text);
    for (const [k, n] of Object.entries(hits)) {
      total[k] = (total[k] ?? 0) + n;
      const s = (samples[k] ??= []);
      if (s.length < per) {
        const i = text.indexOf(`[REDACTED:${k}]`);
        s.push(text.slice(Math.max(0, i - 50), i + 40).replace(/\s+/g, ' '));
      }
    }
  }
}
console.log({ files: files.length, msgs, chars, total });
for (const [k, s] of Object.entries(samples)) console.log(`\n## ${k}\n` + s.map((x) => '  ' + x).join('\n'));
