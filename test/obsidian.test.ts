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

import { typedWikilinks } from '../src/obsidian.ts';
test('typedWikilinks: inline [[rel::target]] and metadata - rel:: [[target]], deduping plain over typed', () => {
  const md = [
    'อ่าน [[tbl_ic_trans]] และ [[uses_table::tbl_ic_trans|ตารางสต็อก]] ตาม [[follows_rule::F01234567 Global Rule#sec]]',
    '- supersedes:: [[F99999999 Old Rule]]',
    '- from:: [[S11111111 Session Card]]',
    '- related:: [[Plain Note]]',
    '`[[uses_table::ignored_in_code]]`',
  ].join('\n');
  assert.deepEqual(typedWikilinks(md), [
    { dst: 'tbl_ic_trans', rel: 'uses_table' },
    { dst: 'f01234567 global rule', rel: 'follows_rule' },
    { dst: 'f99999999 old rule', rel: 'supersedes' },
    { dst: 's11111111 session card', rel: 'from' },
    { dst: 'plain note', rel: 'link' },
  ]);
  assert.deepEqual(wikilinks(md), ['tbl_ic_trans', 'f01234567 global rule', 'f99999999 old rule', 's11111111 session card', 'plain note']);
});
