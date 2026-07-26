<?php
/**
 * Qwest — Simulateur de charge multi-élèves
 *
 * Simule N élèves connectés en parallèle à une partie réelle (créée au préalable
 * par le prof via l'interface). Chaque élève virtuel :
 *   - rejoint la partie (action=join)
 *   - poll get_state à intervalle adaptatif (jitter inclus)
 *   - dès qu'une question est active, programme un envoi de réponse à T = answerAt
 *   - retry les réponses qui échouent (3 fois, comme le client réel)
 *   - applique une politique de panne réseau configurable (latence, perte)
 *
 * Le tout en utilisant curl_multi_exec pour paralléliser sans pcntl.
 *
 * Usage :
 *   php scripts/load_test.php \
 *       --base-url=http://localhost/qwest \
 *       --play-code=AB12CD \
 *       --players=20 \
 *       --duration=180 \
 *       --scenario=stable
 *
 * Scénarios :
 *   stable        : connexion idéale (référence)
 *   slow          : 2 s de latence ajoutée par requête
 *   oscillating   : 30 % de requêtes perdues aléatoirement
 *   last-second   : tous les élèves répondent à T = questionTime - 0.5 s
 *   interrupt     : 25 % des élèves perdent le réseau pendant 30 s à mi-partie
 *   fast          : tous les élèves répondent en moins de 2 s
 */

if (php_sapi_name() !== 'cli') {
    fwrite(STDERR, "Ce script doit être lancé en CLI (php scripts/load_test.php …)\n");
    exit(1);
}

// Hash SHA-256 de prof123 — identique à TEACHER_HASH dans php/control.php et
// CONFIG.TEACHER_PASSWORD_HASH dans js/config.js. Le simulateur agit en tant que
// "prof" pour les actions de pilotage (start_game, next_question, force_question_complete).
const TEACHER_HASH = '00624b02e1f9b996a3278f559d5d55313552ad2c0bafc82adfd975c12df61eaf';

// ============================================================
// Parsing des arguments
// ============================================================
function parseArgs(array $argv): array {
    $defaults = [
        'base-url'   => 'http://localhost/qwest',
        'play-code'  => '',
        'players'    => 20,
        'duration'   => 180,        // secondes
        'scenario'   => 'stable',
        'latency'    => 0,           // ms, ajoutés artificiellement avant chaque requête
        'jitter'     => 0,           // ms, jitter sur la latence
        'drop-rate'  => 0.0,         // 0 à 1
        'auto-prep'  => 1,           // 1 = avance la partie sur une question active si nécessaire
        'verbose'    => false,
    ];
    $opts = $defaults;
    foreach (array_slice($argv, 1) as $arg) {
        if (preg_match('/^--([a-z\-]+)(?:=(.*))?$/i', $arg, $m)) {
            $key = $m[1];
            $val = $m[2] ?? true;
            if (!array_key_exists($key, $opts)) {
                fwrite(STDERR, "Option inconnue : --$key\n");
                exit(2);
            }
            $opts[$key] = is_numeric($val) ? $val + 0 : $val;
        }
    }
    if ($opts['play-code'] === '') {
        fwrite(STDERR, "ERREUR : --play-code est obligatoire (créez la partie côté prof avant de lancer ce script)\n");
        exit(2);
    }
    return $opts;
}

// ============================================================
// Application des presets de scénario
// ============================================================
function applyScenario(array $opts): array {
    switch ($opts['scenario']) {
        case 'stable':
            // Aucun changement
            break;
        case 'slow':
            $opts['latency']   = max($opts['latency'], 2000);
            $opts['jitter']    = max($opts['jitter'], 200);
            break;
        case 'oscillating':
            $opts['drop-rate'] = max($opts['drop-rate'], 0.30);
            $opts['jitter']    = max($opts['jitter'], 800);
            break;
        case 'last-second':
            $opts['_lastSecond'] = true;
            break;
        case 'interrupt':
            $opts['_interrupt'] = true;
            break;
        case 'fast':
            $opts['_fastAnswer'] = true;
            break;
        default:
            fwrite(STDERR, "Scénario inconnu : {$opts['scenario']}\n");
            exit(2);
    }
    return $opts;
}

// ============================================================
// Métriques
// ============================================================
class Metrics {
    public $requestsTotal = 0;
    public $requestsOk = 0;
    public $requestsErr = 0;
    public $requestsDropped = 0;
    public $latencies = [];           // ms
    public $popups = 0;                // popups "connexion perdue" simulées
    public $answersSent = 0;
    public $answersAccepted = 0;
    public $answersRejected = 0;
    public $answersLateAccepted = 0;
    public $unjustTimeout = 0;         // élève qui a cliqué dans le délai mais voit "temps écoulé"
    public $prepFailed = false;
    public $prepError = '';

    public function recordLatency(float $ms): void {
        $this->latencies[] = $ms;
    }
    public function percentile(float $p): float {
        if (!$this->latencies) return 0.0;
        $arr = $this->latencies;
        sort($arr);
        $idx = (int) floor(($p / 100) * (count($arr) - 1));
        return $arr[$idx];
    }
}

// ============================================================
// Joueur virtuel
// ============================================================
class VirtualPlayer {
    public $id;
    public $nickname;
    public $state = 'joining';           // joining | waiting | playing | answered | results | finished
    public $currentQuestion = -1;
    public $questionStartTime = null;    // timestamp local (ms) où l'élève a vu la question
    public $questionTime = 30;            // s
    public $answerAt = null;              // timestamp local (ms) prévu pour répondre
    public $hasAnswered = false;
    public $consecutiveFailures = 0;
    public $popupShown = false;
    public $isOffline = false;
    public $offlineUntil = 0;
    public $answersSeen = [];             // questionIndex => 'correct' | 'wrong' | 'timeout' | 'sending'
    public $score = 0;
    public $nextPollAt = 0;

    /**
     * Réplique du mécanisme pendingAnswers du client JS (sessionManager.js).
     * Quand une tentative d'envoi échoue (drop simulé ou erreur réseau), on
     * stocke ici la réponse à retenter. Le client réel fait 3 retries immédiats
     * (200/1000/3000 ms) puis indéfiniment toutes les 3 s tant que la question
     * est encore active. Sans ce mécanisme côté simulateur, les tests à fort
     * drop-rate produisaient des faux positifs « temps écoulé INJUSTE ».
     *
     * Format pendingAnswer :
     *   ['questionIndex' => int, 'answer' => string, 'timeSpent' => int,
     *    'attempts' => int, 'nextRetryAt' => int (ms), 'maxAttempts' => int]
     */
    public $pendingAnswer = null;

    public function __construct(int $id) {
        $this->id = $id;
        // Avatar fictif "Sim01", "Sim02", … (pas de collision avec les avatars animaux du serveur)
        $this->nickname = sprintf('Sim%02d', $id);
        $this->nextPollAt = (int) (microtime(true) * 1000);
    }
}

// ============================================================
// Helpers réseau
// ============================================================
function makeCurl(string $url, string $method, array $params, int $timeoutMs): array {
    $ch = curl_init();
    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($params));
    } else {
        $query = http_build_query($params);
        curl_setopt($ch, CURLOPT_URL, $url . '?' . $query);
    }
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT_MS, $timeoutMs);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT_MS, min($timeoutMs, 5000));
    return [$ch, microtime(true)];
}

// ============================================================
// Préparation : amener la partie sur une question ACTIVE
// ============================================================
/**
 * S'assure qu'au démarrage du load_test la partie est bien sur une question
 * en cours (state=playing, currentQuestion>=0, questionCompleted=false). Sans ça,
 * les élèves simulés font juste du polling à vide pendant toute la durée du test.
 *
 * Cas gérés :
 *   - state=waiting    → start_game + next_question(0)
 *   - state=finished   → erreur explicite (recréer une partie)
 *   - playing + questionCompleted=true → next_question(currentQuestion + 1)
 *   - playing + currentQuestion=-1     → next_question(0)
 *   - sinon            → rien à faire, on est sur une question active
 *
 * Retourne true si la partie est prête à être chargée, false sinon avec un message.
 */
function prepareGame(string $base, string $playCode, bool $verbose): array {
    $statusUrl = $base . '/php/control.php';

    // 1) Lire l'état courant
    $ch = curl_init($statusUrl . '?' . http_build_query(['action' => 'get_control_state', 'playCode' => $playCode]));
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 8]);
    $body = curl_exec($ch); curl_close($ch);
    $state = json_decode($body, true);
    if (!$state || empty($state['success'])) {
        return [false, 'Session introuvable côté serveur (pas créée par le prof ?) — playCode=' . $playCode];
    }

    $st = $state['state'] ?? 'waiting';
    $currentQ = (int) ($state['currentQuestion'] ?? -1);
    $completed = !empty($state['questionCompleted']);

    if ($verbose) echo "🔎 État actuel : state=$st currentQuestion=$currentQ completed=" . ($completed ? 'Y' : 'N') . "\n";

    if ($st === 'finished') {
        return [false, 'La partie est terminée (state=finished). Recrée une partie pour relancer un load_test.'];
    }

    // Helper : POST control (avec auth prof injectée automatiquement)
    $post = function (string $action, array $params) use ($statusUrl): array {
        $ch = curl_init($statusUrl);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => http_build_query(array_merge(
                ['action' => $action, 'teacher_hash' => TEACHER_HASH],
                $params
            )),
            CURLOPT_TIMEOUT => 8,
        ]);
        $b = curl_exec($ch); curl_close($ch);
        return json_decode($b, true) ?: [];
    };

    if ($st === 'waiting') {
        echo "⚙️  Préparation : la partie est en attente — start_game + next_question(0)\n";
        $r = $post('start_game', ['playCode' => $playCode, 'manualMode' => '1', 'showTop3' => '1']);
        if (empty($r['success'])) return [false, 'start_game a échoué : ' . json_encode($r)];
        $r = $post('next_question', ['playCode' => $playCode, 'questionIndex' => 0, 'customTime' => '']);
        if (empty($r['success'])) return [false, 'next_question(0) a échoué : ' . json_encode($r)];
        return [true, 'Partie démarrée sur Q0'];
    }

    // state = playing
    if ($currentQ < 0) {
        echo "⚙️  Préparation : currentQuestion=-1 — next_question(0)\n";
        $r = $post('next_question', ['playCode' => $playCode, 'questionIndex' => 0, 'customTime' => '']);
        if (empty($r['success'])) return [false, 'next_question(0) a échoué : ' . json_encode($r)];
        return [true, 'Avancé à Q0'];
    }

    if ($completed) {
        // Vérifier qu'il reste des questions dans le quiz : on relit la session via le fichier
        // (alternative : un endpoint qui retourne le total de questions, mais get_control_state
        // ne le donne pas explicitement). On tente next_question(currentQ + 1) et on voit.
        $next = $currentQ + 1;
        echo "⚙️  Préparation : Q$currentQ complétée — tentative next_question($next)\n";
        $r = $post('next_question', ['playCode' => $playCode, 'questionIndex' => $next, 'customTime' => '']);
        if (empty($r['success'])) return [false, 'next_question(' . $next . ') a échoué : ' . json_encode($r)];
        if (!empty($r['idempotent'])) {
            // Le serveur a refusé d'avancer (probablement plus de questions ou bug)
            return [false, 'Impossible d\'avancer au-delà de Q' . $currentQ . ' — quiz épuisé ? Recrée une partie avec un quiz plus long.'];
        }
        return [true, 'Avancé à Q' . $next];
    }

    return [true, "Déjà sur Q$currentQ active"];
}

// ============================================================
// Simulation principale
// ============================================================
function simulate(array $opts): Metrics {
    $base = rtrim($opts['base-url'], '/');
    $playCode = strtoupper(trim($opts['play-code']));
    $duration = (int) $opts['duration'];
    $nPlayers = (int) $opts['players'];
    $latencyMs = (int) $opts['latency'];
    $jitterMs = (int) $opts['jitter'];
    $dropRate = (float) $opts['drop-rate'];
    $verbose = !empty($opts['verbose']);

    $metrics = new Metrics();

    // Préparation : s'assurer qu'une question active existe avant de simuler
    if (!empty($opts['auto-prep'])) {
        [$ok, $msg] = prepareGame($base, $playCode, $verbose);
        echo ($ok ? '✅ ' : '❌ ') . $msg . "\n\n";
        if (!$ok) {
            $metrics->prepFailed = true;
            $metrics->prepError = $msg;
            return $metrics;
        }
    }

    $players = [];
    for ($i = 1; $i <= $nPlayers; $i++) {
        $players[] = new VirtualPlayer($i);
    }

    // Sélection des "victimes" du scénario interrupt
    $interrupted = [];
    if (!empty($opts['_interrupt'])) {
        $cnt = max(1, (int) round($nPlayers * 0.25));
        $picked = array_slice(array_keys($players), 0, $cnt);
        $interruptStartAt = microtime(true) + $duration / 2;
        $interruptEndAt = $interruptStartAt + 30;
        foreach ($picked as $idx) {
            $interrupted[$idx] = ['start' => $interruptStartAt, 'end' => $interruptEndAt];
        }
        echo "ℹ️  Interrupt scenario : élèves " . implode(',', array_map(fn($i) => $players[$i]->id, $picked)) .
             " coupés entre T+" . round($duration/2) . "s et T+" . round($duration/2 + 30) . "s\n";
    }

    $startWall = microtime(true);
    $endWall = $startWall + $duration;

    $mh = curl_multi_init();
    /** @var array<string, array{ch: resource, player: VirtualPlayer, kind: string, startedAt: float, params: array}> */
    $inflight = [];

    echo "▶️  Démarrage : $nPlayers élèves, $duration s, scénario={$opts['scenario']}\n";
    echo "    base-url=$base, play-code=$playCode\n";
    echo "    latency=" . $latencyMs . "ms ±" . $jitterMs . "ms, drop-rate=" . round($dropRate * 100) . "%\n\n";

    while (microtime(true) < $endWall) {
        $now = microtime(true);
        $nowMs = (int) ($now * 1000);

        // Mise à jour de l'état "offline" pour le scénario interrupt
        foreach ($interrupted as $idx => $window) {
            $p = $players[$idx];
            if ($now >= $window['start'] && $now < $window['end']) {
                if (!$p->isOffline) {
                    $p->isOffline = true;
                    $p->offlineUntil = $window['end'];
                    if ($verbose) echo "📴 {$p->nickname} : passage offline jusqu'à T+" . round($window['end'] - $startWall) . "s\n";
                }
            } elseif ($p->isOffline && $now >= $window['end']) {
                $p->isOffline = false;
                $p->consecutiveFailures = 0;
                if ($verbose) echo "📶 {$p->nickname} : retour online\n";
            }
        }

        // Lancer les nouvelles requêtes pour chaque joueur prêt
        foreach ($players as $idx => $p) {
            if (isset($inflight['poll_' . $p->id]) || isset($inflight['answer_' . $p->id])) {
                continue;
            }
            if ($p->isOffline) continue;
            if ($p->state === 'finished') continue;

            // Phase JOIN
            if ($p->state === 'joining') {
                [$ch, $startedAt] = makeCurl($base . '/php/game.php', 'POST',
                    ['action' => 'join', 'playCode' => $playCode, 'nickname' => $p->nickname],
                    8000);
                curl_multi_add_handle($mh, $ch);
                $inflight['poll_' . $p->id] = ['ch' => $ch, 'player' => $p, 'kind' => 'join', 'startedAt' => $startedAt, 'params' => []];
                $metrics->requestsTotal++;
                continue;
            }

            // Phase POLL
            if ($p->nextPollAt <= $nowMs && $p->state !== 'finished') {
                // Drop simulé
                if ($dropRate > 0 && mt_rand(1, 10000) / 10000 < $dropRate) {
                    $metrics->requestsDropped++;
                    $p->consecutiveFailures++;
                    if ($p->consecutiveFailures >= 3 && !$p->popupShown) {
                        $p->popupShown = true;
                        $metrics->popups++;
                        if ($verbose) echo "⚠️  {$p->nickname} : popup connexion perdue (drop)\n";
                    }
                    $p->nextPollAt = $nowMs + nextPollDelay($p);
                    continue;
                }

                [$ch, $startedAt] = makeCurl($base . '/php/game.php', 'GET',
                    ['action' => 'get_state', 'playCode' => $playCode, 'nickname' => $p->nickname],
                    10000);
                curl_multi_add_handle($mh, $ch);
                $inflight['poll_' . $p->id] = ['ch' => $ch, 'player' => $p, 'kind' => 'poll', 'startedAt' => $startedAt, 'params' => []];
                $metrics->requestsTotal++;
                // Latence simulée : on décale le PROCHAIN poll de cet élève (non bloquant pour
                // les autres élèves). Auparavant, un usleep(2000ms) en série bloquait toute la
                // boucle et empêchait les 19 autres élèves de polling pendant 40s+ par tour.
                if ($latencyMs > 0) {
                    $jit = $jitterMs > 0 ? mt_rand(-$jitterMs, $jitterMs) : 0;
                    $p->nextPollAt = $nowMs + max(0, $latencyMs + $jit);
                }
            }

            // Phase ANSWER — première tentative (élève qui clique)
            if ($p->state === 'playing' && !$p->hasAnswered && $p->answerAt !== null && $p->answerAt <= $nowMs) {
                $timeSpent = $nowMs - $p->questionStartTime;
                $answer = json_encode(['index' => 0]); // toujours répondre "0" — on teste la mécanique, pas la justesse
                $p->hasAnswered = true;
                $metrics->answersSent++;

                // Drop simulé : l'élève "a cliqué" mais sa requête n'atteint pas le serveur.
                // Comme le client JS réel : on programme un retry (4 tentatives au total :
                // immédiate puis +500ms, +1500ms, +5000ms). Tant que la pendingAnswer existe,
                // l'écran « envoi en cours » reste affiché côté client → pas un timeout.
                if ($dropRate > 0 && mt_rand(1, 10000) / 10000 < $dropRate) {
                    $metrics->requestsDropped++;
                    if ($verbose) echo "📉 {$p->nickname} : answer drop simulé (sera retenté)\n";
                    $p->pendingAnswer = [
                        'questionIndex' => $p->currentQuestion,
                        'answer' => $answer,
                        'timeSpent' => $timeSpent,
                        'attempts' => 1,
                        'maxAttempts' => 4,
                        'nextRetryAt' => $nowMs + 500, // backoff initial
                    ];
                    continue;
                }

                [$ch, $startedAt] = makeCurl($base . '/php/game.php', 'POST', [
                    'action' => 'answer',
                    'playCode' => $playCode,
                    'nickname' => $p->nickname,
                    'questionIndex' => $p->currentQuestion,
                    'answer' => $answer,
                    'timeSpent' => $timeSpent,
                ], 10000);
                curl_multi_add_handle($mh, $ch);
                $inflight['answer_' . $p->id] = [
                    'ch' => $ch, 'player' => $p, 'kind' => 'answer',
                    'startedAt' => $startedAt,
                    'params' => ['timeSpent' => $timeSpent, 'questionIndex' => $p->currentQuestion, 'answer' => $answer],
                ];
                $metrics->requestsTotal++;
            }

            // Phase ANSWER RETRY — répétition pour les pendingAnswer (drop précédent)
            if ($p->pendingAnswer !== null
                && $p->pendingAnswer['nextRetryAt'] <= $nowMs
                && $p->pendingAnswer['questionIndex'] === $p->currentQuestion // pas de retry si la partie a avancé
                && !isset($inflight['answer_' . $p->id])) {

                $pa = $p->pendingAnswer;
                $pa['attempts']++;
                $p->pendingAnswer['attempts'] = $pa['attempts'];

                // Drop simulé sur le retry aussi (réaliste : le réseau reste oscillant)
                if ($dropRate > 0 && mt_rand(1, 10000) / 10000 < $dropRate) {
                    $metrics->requestsDropped++;
                    if ($verbose) echo "📉 {$p->nickname} : retry #{$pa['attempts']} drop simulé\n";
                    if ($pa['attempts'] >= $pa['maxAttempts']) {
                        // Échec définitif : le client réel garderait pendingAnswer en background
                        // mais ici on s'arrête. Ce sera alors un "vrai" temps écoulé injuste si
                        // le serveur dit answered=false → bug serveur, à investiguer.
                        if ($verbose) echo "⛔ {$p->nickname} : abandon après {$pa['maxAttempts']} retries\n";
                        $p->pendingAnswer = null;
                    } else {
                        // Backoff exponentiel : 500ms → 1500ms → 5000ms
                        $delays = [500, 1500, 5000, 5000];
                        $p->pendingAnswer['nextRetryAt'] = $nowMs + $delays[min($pa['attempts'] - 1, 3)];
                    }
                    continue;
                }

                // Envoi du retry
                [$ch, $startedAt] = makeCurl($base . '/php/game.php', 'POST', [
                    'action' => 'answer',
                    'playCode' => $playCode,
                    'nickname' => $p->nickname,
                    'questionIndex' => $pa['questionIndex'],
                    'answer' => $pa['answer'],
                    'timeSpent' => $pa['timeSpent'],
                ], 10000);
                curl_multi_add_handle($mh, $ch);
                $inflight['answer_' . $p->id] = [
                    'ch' => $ch, 'player' => $p, 'kind' => 'answer_retry',
                    'startedAt' => $startedAt,
                    'params' => ['timeSpent' => $pa['timeSpent'], 'questionIndex' => $pa['questionIndex'],
                                 'answer' => $pa['answer'], 'attempts' => $pa['attempts']],
                ];
                $metrics->requestsTotal++;
            }
        }

        // Pomper les requêtes en cours
        do {
            $mrc = curl_multi_exec($mh, $running);
        } while ($mrc === CURLM_CALL_MULTI_PERFORM);

        // Récolter les terminées
        while ($info = curl_multi_info_read($mh)) {
            $ch = $info['handle'];
            $key = null;
            foreach ($inflight as $k => $entry) {
                if ($entry['ch'] === $ch) { $key = $k; break; }
            }
            if ($key === null) {
                curl_multi_remove_handle($mh, $ch);
                curl_close($ch);
                continue;
            }
            $entry = $inflight[$key];
            $body = curl_multi_getcontent($ch);
            $latency = (microtime(true) - $entry['startedAt']) * 1000;
            $metrics->recordLatency($latency);
            $err = $info['result'] !== CURLE_OK ? curl_strerror($info['result']) : null;
            $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
            unset($inflight[$key]);

            $p = $entry['player'];
            if ($err || $http >= 500 || !$body) {
                $metrics->requestsErr++;
                $p->consecutiveFailures++;
                if ($p->consecutiveFailures >= 3 && !$p->popupShown) {
                    $p->popupShown = true;
                    $metrics->popups++;
                    if ($verbose) echo "⚠️  {$p->nickname} : popup connexion perdue (err: " . ($err ?? "HTTP $http") . ")\n";
                }
                // Erreur sur un answer/answer_retry : programmer un retry comme le client JS réel,
                // au lieu de simplement remettre hasAnswered=false (qui désactive l'écran "envoi en cours").
                if ($entry['kind'] === 'answer' || $entry['kind'] === 'answer_retry') {
                    $nowMs = (int) (microtime(true) * 1000);
                    if ($p->pendingAnswer === null) {
                        $p->pendingAnswer = [
                            'questionIndex' => $entry['params']['questionIndex'],
                            'answer' => $entry['params']['answer'] ?? json_encode(['index' => 0]),
                            'timeSpent' => $entry['params']['timeSpent'],
                            'attempts' => 1,
                            'maxAttempts' => 4,
                            'nextRetryAt' => $nowMs + 500,
                        ];
                    } else {
                        $delays = [500, 1500, 5000, 5000];
                        $att = max(1, $p->pendingAnswer['attempts']);
                        $p->pendingAnswer['nextRetryAt'] = $nowMs + $delays[min($att - 1, 3)];
                    }
                }
                $p->nextPollAt = (int) (microtime(true) * 1000) + nextPollDelay($p);
                continue;
            }

            $metrics->requestsOk++;
            $p->consecutiveFailures = 0;
            $data = json_decode($body, true);
            if (!is_array($data)) {
                $metrics->requestsErr++;
                continue;
            }

            handleResponse($p, $entry, $data, $metrics, $opts, $startWall);

            if ($entry['kind'] !== 'answer') {
                $p->nextPollAt = (int) (microtime(true) * 1000) + nextPollDelay($p);
            }
        }

        usleep(50_000); // 50 ms
    }

    // Cleanup
    foreach ($inflight as $entry) {
        curl_multi_remove_handle($mh, $entry['ch']);
        curl_close($entry['ch']);
    }
    curl_multi_close($mh);

    return $metrics;
}

function nextPollDelay(VirtualPlayer $p): int {
    $base = ($p->state === 'playing' && !$p->hasAnswered) ? 4000 : 6000;
    $jitter = mt_rand(-1500, 1500);
    return max(500, $base + $jitter);
}

function handleResponse(VirtualPlayer $p, array $entry, array $data, Metrics $metrics, array $opts, float $startWall): void {
    $verbose = !empty($opts['verbose']);

    if ($entry['kind'] === 'join') {
        if (!empty($data['success'])) {
            $p->state = 'waiting';
        }
        return;
    }

    if ($entry['kind'] === 'answer' || $entry['kind'] === 'answer_retry') {
        if (!empty($data['success'])) {
            $metrics->answersAccepted++;
            if (!empty($data['lateAccepted'])) {
                $metrics->answersLateAccepted++;
                if ($verbose) echo "✅ {$p->nickname} : answer Q{$entry['params']['questionIndex']} acceptée rétroactivement\n";
            }
            // Réponse acceptée par le serveur → plus de pending à retenter
            $p->pendingAnswer = null;
        } elseif (!empty($data['tooLate'])) {
            $metrics->answersRejected++;
            $p->pendingAnswer = null; // pas de retry sur tooLate (rejet définitif côté serveur)
            if ($verbose) echo "⛔ {$p->nickname} : answer Q{$entry['params']['questionIndex']} rejetée (" . ($data['reason'] ?? '?') . ")\n";
        } else {
            // Échec applicatif sans tooLate : programmer un retry comme le client réel
            $nowMs = (int) (microtime(true) * 1000);
            if ($p->pendingAnswer === null) {
                $p->pendingAnswer = [
                    'questionIndex' => $entry['params']['questionIndex'],
                    'answer' => $entry['params']['answer'] ?? json_encode(['index' => 0]),
                    'timeSpent' => $entry['params']['timeSpent'],
                    'attempts' => 1,
                    'maxAttempts' => 4,
                    'nextRetryAt' => $nowMs + 500,
                ];
            } else {
                $p->pendingAnswer['nextRetryAt'] = $nowMs + 1500;
            }
        }
        return;
    }

    if ($entry['kind'] === 'poll') {
        if (empty($data['success'])) return;

        // État de la partie
        if ($data['state'] === 'finished') {
            $p->state = 'finished';
            return;
        }

        // Nouvelle question
        if (isset($data['question']) && $data['currentQuestion'] !== $p->currentQuestion) {
            $p->currentQuestion = (int) $data['currentQuestion'];
            $p->hasAnswered = false;
            $p->pendingAnswer = null; // une nouvelle question annule tout retry de l'ancienne
            $p->questionStartTime = (int) (microtime(true) * 1000);
            $p->questionTime = (int) ($data['question']['data']['time'] ?? 30);
            $p->state = 'playing';

            // Programmer la réponse selon le scénario
            if (!empty($opts['_lastSecond'])) {
                $p->answerAt = $p->questionStartTime + ($p->questionTime - 1) * 1000 + mt_rand(0, 1000);
            } elseif (!empty($opts['_fastAnswer'])) {
                $p->answerAt = $p->questionStartTime + mt_rand(500, 2000);
            } else {
                $p->answerAt = $p->questionStartTime + mt_rand(3000, ($p->questionTime - 2) * 1000);
            }
            if ($verbose) echo "🎯 {$p->nickname} : Q{$p->currentQuestion} reçue, réponse prévue dans " .
                              round(($p->answerAt - $p->questionStartTime) / 1000, 1) . " s\n";
            return;
        }

        // Résultats reçus
        if (isset($data['results'])) {
            $qi = (int) $data['results']['questionIndex'];
            if (!isset($p->answersSeen[$qi])) {
                $stats = $data['results']['questionStats'] ?? [];
                $myStat = null;
                foreach ($stats as $s) {
                    if ($s['nickname'] === $p->nickname) { $myStat = $s; break; }
                }
                if ($myStat === null) {
                    $p->answersSeen[$qi] = 'unknown';
                } elseif ($myStat['answered'] === false) {
                    if ($p->hasAnswered) {
                        // Bug : l'élève a cliqué mais le serveur dit qu'il n'a pas répondu
                        $metrics->unjustTimeout++;
                        $p->answersSeen[$qi] = 'unjust_timeout';
                        if ($verbose) echo "❌ {$p->nickname} : Q$qi marqué 'temps écoulé' alors que hasAnswered=true (BUG)\n";
                    } else {
                        $p->answersSeen[$qi] = 'timeout';
                    }
                } else {
                    $p->answersSeen[$qi] = !empty($myStat['correct']) ? 'correct' : 'wrong';
                    $p->score += (int) ($myStat['pointsEarned'] ?? 0);
                }
            }
            $p->state = 'results';
        }
    }
}

// ============================================================
// Rapport final
// ============================================================
function printReport(Metrics $m, array $opts): void {
    echo "\n========== RAPPORT ==========\n";
    echo "Scénario        : {$opts['scenario']}\n";
    echo "Élèves simulés  : {$opts['players']}\n";
    echo "Durée           : {$opts['duration']} s\n\n";

    if ($m->prepFailed) {
        echo "❌ ÉCHEC DE PRÉPARATION : {$m->prepError}\n";
        echo "Aucune simulation n'a été exécutée. Recrée une partie de test ou utilise --auto-prep=0\n";
        echo "si tu veux quand même lancer la simulation sur l'état actuel.\n";
        return;
    }

    echo "--- Trafic ---\n";
    echo "Requêtes totales   : {$m->requestsTotal}\n";
    echo "  OK              : {$m->requestsOk}\n";
    echo "  Erreur réseau   : {$m->requestsErr}\n";
    echo "  Drop simulé     : {$m->requestsDropped}\n";
    if ($m->latencies) {
        $sum = array_sum($m->latencies);
        echo "Latence moy     : " . round($sum / count($m->latencies), 1) . " ms\n";
        echo "Latence p50     : " . round($m->percentile(50), 1) . " ms\n";
        echo "Latence p95     : " . round($m->percentile(95), 1) . " ms\n";
        echo "Latence p99     : " . round($m->percentile(99), 1) . " ms\n";
    }
    echo "Req/min effectif : " . round($m->requestsTotal * 60 / $opts['duration'], 1) . "\n";
    echo "\n";

    echo "--- Réponses ---\n";
    echo "Envoyées        : {$m->answersSent}\n";
    echo "Acceptées       : {$m->answersAccepted}\n";
    echo "  dont retroact : {$m->answersLateAccepted}\n";
    echo "Rejetées (tooLate): {$m->answersRejected}\n";
    echo "\n";

    echo "--- Robustesse ---\n";
    echo "Popups 'connexion perdue' : {$m->popups}\n";
    if ($m->unjustTimeout > 0) {
        echo "❌ « Temps écoulé » INJUSTES : {$m->unjustTimeout}  ⚠️ BUG\n";
    } else {
        echo "✅ « Temps écoulé » injustes : 0\n";
    }
    echo "\n";
}

// ============================================================
// Main
// ============================================================
$opts = applyScenario(parseArgs($argv));
$metrics = simulate($opts);
printReport($metrics, $opts);
$exit = 0;
if ($metrics->prepFailed) $exit = 2;
elseif ($metrics->unjustTimeout > 0) $exit = 1;
exit($exit);
