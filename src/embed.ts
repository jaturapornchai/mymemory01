// Local embeddings via Ollama (never a remote API: embeddings can be inverted back to text).
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
export const EMBED_MODEL = process.env.MEMHUB_EMBED_MODEL ?? 'bge-m3';
// Chunks/s for bulk backfill: each chunk costs Ollama ~3 loopback sockets that sit in TIME_WAIT for 2 min, and above ~40/s
// the machine-wide ephemeral port range runs out (every app's outbound connections fail).
const RATE = Number(process.env.MEMHUB_EMBED_RATE) || 10;
const KEEP_ALIVE = '2h'; // ~0.7 GB VRAM while loaded; a cold load costs seconds on the first query

/** Start `ollama serve` in the background if `url/api/ps` is unreachable, then wait up to ~3 s for it to listen. */
export async function ensureOllama(url = OLLAMA, start?: () => void): Promise<boolean> {
  const ping = () => fetch(`${url}/api/ps`, { signal: AbortSignal.timeout(400) }).then((r) => r.ok, () => false);
  if (await ping()) return true;
  try {
    if (start) start();
    else {
      const p = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', () => {});
      p.unref();
    }
  } catch { return false; }
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (await ping()) return true;
  }
  return false;
}

export async function embed(texts: string[], timeoutMs = 120_000, cancel?: AbortSignal): Promise<number[][]> {
  const r = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // truncate:false → error instead of silently embedding a cut text; bge-m3 context is 8K
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, truncate: false, keep_alive: KEEP_ALIVE, options: { num_ctx: 8192 } }),
    signal: cancel ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel]) : AbortSignal.timeout(timeoutMs),
  });
  const j: any = await r.json();
  if (!r.ok || !Array.isArray(j.embeddings)) throw new Error(`ollama embed: ${j.error ?? r.status}`);
  return j.embeddings;
}

export const toVec = (v: number[]) => `[${v.join(',')}]`;

const COLD_WAIT_MS = 4000; // a cold bge-m3 load takes ~2.2 s
const wait = <T>(ms: number, v: T) => sleep(ms, v, { ref: false });

/** Hot-path query vector, or null = search keyword-only. After waitMs: model resident = GPU busy → drop the request (late
 *  ones pile up and slow the next searches) and go keyword-only; not resident = loading (keep_alive expired, app restart,
 *  spawn warm-up) → wait ≤4 s and never abort: an abort also cancels Ollama's model load, so every later search stayed
 *  keyword-only (~20 recall points lost) until some other process reloaded the model. */
export async function embedQuery(text: string, waitMs: number): Promise<number[] | null> {
  const busy = new AbortController();
  const p = embed([text], 60_000, busy.signal).then((e) => e[0], () => null);
  const quick = await Promise.race([p, wait(waitMs, undefined)]);
  if (quick !== undefined) return quick;
  if (await resident()) { busy.abort(); return null; }
  return Promise.race([p, wait(COLD_WAIT_MS, null)]);
}

/** Is the embed model loaded in Ollama? Unknown (error/slow) → true, i.e. don't wait. */
async function resident(): Promise<boolean> {
  try {
    const j: any = await (await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(200) })).json();
    return j.models.some((m: { name: string }) => m.name.replace(/:latest$/, '') === EMBED_MODEL.replace(/:latest$/, ''));
  } catch { return true; }
}

/** Fire-and-forget model load so the first real query doesn't pay the cold start. */
export function warmUp() {
  embed(['warm-up'], 60_000).catch(async () => {
    if (!process.env.OLLAMA_URL && !process.env.MEMORY_HUB_INTERNAL && await ensureOllama()) embed(['warm-up'], 60_000).catch(() => {});
  });
}

/** Embed every chunk that lacks a vector for the current model.
 *  batch 8, not 32: a hot-path query embed queues behind the whole in-flight batch (head-of-line blocking). Measured while a
 *  backfill ran: busy query embed p95 594 ms at 32 (575 ms per batch) → 147 ms at 8, 0/20 over embedQuery's 300 ms wait;
 *  throughput is the same (RATE caps it). */
export async function backfill(db: pg.Pool, batch = 8, log = console.log) {
  let done = 0;
  const t0 = Date.now();
  for (;;) {
    const rows = (await db.query(
      `SELECT id, ctx_header, text FROM chunks WHERE embedding IS NULL OR model_ver IS DISTINCT FROM $1 LIMIT $2`,
      [EMBED_MODEL, batch],
    )).rows;
    if (!rows.length) break;
    let vecs: number[][];
    for (let tries = 1; ; tries++) {
      try { vecs = await embed(rows.map((r) => `${r.ctx_header}\n${r.text}`)); break; }
      catch (e) {
        if (tries === 1 && /fetch failed|ECONNREFUSED/i.test(String(e)) && !process.env.OLLAMA_URL && !process.env.MEMORY_HUB_INTERNAL && await ensureOllama()) continue;
        // Ollama opens a new socket to its runner per tokenize call; bulk backfills exhaust Windows' ports (TIME_WAIT 2 min)
        if (tries >= 10 || !/socket address|connectex|ECONNRESET|ECONNREFUSED/i.test(String(e))) throw e;
        log(`embed: ${(e as Error).message.slice(0, 80)}… retry ${tries}/9 in 60 s`);
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }
    await db.query(
      `UPDATE chunks c SET embedding = v.e::halfvec, model_ver = $1
       FROM unnest($2::text[], $3::text[]) AS v(id, e) WHERE c.id = v.id`,
      [EMBED_MODEL, rows.map((r) => r.id), vecs.map(toVec)],
    );
    done += rows.length;
    const ahead = (done * 1000) / RATE - (Date.now() - t0);
    if (ahead > 0) await new Promise((r) => setTimeout(r, ahead));
    // + the last partial batch, so a small hourly run still logs its rate (it did at batch 32 by accident: done < 32)
    if (done % 1024 < batch || rows.length < batch) log(`embedded ${done} (${((done * 1000) / (Date.now() - t0)).toFixed(0)}/s)`);
  }
  return done;
}

