// Autonomy report: can the bot live without a human? Reads bot.log over a window and checks measurable thresholds.
//
//   node tools/autonomy-report.mjs            last 24 h
//   node tools/autonomy-report.mjs --hours 6
//
// Also imported by bot.mjs for the dashboard (/api/autonomy). Verdict AUTONOMOUS only when every criterion passes on
// a full 24 h window with no human pause. Generic: it only relies on the log prefixes (ATTAQUE, VICTOIRE, DEFAITE,
// BOSS, REFLEXION, PAUSE, REPRISE, REPOS, PLAFOND, ERREUR, INACTIVITE).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function autonomyReport({ hours = 24, logFile = 'bot.log', now = Date.now() } = {}) {
  const from = now - hours * 3600000;
  const lines = readFileSync(logFile, 'utf8').split('\n')
    .map((l) => ({ t: Date.parse(l.slice(0, 24)), m: l.slice(25) }))
    .filter((x) => x.t >= from && x.m);
  const count = (re) => lines.filter((x) => re.test(x.m)).length;
  const fights = lines.filter((x) => /^(VICTOIRE|DEFAITE|BOSS (VICTOIRE|DEFAITE)|ABANDON DEFAITE)/.test(x.m));
  const wins = fights.filter((x) => /VICTOIRE/.test(x.m)).length;
  const xp = lines.reduce((s, x) => s + +(x.m.match(/^(?:BOSS )?VICTOIRE \+(\d+) XP/)?.[1] ?? 0), 0);

  // plus long trou sans progres, hors pauses voulues : demandees (tableau de bord, medecin) ou programmees (REPOS, PLAFOND)
  let longestGap = 0, last = lines[0]?.t ?? from, paused = false;
  for (const x of lines) {
    if (/^PAUSE \(tableau de bord|^PAUSE \(medecin|^REPOS|^PLAFOND/.test(x.m)) paused = true;
    if (/^REPRISE/.test(x.m)) { paused = false; last = x.t; }
    if (/^(ATTAQUE|VICTOIRE|DEFAITE|BOSS)/.test(x.m)) { if (!paused) longestGap = Math.max(longestGap, x.t - last); paused = false; last = x.t; }
  }
  if (!paused) longestGap = Math.max(longestGap, now - last);

  const reflections = lines.filter((x) => /^REFLEXION/.test(x.m));
  const cured = reflections.filter((x) => /symptome disparu/.test(x.m)).length;
  const loops = count(/^INACTIVITE en boucle|la meme ligne repetee/);
  const humanPauses = count(/^PAUSE \(tableau de bord\)/);
  const spanH = Math.max(0.01, (Math.min(now, lines.at(-1)?.t ?? now) - (lines[0]?.t ?? now)) / 3600000);

  const criteria = [
    { name: 'Fenetre couverte', ok: spanH >= hours * 0.95, detail: `${spanH.toFixed(1)} h de log sur ${hours} h` },
    { name: 'Combats par heure', ok: fights.length / spanH >= 15, detail: `${(fights.length / spanH).toFixed(1)} par heure (seuil 15)` },
    { name: 'Taux de victoire', ok: fights.length > 0 && wins / fights.length >= 0.85, detail: `${fights.length ? Math.round((wins / fights.length) * 100) : 0} % (seuil 85 %)` },
    { name: 'Plus long arret', ok: longestGap <= 20 * 60000, detail: `${Math.round(longestGap / 60000)} min sans combat (seuil 20 min, pauses voulues exclues)` },
    { name: 'Medecin efficace', ok: reflections.length === 0 || cured / reflections.length >= 0.6, detail: `${cured}/${reflections.length} ordres ont gueri le symptome (seuil 60 %)` },
    { name: 'Boucles stoppees', ok: loops === 0 || count(/^PAUSE \(medecin|INACTIVITE en boucle/) >= loops, detail: `${loops} boucle(s) detectee(s)` },
    { name: 'Erreurs', ok: count(/^ERREUR/) / spanH <= 3, detail: `${(count(/^ERREUR/) / spanH).toFixed(1)} par heure (seuil 3)` },
  ];
  const autonomous = criteria.every((c) => c.ok) && hours >= 24 && humanPauses === 0;
  return {
    hours, autonomous, humanPauses, criteria,
    summary: `${fights.length} combats, ${wins} victoires, ${(xp / 1e6).toFixed(1)} M XP (${(xp / spanH / 1e6).toFixed(1)} M/h)`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--hours');
  const r = autonomyReport({ hours: i > 0 ? +process.argv[i + 1] : 24 });
  console.log(`Rapport d'autonomie, ${r.hours} h : ${r.summary}`);
  console.log(`Interventions humaines (pauses du tableau de bord) : ${r.humanPauses}`);
  for (const c of r.criteria) console.log(`${c.ok ? 'OK  ' : 'KO  '} ${c.name.padEnd(22)} ${c.detail}`);
  console.log(r.autonomous ? '\nVERDICT : AUTONOME sur cette fenetre.' : `\nVERDICT : pas encore autonome${r.hours < 24 ? ' (fenetre < 24 h)' : ''}.`);
  process.exitCode = r.autonomous ? 0 : 1;
}
