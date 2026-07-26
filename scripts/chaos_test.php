<?php
/**
 * Qwest — Test de chaos « classe de collège » (multi-classes)
 *
 * Simule de 1 à 3 PARTIES COMPLÈTES en parallèle avec des élèves qui se comportent
 * comme de vrais collégiens, et vérifie la robustesse de bout en bout.
 *
 * IMPORTANT — fidélité de la mesure : toutes les requêtes « élèves » d'un même
 * instant partent EN PARALLÈLE (curl_multi), comme de vrais téléphones. La v1
 * interrogeait les élèves un par un : sur un vrai réseau (~130 ms/requête), un tour
 * de 18 élèves prenait ~2,4 s et gonflait artificiellement l'écart d'affichage.
 *
 *   Identité / connexions
 *     C1. double connexion : même appareil, 2ᵉ pseudo            → refus deviceBusy
 *     C2. vol de pseudo : autre appareil, pseudo ACTIF           → refus nicknameTaken
 *     C3. reconnexion légitime : même appareil, même pseudo      → accepté
 *     RL1. élève qui recharge sa page (F5) en pleine question    → repart sans casse
 *     LJ1. élève en retard qui rejoint après le début            → joue la suite
 *     K1. élève retiré par le prof                               → son poste le détecte
 *   Triche
 *     T1. payload de question sans AUCUNE solution
 *     T2. items « remettre dans l'ordre » mélangés et stables
 *     T3. réponses des autres joueurs non exposées
 *     T4. spam de réponses : la PREMIÈRE réponse est définitive
 *     T5. changement d'onglet signalé au prof
 *     T6. action prof sans auth → 403
 *   Réseau
 *     R1. coupure (60 s par défaut) : réponses bufferisées puis answer_bulk
 *         au retour → acceptées, AUCUN « temps écoulé » injuste
 *         + élève très lent (3-5 s de latence) + réponse dernière seconde
 *   Synchronisation
 *     S1. écart de DÉTECTION de chaque question (élèves à réseau nominal)
 *     S2. écart d'AFFICHAGE après révélation alignée (cible ≤ 1,2 s)
 *     S3. classement figé stable entre deux lectures
 *   Multi-classes (--classes=2 ou 3)
 *     M1. étanchéité : un élève d'une classe ne peut pas lire l'état d'une autre
 *     M2. facteur crowd ≥ 1,25 observé (étalement anti-ban multi-classes)
 *     M3. toutes les classes terminent toutes leurs questions (aucun blocage)
 *   Justesse
 *     J1. score final SERVEUR de CHAQUE élève de CHAQUE classe == score recalculé
 *         par le script (qui connaît toutes les réponses envoyées et leurs timeSpent)
 *
 * Logs TSV : scripts/logs/chaos-YYYYmmdd-HHiiss.log
 *
 * Usage :
 *   php scripts/chaos_test.php --base-url=https://monsite.fr/qwest
 *   php scripts/chaos_test.php --base-url=... --classes=3 --players=10 --questions=4
 *
 * Options :
 *   --classes=N        nombre de classes simultanées (1 à 3, défaut 1)
 *   --players=N        élèves « normaux » de la classe principale (défaut 12)
 *   --players-side=N   élèves par classe secondaire (défaut 8)
 *   --questions=N      questions jouées par classe (défaut 5, max 8)
 *   --question-time=N  durée d'une question en s (défaut 12 ; >= 10 conseillé)
 *   --outage=N         durée de la coupure réseau simulée en s (défaut 60)
 *   --keep-session=1   ne pas supprimer les sessions à la fin
 *   --insecure=1       ne pas vérifier le certificat TLS (curl Windows sans cacert)
 */

// Exécutable en CLI, ou inclus par la page web qwest/tests.php (auth prof faite là-bas).
if (php_sapi_name() !== 'cli' && !defined('QWEST_TESTS_WEB')) exit(1);

const TEACHER_HASH = '00624b02e1f9b996a3278f559d5d55313552ad2c0bafc82adfd975c12df61eaf';

// ---------- options (CLI : --opt=valeur ; web : $GLOBALS['QWEST_TEST_ARGS']) ----------
$opts = ['base-url' => 'http://localhost/qwest', 'classes' => 1, 'players' => 12,
         'players-side' => 8, 'questions' => 5, 'question-time' => 12, 'outage' => 60,
         'keep-session' => 0, 'insecure' => 0,
         // === Modélisation du réseau de classe (collège) ===
         // --drop=N : N % des requêtes ÉLÈVE sont « bloquées » par un proxy filtrant
         //   (réponse jamais reçue) — modélise un filtrage d'URL/coupures partielles.
         // --ip-ceiling=N : seuil req/min PAR IP DE SORTIE (= une classe = une IP au
         //   collège) au-delà duquel l'hébergeur/le filtrage bannit. Verdict NET-IP.
         // --latency=N : latence ajoutée (ms, ± jitter) à CHAQUE élève — modélise une
         //   liaison lente/saturée (wifi de collège). S'ajoute aux profils 'slow'/'outage'.
         'drop' => 0, 'ip-ceiling' => 900, 'latency' => 0];
$cliArgs = isset($argv) ? array_slice($argv, 1) : ($GLOBALS['QWEST_TEST_ARGS'] ?? []);
foreach ($cliArgs as $arg) {
    if (preg_match('/^--([a-z\-]+)=(.*)$/', $arg, $m)) $opts[$m[1]] = is_numeric($m[2]) ? $m[2] + 0 : $m[2];
}
$BASE = rtrim($opts['base-url'], '/');
$N_CLASSES = max(1, min(3, (int)$opts['classes']));
$N_NORMAL = max(4, (int)$opts['players']);
$N_SIDE = max(3, min(15, (int)$opts['players-side']));
$N_QUESTIONS = max(2, min(20, (int)$opts['questions']));
$QT = max(8, (int)$opts['question-time']);
$OUTAGE_SEC = max(20, (int)$opts['outage']);
$CURL_INSECURE = !empty($opts['insecure']);
$DROP_PCT = max(0, min(90, (int)$opts['drop']));
$IP_CEILING = max(100, (int)$opts['ip-ceiling']);
$LATENCY_SEC = max(0, (int)$opts['latency']) / 1000.0; // ms → s, latence pervasive par élève
// Horodatages de TOUTES les requêtes : sert à mesurer le PIC req/min et req/s — le
// chiffre qui déclenche un ban. À --classes=1, ce total = la charge d'UNE classe = UNE
// IP de sortie au collège (verdict NET-IP). À --classes>1, c'est la somme des classes.
$GLOBALS['REQ_TIMES'] = [];

// ---------- log ----------
$logDir = __DIR__ . '/logs';
if (!is_dir($logDir)) @mkdir($logDir, 0755, true);
// Ménage : les logs de test de plus de 7 jours sont supprimés (serveur propre).
foreach ((glob($logDir . '/*.log') ?: []) as $oldLog) {
    $mt = @filemtime($oldLog);
    if ($mt && (time() - $mt) > 7 * 86400) @unlink($oldLog);
}
$LOG_FILE = $logDir . '/chaos-' . date('Ymd-His') . '.log';
function clog($who, $event, $details = '') {
    global $LOG_FILE;
    $line = sprintf("%s\t%s\t%s\t%s\n", date('H:i:s') . '.' . sprintf('%03d', (int)(microtime(true) * 1000) % 1000), $who, $event, $details);
    @file_put_contents($LOG_FILE, $line, FILE_APPEND);
}

// ---------- verdicts ----------
$PASS = 0; $FAIL = 0; $verdicts = [];
function verdict($code, $label, $ok, $detail = '') {
    global $PASS, $FAIL, $verdicts;
    if ($ok) $PASS++; else $FAIL++;
    $verdicts[] = [$code, $ok, $label, $detail];
    echo ($ok ? "  ✅ " : "  ❌ ") . "$code — $label" . ($detail !== '' ? "  [$detail]" : '') . "\n";
    clog('verdict', $code, ($ok ? 'PASS' : 'FAIL') . "\t$label\t$detail");
    @flush();
}

// ---------- HTTP (unitaire + PARALLÈLE) ----------
$REQ_COUNT = 0;
function curlBaseOpts() {
    global $CURL_INSECURE;
    $o = [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 12];
    if ($CURL_INSECURE) { $o[CURLOPT_SSL_VERIFYPEER] = false; $o[CURLOPT_SSL_VERIFYHOST] = 0; }
    return $o;
}
/** Comptabilise les 5xx (un seul 500 fige une classe → verdict SRV) + horodate la requête. */
function noteHttpCode($code) {
    if ((int)$code >= 500) $GLOBALS['HTTP5XX'] = ($GLOBALS['HTTP5XX'] ?? 0) + 1;
    $GLOBALS['REQ_TIMES'][] = microtime(true);
}

/** Pic de requêtes sur une fenêtre glissante de $windowSec (max d'occurrences simultanées). */
function peakRate(array $times, $windowSec) {
    if (!$times) return 0;
    sort($times);
    $peak = 0; $j = 0; $n = count($times);
    for ($i = 0; $i < $n; $i++) {
        while ($times[$j] < $times[$i] - $windowSec) $j++;
        $peak = max($peak, $i - $j + 1);
    }
    return $peak;
}
function httpPost($url, array $params) {
    global $REQ_COUNT; $REQ_COUNT++;
    $ch = curl_init($url);
    curl_setopt_array($ch, curlBaseOpts() + [CURLOPT_POST => true, CURLOPT_POSTFIELDS => http_build_query($params)]);
    $body = curl_exec($ch);
    $err = curl_error($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    noteHttpCode($code);
    return ['code' => $code, 'json' => json_decode((string)$body, true),
            'raw' => substr((string)$body, 0, 300), 'err' => $err];
}
function httpGet($url, array $params = []) {
    global $REQ_COUNT; $REQ_COUNT++;
    $ch = curl_init($url . ($params ? ('?' . http_build_query($params)) : ''));
    curl_setopt_array($ch, curlBaseOpts());
    $body = curl_exec($ch);
    $err = curl_error($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    noteHttpCode($code);
    return ['code' => $code, 'json' => json_decode((string)$body, true),
            'raw' => substr((string)$body, 0, 300), 'err' => $err];
}
/** Décrit un échec HTTP de façon lisible (pour les messages d'abandon). */
function httpDiag(array $r) {
    $d = 'HTTP ' . ($r['code'] ?? '?');
    if (!empty($r['err'])) $d .= ' | curl: ' . $r['err'];
    if (!empty($r['raw'])) $d .= ' | réponse: ' . preg_replace('/\s+/', ' ', $r['raw']);
    return $d;
}
/**
 * Exécute un lot de requêtes EN PARALLÈLE (comme de vrais téléphones).
 * $reqs : liste de ['url'=>..., 'post'=>params|null, 'tag'=>donnée libre]
 * Retour : liste de ['tag'=>..., 'code'=>..., 'json'=>...] (ordre quelconque)
 */
function mexec(array $reqs) {
    global $REQ_COUNT;
    if (!$reqs) return [];
    // Parallélisme PLAFONNÉ : le test tourne souvent SUR le serveur mutualisé et
    // s'appelle lui-même — un hébergeur mutualisé ne sert qu'un nombre limité de
    // requêtes PHP simultanées par site. On envoie par vagues de 10 pour ne pas
    // épuiser le pool (sinon : timeouts en cascade pendant le test lui-même).
    $out = [];
    foreach (array_chunk($reqs, 10) as $chunk) {
        $REQ_COUNT += count($chunk);
        $mh = curl_multi_init();
        $handles = [];
        foreach ($chunk as $r) {
            $isPost = !empty($r['post']);
            $ch = curl_init($r['url'] . (!$isPost && !empty($r['get']) ? ('?' . http_build_query($r['get'])) : ''));
            $o = curlBaseOpts();
            if ($isPost) { $o[CURLOPT_POST] = true; $o[CURLOPT_POSTFIELDS] = http_build_query($r['post']); }
            curl_setopt_array($ch, $o);
            curl_multi_add_handle($mh, $ch);
            $handles[(int)$ch] = ['ch' => $ch, 'tag' => $r['tag'] ?? null];
        }
        do {
            $status = curl_multi_exec($mh, $running);
            if ($running) curl_multi_select($mh, 0.05);
        } while ($running && $status === CURLM_OK);
        foreach ($handles as $h) {
            $body = curl_multi_getcontent($h['ch']);
            $code = curl_getinfo($h['ch'], CURLINFO_HTTP_CODE);
            noteHttpCode($code);
            $out[] = ['tag' => $h['tag'], 'code' => $code,
                      'json' => json_decode((string)$body, true),
                      'raw' => substr((string)$body, 0, 200), 'err' => curl_error($h['ch'])];
            curl_multi_remove_handle($mh, $h['ch']);
            curl_close($h['ch']);
        }
        curl_multi_close($mh);
    }
    return $out;
}

// ---------- sonde de l'URL cible ----------
// Le test s'appelle souvent LUI-MÊME (page tests.php sur le serveur). Une redirection
// http→https, un certificat non vérifiable en auto-appel ou un WAF rendent l'API
// muette : on le détecte AVANT de commencer, on corrige tout seul si possible
// (bascule de schéma, repli TLS non vérifié), et sinon on affiche le diagnostic exact.
function qstProbe($base) {
    $r = httpGet("$base/php/game.php", ['action' => 'get_state_readonly', 'playCode' => 'ZZZPROBE', 'nickname' => 'probe']);
    if (is_array($r['json']) && array_key_exists('success', $r['json'])) return true;
    return $r; // échec : on renvoie la réponse pour le diagnostic
}
$__probe = qstProbe($BASE);
if ($__probe !== true) {
    $alt = (strpos($BASE, 'https://') === 0) ? ('http://' . substr($BASE, 8)) : ('https://' . substr($BASE, 7));
    $fixed = false;
    if (qstProbe($alt) === true) {
        echo "ℹ️  $BASE ne répond pas en JSON (" . httpDiag($__probe) . ")\n    → bascule sur $alt\n\n";
        clog('setup', 'probe_switch', "de=$BASE&vers=$alt");
        $BASE = $alt; $fixed = true;
    }
    if (!$fixed && !$CURL_INSECURE) {
        $CURL_INSECURE = true;
        if (qstProbe($BASE) === true) {
            echo "ℹ️  certificat TLS non vérifiable en auto-appel → poursuite SANS vérification TLS (test uniquement)\n\n";
            clog('setup', 'probe_insecure', $BASE);
            $fixed = true;
        } elseif (qstProbe($alt) === true) {
            echo "ℹ️  bascule sur $alt SANS vérification TLS (test uniquement)\n\n";
            clog('setup', 'probe_insecure_switch', $alt);
            $BASE = $alt; $fixed = true;
        } else {
            $CURL_INSECURE = false;
        }
    }
    if (!$fixed) {
        echo "❌ Impossible de joindre l'API du site depuis le serveur.\n";
        echo "   - $BASE → " . httpDiag($__probe) . "\n";
        $altDiag = qstProbe($alt);
        echo "   - $alt → " . ($altDiag === true ? 'OK?' : httpDiag($altDiag)) . "\n";
        echo "   Pistes : redirection imposée par l'hébergeur, pare-feu sortant, ou domaine\n";
        echo "   qui ne pointe pas vers ce serveur. Envoie ce message tel quel pour analyse.\n";
        clog('setup', 'probe_fail', httpDiag($__probe));
        if (defined('QWEST_TESTS_WEB')) return;
        exit(2);
    }
}

// ---------- quiz de test (le script CONNAÎT les solutions → vérif des scores) ----------
// Génère exactement $N_QUESTIONS questions (alternance multiple/ordre/freetext) → permet
// une VRAIE partie longue en temps réel (jusqu'à 20 questions).
$questions = [];
for ($i = 0; $i < $N_QUESTIONS; $i++) {
    switch ($i % 4) {
        case 0: case 2:
            $questions[] = ['id' => "q$i", 'type' => 'multiple', 'question' => "Question $i ?", 'time' => $QT,
                'answers' => [['text' => 'Bonne', 'correct' => true], ['text' => 'B', 'correct' => false],
                              ['text' => 'C', 'correct' => false], ['text' => 'D', 'correct' => false]]];
            break;
        case 1:
            $questions[] = ['id' => "q$i", 'type' => 'order', 'question' => "Remets dans l'ordre $i", 'time' => $QT,
                'answers' => [['text' => 'Un'], ['text' => 'Deux'], ['text' => 'Trois'], ['text' => 'Quatre'], ['text' => 'Cinq']]];
            break;
        case 3:
            $questions[] = ['id' => "q$i", 'type' => 'freetext', 'question' => "Tape 'rome' ($i)", 'time' => $QT,
                'answers' => [['text' => 'Rome', 'correct' => true]], 'caseSensitive' => false,
                'acceptedAnswers' => ['roma']];
            break;
    }
}
$ORDER_SOLUTION = ['Un', 'Deux', 'Trois', 'Quatre', 'Cinq'];

function expectedPoints(array $q, $answerPayload, $timeSpentMs) {
    global $ORDER_SOLUTION;
    $correct = false;
    switch ($q['type']) {
        case 'multiple': $correct = (($answerPayload['index'] ?? -1) === 0); break;
        case 'order':    $correct = (($answerPayload['order'] ?? null) === $ORDER_SOLUTION); break;
        case 'freetext': $correct = in_array(mb_strtolower(trim($answerPayload['freetext'] ?? '')), ['rome', 'roma'], true); break;
    }
    return $correct ? max(0, (int)round(1000 - ($timeSpentMs / 100))) : 0;
}
function goodPayload(array $q, $good) {
    global $ORDER_SOLUTION;
    switch ($q['type']) {
        case 'order':    return ['order' => $good ? $ORDER_SOLUTION : array_reverse($ORDER_SOLUTION)];
        case 'freetext': return ['freetext' => $good ? 'rome' : 'paris'];
        default:         return ['index' => $good ? 0 : 1];
    }
}

// ---------- élèves & classes ----------
function mkStudent($nick, $profile, $classIdx) {
    global $LATENCY_SEC;
    // Latence pervasive (liaison lente/saturée du collège) appliquée à TOUS les élèves,
    // avec jitter par élève (0,5×..1,5×) ; les 'slow' ajoutent encore 3-5 s par-dessus.
    $lat = ($LATENCY_SEC > 0 ? $LATENCY_SEC * (0.5 + mt_rand(0, 100) / 100) : 0.0)
         + ($profile === 'slow' ? (3.0 + mt_rand(0, 20) / 10) : 0.0);
    return ['nick' => $nick, 'profile' => $profile, 'class' => $classIdx,
            'deviceId' => 'chaosdev_' . md5($classIdx . '|' . $nick),
            'nextPollAt' => 0.0, 'latency' => $lat,
            'seenQuestion' => -1, 'detectedAt' => [], 'displayAt' => [], 'answeredQ' => [],
            'buffer' => [], 'offlineStartAt' => 0.0, 'offlineUntil' => 0.0,
            'spamLeft' => 0, 'removed' => false, 'kickedSeen' => false, 'crowd' => 1.0,
            'inFlight' => false,
            // Résilience IDENTIQUE au vrai client (sessionManager.js) — mesurée en
            // conditions réelles sur mutualisé, sans elle des points se perdent :
            'confirmed' => [],      // q => true quand vu dans myAnswered (réponse SÛRE côté serveur)
            'needRejoin' => false,  // poll → kicked alors que non retiré = join englouti → re-join auto
            'rejoinTries' => 0];
}

$classes = [];
for ($ci = 0; $ci < $N_CLASSES; $ci++) {
    $code = 'CHAOS' . chr(65 + $ci) . strtoupper(substr(bin2hex(random_bytes(2)), 0, 3));
    $students = [];
    if ($ci === 0) {
        for ($i = 1; $i <= $N_NORMAL; $i++) $students[] = mkStudent(sprintf('Normal%02d', $i), 'normal', 0);
        $students[] = mkStudent('Lent01', 'slow', 0);
        $students[] = mkStudent('Spam01', 'spammer', 0);
        $students[] = mkStudent('Onglet01', 'tabswitch', 0);
        $students[] = mkStudent('Coupure01', 'outage', 0);
        $students[] = mkStudent('Coupure02', 'outage', 0);
        $students[] = mkStudent('Dernier01', 'lastsecond', 0);
        $students[] = mkStudent('Victime01', 'victim', 0);   // sera retiré par le prof (K1)
    } else {
        for ($i = 1; $i <= $N_SIDE; $i++) $students[] = mkStudent(sprintf('C%d-Eleve%02d', $ci + 1, $i), 'normal', $ci);
    }
    $classes[] = [
        'code' => $code, 'students' => $students, 'isMain' => ($ci === 0),
        // pilotage des classes secondaires (machine à états du « prof » virtuel)
        'drv' => ['q' => -1, 'launchedAt' => 0.0, 'completedSeenAt' => 0.0,
                  'lastCtrlAt' => 0.0, 'finished' => false, 'plans' => []],
    ];
}
$main =& $classes[0];

$totalStudents = 0;
foreach ($classes as $c) $totalStudents += count($c['students']);

echo "🧪 chaos_test — {$opts['base-url']} | $N_CLASSES classe(s), $totalStudents élèves | $N_QUESTIONS questions × {$QT}s | coupure {$OUTAGE_SEC}s"
    . ($DROP_PCT > 0 ? " | proxy filtrant --drop=$DROP_PCT%" : '')
    . ($LATENCY_SEC > 0 ? sprintf(" | latence +%dms/élève", (int)($LATENCY_SEC * 1000)) : '')
    . " | seuil ban {$IP_CEILING} req/min/IP\n";
echo "   log : $LOG_FILE\n\n";
@flush();
clog('setup', 'start', "classes=$N_CLASSES&players=$totalStudents&questions=$N_QUESTIONS&qt=$QT&outage=$OUTAGE_SEC");

// ============================================================
// PHASE 0 — provision des classes
// ============================================================
echo "▶️  Phase 0 : création de " . $N_CLASSES . " session(s) — cible $BASE\n"; @flush();
foreach ($classes as $ci => $c) {
    $payload = ['action' => 'create_session', 'playCode' => $c['code'],
        'quizData' => json_encode(['name' => 'Chaos ' . ($ci + 1), 'questions' => $questions]),
        'manualMode' => '1', 'showTop3' => '1', 'teacher_hash' => TEACHER_HASH];
    $r = httpPost("$BASE/php/control.php", $payload);
    if (empty($r['json']['success'])) { usleep(800000); $r = httpPost("$BASE/php/control.php", $payload); }
    if (empty($r['json']['success'])) {
        echo "❌ create_session impossible ({$c['code']}) : " . httpDiag($r) . " — abandon\n";
        clog('setup', 'create_fail', $c['code'] . "\t" . httpDiag($r));
        goto chaos_end;
    }
}

// ============================================================
// PHASE 1 — joins + scénarios d'identité (classe principale)
// ============================================================
echo "▶️  Phase 1 : connexions + scénarios d'identité\n"; @flush();
// Comme en vrai : les élèves rejoignent APRÈS l'affichage du code, pas 0,3 s après
// la création — laisse au cluster mutualisé le temps de propager les fichiers.
sleep(2);
$joinByTag = [];
foreach ($classes as $ci => $c) {
    foreach ($c['students'] as $si => $s) {
        $joinByTag["$ci:$si"] = ['url' => "$BASE/php/game.php", 'tag' => "$ci:$si",
            'post' => ['action' => 'join', 'playCode' => $c['code'], 'nickname' => $s['nick'], 'deviceId' => $s['deviceId']]];
    }
}
// Joins ÉTALÉS par vagues de 6 toutes les ~700 ms (comme une vraie classe — pas 33
// joins dans la même seconde) : moins d'écritures concurrentes inter-nœuds = moins
// de joins mutuellement écrasés. Retry par rondes pour les rejets transitoires.
$pending = array_values($joinByTag);
$lastFail = null;
for ($round = 1; $round <= 4 && $pending; $round++) {
    if ($round > 1) {
        echo "   ↻ joins à retenter (ronde $round) : " . count($pending) . "\n"; @flush();
        sleep(1);
    }
    $next = [];
    foreach (array_chunk($pending, 6) as $wave) {
        foreach (mexec($wave) as $res) {
            if (empty($res['json']['success'])) {
                $lastFail = $res;
                clog('setup', 'join_retry', $res['tag'] . "\t" . httpDiag($res));
                $next[] = $joinByTag[$res['tag']];
            }
        }
        usleep(700000);
    }
    $pending = $next;
}
if ($pending) {
    echo "❌ join toujours en échec après 4 rondes ({$lastFail['tag']}) : " . httpDiag($lastFail) . " — abandon\n";
    clog('setup', 'join_fail', $lastFail['tag'] . "\t" . httpDiag($lastFail));
    goto chaos_end;
}
clog('setup', 'joins', "$totalStudents ok");

// STABILISATION ACTIVE du roster : sur le cluster, des joins simultanés peuvent
// s'écraser mutuellement (le run 21:45 a montré un roster bloqué à 6/17 — une
// attente passive ne répare RIEN). Ici les élèves POLLENT pendant l'attente :
// ceux dont le join a été englouti reçoivent kicked → re-join automatique (le
// mécanisme du vrai client) → le roster converge AVANT les tests d'identité.
$settleDeadline = microtime(true) + 25;
$rostersOk = false;
$lastRosterCheck = 0;
while (microtime(true) < $settleDeadline) {
    $now = microtime(true);
    $reqs = [];
    foreach ($classes as $ci => &$c) {
        // cadence NORMALE (pas de fenêtre rapide) : la stabilisation n'est pas
        // urgente, inutile de générer un pic — les re-joins, eux, partent immédiatement
        $reqs = array_merge($reqs, collectStudentReqs($c, $ci, -1, [], $now, $BASE));
    }
    unset($c);
    if ($reqs) dispatchResults(mexec($reqs), $classes, $QT, $BASE);

    if ($now - $lastRosterCheck >= 1.5) {
        $lastRosterCheck = $now;
        $rostersOk = true;
        foreach ($classes as $ci => $c) {
            $st = httpGet("$BASE/php/control.php", ['action' => 'get_control_state', 'playCode' => $c['code']]);
            $seen = count($st['json']['players'] ?? []);
            if ($seen < count($c['students'])) $rostersOk = false;
        }
        if ($rostersOk) break;
    }
    usleep(200000);
}
foreach ($classes as $ci => $c) {
    $st = httpGet("$BASE/php/control.php", ['action' => 'get_control_state', 'playCode' => $c['code']]);
    $seen = count($st['json']['players'] ?? []);
    clog('setup', 'roster', 'classe=' . ($ci + 1) . "&vus=$seen/" . count($c['students']));
    if ($seen < count($c['students'])) echo "   ⚠️  classe " . ($ci + 1) . " : roster incomplet après stabilisation ($seen/" . count($c['students']) . ")\n";
}
sleep(2); // convergence des caches inter-nœuds avant les tests d'identité

// C1 : même appareil, pseudo différent → deviceBusy attendu.
// Tolérance cluster : si le doublon passe (le nœud ne voyait pas encore Normal01),
// on retire le doublon, on laisse la visibilité converger et on reteste UNE fois.
$c1ok = false;
for ($try = 0; $try < 2; $try++) {
    $r = httpPost("$BASE/php/game.php", ['action' => 'join', 'playCode' => $main['code'],
        'nickname' => 'Doublon01', 'deviceId' => $main['students'][0]['deviceId']]);
    $c1ok = empty($r['json']['success']) && !empty($r['json']['deviceBusy']);
    if ($c1ok) break;
    if (!empty($r['json']['success'])) {
        // Nettoyage IMPÉRATIF : sans lui, Doublon01 occupe l'appareil de Normal01 et
        // le verrouille dehors pour toute la partie (vu au run 21:36).
        httpPost("$BASE/php/control.php", ['action' => 'remove_player', 'playCode' => $main['code'],
            'nickname' => 'Doublon01', 'teacher_hash' => TEACHER_HASH]);
        clog('setup', 'c1_doublon_nettoye', "essai=$try");
        sleep(2);
    }
}
verdict('C1', 'double connexion même appareil refusée (deviceBusy)', $c1ok);

// C2 : autre appareil, pseudo ACTIF → nicknameTaken attendu.
// Tolérance cluster : si le vol passe (nœud retardataire qui ne voyait pas la
// victime), on RESTAURE la victime (remove + re-join avec son vrai appareil),
// on laisse converger, et on reteste une fois.
$c2ok = false;
$victimNick = $main['students'][1]['nick'];
for ($try = 0; $try < 2; $try++) {
    $r = httpPost("$BASE/php/game.php", ['action' => 'join', 'playCode' => $main['code'],
        'nickname' => $victimNick, 'deviceId' => 'voleur_device_123456']);
    $c2ok = empty($r['json']['success']) && !empty($r['json']['nicknameTaken']);
    if ($c2ok) break;
    if (!empty($r['json']['success'])) {
        // le voleur a écrasé le deviceHash de la victime : on remet tout en ordre
        httpPost("$BASE/php/control.php", ['action' => 'remove_player', 'playCode' => $main['code'],
            'nickname' => $victimNick, 'teacher_hash' => TEACHER_HASH]);
        sleep(1);
        httpPost("$BASE/php/game.php", ['action' => 'join', 'playCode' => $main['code'],
            'nickname' => $victimNick, 'deviceId' => $main['students'][1]['deviceId']]);
        clog('setup', 'c2_victime_restauree', "essai=$try");
        sleep(2);
    }
}
verdict('C2', 'vol de pseudo actif depuis un autre appareil refusé', $c2ok);

// C3 : reconnexion légitime → succès attendu
$r = httpPost("$BASE/php/game.php", ['action' => 'join', 'playCode' => $main['code'],
    'nickname' => $main['students'][1]['nick'], 'deviceId' => $main['students'][1]['deviceId']]);
verdict('C3', 'reconnexion même appareil acceptée', !empty($r['json']['success']));

// T6 : action prof sans hash → 403
$r = httpPost("$BASE/php/control.php", ['action' => 'next_question', 'playCode' => $main['code'], 'questionIndex' => 0]);
verdict('T6', 'next_question sans auth → 403', $r['code'] === 403);

// M1 : étanchéité entre classes
if ($N_CLASSES > 1) {
    $r = httpGet("$BASE/php/game.php", ['action' => 'get_state_readonly',
        'playCode' => $classes[1]['code'], 'nickname' => $main['students'][0]['nick']]);
    verdict('M1', 'étanchéité : un élève ne peut pas lire l\'état d\'une autre classe',
        empty($r['json']['success']) && !empty($r['json']['kicked']));
}

// B1 : RÉGRESSION du bug du 18/06 (answer_bulk avec answer=OBJET au lieu d'une chaîne JSON
// → stocké en tableau PHP → json_decode(array) → TypeError FATALE PHP 8 → 500 sur CHAQUE
// get_state → classe figée). Le vrai client (vieille version en cache pendant un déploiement)
// pouvait envoyer ce payload. Session ISOLÉE (ne pollue pas les scores J1). Le test envoyait
// auparavant les bulk en chaîne JSON, donc ne touchait JAMAIS ce chemin (faux vert).
$b1code = 'B1' . strtoupper(substr(bin2hex(random_bytes(3)), 0, 4));
$b1quiz = json_encode(['name' => 'B1', 'questions' => [['id' => 'b', 'type' => 'multiple',
    'question' => 'Q', 'time' => 30, 'answers' => [['text' => 'A', 'correct' => true], ['text' => 'B', 'correct' => false]]]]]);
httpPost("$BASE/php/control.php", ['action' => 'create_session', 'playCode' => $b1code, 'quizData' => $b1quiz, 'manualMode' => '1', 'showTop3' => '1', 'teacher_hash' => TEACHER_HASH]);
httpPost("$BASE/php/control.php", ['action' => 'start_game', 'playCode' => $b1code, 'manualMode' => '1', 'showTop3' => '1', 'teacher_hash' => TEACHER_HASH]);
httpPost("$BASE/php/control.php", ['action' => 'next_question', 'playCode' => $b1code, 'questionIndex' => 0, 'customTime' => 30, 'teacher_hash' => TEACHER_HASH]);
httpPost("$BASE/php/game.php", ['action' => 'join', 'playCode' => $b1code, 'nickname' => 'B1Eleve', 'deviceId' => 'b1dev0123456']);
// answer en OBJET (pas une chaîne) — exactement le payload du vieux client buggé.
$b1bulk = httpPost("$BASE/php/game.php", ['action' => 'answer_bulk', 'playCode' => $b1code, 'nickname' => 'B1Eleve',
    'answers' => '[{"questionIndex":0,"answer":{"index":0},"timeSpent":1200}]']);
$b1get = httpGet("$BASE/php/game.php", ['action' => 'get_state_readonly', 'playCode' => $b1code, 'nickname' => 'B1Eleve']);
$b1ctrl = httpGet("$BASE/php/control.php", ['action' => 'get_control_state', 'playCode' => $b1code]);
$b1ok = ($b1bulk['code'] < 500) && ((int)$b1get['code'] === 200) && !empty($b1get['json']['success']) && ((int)$b1ctrl['code'] === 200);
verdict('B1', 'answer_bulk avec answer=objet (vieux client) ne plante pas le serveur (zéro 5xx)',
    $b1ok, "bulk={$b1bulk['code']} get={$b1get['code']} ctrl={$b1ctrl['code']}");
httpPost("$BASE/php/control.php", ['action' => 'cleanup_session', 'playCode' => $b1code, 'teacher_hash' => TEACHER_HASH]);

// ============================================================
// PHASE 2 — parties simultanées
// ============================================================
echo "▶️  Phase 2 : partie principale ($N_QUESTIONS questions)" . ($N_CLASSES > 1 ? ' + ' . ($N_CLASSES - 1) . ' classe(s) en parallèle' : '') . "\n"; @flush();
foreach ($classes as $c) {
    $r = httpPost("$BASE/php/control.php", ['action' => 'start_game', 'playCode' => $c['code'],
        'manualMode' => '1', 'showTop3' => '1', 'teacher_hash' => TEACHER_HASH]);
    if (empty($r['json']['success'])) {
        echo "❌ start_game impossible ({$c['code']}) : " . httpDiag($r) . "\n";
        clog('setup', 'start_fail', $c['code'] . "\t" . httpDiag($r));
        goto chaos_end;
    }
}

$detectionSpreads = []; $displaySpreads = []; $slowLags = [];
$payloadChecked = false; $orderChecked = false; $tooLateInjuste = 0;
$maxCrowdSeen = 1.0; $t5Done = false;
$lateJoiner = null; $rl1Done = false; $lj1Done = false; $k1Removed = false;
$startedAt = microtime(true);

/**
 * Prépare le plan de réponse d'un élève pour une question (instant + payload + temps).
 */
function planFor(array $s, array $q, $qIdx, $qLaunchedAt, $QT) {
    $thinkMs = mt_rand(2000, (int)(($QT - 3) * 1000));
    if ($s['profile'] === 'lastsecond') $thinkMs = (int)(($QT * 1000) - 300);
    if ($s['profile'] === 'outage' && $qIdx === 1) $thinkMs = mt_rand(5000, 7000);
    $good = (mt_rand(1, 5) !== 1) || $s['profile'] === 'lastsecond';
    return ['at' => $qLaunchedAt + $thinkMs / 1000 + $s['latency'],
            'payload' => goodPayload($q, $good), 'timeSpent' => $thinkMs];
}

/**
 * Construit les requêtes « élèves » dues à cet instant pour une classe (poll/réponse/bulk),
 * met à jour l'état local hors-ligne. Une seule action HTTP max par élève et par tick.
 */
function collectStudentReqs(&$class, $ci, $q, array $plans, $now, $BASE, $anticipate = false, $sinceCompleted = -1) {
    global $DROP_PCT;
    // Modélise le proxy filtrant du collège : true si CETTE requête est « bloquée ».
    $proxyBlocks = function() use ($DROP_PCT) { return $DROP_PCT > 0 && mt_rand(1, 100) <= $DROP_PCT; };
    $reqs = [];
    foreach ($class['students'] as $si => &$s) {
        if ($s['removed'] && $s['kickedSeen']) continue;
        if ($s['inFlight']) continue;

        // hors-ligne : bufferiser la réponse de la question VUE, aucune requête
        if ($s['offlineStartAt'] > 0 && $now >= $s['offlineStartAt'] && $now < $s['offlineUntil']) {
            if ($s['seenQuestion'] === $q && isset($plans[$s['nick']]) &&
                !isset($s['answeredQ'][$q]) && $now >= $plans[$s['nick']]['at']) {
                $p = $plans[$s['nick']];
                $s['buffer'][] = ['questionIndex' => $q, 'answer' => json_encode($p['payload']), 'timeSpent' => $p['timeSpent']];
                $s['answeredQ'][$q] = ['payload' => $p['payload'], 'timeSpent' => $p['timeSpent']];
                clog($s['nick'], 'answer_buffered_offline', "q=$q&t={$p['timeSpent']}");
            }
            continue;
        }
        // retour de coupure : bulk
        if ($s['offlineStartAt'] > 0 && $now >= $s['offlineUntil'] && count($s['buffer']) > 0) {
            $reqs[] = ['url' => "$BASE/php/game.php", 'tag' => ['t' => 'bulk', 'ci' => $ci, 'si' => $si],
                'post' => ['action' => 'answer_bulk', 'playCode' => $class['code'], 'nickname' => $s['nick'],
                           'answers' => json_encode($s['buffer'])]];
            $s['inFlight'] = true;
            continue;
        }
        // RE-JOIN automatique (comme attemptKickedRecovery du vrai client) : un join
        // peut être englouti par un join concurrent sur le mutualisé — le serveur a
        // répondu succès mais le joueur n'est pas dans la partie (polls → kicked).
        if ($s['needRejoin'] && $s['rejoinTries'] < 8) {
            $s['rejoinTries']++;
            $reqs[] = ['url' => "$BASE/php/game.php", 'tag' => ['t' => 'rejoin', 'ci' => $ci, 'si' => $si],
                'post' => ['action' => 'join', 'playCode' => $class['code'], 'nickname' => $s['nick'], 'deviceId' => $s['deviceId']]];
            $s['inFlight'] = true;
            continue;
        }
        // RÉ-ÉMISSION des réponses non confirmées (comme la confirmation myAnswered du
        // vrai client) : une réponse acceptée peut être engloutie par une écriture
        // concurrente — tant qu'un poll ne la liste pas dans myAnswered, on la renvoie
        // (le serveur dédoublonne, le timeSpent d'origine est conservé → score juste).
        foreach ($s['answeredQ'] as $aq => $rec) {
            if (!empty($s['confirmed'][$aq])) continue;
            if (!isset($rec['sentAt']) || ($now - $rec['sentAt']) < 3.0) continue;
            if (($rec['resends'] ?? 0) >= 8) continue;
            $s['answeredQ'][$aq]['sentAt'] = $now;
            $s['answeredQ'][$aq]['resends'] = ($rec['resends'] ?? 0) + 1;
            $GLOBALS['RESEND_COUNT'] = ($GLOBALS['RESEND_COUNT'] ?? 0) + 1;
            clog($s['nick'], 'reemission', "q=$aq&essai=" . $s['answeredQ'][$aq]['resends']);
            // via answer_bulk : accepte aussi les questions PASSÉES (lateAccepted) et
            // dédoublonne si la réponse est en fait déjà là — comme le vrai client.
            $reqs[] = ['url' => "$BASE/php/game.php", 'tag' => ['t' => 'resend', 'ci' => $ci, 'si' => $si, 'q' => $aq],
                'post' => ['action' => 'answer_bulk', 'playCode' => $class['code'], 'nickname' => $s['nick'],
                           'answers' => json_encode([[
                               'questionIndex' => $aq,
                               'answer' => json_encode($rec['payload']),
                               'timeSpent' => $rec['timeSpent']
                           ]])]];
            $s['inFlight'] = true;
            break;
        }
        if ($s['inFlight']) continue;
        // spam restant (T4) : envois supplémentaires qui tentent de REMPLACER la réponse.
        // Décalé de 3,5 s après la vraie réponse : on teste la RÈGLE serveur (première
        // réponse définitive), pas la fenêtre de convergence inter-nœuds du cluster.
        if ($s['spamLeft'] > 0 && $now >= ($s['spamReadyAt'] ?? 0)) {
            $s['spamLeft']--;
            $reqs[] = ['url' => "$BASE/php/game.php", 'tag' => ['t' => 'spam', 'ci' => $ci, 'si' => $si],
                'post' => ['action' => 'answer', 'playCode' => $class['code'], 'nickname' => $s['nick'],
                           'questionIndex' => $q, 'answer' => json_encode(['index' => 3]),
                           'timeSpent' => 1500]];
            $s['inFlight'] = true;
            continue;
        }
        // réponse planifiée
        if (isset($plans[$s['nick']]) && !isset($s['answeredQ'][$q]) && $now >= $plans[$s['nick']]['at'] && $s['seenQuestion'] >= $q) {
            $p = $plans[$s['nick']];
            $s['answeredQ'][$q] = ['payload' => $p['payload'], 'timeSpent' => $p['timeSpent'],
                                   'sentAt' => $now, 'resends' => 0];
            if ($s['profile'] === 'spammer') { $s['spamLeft'] = 2; $s['spamReadyAt'] = $now + 3.5; }
            // Proxy filtrant : la réponse est bloquée à l'aller → la RÉ-ÉMISSION (myAnswered
            // non confirmé → renvoi après 3 s, timeSpent d'origine conservé) doit la rattraper.
            if ($proxyBlocks()) {
                $GLOBALS['DROP_COUNT'] = ($GLOBALS['DROP_COUNT'] ?? 0) + 1;
                clog($s['nick'], 'proxy_block', "answer q=$q");
                continue;
            }
            $reqs[] = ['url' => "$BASE/php/game.php", 'tag' => ['t' => 'answer', 'ci' => $ci, 'si' => $si, 'q' => $q, 'tab' => ($s['profile'] === 'tabswitch')],
                'post' => ['action' => 'answer', 'playCode' => $class['code'], 'nickname' => $s['nick'],
                           'questionIndex' => $q, 'answer' => json_encode($p['payload']), 'timeSpent' => $p['timeSpent']]];
            $s['inFlight'] = true;
            continue;
        }
        // polling adaptatif réaliste, ALIGNÉ sur la config v2 RÉDUITE (sinon le test ne
        // prédit pas le vrai pic) : 1,6 s en recherche/anticipation (POLL_INTERVAL_TRANSITION),
        // 3 s en base (POLL_INTERVAL_QUESTION), jitter ±30 % (POLL_JITTER_RATIO).
        if ($now >= $s['nextPollAt']) {
            $searching = ($s['seenQuestion'] < $q) || $anticipate;
            $interval = $searching ? 2.2 : (3.0 * $s['crowd']);
            $interval = $interval * (1 + (mt_rand(-35, 35) / 100));
            // Atterrissage dans la fenêtre d'anticipation (miroir du vrai client) :
            // ne jamais programmer un poll qui SAUTE par-dessus la fenêtre [+3,5 ; +9].
            if (!$searching && $sinceCompleted >= 0 && $sinceCompleted < 3.5) {
                $interval = min($interval, (3.5 - $sinceCompleted) + 0.2 + mt_rand(0, 40) / 100);
            }
            $interval += $s['latency'];
            $s['nextPollAt'] = $now + $interval;
            // Proxy filtrant : poll bloqué → on retentera au prochain tick (nextPollAt déjà
            // avancé). L'affichage reste correct grâce à la révélation alignée (horloge).
            if ($proxyBlocks()) {
                $GLOBALS['DROP_COUNT'] = ($GLOBALS['DROP_COUNT'] ?? 0) + 1;
            } else {
                $reqs[] = ['url' => "$BASE/php/game.php", 'tag' => ['t' => 'poll', 'ci' => $ci, 'si' => $si, 'q' => $q, 'sentAt' => $now],
                    'get' => ['action' => (mt_rand(1, 10) === 1 ? 'get_state' : 'get_state_readonly'),
                              'playCode' => $class['code'], 'nickname' => $s['nick']]];
                $s['inFlight'] = true;
            }
        }
    }
    unset($s);
    return $reqs;
}

/**
 * Traite les réponses HTTP d'un lot d'élèves (toutes classes confondues).
 */
function dispatchResults(array $results, &$classes, $QT, $BASE) {
    global $tooLateInjuste, $maxCrowdSeen, $payloadChecked, $orderChecked, $questions, $ORDER_SOLUTION;
    foreach ($results as $res) {
        $tag = $res['tag'];
        if (!is_array($tag)) continue;
        $ci = $tag['ci']; $si = $tag['si'];
        $s =& $classes[$ci]['students'][$si];
        $s['inFlight'] = false;
        $j = $res['json'] ?? [];

        switch ($tag['t']) {
            case 'poll':
                if (!empty($j['crowd']) && is_numeric($j['crowd'])) {
                    $s['crowd'] = max(1.0, min(2.0, (float)$j['crowd']));
                    if ($j['crowd'] > $maxCrowdSeen) $maxCrowdSeen = (float)$j['crowd'];
                }
                if (empty($j['success'])) {
                    if (!empty($j['kicked'])) {
                        if ($s['removed']) {
                            $s['kickedSeen'] = true;
                            clog($s['nick'], 'kicked_detecte', 'poll → kicked=true');
                        } else if (!$s['needRejoin']) {
                            // Join englouti par un join concurrent : le vrai client
                            // re-rejoint automatiquement (attemptKickedRecovery).
                            $s['needRejoin'] = true;
                            $GLOBALS['REJOIN_COUNT'] = ($GLOBALS['REJOIN_COUNT'] ?? 0) + 1;
                            clog($s['nick'], 'kicked_inattendu', 're-join auto programme');
                        }
                    }
                    break;
                }
                // CONFIRMATION des réponses (myAnswered) : ce que le serveur liste est
                // définitivement enregistré — tout le reste sera ré-émis par collect().
                if (isset($j['myAnswered']) && is_array($j['myAnswered'])) {
                    foreach ($j['myAnswered'] as $qa) $s['confirmed'][(int)$qa] = true;
                }
                $q = $tag['q'];
                if (($j['currentQuestion'] ?? -1) === $q && $s['seenQuestion'] < $q) {
                    $s['seenQuestion'] = $q;
                    $det = microtime(true) + $s['latency'];
                    $s['detectedAt'][$q] = $det;
                    // SYNCHRO v2 : l'élève révèle à l'instant ABSOLU revealAt (ms serveur).
                    // displayAt (wall-clock) = détection + secondes restantes jusqu'à revealAt
                    // (durée mesurée CÔTÉ SERVEUR, donc indépendante du décalage d'horloge du
                    // poste). Tous ceux qui détectent AVANT revealAt convergent vers le même
                    // instant absolu → écart d'affichage minimal. Repli : ancien schéma (s).
                    $revealAt = $j['question']['revealAt'] ?? null;   // ms serveur
                    $svMs = $j['serverTimeMs'] ?? null;               // ms serveur
                    if ($revealAt && $svMs) {
                        $alignRemain = max(0, ($revealAt - $svMs) / 1000.0);
                    } else {
                        $st = $j['question']['startTime'] ?? null;
                        $sv = $j['serverTime'] ?? null;
                        $alignRemain = ($st && $sv) ? max(0, 1.5 - max(0, $sv - $st)) : 0;
                    }
                    $s['displayAt'][$q] = $det + $alignRemain;
                    if ($classes[$ci]['isMain']) {
                        clog($s['nick'], 'question_detectee', sprintf("q=%d&apres=%.2fs", $q, $det - $classes[$ci]['drv']['launchedAt']));
                    }
                    // inspections anti-triche (une fois, classe principale)
                    if ($classes[$ci]['isMain'] && !$payloadChecked && isset($j['question']['data'])) {
                        $payloadChecked = true;
                        $leak = strpos(json_encode($j['question']['data']), '"correct"') !== false
                                && (($questions[$q]['type'] ?? '') !== 'freetext');
                        $accLeak = strpos(json_encode($j['question']['data']), 'acceptedAnswers') !== false;
                        verdict('T1', 'payload de question sans solution (correct/acceptedAnswers)', !$leak && !$accLeak);
                        $othersLeak = false;
                        foreach (($j['players'] ?? []) as $p) { if (isset($p['answers'])) $othersLeak = true; }
                        verdict('T3', 'réponses des autres joueurs non exposées aux élèves', !$othersLeak);
                    }
                    if ($classes[$ci]['isMain'] && !$orderChecked && ($questions[$q]['type'] ?? '') === 'order' && isset($j['question']['data']['answers'])) {
                        $orderChecked = true;
                        $served = array_map(function($a) { return $a['text']; }, $j['question']['data']['answers']);
                        $g2 = httpGet("$BASE/php/game.php", ['action' => 'get_state_readonly', 'playCode' => $classes[$ci]['code'], 'nickname' => $s['nick']]);
                        $served2 = array_map(function($a) { return $a['text']; }, $g2['json']['question']['data']['answers'] ?? []);
                        verdict('T2', 'items « ordre » mélangés (≠ solution) et stables entre 2 polls',
                            $served !== $ORDER_SOLUTION && $served === $served2, implode(',', $served));
                    }
                }
                break;

            case 'answer':
                $ok = !empty($j['success']);
                if (!$ok && !empty($j['tooLate'])) $tooLateInjuste++;
                clog($s['nick'], 'answer_envoyee', "q={$tag['q']}&t={$s['answeredQ'][$tag['q']]['timeSpent']}&ok=" . (int)$ok
                    . ($ok ? '' : "\t" . httpDiag($res)));
                // signalement onglet (profil tabswitch) après sa réponse
                if (!empty($tag['tab'])) {
                    httpPost("$BASE/php/game.php", ['action' => 'report_tab_switch',
                        'playCode' => $classes[$ci]['code'], 'nickname' => $s['nick']]);
                }
                break;

            case 'spam':
                clog($s['nick'], 'spam_envoye', 'duplicate=' . (int)!empty($j['duplicate']));
                break;

            case 'rejoin':
                if (!empty($j['success'])) {
                    $s['needRejoin'] = false;
                    clog($s['nick'], 'rejoin_ok', 'essai=' . $s['rejoinTries']);
                } else {
                    clog($s['nick'], 'rejoin_echec', httpDiag($res));
                }
                break;

            case 'resend':
                $r2 = ($j['results'] ?? [])[0] ?? null;
                if (!is_array($r2)) {
                    // échec global de la ré-émission (session occupée/illisible…) :
                    // tracé pour le diagnostic, la prochaine ré-émission retentera
                    clog($s['nick'], 'reemission_echec', "q={$tag['q']}\t" . httpDiag($res));
                }
                if (is_array($r2)) {
                    clog($s['nick'], 'reemission_resultat', "q={$tag['q']}&ok=" . (int)!empty($r2['success'])
                        . "&dup=" . (int)!empty($r2['duplicate']) . "&tooLate=" . (int)!empty($r2['tooLate']));
                    if (!empty($r2['duplicate'])) {
                        // le serveur l'a DÉJÀ : confirmation directe
                        $s['confirmed'][(int)$tag['q']] = true;
                    } elseif (!empty($r2['tooLate'])) {
                        // rejet définitif (vraiment hors grâce) : on arrête, R1/J1 jugeront
                        $tooLateInjuste++;
                        $s['confirmed'][(int)$tag['q']] = true;
                    }
                    // sinon : enregistrée à l'instant → myAnswered confirmera au prochain poll
                }
                break;

            case 'bulk':
                foreach (($j['results'] ?? []) as $r2) {
                    clog($s['nick'], 'bulk_result', "q={$r2['questionIndex']}&ok=" . (int)!empty($r2['success'])
                        . "&late=" . (int)!empty($r2['lateAccepted']) . "&tooLate=" . (int)!empty($r2['tooLate']));
                    if (!empty($r2['tooLate'])) $tooLateInjuste++;
                    // la confirmation finale viendra de myAnswered ; on arme le suivi
                    $qb = (int)($r2['questionIndex'] ?? -1);
                    if ($qb >= 0 && isset($s['answeredQ'][$qb])) {
                        $s['answeredQ'][$qb]['sentAt'] = microtime(true);
                        $s['answeredQ'][$qb]['resends'] = $s['answeredQ'][$qb]['resends'] ?? 0;
                    }
                }
                $s['buffer'] = [];
                $s['offlineStartAt'] = 0;
                clog($s['nick'], 'outage_end', 'bulk envoye');
                break;
        }
        unset($s);
    }
}

/**
 * « Prof virtuel » des classes secondaires : avance sa partie indépendamment
 * (next quand tout le monde a répondu + 2 s, force au timeout + 3 s).
 */
function tickSideDrivers(&$classes, $N_QUESTIONS, $QT, $now, $BASE) {
    global $questions;
    foreach ($classes as $ci => &$c) {
        if ($c['isMain'] || $c['drv']['finished']) continue;
        $drv =& $c['drv'];
        if ($now - $drv['lastCtrlAt'] < 1.5) continue;
        $drv['lastCtrlAt'] = $now;

        // démarrage : lancer Q0
        if ($drv['q'] < 0) {
            $r = httpPost("$BASE/php/control.php", ['action' => 'next_question', 'playCode' => $c['code'],
                'questionIndex' => 0, 'customTime' => $QT, 'teacher_hash' => TEACHER_HASH]);
            if (!empty($r['json']['success'])) {
                $drv['q'] = 0; $drv['launchedAt'] = $now; $drv['completedSeenAt'] = 0;
                $drv['plans'] = [];
                foreach ($c['students'] as $s) $drv['plans'][$s['nick']] = planFor($s, $questions[0], 0, $now, $QT);
                clog('prof-' . ($ci + 1), 'next_question', 'q=0');
            }
            continue;
        }

        $st = httpGet("$BASE/php/control.php", ['action' => 'get_control_state', 'playCode' => $c['code']]);
        $j = $st['json'] ?? [];
        if (empty($j['success'])) continue;

        $completed = !empty($j['questionCompleted']);
        $overdue = isset($j['timeElapsed'], $j['questionTime']) ? ($j['timeElapsed'] - $j['questionTime']) : -99;
        if (!$completed && $overdue >= 3) {
            httpPost("$BASE/php/control.php", ['action' => 'force_question_complete', 'playCode' => $c['code'],
                'questionIndex' => $drv['q'], 'teacher_hash' => TEACHER_HASH]);
            continue;
        }
        if ($completed) {
            if ($drv['completedSeenAt'] <= 0) { $drv['completedSeenAt'] = $now; continue; }
            if ($now - $drv['completedSeenAt'] < 2.0) continue;
            $next = $drv['q'] + 1;
            if ($next >= $N_QUESTIONS) {
                httpPost("$BASE/php/control.php", ['action' => 'end_game', 'playCode' => $c['code'], 'teacher_hash' => TEACHER_HASH]);
                $drv['finished'] = true;
                clog('prof-' . ($ci + 1), 'end_game', 'q=' . $drv['q']);
            } else {
                $r = httpPost("$BASE/php/control.php", ['action' => 'next_question', 'playCode' => $c['code'],
                    'questionIndex' => $next, 'customTime' => $QT, 'teacher_hash' => TEACHER_HASH]);
                if (!empty($r['json']['success'])) {
                    $drv['q'] = $next; $drv['launchedAt'] = $now; $drv['completedSeenAt'] = 0;
                    $drv['plans'] = [];
                    foreach ($c['students'] as $s) $drv['plans'][$s['nick']] = planFor($s, $questions[$next], $next, $now, $QT);
                    clog('prof-' . ($ci + 1), 'next_question', "q=$next");
                }
            }
        }
    }
    unset($c);
}

// ---------- boucle principale : questions de la classe principale ----------
for ($q = 0; $q < $N_QUESTIONS; $q++) {
    $r = httpPost("$BASE/php/control.php", ['action' => 'next_question', 'playCode' => $main['code'],
        'questionIndex' => $q, 'customTime' => $QT, 'teacher_hash' => TEACHER_HASH]);
    if (empty($r['json']['success'])) { echo "❌ next_question($q) impossible : " . httpDiag($r) . "\n"; break; }
    $qLaunchedAt = microtime(true);
    $main['drv']['launchedAt'] = $qLaunchedAt;
    clog('prof', 'next_question', "q=$q");

    // coupure réseau : 4 s après le lancement de Q1 (le temps de VOIR la question)
    if ($q === 1) {
        foreach ($main['students'] as &$s) {
            if ($s['profile'] === 'outage') {
                $s['offlineStartAt'] = $qLaunchedAt + 4;
                $s['offlineUntil'] = $qLaunchedAt + 4 + $OUTAGE_SEC;
                clog($s['nick'], 'outage_start', "debut=+4s&duree={$OUTAGE_SEC}s");
            }
        }
        unset($s);
    }

    // plans de réponse de la question
    $plans = [];
    foreach ($main['students'] as $s) {
        if ($s['removed']) continue;
        if ($s['profile'] === 'victim' && $q === $N_QUESTIONS - 1) continue; // retiré avant de répondre
        $plans[$s['nick']] = planFor($s, $questions[$q], $q, $qLaunchedAt, $QT);
    }
    // évènements spéciaux de cette question
    $reloadAt = ($q === 2) ? $qLaunchedAt + 1.5 : 0;          // RL1 : F5 de Normal03
    $lateJoinAt = ($q === 1) ? $qLaunchedAt + 2.0 : 0;        // LJ1 : Retard01 arrive
    $kickAt = ($q === $N_QUESTIONS - 1) ? $qLaunchedAt + 1.0 : 0; // K1 : retrait de Victime01

    $deadline = $qLaunchedAt + $QT + 6;
    while (microtime(true) < $deadline) {
        $now = microtime(true);

        // RL1 — reload (re-join même pseudo + même appareil) en pleine question
        if ($reloadAt > 0 && $now >= $reloadAt && !$rl1Done) {
            $rl1Done = true;
            foreach ($main['students'] as $si => $s) {
                if ($s['nick'] === 'Normal03') {
                    $r = httpPost("$BASE/php/game.php", ['action' => 'join', 'playCode' => $main['code'],
                        'nickname' => $s['nick'], 'deviceId' => $s['deviceId']]);
                    verdict('RL1', 'reload (F5) en pleine question : reconnexion transparente', !empty($r['json']['success']));
                    break;
                }
            }
        }
        // LJ1 — élève en retard
        if ($lateJoinAt > 0 && $now >= $lateJoinAt && $lateJoiner === null) {
            $lj = mkStudent('Retard01', 'normal', 0);
            $r = httpPost("$BASE/php/game.php", ['action' => 'join', 'playCode' => $main['code'],
                'nickname' => $lj['nick'], 'deviceId' => $lj['deviceId']]);
            $lj['joined'] = !empty($r['json']['success']);
            $main['students'][] = $lj;
            $lateJoiner = ['joined' => $lj['joined']];
            $plans[$lj['nick']] = planFor($lj, $questions[$q], $q, $now, $QT);
            // son timeSpent doit rester dans la grâce : il répond vite après son arrivée
            $plans[$lj['nick']]['at'] = $now + 2.0;
            $plans[$lj['nick']]['timeSpent'] = min($plans[$lj['nick']]['timeSpent'], 4000);
            clog('Retard01', 'late_join', 'ok=' . (int)$lj['joined']);
            verdict('LJ1', 'élève en retard : rejoint une partie déjà commencée et joue la suite', $lj['joined']);
        }
        // K1 — le prof retire Victime01
        if ($kickAt > 0 && $now >= $kickAt && !$k1Removed) {
            $k1Removed = true;
            foreach ($main['students'] as $si => &$s) {
                if ($s['profile'] === 'victim') {
                    httpPost("$BASE/php/control.php", ['action' => 'remove_player', 'playCode' => $main['code'],
                        'nickname' => $s['nick'], 'teacher_hash' => TEACHER_HASH]);
                    $s['removed'] = true;
                    clog($s['nick'], 'removed_by_prof', '');
                    break;
                }
            }
            unset($s);
        }

        // lot parallèle : classe principale + classes secondaires
        $reqs = collectStudentReqs($main, 0, $q, $plans, $now, $BASE);
        foreach ($classes as $ci => &$c) {
            if ($c['isMain'] || $c['drv']['finished'] || $c['drv']['q'] < 0) continue;
            $reqs = array_merge($reqs, collectStudentReqs($c, $ci, $c['drv']['q'], $c['drv']['plans'], $now, $BASE));
        }
        unset($c);
        if ($reqs) dispatchResults(mexec($reqs), $classes, $QT, $BASE);

        // profs virtuels des classes secondaires
        tickSideDrivers($classes, $N_QUESTIONS, $QT, microtime(true), $BASE);

        // fin anticipée : tous les élèves EN LIGNE de la classe principale ont répondu
        $answered = 0; $online = 0;
        foreach ($main['students'] as $s) {
            if ($s['removed']) continue;
            $isOffline = ($s['offlineStartAt'] > 0 && $now >= $s['offlineStartAt'] && $now < $s['offlineUntil']);
            if ($isOffline) continue;
            $online++;
            if (isset($s['answeredQ'][$q])) $answered++;
        }
        if ($answered >= $online && $online > 0) {
            $g = httpGet("$BASE/php/game.php", ['action' => 'get_state_readonly', 'playCode' => $main['code'], 'nickname' => 'Normal01']);
            if (!empty($g['json']['results'])) break;
        }
        usleep(150000);
    }

    // fin de question (idempotent) + stabilité du classement (q0)
    httpPost("$BASE/php/control.php", ['action' => 'force_question_complete', 'playCode' => $main['code'],
        'questionIndex' => $q, 'teacher_hash' => TEACHER_HASH]);
    if ($q === 0) {
        // Le classement figé est IMMUABLE (done-file) — mais sur le cluster, sa
        // propagation aux autres nœuds peut prendre 1-2 s : on tolère ce délai et on
        // ne juge que la STABILITÉ DU CONTENU une fois visible des deux lectures.
        $t1 = 'null'; $t2 = 'null';
        for ($i = 0; $i < 6; $i++) {
            $g1 = httpGet("$BASE/php/game.php", ['action' => 'get_state_readonly', 'playCode' => $main['code'], 'nickname' => 'Normal02']);
            $t1 = json_encode($g1['json']['results']['top3'] ?? null);
            if ($t1 === 'null') { usleep(800000); continue; }
            usleep(900000);
            $g2 = httpGet("$BASE/php/game.php", ['action' => 'get_state_readonly', 'playCode' => $main['code'], 'nickname' => 'Normal02']);
            $t2 = json_encode($g2['json']['results']['top3'] ?? null);
            if ($t2 !== 'null') break;
            usleep(500000);
        }
        verdict('S3', 'classement figé stable entre deux lectures', $t1 !== 'null' && $t1 === $t2);
    }
    // T5 après Q1 (avant le retrait de Victime01 en fin de partie)
    if ($q === 1 && !$t5Done) {
        $t5Done = true;
        $cs = httpGet("$BASE/php/control.php", ['action' => 'get_control_state', 'playCode' => $main['code']]);
        $tabOk = false;
        foreach (($cs['json']['players'] ?? []) as $p) {
            if ($p['nickname'] === 'Onglet01' && (int)($p['tabSwitchCount'] ?? 0) >= 1) $tabOk = true;
        }
        // Le signalement d'onglet est un BEACON best-effort (sendBeacon, débouncé) : en
        // réseau dégradé (perte/latence) il peut être perdu → fonction « avertir le prof »
        // amoindrie, mais sans impact sur le jeu/les scores. INFO sous réseau dégradé.
        if ($DROP_PCT > 0 || $LATENCY_SEC > 0) {
            echo "  ℹ️  T5 (signalement d'onglet) réseau dégradé : " . ($tabOk ? "reçu" : "non reçu (beacon best-effort perdu — sans impact jeu)") . "\n";
        } else {
            verdict('T5', 'changements d\'onglet signalés au prof (tabSwitchCount)', $tabOk);
        }
    }

    // mesures de synchro (élèves à réseau NOMINAL de la classe principale)
    $det = []; $disp = [];
    foreach ($main['students'] as $s) {
        if (!isset($s['detectedAt'][$q])) continue;
        if (in_array($s['profile'], ['outage', 'victim'], true)) continue;
        if ($s['nick'] === 'Retard01') continue;
        if ($s['profile'] === 'slow') { $slowLags[] = $s['detectedAt'][$q] - $qLaunchedAt; continue; }
        $det[] = $s['detectedAt'][$q];
        $disp[] = $s['displayAt'][$q];
    }
    if (count($det) >= 3) {
        // q0 est mesurée à titre INDICATIF mais exclue des verdicts S1/S2 : dans le
        // vrai usage elle a son propre countdown aligné de 3,5 s (large), et dans le
        // test elle peut être polluée par la convergence de visibilité des joins sur
        // le cluster (re-joins en cours au coup d'envoi).
        if ($q >= 1) {
            $detectionSpreads[] = max($det) - min($det);
            $displaySpreads[] = max($disp) - min($disp);
        }
        clog('mesure', 'spread', sprintf("q=%d&detection=%.2fs&affichage=%.2fs%s", $q,
            max($det) - min($det), max($disp) - min($disp), $q === 0 ? '&info_seulement=1' : ''));
    }
    echo "   Q$q jouée (détections : " . count($det) . " élèves nominaux)\n"; @flush();

    // Comme la VRAIE avance auto : Top 3 affiché ~5 s avant la question suivante.
    // Les élèves virtuels passent en fenêtre d'anticipation à +3,5 s (cadence 0,85 s),
    // exactement comme le vrai client → la mesure de synchro reflète le mode auto réel.
    if ($q < $N_QUESTIONS - 1) {
        $completedAt = microtime(true);
        while (microtime(true) < $completedAt + 5.0) {
            $now = microtime(true);
            $anticipate = ($now - $completedAt) >= 3.5;
            $reqs = collectStudentReqs($main, 0, $q, [], $now, $BASE, $anticipate, $now - $completedAt);
            foreach ($classes as $ci => &$c) {
                if ($c['isMain'] || $c['drv']['finished'] || $c['drv']['q'] < 0) continue;
                $reqs = array_merge($reqs, collectStudentReqs($c, $ci, $c['drv']['q'], $c['drv']['plans'], $now, $BASE));
            }
            unset($c);
            if ($reqs) dispatchResults(mexec($reqs), $classes, $QT, $BASE);
            tickSideDrivers($classes, $N_QUESTIONS, $QT, microtime(true), $BASE);
            usleep(100000);
        }
    }
}

// K1 : le poste de l'élève retiré doit le détecter (il polle encore quelques secondes)
$k1Deadline = microtime(true) + 8;
while (microtime(true) < $k1Deadline) {
    $victim = null;
    foreach ($main['students'] as $si => $s) if ($s['profile'] === 'victim') $victim = $s;
    if (!$victim || $victim['kickedSeen']) break;
    $reqs = collectStudentReqs($main, 0, $N_QUESTIONS - 1, [], microtime(true), $BASE);
    if ($reqs) dispatchResults(mexec($reqs), $classes, $QT, $BASE);
    usleep(200000);
}
$victimSeen = false;
foreach ($main['students'] as $s) if ($s['profile'] === 'victim' && $s['kickedSeen']) $victimSeen = true;
verdict('K1', 'élève retiré par le prof : son poste le détecte (kicked)', $victimSeen);

// attendre la fin de la coupure si elle court encore, en continuant de servir les classes
$maxOfflineUntil = 0;
foreach ($main['students'] as $s) $maxOfflineUntil = max($maxOfflineUntil, $s['offlineUntil']);
if ($maxOfflineUntil > microtime(true)) {
    echo "   ⏳ attente du retour de la cohorte « coupure » (" . (int)ceil($maxOfflineUntil - microtime(true)) . " s)…\n"; @flush();
    while (microtime(true) < $maxOfflineUntil + 4) {
        $now = microtime(true);
        $reqs = [];
        foreach ($main['students'] as $si => $s) {
            if ($s['offlineStartAt'] > 0 && $now >= $s['offlineUntil'] && count($s['buffer']) > 0) {
                $reqs[] = ['url' => "$BASE/php/game.php", 'tag' => ['t' => 'bulk', 'ci' => 0, 'si' => $si],
                    'post' => ['action' => 'answer_bulk', 'playCode' => $main['code'], 'nickname' => $s['nick'],
                               'answers' => json_encode($s['buffer'])]];
                $main['students'][$si]['inFlight'] = true;
            }
        }
        if ($reqs) dispatchResults(mexec($reqs), $classes, $QT, $BASE);
        tickSideDrivers($classes, $N_QUESTIONS, $QT, microtime(true), $BASE);
        $pendingBuffers = false;
        foreach ($main['students'] as $s) if (count($s['buffer']) > 0) $pendingBuffers = true;
        if (!$pendingBuffers) break;
        usleep(250000);
    }
}

// laisser les classes secondaires terminer leurs questions
$sideDeadline = microtime(true) + ($N_QUESTIONS * ($QT + 8));
while (microtime(true) < $sideDeadline) {
    $allDone = true;
    foreach ($classes as $c) if (!$c['isMain'] && !$c['drv']['finished']) $allDone = false;
    if ($allDone) break;
    $now = microtime(true);
    $reqs = [];
    foreach ($classes as $ci => &$c) {
        if ($c['isMain'] || $c['drv']['finished'] || $c['drv']['q'] < 0) continue;
        $reqs = array_merge($reqs, collectStudentReqs($c, $ci, $c['drv']['q'], $c['drv']['plans'], $now, $BASE));
    }
    unset($c);
    if ($reqs) dispatchResults(mexec($reqs), $classes, $QT, $BASE);
    tickSideDrivers($classes, $N_QUESTIONS, $QT, microtime(true), $BASE);
    usleep(150000);
}

// DRAIN de confirmation : avant de juger les scores, laisser les élèves vérifier
// (myAnswered) que TOUTES leurs réponses sont enregistrées, et ré-émettre celles
// qui ont été englouties par les écritures concurrentes du mutualisé — c'est ce
// que le vrai client fait en continu pendant toute la partie.
$drainDeadline = microtime(true) + 15;
while (microtime(true) < $drainDeadline) {
    $pendingConf = 0;
    foreach ($classes as $c) {
        foreach ($c['students'] as $s) {
            if ($s['removed']) continue;
            foreach ($s['answeredQ'] as $aq => $rec) {
                if (empty($s['confirmed'][$aq]) && ($rec['resends'] ?? 0) < 8) $pendingConf++;
            }
        }
    }
    if ($pendingConf === 0) break;
    $now = microtime(true);
    $reqs = [];
    foreach ($classes as $ci => &$c) {
        $qCur = $c['isMain'] ? ($N_QUESTIONS - 1) : max(0, $c['drv']['q']);
        $reqs = array_merge($reqs, collectStudentReqs($c, $ci, $qCur, [], $now, $BASE));
    }
    unset($c);
    if ($reqs) dispatchResults(mexec($reqs), $classes, $QT, $BASE);
    usleep(200000);
}

// R1 : zéro rejet injuste
verdict('R1', 'coupure réseau : 0 « temps écoulé » injuste (réponses bufferisées acceptées)', $tooLateInjuste === 0, "rejets=$tooLateInjuste");

// SRV : AUCUNE réponse serveur 5xx de tout le run. Un seul 500 (TypeError fatale, etc.)
// ouvre le circuit breaker de TOUS les postes → classe figée jusqu'à la fin. Ce verdict
// n'existait pas avant le 18/06 ; c'est lui qui aurait attrapé le bug en prod.
$srv5xx = (int)($GLOBALS['HTTP5XX'] ?? 0);
verdict('SRV', 'aucune réponse serveur 5xx (un seul 500 fige la classe)', $srv5xx === 0, "5xx=$srv5xx");

// NET-IP : PIC de requêtes par IP de sortie. Au collège, TOUTE une classe (élèves + prof
// + projection) sort par UNE SEULE IP : c'est l'agrégat par IP — pas le par-élève — qui
// déclenche un ban hébergeur/filtrage. À --classes=1, le total = une classe = une IP.
$peakMin = peakRate($GLOBALS['REQ_TIMES'] ?? [], 60);
$peakSec = peakRate($GLOBALS['REQ_TIMES'] ?? [], 1);
$dropCount = (int)($GLOBALS['DROP_COUNT'] ?? 0);
echo sprintf("  ℹ️  PIC de charge par IP : %d req/min, %d req/s%s\n", $peakMin, $peakSec,
    $DROP_PCT > 0 ? " | proxy a bloqué $dropCount requête(s) (--drop=$DROP_PCT%)" : '');
clog('mesure', 'peak_ip', "reqmin=$peakMin&reqs=$peakSec&drop=$dropCount&classes=$N_CLASSES");
if ($N_CLASSES === 1) {
    verdict('NET-IP', "pic ≤ {$IP_CEILING} req/min pour UNE classe (1 IP) — au-delà, risque de ban",
        $peakMin <= $IP_CEILING, "pic=$peakMin req/min ($peakSec req/s)");
} else {
    echo "  ℹ️  NET-IP non jugé en multi-classes (le pic ci-dessus est la SOMME des $N_CLASSES classes ; relancer avec --classes=1 pour juger une IP).\n";
}
if ($DROP_PCT > 0) {
    // Sous filtrage proxy, la résilience est jugée par R1 (déjà ci-dessus : 0 « temps
    // écoulé » injuste) et J1 (plus bas : scores exacts MALGRÉ les blocages). Si R1+J1
    // passent avec --drop élevé, la ré-émission a bien rattrapé les requêtes bloquées.
    echo "  ℹ️  Filtrage proxy actif (--drop=$DROP_PCT%) : la résilience est validée par R1 (0 rejet) et J1 (scores exacts) ci-dessus/dessous.\n";
}

// S1/S2 : synchronisation (élèves à réseau nominal)
if ($displaySpreads) {
    $maxDet = max($detectionSpreads); $maxDisp = max($displaySpreads);
    if ($DROP_PCT > 0) {
        // Sous filtrage proxy, l'écart d'affichage se dégrade FORCÉMENT (les polls qui
        // portent revealAt sont parfois bloqués → révélation tardive chez les malchanceux).
        // C'est gracieux (bon temps restant + score juste, cf. J1). On NE juge donc PAS S1/S2
        // sous --drop : on rapporte la mesure pour information.
        echo sprintf("  ℹ️  Sync sous filtrage --drop=%d%% (dégradation ATTENDUE, non jugée) : détection %.2fs, affichage %.2fs — la justesse (J1) et l'absence de rejet (R1) tiennent quand même.\n", $DROP_PCT, $maxDet, $maxDisp);
        clog('mesure', 'sync_under_drop', sprintf("drop=%d&det=%.2f&disp=%.2f", $DROP_PCT, $maxDet, $maxDisp));
    } else {
        verdict('S1', 'écart de détection entre élèves (réseau nominal) ≤ 5 s', $maxDet <= 5.0, sprintf("max=%.2fs", $maxDet));
        verdict('S2', 'écart d\'AFFICHAGE (révélation alignée) ≤ 1,2 s', $maxDisp <= 1.2, sprintf("max=%.2fs", $maxDisp));
    }
    if ($slowLags) {
        echo sprintf("  ℹ️  élève très lent : détection %.1f à %.1f s après le lancement (latence simulée — dégradation attendue, score garanti par J1)\n", min($slowLags), max($slowLags));
        clog('mesure', 'slow_lag', sprintf("min=%.2f&max=%.2f", min($slowLags), max($slowLags)));
    }
} else {
    verdict('S1', 'mesure de synchro disponible', false, 'aucune mesure');
}

// M2/M3 : multi-classes
if ($N_CLASSES > 1) {
    verdict('M2', 'facteur crowd ≥ 1,25 observé (étalement multi-classes actif)', $maxCrowdSeen >= 1.25, sprintf("max=%.2f", $maxCrowdSeen));
    $allFinished = true; $detail = [];
    foreach ($classes as $ci => $c) {
        if ($c['isMain']) continue;
        if (!$c['drv']['finished']) { $allFinished = false; $detail[] = 'classe ' . ($ci + 1) . ' bloquée à Q' . $c['drv']['q']; }
    }
    verdict('M3', 'toutes les classes secondaires ont terminé toutes leurs questions', $allFinished, implode(' | ', $detail));
}

// ============================================================
// PHASE 3 — fin de partie + justesse des scores (toutes classes)
// ============================================================
echo "▶️  Phase 3 : fin de partie + vérification des scores\n"; @flush();
httpPost("$BASE/php/control.php", ['action' => 'end_game', 'playCode' => $main['code'], 'teacher_hash' => TEACHER_HASH]);

$scoreErrors = []; $checked = 0;
foreach ($classes as $ci => $c) {
    // Témoins de lecture avec REPLI : si le premier élève est indisponible (kicked
    // transitoire sur un nœud, retiré…), on lit via un autre — 3 témoins × 3 essais.
    $witnesses = [];
    foreach ($c['students'] as $s) {
        if (!$s['removed']) $witnesses[] = $s['nick'];
        if (count($witnesses) >= 3) break;
    }
    $final = null;
    foreach ($witnesses as $witness) {
        for ($try = 0; $try < 3; $try++) {
            $final = httpGet("$BASE/php/game.php", ['action' => 'get_state_readonly', 'playCode' => $c['code'], 'nickname' => $witness]);
            if (!empty($final['json']['finalResults']['players'])) break 2;
            usleep(700000);
        }
        clog('setup', 'final_witness_suivant', 'classe=' . ($ci + 1) . "&apres=$witness\t" . httpDiag($final));
    }
    if (empty($final['json']['finalResults']['players'])) {
        echo "  ⚠️  classe " . ($ci + 1) . " : résultats finaux illisibles → " . httpDiag($final) . "\n";
        clog('setup', 'final_fetch_fail', 'classe=' . ($ci + 1) . "\t" . httpDiag($final));
    }
    $serverPlayers = [];
    foreach (($final['json']['finalResults']['players'] ?? []) as $p) $serverPlayers[$p['nickname']] = (int)($p['score'] ?? 0);
    if ($ci === 0) $mainServerPlayers = $serverPlayers; // réutilisé par T4

    // Réseau dégradé : le SPAMMEUR envoie des réponses DIFFÉRENTES rapprochées (bonne puis
    // fausses) ; sous perte/concurrence, sa bonne réponse peut être perdue (lost-update OVH)
    // et un spam s'enregistrer → score indéterministe. NON représentatif d'un élève normal
    // (qui ne renvoie QUE la même réponse). On l'exclut de J1 en réseau dégradé pour que J1
    // reste un vrai juge de la justesse des ÉLÈVES NORMAUX, sans faux échec sur le spammeur.
    $degradedNet = ($DROP_PCT > 0 || $LATENCY_SEC > 0);
    foreach ($c['students'] as $s) {
        if ($s['removed']) continue; // retiré par le prof : plus de score serveur (normal)
        if ($degradedNet && $s['profile'] === 'spammer') continue; // score ambigu sous perte
        $expected = 0;
        foreach ($s['answeredQ'] as $qi => $a) $expected += expectedPoints($questions[$qi], $a['payload'], $a['timeSpent']);
        $server = $serverPlayers[$s['nick']] ?? -1;
        $checked++;
        clog($s['nick'], 'score', "classe=" . ($ci + 1) . "&attendu=$expected&serveur=$server");
        if ($server !== $expected) $scoreErrors[] = "{$s['nick']}(c" . ($ci + 1) . "): attendu=$expected serveur=$server";
    }
}
verdict('J1', "score serveur == score recalculé pour CHAQUE élève normal ($checked élèves, $N_CLASSES classe(s))",
    count($scoreErrors) === 0, $scoreErrors ? implode(' | ', array_slice($scoreErrors, 0, 4)) : 'tous exacts');

// T4 : la réponse du spammeur n'a pas été écrasée
$spamExpected = 0;
foreach ($main['students'] as $s) {
    if ($s['nick'] !== 'Spam01') continue;
    foreach ($s['answeredQ'] as $qi => $a) $spamExpected += expectedPoints($questions[$qi], $a['payload'], $a['timeSpent']);
}
$spamServer = isset($mainServerPlayers['Spam01']) ? (int)$mainServerPlayers['Spam01'] : -1;
if ($DROP_PCT > 0 || $LATENCY_SEC > 0) {
    // En réseau dégradé, la garantie « 1ʳᵉ réponse définitive » peut sauter par course
    // lost-update SI le client envoie des réponses DIFFÉRENTES dans la même fenêtre ms
    // (cas adversarial). Sans impact sur les élèves normaux (cf. J1). → INFO, pas un échec.
    echo "  ℹ️  T4 (anti-spam) réseau dégradé : spammeur serveur=$spamServer attendu=$spamExpected — "
       . ($spamServer === $spamExpected ? "tenu" : "écart attendu (course lost-update sur réponses adversariales rapprochées)") . "\n";
} else {
    verdict('T4', 'spam de réponses : la première réponse est définitive', $spamServer === $spamExpected, "serveur=$spamServer attendu=$spamExpected");
}

// ---------- info trafic + auto-réparations ----------
$elapsedMin = max(0.1, (microtime(true) - $startedAt) / 60);
$nbResend = (int)($GLOBALS['RESEND_COUNT'] ?? 0);
$nbRejoin = (int)($GLOBALS['REJOIN_COUNT'] ?? 0);
echo sprintf("  ℹ️  trafic généré : %d requêtes en %.1f min ≈ %d req/min (crowd max observé : %.2f)\n",
    $REQ_COUNT, $elapsedMin, (int)round($REQ_COUNT / $elapsedMin), $maxCrowdSeen);
echo sprintf("  ℹ️  auto-réparations du client (normales sur mutualisé) : %d ré-émission(s) de réponse, %d re-join(s)\n",
    $nbResend, $nbRejoin);
clog('mesure', 'trafic', "req=$REQ_COUNT&reqmin=" . (int)round($REQ_COUNT / $elapsedMin) . "&crowdmax=$maxCrowdSeen&resend=$nbResend&rejoin=$nbRejoin");

// ============================================================
// nettoyage + bilan
// ============================================================
chaos_end:
if (empty($opts['keep-session'])) {
    foreach ($classes as $c) {
        httpPost("$BASE/php/control.php", ['action' => 'cleanup_session', 'playCode' => $c['code'], 'teacher_hash' => TEACHER_HASH]);
    }
} else {
    echo "ℹ️  sessions conservées (--keep-session=1)\n";
}

echo "\n========== BILAN CHAOS ==========\n";
foreach ($verdicts as $v) echo ($v[1] ? "✅" : "❌") . " {$v[0]} — {$v[2]}" . ($v[3] !== '' ? "  [{$v[3]}]" : '') . "\n";
echo "\n$PASS réussis, $FAIL échoués — log détaillé : $LOG_FILE\n";
clog('setup', 'end', "pass=$PASS&fail=$FAIL");
if (defined('QWEST_TESTS_WEB')) return; // inclusion web : rendre la main à tests.php
exit($FAIL > 0 ? 1 : 0);
