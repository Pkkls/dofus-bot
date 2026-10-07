// Self-healing button labels (Stagehand's idea, heuristic version, no AI). Pure, tested in heal.test.mjs.
//
// When a known progression button is gone (the site renamed it), pick the visible button whose label shares the
// most words with the old one (accents, case and punctuation ignored). Buttons with consequences are never picked:
// a heal must not turn "Auto" into "Auto AFK (gains -50 %)" or "Suivant" into "Vendre".

export const HEAL_NEVER = /AFK|[−-]\s?50|Vendre|Briser|Acheter|Fuir|Abandonner|Prestige|Supprimer|Fusionner|Payer|Déconnexion|Réinitialiser|Défier|Améliorer/i;
export const HEAL_MIN = 0.6;

// mots-outils ignores : "Fin du tour" et "Fin de tour" sont le meme bouton
const STOP = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'un', 'une', 'au', 'aux', 'a', 'et', 'the', 'of', 'to']);
const words = (s) => new Set(s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !STOP.has(w)));

/** Share of words in common (Jaccard), 0..1. */
export function labelSimilarity(a, b) {
  const A = words(a), B = words(b);
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.max(1, new Set([...A, ...B]).size);
}

/** Best replacement label for `name` among visible `labels`, or null when nothing safe is close enough. */
export function pickHeal(name, labels) {
  const best = [...new Set(labels)]
    .filter((l) => !HEAL_NEVER.test(l))
    .map((l) => ({ label: l, score: labelSimilarity(name, l) }))
    .sort((a, b) => b.score - a.score)[0];
  return best && best.score >= HEAL_MIN ? best : null;
}
