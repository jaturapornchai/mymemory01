// node src/cli.ts <init|migrate|sync [--google-full]|import [--force] [file]|ingest <live.jsonl>|embed|search <query>|stats [--latency]|handoff [list|show <id>|done <id>]|vault <init|log|diff|undo>|google <login|status [--dry]|revoke>>
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const [cmd, ...args] = process.argv.slice(2);

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
    else if (sub === 'status') console.log((await g.status(join(ARCHIVE_ROOT, 'google'), args.includes('--dry'))).join('\n'));
    else if (sub === 'revoke') console.log(await g.revoke());
    else console.log('usage: node src/cli.ts google <login|status [--dry]|revoke>');
  } catch (e) {
    console.error(`google ${sub}: ${(e as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

const { connect } = await import('./db.ts');
const db = connect('rw');
try {
  if (cmd === 'migrate') {
    await db.query(readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8'));
    console.log('schema ok');
  } else if (cmd === 'sync' || cmd === 'import') {
    // One at a time: a long first import must not overlap the hourly run (two appenders would corrupt an archive file).
    const lock = await db.connect();
    try {
      if (!(await lock.query(`SELECT pg_try_advisory_lock(hashtext('memhub-sync')) ok`)).rows[0].ok) console.log(`${cmd}: another sync/import is running, skipped`);
      else {
        const imp = await import('./importer.ts');
        const t0 = Date.now();
        if (args.includes('--google-full')) process.env.MEMHUB_GOOGLE_FULL = '1'; // every matching Gmail thread / Drive file, not just new ones
        if (cmd === 'sync') console.log('archive', JSON.stringify(imp.syncArchive()));
        const file = args.find((a) => !a.startsWith('--'));
        const force = args.includes('--force');
        console.log('index', file ? await imp.indexFile(db, file, force) : await imp.indexArchive(db, force), `${Date.now() - t0} ms`);
        if (!file) console.log('vaults', await (await import('./obsidian.ts')).indexVaults(db));
        if (!file) await (await import('./search.ts')).refreshTermDf(db);
        console.log('embedded', await (await import('./embed.ts')).backfill(db).catch((e) => `skipped: ${e.message}`));
      }
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtext('memhub-sync'))`).catch(() => {});
      lock.release();
    }
  } else if (cmd === 'ingest') {
    // One live transcript (+ its subagents): archive then index. Called detached by hook.ts.
    const imp = await import('./importer.ts');
    const { appendFileSync, readdirSync } = await import('node:fs');
    const live = args[0];
    const subDir = join(live.replace(/\.jsonl$/, ''), 'subagents');
    const files = [live, ...(existsSync(subDir) ? readdirSync(subDir, { recursive: true, encoding: 'utf8' }).map((f) => join(subDir, f)) : [])]
      .filter((f) => f.endsWith('.jsonl'));
    try {
      for (const f of files) { imp.syncOne(f); await imp.indexFile(db, imp.archivePath(f)); }
      await (await import('./embed.ts')).backfill(db, 32, () => {}).catch(() => 0); // Ollama down → vectors filled by next import
    } catch (e) {
      appendFileSync(join(ROOT, 'ingest.log'), `${new Date().toISOString()} ${live}: ${(e as Error).message}\n`);
    }
  } else if (cmd === 'retokenize') {
    // Tokenizer changed → rebuild words/bigrams in place (keeps embeddings; chunk ids don't depend on lexemes).
    const { bigramRuns, bigramTsvector, toTsvector, words } = await import('./thai.ts');
    let n = 0;
    for (let last = ''; ;) {
      const rows = (await db.query('SELECT id, ctx_header, text FROM chunks WHERE id > $1 ORDER BY id LIMIT 1000', [last])).rows;
      if (!rows.length) break;
      await db.query(
        `UPDATE chunks c SET words = v.w::tsvector, bigrams = v.b::tsvector FROM unnest($1::text[], $2::text[], $3::text[]) v(id, w, b) WHERE c.id = v.id`,
        [rows.map((r) => r.id), rows.map((r) => toTsvector(words(`${r.ctx_header}\n${r.text}`))), rows.map((r) => bigramTsvector(bigramRuns(r.text)))],
      );
      n += rows.length;
      last = rows.at(-1).id;
    }
    await (await import('./search.ts')).refreshTermDf(db);
    console.log('retokenized', n);
  } else if (cmd === 'embed') {
    const { backfill } = await import('./embed.ts');
    const t0 = Date.now();
    console.log('embedded', await backfill(db), `${Date.now() - t0} ms`);
  } else if (cmd === 'search') {
    const { search, snippet } = await import('./search.ts');
    const q = args.join(' ');
    const t0 = performance.now();
    const { hits, semantic } = await search(db, q);
    const ms = (performance.now() - t0).toFixed(1);
    for (const h of hits) console.log(`[${h.id}] ${h.ts?.toISOString().slice(0, 10)} ${h.project} ${h.score.toFixed(4)}\n  ${snippet(h.text, q, 200)}`);
    console.log(`${hits.length} hits in ${ms} ms${semantic ? '' : ' (keyword-only)'}`);
  } else if (cmd === 'index-vault') {
    // one vault (memory_save / dream notes) → index + links + vectors; called detached by notes.ts
    const { indexVault, indexVaults, resolveLinks } = await import('./obsidian.ts');
    try {
      console.log(args[0] ? await indexVault(db, args[0]) : await indexVaults(db)); // no arg = all vaults
      await resolveLinks(db);
      await (await import('./embed.ts')).backfill(db, 32, () => {}).catch(() => 0);
    } catch (e) {
      (await import('node:fs')).appendFileSync(join(ROOT, 'ingest.log'), `${new Date().toISOString()} vault ${args[0]}: ${(e as Error).message}\n`);
    }
  } else if (cmd === 'forget') {
    // forget --session <id> | --project <path prefix>: drop from the index for good (raw archive untouched)
    const what = args[0] === '--session' ? 'session' : args[0] === '--project' ? 'project' : null;
    if (!what || !args[1]) throw new Error('usage: forget --session <id> | --project <path>');
    console.log('forgot sources:', await (await import('./importer.ts')).forget(db, what, args[1]));
  } else if (cmd === 'dream') {
    // dream [--runner claude|files] [--run id] [--force] [--limit n] | dream --consolidate (no LLM: approvals, co-access, hubs)
    const d = await import('./dream.ts');
    const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
    if (args.includes('--consolidate')) {
      await d.consolidate(db);
      const { MEMORY_VAULT } = await import('./notes.ts');
      (await import('./vault-git.ts')).commitBatch(MEMORY_VAULT, `consolidate ${new Date().toISOString().slice(0, 10)}: approvals + hubs`);
      console.log('consolidated');
    }
    else {
      const runner = opt('--runner') ?? 'claude';
      const run = opt('--run') ?? `${new Date().toISOString().slice(0, 10)}-${runner}`;
      const dir = join(ROOT, 'tmp', 'dream', run);
      const r = await d.dream(db, { run, force: args.includes('--force'), limit: Number(opt('--limit')) || undefined,
        llm: runner === 'files' ? d.filesRunner(dir) : d.claudeRunner() });
      console.log(JSON.stringify({ run, status: r.status, stats: r.stats }));
      if (r.pending) console.log(`pending requests (answer each <id>.request.json with <id>.result.json, then rerun):\n${r.pending.map((p) => join(dir, `${p}.request.json`)).join('\n')}`);
    }
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
    if (args.includes('--out') && out) writeFileSync(out, json);
    console.log(`${b.mode}: ${b.nodes.length} nodes, ${b.links.length} links, ${b.events.length} events, ${(json.length / 1024).toFixed(0)} KB, ${Date.now() - t0} ms`);
  } else if (cmd === 'brain-serve') {
    // Local viewer with real labels: web/out + /graph.json + /feed.json on 127.0.0.1 only (never exposed).
    const { createServer } = await import('node:http');
    const { buildBrain, feedOf } = await import('./brain.ts');
    const { extname, normalize } = await import('node:path');
    const out = join(ROOT, 'web', 'out');
    const port = Number(args[args.indexOf('--port') + 1]) || 5442;
    let cache: { at: number; b: Awaited<ReturnType<typeof buildBrain>> } | null = null;
    const brain = async () => (cache && Date.now() - cache.at < 5000 ? cache.b : (cache = { at: Date.now(), b: await buildBrain(db, 'local') }).b);
    const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' };
    createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/graph.json' || url.pathname === '/feed.json') {
          const b = await brain();
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          return res.end(JSON.stringify(url.pathname === '/graph.json' ? b : feedOf(b, b.at - 7200)));
        }
        let p = normalize(join(out, decodeURIComponent(url.pathname)));
        if (!p.startsWith(out)) { res.writeHead(403); return res.end(); }
        if (existsSync(p) && !(await import('node:fs')).statSync(p).isFile()) p = join(p, 'index.html');
        if (!existsSync(p)) p = existsSync(`${p}.html`) ? `${p}.html` : join(out, '404.html');
        res.writeHead(existsSync(p) ? 200 : 404, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
        res.end(existsSync(p) ? readFileSync(p) : 'not found');
      } catch (e) { res.writeHead(500); res.end((e as Error).message); }
    }).listen(port, '127.0.0.1', () => console.log(`brain (local, real labels): http://127.0.0.1:${port}`));
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
      console.log(`published rev ${rev}: ${url} (public: https://memory-hub-brain.vercel.app; per-deployment URLs need a Vercel login)`);
    }
  } else if (cmd === 'handoff') {
    // handoff [list] | show <id> | done <id>: cross-AI handoffs (memory_handoff) for ลุงจืด, all projects
    const h = await import('./handoff.ts');
    const [sub = 'list', id] = args;
    if (sub === 'list') {
      await h.expireHandoffs(db);
      const rows = (await db.query(`SELECT * FROM handoffs WHERE status IN ('open', 'claimed') ORDER BY created_at DESC LIMIT 30`)).rows;
      for (const r of rows) console.log(`${h.handoffLine(r)}  [${r.status}${r.claimed_by ? ` by ${r.claimed_by}` : ''}] ${r.project || 'global'}`);
      console.log(rows.length ? `${rows.length} open/claimed — show <id> | done <id>` : 'no open handoffs');
    } else if (sub === 'show' && Number(id)) {
      const r = (await db.query(`SELECT * FROM handoffs WHERE id = $1`, [Number(id)])).rows[0];
      console.log(r ? `${h.handoffLine(r)}\nstatus: ${r.status}${r.claimed_by ? ` by ${r.claimed_by} ${h.ago(r.claimed_at)}` : ''} · ${r.project || 'global'}` +
        `${r.to_app ? ` · for ${r.to_app}` : ''}\n${r.title}\n${r.body}` : `not found: #${id}`);
    } else if (sub === 'done' && Number(id)) console.log(await h.doneHandoff(db, Number(id), 'cli'));
    else console.log('usage: node src/cli.ts handoff [list|show <id>|done <id>]');
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
  } else if (cmd === 'stats') {
    const r = await db.query(`SELECT (SELECT count(*) FROM sources) sources, (SELECT count(*) FROM turns) turns,
      (SELECT count(*) FROM chunks) chunks, (SELECT pg_size_pretty(pg_database_size('memhub'))) db_size`);
    console.table(r.rows);
  } else {
    console.log('usage: node src/cli.ts <init|migrate|sync [--google-full]|import [--force] [file]|ingest <live.jsonl>|embed|search <query>|stats [--latency]|handoff [list|show <id>|done <id>]|vault <init|log|diff|undo>|google <login|status [--dry]|revoke>|retokenize|index-vault [vault]|forget --session <id>|--project <path>|dream [--consolidate]|brain [--public] [--out file]|brain-serve [--port n]|publish [--build] [--force]>');
  }
} finally {
  await db.end();
}
