// Obsidian vaults → searchable notes + [[wikilink]] edges. Read-only: never writes to a vault (notes.ts owns the memory-hub vault).
// Vault files are ลุงจืด's live notes (their own source of truth), so the index mirrors current state:
// edited notes are replaced, deleted notes are dropped.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type pg from 'pg';
import { clean, normProject, store } from './importer.ts';
import { type Fm, fmList, fmStr, isEdited, md5, MEMORY_VAULT, parseNote } from './notes.ts';

export const VAULTS = [...(process.env.MEMHUB_VAULTS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean), MEMORY_VAULT];

const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
const WIKILINK = /(?<!!)\[\[([^\]|#^\n]+)(?:[#^][^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g; // [[target#heading|alias]], not ![[embeds]]

function* notes(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* notes(join(dir, e.name)); }
    else if (e.isFile() && e.name.endsWith('.md')) yield join(dir, e.name);
  }
}

/** Link target as Obsidian resolves it: last path segment, no .md, case-insensitive. */
export const linkKey = (target: string) => basename(target.trim().replace(/\\/g, '/')).replace(/\.md$/i, '').toLowerCase();

export function wikilinks(md: string): string[] {
  return [...new Set([...md.matchAll(WIKILINK)].map((m) => linkKey(m[1])).filter(Boolean))];
}

export async function indexVault(db: pg.Pool, vault: string) {
  const name = basename(vault);
  const project = `obsidian/${name}`;
  const stats = { skip: 0, indexed: 0, removed: 0 };
  const seen = [...notes(vault)];
  // First (a renamed note must free its fid before the new path is indexed). Gone = not seen by this walk AND not on disk now (another process may have written it after our walk started).
  const gone = (await db.query(`SELECT id, path FROM sources WHERE tool = 'obsidian' AND project = $1 AND NOT (path = ANY($2::text[]))`,
    [project, seen])).rows.filter((r) => !existsSync(r.path)).map((r) => r.id);
  if (gone.length && vault === MEMORY_VAULT) { // deleted fact file = ลุงจืด's decision → tombstone so the dream never re-creates it
    await db.query(`INSERT INTO forgotten (key) SELECT 'fact:' || md5 FROM facts WHERE source_id = ANY($1) AND kind <> 'card'
      ON CONFLICT DO NOTHING`, [gone]);
  }
  if (gone.length) await db.query('DELETE FROM sources WHERE id = ANY($1)', [gone]);
  stats.removed = gone.length;
  for (const path of seen) {
    const st = statSync(path);
    const old = (await db.query('SELECT size, mtime_ms FROM sources WHERE path = $1', [path])).rows[0];
    if (old && Number(old.size) === st.size && Number(old.mtime_ms) === Math.round(st.mtimeMs)) { stats.skip++; continue; }
    const raw = readFileSync(path, 'utf8');
    const own = vault === MEMORY_VAULT; // memory-hub's own notes: frontmatter is metadata (facts row), not searchable text
    const { fm, body } = own ? parseNote(raw) : { fm: {} as Fm, body: raw };
    const rel = relative(vault, path).replace(/\\/g, '/');
    const title = basename(path, '.md');
    // daily/ notes (daily.ts): sources.kind 'daily' → ranked below chats (search.ts tier −1), dated by their day, not the 03:30 write
    const daily = own && fmStr(fm.memhub) === 'daily';
    const ts = (daily && isoOr(fmStr(fm.valid_at), null)) || st.mtime.toISOString();
    const uuid = 'obs:' + createHash('sha256').update(path).digest('hex').slice(0, 24);
    await store(db, {
      tool: 'obsidian', path, kind: daily ? 'daily' : 'note', sessionId: `${name}/${rel}`, project,
      size: st.size, mtimeMs: st.mtimeMs, sha256: createHash('sha256').update(raw).digest('hex'),
      label: name, replace: true,
    }, [{ uuid, parentUuid: null, seq: 0, role: 'note', ts, text: clean(`# ${title}\n${body}`) }],
    async (c, sourceId) => {
      if (own) await indexFact(c, sourceId, fm, body, uuid, ts);
      await c.query('DELETE FROM links WHERE src_id = $1', [sourceId]);
      await c.query('INSERT INTO links (src_id, dst_name) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [sourceId, wikilinks(raw)]);
    });
    stats.indexed++;
  }
  return stats;
}

const KINDS = new Set(['card', 'rule', 'feedback', 'decision', 'preference', 'fact', 'howto', 'insight']);
const isoOr = (v: string, dflt: string | null) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : dflt);

/** memory-hub note → sources.status + facts row (an index of the frontmatter; the file stays the truth). */
async function indexFact(c: pg.PoolClient, sourceId: string, fm: Fm, body: string, uuid: string, mtime: string) {
  await c.query('UPDATE sources SET status = $2 WHERE id = $1', [sourceId, fmStr(fm.status) || null]);
  await c.query('DELETE FROM facts WHERE source_id = $1', [sourceId]);
  const type = fmStr(fm.memhub);
  if (!['fact', 'card', 'insight'].includes(type) || !fmStr(fm.id)) return; // a plain note ลุงจืด wrote
  const kind = type === 'fact' ? (KINDS.has(fmStr(fm.kind)) ? fmStr(fm.kind) : 'fact') : type;
  const edited = isEdited(fm, body);
  const pinned = fmStr(fm.pinned) === 'true';
  const uuids = fmList(fm.source_uuids).filter(Boolean);
  const created = isoOr(fmStr(fm.created_at), mtime)!;
  await c.query(
    `INSERT INTO facts (source_id, fid, kind, scope, project, lang, valid_at, invalid_at, created_at, expired_at, superseded_by,
       review_target, source_uuids, session_ids, confidence, importance, pinned, user_owned, edited, md5, run)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text[],
       coalesce((SELECT array_agg(DISTINCT session_id) FROM turns WHERE uuid = ANY($13::text[])), '{}'),
       $14, $15, $16, $17, $18, $19, $20)
     ON CONFLICT (fid) DO NOTHING`, // ponytail: two files claiming one id → first indexed wins
    [sourceId, fmStr(fm.id), kind, fmStr(fm.scope) === 'global' ? 'global' : 'project', fmStr(fm.project) ? normProject(fmStr(fm.project)) : null,
      fmStr(fm.lang) || null, isoOr(fmStr(fm.valid_at), created), isoOr(fmStr(fm.invalid_at), null), created,
      isoOr(fmStr(fm.expired_at), null), fmStr(fm.superseded_by) || null, fmStr(fm.review_target) || null,
      uuids.length ? uuids : [uuid], Number(fmStr(fm.confidence)) || null, Math.min(10, Math.max(1, Number(fmStr(fm.importance)) || 5)),
      pinned, ['rule', 'feedback'].includes(kind) || fmStr(fm.owner) === 'user' || edited || pinned, edited,
      fmStr(fm.md5) || md5(body), fmStr(fm.run) || null]);
}

/** Resolve [[names]] to note sources across all vaults (a name may live in another vault). */
export async function resolveLinks(db: pg.Pool) {
  await db.query(`
    UPDATE links l SET dst_id = n.id
    FROM (SELECT DISTINCT ON (k) id, k FROM (                       -- session_id = 'vault/rel/path.md' (forward slashes)
            SELECT id, lower(regexp_replace(session_id, '^.*/|[.]md$', '', 'g')) k, length(session_id) len
            FROM sources WHERE tool = 'obsidian') x
          ORDER BY k, len) n                                         -- duplicate names: shortest path wins, like Obsidian
    WHERE l.dst_name = n.k AND l.dst_id IS DISTINCT FROM n.id`);
}

export async function indexVaults(db: pg.Pool) {
  const out: Record<string, unknown> = {};
  for (const v of VAULTS) {
    try { out[basename(v)] = await indexVault(db, v); }
    catch (e) { out[basename(v)] = `failed: ${(e as Error).message}`; }
  }
  await resolveLinks(db);
  return out;
}
