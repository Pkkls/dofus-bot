# Handoff dofus-bot

Etat au 2026-10-06. Bot Playwright qui joue seul a DofusMasters (https://dofusmasters.houk.fr, fan-site Next.js) sur le personnage Bernardarnault (Cra), avec un tableau de bord local en temps reel.

## Lancer

```
npm install
npx playwright install chromium
run.cmd            # boucle de relance + ouverture du tableau de bord
npm test           # self-tests (parseurs, scores, choix de deck/groupe/anneaux)
```

Au premier lancement, une fenetre Chromium s'ouvre sur /connexion : se connecter a la main. La session est gardee dans `profile/` (jamais versionne). Sous Windows, la tache planifiee `dofus-bot` lance `run.cmd` a l'ouverture de session. `run.cmd` relance le bot s'il plante et s'arrete (code 2) si la session expire.

Tableau de bord : http://127.0.0.1:7777 (servi par le bot, SSE temps reel, se recharge seul si `dashboard.html` change).

## Regle non negociable

Le site affiche un test de presence ("Es-tu toujours la ? Clique sur le chiffre 5"). Le bot ne clique jamais dedans. Il se met en pause, bipe, ouvre un popup Windows, passe sa fenetre au premier plan, et attend que l'humain reponde. Ne pas automatiser ce test : c'est un controle anti-bot du site. Les CGU (/mentions) interdisent aussi les scripts ; le proprietaire du compte accepte ce risque.

## Ce que fait le bot

| Domaine | Comportement | Etat |
|---|---|---|
| Combat | Mode Auto natif du jeu, "Suivant en auto" | verifie |
| Aventure (Chemin) | Defaite : deck revu, N victoires de chasse (huntWins), puis retente | verifie |
| Chasse | 3 defaites sur 10 : deck revu + groupe facile, puis zone plus facile | code, peu sollicite |
| Boss de zone | Toutes les 20 min, planifie sur "Arrive dans X", un essai | verifie (victoire) |
| Arene | Adversaire au plus faible niveau d'opti s'il est sous le notre, energie >= arenaMinEnergy | verifie (1V 1D) |
| Coffres | Ouvre tout (gagnes + cadeaux), achete en gardant kamasReserve | gagnes verifies, cadeaux corriges le 06/10, a confirmer |
| Deck | Garde les cartes utilitaires, complete par degats/PA selon les stats de /personnage | verifie |
| Inventaire | Equipe le meilleur score par type, vend (2 clics) le moins bon Commun..Rare | verifie au kama pres |
| Anneaux | Optimisation des 2 emplacements, reserve ringSpare, vente du reste | nouveau, a confirmer |
| Fusion | 3 exemplaires au moins aussi bons que la piece portee | debloque le 06/10, a confirmer |
| HDV | Achat pour les emplacements vides uniquement | code, jamais declenche |
| Caracs | Vitalite (vitShare) puis stat de l'element dominant du deck | verifie |
| Reseau | Compteur par type, limiteur maxReqPerMin, images /img/ bloquees sauf pendant le test de presence | verifie (5 a 14 req/min) |

## Architecture (bot.mjs, un seul fichier)

- Haut du fichier : etat `S` (lu par le tableau de bord), reglages `CFG_SPEC` [defaut, min, max] persistes dans `config.json`, `log()` (bot.log), `decide()` (fil des decisions, doublons regroupes), `push()` (SSE).
- Scores : `WEIGHTS` + `weight()` ; les poids Force/Intelligence/Chance/Agilite suivent `ELEM_SHARE` (part de chaque element dans le deck), donc l'equipement suit le build.
- Parseurs purs testes : `scoreItem`, `parseDetail` (panneau d'objet de l'inventaire), `parseCard`, `chooseDeck`, `parseStats`, `pickGroup`, `parseArena`, `parseHdvRows`.
- Passes : `managePass()` = coffres, deck, inventaire (dont `optimizeRings`, fusion, `sellJunk`), HDV, caracs. Au demarrage puis tous les `passEvery` combats.
- Boucle principale : detection fin de combat, file d'actions du tableau de bord, boss, arene, gestion des defaites, rattrapage XP, "Suivant en auto". Statuts : combat, gestion, pause, presence, rate-limit, throttle.
- Serveur : `startDashboard()` sur 127.0.0.1:7777. Routes : `/`, `/api/state`, `/api/events` (SSE), `/api/shot` (capture), `POST /api/pause`, `POST /api/config`, `POST /api/action/<nom>`.
- `state.json` : etat utile entre redemarrages (arene, boss, deck, decisions, scores d'anneaux connus).

## Pieges connus

- Hebergeur o2switch : HTTP 429 "Slow down" si trop de pages en rafale. Le bot fait une pause de 5 min. Pour explorer une page, arreter le bot (le profil est verrouille) et espacer les chargements.
- Vente et fusion en 2 clics : le bouton devient "Confirmer (+X K)".
- Grille d'inventaire : les objets en plusieurs exemplaires ont un badge ("2", "FUSION"). Selecteur `invItems()` et nom lu par `parseDetail()`, jamais "premiere ligne du texte".
- Anneaux : le jeu compare toujours a l'anneau 1, mais propose "Equiper a la place de X (Anneau 1|2)". Le score de l'anneau 2 se decouvre en y placant un anneau (l'ancien revient au sac).
- Les clics de la sonde en headless n'ont parfois aucun effet sur l'inventaire ; le bot en fenetre visible fonctionne. Diagnostiquer dans le bot (decide/log) plutot qu'en headless.
- Ne jamais editer `run.cmd` pendant qu'il tourne (cmd relit le .bat) : `Stop-ScheduledTask dofus-bot` d'abord.
- `bot.log` reecrit sous Windows peut contenir des \r\n : le parseur les tolere.

## A faire ensuite

1. Confirmer en reel : coffres cadeaux, anneaux (decouverte de l'anneau 2 puis paire optimale), fusion.
2. HDV : vente des objets Epique+ inutiles et achat d'ameliorations pour emplacements occupes (l'HDV ne montre pas de comparaison : il faudrait comparer au score propre de la piece portee).
3. Dofus/Trophees (6 emplacements) et familiers : meme approche que les anneaux.
4. Rattrapage d'aventure progressif si l'etape bloque encore apres huntWins victoires.

## Outils

- `explore.mjs <chemin>` : dump lecture seule d'une page dans `dump/` (texte + controles).
- `explore-rings.mjs` : sonde de la grille d'inventaire (anneaux).
