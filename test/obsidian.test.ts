import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkKey, wikilinks } from '../src/obsidian.ts';

test('wikilinks: alias, heading, block, folder path, dedupe; embeds ignored', () => {
  const md = 'see [[Proj-Note]] and [[proj-note|the app]], [[decisions/2026-04-13-x#Why]], [[note^abc]], ![[image.png]], [[ภาษี ภ.ง.ด.53]]';
  assert.deepEqual(wikilinks(md), ['proj-note', '2026-04-13-x', 'note', 'ภาษี ภ.ง.ด.53']);
});

test('linkKey matches how notes are keyed (basename, no .md, lowercase)', () => {
  assert.equal(linkKey('Folder\\Sub/My Note.md'), 'my note');
});
