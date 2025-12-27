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
define('SESSION_TIMEOUT', 600); // 10 minutes (était 5)
define('PING_TIMEOUT', 60); // 60 secondes (était 30) - Pour connexions lentes

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
    error_log("JOIN: SESSIONS_DIR=" . SESSIONS_DIR);
    
    if (empty($playCode) || empty($nickname)) {
        error_log("JOIN: Données manquantes");
        echo json_encode(['success' => false, 'message' => 'Données manquantes']);
        return;
    }
    
    // Vérifier que le dossier existe
    if (!is_dir(SESSIONS_DIR)) {
        error_log("JOIN: ERREUR - Le dossier sessions n'existe pas!");
        echo json_encode(['success' => false, 'message' => 'Erreur serveur - dossier sessions manquant']);
        return;
    }
    
    // Lister tous les fichiers de session pour debug
    $files = glob(SESSIONS_DIR . '/*.json');
    error_log("JOIN: Fichiers de session disponibles: " . implode(', ', array_map('basename', $files)));
    
    // Charger ou créer la session
    $session = loadSession($playCode);
    error_log("JOIN: Session " . ($session ? "trouvée" : "introuvable") . " pour code $playCode");
    
    if (!$session) {
        echo json_encode(['success' => false, 'message' => 'Code de partie invalide. Vérifiez que la partie a bien été créée.']);
        return;
    }
    
    // Vérifier si ce pseudo existe déjà
    $playerExists = false;
    $playerWasDisconnected = false;
    
    foreach ($session['players'] as &$player) {
        if ($player['nickname'] === $nickname) {
            $playerExists = true;
            
            // Si le joueur existe mais est déconnecté, refuser la reconnexion
            if (!($player['connected'] ?? false)) {
                $playerWasDisconnected = true;
                error_log("JOIN: Refus - pseudo $nickname déjà utilisé (joueur déconnecté)");
                break;
            }
            
            // Si connecté, c'est une reconnexion normale
            $player['lastPing'] = time();
            $player['connected'] = true;
            break;
        }
    }
    unset($player); // Fermer la référence
    
    // Refuser si le pseudo était déconnecté
    if ($playerWasDisconnected) {
        echo json_encode([
            'success' => false, 
            'message' => 'Ce pseudo est déjà pris. Choisis-en un autre !'
        ]);
        return;
    }
    
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
    
    if (empty($playCode) || empty($nickname)) {
        return;
    }
    
    $session = loadSession($playCode);
    if (!$session) return;
    
    // Marquer le joueur comme déconnecté
    foreach ($session['players'] as &$player) {
        if ($player['nickname'] === $nickname) {
            $player['connected'] = false;
            break;
        }
    }
    unset($player); // Fermer la référence
    
    saveSession($playCode, $session);
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
    
    // Mettre à jour le timestamp du joueur
    foreach ($session['players'] as &$player) {
        if ($player['nickname'] === $nickname) {
            $player['lastPing'] = time();
            $player['connected'] = true;
            break;
        }
    }
    unset($player); // Fermer la référence
    
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
    
    $session = loadSession($playCode);
    if (!$session) {
        echo json_encode(['success' => false]);
        return;
    }
    
    // Enregistrer la réponse
    foreach ($session['players'] as &$player) {
        if ($player['nickname'] === $nickname) {
            $player['answers'][$questionIndex] = [
                'questionIndex' => $questionIndex,  // AJOUT pour retrouver facilement
                'answer' => $answer,
                'timeSpent' => $timeSpent,
                'timestamp' => time()
            ];
            break;
        }
    }
    unset($player); // IMPORTANT : Fermer la référence
    
    // Vérifier si tous les joueurs ont répondu
    $allAnswered = true;
    $connectedPlayers = 0;
    
    foreach ($session['players'] as $player) {
        if ($player['connected'] && (time() - $player['lastPing'] < 30)) {
            $connectedPlayers++;
            if (!isset($player['answers'][$questionIndex])) {
                $allAnswered = false;
            }
        }
    }
    
    // LOGS COMPACTS
    $logData = [];
    foreach ($session['players'] as $p) {
        $logData[] = "{$p['nickname']}:score=" . ($p['score'] ?? 0) . ",answers=" . count($p['answers'] ?? []);
    }
    error_log("Q$questionIndex|players=" . implode("|", $logData) . "|all=" . ($allAnswered ? 'Y' : 'N'));
    
    // Si tous ont répondu, calculer les scores
    if ($allAnswered && $connectedPlayers > 0) {
        error_log("SUBMIT: Tous ont répondu Q$questionIndex, activation questionCompleted");
        $session['questionCompleted'] = true;
        $session['questionCompletedTime'] = time();
        
        calculateQuestionScores($session, $questionIndex);
        
        // LOG après calcul
        $afterScores = [];
        foreach ($session['players'] as $p) {
            $afterScores[] = "{$p['nickname']}:" . ($p['score'] ?? 0);
        }
        error_log("Q$questionIndex|CALC|" . implode("|", $afterScores));
    } else {
        // Log pour debugging : qui n'a pas encore répondu ?
        $notAnswered = [];
        foreach ($session['players'] as $player) {
            if ($player['connected'] && (time() - $player['lastPing'] < 30)) {
                if (!isset($player['answers'][$questionIndex])) {
                    $notAnswered[] = $player['nickname'];
                }
            }
        }
        if (count($notAnswered) > 0) {
            error_log("SUBMIT: En attente de: " . implode(", ", $notAnswered));
        }
    }
    
    saveSession($playCode, $session);
    echo json_encode(['success' => true]);
}

/**
 * Flux d'événements Server-Sent Events (SSE)
 */
function streamEvents() {
    // Désactiver tous les buffers
    while (ob_get_level()) {
        ob_end_clean();
    }
    
    header('Content-Type: text/event-stream');
    header('Cache-Control: no-cache');
    header('Connection: keep-alive');
    header('X-Accel-Buffering: no'); // Pour nginx
    
    $playCode = isset($_GET['playCode']) ? trim($_GET['playCode']) : '';
    $nickname = isset($_GET['nickname']) ? trim($_GET['nickname']) : '';
    
    if (empty($playCode) || empty($nickname)) {
        echo "event: error\n";
        echo "data: " . json_encode(['error' => 'Invalid parameters']) . "\n\n";
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
        $connectedPlayers = array_filter($session['players'], function($p) {
            return $p['connected'] && (time() - $p['lastPing'] < PING_TIMEOUT);
        });
        echo "event: players\n";
        echo "data: " . json_encode(['players' => array_values($connectedPlayers)]) . "\n\n";
        flush();
    }
    
    // Boucle infinie pour envoyer les mises à jour
    $lastState = null;
    $lastPlayerCount = 0;
    
    while (true) {
        $session = loadSession($playCode);
        
        if (!$session) {
            // Session n'existe plus
            echo "event: error\n";
            echo "data: " . json_encode(['type' => 'error', 'message' => 'Session not found']) . "\n\n";
            flush();
            break;
        }
        
        // Vérifier si ce joueur existe toujours dans la session
        $playerExists = false;
        $playerIndex = -1;
        
        foreach ($session['players'] as $index => $player) {
            if ($player['nickname'] === $nickname) {
                $playerExists = true;
                $playerIndex = $index;
                break;
            }
        }
        
        // Si le joueur a été supprimé, envoyer événement kicked
        if (!$playerExists) {
            error_log("SSE: Joueur $nickname supprimé de la session");
            echo "event: kicked\n";
            echo "data: " . json_encode(['message' => 'Vous avez été retiré de la partie']) . "\n\n";
            flush();
            break;
        }
        
        // Mettre à jour le ping du joueur
        $session['players'][$playerIndex]['lastPing'] = time();
        saveSession($playCode, $session);
        
        // Envoyer les joueurs connectés
        $connectedPlayers = array_filter($session['players'], function($p) {
            return $p['connected'] && (time() - $p['lastPing'] < PING_TIMEOUT);
        });
        
        // Calculer hash pour détecter changements (count + scores)
        $playersHash = json_encode(array_map(function($p) {
            return ['nickname' => $p['nickname'], 'score' => $p['score']];
        }, $connectedPlayers));
        
        static $lastPlayersHash = null;
        if ($playersHash !== $lastPlayersHash) {
            echo "event: players\n";
            echo "data: " . json_encode(['players' => array_values($connectedPlayers)]) . "\n\n";
            flush();
            $lastPlayersHash = $playersHash;
        }
        
        // Envoyer les changements d'état
        if ($session['state'] !== $lastState) {
            switch ($session['state']) {
                case 'playing':
                    echo "event: start\n";
                    echo "data: " . json_encode(['state' => 'playing']) . "\n\n";
                    flush();
                    break;
                
                case 'finished':
                    echo "event: end\n";
                    echo "data: " . json_encode(calculateFinalResults($session)) . "\n\n";
                    flush();
                    break;
            }
            
            $lastState = $session['state'];
        }
        
        // Envoyer les changements de pause
        static $lastPausedState = null;
        $currentPaused = $session['paused'] ?? false;
        
        if ($lastPausedState !== $currentPaused) {
            echo "event: pause\n";
            echo "data: " . json_encode(['paused' => $currentPaused]) . "\n\n";
            flush();
            $lastPausedState = $currentPaused;
        }
        
        // Envoyer la question actuelle
        if (isset($session['currentQuestion']) && $session['currentQuestion'] >= 0) {
            $currentQ = $session['currentQuestion'];
            
            // Vérifier si c'est une nouvelle question
            static $lastQuestionSent = -1;
            static $lastResultsSent = -1;
            
            if ($currentQ !== $lastQuestionSent && isset($session['quizData']['questions'][$currentQ])) {
                $question = $session['quizData']['questions'][$currentQ];
                
                // Utiliser customTime si défini, sinon le temps de la question
                $questionTime = isset($session['customTime']) ? $session['customTime'] : $question['time'];
                $question['time'] = $questionTime;
                
                echo "event: question\n";
                echo "data: " . json_encode([
                    'index' => $currentQ,
                    'question' => $question,
                    'startTime' => $session['questionStartTime'] ?? time()
                ]) . "\n\n";
                flush();
                
                $lastQuestionSent = $currentQ;
                // Réinitialiser le flag results pour cette nouvelle question
                $lastResultsSent = -1;
            }
            
            // Si la question est terminée, envoyer les résultats
            if (isset($session['questionCompleted']) && $session['questionCompleted'] && $lastResultsSent !== $currentQ) {
                error_log("SSE: Envoi résultats Q$currentQ");
                
                // Préparer les résultats pour l'affichage (scores déjà calculés dans submitAnswer)
                $results = calculateQuestionResults($session, $currentQ);
                
                error_log("SSE: Results data = " . json_encode([
                    'questionStats_count' => count($results['questionStats']),
                    'top3_count' => count($results['top3']),
                    'allPlayers_count' => count($results['allPlayers'])
                ]));
                
                echo "event: results\n";
                echo "data: " . json_encode($results) . "\n\n";
                flush();
                
                $lastResultsSent = $currentQ;
            }
        }
        
        // Ping toutes les 1 seconde pour réactivité maximale
        sleep(1);
        
        // Timeout de 5 minutes
        if (connection_aborted()) {
            break;
        }
    }
}

/**
 * Calculer et enregistrer les scores d'une question (appelé dans submitAnswer)
 */
function calculateQuestionScores(&$session, $questionIndex) {
    $question = $session['quizData']['questions'][$questionIndex];
    
    // Déterminer la bonne réponse
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
            // La réponse correcte principale
            $correctAnswer = $question['answers'][0]['text'];
            break;
    }
    
    // Calculer les scores
    foreach ($session['players'] as &$player) {
        if (isset($player['answers'][$questionIndex])) {
            $playerAnswer = json_decode($player['answers'][$questionIndex]['answer'], true);
            $timeSpent = $player['answers'][$questionIndex]['timeSpent'];
            $isCorrect = false;
            
            // Vérifier si correct
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
                        
                        // Normaliser si non sensible à la casse
                        if (!$caseSensitive) {
                            $userAnswer = mb_strtolower(trim($userAnswer), 'UTF-8');
                            $correctAnswer = mb_strtolower(trim($correctAnswer), 'UTF-8');
                        } else {
                            $userAnswer = trim($userAnswer);
                            $correctAnswer = trim($correctAnswer);
                        }
                        
                        // Vérifier la réponse principale
                        $isCorrect = ($userAnswer === $correctAnswer);
                        
                        // Si pas correct, vérifier les alternatives
                        if (!$isCorrect && isset($question['acceptedAnswers'])) {
                            foreach ($question['acceptedAnswers'] as $alternative) {
                                $alternativeToCheck = $caseSensitive ? trim($alternative) : mb_strtolower(trim($alternative), 'UTF-8');
                                if ($userAnswer === $alternativeToCheck) {
                                    $isCorrect = true;
                                    break;
                                }
                            }
                        }
                    }
                    break;
            }
            
            // Calculer les points (timeSpent en millisecondes)
            if ($isCorrect) {
                $timeBonus = max(0, round(1000 - ($timeSpent / 100))); // Arrondir
                $oldScore = $player['score'] ?? 0;
                $player['score'] = $oldScore + $timeBonus;
                $player['answers'][$questionIndex]['correct'] = true;
                $player['answers'][$questionIndex]['points'] = $timeBonus;
            } else {
                $player['answers'][$questionIndex]['correct'] = false;
                $player['answers'][$questionIndex]['points'] = 0;
            }
        }
    }
    unset($player); // IMPORTANT : Fermer la référence
}

/**
 * Calculer les résultats d'une question (pour l'affichage uniquement)
 */
function calculateQuestionResults(&$session, $questionIndex) {
    $question = $session['quizData']['questions'][$questionIndex];
    
    // Déterminer la bonne réponse
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
    
    // Les scores sont DÉJÀ calculés dans submitAnswer, on ne fait que trier
    $playersCopy = $session['players'];
    
    // Trier par score
    usort($playersCopy, function($a, $b) {
        return ($b['score'] ?? 0) - ($a['score'] ?? 0);
    });
    
    // Prendre le top 3
    $top3 = array_slice($playersCopy, 0, 3);
    
    // Calculer les statistiques pour CETTE question
    $questionStats = [];
    foreach ($session['players'] as $player) {
        // La réponse est directement à l'index de la question
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
    
    error_log("QUESTION_STATS: Pour Q$questionIndex - " . count($questionStats) . " joueurs");
    error_log("QUESTION_STATS: Pseudos = " . json_encode(array_column($questionStats, 'nickname')));
    
    // Top 5 des plus rapides avec bonne réponse
    $correctAnswers = array_filter($questionStats, function($stat) {
        return $stat['correct'];
    });
    
    usort($correctAnswers, function($a, $b) {
        return $a['timeSpent'] - $b['timeSpent'];
    });
    
    $top5Fastest = array_slice($correctAnswers, 0, 5);
    
    $manualMode = $session['manualMode'] ?? false;
    error_log("RESULTS: manualMode dans session = " . ($manualMode ? 'true' : 'false'));
    error_log("RESULTS: Type de manualMode = " . gettype($manualMode));
    
    $result = [
        'questionIndex' => $questionIndex,
        'correctAnswer' => $correctAnswer,
        'question' => $question, // Ajouter la question complète
        'top3' => $top3,
        'allPlayers' => $playersCopy,
        'manualMode' => $manualMode,
        'questionStats' => $questionStats,
        'top5Fastest' => $top5Fastest
    ];
    
    error_log("RESULTS: Envoi au client manualMode = " . json_encode($result['manualMode']));
    
    return $result;
}

/**
 * Calculer les résultats finaux
 */
function calculateFinalResults($session) {
    $players = $session['players'];
    
    // Trier par score décroissant
    usort($players, function($a, $b) {
        return $b['score'] - $a['score'];
    });
    
    // Vérifier si la partie a vraiment commencé
    // La partie a commencé si currentQuestion >= 0 (au moins la première question lancée)
    $gameStarted = isset($session['currentQuestion']) && $session['currentQuestion'] >= 0;
    
    // Préparer toutes les questions avec leurs réponses correctes
    $questionsWithAnswers = [];
    if (isset($session['quizData']['questions'])) {
        foreach ($session['quizData']['questions'] as $index => $question) {
            // Déterminer la bonne réponse selon le type
            $correctAnswer = null;
            switch ($question['type']) {
                case 'multiple':
                case 'truefalse':
                    foreach ($question['answers'] as $answerIndex => $answer) {
                        if ($answer['correct']) {
                            $correctAnswer = [
                                'index' => $answerIndex,
                                'text' => $answer['text']
                            ];
                            break;
                        }
                    }
                    break;
                
                case 'order':
                    $correctAnswer = array_map(function($a) { 
                        return $a['text']; 
                    }, $question['answers']);
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
    }
    
    return [
        'players' => $players,
        'totalQuestions' => $session['currentQuestion'],
        'gameStarted' => $gameStarted,
        'currentQuestion' => $session['currentQuestion'],
        'questionsWithAnswers' => $questionsWithAnswers
    ];
}

// ========================================
// FONCTIONS UTILITAIRES
// ========================================

/**
 * Charger une session
 */
function loadSession($playCode) {
    // Convertir en majuscules pour éviter les problèmes de casse
    $playCode = strtoupper(trim($playCode));
    $file = SESSIONS_DIR . '/' . $playCode . '.json';
    
    if (!file_exists($file)) {
        return null;
    }
    
    $data = file_get_contents($file);
    return json_decode($data, true);
}

/**
 * Obtenir l'état actuel du jeu (pour polling)
 */
function getGameState() {
    $playCode = isset($_GET['playCode']) ? trim($_GET['playCode']) : '';
    $nickname = isset($_GET['nickname']) ? trim($_GET['nickname']) : '';
    
    error_log("GET_STATE: playCode=$playCode, nickname=$nickname");
    
    if (empty($playCode) || empty($nickname)) {
        error_log("GET_STATE: Paramètres manquants");
        echo json_encode(['success' => false, 'message' => 'Paramètres manquants']);
        return;
    }
    
    $session = loadSession($playCode);
    
    if (!$session) {
        error_log("GET_STATE: Session introuvable pour $playCode");
        echo json_encode(['success' => false, 'message' => 'Session introuvable']);
        return;
    }
    
    error_log("GET_STATE: Session trouvée, state=" . ($session['state'] ?? 'none') . ", currentQuestion=" . ($session['currentQuestion'] ?? 'none'));
    
    // Vérifier si le joueur existe
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
        error_log("GET_STATE: Joueur $nickname non trouvé (kicked)");
        echo json_encode(['success' => false, 'message' => 'Joueur non trouvé', 'kicked' => true]);
        return;
    }
    
    // Mettre à jour le ping
    $session['players'][$playerIndex]['lastPing'] = time();
    saveSession($playCode, $session);
    
    // Récupérer les joueurs connectés
    $connectedPlayers = array_filter($session['players'], function($p) {
        return $p['connected'] && (time() - $p['lastPing'] < PING_TIMEOUT);
    });
    
    // Préparer la réponse
    $response = [
        'success' => true,
        'state' => $session['state'],
        'paused' => $session['paused'] ?? false,
        'players' => array_values($connectedPlayers),
        'currentQuestion' => $session['currentQuestion'] ?? -1
    ];
    
    // Si une question est active, inclure ses données
    if ($session['state'] === 'playing' && isset($session['currentQuestion'])) {
        $qIndex = $session['currentQuestion'];
        error_log("GET_STATE: Question active détectée, index=$qIndex");
        if (isset($session['questions'][$qIndex])) {
            $response['question'] = [
                'index' => $qIndex,
                'data' => $session['questions'][$qIndex],
                'startTime' => $session['questionStartTime'] ?? time()
            ];
            error_log("GET_STATE: Question incluse dans réponse");
        } else {
            error_log("GET_STATE: ERREUR - question index $qIndex n'existe pas dans session");
        }
    }
    
    // Si des résultats sont disponibles
    if (isset($session['questionCompletedTime']) && isset($session['currentQuestion'])) {
        $qIndex = $session['currentQuestion'];
        $results = calculateQuestionResults($session, $qIndex);
        $response['results'] = $results;
        error_log("GET_STATE: Résultats inclus pour question $qIndex");
    }
    
    // Si le jeu est terminé
    if ($session['state'] === 'finished') {
        $response['finalResults'] = calculateFinalResults($session);
        error_log("GET_STATE: Résultats finaux inclus");
    }
    
    echo json_encode($response);
}

/**
 * Sauvegarder une session
 */
function saveSession($playCode, $session) {
    // Convertir en majuscules pour cohérence
    $playCode = strtoupper(trim($playCode));
    $file = SESSIONS_DIR . '/' . $playCode . '.json';
    file_put_contents($file, json_encode($session, JSON_PRETTY_PRINT));
}

/**
 * Nettoyer les anciennes sessions
 */
function cleanOldSessions() {
    $files = glob(SESSIONS_DIR . '/*.json');
    $now = time();
    
    foreach ($files as $file) {
        $mtime = filemtime($file);
        if ($now - $mtime > SESSION_TIMEOUT) {
            unlink($file);
        }
    }
}
?>
