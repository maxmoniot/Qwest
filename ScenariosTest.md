# Scénarios de test — Qwest

10 scénarios pour valider la robustesse à 20 élèves. Chaque scénario décrit :
- **Setup** : ce qu'il faut préparer
- **Protocole** : la séquence d'actions à exécuter
- **Critères de réussite** : ce qu'on doit observer
- **Métriques à mesurer** : compteurs à enregistrer

Pour exécuter ces scénarios, deux options :
1. **Manuelle** : ouvrir N onglets sur des navigateurs différents (Chrome, Firefox), avec DevTools → Network → Throttling pour simuler la latence
2. **Automatique** : utiliser le script `qwest/scripts/load_test.php` (cf. § Annexe A)

Tous les scénarios partent du même état de base : un quiz de 10 questions de 30 s chacune, mode manuel désactivé (auto-advance), Top 3 affiché entre questions.

---

## Scénario 1 — Connexion stable (référence)

### Setup
- 20 onglets élèves sur un Wifi stable
- 1 fenêtre prof + 1 fenêtre projection
- Aucune limitation réseau

### Protocole
1. Le prof crée la session, partage le code
2. Les 20 élèves rejoignent et choisissent un avatar dans les 30 s
3. Le prof lance la partie
4. Pour chaque question : tous les élèves répondent dans la fenêtre 5–25 s
5. Top 3 s'affiche, on enchaîne automatiquement
6. À la 10ᵉ question, écran final affiché

### Critères de réussite
- 0 popup « connexion perdue »
- 0 écran « ⏰ Temps écoulé » pour les élèves ayant cliqué
- 100 % des réponses comptabilisées (`answered: true` dans le récap final)
- Top 3 cohérent : le 1er a bien le score le plus élevé

### Métriques à mesurer
- Volume de requêtes par minute (relevé dans DevTools Network ou logs Apache) — **cible : ≤ 250 req/min**
- Temps moyen de transition entre fin question et apparition de la suivante chez les élèves — **cible : ≤ 5 s**
- Latence moyenne d'une requête `get_state` — **cible : p95 < 1 s**

---

## Scénario 2 — Connexion lente uniforme

### Setup
- Identique au scénario 1
- Sur les 20 onglets élèves : DevTools → Network → Throttling « Slow 3G » (latence ~2 s, débit limité)

### Protocole
- Identique au scénario 1

### Critères de réussite
- 0 popup « connexion perdue » (la tolérance avant alerte est ≥ 12 s, donc 2 s de latence acceptable)
- 0 « temps écoulé » injuste
- Tous les scores corrects
- Affichage des questions retardé d'au plus 6–8 s (acceptable)

### Métriques à mesurer
- Nombre de retries `submit_answer` — devrait être faible (< 5 % des réponses)
- Nombre d'échecs `get_state` consécutifs maximum — devrait rester < 3 sur la durée

---

## Scénario 3 — Connexion oscillante (50 % perte)

### Setup
- 20 onglets élèves
- Sur 10 d'entre eux : injection d'une perte de 50 % via un proxy (par ex. `tc qdisc` Linux ou un proxy local qui drop aléatoirement)
- Alternative simplifiée : ouvrir/fermer rapidement le mode avion sur 5 onglets pendant la partie

### Protocole
- Lancer une partie standard de 5 questions
- Pendant chaque question, sur les 10 onglets affectés : couper et rétablir le réseau toutes les 4 s

### Critères de réussite
- Les 10 onglets stables fonctionnent normalement
- Les 10 onglets oscillants peuvent voir la popup « connexion perdue » au pire moment, mais elle disparaît dès la reconnexion
- À la fin : tous les élèves ayant cliqué une réponse ont leur réponse comptabilisée (vérifier dans le tableau de suivi prof)
- Aucun JSON de session corrompu côté serveur

### Métriques à mesurer
- Nombre de popups « connexion perdue » apparues sur les 10 onglets oscillants
- Taux de réponses retentées avec succès via le buffer localStorage
- Vérifier visuellement que les scores des onglets oscillants ne sont pas systématiquement à 0

---

## Scénario 4 — Interruption partielle de 30 s pendant une question

### Setup
- 20 onglets élèves
- Identifier 5 d'entre eux comme « groupe A »

### Protocole
1. Lancer une partie
2. À la question 2, durée 30 s : au moment T = 5 s (5 secondes après l'apparition de la question), couper le Wifi sur les 5 onglets du groupe A
3. À T = 35 s (5 s après la fin théorique de la question, donc question déjà passée), rétablir le Wifi
4. Vérifier l'état des onglets du groupe A et du groupe B (15 onglets stables)
5. Continuer la partie

### Critères de réussite
- Les 15 onglets stables : aucune perturbation, scores corrects
- Les 5 onglets coupés : popup « connexion perdue » apparaît dans les ~12 s suivant la coupure (3 échecs × 4 s de polling)
- Au retour : reconnexion automatique, l'écran est restauré sur la **question courante** (pas sur la question manquée)
- Vérifier dans le tableau prof : ces 5 élèves apparaissent comme « non répondu » à la question 2 (`answered: false`) — ce qui est juste, puisqu'ils étaient déconnectés
- L'écran « Temps écoulé » est acceptable ici (ils n'ont vraiment pas répondu)

### Métriques à mesurer
- Délai entre rétablissement du Wifi et reprise de l'affichage normal — **cible : ≤ 8 s**
- Vérifier que la session n'est pas marquée comme expirée (le SESSION_TIMEOUT à 30 min couvre largement)

---

## Scénario 5 — Réponse au dernier moment (juste-juste)

C'est **le scénario critique** pour valider la correction du bug « temps écoulé » au Top 3.

### Setup
- 20 onglets élèves sur Wifi stable
- Question de 30 s

### Protocole
1. Lancer une partie
2. Pour chaque question, **synchroniser les 20 onglets** : tous cliquent leur réponse à T = 29,5 s (0,5 s avant la fin théorique du timer)
3. Le serveur va recevoir 20 POST `submit_answer` simultanés à un moment où le timer est déjà presque écoulé

### Critères de réussite
- **0 onglet** ne voit l'écran « ⏰ Temps écoulé »
- **20 réponses** comptabilisées dans le tableau prof, avec `correct` calculé selon la justesse de la réponse
- Si la grâce a fonctionné : les `timeSpent` retenus sont tous ≤ 30 000 ms (vérifier dans le récap)
- Si une réponse arrive après l'auto-completion : elle est rétroactivement scorée et le joueur a bien des points (Top 3 affiché côté projection peut ne pas refléter ce dernier ajout, mais le score interne est correct)

### Métriques à mesurer
- Distribution des `timeSpent` reçus côté serveur
- Nombre de réponses arrivées après `questionCompleted=true` mais acceptées rétroactivement
- **Si avant correctif (Lot 1)** : on devrait voir plusieurs écrans « Temps écoulé » et plusieurs `points: 0` injustes
- **Si après correctif (Lot 1)** : 0 « Temps écoulé », 0 `points: 0` injuste

---

## Scénario 6 — Prof clique « next » 3× rapidement

### Setup
- Partie en cours, question 2 affichée
- Le prof a un onglet sur Slow 3G (DevTools throttling), pour simuler des timeouts intermittents

### Protocole
1. Le prof attend que la question 2 soit terminée (résultats affichés)
2. Le prof clique « Question suivante » trois fois en moins d'1 seconde

### Critères de réussite
- **On ne saute pas de question** : la session passe de Q2 à Q3 (une seule fois), pas à Q5
- Le bouton « Question suivante » est désactivé pendant la requête (avec spinner) pour empêcher physiquement les multiples clics
- Si une requête échoue (timeout) : retry automatique, pas d'incrément côté JS prof avant confirmation
- Dans les logs serveur : on voit éventuellement plusieurs `next_question` arriver, mais seuls les `questionIndex > currentQuestion` sont appliqués

### Métriques à mesurer
- Vérifier que `currentQuestion` côté serveur est exactement Q3 (pas Q4 ou Q5) après les 3 clics
- Nombre de retries effectués côté JS prof

---

## Scénario 7 — Coupure du poste prof pendant la partie

### Setup
- Partie en cours
- 20 onglets élèves
- Fenêtre prof + fenêtre projection

### Protocole
1. À la question 3, le prof **ferme la fenêtre de pilotage** (sans terminer la partie). La projection reste ouverte
2. Pendant 30 s, les élèves jouent normalement (la projection continue d'afficher l'état)
3. Le prof rouvre la fenêtre de pilotage en tapant le code de modification

### Critères de réussite
- Pendant la coupure prof :
  - La projection continue de polling et reflète l'état serveur en temps réel
  - Les élèves continuent normalement (en mode auto-advance, l'auto-completion serveur prend le relais)
- Au retour du prof : l'interface de pilotage retrouve l'état correct (currentQuestion, scores, joueurs connectés)
- Aucune session perdue, aucun élève déconnecté

### Métriques à mesurer
- Délai pour que le prof retrouve un état utilisable après réouverture — **cible : ≤ 5 s**
- Vérifier que `SESSION_TIMEOUT` (30 min) n'est pas atteint pendant la coupure

---

## Scénario 8 — Reconnexion massive simultanée (coupure Wifi collège)

### Setup
- 20 onglets élèves connectés en partie
- Simuler une coupure générale du Wifi : couper le routeur ou désactiver l'interface réseau de la machine de test pendant 30 s

### Protocole
1. Partie en cours, question 4 démarrée
2. Couper le Wifi pour les 20 onglets simultanément
3. Attendre 30 s
4. Rétablir le Wifi
5. Observer la reconnexion

### Critères de réussite
- Les 20 onglets se reconnectent avec succès
- Le serveur n'est **pas écrasé** par 20 requêtes simultanées :
  - Le **jitter** (±15 % sur les intervalles de polling) étale les requêtes
  - Le backoff exponentiel à la reconnexion ajoute un retard aléatoire
- L'IP du collège n'est pas bannie par OVH

### Métriques à mesurer
- Pic de requêtes par seconde au moment de la reconnexion — **cible : ≤ 8 req/s** (étalées sur 5–10 s)
- Nombre de requêtes en erreur 5xx pendant la rafale
- Délai pour que tous les onglets soient à nouveau opérationnels — **cible : ≤ 15 s**

---

## Scénario 9 — Charge max (30 élèves)

### Setup
- 30 onglets élèves (au-delà de la cible de 20, pour vérifier la marge)
- Wifi stable
- 1 prof + 1 projection + 1 teacher-play

### Protocole
- Identique au scénario 1, mais avec 30 élèves

### Critères de réussite
- Tous les onglets fonctionnent
- Volume de requêtes : `30 × 60/4 + 30 × 60/6 + 60/3 + 60/3 ≈ 300-350 req/min` — sous le seuil de bannissement OVH
- 0 popup « connexion perdue »
- Tous les scores corrects

### Métriques à mesurer
- Volume de requêtes/min — **cible : ≤ 400 req/min**
- Latence p95 des requêtes — **cible : < 2 s**
- Si on dépasse 400 req/min : revoir le polling adaptatif à la baisse pour les classes > 25 élèves

---

## Scénario 10 — Corruption JSON / panne `rename`

C'est un test de **résilience** au niveau serveur.

### Setup
- Partie en cours
- Modifier temporairement `php/game.php` pour injecter une erreur dans la fonction `saveSessionAndUnlock` :

```php
// Mock de panne
if (rand(1, 20) === 1) {
    error_log("MOCK_FAIL: Simulé échec rename");
    return; // Sortie sans écrire
}
```

### Protocole
1. Lancer une partie de 5 questions à 20 élèves
2. Pendant la partie, environ 5 % des écritures vont échouer (mock)
3. À la fin : restaurer le code, vérifier l'état des sessions

### Critères de réussite
- Aucun JSON corrompu (pas de fichier tronqué)
- Les écritures qui échouent sont retentées côté client (les actions prof et les `submit_answer` ont un retry)
- Les pertes éventuelles sont compensées par le polling : un élève qui n'a pas vu sa réponse enregistrée la renvoie via le buffer localStorage
- Le score final reste cohérent (somme des points par question)

### Métriques à mesurer
- Nombre de retries effectués côté client
- Nombre de réponses définitivement perdues (devrait être 0 grâce au buffer localStorage)
- État final du fichier JSON : valide JSON, structure cohérente

---

## Récapitulatif — matrice de validation

| Scénario | Charge | Connexion | Bug visé | Lot prioritaire |
|---|---|---|---|---|
| 1 — Stable | 20 | OK | Référence | Tous |
| 2 — Lent | 20 | 2 s latence | Popup connexion perdue | Lot 3 |
| 3 — Oscillant | 20 | 50 % perte | Popup connexion perdue, justesse | Lot 1 + Lot 3 |
| 4 — Interruption | 20 | 5 onglets coupés 30 s | Reconnexion | Lot 3 |
| 5 — Dernier moment | 20 | OK | « Temps écoulé » injuste | **Lot 1 (critique)** |
| 6 — Next 3× | 20 | OK | Saut de question | Lot 2 |
| 7 — Coupure prof | 20 | Prof coupé 30 s | Robustesse projection | Lot 4 |
| 8 — Reconnexion massive | 20 | Tous coupés 30 s | Bannissement IP, jitter | Lot 3 + Lot 4 |
| 9 — Charge max | 30 | OK | Tenue à la charge | Lot 3 |
| 10 — Corruption JSON | 20 | OK | Robustesse serveur | Lot 4 |

---

## Annexe A — Utilisation du script `load_test.php`

Le script `qwest/scripts/load_test.php` (créé en Lot 5) permet de simuler les scénarios sans avoir 20 onglets ouverts.

### Lancement

```bash
php scripts/load_test.php \
  --base-url=http://localhost/qwest \
  --play-code=AB12CD \
  --players=20 \
  --duration=300 \
  --latency=200 \
  --jitter=100 \
  --drop-rate=0.05 \
  --scenario=stable
```

### Paramètres

| Option | Description | Défaut |
|---|---|---|
| `--base-url` | URL de base du serveur | `http://localhost/qwest` |
| `--play-code` | Code de la partie (pré-créée par le prof) | obligatoire |
| `--players` | Nombre d'élèves simulés | 20 |
| `--duration` | Durée en secondes | 300 |
| `--latency` | Latence ajoutée par requête (ms) | 0 |
| `--jitter` | Jitter sur la latence (ms) | 0 |
| `--drop-rate` | Taux de paquets droppés (0 à 1) | 0 |
| `--scenario` | Préset : `stable`, `slow`, `oscillating`, `interrupt`, `last-second` | `stable` |

### Sortie

Rapport en fin d'exécution :
- Nombre total de requêtes envoyées
- Distribution des codes de réponse (200, 5xx, timeout)
- Latence p50, p95, p99
- Taux de réponses acceptées vs perdues
- Nombre de popups « connexion perdue » simulées
- Score final de chaque élève simulé

### Pré-requis

- PHP 7.4+ avec extensions `curl` et `pcntl`
- La session `play-code` doit avoir été créée par un prof avant de lancer le script
- Le quiz doit avoir au moins 5 questions
