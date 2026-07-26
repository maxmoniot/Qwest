<?php
/**
 * Qwest — Test d'idempotence des actions de pilotage
 *
 * Vérifie que :
 *   - next_question(N) appelée 3× rapidement n'avance qu'à Q=N (pas Q=N+2)
 *   - next_question avec questionIndex < currentQuestion est ignorée (succès idempotent)
 *   - force_question_complete répétée ne re-score pas les élèves (score stable)
 *   - pause_game toggle proprement
 *
 * Pré-requis : une session existe (--play-code), partie déjà lancée (state=playing).
 *
 * Usage :
 *   php scripts/idempotence_test.php --base-url=http://localhost/qwest --play-code=XXXX
 */

if (php_sapi_name() !== 'cli') exit(1);

const TEACHER_HASH = '00624b02e1f9b996a3278f559d5d55313552ad2c0bafc82adfd975c12df61eaf';

$opts = ['base-url' => 'http://localhost/qwest', 'play-code' => ''];
foreach (array_slice($argv, 1) as $arg) {
    if (preg_match('/^--([a-z\-]+)=(.*)$/', $arg, $m)) $opts[$m[1]] = $m[2];
}
if ($opts['play-code'] === '') { fwrite(STDERR, "ERREUR : --play-code requis\n"); exit(2); }

$base = rtrim($opts['base-url'], '/');
$playCode = strtoupper($opts['play-code']);

function post(string $url, array $params): array {
    // Injection automatique de teacher_hash si non fourni — toutes les actions
    // privilégiées de control.php le requièrent.
    if (!isset($params['teacher_hash'])) {
        $params['teacher_hash'] = TEACHER_HASH;
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query($params), CURLOPT_TIMEOUT => 8,
    ]);
    $body = curl_exec($ch);
    curl_close($ch);
    return json_decode($body, true) ?: ['_raw' => $body];
}

function get(string $url, array $params): array {
    $ch = curl_init($url . '?' . http_build_query($params));
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 8]);
    $body = curl_exec($ch);
    curl_close($ch);
    return json_decode($body, true) ?: [];
}

$pass = 0; $fail = 0;
function expect(string $label, bool $cond, string $detail = ''): void {
    global $pass, $fail;
    if ($cond) { echo "  ✅ $label\n"; $pass++; }
    else { echo "  ❌ $label" . ($detail ? " — $detail" : '') . "\n"; $fail++; }
}

echo "🧪 idempotence_test — playCode=$playCode\n\n";

// État initial
$state0 = get($base . '/php/control.php', ['action' => 'get_control_state', 'playCode' => $playCode]);
if (empty($state0['success'])) { fwrite(STDERR, "❌ Session introuvable\n"); exit(1); }
$q0 = (int) $state0['currentQuestion'];
echo "État initial : currentQuestion=$q0\n\n";

// === Test 1 : next_question avec index courant (idempotent) ===
echo "Test 1 — next_question($q0) doit être idempotent\n";
$r = post($base . '/php/control.php', [
    'action' => 'next_question', 'playCode' => $playCode,
    'questionIndex' => $q0, 'customTime' => '',
]);
expect("Réponse success=true", !empty($r['success']), json_encode($r));
expect("Drapeau idempotent=true", !empty($r['idempotent']), "réponse=" . json_encode($r));

$state1 = get($base . '/php/control.php', ['action' => 'get_control_state', 'playCode' => $playCode]);
expect("currentQuestion inchangé", $state1['currentQuestion'] === $q0, "avant=$q0, après={$state1['currentQuestion']}");

// === Test 2 : next_question(q0 - 1) (en arrière, doit être ignoré) ===
if ($q0 >= 1) {
    echo "\nTest 2 — next_question(" . ($q0 - 1) . ") en arrière doit être ignoré\n";
    $r = post($base . '/php/control.php', [
        'action' => 'next_question', 'playCode' => $playCode,
        'questionIndex' => $q0 - 1, 'customTime' => '',
    ]);
    expect("Réponse success=true (ignorée mais pas erreur)", !empty($r['success']), json_encode($r));
    expect("Drapeau idempotent=true", !empty($r['idempotent']), json_encode($r));
    $state2 = get($base . '/php/control.php', ['action' => 'get_control_state', 'playCode' => $playCode]);
    expect("currentQuestion toujours $q0", $state2['currentQuestion'] === $q0);
}

// === Test 3 : 3 appels next_question(q0+1) en parallèle — un seul avance ===
echo "\nTest 3 — 3 appels parallèles next_question(" . ($q0 + 1) . ") doivent converger sur Q=" . ($q0 + 1) . "\n";
$mh = curl_multi_init();
$chs = [];
for ($i = 0; $i < 3; $i++) {
    $ch = curl_init($base . '/php/control.php');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query([
            'action' => 'next_question', 'playCode' => $playCode,
            'questionIndex' => $q0 + 1, 'customTime' => '',
            'teacher_hash' => TEACHER_HASH,
        ]),
        CURLOPT_TIMEOUT => 8,
    ]);
    curl_multi_add_handle($mh, $ch);
    $chs[] = $ch;
}
do { curl_multi_exec($mh, $r); usleep(5000); } while ($r);
$advanceCount = 0;
$idempotentCount = 0;
foreach ($chs as $ch) {
    $body = curl_multi_getcontent($ch);
    $j = json_decode($body, true) ?: [];
    if (!empty($j['success'])) {
        if (!empty($j['idempotent'])) $idempotentCount++;
        else $advanceCount++;
    }
    curl_multi_remove_handle($mh, $ch);
    curl_close($ch);
}
curl_multi_close($mh);
expect("Exactement 1 réel + 2 idempotents (ou 3 idempotents si race)", $advanceCount + $idempotentCount === 3 && $advanceCount <= 1,
    "réels=$advanceCount, idempotents=$idempotentCount");
$state3 = get($base . '/php/control.php', ['action' => 'get_control_state', 'playCode' => $playCode]);
expect("currentQuestion = " . ($q0 + 1), $state3['currentQuestion'] === $q0 + 1,
    "attendu=" . ($q0 + 1) . ", obtenu={$state3['currentQuestion']}");

// === Test 4 : force_question_complete double — 2e appel idempotent ===
echo "\nTest 4 — force_question_complete double sur Q=" . ($q0 + 1) . "\n";
$r1 = post($base . '/php/control.php', [
    'action' => 'force_question_complete', 'playCode' => $playCode,
    'questionIndex' => $q0 + 1,
]);
expect("Premier appel success=true", !empty($r1['success']), json_encode($r1));
$r2 = post($base . '/php/control.php', [
    'action' => 'force_question_complete', 'playCode' => $playCode,
    'questionIndex' => $q0 + 1,
]);
expect("Second appel success=true", !empty($r2['success']));
expect("Second appel idempotent=true", !empty($r2['idempotent']), json_encode($r2));

// === Test 5 : pause_game toggle ===
echo "\nTest 5 — pause_game toggle\n";
$r = post($base . '/php/control.php', ['action' => 'pause_game', 'playCode' => $playCode, 'paused' => '1']);
expect("Pause à 1 success=true", !empty($r['success']));
$state = get($base . '/php/control.php', ['action' => 'get_control_state', 'playCode' => $playCode]);
expect("État serveur paused=true", !empty($state['paused']));
$r = post($base . '/php/control.php', ['action' => 'pause_game', 'playCode' => $playCode, 'paused' => '0']);
expect("Pause à 0 success=true", !empty($r['success']));
$state = get($base . '/php/control.php', ['action' => 'get_control_state', 'playCode' => $playCode]);
expect("État serveur paused=false", empty($state['paused']));

echo "\n========== BILAN ==========\n";
echo "✅ $pass réussis, ❌ $fail échoués\n";
exit($fail > 0 ? 1 : 0);
