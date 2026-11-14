// Canonical Project Resolver across all AI apps, vault notes, and search/save/dream paths.
// Resolves cwd, explicit file paths in text (D:\<project>\..., C:\<project>\...), git remotes, and project/repo aliases
// (ARCHIVE_ROOT/_projects.json, github/_local.json, MEMHUB_PROJECT_MAP, and Postgres state 'project:aliases') into one
// canonical project path (or _global), plus secondary related_projects when a note bridges two repos.
import { existsSync, readdirSync } from 'node:fs';
import type pg from 'pg';
import { canonicalProject, catchAll, normProject, projectMap, projectName, resolveProjectChain, sameTree } from './importer.ts';
import { isGlobalFact } from './notes.ts';

/** Compact alphanumeric key ("memory-hub" / "Memory_Hub" → "memoryhub"). */
export const slugKey = (s: string) => s.trim().toLowerCase().replace(/[-_\s]+/g, '');

// Generic folder names that also appear as everyday tech words: never infer a project from a bare word in this set
// (an explicit filesystem path like D:\present\... still matches via path extraction).
const GENERIC_NAMES = new Set([
  'app', 'api', 'ai', 'bin', 'binance', 'bot', 'build', 'claude', 'cli', 'client', 'cmd', 'code', 'codex', 'config',
  'console', 'crm', 'd', 'data', 'db', 'demo', 'dev', 'dist', 'doc', 'docs', 'docker', 'engine', 'env', 'frontend',
  'backend', 'gemini', 'git', 'github', 'global', 'google', 'hooks', 'hub', 'hubs', 'images', 'install', 'internal',
  'kimi', 'lib', 'linux', 'live', 'lmstudio', 'local', 'logs', 'main', 'mcp', 'memory', 'model', 'models', 'new',
  'newfolder', 'node', 'notes', 'obsidian', 'out', 'pkg', 'present', 'prod', 'project', 'projects', 'raw', 'renders',
  'repo', 'research', 'rule', 'rules', 'scripts', 'server', 'service', 'session', 'sessions', 'shop', 'site',
  'skills', 'sql', 'src', 'system', 'temp', 'test', 'tests', 'tmp', 'tool', 'tools', 'ui', 'user', 'users', 'vault',
  'verify', 'video', 'view', 'web', 'windows', 'work', 'worktrees', 'zcode',
]);

const SYSTEM_PATH = /^[a-z]:\/(?:\$recycle\.bin|program files[^/]*|programdata|windows|system volume information|recovery|perflogs|onedrivetemp|temp|tmp|obsidian-vault)(?:\/|$)|^[a-z]:\/users\/[^/]+\/(?:appdata|\.agents|\.claude|\.codex|\.gemini|\.zcode|\.lmstudio|\.kimi-code|\.memhub|ai-archive)(?:\/|$)/i;
const SCRATCH_PROJECT = /(?:^|\/)(?:tmp|temp|new folder(?:\s*\(\d+\))?|scratch-workspaces|cli-probe|temp-chrome-profile[^/]*)(?:\/|$)/i;
const SCRATCH_CWD = /^(?:\/tmp|[a-z]:\/(?:tmp|temp|new folder(?:\s*\(\d+\))?|scratch-workspaces(?:\/[^/]+)?|cli-probe|temp-chrome-profile[^/]*))$/i;
const CONTRAST_BEFORE = /(?:ไม่(?:ได้)?(?:เกี่ยว(?:ข้อง)?|ยุ่ง|ใช่)(?:กับ)?|ห้าม(?:ปน|นำ|อ้างอิง|แตะ|แก้)|อ้างอิง|แนวทางเดียวกับ|(?:ระบบ|โค้ด)\s*เดิม|ต้นฉบับ(?:หลัก)?(?:[^,\n]{0,25})?อยู่ที่|เป็น\s*KMS|ใช้.*เป็น\s*KMS|จากเดิม|ย้าย(?:.*?\s)?จาก|เปลี่ยน(?:.*?\s)?จาก|\b(?:not\s+related\s+to|instead\s+of|reference\s+only|moved\s+from)\b)[^,;\n]{0,45}$/i;
const CONTRAST_AFTER = /^[^,;\n]{0,30}(?:เป็น\s*KMS(?:\s*เท่านั้น)?|แทน(?:\b|$))/i;

type Catalogue = {
  at: number;
  byPath: Map<string, string>;      // normalized path -> canonical path
  byName: Map<string, string>;      // exact/compact alias or basename -> canonical path
  roots: string[];                  // known project root prefixes sorted longest-first
};

const catCache = new Map<string, Catalogue>();
export function clearResolverCache() { catCache.clear(); }

function diskProjectRoots(): string[] {
  if (process.env.MEMHUB_PROJECT_ROOTS !== undefined) {
    return process.env.MEMHUB_PROJECT_ROOTS.split(',').map((s) => s.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()).filter(Boolean);
  }
  if (process.env.MEMHUB_PG_SCHEMA) return []; // hermetic unit tests only see their own DB + explicit env
  const out: string[] = [];
  for (const drive of ['d:/', 'c:/']) {
    if (!existsSync(drive)) continue;
    try {
      for (const e of readdirSync(drive, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const p = `${drive}${e.name.toLowerCase()}`;
        if (SYSTEM_PATH.test(p) || SCRATCH_PROJECT.test(p) || e.name.startsWith('.') || e.name.startsWith('$')) continue;
        if (drive === 'c:/' && ['users', 'git', 'ao', 'ao-test-data', 'flutter', 'inetpub', 'install', 'msi', 'renders', 'scrcpy'].includes(e.name.toLowerCase()) && !existsSync(`${p}/.git`)) continue;
        out.push(p);
        if (e.name.toLowerCase() === 'code') {
          try {
            for (const sub of readdirSync(p, { withFileTypes: true })) if (sub.isDirectory() && !sub.name.startsWith('.')) out.push(`${p}/${sub.name.toLowerCase()}`);
          } catch {}
        }
      }
    } catch {}
  }
  return out;
}

async function loadCatalogue(db: pg.Pool): Promise<Catalogue> {
  const key = `${process.env.MEMHUB_PG_SCHEMA ?? ''}|${process.env.MEMHUB_PROJECT_MAP ?? ''}|${process.env.MEMHUB_PROJECT_ROOTS ?? ''}`;
  const hit = catCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit;

  const byPath = new Map<string, string>();
  const byName = new Map<string, string>();
  const counts = new Map<string, number>();

  const registerName = (name: string, target: string, force = false) => {
    const low = name.trim().toLowerCase(), comp = slugKey(low);
    if (!low || low.length < 3) return;
    if (force || (!GENERIC_NAMES.has(low) && !GENERIC_NAMES.has(comp))) {
      if (force || !byName.has(low)) byName.set(low, target);
      if (comp.length >= 3 && (force || !byName.has(comp))) byName.set(comp, target);
    }
  };

  // 1) Disk roots first (real directories on D:/ and C:/)
  for (const d of diskProjectRoots()) {
    const canon = normProject(d);
    byPath.set(d, canon);
    byPath.set(canon, canon);
  }

  // 2) DB projects (sources + facts) + state 'project:aliases'
  let dbAliases: Record<string, string> = {};
  try {
    const [pr, st] = await Promise.all([
      db.query(`
        SELECT project, sum(n)::int n FROM (
          SELECT project, count(*)::int n FROM sources WHERE coalesce(project, '') <> '' AND project NOT LIKE 'obsidian/%' AND project NOT LIKE 'github/%' AND project NOT LIKE 'google/%' GROUP BY 1
          UNION ALL
          SELECT project, count(*)::int * 3 n FROM facts WHERE coalesce(project, '') <> '' AND project NOT LIKE 'obsidian/%' AND project NOT LIKE 'github/%' GROUP BY 1
        ) x GROUP BY 1 ORDER BY 2 DESC`),
      db.query(`SELECT v FROM state WHERE k = 'project:aliases'`),
    ]);
    dbAliases = (st.rows[0]?.v as Record<string, string>) ?? {};
    for (const r of pr.rows) {
      const p = String(r.project).toLowerCase();
      if (catchAll(p) || SYSTEM_PATH.test(p) || SCRATCH_PROJECT.test(p)) continue;
      counts.set(p, Number(r.n));
      if (!byPath.has(p)) byPath.set(p, normProject(p));
    }
  } catch {}

  // 3) Explicit alias maps (file projectMap + DB state 'project:aliases' override everything)
  const rawAliases = { ...projectMap(), ...Object.fromEntries(Object.entries(dbAliases).map(([k, v]) => [k.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(), String(v).trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()])) };
  const chase = (p: string): string => {
    let cur = p, guard = 0;
    while (rawAliases[cur] && rawAliases[cur] !== cur && guard++ < 6) cur = rawAliases[cur];
    return cur;
  };
  for (const [k, v] of [...byPath.entries()]) byPath.set(k, chase(v));
  for (const [k, rawV] of Object.entries(rawAliases)) {
    const target = chase(rawV);
    if (!target) continue;
    byPath.set(target, target);
    if (k.includes('/') || /^[a-z]:/.test(k)) {
      byPath.set(k, target);
      const tail = k.split('/').at(-1) ?? '';
      if (!k.startsWith(target + '/') && tail.length >= 4 && !GENERIC_NAMES.has(tail)) registerName(tail, target, false);
    } else {
      registerName(k, target, true); // explicit bare alias ("app-old", "proj-v2", "myapp-web") always wins
    }
  }

  // 4) Register canonical project basenames (most-used project wins ties)
  const canonList = [...new Set(byPath.values())].filter((p) => !catchAll(p) && !SYSTEM_PATH.test(p) && !SCRATCH_PROJECT.test(p))
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.length - b.length);
  for (const c of canonList) registerName(projectName(c), c, false);

  const roots = [...byPath.keys()].filter((p) => /^[a-z]:\//.test(p) && !catchAll(p)).sort((a, b) => b.length - a.length);
  const out = { at: Date.now(), byPath, byName, roots };
  catCache.set(key, out);
  return out;
}

/** Match an extracted path (e.g. "d:/myapp/src/main.py") to its canonical project path, or '' if unknown/system. */
function pathToCanonical(rawPath: string, cat: Catalogue): string {
  const p = rawPath.replace(/\\/g, '/').replace(/[:.,;'"`)\]]+$/, '').replace(/\/+$/, '').toLowerCase();
  if (!/^[a-z]:\/[^/]+/.test(p) || SYSTEM_PATH.test(p) || SCRATCH_PROJECT.test(p) || catchAll(p)) return '';
  if (cat.byPath.has(p)) return cat.byPath.get(p)!;
  for (const r of cat.roots) {
    if (p === r || p.startsWith(r + '/')) return cat.byPath.get(r) ?? r;
  }
  // Fallback: top-level D:/<name> or D:/code/<name> if it exists on disk (or normalized git worktree)
  const segs = p.split('/');
  const cand = segs[1] === 'code' && segs[2] ? `${segs[0]}/code/${segs[2]}` : `${segs[0]}/${segs[1]}`;
  if (GENERIC_NAMES.has(projectName(cand)) && !existsSync(`${cand}/.git`) && !cat.byPath.has(cand)) return '';
  if (existsSync(cand)) {
    const n = normProject(cand);
    return cat.byPath.get(n) ?? n;
  }
  const bySlug = cat.byName.get(slugKey(segs[1]));
  return bySlug ?? '';
}

/** Extract project references from explicit filesystem paths in text, tagging whether each is a contrast/KMS reference. */
export function extractPathProjects(text: string, cat: Catalogue): { positive: string[]; all: string[] } {
  const cleanText = text.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, ' ');
  const positive: string[] = [], all: string[] = [];
  const re = /\b([A-Za-z]:[\\/][^\s"'`<>|*?,;()[\]{}\u0E00-\u0E7F]+)/g;
  for (const m of cleanText.matchAll(re)) {
    const canon = pathToCanonical(m[1], cat);
    if (!canon) continue;
    if (!all.includes(canon)) all.push(canon);
    const idx = m.index ?? 0;
    const before = cleanText.slice(Math.max(0, idx - 60), idx);
    const after = cleanText.slice(idx + m[0].length, idx + m[0].length + 35);
    if (!CONTRAST_BEFORE.test(before) && !CONTRAST_AFTER.test(after) && !positive.includes(canon)) positive.push(canon);
  }
  return { positive, all };
}

/** Extract explicit subject project/alias named at the head of title or first line ("โปรเจกต์ MyApp", "MyApp 2026-10-08", "proj-a: ..."). */
function extractSubjectProject(title: string, content: string, cat: Catalogue): string {
  const head = `${title}\n${content.split('\n').slice(0, 2).join('\n')}`.trim();
  const lookup = (tok: string): string => {
    const low = tok.trim().toLowerCase().replace(/^`+|`+$/g, ''), comp = slugKey(low);
    if (!low || low.length < 3 || GENERIC_NAMES.has(low) || GENERIC_NAMES.has(comp)) return '';
    return cat.byName.get(low) ?? cat.byName.get(comp) ?? '';
  };
  // 1) Explicit Thai/English project label: "โปรเจกต์ X", "กฎโปรเจกต์ X", "ในโปรเจกต์ X", "สำหรับโปรเจกต์ X"
  for (const m of head.matchAll(/(?:กฎ)?(?:ใน|ของ|สำหรับ)?โปรเจ[กค]ต์\s+[`"']?([A-Za-z0-9][\w.-]{2,39})[`"']?/gi)) {
    const hit = lookup(m[1]);
    if (hit) return hit;
  }
  // 2) Leading subject token on title or line 1: "<Name>:", "<Name> (", "<Name> 2026-...", "<Name> E3 ..."
  for (const line of [title.trim(), content.trim().split('\n')[0]?.trim() ?? '']) {
    if (!line) continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]{3,39})(?=\s*(?::|\(|—|-|\d{4}-\d\d-\d\d|[A-Z]\d\b|[\u0E00-\u0E7F]))/.exec(line);
    if (m) {
      const hit = lookup(m[1]);
      if (hit) return hit;
    }
  }
  return '';
}

/** Resolve any caller project filter/input ("MyApp", "memory-hub", "D:\\myapp\\main.py", "proj-v2", "_global")
 *  for memory_save, memory_search, and scripts. */
export async function resolveProjectInput(db: pg.Pool, input: string): Promise<{ isGlobal: boolean; vaultOnly: boolean; canonical: string; family: string[]; substr: string }> {
  const raw = input.trim();
  const low = raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!low) return { isGlobal: false, vaultOnly: false, canonical: '', family: [], substr: '' };
  if (low === '_global' || low === 'global') return { isGlobal: true, vaultOnly: false, canonical: '', family: [], substr: '' };
  if (low.startsWith('obsidian/')) return { isGlobal: false, vaultOnly: true, canonical: low, family: [low], substr: low };

  const cat = await loadCatalogue(db);
  let cand = '';
  if (/^[a-z]:\//.test(low) || low.includes('/')) {
    cand = pathToCanonical(low, cat) || await canonicalProject(db, low);
  } else {
    cand = cat.byName.get(low) ?? cat.byName.get(slugKey(low)) ?? '';
    if (!cand) {
      const norm = normProject(low);
      if (norm !== low || cat.byPath.has(norm)) cand = await canonicalProject(db, norm);
    }
  }
  if (!cand) return { isGlobal: false, vaultOnly: false, canonical: '', family: [], substr: low };
  const chain = await resolveProjectChain(db, cand, false);
  // Include any path mapped to `cand` in our catalogue (e.g. d:/myapp-old -> d:/myapp, d:/proj/sub-v2 -> d:/proj)
  const family = [...new Set([cand, ...chain, ...[...cat.byPath.entries()].filter(([, v]) => v === cand).map(([k]) => k)])]
    .filter((p) => !catchAll(p));
  return { isGlobal: false, vaultOnly: false, canonical: cand, family, substr: projectName(cand).toLowerCase() };
}

/** Canonical project + scope + relatedProjects for a fact at save, import, dream, or retroactive audit time. */
export async function inferFactProject(
  db: pg.Pool,
  content: string,
  opts: { title?: string; explicitProject?: string; cwdProject?: string; inheritedProject?: string; global?: boolean } = {},
): Promise<{ project: string; isGlobal: boolean; relatedProjects: string[] }> {
  const title = opts.title ?? '';
  if (opts.global === true) return { project: '', isGlobal: true, relatedProjects: [] };

  const cat = await loadCatalogue(db);
  const paths = extractPathProjects(`${title}\n${content}`, cat);

  if (opts.explicitProject?.trim()) {
    const res = await resolveProjectInput(db, opts.explicitProject);
    if (res.isGlobal) return { project: '', isGlobal: true, relatedProjects: [] };
    const project = res.canonical || normProject(opts.explicitProject);
    const relatedProjects = paths.positive.filter((p) => p !== project && !sameTree(p, project));
    return { project, isGlobal: !project, relatedProjects };
  }

  if (opts.global === undefined && !opts.inheritedProject && isGlobalFact(content, title)) {
    return { project: '', isGlobal: true, relatedProjects: [] };
  }

  const rawBase = opts.cwdProject || opts.inheritedProject || '';
  const normBase = rawBase.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const baseScratch = !normBase || catchAll(normBase) || SCRATCH_CWD.test(normBase);
  const cwdCanon = !baseScratch ? (pathToCanonical(rawBase, cat) || await canonicalProject(db, rawBase)) : '';

  const subjectProj = extractSubjectProject(title, content, cat);
  const firstPathProj = paths.positive[0] ?? '';

  // Did head/text explicitly name cwdCanon itself?
  const cwdName = cwdCanon ? projectName(cwdCanon).toLowerCase() : '';
  const headLow = `${title}\n${content.split('\n')[0] ?? ''}`.toLowerCase();
  const namesCwdInHead = !!cwdCanon && (paths.positive[0] === cwdCanon || (cwdName.length >= 4 && headLow.includes(cwdName)));
  const mentionsMemoryHub = /\bmem(?:ory[-_]?)?hub\b/i.test(`${title}\n${content}`);

  let project = cwdCanon;
  if (!cwdCanon) {
    project = subjectProj || firstPathProj || '';
  } else if (cwdCanon.endsWith('/memoryhub') && !mentionsMemoryHub && (subjectProj || firstPathProj)) {
    project = subjectProj || firstPathProj;
  } else if (subjectProj && subjectProj !== cwdCanon && !sameTree(subjectProj, cwdCanon) && !namesCwdInHead) {
    project = subjectProj;
  }

  if (!project) return { project: '', isGlobal: true, relatedProjects: [] };
  const relatedSet = new Set<string>();
  if (cwdCanon && cwdCanon !== project && !sameTree(cwdCanon, project) && !(cwdCanon.endsWith('/memoryhub') && !mentionsMemoryHub)) {
    relatedSet.add(cwdCanon);
  }
  for (const p of paths.positive) {
    if (p !== project && !sameTree(p, project)) relatedSet.add(p);
  }
  return { project, isGlobal: false, relatedProjects: [...relatedSet] };
}
