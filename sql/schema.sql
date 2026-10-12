-- Index only: everything here is rebuildable from the raw archive (~/ai-archive/raw).
CREATE TABLE IF NOT EXISTS sources (
  id          bigserial PRIMARY KEY,
  tool        text NOT NULL,                 -- claude
  path        text NOT NULL UNIQUE,          -- archive path
  kind        text NOT NULL,                 -- main | subagent
  session_id  text,
  project     text,
  size        bigint NOT NULL,
  mtime_ms    bigint NOT NULL,
  sha256      text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS turns (
  uuid          text PRIMARY KEY,
  source_id     bigint NOT NULL REFERENCES sources ON DELETE CASCADE,
  seq           int NOT NULL,                -- order within source
  session_id    text NOT NULL,
  parent_uuid   text,
  role          text NOT NULL,               -- user | assistant | tool | summary | notice
  ts            timestamptz,
  project       text,
  text_redacted text NOT NULL,
  is_subagent   boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS turns_source_seq ON turns (source_id, seq);
CREATE INDEX IF NOT EXISTS turns_session ON turns (session_id);

CREATE TABLE IF NOT EXISTS chunks (
  id          text PRIMARY KEY,              -- sha256(chunker_ver, source, text) → stable across re-imports
  source_id   bigint NOT NULL REFERENCES sources ON DELETE CASCADE,
  turn_uuid   text NOT NULL,                 -- first turn in the chunk
  seq_from    int NOT NULL,
  seq_to      int NOT NULL,
  session_id  text NOT NULL,
  project     text,
  ts          timestamptz,
  ctx_header  text NOT NULL,
  text        text NOT NULL,
  words       tsvector NOT NULL,             -- ICU words (Thai) + Latin words, built app-side
  bigrams     tsvector NOT NULL,             -- Thai/digit char bigrams, built app-side
  embedding   halfvec(1024),                 -- Phase 2
  model_ver   text,
  chunker_ver text NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_words ON chunks USING gin (words);
CREATE INDEX IF NOT EXISTS chunks_bigrams ON chunks USING gin (bigrams);
CREATE INDEX IF NOT EXISTS chunks_project_ts ON chunks (project, ts);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks (source_id);

-- Document frequency per word lexeme (refreshed after bulk import) → IDF weighting + rare-term candidates.
CREATE TABLE IF NOT EXISTS term_df (
  word  text PRIMARY KEY,
  ndoc  int NOT NULL
);

-- Phase 2: vector index (cosine on half-precision bge-m3 vectors).
CREATE INDEX IF NOT EXISTS chunks_embedding ON chunks USING hnsw (embedding halfvec_cosine_ops);

-- Obsidian-style edges: [[wikilinks]] between notes (dst_id NULL = link to a note that doesn't exist yet).
CREATE TABLE IF NOT EXISTS links (
  src_id   bigint NOT NULL REFERENCES sources ON DELETE CASCADE,
  dst_name text NOT NULL,                    -- link target as written, lowercased, without alias/heading
  dst_id   bigint REFERENCES sources ON DELETE SET NULL,
  PRIMARY KEY (src_id, dst_name)
);
CREATE INDEX IF NOT EXISTS links_dst ON links (dst_id);
CREATE INDEX IF NOT EXISTS links_dst_name ON links (dst_name);

-- Usage signals: one row per chunk shown (search) or opened (get/related). The only table memhub_ro may write.
CREATE TABLE IF NOT EXISTS access_log (
  id       bigserial PRIMARY KEY,
  ts       timestamptz NOT NULL DEFAULT now(),
  kind     text NOT NULL,                    -- search | get | related
  chunk_id text NOT NULL,
  rank     int,                              -- position in the result list (search)
  query    text,                             -- redacted, ≤300 chars (local only, never exported)
  session  text,                             -- MCP process = one Claude session
  project  text                              -- caller's cwd
);
CREATE INDEX IF NOT EXISTS access_log_chunk ON access_log (chunk_id);
CREATE INDEX IF NOT EXISTS access_log_ts ON access_log (ts);
GRANT INSERT ON access_log TO memhub_ro;
GRANT USAGE ON SEQUENCE access_log_id_seq TO memhub_ro;

-- Brain edges between sources (a < b): Hebbian co-access (used together in one session), strengthened by dream, decayed nightly.
CREATE TABLE IF NOT EXISTS edges (
  a          bigint NOT NULL REFERENCES sources ON DELETE CASCADE,
  b          bigint NOT NULL REFERENCES sources ON DELETE CASCADE,
  kind       text NOT NULL,                  -- coaccess
  w          real NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (a, b, kind),
  CHECK (a < b)
);
CREATE INDEX IF NOT EXISTS edges_b ON edges (b);

-- Pairs the local Gemma judged for an edge of kind sem (src/sem.ts, nightly): every verdict, none too, so a pair is judged once;
-- a deleted source drops its rows like its edges.
CREATE TABLE IF NOT EXISTS judged_pairs (
  a          bigint NOT NULL REFERENCES sources ON DELETE CASCADE,
  b          bigint NOT NULL REFERENCES sources ON DELETE CASCADE,
  verdict    text NOT NULL,                  -- rel: same_task | fixes | explains | uses | updates | none
  strength   smallint NOT NULL,              -- 0..3 (0 with none); verdict <> none AND strength 3 → edge kind sem
  model      text NOT NULL,                  -- llama-server model id
  judged_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX IF NOT EXISTS judged_pairs_b ON judged_pairs (b);
GRANT SELECT ON judged_pairs TO memhub_ro;

-- Forgotten sessions/projects: deleted from the index and never re-imported (the raw archive is untouched).
CREATE TABLE IF NOT EXISTS forgotten (
  key        text PRIMARY KEY,               -- 'session:<id>' | 'project:<normalized path prefix>'
  at         timestamptz NOT NULL DEFAULT now()
);

-- Note status from frontmatter (dream facts: active | superseded); superseded notes rank lower.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS status text;
-- A Claude chat that was shown a Claude-only hit (guard.PRIVATE_TOOLS): hidden wherever that tool is (importer.indexFile).
ALTER TABLE sources ADD COLUMN IF NOT EXISTS hide_as text;

-- Key/value state for background jobs (dream watermark, …).
CREATE TABLE IF NOT EXISTS state (
  k text PRIMARY KEY,
  v jsonb NOT NULL
);

-- Typed index of memory-hub vault notes (frontmatter memhub: fact|card|insight). Truth = the .md file;
-- obsidian.ts rewrites this row on every (re)index, so CASCADE is correct here.
CREATE TABLE IF NOT EXISTS facts (
  source_id     bigint PRIMARY KEY REFERENCES sources ON DELETE CASCADE,
  fid           text NOT NULL UNIQUE,          -- F<md5:8> fact | S<session:8> card | I<md5:8> insight
  kind          text NOT NULL CHECK (kind IN ('card','rule','feedback','decision','preference','fact','howto','insight')),
  scope         text NOT NULL DEFAULT 'project' CHECK (scope IN ('project','global')),
  project       text,                          -- normalized path; NULL when global
  lang          text,
  valid_at      timestamptz NOT NULL,          -- world time: became true
  invalid_at    timestamptz,                   -- world time: stopped being true
  created_at    timestamptz NOT NULL,          -- system time: written
  expired_at    timestamptz,                   -- system time: learned it is no longer current
  superseded_by text,                          -- fid
  review_target text,                          -- pending notes: fid they propose to update/supersede
  source_uuids  text[] NOT NULL CHECK (cardinality(source_uuids) > 0),
  session_ids   text[] NOT NULL DEFAULT '{}',  -- derived from source_uuids at index time
  confidence    real,
  importance    smallint,
  pinned        boolean NOT NULL DEFAULT false,
  user_owned    boolean NOT NULL DEFAULT false, -- rule/feedback, owner: user, or edited → no automatic semantic change
  edited        boolean NOT NULL DEFAULT false, -- body changed by ลุงจืด → machine never writes the file again
  md5           text NOT NULL,                 -- md5(lower(collapsed text)): dedupe + tombstones
  run           text                           -- dream run id; NULL = written by hand / memory_save
);
CREATE INDEX IF NOT EXISTS facts_sessions ON facts USING gin (session_ids);
CREATE INDEX IF NOT EXISTS facts_uuids ON facts USING gin (source_uuids);
CREATE INDEX IF NOT EXISTS facts_md5 ON facts (md5);

-- Review queue = pending notes; ลุงจืด resolves them in Obsidian by setting status.
CREATE OR REPLACE VIEW review_queue AS
  SELECT f.fid, f.review_target, f.kind, f.project, s.path, f.created_at
  FROM facts f JOIN sources s ON s.id = f.source_id WHERE s.status = 'pending';

-- Usage keyed by a stable node id (chunk ids change on note edit / chunker bump).
ALTER TABLE access_log ADD COLUMN IF NOT EXISTS turn_uuid text;
ALTER TABLE access_log ADD COLUMN IF NOT EXISTS client text;  -- MCP clientInfo.name of the AI app that asked
CREATE INDEX IF NOT EXISTS access_log_node ON access_log (turn_uuid, ts);
-- latency of the MCP call that wrote the row (same on every row of one call; stats read rank 1): cli stats --latency
ALTER TABLE access_log ADD COLUMN IF NOT EXISTS tool text;      -- search | get | related | timeline (timeline logs kind 'related')
ALTER TABLE access_log ADD COLUMN IF NOT EXISTS ms int;         -- call start → reply text ready
ALTER TABLE access_log ADD COLUMN IF NOT EXISTS semantic boolean; -- search: false = keyword-only fallback (embedder busy/down)
ALTER TABLE access_log ADD COLUMN IF NOT EXISTS chars int;      -- reply text length the calling AI got (its token cost); null on related
GRANT SELECT ON facts, review_queue TO memhub_ro;

-- The handoffs table was dropped from this schema on 2026-10-07 (memory_handoff removed, 0 rows ever); an existing DB may still have it, harmless.

-- What each SessionStart hook injected (session-start.ts): ids only, never the text, so ลุงจืด can see what an AI was given
-- (cli stats --injected). Written by the hook, so memhub_ro may insert here (like access_log).
CREATE TABLE IF NOT EXISTS injections (
  id      bigserial PRIMARY KEY,
  ts      timestamptz NOT NULL DEFAULT now(),
  client  text NOT NULL,                     -- --app: claude-code | codex | gemini | zcode
  project text,                              -- normalized cwd
  session text,                              -- the new chat's session id
  ids     text[] NOT NULL,                   -- in shown order: F…/S… rule + card fids, session:<id> unsummarized chats
  chars   int NOT NULL                       -- additionalContext length (budget 2000)
);
CREATE INDEX IF NOT EXISTS injections_ts ON injections (ts);
GRANT INSERT ON injections TO memhub_ro;
GRANT USAGE ON SEQUENCE injections_id_seq TO memhub_ro;
ALTER TABLE injections ADD COLUMN IF NOT EXISTS source text; -- Claude Code SessionStart source: startup | resume | clear | compact | fork
GRANT SELECT ON injections TO memhub_ro;                      -- the hook skips a resume of a chat it already briefed
