import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

export const ROOT = join(import.meta.dirname, '..');
const ENV = join(ROOT, '.env');
if (existsSync(ENV)) process.loadEnvFile(ENV);

// hnsw.ef_search (A/B: MEMHUB_EF_SEARCH, an integer 1..1000; else 400)
const ef = Number(process.env.MEMHUB_EF_SEARCH);
const EF_SEARCH = Number.isInteger(ef) && ef >= 1 && ef <= 1000 ? ef : 400;

/** rw = importer/migrations (table owner), ro = MCP search (SELECT only). */
export function connect(role: 'rw' | 'ro'): pg.Pool {
  const password = role === 'rw' ? process.env.MEMHUB_RW_PASSWORD : process.env.MEMHUB_RO_PASSWORD;
  if (!password) throw new Error(`missing MEMHUB_${role.toUpperCase()}_PASSWORD (run: node src/cli.ts init)`);
  const pool = new pg.Pool({
    host: '127.0.0.1',
    port: Number(process.env.MEMHUB_PG_PORT),
    database: 'memhub',
    user: `memhub_${role}`,
    password,
    max: role === 'ro' ? 2 : 4,
    // ro = MCP hot path: keep one connection between calls (a new one costs ~16 ms: connect + cold catalog caches; the 10 s
    // idle timeout dropped it before ~30 % of real searches); allowExitOnIdle so scripts still exit without db.end()
    // A stalled PG fails a call instead of hanging it (ro only: the rw role runs imports and dreams). Slowest ro statement
    // measured 2026-10-04: 0.26 s (eval with HNSW off), lint 0.03 s. statement_timeout 5 s = PG itself slow or locked (the
    // connection stays usable; the container's clock fires it at ~5.6 s wall); query_timeout 6 s = no answer at all
    // (network/process stall: PG never saw the query, the client drops the connection); 2 s to connect or to wait for a
    // pooled one; TCP keepalive notices a dead peer.
    ...(role === 'ro' && { min: 1, allowExitOnIdle: true, connectionTimeoutMillis: 2000, query_timeout: 6000, keepAlive: true }),
    // live index: m=16/ef_construction=64 (schema.sql). vector recall@10 vs exact on 100 real queries at ef_search
    // 100 / 200 / 400: 87.3 / 92.5 / 96.7 %, vector p50 3.0 / 4.2 / 6.4 ms (PERF 2026-10-04); m=24 scored no better on the fine set.
    // Iterative scan keeps recall when project/date filters drop rows;
    // random_page_cost 1.1 (SSD): broad keyword queries use the GIN bitmap instead of a full chunks scan (search p95 −20 %)
    options: `-c hnsw.ef_search=${EF_SEARCH} -c hnsw.iterative_scan=relaxed_order -c random_page_cost=1.1` +
      (role === 'ro' ? ' -c statement_timeout=5000' : '') +
      (process.env.MEMHUB_PG_SCHEMA ? ` -c search_path=${process.env.MEMHUB_PG_SCHEMA},public` : ''), // schema: tests only
  });
  pool.on('error', () => {}); // an idle connection dropped (PG restart) must not crash the server; the next query reconnects
  return pool;
}
