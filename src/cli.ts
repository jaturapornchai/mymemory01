// node src/cli.ts <init|migrate [--force]|sync [--google-full]|import [--force] [file]|ingest <live.jsonl>|embed|search [--since d] [--until d] <query>|stats [--latency|--injected [n]]|daily [YYYY-MM-DD] [--out dir]|vault <init|log|diff|undo>|google <login|status [--dry]|revoke>>
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const [cmd, ...args] = process.argv.slice(2);

// health:<job> in state = last run ok / failed (+ redacted first line of the error): SessionStart warns when a job failed or
// went stale (session-start.ts). Never fails the job; the job's exit code stays its own. A run skipped by a lock keeps the previous
// row (a hung job holding the lock must still go stale); a sync with a failed source records jobErr.
let skipped = false, jobErr: Error | undefined;
const JOB = cmd === 'dream' ? (args.includes('--consolidate') ? 'consolidate' : 'dream') : ['sync', 'lint', 'daily', 'embed'].includes(cmd) ? cmd : '';
async function health(db: { query: (q: string, p: unknown[]) => Promise<unknown> }, job: string, e?: unknown) {
  if (!job) return;
  const { redact, redactPersonal } = await import('./redact.ts');
  // every app sees it: from a local path (Windows user name; vault note names carry titles, with spaces) to the end of the
  // line, and any quoted string holding a slash → <path>
  const msg = String((e as Error)?.message ?? e).trim().split('\n')[0].replace(/(?:\b[A-Za-z]:[\\/]|\\\\|\/(?:home|Users)\/|~[\\/]).*$/, '<path>')
    .replace(/(['"`])[^'"`]*[\\/][^'"`]*\1/g, '<path>');
  const err = e === undefined ? {} : { err: redact(redactPersonal(msg).text).text.slice(0, 120) };
  await db.query(`INSERT INTO state (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [`health:${job}`, { ok: e === undefined, at: new Date().toISOString(), ...err }]).catch(() => {});
}

if (cmd === 'init') {
  const env = join(ROOT, '.env');
  if (existsSync(env)) { console.log('.env exists, leaving it alone'); process.exit(0); }
  const pw = () => randomBytes(24).toString('base64url');
  writeFileSync(env, `MEMHUB_PG_PORT=5441\nPOSTGRES_PASSWORD=${pw()}\nMEMHUB_RW_PASSWORD=${pw()}\nMEMHUB_RO_PASSWORD=${pw()}\n`, { mode: 0o600 });
  console.log('wrote .env (random passwords). next: docker compose up -d && node src/cli.ts migrate');
  process.exit(0);
}

if (cmd === 'vault') {
  // vault init | log [-n N] | diff [rev] [--full] | undo <rev> [--force]: local git history of the memory-hub vault (no DB)
  await import('./db.ts'); // loads .env (MEMHUB_MEMORY_VAULT) before notes.ts reads it
  const { MEMORY_VAULT, reindexSoon } = await import('./notes.ts');
  const g = await import('./vault-git.ts');
  const [sub, ...rest] = args;
  const rev = rest.find((a) => !a.startsWith('-') && rest[rest.indexOf(a) - 1] !== '-n');
  try {
    if (sub === 'init') {
      const t0 = Date.now();
      console.log(`${MEMORY_VAULT}: ${g.snapshot(MEMORY_VAULT) ?? 'already clean'} (${Date.now() - t0} ms)`);
    } else if (sub === 'log') {
      for (const c of g.log(MEMORY_VAULT, rest.includes('-n') ? Number(rest[rest.indexOf('-n') + 1]) || 20 : 20))
        console.log(`${c.hash}  ${c.date}  ${c.kind.padEnd(8)} ${c.subject}  (${c.files} files)`);
    } else if (sub === 'diff') {
      const d = g.show(MEMORY_VAULT, rev);
      if (rest.includes('--full')) console.log(g.patch(MEMORY_VAULT, d.rev));
      else {
        console.log(d.head);
        for (const f of d.files) console.log(`  +${f.added} -${f.removed}  ${f.path.replace(/\.md$/, '')}`);
        console.log(`${d.files.length} notes, +${d.files.reduce((s, f) => s + f.added, 0)} -${d.files.reduce((s, f) => s + f.removed, 0)} lines`);
      }
    } else if (sub === 'undo' && rev) {
      console.log(`reverted ${rev}: ${g.undo(MEMORY_VAULT, rev, rest.includes('--force'))}`);
      reindexSoon(); // same detached index-vault path as memory_save
    } else console.log('usage: node src/cli.ts vault <init|log [-n N]|diff [rev] [--full]|undo <rev> [--force]>');
  } catch (e) {
    console.error(`vault ${sub}: ${(e as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (cmd === 'google') {
  // google login | status [--dry] | revoke: read-only Gmail/Docs/Sheets for Claude only (docs/google.md); no DB.
  // The archive itself is filled by the hourly `sync` (full pass: sync --google-full).
  const g = await import('./tools/google.ts');
  const { ARCHIVE_ROOT } = await import('./importer.ts');
  const [sub] = args;
  try {
    if (sub === 'login') console.log(`logged in, scopes: ${(await g.login()).join(' + ')}`);
    else if (sub === 'status') {
      console.log((await g.status(join(ARCHIVE_ROOT, 'google'), args.includes('--dry'))).join('\n'));
      const t = await import('./tools/google-timeline.ts');
      const age = t.dataAgeDays(join(ARCHIVE_ROOT, t.tool));
      console.log(age === null ? 'timeline: no export yet' : t.staleWarning(age) ?? `timeline: newest data point ${age} days old`);
    }
    else if (sub === 'revoke') console.log(await g.revoke());
    else console.log('usage: node src/cli.ts google <login|status [--dry]|revoke>');
  } catch (e) {
    console.error(`google ${sub}: ${(e as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (cmd === 'lint') {
  // lint [--dry] [--fix]: nightly checks → hubs/_lint.md (--dry prints instead; --fix retires machine dups/expired/replaced).
  const { connect } = await import('./db.ts');
  const fix = args.includes('--fix');
  const db = connect(fix ? 'rw' : 'ro');
  let err: unknown;
  try { console.log(await (await import('./lint.ts')).runLint(db, { dry: args.includes('--dry'), fix })); }
  catch (e) { err = e; console.error(`lint: ${(e as Error).message}`); process.exitCode = 1; }
  finally { await db.end(); }
  const rw = connect('rw'); // lint itself stays read-only unless --fix; only its health row is written
  await health(rw, JOB, err);
  await rw.end();
  process.exit();
}

if (cmd === 'sem') {
  // sem [--dry] [--limit n]: nightly, last: the local Gemma judges new top-cosine pairs → edges kind sem (src/sem.ts).
  // --dry = counts on the read-only role, no Gemma call; llama-server down or not serving Gemma → skipped, exit 0
  const { connect } = await import('./db.ts');
  const dry = args.includes('--dry'), lim = args.includes('--limit') ? args[args.indexOf('--limit') + 1] : undefined;
  if (lim !== undefined && !/^\d+$/.test(lim)) throw new Error(`sem: --limit needs a whole number, got ${lim}`);
  const db = connect(dry ? 'ro' : 'rw');
  try { console.log('sem', JSON.stringify(await (await import('./sem.ts')).runSem(db, { dry, limit: lim === undefined ? undefined : Number(lim) }))); }
  finally { await db.end(); }
  process.exit();
}

const { connect } = await import('./db.ts');
const db = connect('rw');
try {
  if (cmd === 'migrate') {
    // hourly runs this first: ALTER … IF NOT EXISTS still queues an exclusive lock, so give up after 2 s instead of stalling searches
    const sql = readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8');
    const sha = createHash('sha256').update(sql).digest('hex');
    // every ALTER queues ACCESS EXCLUSIVE even when IF NOT EXISTS makes it a no-op, so skip an unchanged schema (fresh DB: no state table → run)
    // the stamp names its schema: an empty scratch schema on the search_path must not read public's stamp as its own
    const done = !args.includes('--force') && (await db.query(`SELECT v->>'sha' sha FROM state WHERE k = 'schema' AND v->>'schema' = current_schema()`)
      .catch(() => ({ rows: [] }))).rows[0]?.sha === sha;
    if (!done) {
      await db.query(`SET lock_timeout = '2s';\n${sql}`); // one simple query = one connection: a separate SET may land on another
      await db.query(`INSERT INTO state (k, v) VALUES ('schema', jsonb_build_object('sha', $1::text, 'schema', current_schema(), 'at', now()))
        ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [sha]);
    }
    console.log(done ? 'schema ok (unchanged)' : 'schema ok');
  } else if (cmd === 'sync' || cmd === 'import') {
    // One at a time: a long first import must not overlap the hourly run (two appenders would corrupt an archive file).
    const lock = await db.connect();
    try {
      if (!(await lock.query(`SELECT pg_try_advisory_lock(hashtext(current_schema() || ':memhub-sync')) ok`)).rows[0].ok) {
        skipped = true;
        console.log(`${cmd}: another sync/import is running, skipped`);
      }
      else {
        const imp = await import('./importer.ts');
        const t0 = Date.now();
        if (args.includes('--google-full')) process.env.MEMHUB_GOOGLE_FULL = '1'; // every matching Gmail thread / Drive file, not just new ones
        if (cmd === 'sync') {
          const a = imp.syncArchive();
          console.log('archive', JSON.stringify(a));
          // generic text: every app sees the line, so it names no tool or account
          if (imp.syncFailed(a.tools)) jobErr = new Error('บาง source นำเข้าไม่สำเร็จ ดู logs/hourly.log');
          const t = await import('./tools/google-timeline.ts');
          const stale = t.staleWarning(t.dataAgeDays(join(imp.ARCHIVE_ROOT, t.tool))); // hourly.log: the phone export is getting old
          if (stale) console.log(stale);
        }
        const file = args.find((a) => !a.startsWith('--'));
        const force = args.includes('--force');
        const tool = file && imp.toolFor(file);
        if (!file) console.log('redact requeued', await imp.requeueUnredacted(db)); // before the index pass that re-imports them
        console.log('index', file ? await (tool ? imp.indexToolFile(db, tool, file, force) : imp.indexFile(db, file, force))
          : await imp.indexArchive(db, force), `${Date.now() - t0} ms`);
        if (!file) console.log('claude memory', await (await import('./claude-memory.ts')).importClaudeMemory(db) // before vaults: indexed this run
          .then((r) => `saved ${r.saved.length}, dup ${r.dup.length}, gone ${r.gone}, unmapped ${r.unmapped.length}`, (e) => `failed: ${e.message}`));
        if (!file) console.log('vaults', await (await import('./obsidian.ts')).indexVaults(db));
        // a deleted / moved note or re-imported file leaves its brain-map pins behind: one sweep per hour
        if (!file) console.log('pins pruned', await (await import('./layout.ts')).prunePins(db));
        if (!file) {
          await (await import('./search.ts')).refreshTermDf(db);
          // a failed rebuild (the nightly holds its lock past the timeout) must not skip this hour's embeddings
          console.log('synapses', await (await import('./synapse.ts')).rebuildSynapses(db, { structural: true }).then(JSON.stringify, (e) => `failed: ${e.message}`));
        }
        // Ollama down = search silently keyword-only: recorded as health:embed (SessionStart warns), the sync itself goes on
        const { backfill } = await import('./embed.ts');
        let emb: unknown;
        try { emb = await backfill(db); await health(db, 'embed'); }
        catch (e) { emb = `skipped: ${(e as Error).message}`; await health(db, 'embed', e); }
        console.log('embedded', emb);
      }
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtext(current_schema() || ':memhub-sync'))`).catch(() => {});
      lock.release();
    }
  } else if (cmd === 'ingest') {
    // One live transcript (+ its subagents): archive then index. Called detached by hook.ts.
    const imp = await import('./importer.ts');
    const { appendFileSync, readdirSync } = await import('node:fs');
    const live = args[0];
    if (!live || !existsSync(live)) process.exit(0);
    const subDir = join(live.replace(/\.jsonl$/, ''), 'subagents');
    const files = [live, ...(existsSync(subDir) ? readdirSync(subDir, { recursive: true, encoding: 'utf8' }).map((f) => join(subDir, f)) : [])]
      .filter((f) => f.endsWith('.jsonl') && existsSync(f));
    try {
      for (const f of files) imp.syncOne(f);
      const arch = files.map(imp.archivePath), hideAs = await imp.sessionHideAs(db, arch); // before any commit: see sessionHideAs
      for (const f of arch) await imp.indexFile(db, f, false, hideAs);
      await (await import('./embed.ts')).backfill(db, 8, () => {}).catch(() => 0); // Ollama down → vectors filled by next import
    } catch (e) {
      appendFileSync(join(ROOT, 'ingest.log'), `${new Date().toISOString()} ${live}: ${(e as Error).message}\n`);
    }
  } else if (cmd === 'retokenize') {
    // Tokenizer / ctx_header changed → backfill [files: ...] on existing chunks from their round's turns, then rebuild words/bigrams in place.
    // Only rows whose ctx_header or tokens differ are written: every rewritten row is re-inserted into the GIN and HNSW indexes.
    const { filesTouched } = await import('./chunk.ts');
    const { bigramRuns, bigramTsvector } = await import('./thai.ts');
    const { chunkWords } = await import('./importer.ts');
    const srcIds = (await db.query(`SELECT DISTINCT source_id FROM turns WHERE text_redacted ~* '(?:^|\\n)\\[(?:edit|write|notebookedit)\\]\\s+'`)).rows.map((r) => r.source_id);
    const hdrByChunk = new Map<string, string>();
    for (const sid of srcIds) {
      const turns = (await db.query(`SELECT seq, role, text_redacted text FROM turns WHERE source_id = $1 ORDER BY seq`, [sid])).rows;
      const chunks = (await db.query(`SELECT id, seq_from, ctx_header FROM chunks WHERE source_id = $1 ORDER BY seq_from`, [sid])).rows;
      const rounds: { from: number; to: number; touched: string[] }[] = [];
      for (const t of turns) {
        if (!rounds.length || t.role === 'user' || t.role === 'summary' || t.role === 'note') rounds.push({ from: t.seq, to: t.seq, touched: [] });
        const cur = rounds.at(-1)!;
        cur.to = t.seq;
      }
      for (const r of rounds) {
        r.touched = filesTouched(turns.filter((t) => t.seq >= r.from && t.seq <= r.to).map((t) => t.text).join('\n'));
      }
      for (const c of chunks) {
        const r = rounds.find((x) => c.seq_from >= x.from && c.seq_from <= x.to);
        if (!r?.touched.length) continue;
        const base = String(c.ctx_header).replace(/ \[files: [^\]]*\]$/, '');
        const next = `${base} [files: ${r.touched.join(' ')}]`;
        if (next !== c.ctx_header) hdrByChunk.set(c.id, next);
      }
    }
    let n = 0, changed = 0;
    const lock = await db.connect(); // sync/import's lock: an hourly re-import rewriting these rows mid-pass would be overwritten
    try {
      if (!(await lock.query(`SELECT pg_try_advisory_lock(hashtext(current_schema() || ':memhub-sync')) ok`)).rows[0].ok)
        throw new Error('retokenize: a sync/import is running, run it again after that finishes');
      for (let last = ''; ;) {
        const rows = (await db.query('SELECT id, ctx_header, text FROM chunks WHERE id > $1 ORDER BY id LIMIT 1000', [last])).rows;
        if (!rows.length) break;
        const hdrs = rows.map((r) => hdrByChunk.get(r.id) ?? (r.ctx_header as string));
        // the vector embeds `${ctx_header}\n${text}` (embed.ts): a new header nulls it, the next sync's backfill re-embeds
        changed += (await db.query(
          `UPDATE chunks c SET ctx_header = v.h, words = v.w::tsvector, bigrams = v.b::tsvector,
             embedding = CASE WHEN c.ctx_header = v.h THEN c.embedding END, model_ver = CASE WHEN c.ctx_header = v.h THEN c.model_ver END
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) v(id, h, w, b)
           WHERE c.id = v.id AND (c.ctx_header, c.words, c.bigrams) IS DISTINCT FROM (v.h, v.w::tsvector, v.b::tsvector)`,
          [rows.map((r) => r.id), hdrs, rows.map((r, i) => chunkWords(hdrs[i], r.text)), rows.map((r) => bigramTsvector(bigramRuns(r.text)))],
        )).rowCount ?? 0;
        n += rows.length;
        last = rows.at(-1).id;
      }
      await (await import('./search.ts')).refreshTermDf(db);
      await (await import('./synapse.ts')).rebuildSynapses(db, { structural: true });
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtext(current_schema() || ':memhub-sync'))`).catch(() => {});
      lock.release();
    }
    console.log('retokenized', n, 'changed', changed);
  } else if (cmd === 'embed') {
    const { backfill } = await import('./embed.ts');
    const t0 = Date.now();
    console.log('embedded', await backfill(db), `${Date.now() - t0} ms`);
  } else if (cmd === 'search') {
    const { search, snippet } = await import('./search.ts');
    const take = (k: string) => { const i = args.indexOf(k); return i < 0 ? undefined : args.splice(i, 2)[1]; }; // flag + value leave the query
    const since = take('--since'), until = take('--until'), asOf = take('--as-of'), kind = take('--kind'), project = take('--project'), q = args.join(' ');
    const t0 = performance.now();
    const { hits, semantic } = await search(db, q, { since, until, asOf, kind, project });
    const ms = (performance.now() - t0).toFixed(1);
    for (const h of hits) console.log(`[${h.id}] ${h.ts?.toISOString().slice(0, 10)} ${h.project} ${h.score.toFixed(4)}\n  ${snippet(h.text, q, 200)}`);
    console.log(`${hits.length} hits in ${ms} ms${semantic ? '' : ' (keyword-only)'}`);
  } else if (cmd === 'index-vault') {
    // one vault (memory_save / dream notes) → index + links + vectors; called detached by notes.ts
    const { indexVault, indexVaults, resolveLinks } = await import('./obsidian.ts');
    try {
      console.log(args[0] ? await indexVault(db, args[0]) : await indexVaults(db)); // no arg = all vaults
      await resolveLinks(db);
      await (await import('./embed.ts')).backfill(db, 8, () => {}).catch(() => 0);
    } catch (e) {
      (await import('node:fs')).appendFileSync(join(ROOT, 'ingest.log'), `${new Date().toISOString()} vault ${args[0]}: ${(e as Error).message}\n`);
    }
  } else if (cmd === 'forget') {
    // forget --session <id> | --project <path prefix>: drop from the index for good (raw archive untouched)
    const what = args[0] === '--session' ? 'session' : args[0] === '--project' ? 'project' : null;
    if (!what || !args[1]) throw new Error('usage: forget --session <id> | --project <path>');
    const r = await (await import('./importer.ts')).forget(db, what, args[1]);
    console.log('forgot sources:', r.sources);
    // facts/cards dreamed from it: printed as fid + note file name (what was retired), not the note body
    for (const [k, xs] of [['retired (note deleted)', r.retired], ['kept, provenance trimmed', r.trimmed], ['kept: edited by you, see hubs/_review.md', r.review], ['daily notes you edited (may still quote it)', r.daily]] as const)
      if (xs.length) console.log(`${k}: ${xs.length}\n${xs.map((x) => `  ${x}`).join('\n')}`);
  } else if (cmd === 'project') {
    // project [--mv <from> <to> | --alias <from> <to> | --sync]: link or merge moved/multi-machine project paths
    const imp = await import('./importer.ts');
    if (args[0] === '--mv' && args[1] && args[2]) {
      console.log('project mv', JSON.stringify(await imp.migrateProject(db, args[1], args[2])));
    } else if (args[0] === '--alias' && args[1] && args[2]) {
      console.log('project alias', JSON.stringify(await imp.setProjectAlias(db, args[1], args[2])));
    } else {
      const sync = args.includes('--sync');
      const rows = (await db.query(`SELECT project, count(*)::int n FROM sources WHERE project <> '' AND project NOT LIKE 'obsidian/%' AND project NOT LIKE 'github/%' AND project NOT LIKE 'google/%' GROUP BY 1 ORDER BY 2 DESC`)).rows;
      const splits: { from: string; to: string; sources: number; notes?: number }[] = [];
      for (const r of rows) {
        const to = await imp.canonicalProject(db, r.project);
        if (to !== r.project) splits.push(sync ? await imp.migrateProject(db, r.project, to) : { from: r.project, to, sources: r.n });
      }
      const aliases = (await db.query(`SELECT v FROM state WHERE k = 'project:aliases'`)).rows[0]?.v ?? {};
      console.log(JSON.stringify({ aliases, ...(sync ? { migrated: splits } : { pending_splits: splits }) }, null, 2));
    }
  } else if (cmd === 'dream') {
    // dream [--runner deepseek|claude|files] [--run id] [--force] [--limit n] | dream --consolidate (no LLM: approvals, synapses, hubs)
    const d = await import('./dream.ts');
    const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
    const runner = opt('--runner') ?? process.env.MEMHUB_DREAM_RUNNER ?? (process.env.MEMHUB_CLAUDE_BIN ? 'claude' : 'deepseek');
    if (args.includes('--consolidate')) {
      await d.consolidate(db);
      const { MEMORY_VAULT } = await import('./notes.ts');
      (await import('./vault-git.ts')).commitBatch(MEMORY_VAULT, `consolidate ${d.BKK(new Date())}: approvals + hubs`);
      console.log('consolidated');
    }
    else if (runner === 'deepseek' && !args.includes('--force') && d.deepseekPeak(new Date())) {
      skipped = true; // ลุงจืด 2026-10-10: DeepSeek only at its off-peak (half) price
      console.log('dream: DeepSeek peak hours (01-04 and 06-10 UTC, Mon-Fri) bill double, skipped');
    }
    else {
      const run = opt('--run') ?? `${d.BKK(new Date())}-${runner}`;
      const dir = join(ROOT, 'tmp', 'dream', run);
      const lim = opt('--limit'); // --limit 0 = no sessions (it once meant the default 25 and dreamed for real)
      if (lim !== undefined && !/^\d+$/.test(lim)) throw new Error(`dream: --limit needs a whole number, got ${lim}`);
      const r = await d.dream(db, { run, force: args.includes('--force'), limit: lim === undefined ? undefined : Number(lim),
        llm: runner === 'files' ? d.filesRunner(dir) : runner === 'deepseek' ? d.deepseekRunner() : d.claudeRunner() });
      if (r.status === 'locked') skipped = true;
      console.log(JSON.stringify({ run, status: r.status, stats: r.stats }));
      if (r.pending) console.log(`pending requests (answer each <id>.request.json with <id>.result.json, then rerun):\n${r.pending.map((p) => join(dir, `${p}.request.json`)).join('\n')}`);
    }
  } else if (cmd === 'daily') {
    // daily [YYYY-MM-DD] [--out dir]: the day's activity note (default yesterday, Asia/Bangkok) → vault daily/ + index;
    // --out = a preview file only (no vault, no git, no index)
    const d = await import('./daily.ts');
    const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
    if (args.includes('--out') && !out) throw new Error('usage: daily [YYYY-MM-DD] [--out dir]');
    const day = args.find((a) => !a.startsWith('--') && a !== out) ?? d.yesterday();
    const r = await d.writeDaily(db, day, out);
    if (r === 'written') {
      const { MEMORY_VAULT } = await import('./notes.ts');
      const { indexVault, resolveLinks } = await import('./obsidian.ts');
      await indexVault(db, MEMORY_VAULT);
      await resolveLinks(db);
      await (await import('./embed.ts')).backfill(db, 8, () => {}).catch(() => 0); // Ollama down → the next sync embeds it
    }
    console.log(`daily ${day}: ${r}`); // kept-user-edit = ลุงจืด edited that note: left as is
  } else if (cmd === 'brain') {
    // brain [--public] [--out file.json] [--rebake] → graph for the web viewer (public = anonymized, safe to publish)
    const { buildBrain } = await import('./brain.ts');
    // --rebake: drop all layout pins → full 300-tick relax (one visible reshuffle) when hubs have grown crowded; the semantic
    // galaxy is refitted from scratch too
    if (args.includes('--rebake')) await db.query(`DELETE FROM state WHERE k IN ('layout', 'layout:semantic')`);
    const t0 = Date.now();
    const b = await buildBrain(db, args.includes('--public') ? 'public' : 'local');
    const out = args[args.indexOf('--out') + 1];
    const json = JSON.stringify(b);
    if (args.includes('--out') && out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, json); }
    console.log(`${b.mode}: ${b.nodes.length} nodes, ${b.links.length} links, ${b.events.length} events, ${(json.length / 1024).toFixed(0)} KB, ${Date.now() - t0} ms`);
  } else if (cmd === 'brain-serve') {
    // Local viewer with real labels: web/out + /graph.json + /feed.json on 127.0.0.1 only (never exposed).
    const { createServer } = await import('node:http');
    const { buildBrain, feedOf, forShare } = await import('./brain.ts');
    const { extname, normalize } = await import('node:path');
    const out = join(ROOT, 'web', 'out');
    // --share [--hours n] [--no-tunnel] (ลุงจืด 2026-10-07: friends ask and see full content): this view through a Cloudflare
    // quick tunnel behind a random link token (a cookie after the first visit) for n hours. ลุงจืด's own AI calls stay out
    // (/live.json is empty), Claude-only sources stay out (as in local), one search at a time, 30 a minute.
    // --open (ลุงจืด 2026-10-08, https://memory.bcaicloud.com behind Caddy): share for anyone, no link token, no time limit, no tunnel
    const open = args.includes('--open');
    const share = open || args.includes('--share');
    const hours = Math.min(24, Number(args[args.indexOf('--hours') + 1]) || 3);
    const token = share ? randomBytes(18).toString('base64url') : '';
    const isToken = (t: string | null | undefined) => { const a = Buffer.from(t ?? ''), b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); }; // bytes: a non-ASCII k of the same length must not throw
    let busy = false;
    const asked: number[] = [];
    const port = Number(args[args.indexOf('--port') + 1]) || (share ? 5443 : 5442);
    // share: every string a friend gets is scrubbed again on the way out (import redacts secrets, but bank/ID/card/OTP only for
    // Google sources, and older rows by older rules). ponytail: ~200 ms per graph.json; cache the scrubbed graph if friends pile up
    const { redact, redactPersonal } = await import('./redact.ts');
    const clean = share ? (_k: string, v: unknown) => (typeof v === 'string' ? redact(redactPersonal(v).text).text : v) : undefined;
    // ลุงจืด 2026-10-07: a question after passwords / keys / codes gets no search (the scrub is the real guard; this is the polite no)
    const SECRET_ASK = /รหัส|พาสเวิร์ด|ความลับ|ซีเคร็ต|โทเค็น|โทเคน|คีย์|ล็อ[กค]อิน|บัตร|บัญชีธนาคาร|เลขบัญชี|พร้อมเพย์|\.env|sk-|aiza|ghp_|:\/\/\S*@|\b(?:pass(?:word|wd|code|phrase)?s?|pwd|pin|otp|cvv|secrets?|tokens?|api[ _-]?keys?|keys?|credentials?|creds?|env|bearer|ssh|logins?|uri|dsn|connection[ _-]?strings?)\b/i;
    // single-flight: requests on a stale cache share one rebuild (it also writes the layout state); a failed one is retried
    let cache: { at: number; b: ReturnType<typeof buildBrain> } | null = null;
    const sent = new WeakMap<object, Record<string, string>>(); // the scrubbed JSON, once per build (~200 ms), not per visitor
    let refreshing = false; // share: a build takes 8-20 s on the server, so visitors keep the old graph while one rebuilds
    const brain = () => {
      if (cache && Date.now() - cache.at < (share ? 60_000 : 5000)) return cache.b;
      if (cache && share) {
        if (!refreshing) {
          refreshing = true;
          buildBrain(db, 'local').then((b) => { cache = { at: Date.now(), b: Promise.resolve(b) }; }, () => {}).finally(() => { refreshing = false; });
        }
        return cache.b;
      }
      return (cache = { at: Date.now(), b: buildBrain(db, 'local').catch((e) => { cache = null; throw e; }) }).b;
    };
    // brain view: /live.json = each MCP call since ?after (ms), /search?q= = one traced search; both local only
    const { liveCalls, tracer } = await import('./brain-live.ts');
    const trace = tracer(connect('ro'));
    const nodeOf = async () => { const m = new Map<string, string>(); for (const n of (await brain()).nodes) { const s = /^source:(\d+)/.exec(n.id)?.[1]; if (s) m.set(s, n.id); } return (sid: string) => m.get(sid) ?? null; };
    const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' };
    createServer(async (req, res) => {
      try {
        // DNS rebinding: a page whose name resolves to 127.0.0.1 is same-origin to it and could read every route
        if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')) { res.writeHead(403); return res.end(); }
        const url = URL.parse(req.url ?? '/', 'http://x');
        if (!url) { res.writeHead(400); return res.end(); }
        if (share && !open) {
          if (isToken(url.searchParams.get('k'))) { // Lax: the link is opened from a chat app (a cross-site navigation)
            res.writeHead(302, { location: '/', 'set-cookie': `mh=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${hours * 3600}` });
            return res.end();
          }
          if (!isToken(/(?:^|;\s*)mh=([^;]+)/.exec(req.headers.cookie ?? '')?.[1])) {
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
            return res.end('ลิงก์ไม่ถูกต้องหรือหมดเวลาแล้ว');
          }
        }
        if (url.pathname === '/graph.json' || url.pathname === '/feed.json') {
          const raw = await brain();
          let s = sent.get(raw);
          if (!s) { const b = share ? forShare(raw) : raw; s = { '/graph.json': JSON.stringify(b, clean), '/feed.json': JSON.stringify(feedOf(b, b.at - 7200), clean) }; sent.set(raw, s); }
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          return res.end(s[url.pathname]);
        }
        if (url.pathname === '/live.json' || url.pathname === '/search') {
          const q = (url.searchParams.get('q') ?? '').trim().slice(0, 300);
          if (url.pathname === '/search' && !q) { res.writeHead(400); return res.end('q?'); }
          if (share && url.pathname === '/search') {
            const now = Date.now();
            while (asked.length && now - asked[0] > 60_000) asked.shift();
            if (busy || asked.length >= 30) { res.writeHead(429); return res.end('busy'); }
            asked.push(now);
            if (SECRET_ASK.test(q)) { console.log(`${new Date().toLocaleTimeString('th-TH')} ไม่ตอบ (ถามหารหัส): ${JSON.stringify(q)}`); res.writeHead(422); return res.end('secret'); }
            busy = true;
            console.log(`${new Date().toLocaleTimeString('th-TH')} ถาม: ${JSON.stringify(q)}`); // quoted: no terminal escape from a friend
          }
          const body = url.pathname === '/search' ? await (async () => trace(q, await nodeOf()))().finally(() => { busy = false; })
            : { now: Date.now(), calls: share ? [] : await liveCalls(db, new Date(Number(url.searchParams.get('after')) || Date.now() - 120_000), await nodeOf()) };
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          return res.end(JSON.stringify(body, clean));
        }
        let p = normalize(join(out, decodeURIComponent(url.pathname)));
        if (!p.startsWith(out)) { res.writeHead(403); return res.end(); }
        if (existsSync(p) && !(await import('node:fs')).statSync(p).isFile()) p = join(p, 'index.html');
        if (!existsSync(p)) p = existsSync(`${p}.html`) ? `${p}.html` : join(out, '404.html');
        res.writeHead(existsSync(p) ? 200 : 404, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
        res.end(existsSync(p) ? readFileSync(p) : 'not found');
      } catch (e) { res.writeHead(500); res.end(share ? 'error' : (e as Error).message); }
    }).listen(port, '127.0.0.1', async () => {
      console.log(`brain (local, real labels): http://127.0.0.1:${port}`);
      if (!share || open) return;
      const link = (base: string) => console.log(`share ${hours} ชม. (Ctrl+C ปิดก่อนได้): ${base}/?k=${token}`);
      const { spawn } = await import('node:child_process');
      const { tmpdir } = await import('node:os');
      let tunnel: import('node:child_process').ChildProcess | null = null;
      const stop = (why: string) => { console.log(`share: ${why}`); tunnel?.kill(); process.exit(0); };
      setTimeout(() => stop('หมดเวลา ปิดแล้ว'), hours * 3600_000);
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => stop('ปิดแล้ว')); // SIGHUP: the terminal window closed
      process.on('exit', () => tunnel?.kill()); // never leave the tunnel up without this server
      if (args.includes('--no-tunnel')) return link(`http://127.0.0.1:${port}`);
      // an empty config: a quick tunnel, never the named tunnel of ~/.cloudflared/config.yml (another service's)
      const cfg = join(tmpdir(), 'memhub-share-cloudflared.yml');
      writeFileSync(cfg, '');
      tunnel = spawn('cloudflared', ['tunnel', '--config', cfg, '--no-autoupdate', '--url', `http://127.0.0.1:${port}`, '--http-host-header', `127.0.0.1:${port}`],
        { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '', shown = false;
      tunnel.stderr!.on('data', (d) => {
        if (shown) return;
        err += d;
        const u = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(err)?.[0];
        if (u) { shown = true; link(u); }
      });
      tunnel.on('exit', (c) => { console.error(`share: cloudflared exited ${c}${shown ? '' : `\n${err.slice(-600)}`}`); process.exit(1); });
    });
    await new Promise(() => {}); // serve until killed
  } else if (cmd === 'publish') {
    // Public mirror on Vercel: static web/out + anonymized graph.json/feed.json; redeploys only when the graph changed.
    // The site's code/assets change only with --build: the hourly run swaps the data next to the last released build, so a
    // web/out that is mid-rebuild (or mid-edit) never goes public.
    const { buildBrain, feedOf, assertAnonymous } = await import('./brain.ts');
    const { cpSync, mkdirSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { createHash } = await import('node:crypto');
    const out = join(ROOT, 'web', 'out'), dir = join(ROOT, 'deploy', 'memory-hub-brain');
    // opt-in: a clone never deploys anything until its owner links the folder to their own Vercel project (vercel link)
    if (!existsSync(join(dir, '.vercel'))) { console.log('publish: skipped (deploy/memory-hub-brain is not linked to a Vercel project; see README)'); process.exit(0); }
    const fresh = args.includes('--build') || !existsSync(join(dir, 'index.html'));
    let keepOg = false; // the hourly data-only run never touches og.png
    if (fresh) {
      const r = spawnSync('npm run build', { cwd: join(ROOT, 'web'), shell: true, stdio: 'inherit' });
      if (r.status) throw new Error('web build failed');
      // share preview (og:image): a failed shot keeps the last released og.png, never a page whose og:image 404s
      keepOg = spawnSync('node scripts/og.mjs', { cwd: join(ROOT, 'web'), shell: true, stdio: 'inherit' }).status !== 0;
      if (keepOg && !existsSync(join(dir, 'og.png'))) throw new Error('og.png: screenshot failed and no earlier one to keep');
      if (keepOg) console.warn('og.png: screenshot failed, keeping the last released one');
    }
    const b = await buildBrain(db, 'public');
    const graph = JSON.stringify(b);
    await assertAnonymous(db, graph); // abort before anything leaves the machine
    const rev = createHash('sha256').update(JSON.stringify({ ...b, at: 0 })).digest('hex').slice(0, 12);
    const last = (await db.query(`SELECT v->>'rev' rev FROM state WHERE k = 'publish'`)).rows[0]?.rev;
    if (rev === last && !fresh && !args.includes('--force')) { console.log(`publish: unchanged (rev ${rev})`); }
    else {
      mkdirSync(dir, { recursive: true });
      const { readdirSync, rmSync } = await import('node:fs');
      if (fresh) {
        for (const f of readdirSync(dir)) if (f !== '.vercel' && !(keepOg && f === 'og.png')) rmSync(join(dir, f), { recursive: true, force: true }); // drop stale build assets
        cpSync(out, dir, { recursive: true });
      }
      writeFileSync(join(dir, 'graph.json'), graph);
      writeFileSync(join(dir, 'feed.json'), JSON.stringify(feedOf(b, b.at - 7200)));
      const r = spawnSync('vercel deploy --prod --yes', { cwd: dir, shell: true, encoding: 'utf8' });
      const url = (r.stdout ?? '').match(/https:\/\/\S+/g)?.at(-1);
      if (r.status || !url) throw new Error(`vercel deploy failed: ${(r.stderr ?? '').slice(-400)}`);
      await db.query(`INSERT INTO state (k, v) VALUES ('publish', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [{ rev, url, at: new Date().toISOString() }]);
      console.log(`published rev ${rev}: ${url} (per-deployment URLs need a Vercel login)`);
    }
  } else if (cmd === 'stats' && args[0] === '--latency') {
    // real MCP calls (access_log rank 1 = one row per call): p50/p95 ms per tool, overall and per AI app, + keyword-only rate
    for (const days of [1, 7]) {
      const r = await db.query(
        `SELECT tool, CASE WHEN grouping(client) = 1 THEN 'all' ELSE coalesce(client, '?') END client, count(*)::int calls,
                round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms))::int p50, round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms))::int p95,
                round(100.0 * count(*) FILTER (WHERE NOT semantic) / nullif(count(semantic), 0), 1) keyword_only_pct
         FROM access_log WHERE rank = 1 AND ms IS NOT NULL AND ts > now() - make_interval(days => $1)
         GROUP BY GROUPING SETS ((tool), (tool, client)) ORDER BY tool, grouping(client) DESC, calls DESC`, [days]);
      console.log(`last ${days} day${days > 1 ? 's' : ''}:`);
      if (r.rows.length) console.table(r.rows); else console.log('  no timed calls yet');
    }
  } else if (cmd === 'stats' && args[0] === '--injected') {
    // stats --injected [n]: what the last n SessionStart hooks gave each new chat (ids only; memory_get <id> shows one)
    const { projectName } = await import('./importer.ts');
    const rows = (await db.query(`SELECT ts, client, project, ids, chars, source FROM injections ORDER BY id DESC LIMIT $1`, [Math.max(1, Number(args[1]) || 10)])).rows;
    for (const r of rows) console.log(`${r.ts.toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 16)}  ${r.client.padEnd(11)} ${(r.source ?? '-').padEnd(7)} ` +
      `${(projectName(r.project ?? '') || '-').padEnd(14)} ${String(r.chars).padStart(4)} chars  ${r.ids.join(' ') || '(no ids)'}`);
    console.log(rows.length ? `${rows.length} injections, newest first` : 'no injections recorded yet');
  } else if (cmd === 'stats') {
    const r = await db.query(`SELECT (SELECT count(*) FROM sources) sources, (SELECT count(*) FROM turns) turns,
      (SELECT count(*) FROM chunks) chunks, (SELECT pg_size_pretty(pg_database_size('memhub'))) db_size`);
    console.table(r.rows);
  } else if (cmd === 'mute') {
    // mute [-]<fid>…: keep facts/cards out of SessionStart, still searchable; -<fid> = unmute. One state row per fid: a re-index
    // never loses it and no note is touched. memory_save mute runs this (the MCP server only holds the read-only role).
    const fids = args.filter((a) => /^-?[FSI][0-9a-f]{8}$/.test(a));
    const on = fids.filter((f) => f[0] !== '-'), un = fids.filter((f) => f[0] === '-').map((f) => f.slice(1));
    if (on.length) await db.query(`INSERT INTO state (k, v) SELECT 'mute:' || f, jsonb_build_object('at', now()) FROM unnest($1::text[]) f
      ON CONFLICT (k) DO NOTHING`, [on]);
    if (un.length) await db.query(`DELETE FROM state WHERE k = ANY($1::text[])`, [un.map((f) => `mute:${f}`)]);
    console.log(`muted: ${on.join(' ') || '-'} · unmuted: ${un.join(' ') || '-'}`);
  } else if (cmd === 'conflict') {
    // conflict <fid> <other>:<name>…: memory_save found a contradiction (accuracy.ts); lint --fix recomputes them nightly
    const [fid, ...rest] = args, others = rest.map((x) => x.split(':') as [string, string]).filter(([o, n]) => /^[FSI][0-9a-f]{8}$/.test(o) && n);
    if (!/^[FSI][0-9a-f]{8}$/.test(fid ?? '') || !others.length) throw new Error('usage: conflict <fid> <other-fid>:<name>...');
    await (await import('./accuracy.ts')).addConflict(db, fid, others);
    console.log(`conflict: ${fid} ↔ ${others.map((o) => o.join(':')).join(' ')}`);
  } else if (cmd === 'identity' || cmd === 'alias') {
    // identity <project> <fid>: the fact SessionStart shows first for that project (B1). alias <project> <old> <new> <since> [fid]
    // [regex]: the project's old name: older chunks naming it get a note, a query naming it gets the identity fact (B4).
    const project = (await import('./importer.ts')).normProject(args[0] ?? '');
    if (!project) throw new Error(`usage: identity <project> <fid> | alias <project> <old> <new> <YYYY-MM-DD> [fid] [regex]`);
    const cur = (await db.query(`SELECT v FROM state WHERE k = $1`, [`identity:${project}`])).rows[0]?.v ?? { aliases: [] };
    if (cmd === 'identity') {
      if (!/^F[0-9a-f]{8}$/.test(args[1] ?? '')) throw new Error('usage: identity <project> <fid>');
      cur.fid = args[1];
    } else {
      const [, old, nu, since, fid, match] = args;
      if (!old || !nu || !/^\d{4}-\d{2}-\d{2}$/.test(since ?? '')) throw new Error('usage: alias <project> <old> <new> <YYYY-MM-DD> [fid] [regex]');
      if (match) new RegExp(match, 'i'); // a bad regex fails here, not in every search
      cur.aliases = [...(cur.aliases ?? []).filter((a: { old: string }) => a.old !== old), { old, new: nu, since, ...(fid ? { fid } : {}), ...(match ? { match } : {}) }];
    }
    await db.query(`INSERT INTO state (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [`identity:${project}`, cur]);
    console.log(`identity:${project} ${JSON.stringify(cur)}`);
  } else if (cmd === 'annotate') {
    // annotate <chunk-id|fid> <text> ('' = remove): a note shown under that chat/card in search, the raw text stays as it was
    const [id, ...words] = args, note = words.join(' ').trim();
    const turn = (await db.query(/^[FSI][0-9a-f]{8}$/.test(id ?? '')
      ? `SELECT c.turn_uuid FROM facts f JOIN chunks c ON c.source_id = f.source_id WHERE f.fid = $1 ORDER BY c.seq_from, c.id LIMIT 1`
      : `SELECT turn_uuid FROM chunks WHERE id LIKE $1 || '%' AND length($1) >= 8 LIMIT 2`, [id ?? ''])).rows;
    if (turn.length !== 1) throw new Error(`annotate: ${turn.length ? 'id prefix matches 2+ chunks' : 'no chunk/fact'} ${id}`);
    const k = `note:${turn[0].turn_uuid}`;
    if (note) await db.query(`INSERT INTO state (k, v) VALUES ($1, jsonb_build_object('text', $2::text)) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [k, note]);
    else await db.query(`DELETE FROM state WHERE k = $1`, [k]);
    console.log(`${k} ${note || '(removed)'}`);
  } else {
    console.log('usage: node src/cli.ts <init|migrate|sync [--google-full]|import [--force] [file]|ingest <live.jsonl>|embed|search [--since d] [--until d] <query>|stats [--latency|--injected [n]]|daily [YYYY-MM-DD] [--out dir]|vault <init|log|diff|undo>|google <login|status [--dry]|revoke>|retokenize|index-vault [vault]|forget --session <id>|--project <path>|dream [--consolidate]|lint [--dry]|sem [--dry] [--limit n]|brain [--public] [--out file]|brain-serve [--port n] [--share [--hours n] [--no-tunnel] | --open]|publish [--build] [--force]|mute [-]<fid>...|conflict <fid> <fid>:<name>...|identity <project> <fid>|alias <project> <old> <new> <since> [fid] [regex]|annotate <id> <text>>');
  }
  if (!skipped) await health(db, JOB, jobErr);
} catch (e) {
  await health(db, JOB, e); // e.g. the dream's "OAuth session expired" from claude -p
  throw e;
} finally {
  await db.end();
}
