import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

export const ROOT = join(import.meta.dirname, '..');
const ENV = join(ROOT, '.env');
if (existsSync(ENV)) process.loadEnvFile(ENV);

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
    ...(role === 'ro' && { min: 1, allowExitOnIdle: true }),
    // ef_search ≥ the 60 candidates we take; iterative scan keeps recall when project/date filters drop rows;
    // random_page_cost 1.1 (SSD): broad keyword queries use the GIN bitmap instead of a full chunks scan (search p95 −20 %)
    options: '-c hnsw.ef_search=100 -c hnsw.iterative_scan=relaxed_order -c random_page_cost=1.1' +
      (process.env.MEMHUB_PG_SCHEMA ? ` -c search_path=${process.env.MEMHUB_PG_SCHEMA},public` : ''), // schema: tests only
  });
  pool.on('error', () => {}); // an idle connection dropped (PG restart) must not crash the server; the next query reconnects
  return pool;
}
