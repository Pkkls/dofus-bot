// Autonomy report: can the bot live without a human? Reads bot.log over a window and checks measurable thresholds.
//
//   node tools/autonomy-report.mjs            last 24 h
//   node tools/autonomy-report.mjs --hours 6
//
// Verdict AUTONOMOUS only when every criterion passes on a full 24 h window. Generic: it only relies on the log
// prefixes (ATTAQUE, VICTOIRE, DEFAITE, BLOQUE, MEDECIN, REFLEXION, PAUSE, ERREUR, INACTIVITE).
import { readFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? +process.argv[i + 1] : d; };
const HOURS = arg('hours', 24);
const now = Date.now(), from = now - HOURS * 3600000;
const lines = readFileSync('bot.log', 'utf8').split('\n')
  .map((l) => ({ t: Date.parse(l.slice(0, 24)), m: l.slice(25) }))
  .filter((x) => x.t >= from && x.m);

const count = (re) => lines.filter((x) => re.test(x.m)).length;
const fights = lines.filter((x) => /^(VICTOIRE|DEFAITE|BOSS (VICTOIRE|DEFAITE)|ABANDON DEFAITE)/.test(x.m));
const wins = fights.filter((x) => /VICTOIRE/.test(x.m)).length;
const xp = lines.reduce((s, x) => s + +(x.m.match(/^(?:BOSS )?VICTOIRE \+(\d+) XP/)?.[1] ?? 0), 0);

// longest gap without fight progress, ignoring time the bot was told to pause (PAUSE ... -> REPRISE)
let longestGap = 0, last = lines[0]?.t ?? from, paused = false;
for (const x of lines) {
  // pauses voulues : demandees (tableau de bord, medecin) ou programmees (plage horaire REPOS, plafond/heure)
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
  ['fenetre couverte', spanH >= HOURS * 0.95, `${spanH.toFixed(1)} h de log sur ${HOURS} h`],
  ['combats par heure', fights.length / spanH >= 15, `${(fights.length / spanH).toFixed(1)} /h (seuil 15)`],
  ['taux de victoire', fights.length && wins / fights.length >= 0.85, `${fights.length ? Math.round((wins / fights.length) * 100) : 0} % (seuil 85 %)`],
  ['plus long trou sans combat', longestGap <= 20 * 60000, `${Math.round(longestGap / 60000)} min (seuil 20 min, pauses demandees exclues)`],
  ['medecin efficace', reflections.length === 0 || cured / reflections.length >= 0.6, `${cured}/${reflections.length} ordres ont gueri le symptome (seuil 60 %)`],
  ['aucune boucle non stoppee', loops === 0 || count(/^PAUSE \(medecin|INACTIVITE en boucle/) >= loops, `${loops} boucle(s) detectee(s)`],
  ['erreurs', count(/^ERREUR/) / spanH <= 3, `${(count(/^ERREUR/) / spanH).toFixed(1)} /h (seuil 3)`],
];

console.log(`Rapport d'autonomie, ${HOURS} h : ${fights.length} combats, ${wins} victoires, ${(xp / 1e6).toFixed(1)} M XP (${(xp / spanH / 1e6).toFixed(1)} M/h)`);
console.log(`Interventions humaines (pauses du tableau de bord) : ${humanPauses}`);
for (const [name, ok, detail] of criteria) console.log(`${ok ? 'OK  ' : 'KO  '} ${name.padEnd(28)} ${detail}`);
const autonomous = criteria.every(([, ok]) => ok) && HOURS >= 24 && humanPauses === 0;
console.log(autonomous ? '\nVERDICT : AUTONOME sur cette fenetre.' : `\nVERDICT : pas encore autonome${HOURS < 24 ? ' (fenetre < 24 h)' : ''}.`);
process.exitCode = autonomous ? 0 : 1;
