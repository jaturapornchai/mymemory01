// End-to-end: spawn the MCP server over stdio exactly like Claude Code does, list tools, search (full + brief), timeline, get.
// usage: node scripts/mcp-smoke.ts "<query>"   exit 1 when a step is skipped or a budget is broken
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { tokens } from '../src/timeline.ts';

const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, '..', 'src', 'mcp.ts')], env: { ...process.env, MEMORY_HUB_INTERNAL: '1' } as Record<string, string> })); // smoke runs are not real use
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '), `| definitions ≈ ${JSON.stringify(tools).length} chars`);
const q = process.argv[2] ?? 'ภ.ง.ด.53';
const call = async (name: string, args: Record<string, unknown>) => {
  const t0 = performance.now();
  const r: any = await client.callTool({ name, arguments: args });
  const out = r.content[0].text as string;
  console.log(`\n${name} ${JSON.stringify(args)} ${(performance.now() - t0).toFixed(0)} ms, ${out.length} chars ≈${tokens(out)}t:\n${out.slice(0, 500)}…`);
  return out;
};
const fail = (why: string) => { console.error(`FAIL: ${why}`); process.exitCode = 1; };
const ID = /^\[([0-9a-f]{16}|[FSI][0-9a-f]{8})\]/m; // chunk id or fact/card/insight id: every kind memory_get accepts

const out = await call('memory_search', { query: q, limit: 5 });
const brief = await call('memory_search', { query: q, detail: 'brief', limit: 15 });
if (brief.split('\n').some((l) => l.length > 200)) fail('brief line > 200 chars');
if (brief.split('\n').filter((l) => ID.test(l)).length > 8) fail('brief > 8 hits'); // invariant: ≤ 8 hits × ≤ 400 chars
const id = out.match(ID)?.[1];
if (!id) fail('no result id → get/timeline skipped');
else {
  const tl = await call('memory_timeline', { id });
  if (tl.length > 1500) fail('timeline > 1500 chars');
  const get = await call('memory_get', { id });
  const est = brief.match(new RegExp(`^\\[${id}\\] .*? ≈(\\d+)t`, 'm'))?.[1]; // brief's estimate for the same hit vs the real get
  console.log(`\nmemory_get ≈${tokens(get)}t, brief estimated ${est ?? '? (id not in brief)'}t`);
}
await client.close();
