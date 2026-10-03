// Claude Code hook for Stop / SessionEnd: hand the transcript to a detached ingest and exit fast.
// Never blocks or fails the session: any problem → exit 0 silently (errors go to ingest.log via the child).
import { spawn } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STOP_DEBOUNCE_MS = 10 * 60_000; // Stop fires every turn; re-ingest a session at most every 10 min

try {
  if (process.env.MEMORY_HUB_INTERNAL) process.exit(0); // our own background claude -p runs must not recurse
  let raw = '';
  for await (const c of process.stdin) raw += c;
  const ev = JSON.parse(raw);
  const path: unknown = ev.transcript_path;
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) process.exit(0);

  if (ev.hook_event_name === 'Stop') {
    const marker = join(tmpdir(), `memhub-${String(ev.session_id).replace(/[^\w-]/g, '')}`);
    if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs < STOP_DEBOUNCE_MS) process.exit(0);
    writeFileSync(marker, '');
  }

  spawn(process.execPath, [join(import.meta.dirname, 'cli.ts'), 'ingest', path], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, MEMORY_HUB_INTERNAL: '1' },
  }).unref();
} catch {
  // swallow: memory is best-effort, the session must never notice
}
process.exit(0);
