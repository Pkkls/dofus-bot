// Zone advisor: picks the hunting zone that yields the most XP per minute for the current level.
//
// Pure module, no browser or I/O: bot.mjs gathers the facts (zone list, level locks, measured XP/min) and applies
// the decision. A decision is one of:
//   { action: 'probe', zones, reason }  harder unlocked zones never measured at this level: measure them, then pick
//   { action: 'move',  zone,  reason }  a zone already measured at this level beats the current one by `moveMargin`
//   { action: 'stay',  reason }         nothing better known or left to try
//
// Why probing matters: XP/min is only known for zones the bot has fought in. Without probing, a zone unlocked by
// levelling up is never tried and the bot keeps farming a zone that no longer pays.

/**
 * @typedef {{ href: string, name: string, minLevel: number, maxLevel: number }} Zone
 * @typedef {{ fights: number, winRate: number, xpPerMin: number, level: number, name?: string }} Measure
 * @typedef {{ probeCount: number, minFights: number, levelTolerance: number, targetWinRate: number, moveMargin: number }} AdvisorConfig
 */

export const DEFAULTS = { probeCount: 3, minFights: 3, levelTolerance: 5, targetWinRate: 0.9, moveMargin: 0.15 };

/** Whether the player's level opens the zone. */
export const isUnlocked = (href, level, levelLocks) => (levelLocks[href] ?? 0) <= level;

/** Whether a measure is recent enough to compare: enough fights, taken at about the current level. */
export const isCurrent = (m, level, cfg = DEFAULTS) => !!m && m.fights >= cfg.minFights && Math.abs(m.level - level) <= cfg.levelTolerance;

/**
 * @param {{ level: number, currentZone: string, zones: Zone[], levelLocks: Record<string, number>,
 *           measures: Record<string, Measure>, config?: Partial<AdvisorConfig> }} facts
 */
export function adviseZone({ level, currentZone, zones, levelLocks, measures, config }) {
  const cfg = { ...DEFAULTS, ...config };
  const open = zones.filter((z) => isUnlocked(z.href, level, levelLocks));
  const current = open.find((z) => z.href === currentZone);
  const here = measures[currentZone];
  const floor = current?.minLevel ?? 0;

  const untried = open
    .filter((z) => z.href !== currentZone && z.minLevel >= floor && !isCurrent(measures[z.href], level, cfg))
    .sort((a, b) => b.minLevel - a.minLevel || b.maxLevel - a.maxLevel)
    .slice(0, cfg.probeCount);
  if (untried.length) {
    const zonesToMeasure = untried.map((z) => z.href);
    if (!isCurrent(here, level, cfg)) zonesToMeasure.push(currentZone); // compare at the same level
    return {
      action: 'probe',
      zones: zonesToMeasure,
      reason: `${untried.length} harder unlocked zone(s) never measured at level ${level}: ${untried.map((z) => `${z.name} ${z.minLevel}-${z.maxLevel}`).join(', ')}`,
    };
  }

  const best = open
    .filter((z) => z.href !== currentZone)
    .map((z) => ({ zone: z, m: measures[z.href] }))
    .filter(({ m }) => isCurrent(m, level, cfg) && m.winRate >= cfg.targetWinRate)
    .sort((a, b) => b.m.xpPerMin - a.m.xpPerMin)[0];
  if (best && here && best.m.xpPerMin > (1 + cfg.moveMargin) * here.xpPerMin) {
    return {
      action: 'move',
      zone: best.zone.href,
      reason: `${best.zone.name} yields ${Math.round(best.m.xpPerMin)} XP/min vs ${Math.round(here.xpPerMin)} here (win rate ${Math.round(best.m.winRate * 100)} %)`,
    };
  }
  return {
    action: 'stay',
    reason: here ? `${Math.round(here.xpPerMin)} XP/min here, no unlocked zone left to measure and none measured better` : 'current zone not measured yet, nothing better known',
  };
}

/** After probing: the measured zone with the best XP/min that holds the target win rate, or null. */
export function pickBestMeasured({ level, zones, levelLocks, measures, config }) {
  const cfg = { ...DEFAULTS, ...config };
  return zones
    .filter((z) => isUnlocked(z.href, level, levelLocks))
    .map((z) => ({ zone: z, m: measures[z.href] }))
    .filter(({ m }) => isCurrent(m, level, cfg) && m.winRate >= cfg.targetWinRate)
    .sort((a, b) => b.m.xpPerMin - a.m.xpPerMin)[0] ?? null;
}
