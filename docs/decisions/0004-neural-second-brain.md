# 0004 — A second brain with synapses (fly mushroom body), kept only where a fresh holdout says it helps

Date: 2026-10-04 · Status: accepted

## Context
ลุงจืด asked for a re-test of accuracy, speed and stability, and for "สมองที่สอง แบบมีการเชื่อมโยงเส้นประสาท" inspired by
fly-brain projects (FlyWire connectome). The fly mushroom body suggested: sparse expansion (Kenyon cells), dopamine-gated
three-factor plasticity, sleep downscaling, active forgetting, a familiarity/novelty neuron (MBON-α'3). Each idea was built and
then had to beat its control on data it was never tuned on. Design and numbers: docs/research/phase4-design.md §4b.

## Decision
- **Speed/stability (kept, all gates passed):** keyword leg detoasts each chunk once (memory_search p95 ~170 → ~90 ms);
  `ef_search` 400 on the m=16 HNSW (closest to exact; m=24 rebuild gained nothing); keyword fallback capped at df ≤ 0.5
  (`MEMHUB_KW_FALLBACK_MAX_DF`); fail-fast DB (statement 5 s, query 6 s, connect 2 s); term_df refresh by DELETE under an
  advisory lock (no 2 s search stall); hourly runs `migrate` first, skipped when `sql/schema.sql` is unchanged (stamp in
  `state`, per schema), `lock_timeout` 2 s, a failed migrate skips that hour.
- **Synapses (kept):** one `edges` table — `prov`, `spawn`, `next` rebuilt hourly from existing tables (0.15 s; zero-degree
  nodes 83 % → ~20 %) and `coaccess` grown by a three-factor rule (co-shown in the top 5 + opened later in that session) and
  downscaled nightly. Never an endpoint that is Claude-only (Google) or hidden; the cached graph re-checks relays per call.
- **Equal-slot competition (on by default, `MEMHUB_COMPETE=0` = off):** when memory_search asks for 7–8 results, 1-hop
  neighbours (link/spawn/prov/coaccess) of the top 6, each as its chunk nearest the query, compete with results 7–8 by
  cos(query) + 0.3·activation. Fresh N1b holdout (237, read once, pre-registered rule): linked answer visible 13.5 → 22.4 %
  vs plain limit 8 (+22 −1, p 6e-6), +23 vs a degree-preserving shuffled graph, answer terms 47.4 → 50.3, +91 chars p95,
  +6 ms p95. About a fifth of real calls ask for 8 results.
- **Not shipped:** '⇢ linked' extra lines (`MEMHUB_ASSOC`, off: holdout +3 only; 2 extra lines lose to 2 more hits on answer
  terms); habituation (one MCP process is not one conversation — subagents, /clear, Codex /new share it — and it saved 2 %);
  FlyHash / fly Bloom novelty / FlyVec / whole-brain LIF simulation (all far below HNSW or no learning); graph merged into the
  top-k score; 2-hop spreading (0 gold hits); choosing the linked chunk nearest the query for extra lines (worse than seed).

## Consequences
- The win is concentrated where the answer lives in a linked note or a subagent run (strata S6, S5); decision→reason,
  bug→later fix and project→deploy questions gain ~0. The detail set lost −3 net at limit 8 (n.s.); default limit 6 is
  unchanged.
- `coaccess` needs weeks of real use before any edge reaches the spreading threshold (max w 0.15 today).
- The public brain shows `prov`/`next` links only after `publish --build` of the new web; until then hourly and nightly
  publish are paused (scripts/*.cmd TEMP lines).
- Every future ranking idea follows the same protocol: EXACT mode, paired arms inside one sync hour, equal-slot baseline,
  shuffled control, a fresh holdout read once.
