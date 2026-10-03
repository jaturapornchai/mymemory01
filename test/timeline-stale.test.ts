// Timeline staleness: the phone is the only copy and Google auto-deletes after 3 months by default, so `google status` and
// the hourly sync warn when the newest exported data point is older than 30 days — the age only, no place, no date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataAgeDays, STALE_DAYS, staleWarning } from '../src/tools/google-timeline.ts';

// fixture dates/point are made up: none is a day or place of his real Timeline (a public test must not echo one)
const NOW = Date.parse('2026-05-03T12:00:00Z');
const seg = (end: string) => ({ startTime: '2026-03-01T09:00:00.000+07:00', endTime: end,
  visit: { topCandidate: { placeID: 'p1', semanticType: 'Unknown', placeLocation: 'geo:9.500000,101.500000' } } });

test('age = whole days since the newest segment end; > 30 days → a warning naming only the age', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memhub-tlage-'));
  try {
    assert.equal(dataAgeDays(dir, NOW), null, 'no export yet');
    assert.equal(staleWarning(null), null);
    writeFileSync(join(dir, 'timeline.json'), JSON.stringify([seg('2026-03-19T08:00:00.000+07:00'), seg('2026-03-10T20:00:00.000+07:00'), { bad: 1 }]));
    const age = dataAgeDays(dir, NOW)!;
    assert.equal(age, 45); // 2026-03-19 01:00Z → 2026-05-03 12:00Z
    const w = staleWarning(age)!;
    assert.match(w, /^WARNING google-timeline: newest data point is 45 days old \(> 30\)/);
    assert.doesNotMatch(w, /\d{4}-\d{2}|geo:|9\.5|101\.5|p1/, 'no date, coordinate or place');
    writeFileSync(join(dir, 'timeline.json'), JSON.stringify([seg(new Date(NOW - 5 * 864e5).toISOString())]));
    assert.equal(dataAgeDays(dir, NOW), 5);
    assert.equal(staleWarning(5), null, 'fresh: quiet hourly log');
    assert.equal(staleWarning(STALE_DAYS), null, 'exactly 30 days: not yet');
    writeFileSync(join(dir, 'timeline.json'), 'not json');
    assert.equal(dataAgeDays(dir, NOW), null, 'unreadable export: no false alarm, no crash');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
