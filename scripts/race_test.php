<?php
/**
 * Qwest — Test de race « réponse au dernier moment »
 *
 * Reproduit le scénario 5 du ScenariosTest.md de manière déterministe :
 *   - N élèves rejoignent une partie réelle
 *   - le prof démarre + lance la question 0 (durée par défaut 30 s)
 *   - tous les élèves attendent T = questionTime - 0.5 s puis envoient leur réponse SIMULTANÉMENT
 *   - on vérifie ensuite via get_state que :
 *       * 100 % des réponses ont été acceptées (success=true ou lateAccepted=true)
 *       * 0 réponse a été marquée tooLate
 *       * 0 élève apparaît avec answered=false dans questionStats du résultat
 *
 * Pré-requis : une session a été créée par le prof, et la question 0 doit pouvoir être
 * lancée par ce script (option --auto-start). Pour tester en isolation, créez une partie
 * avec un quiz simple (1 question multiple-choice), notez le playCode, puis :
 *
 *   php scripts/race_test.php --base-url=http://localhost/qwest --play-code=XXXX --players=20 --auto-start=1
 *
 * Le script affiche un verdict PASS/FAIL clair.
 */

if (php_sapi_name() !== 'cli') exit(1);

// Hash SHA-256 de prof123 — identique à TEACHER_HASH dans php/control.php.
// Ajouté dans tous les POST vers control.php (start_game, next_question, force_question_complete).
const TEACHER_HASH = '00624b02e1f9b996a3278f559d5d55313552ad2c0bafc82adfd975c12df61eaf';

$opts = [
    'base-url' => 'http://localhost/qwest',
    'play-code' => '',
    'players' => 20,
    'auto-start' => 0,
    'question-time' => 30,
    'late-offset-ms' => 500, // marge avant la fin du timer
];
foreach (array_slice($argv, 1) as $arg) {
    if (preg_match('/^--([a-z\-]+)=(.*)$/', $arg, $m)) {
        $opts[$m[1]] = is_numeric($m[2]) ? $m[2] + 0 : $m[2];
    }
}
if ($opts['play-code'] === '') {
    fwrite(STDERR, "ERREUR : --play-code requis\n");
    exit(2);
}

$base = rtrim($opts['base-url'], '/');
$playCode = strtoupper(trim($opts['play-code']));
$nPlayers = (int) $opts['players'];
$qTime = (int) $opts['question-time'];
$lateOffset = (int) $opts['late-offset-ms'];

function postSync(string $url, array $params): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query($params),
        CURLOPT_TIMEOUT => 10,
    ]);
    $body = curl_exec($ch);
    curl_close($ch);
    return json_decode($body, true) ?: [];
}

function getSync(string $url, array $params): array {
    $ch = curl_init($url . '?' . http_build_query($params));
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10]);
    $body = curl_exec($ch);
    curl_close($ch);
    return json_decode($body, true) ?: [];
}

echo "🧪 race_test : $nPlayers élèves, dernière seconde (T = ${qTime}s − ${lateOffset}ms)\n\n";

// Étape 1 — JOIN de tous les élèves
echo "▶️  Étape 1 : JOIN de $nPlayers élèves\n";
$nicknames = [];
for ($i = 1; $i <= $nPlayers; $i++) {
    $nick = sprintf('Race%02d', $i);
    $nicknames[] = $nick;
    $r = postSync($base . '/php/game.php', ['action' => 'join', 'playCode' => $playCode, 'nickname' => $nick]);
    if (empty($r['success'])) {
        fwrite(STDERR, "❌ JOIN échoué pour $nick : " . json_encode($r) . "\n");
        exit(1);
    }
}
echo "   ✅ Tous joints\n";

// Étape 2 — Auto-start (si demandé)
if (!empty($opts['auto-start'])) {
    echo "▶️  Étape 2 : start_game + next_question(0)\n";
    $r = postSync($base . '/php/control.php', [
        'action' => 'start_game', 'playCode' => $playCode, 'manualMode' => '1', 'showTop3' => '1',
        'teacher_hash' => TEACHER_HASH
    ]);
    if (empty($r['success'])) { fwrite(STDERR, "❌ start_game échoué\n"); exit(1); }
    $r = postSync($base . '/php/control.php', [
        'action' => 'next_question', 'playCode' => $playCode, 'questionIndex' => 0, 'customTime' => $qTime,
        'teacher_hash' => TEACHER_HASH
    ]);
    if (empty($r['success'])) { fwrite(STDERR, "❌ next_question échoué\n"); exit(1); }
    echo "   ✅ Question 0 lancée\n";
} else {
    echo "ℹ️  --auto-start=0 : démarrez la partie depuis l'interface prof MAINTENANT (Q0)\n";
    echo "   Appuyez sur Entrée quand c'est fait...\n";
    fgets(STDIN);
}

// Étape 3 — Récupérer questionStartTime depuis le serveur
echo "▶️  Étape 3 : lecture du questionStartTime serveur\n";
$state = getSync($base . '/php/game.php', ['action' => 'get_state', 'playCode' => $playCode, 'nickname' => $nicknames[0]]);
if (empty($state['success']) || empty($state['question'])) {
    fwrite(STDERR, "❌ Impossible de récupérer la question : " . json_encode($state) . "\n");
    exit(1);
}
$startTimeServer = (int) $state['question']['startTime']; // unix seconds
echo "   questionStartTime serveur = $startTimeServer ({" . date('H:i:s', $startTimeServer) . "})\n";

// Étape 4 — Synchroniser et envoyer toutes les réponses à T = qTime - lateOffset/1000
$targetUnix = $startTimeServer + $qTime - ($lateOffset / 1000);
$nowFloat = microtime(true);
$wait = $targetUnix - $nowFloat;
if ($wait > 0) {
    echo "▶️  Étape 4 : attente " . round($wait, 2) . " s avant la rafale\n";
    usleep((int) ($wait * 1_000_000));
} else {
    echo "⚠️  Le timer est déjà passé (offset = " . round(-$wait, 2) . " s) — envoi immédiat\n";
}

echo "💥 Étape 5 : envoi simultané de $nPlayers réponses\n";
$mh = curl_multi_init();
$handles = [];
$startBurst = microtime(true);
foreach ($nicknames as $nick) {
    $ch = curl_init($base . '/php/game.php');
    $timeSpent = (int) (($qTime * 1000) - $lateOffset);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query([
            'action' => 'answer',
            'playCode' => $playCode,
            'nickname' => $nick,
            'questionIndex' => 0,
            'answer' => json_encode(['index' => 0]),
            'timeSpent' => $timeSpent,
        ]),
        CURLOPT_TIMEOUT => 15,
    ]);
    curl_multi_add_handle($mh, $ch);
    $handles[$nick] = $ch;
}
do { curl_multi_exec($mh, $running); usleep(10_000); } while ($running);

$results = [];
foreach ($handles as $nick => $ch) {
    $body = curl_multi_getcontent($ch);
    $results[$nick] = json_decode($body, true);
    curl_multi_remove_handle($mh, $ch);
    curl_close($ch);
}
curl_multi_close($mh);
$burstDuration = microtime(true) - $startBurst;
echo "   Rafale envoyée en " . round($burstDuration * 1000) . " ms\n";

// Étape 6 — Comptage côté client
$accepted = 0; $lateAccepted = 0; $tooLate = 0; $errors = 0;
foreach ($results as $nick => $r) {
    if (!is_array($r)) { $errors++; continue; }
    if (!empty($r['success'])) {
        $accepted++;
        if (!empty($r['lateAccepted'])) $lateAccepted++;
    } elseif (!empty($r['tooLate'])) {
        $tooLate++;
    } else {
        $errors++;
    }
}

echo "\n--- Verdict côté client (réponse à submit) ---\n";
echo "  Acceptées          : $accepted / $nPlayers\n";
echo "  dont rétroactives  : $lateAccepted\n";
echo "  Rejetées tooLate   : $tooLate\n";
echo "  Erreurs            : $errors\n";

// Étape 7 — Forcer la fin de question puis lire les résultats
echo "\n▶️  Étape 7 : force_question_complete + relecture des résultats\n";
postSync($base . '/php/control.php', ['action' => 'force_question_complete', 'playCode' => $playCode, 'questionIndex' => 0, 'teacher_hash' => TEACHER_HASH]);
sleep(1);
$state = getSync($base . '/php/game.php', ['action' => 'get_state', 'playCode' => $playCode, 'nickname' => $nicknames[0]]);
$stats = $state['results']['questionStats'] ?? [];
$missingInResults = 0;
$pointsTotal = 0;
foreach ($nicknames as $nick) {
    $found = false;
    foreach ($stats as $s) {
        if ($s['nickname'] === $nick) {
            $found = true;
            if (empty($s['answered'])) $missingInResults++;
            $pointsTotal += (int) ($s['pointsEarned'] ?? 0);
            break;
        }
    }
    if (!$found) $missingInResults++;
}

echo "  Élèves marqués 'answered=false' dans les résultats : $missingInResults\n";
echo "  Total points distribués : $pointsTotal\n";

// Verdict global
echo "\n========== RÉSULTAT ==========\n";
$pass = ($tooLate === 0 && $missingInResults === 0 && $errors === 0);
if ($pass) {
    echo "✅ PASS — toutes les réponses dernière-seconde ont été acceptées et scorées.\n";
    exit(0);
} else {
    echo "❌ FAIL — bug 'temps écoulé' encore présent ou réponses perdues.\n";
    echo "   tooLate=$tooLate, missingInResults=$missingInResults, errors=$errors\n";
    exit(1);
}
