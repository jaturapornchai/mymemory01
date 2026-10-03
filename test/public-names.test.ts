// public-check's visible-text rule: the AI apps' display names (and the site's name) pass, project/repo/person names do not.
// No DB: a stub returns the sources the needles come from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { PUBLIC_NAMES, textLeak } from '../web/scripts/public-names.mjs';

const db = { query: async () => ({ rows: [{ v: 'D:/work/secret-app' }, { v: 'github/acme/widget-repo' }, { v: 'D:/work/codex-tools' }, { v: 'D:/memory-hub' },
  { v: 'C:/Users/someone/.gemini/antigravity/brain/abc.jsonl' }] }) } as unknown as pg.Pool;

test('textLeak: the 8 app display names and memory-hub are fine', async () => {
  const text = 'memory-hub\nClaude 1,234 · Codex 56 · Gemini 7 · Antigravity 8 · ZCode 9 · LM Studio 10 · GitHub 11 · Obsidian 12\nความจำ · V2';
  assert.equal(await textLeak(db, text, 'someone'), '');
  assert.equal(text.replace(PUBLIC_NAMES, '').match(/[A-Z]/g)?.join(''), 'V'); // all stripped, the alias stays
});

test('textLeak: project, repo and person names still leak, also spelled like an app', async () => {
  for (const text of ['โปรเจกต์ secret-app', 'widget-repo', 'Codex-tools', 'codex-tools'])
    assert.match(await textLeak(db, text, 'someone'), /leaks/, text);
  assert.equal(await textLeak(db, 'ของ Someone', 'someone'), 'user name');
});
