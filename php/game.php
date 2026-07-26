<?php
// ============================================
// QWEST - GAME API (Gestion des parties)
// Description: Gestion temps réel des sessions de jeu
// ============================================

header('Content-Type: application/json; charset=utf-8');
// CORS retiré : l'app fonctionne en same-origin. Autoriser '*' permettait à n'importe
// quelle page tierce de faire des requêtes (CSRF). Si besoin de cross-origin un jour,
// remplacer par une whitelist explicite.

// Configuration
define('SESSIONS_DIR', __DIR__ . '/data/sessions');
define('SESSION_TIMEOUT', 1800); // 30 minutes — couvre une partie complète + marge en cas de désync ping
define('PING_TIMEOUT', 120); // 120 secondes - Tolérance pour connexions instables en classe

// NOUVEAU : Seuil unique pour "joueur actif devant répondre"
// Un joueur est considéré actif s'il a pingé dans les 60 dernières secondes
define('ACTIVE_PLAYER_THRESHOLD', 60);

// Marge de grâce après la fin du timer de question (en secondes)
// Après ce délai, on force automatiquement la completion.
// Sert aussi de tolérance pour accepter les réponses arrivées tardivement
// par latence réseau (timeSpent client <= questionTime + grace).
// Étendue à 15 s pour absorber les wifi très instables du collège : le scoring
// rétroactif individuel (scorePlayerAnswer) reste sans impact sur le Top 3
// affiché aux autres élèves, donc l'extension est sans risque pour l'UX.
define('QUESTION_TIMEOUT_GRACE', 15);

// === THROTTLE par device (anti-ban hébergeur, anti-boucle bug client) ===
// Limite par appareil (clé = playCode + nickname), PAS par IP : le collège est
// derrière un NAT partagé, throttler par IP banit toute la classe pour un seul
// élève fautif. La limite est calibrée largement au-dessus du polling normal
// (configuration ~30 req/min/élève) pour ne pas générer de faux positifs.
define('THROTTLE_DIR', __DIR__ . '/data/throttle');
define('THROTTLE_WINDOW_SEC', 60);
// 75 req/min/device : un élève légitime sur mobile (polling 2 s + fenêtres de
// transition + bascules d'onglet) culmine vers 45-55 req/min ; 60 générait des
// FAUX POSITIFS (HTTP 429 → pause circuit breaker → questions ratées). 75 laisse
// la marge aux téléphones bavards tout en attrapant une VRAIE boucle de bug
// (qui tourne à 120-300 req/min sustained). Impact agrégé nul : un client
// légitime ne SOUTIENT jamais 75 req/min (il faudrait 1,25 req/s en continu).
define('THROTTLE_MAX_REQUESTS', 75);
// Budget SÉPARÉ pour get_state_readonly : en partie « rapide » (questions de 10-20 s),
// l'élève passe l'essentiel de son temps en fenêtre de transition (poll à 800 ms) et
// atteint LÉGITIMEMENT 70-90 req/min — les 429 observés (count=76 en boucle sur des
// élèves réels les 08-09/06) ouvraient le circuit breaker → « Connexion lente » à tort.
// Un poll readonly coûte ~2 ms serveur (file_get_contents, zéro verrou) : on peut être
// généreux. 180/min attrape toujours une vraie boucle de bug (300-600 req/min).
define('THROTTLE_RO_MAX_REQUESTS', 180);
// Retry-After court : si un appareil EST throttlé, il reprend en 10 s, pas 30 s.
// 10 s < une question (20-30 s) → l'élève peut quand même répondre, et le scoring
// rétroactif (GRACE 15 s) + pendingAnswers couvrent le reste. Corrige le « reprise
// après 30 s, c'est trop long » signalé en classe.
define('THROTTLE_RETRY_AFTER_SEC', 10);

// Store partagé : fichier d'état single-writer (CODE.state.json), complétions
// immuables (CODE.done.qN.json), scores dérivés. Voir l'en-tête de session_store.php.
require_once __DIR__ . '/session_store.php';

// Filet anti-500 : tout crash (exception PHP 8 — TypeError incluse — ou fatal) est
// tracé (php/data/metrics/errors-*.log) et converti en JSON dégradé HTTP 200, pour
// qu'un bug isolé ne fige JAMAIS toute la classe (cf. session_store.php). Armé tôt
// pour couvrir aussi le throttle ci-dessous.
qst_registerErrorNet();

// Créer les dossiers nécessaires
if (!file_exists(SESSIONS_DIR)) {
    mkdir(SESSIONS_DIR, 0755, true);
}
if (!file_exists(THROTTLE_DIR)) {
    @mkdir(THROTTLE_DIR, 0755, true);
}

// Nettoyage des anciennes sessions par échantillonnage : 1 % des requêtes
// font le ménage. Évite l'O(n) coûteux à CHAQUE requête (à 700 req/min, ce
// glob+filemtime saturait le disque OVH mutualisé) et évite de supprimer
// par erreur une session active dont le filemtime n'a pas eu le temps
// d'être mis à jour à cause d'une contention ponctuelle.
if (mt_rand(1, 100) === 1) {
    cleanOldSessions();
    cleanOldThrottleFiles();
    cleanOldMetricsFiles();
}

/**
 * Nettoyage périodique des fichiers throttle anciens.
 */
function cleanOldThrottleFiles() {
    $dir = THROTTLE_DIR;
    if (!is_dir($dir)) return;
    $files = @glob($dir . '/*.txt');
    if (!$files) return;
    $now = time();
    foreach ($files as $f) {
        $mt = @filemtime($f);
        if ($mt && ($now - $mt) > 300) {
            @unlink($f);
        }
    }
}

/**
 * Garde 7 jours de logs métriques max — au-delà, on supprime.
 * Évite de saturer le disque OVH mutualisé. Au tarif observé ~660 req/min
 * × 100 bytes/ligne × 8 h × 7 j ≈ 22 MB max → largement OK.
 */
function cleanOldMetricsFiles() {
    $dir = __DIR__ . '/data/metrics';
    if (!is_dir($dir)) return;
    $files = @glob($dir . '/*.log');
    if (!$files) return;
    $now = time();
    foreach ($files as $f) {
        $mt = @filemtime($f);
        if ($mt && ($now - $mt) > 7 * 86400) {
            @unlink($f);
        }
    }
}

/**
 * Throttle d'une clé d'identification (typiquement "<playCode>|<nickname>").
 *
 * Si la fenêtre glissante dépasse THROTTLE_MAX_REQUESTS, renvoie HTTP 429
 * + Retry-After et TERMINE la requête (exit). Le client respecte le délai
 * via son circuit breaker.
 *
 * NB : si $key est vide (action sans identifiant — ex : prepareGame), on
 * skip le throttle pour ne pas bloquer les actions légitimes early-stage.
 */
function enforceThrottle($key, $maxRequests = THROTTLE_MAX_REQUESTS) {
    if ($key === null || $key === '' || $key === '|') return;
    $hash = md5($key);
    // Sanity : restreindre le chemin de fichier
    if (!preg_match('/^[a-f0-9]{32}$/', $hash)) return;
    $file = THROTTLE_DIR . '/' . $hash . '.txt';

    $fp = @fopen($file, 'c+');
    if (!$fp) return; // si on ne peut pas écrire, on n'empêche pas la requête
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
    if (($now - (int)$data['windowStart']) >= THROTTLE_WINDOW_SEC) {
        $data = ['windowStart' => $now, 'count' => 0];
    }
    $data['count'] = (int)$data['count'] + 1;

    @ftruncate($fp, 0);
    @rewind($fp);
    @fwrite($fp, json_encode($data));
    @fflush($fp);
    @flock($fp, LOCK_UN);
    @fclose($fp);

    if ($data['count'] > $maxRequests) {
        header('HTTP/1.1 429 Too Many Requests');
        header('Retry-After: ' . THROTTLE_RETRY_AFTER_SEC);
        header('Content-Type: application/json; charset=utf-8');
        if (function_exists('setMetricDetail')) {
            setMetricDetail('throttled', 1);
            setMetricDetail('ra', THROTTLE_RETRY_AFTER_SEC);
            setMetricDetail('count', $data['count']);
        }
        echo json_encode([
            'success' => false,
            'throttled' => true,
            'message' => 'Trop de requêtes — patiente quelques secondes',
            'retryAfter' => THROTTLE_RETRY_AFTER_SEC
        ]);
        exit;
    }
}

/**
 * Helper : construit la clé de throttle à partir des paramètres élève.
 * Retourne null si pas assez d'info (auquel cas on skip le throttle).
 */
function buildThrottleKey() {
    $pc = $_GET['playCode'] ?? $_POST['playCode'] ?? '';
    $nk = $_GET['nickname'] ?? $_POST['nickname'] ?? '';
    $pc = is_string($pc) ? trim($pc) : '';
    $nk = is_string($nk) ? trim($nk) : '';
    if ($pc === '' || $nk === '') return null;
    return $pc . '|' . $nk;
}

// NB : le throttle global est invoqué PLUS BAS, juste après l'enregistrement du
// register_shutdown_function des métriques. Sinon un 429 fait exit() avant que le
// logger soit en place → les throttles n'apparaissaient pas dans les métriques
// (angle mort de diagnostic). Déplacé pour que chaque 429 soit tracé.

// === LOGGING MÉTRIQUES (format enrichi v2) ===
// Format TSV : timestamp \t ip \t endpoint \t playCode \t nickname \t http_code
//              \t duration_ms \t details \t ua_short
// Stocké dans php/data/metrics/YYYY-MM-DD.log. Sert au dashboard temps réel et
// au diagnostic post-mortem. Kill-switch : METRICS_ENABLED = false.
//
// Pourquoi ces colonnes :
// - http_code seul ne suffit pas : le serveur répond 200 pour des réponses
//   tooLate/duplicate/idempotent — il faut $details pour les distinguer
// - duration_ms : critique pour détecter lock contention OVH ou ralentissement
// - ua_short : Chrome/iOS Safari/Firefox ont des comportements différents
//   (Visibility API, keepalive, autoplay) — utile pour corréler des bugs
define('METRICS_ENABLED', true);
define('METRICS_DIR', __DIR__ . '/data/metrics');
define('METRICS_MAX_BYTES', 30 * 1024 * 1024); // 30 MB primary + 30 MB old = 60 MB/jour max

// Mesure de la durée de la requête (depuis le début de game.php)
$__metricStart = microtime(true);

// Buffer global pour les détails métier (rempli par les endpoints via setMetricDetail).
$GLOBALS['__metricDetails'] = '';

/**
 * Permet à un endpoint de pousser une info métier qui sera loguée à la fin.
 * Format suggéré : "key=value&key2=value2" (style URL-encoded simple).
 * Caractères à éviter dans value : \t \n & = (on ne re-parse pas vraiment, mais facilite la lecture).
 */
function setMetricDetail($key, $value) {
    $cur = $GLOBALS['__metricDetails'] ?? '';
    // Échapper sommairement
    $v = str_replace(["\t", "\n", "\r", "&", "="], ' ', (string)$value);
    $k = str_replace(["\t", "\n", "\r", "&", "="], '_', (string)$key);
    $entry = $k . '=' . $v;
    $GLOBALS['__metricDetails'] = ($cur === '' ? '' : $cur . '&') . $entry;
}

/**
 * Détecte un User-Agent court (ex "Chrome/132", "Mobile-Safari/17", "Firefox/120").
 * Renvoie une chaîne de < 32 caractères, simplifie le grep dans les logs.
 */
function shortUserAgent($ua) {
    if (!is_string($ua) || $ua === '') return '?';
    // iPad/iPhone Safari
    if (preg_match('/iP(hone|ad).*OS (\d+).*Mobile.*Safari/', $ua, $m)) {
        return 'iOS-Safari/' . $m[2];
    }
    // Chrome (et Edge, Opera, etc. qui mentent comme Chrome)
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

    // Rotation : si on dépasse la taille max, renommer en .old.log (écrasant
    // le .old précédent) et repartir d'un fichier vide. Garde ainsi jusqu'à
    // 2 × METRICS_MAX_BYTES de logs sur la journée — utile si une partie longue
    // dépasse le seuil principal.
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

    // FILE_APPEND est atomique pour les writes courts (< PIPE_BUF ~4096 bytes
    // sur Linux). Pas besoin de LOCK_EX explicite → moins de contention.
    @file_put_contents($file, $line, FILE_APPEND);
}

/**
 * Log d'événements critiques (séparé du log de volume), format texte libre.
 * Volume très bas (quelques lignes par partie) → pas besoin de rotation.
 * Format : timestamp \t event_type \t playCode \t actor \t details_libres
 */
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

// Hook de fin de requête : on log automatiquement à la fin de tout endpoint.
register_shutdown_function(function() {
    $endpoint = $_GET['action'] ?? $_POST['action'] ?? 'unknown';
    $playCode = $_GET['playCode'] ?? $_POST['playCode'] ?? '';
    $nickname = $_GET['nickname'] ?? $_POST['nickname'] ?? '';
    $code = http_response_code();
    if ($code === false) $code = 200;
    $durationMs = (int) round((microtime(true) - ($GLOBALS['__metricStart'] ?? microtime(true))) * 1000);
    $details = $GLOBALS['__metricDetails'] ?? '';
    $ua = shortUserAgent($_SERVER['HTTP_USER_AGENT'] ?? '');
    logMetric($endpoint, $playCode, $nickname, $code, $durationMs, $details, $ua);
});

// Throttle global avant routage : couvre tous les endpoints élève sans avoir à
// modifier chaque fonction. Skip si action absente ou pas identifié. Placé APRÈS
// l'enregistrement du shutdown function ci-dessus pour que les 429 soient bien
// tracés dans les métriques (sinon exit() avant mise en place du logger).
$__throttleKey = buildThrottleKey();
if ($__throttleKey !== null) {
    $__throttleAction = $_GET['action'] ?? $_POST['action'] ?? '';
    if ($__throttleAction === 'get_state_readonly' || $__throttleAction === 'time_sync') {
        // Compteur dédié (préfixe 'ro|') : les polls readonly et le handshake d'horloge
        // (time_sync, lecture pure sans verrou) ne consomment pas le budget des endpoints
        // écrivains, et disposent d'un plafond plus large.
        enforceThrottle('ro|' . $__throttleKey, THROTTLE_RO_MAX_REQUESTS);
    } else {
        enforceThrottle($__throttleKey);
    }
}

// Récupérer l'action
$action = isset($_GET['action']) ? $_GET['action'] : (isset($_POST['action']) ? $_POST['action'] : '');

// Router les actions
switch ($action) {
    case 'join':
        joinGame();
        break;
    
    case 'leave':
        leaveGame();
        break;

    case 'report_tab_switch':
        reportTabSwitch();
        break;

    case 'ping':
        pingPlayer();
        break;
    
    case 'answer':
        submitAnswer();
        break;

    case 'answer_bulk':
        submitAnswerBulk();
        break;

    case 'client_log':
        submitClientLog();
        break;
    
    case 'stream':
        // SSE retiré : la connexion persistante était coupée à 30 s par OVH,
        // concurrente en écriture avec le polling, et faisait flotter le scoreboard.
        // Tout passe désormais par get_state (polling adaptatif côté client).
        echo json_encode([
            'success' => false,
            'message' => 'SSE désactivé. Utilisez action=get_state.',
            'deprecated' => true
        ]);
        break;
    
    case 'get_state':
        getGameState();
        break;

    case 'get_state_readonly':
        getGameStateReadonly();
        break;

    case 'time_sync':
        timeSync();
        break;
    
    case 'reconnect_player':
        reconnectPlayer();
        break;
    
    case 'check_question_timeout':
        checkQuestionTimeout();
        break;
    
    default:
        echo json_encode([
            'success' => false,
            'message' => 'Action non reconnue'
        ]);
        break;
}

// ========================================
// FONCTIONS DE JEU
// ========================================

/**
 * Rejoindre une partie
 */
/**
 * Valide un nickname élève par LISTE NOIRE des caractères dangereux.
 *
 * Pourquoi pas une liste blanche ? Les emojis composés modernes utilisent
 * un Zero-Width Joiner (ZWJ U+200D) ou un Variation Selector-16 (U+FE0F) —
 * ex: 🐻‍❄️ = 🐻 + ZWJ + ❄️. Une regex en liste blanche les rejette
 * presque toujours, et bloque arbitrairement des avatars légitimes.
 *
 * Ici on refuse seulement ce qui peut casser un innerHTML ou un attribut HTML :
 *   - caractères de contrôle U+0000–U+001F et U+007F (DEL)
 *   - < > " ' & \  (tags HTML, attributs, échappement JS)
 *
 * Sécurité : en plus de cette validation serveur, escapeHtml() côté JS
 * (utils.js) échappe systématiquement les pseudos avant injection dans
 * innerHTML — défense en profondeur.
 *
 * Longueur max : 30 caractères. Retourne le nickname normalisé ou null si invalide.
 */
function validateNickname($nickname) {
    $nickname = trim((string)$nickname);
    if ($nickname === '') return null;
    $nickname = mb_substr($nickname, 0, 30, 'UTF-8');
    if (preg_match('/[\x{0000}-\x{001F}<>"\'&\\\\\x{007F}]/u', $nickname)) {
        return null;
    }
    return $nickname;
}

function joinGame() {
    $playCode = isset($_POST['playCode']) ? trim($_POST['playCode']) : '';
    $nicknameRaw = isset($_POST['nickname']) ? $_POST['nickname'] : '';
    $nickname = validateNickname($nicknameRaw);
    $deviceId = isset($_POST['deviceId']) ? trim($_POST['deviceId']) : '';

    error_log("JOIN: playCode=$playCode, nickname=" . ($nickname ?? '(REJETÉ)'));

    if (empty($playCode) || $nickname === null) {
        echo json_encode(['success' => false, 'message' => 'Pseudo ou code invalide']);
        return;
    }

    // Empreinte appareil (anti double-connexion). Clé = playCode + deviceId, JAMAIS l'IP :
    // toute la classe est derrière une IP NAT commune, donc dédup par IP banderait tout
    // le monde. Sans deviceId (localStorage indispo) → pas de blocage (repli tolérant).
    $deviceHash = ($deviceId !== '' && strlen($deviceId) >= 8) ? md5($playCode . '|' . $deviceId) : '';

    // Read-modify-write sous verrou : critique pour 20 joins simultanés (race_test)
    // qui ajoutent chacun un joueur dans players[]. Sans verrou, la dernière écriture
    // gagne et perd les autres joueurs (lost update).
    list($session, $fp) = loadSessionForUpdate($playCode);
    if (!$session) {
        // Distinguer « code vraiment invalide » (fichier absent) de « serveur occupé »
        // (verrou pris pendant une rafale de joins) : le 2ᵉ cas est RÉESSAYABLE.
        // NB : sur le cluster mutualisé, un fichier tout juste créé peut mettre ~1 s à
        // devenir visible depuis un autre nœud — le client retente aussi sur sessionGone
        // avant de conclure (mesuré en conditions réelles : join rejeté 0,3 s après la
        // création de la partie alors que le code était valide).
        $cleanCode = validatePlayCode($playCode);
        $fileExists = ($cleanCode !== null) && file_exists(SESSIONS_DIR . '/' . $cleanCode . '.json');
        if ($fileExists) {
            setMetricDetail('joinBusy', 1);
            echo json_encode(['success' => false, 'message' => 'Serveur occupé, réessaie', 'retryable' => true]);
        } else {
            echo json_encode(['success' => false, 'message' => 'Code de partie invalide', 'sessionGone' => true]);
        }
        return;
    }

    // Anti double-connexion : si CE même appareil est déjà présent avec un AUTRE pseudo
    // ET encore actif (connecté & ping récent), on refuse le 2ᵉ pseudo. La reconnexion
    // du MÊME pseudo (reload, récup réseau) reste autorisée plus bas.
    if ($deviceHash !== '') {
        foreach ($session['players'] as $p) {
            if (($p['deviceHash'] ?? '') === $deviceHash && ($p['nickname'] ?? '') !== $nickname) {
                $stillActive = ($p['connected'] ?? false) && (time() - ($p['lastPing'] ?? 0) < ACTIVE_PLAYER_THRESHOLD);
                if ($stillActive) {
                    if ($fp) { @flock($fp, LOCK_UN); @fclose($fp); }
                    echo json_encode([
                        'success' => false,
                        'deviceBusy' => true,
                        'message' => 'Cet appareil participe déjà avec le pseudo « ' . $p['nickname'] . ' »'
                    ]);
                    return;
                }
            }
        }
    }

    $playerExists = false;
    foreach ($session['players'] as &$player) {
        if ($player['nickname'] === $nickname) {
            $playerExists = true;
            // ANTI-VOL DE PSEUDO : la reconnexion légitime, c'est le MÊME appareil
            // (deviceHash identique — reload, retour réseau) ou un joueur INACTIF
            // (>60 s sans ping : téléphone mort, l'élève revient d'un autre poste).
            // Un appareil DIFFÉRENT qui tente de prendre un pseudo encore ACTIF est
            // refusé : un petit malin pouvait éjecter un camarade en forgeant un join
            // avec son pseudo (l'ancien code écrasait alors le deviceHash du joueur).
            $sameDevice = ($deviceHash !== '' && ($player['deviceHash'] ?? '') === $deviceHash);
            $stillActive = ($player['connected'] ?? false) && (time() - ($player['lastPing'] ?? 0) < ACTIVE_PLAYER_THRESHOLD);
            if (!$sameDevice && $stillActive && ($player['deviceHash'] ?? '') !== '') {
                if ($fp) { @flock($fp, LOCK_UN); @fclose($fp); }
                setMetricDetail('takeover_blocked', 1);
                echo json_encode([
                    'success' => false,
                    'nicknameTaken' => true,
                    'message' => 'Ce pseudo est déjà utilisé sur un autre appareil'
                ]);
                return;
            }
            $player['lastPing'] = time();
            $player['connected'] = true;
            if ($deviceHash !== '') $player['deviceHash'] = $deviceHash;
            break;
        }
    }
    unset($player);

    if (!$playerExists) {
        $session['players'][] = [
            'nickname' => $nickname,
            'score' => 0,
            'answers' => [],
            'connected' => true,
            'lastPing' => time(),
            'joinedAt' => time(),
            'deviceHash' => $deviceHash
        ];
    }

    saveSessionAndUnlock($playCode, $session, $fp);
    echo json_encode(['success' => true]);
}

/**
 * Signalement « l'élève a quitté l'onglet » (anti-triche, mode « avertir seulement »).
 * Incrémente un compteur sur le joueur pour que le prof le voie dans le pilotage.
 * NE déconnecte PAS (la reconnexion est auto au retour). Verrou court : non vital.
 * Volume négligeable (débouncé côté client à 1 beacon / 3 s).
 */
function reportTabSwitch() {
    $playCode = isset($_POST['playCode']) ? trim($_POST['playCode']) : '';
    $nickname = isset($_POST['nickname']) ? trim($_POST['nickname']) : '';
    if (empty($playCode) || empty($nickname)) return;

    list($session, $fp) = loadSessionForUpdate($playCode, 0.4);
    if (!$session) return; // pas grave si on rate ce signalement

    foreach ($session['players'] as &$player) {
        if (($player['nickname'] ?? '') === $nickname) {
            $player['tabSwitchCount'] = (int)($player['tabSwitchCount'] ?? 0) + 1;
            $player['leftTab'] = true;
            $player['lastTabSwitch'] = time();
            break;
        }
    }
    unset($player);

    saveSessionAndUnlock($playCode, $session, $fp);
    echo json_encode(['success' => true]);
}

/**
 * Quitter une partie
 */
function leaveGame() {
    $playCode = isset($_POST['playCode']) ? trim($_POST['playCode']) : '';
    $nickname = isset($_POST['nickname']) ? trim($_POST['nickname']) : '';

    if (empty($playCode) || empty($nickname)) return;

    list($session, $fp) = loadSessionForUpdate($playCode);
    if (!$session) return;

    foreach ($session['players'] as &$player) {
        if ($player['nickname'] === $nickname) {
            $player['connected'] = false;
            break;
        }
    }
    unset($player);

    saveSessionAndUnlock($playCode, $session, $fp);
}

/**
 * Forcer la reconnexion d'un joueur
 */
function reconnectPlayer() {
    $playCode = isset($_POST['playCode']) ? trim($_POST['playCode']) : '';
    $nickname = isset($_POST['nickname']) ? trim($_POST['nickname']) : '';

    if (empty($playCode) || empty($nickname)) {
        echo json_encode(['success' => false, 'message' => 'Paramètres manquants']);
        return;
    }

    list($session, $fp) = loadSessionForUpdate($playCode);
    if (!$session) {
        echo json_encode(['success' => false, 'message' => 'Session introuvable']);
        return;
    }

    foreach ($session['players'] as &$player) {
        if ($player['nickname'] === $nickname) {
            $timeSinceLastPing = time() - ($player['lastPing'] ?? 0);

            if ($timeSinceLastPing < 10) {
                $player['connected'] = true;
                saveSessionAndUnlock($playCode, $session, $fp);
                echo json_encode(['success' => true, 'online' => true]);
            } else {
                if ($fp) { @flock($fp, LOCK_UN); @fclose($fp); }
                echo json_encode([
                    'success' => false,
                    'online' => false,
                    'timeSinceLastPing' => $timeSinceLastPing
                ]);
            }
            return;
        }
    }
    unset($player);

    if ($fp) { @flock($fp, LOCK_UN); @fclose($fp); }
    echo json_encode(['success' => false, 'message' => 'Joueur non trouvé']);
}

/**
 * Ping pour maintenir la connexion
 */
function pingPlayer() {
    $playCode = isset($_POST['playCode']) ? trim($_POST['playCode']) : '';
    $nickname = isset($_POST['nickname']) ? trim($_POST['nickname']) : '';

    if (empty($playCode) || empty($nickname)) {
        echo json_encode(['success' => false]);
        return;
    }

    list($session, $fp) = loadSessionForUpdate($playCode);
    if (!$session) {
        echo json_encode(['success' => false]);
        return;
    }

    foreach ($session['players'] as &$player) {
        if ($player['nickname'] === $nickname) {
            $player['lastPing'] = time();
            $player['connected'] = true;
            break;
        }
    }
    unset($player);

    saveSessionAndUnlock($playCode, $session, $fp);
    echo json_encode(['success' => true]);
}

/**
 * Soumettre une réponse
 *
 * Justesse du score :
 *   - timeSpent est mesuré côté client en horloge locale (Date.now() - questionStartTime),
 *     donc juste vis-à-vis de l'élève (indépendant de la latence réseau et du moment où la
 *     question s'est affichée chez lui).
 *   - Une réponse est acceptée si elle satisfait DEUX conditions :
 *       (a) la session est encore sur la même question (currentQuestion === questionIndex)
 *       (b) le timeSpent client est <= (questionTime + QUESTION_TIMEOUT_GRACE) * 1000 ms
 *   - Si la question a déjà été marquée questionCompleted=true (auto-completion serveur)
 *     mais que les conditions (a) et (b) restent satisfaites, la réponse est ACCEPTÉE
 *     RÉTROACTIVEMENT et le score de ce joueur est calculé seul (le Top 3 affiché aux
 *     autres reste figé, mais le score interne est correct).
 *   - Si une condition n'est pas remplie, la réponse est rejetée avec tooLate=true.
 */
function submitAnswer() {
    $playCode = isset($_POST['playCode']) ? trim($_POST['playCode']) : '';
    $nickname = isset($_POST['nickname']) ? trim($_POST['nickname']) : '';
    $questionIndex = isset($_POST['questionIndex']) ? intval($_POST['questionIndex']) : 0;
    $answer = isset($_POST['answer']) ? $_POST['answer'] : '';
    // Normalisation défensive : 'answer' DOIT être stocké en CHAÎNE (les scores sont
    // dérivés via json_decode(string) à la lecture — un tableau ferait planter PHP 8).
    // En POST urlencodé c'est déjà une chaîne, mais on blinde quoi qu'il arrive.
    if (!is_string($answer)) $answer = json_encode($answer);
    $timeSpent = isset($_POST['timeSpent']) ? intval($_POST['timeSpent']) : 0;

    if (empty($playCode) || empty($nickname)) {
        echo json_encode(['success' => false, 'message' => 'Paramètres manquants']);
        return;
    }

    // Attente COURTE du verrou (1,2 s) : sous rafale de réponses (fin de question),
    // tenir un process PHP 3 s épuisait le pool OVH → HTTP 500 en cascade. Si le verrou
    // n'est pas obtenu, on renvoie une réponse retryable ; le client re-tente via
    // pendingAnswers et la GRACE serveur (15 s) garantit l'enregistrement final.
    list($session, $fp) = loadSessionForUpdate($playCode, 1.2);
    if (!$session) {
        echo json_encode(['success' => false, 'message' => 'Session occupée, réessaie', 'retryable' => true]);
        return;
    }

    // Diagnostic logs : on capture toujours questionIndex et timeSpent pour analyse a posteriori
    setMetricDetail('q', $questionIndex);
    setMetricDetail('t', $timeSpent);

    // L'état de pilotage fait foi : fichier single-writer (control.php), que les
    // requêtes élèves n'écrivent jamais — il ne peut donc pas être périmé par un
    // lost update côté session joueurs.
    qst_ensureState($playCode, $session);
    $state = qst_loadState($playCode) ?: [];

    // Garde-fou (a) : la session est-elle encore sur cette question ?
    $sessionQuestion = $state['currentQuestion'] ?? ($session['currentQuestion'] ?? -1);
    if ($sessionQuestion !== $questionIndex) {
        if ($fp) { flock($fp, LOCK_UN); fclose($fp); }
        error_log("SUBMIT_REJECT: Q$questionIndex obsolète (session sur Q$sessionQuestion) pour $nickname");
        setMetricDetail('tooLate', 'qchg');
        setMetricDetail('curQ', $sessionQuestion);
        echo json_encode([
            'success' => false,
            'tooLate' => true,
            'reason' => 'question_changed'
        ]);
        return;
    }

    // Garde-fou (b) : le timeSpent client est-il dans la grâce ?
    $questions = $session['questions'] ?? $session['quizData']['questions'] ?? [];
    $questionTime = ($state['customTime'] ?? null) ?? $questions[$questionIndex]['time'] ?? 30;
    $maxAllowedMs = ($questionTime + QUESTION_TIMEOUT_GRACE) * 1000;
    if ($timeSpent > $maxAllowedMs) {
        if ($fp) { flock($fp, LOCK_UN); fclose($fp); }
        error_log("SUBMIT_REJECT: Q$questionIndex hors délai pour $nickname (timeSpent={$timeSpent}ms > {$maxAllowedMs}ms)");
        setMetricDetail('tooLate', 'time');
        setMetricDetail('max', $maxAllowedMs);
        echo json_encode([
            'success' => false,
            'tooLate' => true,
            'reason' => 'time_exceeded'
        ]);
        return;
    }

    // Acceptation : enregistrer la réponse. La complétion fait foi via le done-file.
    // PREMIÈRE RÉPONSE DÉFINITIVE : si le joueur a déjà répondu à cette question, on
    // n'écrase pas (un petit malin pourrait répondre vite au hasard puis corriger via
    // devtools ; et les ré-émissions de confirmation deviennent idempotentes de fait).
    $alreadyCompleted = qst_doneExists($playCode, $questionIndex);
    $alreadyAnswered = false;
    foreach ($session['players'] as &$player) {
        if ($player['nickname'] === $nickname) {
            if (isset($player['answers'][$questionIndex])) {
                $alreadyAnswered = true;
                $player['lastPing'] = time();
                $player['connected'] = true;
                break;
            }
            $player['answers'][$questionIndex] = [
                'questionIndex' => $questionIndex,
                'answer' => $answer,
                'timeSpent' => $timeSpent,
                'timestamp' => time()
            ];
            $player['lastPing'] = time();
            $player['connected'] = true;
            break;
        }
    }
    unset($player);

    if ($alreadyAnswered) {
        setMetricDetail('dup', 1);
        saveSessionAndUnlock($playCode, $session, $fp);
        echo json_encode(['success' => true, 'duplicate' => true]);
        return;
    }

    if ($alreadyCompleted) {
        // Acceptation rétroactive : le score étant DÉRIVÉ des réponses à la lecture,
        // enregistrer la réponse suffit — les points apparaîtront partout, sans
        // toucher au Top 3 figé (embarqué dans le done-file, immuable).
        error_log("SUBMIT_LATE_ACCEPTED: Q$questionIndex pour $nickname (timeSpent={$timeSpent}ms, déjà completed)");
        setMetricDetail('lateAcc', 1);
        saveSessionAndUnlock($playCode, $session, $fp);
        echo json_encode(['success' => true, 'lateAccepted' => true]);
        return;
    }

    // Flux normal : timer écoulé ? → complétion par création du done-file (immuable)
    $forceComplete = qst_maybeTimeoutComplete($playCode, $session, $state, QUESTION_TIMEOUT_GRACE);

    if (!$forceComplete) {
        // Vérifier si tous les joueurs ACTIFS ont répondu
        $allAnswered = true;
        $activePlayersCount = 0;
        foreach ($session['players'] as $player) {
            $isActive = $player['connected'] && (time() - $player['lastPing'] < ACTIVE_PLAYER_THRESHOLD);
            if ($isActive) {
                $activePlayersCount++;
                if (!isset($player['answers'][$questionIndex])) {
                    $allAnswered = false;
                }
            }
        }

        if ($allAnswered && $activePlayersCount > 0) {
            error_log("SUBMIT: Tous actifs ont répondu Q$questionIndex");
            if (qst_createDone($playCode, $questionIndex, 'all_answered', $session, $state)) {
                setMetricDetail('allDone', 1);
                logEvent('question_complete_all_answered', $playCode, '', "q={$questionIndex}&active={$activePlayersCount}");
            }
        }
    }

    setMetricDetail('ok', 1);
    saveSessionAndUnlock($playCode, $session, $fp);
    echo json_encode(['success' => true]);
}

/**
 * Reçoit un buffer d'événements diagnostiques côté client (envoyé via
 * navigator.sendBeacon au beforeunload, ou à la fin d'une partie).
 *
 * Format : POST { playCode, nickname, events: JSON.stringify([...]) }
 * Limites strictes pour éviter qu'un client malveillant ou bogué fasse
 * exploser le disque :
 *   - taille brute max : 32 KB
 *   - nb d'events max : 200
 *   - 1 seul appel par client/partie attendu (sendBeacon au beforeunload)
 *
 * Stocké dans `php/data/metrics/client-YYYY-MM-DD.log`, format TSV :
 *   datetime \t ip \t playCode \t nickname \t event_type \t details_libres
 */
function submitClientLog() {
    $playCode = isset($_POST['playCode']) ? trim($_POST['playCode']) : '';
    $nicknameRaw = isset($_POST['nickname']) ? $_POST['nickname'] : '';
    $nickname = validateNickname($nicknameRaw);
    $eventsJson = isset($_POST['events']) ? $_POST['events'] : '';

    if (empty($playCode) || $nickname === null) {
        echo json_encode(['success' => false, 'message' => 'Paramètres manquants']);
        return;
    }
    if (strlen($eventsJson) > 32 * 1024) {
        echo json_encode(['success' => false, 'message' => 'Payload trop gros']);
        return;
    }
    $events = json_decode($eventsJson, true);
    if (!is_array($events) || count($events) === 0) {
        echo json_encode(['success' => false, 'message' => 'Aucun event']);
        return;
    }
    if (count($events) > 200) {
        $events = array_slice($events, -200);
    }

    if (!METRICS_ENABLED) {
        echo json_encode(['success' => true, 'skipped' => true]);
        return;
    }

    $dir = METRICS_DIR;
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    if (!is_writable($dir)) {
        echo json_encode(['success' => false, 'message' => 'metrics dir non writable']);
        return;
    }
    $file = $dir . '/client-' . date('Y-m-d') . '.log';
    // Rotation : si fichier > 30 MB, on bascule en .old
    if (file_exists($file) && @filesize($file) > METRICS_MAX_BYTES) {
        @rename($file, $dir . '/client-' . date('Y-m-d') . '.old.log');
    }

    $ip = $_SERVER['REMOTE_ADDR'] ?? '?';
    $clean = function($v) {
        return str_replace(["\t", "\n", "\r"], ' ', (string)$v);
    };
    $lines = '';
    foreach ($events as $ev) {
        if (!is_array($ev)) continue;
        $t = $ev['t'] ?? '';
        $type = isset($ev['type']) ? (string)$ev['type'] : 'unknown';
        $data = isset($ev['data']) ? $ev['data'] : '';
        if (is_array($data)) {
            $kv = [];
            foreach ($data as $k => $v) {
                $kv[] = $clean($k) . '=' . $clean(substr((string)$v, 0, 80));
            }
            $data = implode('&', $kv);
        } else {
            $data = (string)$data;
        }
        // t = timestamp client (ms epoch). On le formate côté serveur si besoin.
        $tHuman = is_numeric($t) ? date('Y-m-d H:i:s', (int)($t / 1000)) . '.' . sprintf('%03d', $t % 1000) : '?';
        $lines .= implode("\t", [
            $tHuman,
            $clean($ip),
            $clean(substr($playCode, 0, 16)),
            $clean(substr($nickname, 0, 50)),
            $clean(substr($type, 0, 40)),
            $clean(substr($data, 0, 300))
        ]) . "\n";
    }
    @file_put_contents($file, $lines, FILE_APPEND);
    echo json_encode(['success' => true, 'logged' => count($events)]);
}

/**
 * Coalescence : traite plusieurs réponses (questions différentes) d'un même
 * joueur en UN SEUL verrou flock. Utilisé au retour de connexion : si l'élève
 * a buffer 3 réponses pendant une coupure, le client envoie une seule requête
 * `answer_bulk` au lieu de 3 → divise le volume HTTP par N.
 *
 * Format POST :
 *   playCode, nickname, answers (JSON array de { questionIndex, answer, timeSpent })
 *
 * Retour : { success: true, results: [ { questionIndex, success, lateAccepted?, tooLate?, reason? }, ... ] }
 */
function submitAnswerBulk() {
    $playCode = isset($_POST['playCode']) ? trim($_POST['playCode']) : '';
    $nicknameRaw = isset($_POST['nickname']) ? $_POST['nickname'] : '';
    $nickname = validateNickname($nicknameRaw);
    $answersJson = isset($_POST['answers']) ? $_POST['answers'] : '';

    if (empty($playCode) || $nickname === null) {
        echo json_encode(['success' => false, 'message' => 'Paramètres manquants']);
        return;
    }

    $answersArray = json_decode($answersJson, true);
    if (!is_array($answersArray) || count($answersArray) === 0) {
        echo json_encode(['success' => false, 'message' => 'Aucune réponse']);
        return;
    }
    // Cap protectif (un quizz a au max 150 questions, mais on borne plus bas
    // pour limiter le coût d'une bulk par requête)
    if (count($answersArray) > 50) {
        echo json_encode(['success' => false, 'message' => 'Trop de réponses dans une seule requête']);
        return;
    }

    // Attente COURTE du verrou (1,2 s) — cf. submitAnswer : évite l'épuisement du pool
    // de process OVH sous rafale de retries. Réponse retryable si le verrou est occupé.
    list($session, $fp) = loadSessionForUpdate($playCode, 1.2);
    if (!$session) {
        echo json_encode(['success' => false, 'message' => 'Session occupée, réessaie', 'retryable' => true]);
        return;
    }

    // État de pilotage single-writer : vérité sur la question courante et le temps.
    qst_ensureState($playCode, $session);
    $state = qst_loadState($playCode) ?: [];
    $sessionCurrentQ = $state['currentQuestion'] ?? ($session['currentQuestion'] ?? -1);
    $questions = $session['questions'] ?? $session['quizData']['questions'] ?? [];
    $results = [];
    $shouldCheckCompletion = false;

    foreach ($answersArray as $item) {
        if (!is_array($item)) continue;
        $qIdx = isset($item['questionIndex']) ? intval($item['questionIndex']) : -1;
        $ans = isset($item['answer']) ? $item['answer'] : '';
        // CRITIQUE : $item provient du json_decode du tableau 'answers' → $ans peut être
        // un TABLEAU (client qui a envoyé un objet au lieu d'une chaîne JSON). On le
        // re-sérialise en chaîne pour ne JAMAIS stocker un tableau (qui ferait planter
        // json_decode() à la lecture en PHP 8 → 500 sur chaque get_state → classe figée).
        if (!is_string($ans)) $ans = json_encode($ans);
        $ts  = isset($item['timeSpent']) ? intval($item['timeSpent']) : 0;

        if ($qIdx < 0 || !isset($questions[$qIdx])) {
            $results[] = ['questionIndex' => $qIdx, 'success' => false, 'tooLate' => true, 'reason' => 'question_changed'];
            continue;
        }

        $questionTime = ($state['customTime'] ?? null) ?? $questions[$qIdx]['time'] ?? 30;
        $maxAllowedMs = ($questionTime + QUESTION_TIMEOUT_GRACE) * 1000;
        if ($ts > $maxAllowedMs) {
            $results[] = ['questionIndex' => $qIdx, 'success' => false, 'tooLate' => true, 'reason' => 'time_exceeded'];
            continue;
        }

        // Question dépassée (session sur une plus récente) → on accepte rétroactivement
        // si le timeSpent est dans la grâce ET la question existait.
        $isCurrent = ($qIdx === $sessionCurrentQ);
        $alreadyCompletedThisQ = $isCurrent && qst_doneExists($playCode, $qIdx);
        $isLate = !$isCurrent || $alreadyCompletedThisQ;

        // Enregistrer la réponse sur le joueur (les points sont DÉRIVÉS à la lecture —
        // aucune mutation de score, donc rien à perdre ni à compter double).
        $found = false;
        foreach ($session['players'] as &$player) {
            if ($player['nickname'] === $nickname) {
                $found = true;
                // Pas de double-enregistrement : si déjà répondu à cette question, on ignore.
                if (isset($player['answers'][$qIdx])) {
                    $results[] = ['questionIndex' => $qIdx, 'success' => true, 'duplicate' => true];
                    break;
                }
                $player['answers'][$qIdx] = [
                    'questionIndex' => $qIdx,
                    'answer' => $ans,
                    'timeSpent' => $ts,
                    'timestamp' => time()
                ];
                $player['lastPing'] = time();
                $player['connected'] = true;

                if ($isLate) {
                    $results[] = ['questionIndex' => $qIdx, 'success' => true, 'lateAccepted' => true];
                } else {
                    $results[] = ['questionIndex' => $qIdx, 'success' => true];
                    $shouldCheckCompletion = true;
                }
                break;
            }
        }
        unset($player);

        if (!$found) {
            $results[] = ['questionIndex' => $qIdx, 'success' => false, 'reason' => 'player_not_in_session'];
        }
    }

    // Si la question courante a été touchée, vérifier si tout le monde a répondu
    if ($shouldCheckCompletion && $sessionCurrentQ >= 0 && !qst_doneExists($playCode, $sessionCurrentQ)) {
        $forceComplete = qst_maybeTimeoutComplete($playCode, $session, $state, QUESTION_TIMEOUT_GRACE);
        if (!$forceComplete) {
            $allAnswered = true;
            $activePlayersCount = 0;
            foreach ($session['players'] as $player) {
                $isActive = $player['connected'] && (time() - $player['lastPing'] < ACTIVE_PLAYER_THRESHOLD);
                if ($isActive) {
                    $activePlayersCount++;
                    if (!isset($player['answers'][$sessionCurrentQ])) {
                        $allAnswered = false;
                    }
                }
            }
            if ($allAnswered && $activePlayersCount > 0) {
                if (qst_createDone($playCode, $sessionCurrentQ, 'all_answered', $session, $state)) {
                    logEvent('question_complete_all_answered', $playCode, '', "q={$sessionCurrentQ}&active={$activePlayersCount}");
                }
            }
        }
    }

    // Diagnostic : compter les types de résultats
    $ok = 0; $late = 0; $tooLate = 0; $dup = 0;
    foreach ($results as $r) {
        if (!empty($r['lateAccepted'])) { $late++; }
        elseif (!empty($r['duplicate'])) { $dup++; }
        elseif (!empty($r['success'])) { $ok++; }
        elseif (!empty($r['tooLate'])) { $tooLate++; }
    }
    setMetricDetail('n', count($answersArray));
    setMetricDetail('ok', $ok);
    if ($late > 0) setMetricDetail('late', $late);
    if ($tooLate > 0) setMetricDetail('tooLate', $tooLate);
    if ($dup > 0) setMetricDetail('dup', $dup);

    saveSessionAndUnlock($playCode, $session, $fp);
    echo json_encode(['success' => true, 'results' => $results]);
}

// NB : les anciens helpers scorePlayerAnswer / checkAndForceQuestionCompletion /
// calculateQuestionScores / freezeRanking (mutations de la session) ont été remplacés
// par le store partagé (session_store.php) : complétion = fichier done immuable
// (qst_maybeTimeoutComplete / qst_createDone, classement figé embarqué), scores
// DÉRIVÉS des réponses à la lecture (qst_decorateSession / qst_evaluateAnswer).

/**
 * NOUVEAU : Action watchdog appelable par les élèves
 */
function checkQuestionTimeout() {
    $playCode = isset($_GET['playCode']) ? trim($_GET['playCode']) : '';
    $nickname = isset($_GET['nickname']) ? trim($_GET['nickname']) : '';
    $questionIndex = isset($_GET['questionIndex']) ? intval($_GET['questionIndex']) : -1;
    
    if (empty($playCode)) {
        echo json_encode(['success' => false, 'message' => 'Paramètres manquants']);
        return;
    }
    
    list($session, $fp) = loadSessionForUpdate($playCode);
    if (!$session) {
        echo json_encode(['success' => false, 'message' => 'Session introuvable']);
        return;
    }

    if (!empty($nickname)) {
        foreach ($session['players'] as &$player) {
            if ($player['nickname'] === $nickname) {
                $player['lastPing'] = time();
                $player['connected'] = true;
                break;
            }
        }
        unset($player);
    }

    qst_ensureState($playCode, $session);
    $state = qst_loadState($playCode) ?: [];
    $wasForced = qst_maybeTimeoutComplete($playCode, $session, $state, QUESTION_TIMEOUT_GRACE);

    saveSessionAndUnlock($playCode, $session, $fp);

    $view = qst_view($playCode, $session, $state);
    $response = [
        'success' => true,
        'questionCompleted' => $view['questionCompleted'] ?? false,
        'wasForced' => $wasForced
    ];

    if ($view['questionCompleted'] ?? false) {
        $currentQ = $view['currentQuestion'] ?? -1;
        if ($currentQ >= 0) {
            $response['results'] = calculateQuestionResults($view, $currentQ);
        }
    }

    echo json_encode($response);
}

// NB : streamEvents (SSE, déjà non routé), calculateQuestionScores et freezeRanking
// ont été supprimés — remplacés par le store partagé (cf. session_store.php) :
// scores dérivés à la lecture, classement figé embarqué dans le done-file immuable.

/**
 * Calculer les résultats d'une question.
 * $session doit être une VUE (qst_view) : scores/correct/points déjà dérivés,
 * rankingSnapshot issu du done-file si la question est complétée.
 */
function calculateQuestionResults(&$session, $questionIndex) {
    $questions = $session['questions'] ?? $session['quizData']['questions'] ?? [];
    
    if (!isset($questions[$questionIndex])) {
        return [
            'questionIndex' => $questionIndex,
            'correctAnswer' => null,
            'question' => null,
            'top3' => [],
            'allPlayers' => [],
            'manualMode' => $session['manualMode'] ?? false,
            'questionStats' => [],
            'top5Fastest' => [],
            'isLastQuestion' => false,
            'totalQuestions' => 0
        ];
    }
    
    $question = $questions[$questionIndex];
    
    $correctAnswer = null;
    switch ($question['type']) {
        case 'multiple':
        case 'truefalse':
            foreach ($question['answers'] as $index => $answer) {
                if ($answer['correct']) {
                    $correctAnswer = $index;
                    break;
                }
            }
            break;
        case 'order':
            $correctAnswer = array_map(function($a) { return $a['text']; }, $question['answers']);
            break;
        case 'freetext':
            $correctAnswer = $question['answers'][0]['text'];
            break;
    }
    
    // Classement FIGÉ à la complétion (anti-scintillement) : on réutilise l'instantané
    // pris quand questionCompleted est passé à true. Repli : tri live stable si absent.
    if (isset($session['rankingSnapshot']) && (($session['rankingSnapshot']['q'] ?? -1) === $questionIndex)) {
        $playersCopy = $session['rankingSnapshot']['players'];
    } else {
        $playersCopy = array_values($session['players']);
        usort($playersCopy, function($a, $b) {
            $d = (int)($b['score'] ?? 0) - (int)($a['score'] ?? 0);
            if ($d !== 0) return $d;
            return strcmp((string)($a['nickname'] ?? ''), (string)($b['nickname'] ?? ''));
        });
    }

    $top3 = array_slice($playersCopy, 0, 3);
    
    $questionStats = [];
    foreach ($session['players'] as $player) {
        if (isset($player['answers'][$questionIndex])) {
            $answer = $player['answers'][$questionIndex];
            $questionStats[] = [
                'nickname' => $player['nickname'],
                'correct' => $answer['correct'] ?? false,
                'timeSpent' => $answer['timeSpent'] ?? 0,
                'pointsEarned' => $answer['points'] ?? 0,
                'answered' => true
            ];
        } else {
            // Inclure aussi les joueurs qui n'ont pas répondu
            $questionStats[] = [
                'nickname' => $player['nickname'],
                'correct' => false,
                'timeSpent' => 0,
                'pointsEarned' => 0,
                'answered' => false
            ];
        }
    }
    
    $correctAnswers = array_filter($questionStats, function($s) { return $s['correct']; });
    usort($correctAnswers, function($a, $b) { return $a['timeSpent'] - $b['timeSpent']; });
    $top5Fastest = array_slice($correctAnswers, 0, 5);
    
    $totalQuestions = count($questions);
    $isLastQuestion = ($questionIndex + 1) >= $totalQuestions;
    
    return [
        'questionIndex' => $questionIndex,
        'correctAnswer' => $correctAnswer,
        'question' => $question,
        'top3' => $top3,
        'allPlayers' => $playersCopy,
        'manualMode' => $session['manualMode'] ?? false,
        'questionStats' => $questionStats,
        'top5Fastest' => $top5Fastest,
        'isLastQuestion' => $isLastQuestion,
        'totalQuestions' => $totalQuestions
    ];
}

/**
 * Calculer les résultats finaux
 */
function calculateFinalResults($session) {
    $players = $session['players'];
    usort($players, function($a, $b) {
        return ($b['score'] ?? 0) - ($a['score'] ?? 0);
    });
    
    $gameStarted = isset($session['currentQuestion']) && $session['currentQuestion'] >= 0;
    
    $questions = $session['questions'] ?? $session['quizData']['questions'] ?? [];
    $questionsWithAnswers = [];
    
    foreach ($questions as $index => $question) {
        $correctAnswer = null;
        switch ($question['type']) {
            case 'multiple':
            case 'truefalse':
                foreach ($question['answers'] as $i => $a) {
                    if ($a['correct']) {
                        $correctAnswer = ['index' => $i, 'text' => $a['text']];
                        break;
                    }
                }
                break;
            case 'order':
                $correctAnswer = array_map(function($a) { return $a['text']; }, $question['answers']);
                break;
            case 'freetext':
                $correctAnswer = [
                    'text' => $question['answers'][0]['text'],
                    'acceptedAnswers' => $question['acceptedAnswers'] ?? []
                ];
                break;
        }
        
        $questionsWithAnswers[] = [
            'index' => $index,
            'type' => $question['type'],
            'question' => $question['question'],
            'imageUrl' => $question['imageUrl'] ?? null,
            'answers' => $question['answers'],
            'correctAnswer' => $correctAnswer
        ];
    }
    
    return [
        'players' => $players,
        'totalQuestions' => $session['currentQuestion'] ?? 0,
        'gameStarted' => $gameStarted,
        'currentQuestion' => $session['currentQuestion'] ?? 0,
        'questionsWithAnswers' => $questionsWithAnswers
    ];
}

// ========================================
// FONCTIONS UTILITAIRES
// ========================================

/**
 * Charge une session avec verrouillage partagé (lecture)
 * Permet plusieurs lectures simultanées mais bloque les écritures
 */
/**
 * Valide qu'un playCode est utilisable comme nom de fichier (anti path traversal).
 * Retourne le code normalisé (majuscules) ou null si invalide.
 * Format attendu : 3 à 12 caractères [A-Z0-9].
 */
function validatePlayCode($code) {
    $code = strtoupper(trim((string)$code));
    return preg_match('/^[A-Z0-9]{3,12}$/', $code) ? $code : null;
}

function loadSession($playCode) {
    $playCode = validatePlayCode($playCode);
    if ($playCode === null) {
        error_log("LOAD_SESSION: playCode invalide rejeté");
        return null;
    }
    $file = SESSIONS_DIR . '/' . $playCode . '.json';

    if (!file_exists($file)) {
        return null;
    }
    
    // Lecture simple sans verrouillage pour les opérations read-only
    $content = @file_get_contents($file);
    if ($content === false) {
        return null;
    }
    
    $data = json_decode($content, true);
    if ($data === null && json_last_error() !== JSON_ERROR_NONE) {
        error_log("LOAD_SESSION: Erreur JSON pour $playCode: " . json_last_error_msg());
        return null;
    }
    
    return $data;
}

/**
 * Charge et verrouille une session pour modification (lecture + écriture atomique)
 * Retourne [session, fileHandle] - Le handle DOIT être passé à saveSessionAndUnlock
 */
function loadSessionForUpdate($playCode, $maxWaitSec = 3) {
    $playCode = validatePlayCode($playCode);
    if ($playCode === null) {
        error_log("LOAD_SESSION_UPDATE: playCode invalide rejeté");
        return [null, null];
    }
    $file = SESSIONS_DIR . '/' . $playCode . '.json';

    if (!file_exists($file)) {
        return [null, null];
    }

    // VERROU SÉPARÉ (CODE.lock, jamais renommé) + lecture FRAÎCHE après acquisition.
    // L'écriture du .json est désormais ATOMIQUE (tmp+rename sur Linux) : verrouiller
    // le .json lui-même deviendrait orphelin après un rename. Voir session_store.php.
    // $maxWaitSec est paramétrable. get_state passe 0 → tentative NON BLOQUANTE unique :
    // si le verrou est libre on l'obtient, sinon on bascule INSTANTANÉMENT en lecture
    // seule. C'est LE point clé anti-tempête : sous une rafale de réponses (fin de
    // question), le verrou est tenu par les écritures ; un get_state qui ATTENDAIT
    // (même 0,4 s) empilait les process PHP → épuisement du pool OVH → HTTP 500 en
    // cascade. En ne bloquant jamais, get_state ne participe plus à la contention.
    $fp = qst_acquireSessionLock($playCode, $maxWaitSec);
    if (!$fp) {
        error_log("LOAD_SESSION_UPDATE: Verrou non obtenu pour $playCode — abandon propre");
        return [null, null];
    }

    $content = @file_get_contents($file);
    if ($content === false || $content === '') {
        qst_releaseSessionLock($fp);
        return [null, null];
    }

    $data = json_decode($content, true);
    if ($data === null && json_last_error() !== JSON_ERROR_NONE) {
        error_log("LOAD_SESSION_UPDATE: Erreur JSON pour $playCode: " . json_last_error_msg());
        qst_releaseSessionLock($fp);
        return [null, null];
    }

    return [$data, $fp];
}

/**
 * Sauvegarde une session et libère le verrou
 * @param string $playCode Code de la partie
 * @param array $session Données de session
 * @param resource|null $fp Handle de fichier (si null, utilise l'ancienne méthode)
 */
/**
 * Sauvegarde une session.
 *
 * Stratégie en deux modes :
 *
 *  - Avec verrou (fp != null) : écriture in-place sous flock LOCK_EX. Le verrou
 *    sérialise totalement les écritures donc fwrite ne peut pas être entrelacé
 *    au niveau byte. PAS de tmp+rename ici : c'est précisément la fenêtre
 *    "unlock avant rename" qui causait des lost updates massifs (race_test FAIL,
 *    17/20 réponses perdues). Le PID partagé entre threads Apache mpm_winnt n'est
 *    plus un problème puisqu'on n'utilise plus de fichier tmp dans ce chemin.
 *
 *  - Sans verrou (fp == null) : tmp+rename atomique avec uniqid. Utilisé seulement
 *    pour la création initiale (createSession), où il n'y a pas de race possible
 *    puisque le fichier n'existe pas encore.
 *
 *  IMPORTANT : pour que ce schéma soit sûr, TOUTES les fonctions qui écrivent
 *  une session existante doivent passer par loadSessionForUpdate + saveSessionAndUnlock.
 *  Ne jamais appeler saveSession() (= sans fp) sur un fichier existant.
 */
function saveSessionAndUnlock($playCode, $session, $fp = null) {
    $playCode = validatePlayCode($playCode);
    if ($playCode === null) {
        error_log("SAVE_SESSION: playCode invalide rejeté");
        if ($fp) { @flock($fp, LOCK_UN); @fclose($fp); }
        return;
    }
    $file = SESSIONS_DIR . '/' . $playCode . '.json';

    $content = json_encode($session, JSON_PRETTY_PRINT);
    if ($content === false) {
        error_log("SAVE_SESSION: json_encode a échoué pour $playCode : " . json_last_error_msg());
        if ($fp) { @flock($fp, LOCK_UN); @fclose($fp); }
        return;
    }

    if ($fp) {
        // Écriture ATOMIQUE pour les lecteurs (tmp+rename sur Linux, in-place sous
        // Windows) sous le verrou CODE.lock. Voir session_store.php : l'écriture
        // in-place pouvait être entrelacée entre deux nœuds du cluster mutualisé
        // → JSON invalide persistant → session morte (mesuré le 12/06).
        if (!qst_atomicWriteFile($file, $content)) {
            error_log("SAVE_SESSION: écriture impossible pour $playCode");
        }
        qst_releaseSessionLock($fp);
        return;
    }

    // Création (pas de verrou) : tmp+rename atomique. uniqid évite le PID partagé.
    $tmpFile = $file . '.tmp.' . uniqid('', true);
    $written = @file_put_contents($tmpFile, $content);
    if ($written === false || $written !== strlen($content)) {
        error_log("SAVE_SESSION: Échec écriture du tmp pour $playCode (wrote=" . var_export($written, true) . ")");
        @unlink($tmpFile);
        return;
    }
    if (!@rename($tmpFile, $file)) {
        error_log("SAVE_SESSION: rename a échoué pour $playCode");
        @unlink($tmpFile);
    }
}

/**
 * Ancienne fonction pour compatibilité (sans verrouillage)
 */
function saveSession($playCode, $session) {
    saveSessionAndUnlock($playCode, $session, null);
}

/**
 * SYNCHRO v2 — handshake d'horloge (algo de Cristian côté client).
 * Renvoie UNIQUEMENT l'heure serveur en ms, le plus tôt possible : aucune lecture de
 * session, aucun verrou, traitement < 1 ms → le RTT mesuré par le client est quasi
 * intégralement réseau, donc l'estimation d'offset (serverMs + RTT/2 - reçuMs) est
 * précise. Le client en fait quelques aller-retours et garde le meilleur (RTT min).
 */
function timeSync() {
    echo json_encode(['success' => true, 'serverTimeMs' => qst_nowMs()]);
}

function getGameState() {
    $playCode = isset($_GET['playCode']) ? trim($_GET['playCode']) : '';
    $nickname = isset($_GET['nickname']) ? trim($_GET['nickname']) : '';

    if (empty($playCode) || empty($nickname)) {
        echo json_encode(['success' => false, 'message' => 'Paramètres manquants']);
        return;
    }

    // Verrou exclusif NON BLOQUANT (0 s d'attente). get_state rafraîchit lastPing et
    // peut auto-compléter une question, mais ce n'est PAS vital à chaque poll. Si le
    // verrou est libre on fait le travail complet ; s'il est PRIS (rafale de réponses
    // en cours), on bascule INSTANTANÉMENT en lecture seule SANS attendre — c'est ce
    // qui empêche l'empilement de process PHP et la tempête de HTTP 500 (un get_state
    // qui attendait, même 0,4 s, participait à l'épuisement du pool OVH). lastPing sera
    // rafraîchi à un prochain poll où le verrou est libre (entre les rafales).
    list($session, $fp) = loadSessionForUpdate($playCode, 0);

    if (!$session) {
        // Session inexistante OU verrou indisponible rapidement : dans les deux cas la
        // lecture seule fait le bon choix (réponse "introuvable" propre, ou état complet
        // sans rafraîchir lastPing). On ne bloque JAMAIS un process et on ne 500 jamais.
        setMetricDetail('degraded', 1);
        getGameStateReadonly();
        return;
    }

    $playerExists = false;
    $playerIndex = -1;

    // Guard null/array (PHP 8 : foreach sur null = warning, accès clé absente = warning) :
    // une session valide a toujours 'players', mais on ne prend AUCUN risque de fatal/500.
    foreach (($session['players'] ?? []) as $index => $player) {
        if (($player['nickname'] ?? null) === $nickname) {
            $playerExists = true;
            $playerIndex = $index;
            break;
        }
    }

    if (!$playerExists) {
        // Libérer le verrou avant de répondre
        if ($fp) {
            flock($fp, LOCK_UN);
            fclose($fp);
        }
        echo json_encode(['success' => false, 'message' => 'Joueur non trouvé', 'kicked' => true]);
        return;
    }

    $session['players'][$playerIndex]['lastPing'] = time();
    $session['players'][$playerIndex]['connected'] = true;

    // Vérification automatique du timeout : crée le done-file (immuable) si le temps
    // est largement écoulé — filet de sécurité ultime quand plus aucune fenêtre prof
    // n'est ouverte (le pilotage/projection le fait normalement avec une grâce de 3 s).
    qst_ensureState($playCode, $session);
    $state = qst_loadState($playCode) ?: [];
    qst_maybeTimeoutComplete($playCode, $session, $state, QUESTION_TIMEOUT_GRACE);

    // Sauvegarder et libérer le verrou
    saveSessionAndUnlock($playCode, $session, $fp);

    // Facteur de charge multi-classes : recalculé ici (polls écrivains seulement,
    // 1 sur POLL_READONLY_RATIO) pour que le glob ne touche jamais le chemin chaud.
    qst_refreshCrowd();

    $view = qst_view($playCode, $session, $state);

    // Diagnostic : capture l'état renvoyé pour reconstituer "qui voyait quoi quand"
    setMetricDetail('s', $view['state'] ?? '?');
    setMetricDetail('q', $view['currentQuestion'] ?? -1);
    if (!empty($view['questionCompleted'])) setMetricDetail('qc', 1);
    if (!empty($view['paused'])) setMetricDetail('paused', 1);

    echo json_encode(buildGameStateResponse($view, false, $nickname));
}

/**
 * Variante lecture-seule de get_state : ne prend AUCUN verrou flock, ne met
 * pas à jour lastPing, n'appelle pas checkAndForceQuestionCompletion.
 *
 * Utilisée par le client pour la majorité de ses polls (cf. POLL_READONLY_RATIO
 * dans config.js) afin de réduire la contention disque OVH mutualisé : un poll
 * "normal" prend un flock exclusif et fait load+modify+save → coûteux sous
 * charge. Un poll readonly est juste un file_get_contents + json_decode.
 *
 * Conséquence : lastPing n'est rafraîchi qu'à intervalle régulier (1 poll sur N
 * reste un get_state normal). Tant que cet intervalle reste < ACTIVE_PLAYER_THRESHOLD
 * (60 s), le joueur reste considéré actif.
 *
 * checkAndForceQuestionCompletion saute aussi, mais c'est sans conséquence :
 * le polling prof appelle déjà `force_question_complete` 3 s après expiration
 * du timer côté serveur (cf. control.js : RESYNC AUTO), donc l'auto-completion
 * reste garantie même si les polls élève sont en majorité readonly.
 */
function getGameStateReadonly() {
    $playCode = isset($_GET['playCode']) ? trim($_GET['playCode']) : '';
    $nickname = isset($_GET['nickname']) ? trim($_GET['nickname']) : '';

    if (empty($playCode) || empty($nickname)) {
        echo json_encode(['success' => false, 'message' => 'Paramètres manquants']);
        return;
    }

    $cleanPlayCode = validatePlayCode($playCode);
    if ($cleanPlayCode === null) {
        echo json_encode(['success' => false, 'message' => 'Code invalide']);
        return;
    }

    $sessionFile = SESSIONS_DIR . '/' . $cleanPlayCode . '.json';
    if (!file_exists($sessionFile)) {
        echo json_encode(['success' => false, 'message' => 'Session introuvable']);
        return;
    }

    // Lecture pure, sans flock. Si une écriture est en cours côté serveur
    // (10–50 ms typique), on peut lire un fichier momentanément vide ;
    // dans ce cas json_decode renverra null, on signale "transient" et le
    // client retentera au polling suivant.
    $content = @file_get_contents($sessionFile);
    if ($content === false || $content === '') {
        setMetricDetail('transient', 'empty');
        echo json_encode(['success' => false, 'message' => 'Session en cours d\'écriture', 'transient' => true]);
        return;
    }
    $session = json_decode($content, true);
    if (!is_array($session)) {
        setMetricDetail('transient', 'corrupt');
        echo json_encode(['success' => false, 'message' => 'Session corrompue (lecture concurrente)', 'transient' => true]);
        return;
    }

    // Vérifier que le joueur existe (kicked sinon)
    $playerExists = false;
    if (isset($session['players']) && is_array($session['players'])) {
        foreach ($session['players'] as $p) {
            if (isset($p['nickname']) && $p['nickname'] === $nickname) {
                $playerExists = true;
                break;
            }
        }
    }
    if (!$playerExists) {
        setMetricDetail('kicked', 1);
        echo json_encode(['success' => false, 'message' => 'Joueur non trouvé', 'kicked' => true]);
        return;
    }

    // Vue unifiée : état single-writer + complétion done-file + scores dérivés.
    // (2 lectures de petits fichiers en plus — pas de verrou, chemin toujours froid.)
    $view = qst_view($cleanPlayCode, $session);

    // Diagnostic même en readonly : state + currentQuestion
    setMetricDetail('s', $view['state'] ?? '?');
    setMetricDetail('q', $view['currentQuestion'] ?? -1);
    if (!empty($view['questionCompleted'])) setMetricDetail('qc', 1);

    echo json_encode(buildGameStateResponse($view, true, $nickname));
}

/**
 * Construit la réponse get_state à partir d'un objet $session déjà chargé.
 * Factorise la logique entre getGameState (read-write) et getGameStateReadonly.
 *
 * Si $readonly est true, on ajoute un flag dans la réponse pour permettre au
 * client de savoir que lastPing n'a pas été rafraîchi serveur-side.
 */
function buildGameStateResponse($session, $readonly = false, $nickname = '') {
    $state = $session['state'] ?? 'waiting';
    $allPlayers = $session['players'] ?? [];

    if ($state === 'waiting') {
        // EN LOBBY : on retourne TOUS les joueurs qui ont rejoint, sans filtre
        // par lastPing/connected. C'est essentiel pour la stabilité visuelle :
        // un élève qui passe son onglet en arrière-plan (Visibility API throttle
        // setTimeout à 1/s) peut voir son lastPing dépasser PING_TIMEOUT pendant
        // l'attente, ce qui le faisait disparaître/réapparaître chez les autres.
        // En lobby, l'intention "je suis dans la partie" est binaire : j'ai fait
        // join → je suis dedans. La déconnexion en attente n'a aucune conséquence
        // pédagogique, donc on ne la signale pas.
        $connectedPlayers = $allPlayers;
    } else {
        // En partie / fin : on garde le filtre pour ne montrer que les actifs.
        $connectedPlayers = array_filter($allPlayers, function($p) {
            return ($p['connected'] ?? false) && (time() - ($p['lastPing'] ?? 0) < PING_TIMEOUT);
        });
    }

    // Hint de transition pour le polling adaptatif côté client (cf. sessionManager.js
    // nextPollDelay). secondsSinceLastChange permet de basculer en fast-poll juste
    // après une transition. serverTime sert au diagnostic d'horloge.
    $now = time();
    $lastChange = max(
        $session['startTime']             ?? 0,
        $session['questionStartTime']     ?? 0,
        $session['questionCompletedTime'] ?? 0,
        $session['endTime']               ?? 0
    );

    // ANTI-TRICHE + ALLÈGEMENT RÉSEAU : les élèves ne reçoivent des autres joueurs
    // que le strict nécessaire à l'affichage (pseudo, score, connecté). Avant, le
    // payload embarquait TOUTES les réponses de TOUS les joueurs (lisible dans
    // l'onglet Réseau des devtools : un élève pouvait copier la réponse d'un
    // camarade ayant déjà répondu) et grossissait à chaque question — pénalisant
    // sur les connexions très lentes du collège.
    $slimPlayers = [];
    foreach ($connectedPlayers as $p) {
        $slimPlayers[] = [
            'nickname' => $p['nickname'] ?? '',
            'score' => (int)($p['score'] ?? 0),
            'connected' => (bool)($p['connected'] ?? false),
            'joinedAt' => $p['joinedAt'] ?? 0,
        ];
    }

    $response = [
        'success' => true,
        'state' => $session['state'] ?? 'waiting',
        'paused' => $session['paused'] ?? false,
        'players' => $slimPlayers,
        'currentQuestion' => $session['currentQuestion'] ?? -1,
        'secondsSinceLastChange' => $lastChange ? ($now - $lastChange) : null,
        'serverTime' => $now,
        // SYNCHRO v2 : horloge serveur en ms — référence pour l'horloge synchronisée
        // du client (handshake time_sync + correction opportuniste à chaque poll).
        'serverTimeMs' => qst_nowMs(),
        'readonly' => $readonly,
        // Facteur d'étalement multi-classes (anti-ban OVH) : >1 quand plusieurs
        // parties tournent en même temps sur le compte — le client étire ses
        // intervalles de polling de base (jamais la fenêtre de transition).
        'crowd' => qst_crowdFactor()
    ];

    // Instant de complétion (horloge serveur) : permet au client d'ANTICIPER
    // l'avance automatique (fast-poll autour de completedAt + 5 s) pour que la
    // question suivante soit détectée par tous dans la même seconde.
    if (!empty($session['questionCompletedTime'])) {
        $response['questionCompletedAt'] = $session['questionCompletedTime'];
        $response['manualMode'] = (bool)($session['manualMode'] ?? false);
    }

    // CONFIRMATION DES RÉPONSES : indexes des questions auxquelles CE joueur a une
    // réponse réellement ENREGISTRÉE côté serveur. Le client garde chaque réponse en
    // attente tant qu'elle n'apparaît pas ici, et la ré-émet si elle a été engloutie
    // par une écriture concurrente (lost update mutualisé) — le serveur dédoublonne.
    if ($nickname !== '') {
        foreach (($session['players'] ?? []) as $p) {
            if (($p['nickname'] ?? null) === $nickname) {
                $response['myAnswered'] = array_map('intval', array_keys($p['answers'] ?? []));
                break;
            }
        }
    }
    if (function_exists('setMetricDetail')) {
        setMetricDetail('np', count($connectedPlayers));
    }

    if (($session['state'] ?? '') === 'playing' && isset($session['currentQuestion'])) {
        $qIndex = $session['currentQuestion'];
        $questions = $session['questions'] ?? $session['quizData']['questions'] ?? [];

        if (isset($questions[$qIndex])) {
            $questionData = $questions[$qIndex];

            // Appliquer le temps personnalisé si défini
            if (isset($session['customTime']) && $session['customTime'] > 0) {
                $questionData['time'] = $session['customTime'];
            }

            // Question EXPURGÉE des solutions (drapeaux correct, variantes acceptées,
            // ordre correct) — la version complète arrive avec les résultats.
            $questionData = qst_sanitizeQuestionForStudent($questionData, $session['playCode'] ?? '', $qIndex);

            $response['question'] = [
                'index' => $qIndex,
                'data' => $questionData,
                'startTime' => $session['questionStartTime'] ?? time(),
                // SYNCHRO v2 : instant ABSOLU d'apparition (ms serveur) + durée (ms).
                // Le client révèle quand SON horloge synchronisée atteint revealAt, et
                // affiche le temps restant = durationMs - (horloge - revealAt). Si
                // revealAt manque (session legacy), repli sur startTime*1000.
                'revealAt' => (int)($session['questionRevealAt'] ?? 0) ?: (($session['questionStartTime'] ?? 0) * 1000),
                'durationMs' => ((int)($questionData['time'] ?? 30)) * 1000,
                'totalQuestions' => count($questions)
            ];
        }
    }

    if (isset($session['questionCompletedTime']) && isset($session['currentQuestion'])) {
        $response['results'] = calculateQuestionResults($session, $session['currentQuestion']);
    }

    if (($session['state'] ?? '') === 'finished') {
        $response['finalResults'] = calculateFinalResults($session);
    }

    return $response;
}

function cleanOldSessions() {
    // Nettoyage par GROUPE (CODE.json + CODE.state.json + CODE.done.q*.json) : le
    // groupe est supprimé quand son fichier le plus récent dépasse le timeout —
    // jamais de suppression partielle d'une session encore active.
    qst_cleanOldSessionGroups(SESSION_TIMEOUT);
}
?>
