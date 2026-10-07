# Handoff dofus-bot

Etat au 2026-10-06, 03h20 (heure de Paris). Bot Playwright qui joue seul a DofusMasters (https://dofusmasters.houk.fr, fan-site Next.js) sur le personnage Bernardarnault (Cra), avec un tableau de bord local en temps reel.

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
| Combat | manualFight=1 (defaut) : moteur manuel `playTurn`. Le combat suivant part par "Etape suivante" ou une attaque de zone, jamais "Suivant en auto" (qui lance en Auto). A chaque coup : etat relu a l'ecran (`readFight` : main, PA, PV, bouclier, resistances, protection/bouclier ennemi), attente d'un etat stable (`settle`, le jeu affiche "- PA" pendant les animations), toutes les combinaisons de cartes payables x chaque cible focus evaluees (`bestMove`/`planValue` : degats formule deck x correctif appris, kills, soin/bouclier selon le danger), 1re carte du meilleur plan jouee puis recalcul. Auto-apprentissage dans state.json (`S.learn`) : correctif de degats par element (reel/prevu), style de jeu (equilibre/agressif/prudent) choisi par UCB1 sur victoire et vitesse. Echec de lecture ou 3 cartes refusees : Auto pour ce combat. manualFight=0 : ancien mode Auto | verifie 06/10 : 4/4 victoires dont boss de zone. Entrainement (bouton dashboard) : trainFights combats dans la zone dont le niveau max est le plus proche de trainLevel (200), groupe le plus gros, hors compteur de defaites ; table S.learn.train par style (tours tenus, part des PV ennemis), +0.3 x survie dans le choix de style en vrai combat. 1er essai niv 200 gagne en 7 tours |
| Aventure (Chemin) | Defaite : deck revu, N victoires de chasse (huntWins), puis retente | verifie |
| Chasse | 3 defaites sur 10 : deck revu + groupe facile, puis zone plus facile | code, peu sollicite |
| Boss de zone | Toutes les 20 min, planifie sur "Arrive dans X", un essai | verifie (victoire) |
| Arene | Adversaire au plus faible niveau d'opti s'il est sous le notre, energie >= arenaMinEnergy | verifie (1V 1D) |
| Coffres | Ouvre tout (gagnes + cadeaux), achete en gardant kamasReserve | gagnes verifies, cadeaux corriges le 06/10, a confirmer |
| Deck | Garde les cartes utilitaires, complete par degats/PA selon les stats de /personnage | verifie |
| Inventaire | Equipe le meilleur score par type, vend (2 clics) le moins bon seulement si canSell : Commun ou Peu commun, pas favori, pas de tiers/Rayonnant, hors NEVER_SELL (Gelano), comparaison complete (pas de "autres differences"). Dans le doute on garde. Incident 06/10 01:05 : une vingtaine d anneaux vendus depuis l onglet Chapeau (filtre pas applique), corrige par 11b68bf | verifie au kama pres |
| Anneaux | `optimizeRings` : decouverte du score de l'anneau 2, puis le meilleur du sac remplace le plus faible ; reserve ringSpare (niveau >= mon niveau - spareWindow), vente du reste | paire passee a 107 + 100 en reel ; boucle de permutation corrigee le 06/10, a reverifier |
| Fusion | 3 exemplaires au moins aussi bons que la piece portee | debloque le 06/10, a confirmer |
| HDV | Ameliorations : pour chaque emplacement, annonces de mon niveau dans le budget (kamas - kamasReserve), 15 moins cheres, stats lues dans le panneau de detail (`hdvStats`), gain = score - piece portee (S.worn), achat du meilleur gain par kama si >= max(10, 10 % de la piece), puis inventaire pour equiper. Diagnostic : dump/hdv_eval.txt | selection verifiee 06/10 (Coiffe du Ploukosse +38 pour 500 K...) ; ACHAT EN PANNE COTE SITE le 06/10 : clic Acheter sans aucune requete, meme a la main (enregistre). Achat verifie par les kamas avant/apres ; echec -> HDV saute 6 h (S.hdvBrokenUntil). Enregistreur de debug : creer le fichier `record` -> clics et POST dans dump/record.txt |
| Caracs | Vitalite (vitShare) puis stat de l'element dominant du deck | verifie |
| Horaires et rythme | `gate()` avant chaque combat : plage horaire (scheduleOn, activeFrom -> activeTo en minutes, peut passer minuit) et plafond maxFightsPerHour (heure glissante). Attente sans requete, reprise seule | verifie (repos, plafond, reprise) |
| Energie | 1 point / 6 min. Lue sur les pages de zone et d'arene, decomptee par combat (1, boss/arene 2), estimee entre deux. A la reserve energyReserve (2, gardee pour le boss) ou sur "Plus assez d energie" : plus de chasse/aventure/arene, `gate()` attend energyResume (6) points (statut recharge) ; seul le boss annonce passe pendant la recharge. A la reserve, lecture exacte sur /jeu (minuteur du prochain point) et, si energyBuy=1 (coupe par defaut), achat +10 a 300 K le point sans entamer kamasReserve (bouton "+10 ·" via hasText car son nom accessible est un aria-label "3 000 kamas" ; attendre networkidle + 2 s sinon le clic est ignore ; pas de confirmation). Achat retente toutes les 5 min pendant une recharge (canBuyEnergy), verifie : 2 -> 12/100 puis combats relances. Bouton dashboard "Energie max" = "+N (max)" : verifie le 06/10, 3 -> 100/100 pour 29 100 K | code le 06/10, a verifier |
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
- Panneau de detail parfois perime apres un clic : toujours passer par `openItem()`, qui attend que le nom du panneau corresponde a l'image cliquee. Aucune vente ni equipement sans cette verification.
- Emplacements portes : un badge de tiers peut s'ajouter au texte ("T2 Anneau"), d'ou la regex `/(^|\s)Anneau$/`. Si un anneau porte est illisible, `optimizeRings` ne touche a rien.
- Le texte de l'image d'un objet = nom sans le tiers (`baseName`) : "Gelano" pour "Gelano · Tiers 2".
- Anneaux : le jeu compare toujours a l'anneau 1, mais propose "Equiper a la place de X (Anneau 1|2)". Le score de l'anneau 2 se decouvre en y placant un anneau (l'ancien revient au sac).
- Les clics de la sonde en headless n'ont parfois aucun effet sur l'inventaire ; le bot en fenetre visible fonctionne. Diagnostiquer dans le bot (decide/log) plutot qu'en headless.
- Ne jamais editer `run.cmd` pendant qu'il tourne (cmd relit le .bat) : `Stop-ScheduledTask dofus-bot` d'abord.
- `bot.log` reecrit sous Windows peut contenir des \r\n : le parseur les tolere.

## Derniere verification (2026-10-06, 01h20 UTC)

- Passe de gestion complete en 61 s (contre ~10 min avant les gardes `openItem` et la fusion limitee au badge FUSION), 0 erreur, ventes reelles.
- Anneaux : paire optimale stable (Alliance des Forestiers 123, Anneau Ouroboulos 107), plus de permutation en boucle ; reserve = anneaux de niveau >= niveau - spareWindow.
- Chaque type d'objet ne traite que les objets dont le panneau indique le meme emplacement (`sameSlot`), meme si le filtre de type n'est pas encore applique.
- Coffres cadeaux ouverts.

## Reglages en vigueur (config.json local, non versionne)

Au 2026-10-06 : plage horaire active (scheduleOn 1) de 13:00 a 06:00 (activeFrom 780, activeTo 360), plafond 240 combats par heure (environ 4 par minute). Autres reglages par defaut. A modifier depuis le tableau de bord, section Reglages.

## A faire ensuite

1. Confirmer en reel une fusion (aucun objet eligible pour l'instant : il faut 3 exemplaires au moins aussi bons que la piece portee).
2. HDV : vente des objets Epique+ inutiles et achat d'ameliorations pour emplacements occupes (l'HDV ne montre pas de comparaison : il faudrait comparer au score propre de la piece portee).
3. Dofus/Trophees (6 emplacements) et familiers : meme approche que les anneaux.
4. Rattrapage d'aventure progressif si l'etape bloque encore apres huntWins victoires.

## Outils

- `explore.mjs <chemin>` : dump lecture seule d'une page dans `dump/` (texte + controles).
- `explore-rings.mjs` : sonde de la grille d'inventaire (anneaux).

## Indices de defaite (06/10)

A chaque defaite : ecran complet dans `dump/defaite-<ts>.txt`, ligne d'indice au log (`INDICE`) et dans `S.hints` par monstre. `rulesOf()` traduit l'indice en regles ; une seule reconnue pour l'instant : "meme element deux fois de suite" (renvoi) -> `orderCards` alterne les elements depuis le dernier joue et `planValue` compte une repetition comme degats renvoyes. `HINT_SEED` contient les indices connus avant capture (Phossile). Ajouter une regle par nouvel indice capture. Limite : element d'une carte = son 1er element de degats.

## Prestige (06/10)

Le jeu permet un prestige : retour niveau 1, sorts et inventaire perdus, un objet garde (+25 % dommages). Prestige fait le 06/10 a 13h, objet garde : Mollosk (dans NEVER_SELL). Le bot detecte une chute de niveau > 5 : zone, compteurs, anneaux connus et stats remis a zero, passe de gestion, aventure depuis le debut. Garde-fou : un lien de zone plus de 20 niveaux au-dessus du perso est ignore hors entrainement (niveaux des zones lus une fois par lancement, `allZones`).

## Ecran d'inactivite (06/10)

"Tu etais inactif, ta place a ete liberee, progression sauvegardee" (10 min sans clic) n'est pas le test de presence : le bot attend `gate()` (energie, plage horaire) puis recharge /combat pour reprendre sa place, sans cliquer dans l'ecran. Le test de presence "Es-tu toujours la ?" reste manuel (alerte, jamais clique).

## Optimisation moteur (06/10 apres-midi)

Bilan avant : 51/51 victoires depuis 13:50 (~186/189 au total), 2,3 cartes/tour, ~36 s entre deux fins de combat. Ajouts : regle `healHurtFrom` (indice Sphincter Cell "a partir du tour 4, vos soins vous blessaient" : soins et vol de vie comptes negatifs), capture d'indice stricte (ligne "Indice" seulement, l'arene n'en donne pas), montee de zone sur taux de victoire cible `targetWin` (0.85, fenetre 20 combats, demande de kil : pas 100 %, garder une marge), anneau verrouille au prestige contourne (emplacement remplacable seulement).

## Mise a jour du site du 06/10 (Forgemagie, Ascension) et surveillance

- Surveillance : id de deploiement Next (`dpl=` dans les scripts) lu a chaque page ; s'il change, `siteScan` releve boutons/listes de chaque onglet du menu (nombres masques), compare a `S.siteMap`, signale les nouveautes (log `MAJ SITE`, decision, alerte) et sauve chaque page dans `dump/site_*.txt`. Releve de reference fait le 06/10.
- Forgemagie : 1re visite = Bouclier de forge. Briser un objet (fiche inventaire "Briser x1 : +N orbe") donne des orbes (1 < niv 70, 2 jusqu'a 139, 3 au-dela, 1500/jour) ; les orbes ameliorent le bouclier (+% stats sur tout l'equipement, jusqu'a +200 % niv 200, garde au prestige). `sellJunk` brise au lieu de vendre si breakJunk=1 et kamas >= energyKamas + 3000, sinon vend. `forgeUpgrade` lit la page (`parseForge` : niveau, orbes, quota du jour, cout et reussite annonces, bonus), depense toutes les orbes ("10 essais" si assez) et apprend dans `S.learn.forge` (essais/reussites reels vs annonce, objets brises, orbes gagnes). Quota du jour atteint -> vente au lieu de briser. Bouton dashboard "Forge". Lecture verifiee 06/10 (niv 1, 0 orbe, quota 1500) ; brisage pas encore vu en reel.
- Ascension (prestige + niveau 200) : etages de boss, 2 energie, coffre par nouvel etage. Pas encore code (perso niv 53).
- Guilde : "Entrer dans la Faille", pas encore explore.
- Fenetres d'annonce ("Rejoins le Discord !") fermees par "Plus tard". Clics qui expirent 2 fois en 3 min : capture `dump/bloque-*` + alerte (fenetre inconnue, ex. anti-AFK non reconnu).

## Gestion du personnage auto-optimisee (06/10)

- Deck : `cardValue` multiplie par le correctif appris en combat `S.learn.k[elem]` (degats reels / prevus).
- Caracs : `vitShareNow()` adapte la part de vitalite a `S.learn.build` (moyennes glissantes des PV mini atteints et des defaites en combat manuel) : defaites > 15 % ou PV mini < 35 % -> +15 pts ; PV mini > 75 % sans defaite -> -10 pts ; bornee 5-60 %. Le poids de la Vitalite dans le score d'objet suit le meme besoin.
- Zones : `S.learn.zones[zone]` (XP/min et victoires, moyennes glissantes, niveau du perso a la mesure). Tous les 20 combats, bascule vers la zone a la meilleure XP/min parmi celles gagnees au taux vise et mesurees a +-10 niveaux, si elle bat la zone actuelle de 20 %.
- XP hard (bouton) : plus gros groupes, palier suivant a chaque victoire, 1re defaite -> palier precedent et montee normale. Depuis le 07/10 : XP hard part du HAUT (XP_TOP, zone la plus dure ouverte), descend de `xpHardStep` niveaux de monstres (10, reglable au tableau de bord) a chaque defaite, 1re victoire = on farme la. 2e palier de defaites en chasse = un cran plus bas (avant : zone la plus facile de ma tranche).
- `allZones()` : charge `/chasse?toutes=1` (les 222 zones ; `/chasse` seul = "Zones de mon niveau") (avant : seulement si < 20 liens, donc jamais avec la nouvelle interface, l'XP hard plafonnait a ma tranche). Liste relue tous les 5 niveaux et cumulee.
- Zones verrouillees : la liste `?toutes=1` affiche "Niveau N requis" sur chaque carte ; `allZones()` le lit (une page) dans `S.zoneReq`, exclu des sauts XP hard et du choix meilleure XP/min. Le refus "Zone reservee aux joueurs de niveau N et plus" reste en filet (avant 07/10 19h : seul moyen, une requete par zone = rafale). Releve du site : `siteScan` parcourt tous les liens + onglets, `dump/site-map.json`, diff dans `dump/site-changes.txt`.
- 07/10 18h34 : state.json efface par erreur (pas de sauvegarde), repart vide. Limite XP hard remesuree.
- Tout est visible dans le module "Moteur de combat" du tableau de bord (Build, Meilleures zones).

## Pats et deblocage par hypotheses (06/10)

- Pat = PV+protection ennemis qui ne baissent plus (3 tours sans entamer). `STALL_HYPOS` testees 2 tours chacune : tout aux degats, focus le plus entame, focus le moins resistant, aucun soin ni bouclier. Celle qui fait baisser les PV ennemis est gardee ; resultats appris par groupe d'ennemis (`S.learn.stall[noms]`) et reutilises des le tour 1 au combat suivant. Fuite seulement si toutes echouent.
- Arene : adversaire qui nous bat ou nous bloque evite jusqu'a +3 niveaux ou un deck different (`S.learn.arenaAvoid`, `deckKey()`), pas de duree fixe (demande de kil : le perso evolue vite).
- Deblocage de page (`unblock`) : signature = chemin + titre de main ; actions sures testees, F5 en tete, la meilleure apprise d'abord (`S.learn.unblock`). Page d'erreur serveur -> F5 immediat ; page figee stuckSec (15 s) -> deblocage.

## Aventure prioritaire et Sagesse (06/10 soir)

- Aventure d'abord (`wantAdventure`/`goAdventure`) : hors rattrapage de chasse apres une defaite d'aventure (huntLeft, garde dans state.json), XP hard et entrainement, chaque fin de combat sans "Etape suivante" relance /aventure "Combattre". Chemin non lancable -> chasse, nouvel essai 30 min (`S.advBlockedUntil`). Ecran "Aucun combat en cours" -> aventure, sinon chasse. Verifie : boss -> aventure -> 3 etapes enchainees.
- Sagesse (XP, inutile au niveau 200) : caracs au rendement marginal, XP/min ~ (1+Sag/100)(1+(stat+Pui)/100) ; cible Sag = (100+stat+Pui) x coutStat/coutSag - 100 ; frein `wisdomShareNow()` selon le danger mesure (0 si defaites > 15 % ou PV mini < 35 %, moitie si PV mini < 50 %). Poids de la Sagesse dans le score d'objet = stat principale x meme frein. Validation : `S.learn.wisLog` (sagesse, XP par victoire de chasse, defaites a chaque passe), ligne "Sagesse (XP)" du tableau de bord.
- File d'attente du serveur : attente passive, aucune navigation (sinon place perdue). Page 508 "Resource Limit Is Reached" : comme le 429, attente doublee 60 s -> 9 min.

## HDV refait, Abysses, rush prestige (06/10 nuit)

- HDV nouvelle interface : pastilles de type ("Chapeau N"), case "Equipables par moi", select "Tri : Prix croissant", annonces "Nom / Niv. N · Emplacement / par Vendeur / PRIX K / Acheter" (`parseHdvRows` lit les deux formats). L'achat passe par un `window.confirm()` ("Acheter X pour N kamas ?") que Playwright refusait en silence : accepte maintenant. Verifie : 2 achats, kamas debites. `S.hdvBought` empeche de racheter le meme objet. Objets achetes = "LIE" temporairement (invendables). Mise en vente pas encore codee : onglet Vendre capture dans `dump/hdv_vendre2.txt` (inventaire en boutons-images, 20 offres max, taxe 2 %).
- Abysses (descentes illimitees, 20 energie au depart) : apres victoire, lien "Choisir ma recompense" sur /combat (le titre "Les Abysses · Tour N" reste affiche, d'ou la verification avant le test de combat), puis carte bonus, puis "Combattre l'etage N" ou "Affronter le gros boss de l'etage N" (tous les 5). Accueil "Pret a plonger ?" sans "DESCENTE EN COURS" = descente finie (`abyssEnd`, meme apres un redemarrage). Verifie : etages 1 a 5 franchis, cartes Legendaire PA/PM prises.
- Rush prestige (`CFG.rushPrestige` = prestige vise, 4 actuellement) : avant le 200, ni abysses ni arene, energie achetee meme si `energyBuy` = 0. Au 200 : /personnage, bouton contenant "Prestige" (dialogue et confirmation acceptes) ; sinon condition lue ("etage N", P4 = etage 20 de l'Ascension) puis combats d'Ascension (`S.rushAsc`, `S.ascBest`). Prestige lu dans l'en-tete ("Nom ✦N" -> `S.prestige`). Ecrans captures : `dump/prestige.txt`, `dump/ascension.txt` si bouton introuvable (nouvel essai 30 min). Non verifie en reel (perso niv 152, prestige 1) : les libelles des boutons Prestige et Ascension sont devines par regex.

## Rush : temps perdu mesure et reduit (06/10 nuit)

- Passe de gestion chronometree : ligne `PASSE gestion N s (coffres, deck, inventaire, hdv, carac, forge)` et `S.passLog`. Avant : 137 s (inventaire 28, HDV 40, caracs 63). Apres : inventaire 1 s si rien n'a change (`S.invSeen` : niveau + nombre d'objets par emplacement, bouton Inventaire = scan complet), HDV 1 fois par heure sauf emplacement vide, page HDV non chargee = pause 6 h.
- Trophees (6 emplacements) : boutons "Equiper a la place de X (Dofus / Trophee N)" ; on remplace la piece portee au plus petit score connu (`S.ownScore`), et un objet deja equipe 2 fois en 24 h n'est plus reequipe (`S.equipLog`). Avant : Feroce reequipe 10 fois, Robuste majeur 9 fois en une soiree.
- Rush et Abysses : la descente en cours reste ouverte (aucune fuite, aucun abandon), l'ecran de victoire d'abysses ("Choisir ma recompense") compte comme fin de combat pour repartir en chasse.
- Tableau de bord : section "Objectif" (feuille de route du rush, barre de l'etape en cours, carte Abysses : record, descente, choix appris).
