// node --test zone-advisor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adviseZone, pickBestMeasured } from './zone-advisor.mjs';

const zone = (id, minLevel, maxLevel) => ({ href: `/chasse?zone=${id}`, name: `Z${id}`, minLevel, maxLevel });
const zones = [zone(1, 100, 110), zone(2, 114, 138), zone(3, 122, 130), zone(4, 150, 160)];
const measure = (xpPerMin, level = 120, winRate = 0.95, fights = 5) => ({ fights, winRate, xpPerMin, level });

test('probes harder unlocked zones never measured at this level, hardest first, locked ones excluded', () => {
  const d = adviseZone({
    level: 120, currentZone: '/chasse?zone=1', zones,
    levelLocks: { '/chasse?zone=3': 117, '/chasse?zone=4': 145 },
    measures: { '/chasse?zone=1': measure(500_000) },
  });
  assert.equal(d.action, 'probe');
  assert.deepEqual(d.zones, ['/chasse?zone=3', '/chasse?zone=2']);
});

test('also measures the current zone when its own measure is stale', () => {
  const d = adviseZone({
    level: 130, currentZone: '/chasse?zone=1', zones: zones.slice(0, 2), levelLocks: {},
    measures: { '/chasse?zone=1': measure(500_000, 110) },
  });
  assert.equal(d.action, 'probe');
  assert.deepEqual(d.zones, ['/chasse?zone=2', '/chasse?zone=1']);
});

test('moves when a measured zone beats the current one by the margin and holds the win rate', () => {
  const measures = {
    '/chasse?zone=1': measure(500_000),
    '/chasse?zone=2': measure(900_000),
    '/chasse?zone=3': measure(2_000_000, 120, 0.5), // too many defeats: ignored
  };
  const d = adviseZone({ level: 120, currentZone: '/chasse?zone=1', zones: zones.slice(0, 3), levelLocks: {}, measures });
  assert.equal(d.action, 'move');
  assert.equal(d.zone, '/chasse?zone=2');
});

test('stays when nothing better is measured and nothing is left to try', () => {
  const measures = { '/chasse?zone=1': measure(500_000), '/chasse?zone=2': measure(540_000) };
  const d = adviseZone({ level: 120, currentZone: '/chasse?zone=1', zones: zones.slice(0, 2), levelLocks: {}, measures });
  assert.equal(d.action, 'stay');
});

test('pickBestMeasured skips locked zones and losing zones', () => {
  const measures = {
    '/chasse?zone=1': measure(500_000),
    '/chasse?zone=2': measure(800_000),
    '/chasse?zone=3': measure(3_000_000, 120, 0.4),
    '/chasse?zone=4': measure(9_000_000),
  };
  const best = pickBestMeasured({ level: 120, zones, levelLocks: { '/chasse?zone=4': 145 }, measures });
  assert.equal(best.zone.href, '/chasse?zone=2');
});
