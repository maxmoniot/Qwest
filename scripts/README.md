# Scripts de vérification — Qwest

Outils en CLI pour valider la robustesse de l'application avant utilisation en classe. Tous les scripts sont en **PHP autonome** (mêmes pré-requis que l'app : PHP 7.4+ avec extensions `curl` et `json`).

## Pré-requis communs

1. **Apache (XAMPP) doit tourner** localement ou sur le serveur cible.
2. Pour les scripts qui simulent des élèves, **une partie doit avoir été créée par un prof** dans l'interface (`prof123` → créer un quiz → cliquer Piloter → noter le `playCode`).
3. Lancer les scripts depuis la racine du projet : `cd c:/xampp/htdocs/qwest`.

---

## 1. `check_server.php` — Sanity côté serveur

Vérifie que les fichiers PHP n'ont pas d'erreur de syntaxe, que les endpoints répondent du JSON valide, que les SSE désactivés renvoient bien une erreur explicite, et que les sessions sur disque sont cohérentes.

```bash
php scripts/check_server.php --base-url=http://localhost/qwest
```

Avec une session existante, il vérifie aussi l'idempotence des actions de pilotage :

```bash
php scripts/check_server.php --base-url=http://localhost/qwest --play-code=AB12CD
```

À lancer **après chaque déploiement** sur le serveur OVH, et avant chaque journée d'utilisation en classe.

---

## 2. `race_test.php` — Test « réponse au dernier moment »

Reproduit le scénario qui causait des écrans « ⏰ Temps écoulé » injustes : 20 élèves cliquent leur réponse à `T = questionTime - 0,5 s` simultanément, et certains POST arrivent sur le serveur après l'auto-completion.

```bash
# Préparation : créer une partie avec un quiz d'1 question (multiple choice)
# Récupérer le playCode (ex: AB12CD)
# Puis :
php scripts/race_test.php \
    --base-url=http://localhost/qwest \
    --play-code=AB12CD \
    --players=20 \
    --auto-start=1 \
    --question-time=30
```

**Verdict attendu** (après application du Lot 1) :
- ✅ 20 réponses acceptées (success=true)
- ✅ 0 réponse rejetée (`tooLate=false`)
- ✅ 0 élève marqué `answered=false` dans les résultats
- ✅ Total points distribués > 0

**Si le verdict est FAIL** : le bug « temps écoulé » est encore présent — vérifier que `QUESTION_TIMEOUT_GRACE` est bien à 6 dans `php/game.php` et que `submitAnswer` a bien le code d'acceptation rétroactive.

---

## 3. `idempotence_test.php` — Robustesse du pilotage

Vérifie que les actions de pilotage du prof sont **idempotentes** : les retries en cas de timeout ne provoquent pas de double avance, de double scoring, ou de divergence prof/serveur.

```bash
# Pré-requis : partie en cours (state=playing), Q=0 ou supérieure
php scripts/idempotence_test.php --base-url=http://localhost/qwest --play-code=AB12CD
```

Tests exécutés :
1. `next_question(currentQuestion)` → idempotent
2. `next_question(currentQuestion - 1)` → ignorée
3. 3 appels `next_question(currentQuestion + 1)` en parallèle → un seul avance
4. `force_question_complete` répétée → 2ᵉ appel idempotent
5. `pause_game` toggle → état serveur cohérent

**Effet de bord** : ce test fait avancer la partie d'une question. À lancer sur une session de test, pas une vraie partie en classe.

---

## 4. `load_test.php` — Simulateur de charge multi-élèves

> ⚠️ **AVERTISSEMENT — Ce test N'EST PAS suffisant pour valider une partie en classe**
>
> `load_test.php` tourne en CLI PHP avec `curl_multi_exec` depuis **un seul processus**, **une seule IP** locale. Il ne reproduit PAS :
>
> - **NAT collège** : 20 vrais navigateurs derrière une seule IP publique (la box du collège) — déclenche des comportements de l'hébergeur qu'on ne voit jamais en local.
> - **Visibility API** : les onglets en arrière-plan throttlent `setTimeout` à ~1/s côté navigateur — ça réveille en cascade au retour au premier plan.
> - **localStorage** : recovery des `pendingAnswers` après un reload réel, partage entre onglets.
> - **HTTP 429 / 403 OVH** : OVH peut drop silencieusement, pas seulement renvoyer un code propre.
> - **Timing JS / rendu DOM** : 50–500 ms d'overhead que curl n'a pas.
> - **Keep-Alive HTTP + compression** : pas le même comportement que `fetch()` réel.
>
> Conséquence : l'ancien tableau « 20/20 réponses acceptées, latence ~430 ms » dans CLAUDE.md correspond à un environnement IDÉAL irréaliste. La classe réelle voit ~4× plus de volume HTTP que ce que ce simulateur montre.
>
> **À utiliser comme** : test rapide de non-régression côté serveur, validation que le code PHP tient sous N requêtes parallèles, mesure d'idempotence.
>
> **À compléter PAR** : `scripts/honest_load.html` (multi-onglets réels du même navigateur, voir section 6 plus bas) + monitoring via `scripts/dashboard.html` pendant le test.

Le plus complet : simule N élèves en parallèle (via `curl_multi_exec`) avec différents profils réseau, mesure latences et compte les bugs.

```bash
# Scénario stable (référence)
php scripts/load_test.php \
    --base-url=http://localhost/qwest \
    --play-code=AB12CD \
    --players=20 \
    --duration=180 \
    --scenario=stable

# Scénario lent (Slow 3G équivalent : +2 s par requête)
php scripts/load_test.php --base-url=... --play-code=... --scenario=slow

# Scénario oscillant (30 % de pertes)
php scripts/load_test.php --base-url=... --play-code=... --scenario=oscillating

# Scénario "réponse au dernier moment" (tous à T = qTime - 0.5 s)
php scripts/load_test.php --base-url=... --play-code=... --scenario=last-second

# Scénario "interrupt" (25 % des élèves coupent 30 s à mi-partie)
php scripts/load_test.php --base-url=... --play-code=... --scenario=interrupt

# Scénario "fast" (tous répondent en moins de 2 s)
php scripts/load_test.php --base-url=... --play-code=... --scenario=fast
```

Options communes :

| Option | Effet | Défaut |
|---|---|---|
| `--players` | Nombre d'élèves simulés | 20 |
| `--duration` | Durée du test (s) | 180 |
| `--latency` | Latence ajoutée par requête (ms) | 0 |
| `--jitter` | Jitter sur la latence (ms) | 0 |
| `--drop-rate` | Taux de paquets droppés (0 à 1) | 0 |
| `--verbose` | Logs détaillés par élève | off |

**Métriques rapportées** :
- Volume de requêtes (`req/min effectif`)
- Latences p50/p95/p99
- Réponses acceptées / rétroactives / rejetées
- **Popups « connexion perdue »** déclenchées (3 échecs consécutifs)
- **« Temps écoulé » INJUSTES** (élève qui a cliqué mais que le serveur ne voit pas répondre)

**Code de sortie** : 0 si tout OK, 1 si au moins un « temps écoulé » injuste est détecté.

---

## Workflow recommandé avant utilisation en classe

```bash
# 1. Sanity côté serveur (sans partie active)
php scripts/check_server.php --base-url=http://localhost/qwest

# 2. Créer une partie de test (depuis l'interface prof, quiz simple 5 questions)
# → noter le playCode (ex: TEST01)

# 3. Race condition (le bug le plus visible)
php scripts/race_test.php --base-url=http://localhost/qwest --play-code=TEST01 --auto-start=1

# 4. Idempotence (sur la même session, après race_test)
php scripts/idempotence_test.php --base-url=http://localhost/qwest --play-code=TEST01

# 5. Charge — 20 élèves stables (référence)
php scripts/load_test.php --base-url=http://localhost/qwest --play-code=TEST01 --players=20 --scenario=stable --duration=120

# 6. Charge — 20 élèves Wifi lent
php scripts/load_test.php --base-url=http://localhost/qwest --play-code=TEST01 --players=20 --scenario=slow --duration=120

# 7. Charge — 20 élèves Wifi oscillant
php scripts/load_test.php --base-url=http://localhost/qwest --play-code=TEST01 --players=20 --scenario=oscillating --duration=120

# 8. Stress — 30 élèves
php scripts/load_test.php --base-url=http://localhost/qwest --play-code=TEST01 --players=30 --scenario=stable --duration=120
```

Si tous les scripts retournent code 0 et que les métriques sont dans les cibles, l'application est prête à être utilisée avec une classe.

---

## 5. `dashboard.html` — Métriques temps réel

> ⚠️ **TEMPORAIRE** : ce dashboard est à la racine du projet (`qwest/dashboard.html`, pas `scripts/`) car le `.htaccess` de `scripts/` est restreint LAN-only et bloque l'accès depuis OVH. À retirer une fois l'app stabilisée.

Accès :
- depuis le panel prof : bouton « 📊 Dashboard » dans le header du modal de pilotage (lien direct avec le `teacher_hash`)
- ou en direct : `http://<hôte>/qwest/dashboard.html?teacher_hash=<hash>` (auth par le hash prof côté PHP, cf. `dashboard.php`)

Lit en continu `php/data/metrics/YYYY-MM-DD.log` produit par `game.php` et `control.php`.

Affiche en temps réel :
- **Volume global req/min** (avec seuil OVH ~1000 surligné)
- **Graphique d'évolution** par bucket de 5 s
- **Répartition par endpoint** (`get_state_readonly`, `get_state`, `answer_bulk`, etc.)
- **Codes HTTP** (200 / 429 / 5xx) — surveiller les **429** qui indiquent que le throttle PHP a dû couper un client
- **Top 10 devices** les plus actifs (IP + pseudo)

À garder ouvert pendant une partie de test pour voir le **vrai** volume serveur, indépendamment de ce que le `load_test.php` affirme.

---

## 6. `honest_load.html` — Test multi-onglets réels

Pour reproduire la condition NAT collège (1 IP source + 20 onglets de navigateur réels), ouvre `http://localhost/qwest/scripts/honest_load.html`. La page lance N popups vers `index.html` qui jouent comme de vrais élèves avec leur propre Visibility API, localStorage et timing JS.

À ouvrir sur **un seul ordinateur** avec les popups autorisées dans le navigateur. Combiner avec `dashboard.html` pour mesurer le vrai volume.

**Critère de succès** : pic ≤ 1000 req/min mesuré côté serveur (dashboard) pendant toute la durée du test.

---

## Cibles à respecter

| Indicateur | Cible | Si dépassé |
|---|---|---|
| Volume de requêtes serveur (20 élèves stables, mesuré via dashboard) | ≤ 1000 req/min moyenne, ≤ 1500 pic sur 5 s | revoir les intervalles de polling à la hausse |
| Latence p95 d'une requête | < 2 s | OVH surchargé — réduire le nombre d'élèves ou changer d'horaire |
| HTTP 429 reçus sur 20 élèves stables (dashboard) | 0 | un client en boucle infinie — vérifier circuit breaker |
| Popups « connexion perdue » sur 20 élèves stables | 0 | bug de stabilité — réinvestiguer |
| « Temps écoulé » INJUSTES sur 20 élèves last-second | 0 | bug Lot 1 non corrigé |
| Tests d'idempotence | tous PASS | bug Lot 2 non corrigé |
