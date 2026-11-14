// Accuracy of the curated memory (ลุงจืด 2026-10-18): two current facts saying opposite things about
// one name (CONFLICT), a fact citing a local path that is gone (STALE), a pending correction of a shown fact, the project
// identity shown first at SessionStart + the project's old names (aliases), notes on raw chunks, near-duplicate & parameter-override
// saves across aliases, multi-app live "did he type this" for memory_save user_quote, and "where is X" lookups.
import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type pg from 'pg';
import { embed, toVec } from './embed.ts';
import { catchAll, LIVE_DIR, projectTree, sameTree } from './importer.ts';
import { resolveProjectInput, slugKey } from './projects.ts';
import { day } from './search.ts';
import { words } from './thai.ts';

type Row = Record<string, any>;
/** fact note text (DB first turn) → its claim: no '# title' line, no '- from:: [[…]]' link lines. */
export const claim = (t: string) => String(t ?? '').replace(/^# [^\n]*\n/, '').split('\n\n- ')[0];
export const ACTIVE = `coalesce(s.status, 'active') = 'active'`;
export const VISIBLE = (p: string) => `coalesce(s.hide_as, s.tool) <> ALL(${p}::text[]) AND NOT EXISTS (SELECT 1 FROM sources h WHERE h.session_id = ANY(f.session_ids) AND coalesce(h.hide_as, h.tool) = ANY(${p}::text[]))`;
const TEXT = `(SELECT t.text_redacted FROM turns t WHERE t.source_id = s.id ORDER BY t.seq LIMIT 1)`;

// ---- CONFLICT: one name, opposite polarity ("POS sync กับ BC AI Account" vs "myapp ไม่เกี่ยวกับ BC") ----
// A name = a capitalized word or acronym (BC, CHAMP, ObjectBox), not inside a path; generic tech/domain acronyms name nothing.
const STOP = new Set('ai api ui ux url id db sql json http https ok pr git mcp cli llm os pc ip utc sme dev the this that and for with from use it is if'.split(' '));
// exclusion of a thing ("ไม่เกี่ยวกับ BC", "ห้ามนำ CHAMP", "ไม่ต้องใช้ Gemma", "not BC"), not "ห้ามแก้ X" (do not edit repo X) or "ไม่ต้อง commit".
const CUE = /ไม่(?:ได้)?(?:เกี่ยว(?:ข้อง)?|ยุ่ง)(?:กับ)?|ไม่ใช่|ไม่(?:ต้อง)?(?:ใช้|พึ่ง)|เลิกใช้|ยกเลิก(?:การ)?(?:ใช้)?|(?:พร้อม)?ถอด(?=\s+[A-Z])|ห้าม(?:นำ|ใช้|ปน|อ้างอิง|เก็บ(?:ใน)?)?|อย่า(?!ง)|\b(?:not|never|no longer|instead of|without)\b|n't\b/gi;
const CLAUSE = /[,;!?()\n]|\.\s|\sbut\s|แต่/i;
// a clause about the past, a migration source ("ย้ายจาก Firebase"), old/legacy code, or task-local/assistant-only scope asserts nothing contradictory now.
const HIST = /เปลี่ยนชื่อ|rename|แทน|instead|เดิม|ก่อนหน้า|previous|formerly|เคย|พูดว่า|เรียกว่า|\bold\b|\blegacy\b|\bstale\b|เก่าที่(?:ไม่|พยายาม)|ปิด\s+[A-Z]\w+\s+ไปแล้ว|ย้าย(?:[^,;\n]{0,35}\s)?จาก|เปลี่ยน(?:[^,;\n]{0,35}\s)?จาก|ถอด(?:\s+\S+){0,4}\s*ออกจาก|สำหรับงาน[^,;\n]*ไม่เกี่ยว|เป็นผู้ช่วย(?:ของ|ใน)|ห้าม\s+Claude\s+ส่งงาน|ไฟล์เดิม\s+drift|ห้ามส่ง\s+batch\s+ให้|ไม่มีเงื่อนไข\s+BTC|ไม่ใช่\s+BTC\//i;
const RUN = /(?<![\w\\/.:-])[A-Z][A-Za-z0-9]+(?: [A-Z][A-Za-z0-9]*)*(?![\w-])/g;
const GLUE = /^[\s"'`(]*(?:(?:และ|หรือ|and|or|\/|&)[\s"'`(]*)?$/i;

export function polarity(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const cl of text.split(CLAUSE)) {
    if (HIST.test(cl)) continue;
    const cues = new Set([...cl.matchAll(CUE)].map((c) => c.index! + c[0].length));
    let last = -1, negEnd = -1;
    for (const m of cl.matchAll(RUN)) {
      const k = m[0].split(' ')[0].toLowerCase(), at = m.index!;
      const after = (e: number) => e >= 0 && e <= at && GLUE.test(cl.slice(e, at));
      const neg = [...cues].some((e) => e <= at && /^[\s"'`(]*$/.test(cl.slice(e, at))) || (negEnd === last && after(negEnd));
      last = at + m[0].length;
      if (neg) negEnd = last;
      if (STOP.has(k)) continue;
      const p = neg ? 'neg' : 'pos';
      out.set(k, out.has(k) && out.get(k) !== p ? 'mix' : p);
    }
  }
  return out;
}

export type FactText = { fid: string; project: string; canon?: string; related?: string[]; kind: string; text: string };
const NORM = new Set(['rule', 'feedback', 'decision', 'preference']);

const sameSubject = (a: FactText, b: FactText) => {
  const pa = a.canon || a.project, pb = b.canon || b.project;
  if (pa && pb) return sameTree(pa, pb);
  const [g, p] = pa ? [b, a] : [a, b];
  const pp = p.canon || p.project;
  if (!pp) return false;
  const names = [...new Set([...projectTree(pp), ...(p.project && p.project !== pp ? projectTree(p.project) : [])])]
    .map((d) => basename(d).toLowerCase()).filter((n) => n.length >= 4);
  const first = claim(g.text).match(/\b[a-z]:[\\/]+([\w.-]+)/i)?.[1].toLowerCase();
  return first ? names.some((n) => slugKey(n) === slugKey(first)) : names.some((n) => g.text.toLowerCase().includes(n));
};

export function conflictPairs(facts: FactText[], only?: string): { a: string; b: string; name: string }[] {
  const pol = new Map(facts.map((f) => [f.fid, polarity(claim(f.text))]));
  const byName = new Map<string, FactText[]>();
  for (const f of facts) for (const [k, p] of pol.get(f.fid)!) if (p !== 'mix') (byName.get(k) ?? byName.set(k, []).get(k)!).push(f);
  const out = new Map<string, { a: string; b: string; name: string }>();
  for (const [k, fs] of byName) {
    const neg = fs.filter((f) => pol.get(f.fid)!.get(k) === 'neg');
    for (const n of neg) for (const p of fs) {
      if (pol.get(p.fid)!.get(k) !== 'pos' || (only && n.fid !== only && p.fid !== only) || !sameSubject(n, p)) continue;
      if (!NORM.has(n.kind) && !NORM.has(p.kind)) continue;
      const [a, b] = n.fid < p.fid ? [n.fid, p.fid] : [p.fid, n.fid];
      if (!out.has(`${a} ${b}`)) out.set(`${a} ${b}`, { a, b, name: k });
    }
  }
  return [...out.values()];
}

async function expandProjectFamily(db: pg.Pool, project?: string | null): Promise<{ canon: string; family: string[]; rootPrefix: string | null }> {
  if (!project) return { canon: '', family: [], rootPrefix: null };
  const res = await resolveProjectInput(db, project);
  const canon = res.canonical || project;
  const family = [...new Set([...res.family, ...projectTree(canon), ...projectTree(project)])].filter(Boolean);
  return { canon, family, rootPrefix: canon && !catchAll(canon) ? canon : null };
}

async function factRows(db: pg.Pool, hide: string[], project?: string | null) {
  const exp = await expandProjectFamily(db, project);
  const rows = (await db.query(`SELECT f.fid, coalesce(f.project, '') project, coalesce(f.related_projects, '{}') related, f.kind, s.path,
      (SELECT count(*)::int FROM turns t WHERE t.source_id = s.id) turns, ${TEXT} text
    FROM facts f JOIN sources s ON s.id = f.source_id
    WHERE ${ACTIVE} AND f.kind <> 'card' AND ${VISIBLE('$1')}
      AND ($2::text IS NULL OR f.project = ANY($3::text[]) OR f.related_projects && $3::text[]
           OR ($4::text IS NOT NULL AND starts_with(f.project, $4::text || '/')) OR f.scope = 'global')`,
  [hide, project || null, exp.family, exp.rootPrefix])).rows;

  const canonByProj = new Map<string, string>();
  for (const p of new Set(rows.map((r) => String(r.project)).filter(Boolean))) {
    const r = await resolveProjectInput(db, p);
    canonByProj.set(p, r.canonical || p);
  }
  return rows.map((r) => {
    const proj = String(r.project);
    return {
      fid: r.fid as string,
      project: proj,
      canon: proj ? (canonByProj.get(proj) ?? proj) : '',
      related: Array.isArray(r.related) ? (r.related as string[]) : [],
      kind: String(r.kind),
      path: String(r.path ?? ''),
      turns: Number(r.turns),
      text: String(r.text ?? ''),
    };
  });
}

export async function factTexts(db: pg.Pool, hide: string[], project?: string | null): Promise<FactText[]> {
  return (await factRows(db, hide, project)).map(({ fid, project, canon, related, kind, text }) => ({ fid, project, canon, related, kind, text }));
}

// ---- STALE: a local path or executable artifact the fact cites is gone on disk ----
const ABS = /\b[A-Za-z]:[\\/][^\s"'`<>|*?,;()[\]{}\u0E00-\u0E7F]*/g;
const REL = /(?<![\w.:\\/~-])(?:[\w-][\w.-]*[\\/])+[\w-]+(?:\.[\w-]+)*\.[A-Za-z]\w{0,6}(?::\d+(?:-\d+|:\d+)?)?(?![\w/\\-]|\.[\w-])/g;
const TILDE = /(?<![\w.:\\/-])~[\\/]([\w.-]+(?:[\\/][\w.-]+)+)/g;
const ENV_HOME = /%USERPROFILE%[\\/]([^\s"'`<>|*?,;()[\]{}\u0E00-\u0E7F]+)/gi;
const PLACEHOLDER = /[*?<>|{}]|\.\.\.|\[REDACTED|\[PRIVATE\]|x\.x\.x\.x|\$\{?\w+/i;
// Clauses stating something was deleted / retired / moved away do not assert the gone path still exists.
const WENT_AWAY = /(?:ถูกลบ|ลบ(?:ออก|แล้ว|ไป|โฟลเดอร์|ไฟล์|แอป|ทิ้ง)|เลิกใช้|ถอดออก(?:\s*หมดแล้ว)?|ไม่มี\s+`?[\w.\\/-]+`?\s*(?:แล้ว|รัน|อีก)|ไม่มีแล้ว|เอา\s+`?[\w.\\/-]+`?\s*ออก|\b(?:was\s+)?(?:removed|deleted|dropped|retired|deprecated)\b|\bno\s+longer\s+exists?\b)/i;
const MOVED_FROM = /(?:ย้าย(?:[^,\n]{0,30}\s)?จาก|เปลี่ยน(?:[^,\n]{0,30}\s)?จาก|\bmoved\s+from\b)\s*[`"']?(?:[A-Za-z]:[\\/]|~[\\/]|[\w.-]+[\\/])[^\s"'`,;()]+[`"']?/gi;

const KNOWN_REPO_DIRS = new Set(['app', 'src', 'lib', 'pkg', 'cmd', 'internal', 'scripts', 'server', 'client', 'frontend', 'backend', 'console', 'web', 'engine', 'sql', 'hooks', 'skills']);
const ARTIFACT_DIRS = new Set(['dist', 'build', 'out', 'bin', 'release', 'target']);
const ARTIFACT_EXT = /\.(?:exe|msi|dll|bat|cmd|ps1|vbs|sh|py|mjs|js|ts|cs|csproj|go)$/i;
const SYSTEM_EXES = new Set([
  'msg.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'node.exe', 'python.exe', 'pythonw.exe', 'git.exe', 'ssh.exe', 'scp.exe',
  'mstsc.exe', 'taskkill.exe', 'tasklist.exe', 'explorer.exe', 'chrome.exe', 'msedge.exe', 'code.exe', 'schtasks.exe', 'sc.exe',
  'netstat.exe', 'curl.exe', 'tar.exe', 'ffmpeg.exe', 'ffprobe.exe', 'winget.exe', 'wsl.exe', 'docker.exe', 'claude.exe',
  'codex.exe', 'ngrok.exe', 'cloudflared.exe', 'dotnet.exe', 'go.exe', 'cargo.exe', 'rustc.exe', 'psql.exe', 'sqlite3.exe',
  'robocopy.exe', 'xcopy.exe', 'where.exe', 'findstr.exe', 'reg.exe', 'icacls.exe', 'mklink.exe', 'notepad.exe', 'setup.exe',
]);

const subdirs = new Map<string, string[]>();
const branchTips = new Map<string, Set<string>>();

function getSubdirs(root: string): string[] {
  if (!subdirs.has(root)) {
    try { subdirs.set(root, readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => join(root, d.name))); }
    catch { subdirs.set(root, []); }
  }
  return subdirs.get(root)!;
}

function onOtherGitBranch(root: string, relPosix: string): boolean {
  if (!existsSync(join(root, '.git'))) return false;
  if (!branchTips.has(root)) {
    const files = new Set<string>();
    try {
      const branches = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8);
      for (const b of branches) {
        const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', b], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        for (const f of tree.split('\n')) if (f) files.add(f.trim());
      }
    } catch {}
    branchTips.set(root, files);
  }
  return branchTips.get(root)!.has(relPosix);
}

function hasExeInProject(root: string, exeLow: string): boolean {
  const dirs = [root, ...getSubdirs(root)];
  for (const d of dirs) {
    try {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isFile() && e.name.toLowerCase() === exeLow) return true;
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          try { if (readdirSync(join(d, e.name)).some((f) => f.toLowerCase() === exeLow)) return true; } catch {}
        }
      }
    } catch {}
  }
  return false;
}

function hasAnyDesktopGuiApp(root: string): boolean {
  const dirs = [root, ...getSubdirs(root)];
  for (const d of dirs) {
    try {
      if (readdirSync(d).some((n) => /\.(?:exe|csproj|sln|vcxproj)$/i.test(n))) return true;
    } catch {}
  }
  return false;
}

/** "C:\Program" of "C:\Program Files\…": the path went on after a space. */
const cutAtSpace = (p: string) => {
  const i = p.search(/[^\\/]+$/), dir = p.slice(0, i), last = p.slice(i);
  try { return !!last && existsSync(dir) && readdirSync(dir).some((n) => n.startsWith(last + ' ')); } catch { return false; }
};

function resolveExistingRoot(project?: string | null): string {
  if (!project) return '';
  const p = project.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-z]:\//i.test(p) && existsSync(p)) return p;
  // Moved top-level project between C:/ and D:/ (outside hermetic unit-test schemas)
  if (!process.env.MEMHUB_PG_SCHEMA && /^[cd]:\/[\w-]{4,}$/i.test(p)) {
    const alt = `${p[0].toLowerCase() === 'd' ? 'c' : 'd'}${p.slice(1)}`;
    if (existsSync(alt)) return alt;
  }
  return '';
}

/** Paths and runnable local artifacts in `text` that no longer exist on disk (D:\, C:\Users\jatur\, or project folder). */
export function missingPaths(text: string, project?: string | null): string[] {
  const out = new Set<string>();
  const home = homedir();
  const strippedUrls = text.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, ' ').replace(MOVED_FROM, ' ');
  const activeClauses = strippedUrls.split(/\n|;| · /).filter((cl) => !WENT_AWAY.test(cl));
  if (!activeClauses.length) return [];
  const activeText = activeClauses.join('\n');

  // Expand ~/ and %USERPROFILE%\ (only when not inside hermetic test schemas unless HOME matches)
  const expanded = process.env.MEMHUB_PG_SCHEMA ? activeText : activeText
    .replace(TILDE, (_, rel: string) => join(home, rel))
    .replace(ENV_HOME, (_, rel: string) => join(home, rel));

  const lineCache = new Map<string, number | null>();
  const fileLineCount = (fp: string): number | null => {
    if (lineCache.has(fp)) return lineCache.get(fp)!;
    try {
      const st = statSync(fp);
      if (!st.isFile() || st.size > 5 * 1024 * 1024) { lineCache.set(fp, null); return null; }
      const buf = readFileSync(fp);
      if (buf.subarray(0, 512).includes(0)) { lineCache.set(fp, null); return null; }
      let n = buf.length === 0 ? 0 : 1;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
      if (buf.length > 0 && buf[buf.length - 1] === 10) n--;
      lineCache.set(fp, n);
      return n;
    } catch {
      lineCache.set(fp, null);
      return null;
    }
  };
  const splitLineRef = (tok: string): { clean: string; maxLine: number | null; span: string } => {
    const mm = /^(.*?):(\d+)(?:-(\d+)|:\d+)?$/.exec(tok);
    if (!mm) return { clean: tok, maxLine: null, span: '' };
    const a = Number(mm[2]), b = mm[3] ? Number(mm[3]) : a;
    return { clean: mm[1], maxLine: Math.max(a, b), span: mm[3] ? `${a}-${b}` : String(a) };
  };

  for (const m of expanded.match(ABS) ?? []) {
    if (PLACEHOLDER.test(m)) continue;
    const trimmed = m.replace(/\\\\+/g, '\\').replace(/[.:\\/]+$/, '');
    const { clean: p, maxLine, span } = splitLineRef(trimmed);
    if (p.length <= 3 || !existsSync(p.slice(0, 3))) continue;
    if (!existsSync(p)) {
      if (!cutAtSpace(p)) out.add(p);
    } else if (maxLine !== null) {
      const total = fileLineCount(p);
      if (total !== null && maxLine > total) out.add(`${p}:${span} (EOF=${total})`);
    }
  }

  const root = resolveExistingRoot(project);
  if (!root) return [...out];
  const sdirs = getSubdirs(root);

  for (const raw of activeText.match(REL) ?? []) {
    if (PLACEHOLDER.test(raw)) continue;
    const { clean: relClean, maxLine, span } = splitLineRef(raw.replace(/\\/g, '/'));
    const m = relClean;
    const first = m.split('/')[0], firstLow = first.toLowerCase();
    const base = [root, ...sdirs].filter((d) => existsSync(join(d, first)));
    if (base.length) {
      const existingBase = base.find((d) => existsSync(join(d, m)));
      if (!existingBase) {
        if (!onOtherGitBranch(root, m)) out.add(m);
      } else if (maxLine !== null) {
        const total = fileLineCount(join(existingBase, m));
        if (total !== null && maxLine > total) out.add(`${m}:${span} (EOF=${total})`);
      }
    } else if ((KNOWN_REPO_DIRS.has(firstLow) || (ARTIFACT_DIRS.has(firstLow) && ARTIFACT_EXT.test(m))) && !onOtherGitBranch(root, m)) {
      out.add(m);
    }
  }

  // Standalone unique file in project root/subdir with explicit line bounds (e.g. voice_agent.py:1446-1455)
  for (const bm of activeText.matchAll(/(?<![\w.:/\\-])([\w-]{3,}\.(?:py|ts|tsx|js|mjs|go|cs|rs|sql|cpp|h|java)):(\d+)(?:-(\d+))?\b/g)) {
    const fname = bm[1], a = Number(bm[2]), b = bm[3] ? Number(bm[3]) : a, maxLine = Math.max(a, b);
    const hits = [root, ...sdirs].map((d) => join(d, fname)).filter((fp) => existsSync(fp));
    if (hits.length === 1) {
      const total = fileLineCount(hits[0]);
      if (total !== null && maxLine > total) out.add(`${fname}:${bm[3] ? `${a}-${b}` : a} (EOF=${total})`);
    }
  }

  // Explicit deleted sub-folder reference like `app/` or `dist/`
  for (const dm of activeText.matchAll(/(?:`|"|'|\s|\()((?:app|dist|frontend|backend|server|console|engine)\/)(?=`|"|'|\s|\)|,|$)/g)) {
    const dirName = dm[1].slice(0, -1);
    if (![root, ...sdirs].some((d) => existsSync(join(d, dirName))) && !onOtherGitBranch(root, dirName)) out.add(dm[1]);
  }

  // Standalone project .exe artifact (e.g. BotTread.exe) that no longer exists anywhere in the project
  for (const em of activeText.matchAll(/(?:`([\w-]{3,}\.exe)`|\b([A-Z][\w-]{2,}\.exe)\b)/g)) {
    const exe = em[1] ?? em[2], exeLow = exe.toLowerCase();
    if (SYSTEM_EXES.has(exeLow) || PLACEHOLDER.test(exe)) continue;
    if (!hasExeInProject(root, exeLow)) out.add(exe);
  }

  // Windows desktop GUI launch instructions (WinSta0\Default) when the project no longer has any desktop GUI app/executable
  if (/(?:การเปิด|เปิด|รัน)\s*GUI\b[\s\S]{0,160}WinSta0\\Default/i.test(activeText) && !hasAnyDesktopGuiApp(root)) {
    out.add('GUI (WinSta0\\Default)');
  }

  return [...out];
}

export type AccuracyFlags = { pairs: { a: string; b: string; name: string; apath: string; bpath: string }[]; stale: { fid: string; path: string; paths: string[] }[] };

export async function accuracyFlags(db: pg.Pool, hide: string[]): Promise<AccuracyFlags> {
  const rows = await factRows(db, hide);
  const paths = new Map(rows.map((r) => [r.fid, r.path]));
  const stale = rows.flatMap((f) => {
    const needDisk = f.turns !== 1 || /^# [^\n]*\n# /.test(f.text) || f.text.includes('[REDACTED:') || f.text.includes('[PRIVATE]');
    const body = needDisk && f.path && existsSync(f.path)
      ? claim(readFileSync(f.path, 'utf8').replace(/^---\n[\s\S]*?\n---\n?/, '')) : claim(f.text);
    const miss = missingPaths(body, f.canon || f.project);
    return miss.length ? [{ fid: f.fid, path: f.path, paths: miss }] : [];
  });
  return { pairs: conflictPairs(rows).map((x) => ({ ...x, apath: paths.get(x.a) ?? '', bpath: paths.get(x.b) ?? '' })), stale };
}

export async function saveFlags(db: pg.Pool, f: AccuracyFlags) {
  const rows = new Map<string, Row>();
  for (const { a, b, name } of f.pairs) for (const [x, y] of [[a, b], [b, a]]) {
    const r = rows.get(`conflict:${x}`) ?? { with: [], on: [] };
    r.with.push(y); r.on.push(name); rows.set(`conflict:${x}`, r);
  }
  for (const s of f.stale) rows.set(`stale:${s.fid}`, { paths: s.paths });
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(`DELETE FROM state WHERE k LIKE 'conflict:%' OR k LIKE 'stale:%'`);
    if (rows.size) await c.query(`INSERT INTO state (k, v) SELECT * FROM jsonb_each($1::jsonb)`, [Object.fromEntries(rows)]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

export async function addConflict(db: pg.Pool, fid: string, others: [string, string][]) {
  for (const [x, y, name] of others.flatMap(([o, n]) => [[fid, o, n], [o, fid, n]]))
    await db.query(`INSERT INTO state (k, v) VALUES ($1, jsonb_build_object('with', jsonb_build_array($2::text), 'on', jsonb_build_array($3::text)))
      ON CONFLICT (k) DO UPDATE SET v = CASE WHEN state.v->'with' ? $2 THEN state.v
        ELSE jsonb_build_object('with', (state.v->'with') || to_jsonb($2::text), 'on', (state.v->'on') || to_jsonb($3::text)) END`, [`conflict:${x}`, y, name]);
}

// ---- identity + aliases ----
export type Alias = { old: string; new: string; since: string; fid?: string; match?: string };
export type Identity = { project: string; fid: string; text: string; aliases: Alias[] };

export async function identityOf(db: pg.Pool, chain: string[], hide: string[] = []): Promise<Identity | null> {
  if (!chain.length) return null;
  const rows = (await db.query(`SELECT k, v FROM state WHERE k = ANY($1)`, [chain.map((p) => `identity:${p}`)])).rows;
  const r = chain.map((p) => rows.find((x) => x.k === `identity:${p}`)).find(Boolean);
  if (!r) return null;
  const t = r.v.fid ? (await db.query(`SELECT ${TEXT} txt FROM facts f JOIN sources s ON s.id = f.source_id WHERE f.fid = $1 AND ${ACTIVE} AND ${VISIBLE('$2')}`,
    [r.v.fid, hide])).rows[0]?.txt : '';
  return { project: r.k.slice(9), fid: t ? r.v.fid : '', text: t ? claim(t) : '', aliases: r.v.aliases ?? [] };
}
export const aliasRe = (a: Alias) => new RegExp(a.match ?? a.old.split(/\s+/).slice(0, 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'i');
const aliasNote = (a: Alias) => `${a.old} ในข้อความนี้ = ${a.new} (ชื่อเก่า ก่อนเปลี่ยนชื่อทั้ง repo${a.fid ? ` ตาม [${a.fid}]` : ''} ${a.since})`;

export function notBcLine(id: Identity | null): string {
  if (!id?.text || !/ไม่(?:เกี่ยว(?:ข้อง)?กับ|ใช่)\s*(?:ระบบ\s*)?BC|\bnot\s+(?:related\s+to\s+)?BC\b/i.test(id.text)) return '';
  const ref = id.text.match(/อ้างอิง[^\n]*?([A-Za-z]:\\[\w\\.-]*\w)/)?.[1];
  return `⚠ กฎกลางส่วน BC/CHAMP (~/.agents/AGENTS.md: Identity, ข้อ 18, UI Baseline ข้อ 3) ไม่ใช้กับ project นี้${ref ? ` — อ้างอิง ${ref} แทน` : ''}`;
}

// ---- per-item warnings for search hits and SessionStart lines ----
export type Item = { key: string; fid?: string | null; turn?: string | null; project?: string | null; ts?: Date | null; text?: string };
export type Flags = { tags: string[]; lines: string[] };

export async function flagsFor(db: pg.Pool, items: Item[], hide: string[]): Promise<Map<string, Flags>> {
  const out = new Map<string, Flags>();
  if (!items.length) return out;
  const fids = [...new Set(items.map((i) => i.fid).filter(Boolean) as string[])];
  const projects = [...new Set(items.map((i) => i.project).filter(Boolean) as string[])];
  const keys = [...fids.flatMap((f) => [`conflict:${f}`, `stale:${f}`]), ...items.filter((i) => i.turn).map((i) => `note:${i.turn}`), ...projects.map((p) => `identity:${p}`)];
  const [st, fix] = await Promise.all([db.query(`SELECT k, v FROM state WHERE k = ANY($1)`, [keys]),
    db.query(`SELECT f.review_target t, f.fid FROM facts f JOIN sources s ON s.id = f.source_id
      WHERE s.status = 'pending' AND f.review_target = ANY($1) AND ${VISIBLE('$2')} ORDER BY f.fid`, [fids, hide])]);
  const state = new Map(st.rows.map((r) => [r.k as string, r.v]));
  const partners = [...new Set(fids.flatMap((f) => state.get(`conflict:${f}`)?.with ?? []))] as string[];
  const ptxt = new Map(partners.length ? (await db.query(`SELECT f.fid, f.valid_at, ${TEXT} txt FROM facts f JOIN sources s ON s.id = f.source_id
    WHERE f.fid = ANY($1) AND ${ACTIVE} AND ${VISIBLE('$2')}`, [[...partners, ...fids], hide])).rows
    .map((r) => [r.fid as string, { txt: claim(r.txt).replace(/\s+/g, ' ').trim(), at: r.valid_at as Date }]) : []);
  for (const i of items) {
    const f: Flags = { tags: [], lines: [] }, c = i.fid ? state.get(`conflict:${i.fid}`) : null;
    (c?.with ?? []).forEach((o: string, n: number) => {
      const p = ptxt.get(o);
      if (!p) return;
      const ta = ptxt.get(i.fid!)?.at ?? i.ts ?? null;
      const newer = day(p.at) === day(ta) ? 'วันเดียวกัน' : new Date(p.at) > new Date(ta ?? 0) ? 'ใหม่กว่า' : 'เก่ากว่า';
      f.tags.push(`⚠CONFLICT ↔ [${o}] (${c.on[n]}) · อันนี้ ${day(ta)} · [${o}] ${day(p.at)} ${newer}`);
      f.lines.push(`⚠ ขัดกับ [${o}] เรื่อง ${c.on[n]}: ${p.txt.slice(0, 160)}`);
    });
    const s = i.fid ? state.get(`stale:${i.fid}`) : null;
    if (s) f.tags.push(`STALE: ไม่พบ ${s.paths.slice(0, 2).join(', ')}`);
    const p = fix.rows.filter((r) => r.t === i.fid).map((r) => `[${r.fid}]`);
    if (p.length) f.tags.push(`มีฉบับแก้รออนุมัติ ${p.join(' ')}`);
    const note = i.turn ? state.get(`note:${i.turn}`) : null;
    if (note) f.lines.push(`หมายเหตุ: ${note.text}`);
    for (const a of (i.project ? state.get(`identity:${i.project}`)?.aliases ?? [] : []) as Alias[])
      if (i.ts && new Date(i.ts) < new Date(a.since) && aliasRe(a).test(i.text ?? '') && !note?.text.includes(aliasNote(a))) f.lines.push(`หมายเหตุ: ${aliasNote(a)}`);
    if (f.tags.length || f.lines.length) out.set(i.key, f);
  }
  return out;
}

// ---- near-duplicates + cross-alias parameter / proof overrides (memory_save, Claude memory import) ----
const CONST_STOP = new Set(['USER_INPUT', 'USER_REQUEST', 'SYSTEM_MESSAGE', 'UTF_8', 'PRIMARY_KEY', 'CREATE_TABLE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']);
const FILE_STOP = new Set(['index.ts', 'index.js', 'main.py', 'main.go', 'package.json', 'tsconfig.json', 'readme.md', 'claude.md', 'agents.md', 'skill.md']);

export function extractTargets(text: string): { consts: Set<string>; files: Set<string> } {
  const consts = new Set<string>(), files = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) {
    if (m[1].length >= 5 && !CONST_STOP.has(m[1])) consts.add(m[1]);
  }
  for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_-]{3,})\s*=\s*['"\d-]/g)) {
    const k = m[1].toUpperCase();
    if (k.length >= 5 && !CONST_STOP.has(k)) consts.add(k);
  }
  for (const m of text.matchAll(/(?:^|[\s`'":/\\])([\w-]{3,}\.(?:py|ts|tsx|js|mjs|go|cs|rs|sql|sh|cmd|ps1|toml|ya?ml))\b/gi)) {
    const f = m[1].toLowerCase();
    if (!FILE_STOP.has(f)) files.add(f);
  }
  return { consts, files };
}

export const hasOverrideProof = (text: string) =>
  /แทนที่|ยกเลิก(?:กติกา|กฎ|เพดาน|แนวทาง|เงื่อนไข|การใช้)?|เลิกใช้|ถอดออก|เปลี่ยน(?:กติกา|กฎ|ค่า|เงื่อนไข|จาก)|ปรับ\s+`?[A-Z0-9_]{4,}`?|\b(?:replaced?|supersede[ds]?|deprecated?|removed|dropped)\b|(?:OOS|backtest|forward\s+paper|walk-forward|replay)\b[^\n]{0,140}(?:ไม่ผ่าน|ตกหมด|พัง|ติดลบ|\b0\/\d+\b|t=[+-]?\d)/i.test(text);

export type NearFact = { fid: string; sim: number | null; txt: string; his: boolean; override: boolean; reason?: string };

export async function nearFacts(
  db: pg.Pool,
  content: string,
  project: string,
  hide: string[],
  skip: string[],
  o: { kind?: string; min?: number; n?: number; forSave?: boolean } = {},
): Promise<NearFact[]> {
  const vec = await embed([content], 1500).then((e) => toVec(e[0]), () => null);
  const exp = await expandProjectFamily(db, project);
  const rows = (await db.query(
    `SELECT f.fid, f.kind, coalesce(f.project, '') project, (f.user_owned OR f.edited) his, ${TEXT} txt,
            1 - ((SELECT c.embedding FROM chunks c WHERE c.source_id = s.id AND c.embedding IS NOT NULL ORDER BY c.seq_from, c.id LIMIT 1) <=> $5::halfvec) sim
     FROM facts f JOIN sources s ON s.id = f.source_id
     WHERE f.kind <> 'card' AND ($1::text IS NULL OR f.kind = $1)
       AND ($2::text = '' AND f.scope = 'global'
            OR ($2::text <> '' AND (f.project = ANY($6::text[]) OR f.related_projects && $6::text[] OR f.scope = 'global')))
       AND ${ACTIVE} AND f.fid <> ALL($3) AND ${VISIBLE('$4')}
     ORDER BY sim DESC NULLS LAST, f.created_at DESC LIMIT 300`,
    [o.kind ?? null, project, skip, hide, vec, exp.family],
  )).rows;

  const bag = (t: string) => new Set(words(t));
  const mine = bag(content), min = o.min ?? 0.85;
  const overlap = (t: string) => { const b = bag(t); let k = 0; for (const w of b) if (mine.has(w)) k++; return k / Math.max(1, new Set([...mine, ...b]).size); };
  const neg = (t: string) => [...polarity(t)].filter(([, p]) => p !== 'pos').map(([k]) => k), myNeg = new Set(neg(content));
  const myTargets = extractTargets(content), myProof = hasOverrideProof(content);
  const projNames = exp.family.map((p) => basename(p).toLowerCase()).filter((n) => n.length >= 4);

  const matched: NearFact[] = [];
  for (const r of rows) {
    const txt = claim(r.txt), sim = r.sim as number | null, ov = overlap(txt);
    // Global candidate only counts for a project save when it is actually about this project (or an identical universal claim)
    const inSameProject = !project || !!r.project || projNames.some((n) => txt.toLowerCase().includes(n)) || (sim ?? 0) >= min || ov >= 0.6;
    if (!inSameProject) continue;

    const isNearDup = (sim ?? 0) >= min || ov >= 0.6 || ((sim ?? 0) >= min - 0.1 && neg(txt).some((k) => myNeg.has(k)));
    let override = false, reason: string | undefined;
    if (o.forSave && project) {
      const rt = extractTargets(txt);
      const sharedConst = [...myTargets.consts].find((c) => rt.consts.has(c));
      const sharedFile = [...myTargets.files].find((f) => rt.files.has(f));
      if (sharedConst && (myProof || NORM.has(String(r.kind)) || (sim ?? 0) >= 0.55 || ov >= 0.15)) {
        override = true; reason = sharedConst;
      } else if (sharedFile && myProof && ((sim ?? 0) >= 0.58 || ov >= 0.18)) {
        override = true; reason = sharedFile;
      } else if (myProof && NORM.has(String(r.kind)) && ((sim ?? 0) >= 0.68 || ov >= 0.28)) {
        override = true; reason = 'rule-override';
      }
    }
    if (isNearDup || override) {
      matched.push({
        fid: r.fid as string,
        sim,
        his: Boolean(r.his),
        override: override && !isNearDup ? true : override,
        reason,
        txt: txt.replace(/\s+/g, ' ').trim().slice(0, 60),
      });
    }
  }
  return matched.slice(0, o.n ?? 2);
}

// ---- user_quote: did ลุงจืด type this in any AI app on this machine (within 48h)? ----
const RECENT = 48 * 3600e3, TAIL = 4 << 20;

const claudeUserText = (o: Row): string | null => {
  if (o?.type !== 'user' || o.message?.role !== 'user' || o.isMeta) return null;
  const c = o.message.content;
  return typeof c === 'string' ? c : Array.isArray(c) && !c.some((b) => b?.type === 'tool_result') ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : null;
};

const AG_STRIP = /<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|CONTEXT_SUMMARY|SYSTEM_MESSAGE)>[\s\S]*?(?:<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|CONTEXT_SUMMARY|SYSTEM_MESSAGE)>|$)/g;
const agUserText = (o: Row): string | null => {
  if (o?.type !== 'USER_INPUT' || o.status === 'CLEARED' || (o.source && o.source !== 'USER_EXPLICIT') || typeof o.content !== 'string') return null;
  const c = o.content.replace(AG_STRIP, '');
  const req = [...c.matchAll(/<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/g)].map((m) => m[1]);
  return req.length ? req.join('\n') : c;
};

const codexUserText = (o: Row): string | null => {
  if (o?.type !== 'response_item' || o.payload?.type !== 'message' || o.payload?.role !== 'user' || !Array.isArray(o.payload.content)) return null;
  return o.payload.content.filter((c: any) => c?.type === 'input_text' && typeof c.text === 'string' && !/^(?:# AGENTS\.md|<environment_context|<user_instructions|<skill>)/.test(c.text.trim()))
    .map((c: any) => c.text).join('\n');
};

const geminiUserText = (o: Row): string[] => {
  const extract = (m: any): string => {
    if (m?.type !== 'user') return '';
    const c = m.displayContent ?? m.content;
    return (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p: any) => typeof p?.text === 'string' && !p.thought).map((p: any) => p.text).join('\n') : '');
  };
  if (o?.type === 'user') return [extract(o)];
  if (Array.isArray(o?.$set?.messages)) return o.$set.messages.map(extract).filter(Boolean);
  if (Array.isArray(o?.messages)) return o.messages.map(extract).filter(Boolean);
  return [];
};

const kimiUserText = (o: Row): string | null => {
  if (o?.type !== 'context.append_message' || o.message?.role !== 'user') return null;
  const kind = o.message?.origin?.kind;
  if (kind && kind !== 'user') return null;
  return Array.isArray(o.message.content) ? o.message.content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n') : null;
};

const flat = (s: string) => s.replace(/\[([^\]]*)\]\([^)\s]*\)/g, (_, t: string) => t).replace(/\s+/g, ' ').trim();

function readTail(path: string, maxBytes = TAIL): string {
  const size = statSync(path).size;
  if (!size) return '';
  const len = Math.min(size, maxBytes), fd = openSync(path, 'r'), b = Buffer.allocUnsafe(len);
  try { readSync(fd, b, 0, len, size - len); } finally { closeSync(fd); }
  return b.toString('utf8');
}

function isCodexSubOrExecFile(path: string): boolean {
  const fd = openSync(path, 'r'), b = Buffer.allocUnsafe(16384);
  try {
    const n = readSync(fd, b, 0, b.length, 0), nl = b.subarray(0, n).indexOf(10);
    const p = nl > 0 ? JSON.parse(b.toString('utf8', 0, nl)).payload : null;
    return !!(p && (p.thread_source === 'guardian_review' || p.originator === 'codex_exec' || p.source === 'exec' || p.parent_thread_id || p.source?.subagent));
  } catch { return false; } finally { closeSync(fd); }
}

function recentFiles(root: string, maxDepth: number, accept: (path: string, name: string) => boolean, cutoff: number): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (!existsSync(d)) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) walk(p, depth + 1); }
      else if (e.isFile() && accept(p, e.name)) {
        try { const st = statSync(p); if (st.size > 0 && st.mtimeMs >= cutoff) out.push(p); } catch {}
      }
    }
  };
  walk(root, 0);
  return out;
}

/** memory_save user_quote: verifies his exact words (≥ 6 chars, whitespace/markdown-link insensitive) in any indexed main user turn
 *  from the last 48h OR any live transcript modified within 48h across Claude Code, Antigravity, Codex, Gemini CLI, Kimi, LM Studio, and ZCode. */
export async function userSaid(db: pg.Pool, quote: string, liveDir = LIVE_DIR): Promise<boolean> {
  const q = flat(quote);
  if (q.length < 6) return false;
  if ((await db.query(`SELECT 1 FROM sources s JOIN turns t ON t.source_id = s.id WHERE s.kind = 'main' AND t.role = 'user'
    AND t.ts > now() - interval '48 hours' AND left(t.text_redacted, 1) <> '['
    AND strpos(regexp_replace(regexp_replace(t.text_redacted, '\\[([^]]*)\\]\\([^)[:space:]]*\\)', '\\1', 'g'), '\\s+', ' ', 'g'), $1) > 0 LIMIT 1`, [q])).rowCount) return true;

  const cutoff = Date.now() - RECENT;
  const probe = q.split(' ').sort((a, b) => b.length - a.length)[0];
  const jsonProbe = JSON.stringify(probe).slice(1, -1);
  const hasProbe = (s: string) => s.includes(probe) || (jsonProbe !== probe && s.includes(jsonProbe));

  // 1) Claude Code (~/.claude/projects/*/*.jsonl or custom liveDir)
  for (const f of recentFiles(liveDir, 1, (_, n) => n.endsWith('.jsonl'), cutoff)) {
    for (const line of readTail(f).split('\n')) {
      if (!hasProbe(line)) continue;
      try { if (flat(claudeUserText(JSON.parse(line)) ?? '').includes(q)) return true; } catch {}
    }
  }

  // Hermetic test isolation: only scan other live AI homes when running against default LIVE_DIR outside test schemas,
  // OR when the test explicitly sets that app's home env var (e.g. MEMHUB_ANTIGRAVITY_HOME).
  const prod = liveDir === LIVE_DIR && !process.env.MEMHUB_PG_SCHEMA;
  const home = homedir();

  // 2) Google Antigravity (~/.gemini/antigravity{,-ide,-cli}/brain/<id>/.system_generated/logs/transcript{_full,}.jsonl)
  if (prod || process.env.MEMHUB_ANTIGRAVITY_HOME) {
    const agRoot = process.env.MEMHUB_ANTIGRAVITY_HOME ?? join(home, '.gemini');
    for (const app of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
      const brainDir = join(agRoot, app, 'brain');
      if (!existsSync(brainDir)) continue;
      let ids: string[] = [];
      try { ids = readdirSync(brainDir); } catch { continue; }
      for (const id of ids) {
        const logsDir = join(brainDir, id, '.system_generated', 'logs');
        for (const fn of ['transcript_full.jsonl', 'transcript.jsonl']) {
          const p = join(logsDir, fn);
          try { if (!existsSync(p) || statSync(p).mtimeMs < cutoff) continue; } catch { continue; }
          for (const line of readTail(p).split('\n')) {
            if (!line.includes('USER_INPUT') || !hasProbe(line)) continue;
            try { if (flat(agUserText(JSON.parse(line)) ?? '').includes(q)) return true; } catch {}
          }
        }
      }
    }
  }

  // 3) Codex (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
  if (prod || process.env.MEMHUB_CODEX_HOME) {
    const codexRoot = join(process.env.MEMHUB_CODEX_HOME ?? join(home, '.codex'), 'sessions');
    for (const f of recentFiles(codexRoot, 4, (_, n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), cutoff)) {
      if (isCodexSubOrExecFile(f)) continue;
      for (const line of readTail(f).split('\n')) {
        if (!hasProbe(line)) continue;
        try { if (flat(codexUserText(JSON.parse(line)) ?? '').includes(q)) return true; } catch {}
      }
    }
  }

  // 4) Gemini CLI (~/.gemini/tmp/<slug>/chats/session-*.{jsonl,json})
  if (prod || process.env.MEMHUB_GEMINI_HOME) {
    const gemRoot = join(process.env.MEMHUB_GEMINI_HOME ?? join(home, '.gemini'), 'tmp');
    for (const f of recentFiles(gemRoot, 3, (p, n) => /[\\/]chats[\\/][^\\/]+$/.test(p) && n.startsWith('session-') && (n.endsWith('.jsonl') || n.endsWith('.json')), cutoff)) {
      const raw = readTail(f);
      if (!hasProbe(raw)) continue;
      for (const line of f.endsWith('.json') ? [raw] : raw.split('\n')) {
        if (!hasProbe(line)) continue;
        try { if (geminiUserText(JSON.parse(line)).some((u) => flat(u).includes(q))) return true; } catch {}
      }
    }
  }

  // 5) Kimi Code (~/.kimi-code/sessions/*/*/agents/main/wire.jsonl)
  if (prod || process.env.KIMI_CODE_HOME) {
    const kimiRoot = join(process.env.KIMI_CODE_HOME ?? join(home, '.kimi-code'), 'sessions');
    for (const f of recentFiles(kimiRoot, 5, (p, n) => n === 'wire.jsonl' && /[\\/]agents[\\/]main[\\/]wire\.jsonl$/.test(p), cutoff)) {
      for (const line of readTail(f).split('\n')) {
        if (!hasProbe(line)) continue;
        try { if (flat(kimiUserText(JSON.parse(line)) ?? '').includes(q)) return true; } catch {}
      }
    }
  }

  // 6) LM Studio (~/.lmstudio/conversations/**/*.conversation.json)
  if (prod || process.env.MEMHUB_LMSTUDIO_HOME) {
    const lmsRoot = join(process.env.MEMHUB_LMSTUDIO_HOME ?? join(home, '.lmstudio'), 'conversations');
    for (const f of recentFiles(lmsRoot, 3, (_, n) => n.endsWith('.conversation.json'), cutoff)) {
      try {
        if (statSync(f).size > 8 << 20) continue;
        const raw = readFileSync(f, 'utf8');
        if (!hasProbe(raw)) continue;
        const j = JSON.parse(raw);
        for (const m of Array.isArray(j?.messages) ? j.messages : []) {
          const v = Array.isArray(m?.versions) ? m.versions[Number(m?.currentlySelected) || 0] : null;
          if (v?.role !== 'user' || !Array.isArray(v.content)) continue;
          const txt = v.content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n');
          if (flat(txt).includes(q)) return true;
        }
      } catch {}
    }
  }

  // 7) ZCode (~/.zcode/cli/db/db.sqlite)
  if (prod || process.env.MEMHUB_ZCODE_HOME) {
    const zcDb = join(process.env.MEMHUB_ZCODE_HOME ?? join(home, '.zcode'), 'cli', 'db', 'db.sqlite');
    const zcFresh = [zcDb, `${zcDb}-wal`].some((p) => { try { return existsSync(p) && statSync(p).mtimeMs >= cutoff; } catch { return false; } });
    if (zcFresh && existsSync(zcDb)) {
      const tmp = mkdtempSync(join(tmpdir(), 'memhub-zcode-q-'));
      try {
        const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
        for (const s of ['', '-wal', '-shm']) if (existsSync(zcDb + s)) copyFileSync(zcDb + s, join(tmp, `db.sqlite${s}`));
        const sq = new DatabaseSync(join(tmp, 'db.sqlite'), { readOnly: true });
        try {
          const rows = sq.prepare(`
            SELECT p.data pdata, m.data mdata FROM message m
            JOIN session s ON s.id = m.session_id
            JOIN part p ON p.message_id = m.id
            WHERE m.time_created >= ? AND coalesce(s.task_type, '') <> 'subagent_child'
          `).all(cutoff) as { pdata: string; mdata: string }[];
          for (const r of rows) {
            if (!hasProbe(r.pdata)) continue;
            const md = JSON.parse(r.mdata), pd = JSON.parse(r.pdata);
            if (md?.role === 'user' && !md.synthetic && pd?.type === 'text' && !pd.synthetic && typeof pd.text === 'string' && flat(pd.text).includes(q)) return true;
          }
        } finally { sq.close(); }
      } catch {} finally { rmSync(tmp, { recursive: true, force: true }); }
    }
  }

  return false;
}

// ---- "X อยู่ไหน / path X" ----
const WHERE_Q = /อยู่(?:ที่)?ไหน|ที่อยู่|ตำแหน่ง|โฟลเดอร์|folder|director(?:y|ies)|\bpath\b|\bwhere\b|\blocation\b|\brepo\b/i;
const WHERE_W = new Set('path where folder directory location repo github local machine find code source the file files'.split(' '));

export async function locations(db: pg.Pool, query: string, hide: string[]): Promise<string> {
  if (!WHERE_Q.test(query)) return '';
  const terms = [...new Set(query.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])].filter((t) => !WHERE_W.has(t)).slice(0, 4);
  const out: string[] = [];
  for (const term of terms) {
    const [chunks, gh] = await Promise.all([
      db.query(`SELECT c.text, c.ts FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.words @@ to_tsquery('simple', $1)
        AND coalesce(s.hide_as, s.tool) <> ALL($2::text[]) ORDER BY c.ts DESC NULLS LAST LIMIT 300`, [term, hide]),
      db.query(`SELECT DISTINCT substring(session_id from '^github:([\\w.-]+/[\\w.-]+)') r FROM sources WHERE tool = 'github' AND session_id ILIKE $1`, [`github:%${term}%`]),
    ]);
    const local = new Map<string, { p: string; n: number; last: Date | null }>();
    const repos = new Set<string>(gh.rows.map((r) => r.r).filter((r) => r && r.split('/')[1].toLowerCase().includes(term)));
    for (const c of chunks.rows) {
      const seen = new Set<string>();
      for (const m of String(c.text).match(ABS) ?? []) {
        const segs = m.replace(/\\\\+/g, '\\').split(/[\\/]/), i = segs.findIndex((s) => s.toLowerCase().includes(term));
        if (i < 1) continue;
        const p = segs.slice(0, i + 1).join('\\'), k = p.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        const x = local.get(k) ?? local.set(k, { p, n: 0, last: c.ts }).get(k)!;
        x.n++;
      }
      for (const m of String(c.text).matchAll(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?![\w.-])/gi)) if (m[1].split('/')[1].toLowerCase().includes(term)) repos.add(m[1]);
    }
    const top = [...local.values()].sort((a, b) => b.n - a.n).slice(0, 3);
    if (!top.length && !repos.size) continue;
    out.push(`ตำแหน่ง "${term}" (จาก tool call/GitHub ในความจำ): ` + [...top.map((x) => `${x.p} (${existsSync(x.p) ? 'มีในเครื่องนี้' : 'ไม่พบในเครื่องนี้แล้ว'}, ${x.n} chunk, ล่าสุด ${day(x.last)})`),
      ...(repos.size ? [`GitHub ${[...repos].slice(0, 3).join(', ')}`] : [])].join(' · '));
  }
  return out.join('\n');
}
