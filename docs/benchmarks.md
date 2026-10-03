> **สรุป (ไทย):** วัด memory-hub ด้วย benchmark สาธารณะ 2 ชุด ผ่าน pipeline จริงทั้งเส้น (redact → chunk → ตัดคำ → bge-m3 → `search()` RRF + prior) ใน schema แยก `memhub_bench` ไม่แตะ schema หลัก วัดเฉพาะการค้นคืน (retrieval) ไม่มี LLM อ่านหรือตอบ
> - **LongMemEval_S** (สุ่มแบบแบ่งชั้น 54/500 ข้อ ครบ 6 ประเภท, seed 1): session R@5 = 100% (54/54) แต่พอตรวจซ้ำด้วยอีก 20 ข้อนอก subset (seed 2) ได้ R@5 **90%** / R@10 95% (พลาด 2 ข้อ เป็น temporal-reasoning ทั้งคู่) รวม 74 ข้อได้ R@5 **97.3%** (72/74, ช่วงเชื่อมั่น 95% คือ 90.7–99.3) / R@10 98.6% จึง**อยู่ระดับเดียวกับ** mempalace 96.6% และ agentmemory 95.2/98.6% (นิยามเดียวกัน วัดครบ 500 ข้อ) ไม่ใช่หลักฐานว่าเหนือกว่า ตัวเลขจริงต้องรอวัดครบ 500 ข้อ
> - **LoCoMo** (ครบ 1,986 ข้อ): session R@10 = **93.9%** (mempalace hybrid v5 ได้ 88.9%) และ R@5 = 87.7% (mempalace ได้ 83.7%) ส่วนระดับ dialog ตามนิยามทางการ R@5/10/25 = 60.5/69.5/78.1% (paper ใช้ DRAGON ได้ 58.8/67.5/79.9%)
> - latency ของ `search()` อยู่ที่ p50 37.5 ms / p95 54.8 ms
> - ข้อจำกัด: ข้อมูลเป็นภาษาอังกฤษล้วน จึงไม่ได้วัดภาษาไทย / LongMemEval เป็น subset / ตัวเลขของโปรเจ็กต์อื่นเป็นตัวเลขที่เขารายงานเอง (self-reported) เรายังไม่ได้รันซ้ำ / หน่วยที่ค้นคืนต่างกัน (ของเราคือ chunk ระดับ round)

# Public memory benchmarks: LongMemEval_S + LoCoMo (2026-10-02)

`npm run bench` (`scripts/bench.ts`) runs both datasets through memory-hub's real pipeline and scores the rankings with ports of each benchmark's official retrieval metrics. It also scores the metric definitions other projects use, so the numbers line up. **Retrieval only:** no LLM reads the results or answers the questions (external AI is not allowed here), so answer accuracy is out of scope and is never claimed.

## 1. Method

- **Schema.** Everything runs in its own schema, `memhub_bench`. It is created by `sql/schema.sql` exactly as `node src/cli.ts migrate` creates the main one, and a guard aborts if `current_schema()` is anything else. The main schema is never written. Results: `bench/data/results.json`, which holds per-question rows (gitignored).
- **Ingest = the importer's `store()`.** For every dataset session:
  - Each message goes through `clean()` (strip `<private>`, then redact).
  - `chunkTurns` builds round chunks of at most 1,200 chars, each starting at a user turn.
  - Each chunk gets ICU/Latin `words` and Thai/digit `bigrams` tsvectors.
  - `backfill()` embeds the chunks with bge-m3 via Ollama, rate-limited to `MEMHUB_EMBED_RATE` = 10/s.
  - `refreshTermDf()` runs last.
- **Isolation.** Each LongMemEval question is its own project, `bench/lme/<question_id>/`, holding its own haystack. Each LoCoMo conversation is likewise one project, `bench/locomo/<sample_id>/`. Every search passes that project as the filter. IDF is corpus-wide, as in real use: one corpus with 64 projects and 35,434 chunks.
- **Timestamps.**
  - Message time = the dataset's session time + *i* ms, which keeps the message order. LongMemEval uses `haystack_dates` and LoCoMo uses `session_N_date_time`. Neither has a zone, so both are read as UTC.
  - LongMemEval's `before` bound is the end of the question's day (`question_date`). The day, not the minute, because 44 of the 500 questions have answer sessions dated later on the question's own day, which looks like noise in the dataset's clock times. No haystack session is dated after that day, so the bound hides nothing.
  - LoCoMo has no question date, so it gets no bound.
- **LoCoMo text.** It uses LoCoMo's own dialog-RAG format: `<speaker> said, "<text>"`, plus ` and shared <blip_caption>` when there is a caption. A `speaker_a` turn opens a round (role user) and `speaker_b` is the reply (role assistant).
- **LongMemEval subset.** 54 of the 500 questions, picked with seed 1 and stratified by `question_type` (each type gets its share, largest remainder):

  | Type | single-session-user | multi-session | single-session-preference | temporal-reasoning | knowledge-update | single-session-assistant |
  |---|---|---|---|---|---|---|
  | In subset (of 500) | 8 (70) | 14 (133) | 3 (30) | 14 (133) | 9 (78) | 6 (56) |

  Two of the 54 are abstention questions. 13 haystacks contain one session twice (same id and text, different date); it is stored once, at its first date.
- **Rankings from `search()`** (`src/search.ts` imported as is; RRF k=60 over the words, bigram and vector legs, then the priors):
  - **Session ranking:** `search(question, {project, before, limit: 20, perSession: 1})`, which gives one hit per session, ordered by the session's best chunk.
  - **Chunk ranking:** `search(question, {project, before, limit: 20})`, which is the default `memory_search` behaviour (at most 3 chunks per session). It feeds the turn and dialog metrics. A chunk is part of one round (a user turn plus its replies), so:
    - for LongMemEval it ranks that round's user turn;
    - for LoCoMo it ranks every dialog in it, in order.
  - **Legs:** *keyword-only* = `search(…, {semantic: false})`, i.e. the words and bigram legs plus the priors. *Semantic-only* = `search()`'s vector leg alone: HNSW cosine, the same filters, top 60.
  - A hybrid search whose 300 ms query embedding timed out is retried twice. No search ended up keyword-only.
  - Query embeddings are paced at 10/s too.

## 2. Dataset files (official sources only, downloaded 2026-10-02 into `bench/data/`)

| File | URL | Bytes | sha256 |
|---|---|---|---|
| `locomo10.json` | https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json (repo [snap-research/locomo](https://github.com/snap-research/locomo); last commit touching the file `cbfbc1d`, 2024-08-10) | 2,805,274 | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` |
| `longmemeval_s_cleaned.json` | https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json (linked from [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval); dataset revision `98d7416`) | 277,383,467 | `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` |

The LongMemEval size was checked with a HEAD request before downloading (277 MB, under the 400 MB limit). Its sha256 equals the Hub's LFS ETag. No code from either repo was executed: the evaluation code was only read, to port the metrics.

## 3. Metric definitions (exact)

**LongMemEval, official** (`src/retrieval/eval_utils.py`, `src/retrieval/run_retrieval.py`):
- *Session corpus:* one id per haystack session. Evidence sessions' ids contain `answer`. An evidence session none of whose **user** turns has `has_answer` is renamed `noans` and is not a target.
- *Turn corpus:* **user turns only**, with id `<session id>_<position in session, 1-based, assistant turns counted>`. Inside an evidence session, a user turn without `has_answer` is renamed `noans`.
- *Correct* = the corpus ids that contain `answer`.
- `recall_any@k` = 1 if any correct id is among the top-k ranked ids.
- `recall_all@k` = 1 if all of them are (vacuously 1 if there are none).
- `ndcg@k` = DCG(ranking) / DCG(ideal), where **DCG@k = rel₁ + Σᵢ₌₂..ₖ relᵢ / log₂ i**. Positions 1 and 2 both weigh 1, and the ideal ranks every relevant corpus id first.
- Averages skip abstention questions (`_abs`) and questions without a user-side `has_answer` turn: 7 of the 54, leaving **n = 47**.
- Session metrics here use the session-granularity evaluation on memory-hub's session ranking. Their recall values equal the code's `turn2session` conversion (top-k distinct sessions by best turn).

**LongMemEval, mempalace's headline** (`benchmarks/longmemeval_bench.py`, raw mode): the session ranking, `recall_any@k` against `answer_session_ids`, averaged over **every** question (abstention and single-session-assistant included). Its nDCG uses a different ideal and is not reported here.

**LoCoMo, official** (`task_eval/evaluation.py`, `recall_acc`):
- recall = (# evidence entries among the retrieved `dia_id`s) / (# evidence entries), and 1 if a question lists no evidence.
- It is averaged over all 1,986 questions, adversarial (category 5) included.
- Entries are matched literally. 9 malformed entries in 9 questions (e.g. `D8:6; D9:17`, `D:11:26`) can never match.
- `d@k`: memory-hub's chunks, in rank order, are expanded into their dialogs and cut at **k dialogs**. This is the paper's dialog-RAG setting with top-k dialogs.

**LoCoMo, mempalace** (`benchmarks/locomo_bench.py`, `--granularity session`): evidence is turned into the set of sessions (`D<n>:` at the start of each entry). `s@k` = |evidence sessions in the top-k sessions| / |evidence sessions| (1 if none parse), averaged over all 1,986. A random ranking scores 18.7% at `s@5` and 37.2% at `s@10`, because conversations have only 19–32 sessions.

All of the above is unit-tested against hand-computed cases in `test/bench-metrics.test.ts`.

## 4. Results (run 2026-10-02, bge-m3 F16 on Ollama 0.33.2, `RANK` defaults)

**LongMemEval_S, 54-question subset: mempalace definition** (session `recall_any`, all 54). A random ranking would score 18.9% at R@5 over the 500.

| Mode | R@5 | R@10 |
|---|---|---|
| **hybrid `search()`** | **100** (54/54; 95% CI 93.4–100) | **100** |
| keyword-only | 96.3 | 100 |
| semantic-only (vector leg) | 100 | 100 |

Every question type scores 100 / 100 with hybrid.

**Out-of-subset check: the 100 did not hold.** 20 more questions, `stratified(rest of the 500, 20, seed 2)`: disjoint from the 54, types 3/6/1/5/3/2 in the order of the §1 table. They were ingested into a scratch schema together with the 54 + LoCoMo (the same 35,434 chunk ids as the bench corpus, plus 12,102 new ones) and ranked the same way (scratch script `tmp/verify-benchmark/verify-subset.ts`).

| Questions | hybrid R@1 | hybrid R@5 | hybrid R@10 | keyword R@5 / R@10 |
|---|---|---|---|---|
| the 54, re-scored in the larger corpus | 98.1 | 100 | 100 | 96.3 / 100 |
| the 20 out-of-subset | 80 | **90** (18/20; CI 69.9–97.2) | 95 (19/20) | 90 / 95 |
| pooled 74 | 93.2 | **97.3** (72/74; CI 90.7–99.3) | 98.6 (73/74) | 94.6 / 98.6 |

Both misses are temporal-reasoning: `gpt4_8279ba03` (missed at 5 and at 10) and `gpt4_7f6b06db` (found at 10). The subset ids do equal `stratified(all, 54, seed 1)`, so it was not cherry-picked. 0 misses in 54 at a true rate of ~96.6% happens about 15% of the time: the 54/54 was small-sample luck.

**LongMemEval_S subset: official definitions** (n = 47; nDCG ×100):

| Mode | any@1 | any@3 | any@5 | any@10 | all@5 | all@10 | nDCG@5 | nDCG@10 |
|---|---|---|---|---|---|---|---|---|
| session: hybrid | 93.6 | 100 | 100 | 100 | 93.6 | 95.7 | 95.8 | 96.4 |
| session: keyword | 89.4 | 91.5 | 95.7 | 100 | 78.7 | 91.5 | 84.6 | 87.8 |
| session: semantic | 91.5 | 100 | 100 | 100 | 93.6 | 95.7 | 94.1 | 94.9 |
| turn: hybrid | 66.0 | 95.7 | 95.7 | 95.7 | 66.0 | 72.3 | 73.0 | 74.6 |
| turn: keyword | 57.4 | 83.0 | 87.2 | 97.9 | 57.4 | 63.8 | 66.6 | 69.2 |
| turn: semantic | 63.8 | 91.5 | 95.7 | 97.9 | 66.0 | 85.1 | 72.3 | 76.8 |

**LoCoMo, all 1,986 questions** (`s@k` = mempalace session recall, `d@k` = official `recall_acc` over k dialogs):

| Mode | s@5 | s@10 | d@5 | d@10 | d@25 |
|---|---|---|---|---|---|
| **hybrid `search()`** | **87.7** | **93.9** | **60.5** | **69.5** | **78.1** |
| keyword-only | 83.7 | 90.6 | 54.7 | 62.4 | 71.5 |
| semantic-only (vector leg) | 86.4 | 93.6 | 58.9 | 69.1 | 80.2 |

Hybrid by LoCoMo `category`. Names differ between papers, so the dataset's numbers are used:

| Category | n | s@5 | s@10 | d@5 | d@10 | d@25 |
|---|---|---|---|---|---|---|
| 1 | 282 | 60.5 | 77.9 | 27.7 | 39.6 | 53.3 |
| 2 | 321 | 88.0 | 95.8 | 65.8 | 73.3 | 81.5 |
| 3 | 96 | 61.7 | 72.8 | 27.3 | 37.8 | 46.9 |
| 4 | 841 | 95.8 | 98.8 | 68.1 | 77.4 | 84.2 |
| 5 | 446 | 95.1 | 98.0 | 70.2 | 77.6 | 86.5 |

**Latency** of `search()`, measured on the default call (limit 20, project filter, query embedding included, sequential, 35,434-chunk bench corpus): hybrid p50 **37.5 ms** / p95 **54.8 ms**; keyword-only p50 15.3 ms / p95 20.0 ms.

**Run-to-run.** A second run rebuilt the LoCoMo rows (the HNSW graph insertion order changed). LongMemEval came out identical. LoCoMo moved by at most 0.4 pt (per category) and by at most 0.1 pt overall (HNSW is approximate).

## 5. Against what other projects report (all **self-reported**, not re-run by us)

| Project, config | Dataset, metric (same definition as ours?) | They report | memory-hub |
|---|---|---|---|
| [mempalace raw](https://github.com/MemPalace/mempalace/blob/develop/benchmarks/BENCHMARKS.md): ChromaDB + all-MiniLM-L6-v2, one doc per session (user turns), no LLM | LongMemEval_S cleaned, 500 q, session `recall_any@5` / `@10` over all questions (**same**) | 96.6 (R@5; no single R@10 stated) | 97.3 / 98.6 on **74 q** (54 subset + 20 out of it; R@5 CI 90.7–99.3): level, not ahead |
| [agentmemory](https://github.com/rohitg00/agentmemory/blob/main/benchmark/LONGMEMEVAL.md) BM25 + vector (all-MiniLM-L6-v2) | same, 500 q (**same**) | 95.2 / 98.6 | 97.3 / 98.6 (74 q): level |
| agentmemory BM25-only | same (**same**) | 86.2 / 94.6 | keyword-only 94.6 / 98.6 (74 q) |
| [mempalace hybrid v5](https://github.com/MemPalace/mempalace/blob/develop/benchmarks/BENCHMARKS.md) (top-10, no rerank) | LoCoMo locomo10, 1,986 q, session recall @5 / @10 (**same**) | 83.7 / 88.9 | **87.7 / 93.9** |
| mempalace bge-large hybrid (top-10, no LLM) | same, @10 (**same**) | 92.4 | 93.9 |
| [LoCoMo paper](https://arxiv.org/abs/2402.17753), Table 3, DRAGON retriever, dialog units | LoCoMo `recall_acc` @5 / @10 / @25 dialogs (**same definition**; the paper's dataset version may differ, since v1 had 50 conversations) | 58.8 / 67.5 / 79.9 | 60.5 / 69.5 / 78.1 |

**Not comparable, and not compared:**
- mempalace's 100% figures use an LLM rerank, and its LoCoMo top-50 exceeds the 19–32 sessions per conversation. Its own doc says so.
- QA-accuracy numbers: Mastra 94.87%, Supermemory ~99%, the LongMemEval leaderboard, and LoCoMo F1/LLM-judge.
- The LongMemEval paper's retrieval tables, which use LongMemEval_M (~500 sessions per haystack).
- [mempalace issue #29](https://github.com/MemPalace/mempalace/issues/29) notes that `recall_any@5` measures retrieval, not answer correctness, and that it is the softer of the two recall metrics. Both points hold for our number too, which is why the official `recall_all` and turn-level results are reported as well.

## 6. Caveats

- **Subset.** LongMemEval is 54/500 questions (seed 1, every type present but only 3 single-session-preference questions). The full set would take ~8.5 h of embedding at 10/s (~600 chunks per question): `--lme 500`. LoCoMo is complete. The subset's 54/54 did not hold on 20 more questions (R@5 90, §4), so it is not evidence that memory-hub beats the others on LongMemEval: until the full run, quote the pooled 74 (R@5 97.3, R@10 98.6).
- **English only.** Both datasets are English, so memory-hub's Thai side is barely exercised: ICU word segmentation, the Thai/digit bigram leg, and Thai stems. The in-house eval (`scripts/eval.ts`, ลุงจืด's own Thai/English questions) is still the measure for that.
- **Retrieval only.** No answer generation and no judge. A recall of 100% does not mean an LLM answers correctly.
- **Different units.**
  - memory-hub retrieves round chunks: a user turn plus its replies, at most 1,200 chars, with *assistant text included*.
  - mempalace raw indexes whole sessions (user turns only); the LongMemEval turn index is single user turns; LoCoMo's is single dialogs. We map our ranking onto each unit (§1).
  - Including assistant text helps single-session-assistant questions in the mempalace definition. The official LongMemEval averages exclude those questions.
- **Diversity cap.** The default 3-chunks-per-session cap in `search()` limits how many dialogs one session can contribute. That is why hybrid `d@25` (78.1) is below the uncapped vector leg (80.2).
- **Not tuned on these sets.** memory-hub's `RANK` parameters were tuned on ลุงจืด's own eval set, so they are zero-shot here. mempalace says its hybrid versions were built from failure patterns on these same benchmarks, apart from its held-out LongMemEval split.
- **Dataset quirks.** The LongMemEval same-day timestamps (§1) and the 9 malformed LoCoMo evidence ids (§3) are handled as described, and both are scored literally.
- **Revisions.** Other projects may have used an earlier revision of the cleaned LongMemEval file.

## 7. Reproduce

```bash
mkdir -p bench/data   # official sources only; verify the sha256 values in §2
curl -fL -o bench/data/locomo10.json https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json
curl -fL -o bench/data/longmemeval_s_cleaned.json https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
sha256sum bench/data/*.json
npm run bench                          # = node scripts/bench.ts --lme 54 --locomo 10 --seed 1 --json bench/data/results.json
node --test test/bench-metrics.test.ts # the metric ports
```

- **First run:** ≈ 75 min. That is 35,434 chunks embedded at 10/s (~59 min), plus ingesting 2,839 sessions and ~10 min of searches.
- **Re-run:** ≈ 10 min, because the schema is the embedding cache and `bench_vec` keeps vectors of projects a smaller run dropped. The searches dominate, since query embeddings are paced at 10/s.
- **Prerequisites:** Ollama must be up with `bge-m3`. Do not run it while `scripts/eval.ts` is measuring latency.
- **Fresh start:** `DROP SCHEMA memhub_bench CASCADE` (this also drops the cache).
