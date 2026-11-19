// Retroactive all-projects audit & cleanup across MEMORY_VAULT and PostgreSQL.
// Modes:
//   npx tsx scripts/audit-all-projects.ts --dry-run   (default: read-only report by project)
//   npx tsx scripts/audit-all-projects.ts --apply     (normalizes vault + DB, closes superseded invalid_at, restores rule/decision kind, clears stuck review_target, resolves obsolete conflicts, re-indexes, rebuilds hubs)
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { connect } from '../src/db.ts';
import { clearProjectCache, projectMap } from '../src/importer.ts';
import { refreshTermDf } from '../src/search.ts';
import { clearResolverCache, inferFactProject } from '../src/projects.ts';
import { fileName, isEdited, isGlobalFact, md5, MEMORY_VAULT, noteUuid, parseNote, projectSlug, writeNote } from '../src/notes.ts';
import { indexVault, resolveLinks } from '../src/obsidian.ts';
import { accuracyFlags, conflictPairs, missingPaths, polarity, saveFlags } from '../src/accuracy.ts';
import { consolidate } from '../src/dream.ts';
import { backfill } from '../src/embed.ts';
import { rebuildSynapses } from '../src/synapse.ts';
import { commitBatch } from '../src/vault-git.ts';

const apply = process.argv.includes('--apply');

type AuditConfig = {
  activateKeepTarget?: string[];
  supersedePendingTo?: Record<string, string>;
  explicitSupersedes?: Record<string, string>;
  keepGlobalFids?: string[];
  forceProjectByFid?: Record<string, { project: string; related?: string[] }>;
};

type VaultFact = {
  fid: string;
  rel: string;
  abs: string;
  title: string;
  fm: Record<string, any>;
  body: string;
  coreText: string;
  edited: boolean;
};

function walkMd(dir: string, base = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(full, rel));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

function extractCoreText(body: string): { title: string; core: string } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  const coreLines: string[] = [];
  for (const l of lines) {
    const m = /^#\s+F[0-9a-f]{7,8}\s+(.*)$/i.exec(l.trim());
    if (m && !title) { title = m[1].trim(); continue; }
    if (/^-\s+[a-z][a-z0-9_]*::\s+\[\[/i.test(l.trim())) continue;
    coreLines.push(l);
  }
  return { title, core: coreLines.join('\n').trim() };
}

function loadVaultFacts(): Map<string, VaultFact> {
  const map = new Map<string, VaultFact>();
  for (const sub of walkMd(join(MEMORY_VAULT, 'facts'), 'facts')) {
    const abs = join(MEMORY_VAULT, sub);
    const raw = readFileSync(abs, 'utf8');
    const { fm, body } = parseNote(raw);
    if (fm.memhub !== 'fact' || !fm.id || !String(fm.id).startsWith('F')) continue;
    const { title, core } = extractCoreText(body);
    map.set(String(fm.id), {
      fid: String(fm.id),
      rel: sub.replace(/\\/g, '/'),
      abs,
      title,
      fm,
      body,
      coreText: core,
      edited: isEdited(fm, body),
    });
  }
  return map;
}

type ProjectStats = {
  active: number;
  pending: number;
  superseded: number;
  stale: number;
  conflicts: number;
  movedIn: number;
  movedOut: number;
  newlyActivated: number;
  newlySuperseded: number;
  kindRestored: number;
  closedInvalidAt: number;
  clearedReview: number;
};

const blankStats = (): ProjectStats => ({
  active: 0, pending: 0, superseded: 0, stale: 0, conflicts: 0,
  movedIn: 0, movedOut: 0, newlyActivated: 0, newlySuperseded: 0,
  kindRestored: 0, closedInvalidAt: 0, clearedReview: 0,
});

type PlannedEdit = {
  fid: string;
  oldProject: string;
  newProject: string;
  newScope: 'global' | 'project';
  relatedProjects: string[];
  oldKind: string;
  newKind: string;
  oldStatus: string;
  newStatus: string;
  newSupersededBy: string;
  newReviewTarget: string;
  newInvalidAt: string;
  reasons: string[];
};

function ensurePlan(plan: Map<string, PlannedEdit>, n: VaultFact): PlannedEdit {
  let cur = plan.get(n.fid);
  if (!cur) {
    const oldProject = String(n.fm.project ?? '');
    cur = {
      fid: n.fid,
      oldProject,
      newProject: oldProject,
      newScope: oldProject ? 'project' : 'global',
      relatedProjects: Array.isArray(n.fm.related_projects) ? [...n.fm.related_projects].filter(Boolean) : [],
      oldKind: String(n.fm.kind ?? 'fact') || 'fact',
      newKind: String(n.fm.kind ?? 'fact') || 'fact',
      oldStatus: String(n.fm.status ?? 'active') || 'active',
      newStatus: String(n.fm.status ?? 'active') || 'active',
      newSupersededBy: String(n.fm.superseded_by ?? ''),
      newReviewTarget: String(n.fm.review_target ?? ''),
      newInvalidAt: String(n.fm.invalid_at ?? ''),
      reasons: [],
    };
    plan.set(n.fid, cur);
  }
  return cur;
}

async function main() {
  const db = connect('rw');
  try {
    console.log(`\n=== MEMORY-HUB ALL-PROJECTS AUDIT (${apply ? 'APPLY MODE' : 'DRY-RUN MODE'}) ===`);
    console.log(`Vault: ${MEMORY_VAULT}`);

    const [alRes, cfgRes, conflictStateRes] = await Promise.all([
      db.query(`SELECT v FROM state WHERE k = 'project:aliases'`),
      db.query(`SELECT v FROM state WHERE k = 'audit:config'`),
      db.query(`SELECT k, v FROM state WHERE k LIKE 'conflict:%'`),
    ]);

    const dbAliases = ((alRes.rows[0]?.v as Record<string, string>) ?? {});
    const canonicalAliases: Record<string, string> = {
      ...projectMap(),
      ...Object.fromEntries(Object.entries(dbAliases).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()])),
    };
    const cfg = ((cfgRes.rows[0]?.v as AuditConfig) ?? {});
    const activateKeepTarget = new Set(cfg.activateKeepTarget ?? []);
    const supersedePendingTo: Record<string, string> = { ...(cfg.supersedePendingTo ?? {}) };
    const explicitSupersedes: Record<string, string> = { ...(cfg.explicitSupersedes ?? {}) };
    const keepGlobalFids = new Set(cfg.keepGlobalFids ?? []);
    const forceProjectByFid = cfg.forceProjectByFid ?? {};

    clearProjectCache();
    clearResolverCache();

    const conflictCountByFid = new Map<string, number>();
    for (const r of conflictStateRes.rows) {
      const fid = String(r.k).slice('conflict:'.length);
      const arr = Array.isArray(r.v?.with) ? r.v.with : Array.isArray(r.v) ? r.v : [];
      if (arr.length) conflictCountByFid.set(fid, arr.length);
    }

    const notes = loadVaultFacts();
    const byProject = new Map<string, ProjectStats>();
    const statFor = (p: string) => {
      const key = p || '_global';
      if (!byProject.has(key)) byProject.set(key, blankStats());
      return byProject.get(key)!;
    };

    for (const n of notes.values()) {
      const p = String(n.fm.project ?? '') || '_global';
      const st = statFor(p);
      const status = String(n.fm.status ?? 'active');
      if (status === 'active') st.active++;
      else if (status === 'pending') st.pending++;
      else st.superseded++;
      if (conflictCountByFid.has(n.fid)) st.conflicts += conflictCountByFid.get(n.fid)!;
      if (status === 'active') {
        const miss = missingPaths(`${n.title}\n${n.coreText}`, n.fm.project ? String(n.fm.project) : null);
        if (miss.length) st.stale++;
      }
    }

    const plan = new Map<string, PlannedEdit>();

    // Pass 1: Canonical project normalization, shared external entity related_projects, pending & stuck review_target cleanup
    for (const n of notes.values()) {
      if (n.edited) continue;
      const oldProject = String(n.fm.project ?? '');
      const oldStatus = String(n.fm.status ?? 'active');
      const oldRev = String(n.fm.review_target ?? '');
      const prevRel = Array.isArray(n.fm.related_projects) ? [...n.fm.related_projects].filter(Boolean) : [];

      let newProject = oldProject;
      let newScope: 'global' | 'project' = oldProject ? 'project' : 'global';
      let relatedProjects = [...prevRel];
      let newStatus = oldStatus;
      let newSup = String(n.fm.superseded_by ?? '');
      let newRev = oldRev;
      const reasons: string[] = [];

      const forced = forceProjectByFid[n.fid];
      const keepGlobal = keepGlobalFids.has(n.fid) || (!oldProject && isGlobalFact(n.coreText, n.title));
      if (keepGlobal) {
        if (oldProject) {
          newProject = '';
          newScope = 'global';
          relatedProjects = [];
          reasons.push(`project:${oldProject}->_global`);
        }
      } else if (forced) {
        if (forced.project !== oldProject) {
          newProject = forced.project;
          newScope = forced.project ? 'project' : 'global';
          reasons.push(`project:${oldProject || '_global'}->${newProject || '_global'}`);
        }
        const mergedRel = [...new Set([...relatedProjects, ...(forced.related ?? [])])].filter((rp) => rp && rp !== newProject);
        if (JSON.stringify(mergedRel) !== JSON.stringify(prevRel)) {
          relatedProjects = mergedRel;
          reasons.push(`related:[${relatedProjects.join(',')}]`);
        }
      } else {
        const directAlias = oldProject ? canonicalAliases[oldProject.toLowerCase()] : undefined;
        const inferred = await inferFactProject(db, n.coreText, {
          title: n.title,
          cwdProject: directAlias ?? (oldProject || undefined),
        });
        const targetProj = inferred.isGlobal ? (directAlias ?? '') : inferred.project;
        const oldIsScratch = /^(?:\/tmp|[a-z]:\/(?:tmp|temp|new folder)|.*\/(?:scratch-workspaces|cli-probe)(?:\/|$))/i.test(oldProject);
        if (oldProject && targetProj && targetProj !== oldProject) {
          newProject = targetProj;
          newScope = 'project';
          reasons.push(`project:${oldProject}->${newProject}`);
        } else if (oldProject && oldIsScratch && !targetProj) {
          newProject = '';
          newScope = 'global';
          reasons.push(`project:${oldProject}->_global`);
        } else if (!oldProject && targetProj) {
          newProject = targetProj;
          newScope = 'project';
          reasons.push(`project:_global->${newProject}`);
        }
        const mergedRel = [...new Set([...relatedProjects, ...inferred.relatedProjects])]
          .filter((rp) => rp && rp !== newProject);
        if (JSON.stringify(mergedRel) !== JSON.stringify(prevRel)) {
          relatedProjects = mergedRel;
          reasons.push(`related:[${relatedProjects.join(',')}]`);
        }
      }

      if (oldStatus === 'pending') {
        if (supersedePendingTo[n.fid] && notes.has(supersedePendingTo[n.fid])) {
          newStatus = 'superseded';
          newSup = supersedePendingTo[n.fid];
          newRev = '';
          reasons.push(`pending->superseded_by:${newSup}`);
        } else if (activateKeepTarget.has(n.fid)) {
          newStatus = 'active';
          newRev = '';
          reasons.push(`pending->active(keep ${oldRev})`);
        } else {
          newStatus = 'active';
          newRev = '';
          reasons.push(`pending->active${oldRev ? `(supersedes ${oldRev})` : ''}`);
          if (oldRev && notes.has(oldRev) && !notes.get(oldRev)!.edited) {
            explicitSupersedes[oldRev] = n.fid;
          }
        }
      } else if (oldRev) {
        newRev = '';
        reasons.push(`clear_review_target:${oldRev}`);
      }

      if (reasons.length) {
        const e = ensurePlan(plan, n);
        e.newProject = newProject;
        e.newScope = newScope;
        e.relatedProjects = relatedProjects;
        e.newStatus = newStatus;
        e.newSupersededBy = newSup;
        e.newReviewTarget = newRev;
        e.reasons.push(...reasons);
      }
    }

    // Pass 2: Explicit supersedes from config / approved pending notes
    for (const [oldFid, byFid] of Object.entries(explicitSupersedes)) {
      const n = notes.get(oldFid);
      if (!n || n.edited || !notes.has(byFid)) continue;
      const curStatus = plan.get(oldFid)?.newStatus ?? String(n.fm.status ?? 'active');
      const curSup = plan.get(oldFid)?.newSupersededBy ?? String(n.fm.superseded_by ?? '');
      if (curStatus === 'superseded' && curSup === byFid) continue;
      const e = ensurePlan(plan, n);
      e.newStatus = 'superseded';
      e.newSupersededBy = byFid;
      e.newReviewTarget = '';
      e.reasons.push(`superseded_by:${byFid}`);
    }

    // Pass 3: Exact normalized core-text duplicates within same canonical project -> keep newer/user-saved, supersede older unedited
    const byNormBody = new Map<string, VaultFact[]>();
    for (const n of notes.values()) {
      const eff = plan.get(n.fid);
      const st = eff ? eff.newStatus : String(n.fm.status ?? 'active');
      if (st !== 'active') continue;
      const proj = eff ? eff.newProject : String(n.fm.project ?? '');
      const key = `${proj || '_global'}||${md5(n.coreText)}`;
      if (!byNormBody.has(key)) byNormBody.set(key, []);
      byNormBody.get(key)!.push(n);
    }
    for (const group of byNormBody.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => {
        const aHand = a.fm.run ? 0 : 1, bHand = b.fm.run ? 0 : 1;
        if (aHand !== bHand) return bHand - aHand;
        return String(b.fm.valid_at ?? '').localeCompare(String(a.fm.valid_at ?? ''));
      });
      const winner = group[0];
      for (const dup of group.slice(1)) {
        if (dup.edited) continue;
        const e = ensurePlan(plan, dup);
        e.newStatus = 'superseded';
        e.newSupersededBy = winner.fid;
        e.newReviewTarget = '';
        e.reasons.push(`exact_dup_of:${winner.fid}`);
      }
    }

    // Pass 4: Retire unedited machine-dreamed notes contradicted by a newer permanent retirement decision/rule in the same project
    const activeFactsForConflict: { fid: string; project: string; kind: string; text: string }[] = [];
    for (const n of notes.values()) {
      const eff = plan.get(n.fid);
      const st = eff ? eff.newStatus : String(n.fm.status ?? 'active');
      if (st !== 'active' || String(n.fm.kind ?? '') === 'card') continue;
      activeFactsForConflict.push({
        fid: n.fid,
        project: eff ? eff.newProject : String(n.fm.project ?? ''),
        kind: eff ? eff.newKind : String(n.fm.kind ?? 'fact'),
        text: `${n.title}\n${n.coreText}`,
      });
    }
    const RETIRE_RE = /(?:ยกเลิก(?:การ)?(?:ใช้)?|เลิกใช้|ถอด(?:\s+\S+){0,4}\s*ออกจาก|แทนที่\b|\breplaces\s+)/i;
    // Also map explicit full-removal decisions (e.g. "ถอด ClickHouse ออกจากเซิร์ฟเวอร์ ... ทั้งหมด") by project + retired tech
    const projectRetiredTech = new Map<string, { fid: string; ts: number }>();
    for (const n of notes.values()) {
      const eff = plan.get(n.fid);
      const st = eff ? eff.newStatus : String(n.fm.status ?? 'active');
      if (st !== 'active') continue;
      const proj = eff ? eff.newProject : String(n.fm.project ?? '');
      if (!proj) continue;
      const ts = Date.parse(String(n.fm.valid_at || n.fm.created_at || '')) || 0;
      for (const m of n.coreText.matchAll(/(?:ยกเลิก(?:การ)?(?:ใช้)?|เลิกใช้|ถอด)\s+([A-Z][A-Za-z0-9]+)(?=[\s,)/]|$)/g)) {
        if (!/(?:ถาวร|ทั้งหมด|clean\s*100%|เครดิตหมด|เปลี่ยนมาใช้|ให้ใช้)/i.test(n.coreText)) continue;
        const key = `${proj}||${m[1].toLowerCase()}`;
        const prev = projectRetiredTech.get(key);
        if (!prev || ts > prev.ts) projectRetiredTech.set(key, { fid: n.fid, ts });
      }
      // Hand-saved note with an explicit "**Update YYYY-MM-DD:** ... replaces <Tech>" retires older machine-dreamed rule of same date/topic
      const upd = /\*\*Update\s+(\d{4}-\d\d-\d\d):\*\*[^\n]*\breplaces\s+([A-Z][A-Za-z0-9]+)/i.exec(n.coreText);
      if (upd && !n.fm.run) {
        const updTs = Date.parse(`${upd[1]}T23:59:59Z`) || ts;
        const key = `${proj}||${upd[2].toLowerCase()}`;
        const prev = projectRetiredTech.get(key);
        if (!prev || updTs > prev.ts) projectRetiredTech.set(key, { fid: n.fid, ts: updTs });
      }
    }
    const candPairs = conflictPairs(activeFactsForConflict);
    for (const p of candPairs) {
      const na = notes.get(p.a), nb = notes.get(p.b);
      if (!na || !nb) continue;
      const pa = polarity(`${na.title}\n${na.coreText}`).get(p.name);
      const pb = polarity(`${nb.title}\n${nb.coreText}`).get(p.name);
      const checkRetire = (oldN: VaultFact, newN: VaultFact, oldPol?: string, newPol?: string) => {
        if (oldN.edited || !oldN.fm.run || oldN.fm.owner === 'user') return;
        const effOld = plan.get(oldN.fid);
        if ((effOld?.newStatus ?? String(oldN.fm.status ?? 'active')) !== 'active') return;
        const proj = effOld?.newProject ?? String(oldN.fm.project ?? '');
        const oldTs = Date.parse(String(oldN.fm.valid_at || oldN.fm.created_at || '')) || 0;
        const newTs = Date.parse(String(newN.fm.valid_at || newN.fm.created_at || '')) || 0;
        const retired = proj ? projectRetiredTech.get(`${proj}||${p.name}`) : undefined;
        if (oldPol === 'pos' && newPol === 'neg' && newTs > oldTs && RETIRE_RE.test(newN.coreText)) {
          const e = ensurePlan(plan, oldN);
          e.newStatus = 'superseded';
          e.newSupersededBy = retired ? retired.fid : newN.fid;
          e.newReviewTarget = '';
          e.reasons.push(`retired_conflict(${p.name})->${e.newSupersededBy}`);
        } else if (oldPol === 'pos' && retired && retired.ts > oldTs && retired.fid !== oldN.fid) {
          const e = ensurePlan(plan, oldN);
          e.newStatus = 'superseded';
          e.newSupersededBy = retired.fid;
          e.newReviewTarget = '';
          e.reasons.push(`retired_tech(${p.name})->${retired.fid}`);
        } else if (oldPol === 'pos' && retired && Math.abs(retired.ts - oldTs) <= 2 * 86400e3 && retired.fid !== oldN.fid && !notes.get(retired.fid)?.fm.run) {
          const e = ensurePlan(plan, oldN);
          e.newStatus = 'superseded';
          e.newSupersededBy = retired.fid;
          e.newReviewTarget = '';
          e.reasons.push(`retired_by_hand_update(${p.name})->${retired.fid}`);
        }
      };
      checkRetire(na, nb, pa, pb);
      checkRetire(nb, na, pb, pa);
    }

    // Pass 5 (ข): Retroactive kind="rule" / "decision" inheritance across all supersede chains
    const replacesOld = new Map<string, Set<string>>(); // newFid -> Set<oldFid>
    const addReplaceEdge = (oldFid: string, newFid: string) => {
      if (!oldFid || !newFid || oldFid === newFid || !notes.has(oldFid) || !notes.has(newFid)) return;
      if (!replacesOld.has(newFid)) replacesOld.set(newFid, new Set());
      replacesOld.get(newFid)!.add(oldFid);
    };
    for (const n of notes.values()) {
      const eff = plan.get(n.fid);
      const supBy = eff ? eff.newSupersededBy : String(n.fm.superseded_by ?? '');
      if (supBy) addReplaceEdge(n.fid, supBy);
      const origRev = String(n.fm.review_target ?? '');
      if (origRev) {
        const tgt = notes.get(origRev);
        const tgtSt = tgt ? (plan.get(origRev)?.newStatus ?? String(tgt.fm.status ?? 'active')) : '';
        if (tgtSt === 'superseded') addReplaceEdge(origRev, n.fid);
      }
      for (const m of n.body.matchAll(/^-\s+supersedes::\s+\[\[(F[0-9a-f]{7,8})\b/gim)) {
        addReplaceEdge(m[1], n.fid);
      }
    }
    const effKindMap = new Map<string, string>();
    for (const n of notes.values()) effKindMap.set(n.fid, String(n.fm.kind ?? 'fact') || 'fact');
    let kindChanged = true;
    while (kindChanged) {
      kindChanged = false;
      for (const [newFid, olds] of replacesOld) {
        const n = notes.get(newFid)!;
        if (n.edited) continue;
        const curKind = effKindMap.get(newFid)!;
        if (curKind !== 'fact') continue;
        let nextKind = curKind;
        for (const oldFid of olds) {
          const ok = effKindMap.get(oldFid);
          if (ok === 'rule') { nextKind = 'rule'; break; }
          if (ok === 'decision') nextKind = 'decision';
        }
        if (nextKind !== curKind) {
          effKindMap.set(newFid, nextKind);
          kindChanged = true;
        }
      }
    }
    for (const [fid, nextKind] of effKindMap) {
      const n = notes.get(fid)!;
      const origKind = String(n.fm.kind ?? 'fact') || 'fact';
      if (nextKind !== origKind && !n.edited) {
        const e = ensurePlan(plan, n);
        e.newKind = nextKind;
        e.reasons.push(`inherit_kind:${origKind}->${nextKind}`);
      }
    }

    // Pass 6 (ก): Close invalid_at (valid_until) on every superseded note missing invalid_at
    const nowIso = new Date().toISOString();
    for (const n of notes.values()) {
      if (n.edited) continue;
      const eff = plan.get(n.fid);
      const st = eff ? eff.newStatus : String(n.fm.status ?? 'active');
      if (st !== 'superseded') continue;
      const hasInvalidAt = String(n.fm.invalid_at ?? '').trim();
      if (hasInvalidAt) continue;
      const supBy = eff ? eff.newSupersededBy : String(n.fm.superseded_by ?? '');
      const rep = supBy ? notes.get(supBy) : undefined;
      const selfValid = String(n.fm.valid_at ?? '').trim();
      const repValid = rep ? String(rep.fm.valid_at || rep.fm.created_at || '').trim() : '';
      let closedAt = String(n.fm.valid_until ?? '').trim();
      if (!closedAt) {
        if (repValid && (!selfValid || Date.parse(repValid) >= Date.parse(selfValid))) {
          closedAt = repValid;
        } else {
          closedAt = String(n.fm.expired_at || rep?.fm.created_at || n.fm.created_at || selfValid || nowIso).trim();
        }
      }
      const e = ensurePlan(plan, n);
      e.newInvalidAt = closedAt;
      e.reasons.push(`close_invalid_at:${closedAt.slice(0, 10)}`);
    }

    // Drop any no-op plan entries
    for (const [fid, e] of [...plan.entries()]) {
      if (!e.reasons.length) plan.delete(fid);
    }

    let totalClosedInvalid = 0, totalKindRestored = 0, totalClearedReview = 0, totalNewlySuperseded = 0;
    for (const e of plan.values()) {
      if (e.oldProject !== e.newProject) {
        statFor(e.oldProject).movedOut++;
        statFor(e.newProject).movedIn++;
      }
      const targetStat = statFor(e.newProject);
      if (e.oldStatus === 'pending' && e.newStatus === 'active') targetStat.newlyActivated++;
      if (e.oldStatus !== 'superseded' && e.newStatus === 'superseded') { targetStat.newlySuperseded++; totalNewlySuperseded++; }
      if (e.oldKind !== e.newKind) { targetStat.kindRestored++; totalKindRestored++; }
      if (e.newInvalidAt && !notes.get(e.fid)!.fm.invalid_at) { targetStat.closedInvalidAt++; totalClosedInvalid++; }
      if (notes.get(e.fid)!.fm.review_target && !e.newReviewTarget) { targetStat.clearedReview++; totalClearedReview++; }
    }

    const pathAliases = Object.entries(canonicalAliases)
      .filter(([k, v]) => /^[a-z]:\//.test(k) && k !== v)
      .map(([k]) => k);
    const dbAliasSources = pathAliases.length
      ? await db.query(`SELECT lower(project) project, count(*)::int n FROM sources WHERE lower(project) = ANY($1::text[]) GROUP BY 1 ORDER BY 2 DESC`, [pathAliases])
      : { rows: [] };

    console.log(`\n--- SUMMARY ACROSS ALL PROJECTS (${notes.size} fact notes, ${plan.size} notes to update) ---`);
    console.log(`  (ก) Superseded notes closing invalid_at: ${totalClosedInvalid}`);
    console.log(`  (ข) Notes restoring kind (fact -> rule/decision): ${totalKindRestored}`);
    console.log(`  (ค) Stuck review_target cleared: ${totalClearedReview}, newly superseded obsolete/conflict notes: ${totalNewlySuperseded}`);
    console.log('\n' + 'Project'.padEnd(32) + 'Active  Pend   Sup  Conf Stale | MvOut MvIn +Sup +Kind +Inv -Rev');
    console.log('-'.repeat(100));
    const sortedProjects = [...byProject.entries()].sort((a, b) =>
      (b[1].active + b[1].pending + b[1].movedIn + b[1].movedOut + b[1].kindRestored + b[1].closedInvalidAt)
      - (a[1].active + a[1].pending + a[1].movedIn + a[1].movedOut + a[1].kindRestored + a[1].closedInvalidAt)
      || a[0].localeCompare(b[0]));
    for (const [proj, s] of sortedProjects) {
      if (s.active + s.pending + s.movedIn + s.movedOut + s.newlySuperseded + s.kindRestored + s.closedInvalidAt + s.clearedReview === 0) continue;
      console.log(
        proj.slice(0, 31).padEnd(32)
        + String(s.active).padStart(6)
        + String(s.pending).padStart(6)
        + String(s.superseded).padStart(6)
        + String(s.conflicts).padStart(6)
        + String(s.stale).padStart(6)
        + ' |'
        + String(s.movedOut).padStart(6)
        + String(s.movedIn).padStart(5)
        + String(s.newlySuperseded).padStart(5)
        + String(s.kindRestored).padStart(6)
        + String(s.closedInvalidAt).padStart(5)
        + String(s.clearedReview).padStart(5),
      );
    }

    const sampleInteresting = [...plan.values()].filter((e) =>
      e.oldKind !== e.newKind || e.oldStatus !== e.newStatus || e.oldProject !== e.newProject || ['F2c3b1193', 'Fb308aa1f', 'F92141f28'].includes(e.fid),
    );
    if (sampleInteresting.length) {
      console.log(`\nKey structural updates (${sampleInteresting.length} notes):`);
      for (const e of sampleInteresting.slice(0, 60)) {
        console.log(`  [${e.fid}] (${e.newProject || '_global'}) ${e.reasons.join('; ')}`);
      }
    }

    const totalDbAlias = dbAliasSources.rows.reduce((a: number, r: any) => a + Number(r.n), 0);
    console.log(`\nDB raw chat/doc sources on old alias paths to normalize: ${totalDbAlias} sources across ${dbAliasSources.rows.length} alias paths`);

    if (!apply) {
      console.log(`\nDry-run complete. Re-run with --apply to execute all ${plan.size} vault updates + ${totalDbAlias} DB source updates + re-index.`);
      return;
    }

    console.log(`\nApplying ${plan.size} vault note updates...`);
    let movedFiles = 0, updatedFiles = 0;
    for (const e of plan.values()) {
      const n = notes.get(e.fid)!;
      // IMPORTANT: writeNote merges { ...old.fm, ...meta }, so cleared fields MUST be passed as '' or [], never `delete`!
      const meta: Record<string, string | string[]> = {
        scope: e.newScope,
        project: e.newProject || '',
        related_projects: e.relatedProjects,
        kind: e.newKind,
        status: e.newStatus,
        superseded_by: e.newSupersededBy || '',
        review_target: e.newReviewTarget || '',
      };
      if (e.newStatus === 'superseded') {
        const inv = e.newInvalidAt || String(n.fm.invalid_at || n.fm.expired_at || nowIso);
        meta.invalid_at = inv;
        meta.expired_at = String(n.fm.expired_at || inv);
      }

      const prevTags = Array.isArray(n.fm.tags)
        ? n.fm.tags.map(String).filter((t: string) => !t.startsWith('project/') && (t === 'memhub/saved' || t === 'memhub/fact' || !t.startsWith('memhub/')))
        : ['memhub/fact'];
      if (!prevTags.includes('memhub/saved')) prevTags.push(`memhub/${e.newKind}`);
      else if (e.oldKind !== e.newKind) prevTags.push(`memhub/${e.newKind}`);
      if (e.newProject) prevTags.push(`project/${projectSlug(e.newProject)}`);
      meta.tags = [...new Set(prevTags)];

      const fileBase = basename(n.rel) || `${e.fid} ${fileName(n.title || e.fid, 40)}.md`;
      const targetRel = e.oldProject !== e.newProject
        ? `facts/${e.newProject ? projectSlug(e.newProject) : '_global'}/${fileBase}`
        : n.rel;

      if (targetRel !== n.rel) {
        const fullMeta: Record<string, any> = { ...n.fm, ...meta };
        if (Array.isArray(fullMeta.source_uuids)) {
          const oldSelf = noteUuid(join(MEMORY_VAULT, n.rel)), newSelf = noteUuid(join(MEMORY_VAULT, targetRel));
          const oldSlash = noteUuid(n.rel), newSlash = noteUuid(targetRel);
          fullMeta.source_uuids = fullMeta.source_uuids.map((u: string) => (u === oldSelf ? newSelf : u === oldSlash ? newSlash : u));
        }
        delete fullMeta.body_sha;
        const wr = writeNote(targetRel, fullMeta, n.body);
        if (wr !== 'kept-user-edit' && existsSync(n.abs)) {
          unlinkSync(n.abs);
          movedFiles++;
        }
      } else {
        const wr = writeNote(targetRel, meta);
        if (wr === 'written') updatedFiles++;
      }
    }
    console.log(`Vault files written: ${movedFiles} moved, ${updatedFiles} updated in place.`);

    let dbNormalized = 0;
    for (const [aliasPath, canonPath] of Object.entries(canonicalAliases)) {
      if (!/^[a-z]:\//.test(aliasPath) || aliasPath === canonPath) continue;
      const u1 = await db.query(`UPDATE sources SET project = $2 WHERE lower(project) = $1`, [aliasPath, canonPath]);
      await db.query(`UPDATE turns SET project = $2 WHERE lower(project) = $1`, [aliasPath, canonPath]);
      await db.query(`UPDATE chunks SET project = $2 WHERE lower(project) = $1`, [aliasPath, canonPath]);
      dbNormalized += u1.rowCount ?? 0;
    }
    console.log(`DB sources normalized: ${dbNormalized}`);

    // Force re-index on any DB fact row still missing invalid_at while superseded or holding non-pending review_target
    await db.query(`
      UPDATE sources SET mtime_ms = 0, sha256 = ''
      WHERE id IN (
        SELECT f.source_id FROM facts f JOIN sources s ON s.id = f.source_id
        WHERE (s.status = 'superseded' AND f.invalid_at IS NULL)
           OR (coalesce(s.status, 'active') <> 'pending' AND coalesce(f.review_target, '') <> '')
      )`);

    commitBatch(MEMORY_VAULT, `audit: close superseded invalid_at, restore rule/decision kind, clear stuck review_target (${plan.size} notes)`);

    console.log('Re-indexing vault...');
    const idx = await indexVault(db, MEMORY_VAULT);
    const links = await resolveLinks(db);
    await refreshTermDf(db);
    clearResolverCache();
    console.log(`indexVault: ${JSON.stringify(idx)}, links=${links}`);

    console.log('Backfilling embeddings for moved/updated notes...');
    const emb = await backfill(db);
    console.log(`backfill embeddings: ${JSON.stringify(emb)}`);

    console.log('Recomputing accuracy flags (STALE + CONFLICT) across all active facts...');
    await db.query(`DELETE FROM state WHERE k LIKE 'conflict:%' OR k LIKE 'stale:%'`);
    const flags = await accuracyFlags(db, []);
    await saveFlags(db, flags);
    const conflictCountAfter = new Set(flags.pairs.flatMap((p) => [p.a, p.b])).size;
    const staleCountAfter = flags.stale.length;
    console.log(`accuracyFlags saved: ${conflictCountAfter} facts in ${flags.pairs.length} conflict pairs, ${staleCountAfter} active facts flagged STALE.`);

    console.log('Rebuilding hubs (consolidate) & synapses...');
    const cons = await consolidate(db);
    commitBatch(MEMORY_VAULT, `consolidate: post-audit hubs`);
    await indexVault(db, MEMORY_VAULT);
    await resolveLinks(db);
    const syn = await rebuildSynapses(db, { structural: true });
    await backfill(db);
    console.log(`synapses: ${JSON.stringify(syn)}`);
    console.log(`consolidate: ${JSON.stringify(cons)}`);

    const [pendingLeft, supNullLeft, stuckRevLeft] = await Promise.all([
      db.query(`SELECT count(*)::int n FROM review_queue`),
      db.query(`SELECT count(*)::int n FROM facts f JOIN sources s ON s.id = f.source_id WHERE s.status = 'superseded' AND f.invalid_at IS NULL`),
      db.query(`SELECT count(*)::int n FROM facts f JOIN sources s ON s.id = f.source_id WHERE coalesce(s.status, 'active') <> 'pending' AND coalesce(f.review_target, '') <> ''`),
    ]);
    console.log(`\n=== APPLY COMPLETE: review_queue=${pendingLeft.rows[0].n}, superseded_without_invalid_at=${supNullLeft.rows[0].n}, stuck_review_target=${stuckRevLeft.rows[0].n}, conflict_pairs=${flags.pairs.length}, flagged_STALE=${staleCountAfter} ===`);
  } finally {
    await db.end();
  }
}

await main();
