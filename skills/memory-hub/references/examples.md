# memory-hub: worked examples

Names, ids and content below are made up. Call syntax is generic; use your app's tool name (see apps.md).

## 1. Past decision: one search, no get
User: "ครั้งก่อนเราตัดสินใจใช้ queue ตัวไหนใน proj-a"
```
memory_search {"query": "proj-a message queue choice decision", "project": "proj-a", "limit": 4}
→ [F1a2b3c4d] 2026-09-14 23d proj-a | decision cur | src codex:1a2b3c4d#12 2026-09-14 | used 3x, last 5d
  <passage that states the choice and why>
```
Answer from the snippet and cite `[F1a2b3c4d]`, the src tag and the date. No memory_get.
Why: the snippet holds the answer; a get would add ≈1-3k tokens and bump its "used" rank for nothing.

## 2. Nothing stored: say ไม่รู้
User: "จำได้ไหมว่าเคยตั้ง Redis cluster ให้ proj-b"
```
memory_search {"query": "proj-b Redis cluster setup config", "project": "proj-b", "limit": 4}
→ ไม่รู้ (not in memory): nothing stored matches this query. Tell the user ...
  <near misses about other caches>
```
Reply "ในความจำไม่มีบันทึกเรื่องตั้ง Redis cluster ของ proj-b" and continue (ask or work it out fresh).
Why: the header means the hits are near misses. No synonym re-search, no get on near misses.

## 3. Do not call
- "เขียน regex ตรวจอีเมลใน TypeScript ให้หน่อย" → general knowledge, no call.
- The session-start block already lists `- [F5e6f7a8b] proj-a commit messages in Thai` under its rules heading and the user asks which language commit messages use → answer from it, cite the fid, no search.
- "เมื่อกี้แก้ไฟล์ไหนไปบ้าง" → it is in this conversation; your own live session is hidden from search anyway.

## 4. Skim a period: brief, get only on request
User (today 2026-10-07): "เดือนที่แล้วทำอะไรใน proj-a ไปบ้าง"
```
memory_search {"query": "proj-a work done sessions summary", "project": "proj-a",
               "since": "2026-09-01", "until": "2026-09-30", "detail": "brief", "limit": 8}
→ brief: ≈t = est. tokens of memory_get(id); ...
  [0a1b2c3d4e5f6a7b] 2026-09-22 proj-a card src claude:9f8e7d6c#3 ≈420t: <gist>
  ... (one line per hit)
```
Summarise from the lines. If the user asks to expand one item: `memory_get {"id": "0a1b2c3d4e5f6a7b", "max_chars": 2500}`.
Why: no get is expected, and brief costs ≈0.4× of full at the same limit; since/until is a hard filter, "เดือนที่แล้ว" in the query would only nudge. With since/until there is no ไม่รู้ header, so judge relevance yourself.

## 5. Timeline follow-up
After a search returned the chat hit `[a1b2c3d4e5f60718]`, the user asks: "หลังจากนั้นเราทำอะไรต่อ"
```
memory_get {"id": "a1b2c3d4e5f60718", "view": "timeline"}
→ [a1b2c3d4e5f60718] timeline: proj-a · codex · 2026-09-14 (times UTC)
  ▶ [...] 09-14 10:02 U ≈300t: <gist>
     ⇢ [F2b3c4d5e] decision ≈120t: <gist>
  same project, other sessions/apps (±7d): ...
```
Answer from the rows; memory_get text only the one row that needs detail.
On an older server that still lists memory_timeline, call `memory_timeline {"id": "a1b2c3d4e5f60718"}` instead (there `view` is ignored and returns the full text).
Why: one ≤1500-char call replaces several searches. Here `⇢` is a fact distilled in that round, not a search match.

## 6. Correction with replaces
User: "ที่จำไว้ว่า proj-a ใช้ port 8080 ผิดนะ ตอนนี้ใช้ 9090"
If the old fid is already visible (session-start block or an earlier result), skip the search.
```
memory_search {"query": "proj-a API server port", "project": "proj-a", "limit": 3}
→ [F1a2b3c4d] ... proj-a | fact cur | ... port 8080 ...
memory_save {"content": "proj-a API server listens on port 9090 (was 8080).", "kind": "fact",
             "replaces": ["F1a2b3c4d"]}
→ saved: <path> (searchable in new sessions)
  replaced (now OLD): [F1a2b3c4d]
```
If the old one was the user's own note, the reply says the new one is pending review; tell the user.
Why: without replaces both stay current, and hand-saved facts get the top ranking tier.

## 7. Remember, then mute
User: "จำไว้ ทุก project ใช้ pnpm ไม่ใช้ npm"
```
memory_save {"content": "ทุก project ใช้ pnpm แทน npm", "kind": "rule", "global": true, "title": "ใช้ pnpm"}
→ saved: <path> (searchable in new sessions)
  คล้าย [F9a8b7c6d] <similar text> — ส่ง replaces:[F9a8b7c6d] ถ้าจะแทน
```
One call. If a `คล้าย` line appears, ask the user whether it replaces that fact; do not save again on your own.
Later: "เรื่อง npm อย่าพูดถึงอีก" → `memory_save {"mute": ["F9a8b7c6d"]}` (no content). It stays searchable but leaves the session-start block.

## 8. Degraded or off
- First line `(keyword-only: embedder busy)` with relevant hits → use them. Nothing relevant → search once more (that is your 2nd search); still missing → say recall was limited. Keyword-only results never carry the ไม่รู้ header.
- `memory-hub is off for <client>: ...`, a missing tool, or an error → no retry. Tell the user once: "ตอนนี้ใช้ memory-hub ไม่ได้ จะทำต่อโดยไม่มีความจำเดิม", then continue.
