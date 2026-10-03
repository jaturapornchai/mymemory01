# 0002 — Dream into Markdown facts, ACT-R ranking, Hebbian links, anonymized public brain

Date: 2026-10-02 · Status: accepted (details: `docs/research/phase4-design.md`)

## Context
ลุงจืด asked for ranking by use/age/importance, a "dream" that distils sessions, a brain with neuron-like links, every Claude
connected, and a public 3D view for friends — still local-only, Claude-only for any LLM step, his own notes never overwritten.

## Decision
- **Facts live as Markdown** in `D:/obsidian-vault/memory-hub` (`facts/`, `sessions/` cards, `hubs/`); the `facts` table is an
  index of their frontmatter. File = truth, so ลุงจืด edits/deletes in Obsidian; `body_sha` detects edits → never rewritten;
  deleting a file tombstones `fact:<md5>`.
- **Dream** = Mem0-style ADD/NOOP/UPDATE/SUPERSEDE with Graphiti/Zep bi-temporal fields (valid/invalid vs created/expired;
  a late-arriving older fact is born superseded). Prompts use integer remaps (T#/S#/N#/E#), unknown ids rejected; zod-validated.
  Runner: headless `claude -p` (sonnet, `--setting-sources project`, ANTHROPIC_* stripped) or a files runner answered by an
  in-session Workflow. Notes ลุงจืด wrote/edited/pinned (or `memory_save`d) are never changed — proposals go to
  `hubs/_review.md`. A dream-recorded rule/feedback is superseded automatically only by ลุงจืด's own newer words
  (a user turn), never by assistant text — otherwise stale rules ("Fable thinks, DeepSeek does") stayed active.
- **Coverage per turn, not per session**: state `dream:session:<id>.upto` = time of the last dreamed turn; a session that
  grows is dreamed again for its new turns only (own card), a session resumed in another folder is merged by time, long
  ones go in consecutive ≤20k-char windows (oldest first, a session's next window in a later batch so it can supersede
  the earlier one). The first run cut long sessions to head + tail and kept facts their hidden middle had reversed
  (SEA-LION "chosen" though deleted two days later). The batch plan freezes each session's turn range, so a resumed
  files-runner run keeps its request ids.
- **Ranking** = RRF relevance × ACT-R prior: base-level activation (Petrov approx. k=1, d=0.5) from `access_log` (search impressions
  excluded), saturating S/(S+1), noisy-or with importance; β=0.05 (higher β hurt recall in eval). Superseded ×0.5, pending ×0.8.
- **Links**: Obsidian wikilinks + same-session + Hebbian co-access `w = min(1, Σ 0.1·0.995^age)` (once per session, ≤30 min
  window) recomputed nightly + vector similarity, exposed by `memory_related`.
- **Project** = git root of the cwd; Claude worktrees and subdirs fold into the main repo; workflow/subagent files inherit the
  parent session (else forget/exclude would miss them).
- **Privacy guard**: no memory served when `ANTHROPIC_BASE_URL` is a non-Anthropic host (this machine's CLI env points at z.ai).
- **Public brain**: Next.js static export on Vercel, hourly redeploy only when the graph changed; nodes are salted aliases
  (P1/V1/…), counts and timestamps only; `assertAnonymous` blocks a publish containing any project/session/path token.

## Evidence (2026-10-02)
- Backfill dream: 58 sessions → 55 cards + 273 facts; audit 25/30 sampled facts faithful (3 corrected), vault secret scan clean.
- Audit found redaction gaps (DigitalOcean / Ark / Ollama keys, `password \`x\``) → rules added, `import --force` re-applied;
  0 turns still change under the redactor.
- Eval R@10 87.2 (was 86.0), p95 205 ms. Tests 87/87 incl. e2e: hook ingest → new MCP session recalls (Thai + English),
  `memory_save` → next session finds it, SessionStart inject, z.ai guard, forget.

## Consequences
- Nightly dream needs a logged-in Anthropic CLI (`claude /login`); until then run it via the files runner.
- Facts written before the project fix keep their old folder names (`facts/<worktree>/`); the index normalizes the project.
