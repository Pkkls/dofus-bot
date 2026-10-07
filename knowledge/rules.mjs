// Doctor pre-rules for DofusMasters: situations whose answer is CERTAIN never go to the model. A small model can
// get them wrong (in the eval it answered "f5" to the presence test), and these are exactly the cases where a wrong
// answer costs the most. Each rule: test(input) -> true when it applies; order must be in the allowed list.
// Generic shape, game-specific content: ai/llm.mjs runs whatever list the game configures.

const text = (i) => `${i.page}\n${i.log.join('\n')}`;

export const DOCTOR_RULES = [
  {
    id: 'presence-test',
    test: (i) => /Es-tu toujours l[àa]|toujours l[àa] \?|clique sur (le|la) \d|captcha|v[ée]rification humaine|prouve que/i.test(i.page),
    order: 'alerter',
    why: 'test de presence anti-bot : seul kil y repond, le bot ne clique jamais',
  },
  {
    id: 'presence-in-log',
    test: (i) => /Es-tu toujours l[àa]/i.test(i.log.join('\n')),
    order: 'alerter',
    why: 'le bot bute sur un test de presence : seul kil y repond',
  },
  {
    id: 'site-update-broke-buttons',
    test: (i) => /MAJ SITE/.test(text(i)) && /Timeout|introuvable/.test(i.log.join('\n')),
    order: 'site',
    why: 'le site vient de changer et des boutons ne sont plus trouves : relever le site',
  },
  {
    id: 'no-energy',
    test: (i) => /Plus assez d.?[ée]nergie|[ée]nergie\s*:?\s*[01]\s*\/\s*\d+/i.test(text(i)),
    order: 'attendre',
    why: 'plus d energie : elle revient seule (1 point toutes les 6 min)',
  },
  {
    id: 'server-queue',
    test: (i) => /File d.attente|serveur est plein/i.test(text(i)),
    order: 'attendre',
    why: 'file d attente du serveur : la place arrive seule, ne pas naviguer',
  },
];
