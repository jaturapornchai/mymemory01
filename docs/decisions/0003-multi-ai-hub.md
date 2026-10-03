# 0003 — One memory hub for every AI app; Claude stays the main one

Date: 2026-10-02 · Status: accepted

## Context
ลุงจืด works in several AI apps besides Claude Code — Codex, Gemini CLI, Antigravity, ZCode, LM Studio — and each keeps
its own history, so a decision made in one app was invisible to the others. 0001/0002 made memory-hub Claude-only
(index, MCP and the z.ai guard). On 2026-10-02 he decided: "memory hub ให้กับ ai model ทุกตัว แต่ claude เป็นตัวหลัก".

## Decision
- **Import every app** through one small module per app (`src/tools/<tool>.ts`: `sync` / `isTranscript` / `parse`). Live app
  data is read-only; the archive `~/ai-archive/raw/<tool>/` is append-only (rewritten files keep `.bak` copies); the shared
  indexer applies the same redaction, project rule (git root of the cwd), exclude/forget and chunking. Turn uuids are
  `<tool>:<session>:<id>` so apps can never collide; child/subagent sessions group under their parent conversation.
- **Serve every app** over the same MCP server; `access_log.client` and `memory_save` notes record which app asked.
  Raw conversations of any app are raw truth in ranking (never down-ranked, only annotated as changed).
- **Claude stays the main one**: the dream (cards + facts) runs on Claude only and now covers every app's sessions; the
  session header and card name the app, and the extractor never attributes another app's answer to Claude.
- **Backlog cap**: the first runs would meet ~1000 never-dreamed sessions (Codex alone ~800), so a run without `--limit`
  dreams at most 25 sessions, newest first; sessions with nothing worth a card are marked done without counting.
- `MEMHUB_ANTHROPIC_ONLY=1` restores the old rule: memory only for Claude apps on an Anthropic backend.

## Consequences
- What an app reads through MCP goes to that app's model provider (OpenAI, Google, Z.ai; nobody for a local LM Studio
  model) — accepted by ลุงจืด; the strict flag above is the way back.
- The backlog drains over weeks at 25 sessions/night (more with `dream --limit n`); the cap counts sessions, not windows,
  so one very long session still goes whole.
- Each app's format is internal and may change; importers ignore unknown fields and skip malformed lines, and one broken
  importer never stops the others' sync.
