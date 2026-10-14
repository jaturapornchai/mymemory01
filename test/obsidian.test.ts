import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkKey, wikilinks } from '../src/obsidian.ts';

test('wikilinks: alias, heading, block, folder path, dedupe; embeds and code spans ignored', () => {
  const md = 'see [[Proj-Note]] and [[proj-note|the app]], [[decisions/2026-04-13-x#Why]], [[note^abc]], ![[image.png]], [[ภาษี ภ.ง.ด.53]], `[[...settingPath]]`, ```\n[[in-code]]\n```';
  assert.deepEqual(wikilinks(md), ['proj-note', '2026-04-13-x', 'note', 'ภาษี ภ.ง.ด.53']);
});

test('linkKey matches how notes are keyed (basename, no .md/.md.md, lowercase)', () => {
  assert.equal(linkKey('Folder\\Sub/My Note.md'), 'my note');
  assert.equal(linkKey('facts/bccode/Fd37bed41 bccode CLAUDE.md.md'), 'fd37bed41 bccode claude');
});
