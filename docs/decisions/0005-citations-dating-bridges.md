# 0005 — Every hit names its source; facts are dated by their chat; LLM-free bridges stay out of ranking until they earn it

Date: 2026-10-05 · Status: accepted (A, C1, C3) · B partially (edges kept, not in competition) · C2 skipped

## Context
ลุงจืด asked for links that make the brain "เก่ง ฉลาด รอบรู้ และสามารถอ้างถึงต้นทางได้". Research (tmp/research/linking/REPORT.md)
led to three tracks: A citations, B LLM-free links (entity / chat↔GitHub), C knowledge hygiene (contradictions, aliases, event dating).
Rules kept: no LLM in the search hot path, no ranking change without a fresh holdout and a shuffled control, Claude-only sources never cited.

## Decision
- **A — citations (shipped).** `origins()` (search.ts) looks up one `src` tag per hit after ranking (ranking unchanged by construction,
  p50 1.3 ms): `claude:<last 8 of session>#seq`, `claude/sub:<agent file>#seq`, `github:o/r@sha7` / `#N`, `note:<vault/path>`. A fact shows
  its preferred cited turn (his words first, then the earliest) + date + `×N` sessions + `AI-only` when no cited turn is his, or
  `memory_save`. `memory_get` lists the cited turns (his first, 6 shown) with tags and GitHub permalinks. Live: 1324/1324 hits tagged,
  fact hits with a visible source 49 % → 100 %; output +6.8 % (brief +10.8 %: brief drops the app word when a tag names it).
- **C1 — lint (shipped).** `support`: dream facts whose hard anchors (identifiers, versions, numbers) are mostly absent from the cited turns.
  `conflicts`: same-project active facts with cosine 0.8–0.95 whose numbers differ or where one side negates. Report only, no auto-edit.
  Feeding conflicts into the dream is blocked until `claude /login` works again.
- **C3 — event dating (shipped).** A fact/card/insight chunk is dated by its earliest cited non-note turn, then `created_at`, never the file
  mtime (791 of 859 facts were > 1 day off). Gate: EXACT eval before/after within one sync hour — raw 9/254 items moved (6 up, 3 down),
  fine 2/293 (net 0): no regression. Re-dated notes get new chunk ids, so the reindex re-embeds them (`index-vault` does).
- **B — bridges (edges shipped, competition NOT adopted).** `entity` (identifier-shaped lexeme, unit df 2–12, Σ1/ln(1+n), per-node top 8)
  and `cites` (sha prefix / github.com URL → the commit, issue or repo source) are rebuilt hourly (+~1.1 s) and shown by `memory_related`.
  Bridges are fan-normalized as their own family at gain 0.5 (`share()`), so they never dilute link/spawn/prov arcs; with the default kinds
  this is identical to before (N1 tune split 20.2 = 20.2 on every stratum). Pre-registered test on a fresh holdout N1c (207 items incl.
  entity S8 and GitHub S9 strata, tmp/abc/b/PREREG.md), B-visible@8C: current 17.4 · +bridges 16.9 · shuffled bridges 16.9 → fails.
  They help where meant (S8 +2, S9 +1) and lose elsewhere (S6 −2, S5/S2/S7 −1). `MEMHUB_COMPETE_KINDS` keeps them opt-in.
  The same read replicated the current competition: 8.7 → 17.4 (+18 −0, p 7.6e-6).
- **C2 — alias table (skipped).** bge-m3 is cross-lingual, so the vector leg already bridges Thai/English names,
  and no eval set targets alias misses yet (not measured, so not built). Add with such a set when a miss is traced to vocabulary.

## Consequences
- Every app can say where a memory came from; AI-only facts are visible as such.
- N1, N1b, N2, fine and now N1c are read: the next associative change needs a fresh N1d (tmp/neural/eval/n1c is the template).
- Bridges in competition is the open lead: a gate that lets a bridge take a slot only when no base proposal clears θ is untested.
