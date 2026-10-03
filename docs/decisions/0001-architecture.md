# 0001 — Build on Postgres + app-side Thai tokenization + bge-m3; no off-the-shelf memory tool

Date: 2026-10-01 · Status: accepted

## Context
ลุงจืด wants every Claude (Code, all projects + Desktop) to recall past conversations and Obsidian notes, local-only,
fast, and cheap in tokens, with Thai + English search. Claude Code deletes transcripts after `cleanupPeriodDays`
(now set to 3650); only 60 main sessions survived on disk.

## Decision
- **Archive** raw JSONL append-only in `~/ai-archive/raw/claude/projects`; DB is a rebuildable index.
- **Postgres 18 + pgvector 0.8.6** (`memhub-pg`, 127.0.0.1:5441, rw/ro roles).
- **Thai keyword search app-side**: ICU `Intl.Segmenter('th')` words (split at Thai↔digit/Latin edges) + Thai/digit
  char bigrams (dots in abbreviations removed), stored as pre-built tsvectors. Words list = candidates from rare terms
  (df ≤ 5 %) scored by Σ IDF (`term_df`); bigram list = exact phrases of short runs.
- **Vectors**: bge-m3 via local Ollama, halfvec(1024) HNSW; 300 ms query-embed timeout → keyword-only fallback.
- **Fusion**: RRF k=60 of the three lists in one SQL; ≤3 hits per session; current project ×1.3.
- **MCP**: `memory_search` (≤8 snippets × ≤400 chars), `memory_get`, `memory_related` (Obsidian links/backlinks + similar).
- **Index policy**: user/assistant text, compact tool lines (Bash/Edit/Write/Web/Agent/Ask), compact summaries,
  Agent/AskUserQuestion results, subagent task + final answer; skip thinking, isMeta, system-reminders, other tool output.
- **Redaction** before DB/embedding (regex families + entropy rule); `<private>` dropped; NUL stripped.

## Evidence (measured 2026-10-01, 86 real questions written from sampled rounds; not hand-checked yet)
| config | R@1 | R@5 | R@10 | MRR | p50 / p95 |
|---|---|---|---|---|---|
| keyword (ts_rank OR fallback) | 38.4 | 62.8 | 70.9 | 0.480 | 161 / 258 ms |
| keyword (rare-term + IDF) | 46.5 | 69.8 | 77.9 | 0.565 | 40 / 139 ms |
| + bge-m3 vectors (final, cap 3/session) | 62.8 | 79.1 | 86.0 | 0.701 | 51 / 113 ms |

Lexical-style questions R@5 95.5; semantic-style R@10 76.2. Redaction dry run over the archive: ~280 real secret hits
(connstr, kv, sk-, bearer, aws), remaining entropy false positives are ssh public keys / URL ids only.

## Alternatives rejected (research workflow, hands-on where possible)
- **deja-vu** (MIT, closest fit): missed "ภงด 53"; broad queries up to 3.2 s.
- **Hindsight / Mem0 / Graphiti / cognee …**: LLM extraction on write (loses verbatim, needs LLM), weak Thai lexical.
- **claude-mem, Basic Memory, QMD, episodic-memory**: FTS5/English embedders break Thai; AGPL (Basic Memory).
- **ParadeDB pg_search** (AGPL), **PGroonga** (TF-only score, custom image), **pg_textsearch** (BM25; revisit only if p95 > 300 ms).
- **Rerankers** (bge-reranker-v2-m3, Qwen3-Reranker): 7/8 vs dense 8/8 on the Thai toy set, 4–11 s on CPU; GPU is shared.
- **Embedders**: qwen3-embedding:0.6b lower Thai retrieval (64.51 vs bge-m3 69.67, community Thai MTEB); jina non-commercial.
- **Kev** (decision models): not retrieval; candidate only for Phase 4 dream pre-filtering, needs approval (spec says dream = Claude only).

## Consequences
- Tokenizer changes need `node src/cli.ts retokenize`; embedder changes need `embed` (model_ver per row).
- GPU is shared with other projects (gemma-4-26B ≈ 15 GB): vectors may time out → results marked keyword-only.
- MCP hides chunks newer than its own start (live session already in context; concurrent sessions hidden too).
