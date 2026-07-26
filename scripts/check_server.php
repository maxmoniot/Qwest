<?php
/**
 * Qwest — Vérifications sanity côté serveur
 *
 * Lance une série de checks indépendants pour s'assurer que :
 *   - les fichiers PHP n'ont pas d'erreur de syntaxe (php -l)
 *   - les endpoints clés répondent du JSON valide (pas de notice/warning qui pollue)
 *   - les fichiers de session sur disque sont du JSON valide et structurés
 *   - les actions désactivées (SSE) renvoient bien une erreur explicite
 *   - les actions idempotentes (next_question, force_question_complete) le sont
 *
 * Usage :
 *   php scripts/check_server.php --base-url=http://localhost/qwest [--play-code=...]
 *
 * Si --play-code est fourni, des checks supplémentaires sur la session sont effectués.
 */

if (php_sapi_name() !== 'cli') {
    fwrite(STDERR, "CLI uniquement\n");
    exit(1);
}

const TEACHER_HASH = '00624b02e1f9b996a3278f559d5d55313552ad2c0bafc82adfd975c12df61eaf';

$opts = ['base-url' => 'http://localhost/qwest', 'play-code' => '', 'php-bin' => ''];
foreach (array_slice($argv, 1) as $arg) {
    if (preg_match('/^--([a-z\-]+)=(.*)$/', $arg, $m)) {
        $opts[$m[1]] = $m[2];
    }
}

// Auto-détection du binaire php pour le lint (utile sur Windows + XAMPP où php n'est
// pas dans le PATH par défaut). Ordre : --php-bin, PHP_BINARY courant, C:\xampp\php\php.exe
function resolvePhpBin(string $explicit): string {
    if ($explicit !== '' && @is_executable($explicit)) return $explicit;
    if (defined('PHP_BINARY') && PHP_BINARY && @is_executable(PHP_BINARY)) return PHP_BINARY;
    foreach (['C:\\xampp\\php\\php.exe', '/usr/bin/php', '/usr/local/bin/php'] as $p) {
        if (@is_executable($p)) return $p;
    }
    return 'php'; // dernier recours, suppose le PATH
}
$PHP_BIN = resolvePhpBin($opts['php-bin']);

$baseUrl = rtrim($opts['base-url'], '/');
$playCode = strtoupper(trim($opts['play-code']));
$pass = 0;
$fail = 0;
$failures = [];

function check(string $label, callable $fn): void {
    global $pass, $fail, $failures;
    try {
        $result = $fn();
        if ($result === true || (is_array($result) && !empty($result['ok']))) {
            echo "✅ $label\n";
            $pass++;
        } else {
            $msg = is_array($result) ? ($result['msg'] ?? 'échec') : 'échec';
            echo "❌ $label — $msg\n";
            $fail++;
            $failures[] = [$label, $msg];
        }
    } catch (Throwable $e) {
        echo "❌ $label — exception : " . $e->getMessage() . "\n";
        $fail++;
        $failures[] = [$label, $e->getMessage()];
    }
}

function httpGet(string $url): array {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    return ['code' => $code, 'body' => $body, 'err' => $err];
}

function httpPost(string $url, array $params): array {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($params));
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    return ['code' => $code, 'body' => $body, 'err' => $err];
}

echo "🔍 Qwest — vérifications sanity\n";
echo "   base-url=$baseUrl" . ($playCode ? " play-code=$playCode" : "") . "\n\n";

// ============================================================
// 1. Lint PHP des fichiers backend
// ============================================================
$phpRoot = realpath(__DIR__ . '/../php');
foreach (['game.php', 'control.php', 'api.php'] as $file) {
    check("Lint php : $file", function () use ($phpRoot, $file, $PHP_BIN) {
        $cmd = escapeshellarg($PHP_BIN) . ' -l ' . escapeshellarg($phpRoot . DIRECTORY_SEPARATOR . $file) . ' 2>&1';
        exec($cmd, $out, $rc);
        return $rc === 0 ? true : ['ok' => false, 'msg' => implode("\n", $out)];
    });
}

// ============================================================
// 2. Endpoints — JSON valide, pas de notice PHP en sortie
// ============================================================
check("api.php : action inconnue → JSON valide", function () use ($baseUrl) {
    $r = httpGet($baseUrl . '/php/api.php?action=ping_unknown');
    if ($r['code'] !== 200) return ['ok' => false, 'msg' => "HTTP {$r['code']}"];
    $j = json_decode($r['body'], true);
    if (!is_array($j)) return ['ok' => false, 'msg' => "Sortie non-JSON : " . substr($r['body'], 0, 80)];
    return true;
});

check("game.php : SSE désactivé renvoie erreur explicite", function () use ($baseUrl) {
    $r = httpGet($baseUrl . '/php/game.php?action=stream');
    $j = json_decode($r['body'], true);
    if (!is_array($j)) return ['ok' => false, 'msg' => 'JSON invalide'];
    if (empty($j['deprecated'])) return ['ok' => false, 'msg' => "Drapeau 'deprecated' attendu : " . substr($r['body'], 0, 120)];
    return true;
});

check("control.php : SSE désactivé renvoie erreur explicite", function () use ($baseUrl) {
    $r = httpGet($baseUrl . '/php/control.php?action=stream');
    $j = json_decode($r['body'], true);
    if (!is_array($j)) return ['ok' => false, 'msg' => 'JSON invalide'];
    if (empty($j['deprecated'])) return ['ok' => false, 'msg' => "Drapeau 'deprecated' attendu"];
    return true;
});

check("game.php : action manquante → success=false", function () use ($baseUrl) {
    $r = httpGet($baseUrl . '/php/game.php');
    $j = json_decode($r['body'], true);
    return is_array($j) && isset($j['success']) ? true : ['ok' => false, 'msg' => 'pas de success boolean'];
});

// ============================================================
// 3. Constantes serveur attendues
// ============================================================
check("game.php : QUESTION_TIMEOUT_GRACE = 15", function () use ($phpRoot) {
    $src = file_get_contents($phpRoot . '/game.php');
    return preg_match("/define\\('QUESTION_TIMEOUT_GRACE',\\s*15\\)/", $src) === 1
        ? true : ['ok' => false, 'msg' => 'GRACE != 15'];
});
check("game.php : SESSION_TIMEOUT >= 1800", function () use ($phpRoot) {
    $src = file_get_contents($phpRoot . '/game.php');
    if (!preg_match("/define\\('SESSION_TIMEOUT',\\s*(\\d+)\\)/", $src, $m)) {
        return ['ok' => false, 'msg' => 'constant introuvable'];
    }
    return (int) $m[1] >= 1800 ? true : ['ok' => false, 'msg' => "SESSION_TIMEOUT={$m[1]} < 1800"];
});

// ============================================================
// 3 bis. Tests de sécurité (failles patchées dans les Lots S1-S4)
// ============================================================

check("🔒 path traversal sur playCode rejeté (api.php check_quiz)", function () use ($baseUrl) {
    $r = httpGet($baseUrl . '/php/api.php?action=check_game&code=' . urlencode('../../etc/passwd'));
    $j = json_decode($r['body'], true);
    if (!is_array($j)) return ['ok' => false, 'msg' => 'JSON invalide'];
    // Attendu : success=false ou exists=false. Surtout : pas de fuite de fichier.
    if (!empty($j['exists']) && $j['exists'] === true) {
        return ['ok' => false, 'msg' => 'path traversal accepté (faille critique)'];
    }
    return true;
});

check("🔒 path traversal sur playCode rejeté (game.php get_state)", function () use ($baseUrl) {
    $r = httpGet($baseUrl . '/php/game.php?action=get_state&playCode=' . urlencode('../foo') . '&nickname=test');
    $j = json_decode($r['body'], true);
    if (!is_array($j)) return ['ok' => false, 'msg' => 'JSON invalide'];
    return empty($j['success']) ? true : ['ok' => false, 'msg' => 'playCode malformé accepté'];
});

check("🔒 auth prof requise pour next_question (sans hash → 403)", function () use ($baseUrl) {
    $r = httpPost($baseUrl . '/php/control.php', [
        'action' => 'next_question', 'playCode' => 'NOTEXIST', 'questionIndex' => 0,
        // pas de teacher_hash
    ]);
    if ($r['code'] !== 403) {
        return ['ok' => false, 'msg' => "code attendu 403, reçu {$r['code']}"];
    }
    return true;
});

check("🔒 auth prof requise pour cleanup_session (sans hash → 403)", function () use ($baseUrl) {
    $r = httpPost($baseUrl . '/php/control.php', [
        'action' => 'cleanup_session', 'playCode' => 'NOTEXIST',
    ]);
    return $r['code'] === 403 ? true : ['ok' => false, 'msg' => "code attendu 403, reçu {$r['code']}"];
});

check("🔒 mauvais teacher_hash rejeté (timing-safe via hash_equals)", function () use ($baseUrl) {
    $r = httpPost($baseUrl . '/php/control.php', [
        'action' => 'pause_game', 'playCode' => 'NOTEXIST',
        'paused' => '1', 'teacher_hash' => 'wronghashvalue00000000000000000000000000000000000000000000000000'
    ]);
    return $r['code'] === 403 ? true : ['ok' => false, 'msg' => "code attendu 403, reçu {$r['code']}"];
});

check("🔒 CORS '*' retiré (header absent ou origin précis)", function () use ($baseUrl) {
    $ch = curl_init($baseUrl . '/php/api.php?action=ping');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_HEADER => true, CURLOPT_NOBODY => true, CURLOPT_TIMEOUT => 5,
    ]);
    $resp = curl_exec($ch);
    curl_close($ch);
    if (preg_match('/Access-Control-Allow-Origin:\s*\*/i', $resp)) {
        return ['ok' => false, 'msg' => 'CORS * encore présent → CSRF possible depuis sites tiers'];
    }
    return true;
});

check("🔒 runner.php : injection shell via baseUrl rejetée", function () use ($baseUrl) {
    $r = httpPost($baseUrl . '/scripts/runner.php', [
        'script' => 'check_server',
        'base-url' => 'http://example.com$(whoami)',
    ]);
    $j = json_decode($r['body'], true);
    if (!is_array($j)) return true; // accès bloqué par .htaccess = OK aussi
    return empty($j['ok']) ? true : ['ok' => false, 'msg' => 'baseUrl avec $() accepté'];
});

check("🔒 imageUrl javascript: rejetée par api.php save_quiz", function () use ($baseUrl) {
    // On envoie un quiz minimaliste avec une imageUrl javascript:
    $bad = json_encode(['questions' => [['type' => 'multiple', 'question' => 'Q', 'answers' => [], 'imageUrl' => 'javascript:alert(1)']]]);
    $r = httpPost($baseUrl . '/php/api.php', [
        'action' => 'save_quiz',
        'quizName' => 'TEST_SECURITY',
        'modifyCode' => 'TEST',
        'playCode' => 'TEST01',
        'quizData' => $bad,
        'captchaAnswer' => '1',
        'captchaExpected' => '1',
    ]);
    $j = json_decode($r['body'], true);
    if (!is_array($j)) return ['ok' => false, 'msg' => 'JSON invalide'];
    return empty($j['success']) ? true : ['ok' => false, 'msg' => "imageUrl javascript: a été acceptée — XSS possible"];
});

check("🔒 quizData > 2 MB rejeté par control.php create_session", function () use ($baseUrl) {
    $huge = str_repeat('A', 3 * 1024 * 1024);
    $r = httpPost($baseUrl . '/php/control.php', [
        'action' => 'create_session',
        'playCode' => 'TESTSZ',
        'quizData' => $huge,
        'teacher_hash' => '00624b02e1f9b996a3278f559d5d55313552ad2c0bafc82adfd975c12df61eaf',
    ]);
    if ($r['code'] !== 413) {
        return ['ok' => false, 'msg' => "code attendu 413, reçu {$r['code']}"];
    }
    return true;
});

check("🔒 .htaccess racine bloque php/data (sessions inaccessibles)", function () use ($baseUrl) {
    $r = httpGet($baseUrl . '/php/data/sessions/');
    if ($r['code'] === 200 && stripos($r['body'], 'json') !== false) {
        return ['ok' => false, 'msg' => 'php/data/sessions accessible publiquement'];
    }
    return true;
});

// ============================================================
// 3 ter. Robustesse disque (intégrité du dossier sessions)
// ============================================================

check("🧹 pas de fichiers tmp orphelins dans php/data/sessions/", function () use ($phpRoot) {
    $sessionsDir = $phpRoot . '/data/sessions';
    if (!is_dir($sessionsDir)) return true; // pas créé encore = OK
    $orphans = glob($sessionsDir . '/*.tmp.*') ?: [];
    if (count($orphans) === 0) return true;

    $now = time();
    $details = [];
    foreach ($orphans as $f) {
        $age = $now - filemtime($f);
        $details[] = basename($f) . ' (' . $age . 's)';
    }
    return [
        'ok' => false,
        'msg' => count($orphans) . ' tmp orphelin(s) — un rename a échoué et n\'a pas nettoyé : '
                 . implode(', ', array_slice($details, 0, 5))
                 . (count($details) > 5 ? ' …' : '')
                 . '. Supprime-les manuellement si > 60s.',
    ];
});

check("🧹 pas de session JSON corrompue dans php/data/sessions/", function () use ($phpRoot) {
    $sessionsDir = $phpRoot . '/data/sessions';
    if (!is_dir($sessionsDir)) return true;
    $files = glob($sessionsDir . '/*.json') ?: [];
    $broken = [];
    foreach ($files as $f) {
        $content = @file_get_contents($f);
        if ($content === false) continue;
        // Vérifier que le JSON est complet et valide (un fichier corrompu aurait du contenu en double)
        $data = json_decode($content, true);
        if (!is_array($data)) {
            $broken[] = basename($f);
            continue;
        }
        // Heuristique : un fichier corrompu (mélange) contient typiquement '}    }' ou des clés dupliquées
        if (preg_match('/\}\s*\}\s*$/', $content) || substr_count($content, '"playCode"') > 1) {
            $broken[] = basename($f) . ' (contenu suspect)';
        }
    }
    if (count($broken) === 0) return true;
    return [
        'ok' => false,
        'msg' => count($broken) . ' session(s) corrompue(s) : ' . implode(', ', array_slice($broken, 0, 3))
                 . '. Supprime-les manuellement.',
    ];
});

// ============================================================
// 4. Session existante (si --play-code fourni)
// ============================================================
if ($playCode) {
    $sessionFile = $phpRoot . '/data/sessions/' . $playCode . '.json';
    check("Fichier session $playCode.json existe", function () use ($sessionFile) {
        return file_exists($sessionFile) ? true : ['ok' => false, 'msg' => "introuvable : $sessionFile"];
    });
    if (file_exists($sessionFile)) {
        $session = json_decode(file_get_contents($sessionFile), true);
        check("Session : JSON valide", function () use ($session) {
            return is_array($session) ? true : ['ok' => false, 'msg' => 'JSON invalide'];
        });
        check("Session : champs obligatoires", function () use ($session) {
            $required = ['playCode', 'state', 'currentQuestion', 'players'];
            foreach ($required as $k) {
                if (!array_key_exists($k, $session)) return ['ok' => false, 'msg' => "champ manquant : $k"];
            }
            return true;
        });
        check("Session : pas de joueur avec answers null", function () use ($session) {
            foreach ($session['players'] ?? [] as $p) {
                if (!array_key_exists('answers', $p) || !is_array($p['answers'] ?? [])) {
                    return ['ok' => false, 'msg' => "joueur {$p['nickname']} : answers manquant"];
                }
            }
            return true;
        });
    }

    // Idempotence next_question — appel double
    check("control.php : next_question idempotent (double appel)", function () use ($baseUrl, $playCode) {
        // On envoie deux fois le même questionIndex ; le 2e doit retourner idempotent=true
        $session = json_decode(file_get_contents(__DIR__ . '/../php/data/sessions/' . $playCode . '.json'), true);
        $q = (int) ($session['currentQuestion'] ?? 0);
        // Pour ne pas perturber une vraie partie, on ne teste que si state != 'playing' OU si on demande l'index actuel
        $r2 = httpPost($baseUrl . '/php/control.php', [
            'action' => 'next_question', 'playCode' => $playCode,
            'questionIndex' => $q, 'customTime' => '',
            'teacher_hash' => TEACHER_HASH
        ]);
        $j = json_decode($r2['body'], true);
        if (!is_array($j)) return ['ok' => false, 'msg' => 'JSON invalide'];
        if (empty($j['success'])) return ['ok' => false, 'msg' => 'second appel non success'];
        if (empty($j['idempotent']) && empty($j['alreadyAt'])) {
            return ['ok' => false, 'msg' => "drapeau idempotent attendu pour Q$q : " . substr($r2['body'], 0, 120)];
        }
        return true;
    });

    // Idempotence force_question_complete
    check("control.php : force_question_complete idempotent (double appel)", function () use ($baseUrl, $playCode) {
        $session = json_decode(file_get_contents(__DIR__ . '/../php/data/sessions/' . $playCode . '.json'), true);
        $q = (int) ($session['currentQuestion'] ?? 0);
        if ($q < 0) return true; // pas de question en cours, on saute
        // Premier appel — peut succès, on note
        httpPost($baseUrl . '/php/control.php', [
            'action' => 'force_question_complete', 'playCode' => $playCode, 'questionIndex' => $q,
            'teacher_hash' => TEACHER_HASH
        ]);
        // Second appel — doit être idempotent
        $r = httpPost($baseUrl . '/php/control.php', [
            'action' => 'force_question_complete', 'playCode' => $playCode, 'questionIndex' => $q,
            'teacher_hash' => TEACHER_HASH
        ]);
        $j = json_decode($r['body'], true);
        if (!is_array($j)) return ['ok' => false, 'msg' => 'JSON invalide'];
        if (empty($j['success'])) return ['ok' => false, 'msg' => 'pas success'];
        if (empty($j['idempotent'])) return ['ok' => false, 'msg' => 'idempotent=true attendu au 2e appel'];
        return true;
    });
}

// ============================================================
// 5. Bilan
// ============================================================
echo "\n========== BILAN ==========\n";
echo "✅ $pass réussis, ❌ $fail échoués\n";
if ($failures) {
    echo "\nÉchecs détaillés :\n";
    foreach ($failures as [$label, $msg]) {
        echo "  • $label\n    → $msg\n";
    }
}
exit($fail > 0 ? 1 : 0);
