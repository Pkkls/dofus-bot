import { chromium } from 'playwright';
import { appendFileSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { exec } from 'node:child_process';
import http from 'node:http';

const BASE = 'https://dofusmasters.houk.fr', COMBAT = BASE + '/combat';
const rand = (a, b) => a + Math.random() * Math.max(0, b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Etat live (lu par le tableau de bord) + reglages modifiables depuis le tableau de bord (config.json)
const S = { status: 'demarrage', since: Date.now(), name: '', level: 0, kamas: 0, mode: 'aventure', huntLeft: 0, zone: null, strikes: 0, boss: null, deck: [], elem: {}, paused: false, queue: [], last: {}, energy: null, arena: null, emptySlots: [], combats: 0, decisions: [], rings: {} };
// decision en direct (pourquoi le bot fait ce qu'il fait), lue par le tableau de bord ; pas ecrite dans bot.log
// decisions identiques consecutives (aux nombres pres) regroupees : x N au lieu de spammer le fil
const decide = (m) => {
  const top = S.decisions[0], key = (s) => s.replace(/\d+/g, '#');
  if (top && key(top.m) === key(m)) Object.assign(top, { t: Date.now(), m, n: (top.n ?? 1) + 1 });
  else { S.decisions.unshift({ t: Date.now(), m, n: 1 }); S.decisions.length = Math.min(S.decisions.length, 60); }
  push();
};
const CFG_SPEC = { vitShare: [0.2, 0, 1], kamasReserve: [20000, 0, 1e9], huntWins: [40, 1, 500], defeatThreshold: [3, 1, 10], maxGroup: [2, 0, 3], passEvery: [30, 5, 500], arenaEvery: [10, 0, 240], arenaMinEnergy: [60, 0, 1000], maxReqPerMin: [60, 10, 600], blockImages: [1, 0, 1], ringSpare: [4, 0, 20], spareWindow: [15, 0, 100],
  scheduleOn: [0, 0, 1], activeFrom: [540, 0, 1439], activeTo: [60, 0, 1439], maxFightsPerHour: [0, 0, 600], energyReserve: [2, 0, 1000], energyResume: [6, 1, 1000], energyBuy: [0, 0, 1], manualFight: [1, 0, 1], trainFights: [5, 1, 50], trainLevel: [200, 1, 300], climbWins: [5, 0, 200], targetWin: [0.85, 0.5, 1], thinkMin: [800, 0, 20000], thinkMax: [2500, 0, 30000], gapMin: [5, 0, 600], gapMax: [20, 0, 900], breakChance: [0.04, 0, 1], breakMin: [2, 0, 9], breakMax: [8, 0, 9], loseRate: [0.05, 0, 0.5], breakJunk: [1, 0, 1], energyKamas: [5000, 0, 1e9] }; // energyKamas : reserve de kamas jamais depensee en energie (coffres/HDV : kamasReserve) // energie : reserve gardee pour le boss, reprise apres recharge // horaires en minutes depuis minuit ; 0 combat/h = illimite // [defaut, min, max] ; arenaEvery en min, 0 = arene coupee
const CFG = { ...Object.fromEntries(Object.entries(CFG_SPEC).map(([k, [d]]) => [k, d])), ...(existsSync('config.json') ? JSON.parse(readFileSync('config.json', 'utf8')) : {}) };
// Energie : 1 point / 6 min. Lue sur les pages de zone et d'arene, decomptee a chaque combat (chasse/aventure 1, boss/arene 2), estimee entre deux.
const REGEN = 360000;
const setEnergy = (n, max) => { S.energy = n; S.energyAt = Date.now(); if (max) S.energyMax = max; };
const energyNow = () => (S.energy == null ? null : Math.min(S.energyMax ?? Infinity, S.energy + Math.floor((Date.now() - (S.energyAt ?? Date.now())) / REGEN)));
// rebase sans perdre le point en cours de recharge
const spendEnergy = (n) => { if (S.energy == null) return; const e = energyNow(), at = S.energyAt ?? Date.now(); S.energyAt = Date.now() - (Date.now() - at) % REGEN; S.energy = Math.max(0, e - n); };
const parseForge = (t) => ({
  level: +(t.match(/Bouclier de forge · niveau (\d+)/)?.[1] ?? 0),
  orbs: +(t.match(/Orbes d.amélioration\n([\d\s\u00a0\u202f]+)\n/)?.[1].replace(/\D/g, '') ?? 0),
  left: +(t.match(/Encore ([\d\s\u00a0\u202f]+) orbes? à gagner aujourd/)?.[1].replace(/\D/g, '') ?? NaN),
  cost: +(t.match(/(\d+) orbes? par essai/)?.[1] ?? 1),
  rate: +(t.match(/(\d+) ?% de réussite/)?.[1] ?? 100),
  bonus: +(t.match(/\+([\d.,]+) ?% de stats sur tout/)?.[1].replace(',', '.') ?? 0),
});
// /jeu : energie exacte (minuteur du prochain point), prix et quota d'achat du jour
const parseJeu = (t) => {
  const m = t.match(/Énergie\n(\d+)\/(\d+)\n+(?:\+1 dans (?:(\d+) min)?\s*(\d+)?)?/);
  return m && { e: +m[1], max: +m[2], next: (+(m[3] ?? 0) * 60 + +(m[4] ?? 0)) * 1000, price: +(t.match(/\(([\d\s]+) K le point/)?.[1].replace(/\D/g, '') ?? 0), left: +(t.match(/encore (\d+) aujourd/)?.[1] ?? 0) };
};
const log = (line) => { const l = `${new Date().toISOString()} ${line}`; console.log(l); appendFileSync('bot.log', l + '\n'); push(); };
// temps reel : chaque client du tableau de bord garde un flux SSE ouvert ; push() regroupe les envois (max ~5/s)
const clients = new Set();
let pushTimer = null;
function push() {
  if (pushTimer || !clients.size) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) res.write(msg);
  }, 200);
}
// version de la page : si dashboard.html change, les clients se rechargent seuls
const pageVer = () => { try { return statSync('dashboard.html').mtimeMs; } catch { return 0; } };
// reseau : chaque requete vers le serveur du jeu, classee ; le limiteur ne compte que pages + actions + donnees (pas les images/scripts)
const NET = { total: 0, by: { page: 0, action: 0, donnee: 0, asset: 0 }, r429: 0, recent: [], throttled: 0, blocked: 0 };
const blockable = (u) => CFG.blockImages && S.status !== 'presence' && /\/img\//.test(u); // images objets/monstres : inutiles au bot
const netKind = (r) => r.resourceType() === 'document' ? 'page' : r.method() === 'POST' ? 'action' : ['fetch', 'xhr'].includes(r.resourceType()) ? 'donnee' : 'asset';
const netLastMin = () => { const t = Date.now() - 60000; return NET.recent.filter(([at, k]) => at > t && k !== 'asset').length; };
const netView = () => {
  const now = Date.now();
  NET.recent = NET.recent.filter(([at]) => now - at < 1800000); // 30 min glissantes
  const perMin = Array.from({ length: 30 }, () => ({ srv: 0, asset: 0 }));
  for (const [at, k] of NET.recent) { const m = 29 - Math.floor((now - at) / 60000); if (m >= 0) perMin[m][k === 'asset' ? 'asset' : 'srv']++; }
  const last = { page: 0, action: 0, donnee: 0, asset: 0 };
  for (const [at, k] of NET.recent) if (now - at < 60000) last[k]++;
  return { total: NET.total, by: NET.by, r429: NET.r429, throttled: NET.throttled, blocked: NET.blocked, lastMin: last, srvLastMin: netLastMin(), perMin };
};
const snapshot = () => ({ now: Date.now(), ver: pageVer(), S, CFG, net: netView(), stats: parseLog() });
setInterval(push, 1000); // comptes a rebours, uptime, minutes qui glissent
// etat utile entre deux redemarrages (arene, boss, deck, energie, dernieres actions, decisions)
const KEEP = ['stats', 'learn', 'hints', 'worn', 'hdvBrokenUntil', 'siteMap', 'dpl', 'forge', 'arena', 'boss', 'deck', 'elem', 'energy', 'energyAt', 'energyMax','emptySlots', 'last', 'decisions', 'rings'];
try { Object.assign(S, JSON.parse(readFileSync('state.json', 'utf8'))); } catch {}
setInterval(() => writeFileSync('state.json', JSON.stringify(Object.fromEntries(KEEP.map((k) => [k, S[k]])))), 10000);
const alert = (m) => { process.stdout.write('\x07'); exec(`msg * "dofus-bot: ${m}"`); };
const ACTION_NAMES = ['gestion', 'coffres', 'deck', 'inventaire', 'hdv', 'carac', 'arene', 'boss', 'energie', 'forge', 'xphard', 'entrainement', 'zone', 'aventure', 'f5'];
// horaires en minutes depuis minuit ; une plage peut passer minuit (ex. 540 -> 60 = 09:00 -> 01:00)
const inWindow = (m, a, b) => a === b || (a < b ? m >= a && m < b : m >= a || m < b);
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const safe = (name, p) => p.catch((e) => log(`ERREUR ${name} ` + e.message.split('\n')[0] + ' | ' + (e.message.match(/waiting for (.+)/)?.[1] ?? '').slice(0, 160))); // + l'element vise

// Poids des stats pour comparer un objet a celui porte. Reglage : adapte Force/Intelligence/Chance/Agilite a ton element.
const WEIGHTS = {
  'PA': 100, 'PM': 60, 'Portée': 30, 'Invocation': 10,
  'Vitalité': 1, 'Puissance': 1.5, 'Sagesse': 0.3, // Force/Intel/Chance/Agi : selon le deck (ELEM_SHARE)
  'Dommages': 5, 'Critique': 4, 'Soins': 2, 'Dommages Critiques': 2,
  'Tacle': 0.3, 'Fuite': 0.3, 'Esquive PA': 0.5, 'Esquive PM': 0.5, 'Retrait PA': 0.5, 'Retrait PM': 0.5, 'Prospection': 0.3, 'Initiative': 0.05, 'Pods': 0,
};
// part de chaque element dans les cartes de degats du deck (maj par optimizeDeck) : le stuff suit le build
let ELEM_SHARE = { Neutre: 0.2, Terre: 0.2, Feu: 0.2, Eau: 0.2, Air: 0.2 };
const STAT_ELEM = { Force: ['Terre', 'Neutre'], Intelligence: ['Feu'], Chance: ['Eau'], Agilité: ['Air'] };
const weight = (stat, pct) => {
  if (STAT_ELEM[stat]) return 0.2 + 1.5 * STAT_ELEM[stat].reduce((s, e) => s + ELEM_SHARE[e], 0);
  const de = stat.match(/^Dommages (Neutre|Terre|Feu|Eau|Air)$/);
  if (de) return 0.5 + 5 * ELEM_SHARE[de[1]];
  return WEIGHTS[stat] ?? (/^Dommages /.test(stat) ? 1 : /^Résistance /.test(stat) ? (pct ? 2 : 0.5) : 0.2);
};
// ponytail: ignore les "+ N autres différences" cachees derriere l'icone ; les lire au survol si les choix paraissent mauvais
const scoreItem = (txt) => txt.split('\n').reduce((s, l) => {
  const m = l.match(/^([+-])\s?(\d+)(%?) (.+)$/);
  return m ? s + (m[1] === '-' ? -1 : 1) * +m[2] * weight(m[4].trim(), m[3]) : s;
}, 0);

// Deck : garde les cartes utilitaires deja dans le deck, complete avec les meilleurs degats par PA.
// Degats effectifs facon Dofus : moyenne * (1 + (stat de l'element + puissance) / 100) + dommages fixes de l'element.
const ELEM_STAT = { Neutre: 'Force', Terre: 'Force', Feu: 'Intelligence', Eau: 'Chance', Air: 'Agilité' };
const parseCard = (txt) => {
  const cost = +txt.match(/^\s*(\d+)/)?.[1];
  const name = txt.replace(/^\s*\d+\s*/, '').split('\n')[0].split(/\s\d+ à \d+|\s[+-]\d|\s(Soigne|Bouclier|Vole)\b/)[0].trim(); // 1re ligne : "Tornabombe\nBombe : ..."
  const d = txt.match(/(\d+) à (\d+) (dommages|vol de vie) (\w+)/);
  return { cost, name, dmg: d ? { avg: (+d[1] + +d[2]) / 2, elem: d[4], steal: d[3] !== 'dommages', zone: /en zone/.test(txt) } : null };
};
const cardValue = (c, s) => {
  if (!c.dmg) return 0;
  const e = c.dmg.elem;
  const v = c.dmg.avg * (1 + ((s[ELEM_STAT[e]] ?? 0) + s.Puissance) / 100) + (s.dmg[e] ?? 0);
  return (v * (c.dmg.zone ? 1.15 : 1) * (c.dmg.steal ? 1.1 : 1)) / c.cost;
};
const chooseDeck = (deck, pool, s) => {
  const keep = deck.filter((c) => !c.dmg);
  const seen = new Set();
  const dmg = [...deck, ...pool].filter((c) => c.dmg && !seen.has(c.name) && seen.add(c.name))
    .sort((a, b) => cardValue(b, s) - cardValue(a, s));
  return [...keep, ...dmg].slice(0, 10).map((c) => c.name);
};
const setElemShare = (cards) => {
  const dmg = cards.filter((c, i, a) => c.dmg && a.findIndex((x) => x.name === c.name) === i);
  if (!dmg.length) return;
  ELEM_SHARE = Object.fromEntries(Object.keys(ELEM_SHARE).map((e) => [e, dmg.filter((c) => c.dmg.elem === e).length / dmg.length]));
};
const parseStats = (t) => ({
  ...Object.fromEntries(['Force', 'Intelligence', 'Chance', 'Agilité'].map((k) => [k, +(t.match(new RegExp(`\\n${k}\\n(\\d+)`))?.[1] ?? 0)])),
  Puissance: +(t.match(/Puissance (\d+)/)?.[1] ?? 0),
  dmg: Object.fromEntries(['Neutre', 'Terre', 'Feu', 'Eau', 'Air'].map((k) => [k, +(t.match(new RegExp(`\\n${k}\\t(\\d+)`))?.[1] ?? 0)])),
});

async function optimizeDeck(page) {
  await page.goto(BASE + '/personnage');
  await page.getByText('Caractéristiques').first().waitFor();
  const stats = parseStats(await page.locator('main').innerText());
  S.stats = stats; // aussi pour le combat manuel
  await page.goto(BASE + '/deck');
  await page.getByText('Collection').first().waitFor();
  const inDeck = page.locator('button[title="Cliquer pour retirer du deck"]');
  const inPool = page.locator('button[title="Cliquer pour ajouter au deck"]:enabled');
  const deck = (await inDeck.allInnerTexts()).map(parseCard);
  const pool = (await inPool.allInnerTexts()).map(parseCard);
  const want = new Set(chooseDeck(deck, pool, stats));
  setElemShare([...deck, ...pool].filter((c) => want.has(c.name)));
  S.deck = [...deck, ...pool].filter((c, i, a) => want.has(c.name) && a.findIndex((x) => x.name === c.name) === i).map((c) => ({ name: c.name, cost: c.cost, elem: c.dmg?.elem ?? null, value: Math.round(cardValue(c, stats) * 10) / 10 }));
  S.elem = { ...ELEM_SHARE };
  const out = deck.filter((c) => !want.has(c.name)).map((c) => c.name);
  const add = [...want].filter((n) => !deck.some((c) => c.name === n));
  if (!add.length) return;
  for (const n of out) { await inDeck.filter({ hasText: n }).first().click(); await sleep(500); }
  for (const n of add) { await inPool.filter({ hasText: n }).first().click(); await sleep(500); }
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await sleep(1500);
  log(`DECK -${out.join(', -')} +${add.join(', +')}`);
  decide(`Deck : +${add.join(', +')} car meilleurs degats par PA avec mes stats`);
}

// Panneau de detail inventaire : diff "Comparé à" si slot occupe, sinon stats brutes de l'objet (slot libre)
const invScore = (detail) => {
  const cmp = detail.match(/Comparé à [^\n]*\n([\s\S]*?)(\nFusionner|\nVendre|$)/);
  if (cmp) return scoreItem(cmp[1]);
  const own = detail.match(/\nNiveau \d+\n([\s\S]*?)\nExemplaires/);
  return own ? scoreItem(own[1]) : 0;
};

// Inventaire : par type, filtre "Equipables", score chaque objet, equipe le meilleur s'il bat la piece portee
// objets de la grille : bouton avec image, texte limite a un badge (nb d'exemplaires, FUSION, etoile) ; exclut les emplacements portes ("Chapeau"...)
const invItems = (main) => main.locator('button:has(img)').filter({ hasNotText: /\b(?!FUSION\b)[A-Za-zÀ-ÿ]{3,}/ });
const SLOTS = ['Chapeau', 'Cape', 'Amulette', 'Anneau', 'Ceinture', 'Bottes', 'Arme', 'Bouclier', 'Familier', 'Dofus / Trophée'];
// Vente : pas d'anneau (2 emplacements, la comparaison ne voit qu'un anneau), ni familier, ni Dofus/Trophee
// bouton de l'etape d'aventure : "Combattre", ou "Affronter le boss" sur une etape de boss
const ADV_FIGHT = /^(Combattre|Affronter le boss)/;
const SELLABLE = ['Chapeau', 'Cape', 'Amulette', 'Ceinture', 'Bottes', 'Arme', 'Bouclier'];
const SELL_RARITY = new Set(['COMMUN', 'PEU COMMUN']); // RARE et au-dessus : jamais vendus
// vente prudente, dans le doute on garde : favori, rarete RARE+, tiers fusionne ou Rayonnant, liste NEVER_SELL, comparaison incomplete
const NEVER_SELL = ['Gelano', 'Molosk', 'Mollosk']; // Molosk (familier) : objet garde au prestige // noms de base (sans tiers) des objets rares a garder quoi qu'il arrive
const canSell = (d) => !d.fav && SELL_RARITY.has(d.rarity) && !/ · (Tiers \d+|Rayonnant)$/.test(d.name) && !NEVER_SELL.includes(baseName(d.name)) && !d.partial;
// panneau de detail : "Nom / RARETE / Emplacement / Niveau N / stats / Exemplaires..." ; on prend la derniere occurrence (la grille au-dessus contient des badges)
const parseDetail = (t) => {
  const all = [...t.matchAll(/(?:^|\n)(★\n)?([^\n]+)\n(COMMUN|PEU COMMUN|RARE|ÉPIQUE|MYTHIQUE|LÉGENDAIRE)\n([^\n]+)\nNiveau (\d+)\n/g)];
  const m = all.at(-1);
  if (!m) return null;
  const detail = t.slice(m.index);
  const own = scoreItem(detail.match(/\nNiveau \d+\n([\s\S]*?)\nExemplaires/)?.[1] ?? '');
  return { name: m[2].trim(), fav: !!m[1], rarity: m[3], slot: m[4].trim(), level: +m[5], own, diff: invScore(detail), cmp: detail.match(/Comparé à ([^\n]+)/)?.[1] ?? null, partial: /autres différences/.test(detail) };
};
async function equipFromInventory(page) {
  await page.goto(BASE + '/inventaire');
  await page.getByText('Équipement porté').waitFor({ timeout: 30000 });
  const main = page.locator('main');
  const cb = main.locator('input[type=checkbox]').first();
  if (!(await cb.isChecked())) await cb.check();
  S.emptySlots = (await main.locator('button').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.startsWith('+ ')).map((s) => s.slice(2)); // ex. "+ Bouclier"
  for (const slot of SLOTS) {
    const filter = main.locator('button').filter({ hasText: new RegExp(`^${slot}\\s*\\d+$`) });
    if (!(await filter.count())) continue;
    await filter.first().click();
    await sleep(800);
    const items = invItems(main);
    // fusion : 3 exemplaires d'un objet au moins aussi bon que la piece portee -> tiers suivant (+10 % stats) ; seuls les badges FUSION
    const fusable = items.filter({ hasText: 'FUSION' });
    for (let i = 0, fused = 0; i < Math.min(await fusable.count(), 10) && fused < 5; i++) {
      const fd = await openItem(main, fusable.nth(i));
      const fuse = main.getByRole('button', { name: /^Fusionner 3/ });
      if (!fd || !(await fuse.isEnabled().catch(() => false))) continue;
      if (fd.diff < 0) continue; // ponytail: le moins bon part chez le marchand, 3 ventes > 1 fusion
      await fuse.click();
      const ok = main.getByRole('button', { name: /^Confirmer/ }); // meme schema en 2 clics que la vente, si present
      if (await ok.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await ok.click();
      await sleep(1500);
      log(`FUSION ${slot}: ${fd.name}`);
      decide(`Fusion ${slot} : 3 exemplaires au moins aussi bons que ma piece, tiers superieur (+10 % stats)`);
      fused++; i = -1; // la grille a change : on repart du debut
    }
    if (slot === 'Anneau') { await optimizeRings(page, main); continue; } // 2 emplacements : logique dediee
    let best = 0, bestIdx = -1, bestName = '';
    const junk = [];
    const seen = [];
    // ponytail: 25 objets max par type ; trier par niveau d'abord si l'inventaire grossit
    for (let i = 0; i < Math.min(await items.count(), 25); i++) {
      const d = await openItem(main, items.nth(i));
      if (!d || !sameSlot(d.slot, slot) || !(await main.getByRole('button', { name: /^Équiper/ }).first().isEnabled().catch(() => false))) continue; // filtre pas encore applique : objet d'un autre type ignore
      seen.push({ i, ...d });
      if (d.diff > best) { best = d.diff; bestIdx = i; bestName = d.name; }
      if (d.diff < 0 && SELLABLE.includes(slot) && canSell(d)) junk.push([d.name, d.diff]);
    }
    const ref = seen.find((x) => x.cmp); // piece portee = score propre - ecart affiche
    if (ref) (S.worn ??= {})[slot] = Math.round(ref.own - ref.diff); else if (S.emptySlots?.includes(slot)) (S.worn ??= {})[slot] = 0;
    decide(`Inventaire ${slot} : ${bestIdx >= 0 ? `j'equipe ${bestName} (score +${Math.round(best)})` : 'rien de mieux que ma piece'}${junk.length ? `, ${junk.length} moins bon(s) a vendre` : ''}`);
    if (bestIdx >= 0 && (await openItem(main, items.nth(bestIdx)))?.name === bestName) {
      await main.getByRole('button', { name: /^Équiper/ }).first().click();
      log(`EQUIPE (inventaire) ${slot}: ${bestName} (score ${Math.round(best)})`);
      await sleep(1500);
    }
    await sellJunk(page, main, slot, junk);
  }
}

// Ouvre le detail d'un objet de la grille et attend que le panneau montre CET objet (nom = texte de l'image).
// Sinon null : on n'equipe ni ne vend jamais sur un panneau perime (le clic ne met pas toujours le panneau a jour).
async function openItem(main, item) {
  const alt = (await item.locator('img').first().getAttribute('alt').catch(() => null))?.trim();
  if (!alt) return null;
  await item.click({ timeout: 5000 }).catch(() => {});
  for (let k = 0; k < 10; k++) {
    await sleep(150);
    const d = parseDetail(await main.innerText());
    if (d && (d.name === alt || d.name.startsWith(alt + ' '))) {
      if (!existsSync('dump/inv_detail.txt')) writeFileSync('dump/inv_detail.txt', `${await main.innerText()}\n\n=== BOUTONS\n${(await main.locator('button').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).filter(Boolean).join('\n')}`); // fiche apres la maj Forgemagie
      return d;
    }
  }
  return null;
}
const sameSlot = (a, b) => a === b || b.includes(a) || a.includes(b); // "Dofus / Trophée" peut s'afficher "Trophée"
const baseName = (n) => n.replace(/ · (Tiers \d+|Rayonnant)$/, ''); // texte de l'image = nom sans le tiers

// Anneaux : 2 emplacements, le jeu compare toujours a l'anneau 1 mais propose "Equiper a la place de X (Anneau 1|2)".
// Scores connus memorises dans S.rings. Si l'anneau 2 est inconnu, on y place le meilleur du sac : l'ancien revient au sac
// et devient mesurable ; ensuite le meilleur du sac remplace le plus faible des deux tant qu'il le bat (4 tours max).
async function optimizeRings(page, main) {
  const items = invItems(main);
  const scan = async () => {
    const out = [];
    for (let i = 0; i < Math.min(await items.count(), 60); i++) {
      const d = await openItem(main, items.nth(i));
      if (!d || !sameSlot(d.slot, 'Anneau') || !(await main.getByRole('button', { name: /^Équiper/ }).first().isEnabled().catch(() => false))) continue;
      S.rings[d.name] = d.own;
      if (d.cmp) S.rings[d.cmp] = d.own - d.diff;
      out.push({ i, ...d });
    }
    return out;
  };
  // emplacements portes : le texte peut contenir un badge de tiers ("T2 Anneau"), d'ou la regex ; score cherche par nom exact puis par nom de base
  const worn = () => main.locator('button').filter({ hasText: /(^|\s)Anneau$/ }).locator('img').evaluateAll((els) => els.map((e) => e.alt));
  const scoreOf = (n) => S.rings[n] ?? Object.entries(S.rings).find(([k]) => baseName(k) === n)?.[1];
  let sack = await scan();
  for (let round = 0; round < 4 && sack.length; round++) {
    const [n1, n2] = await worn(), s = [scoreOf(n1), scoreOf(n2)];
    if ((!n1 || !n2) && S.emptySlots?.includes('Anneau')) { // emplacement libre (ex. apres un prestige) : le meilleur du sac y va, bouton "Equiper" simple
      const best = sack.reduce((a, b) => (b.own > a.own ? b : a));
      if ((await openItem(main, items.nth(best.i)))?.name !== best.name) break;
      await main.getByRole('button', { name: /^Équiper/ }).first().click();
      await sleep(1500);
      log(`EQUIPE (inventaire) Anneau libre: ${best.name} (score ${Math.round(best.own)})`);
      decide(`Anneaux : emplacement libre, j'y mets ${best.name} (score ${Math.round(best.own)})`);
      if (n1 || n2) S.emptySlots = S.emptySlots.filter((x) => x !== 'Anneau'); // il n'en restait qu'un de libre
      sack = await scan();
      continue;
    }
    if (!n1 || !n2) { decide(`Anneaux : emplacements portes illisibles (${n1 ?? '?'}, ${n2 ?? '?'}), je ne touche a rien`); break; }
    const best = sack.reduce((a, b) => (b.own > a.own ? b : a));
    let slot = 0;
    if (s[1] === undefined) slot = 2; // decouverte de l'anneau 2
    else if (s[0] === undefined) slot = 1;
    else { const weak = s[0] <= s[1] ? 1 : 2; if (best.own > s[weak - 1]) slot = weak; }
    if (!slot) { decide(`Anneaux : paire optimale (${n1} ${Math.round(s[0])}, ${n2} ${Math.round(s[1])}), rien de mieux au sac (meilleur ${best.name} ${Math.round(best.own)})`); break; }
    if ((await openItem(main, items.nth(best.i)))?.name !== best.name) break; // la grille a bouge : on s'arrete proprement
    // par le texte : un title sur le bouton remplace son nom accessible
    // le jeu ne propose que les emplacements remplacables (ex. l'anneau garde au prestige est verrouille) : on se rabat sur l'autre s'il vaut le coup
    const offered = (await main.locator('button', { hasText: /^Équiper/ }).allInnerTexts().catch(() => [])).join(' ');
    const other = 3 - slot;
    if (!new RegExp(`Anneau ${slot}\\)`).test(offered) && new RegExp(`Anneau ${other}\\)`).test(offered) && (s[other - 1] === undefined || best.own > s[other - 1])) {
      decide(`Anneaux : emplacement ${slot} non remplacable (verrouille), je vise l'emplacement ${other}`);
      slot = other;
    }
    const slotBtn = main.locator('button', { hasText: new RegExp(`Anneau ${slot}\\)?\\s*$`) }).first();
    if (!(await slotBtn.isVisible().catch(() => false))) {
      const equips = await main.locator('button', { hasText: /^Équiper/ }).allInnerTexts().catch(() => []);
      decide(new RegExp(`Anneau ${other}\\)`).test(offered)
        ? `Anneaux : emplacement ${slot} verrouille, et rien au sac ne bat l'anneau remplacable (${slot === 1 ? n2 : n1})`
        : `Anneaux : bouton de l'emplacement ${slot} introuvable (boutons : ${equips.map((t) => t.replace(/\s+/g, ' ')).join(' | ') || 'aucun'}), j'arrete la`);
      break;
    }
    await slotBtn.click();
    await sleep(1500);
    const why = s[slot - 1] === undefined ? `decouverte du score de ${slot === 1 ? n1 : n2}` : `${Math.round(best.own)} > ${Math.round(s[slot - 1])}`;
    log(`EQUIPE (inventaire) Anneau ${slot}: ${best.name} (score ${Math.round(best.own)}, ${why})`);
    decide(`Anneaux : ${best.name} en emplacement ${slot} a la place de ${slot === 1 ? n1 : n2} (${why})`);
    sack = await scan();
  }
  const [n1, n2] = await worn();
  const minWorn = Math.min(scoreOf(n1) ?? -Infinity, scoreOf(n2) ?? -Infinity);
  if (Number.isFinite(minWorn)) (S.worn ??= {}).Anneau = Math.round(minWorn); // l'HDV compare au plus faible des deux
  const spare = new Set(sack.filter((r) => r.level >= S.level - CFG.spareWindow).sort((a, b) => b.own - a.own).slice(0, CFG.ringSpare));
  // vendu : hors reserve, moins bon que les deux portes, et canSell (dans le doute on garde)
  const junk = sack.filter((r) => !spare.has(r) && r.own < minWorn && canSell(r)).map((r) => [r.name, r.own - minWorn]);
  decide(`Anneaux : ${sack.length} au sac, reserve ${[...spare].map((r) => `${r.name} (${Math.round(r.own)})`).join(', ') || 'aucune'}, ${junk.length} a vendre`);
  await sellJunk(page, main, 'Anneau', junk);
}

// vend 1 exemplaire de chaque objet de la liste (vente en 2 clics : "Vendre x1" puis "Confirmer")
async function sellJunk(page, main, slot, junk) {
    for (const [name, s] of junk) {
      // meme image pour tous les tiers : on ouvre chaque candidat jusqu'a trouver le nom exact
      const cands = invItems(main).filter({ has: page.locator(`img[alt="${baseName(name).replace(/"/g, '\\"')}"]`) });
      let found = false;
      for (let k = 0; k < await cands.count() && !found; k++) found = (await openItem(main, cands.nth(k)))?.name === name;
      if (!found) { log(`ERREUR vente ${name} : introuvable dans la grille`); continue; }
      // Forgemagie : briser donne des orbes (Bouclier de forge, garde au prestige) ; on vend seulement si les kamas manquent pour l'energie
      const brk = main.locator('button', { hasText: /^Briser ×1/ }).first();
      const breakIt = CFG.breakJunk && S.kamas >= CFG.energyKamas + 3000 && !(S.forge?.left <= 0) && await brk.isEnabled().catch(() => false); // quota du jour atteint -> vente
      const sell = breakIt ? brk : main.getByRole('button', { name: /^Vendre ×1/ });
      if (!(await sell.isEnabled().catch(() => false))) continue;
      const price = (await sell.innerText()).replace(/^(Vendre|Briser) ×1 : /, '');
      await sell.click(); // 1er clic : le bouton devient "Confirmer (...)"
      const confirm = main.getByRole('button', { name: /^Confirmer/ });
      if (!(await confirm.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false))) {
        if (breakIt) { const L = ((S.learn ??= {}).forge ??= { tries: 0, ok: 0, expected: 0, broken: 0, orbsGained: 0 }); L.broken++; L.orbsGained += +(price.match(/\+(\d+) orbe/)?.[1] ?? 0); log(`BRISE ${slot}: ${name} (score ${Math.round(s)}, ${price}, sans confirmation)`); await sleep(1200); continue; } // brise en 1 clic
        log(`ERREUR vente ${name} : pas de confirmation`); continue;
      }
      await confirm.click();
      await sleep(1200);
      if (await confirm.isVisible().catch(() => false)) { log(`ERREUR vente ${name} : confirmation sans effet`); continue; }
      if (breakIt) { // apprentissage : orbes gagnes par objet brise ; quota du jour decompte
        const n = +(price.match(/\+(\d+) orbe/)?.[1] ?? 0);
        const L = ((S.learn ??= {}).forge ??= { tries: 0, ok: 0, expected: 0, broken: 0, orbsGained: 0 });
        L.broken++; L.orbsGained += n; if (S.forge && Number.isFinite(S.forge.left)) S.forge.left -= n;
      }
      log(`${breakIt ? 'BRISE' : 'VENDU'} ${slot}: ${name} (score ${Math.round(s)}, ${price})`);
    }
}

// Coffres : ouvre tout (gagnes + cadeaux), puis achete en gardant CFG.kamasReserve (epique 20k > chanceux 10k)
async function openChests(page) {
  await page.goto(BASE + '/coffres');
  await page.getByText('Boutique de coffres').waitFor({ timeout: 30000 });
  const main = page.locator('main');
  const cb = main.locator('input[type=checkbox]').first();
  if (await cb.count() && !(await cb.isChecked())) await cb.check(); // objets de ma tranche de niveau
  let opened = 0, bought = 0;
  for (let i = 0; i < 20; i++) { // coffres gagnes puis cadeaux
    const btn = main.locator('button:enabled').filter({ hasText: /^Ouvrir/ }); // coffres gagnes + cadeaux (bonus, epiques, legendaires), le premier actif
    if (!(await btn.count())) break;
    await btn.first().click();
    opened++;
    await sleep(2000);
    await page.keyboard.press('Escape').catch(() => {}); // ferme un eventuel recap
  }
  for (let i = 0; i < 10; i++) {
    const kamas = +((await main.innerText()).match(/([\d\s]+) kamas/)?.[1].replace(/\D/g, '') ?? 0);
    const tier = kamas - 20000 >= CFG.kamasReserve ? 2 : kamas - 10000 >= CFG.kamasReserve ? 1 : -1; // index dans les boutons Acheter (classique, chanceux, epique)
    if (tier < 0) { decide(`Coffres : ${opened} ouverts ; pas d'achat, il faut garder ${CFG.kamasReserve} kamas de reserve (j'en ai ${kamas})`); break; }
    decide(`Coffres : achat d'un ${tier === 2 ? 'epique (objet Epique ou mieux garanti)' : 'chanceux (raretes x3)'} car ${kamas} kamas, reserve ${CFG.kamasReserve} respectee`);
    await main.getByRole('button', { name: 'Acheter et ouvrir' }).nth(tier).click();
    bought++;
    log(`COFFRE achete ${tier === 2 ? 'epique 20k' : 'chanceux 10k'} (kamas ${kamas})`);
    await sleep(2500);
    await page.keyboard.press('Escape').catch(() => {});
  }
  if (opened || bought) log(`COFFRES ouverts ${opened}, achetes ${bought}`);
}

// Points de carac : 80 % dans la stat de l'element dominant du deck, CFG.vitShare en Vitalite
const mainStat = () => Object.entries(STAT_ELEM).map(([s, es]) => [s, es.reduce((a, e) => a + ELEM_SHARE[e], 0)]).sort((a, b) => b[1] - a[1])[0][0];
async function allocateStats(page) {
  await page.goto(BASE + '/personnage');
  await page.getByText('Caractéristiques').first().waitFor({ timeout: 30000 });
  const pts = async () => +((await page.locator('main').innerText()).match(/Points à répartir : (\d+)/)?.[1] ?? 0);
  const total = await pts();
  if (!total) return;
  const main = mainStat();
  decide(`Caracs : ${total} points, d'abord ${Math.round(CFG.vitShare * 100)} % en Vitalite, le reste en ${main} (element principal du deck)`);
  for (const [stat, want] of [['Vitalité', Math.floor(total * CFG.vitShare)], [main, Infinity]]) { // Vitalite d'abord : 1 pt fixe, la stat principale a des paliers
    if (!(await pts())) break; // les paliers de cout peuvent tout consommer sur la stat principale
    const input = page.getByLabel(`Points à ajouter en ${stat}`);
    const max = +((await input.locator('xpath=following::button[starts-with(normalize-space(), "max")][1]').innerText()).match(/\d+/)?.[0] ?? 0);
    const n = Math.min(want, max);
    if (n <= 0) continue;
    await input.fill(String(n));
    await input.locator('xpath=following::button[normalize-space()="Ajouter"][1]').click();
    await sleep(1500);
    log(`CARAC +${n} ${stat}`);
  }
}

// ---- Combat manuel. Tout est relu a l'ecran a chaque coup (main, PA, PV, bouclier, resistances, protections), les stats
// viennent de /personnage (S.stats, relues a chaque passe deck) : le jeu suit le deck et le stuff du moment.
// A chaque coup : toutes les combinaisons de cartes payables x chaque cible focus, evaluees ; on joue la 1re carte du meilleur plan puis on recalcule.
const readFight = (page) => page.locator('main').evaluate((m) => {
  const num = (s) => +String(s).replace(/\D/g, '');
  const NUMS = /^([\d\s\u00a0\u202f]+)\/([\d\s\u00a0\u202f]+)(?:·\s*([\d\s\u00a0\u202f]+) bouclier)?$/; // "1 261 / 2 210 · 442 bouclier"
  const enemies = [...m.querySelectorAll('button')].filter((b) => b.querySelector('[aria-label="Résistances"]')).map((b, i) => {
    const t = b.innerText;
    const hp = [...b.querySelectorAll('div')].map((d) => d.innerText.trim().match(NUMS)).find(Boolean) ?? [0, '0', '1', '0'];
    const res = {};
    b.querySelectorAll('[title^="Résistance"]').forEach((r) => { const x = r.title.match(/Résistance (\S+) : (-?\d+)/); if (x) res[x[1]] = +x[2]; });
    return { i, name: b.querySelector('.font-bold')?.innerText.trim() ?? '?', hp: num(hp[1]), max: num(hp[2]) || 1, res, prot: num(t.match(/Protection\s*([\d\s  ]+)/)?.[1] ?? 0) + num(hp[3] ?? 0), rage: /Rage/.test(t), boss: /BOSS/i.test(t) };
  });
  const pv = [...m.querySelectorAll('div')].map((d) => d.innerText.trim()).find((s) => /^[\d\s  ]+\/[\d\s  ]+ PV/.test(s)) ?? '0/1 PV';
  const [hp, max] = pv.split(' PV')[0].split('/').map(num);
  const hand = [...m.querySelectorAll('button')].filter((b) => b.querySelector('span[aria-label$=" PA"]')).map((b) => ({
    name: b.querySelector('.title')?.innerText.trim() ?? '?', cost: num(b.querySelector('span[aria-label$=" PA"]').getAttribute('aria-label')),
    lines: [...b.querySelectorAll('li')].map((l) => l.innerText.trim()), weapon: (b.title || '').startsWith('Ton arme'), off: b.disabled,
  }));
  const t = m.innerText;
  return {
    myTurn: /À toi de jouer/.test(t), turn: +(t.match(/Tour (\d+)/)?.[1] ?? 0), pa: +(t.match(/(\d+) PA ·/)?.[1] ?? 0), paKnown: /\d+ PA ·/.test(t), hp, max, shield: num(pv.match(/([\d\s  ]+) bouclier/)?.[1] ?? 0),
    pow: [...t.matchAll(/\+(\d+) Puissance \(\d+\)/g)].reduce((s, x) => s + +x[1], 0),
    target: t.match(/Cible : ([^\n(]+?) \(/)?.[1] ?? null, enemies, hand,
  };
});
const cardFx = (lines) => {
  const f = { dmg: [], heal: 0, healPct: 0, shieldPct: 0, shieldLvl: 0, pow: 0 };
  for (const l of lines) {
    let m;
    if ((m = l.match(/(\d+) à (\d+) (dommages|vol de vie) (Neutre|Terre|Feu|Eau|Air)/))) f.dmg.push({ avg: (+m[1] + +m[2]) / 2, elem: m[4], steal: m[3] !== 'dommages', zone: /en zone/.test(l) });
    else if ((m = l.match(/Soigne (\d+) ?% des PV max/))) f.healPct += +m[1];
    else if ((m = l.match(/Soigne (\d+) à (\d+)/))) f.heal += (+m[1] + +m[2]) / 2;
    else if ((m = l.match(/Bouclier de (\d+) ?% des PV max/))) f.shieldPct += +m[1];
    else if ((m = l.match(/Bouclier de (\d+) ?% du niveau/))) f.shieldLvl += +m[1];
    else if ((m = l.match(/\+(\d+) Puissance/))) f.pow += +m[1];
  }
  return f;
};
const NO_STATS = { Force: 0, Intelligence: 0, Chance: 0, Agilité: 0, Puissance: 0, dmg: {} };
// S.learn.k[elem] : correctif appris (degats reels / prevus), absorbe critiques et multiplicateurs inconnus
const hitOn = (d, e, pow, s) => Math.max(0, (d.avg * (1 + ((s[ELEM_STAT[d.elem]] ?? 0) + s.Puissance + pow) / 100) + (s.dmg[d.elem] ?? 0)) * (1 - (e.res[d.elem] ?? 0) / 100) * (S.learn?.k?.[d.elem] ?? 1));
// styles de jeu, choisis par UCB1 sur les combats passes (recompense : victoire, plus elle est rapide mieux c'est)
const PROFILES = {
  equilibre: { heal: [2.5, 1.2, 0.3], shield: 1.2, kill: 3 },
  agressif: { heal: [1.5, 0.6, 0.1], shield: 0.6, kill: 4 },
  prudent: { heal: [3.5, 2, 0.6], shield: 1.6, kill: 2 },
};
const pickProfile = () => {
  const L = (S.learn ??= {}).prof ??= {};
  const n = Object.values(L).reduce((a, p) => a + p.n, 0);
  const T = S.learn.train ?? {};
  const surv = (k) => (T[k]?.n ? T[k].r / T[k].n : 0.5); // survie moyenne en entrainement, 0.5 si inconnue
  return Object.keys(PROFILES).map((k) => [k, L[k]?.n ? L[k].r / L[k].n + Math.sqrt((2 * Math.log(n + 1)) / L[k].n) + 0.3 * surv(k) : Infinity]).sort((a, b) => b[1] - a[1])[0][0];
};
// entrainement (combats perdus d'avance) : recompense = tours tenus (sur 10) et part des PV ennemis infligee
const rewardTrain = (k, turns, dmgFrac) => { const p = ((S.learn ??= {}).train ??= {})[k] ??= { n: 0, r: 0, turns: 0 }; p.n++; p.turns += turns; p.r += 0.5 * Math.min(turns, 10) / 10 + 0.5 * dmgFrac; };
// pour choisir le style pendant l'entrainement : on explore, UCB sur la table d'entrainement seule
const pickTrainProfile = () => {
  const T = (S.learn ??= {}).train ??= {};
  const n = Object.values(T).reduce((a, p) => a + p.n, 0);
  return Object.keys(PROFILES).map((k) => [k, T[k]?.n ? T[k].r / T[k].n + Math.sqrt((2 * Math.log(n + 1)) / T[k].n) : Infinity]).sort((a, b) => b[1] - a[1])[0][0];
};
const rewardProfile = (k, win, turns) => { const p = ((S.learn ??= {}).prof ??= {})[k] ??= { n: 0, r: 0, w: 0 }; p.n++; p.w += win ? 1 : 0; p.r += win ? 1 - Math.min(turns, 20) / 40 : 0; };
// valeur d'un plan (cartes jouees ce tour) avec un focus pour les cartes mono-cible
// ponytail: degats ennemis estimes par ce qu'on a encaisse au tour precedent ; critiques, PM, retraits de PA ignores
// Indices de defaite (S.hints, par monstre) traduits en regles. HINT_SEED : indices connus avant leur capture automatique.
const HINT_SEED = { Phossile: 'Utiliser deux fois de suite le meme element lui renvoie les degats', 'Sphincter Cell': 'Indice : à partir du tour 4, vos soins vous blessaient au lieu de vous soigner.' };
const hintOf = (name) => {
  const all = { ...HINT_SEED, ...Object.fromEntries(Object.entries(S.hints ?? {}).map(([k, v]) => [k, v.hint])) };
  const k = Object.keys(all).find((n) => name === n || name.startsWith(n + ' ') || n.startsWith(name + ' '));
  return k ? all[k] : '';
};
// ponytail: une seule regle reconnue pour l'instant ; en ajouter une par nouvel indice capture (dump/defaite-*.txt)
const rulesOf = (name) => {
  const t = hintOf(name);
  return {
    altElem: /m[êe]me [ée]l[ée]ment/i.test(t) && /(deux fois|de suite|cons[ée]cuti|renvo)/i.test(t),
    // "a partir du tour 4, vos soins vous blessaient" : soins (et vol de vie) comptes en degats subis a partir de ce tour
    healHurtFrom: /soins?\b.*\bbless/i.test(t) ? +(t.match(/tour (\d+)/i)?.[1] ?? 1) : null,
  };
};
const elemOf = (c) => c.fx.dmg[0]?.elem ?? null;
// ordre de jeu : buffs, mono-cible, zone, soins ; si un ennemi interdit la repetition d'element, on alterne (depuis le dernier element joue)
const orderCards = (cards, st, last) => {
  const rank = (c) => (c.fx.pow ? 0 : c.fx.dmg.some((d) => !d.zone) ? 1 : c.fx.dmg.length ? 2 : 3);
  const sorted = [...cards].sort((a, b) => rank(a) - rank(b));
  if (!st.enemies.some((e) => e.hp > 0 && rulesOf(e.name).altElem)) return sorted;
  const seq = [];
  for (let prev = last; sorted.length;) {
    let k = sorted.findIndex((c) => !elemOf(c) || elemOf(c) !== prev);
    if (k < 0) k = 0;
    const [c] = sorted.splice(k, 1);
    seq.push(c); if (elemOf(c)) prev = elemOf(c);
  }
  return seq;
};
const planValue = (cards, st, focus, inc, s, P = PROFILES.equilibre, last = null) => {
  const alive = st.enemies.filter((e) => e.hp > 0);
  const left = new Map(alive.map((e) => [e.i, e.hp + e.prot]));
  const pow = st.pow + cards.reduce((a, c) => a + c.fx.pow, 0);
  let v = 0, heal = 0, prev = last;
  for (const c of cards) {
    const repeat = elemOf(c) && elemOf(c) === prev;
    if (elemOf(c)) prev = elemOf(c);
    for (const d of c.fx.dmg) for (const e of d.zone ? alive : alive.filter((x) => x.i === focus)) {
    if (repeat && rulesOf(e.name).altElem) { v -= hitOn(d, e, pow, s); continue; } // renvoye : rien pour lui, pour nous
    const done = Math.min(hitOn(d, e, pow, s), left.get(e.i));
    left.set(e.i, left.get(e.i) - done);
    v += done; if (d.steal) heal += done / 2;
    }
  }
  const threat = inc / Math.max(1, alive.length);
  for (const e of alive) if (left.get(e.i) <= 0) v += 0.25 * e.max + P.kill * threat * (e.rage ? 1.5 : 1); // tuer = moins de coups recus
  heal += cards.reduce((a, c) => a + c.fx.heal + (c.fx.healPct * st.max) / 100, 0);
  const shield = cards.reduce((a, c) => a + (c.fx.shieldPct * st.max) / 100 + (c.fx.shieldLvl * (st.level || S.level || 100)) / 100, 0);
  const danger = (st.hp + st.shield - inc) / st.max; // PV restants apres le prochain tour ennemi, en part du max
  const w = danger < 0.35 ? P.heal[0] : danger < 0.6 ? P.heal[1] : P.heal[2];
  const hurtFrom = Math.min(...alive.map((e) => rulesOf(e.name).healHurtFrom ?? Infinity));
  if ((st.turn ?? 0) >= hurtFrom) v -= 2 * heal; // soins inverses : chaque PV "soigne" est un PV perdu
  else v += w * Math.min(heal, st.max - st.hp);
  v += (danger < 0.6 ? P.shield : P.shield / 3) * Math.min(shield, Math.max(0, inc - st.shield));
  return v;
};
// meilleur plan : sous-ensembles de la main payables avec les PA (arme 1 fois/tour), x focus ; renvoie la carte a jouer en premier
const bestMove = (st, inc, s, weaponUsed, blocked, P) => {
  const hand = st.hand.filter((c) => !c.off && c.cost <= st.pa && !(c.weapon && weaponUsed) && !blocked.has(c.name)).map((c) => ({ ...c, fx: cardFx(c.lines) }));
  const alive = st.enemies.filter((e) => e.hp > 0);
  let best = { v: 0 };
  for (let mask = 1; mask < 1 << hand.length; mask++) {
    const cards = hand.filter((_, k) => mask & (1 << k));
    if (cards.reduce((a, c) => a + c.cost, 0) > st.pa) continue;
    const seq = orderCards(cards, st, fightMem.lastElem);
    for (const e of alive) { const v = planValue(seq, st, e.i, inc, s, P, fightMem.lastElem); if (v > best.v + 1e-6) best = { v, cards: seq, focus: e }; }
  }
  if (!best.cards) return null;
  const first = best.cards[0]; // deja ordonne par orderCards
  return { card: first, focus: best.focus, plan: best.cards.map((c) => c.name), v: best.v, single: first.fx.dmg.some((d) => !d.zone) };
};
let fightMem = { turn: 0, endHp: null, inc: 0, profile: null };
// joue un tour complet ; false = echec de lecture ou de clic (l'appelant repasse en Auto)
async function playTurn(page) {
  const main = page.locator('main');
  let st = await readFight(page);
  if (!st.myTurn || !st.hand.length) return false;
  const s = S.stats ?? NO_STATS;
  if (st.turn <= 1 || !fightMem.profile) fightMem = { turn: st.turn, endHp: null, inc: 0, profile: trainLeft > 0 ? pickTrainProfile() : pickProfile(), ehp0: st.enemies.reduce((a, e) => a + e.max, 0) };
  fightMem.ehp = st.enemies.reduce((a, e) => a + e.hp + e.prot, 0);
  fightMem.foes = st.enemies.map((e) => e.name); // pour ranger l'indice de defaite par monstre
  const ruled = st.enemies.filter((e) => e.hp > 0 && rulesOf(e.name).altElem).map((e) => e.name);
  const hurt = st.enemies.filter((e) => e.hp > 0 && rulesOf(e.name).healHurtFrom).map((e) => `${e.name} (tour ${rulesOf(e.name).healHurtFrom})`);
  if (hurt.length && !fightMem.hurtSaid) { fightMem.hurtSaid = true; decide(`Mecanique ${hurt.join(', ')} (indice) : plus aucun soin ni vol de vie a partir de ce tour`); }
  if (ruled.length && !fightMem.ruleSaid) { fightMem.ruleSaid = true; decide(`Mecanique ${ruled.join(', ')} (indice) : j'alterne les elements, jamais deux fois le meme de suite`); }
  fightMem.turn = st.turn;
  S.fightNow = { profile: fightMem.profile, turn: st.turn, foes: st.enemies.filter((e) => e.hp > 0).map((e) => e.name), at: Date.now() }; // tableau de bord
  const P = PROFILES[fightMem.profile];
  if (fightMem.incTurn !== st.turn) { // une seule estimation par tour, meme si le tour est joue en plusieurs appels
    const lost = fightMem.endHp == null ? 0 : Math.max(0, fightMem.endHp - (st.hp + st.shield));
    const alive0 = st.enemies.filter((e) => e.hp > 0).length;
    fightMem.inc = Math.max(lost, 0.6 * fightMem.inc, alive0 * 0.06 * st.max); // plancher : 6 % des PV max par ennemi vivant
    fightMem.incTurn = st.turn; fightMem.weapon = false;
  }
  let weaponUsed = fightMem.weapon, plays = 0, fails = 0;
  const blocked = new Set(), played = [];
  // etat stable : main a moi, PA lisibles (pendant une animation le jeu affiche "- PA"), cartes actives, 2 lectures identiques
  const settle = async (x) => {
    for (let k = 0, prev = ''; k < 40; k++) {
      const key = `${x.myTurn}|${x.pa}|${x.hand.map((c) => c.name + c.off).join()}|${x.enemies.map((e) => e.hp).join()}`;
      if (x.myTurn && x.paKnown && (x.hand.some((c) => !c.off) || x.hand.every((c) => c.cost > x.pa || c.weapon)) && key === prev) return x; // tout grise faute de PA (ou arme deja utilisee) : rien a attendre
      if (!x.enemies.some((e) => e.hp > 0) && x.enemies.length) return x; // combat gagne
      prev = key; await sleep(250); x = await readFight(page);
    }
    return x;
  };
  st = await settle(st);
  while (plays < 15) {
    const mv = bestMove(st, fightMem.inc, s, weaponUsed, blocked, P);
    if (!mv) break;
    if (mv.single && st.target !== mv.focus.name) {
      // ciblage : delai court, un ennemi momentanement desactive (animation) ne doit pas faire tomber le tour en Auto
      if (!(await main.locator('button').filter({ has: page.locator('[aria-label="Résistances"]') }).nth(mv.focus.i).click({ timeout: 4000 }).then(() => true, () => false))) { blocked.add(mv.card.name); if (++fails >= 3) return false; st = await settle(await readFight(page)); continue; }
      await sleep(400);
    }
    await sleep(rand(CFG.thinkMin, CFG.thinkMax)); // temps de reflexion
    const before = st;
    await page.locator('div.fixed button').filter({ hasText: mv.card.name }).first().click();
    let after = before;
    for (let k = 0; k < 15; k++) { await sleep(200); after = await readFight(page); if (after.pa !== before.pa || after.hand.length !== before.hand.length) break; }
    after = await settle(after); // la carte s'anime : on attend un etat stable avant le coup suivant
    if (after.pa === before.pa && after.hand.length === before.hand.length && after.myTurn) { // carte refusee (condition de lancer) : on l'ecarte pour ce tour
      blocked.add(mv.card.name);
      if (++fails >= 3) return false;
      st = after; continue;
    }
    if (mv.card.weapon) weaponUsed = fightMem.weapon = true;
    // calibrage : degats reels (PV + protection perdus) / prevus, si personne n'est mort (sinon le reel est plafonne)
    const ehp = (x) => x.enemies.reduce((a, e) => a + e.hp + e.prot, 0);
    const d0 = cardFx(mv.card.lines).dmg[0];
    if (d0 && after.enemies.every((e, k) => e.hp > 0 || before.enemies[k]?.hp <= 0)) {
      const alive = before.enemies.filter((e) => e.hp > 0);
      const k0 = S.learn?.k?.[d0.elem] ?? 1;
      const pred = cardFx(mv.card.lines).dmg.reduce((a, d) => a + (d.zone ? alive : alive.filter((x) => x.i === mv.focus.i)).reduce((b, e) => b + hitOn(d, e, before.pow, s), 0), 0) / k0;
      const real = ehp(before) - ehp(after);
      if (pred > 0 && real > 0) { const K = ((S.learn ??= {}).k ??= {}); K[d0.elem] = Math.min(3, Math.max(0.3, 0.85 * k0 + 0.15 * (real / pred))); }
    }
    if (elemOf(mv.card)) fightMem.lastElem = elemOf(mv.card);
    played.push(`${mv.card.name}${mv.single ? ' > ' + mv.focus.name : ''}`);
    plays++; st = after;
    if (!st.myTurn || !st.enemies.some((e) => e.hp > 0)) break; // combat fini
  }
  if (!played.length) writeFileSync('dump/nomove.json', JSON.stringify({ at: new Date().toISOString(), again: bestMove(st, fightMem.inc, s, weaponUsed, blocked, P)?.plan ?? null, weaponUsed, one: st.hand.map((c) => [c.name, planValue([{ ...c, fx: cardFx(c.lines) }], st, 0, fightMem.inc, s, P)]), st, s, inc: fightMem.inc, P, blocked: [...blocked], html: await main.innerHTML().catch(() => '') }, null, 1)); // diagnostic : tour sans coup
  decide(`Tour ${st.turn} manuel (${fightMem.profile}) : ${played.join(', ') || 'rien de rentable'} (reste ${st.paKnown ? st.pa : '?'} PA, PV ${st.hp}/${st.max}, degats ennemis estimes ${Math.round(fightMem.inc)})`);
  if (st.myTurn) { // toujours rendre la main, meme si la lecture des ennemis a rate
    fightMem.endHp = st.hp + st.shield;
    await main.getByRole('button', { name: 'Fin du tour' }).click();
  }
  return true;
}

const RANK = ['Facile', 'Moyen', 'Difficile', 'Très difficile'];
// plus gros groupe dont la difficulte <= maxRank, sinon le plus facile
const pickGroup = (txt, maxRank) => {
  const r = [...txt.matchAll(/Groupe \d+\n(Facile|Moyen|Difficile|Très difficile)\n/g)].map((m) => RANK.indexOf(m[1]));
  let i = -1; r.forEach((x, j) => { if (x <= maxRank && (i < 0 || x > r[i])) i = j; });
  return i >= 0 ? i : r.indexOf(Math.min(...r));
};

// zone d'entrainement : dans "Toutes les zones", celle dont le niveau max est le plus proche de CFG.trainLevel
// toutes les zones [href, niveau max, nom] triees par niveau max ; lues une fois par lancement
let ZONES = null;
async function allZones(page) {
  if (ZONES?.length) return ZONES;
  await page.goto(BASE + '/chasse');
  await page.getByRole('link', { name: /Toutes les zones/ }).click({ timeout: 20000 });
  await sleep(2500);
  ZONES = (await page.locator('a[href^="/chasse?zone="]').evaluateAll((els) => els.map((e) => [e.getAttribute('href'), e.innerText])))
    .map(([h, t]) => [h, +(t.match(/Niveau \d+[–-](\d+)/)?.[1] ?? 0), t.split('\n')[0]]).filter(([, m]) => m).sort((a, b) => a[1] - b[1]);
  return ZONES;
}
// palier de zone suivant (dir 1) ou precedent (dir -1) par niveau max ; reste sur place en bout de liste
async function climbZone(page, cur, dir, why) {
  const z = await allZones(page);
  const curMax = z.find(([h]) => h === cur)?.[1] ?? S.level;
  const next = dir > 0 ? z.find(([, m]) => m > curMax) : [...z].reverse().find(([, m]) => m < curMax);
  if (!next) { decide(`Zone : deja au ${dir > 0 ? 'plus haut' : 'plus bas'} palier (niveau max ${curMax})`); return cur; }
  decide(`Zone ${dir > 0 ? 'montee' : 'descente'} : ${next[2]} (niveau max ${next[1]}, avant ${curMax}), ${why}`);
  log(`ZONE ${dir > 0 ? 'montee' : 'descente'} ${next[2]} niv ${next[1]}`);
  return next[0];
}
async function pickHardZone(page) {
  const z = [...(await allZones(page))];
  const pick = z.sort((a, b) => Math.abs(a[1] - CFG.trainLevel) - Math.abs(b[1] - CFG.trainLevel))[0];
  if (pick) decide(`Entrainement : zone ${pick[2]} (niveau max ${pick[1]}, cible ${CFG.trainLevel}), parmi ${z.length} zones`);
  return pick?.[0];
}

async function attackGroup(page, zone, maxRank) {
  await page.goto(BASE + zone);
  await page.getByRole('button', { name: 'Attaquer' }).first().waitFor({ timeout: 20000 });
  const t = await page.locator('main').innerText();
  const en = t.match(/Énergie : (\d+)\/(\d+)/);
  if (en) setEnergy(+en[1], +en[2]);
  if (en && +en[1] <= CFG.energyReserve) { S.recharging = true; decide(`Energie ${en[1]} <= reserve ${CFG.energyReserve} : pas d'attaque, retour a l'ecran de fin pour recharger`); await page.goto(COMBAT); return; }
  const i = pickGroup(t, maxRank);
  decide(`Groupe ${i + 1} attaque : le plus gros dont la difficulte <= ${RANK[maxRank]}`);
  await page.getByRole('button', { name: 'Attaquer' }).nth(i).click();
  log(`ATTAQUE ${zone} groupe ${i + 1}`);
  return true;
}

// zones de ma tranche : easiest = niveau max le plus bas ; sinon meilleure XP = niveau max le plus haut <= mon niveau
async function pickZone(page, current, easiest) {
  await page.goto(BASE + '/chasse');
  await page.getByText('Zones de mon niveau').first().waitFor({ timeout: 20000 });
  const lvl = +((await page.locator('body').innerText()).match(/Niv\. (\d+)/)?.[1] ?? 1);
  const z = (await page.locator('a[href^="/chasse?zone="]').evaluateAll((els) => els.map((e) => [e.getAttribute('href'), e.innerText])))
    .map(([h, t]) => [h, +(t.match(/Niveau \d+–(\d+)/)?.[1] ?? 999)]).filter(([h]) => h !== current).sort((a, b) => a[1] - b[1]);
  const pick = (easiest ? z[0] : z.filter(([, m]) => m <= lvl).pop() ?? z[0]);
  if (pick) decide(`Zone ${pick[0].split('=')[1]} : ${easiest ? 'la plus facile de ma tranche' : 'meilleure XP sans depasser mon niveau'} (niv max ${pick[1]}, moi ${lvl})`);
  return pick?.[0];
}

// boss de zone (toutes les 20 min, 5 min de presence, un essai) : clique si dispo
async function tryBoss(page) {
  await page.goto(BASE + '/chasse');
  await page.getByText('Zones de mon niveau').first().waitFor({ timeout: 20000 });
  await sleep(2000); // bloc boss rendu cote client
  const b = page.getByRole('button', { name: /Affronter/ });
  if (!(await b.first().isVisible()) || !(await b.first().isEnabled())) {
    const t = await page.locator('main').innerText();
    const i = t.search(/boss/i);
    log(`BOSS indispo : ${i < 0 ? 'aucun bloc boss' : t.slice(i, i + 160).replace(/\n+/g, ' / ')}`);
    const a = t.match(/Arrive dans (?:(\d+) min)?\s*(\d+)?\s*s?/);
    const ms = a ? (+(a[1] ?? 0) * 60 + +(a[2] ?? 0)) * 1000 : 0;
    decide(ms ? `Boss pas encore la : je reviens dans ${Math.round(ms / 1000)} s, a son arrivee` : 'Boss absent : nouvelle verification dans 2 min 30');
    S.boss = { name: t.match(/BOSS DE ZONE[^\n]*\n([^\n]+)/)?.[1] ?? '?', tier: t.match(/NIVEAUX ([\d–-]+)/)?.[1] ?? '', eta: ms ? Date.now() + ms : null, live: false };
    return ms; // ms avant arrivee (0 = inconnu)
  }
  const name = (await page.locator('main').innerText()).match(/\n([^\n]+)\n[^\n]*· \d+ énergie/)?.[1] ?? 'boss';
  decide(`Boss ${name} present : je l'affronte (un seul essai par apparition)`);
  await b.first().click();
  S.boss = { ...S.boss, name, live: true, eta: null };
  log(`BOSS ${name} - combat lance`);
  return true;
}

// Arene : adversaires = persos d'autres joueurs joues par l'ordi. On defie le plus faible (opti), s'il est sous le notre.
const parseArena = (t) => ({
  elo: +(t.match(/TON ELO\n(\d+)/)?.[1] ?? 0),
  opti: +(t.match(/NIVEAU D.OPTI\n([\d\s]+)\n/)?.[1].replace(/\D/g, '') ?? 0),
  rank: t.match(/CLASSEMENT\n#?([\d\s]+)\n/)?.[1].trim() ?? '?',
  wl: t.match(/VICTOIRES \/ DÉFAITES\n([^\n]+)/)?.[1] ?? '?',
  energy: +(t.match(/tu en as (\d+)/)?.[1] ?? 0),
  opp: [...t.matchAll(/\n([^\n]+)\n\S+ niveau \d+ · Elo (\d+) · opti ([\d\s]+) ·/g)].map((m) => ({ name: m[1], elo: +m[2], opti: +m[3].replace(/\D/g, '') })),
});
async function fightArena(page) {
  await page.goto(BASE + '/arene');
  await page.getByRole('button', { name: 'Défier' }).first().waitFor({ timeout: 20000 });
  const a = parseArena(await page.locator('main').innerText());
  S.arena = { elo: a.elo, opti: a.opti, rank: a.rank, wl: a.wl, at: Date.now() };
  if (a.energy) setEnergy(a.energy); // 0 = texte non trouve
  if (a.energy < CFG.arenaMinEnergy) { decide(`Arene sautee : energie ${a.energy} sous le minimum ${CFG.arenaMinEnergy}, je la garde pour la chasse`); log(`ARENE ignoree : energie ${a.energy} < ${CFG.arenaMinEnergy}`); return false; }
  const i = a.opp.reduce((b, o, j) => (o.opti < a.opp[b].opti ? j : b), 0);
  if (!a.opp.length || a.opp[i].opti > a.opti) { decide(`Arene sautee : le plus faible des 6 (${a.opp[i]?.opti ?? '?'}) depasse mon opti ${a.opti}`); log(`ARENE ignoree : aucun adversaire sous mon opti (${a.opti})`); return false; }
  decide(`Arene : je defie ${a.opp[i].name}, le plus faible (opti ${a.opp[i].opti} contre ${a.opti})`);
  await page.getByRole('button', { name: 'Défier' }).nth(i).click();
  log(`ARENE defie ${a.opp[i].name} (opti ${a.opp[i].opti} vs ${a.opti}, Elo ${a.elo})`);
  return true;
}

// HDV : achete de quoi remplir les emplacements vides (vus par la passe inventaire), dans le budget au-dessus de la reserve
// ponytail: emplacements vides seulement, l'HDV ne montre pas de comparaison avec la piece portee
const parseHdvRows = (t) => [...t.matchAll(/\n([^\n]+)\nNiveau (\d+) · vendu par [^\n]*\n([\d\s]+) K\n(Acheter|Trop cher)/g)]
  .map((m, idx) => ({ idx, raw: m[1], name: m[1].replace(/ · Rayonnant$/, ''), level: +m[2], price: +m[3].replace(/\D/g, ''), buyable: m[4] === 'Acheter' }));
// HDV (prix bas, pas d'economie) : pour chaque emplacement au score connu, l'annonce de mon niveau au meilleur gain par kama
// gain = score brut de l'annonce - score de la piece portee (S.worn, 0 si vide) ; seuil : +10 % de la piece ou +10
// panneau de detail d'une annonce : "Nom\nRARETE\nEmplacement\nNiveau N\n+stats..." jusqu'a l'annonce suivante ; null si absent
const hdvStats = (t, name) => {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = t.match(new RegExp(`\\n${esc}(?: · Rayonnant)?\\n(?:COMMUN|PEU COMMUN|RARE|ÉPIQUE|MYTHIQUE|LÉGENDAIRE)\\n[^\\n]+\\nNiveau \\d+\\n([\\s\\S]*?)(?=\\n[^\\n]+\\nNiveau \\d+ · vendu par|$)`));
  return m ? m[1] : null;
};
async function hdvBuy(page) {
  if (Date.now() < (S.hdvBrokenUntil ?? 0)) { decide(`HDV saute : achat en panne cote site (bouton Acheter sans effet), nouvel essai vers ${new Date(S.hdvBrokenUntil).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`); return 0; }
  let bought = 0; const seenRows = []; // seenRows : diagnostic dump/hdv_eval.txt
  const slots = [...new Set([...(S.emptySlots ?? []), ...Object.keys(S.worn ?? {})])].filter((s) => SLOTS.includes(s));
  for (const slot of slots) {
    const worn = S.emptySlots?.includes(slot) ? 0 : S.worn?.[slot] ?? 0;
    const budget = S.kamas - CFG.kamasReserve;
    if (budget <= 0) { log(`HDV : budget nul (reserve ${CFG.kamasReserve})`); return; }
    await page.goto(BASE + '/hdv');
    await page.getByRole('button', { name: 'Filtrer' }).waitFor({ timeout: 20000 });
    const main = page.locator('main');
    await main.locator('select').first().selectOption({ label: slot });
    await page.getByRole('button', { name: 'Filtrer' }).click();
    await sleep(2500);
    const all = parseHdvRows('\n' + await main.innerText());
    seenRows.push(`${slot} : ${all.length} annonces, ${all.filter((x) => x.buyable && x.level <= S.level && x.price <= budget).length} dans niveau+budget (niv ${S.level}, budget ${budget})`);
    // ligne = plus proche ancetre du nom qui contient un bouton Acheter / Trop cher (n-ieme si le nom se repete)
    const rowOf = (r) => main.getByText(r.raw, { exact: true }).nth(all.filter((x) => x.raw === r.raw && x.idx < r.idx).length)
      .locator('xpath=ancestor::*[.//button[normalize-space()="Acheter" or normalize-space()="Trop cher"]][1]');
    let best = null;
    for (const r of all.filter((x) => x.buyable && x.level <= S.level && x.price <= budget).sort((a, b) => a.price - b.price).slice(0, 15)) {
      const row = rowOf(r);
      await row.locator('button:has(img)').first().click().catch(() => {}); // ouvre les stats de l'objet
      await sleep(600);
      const rt = hdvStats(await main.innerText(), r.name); // les stats s'affichent dans un panneau a part, pas dans la ligne
      const s = (rt == null ? -Infinity : scoreItem(rt)) - worn; // gain sur la piece portee ; seules les lignes "+N Stat" comptent
      seenRows.push(`${slot} | ${r.name} niv ${r.level} ${r.price} K -> ${Math.round(s)} | ${(rt ?? 'panneau introuvable').replace(/\n/g, ' / ').slice(0, 160)}`);
      if (s >= Math.max(10, 0.1 * Math.abs(worn)) && (!best || s / r.price > best.s / best.r.price)) best = { r, s };
    }
    if (!best) { decide(`HDV ${slot} : rien de mieux que ma piece (score ${worn}) dans mon niveau sous ${Math.round(budget / 1000)} k`); continue; }
    decide(`HDV ${slot} : ${best.r.name} niv ${best.r.level}, +${Math.round(best.s)} sur ma piece (${worn}) pour ${best.r.price} K, meilleur gain par kama`);
    const kamasHdv = async () => +((await main.innerText()).match(/\n([\d\s  ]+) kamas\n/)?.[1].replace(/\D/g, '') ?? NaN);
    const k0 = await kamasHdv();
    const buyBtn = rowOf(best.r).getByRole('button', { name: 'Acheter', exact: true });
    const nBtn = await buyBtn.count();
    const posts = [];
    const onResp = async (r) => { if (r.request().method() === 'POST') posts.push(`${r.status()} ${r.url().slice(-60)} :: ${(await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600)}`); };
    page.on('response', onResp);
    await buyBtn.first().click();
    await sleep(2500);
    page.off('response', onResp);
    // la confirmation peut etre une modale hors de main : on cherche dans toute la page
    const after = `${await page.locator('body > *:not(main)').allInnerTexts().then((a) => a.join(' | ')).catch(() => '')}\n--- boutons hors main: ${await page.locator('button:visible').evaluateAll((els) => els.filter((e) => !e.closest('main')).map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | '))}`;
    const ok = page.getByRole('button', { name: /^(Confirmer|Oui|Valider|Payer)/ });
    if (await ok.first().waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await ok.first().click();
    await sleep(1500);
    const k1 = await kamasHdv();
    if (!(k1 < k0)) { // pas debite : achat rate, on garde la trace de ce que la page a affiche
      writeFileSync('dump/hdv_buy.txt', `${best.r.name} ${best.r.price} K | boutons Acheter dans la ligne: ${nBtn} | kamas ${k0} -> ${k1} | enabled ${await buyBtn.first().isEnabled().catch(() => '?')}\n\nPOST au clic (${posts.length}):\n${posts.join('\n')}\n\nApres clic:\n${after.slice(0, 1500)}`);
      log(`HDV achat rate ${slot}: ${best.r.name} (${best.r.price} K), kamas ${k0} -> ${k1}, voir dump/hdv_buy.txt - HDV en pause 6 h`);
      S.hdvBrokenUntil = Date.now() + 6 * 3600000; // bug du site (06/10 : clic Acheter sans requete, meme a la main) : on ne perd pas de temps
      break;
      continue;
    }
    S.kamas = k1;
    log(`HDV achat ${slot}: ${best.r.name} niv ${best.r.level} (gain +${Math.round(best.s)}, ${best.r.price} K, kamas ${k0} -> ${k1})`);
    bought++;
  }
  writeFileSync('dump/hdv_eval.txt', seenRows.join('\n'));
  return bought;
}

if (process.argv[2] === 'test') {
  const assert = (await import('node:assert')).strict;
  const AR = parseArena('TON ELO\n985\nNIVEAU D’OPTI\n2 302\nadversaires\nCLASSEMENT\n#6145\nVICTOIRES / DÉFAITES\n0 / 1\nDeck\nPawmi\nEcaflip niveau 91 · Elo 1001 · opti 2 486 · 1V / 1D\nDéfier\nPad\nFéca niveau 71 · Elo 978 · opti 2 036 · 4V / 6D\nDéfier\nChaque défi coûte 2 points d’énergie (tu en as 148).');
  assert.deepEqual([AR.elo, AR.opti, AR.rank, AR.energy, AR.opp.length, AR.opp[1].name, AR.opp[1].opti], [985, 2302, '6145', 148, 2, 'Pad', 2036]);
  const HR = parseHdvRows('\nFiltrer\nYugoufle\nNiveau 41 · vendu par Hadu\n300 K\nAcheter\n★\nKompost · Rayonnant\nNiveau 60 · vendu par Ouateu\n1 500 K\nTrop cher');
  assert.deepEqual(HR.map((r) => [r.name, r.level, r.price, r.buyable]), [['Yugoufle', 41, 300, true], ['Kompost', 60, 1500, false]]);
  assert.equal(hdvStats('\nFiltrer\nSac du Récolteur\nNiveau 15 · vendu par T\n300 K\nAcheter\nSac du Récolteur\nRARE\nCape\nNiveau 15\n+400 Pods\n+20 Vitalité\nYugoufle\nNiveau 41 · vendu par H\n300 K\nAcheter', 'Sac du Récolteur'), '+400 Pods\n+20 Vitalité');
  assert.ok(scoreItem('Comparé à X\n+1 PM\n+10 Vitalité\n+10 Sagesse\n+10 Puissance\n-3 Dommages\n+2% Résistance Terre\n-4 Tacle') > 0);
  assert.ok(scoreItem('Comparé à X\n-40 Vitalité\n-10 Sagesse\n-25 Intelligence\n+60 Agilité\n+1% Critique\n+4 Dommages\n-5 Dommages Feu') < 30);
  assert.ok(scoreItem('Comparé à X\n-1 PA\n+50 Vitalité') < 0);
  assert.equal(scoreItem('Vendre · 1 440 K\nNiveau 72 requis'), 0);
  const P = parseStats('\nForce\n45 (0 +45)\nIntelligence\n25 (0 +25)\nChance\n70 (0 +70)\nAgilité\n65 (0 +65)\nTerre\t4\t0 %\nFeu\t8\t0 %\nEau\t9\t0 %\nPuissance 85 · Soins 0');
  assert.deepEqual([P.Force, P.Chance, P.Puissance, P.dmg.Eau], [45, 70, 85, 9]);
  { // combat manuel : PV pleins -> pas de soin, budget PA respecte, Feu (point faible) prefere
    const card = (name, cost, lines, weapon = false) => ({ name, cost, lines, weapon, off: false });
    const st = { pa: 9, hp: 2717, max: 2717, shield: 0, pow: 0, target: 'El Piko', enemies: [{ i: 0, name: 'El Piko', hp: 3287, max: 3287, prot: 657, rage: false, res: { Neutre: 30, Terre: 20, Feu: 15, Eau: 25, Air: 20 } }],
      hand: [card('Cubitus', 2, ['14 à 16 vol de vie Eau']), card('Secourisme', 2, ['Soigne 23% des PV max']), card('Eau-de-vie', 2, ['Soigne 22 à 24 (Eau)', '22 à 24 dommages Eau — en zone']), card('Ferveur', 2, ['Bouclier de 50% du niveau (2 tours)', '16 à 19 dommages Eau — en zone']), card('Parafuso', 3, ['21 à 24 vol de vie Eau — en zone']), card('Bâton du Shamansot', 4, ['18 à 25 dommages Feu', '4 à 7 vol de vie Eau'], true)] };
    const s = { ...NO_STATS, Chance: 200, Intelligence: 50, Puissance: 50, dmg: {} };
    const mv = bestMove(st, 300, s, false, new Set(), PROFILES.equilibre);
    const cost = mv.plan.reduce((a, n) => a + st.hand.find((c) => c.name === n).cost, 0);
    assert.ok(mv && !mv.plan.includes('Secourisme') && cost <= 9 && cost >= 8, JSON.stringify(mv?.plan));
    { const stP = { ...st, enemies: [{ ...st.enemies[0], name: 'Phossile' }] };
      const seq = orderCards(['Boliche', 'Bâton du Shamansot', 'Cubitus'].map((n) => ({ ...stP.hand.find((c) => c.name === n) ?? card(n, 3, ['29 à 32 dommages Eau']), fx: cardFx((stP.hand.find((c) => c.name === n) ?? { lines: ['29 à 32 dommages Eau'] }).lines) })), stP, null);
      assert.ok(seq.every((c, k) => !k || elemOf(c) !== elemOf(seq[k - 1])), seq.map((c) => c.name).join()); // Eau, Feu, Eau
    }
    { // Sphincter Cell : soins inverses a partir du tour 4
      const stS = { ...st, hp: 600, enemies: [{ ...st.enemies[0], name: 'Sphincter Cell' }] };
      const heal = [{ ...card('Secourisme', 2, ['Soigne 23% des PV max']), fx: cardFx(['Soigne 23% des PV max']) }];
      assert.ok(planValue(heal, { ...stS, turn: 2 }, 0, 900, s) > 0 && planValue(heal, { ...stS, turn: 5 }, 0, 900, s) < 0);
    }
    const hurt = bestMove({ ...st, hp: 600 }, 900, s, false, new Set(), PROFILES.equilibre);
    assert.ok(hurt.plan.includes('Secourisme'), JSON.stringify(hurt.plan)); // en danger : soin
  }
  assert.deepEqual(parseForge('Bouclier de forge · niveau 1\n+1 % de stats sur tout ton équipement\nNiveau 1 / 200\nOrbes d’amélioration\n12\nEncore 1 488 orbes à gagner aujourd’hui\nNiveau 1 → 2 : 1 orbe par essai, 100 % de réussite'), { level: 1, orbs: 12, left: 1488, cost: 1, rate: 100, bonus: 1 });
  const it = { fav: false, rarity: 'COMMUN', name: 'Coiffe Bouftou', partial: false };
  assert.deepEqual([canSell(it), canSell({ ...it, rarity: 'RARE' }), canSell({ ...it, name: 'Coiffe Bouftou · Tiers 2' }), canSell({ ...it, name: 'Gelano' }), canSell({ ...it, partial: true }), canSell({ ...it, fav: true })], [true, false, false, false, false, false]);
  setEnergy(0, 200); S.energyAt -= 2.5 * REGEN; assert.equal(energyNow(), 2);
  spendEnergy(1); assert.equal(energyNow(), 1); S.energyAt -= 0.5 * REGEN; assert.equal(energyNow(), 2); // le point en cours de recharge est garde
  setEnergy(199); S.energyAt -= 5 * REGEN; assert.equal(energyNow(), 200);
  assert.deepEqual(parseJeu('Ouvrir un coffre\nÉnergie\n1/100\n\n+1 dans 2 min 13 · 1 par combat, 2 en arène\n\nAcheter (300 K le point, encore 1000 aujourd’hui) :\n+1 · 300 K'),{ e: 1, max: 100, next: 133000, price: 300, left: 1000 });
  assert.equal(parseCard('4 Ronces Agressives 24 à 27 dommages Terre RARE').name, 'Ronces Agressives');
  assert.equal(parseCard('3\nTornabombe\nBombe : 20 à 22 dommages Air\nRARE').name, 'Tornabombe');
  assert.equal(parseCard('1 Tirs Puissants +100 Puissance (1 tour) +10 % Critique (1 tour) CLASSE').dmg, null);
  assert.equal(parseCard('3 Flèche Glacée -2 PA à la cible 12 à 14 dommages Eau COMMUN').name, 'Flèche Glacée');
  const deck = ['1 Tirs Puissants +100 Puissance', '3 Roulage de Pelle 11 à 13 dommages Feu', ...Array.from({ length: 8 }, (_, i) => `3 C${i} 20 à 22 dommages Terre`)].map(parseCard);
  const got = chooseDeck(deck, [parseCard('3 Pillage Vole 40 Chance (3 tours) 17 à 19 vol de vie Eau ÉPIQUE')], P);
  assert.ok(got.includes('Tirs Puissants') && got.includes('Pillage') && !got.includes('Roulage de Pelle') && got.length === 10);
  const KW = 'Kwakoiffe de Terre\nCOMMUN\nChapeau\nNiveau 41\nPanoplie : X\n+20 Vitalité\n+30 Force\n\nExemplaires : 1\n\nÉquiper à la place de Casque Noix\nComparé à Casque Noix\n-20 Vitalité\n+10 Sagesse\n+30 Force\n-35 Chance\n-15 Puissance\n+5% Résistance Terre\n-5 Fuite\nFusionner 3 → Tiers 2 (1/3)\nVendre au marchand';
  ELEM_SHARE = { Neutre: 0, Terre: 0, Feu: 0, Eau: 1, Air: 0 };
  assert.ok(invScore(KW) < 0); // deck Eau : perdre 35 Chance est mauvais
  ELEM_SHARE = { Neutre: 0, Terre: 1, Feu: 0, Eau: 0, Air: 0 };
  assert.ok(invScore(KW) > 0); // deck Terre : +30 Force vaut le coup
  assert.ok(invScore('X\nNiveau 41\n+20 Vitalité\n+30 Force\n\nExemplaires : 1') > 0); // slot libre
  ELEM_SHARE = { Neutre: 0, Terre: 0.25, Feu: 0, Eau: 0.75, Air: 0 }; assert.equal(mainStat(), 'Chance');
  assert.ok(inWindow(600, 540, 60) && inWindow(30, 540, 60) && !inWindow(120, 540, 60) && inWindow(600, 540, 1200) && !inWindow(1300, 540, 1200));
  const PD = parseDetail('Initiative\n2\n4\nFUSION\n2\n★\nClique sur un objet\n★\nAnneau Zest\nRARE\nAnneau\nNiveau 70\n+30 Vitalité\n+20 Chance\n\nExemplaires : 2 · revente 900 K\n\nÉquiper à la place de Bague de Boufbowl\nComparé à Bague de Boufbowl\n+10 Vitalité\n-5 Chance\nFusionner 3');
  assert.deepEqual([PD.name, PD.fav, PD.rarity, PD.slot, PD.level, PD.cmp], ['Anneau Zest', true, 'RARE', 'Anneau', 70, 'Bague de Boufbowl']);
  assert.ok(sameSlot('Trophée', 'Dofus / Trophée') && !sameSlot('Anneau', 'Chapeau'));
  assert.ok(PD.own > PD.diff && PD.diff > 0);
  const G = 'Groupe 1\nMoyen\nA\nGroupe 2\nDifficile\nB\nGroupe 3\nTrès difficile\nC\n';
  assert.deepEqual([pickGroup(G, 0), pickGroup(G, 1), pickGroup(G, 2), pickGroup(G, 3)], [0, 0, 1, 2]);
  console.log('scoreItem + deck + groupe ok'); process.exit(0);
}

// ---- Tableau de bord : http://127.0.0.1:7777 (dashboard.html + API JSON) ----
let logCache = { key: '', data: null };
const parseLog = () => {
  const txt = existsSync('bot.log') ? readFileSync('bot.log', 'utf8') : '';
  const key = txt.length + ':' + Math.floor(Date.now() / 60000); // + minute : les barres horaires glissent meme sans nouvelle ligne
  if (key === logCache.key) return logCache.data;
  const now = Date.now(), H = 3600000;
  const d = { wins: 0, losses: 0, bossWins: 0, bossLosses: 0, arenaWins: 0, arenaLosses: 0, fusions: 0, bought: 0, boughtK: 0, xp: 0, kamas: 0, sold: 0, soldK: 0, chests: 0, chestsBought: 0, equips: 0, presence: 0,
    hours: Array.from({ length: 24 }, () => ({ xp: 0, kamas: 0, wins: 0, losses: 0 })), feed: [] };
  for (const l of txt.split(/\r?\n/)) { // \r\n toleres (log reecrit sous Windows)
    const m = l.match(/^(\S+Z) (.*)$/);
    if (!m) continue;
    const t = Date.parse(m[1]), msg = m[2], ago = Math.floor((now - t) / H), b = ago < 24 ? d.hours[23 - ago] : null;
    let g;
    if ((g = msg.match(/^(BOSS |ARENE )?(VICTOIRE|DEFAITE)(?: \+(\d+) XP \+(\d+) kamas)?/))) {
      const win = g[2] === 'VICTOIRE', xp = +(g[3] ?? 0), k = +(g[4] ?? 0);
      if (g[1] === 'BOSS ') win ? d.bossWins++ : d.bossLosses++; else if (g[1]) win ? d.arenaWins++ : d.arenaLosses++; else win ? d.wins++ : d.losses++;
      d.xp += xp; d.kamas += k;
      if (b) { b.xp += xp; b.kamas += k; win ? b.wins++ : b.losses++; }
    } else if ((g = msg.match(/^VENDU .*, ([\d\s]+) K\)$/))) { d.sold++; d.soldK += +g[1].replace(/\D/g, ''); }
    else if ((g = msg.match(/^COFFRES ouverts (\d+), achetes (\d+)/))) { d.chests += +g[1]; d.chestsBought += +g[2]; }
    else if ((g = msg.match(/^HDV achat .*, (\d+) K\)$/))) { d.bought++; d.boughtK += +g[1]; }
    else if (/^FUSION/.test(msg)) d.fusions++;
    else if (/^EQUIPE/.test(msg)) d.equips++;
    else if (/^PRESENCE/.test(msg)) d.presence++;
    if (/^(EQUIPE|VENDU|COFFRE|DECK|CARAC|FUSION|HDV achat|ARENE|BOSS (VICTOIRE|DEFAITE)|BOSS .* lance|AVENTURE|TROP|ACTION)/.test(msg)) d.feed.push([t, msg]);
  }
  d.feed = d.feed.slice(-60).reverse();
  d.tail = txt.trimEnd().split(/\r?\n/).slice(-200);
  logCache = { key, data: d };
  return d;
};
// en-tete du jeu : "Nom", puis "Niv. 72 · 26 690 K"
const readHeader = (text) => {
  const hd = text.match(/([^\n]+)\nNiv\. (\d+) · ([\d\s]+) K/);
  if (hd) Object.assign(S, { name: hd[1].trim(), level: +hd[2], kamas: +hd[3].replace(/\D/g, '') });
};
function startDashboard(page) {
  let shot = { t: 0, buf: null, p: null };
  http.createServer(async (req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      if (req.url === '/') return send(200, 'text/html; charset=utf-8', readFileSync('dashboard.html'));
      if (req.url === '/api/state') return send(200, 'application/json', JSON.stringify(snapshot()));
      // debug lecture seule : texte + controles de la page courante du bot (sans la toucher)
      if (req.url === '/api/dom') return send(200, 'text/plain; charset=utf-8', page.url() + '\n\n' + (await page.locator('main').innerText().catch(() => '')) + '\n\n=== CONTROLS\n' + (await page.locator('main').locator('button, a, input, select, label').evaluateAll((els) => els.map((e) => `${e.tagName}${e.type ? '[' + e.type + ']' : ''}${e.checked ? ' [x]' : ''}${e.disabled ? ' [disabled]' : ''} "${(e.innerText || e.value || '').replace(/\s+/g, ' ').slice(0, 80)}" ${e.title || e.getAttribute('aria-label') || ''} .${(e.className || '').toString().slice(0, 60)}`).join('\n')).catch((er) => er.message)));
      if (req.url === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`retry: 1000\ndata: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.url.startsWith('/api/shot')) {
        if (Date.now() - shot.t > 2500 && !shot.p) { // une seule capture a la fois, meme avec plusieurs onglets ouverts
          shot.p = page.screenshot({ type: 'jpeg', quality: 55, timeout: 8000 }).then((b) => { shot.buf = b; shot.t = Date.now(); }, () => {}).finally(() => { shot.p = null; });
        }
        if (shot.p && !shot.buf) await shot.p;
        return shot.buf ? send(200, 'image/jpeg', shot.buf) : send(503, 'text/plain', 'indispo');
      }
      if (req.method === 'POST' && req.url.startsWith('/api/action/')) {
        const a = req.url.slice(12);
        if (!ACTION_NAMES.includes(a)) return send(400, 'text/plain', 'action inconnue');
        if (!S.queue.includes(a)) S.queue.push(a);
        return send(200, 'application/json', JSON.stringify({ queue: S.queue }));
      }
      if (req.method === 'POST' && req.url === '/api/pause') { S.paused = !S.paused; log(S.paused ? 'PAUSE (tableau de bord)' : 'REPRISE (tableau de bord)'); return send(200, 'application/json', JSON.stringify({ paused: S.paused })); }
      if (req.method === 'POST' && req.url === '/api/config') {
        let body = '';
        for await (const c of req) body += c;
        const inp = JSON.parse(body);
        for (const [k, [, lo, hi]] of Object.entries(CFG_SPEC)) if (inp[k] !== '' && Number.isFinite(+inp[k])) CFG[k] = Math.min(hi, Math.max(lo, +inp[k])); // cles connues, bornees
        writeFileSync('config.json', JSON.stringify(CFG, null, 2));
        log('CONFIG ' + JSON.stringify(CFG));
        return send(200, 'application/json', JSON.stringify(CFG));
      }
      send(404, 'text/plain', 'introuvable');
    } catch (e) { send(500, 'text/plain', e.message); }
  }).listen(7777, '127.0.0.1');
}

// Plage horaire (CFG.scheduleOn, activeFrom -> activeTo, peut passer minuit) et plafond de combats par heure glissante.
// Hors plage ou plafond atteint : le bot attend sur l'ecran de fin, sans aucune requete, et reprend seul.
async function gate() {
  let said = '';
  for (;;) {
    const d = new Date(), mins = d.getHours() * 60 + d.getMinutes();
    fightTimes = fightTimes.filter((t) => Date.now() - t < 3600000);
    S.fightsHour = fightTimes.length;
    const off = CFG.scheduleOn && !inWindow(mins, CFG.activeFrom, CFG.activeTo);
    const capped = CFG.maxFightsPerHour > 0 && fightTimes.length >= CFG.maxFightsPerHour;
    // energie : a la reserve (gardee pour le boss), recharge jusqu'a energyResume ; le boss annonce passe des qu'il y a ses 2 points
    const e = energyNow(), resume = Math.max(CFG.energyResume, CFG.energyReserve + 1);
    if (e != null && e <= CFG.energyReserve) S.recharging = true;
    if (S.recharging && (e == null || e >= resume)) S.recharging = false;
    if (!off && !capped && S.recharging && e >= 2 && S.boss?.eta && Date.now() > S.boss.eta + 5000) return; // la boucle ne fait que le boss pendant la recharge
    if (!off && !capped && S.recharging && canBuyEnergy()) return; // la boucle retente l'achat (reglage active ou kamas revenus)
    if (!off && !capped && !S.recharging) { S.resumeAt = null; if (said) decide(`Reprise : ${said === 'nrj' ? `energie a ${e}` : 'dans la plage horaire et sous le plafond'}`); return; }
    if (off) {
      const wait = ((CFG.activeFrom - mins + 1440) % 1440) * 60000;
      S.status = 'repos'; S.resumeAt = Date.now() + wait;
      if (said !== 'off') { decide(`Hors plage horaire (${hhmm(CFG.activeFrom)} -> ${hhmm(CFG.activeTo)}) : arret jusqu'a ${hhmm(CFG.activeFrom)}`); log(`REPOS jusqu'a ${hhmm(CFG.activeFrom)}`); said = 'off'; }
    } else if (!capped) {
      S.status = 'recharge'; S.resumeAt = S.energyAt + (resume - S.energy) * REGEN;
      if (said !== 'nrj') { decide(`Energie ${e} <= reserve ${CFG.energyReserve} (gardee pour le boss) : recharge 1 point / 6 min, reprise a ${resume} points vers ${new Date(S.resumeAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`); log(`ENERGIE ${e} - recharge jusqu'a ${resume}`); said = 'nrj'; }
    } else {
      S.status = 'plafond'; S.resumeAt = fightTimes[0] + 3600000;
      if (said !== 'cap') { decide(`Plafond atteint : ${fightTimes.length} combats sur la derniere heure (max ${CFG.maxFightsPerHour}), reprise vers ${new Date(S.resumeAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`); log(`PLAFOND ${fightTimes.length}/h`); said = 'cap'; }
    }
    push();
    await sleep(15000);
  }
}
// achat retente au plus toutes les 5 min pendant une recharge ; ponytail: prix 300 K le point en dur ici, buyEnergy relit le vrai prix
const canBuyEnergy = () => CFG.energyBuy && (S.kamas - 3000 >= CFG.energyKamas || Date.now() - (S.last.venteEnergie ?? 0) > 1800000) && Date.now() - (S.last.energie ?? 0) > 300000;
// a la reserve : lit l'energie exacte, et si CFG.energyBuy, achete +10 sans toucher a energyKamas ; kamas trop justes : passe de vente d'abord (30 min mini entre deux)
// max (bouton du tableau de bord) : le plein, autant que les kamas le permettent
async function buyEnergy(page, max = false, sold = false) {
  await page.goto(BASE + '/jeu', { waitUntil: 'networkidle' });
  await page.getByText(/^Acheter \(/).waitFor({ timeout: 20000 });
  await sleep(2000); // clic ignore tant que la page n'est pas hydratee
  const read = async () => { const j = parseJeu(await page.locator('main').innerText()); if (j) { setEnergy(j.e, j.max); if (j.next) S.energyAt -= REGEN - j.next; } return j; };
  const j = await read();
  if (max) {
    const b = page.locator('button', { hasText: /\(max\) ·/ });
    if (!(await b.count())) { decide(`Energie ${j?.e}/${j?.max} : pas de bouton max (plein ou pas assez de kamas)`); return; }
    const label = (await b.innerText()).replace(/\s+/g, ' ');
    decide(`Energie max demandee depuis le tableau de bord : ${label}`);
    await b.click();
    await sleep(3000);
    await page.reload({ waitUntil: 'networkidle' }); await page.getByText(/^Acheter \(/).waitFor({ timeout: 20000 }).catch(() => {});
    const after = await read();
    log(after?.e > j.e ? `ENERGIE achetee (${label}) : ${after.e}/${after.max}` : `ENERGIE achat sans effet (${label}, ${after?.e ?? '?'}/${j.max})`);
    return;
  }
  if (!j || j.e > CFG.energyReserve) return;
  if (!CFG.energyBuy) { decide(`Energie ${j.e}/${j.max} : achat coupe (reglage), j'attends la recharge`); return; }
  if (j.left >= 10 && S.kamas - 10 * j.price < CFG.energyKamas && !sold && Date.now() - (S.last.venteEnergie ?? 0) > 1800000) {
    S.last.venteEnergie = Date.now();
    decide(`Energie ${j.e}/${j.max} : ${S.kamas} K, trop juste pour +10 (reserve ${CFG.energyKamas} K) : je vends les objets inutiles d'abord`);
    await safe('inventaire', equipFromInventory(page));
    return buyEnergy(page, false, true);
  }
  if (j.left < 10 || S.kamas - 10 * j.price < CFG.energyKamas) { decide(`Energie ${j.e}/${j.max} : pas d'achat (${S.kamas} K, reserve energie ${CFG.energyKamas} K, quota ${j.left})`); return; }
  decide(`Energie ${j.e}/${j.max} : j'achete +10 (${10 * j.price} K), il reste ${S.kamas - 10 * j.price} K (reserve energie ${CFG.energyKamas} K)`);
  await page.locator('button', { hasText: /^\+10 ·/ }).click(); // nom accessible = aria-label "3 000 kamas", d'ou hasText
  const ok = page.getByRole('button', { name: /^Confirmer/ });
  if (await ok.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await ok.click();
  await sleep(3000);
  await page.reload({ waitUntil: 'networkidle' }); await page.getByText(/^Acheter \(/).waitFor({ timeout: 20000 }).catch(() => {});
  const after = await read();
  if (after?.e > j.e) { S.kamas -= 10 * j.price; log(`ENERGIE achetee +10 (${10 * j.price} K) : ${after.e}/${after.max}`); }
  else log(`ENERGIE achat sans effet (${after?.e ?? '?'}/${j.max})`);
}

// Inventaire du site : pour chaque onglet du menu, boutons et listes (nombres masques), diff avec le releve precedent.
// Le 1er releve sert de reference ; ensuite chaque nouvel onglet/bouton est signale (log MAJ SITE, decision, alerte) et la page sauvegardee.
let siteScanDue = false;
async function siteScan(page) {
  await page.goto(BASE + '/');
  await sleep(2500);
  const nav = await page.locator('header a[href^="/"], nav a[href^="/"]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('href')))]).catch(() => []);
  const map = {};
  for (const p of nav.filter((x) => x !== '/' && !/deconnexion|logout|combat/i.test(x))) {
    await page.goto(BASE + p).catch(() => {});
    await sleep(2500);
    const later = page.getByRole('button', { name: 'Plus tard', exact: true });
    if (await later.isVisible().catch(() => false)) await later.click().catch(() => {});
    map[p] = await page.locator('main').locator('button, select, input').evaluateAll((els) => [...new Set(els.map((e) => (e.innerText || e.value || e.getAttribute('aria-label') || e.title || '').replace(/\s+/g, ' ').trim().replace(/\d[\d\s.,]*/g, '#').slice(0, 60)).filter((t) => t && t.length > 1))]).catch(() => []);
    writeFileSync(`dump/site${p.replace(/\W/g, '_')}.txt`, await page.locator('main').innerText().catch(() => ''));
  }
  const old = S.siteMap;
  S.siteMap = map;
  if (!old) { decide(`Site : releve de reference fait (${Object.keys(map).length} onglets)`); return; }
  const changes = [];
  for (const [p, btns] of Object.entries(map)) {
    if (!old[p]) changes.push(`nouvel onglet ${p}`);
    else { const nb = btns.filter((b) => !old[p].includes(b)); if (nb.length) changes.push(`${p} : ${nb.slice(0, 8).join(', ')}`); }
  }
  if (!changes.length) { decide('Site mis a jour : aucun nouvel onglet ni bouton'); return; }
  log(`MAJ SITE nouveautes : ${changes.join(' | ').slice(0, 600)}`);
  decide(`Mise a jour du site : ${changes.join(' | ').slice(0, 400)} (pages dans dump/site_*.txt)`);
  alert('mise a jour du site : nouveaux onglets/boutons, voir le tableau de bord');
}

// Forgemagie. Page lue a chaque visite (parseForge) : niveau du bouclier, orbes, quota du jour, cout et reussite annonces de l'essai.
// Apprentissage dans S.learn.forge : essais / reussites reels (compares a l'annonce), objets brises et orbes gagnes.
// Strategie : un echec ne coute jamais de niveau -> on depense toutes les orbes ("10 essais" si assez, sinon essai par essai).
async function forgeUpgrade(page) {
  await page.goto(BASE + '/forgemagie');
  await page.getByText('Bouclier de forge').first().waitFor({ timeout: 20000 });
  await sleep(1500);
  const read = async () => (S.forge = { ...parseForge(await page.locator('main').innerText()), at: Date.now() });
  const L = ((S.learn ??= {}).forge ??= { tries: 0, ok: 0, expected: 0, broken: 0, orbsGained: 0 });
  const f0 = await read();
  for (let k = 0; k < 40; k++) {
    const f = S.forge;
    if (f.orbs < f.cost) break;
    const ten = page.getByRole('button', { name: /10 essais/ });
    const one = page.getByRole('button', { name: /^Améliorer/ });
    const b = f.orbs >= 10 * f.cost && (await ten.isEnabled().catch(() => false)) ? ten : (await one.isEnabled().catch(() => false)) ? one : null;
    if (!b) break;
    await b.click();
    await sleep(1800);
    const g = await read();
    const tries = Math.max(0, Math.round((f.orbs - g.orbs) / f.cost));
    if (!tries) break; // rien ne s'est passe
    L.tries += tries; L.ok += Math.max(0, g.level - f.level); L.expected += (tries * f.rate) / 100;
  }
  const f1 = S.forge;
  const real = L.tries ? `reussite reelle ${L.ok}/${L.tries} (annoncee ~${Math.round((100 * L.expected) / L.tries)} %)` : 'pas encore d\'essai';
  if (f1.level !== f0.level) { log(`FORGE bouclier niveau ${f0.level} -> ${f1.level} (+${f1.bonus} % stats), ${real}`); decide(`Forgemagie : bouclier niveau ${f0.level} -> ${f1.level}, +${f1.bonus} % sur tout l'equipement ; ${real}`); }
  else decide(`Forgemagie : bouclier niveau ${f1.level} (+${f1.bonus} %), ${f1.orbs} orbe(s), essai a ${f1.cost} orbe(s) : rien a depenser`);
}

// Forgemagie (06/10) : la 1re visite donne le Bouclier de forge ; page sauvegardee pour coder son usage ensuite
async function visitForge(page) {
  await page.goto(BASE + '/forgemagie');
  await sleep(4000);
  const later = page.getByRole('button', { name: 'Plus tard', exact: true });
  if (await later.isVisible().catch(() => false)) await later.click().catch(() => {});
  const t = await page.locator('main').innerText().catch(() => '');
  const ctrls = await page.locator('main').locator('button, a, input, select').evaluateAll((els) => els.map((e) => `${e.tagName}${e.disabled ? ' [disabled]' : ''} "${(e.innerText || e.value || '').replace(/\s+/g, ' ').slice(0, 90)}" ${e.title || ''}`)).catch(() => []);
  writeFileSync('dump/forgemagie.txt', `${page.url()}\n\n${t}\n\n=== CONTROLS\n${ctrls.join('\n')}`);
  S.last.forge = Date.now();
  log(`FORGE visitee (${page.url()}) : ${t.match(/Bouclier de forge[^\n]*/)?.[0] ?? 'page sauvegardee dans dump/forgemagie.txt'}`);
  decide('Forgemagie : 1re visite faite (Bouclier de forge), page sauvegardee pour la suite');
}

// Coffres d'abord (nouveaux objets/cartes), puis deck, stuff, caracs ; au demarrage et tous les CFG.passEvery combats
async function managePass(page) {
  S.status = 'gestion';
  decide('Passe de gestion : coffres, puis deck, puis stuff (equiper, fusionner, vendre), HDV, caracs');
  await safe('coffres', openChests(page));
  await safe('deck', optimizeDeck(page));
  await safe('inventaire', equipFromInventory(page));
  if ((await safe('hdv', hdvBuy(page))) > 0) await safe('inventaire', equipFromInventory(page)); // equipe les achats tout de suite
  await safe('carac', allocateStats(page));
  for (const k of ['coffres', 'deck', 'inventaire', 'hdv', 'carac']) S.last[k] = Date.now();
  if (!ZONES) await safe('zones', allZones(page)); // niveaux des zones pour le garde-fou (une fois par lancement)
  if (!S.last.forge) await safe('forge', visitForge(page)); // 1re visite : Bouclier de forge offert
  else await safe('forge', forgeUpgrade(page));
  await page.goto(COMBAT);
}

// Fenetre visible + profil persistant : login manuel une seule fois, et c'est toi qui reponds au test de presence.
const ctx = await chromium.launchPersistentContext('profile', { headless: false, viewport: null });
const page = ctx.pages()[0] ?? await ctx.newPage();
startDashboard(page);
await page.route(/\/img\//, (route) => (blockable(route.request().url()) ? route.abort() : route.continue()));
page.on('request', (r) => { if (!r.url().startsWith(BASE)) return; if (blockable(r.url())) { NET.blocked++; return; } /* bloquee : jamais envoyee */ const k = netKind(r); NET.total++; NET.by[k]++; NET.recent.push([Date.now(), k]); });
page.on('response', (r) => { if (r.status() === 429 && r.url().startsWith(BASE)) NET.r429++; });
// enregistreur de debug (fichier "record" present) : clics et POST vers dump/record.txt, pour copier un geste fait a la main
await page.addInitScript(() => document.addEventListener('click', (e) => { const b = e.target.closest('button, a') ?? e.target; console.log('REC click ' + b.outerHTML.replace(/\s+/g, ' ').slice(0, 400)); }, true));
page.on('console', (m) => { if (existsSync('record') && m.text().startsWith('REC ')) appendFileSync('dump/record.txt', `${new Date().toISOString()} ${m.text()}\n`); });
page.on('request', (r) => { if (existsSync('record') && r.method() === 'POST' && r.url().startsWith(BASE)) appendFileSync('dump/record.txt', `${new Date().toISOString()} POST ${r.url()} next-action=${r.headers()['next-action'] ?? '-'} body=${(r.postData() ?? '').slice(0, 600)}\n`); });
// limiteur : avant chaque navigation, attend si le plafond de requetes/min est atteint
const rawGoto = page.goto.bind(page);
page.goto = async (...a) => {
  if (netLastMin() >= CFG.maxReqPerMin) {
    NET.throttled++;
    decide(`Limiteur : ${netLastMin()} requetes la derniere minute (plafond ${CFG.maxReqPerMin}), j'attends avant de charger une page`);
    const prev = S.status; S.status = 'throttle';
    while (netLastMin() >= CFG.maxReqPerMin) await sleep(3000);
    S.status = prev;
  }
  return rawGoto(...a);
};
page.on('load', () => setTimeout(() => page.locator('body').innerText().then(readHeader, () => {}), 1500));
// mise a jour du site = nouvel id de deploiement Next (dpl=... dans les scripts) -> inventaire des onglets/boutons au prochain ecran de fin
page.on('load', () => setTimeout(() => page.evaluate(() => [...document.scripts].map((s) => s.src.match(/dpl=([\w-]+)/)?.[1]).find(Boolean) ?? null).then((d) => {
  if (d && d !== S.dpl) { if (S.dpl) { siteScanDue = true; log(`MAJ SITE detectee (deploiement ${S.dpl} -> ${d})`); } else siteScanDue = !S.siteMap; S.dpl = d; }
}, () => {}), 2000)); // nom/niveau/kamas aussi pendant les passes
await page.goto(COMBAT);

if (page.url().includes('/connexion')) {
  console.log('Connecte-toi dans la fenetre...');
  while (page.url().includes('/connexion')) await sleep(1000);
  await sleep(2000);
  await page.goto(COMBAT);
}

await managePass(page);

let autoClicked = false, presenceAlerted = false, idleSince = Date.now(), lastText = '', combats = 0;
let zone = null, results = [], strikes = 0, winsSinceStrike = 0, fight = null, lastBoss = 0, nextBossCheck = 0, lastArena = 0; // fight : null | 'boss' | 'arene'
let endHandled = false, deckDue = false, stuck = 0, huntLeft = 0, backToAdventure = false;
let clickFails = []; // clics expires recents (fenetre inconnue)
// XP hard (bouton) : plus gros groupes, palier suivant a chaque victoire, 1re defaite -> un cran plus bas puis montee normale
let xpHard = false;
const grpRank = () => (xpHard ? 3 : strikes ? 0 : CFG.maxGroup);
let paced = false, throwChecked = false; // rythme : ecart deja fait sur cet ecran de fin ; abandon deja tire pour ce combat
let trainLeft = 0, trainZone = null, climbStreak = 0, climbDir = 0, climbHist = [], lastLevel = 0; // entrainement demande depuis le tableau de bord
let fightTimes = []; // fins de combat de la derniere heure (plafond)
let energyText = ''; // ecran de fin deja traite pour "Plus assez d'energie" (le message reste affiche apres la recharge)
// actions lancables depuis le tableau de bord (true = un combat a ete lance)
const ACTIONS = {
  coffres: openChests, deck: optimizeDeck, inventaire: equipFromInventory, hdv: hdvBuy, carac: allocateStats, arene: fightArena, boss: tryBoss, energie: (p) => buyEnergy(p, true), forge: forgeUpgrade, xphard: async () => { xpHard = true; S.xpHard = true; climbHist = []; climbStreak = 0; decide('XP hard : plus gros groupes, palier de zone suivant a chaque victoire, jusqu\'a la premiere defaite'); log('XP HARD demarre'); return false; }, entrainement: async () => { trainLeft = CFG.trainFights; trainZone = null; decide(`Entrainement demande : ${CFG.trainFights} combats vers le niveau ${CFG.trainLevel}, en manuel`); return false; },
  zone: async (p) => { zone = (await pickZone(p, zone, true)) ?? zone; await attackGroup(p, zone, 0); return true; },
  aventure: async (p) => { huntLeft = 0; await p.goto(BASE + '/aventure'); await p.locator('button', { hasText: ADV_FIGHT }).first().click({ timeout: 20000 }); return true; },
};
while (true) {
  try {
  if (page.url().includes('/connexion')) {
    log('SESSION EXPIREE - arret');
    alert('session expiree, relance run.cmd et reconnecte-toi');
    await ctx.close();
    process.exit(2);
  }
  // fenetres d'annonce (ex. "Rejoins le Discord !" pour la Forgemagie) : elles recouvrent la page et bloquent les clics -> "Plus tard"
  const later = page.getByRole('button', { name: 'Plus tard', exact: true });
  if (await later.isVisible().catch(() => false)) { await later.click().catch(() => {}); log('ANNONCE fermee (Plus tard)'); await sleep(800); idleSince = Date.now(); continue; }
  if (S.queue[0] === 'f5') { S.queue.shift(); log('ACTION f5 (tableau de bord)'); await page.goto(COMBAT); idleSince = Date.now(); continue; }
  if (S.paused) { S.status = 'pause'; await sleep(1000); idleSince = Date.now(); continue; }
  const text = await page.locator('body').innerText().catch(() => '');
  if (text !== lastText) { lastText = text; idleSince = Date.now(); } // la page bouge = pas bloque
  readHeader(text);
  // prestige (retour niveau 1, sorts et inventaire perdus) : on oublie zone, compteurs et anneaux, passe de gestion, aventure depuis le debut
  if (lastLevel && S.level && S.level < lastLevel - 5) {
    log(`PRESTIGE detecte (niveau ${lastLevel} -> ${S.level}) - zone, compteurs et anneaux remis a zero`);
    decide(`Prestige : niveau ${lastLevel} -> ${S.level}. Je repars de zero : zone de mon niveau, deck et stats relus, aventure depuis le debut`);
    zone = null; trainZone = null; trainLeft = 0; results = []; strikes = 0; winsSinceStrike = 0; climbStreak = 0; climbDir = 0;
    huntLeft = 0; backToAdventure = false; deckDue = true; S.rings = {}; S.stats = null;
    if (!S.queue.includes('aventure')) S.queue.push('aventure');
  }
  if (S.level) lastLevel = S.level;
  Object.assign(S, { huntLeft, zone, strikes, status: 'combat' });

  // rate-limit de l'hebergeur (o2switch) : on respecte, pause 5 min
  if (/HTTP 429|Slow down/.test(text)) { S.status = 'rate-limit'; decide('Serveur sature (429) : pause 5 min pour ne pas aggraver'); log('RATE LIMIT 429 - pause 5 min'); await sleep(300000); await page.goto(COMBAT).catch(() => {}); idleSince = Date.now(); continue; }

  // ecran d'inactivite ("Tu etais inactif", place liberee, progression sauvegardee) : pas un controle anti-bot, juste un slot rendu.
  // On attend d'avoir le droit de jouer (energie, plage horaire) puis on recharge la page pour reprendre sa place, sans cliquer dedans.
  if (/Tu étais inactif|ta place a été libérée/i.test(text)) {
    log('INACTIVITE - place liberee, je reprends des que je peux jouer');
    decide('Ecran d\'inactivite (place liberee) : j\'attends de pouvoir jouer puis je recharge la page pour reprendre ma place');
    S.status = 'presence';
    await gate();
    await page.goto(COMBAT).catch(() => {});
    autoClicked = false; idleSince = Date.now();
    continue;
  }
  // test de presence : on previent et on attend l'humain, on ne clique jamais dedans
  if (/Es-tu toujours là|toujours là \?|es-tu là|clique sur (le|la)|captcha|anti-?bot|vérification humaine|prouve que/i.test(text)) {
    S.status = 'presence';
    if (!presenceAlerted) {
      decide('Test de presence : je ne clique jamais dedans, j\'attends le tien');
      log('PRESENCE demandee - en attente de toi');
      alert('test de presence, clique dans la fenetre'); await page.bringToFront().catch(() => {}); presenceAlerted = true;
    }
    idleSince = Date.now();
    await sleep(2000);
    continue;
  }
  presenceAlerted = false;

  const next = page.getByRole('button', { name: 'Suivant en auto' });
  const endBtn = page.getByRole('button', { name: /^(Suivant en auto|Refaire ce combat|Étape suivante|Réessayer en auto|Réessayer l.étape|Retour.*|Continuer|Chasse libre|Autres groupes de la zone)$/ });
  const adventure = /Voir le Chemin/.test(text);
  if (/Victoire !|Défaite/.test(text) && !/À toi de jouer/.test(text) && (fight || await endBtn.first().isVisible().catch(() => false))) { // boss/arene : ecran de fin peut-etre sans bouton connu
    if (!endHandled) {
    endHandled = true;
    paced = false; throwChecked = false;
    if (++combats % CFG.passEvery === 0) deckDue = true;
    const win = /Victoire !/.test(text) && !/Défaite/.test(text);
    const num = (s) => s.replace(/\D/g, '');
    const g = text.match(/\+([\d\s]+?) XP\s*\+([\d\s]+?) kamas/);
    S.combats = combats;
    fightTimes.push(Date.now());
    spendEnergy(fight === 'boss' || fight === 'arene' ? 2 : 1);
    log(`${fight ? fight.toUpperCase() + ' ' : ''}${win ? 'VICTOIRE' : 'DEFAITE'} ${g ? `+${num(g[1])} XP +${num(g[2])} kamas` : 'gains=0'}`);
    const zl = await page.getByRole('link', { name: 'Autres groupes de la zone' }).getAttribute('href', { timeout: 1000 }).catch(() => null);
    // garde-fou : jamais une zone plus de 20 niveaux au-dessus de moi hors entrainement (ex. apres un prestige)
    const zlMax = ZONES?.find(([zh]) => zh === zl)?.[1];
    if (zl?.startsWith('/chasse?zone=') && (fight === 'entrainement' || !zlMax || zlMax <= S.level + 20)) zone = zl;
    // aventure perdue : deck revu + XP en chasse avant de retenter
    // ponytail: 40 victoires fixe ; a rendre progressif si l'etape bloque encore apres
    if (adventure && !win) { decide(`Aventure perdue : deck revu, puis ${CFG.huntWins} victoires en chasse avant de retenter`); huntLeft = CFG.huntWins; deckDue = true; log('AVENTURE bloquee - deck revu, ' + CFG.huntWins + ' victoires en chasse puis retente'); }
    else if (!adventure && !fight) {
      results.push(win); if (results.length > 10) results.shift(); winsSinceStrike = win ? winsSinceStrike + 1 : 0;
      // vise targetWin (pas 100 %) : sur les 20 derniers, au-dessus on monte, sous la cible -10 pts on redescend ; climbWins combats mini entre deux changements
      if (xpHard) {
        if (win) climbDir = 1;
        else { climbDir = -1; xpHard = false; S.xpHard = false; climbHist = []; climbStreak = 0; decide('XP hard : premiere defaite, je redescends d\'un palier et je reprends la montee normale (taux vise)'); log('XP HARD termine - defaite, palier precedent'); }
      } else if (CFG.climbWins) {
        climbHist.push(win); if (climbHist.length > 20) climbHist.shift();
        const rate = climbHist.filter(Boolean).length / climbHist.length;
        S.climb = { rate, n: climbHist.length }; // tableau de bord
        if (++climbStreak >= CFG.climbWins && climbHist.length >= CFG.climbWins) {
          if (rate > CFG.targetWin) { climbDir = 1; climbStreak = 0; climbHist = []; }
          else if (rate < CFG.targetWin - 0.1) { climbDir = -1; climbStreak = 0; climbHist = []; }
        }
      }
      if (win && huntLeft > 0 && --huntLeft === 0) backToAdventure = true;
    }
    if (winsSinceStrike >= 30) strikes = 0;
    if (!win) { // l'ecran de defaite donne un indice sur la mecanique du monstre : texte complet en dump, indice au log et dans S.hints
      writeFileSync(`dump/defaite-${Date.now()}.txt`, text);
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const i = lines.findIndex((l) => /indice|astuce|conseil|m[ée]canique|faiblesse|pense [àa]/i.test(l));
      const hint = i >= 0 ? lines[i] : null; // pas d'indice (ex. arene) : rien a retenir
      const foes = fightMem.foes?.join(', ') || '?';
      if (hint) {
      for (const f of fightMem.foes ?? []) (S.hints ??= {})[f] = { hint, at: Date.now(), with: foes };
      log(`INDICE (${foes}) ${hint.slice(0, 300)}`);
      decide(`Defaite contre ${foes} : indice du jeu "${hint.slice(0, 200)}"`);
      } else decide(`Defaite contre ${foes} : pas d'indice affiche`);
    }
    if (fight === 'entrainement' && fightMem.profile) {
      const dmgFrac = fightMem.ehp0 ? Math.max(0, Math.min(1, 1 - fightMem.ehp / fightMem.ehp0)) : 0;
      rewardTrain(fightMem.profile, fightMem.turn, dmgFrac);
      const t = S.learn.train[fightMem.profile];
      trainLeft = Math.max(0, trainLeft - 1);
      decide(`Entrainement (${fightMem.profile}) : ${win ? 'victoire' : 'defaite'}, tenu ${fightMem.turn} tours, ${Math.round(dmgFrac * 100)} % des PV ennemis ; moyenne du style ${(t.turns / t.n).toFixed(1)} tours sur ${t.n} essais ; reste ${trainLeft}`);
      log(`ENTRAINEMENT ${fightMem.profile} ${fightMem.turn} tours ${Math.round(dmgFrac * 100)} %`);
      fightMem = { turn: 0, endHp: null, inc: 0, profile: null };
    }
    if (fightMem.profile) { rewardProfile(fightMem.profile, win, fightMem.turn); const p = S.learn.prof[fightMem.profile]; decide(`Style ${fightMem.profile} : ${win ? 'victoire' : 'defaite'} en ${fightMem.turn} tours (${p.w}/${p.n} gagnes)`); fightMem = { turn: 0, endHp: null, inc: 0, profile: null }; }
    if (fight === 'boss') S.boss = { ...S.boss, live: false, last: win ? 'victoire' : 'defaite' };
    if (fight === 'arene') S.arena = { ...S.arena, last: win ? 'victoire' : 'defaite' };
    S.mode = fight ?? (adventure ? 'aventure' : 'chasse');
    fight = null;
    // objets droppes : equipe si emplacement libre ou meilleur score que la piece portee
    for (const btn of await page.getByRole('button', { name: 'Équiper', exact: true }).all()) {
      const card = btn.locator('xpath=ancestor::*[contains(., "Comparé à") or contains(., "libre")][1]');
      const t = await card.innerText().catch(() => '');
      const lines = t.split('\n'), li = lines.findIndex((l) => / · niv\. \d+/.test(l));
      const name = li > 0 ? lines[li - 1] : '?';
      const score = /libre/.test(t) ? Infinity : scoreItem(t);
      decide(score > 0 ? `Butin ${name} : meilleur que ma piece (score ${score}), je l'equipe` : `Butin ${name} : moins bon (score ${Math.round(score)}), je garde ma piece`);
      if (score > 0) { await btn.click(); log(`EQUIPE ${name} (score ${score})`); await sleep(2000); }
      else log(`GARDE ${name} (score ${score})`);
    }
    }
    autoClicked = false; idleSince = Date.now();
    if (/Plus assez d.énergie/.test(text) && text !== energyText) { energyText = text; setEnergy(0); }
    if (energyNow() != null && energyNow() <= CFG.energyReserve && (!S.recharging || canBuyEnergy())) { await safe('energie', buyEnergy(page)); S.last.energie = Date.now(); await page.goto(COMBAT); } // gate() passe en recharge si rien n'a ete achete
    if (!paced) { // une fois par ecran de fin : ecart aleatoire, parfois une vraie pause (< 10 min, sinon la place est liberee)
      paced = true;
      if (Math.random() < CFG.breakChance) {
        const ms = rand(CFG.breakMin, CFG.breakMax) * 60000;
        S.status = 'repos'; S.resumeAt = Date.now() + ms;
        decide(`Pause aleatoire de ${Math.round(ms / 60000)} min`); log(`PAUSE aleatoire ${Math.round(ms / 60000)} min`);
        await sleep(ms);
        S.resumeAt = null;
      }
      await sleep(rand(CFG.gapMin, CFG.gapMax) * 1000);
    }
    await gate(); // plage horaire + plafond de combats/heure, avant de lancer quoi que ce soit
    idleSince = Date.now();

    // actions demandees depuis le tableau de bord, executees ici entre deux combats
    let started = false;
    while (S.queue.length && !started) {
      const a = S.queue.shift();
      log(`ACTION ${a} (tableau de bord)`);
      S.last[a] = Date.now();
      decide(`Action demandee depuis le tableau de bord : ${a}`);
      const r = a === 'gestion' ? await managePass(page) : await safe(a, ACTIONS[a](page));
      if (r === true && (a === 'boss' || a === 'arene')) { fight = a; if (a === 'boss') lastBoss = Date.now(); }
      started = r === true && ['boss', 'arene', 'zone', 'aventure'].includes(a);
    }
    if (started) continue;

    // boss toutes les ~2.5 min de verif, un seul essai par apparition
    if (Date.now() > nextBossCheck && Date.now() - lastBoss > 360000) {
      const r = await tryBoss(page);
      S.last.boss = Date.now();
      if (r === true) { fight = 'boss'; lastBoss = Date.now(); continue; }
      nextBossCheck = Date.now() + (r > 0 ? r + 5000 : 150000); // juste apres l'arrivee annoncee, sinon dans 2.5 min
    }
    if (S.recharging) { if (page.url() !== COMBAT) await page.goto(COMBAT); await sleep(1000); continue; } // recharge : rien d'autre que le boss, attente sur l'ecran de fin
    // arene toutes les CFG.arenaEvery minutes, si assez d'energie et un adversaire plus faible
    if (CFG.arenaEvery > 0 && Date.now() - lastArena > CFG.arenaEvery * 60000) {
      lastArena = S.last.arene = Date.now();
      if ((await safe('arene', fightArena(page))) === true) { fight = 'arene'; continue; }
    }
    // trop de defaites : deck revu + groupe facile ; si ca recommence, zone plus facile
    if (results.filter((w) => !w).length >= CFG.defeatThreshold) {
      results = []; strikes++; winsSinceStrike = 0;
      decide(`${CFG.defeatThreshold} defaites sur 10 : deck revu, groupe facile${strikes >= 2 ? ', et zone plus facile' : ''}`);
      log(`TROP DE DEFAITES (palier ${strikes}) - deck revu, groupe facile${strikes >= 2 ? ', zone plus facile' : ''}`);
      await safe('deck', optimizeDeck(page));
      if (strikes >= 2 || !zone) zone = (await pickZone(page, zone, true)) ?? zone;
      await attackGroup(page, zone, 0);
      continue;
    }
    if (climbDir && zone && !adventure) { // chasse : on monte tant qu'on gagne, on redescend a la premiere defaite
      zone = await climbZone(page, zone, climbDir, xpHard ? 'XP hard, victoire' : `taux de victoire ${climbDir > 0 ? 'au-dessus de' : 'sous'} la cible ${Math.round(CFG.targetWin * 100)} %`);
      climbDir = 0;
      await attackGroup(page, zone, grpRank());
      continue;
    }
    if (siteScanDue) { siteScanDue = false; await safe('site', siteScan(page)); await page.goto(COMBAT).catch(() => {}); continue; }
    if (trainLeft > 0 && CFG.manualFight) {
      trainZone ??= await pickHardZone(page);
      if (trainZone && (await safe('entrainement', attackGroup(page, trainZone, 3))) === true) { fight = 'entrainement'; continue; }
      if (!trainZone) { decide('Entrainement annule : aucune zone trouvee'); trainLeft = 0; }
    }
    if (deckDue) { decide(`Passe de gestion : coffres, deck, stuff, HDV, caracs (tous les ${CFG.passEvery} combats ou apres une defaite)`); deckDue = false; await managePass(page); continue; }
    if (backToAdventure) {
      backToAdventure = false;
      decide(`${CFG.huntWins} victoires de rattrapage faites : je retente l'etape d'aventure`);
      await page.goto(BASE + '/aventure');
      await page.locator('button', { hasText: ADV_FIGHT }).first().click({ timeout: 20000 });
      log('AVENTURE - retente l\'etape');
      continue;
    }
    if (adventure && huntLeft > 0) {
      decide(`Rattrapage XP : encore ${huntLeft} victoires en chasse avant l'aventure`);
      zone = (await pickZone(page, null, false)) ?? zone;
      await attackGroup(page, zone, grpRank());
      continue;
    }
    if (page.url() !== COMBAT) { await page.goto(COMBAT); continue; } // apres boss/deck, revient a l'ecran de fin
    const step = page.getByRole('button', { name: 'Étape suivante', exact: true });
    if (CFG.manualFight && await step.isVisible().catch(() => false)) { // "Suivant en auto" lancerait le combat en Auto
      decide('Combat suivant en manuel : Etape suivante');
      await step.click(); autoClicked = false; await sleep(3000);
    } else if (CFG.manualFight && zone) {
      await attackGroup(page, zone, grpRank());
    } else if (await next.isVisible().catch(() => false)) {
      decide(`Rien a faire : combat suivant en Auto (passe dans ${CFG.passEvery - (combats % CFG.passEvery)} combats)`);
      await sleep(1000 + Math.random() * 2000);
      await next.click();
      autoClicked = true; // "Suivant en auto" lance le combat suivant deja en Auto
      await sleep(3000);
    } else if (zone) {
      await attackGroup(page, zone, grpRank());
    } else { // pas de bouton connu (fin d'arene ?) : retour en chasse dans la zone XP
      zone ??= await pickZone(page, null, false);
      await attackGroup(page, zone, grpRank());
    }
    continue;
  }
  endHandled = false; // plus sur un ecran de fin : le prochain sera un nouveau combat

  const auto = page.getByRole('button', { name: 'Auto', exact: true });
  if (!autoClicked && /À toi de jouer/.test(text) && await auto.isEnabled().catch(() => false)) {
    // defaites volontaires (loseRate) : chasse seulement, tire une fois au tour 1, exclues du taux de victoire et de l'apprentissage
    if (!throwChecked && !fight && S.mode === 'chasse' && +(text.match(/Tour (\d+)/)?.[1] ?? 0) === 1) {
      throwChecked = true;
      if (Math.random() < CFG.loseRate) {
        await sleep(rand(CFG.thinkMin, CFG.thinkMax));
        const dialogs = [];
        const onDialog = (dg) => { dialogs.push(dg.message()); dg.accept().catch(() => {}); }; // confirmation native : Playwright la refuse par defaut
        page.on('dialog', onDialog);
        await page.getByRole('button', { name: 'Fuir', exact: true }).click().catch(() => {});
        await sleep(1500);
        const ok = page.getByRole('button', { name: /^(Confirmer|Oui|Abandonner)/ }).last();
        if (await ok.isVisible().catch(() => false)) await ok.click().catch(() => {});
        await sleep(1500);
        page.off('dialog', onDialog);
        writeFileSync('dump/fuir.txt', `dialogues: ${dialogs.join(' | ') || 'aucun'}\nboutons: ${await page.locator('button:visible').allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, ' ')).join(' | ')).catch(() => '')}\n\n${(await page.locator('body').innerText().catch(() => '')).slice(0, 1500)}`);
        fight = 'abandon';
        decide(`Defaite volontaire (${Math.round(CFG.loseRate * 100)} % des combats) : je fuis ce combat`);
        log('ABANDON volontaire - fuite');
        idleSince = Date.now();
        await sleep(2000);
        continue;
      }
    }
    if (CFG.manualFight && (await safe('combat', playTurn(page))) === true) idleSince = Date.now(); // tour joue ; le suivant reviendra ici
    else {
      if (CFG.manualFight) { log('COMBAT manuel en echec - passe en Auto pour ce combat'); fightMem.profile = null; }
      await sleep(1000 + Math.random() * 2000);
      await auto.click();
      autoClicked = true;
      idleSince = Date.now();
    }
  }

  // serveur en vrac ou rien ne bouge depuis 30 s : F5
  if (/Application error|Internal Server Error|Bad Gateway|Something went wrong|This page couldn.t load/i.test(text) || Date.now() - idleSince > 30000) {
    log('BLOQUE - rechargement');
    decide(stuck % 2 ? 'Page figee depuis 30 s : je relance un combat via la zone' : 'Page figee depuis 30 s : F5');
    if (++stuck % 2 === 0) { // 2e blocage : relance un combat via la zone (zone la plus facile si inconnue)
      zone ??= await pickZone(page, null, true).catch(() => null);
      if (zone) await safe('attaque', attackGroup(page, zone, grpRank()));
    }
    else await page.goto(COMBAT).catch(() => {});
    autoClicked = false; idleSince = Date.now();
  }
  await sleep(1000);
  } catch (e) {
    log('ERREUR ' + e.message.split('\n')[0]);
    // 2 clics expires en 3 min : sans doute une fenetre inconnue par-dessus la page (anti-AFK, annonce) -> capture + alerte, on ne clique pas dedans
    if (/Timeout/.test(e.message)) {
      clickFails = clickFails.filter((t) => Date.now() - t < 180000); clickFails.push(Date.now());
      if (clickFails.length >= 2) {
        clickFails = [];
        const ts = Date.now();
        await page.screenshot({ path: `dump/bloque-${ts}.png` }).catch(() => {});
        writeFileSync(`dump/bloque-${ts}.txt`, `${page.url()}\n\n${await page.locator('body').innerText().catch(() => '')}\n\n=== BOUTONS VISIBLES\n${await page.locator('button:visible').allInnerTexts().then((a) => a.map((x) => x.replace(/\s+/g, ' ')).join('\n')).catch(() => '')}`);
        log(`BLOQUE fenetre inconnue ? capture dump/bloque-${ts}.png/txt`);
        decide(`Clics bloques 2 fois : une fenetre inconnue recouvre peut-etre la page, capture dans dump/bloque-${ts}.png, verifie la fenetre du bot`);
        alert('clics bloques : fenetre inconnue (anti-AFK ?), regarde la fenetre du bot'); await page.bringToFront().catch(() => {});
      }
    }
    await sleep(5000); await page.goto(COMBAT).catch(() => {}); autoClicked = false; idleSince = Date.now();
  }
}
