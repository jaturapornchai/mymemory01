# Google (Gmail · Docs · Sheets · Maps Timeline) — read-only, Claude only

## Objective
- **What**: memory-hub keeps a permanent, searchable copy of ลุงจืด's own Google data: Gmail threads that matter, Google Docs, Google Sheets (header rows only unless allowlisted) and the Google Maps Timeline ("ไปไอซ์แลนด์เมื่อไหร่", "ไประนองเมื่อไหร่").
- **Why**: Claude can then answer "what did X write about the quote", "where is the budget sheet" or "when was I in Ranong" from `memory_search` without opening Gmail/Drive and without any live connector.
- **Rules (ลุงจืด 2026-10-03)**:
  - Read only. The scopes are `gmail.readonly` + `drive.readonly`, so Google itself refuses every write.
  - Visible to Claude only: never to Codex / Gemini / Antigravity / ZCode / LM Studio / any other MCP client, never through SessionStart, never dreamed.
  - Public brain shows counts only, under the app label "Google".

## Workflow
```
Gmail / Drive / Sheets API (GET only) ──hourly `sync`──▶ ~/ai-archive/raw/google/        (append-only; a rewrite keeps a .bak)
   gmail/<yyyy>/<threadId>.json · docs/<fileId>.json · sheets/<fileId>.json · _state.json
Timeline.json (phone export) ──hourly `sync`──▶ ~/ai-archive/raw/google-timeline/exports/ + timeline.json
                                         │ parse → clean() (strip <private>, secrets, OTP/card/ID/bank numbers) → chunks → bge-m3
                                         ▼
                 Postgres sources.tool = 'google' | 'google-timeline', kind 'doc'  (searchable, never dreamed)
                                         ▼
       MCP memory_search/get/related/timeline: shown only when guard.privateOk(client) (a Claude app on Anthropic's API)
```
### Gmail (`src/tools/google.ts`, tool `google`)
- **Which mail**: one query: `(is:starred OR is:important OR in:sent) -category:promotions -category:social -label:no-memory -subject:(OTP OR "verification code" OR "รหัส OTP" OR "reset your password" OR "รีเซ็ตรหัสผ่าน" OR "sign-in code" OR "login code" OR "security code" OR "confirmation code" OR "access code" OR "รหัสยืนยัน" OR "รหัสเข้าสู่ระบบ")`.
  - The importer applies the same rules again to every message it fetches, plus it drops spam, trash and drafts.
- **Hourly run**: threads with mail since the last good run (minus 2 days), then `threads.get` for each of them. An unchanged thread leaves its file untouched.
- **First run, backfill and weekly full pass**: every matching thread that is not archived yet, newest first, at most 1500 threads per run (the next hour continues).
  - Old mail that he stars later arrives with the weekly pass, or sooner with `sync --google-full`.
- **What is archived**: the API's thread JSON minus `historyId`, `UNREAD`, attachment ids and attachment bodies. Attachments are kept as name + size only.
- **Index**: 1 thread = session `gmail:<threadId>` (project `google/gmail`).
  - 1 mail = 1 turn: `[mail] Subject\nFrom → To, Cc\nbody\n[แนบ: quote.pdf 123 KB]`.
  - Mail he sent = role user, everyone else's = assistant.
  - The body is the text/plain part, or HTML turned into text. Charsets are decoded (TIS-620 / windows-874).
  - Quoted history (`>` lines, "On … wrote:", "เมื่อ … เขียนว่า:", "Original Message") is cut. Each mail is capped at 20k characters.
### Docs and Sheets
- **Which files**: Docs and Sheets he owns, plus shared ones he opened in the last 12 months. A file name containing `no-memory` opts that file out.
  - Uploaded PDF/DOCX files and shared drives are not included.
- **Hourly run**: files modified since the last good run (minus 1 h). A weekly full list also catches shared files he opened recently and changes to the allowlist.
- **Docs**: exported as markdown (Drive's export limit is 10 MB; a bigger file is skipped and counted).
  - Indexed as session `gdoc:<fileId>`: one turn, capped at 200k characters, with images replaced by `[image]` / `[data-url]`.
- **Sheets**: by default only the title, the tab names, each tab's size and its header row are archived.
  - Sheets listed in `sheets-allow.txt` keep their full values (≤ 2000 rows per tab) as formatted strings, so money stays `"1,234.50"` and never becomes a float.
  - Indexed as session `gsheet:<fileId>`.
- **Rate limits**: Gmail ≈ 2 requests/s, Sheets 1 request/s. A 429 or 403 `rateLimitExceeded` (or a 5xx) is retried after 1, 2, 4 and 8 s, then the run stops and the next hour resumes.
### Maps Timeline (`src/tools/google-timeline.ts`, tool `google-timeline`)
- **Input**: the on-device Timeline export (iOS format: a JSON array of visit / activity segments). Put it in `~/ai-archive/inbox/google-timeline/*.json` or list it in `MEMHUB_TIMELINE_FILES`.
  - The original file is only read, never moved or changed. The raw archive keeps an exact copy.
- **Place names**: the export has no names, so they are looked up offline with GeoNames (`TH.txt`, `cities500.txt`, admin codes in `~/ai-archive/ref/geonames/`). This gives country / province / district in Thai and English.
  - No coordinate or place id is ever sent anywhere.
- **Index**: one session `google-timeline` (project `google/timeline`): an index of places, one turn per place with every trip's dates, then per month a summary, its trips (`ทริป ไอซ์แลนด์ (Iceland) …`) and its days.
  - Home, and anything within 200 m of it, is written as `บ้าน` with no area.
  - The indexed text holds no coordinates and no place ids.

## Config
| What | Where / default |
|---|---|
| Credentials dir | `%USERPROFILE%\.memory-hub\google\` (env `MEMHUB_GOOGLE_DIR`) — outside the repo and outside `ai-archive` |
| OAuth client | exactly one `client_secret*.json` (Desktop app) in that dir. ลุงจืด downloads it; it is read in place, never copied |
| Refresh token | `token.dpapi` in that dir, encrypted with Windows DPAPI (CurrentUser). Access tokens live only in memory and are never logged |
| Sheets allowlist | `sheets-allow.txt` in that dir: one Sheets URL or id per line, `#` comments |
| Full pass now | `node src/cli.ts sync --google-full` (env `MEMHUB_GOOGLE_FULL=1`) |
| Timeline files | `~/ai-archive/inbox/google-timeline/*.json`, plus `MEMHUB_TIMELINE_FILES` (`;`-separated paths) |
| GeoNames dir | `~/ai-archive/ref/geonames/` (env `MEMHUB_GEONAMES_DIR`) |
| Visibility | `src/guard.ts` `PRIVATE_TOOLS = {'google','google-timeline'}`, `privateOk(client, env)`. `MEMHUB_PRIVATE_SOURCES=0` hides them from every client |
| Tests | `MEMHUB_GOOGLE_FAKE=<fixture.json>`: recorded responses instead of the network (`test/tool-google.test.ts`) |

## Dependency
- **Network**: Google APIs over HTTPS: `gmail.googleapis.com`, `www.googleapis.com` (Drive), `sheets.googleapis.com` (GET only); `oauth2.googleapis.com` (token / revoke POST); `accounts.google.com` (consent page in the browser).
- **Local tools**: `powershell` for DPAPI and `rundll32` to open the browser. No npm dependency was added: the code uses only `fetch`, `node:http` and `node:crypto`.
- **Place names**: GeoNames dumps, © GeoNames (geonames.org), licensed CC-BY 4.0, downloaded once.
- **Rest of memory-hub (unchanged)**: Postgres (index), Ollama bge-m3 (embeddings).

## Usage example
### One-time setup (ลุงจืด ทำเอง — คลิกตามนี้)
0. ทำหลังโค้ดเสร็จแล้ว. login ด้วย Gmail บัญชีที่จะดึงข้อมูล (console ภาษาไทย ปุ่มเป็นไทยแต่ลำดับเหมือนกัน)
1. **สร้าง project**: https://console.cloud.google.com/projectcreate → Project name `memory-hub` → Location: No organization → Create → เลือก project memory-hub ที่แถบบน
2. **เปิด API 3 ตัว** (project memory-hub ถูกเลือกอยู่) แต่ละตัวกด Enable:
   - https://console.cloud.google.com/apis/library/gmail.googleapis.com
   - https://console.cloud.google.com/apis/library/drive.googleapis.com
   - https://console.cloud.google.com/apis/library/sheets.googleapis.com
   - ไม่ต้องเปิด Docs API
3. **ตั้ง consent screen**: https://console.cloud.google.com/auth/overview → Get started
   - App name `memory-hub`, User support email = Gmail ของลุงจืด → Next
   - Audience: External → Next
   - Contact: Gmail ของลุงจืด → Next
   - ติ๊ก User Data Policy → Continue → Create
4. **ประกาศ scope**: เมนูซ้าย Data Access → Add or Remove Scopes → Manually add scopes → วาง 2 บรรทัดนี้ → Add to table → Update → Save. **ห้ามเพิ่ม scope อื่น** เพราะโปรแกรมจะปฏิเสธ token ที่มี scope เกิน
   ```
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/drive.readonly
   ```
5. **Publish**: เมนูซ้าย Audience → Publish app → Confirm (สถานะเป็น In production)
   - ถ้าขึ้น "Needs verification" ให้เพิกเฉย (ใช้คนเดียว เข้าข้อยกเว้น personal use)
   - ไม่ต้องเพิ่ม Test users
   - ถ้าค้างอยู่ที่ Testing, refresh token จะหมดอายุทุก 7 วัน
6. **สร้าง OAuth client**: https://console.cloud.google.com/auth/clients → Create client → Application type **Desktop app** → Name `memory-hub-local` → Create
   - กด **Download JSON ทันที** เพราะ secret แสดงครั้งเดียว ถ้าปิดไปแล้วต้องกด Add Secret ใหม่
7. **วางไฟล์**: สร้างโฟลเดอร์ `%USERPROFILE%\.memory-hub\google\` แล้วย้ายไฟล์ `client_secret_….apps.googleusercontent.com.json` ไปไว้ในนั้น (ชื่อเดิม ให้มีไฟล์เดียว) → ลบสำเนาใน Downloads
   - ห้ามวางใน `D:\memoryhub` หรือโฟลเดอร์ที่ sync ขึ้น cloud
8. **Login ครั้งเดียว**: เปิด terminal ปกติ (นอกแอป AI) แล้วรัน 2 คำสั่งนี้:
   ```
   cd /d D:\memoryhub
   node src\cli.ts google login
   ```
   - browser เปิดเอง (ถ้าไม่เปิด ให้ copy URL ที่พิมพ์ออกมา) → เลือกบัญชี
   - หน้า "Google hasn't verified this app" → Advanced → Go to memory-hub (unsafe)
   - ติ๊กอนุญาตทั้ง 2 ข้อ → Continue → เห็น "เสร็จแล้ว ปิดแท็บได้"
   - terminal ต้องขึ้น `logged in, scopes: gmail.readonly + drive.readonly`
9. **ตรวจก่อนดึงจริง**: `node src\cli.ts google status --dry` แสดงจำนวนเมล / Docs / Sheets โดยประมาณ
   - ถ้าโอเค ให้รอรอบ hourly หรือรัน `node src\cli.ts sync`
   - เธรดที่ไม่อยากให้จำ: ติด label `no-memory` ใน Gmail
   - ไฟล์ Drive ที่ไม่อยากให้จำ: ใส่คำ `no-memory` ในชื่อไฟล์
   - Sheets ที่ยอมให้เก็บเนื้อหาเต็ม: ใส่ URL ทีละบรรทัดใน `%USERPROFILE%\.memory-hub\google\sheets-allow.txt` แล้วรัน `node src\cli.ts sync --google-full` (หรือรอรอบรายสัปดาห์)
10. **ทดสอบ token วันที่ 8**: หลัง login 8 วัน รัน `node src\cli.ts google status --dry` ต้องยังแสดงจำนวนได้
    - ถ้าขึ้น "token expired or revoked: login again" แปลว่า token ยังหมดใน 7 วัน → บอก Claude
    - เปลี่ยนรหัสผ่าน Gmail เมื่อไร ต้องทำข้อ 8 ใหม่
11. **ยกเลิกสิทธิ์** (เมื่อไรก็ได้) ทำวิธีใดวิธีหนึ่ง:
    - `node src\cli.ts google revoke`
    - https://myaccount.google.com/linkedapps → memory-hub → Remove access
    - ตัดทั้งหมด: https://console.cloud.google.com/iam-admin/settings → Shut down

### Day to day
```
node src/cli.ts google status            # setup, token (DPAPI), archive counts, last good runs
node src/cli.ts google status --dry      # + live estimate: matching mails, Docs/Sheets in scope (read-only calls)
node src/cli.ts sync                     # what the hourly job runs (Google is part of it)
node src/cli.ts sync --google-full       # every matching thread/file now (old mail starred later, allowlist changes)
node src/cli.ts forget --session gmail:<threadId>   # drop one imported thread from the index for good
node src/cli.ts google revoke            # revoke at Google + delete token.dpapi
```
In Claude, `memory_search "ใบเสนอราคา"` hits show as `Gmail` / `Google Docs` / `Google Sheets`. `memory_search "ไประนองเมื่อไหร่"` hits show as `Google Maps timeline`.

## Limitation
- **The Claude-only gate covers MCP and SessionStart only.** The data sits in plaintext in `~/ai-archive/raw/google*` and in Postgres.
  - Any AI with a shell on this PC can read it directly.
  - Exclude `raw/google*` from any cloud backup of `ai-archive`.
- **Wording that enters memory through Claude**: if Claude `memory_save`s mail wording into a note, that note becomes visible to every app.
  - A Claude Code chat that memory-hub showed a Claude-only hit (its id in a memory_search / get / timeline / related call) is Claude-only too: answers, `/compact` summaries, Agent results and its subagents (`sources.hide_as`, set at import, never cleared).
  - A chat that got the data any other way (pasted, a script's output, another app's chat) is not.
- **Deleted in Google ≠ forgotten.** Mail or files deleted in Google stay in the archive and the index (permanent memory). Use `forget --session`.
  - A `no-memory` label added after import stops future imports only.
- **Old mail starred later** waits for the weekly full pass (or `sync --google-full`). A shared file he opens without anyone editing it also waits for the weekly pass.
- **Token lifetime**: the token dies when the Gmail password changes, after 6 months unused, or with more than 100 tokens per client.
  - The hourly log then shows `skipped: token expired or revoked`.
  - Whether an unverified "In production" app keeps its token past 7 days is still to be confirmed on day 8.
- **Gmail query**: the Thai `-subject:(…)` part of the query is not verified against Gmail.
  - The importer applies the same subject filter itself, so OTP / reset mails never land even if the query lets them through.
- **Not imported**: Google Photos (by decision); uploaded PDF/DOCX files, shared drives and attachments' contents.
- **Size limits**: Docs over 10 MB (export limit) are skipped. Sheets keep at most 2000 rows per tab.
- **Timeline**: depends on ลุงจืด exporting from the phone. Place names are only as good as GeoNames: the nearest town or district, not shop or street names.
