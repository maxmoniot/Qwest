<?php
// ============================================
// QWEST - GAME API (Gestion des parties)
// Description: Gestion temps réel des sessions de jeu
// ============================================

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST');

// Configuration
define('SESSIONS_DIR', __DIR__ . '/data/sessions');
define('SESSION_TIMEOUT', 600); // 10 minutes
define('PING_TIMEOUT', 120); // 120 secondes - Tolérance pour connexions instables en classe

// NOUVEAU : Seuil unique pour "joueur actif devant répondre"
// Un joueur est considéré actif s'il a pingé dans les 60 dernières secondes
define('ACTIVE_PLAYER_THRESHOLD', 60);

// NOUVEAU : Marge de grâce après la fin du timer de question (en secondes)
// Après ce délai, on force automatiquement la completion
define('QUESTION_TIMEOUT_GRACE', 3);

// Créer le dossier des sessions
if (!file_exists(SESSIONS_DIR)) {
    mkdir(SESSIONS_DIR, 0755, true);
}

// Nettoyer les anciennes sessions
cleanOldSessions();

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
    
    case 'ping':
        pingPlayer();
        break;
    
    case 'answer':
        submitAnswer();
        break;
    
    case 'stream':
        streamEvents();
        break;
    
    case 'get_state':
        getGameState();
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
function joinGame() {
    $playCode = isset($_POST['playCode']) ? trim($_POST['playCode']) : '';
    $nickname = isset($_POST['nickname']) ? trim($_POST['nickname']) : '';
    
    error_log("JOIN: playCode=$playCode, nickname=$nickname");
    
    if (empty($playCode) || empty($nickname)) {
        echo json_encode(['success' => false, 'message' => 'Données manquantes']);
        return;
    }
    
    $session = loadSession($playCode);
    
    if (!$session) {
        echo json_encode(['success' => false, 'message' => 'Code de partie invalide']);
        return;
    }
    
    // Vérifier si ce pseudo existe déjà
    $playerExists = false;
    
    foreach ($session['players'] as &$player) {
        if ($player['nickname'] === $nickname) {
            $playerExists = true;
            $player['lastPing'] = time();
            $player['connected'] = true;
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
            'joinedAt' => time()
        ];
    }
    
    saveSession($playCode, $session);
    echo json_encode(['success' => true]);
}

/**
 * Quitter une partie
 */
function leaveGame() {
    $playCode = isset($_POST['playCode']) ? trim($_POST['playCode']) : '';
    $nickname = isset($_POST['nickname']) ? trim($_POST['nickname']) : '';
    
    if (empty($playCode) || empty($nickname)) return;
    
    $session = loadSession($playCode);
    if (!$session) return;
    
    foreach ($session['players'] as &$player) {
        if ($player['nickname'] === $nickname) {
            $player['connected'] = false;
            break;
        }
    }
    unset($player);
    
    saveSession($playCode, $session);
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
    
    $session = loadSession($playCode);
    if (!$session) {
        echo json_encode(['success' => false, 'message' => 'Session introuvable']);
        return;
    }
    
    foreach ($session['players'] as &$player) {
        if ($player['nickname'] === $nickname) {
            $timeSinceLastPing = time() - ($player['lastPing'] ?? 0);
            
            if ($timeSinceLastPing < 10) {
                $player['connected'] = true;
                saveSession($playCode, $session);
                echo json_encode(['success' => true, 'online' => true]);
            } else {
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
    
    $session = loadSession($playCode);
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
    
    saveSession($playCode, $session);
    echo json_encode(['success' => true]);
}

/**
 * Soumettre une réponse
 */
function submitAnswer() {
    $playCode = isset($_POST['playCode']) ? trim($_POST['playCode']) : '';
    $nickname = isset($_POST['nickname']) ? trim($_POST['nickname']) : '';
    $questionIndex = isset($_POST['questionIndex']) ? intval($_POST['questionIndex']) : 0;
    $answer = isset($_POST['answer']) ? $_POST['answer'] : '';
    $timeSpent = isset($_POST['timeSpent']) ? intval($_POST['timeSpent']) : 0;
    
    if (empty($playCode) || empty($nickname)) {
        echo json_encode(['success' => false]);
        return;
    }
    
    // IMPORTANT : Utiliser le verrouillage pour éviter les conflits
    list($session, $fp) = loadSessionForUpdate($playCode);
    if (!$session) {
        echo json_encode(['success' => false]);
        return;
    }
    
    // Enregistrer la réponse
    foreach ($session['players'] as &$player) {
        if ($player['nickname'] === $nickname) {
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
    
    // Vérifier d'abord si le temps est écoulé (forcer la completion)
    $forceComplete = checkAndForceQuestionCompletion($session, $questionIndex);
    
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
        
        // Log compact
        $logData = [];
        foreach ($session['players'] as $p) {
            $isActive = $p['connected'] && (time() - $p['lastPing'] < ACTIVE_PLAYER_THRESHOLD);
            $hasAnswered = isset($p['answers'][$questionIndex]) ? 'Y' : 'N';
            $logData[] = "{$p['nickname']}:a=" . ($isActive ? 'Y' : 'N') . ",r=$hasAnswered";
        }
        error_log("Q$questionIndex|" . implode("|", $logData) . "|all=" . ($allAnswered ? 'Y' : 'N'));
        
        if ($allAnswered && $activePlayersCount > 0) {
            error_log("SUBMIT: Tous actifs ont répondu Q$questionIndex");
            $session['questionCompleted'] = true;
            $session['questionCompletedTime'] = time();
            calculateQuestionScores($session, $questionIndex);
        }
    }
    
    // Sauvegarder avec libération du verrou
    saveSessionAndUnlock($playCode, $session, $fp);
    echo json_encode(['success' => true]);
}

/**
 * NOUVEAU : Vérifier si le temps de la question est écoulé et forcer la completion
 */
function checkAndForceQuestionCompletion(&$session, $questionIndex = null) {
    if (isset($session['questionCompleted']) && $session['questionCompleted']) {
        return false;
    }
    
    if ($session['state'] !== 'playing') {
        return false;
    }
    
    if ($questionIndex === null) {
        $questionIndex = $session['currentQuestion'] ?? -1;
    }
    
    if ($questionIndex < 0) {
        return false;
    }
    
    $questions = $session['questions'] ?? $session['quizData']['questions'] ?? [];
    if (!isset($questions[$questionIndex])) {
        return false;
    }
    
    $questionTime = $session['customTime'] ?? $questions[$questionIndex]['time'] ?? 30;
    $questionStartTime = $session['questionStartTime'] ?? 0;
    
    if ($questionStartTime === 0) {
        return false;
    }
    
    $timeElapsed = time() - $questionStartTime;
    
    if ($timeElapsed >= ($questionTime + QUESTION_TIMEOUT_GRACE)) {
        error_log("AUTO_COMPLETE: Q$questionIndex timeout ({$timeElapsed}s >= {$questionTime}s + " . QUESTION_TIMEOUT_GRACE . "s)");
        
        $session['questionCompleted'] = true;
        $session['questionCompletedTime'] = time();
        calculateQuestionScores($session, $questionIndex);
        
        return true;
    }
    
    return false;
}

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
    
    $session = loadSession($playCode);
    if (!$session) {
        echo json_encode(['success' => false, 'message' => 'Session introuvable']);
        return;
    }
    
    // Mettre à jour le ping
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
    
    $wasForced = checkAndForceQuestionCompletion($session, $questionIndex >= 0 ? $questionIndex : null);
    
    saveSession($playCode, $session);
    
    $response = [
        'success' => true,
        'questionCompleted' => $session['questionCompleted'] ?? false,
        'wasForced' => $wasForced
    ];
    
    if ($session['questionCompleted'] ?? false) {
        $currentQ = $session['currentQuestion'] ?? -1;
        if ($currentQ >= 0) {
            $response['results'] = calculateQuestionResults($session, $currentQ);
        }
    }
    
    echo json_encode($response);
}

/**
 * Flux SSE (gardé pour compatibilité)
 */
function streamEvents() {
    while (ob_get_level()) {
        ob_end_clean();
    }
    
    header('Content-Type: text/event-stream');
    header('Cache-Control: no-cache');
    header('Connection: keep-alive');
    header('X-Accel-Buffering: no');
    
    $playCode = isset($_GET['playCode']) ? trim($_GET['playCode']) : '';
    $nickname = isset($_GET['nickname']) ? trim($_GET['nickname']) : '';
    
    if (empty($playCode) || empty($nickname)) {
        echo "event: error\ndata: " . json_encode(['error' => 'Invalid parameters']) . "\n\n";
        flush();
        exit;
    }
    
    echo "event: connected\ndata: " . json_encode(['message' => 'Connected']) . "\n\n";
    flush();
    
    $lastState = null;
    $lastQuestionSent = -1;
    $lastResultsSent = -1;
    
    while (true) {
        $session = loadSession($playCode);
        
        if (!$session) {
            echo "event: error\ndata: " . json_encode(['error' => 'Session not found']) . "\n\n";
            flush();
            break;
        }
        
        $playerExists = false;
        $playerIndex = -1;
        
        foreach ($session['players'] as $index => $player) {
            if ($player['nickname'] === $nickname) {
                $playerExists = true;
                $playerIndex = $index;
                break;
            }
        }
        
        if (!$playerExists) {
            echo "event: kicked\ndata: " . json_encode(['message' => 'Retiré de la partie']) . "\n\n";
            flush();
            break;
        }
        
        $session['players'][$playerIndex]['lastPing'] = time();
        checkAndForceQuestionCompletion($session);
        saveSession($playCode, $session);
        
        $connectedPlayers = array_filter($session['players'], function($p) {
            return $p['connected'] && (time() - $p['lastPing'] < PING_TIMEOUT);
        });
        
        echo "event: players\ndata: " . json_encode(['players' => array_values($connectedPlayers)]) . "\n\n";
        flush();
        
        if ($session['state'] !== $lastState) {
            if ($session['state'] === 'playing') {
                echo "event: start\ndata: " . json_encode(['state' => 'playing']) . "\n\n";
            } elseif ($session['state'] === 'finished') {
                echo "event: end\ndata: " . json_encode(calculateFinalResults($session)) . "\n\n";
            }
            flush();
            $lastState = $session['state'];
        }
        
        if (isset($session['currentQuestion']) && $session['currentQuestion'] >= 0) {
            $currentQ = $session['currentQuestion'];
            $questions = $session['questions'] ?? $session['quizData']['questions'] ?? [];
            
            if ($currentQ !== $lastQuestionSent && isset($questions[$currentQ])) {
                $question = $questions[$currentQ];
                $question['time'] = $session['customTime'] ?? $question['time'];
                
                echo "event: question\ndata: " . json_encode([
                    'index' => $currentQ,
                    'question' => $question,
                    'startTime' => $session['questionStartTime'] ?? time(),
                    'totalQuestions' => count($questions)
                ]) . "\n\n";
                flush();
                
                $lastQuestionSent = $currentQ;
                $lastResultsSent = -1;
            }
            
            if (isset($session['questionCompleted']) && $session['questionCompleted'] && $lastResultsSent !== $currentQ) {
                $results = calculateQuestionResults($session, $currentQ);
                echo "event: results\ndata: " . json_encode($results) . "\n\n";
                flush();
                $lastResultsSent = $currentQ;
            }
        }
        
        sleep(1);
        if (connection_aborted()) break;
    }
}

/**
 * Calculer les scores d'une question
 */
function calculateQuestionScores(&$session, $questionIndex) {
    $questions = $session['questions'] ?? $session['quizData']['questions'] ?? [];
    
    if (!isset($questions[$questionIndex])) {
        return;
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
    
    foreach ($session['players'] as &$player) {
        if (isset($player['answers'][$questionIndex])) {
            $playerAnswer = json_decode($player['answers'][$questionIndex]['answer'], true);
            $timeSpent = $player['answers'][$questionIndex]['timeSpent'];
            $isCorrect = false;
            
            switch ($question['type']) {
                case 'multiple':
                case 'truefalse':
                    $isCorrect = isset($playerAnswer['index']) && $playerAnswer['index'] === $correctAnswer;
                    break;
                case 'order':
                    $isCorrect = isset($playerAnswer['order']) && $playerAnswer['order'] === $correctAnswer;
                    break;
                case 'freetext':
                    if (isset($playerAnswer['freetext'])) {
                        $userAnswer = $playerAnswer['freetext'];
                        $caseSensitive = $question['caseSensitive'] ?? false;
                        
                        if (!$caseSensitive) {
                            $userAnswer = mb_strtolower(trim($userAnswer), 'UTF-8');
                            $correctAnswer = mb_strtolower(trim($correctAnswer), 'UTF-8');
                        } else {
                            $userAnswer = trim($userAnswer);
                            $correctAnswer = trim($correctAnswer);
                        }
                        
                        $isCorrect = ($userAnswer === $correctAnswer);
                        
                        if (!$isCorrect && isset($question['acceptedAnswers'])) {
                            foreach ($question['acceptedAnswers'] as $alt) {
                                $altCheck = $caseSensitive ? trim($alt) : mb_strtolower(trim($alt), 'UTF-8');
                                if ($userAnswer === $altCheck) {
                                    $isCorrect = true;
                                    break;
                                }
                            }
                        }
                    }
                    break;
            }
            
            if ($isCorrect) {
                $timeBonus = max(0, round(1000 - ($timeSpent / 100)));
                $player['score'] = ($player['score'] ?? 0) + $timeBonus;
                $player['answers'][$questionIndex]['correct'] = true;
                $player['answers'][$questionIndex]['points'] = $timeBonus;
            } else {
                $player['answers'][$questionIndex]['correct'] = false;
                $player['answers'][$questionIndex]['points'] = 0;
            }
        }
    }
    unset($player);
}

/**
 * Calculer les résultats d'une question
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
    
    $playersCopy = $session['players'];
    usort($playersCopy, function($a, $b) {
        return ($b['score'] ?? 0) - ($a['score'] ?? 0);
    });
    
    $top3 = array_slice($playersCopy, 0, 3);
    
    $questionStats = [];
    foreach ($session['players'] as $player) {
        if (isset($player['answers'][$questionIndex])) {
            $answer = $player['answers'][$questionIndex];
            $questionStats[] = [
                'nickname' => $player['nickname'],
                'correct' => $answer['correct'] ?? false,
                'timeSpent' => $answer['timeSpent'] ?? 0,
                'pointsEarned' => $answer['points'] ?? 0
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
function loadSession($playCode) {
    $playCode = strtoupper(trim($playCode));
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
function loadSessionForUpdate($playCode) {
    $playCode = strtoupper(trim($playCode));
    $file = SESSIONS_DIR . '/' . $playCode . '.json';
    
    if (!file_exists($file)) {
        return [null, null];
    }
    
    // Ouvrir avec verrouillage exclusif
    $fp = @fopen($file, 'r+');
    if (!$fp) {
        error_log("LOAD_SESSION_UPDATE: Impossible d'ouvrir $playCode");
        return [null, null];
    }
    
    // Attendre le verrou exclusif (bloque si un autre processus l'a)
    // Timeout de 5 secondes max pour éviter deadlock
    $lockAcquired = false;
    $startTime = time();
    while (!$lockAcquired && (time() - $startTime) < 5) {
        if (flock($fp, LOCK_EX | LOCK_NB)) {
            $lockAcquired = true;
        } else {
            usleep(50000); // 50ms
        }
    }
    
    if (!$lockAcquired) {
        // Timeout - forcer le verrou quand même
        flock($fp, LOCK_EX);
        error_log("LOAD_SESSION_UPDATE: Verrou forcé après timeout pour $playCode");
    }
    
    $content = stream_get_contents($fp);
    if (empty($content)) {
        flock($fp, LOCK_UN);
        fclose($fp);
        return [null, null];
    }
    
    $data = json_decode($content, true);
    if ($data === null && json_last_error() !== JSON_ERROR_NONE) {
        error_log("LOAD_SESSION_UPDATE: Erreur JSON pour $playCode: " . json_last_error_msg());
        flock($fp, LOCK_UN);
        fclose($fp);
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
function saveSessionAndUnlock($playCode, $session, $fp = null) {
    $playCode = strtoupper(trim($playCode));
    $file = SESSIONS_DIR . '/' . $playCode . '.json';
    
    $content = json_encode($session, JSON_PRETTY_PRINT);
    
    if ($fp) {
        // Écriture avec le verrou existant
        fseek($fp, 0);
        ftruncate($fp, 0);
        fwrite($fp, $content);
        fflush($fp);
        flock($fp, LOCK_UN);
        fclose($fp);
    } else {
        // Fallback : écriture atomique avec fichier temporaire
        $tmpFile = $file . '.tmp.' . getmypid();
        if (file_put_contents($tmpFile, $content) !== false) {
            rename($tmpFile, $file);
        } else {
            error_log("SAVE_SESSION: Échec écriture pour $playCode");
        }
    }
}

/**
 * Ancienne fonction pour compatibilité (sans verrouillage)
 */
function saveSession($playCode, $session) {
    saveSessionAndUnlock($playCode, $session, null);
}

function getGameState() {
    $playCode = isset($_GET['playCode']) ? trim($_GET['playCode']) : '';
    $nickname = isset($_GET['nickname']) ? trim($_GET['nickname']) : '';
    
    if (empty($playCode) || empty($nickname)) {
        echo json_encode(['success' => false, 'message' => 'Paramètres manquants']);
        return;
    }
    
    // Utiliser le verrouillage pour éviter les conflits
    list($session, $fp) = loadSessionForUpdate($playCode);
    
    if (!$session) {
        echo json_encode(['success' => false, 'message' => 'Session introuvable']);
        return;
    }
    
    $playerExists = false;
    $playerIndex = -1;
    
    foreach ($session['players'] as $index => $player) {
        if ($player['nickname'] === $nickname) {
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
    
    // Vérification automatique du timeout
    checkAndForceQuestionCompletion($session);
    
    // Sauvegarder et libérer le verrou
    saveSessionAndUnlock($playCode, $session, $fp);
    
    $connectedPlayers = array_filter($session['players'], function($p) {
        return $p['connected'] && (time() - $p['lastPing'] < PING_TIMEOUT);
    });
    
    $response = [
        'success' => true,
        'state' => $session['state'],
        'paused' => $session['paused'] ?? false,
        'players' => array_values($connectedPlayers),
        'currentQuestion' => $session['currentQuestion'] ?? -1
    ];
    
    if ($session['state'] === 'playing' && isset($session['currentQuestion'])) {
        $qIndex = $session['currentQuestion'];
        $questions = $session['questions'] ?? $session['quizData']['questions'] ?? [];
        
        if (isset($questions[$qIndex])) {
            $questionData = $questions[$qIndex];
            
            // IMPORTANT : Appliquer le temps personnalisé si défini
            if (isset($session['customTime']) && $session['customTime'] > 0) {
                $questionData['time'] = $session['customTime'];
            }
            
            $response['question'] = [
                'index' => $qIndex,
                'data' => $questionData,
                'startTime' => $session['questionStartTime'] ?? time(),
                'totalQuestions' => count($questions)
            ];
        }
    }
    
    if (isset($session['questionCompletedTime']) && isset($session['currentQuestion'])) {
        $response['results'] = calculateQuestionResults($session, $session['currentQuestion']);
    }
    
    if ($session['state'] === 'finished') {
        $response['finalResults'] = calculateFinalResults($session);
    }
    
    echo json_encode($response);
}

function cleanOldSessions() {
    $files = glob(SESSIONS_DIR . '/*.json');
    $now = time();
    
    foreach ($files as $file) {
        if ($now - filemtime($file) > SESSION_TIMEOUT) {
            unlink($file);
        }
    }
}
?>
