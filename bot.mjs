import { chromium } from 'playwright';
import { appendFileSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { exec } from 'node:child_process';
import http from 'node:http';

const BASE = 'https://dofusmasters.houk.fr', COMBAT = BASE + '/combat';
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
  scheduleOn: [0, 0, 1], activeFrom: [540, 0, 1439], activeTo: [60, 0, 1439], maxFightsPerHour: [0, 0, 600], energyReserve: [2, 0, 1000], energyResume: [6, 1, 1000], energyBuy: [0, 0, 1] }; // energie : reserve gardee pour le boss, reprise apres recharge // horaires en minutes depuis minuit ; 0 combat/h = illimite // [defaut, min, max] ; arenaEvery en min, 0 = arene coupee
const CFG = { ...Object.fromEntries(Object.entries(CFG_SPEC).map(([k, [d]]) => [k, d])), ...(existsSync('config.json') ? JSON.parse(readFileSync('config.json', 'utf8')) : {}) };
// Energie : 1 point / 6 min. Lue sur les pages de zone et d'arene, decomptee a chaque combat (chasse/aventure 1, boss/arene 2), estimee entre deux.
const REGEN = 360000;
const setEnergy = (n, max) => { S.energy = n; S.energyAt = Date.now(); if (max) S.energyMax = max; };
const energyNow = () => (S.energy == null ? null : Math.min(S.energyMax ?? Infinity, S.energy + Math.floor((Date.now() - (S.energyAt ?? Date.now())) / REGEN)));
// rebase sans perdre le point en cours de recharge
const spendEnergy = (n) => { if (S.energy == null) return; const e = energyNow(), at = S.energyAt ?? Date.now(); S.energyAt = Date.now() - (Date.now() - at) % REGEN; S.energy = Math.max(0, e - n); };
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
const KEEP = ['arena', 'boss', 'deck', 'elem', 'energy', 'energyAt', 'energyMax','emptySlots', 'last', 'decisions', 'rings'];
try { Object.assign(S, JSON.parse(readFileSync('state.json', 'utf8'))); } catch {}
setInterval(() => writeFileSync('state.json', JSON.stringify(Object.fromEntries(KEEP.map((k) => [k, S[k]])))), 10000);
const alert = (m) => { process.stdout.write('\x07'); exec(`msg * "dofus-bot: ${m}"`); };
const ACTION_NAMES = ['gestion', 'coffres', 'deck', 'inventaire', 'hdv', 'carac', 'arene', 'boss', 'energie', 'zone', 'aventure', 'f5'];
// horaires en minutes depuis minuit ; une plage peut passer minuit (ex. 540 -> 60 = 09:00 -> 01:00)
const inWindow = (m, a, b) => a === b || (a < b ? m >= a && m < b : m >= a || m < b);
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const safe = (name, p) => p.catch((e) => log(`ERREUR ${name} ` + e.message.split('\n')[0] + ' | ' + (e.message.match(/waiting for (.+)/)?.[1] ?? '').slice(0, 160))); // + l'element vise

// Poids des stats pour comparer un objet a celui porte. Reglage : adapte Force/Intelligence/Chance/Agilite a ton element.
const WEIGHTS = {
  'PA': 100, 'PM': 60, 'Portée': 30, 'Invocation': 10,
  'Vitalité': 1, 'Puissance': 1.5, 'Sagesse': 0.3, // Force/Intel/Chance/Agi : selon le deck (ELEM_SHARE)
  'Dommages': 5, 'Critique': 4, 'Soins': 2, 'Dommages Critiques': 2,
  'Tacle': 0.3, 'Fuite': 0.3, 'Esquive PA': 0.5, 'Esquive PM': 0.5, 'Retrait PA': 0.5, 'Retrait PM': 0.5, 'Prospection': 0.3, 'Initiative': 0.05,
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
  const name = txt.replace(/^\s*\d+\s*/, '').split(/\s\d+ à \d+|\s[+-]\d|\s(Soigne|Bouclier|Vole)\b/)[0].trim();
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
const NEVER_SELL = ['Gelano']; // noms de base (sans tiers) des objets rares a garder quoi qu'il arrive
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
    if (d && (d.name === alt || d.name.startsWith(alt + ' '))) return d;
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
    if (!n1 || !n2) { decide(`Anneaux : emplacements portes illisibles (${n1 ?? '?'}, ${n2 ?? '?'}), je ne touche a rien`); break; }
    const best = sack.reduce((a, b) => (b.own > a.own ? b : a));
    let slot = 0;
    if (s[1] === undefined) slot = 2; // decouverte de l'anneau 2
    else if (s[0] === undefined) slot = 1;
    else { const weak = s[0] <= s[1] ? 1 : 2; if (best.own > s[weak - 1]) slot = weak; }
    if (!slot) { decide(`Anneaux : paire optimale (${n1} ${Math.round(s[0])}, ${n2} ${Math.round(s[1])}), rien de mieux au sac (meilleur ${best.name} ${Math.round(best.own)})`); break; }
    if ((await openItem(main, items.nth(best.i)))?.name !== best.name) break; // la grille a bouge : on s'arrete proprement
    await main.getByRole('button', { name: new RegExp(`\\(Anneau ${slot}\\)$`) }).click();
    await sleep(1500);
    const why = s[slot - 1] === undefined ? `decouverte du score de ${slot === 1 ? n1 : n2}` : `${Math.round(best.own)} > ${Math.round(s[slot - 1])}`;
    log(`EQUIPE (inventaire) Anneau ${slot}: ${best.name} (score ${Math.round(best.own)}, ${why})`);
    decide(`Anneaux : ${best.name} en emplacement ${slot} a la place de ${slot === 1 ? n1 : n2} (${why})`);
    sack = await scan();
  }
  const [n1, n2] = await worn();
  const minWorn = Math.min(scoreOf(n1) ?? -Infinity, scoreOf(n2) ?? -Infinity);
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
      const sell = main.getByRole('button', { name: /^Vendre ×1/ });
      if (!(await sell.isEnabled().catch(() => false))) continue;
      const price = (await sell.innerText()).replace(/^Vendre ×1 : /, '');
      await sell.click(); // 1er clic : le bouton devient "Confirmer (+X K)"
      const confirm = main.getByRole('button', { name: /^Confirmer/ });
      if (!(await confirm.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false))) { log(`ERREUR vente ${name} : pas de confirmation`); continue; }
      await confirm.click();
      await sleep(1200);
      if (await confirm.isVisible().catch(() => false)) { log(`ERREUR vente ${name} : confirmation sans effet`); continue; }
      log(`VENDU ${slot}: ${name} (score ${Math.round(s)}, ${price})`);
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

const RANK = ['Facile', 'Moyen', 'Difficile', 'Très difficile'];
// plus gros groupe dont la difficulte <= maxRank, sinon le plus facile
const pickGroup = (txt, maxRank) => {
  const r = [...txt.matchAll(/Groupe \d+\n(Facile|Moyen|Difficile|Très difficile)\n/g)].map((m) => RANK.indexOf(m[1]));
  let i = -1; r.forEach((x, j) => { if (x <= maxRank && (i < 0 || x > r[i])) i = j; });
  return i >= 0 ? i : r.indexOf(Math.min(...r));
};

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
async function hdvBuy(page) {
  for (const slot of [...new Set(S.emptySlots ?? [])]) {
    const budget = S.kamas - CFG.kamasReserve;
    if (budget <= 0) { log(`HDV : budget nul (reserve ${CFG.kamasReserve})`); return; }
    await page.goto(BASE + '/hdv');
    await page.getByRole('button', { name: 'Filtrer' }).waitFor({ timeout: 20000 });
    const main = page.locator('main');
    await main.locator('select').first().selectOption({ label: slot });
    await page.getByRole('button', { name: 'Filtrer' }).click();
    await sleep(2500);
    const all = parseHdvRows('\n' + await main.innerText());
    // ligne = plus proche ancetre du nom qui contient un bouton Acheter / Trop cher (n-ieme si le nom se repete)
    const rowOf = (r) => main.getByText(r.raw, { exact: true }).nth(all.filter((x) => x.raw === r.raw && x.idx < r.idx).length)
      .locator('xpath=ancestor::*[.//button[normalize-space()="Acheter" or normalize-space()="Trop cher"]][1]');
    let best = null;
    for (const r of all.filter((x) => x.buyable && x.level <= S.level && x.price <= budget).slice(0, 12)) {
      const row = rowOf(r);
      await row.locator('button:has(img)').first().click().catch(() => {}); // ouvre les stats de l'objet
      await sleep(400);
      const s = scoreItem(await row.innerText().catch(() => '')); // seules les lignes "+N Stat" comptent
      if (s > 0 && (!best || s / r.price > best.s / best.r.price)) best = { r, s };
    }
    if (!best) { decide(`HDV ${slot} : aucun objet utile de mon niveau sous ${Math.round(budget / 1000)} k`); log(`HDV ${slot} : rien d'utile dans le budget (${Math.round(budget / 1000)} k)`); continue; }
    await rowOf(best.r).getByRole('button', { name: 'Acheter', exact: true }).click();
    const ok = main.getByRole('button', { name: /^Confirmer/ });
    if (await ok.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await ok.click();
    await sleep(1500);
    S.kamas -= best.r.price;
    log(`HDV achat ${slot}: ${best.r.name} niv ${best.r.level} (score ${Math.round(best.s)}, ${best.r.price} K)`);
  }
}

if (process.argv[2] === 'test') {
  const assert = (await import('node:assert')).strict;
  const AR = parseArena('TON ELO\n985\nNIVEAU D’OPTI\n2 302\nadversaires\nCLASSEMENT\n#6145\nVICTOIRES / DÉFAITES\n0 / 1\nDeck\nPawmi\nEcaflip niveau 91 · Elo 1001 · opti 2 486 · 1V / 1D\nDéfier\nPad\nFéca niveau 71 · Elo 978 · opti 2 036 · 4V / 6D\nDéfier\nChaque défi coûte 2 points d’énergie (tu en as 148).');
  assert.deepEqual([AR.elo, AR.opti, AR.rank, AR.energy, AR.opp.length, AR.opp[1].name, AR.opp[1].opti], [985, 2302, '6145', 148, 2, 'Pad', 2036]);
  const HR = parseHdvRows('\nFiltrer\nYugoufle\nNiveau 41 · vendu par Hadu\n300 K\nAcheter\n★\nKompost · Rayonnant\nNiveau 60 · vendu par Ouateu\n1 500 K\nTrop cher');
  assert.deepEqual(HR.map((r) => [r.name, r.level, r.price, r.buyable]), [['Yugoufle', 41, 300, true], ['Kompost', 60, 1500, false]]);
  assert.ok(scoreItem('Comparé à X\n+1 PM\n+10 Vitalité\n+10 Sagesse\n+10 Puissance\n-3 Dommages\n+2% Résistance Terre\n-4 Tacle') > 0);
  assert.ok(scoreItem('Comparé à X\n-40 Vitalité\n-10 Sagesse\n-25 Intelligence\n+60 Agilité\n+1% Critique\n+4 Dommages\n-5 Dommages Feu') < 30);
  assert.ok(scoreItem('Comparé à X\n-1 PA\n+50 Vitalité') < 0);
  assert.equal(scoreItem('Vendre · 1 440 K\nNiveau 72 requis'), 0);
  const P = parseStats('\nForce\n45 (0 +45)\nIntelligence\n25 (0 +25)\nChance\n70 (0 +70)\nAgilité\n65 (0 +65)\nTerre\t4\t0 %\nFeu\t8\t0 %\nEau\t9\t0 %\nPuissance 85 · Soins 0');
  assert.deepEqual([P.Force, P.Chance, P.Puissance, P.dmg.Eau], [45, 70, 85, 9]);
  const it = { fav: false, rarity: 'COMMUN', name: 'Coiffe Bouftou', partial: false };
  assert.deepEqual([canSell(it), canSell({ ...it, rarity: 'RARE' }), canSell({ ...it, name: 'Coiffe Bouftou · Tiers 2' }), canSell({ ...it, name: 'Gelano' }), canSell({ ...it, partial: true }), canSell({ ...it, fav: true })], [true, false, false, false, false, false]);
  setEnergy(0, 200); S.energyAt -= 2.5 * REGEN; assert.equal(energyNow(), 2);
  spendEnergy(1); assert.equal(energyNow(), 1); S.energyAt -= 0.5 * REGEN; assert.equal(energyNow(), 2); // le point en cours de recharge est garde
  setEnergy(199); S.energyAt -= 5 * REGEN; assert.equal(energyNow(), 200);
  assert.deepEqual(parseJeu('Ouvrir un coffre\nÉnergie\n1/100\n\n+1 dans 2 min 13 · 1 par combat, 2 en arène\n\nAcheter (300 K le point, encore 1000 aujourd’hui) :\n+1 · 300 K'),{ e: 1, max: 100, next: 133000, price: 300, left: 1000 });
  assert.equal(parseCard('4 Ronces Agressives 24 à 27 dommages Terre RARE').name, 'Ronces Agressives');
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
// a la reserve : lit l'energie exacte, et si CFG.energyBuy, achete +10 sans toucher a kamasReserve
// max (bouton du tableau de bord) : le plein, autant que les kamas le permettent
async function buyEnergy(page, max = false) {
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
    await page.reload({ waitUntil: 'networkidle' });
    const after = await read();
    log(after?.e > j.e ? `ENERGIE achetee (${label}) : ${after.e}/${after.max}` : `ENERGIE achat sans effet (${label}, ${after?.e ?? '?'}/${j.max})`);
    return;
  }
  if (!j || j.e > CFG.energyReserve) return;
  if (!CFG.energyBuy) { decide(`Energie ${j.e}/${j.max} : achat coupe (reglage), j'attends la recharge`); return; }
  if (j.left < 10 || S.kamas - 10 * j.price < CFG.kamasReserve) { decide(`Energie ${j.e}/${j.max} : pas d'achat (${S.kamas} K, reserve ${CFG.kamasReserve} K, quota ${j.left})`); return; }
  decide(`Energie ${j.e}/${j.max} : j'achete +10 (${10 * j.price} K), il reste ${S.kamas - 10 * j.price} K au-dessus de la reserve de ${CFG.kamasReserve} K`);
  await page.locator('button', { hasText: /^\+10 ·/ }).click(); // nom accessible = aria-label "3 000 kamas", d'ou hasText
  const ok = page.getByRole('button', { name: /^Confirmer/ });
  if (await ok.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) await ok.click();
  await sleep(3000);
  await page.reload({ waitUntil: 'networkidle' });
  const after = await read();
  if (after?.e > j.e) { S.kamas -= 10 * j.price; log(`ENERGIE achetee +10 (${10 * j.price} K) : ${after.e}/${after.max}`); }
  else log(`ENERGIE achat sans effet (${after?.e ?? '?'}/${j.max})`);
}

// Coffres d'abord (nouveaux objets/cartes), puis deck, stuff, caracs ; au demarrage et tous les CFG.passEvery combats
async function managePass(page) {
  S.status = 'gestion';
  decide('Passe de gestion : coffres, puis deck, puis stuff (equiper, fusionner, vendre), HDV, caracs');
  await safe('coffres', openChests(page));
  await safe('deck', optimizeDeck(page));
  await safe('inventaire', equipFromInventory(page));
  await safe('hdv', hdvBuy(page));
  await safe('carac', allocateStats(page));
  for (const k of ['coffres', 'deck', 'inventaire', 'hdv', 'carac']) S.last[k] = Date.now();
  await page.goto(COMBAT);
}

// Fenetre visible + profil persistant : login manuel une seule fois, et c'est toi qui reponds au test de presence.
const ctx = await chromium.launchPersistentContext('profile', { headless: false, viewport: null });
const page = ctx.pages()[0] ?? await ctx.newPage();
startDashboard(page);
await page.route(/\/img\//, (route) => (blockable(route.request().url()) ? route.abort() : route.continue()));
page.on('request', (r) => { if (!r.url().startsWith(BASE)) return; if (blockable(r.url())) { NET.blocked++; return; } /* bloquee : jamais envoyee */ const k = netKind(r); NET.total++; NET.by[k]++; NET.recent.push([Date.now(), k]); });
page.on('response', (r) => { if (r.status() === 429 && r.url().startsWith(BASE)) NET.r429++; });
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
page.on('load', () => setTimeout(() => page.locator('body').innerText().then(readHeader, () => {}), 1500)); // nom/niveau/kamas aussi pendant les passes
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
let fightTimes = []; // fins de combat de la derniere heure (plafond)
let energyText = ''; // ecran de fin deja traite pour "Plus assez d'energie" (le message reste affiche apres la recharge)
// actions lancables depuis le tableau de bord (true = un combat a ete lance)
const ACTIONS = {
  coffres: openChests, deck: optimizeDeck, inventaire: equipFromInventory, hdv: hdvBuy, carac: allocateStats, arene: fightArena, boss: tryBoss, energie: (p) => buyEnergy(p, true),
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
  if (S.queue[0] === 'f5') { S.queue.shift(); log('ACTION f5 (tableau de bord)'); await page.goto(COMBAT); idleSince = Date.now(); continue; }
  if (S.paused) { S.status = 'pause'; await sleep(1000); idleSince = Date.now(); continue; }
  const text = await page.locator('body').innerText().catch(() => '');
  if (text !== lastText) { lastText = text; idleSince = Date.now(); } // la page bouge = pas bloque
  readHeader(text);
  Object.assign(S, { huntLeft, zone, strikes, status: 'combat' });

  // rate-limit de l'hebergeur (o2switch) : on respecte, pause 5 min
  if (/HTTP 429|Slow down/.test(text)) { S.status = 'rate-limit'; decide('Serveur sature (429) : pause 5 min pour ne pas aggraver'); log('RATE LIMIT 429 - pause 5 min'); await sleep(300000); await page.goto(COMBAT).catch(() => {}); idleSince = Date.now(); continue; }

  // test de presence : on attend que l'humain reponde, on ne clique jamais dedans
  if (/Es-tu toujours là/.test(text)) {
    S.status = 'presence';
    if (!presenceAlerted) { decide('Test de presence : je ne clique jamais dedans, j\'attends le tien'); log('PRESENCE demandee - en attente de toi'); alert('test de presence, clique dans la fenetre'); await page.bringToFront().catch(() => {}); presenceAlerted = true; }
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
    if (++combats % CFG.passEvery === 0) deckDue = true;
    const win = /Victoire !/.test(text) && !/Défaite/.test(text);
    const num = (s) => s.replace(/\D/g, '');
    const g = text.match(/\+([\d\s]+?) XP\s*\+([\d\s]+?) kamas/);
    S.combats = combats;
    fightTimes.push(Date.now());
    spendEnergy(fight === 'boss' || fight === 'arene' ? 2 : 1);
    log(`${fight ? fight.toUpperCase() + ' ' : ''}${win ? 'VICTOIRE' : 'DEFAITE'} ${g ? `+${num(g[1])} XP +${num(g[2])} kamas` : 'gains=0'}`);
    const zl = await page.getByRole('link', { name: 'Autres groupes de la zone' }).getAttribute('href', { timeout: 1000 }).catch(() => null);
    if (zl?.startsWith('/chasse?zone=')) zone = zl;
    // aventure perdue : deck revu + XP en chasse avant de retenter
    // ponytail: 40 victoires fixe ; a rendre progressif si l'etape bloque encore apres
    if (adventure && !win) { decide(`Aventure perdue : deck revu, puis ${CFG.huntWins} victoires en chasse avant de retenter`); huntLeft = CFG.huntWins; deckDue = true; log('AVENTURE bloquee - deck revu, ' + CFG.huntWins + ' victoires en chasse puis retente'); }
    else if (!adventure && !fight) {
      results.push(win); if (results.length > 10) results.shift(); winsSinceStrike = win ? winsSinceStrike + 1 : 0;
      if (win && huntLeft > 0 && --huntLeft === 0) backToAdventure = true;
    }
    if (winsSinceStrike >= 30) strikes = 0;
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
    if (!S.recharging && energyNow() != null && energyNow() <= CFG.energyReserve) { await safe('energie', buyEnergy(page)); S.last.energie = Date.now(); await page.goto(COMBAT); } // gate() passe en recharge si rien n'a ete achete
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
      await attackGroup(page, zone, strikes ? 0 : CFG.maxGroup);
      continue;
    }
    if (page.url() !== COMBAT) { await page.goto(COMBAT); continue; } // apres boss/deck, revient a l'ecran de fin
    if (await next.isVisible().catch(() => false)) {
      decide(`Rien a faire : combat suivant en Auto (passe dans ${CFG.passEvery - (combats % CFG.passEvery)} combats)`);
      await sleep(1000 + Math.random() * 2000);
      await next.click();
      autoClicked = true; // "Suivant en auto" lance le combat suivant deja en Auto
      await sleep(3000);
    } else if (zone) {
      await attackGroup(page, zone, strikes ? 0 : CFG.maxGroup);
    } else { // pas de bouton connu (fin d'arene ?) : retour en chasse dans la zone XP
      zone ??= await pickZone(page, null, false);
      await attackGroup(page, zone, strikes ? 0 : CFG.maxGroup);
    }
    continue;
  }
  endHandled = false; // plus sur un ecran de fin : le prochain sera un nouveau combat

  const auto = page.getByRole('button', { name: 'Auto', exact: true });
  if (!autoClicked && /À toi de jouer/.test(text) && await auto.isEnabled().catch(() => false)) {
    await sleep(1000 + Math.random() * 2000);
    await auto.click();
    autoClicked = true;
    idleSince = Date.now();
  }

  // serveur en vrac ou rien ne bouge depuis 30 s : F5
  if (/Application error|Internal Server Error|Bad Gateway|Something went wrong|This page couldn.t load/i.test(text) || Date.now() - idleSince > 30000) {
    log('BLOQUE - rechargement');
    decide(stuck % 2 ? 'Page figee depuis 30 s : je relance un combat via la zone' : 'Page figee depuis 30 s : F5');
    if (++stuck % 2 === 0) { // 2e blocage : relance un combat via la zone (zone la plus facile si inconnue)
      zone ??= await pickZone(page, null, true).catch(() => null);
      if (zone) await safe('attaque', attackGroup(page, zone, strikes ? 0 : CFG.maxGroup));
    }
    else await page.goto(COMBAT).catch(() => {});
    autoClicked = false; idleSince = Date.now();
  }
  await sleep(1000);
  } catch (e) { log('ERREUR ' + e.message.split('\n')[0]); await sleep(5000); await page.goto(COMBAT).catch(() => {}); autoClicked = false; idleSince = Date.now(); }
}
