<?php
// ============================================
// QWEST - CONTROL API
// Description: API de pilotage pour le professeur
// ============================================

header('Content-Type: application/json; charset=utf-8');
// CORS retiré (cf. game.php) — same-origin uniquement.

define('SESSIONS_DIR', __DIR__ . '/data/sessions');

// Timeouts - cohérents avec game.php
define('PING_TIMEOUT', 120); // 120 secondes - Tolérance pour connexions instables
// Seuil d'affichage "déconnecté" côté prof. DOIT être supérieur au cycle de refresh
// de lastPing côté élève : avec POLL_READONLY_RATIO=10 et un poll ~2,5 s, lastPing
// n'est rafraîchi que toutes les ~25 s. À 10 s, le statut de CHAQUE élève clignotait
// (connecté/déconnecté) en permanence, et ce flapping déclenchait une écriture de la
// session à presque chaque get_control_state (1-3 s) → écritures concurrentes inutiles.
define('VISUAL_DISCONNECT_THRESHOLD', 35);
// Marge de grâce après fin du timer côté prof : 3 s pour la resync auto
// (force_question_complete déclenchée par le polling prof). N.B. : la grâce
// côté élève pour accepter une réponse tardive est plus longue (15 s dans
// game.php) — elle absorbe les wifi instables sans toucher au Top 3.
define('QUESTION_TIMEOUT_GRACE', 3);
define('ACTIVE_PLAYER_THRESHOLD', 60); // Seuil pour considérer un joueur comme "actif"

// === Synchro v2 : avance (lead) entre l'instruction prof et l'apparition de la
// question. Le serveur fixe revealAt = maintenant + lead (ms) ; tous les postes ont
// le temps de poller et d'apprendre cet instant avant qu'il n'arrive → ils révèlent
// TOUS au même instant absolu (horloge serveur). Doit rester cohérent avec les
// constantes JS du même nom (config.js). Q0 : depuis le lobby (poll 2,5 s) → plus long.
define('REVEAL_LEAD_MS', 3500);
define('FIRST_REVEAL_LEAD_MS', 4500);

// === THROTTLE prof (anti-ban hébergeur, anti-boucle bug client) ===
// Clé = teacher_hash + REMOTE_ADDR. Limite haute (200/min) : le prof a 3 fenêtres
// possibles (contrôle + projection + teacher-play) qui pollent toutes en parallèle,
// chacune ~30 req/min ≈ 90/min total. 200 laisse de la marge pour les actions
// (next_question, pause, etc.) sans bloquer le déroulement normal d'une partie.
define('CTRL_THROTTLE_DIR', __DIR__ . '/data/throttle');
define('CTRL_THROTTLE_WINDOW_SEC', 60);
define('CTRL_THROTTLE_MAX_REQUESTS', 200);
define('CTRL_THROTTLE_RETRY_AFTER_SEC', 30);

// Store partagé : fichier d'état single-writer (CODE.state.json), complétions
// immuables (CODE.done.qN.json), scores dérivés. Voir l'en-tête de session_store.php.
require_once __DIR__ . '/session_store.php';

// Filet anti-500 : tout crash est tracé (errors-*.log) et converti en JSON dégradé
// HTTP 200 → un bug isolé ne fige plus la classe (le prof reste pilotable). Armé tôt.
qst_registerErrorNet();

// Hash SHA-256 du mot de passe professeur (prof123). Doit être identique à
// CONFIG.TEACHER_PASSWORD_HASH dans js/config.js. Si tu changes le mot de passe,
// changer aux deux endroits.
define('TEACHER_HASH', '00624b02e1f9b996a3278f559d5d55313552ad2c0bafc82adfd975c12df61eaf');

/**
 * Vérifie l'authentification prof avant une action de pilotage.
 * Le client doit envoyer 'teacher_hash' en POST/GET, valeur identique à TEACHER_HASH.
 *
 * Limitation : c'est un patch minimal. Le hash étant en clair côté JS (config.js),
 * un élève qui ouvre la console le verra. Mais ça arrête 99 % des bidouilleurs
 * occasionnels qui ne font que tester une URL au hasard. Pour une vraie protection,
 * il faudra passer à un token serveur (PHPSESSION ou JWT).
 *
 * Utilise hash_equals pour éviter les attaques par timing.
 */
function requireTeacherAuth() {
    $h = $_POST['teacher_hash'] ?? $_GET['teacher_hash'] ?? '';
    if (!is_string($h) || !hash_equals(TEACHER_HASH, $h)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Non autorisé (auth prof requise)']);
        exit;
    }
}

// Créer les dossiers si nécessaires
if (!file_exists(__DIR__ . '/data')) {
    mkdir(__DIR__ . '/data', 0755, true);
}
if (!file_exists(SESSIONS_DIR)) {
    mkdir(SESSIONS_DIR, 0755, true);
}
if (!file_exists(CTRL_THROTTLE_DIR)) {
    @mkdir(CTRL_THROTTLE_DIR, 0755, true);
}

/**
 * Throttle prof : clé = teacher_hash + REMOTE_ADDR. Renvoie 429 + Retry-After
 * et termine la requête si la limite est dépassée. Le client respecte le délai
 * via son circuit breaker.
 */
function enforceControlThrottle($key) {
    if ($key === null || $key === '') return;
    $hash = md5($key);
    if (!preg_match('/^[a-f0-9]{32}$/', $hash)) return;
    $file = CTRL_THROTTLE_DIR . '/c_' . $hash . '.txt';

    $fp = @fopen($file, 'c+');
    if (!$fp) return;
    if (!@flock($fp, LOCK_EX)) {
        @fclose($fp);
        return;
    }

    $now = time();
    $content = stream_get_contents($fp);
    $data = $content ? json_decode($content, true) : null;
    if (!is_array($data) || !isset($data['windowStart'])) {
        $data = ['windowStart' => $now, 'count' => 0];
    }
    if (($now - (int)$data['windowStart']) >= CTRL_THROTTLE_WINDOW_SEC) {
        $data = ['windowStart' => $now, 'count' => 0];
    }
    $data['count'] = (int)$data['count'] + 1;

    @ftruncate($fp, 0);
    @rewind($fp);
    @fwrite($fp, json_encode($data));
    @fflush($fp);
    @flock($fp, LOCK_UN);
    @fclose($fp);

    if ($data['count'] > CTRL_THROTTLE_MAX_REQUESTS) {
        header('HTTP/1.1 429 Too Many Requests');
        header('Retry-After: ' . CTRL_THROTTLE_RETRY_AFTER_SEC);
        header('Content-Type: application/json; charset=utf-8');
        if (function_exists('setMetricDetail')) {
            setMetricDetail('throttled', 1);
            setMetricDetail('ra', CTRL_THROTTLE_RETRY_AFTER_SEC);
            setMetricDetail('count', $data['count']);
        }
        echo json_encode([
            'success' => false,
            'throttled' => true,
            'message' => 'Trop de requêtes — patiente quelques secondes',
            'retryAfter' => CTRL_THROTTLE_RETRY_AFTER_SEC
        ]);
        exit;
    }
}

// Throttle global avant routage. Clé : teacher_hash + REMOTE_ADDR.
// Si pas de teacher_hash (ex : get_control_state appelé par la projection sans auth),
// on throttle quand même par IP seule pour limiter les boucles côté projection.
$__ctrlTeacherHash = $_POST['teacher_hash'] ?? $_GET['teacher_hash'] ?? '';
$__ctrlIp = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
$__ctrlPlayCode = $_POST['playCode'] ?? $_GET['playCode'] ?? '';
$__ctrlKey = $__ctrlTeacherHash !== ''
    ? ('t:' . $__ctrlTeacherHash . '|' . $__ctrlIp)
    : ('a:' . $__ctrlIp . '|' . $__ctrlPlayCode);
enforceControlThrottle($__ctrlKey);

// === LOGGING MÉTRIQUES (format enrichi v2) === (cf. game.php pour la doc complète)
define('METRICS_ENABLED', true);
define('METRICS_DIR', __DIR__ . '/data/metrics');
define('METRICS_MAX_BYTES', 30 * 1024 * 1024);

$__metricStart = microtime(true);
$GLOBALS['__metricDetails'] = '';

function setMetricDetail($key, $value) {
    $cur = $GLOBALS['__metricDetails'] ?? '';
    $v = str_replace(["\t", "\n", "\r", "&", "="], ' ', (string)$value);
    $k = str_replace(["\t", "\n", "\r", "&", "="], '_', (string)$key);
    $entry = $k . '=' . $v;
    $GLOBALS['__metricDetails'] = ($cur === '' ? '' : $cur . '&') . $entry;
}

function shortUserAgent($ua) {
    if (!is_string($ua) || $ua === '') return '?';
    if (preg_match('/iP(hone|ad).*OS (\d+).*Mobile.*Safari/', $ua, $m)) return 'iOS-Safari/' . $m[2];
    if (preg_match('/Edg\/(\d+)/', $ua, $m)) return 'Edge/' . $m[1];
    if (preg_match('/OPR\/(\d+)/', $ua, $m)) return 'Opera/' . $m[1];
    if (preg_match('/Chrome\/(\d+)/', $ua, $m)) {
        $suffix = (stripos($ua, 'Mobile') !== false) ? '-Mob' : '';
        return 'Chrome' . $suffix . '/' . $m[1];
    }
    if (preg_match('/Firefox\/(\d+)/', $ua, $m)) return 'Firefox/' . $m[1];
    if (preg_match('/Safari\/(\d+)/', $ua, $m)) return 'Safari/' . $m[1];
    return substr(preg_replace('/[^A-Za-z0-9\/\-.]/', '_', $ua), 0, 30);
}

function logMetric($endpoint, $playCode, $nickname, $httpCode, $durationMs, $details, $uaShort) {
    if (!METRICS_ENABLED) return;
    $dir = METRICS_DIR;
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    if (!is_writable($dir)) return;
    $file = $dir . '/' . date('Y-m-d') . '.log';
    if (file_exists($file) && @filesize($file) > METRICS_MAX_BYTES) {
        $oldFile = $dir . '/' . date('Y-m-d') . '.old.log';
        @rename($file, $oldFile);
    }
    $ip = $_SERVER['REMOTE_ADDR'] ?? '?';
    $clean = function($v) {
        return str_replace(["\t", "\n", "\r"], ' ', (string)$v);
    };
    $line = implode("\t", [
        time(),
        $clean($ip),
        $clean($endpoint),
        $clean(substr($playCode, 0, 16)),
        $clean(substr($nickname, 0, 50)),
        intval($httpCode),
        intval($durationMs),
        $clean(substr($details, 0, 200)),
        $clean(substr($uaShort, 0, 32))
    ]) . "\n";
    @file_put_contents($file, $line, FILE_APPEND);
}

function logEvent($eventType, $playCode, $actor, $details) {
    if (!METRICS_ENABLED) return;
    $dir = METRICS_DIR;
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    if (!is_writable($dir)) return;
    $file = $dir . '/events-' . date('Y-m-d') . '.log';
    $clean = function($v) {
        return str_replace(["\t", "\n", "\r"], ' ', (string)$v);
    };
    $line = implode("\t", [
        date('Y-m-d H:i:s'),
        $clean($eventType),
        $clean(substr($playCode, 0, 16)),
        $clean(substr($actor, 0, 50)),
        $clean(substr($details, 0, 500))
    ]) . "\n";
    @file_put_contents($file, $line, FILE_APPEND);
}

register_shutdown_function(function() {
    $endpoint = $_GET['action'] ?? $_POST['action'] ?? 'unknown';
    $playCode = $_GET['playCode'] ?? $_POST['playCode'] ?? '';
    $teacherHash = $_GET['teacher_hash'] ?? $_POST['teacher_hash'] ?? '';
    $whoLabel = $teacherHash !== '' ? ('teacher:' . substr($teacherHash, 0, 8)) : '';
    $code = http_response_code();
    if ($code === false) $code = 200;
    $durationMs = (int) round((microtime(true) - ($GLOBALS['__metricStart'] ?? microtime(true))) * 1000);
    $details = $GLOBALS['__metricDetails'] ?? '';
    $ua = shortUserAgent($_SERVER['HTTP_USER_AGENT'] ?? '');
    logMetric($endpoint, $playCode, $whoLabel, $code, $durationMs, $details, $ua);
});

$action = isset($_GET['action']) ? $_GET['action'] : (isset($_POST['action']) ? $_POST['action'] : '');

// Liste des actions qui modifient l'état d'une partie. Toutes nécessitent l'auth prof.
// get_control_state n'est PAS dans la liste : c'est de la lecture, utilisé aussi par la
// projection (qui est volontairement sans auth pour rester fonctionnelle même si la
// fenêtre prof est fermée).
$privilegedActions = [
    'create_session', 'start_game', 'pause_game', 'next_question', 'end_game',
    'update_player_score', 'remove_player', 'cleanup_session',
    'force_question_complete', 'update_questions',
];
if (in_array($action, $privilegedActions, true)) {
    requireTeacherAuth();
}

switch ($action) {
    case 'create_session':
        createSession();
        break;

    case 'start_game':
        startGame();
        break;

    case 'pause_game':
        pauseGame();
        break;

    case 'next_question':
        nextQuestion();
        break;

    case 'end_game':
        endGame();
        break;

    case 'update_player_score':
        updatePlayerScore();
        break;

    case 'remove_player':
        removePlayer();
        break;

    case 'cleanup_session':
        cleanupSession();
        break;

    case 'stream':
        // SSE prof retiré (cf. game.php). Tout passe par get_control_state (polling adaptatif).
        echo json_encode([
            'success' => false,
            'message' => 'SSE désactivé. Utilisez action=get_control_state.',
            'deprecated' => true
        ]);
        break;

    case 'get_control_state':
        getControlState();
        break;

    case 'force_question_complete':
        forceQuestionComplete();
        break;

    case 'update_questions':
        updateQuestions();
        break;
    
    default:
        echo json_encode(['success' => false, 'message' => 'Action inconnue']);
        break;
}

function createSession() {
    // Limite de taille : 2 MB max pour quizData (anti DoS)
    if (isset($_POST['quizData']) && strlen($_POST['quizData']) > 2 * 1024 * 1024) {
        http_response_code(413);
        echo json_encode(['success' => false, 'message' => 'Quiz trop volumineux (max 2 Mo)']);
        return;
    }

    $playCode = $_POST['playCode'] ?? '';
    $quizData = $_POST['quizData'] ?? '';
    $manualMode = $_POST['manualMode'] ?? '0';
    $showTop3 = $_POST['showTop3'] ?? '1';
    
    error_log("CREATE_SESSION: playCode=$playCode (avant conversion)");
    
    // Convertir en majuscules immédiatement
    $playCode = strtoupper(trim($playCode));
    error_log("CREATE_SESSION: playCode=$playCode (après conversion)");
    
    $session = [
        'playCode' => $playCode,
        'quizData' => json_decode($quizData, true),
        'manualMode' => $manualMode === '1',
        'showTop3' => $showTop3 === '1',
        'state' => 'waiting',
        'currentQuestion' => -1,
        'players' => [],
        'questions' => json_decode($quizData, true)['questions'] ?? [],  // IMPORTANT : ajouter les questions
        'usedAnimals' => [],  // Liste des animaux déjà proposés
        'createdAt' => time()
    ];
    
    // Utiliser saveSession pour avoir la conversion en majuscules cohérente
    saveSession($playCode, $session);

    // Fichier d'état séparé (single-writer prof) : la vérité du pilotage vit ici,
    // hors de portée des écritures élèves (anti lost-update mutualisé).
    qst_initState($playCode, [
        'manualMode' => $manualMode === '1',
        'showTop3' => $showTop3 === '1',
    ]);
    error_log("CREATE_SESSION: Session créée pour $playCode");

    echo json_encode(['success' => true]);
}

function startGame() {
    $playCode = $_POST['playCode'] ?? '';
    $manualMode = $_POST['manualMode'] ?? '0';
    $showTop3 = $_POST['showTop3'] ?? '1';

    $session = loadSession($playCode);
    if (!$session) {
        echo json_encode(['success' => false]);
        return;
    }
    qst_ensureState($playCode, $session);

    list($state, $fp) = qst_loadStateForUpdate($playCode);
    if (!$state) {
        echo json_encode(['success' => false, 'message' => 'État occupé, réessaie', 'retryable' => true]);
        return;
    }
    $state['state'] = 'playing';
    $state['startTime'] = time();
    $state['manualMode'] = $manualMode === '1';
    $state['showTop3'] = $showTop3 === '1';
    qst_saveStateAndUnlock($playCode, $state, $fp);

    $nbPlayers = count($session['players'] ?? []);
    setMetricDetail('players', $nbPlayers);
    logEvent('start_game', $playCode, 'teacher', "players={$nbPlayers}&manual={$manualMode}&showTop3={$showTop3}");
    echo json_encode(['success' => true]);
}

function updateQuestions() {
    $playCode = $_POST['playCode'] ?? '';
    $questionsJson = $_POST['questions'] ?? '';
    $quizDataJson = $_POST['quizData'] ?? '';
    
    list($session, $fp) = loadSessionForUpdate($playCode);

    if ($session) {
        if ($questionsJson) {
            $questions = json_decode($questionsJson, true);
            $session['questions'] = $questions;
            if (!isset($session['quizData'])) {
                $session['quizData'] = [];
            }
            $session['quizData']['questions'] = $questions;
        }

        if ($quizDataJson) {
            $session['quizData'] = json_decode($quizDataJson, true);
            if (isset($session['quizData']['questions'])) {
                $session['questions'] = $session['quizData']['questions'];
            }
        }

        saveSessionAndUnlock($playCode, $session, $fp);

        error_log("UPDATE_QUESTIONS: Questions mises à jour pour $playCode, " . count($session['questions']) . " questions");

        echo json_encode(['success' => true]);
    } else {
        echo json_encode(['success' => false, 'message' => 'Session not found']);
    }
}

function pauseGame() {
    $playCode = $_POST['playCode'] ?? '';
    $paused = $_POST['paused'] ?? '0';

    $session = loadSession($playCode);
    if (!$session) {
        echo json_encode(['success' => false, 'message' => 'Session introuvable']);
        return;
    }
    qst_ensureState($playCode, $session);

    list($state, $fp) = qst_loadStateForUpdate($playCode);
    if (!$state) {
        echo json_encode(['success' => false, 'message' => 'État occupé, réessaie', 'retryable' => true]);
        return;
    }

    $state['paused'] = $paused === '1';
    qst_saveStateAndUnlock($playCode, $state, $fp);
    setMetricDetail('paused', $state['paused'] ? 1 : 0);
    logEvent('pause_game', $playCode, 'teacher', "paused=" . ($state['paused'] ? '1' : '0'));
    echo json_encode(['success' => true]);
}

/**
 * Avancer à la question suivante. Idempotente :
 *   - si questionIndex <= currentQuestion, ne fait rien et renvoie {success: true, alreadyAt: questionIndex}
 *   - protège contre les doubles-clics, les retries de timeout, et les requêtes en désordre.
 */
function nextQuestion() {
    $playCode = $_POST['playCode'] ?? '';
    $questionIndex = intval($_POST['questionIndex'] ?? 0);
    $customTime = $_POST['customTime'] ?? null;

    if ($customTime !== null && $customTime !== '' && $customTime !== 'null') {
        $customTime = intval($customTime);
    } else {
        $customTime = null;
    }

    $session = loadSession($playCode);
    if (!$session) {
        echo json_encode(['success' => false, 'message' => 'Session introuvable']);
        return;
    }
    qst_ensureState($playCode, $session);

    // L'avance vit dans le fichier d'état SINGLE-WRITER : aucune requête élève ne
    // l'écrit, donc l'avance ne peut plus être engloutie par une écriture concurrente
    // de la session joueurs (cause des 45 next_question perdus mesurés le 12/06).
    list($state, $fp) = qst_loadStateForUpdate($playCode);
    if (!$state) {
        echo json_encode(['success' => false, 'message' => 'État occupé, réessaie', 'retryable' => true]);
        return;
    }

    // Idempotence : si on a déjà avancé au-delà ou pile sur cette question, on confirme sans agir.
    $currentQ = $state['currentQuestion'] ?? -1;
    if ($questionIndex <= $currentQ) {
        @flock($fp, LOCK_UN); @fclose($fp);
        error_log("NEXT_QUESTION: idempotent — demande Q$questionIndex, déjà sur Q$currentQ");
        setMetricDetail('idem', 1);
        setMetricDetail('from', $currentQ);
        setMetricDetail('to', $questionIndex);
        echo json_encode([
            'success' => true,
            'alreadyAt' => $currentQ,
            'idempotent' => true
        ]);
        return;
    }

    // SYNCHRO v2 : on fixe l'instant ABSOLU d'apparition (revealAt, ms serveur) avec une
    // avance (lead) — le temps que tous les postes pollent et apprennent cet instant
    // avant qu'il n'arrive → révélation simultanée chez tous, sans requête de plus.
    $nowMs = qst_nowMs();
    $lead = ($questionIndex <= 0) ? FIRST_REVEAL_LEAD_MS : REVEAL_LEAD_MS;
    $revealAt = $nowMs + $lead;

    $state['currentQuestion'] = $questionIndex;
    $state['questionRevealAt'] = $revealAt;
    // questionStartTime (secondes) = SECONDE de révélation : conserve la compat avec la
    // logique d'auto-complétion au timeout (qst_maybeTimeoutComplete) et le timeElapsed
    // de get_control_state, qui comptent désormais à partir de l'apparition réelle.
    $state['questionStartTime'] = (int) floor($revealAt / 1000);
    $state['customTime'] = ($customTime !== null) ? $customTime : null;
    // Pas de flag de complétion à réinitialiser : la complétion de la question N est
    // matérialisée par l'existence de CODE.done.qN.json — celui de Q$questionIndex
    // n'existe pas encore, donc la nouvelle question démarre « non complétée » de fait.
    qst_saveStateAndUnlock($playCode, $state, $fp);
    error_log("NEXT_QUESTION: Question $questionIndex lancée, revealAt=$revealAt (lead {$lead}ms), customTime=" . ($customTime ?? 'none'));

    setMetricDetail('from', $currentQ);
    setMetricDetail('to', $questionIndex);
    if ($customTime !== null) setMetricDetail('ct', $customTime);
    logEvent('next_question', $playCode, 'teacher', "from={$currentQ}&to={$questionIndex}&revealAt={$revealAt}&customTime=" . ($customTime ?? 'none'));

    echo json_encode(['success' => true, 'currentQuestion' => $questionIndex, 'questionRevealAt' => $revealAt, 'serverTimeMs' => $nowMs]);
}

function endGame() {
    $playCode = $_POST['playCode'] ?? '';

    $session = loadSession($playCode);
    if (!$session) {
        echo json_encode(['success' => false]);
        return;
    }
    qst_ensureState($playCode, $session);

    list($state, $fp) = qst_loadStateForUpdate($playCode);
    if (!$state) {
        echo json_encode(['success' => false, 'message' => 'État occupé, réessaie', 'retryable' => true]);
        return;
    }
    $previousState = $state['state'] ?? '?';
    $lastQ = $state['currentQuestion'] ?? -1;
    $state['state'] = 'finished';
    $state['endTime'] = time();
    $state['paused'] = false;
    qst_saveStateAndUnlock($playCode, $state, $fp);
    setMetricDetail('prevState', $previousState);
    setMetricDetail('lastQ', $lastQ);
    logEvent('end_game', $playCode, 'teacher', "prevState={$previousState}&lastQ={$lastQ}&players=" . count($session['players'] ?? []));
    echo json_encode(['success' => true]);
}

function cleanupSession() {
    $playCode = validatePlayCode($_POST['playCode'] ?? '');
    if ($playCode === null) {
        http_response_code(400);
        echo json_encode(['success' => false, 'message' => 'Code de partie invalide']);
        return;
    }

    // Supprime le groupe complet : CODE.json + CODE.state.json + CODE.done.q*.json
    qst_deleteSessionFiles($playCode);
    error_log("CLEANUP: Session $playCode supprimée (groupe complet)");

    echo json_encode(['success' => true]);
}

function streamControl() {
    // Désactiver tous les buffers
    while (ob_get_level()) {
        ob_end_clean();
    }
    
    header('Content-Type: text/event-stream');
    header('Cache-Control: no-cache');
    header('Connection: keep-alive');
    header('X-Accel-Buffering: no'); // Pour nginx
    
    $playCode = $_GET['playCode'] ?? '';
    
    if (empty($playCode)) {
        echo "event: error\n";
        echo "data: " . json_encode(['error' => 'Invalid playCode']) . "\n\n";
        flush();
        exit;
    }
    
    // Message initial
    echo "event: connected\n";
    echo "data: " . json_encode(['message' => 'Connected']) . "\n\n";
    flush();
    
    // Envoyer immédiatement la liste des joueurs
    $session = loadSession($playCode);
    if ($session) {
        $allPlayers = $session['players'] ?? [];
        foreach ($allPlayers as &$player) {
            $timeSinceLastPing = time() - ($player['lastPing'] ?? 0);
            if ($timeSinceLastPing >= 60) {
                $player['connected'] = false;
            }
        }
        unset($player);
        
        echo "event: players\n";
        echo "data: " . json_encode(['players' => array_values($allPlayers)]) . "\n\n";
        flush();
    }
    
    $lastResultsSent = -1;
    
    while (true) {
        $session = loadSession($playCode);
        
        if (!$session) {
            echo "event: error\n";
            echo "data: " . json_encode(['error' => 'Session not found']) . "\n\n";
            flush();
            break;
        }
        
        // Récupérer TOUS les joueurs (connectés et déconnectés)
        $allPlayers = $session['players'] ?? [];
        
        // Mettre à jour le statut connected en fonction du lastPing
        foreach ($allPlayers as &$player) {
            $timeSinceLastPing = time() - ($player['lastPing'] ?? 0);
            // Si pas de ping depuis 60s, marquer comme déconnecté
            if ($timeSinceLastPing >= 60) {
                $player['connected'] = false;
            }
        }
        unset($player);
        
        // Trier : déconnectés en haut (rouge), puis connectés (vert)
        usort($allPlayers, function($a, $b) {
            $aConnected = $a['connected'] ?? false;
            $bConnected = $b['connected'] ?? false;
            
            // Déconnectés d'abord
            if (!$aConnected && $bConnected) return -1;
            if ($aConnected && !$bConnected) return 1;
            
            // Sinon par ordre d'arrivée (joinedAt)
            return ($a['joinedAt'] ?? 0) - ($b['joinedAt'] ?? 0);
        });
        
        // Envoyer la liste complète
        echo "event: players\n";
        echo "data: " . json_encode(['players' => array_values($allPlayers)]) . "\n\n";
        flush();
        
        // Envoyer les résultats au prof quand la question est complétée
        if (isset($session['questionCompletedTime']) && isset($session['currentQuestion'])) {
            $currentQ = $session['currentQuestion'];
            error_log("CONTROL SSE: questionCompletedTime détecté pour question $currentQ (lastResultsSent=$lastResultsSent)");
            
            if ($lastResultsSent !== $currentQ) {
                echo "event: results\n";
                echo "data: " . json_encode(['questionIndex' => $currentQ]) . "\n\n";
                flush();
                $lastResultsSent = $currentQ;
                error_log("CONTROL SSE: Event results envoyé pour question $currentQ");
            }
        }
        
        // Polling rapide pour réactivité maximale
        sleep(1);
        
        if (connection_aborted()) break;
    }
}

/**
 * Valide qu'un playCode est utilisable comme nom de fichier (anti path traversal).
 * Retourne le code normalisé (majuscules) ou null si invalide.
 */
function validatePlayCode($code) {
    $code = strtoupper(trim((string)$code));
    return preg_match('/^[A-Z0-9]{3,12}$/', $code) ? $code : null;
}

function loadSession($playCode) {
    $playCode = validatePlayCode($playCode);
    if ($playCode === null) {
        error_log("CONTROL LOAD_SESSION: playCode invalide rejeté");
        return null;
    }
    $file = SESSIONS_DIR . '/' . $playCode . '.json';

    if (!file_exists($file)) {
        return null;
    }
    
    $content = @file_get_contents($file);
    if ($content === false) {
        return null;
    }
    
    $data = json_decode($content, true);
    if ($data === null && json_last_error() !== JSON_ERROR_NONE) {
        error_log("CONTROL LOAD_SESSION: Erreur JSON pour $playCode: " . json_last_error_msg());
        return null;
    }
    
    return $data;
}

/**
 * Charge et verrouille une session pour modification
 */
function loadSessionForUpdate($playCode, $maxWaitSec = 3) {
    $playCode = validatePlayCode($playCode);
    if ($playCode === null) {
        error_log("CONTROL LOAD_SESSION_UPDATE: playCode invalide rejeté");
        return [null, null];
    }
    $file = SESSIONS_DIR . '/' . $playCode . '.json';

    if (!file_exists($file)) {
        return [null, null];
    }

    // Verrou SÉPARÉ (CODE.lock) + lecture fraîche après acquisition — voir
    // session_store.php (écriture du .json atomique par tmp+rename sur Linux).
    $fp = qst_acquireSessionLock($playCode, $maxWaitSec);
    if (!$fp) {
        error_log("CONTROL LOAD_SESSION_UPDATE: Verrou non obtenu pour $playCode — abandon propre");
        return [null, null];
    }

    $content = @file_get_contents($file);
    if ($content === false || $content === '') {
        qst_releaseSessionLock($fp);
        return [null, null];
    }

    $data = json_decode($content, true);
    if ($data === null && json_last_error() !== JSON_ERROR_NONE) {
        error_log("CONTROL LOAD_SESSION_UPDATE: Erreur JSON pour $playCode");
        qst_releaseSessionLock($fp);
        return [null, null];
    }

    return [$data, $fp];
}

/**
 * Sauvegarde une session — voir game.php::saveSessionAndUnlock pour l'explication
 * détaillée. Mode in-place sous verrou pour les écritures sur fichier existant,
 * tmp+rename atomique seulement pour la création (sans verrou).
 */
function saveSessionAndUnlock($playCode, $session, $fp = null) {
    $playCode = validatePlayCode($playCode);
    if ($playCode === null) {
        error_log("CONTROL SAVE_SESSION: playCode invalide rejeté");
        if ($fp) { @flock($fp, LOCK_UN); @fclose($fp); }
        return;
    }
    $file = SESSIONS_DIR . '/' . $playCode . '.json';

    $content = json_encode($session);
    if ($content === false) {
        error_log("CONTROL SAVE_SESSION: json_encode a échoué pour $playCode");
        if ($fp) { @flock($fp, LOCK_UN); @fclose($fp); }
        return;
    }

    if ($fp) {
        // Écriture atomique pour les lecteurs, sous le verrou CODE.lock.
        if (!qst_atomicWriteFile($file, $content)) {
            error_log("CONTROL SAVE_SESSION: écriture impossible pour $playCode");
        }
        qst_releaseSessionLock($fp);
        return;
    }

    $tmpFile = $file . '.tmp.' . uniqid('', true);
    $written = @file_put_contents($tmpFile, $content);
    if ($written === false || $written !== strlen($content)) {
        error_log("CONTROL SAVE_SESSION: Échec écriture tmp pour $playCode");
        @unlink($tmpFile);
        return;
    }
    if (!@rename($tmpFile, $file)) {
        error_log("CONTROL SAVE_SESSION: rename a échoué pour $playCode");
        @unlink($tmpFile);
    }
}

function saveSession($playCode, $session) {
    saveSessionAndUnlock($playCode, $session, null);
}

// NB : les anciens helpers checkAndForceQuestionCompletionControl / freezeRankingControl /
// calculateQuestionScores (copie locale) ont été remplacés par le store partagé
// (session_store.php) : complétion = fichier done immuable (qst_maybeTimeoutComplete /
// qst_createDone), classement figé embarqué dans le done-file, scores DÉRIVÉS à la
// lecture (qst_decorateSession). Plus aucune mutation de score dans la session.

function updatePlayerScore() {
    $playCode = $_POST['playCode'] ?? '';
    $nickname = $_POST['nickname'] ?? '';
    $score = intval($_POST['score'] ?? 0);

    error_log("UPDATE_SCORE: playCode=$playCode, nickname=$nickname, score=$score");

    $session = loadSession($playCode);
    if (!$session) {
        error_log("UPDATE_SCORE: Session non trouvée");
        echo json_encode(['success' => false]);
        return;
    }
    qst_ensureState($playCode, $session);

    // Les scores étant DÉRIVÉS des réponses, la correction manuelle du prof est
    // stockée comme un AJUSTEMENT (delta vs score dérivé brut) dans le fichier
    // d'état single-writer. Le score affiché redevient exactement la valeur saisie,
    // et l'ajustement survit aux réponses tardives sans pouvoir être englouti.
    $decoratedRaw = qst_decorateSession($session, ['scoreAdjusts' => []]);
    $rawScore = 0;
    foreach (($decoratedRaw['players'] ?? []) as $p) {
        if (($p['nickname'] ?? '') === $nickname) { $rawScore = (int)($p['score'] ?? 0); break; }
    }

    list($state, $fp) = qst_loadStateForUpdate($playCode);
    if (!$state) {
        echo json_encode(['success' => false, 'message' => 'État occupé, réessaie', 'retryable' => true]);
        return;
    }
    if (!isset($state['scoreAdjusts']) || !is_array($state['scoreAdjusts'])) {
        $state['scoreAdjusts'] = [];
    }
    $state['scoreAdjusts'][$nickname] = $score - $rawScore;
    qst_saveStateAndUnlock($playCode, $state, $fp);

    setMetricDetail('adjust', $score - $rawScore);
    echo json_encode(['success' => true]);
}

function removePlayer() {
    $playCode = $_POST['playCode'] ?? '';
    $nickname = $_POST['nickname'] ?? '';
    
    error_log("REMOVE_PLAYER: playCode=$playCode, nickname=$nickname");
    
    list($session, $fp) = loadSessionForUpdate($playCode);
    if (!$session) {
        echo json_encode(['success' => false]);
        return;
    }

    $session['players'] = array_values(array_filter($session['players'], function($player) use ($nickname) {
        return $player['nickname'] !== $nickname;
    }));

    setMetricDetail('target', $nickname);
    logEvent('remove_player', $playCode, 'teacher', "target={$nickname}");

    saveSessionAndUnlock($playCode, $session, $fp);

    // Si le joueur retiré était le dernier non-répondant, la question est de fait
    // terminée pour tous les actifs restants → créer le done-file (immuable).
    $state = qst_loadState($playCode);
    if ($state && ($state['state'] ?? '') === 'playing' && ($state['currentQuestion'] ?? -1) >= 0) {
        $questionIndex = $state['currentQuestion'];
        if (!qst_doneExists($playCode, $questionIndex)) {
            $allAnswered = true;
            $connectedPlayers = 0;
            foreach ($session['players'] as $player) {
                if (($player['connected'] ?? false) && (time() - ($player['lastPing'] ?? 0) < ACTIVE_PLAYER_THRESHOLD)) {
                    $connectedPlayers++;
                    if (!isset($player['answers'][$questionIndex])) {
                        $allAnswered = false;
                    }
                }
            }
            if ($allAnswered && $connectedPlayers > 0) {
                if (qst_createDone($playCode, $questionIndex, 'all_answered', $session, $state)) {
                    logEvent('question_complete_all_answered', $playCode, '', "q={$questionIndex}&active={$connectedPlayers}");
                }
            }
        }
    }

    echo json_encode(['success' => true]);
}

/**
 * Forcer la fin de la question courante (resync prof). Idempotente :
 *   - si la question est déjà marquée complétée, on ne re-score pas (les points sont déjà attribués)
 *     et on renvoie un succès pour ne pas bloquer le client en cas de retry.
 *   - si questionIndex ne correspond pas à currentQuestion, on renvoie une erreur explicite.
 */
function forceQuestionComplete() {
    $playCode = $_POST['playCode'] ?? '';
    $questionIndex = intval($_POST['questionIndex'] ?? -1);

    error_log("FORCE_QUESTION_COMPLETE: playCode=$playCode, questionIndex=$questionIndex");

    $session = loadSession($playCode);
    if (!$session) {
        echo json_encode(['success' => false, 'message' => 'Session introuvable']);
        return;
    }
    qst_ensureState($playCode, $session);
    $state = qst_loadState($playCode);

    $currentQ = $state['currentQuestion'] ?? -1;
    if ($questionIndex !== $currentQ) {
        error_log("FORCE_QUESTION_COMPLETE: mismatch questionIndex=$questionIndex, currentQuestion=$currentQ");
        setMetricDetail('mismatch', 1);
        setMetricDetail('reqQ', $questionIndex);
        setMetricDetail('curQ', $currentQ);
        echo json_encode([
            'success' => false,
            'message' => 'La session est sur une autre question',
            'currentQuestion' => $currentQ
        ]);
        return;
    }

    if (qst_doneExists($playCode, $questionIndex)) {
        error_log("FORCE_QUESTION_COMPLETE: idempotent — Q$questionIndex déjà complétée");
        setMetricDetail('idem', 1);
        setMetricDetail('q', $questionIndex);
        echo json_encode(['success' => true, 'idempotent' => true]);
        return;
    }

    // Création EXCLUSIVE du done-file : si un concurrent vient de le créer, c'est un
    // succès idempotent — la question est terminée dans tous les cas.
    $created = qst_createDone($playCode, $questionIndex, 'forced', $session, $state);
    error_log("FORCE_QUESTION_COMPLETE: Question $questionIndex marquée comme complétée" . ($created ? '' : ' (déjà fait par un concurrent)'));
    setMetricDetail('q', $questionIndex);
    setMetricDetail('forced', 1);
    if ($created) {
        logEvent('force_question_complete', $playCode, 'teacher', "q={$questionIndex}");
    }
    echo json_encode(['success' => true, 'idempotent' => !$created]);
}

function getControlState() {
    $playCode = $_GET['playCode'] ?? '';
    
    error_log("GET_CONTROL_STATE: playCode=$playCode");
    
    if (empty($playCode)) {
        error_log("GET_CONTROL_STATE: playCode vide");
        echo json_encode(['success' => false, 'message' => 'playCode manquant']);
        return;
    }
    
    $session = loadSession($playCode);
    
    if (!$session) {
        error_log("GET_CONTROL_STATE: Session introuvable pour $playCode");
        error_log("GET_CONTROL_STATE: Fichiers disponibles: " . implode(', ', array_map('basename', glob(SESSIONS_DIR . '/*.json'))));
        echo json_encode(['success' => false, 'message' => 'Session introuvable']);
        return;
    }
    
    // IMPORTANT (anti lost-update) : get_control_state n'écrit JAMAIS la session.
    // - statut "connecté" : recalculé à la lecture (plus bas), jamais persisté.
    // - complétion au timeout : matérialisée par la CRÉATION du done-file immuable
    //   (aucune réécriture d'un fichier partagé, donc rien à engloutir).
    qst_ensureState($playCode, $session);
    $state = qst_loadState($playCode);

    if (is_array($state) && qst_maybeTimeoutComplete($playCode, $session, $state, QUESTION_TIMEOUT_GRACE)) {
        error_log("CONTROL_AUTO_COMPLETE: Q" . ($state['currentQuestion'] ?? -1) . " timeout (done-file créé)");
        logEvent('question_complete_timeout', $playCode, '', 'q=' . ($state['currentQuestion'] ?? -1));
    }

    // Vue unifiée : état single-writer + complétion done-file + scores dérivés.
    $session = qst_view($playCode, $session, $state);

    // Préparer la réponse (lecture seule à partir d'ici, $session est à jour)
    $allPlayers = $session['players'] ?? [];
    foreach ($allPlayers as $index => &$player) {
        $timeSinceLastPing = time() - ($player['lastPing'] ?? 0);
        $player['connected'] = ($timeSinceLastPing < VISUAL_DISCONNECT_THRESHOLD);
        $player['timeSinceLastPing'] = $timeSinceLastPing;
    }
    unset($player);
    
    $response = [
        'success' => true,
        'players' => array_values($allPlayers),
        'state' => $session['state'] ?? 'waiting',
        'currentQuestion' => $session['currentQuestion'] ?? -1,
        'paused' => $session['paused'] ?? false,
        'questionCompleted' => $session['questionCompleted'] ?? false,
        // Champs pour le MODE SECOURS de la projection (pilotage de relève quand la
        // fenêtre prof est morte) : temps personnalisé à propager au next_question,
        // mode manuel/auto, horloge serveur pour les délais sans dépendre de
        // l'horloge locale du poste de projection.
        'customTime' => (is_array($state) ? ($state['customTime'] ?? null) : null),
        'manualMode' => (bool)($session['manualMode'] ?? false),
        'serverTime' => time(),
        // SYNCHRO v2 : horloge serveur ms + instant absolu d'apparition de la question
        // courante (relayés à la projection pour une révélation alignée au ms près).
        'serverTimeMs' => qst_nowMs(),
        'questionRevealAt' => (int)($session['questionRevealAt'] ?? 0)
    ];

    // Ajouter les infos de timing pour la resync automatique
    if (isset($session['questionStartTime']) && isset($session['currentQuestion']) && $session['currentQuestion'] >= 0) {
        $response['questionStartTime'] = $session['questionStartTime'];
        $response['timeElapsed'] = time() - $session['questionStartTime'];
        
        // Déterminer le temps alloué pour cette question
        $questionIndex = $session['currentQuestion'];
        $questionTime = 30; // Défaut
        
        // Utiliser customTime si défini
        if (isset($session['customTime']) && $session['customTime'] > 0) {
            $questionTime = $session['customTime'];
        } 
        // Sinon utiliser le temps de la question
        else if (isset($session['quizData']['questions'][$questionIndex]['time'])) {
            $questionTime = $session['quizData']['questions'][$questionIndex]['time'];
        }
        
        $response['questionTime'] = $questionTime;
        
        error_log("GET_CONTROL_STATE: Q{$questionIndex} - timeElapsed=" . $response['timeElapsed'] . "s, questionTime={$questionTime}s, completed=" . ($session['questionCompleted'] ?? false ? 'true' : 'false'));
    }
    
    // Si des résultats sont disponibles
    if (isset($session['questionCompletedTime']) && isset($session['currentQuestion'])) {
        $response['resultsAvailable'] = true;
        $response['questionIndex'] = $session['currentQuestion'];
        $response['questionCompletedAt'] = $session['questionCompletedTime'];
    }

    // Classement FIGÉ (anti-scintillement du Top 3 / classement) : si un instantané a
    // été pris à la complétion de la question courante (cf. freezeRanking dans game.php),
    // on le renvoie tel quel. Le pilote/projection l'affichent SANS re-trier → l'ordre ne
    // bouge plus pendant l'affichage, même si des réponses tardives arrivent.
    if (isset($session['rankingSnapshot']) &&
        (($session['rankingSnapshot']['q'] ?? -1) === ($session['currentQuestion'] ?? -2))) {
        $response['ranking'] = $session['rankingSnapshot']['players'];
    }

    echo json_encode($response);
}
?>
