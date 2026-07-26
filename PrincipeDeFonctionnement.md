# Principe de fonctionnement — Qwest

Ce document décrit, en clair et sans jargon, **comment fonctionne réellement** l'application Qwest aujourd'hui (état observé du code) et **comment elle est censée fonctionner** une fois les correctifs appliqués (architecture cible). Il sert de référence pour le débogage, l'évolution et la rédaction des scénarios de test.

## 1. Vue d'ensemble

Qwest est un quiz temps réel (type Kahoot) à trois rôles :

- **Élève** : se connecte avec un *code de partie*, choisit un avatar, répond aux questions
- **Professeur (pilotage)** : crée le quiz, lance la partie, voit l'état en direct, peut avancer manuellement, met en pause, ajuste un score
- **Projection** : fenêtre dédiée (TBI/vidéoprojecteur) qui affiche la question courante, le timer et le Top 3, **indépendamment** du poste prof

Architecture technique :

- Frontend : JavaScript vanilla (pas de framework)
- Backend : PHP 7.4+ sur Apache, persistance par fichiers JSON dans `php/data/sessions/`
- Pas de base de données, pas de WebSocket — uniquement du HTTP classique (compatible OVH mutualisé)
- Synchronisation temps réel par **polling périodique** (HTTP GET répété)

## 2. Données d'une session

Chaque partie est représentée par un fichier JSON unique dans `php/data/sessions/CODE.json`. Forme observée :

```json
{
  "playCode": "AB12CD",
  "state": "waiting | playing | finished",
  "currentQuestion": -1,
  "questionStartTime": 1714900000,
  "questionCompleted": false,
  "questionCompletedTime": 1714900033,
  "customTime": 30,
  "manualMode": true,
  "showTop3": true,
  "paused": false,
  "quizData": { "questions": [ ... ] },
  "questions": [ ... ],
  "usedAnimals": [ "lion", "ours", ... ],
  "players": [
    {
      "nickname": "lion42",
      "score": 1850,
      "connected": true,
      "lastPing": 1714900028,
      "joinedAt": 1714899800,
      "answers": {
        "0": { "questionIndex": 0, "answer": "{\"index\":1}", "timeSpent": 4200, "timestamp": 1714899850, "correct": true, "points": 958 },
        "1": { ... }
      }
    }
  ],
  "createdAt": 1714899750
}
```

Points importants :

- `currentQuestion` vaut **-1** tant que la partie n'a pas démarré, puis 0, 1, 2…
- `questionStartTime` est un **timestamp Unix serveur**, posé à chaque appel à `next_question`
- `questionCompleted` passe à `true` quand tous les élèves actifs ont répondu **OU** quand le timer expire (auto-completion)
- `customTime` (s'il est défini) **écrase** la durée individuelle de chaque question
- `players[i].answers` est indexé par `questionIndex` (0, 1, 2…) — chaque entrée contient la réponse brute, le temps mis (en ms, mesuré côté client), et après calcul `correct` + `points`

## 3. Machine à états

### 3.1 Côté serveur (la session)

```
                    create_session
                          │
                          ▼
                     ┌─────────┐
                     │ waiting │  ◄──── les élèves font join
                     └────┬────┘
                          │ start_game
                          ▼
                     ┌─────────┐
        next_question│         │
        ◄────────────│ playing │
                     │         │
                     └────┬────┘
                          │ end_game (ou plus de questions)
                          ▼
                     ┌──────────┐
                     │ finished │
                     └──────────┘
```

Pendant `playing`, deux flags fluctuent :
- `questionCompleted: false` ⟶ une question est en cours, les élèves peuvent encore répondre
- `questionCompleted: true` ⟶ la question est terminée, on attend que le prof clique « next » (mode manuel) ou qu'un nouveau `next_question` arrive

### 3.2 Côté élève

```
┌──────────┐   code valide   ┌─────────────┐  avatar choisi  ┌────────┐
│ accueil  │ ──────────────► │ choix avatar│ ──────────────► │ lobby  │
└──────────┘                 └─────────────┘                 └───┬────┘
                                                                 │ state="playing"
                                                                 ▼
                                                           ┌──────────┐
                                                           │ question │ ◄──┐
                                                           └────┬─────┘    │
                                                                │ clic     │
                                                                ▼          │
                                                       ┌──────────────┐    │
                                                       │ réponse      │    │
                                                       │ enregistrée  │    │
                                                       └────┬─────────┘    │
                                                            │ results dispo│
                                                            ▼              │
                                                      ┌──────────┐         │
                                                      │ résultat │         │
                                                      │  + Top 3 │         │
                                                      └────┬─────┘         │
                                                           │ next question │
                                                           └───────────────┘
                                                                │ end
                                                                ▼
                                                          ┌──────────┐
                                                          │  final   │
                                                          └──────────┘
```

Côté élève, deux horloges sont tenues :
- `questionStartTime` = `Date.now()` au moment où la question s'affiche **chez lui** (sert au calcul des points)
- `serverQuestionStartTime` = horodatage serveur (sert au timer visuel et à la reconnexion)

C'est le délai **local** (`Date.now() - questionStartTime`, en ms) qui est envoyé au serveur dans le champ `timeSpent`.

## 4. Synchronisation — comment l'élève sait ce qu'il doit afficher

Aucun message n'est *poussé* du serveur vers l'élève (pas de WebSocket sur OVH mutualisé). À la place, **l'élève interroge le serveur à intervalle régulier** (polling) :

### 4.1 État actuel (avant correctifs)

- L'élève appelle `php/game.php?action=get_state` toutes les **2 secondes**
- Le serveur répond avec un JSON contenant : `state`, `currentQuestion`, `question` (si en cours), `results` (si terminée), liste des joueurs, etc.
- L'élève compare ce qu'il reçoit à ce qu'il affiche déjà :
  - nouvelle question (currentQuestion change) → affiche la question, démarre le timer local
  - `questionCompleted` passe à true → affiche les résultats / Top 3
  - `state` passe à `finished` → affiche l'écran final
- En parallèle, après avoir cliqué sa réponse, l'élève appelle un **watchdog** (`check_question_timeout`) toutes les 2-3 s pour forcer la fin si le serveur traîne
- En cas d'échec d'une requête (timeout 5 s) : 3 échecs successifs déclenchent une popup « connexion perdue ». Tentatives de reconnexion en backoff exponentiel (2 s → 4 s → 8 s → 10 s plafond)

### 4.2 État cible (après correctifs)

- **Un seul mécanisme** : polling adaptatif sur `get_state` (le watchdog est supprimé, redondant)
- Cadences : 4 s en question active, 6 s en attente / résultats / Top 3
- **Jitter** ±15 % sur chaque intervalle (pour éviter que tous les élèves frappent le serveur en même temps)
- Timeout AbortController : 10 s (au lieu de 5 s)
- 3 échecs avant popup, comme avant — soit ~12 s de tolérance avant alerte
- Le `lastPing` est mis à jour serveur-side à **chaque** `get_state` (pas besoin d'un ping séparé)

## 5. Synchronisation — côté professeur et projection

- **Pilotage prof** : poll `php/control.php?action=get_control_state` toutes les **2 s** (cible : 3 s en question active, 5 s en attente)
- **Projection** : poll le **même endpoint** indépendamment, toutes les **1.5 s** (cible : 3 s)
- **Teacher-play** (« Je participe aussi ») : ne poll PAS le serveur — il reçoit ses mises à jour via `window.opener.updateTeacher()` (push depuis la fenêtre de pilotage)

La projection est volontairement autonome : si le poste prof perd le réseau, la projection continue d'afficher la partie en cours.

## 6. Cycle complet d'une question — qui fait quoi, quand

Exemple : question 0, durée 30 s, mode manuel, 20 élèves.

| Temps | Acteur | Action |
|---|---|---|
| T = 0 | Prof | Clique « Lancer la partie » → POST `start_game` puis POST `next_question` (questionIndex=0) |
| T = 0,1 s | Serveur | Pose `currentQuestion=0`, `questionStartTime=T`, `questionCompleted=false` |
| T = 0–4 s | Élèves | Au prochain polling (`get_state`), reçoivent la question, démarrent leur timer local. Latence d'apparition : 0–4 s selon le moment du polling |
| T = 5–28 s | Élèves | Cliquent leur réponse → POST `submit_answer` avec `timeSpent` mesuré localement |
| T = 5–28 s | Serveur | Stocke la réponse. Si tous les actifs ont répondu → marque `questionCompleted=true` et calcule les scores |
| T = 30 s | (timer écoulé) | Le serveur attend la **grâce** (3 s actuellement, 6 s cible) avant de forcer |
| T = 33 s (cible 36 s) | Serveur | Au prochain polling élève ou prof, `checkAndForceQuestionCompletion` voit que `time() - questionStartTime ≥ questionTime + grace`, marque la question terminée et calcule les scores |
| T = 33–37 s | Tous | Au polling suivant, reçoivent `results` + `questionCompleted=true` → affichent résultats + Top 3 |
| T = 37 s+ | Prof | Clique « Question suivante » (mode manuel) → POST `next_question` (questionIndex=1) |
| T = 37,1 s | Serveur | Pose `currentQuestion=1`, reset `questionCompleted=false` |
| T = 37–41 s | Élèves | Au polling suivant, voient la nouvelle question, démarrent leur nouveau timer |

**Latence perçue** (intervalle entre clic prof et apparition chez le dernier élève) : **0 à 4 s** (cible). Acceptable pour un quiz pédagogique.

## 7. Calcul du score

Quand une question est marquée `questionCompleted = true`, le serveur appelle `calculateQuestionScores` :

1. Pour chaque joueur ayant une réponse à cet index :
   - Compare la réponse à la bonne réponse selon le type (multiple, truefalse, order, freetext)
   - Si correct : `points = max(0, round(1000 - timeSpent / 100))` (où `timeSpent` est en ms)
     - Réponse instantanée (0 ms) ≈ 1000 points
     - Réponse à 5 s ≈ 950 points
     - Réponse à 30 s ≈ 700 points
   - Si incorrect : 0 point

Le score est **juste** *par construction* : il dépend uniquement du temps écoulé entre l'affichage de la question chez l'élève et son clic, mesuré localement par son navigateur. Il n'est pas affecté par la latence du polling ni par le moment où la requête arrive sur le serveur — **à condition que la réponse soit acceptée**.

**Bug actuel à corriger (Lot 1)** : si la réponse arrive sur le serveur après que l'auto-completion ait déjà tourné (élève qui a cliqué dans le temps imparti mais dont le réseau était lent), elle est stockée mais **jamais évaluée**. Elle apparaît comme `correct: false`, `points: 0` — voire `answered: false` si elle n'arrive jamais. Solution : accepter rétroactivement les réponses dont le `timeSpent` reste ≤ `(questionTime + GRACE) × 1000` ms et recalculer le score de ce joueur uniquement.

## 8. Charge réseau

À 20 élèves + 1 prof + 1 projection (chiffres mesurés) :

| Source | Fréquence actuelle | Volume actuel | Volume cible |
|---|---|---|---|
| Élève → `get_state` | 2 s | 600 req/min | 200 req/min |
| Élève → `check_question_timeout` (watchdog) | 2-3 s en question | jusqu'à +600 req/min | 0 (supprimé) |
| Prof → `get_control_state` | 2 s | 30 req/min | 20 req/min |
| Projection → `get_control_state` | 1.5 s | 40 req/min | 20 req/min |
| **Total** |  | **700-1300 req/min** | **~240 req/min** |

Soit une **division par 4 à 6** de la charge serveur. Important : OVH mutualisé peut bannir l'IP si le débit dépasse certains seuils (non documentés mais observés autour de 1000 req/min en pic). À 20 élèves, on était parfois au-dessus du seuil ; après correctifs, on a une marge de sécurité confortable.

## 9. Modes de défaillance et réponses

### 9.1 Élève — perte de réseau temporaire

- **3 échecs consécutifs de `get_state`** → popup « connexion perdue », passage en mode reconnexion
- Reconnexion : retry exponentiel 2 s → 4 s → 8 s → 10 s plafond, indéfiniment
- À la reconnexion, polling normal reprend ; `lastPing` est rafraîchi côté serveur
- Si l'élève était en train de répondre : la réponse est sauvegardée en `localStorage` ; un retry automatique la renvoie dès que la connexion revient

### 9.2 Élève — réponse en transit pendant la fin du timer

- Cas problématique avant correctifs (cf. § 7)
- Après correctifs : la réponse est acceptée tant que `timeSpent ≤ (questionTime + GRACE) × 1000` ms côté client. L'élève ne voit jamais « temps écoulé » s'il a réellement cliqué dans le temps imparti perçu chez lui

### 9.3 Prof — clic « next » qui n'arrive pas

- Avant correctifs : `currentQuestion` est incrémenté côté JS avant même que le serveur confirme. Si la requête échoue, le prof croit avoir avancé mais la session est toujours sur l'ancienne question
- Après correctifs : pas d'incrément optimiste. Retry exponentiel 0,5 s → 1,5 s → 4 s. Bouton désactivé pendant la séquence avec spinner. En cas d'échec final, alerte « Action non confirmée — réessayer ? »
- **Idempotence** : si le serveur reçoit `next_question` avec `questionIndex ≤ currentQuestion`, il renvoie succès sans rien faire. Évite les doubles-clics

### 9.4 Prof — fenêtre prof crash ou réseau coupé

- Projection continue de polling indépendamment et reste à jour
- Élèves continuent de polling et la session reste active (`SESSION_TIMEOUT = 30 min` après correctifs)
- Au retour du prof, il rouvre la fenêtre de pilotage : le polling reprend, l'état est restauré

### 9.5 Serveur — contention disque

- Avant correctifs : 20 verrous flock concurrents toutes les 2 s ⇒ certaines requêtes dépassent le timeout client ⇒ « connexion perdue »
- Après correctifs : verrou flock conservé pour les écritures critiques (`submitAnswer`), abandonné sur les pollings simples. `cleanOldSessions` n'est plus appelé à chaque requête (échantillonnage 1 %). Le « verrou forcé après 5 s » qui pouvait corrompre le JSON est supprimé — à la place, échec propre avec retry côté client.

### 9.6 Serveur — coupure entre deux écritures

- Écriture atomique systématique : on écrit dans un fichier `.tmp` puis `rename()` (atomique sur Linux)
- En cas de crash entre `tmp` et `rename`, le fichier original reste intact

## 10. Endpoints HTTP

### `php/game.php` (côté élève)

| Action | Méthode | Description |
|---|---|---|
| `join` | POST | Rejoindre une partie (`playCode`, `nickname`) |
| `leave` | POST | Quitter une partie |
| `get_state` | GET | Récupérer l'état complet (équivaut aussi à un ping) |
| `submit_answer` | POST | Envoyer une réponse |
| `reconnect_player` | POST | Reprendre la connexion après une perte |
| `check_question_timeout` | GET | **À supprimer (Lot 3)** — watchdog redondant |
| `stream` | GET (SSE) | **À supprimer (Lot 4)** — connexion persistante non viable |

### `php/control.php` (côté prof + projection)

| Action | Méthode | Description |
|---|---|---|
| `create_session` | POST | Créer une session à partir d'un quiz |
| `start_game` | POST | Passer la session de `waiting` à `playing` |
| `next_question` | POST | Avancer à une question donnée |
| `pause_game` | POST | Mettre en pause (toggle) |
| `force_question_complete` | POST | Forcer la fin de la question courante (resync) |
| `end_game` | POST | Passer à `finished` |
| `update_player_score` | POST | Modifier manuellement le score d'un joueur |
| `remove_player` | POST | Retirer un joueur |
| `get_control_state` | GET | État pour le pilotage et la projection |

### `php/api.php` (gestion des quizzes — hors temps réel)

`save_quiz`, `load_quiz`, `list_quizzes`, `verify_modify_code`, `check_game`, `get_animals`, etc.

## 11. Ce qui rend l'application *juste*, *robuste* et *peu coûteuse*

| Propriété | Mécanisme |
|---|---|
| **Justesse du score** | Mesure du temps de réponse côté client (en ms), réponses acceptées rétroactivement dans la grâce, pas de pénalité due au réseau |
| **Tolérance aux pertes réseau** | Polling > push, retry localStorage des réponses, backoff exponentiel à la reconnexion, écriture atomique côté serveur |
| **Idempotence des actions prof** | `next_question` ignore les indices ≤ courant, `force_question_complete` réentrante, écritures atomiques |
| **Charge minimale** | Polling adaptatif (4-6 s côté élève), un seul endpoint (pas de ping séparé), suppression du watchdog et du SSE, jitter pour éviter les rafales synchrones |
| **Indépendance projection / prof** | Polling séparé, même endpoint mais pas de dépendance entre fenêtres |
