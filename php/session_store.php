<?php
// ============================================
// QWEST - SESSION STORE (helpers partagés game.php / control.php)
// ============================================
//
// Architecture anti lost-update pour hébergement MUTUALISÉ (OVH = cluster de
// frontaux + stockage NFS : flock n'est PAS garanti entre nœuds, et une lecture
// peut renvoyer un cache périmé). Mesuré le 12/06/2026 : 45 écritures
// next_question pourtant faites sous flock ont été englouties par des écritures
// concurrentes porteuses d'une copie périmée. La parade n'est pas un meilleur
// verrou (impossible sur cette infra) mais une SÉPARATION DES ÉCRIVAINS :
//
//   1. CODE.json        (legacy)  : joueurs (réponses, pings), quizData, animaux.
//                                   Multi-écrivains sous flock. Plus AUCUNE donnée
//                                   critique : tout y est re-dérivable ou cosmétique.
//   2. CODE.state.json            : état de pilotage (state, currentQuestion,
//                                   questionStartTime, paused…). Écrit UNIQUEMENT
//                                   par les actions prof de control.php → un seul
//                                   écrivain logique (les actions d'un même prof
//                                   sont séquentielles) → ne peut plus être englouti
//                                   par les requêtes élèves.
//   3. CODE.done.q<N>.json        : complétion de la question N. IMMUABLE : créé en
//                                   mode exclusif ('x'), jamais réécrit. Son
//                                   EXISTENCE vaut vérité ; il contient l'instant de
//                                   complétion et le classement FIGÉ (anti-
//                                   scintillement du Top 3). Un fichier qu'on ne
//                                   réécrit jamais ne peut pas subir de lost update.
//
//   Scores : DÉRIVÉS des réponses à la lecture (qst_decorateSession). Jamais
//   stockés. → un score ne peut être ni perdu ni compté double, même si une
//   écriture concurrente écrase une mise à jour de réponse (la réponse elle-même
//   est en plus re-confirmée côté client via le champ myAnswered de get_state).
//
// Toutes les fonctions sont préfixées qst_ (pas de collision avec les helpers
// existants des deux includers). SESSIONS_DIR doit être défini par l'includer.

// --------------------------------------------
// Verrou séparé + écriture ATOMIQUE des fichiers de session
// --------------------------------------------
// Mesuré le 12/06/2026 sur OVH (cluster) : deux réécritures IN-PLACE simultanées du
// CODE.json depuis deux nœuds (leurs flock ne s'excluent pas mutuellement) se sont
// ENTRELACÉES → JSON invalide PERSISTANT → session morte pour toute la classe (toutes
// les requêtes en échec jusqu'à la fin). La parade :
//   - écriture par tmp + rename() : ATOMIQUE — un lecteur voit l'ancien ou le nouveau
//     contenu, JAMAIS un mélange. Deux écrivains concurrents = au pire une écriture
//     perdue (déjà auto-réparée par la confirmation myAnswered côté client) ;
//   - le verrou vit sur un fichier SÉPARÉ (CODE.lock), jamais renommé : verrouiller le
//     .json lui-même deviendrait orphelin après un rename (le waiter local garderait
//     l'ancien inode et écraserait la mise à jour) ;
//   - sous Windows local (XAMPP, mono-nœud où flock est fiable), rename échoue si un
//     handle est ouvert → on conserve l'écriture in-place historique.

/**
 * Horloge serveur en MILLISECONDES (epoch ms). Référence unique de temps pour la
 * synchronisation v2 : c'est CE serveur qui fait autorité (pas un serveur de temps
 * externe). Renvoyée dans chaque réponse (serverTimeMs) et utilisée pour planifier
 * l'instant absolu d'apparition des questions (revealAt). Les clients estiment leur
 * décalage (offset) par handshake et alignent leur horloge dessus.
 */
function qst_nowMs() {
    return (int) round(microtime(true) * 1000);
}

// --------------------------------------------
// FILET ANTI-500 + capture de crash (robustesse « classe entière »)
// --------------------------------------------
// Leçon du 18/06 : un seul mauvais enregistrement (réponse stockée en tableau) faisait
// lever une TypeError FATALE à CHAQUE get_state (scores dérivés à la lecture) → HTTP 500
// pour TOUS → circuit breaker ouvert partout → partie figée jusqu'à la fin, et le prof
// lui-même bloqué (son get_control_state en 500). Un 500 nu est donc catastrophique en
// classe. Parade : tout crash (exception PHP 8 — TypeError incluse — OU fatal) est
// intercepté, tracé avec sa cause EXACTE (fichier:ligne), et converti en JSON dégradé
// HTTP 200 → le client le traite comme un hoquet transitoire et repart au poll suivant.

/** Journalise une erreur serveur avec sa cause exacte dans php/data/metrics/errors-*.log. */
function qst_logServerError($kind, $message, $file, $lineNo, $extra = '') {
    $dir = __DIR__ . '/data/metrics';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    if (!is_writable($dir)) return;
    $clean = function($v) { return str_replace(["\t", "\n", "\r"], ' ', (string)$v); };
    $ep = $_GET['action'] ?? $_POST['action'] ?? '?';
    $pc = $_GET['playCode'] ?? $_POST['playCode'] ?? '';
    $nk = $_GET['nickname'] ?? $_POST['nickname'] ?? '';
    $ip = $_SERVER['REMOTE_ADDR'] ?? '?';
    $row = implode("\t", [
        date('Y-m-d H:i:s'), $clean($ip), $clean($ep),
        $clean(substr((string)$pc, 0, 16)), $clean(substr((string)$nk, 0, 50)),
        $clean($kind), $clean($file . ':' . $lineNo),
        $clean(substr((string)$message, 0, 300)), $clean(substr((string)$extra, 0, 120)),
    ]) . "\n";
    @file_put_contents($dir . '/errors-' . date('Y-m-d') . '.log', $row, FILE_APPEND);
    // Trace aussi dans le log de volume (colonne details) pour corréler avec le trafic.
    if (function_exists('setMetricDetail')) {
        setMetricDetail('err', $kind);
        setMetricDetail('errmsg', substr((string)$message, 0, 120));
    }
}

/** Jette toute sortie partielle et renvoie un JSON dégradé en HTTP 200 (jamais un 500 nu). */
function qst_emitDegradedJson() {
    // Garde anti-double-émission : l'exception-handler ET le shutdown peuvent se déclencher.
    if (!empty($GLOBALS['__qst_degraded'])) return;
    $GLOBALS['__qst_degraded'] = true;
    while (ob_get_level() > 0) { @ob_end_clean(); }
    if (!headers_sent()) {
        http_response_code(200);
        header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode([
        'success' => false,
        'serverError' => true,
        'transient' => true,   // → le client retente au poll suivant, n'ouvre PAS le circuit breaker
        'message' => 'Hoquet serveur — réessaie',
    ]);
}

/**
 * Arme le filet : handler d'exception + handler de fatal au shutdown. À appeler TÔT,
 * avant tout traitement (et avant le throttle, pour couvrir aussi ce chemin).
 * $manageBuffer : démarre un tampon de sortie pour pouvoir jeter une sortie partielle
 * si le crash survient en cours d'echo. api.php gère déjà son propre ob_start → false.
 */
function qst_registerErrorNet($manageBuffer = true) {
    if ($manageBuffer && function_exists('ob_start')) { @ob_start(); }
    set_exception_handler(function($e) {
        qst_logServerError('exception', $e->getMessage(), $e->getFile(), $e->getLine(),
                           get_class($e));
        qst_emitDegradedJson();
    });
    register_shutdown_function(function() {
        $e = error_get_last();
        if ($e && in_array($e['type'],
            [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR], true)) {
            qst_logServerError('fatal', $e['message'], $e['file'], $e['line']);
            qst_emitDegradedJson();
        }
    });
}

function qst_sessionLockFile($playCode) {
    return SESSIONS_DIR . '/' . $playCode . '.lock';
}

/** Acquiert le verrou de session (fichier CODE.lock). Retourne le handle ou null. */
function qst_acquireSessionLock($playCode, $maxWaitSec = 3) {
    $playCode = validatePlayCode($playCode);
    if ($playCode === null) return null;
    $fp = @fopen(qst_sessionLockFile($playCode), 'c+');
    if (!$fp) return null;
    $start = microtime(true);
    do {
        if (flock($fp, LOCK_EX | LOCK_NB)) return $fp;
        if ((microtime(true) - $start) >= $maxWaitSec) break;
        usleep(50000);
    } while (true);
    fclose($fp);
    return null;
}

function qst_releaseSessionLock($fp) {
    if ($fp) { @flock($fp, LOCK_UN); @fclose($fp); }
}

/**
 * Écrit un fichier de données de session de façon ATOMIQUE pour les lecteurs :
 * tmp + rename sur Linux/OVH (jamais de contenu déchiré), in-place sous Windows.
 * À appeler UNIQUEMENT sous verrou (qst_acquireSessionLock / qst_loadStateForUpdate).
 */
function qst_atomicWriteFile($file, $content) {
    if (DIRECTORY_SEPARATOR === '\\') {
        $fh = @fopen($file, 'c');
        if (!$fh) return false;
        ftruncate($fh, 0);
        fwrite($fh, $content);
        fflush($fh);
        fclose($fh);
        return true;
    }
    $tmp = $file . '.tmp.' . uniqid('', true);
    if (@file_put_contents($tmp, $content) === false) { @unlink($tmp); return false; }
    if (@rename($tmp, $file)) return true;
    @unlink($tmp);
    // Repli (rename refusé par le FS) : in-place — mieux que perdre la mise à jour.
    $fh = @fopen($file, 'c');
    if (!$fh) return false;
    ftruncate($fh, 0);
    fwrite($fh, $content);
    fflush($fh);
    fclose($fh);
    return true;
}

// --------------------------------------------
// Fichier d'état (CODE.state.json)
// --------------------------------------------

function qst_stateFile($playCode) {
    return SESSIONS_DIR . '/' . $playCode . '.state.json';
}

/** Lecture sans verrou de l'état de pilotage. Retourne null si absent/illisible. */
function qst_loadState($playCode) {
    $playCode = validatePlayCode($playCode);
    if ($playCode === null) return null;
    $f = qst_stateFile($playCode);
    if (!file_exists($f)) return null;
    $raw = @file_get_contents($f);
    if ($raw === false || $raw === '') return null;
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

/**
 * Charge et verrouille l'état pour modification (actions prof uniquement).
 * Le verrou vit sur CODE.state.lock (séparé, jamais renommé) ; la lecture du
 * state.json se fait APRÈS acquisition (fraîcheur garantie en local).
 */
function qst_loadStateForUpdate($playCode, $maxWaitSec = 2) {
    $playCode = validatePlayCode($playCode);
    if ($playCode === null) return [null, null];
    $f = qst_stateFile($playCode);
    if (!file_exists($f)) return [null, null];

    $fp = @fopen(SESSIONS_DIR . '/' . $playCode . '.state.lock', 'c+');
    if (!$fp) return [null, null];

    $lockAcquired = false;
    $startTime = microtime(true);
    do {
        if (flock($fp, LOCK_EX | LOCK_NB)) { $lockAcquired = true; break; }
        if ((microtime(true) - $startTime) >= $maxWaitSec) break;
        usleep(30000);
    } while (true);

    if (!$lockAcquired) {
        fclose($fp);
        return [null, null];
    }

    $raw = @file_get_contents($f);
    $data = $raw ? json_decode($raw, true) : null;
    if (!is_array($data)) {
        flock($fp, LOCK_UN);
        fclose($fp);
        return [null, null];
    }
    return [$data, $fp];
}

/** Écrit l'état (atomique pour les lecteurs) et libère. rev/updatedAt maintenus ici. */
function qst_saveStateAndUnlock($playCode, $state, $fp) {
    $state['rev'] = (int)($state['rev'] ?? 0) + 1;
    $state['updatedAt'] = time();
    $content = json_encode($state);
    if ($content === false || !$fp) {
        if ($fp) { @flock($fp, LOCK_UN); @fclose($fp); }
        return false;
    }
    $ok = qst_atomicWriteFile(qst_stateFile($playCode), $content);
    flock($fp, LOCK_UN);
    fclose($fp);
    return $ok;
}

/** Création initiale de l'état (tmp+rename : pas de race, le fichier n'existe pas). */
function qst_initState($playCode, array $fields) {
    $playCode = validatePlayCode($playCode);
    if ($playCode === null) return false;
    $state = array_merge([
        'playCode' => $playCode,
        'state' => 'waiting',
        'currentQuestion' => -1,
        'questionStartTime' => 0,
        // Instant ABSOLU (ms serveur) d'apparition de la question courante — fait foi
        // pour la révélation alignée et le timer visuel côté clients (synchro v2).
        'questionRevealAt' => 0,
        'customTime' => null,
        'startTime' => 0,
        'endTime' => 0,
        'paused' => false,
        'manualMode' => false,
        'showTop3' => true,
        'scoreAdjusts' => [],
        'rev' => 1,
        'updatedAt' => time(),
    ], $fields);
    $f = qst_stateFile($playCode);
    $tmp = $f . '.tmp.' . uniqid('', true);
    if (@file_put_contents($tmp, json_encode($state)) === false) { @unlink($tmp); return false; }
    if (!@rename($tmp, $f)) { @unlink($tmp); return false; }
    return true;
}

/**
 * Filet de migration : si une session existe sans fichier d'état (créée par une
 * version antérieure, mi-journée de déploiement), on le crée depuis la session.
 */
function qst_ensureState($playCode, array $session) {
    if (qst_loadState($playCode) !== null) return;
    qst_initState($playCode, [
        'state' => $session['state'] ?? 'waiting',
        'currentQuestion' => $session['currentQuestion'] ?? -1,
        'questionStartTime' => $session['questionStartTime'] ?? 0,
        'customTime' => $session['customTime'] ?? null,
        'startTime' => $session['startTime'] ?? 0,
        'endTime' => $session['endTime'] ?? 0,
        'paused' => (bool)($session['paused'] ?? false),
        'manualMode' => (bool)($session['manualMode'] ?? false),
        'showTop3' => (bool)($session['showTop3'] ?? true),
    ]);
}

// --------------------------------------------
// Fichiers de complétion immuables (CODE.done.q<N>.json)
// --------------------------------------------

function qst_doneFile($playCode, $q) {
    return SESSIONS_DIR . '/' . $playCode . '.done.q' . intval($q) . '.json';
}

function qst_doneExists($playCode, $q) {
    $playCode = validatePlayCode($playCode);
    if ($playCode === null || intval($q) < 0) return false;
    return file_exists(qst_doneFile($playCode, $q));
}

function qst_loadDone($playCode, $q) {
    $playCode = validatePlayCode($playCode);
    if ($playCode === null || intval($q) < 0) return null;
    $f = qst_doneFile($playCode, $q);
    if (!file_exists($f)) return null;
    $raw = @file_get_contents($f);
    $data = $raw ? json_decode($raw, true) : null;
    return is_array($data) ? $data : null;
}

/**
 * Marque la question $q comme terminée en CRÉANT son fichier done (mode 'x' :
 * échoue si déjà créé → un seul gagnant, jamais de réécriture, donc impossible à
 * engloutir). Le classement figé (scores dérivés à CET instant) est embarqué.
 * Retourne true si CE processus a créé le fichier (l'appelant peut alors logguer
 * l'événement une seule fois), false si déjà fait par un autre.
 */
function qst_createDone($playCode, $q, $reason, array $session, array $state) {
    $playCode = validatePlayCode($playCode);
    $q = intval($q);
    if ($playCode === null || $q < 0) return false;
    $f = qst_doneFile($playCode, $q);
    if (file_exists($f)) return false;

    // Classement figé : scores dérivés des réponses connues à cet instant.
    $decorated = qst_decorateSession($session, $state);
    $ranking = [];
    foreach (($decorated['players'] ?? []) as $p) {
        $ranking[] = [
            'nickname' => $p['nickname'] ?? '',
            'score' => (int)($p['score'] ?? 0),
            'connected' => (bool)($p['connected'] ?? false),
        ];
    }
    usort($ranking, function($a, $b) {
        $d = $b['score'] - $a['score'];
        if ($d !== 0) return $d;
        return strcmp($a['nickname'], $b['nickname']);
    });

    $payload = json_encode([
        'q' => $q,
        'completedTime' => time(),
        'reason' => $reason,
        'ranking' => $ranking,
    ]);

    // Création exclusive : 'x' échoue si le fichier existe (créé par un concurrent
    // entre notre test et maintenant) — c'est exactement ce qu'on veut.
    $fp = @fopen($f, 'x');
    if (!$fp) return false;
    fwrite($fp, $payload);
    fflush($fp);
    fclose($fp);
    return true;
}

/**
 * Complétion automatique au timeout : crée le done-file si le temps de la question
 * courante est écoulé (+ grâce). Remplace les anciens checkAndForceQuestionCompletion
 * qui MUTAIENT la session (flags + scores) — source de lost updates.
 * $graceSec : marge après la fin du timer (3 s côté pilotage, 15 s côté élève).
 * Retourne true si la complétion vient d'être créée par cet appel.
 */
function qst_maybeTimeoutComplete($playCode, array $session, array $state, $graceSec) {
    if (($state['state'] ?? '') !== 'playing') return false;
    if (!empty($state['paused'])) return false;
    $q = $state['currentQuestion'] ?? -1;
    if ($q < 0 || qst_doneExists($playCode, $q)) return false;

    $questions = $session['questions'] ?? $session['quizData']['questions'] ?? [];
    if (!isset($questions[$q])) return false;

    $questionTime = $state['customTime'] ?? $questions[$q]['time'] ?? 30;
    $startTime = $state['questionStartTime'] ?? 0;
    if ($startTime <= 0) return false;

    if ((time() - $startTime) >= ($questionTime + $graceSec)) {
        return qst_createDone($playCode, $q, 'timeout', $session, $state);
    }
    return false;
}

// --------------------------------------------
// Scores dérivés
// --------------------------------------------

/**
 * Évalue UNE réponse enregistrée pour UNE question → ['correct' => bool, 'points' => int].
 * Logique strictement identique à l'ancien calculateQuestionScores (multiple/truefalse
 * par index, order par égalité de séquence, freetext avec casse paramétrable et
 * variantes acceptées ; bonus = max(0, round(1000 - timeSpent/100))).
 */
function qst_evaluateAnswer(array $question, array $answerRecord) {
    // TOLÉRANCE ANTI-CRASH (PHP 8) : 'answer' peut être une chaîne JSON (flux normal),
    // un TABLEAU déjà décodé (vieux client en cache ou ré-émission qui a envoyé un objet),
    // ou absent. json_decode(array) lève une TypeError FATALE en PHP 8 → 500 sur CHAQUE
    // get_state (scores dérivés à la lecture) → toute la classe figée. On normalise donc
    // ici sans jamais planter, et même un mauvais enregistrement déjà en base est lu.
    $rawAnswer = $answerRecord['answer'] ?? '';
    if (is_array($rawAnswer)) {
        $playerAnswer = $rawAnswer;
    } elseif (is_string($rawAnswer) && $rawAnswer !== '') {
        $playerAnswer = json_decode($rawAnswer, true);
    } else {
        $playerAnswer = null;
    }
    if (!is_array($playerAnswer)) $playerAnswer = [];
    $timeSpent = (int)($answerRecord['timeSpent'] ?? 0);
    $isCorrect = false;

    switch ($question['type'] ?? '') {
        case 'multiple':
        case 'truefalse':
            $correctIndex = null;
            foreach (($question['answers'] ?? []) as $i => $a) {
                if (!empty($a['correct'])) { $correctIndex = $i; break; }
            }
            $isCorrect = isset($playerAnswer['index']) && $playerAnswer['index'] === $correctIndex;
            break;

        case 'order':
            $correctOrder = array_map(function($a) { return $a['text']; }, $question['answers'] ?? []);
            $isCorrect = isset($playerAnswer['order']) && $playerAnswer['order'] === $correctOrder;
            break;

        case 'freetext':
            if (isset($playerAnswer['freetext'])) {
                $expected = $question['answers'][0]['text'] ?? '';
                $caseSensitive = $question['caseSensitive'] ?? false;
                $userAnswer = $caseSensitive ? trim($playerAnswer['freetext'])
                                             : mb_strtolower(trim($playerAnswer['freetext']), 'UTF-8');
                $expectedCmp = $caseSensitive ? trim($expected)
                                              : mb_strtolower(trim($expected), 'UTF-8');
                $isCorrect = ($userAnswer === $expectedCmp);
                if (!$isCorrect && isset($question['acceptedAnswers'])) {
                    foreach ($question['acceptedAnswers'] as $alt) {
                        $altCmp = $caseSensitive ? trim($alt) : mb_strtolower(trim($alt), 'UTF-8');
                        if ($userAnswer === $altCmp) { $isCorrect = true; break; }
                    }
                }
            }
            break;
    }

    $points = $isCorrect ? max(0, (int)round(1000 - ($timeSpent / 100))) : 0;
    return ['correct' => $isCorrect, 'points' => $points];
}

/**
 * Décore une session (copie) avec les valeurs dérivées : pour chaque joueur,
 * answers[q]['correct'|'points'] et 'score' (somme des points + ajustement prof
 * éventuel state.scoreAdjusts[nickname]). La forme du résultat est identique à ce
 * que produisait l'ancien scoring stocké → tous les consommateurs (résultats,
 * pilotage, CSV, projection) fonctionnent sans changement.
 */
function qst_decorateSession(array $session, array $state) {
    $questions = $session['questions'] ?? $session['quizData']['questions'] ?? [];
    $adjusts = $state['scoreAdjusts'] ?? [];

    foreach (($session['players'] ?? []) as $idx => $player) {
        $score = 0;
        foreach (($player['answers'] ?? []) as $q => $rec) {
            if (!is_array($rec) || !isset($questions[$q])) continue;
            $eval = qst_evaluateAnswer($questions[$q], $rec);
            $session['players'][$idx]['answers'][$q]['correct'] = $eval['correct'];
            $session['players'][$idx]['answers'][$q]['points'] = $eval['points'];
            $score += $eval['points'];
        }
        $nick = $player['nickname'] ?? '';
        if (isset($adjusts[$nick])) {
            $score += (int)$adjusts[$nick];
        }
        $session['players'][$idx]['score'] = max(0, $score);
    }
    return $session;
}

// --------------------------------------------
// Anti-triche : payload de question expurgé pour les élèves
// --------------------------------------------

/**
 * Retourne une COPIE de la question sans aucune information de solution — un
 * collégien qui ouvre l'onglet Réseau des devtools ne doit rien pouvoir y lire :
 *   - multiple/truefalse : drapeaux 'correct' retirés (l'ordre des réponses est
 *     CONSERVÉ : l'élève répond par index) ;
 *   - order : l'ordre du tableau EST la solution → mélange DÉTERMINISTE seedé par
 *     playCode+index (stable d'un poll à l'autre, identique pour toute la classe ;
 *     l'élève répond par textes, la vérification serveur garde la vraie séquence) ;
 *   - freetext : texte attendu et variantes acceptées retirés.
 * La question COMPLÈTE (avec solution) reste disponible dans les résultats, une
 * fois la question terminée (calculateQuestionResults).
 */
function qst_sanitizeQuestionForStudent($question, $playCode, $qIndex) {
    if (!is_array($question)) return $question;
    $type = $question['type'] ?? '';
    $answers = $question['answers'] ?? [];

    switch ($type) {
        case 'multiple':
        case 'truefalse':
            foreach ($answers as $i => $a) {
                unset($answers[$i]['correct']);
            }
            $question['answers'] = array_values($answers);
            break;

        case 'order':
            foreach ($answers as $i => $a) {
                unset($answers[$i]['correct']);
                unset($answers[$i]['order']);
            }
            $answers = array_values($answers);
            // Fisher-Yates avec LCG local seedé (pas de mt_srand : ne pas perturber
            // l'échantillonnage mt_rand du nettoyage). Même seed → même ordre pour
            // tous les élèves et tous les polls (pas de re-mélange à l'affichage).
            $seed = crc32($playCode . '|' . $qIndex . '|' . ($question['id'] ?? ''));
            $lcg = function() use (&$seed) {
                $seed = ($seed * 1103515245 + 12345) & 0x7FFFFFFF;
                return $seed;
            };
            for ($i = count($answers) - 1; $i > 0; $i--) {
                $j = $lcg() % ($i + 1);
                $tmp = $answers[$i]; $answers[$i] = $answers[$j]; $answers[$j] = $tmp;
            }
            $question['answers'] = $answers;
            break;

        case 'freetext':
            $question['answers'] = [['text' => '', 'correct' => true]];
            unset($question['acceptedAnswers']);
            break;
    }
    return $question;
}

// --------------------------------------------
// Vue unifiée (overlay)
// --------------------------------------------

/**
 * Construit la VUE complète d'une session : session legacy (joueurs, quiz) +
 * état de pilotage (state.json prioritaire) + complétion (done-file) + scores
 * dérivés. C'est ce que tous les chemins de LECTURE doivent utiliser : les champs
 * d'état éventuellement présents dans la session legacy (écrits par d'anciennes
 * versions) sont écrasés par la vérité du store séparé.
 */
function qst_view($playCode, array $session, $state = null) {
    if ($state === null) $state = qst_loadState($playCode);
    if (is_array($state)) {
        $session['state'] = $state['state'] ?? 'waiting';
        $session['currentQuestion'] = $state['currentQuestion'] ?? -1;
        $session['questionStartTime'] = $state['questionStartTime'] ?? 0;
        $session['questionRevealAt'] = (int)($state['questionRevealAt'] ?? 0);
        $session['paused'] = (bool)($state['paused'] ?? false);
        $session['manualMode'] = (bool)($state['manualMode'] ?? false);
        $session['showTop3'] = (bool)($state['showTop3'] ?? true);
        if (($state['startTime'] ?? 0) > 0) $session['startTime'] = $state['startTime'];
        if (($state['endTime'] ?? 0) > 0) $session['endTime'] = $state['endTime'];
        if (isset($state['customTime']) && $state['customTime'] !== null && $state['customTime'] !== '') {
            $session['customTime'] = (int)$state['customTime'];
        } else {
            unset($session['customTime']);
        }
    } else {
        $state = []; // session legacy pure : les champs restent ceux du fichier session
    }

    // Complétion de la question courante : l'existence du done-file fait foi.
    $q = $session['currentQuestion'] ?? -1;
    $done = ($q >= 0) ? qst_loadDone($playCode, $q) : null;
    if ($done) {
        $session['questionCompleted'] = true;
        $session['questionCompletedTime'] = $done['completedTime'] ?? time();
        $session['rankingSnapshot'] = ['q' => $q, 'players' => $done['ranking'] ?? []];
    } else {
        $session['questionCompleted'] = false;
        unset($session['questionCompletedTime']);
        unset($session['rankingSnapshot']);
    }

    return qst_decorateSession($session, $state);
}

// --------------------------------------------
// Facteur de charge multi-classes (anti-ban OVH)
// --------------------------------------------

define('QST_CROWD_FILE', SESSIONS_DIR . '/crowd.json');
define('QST_CROWD_TTL', 12);          // reconstruit au plus toutes les 12 s
define('QST_CROWD_ACTIVE_WINDOW', 180); // une partie est "active" si état modifié < 3 min

/**
 * Lit le facteur d'étalement courant (1.0 / 1.25 / 1.5). Fichier DÉRIVÉ : un
 * écrasement concurrent est sans conséquence (même contenu recalculable).
 * Un fichier PÉRIMÉ (> 60 s : plus aucun poll écrivain ne l'a reconstruit,
 * donc plus de partie active récente) vaut 1.0 — évite qu'une classe seule
 * reste étalée à cause d'un crowd.json laissé par des parties terminées.
 */
function qst_crowdFactor() {
    $raw = @file_get_contents(QST_CROWD_FILE);
    $data = $raw ? json_decode($raw, true) : null;
    if (!is_array($data) || (time() - (int)($data['at'] ?? 0)) > 60) return 1.0;
    $n = (int)($data['n'] ?? 1);
    if ($n <= 1) return 1.0;
    if ($n === 2) return 1.25;
    return 1.5;
}

/**
 * Reconstruit crowd.json s'il est périmé. Appelé par les get_state ÉCRIVAINS
 * (1 poll sur POLL_READONLY_RATIO par élève) → coût du glob amorti, jamais sur le
 * chemin readonly chaud. Compte les parties en cours réellement actives.
 */
function qst_refreshCrowd() {
    $raw = @file_get_contents(QST_CROWD_FILE);
    $data = $raw ? json_decode($raw, true) : null;
    if (is_array($data) && (time() - (int)($data['at'] ?? 0)) < QST_CROWD_TTL) return;

    $n = 0;
    foreach ((glob(SESSIONS_DIR . '/*.state.json') ?: []) as $f) {
        $st = json_decode(@file_get_contents($f) ?: '', true);
        if (is_array($st) && ($st['state'] ?? '') === 'playing'
            && (time() - (int)($st['updatedAt'] ?? 0)) < QST_CROWD_ACTIVE_WINDOW) {
            $n++;
        }
    }
    $tmp = QST_CROWD_FILE . '.tmp.' . uniqid('', true);
    if (@file_put_contents($tmp, json_encode(['n' => $n, 'at' => time()])) !== false) {
        @rename($tmp, QST_CROWD_FILE);
    }
}

// --------------------------------------------
// Nettoyage groupé (CODE.json + CODE.state.json + CODE.done.q*.json)
// --------------------------------------------

/**
 * Supprime TOUS les fichiers d'une session (appelé par cleanup_session et par le
 * nettoyage périodique). Le groupe vit et meurt ensemble.
 */
function qst_deleteSessionFiles($playCode) {
    $playCode = validatePlayCode($playCode);
    if ($playCode === null) return;
    @unlink(SESSIONS_DIR . '/' . $playCode . '.json');
    @unlink(qst_stateFile($playCode));
    @unlink(SESSIONS_DIR . '/' . $playCode . '.lock');
    @unlink(SESSIONS_DIR . '/' . $playCode . '.state.lock');
    foreach ((glob(SESSIONS_DIR . '/' . $playCode . '.done.q*.json') ?: []) as $f) {
        @unlink($f);
    }
}

/**
 * Nettoyage périodique par GROUPE de session : un groupe est supprimé quand son
 * fichier le plus récent dépasse le timeout (évite qu'un state.json figé d'une
 * partie encore pollée soit supprimé avant le fichier joueurs, et inversement).
 */
function qst_cleanOldSessionGroups($timeoutSec) {
    $files = glob(SESSIONS_DIR . '/*.json') ?: [];
    $now = time();
    $groups = []; // playCode => mtime max
    foreach ($files as $f) {
        $base = basename($f);
        if ($base === 'crowd.json') {
            continue;
        }
        // playCode = segment avant le premier point ([A-Z0-9]{3,12})
        $code = substr($base, 0, strpos($base, '.'));
        if (!preg_match('/^[A-Z0-9]{3,12}$/', $code)) continue;
        $mt = @filemtime($f) ?: 0;
        if (!isset($groups[$code]) || $mt > $groups[$code]) $groups[$code] = $mt;
    }
    foreach ($groups as $code => $newest) {
        if (($now - $newest) > $timeoutSec) {
            qst_deleteSessionFiles($code);
        }
    }

    // Orphelins (serveur propre) : verrous dont la session n'existe plus (création
    // interrompue, nettoyage partiel) et fichiers temporaires d'écritures avortées
    // (crash entre le tmp et le rename) — supprimés au-delà d'une heure.
    foreach ((glob(SESSIONS_DIR . '/*.lock') ?: []) as $f) {
        $base = basename($f);
        $code = substr($base, 0, strpos($base, '.'));
        if (!file_exists(SESSIONS_DIR . '/' . $code . '.json') && ($now - (@filemtime($f) ?: 0)) > 3600) {
            @unlink($f);
        }
    }
    foreach ((glob(SESSIONS_DIR . '/*.tmp.*') ?: []) as $f) {
        if (($now - (@filemtime($f) ?: 0)) > 3600) @unlink($f);
    }
}
?>
