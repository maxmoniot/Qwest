<?php
// ============================================
// QWEST - METRICS DASHBOARD BACKEND (à la racine — accessible OVH)
// Lit les logs de métriques produits par game.php / control.php et renvoie
// un JSON agrégé pour dashboard.html.
//
// TEMPORAIRE : ce fichier est à la racine pour rester accessible depuis le poste
// prof au collège, hors restriction LAN du dossier scripts/. Auth par teacher_hash.
// À retirer (ou redéplacer dans scripts/) une fois l'app stabilisée.
// ============================================

header('Content-Type: application/json; charset=utf-8');

/**
 * Source de vérité pour le hash prof : on lit le hash depuis php/control.php
 * (qui est le fichier canonical de l'app, déjà en place). Évite tout
 * mismatch entre dashboard.php et control.php après une rotation de mdp.
 * Fallback : un hash codé en dur en cas d'échec de lecture.
 */
function loadTeacherHash() {
    $controlFile = __DIR__ . '/php/control.php';
    if (file_exists($controlFile)) {
        $content = @file_get_contents($controlFile);
        if ($content && preg_match("/define\\('TEACHER_HASH',\\s*'([a-f0-9]{64})'\\)/", $content, $m)) {
            return $m[1];
        }
    }
    // Fallback : sha256('prof123')
    return '00624b02e1f9b996a3278f559d5d55313552ad2c0bafc82adfd975c12df61eaf';
}
define('TEACHER_HASH', loadTeacherHash());

/**
 * Vérifie l'auth. Accepte AU CHOIX :
 *   - teacher_hash (SHA-256 hex du mot de passe) en GET ou POST
 *   - teacher_password (mot de passe en clair) en GET ou POST
 * Le second est utile si le hash côté JS ou le hash côté PHP a divergé pour
 * une quelconque raison (cache navigateur, config mise à jour incomplète).
 */
function isAuthenticated() {
    $h = $_GET['teacher_hash'] ?? $_POST['teacher_hash'] ?? '';
    if (is_string($h) && $h !== '' && hash_equals(TEACHER_HASH, $h)) {
        return true;
    }
    $p = $_GET['teacher_password'] ?? $_POST['teacher_password'] ?? '';
    if (is_string($p) && $p !== '') {
        $computed = hash('sha256', $p);
        if (hash_equals(TEACHER_HASH, $computed)) {
            return true;
        }
    }
    return false;
}

if (!isAuthenticated()) {
    http_response_code(403);
    if (isset($_GET['download'])) {
        header('Content-Type: text/plain; charset=utf-8');
        echo "403 — authentification requise";
    } else {
        echo json_encode(['success' => false, 'message' => 'Non autorisé (teacher_hash ou teacher_password requis)']);
    }
    exit;
}

define('METRICS_DIR', __DIR__ . '/php/data/metrics');

// ============================================
// Mode "liste des logs disponibles"
// ============================================
if (isset($_GET['list']) && $_GET['list'] === 'logs') {
    $files = [];
    if (is_dir(METRICS_DIR)) {
        // 3 types de fichiers : YYYY-MM-DD.log, YYYY-MM-DD.old.log, events-YYYY-MM-DD.log
        $glob = @glob(METRICS_DIR . '/*.log');
        if ($glob) {
            foreach ($glob as $f) {
                $basename = basename($f);
                $type = 'metrics';
                $dateKey = '';
                if (preg_match('/^(\d{4}-\d{2}-\d{2})\.log$/', $basename, $m)) {
                    $type = 'metrics';
                    $dateKey = $m[1];
                } elseif (preg_match('/^(\d{4}-\d{2}-\d{2})\.old\.log$/', $basename, $m)) {
                    $type = 'metrics-old';
                    $dateKey = $m[1];
                } elseif (preg_match('/^events-(\d{4}-\d{2}-\d{2})\.log$/', $basename, $m)) {
                    $type = 'events';
                    $dateKey = $m[1];
                } elseif (preg_match('/^client-(\d{4}-\d{2}-\d{2})\.log$/', $basename, $m)) {
                    $type = 'client';
                    $dateKey = $m[1];
                } elseif (preg_match('/^client-(\d{4}-\d{2}-\d{2})\.old\.log$/', $basename, $m)) {
                    $type = 'client-old';
                    $dateKey = $m[1];
                } else {
                    continue;
                }
                $files[] = [
                    'date' => $dateKey,
                    'type' => $type,
                    'filename' => $basename,
                    'sizeBytes' => @filesize($f) ?: 0,
                    'modified' => @filemtime($f) ?: 0
                ];
            }
            // Plus récent + metrics avant events
            usort($files, function($a, $b) {
                $c = strcmp($b['date'], $a['date']);
                if ($c !== 0) return $c;
                $order = ['metrics' => 0, 'metrics-old' => 1, 'events' => 2, 'client' => 3, 'client-old' => 4];
                return ($order[$a['type']] ?? 9) - ($order[$b['type']] ?? 9);
            });
        }
    }
    echo json_encode(['success' => true, 'files' => $files]);
    exit;
}

// ============================================
// Mode "télécharger un log précis"
// Paramètres : download=YYYY-MM-DD (par défaut metrics), type=metrics|metrics-old|events
// ============================================
if (isset($_GET['download'])) {
    $date = $_GET['download'];
    $type = $_GET['type'] ?? 'metrics';
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        http_response_code(400);
        header('Content-Type: text/plain; charset=utf-8');
        echo "400 — format date invalide (attendu YYYY-MM-DD)";
        exit;
    }
    switch ($type) {
        case 'metrics':
            $filename = $date . '.log';
            $downloadName = 'qwest-metrics-' . $date . '.tsv';
            break;
        case 'metrics-old':
            $filename = $date . '.old.log';
            $downloadName = 'qwest-metrics-' . $date . '-old.tsv';
            break;
        case 'events':
            $filename = 'events-' . $date . '.log';
            $downloadName = 'qwest-events-' . $date . '.tsv';
            break;
        case 'client':
            $filename = 'client-' . $date . '.log';
            $downloadName = 'qwest-client-' . $date . '.tsv';
            break;
        case 'client-old':
            $filename = 'client-' . $date . '.old.log';
            $downloadName = 'qwest-client-' . $date . '-old.tsv';
            break;
        default:
            http_response_code(400);
            header('Content-Type: text/plain; charset=utf-8');
            echo "400 — type invalide (metrics|metrics-old|events|client|client-old)";
            exit;
    }
    $file = METRICS_DIR . '/' . $filename;
    if (!file_exists($file)) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo "404 — pas de log $type pour $date";
        exit;
    }
    header('Content-Type: text/plain; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $downloadName . '"');

    if ($type === 'metrics' || $type === 'metrics-old') {
        echo "# Qwest — métriques v2 — " . $date . ($type === 'metrics-old' ? ' (ancien fichier, archivé après rotation 30 Mo)' : '') . "\n";
        echo "# Format TSV (9 colonnes) : timestamp_unix \\t ip \\t endpoint \\t playCode \\t nickname \\t http_code \\t duration_ms \\t details \\t ua_short\n";
        echo "#\n";
        echo "# details : chaîne 'k=v&k2=v2' avec champs métier selon l'endpoint :\n";
        echo "#   - get_state / get_state_readonly : s=<state>&q=<currentQuestion>&qc=1 si questionCompleted&paused=1 si pause\n";
        echo "#   - answer : q=<idx>&t=<timeSpentMs>&ok=1 (succès) | tooLate=qchg|time (rejet) | lateAcc=1 (rétroactif) | allDone=1 (tous ont répondu)\n";
        echo "#   - answer_bulk : n=<total>&ok=<succès>&late=<rétroactifs>&tooLate=<rejets>&dup=<doublons>\n";
        echo "#   - next_question : from=<oldQ>&to=<newQ>&idem=1 si idempotent&ct=<customTime>\n";
        echo "#   - force_question_complete : q=<idx>&forced=1 | idem=1 | mismatch=1\n";
        echo "#   - start_game : players=<N>\n";
        echo "#   - pause_game : paused=1|0\n";
        echo "#   - remove_player : target=<nickname>\n";
        echo "#   - end_game : prevState=<state>&lastQ=<idx>\n";
        echo "#   - any 429 : throttled=1&ra=<retryAfter>&count=<countInWindow>\n";
        echo "#\n";
        echo "# À surveiller dans ce fichier :\n";
        echo "#   - duration_ms > 1000 → lock contention ou OVH saturé\n";
        echo "#   - 429 répétés depuis une même IP → throttle se déclenche (boucle bug ?)\n";
        echo "#   - http_code 5xx → erreur serveur\n";
        echo "#   - tooLate=time fréquents → questionTime trop court ou wifi très lent\n";
        echo "#\n";
    } elseif ($type === 'events') {
        echo "# Qwest — événements " . $date . "\n";
        echo "# Format TSV : datetime \\t event_type \\t playCode \\t actor \\t details_libres\n";
        echo "# event_type : start_game | pause_game | next_question | force_question_complete | end_game | remove_player | question_complete_all_answered\n";
        echo "#\n";
    } else {
        // client / client-old
        echo "# Qwest — logs client " . $date . ($type === 'client-old' ? ' (archivé)' : '') . "\n";
        echo "# Format TSV : datetime_client \\t ip \\t playCode \\t nickname \\t event_type \\t details_libres\n";
        echo "# Envoyés via navigator.sendBeacon au beforeunload (1 fois par session, pas de surcharge).\n";
        echo "# event_type : session_init | visibility_change | cb_open | cb_close | pending_stored | flush\n";
        echo "# Le timestamp est local au navigateur du client — peut différer de l'horloge serveur.\n";
        echo "#\n";
    }
    readfile($file);
    exit;
}

// Fenêtre par défaut : 5 minutes glissantes (300 s).
$windowSec = isset($_GET['window']) ? max(60, min(3600, intval($_GET['window']))) : 300;
// Granularité bucket : 5 secondes par défaut. Plus fin = plus de points sur le graphe.
$bucketSec = isset($_GET['bucket']) ? max(1, min(60, intval($_GET['bucket']))) : 5;

$now = time();
$cutoff = $now - $windowSec;

if (!is_dir(METRICS_DIR)) {
    echo json_encode([
        'success' => true,
        'windowSec' => $windowSec,
        'bucketSec' => $bucketSec,
        'now' => $now,
        'totalRequests' => 0,
        'totalReqPerMin' => 0,
        'perBucket' => [],
        'byEndpoint' => [],
        'byStatus' => [],
        'topDevices' => [],
        'note' => 'Aucun dossier de métriques (pas encore de requêtes journalisées)'
    ]);
    exit;
}

// On peut avoir besoin du fichier d'hier si la fenêtre déborde sur minuit.
// On inclut aussi les .old.log si présent (post-rotation des gros logs).
$files = [];
foreach (['', '.old'] as $variant) {
    $today = METRICS_DIR . '/' . date('Y-m-d', $now) . $variant . '.log';
    $yesterday = METRICS_DIR . '/' . date('Y-m-d', $now - 86400) . $variant . '.log';
    if (file_exists($today)) $files[] = $today;
    if ($cutoff < strtotime('today') && file_exists($yesterday)) {
        array_unshift($files, $yesterday);
    }
}

$totalRequests = 0;
$perBucket = []; // bucketStart => count
$byEndpoint = []; // endpoint => count
$byStatus = []; // statusCode => count
$byDevice = []; // ip|nickname => count
$slowRequests = 0; // duration > 1000 ms (signal de lock contention / OVH lent)
$maxDuration = 0;

foreach ($files as $file) {
    // Lecture streamée pour gros fichiers
    $fp = @fopen($file, 'r');
    if (!$fp) continue;

    // IMPORTANT (anti-surcharge) : on ne lit que la QUEUE du fichier — juste assez pour
    // couvrir la fenêtre demandée. Avant, chaque rafraîchissement (toutes les 5-10 s)
    // relisait+parsait le fichier ENTIER (9+ Mo en fin de journée, ~100 k lignes), ce qui
    // tenait un process PHP et entrait en concurrence avec la partie en cours sur le pool
    // de process OVH. Le fichier étant chronologique et append-only, la fenêtre récente
    // est forcément à la fin → on se positionne près de l'EOF. Budget large : 8 Ko/s
    // (≈ 80 req/s × 100 o) × fenêtre, plancher 2 Mo.
    $fsize = @filesize($file);
    $tailBytes = max(2 * 1024 * 1024, $windowSec * 8000);
    if ($fsize !== false && $fsize > $tailBytes) {
        fseek($fp, $fsize - $tailBytes);
        fgets($fp); // jeter la 1ère ligne (probablement coupée en plein milieu)
    }

    while (($line = fgets($fp)) !== false) {
        $line = rtrim($line, "\r\n");
        if ($line === '') continue;
        $parts = explode("\t", $line);
        if (count($parts) < 6) continue; // au minimum format v1 (6 colonnes)
        $ts = intval($parts[0]);
        if ($ts < $cutoff) continue;
        $ip = $parts[1];
        $endpoint = $parts[2];
        $playCode = $parts[3];
        $nickname = $parts[4];
        $code = intval($parts[5]);
        $duration = isset($parts[6]) ? intval($parts[6]) : 0; // format v2

        $totalRequests++;
        if ($duration > 1000) $slowRequests++;
        if ($duration > $maxDuration) $maxDuration = $duration;
        $bucketStart = $ts - ($ts % $bucketSec);
        $perBucket[$bucketStart] = ($perBucket[$bucketStart] ?? 0) + 1;
        $byEndpoint[$endpoint] = ($byEndpoint[$endpoint] ?? 0) + 1;
        $byStatus[$code] = ($byStatus[$code] ?? 0) + 1;
        $deviceKey = $nickname !== '' ? ($ip . ' | ' . $nickname) : $ip;
        $byDevice[$deviceKey] = ($byDevice[$deviceKey] ?? 0) + 1;
    }
    fclose($fp);
}

// Trier les buckets par ordre chronologique
ksort($perBucket);
$bucketArr = [];
foreach ($perBucket as $bucketStart => $count) {
    $bucketArr[] = [
        'ts' => $bucketStart,
        'count' => $count,
        'reqPerMin' => round(($count / $bucketSec) * 60)
    ];
}

// Top devices (top 10)
arsort($byDevice);
$topDevices = [];
$i = 0;
foreach ($byDevice as $key => $count) {
    if ($i++ >= 10) break;
    $topDevices[] = [
        'key' => $key,
        'count' => $count,
        'reqPerMin' => round(($count / $windowSec) * 60)
    ];
}

// Trier byEndpoint et byStatus par compteur décroissant
arsort($byEndpoint);
ksort($byStatus);

echo json_encode([
    'success' => true,
    'windowSec' => $windowSec,
    'bucketSec' => $bucketSec,
    'now' => $now,
    'totalRequests' => $totalRequests,
    'totalReqPerMin' => round(($totalRequests / $windowSec) * 60),
    'slowRequests' => $slowRequests, // requêtes > 1 s (suspect)
    'maxDuration' => $maxDuration,   // pire durée observée sur la fenêtre
    'perBucket' => $bucketArr,
    'byEndpoint' => $byEndpoint,
    'byStatus' => $byStatus,
    'topDevices' => $topDevices
]);
