// One-off (2026-10-18): Claude-memory facts imported before the dating fix carry the import run as valid_at/created_at, and
// importClaudeMemory never rewrites them (same sha). Re-date each from its source file (writtenAt), then index the vault.
//   node scripts/backfill-cmem-dates.ts        → dry run: counts + 5 samples
//   node scripts/backfill-cmem-dates.ts --run  → write the notes (one vault commit), index the vault
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { parseMemory, writtenAt } from '../src/claude-memory.ts';
import { connect } from '../src/db.ts';
import { LIVE_DIR } from '../src/importer.ts';
import { fmStr, isEdited, md5, MEMORY_VAULT, parseNote, renderNote, sha, writeNote } from '../src/notes.ts';
import { indexVault } from '../src/obsidian.ts';
import { beforeMachineWrite, commitBatch } from '../src/vault-git.ts';

export async function backfillClaudeMemoryDates(db: pg.Pool, o: { dir?: string; dry?: boolean } = {}) {
  const dir = o.dir ?? LIVE_DIR;
  const out = { fixed: [] as { key: string; rel: string; from: string; to: string; crlf: boolean }[], gone: 0, changed: 0, superseded: 0, notOlder: 0 };
  for (const { k, v } of (await db.query(`SELECT k, v FROM state WHERE k LIKE 'cmem:%' ORDER BY k`)).rows) {
    if (!v.rel) continue; // a duplicate of another fact: no note of its own
    const key = k.slice(5), [slug, f] = key.split('/'), srcPath = join(dir, slug, 'memory', f), path = join(MEMORY_VAULT, v.rel);
    if (!existsSync(srcPath) || !existsSync(path)) { out.gone++; continue; }
    const src = readFileSync(srcPath, 'utf8'), m = parseMemory(src);
    if (md5(src) !== v.sha || !m) { out.changed++; continue; } // edited since: the next sync re-imports it, dated right
    const raw = readFileSync(path, 'utf8'), { fm, body } = parseNote(raw);
    // a CRLF source: the old writeNote hashed its body with the \r (notes.ts fixed) → looks like his edit, but it is the machine's
    const crlf = raw.includes('\r') && sha(raw.replace(/^---\n[\s\S]*?\n---\n?/, '')) === fmStr(fm.body_sha);
    // a later save took the note over (superseded, his edit, another source of the same text): its dates are not ours to move
    if (fmStr(fm.status) !== 'active' || fmStr(fm.id) !== v.fid || fmStr(fm.claude_memory) !== key || (isEdited(fm, body) && !crlf)) { out.superseded++; continue; }
    const to = writtenAt(m, srcPath), from = fmStr(fm.valid_at);
    if (!(to.getTime() < Date.parse(from))) { out.notOlder++; continue; } // never make a fact look newer than it is
    out.fixed.push({ key, rel: v.rel, from, to: to.toISOString(), crlf });
    if (o.dry) continue;
    if (crlf) { beforeMachineWrite(MEMORY_VAULT, v.rel); writeFileSync(path, renderNote({ ...fm, body_sha: sha(body) }, body)); } // LF + its sha, same text
    writeNote(v.rel, { valid_at: to.toISOString(), created_at: to.toISOString() });
  }
  if (!o.dry && out.fixed.length) {
    commitBatch(MEMORY_VAULT, `claude-memory: re-date ${out.fixed.length} imported facts by their source file`);
    await indexVault(db, MEMORY_VAULT);
  }
  return out;
}

if (import.meta.main) {
  const run = process.argv.includes('--run'), db = connect('rw');
  const r = await backfillClaudeMemoryDates(db, { dry: !run });
  console.log(`${run ? 'RUN' : 'DRY RUN'}: fix ${r.fixed.length} (CRLF note repaired too: ${r.fixed.filter((x) => x.crlf).length}) | skip: source gone ${r.gone}, source changed ${r.changed}, superseded/edited ${r.superseded}, not older ${r.notOlder}`);
  for (const x of r.fixed.slice(0, 5)) console.log(`  ${x.key}: ${x.from} → ${x.to}`);
  await db.end();
}
