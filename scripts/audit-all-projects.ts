// Retroactive all-projects audit & cleanup across MEMORY_VAULT and PostgreSQL.
// Modes:
//   node scripts/audit-all-projects.ts --dry-run   (default: read-only report by project)
//   node scripts/audit-all-projects.ts --apply     (normalizes vault + DB, resolves review queue & obsolete items, re-indexes, rebuilds hubs)
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '../src/db.ts';
import { basename } from 'node:path';
import { clearProjectCache, projectMap } from '../src/importer.ts';
import { refreshTermDf } from '../src/search.ts';
import { clearResolverCache, inferFactProject } from '../src/projects.ts';
import { fileName, isEdited, isGlobalFact, md5, MEMORY_VAULT, noteUuid, parseNote, projectSlug, writeNote } from '../src/notes.ts';
import { indexVault, resolveLinks } from '../src/obsidian.ts';
import { accuracyFlags, missingPaths, saveFlags } from '../src/accuracy.ts';
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
};

const blankStats = (): ProjectStats => ({
  active: 0, pending: 0, superseded: 0, stale: 0, conflicts: 0,
  movedIn: 0, movedOut: 0, newlyActivated: 0, newlySuperseded: 0,
});

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

    type PlannedEdit = {
      fid: string;
      oldProject: string;
      newProject: string;
      newScope: 'global' | 'project';
      relatedProjects: string[];
      oldStatus: string;
      newStatus: string;
      newSupersededBy: string;
      newReviewTarget: string;
      reason: string;
    };
    const plan = new Map<string, PlannedEdit>();

    for (const n of notes.values()) {
      const oldProject = String(n.fm.project ?? '');
      const oldStatus = String(n.fm.status ?? 'active');
      const oldSup = String(n.fm.superseded_by ?? '');
      const oldRev = String(n.fm.review_target ?? '');
      let newProject = oldProject;
      let newScope: 'global' | 'project' = oldProject ? 'project' : 'global';
      let relatedProjects: string[] = Array.isArray(n.fm.related_projects) ? [...n.fm.related_projects] : [];
      let newStatus = oldStatus;
      let newSup = oldSup;
      let newRev = oldRev;
      const reasons: string[] = [];

      if (!n.edited) {
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
          if (JSON.stringify(mergedRel) !== JSON.stringify(relatedProjects)) {
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
          if (oldProject && targetProj && targetProj !== oldProject) {
            newProject = targetProj;
            newScope = 'project';
            reasons.push(`project:${oldProject}->${newProject}`);
          } else if (!oldProject && targetProj) {
            newProject = targetProj;
            newScope = 'project';
            reasons.push(`project:_global->${newProject}`);
          }
          const mergedRel = [...new Set([...relatedProjects, ...inferred.relatedProjects])]
            .filter((rp) => rp && rp !== newProject);
          if (JSON.stringify(mergedRel) !== JSON.stringify(relatedProjects)) {
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
        }
      }

      if (reasons.length) {
        plan.set(n.fid, {
          fid: n.fid, oldProject, newProject, newScope, relatedProjects,
          oldStatus, newStatus, newSupersededBy: newSup, newReviewTarget: newRev,
          reason: reasons.join('; '),
        });
      }
    }

    for (const [oldFid, byFid] of Object.entries(explicitSupersedes)) {
      const n = notes.get(oldFid);
      if (!n || n.edited || !notes.has(byFid)) continue;
      // Only mark superseded when not already identically superseded in frontmatter!
      const curStatus = plan.get(oldFid)?.newStatus ?? String(n.fm.status ?? 'active');
      const curSup = plan.get(oldFid)?.newSupersededBy ?? String(n.fm.superseded_by ?? '');
      if (curStatus === 'superseded' && curSup === byFid) continue;
      const cur = plan.get(oldFid) ?? {
        fid: oldFid,
        oldProject: String(n.fm.project ?? ''),
        newProject: String(n.fm.project ?? ''),
        newScope: (n.fm.project ? 'project' : 'global') as 'global' | 'project',
        relatedProjects: Array.isArray(n.fm.related_projects) ? [...n.fm.related_projects] : [],
        oldStatus: String(n.fm.status ?? 'active'),
        newStatus: String(n.fm.status ?? 'active'),
        newSupersededBy: String(n.fm.superseded_by ?? ''),
        newReviewTarget: String(n.fm.review_target ?? ''),
        reason: '',
      };
      cur.newStatus = 'superseded';
      cur.newSupersededBy = byFid;
      cur.newReviewTarget = '';
      cur.reason = [cur.reason, `superseded_by:${byFid}`].filter(Boolean).join('; ');
      plan.set(oldFid, cur);
    }

    // Exact normalized core-text duplicates within same canonical project -> keep newer/user-saved, supersede older unedited
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
        const cur = plan.get(dup.fid) ?? {
          fid: dup.fid,
          oldProject: String(dup.fm.project ?? ''),
          newProject: String(dup.fm.project ?? ''),
          newScope: (dup.fm.project ? 'project' : 'global') as 'global' | 'project',
          relatedProjects: Array.isArray(dup.fm.related_projects) ? [...dup.fm.related_projects] : [],
          oldStatus: String(dup.fm.status ?? 'active'),
          newStatus: 'active',
          newSupersededBy: '',
          newReviewTarget: '',
          reason: '',
        };
        cur.newStatus = 'superseded';
        cur.newSupersededBy = winner.fid;
        cur.reason = [cur.reason, `exact_dup_of:${winner.fid}`].filter(Boolean).join('; ');
        plan.set(dup.fid, cur);
      }
    }

    for (const e of plan.values()) {
      if (e.oldProject !== e.newProject) {
        statFor(e.oldProject).movedOut++;
        statFor(e.newProject).movedIn++;
      }
      const targetStat = statFor(e.newProject);
      if (e.oldStatus === 'pending' && e.newStatus === 'active') targetStat.newlyActivated++;
      if (e.oldStatus !== 'superseded' && e.newStatus === 'superseded') targetStat.newlySuperseded++;
    }

    const pathAliases = Object.entries(canonicalAliases)
      .filter(([k, v]) => /^[a-z]:\//.test(k) && k !== v)
      .map(([k]) => k);
    const dbAliasSources = pathAliases.length
      ? await db.query(`SELECT lower(project) project, count(*)::int n FROM sources WHERE lower(project) = ANY($1::text[]) GROUP BY 1 ORDER BY 2 DESC`, [pathAliases])
      : { rows: [] };

    console.log(`\n--- SUMMARY ACROSS ALL PROJECTS (${notes.size} fact notes, ${plan.size} notes to update) ---`);
    console.log('Project'.padEnd(36) + 'Active  Pend  Sup   Conf  Stale | MoveOut MoveIn +Act +Sup');
    console.log('-'.repeat(94));
    const sortedProjects = [...byProject.entries()].sort((a, b) =>
      (b[1].active + b[1].pending + b[1].movedIn + b[1].movedOut) - (a[1].active + a[1].pending + a[1].movedIn + a[1].movedOut)
      || a[0].localeCompare(b[0]));
    for (const [proj, s] of sortedProjects) {
      if (s.active + s.pending + s.movedIn + s.movedOut + s.newlySuperseded === 0) continue;
      console.log(
        proj.slice(0, 35).padEnd(36)
        + String(s.active).padStart(6)
        + String(s.pending).padStart(6)
        + String(s.superseded).padStart(6)
        + String(s.conflicts).padStart(6)
        + String(s.stale).padStart(6)
        + ' |'
        + String(s.movedOut).padStart(8)
        + String(s.movedIn).padStart(7)
        + String(s.newlyActivated).padStart(5)
        + String(s.newlySuperseded).padStart(5),
      );
    }

    const totalDbAlias = dbAliasSources.rows.reduce((a: number, r: any) => a + Number(r.n), 0);
    console.log(`\nDB raw chat/doc sources on old alias paths to normalize: ${totalDbAlias} sources across ${dbAliasSources.rows.length} alias paths`);
    for (const r of dbAliasSources.rows) {
      console.log(`  ${r.project} -> ${canonicalAliases[String(r.project)]} (${r.n} sources)`);
    }

    // Verify un-flagged STALE facts in DB state
    const dbStaleRes = await db.query(`SELECT k FROM state WHERE k LIKE 'stale:%'`);
    const dbStaleSet = new Set(dbStaleRes.rows.map((r: any) => String(r.k).slice('stale:'.length)));
    let unflaggedStale = 0;
    for (const n of notes.values()) {
      const eff = plan.get(n.fid);
      const st = eff ? eff.newStatus : String(n.fm.status ?? 'active');
      if (st !== 'active') continue;
      const proj = eff ? eff.newProject : String(n.fm.project ?? '');
      const miss = missingPaths(`${n.title}\n${n.coreText}`, proj || null);
      if (miss.length && !dbStaleSet.has(n.fid)) unflaggedStale++;
    }
    console.log(`Active STALE facts not yet flagged in DB state: ${unflaggedStale}`);

    if (!apply) {
      console.log(`\nDry-run complete. Re-run with --apply to execute all ${plan.size} vault updates + ${totalDbAlias} DB source updates + re-index.`);
      return;
    }

    console.log(`\nApplying ${plan.size} vault note updates...`);
    let movedFiles = 0, updatedFiles = 0;
    for (const e of plan.values()) {
      const n = notes.get(e.fid)!;
      const fm: Record<string, any> = { ...n.fm };
      fm.scope = e.newScope;
      if (e.newProject) fm.project = e.newProject;
      else delete fm.project;

      if (e.relatedProjects.length) fm.related_projects = e.relatedProjects;
      else delete fm.related_projects;

      fm.status = e.newStatus;
      if (e.newSupersededBy) {
        fm.superseded_by = e.newSupersededBy;
        if (!fm.expired_at) fm.expired_at = new Date().toISOString();
      } else {
        delete fm.superseded_by;
      }
      if (e.newReviewTarget) fm.review_target = e.newReviewTarget;
      else delete fm.review_target;

      const kind = String(fm.kind ?? 'fact');
      const prevTags = Array.isArray(fm.tags) ? fm.tags.map(String).filter((t: string) => !t.startsWith('project/')) : ['memhub/fact', `memhub/${kind}`];
      if (e.newProject) prevTags.push(`project/${projectSlug(e.newProject)}`);
      fm.tags = [...new Set(prevTags)];

      const fileBase = basename(n.rel) || `${e.fid} ${fileName(n.title || e.fid, 40)}.md`;
      const targetRel = e.oldProject !== e.newProject
        ? `facts/${e.newProject ? projectSlug(e.newProject) : '_global'}/${fileBase}`
        : n.rel;

      if (targetRel !== n.rel && Array.isArray(fm.source_uuids)) {
        const oldSelf = noteUuid(join(MEMORY_VAULT, n.rel)), newSelf = noteUuid(join(MEMORY_VAULT, targetRel));
        const oldSlash = noteUuid(n.rel), newSlash = noteUuid(targetRel);
        fm.source_uuids = fm.source_uuids.map((u: string) => (u === oldSelf ? newSelf : u === oldSlash ? newSlash : u));
      }

      delete fm.body_sha;
      writeNote(targetRel, fm, n.body);
      if (targetRel !== n.rel && existsSync(n.abs)) {
        unlinkSync(n.abs);
        movedFiles++;
      } else {
        updatedFiles++;
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

    commitBatch(MEMORY_VAULT, `audit: normalize projects, resolve review queue, retire ${plan.size} stale/obsolete facts`);

    console.log('Re-indexing vault...');
    const idx = await indexVault(db, MEMORY_VAULT);
    const links = await resolveLinks(db);
    await refreshTermDf(db);
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

    const pendingLeft = (await db.query(`SELECT count(*)::int n FROM review_queue`)).rows[0].n;
    console.log(`\n=== APPLY COMPLETE: review_queue pending = ${pendingLeft}, conflict facts = ${conflictCountAfter}, flagged STALE facts = ${staleCountAfter} ===`);
  } finally {
    await db.end();
  }
}

await main();
