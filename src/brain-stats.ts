// Big-picture numbers for the brain export (merged into Brain.stats), public and local alike: counts and sizes only.
// Nothing here may carry a project, repo, org, person, file or note name. Sources other than the AI chat apps (GitHub,
// Obsidian, Google, …) only ever add to totals: no number here is shaped by their times.
// Stat keys must not contain words of archive file names: assertAnonymous takes path parts ≥ 6 chars as needles
// (github's commits.jsonl / issues/<n>.json → 'commits', 'issues'), hence ghCmt / ghIss.
// vaultNotes: while only one vault besides the memory vault exists, it equals that vault's (V1) count; no name either way.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { ARCHIVE_ROOT } from './importer.ts';
import { MEMORY_PROJECT } from './notes.ts';

// the AI chat apps (sources.tool): only their times may set firstChat. A new app counts once added here (fail closed)
const CHAT_TOOLS = ['claude', 'codex', 'gemini', 'antigravity', 'zcode', 'lmstudio'];
const ARCHIVE_TTL = 10 * 60_000;
let archive: { root: string; at: number; bytes: number; files: number } | undefined;

/** Raw archive on disk (bytes, files). ~0.3 s for 17k files, so cached: brain-serve rebuilds the brain every 5 s.
 *  Real directories only: a junction or symlink (Dirent.isDirectory() false) is never followed, so nothing outside the
 *  archive is counted and a link loop cannot recurse. */
export function archiveSize(root = ARCHIVE_ROOT): { bytes: number; files: number } | undefined {
  if (archive?.root === root && Date.now() - archive.at < ARCHIVE_TTL) return archive;
  let bytes = 0, files = 0;
  try {
    for (const dirs = [root]; dirs.length; ) {
      const dir = dirs.pop()!;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) dirs.push(p);
        else if (e.isFile()) {
          bytes += statSync(p, { throwIfNoEntry: false })?.size ?? 0; // gone since the listing: skip
          files++;
        }
      }
    }
  } catch { return undefined; } // no archive here
  return (archive = { root, at: Date.now(), bytes, files });
}

export async function brainStats(db: pg.Pool, root = ARCHIVE_ROOT): Promise<{ stats: Record<string, number>; model?: string }> {
  // GitHub sessions (src/tools/github.ts parse): 'github:<owner>/<repo>' = repo card (its 2nd line: "<lang> · private …"),
  // '…:commits' = his commits (a turn each), '…#<n>' = an issue/PR
  const r = (await db.query(`WITH gh AS (SELECT id, session_id sid FROM sources WHERE tool = 'github'),
      ix AS (SELECT am.amname = 'hnsw' hnsw, pg_relation_size(i.indexrelid) b FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam JOIN pg_class t ON t.oid = i.indrelid
             WHERE t.relnamespace = current_schema()::regnamespace)
    SELECT
      (SELECT count(*) FROM gh WHERE sid !~ '#|:commits$') "ghRepos",
      (SELECT count(*) FROM gh JOIN turns t ON t.source_id = gh.id
       WHERE sid !~ '#|:commits$' AND ' · ' || split_part(t.text_redacted, E'\\n', 2) LIKE '% · private%') "ghPriv",
      (SELECT count(DISTINCT split_part(sid, '/', 1)) FROM gh) "ghOrgs",
      (SELECT count(*) FROM gh WHERE sid ~ ':commits$') "ghMine",
      (SELECT count(*) FROM gh JOIN turns t ON t.source_id = gh.id WHERE sid ~ ':commits$') "ghCmt",
      (SELECT count(*) FROM gh WHERE sid ~ '#') "ghIss",
      (SELECT count(*) FROM facts f JOIN sources s ON s.id = f.source_id WHERE s.status = 'active' AND f.kind <> 'card') facts,
      (SELECT count(*) FROM facts f JOIN sources s ON s.id = f.source_id WHERE s.status = 'active' AND f.kind IN ('rule', 'feedback')) rules,
      (SELECT count(*) FROM sources WHERE tool = 'obsidian' AND project IS DISTINCT FROM $1) "vaultNotes",
      (SELECT floor(extract(epoch FROM min(t.ts)) / 86400) * 86400 FROM turns t JOIN sources s ON s.id = t.source_id
       WHERE s.tool = ANY($2)) "firstChat", -- the day only (UTC midnight)
      (SELECT sum(char_length(text_redacted)) FROM turns) "textChars",
      pg_table_size(to_regclass('turns')) "turnsBytes", pg_table_size(to_regclass('chunks')) "chunksBytes",
      (SELECT coalesce(sum(b) FILTER (WHERE hnsw), 0) FROM ix) "hnswBytes",
      (SELECT coalesce(sum(b) FILTER (WHERE NOT hnsw), 0) FROM ix) "idxBytes",
      -- other non-system schemas in this database are copies (memhub_bench, test schemas), not the memory itself
      (SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'm') AND n.oid <> current_schema()::regnamespace
         AND n.nspname !~ '^(pg_|information_schema$)') "copyBytes",
      (SELECT vector_dims(embedding) FROM chunks WHERE embedding IS NOT NULL LIMIT 1) dims,
      (SELECT model_ver FROM chunks WHERE embedding IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1) model`,
  [MEMORY_PROJECT, CHAT_TOOLS])).rows[0];
  const { model, ...counts } = r ?? {}; // r: absent only on a stub DB (test/brain-log)
  const stats: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) if (v !== null) stats[k] = Number(v); // null: nothing to count (no chats, no vectors)

  const raw = archiveSize(root);
  if (raw) Object.assign(stats, { rawBytes: raw.bytes, rawFiles: raw.files });

  // search latency (MCP calls, rank-1 row = one per call): only once access_log has the ms column
  if ((await db.query(`SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('access_log') AND attname = 'ms' AND NOT attisdropped`)).rowCount) {
    const l = (await db.query(`SELECT count(*)::int n, percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) p95
      FROM access_log WHERE kind = 'search' AND rank = 1 AND ms IS NOT NULL AND ts > now() - interval '7 days'`)).rows[0];
    if (l.n) Object.assign(stats, { timed7d: l.n, p50ms: Math.round(l.p50), p95ms: Math.round(l.p95) });
  }
  // a bare model name only ("bge-m3"): anything else (a path, a URL) stays out of the export
  const name = typeof model === 'string' ? model.replace(/:latest$/, '') : '';
  return { stats, ...(/^[\w.-]{1,40}$/.test(name) && { model: name }) };
}
