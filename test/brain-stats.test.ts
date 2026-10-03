// brain-stats: the export's big-picture numbers (counts and sizes only) on a throwaway schema per run (never public).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCHEMA = `memhub_brainstats_test_${process.pid}`;
process.env.MEMHUB_PG_SCHEMA = SCHEMA;
const { connect, ROOT } = await import('../src/db.ts');
const { MEMORY_PROJECT } = await import('../src/notes.ts');
const { brainStats } = await import('../src/brain-stats.ts');

const db = connect('rw');
const guard = async () => assert.equal((await db.query('SELECT current_schema() s')).rows[0].s, SCHEMA, 'scratch schema missing: refusing to write to public');
const archive = mkdtempSync(join(tmpdir(), 'memhub-brainstats-'));
const outside = mkdtempSync(join(tmpdir(), 'memhub-brainstats-out-'));
const DAY = 86400;
const at = (iso: string) => Date.parse(iso) / 1000;

/** one source with its turns: [ts, text] */
async function source(tool: string, sid: string, project: string, turns: [string, string][], status: string | null = null) {
  const id = (await db.query(`INSERT INTO sources (tool, path, kind, session_id, project, size, mtime_ms, sha256, status)
    VALUES ($1, $2, $3, $4, $5, 1, 1, 'x', $6) RETURNING id`, [tool, `${tool}/${sid}`, tool === 'claude' ? 'main' : 'doc', sid, project, status])).rows[0].id;
  for (const [i, [ts, text]] of turns.entries()) {
    await db.query(`INSERT INTO turns (uuid, source_id, seq, session_id, role, ts, project, text_redacted) VALUES ($1, $2, $3, $4, 'user', $5, $6, $7)`,
      [`${sid}-${i}`, id, i, sid, ts, project, text]);
  }
  return id;
}
async function fact(src: number, kind: string) {
  await db.query(`INSERT INTO facts (source_id, fid, kind, valid_at, created_at, source_uuids, md5) VALUES ($1, $2, $3, now(), now(), '{u}', 'm')`, [src, `F${src}`, kind]);
}

before(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await guard();
  await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
  // GitHub: 3 repo cards (2 private) of 2 owners, his commits in one repo, one issue
  await source('github', 'github:acme-corp/secret-repo', 'github/acme-corp/secret-repo', [['2015-01-01', '[repo acme-corp/secret-repo] top secret\nTypeScript · private · created 2015-01-01']]);
  await source('github', 'github:acme-corp/open-repo', 'github/acme-corp/open-repo', [['2015-01-01', '[repo acme-corp/open-repo]\nGo · created 2015-01-01 · topics private-ish']]);
  await source('github', 'github:someone/forked', 'github/someone/forked', [['2015-01-01', '[repo someone/forked] x\nprivate fork · created 2015-01-01']]);
  await source('github', 'github:acme-corp/secret-repo:commits', 'github/acme-corp/secret-repo', [['2015-01-02', '[commit a] fix'], ['2015-01-03', '[commit b] add']]);
  await source('github', 'github:acme-corp/secret-repo#7', 'github/acme-corp/secret-repo', [['2015-01-04', '[issue #7] secret issue title (open)']]);
  // Google and notes are older than any chat: never the first chat
  await source('google-timeline', 'g:1', 'google', [['2010-05-05T10:00:00Z', 'visited a secret place']]);
  await source('obsidian', 'notes/diary.md', 'obsidian/personal', [['2011-01-01', 'my diary']]);
  const mem = await source('obsidian', 'm/rule.md', MEMORY_PROJECT, [['2026-01-01', 'rule text']], 'active');
  await fact(mem, 'rule');
  await fact(await source('obsidian', 'm/fact.md', MEMORY_PROJECT, [['2026-01-01', 'a fact']], 'active'), 'fact');
  await fact(await source('obsidian', 'm/old.md', MEMORY_PROJECT, [['2026-01-01', 'old fact']], 'superseded'), 'fact');
  await fact(await source('obsidian', 'm/card.md', MEMORY_PROJECT, [['2026-01-01', 'session card']], 'active'), 'card');
  const chat = await source('claude', 'c-1', 'D:/work/secret-project', [['2026-03-04T15:30:00Z', 'สวัสดี'], ['2026-03-05T01:00:00Z', 'hello']]);
  await db.query(`INSERT INTO chunks (id, source_id, turn_uuid, seq_from, seq_to, session_id, ts, ctx_header, text, words, bigrams, chunker_ver, embedding, model_ver)
    VALUES ('k1', $1, 'c-1-0', 0, 1, 'c-1', now(), '', 'x', ''::tsvector, ''::tsvector, 't', $2::halfvec, 'bge-m3:latest')`,
  [chat, `[${Array(1024).fill(0.5).join(',')}]`]);
  // searches: 3 timed calls this week (rank-1 rows), a rank-2 row, an untimed one, one too old, a recall
  await db.query(`INSERT INTO access_log (ts, kind, chunk_id, rank, ms) VALUES
    (now(), 'search', 'k1', 1, 10), (now(), 'search', 'k1', 1, 20), (now(), 'search', 'k1', 1, 300), (now(), 'search', 'k1', 2, 9999),
    (now(), 'search', 'k1', 1, NULL), (now() - interval '8 days', 'search', 'k1', 1, 9999), (now(), 'get', 'k1', 1, 9999)`);
  mkdirSync(join(archive, 'claude', 'deep'), { recursive: true });
  writeFileSync(join(archive, 'claude', 'a.jsonl'), 'x'.repeat(100));
  writeFileSync(join(archive, 'claude', 'deep', 'b.jsonl'), 'y'.repeat(23));
  // links are never followed: a junction out of the archive, one back to its root (a loop), a file link
  writeFileSync(join(outside, 'big.bin'), 'z'.repeat(5000));
  symlinkSync(outside, join(archive, 'out'), 'junction');
  symlinkSync(archive, join(archive, 'claude', 'deep', 'loop'), 'junction');
  try { symlinkSync(join(outside, 'big.bin'), join(archive, 'big.bin'), 'file'); } catch { /* Windows without symlink rights */ }
});
after(async () => {
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.end();
  rmSync(archive, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('brainStats: GitHub, memory, storage, vectors, archive and search speed, counts only', async () => {
  const { stats, model } = await brainStats(db, archive);
  assert.deepEqual(
    [stats.ghRepos, stats.ghPriv, stats.ghOrgs, stats.ghMine, stats.ghCmt, stats.ghIss],
    [3, 2, 2, 1, 2, 1], // "topics private-ish" is not the private flag
  );
  assert.deepEqual([stats.facts, stats.rules, stats.vaultNotes], [2, 1, 1]); // active non-card facts; the diary only
  assert.equal(stats.firstChat, Math.floor(at('2026-03-04T15:30:00Z') / DAY) * DAY); // a chat's day, not Google's or a note's
  assert.equal(stats.textChars, [...'สวัสดี'].length + 5 + (await db.query(`SELECT sum(char_length(text_redacted))::int n FROM turns t
    JOIN sources s ON s.id = t.source_id WHERE s.tool <> 'claude'`)).rows[0].n);
  assert.ok(stats.turnsBytes > 0 && stats.chunksBytes > 0 && stats.hnswBytes > 0 && stats.idxBytes > 0, JSON.stringify(stats));
  assert.equal(stats.dims, 1024);
  assert.equal(model, 'bge-m3');
  assert.deepEqual([stats.rawBytes, stats.rawFiles], [123, 2]); // the linked 5,000 B and the loop: not counted
  assert.ok(stats.copyBytes > 0); // public is another schema from this scratch one
  assert.deepEqual([stats.timed7d, stats.p50ms, stats.p95ms], [3, 20, 272]); // percentile_cont: 20 + 0.9 × (300 − 20)
  assert.ok(Object.values(stats).every(Number.isFinite));
  assert.doesNotMatch(JSON.stringify({ stats, model }), /acme|secret|someone|diary|google|issue title|2010|D:/i);
});

test('brainStats: no ms column (older schema), no archive, no vectors → those numbers are left out', async () => {
  await guard();
  await db.query(`ALTER TABLE access_log DROP COLUMN ms; UPDATE chunks SET embedding = NULL`);
  const { stats, model } = await brainStats(db, join(archive, 'missing'));
  for (const k of ['timed7d', 'p50ms', 'p95ms', 'rawBytes', 'rawFiles', 'dims']) assert.equal(stats[k], undefined, k);
  assert.equal(model, undefined);
  assert.equal(stats.ghRepos, 3);
});
