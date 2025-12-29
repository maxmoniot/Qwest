<?php
// ============================================
// QWEST - CONTROL API
// Description: API de pilotage pour le professeur
// ============================================

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

define('SESSIONS_DIR', __DIR__ . '/data/sessions');

// Créer les dossiers si nécessaires
if (!file_exists(__DIR__ . '/data')) {
    mkdir(__DIR__ . '/data', 0755, true);
}
if (!file_exists(SESSIONS_DIR)) {
    mkdir(SESSIONS_DIR, 0755, true);
}

$action = isset($_GET['action']) ? $_GET['action'] : (isset($_POST['action']) ? $_POST['action'] : '');

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
        streamControl();
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
    error_log("CREATE_SESSION: Session créée pour $playCode");
    
    echo json_encode(['success' => true]);
}

function startGame() {
    $playCode = $_POST['playCode'] ?? '';
    $manualMode = $_POST['manualMode'] ?? '0';
    $showTop3 = $_POST['showTop3'] ?? '1';
    
    error_log("START_GAME: Reçu manualMode POST = '$manualMode'");
    
    $session = loadSession($playCode);
    
    if ($session) {
        $session['state'] = 'playing';
        $session['startTime'] = time();
        $session['manualMode'] = $manualMode === '1';
        $session['showTop3'] = $showTop3 === '1';
        
        error_log("START_GAME: Session manualMode = " . ($session['manualMode'] ? 'true' : 'false') . ", type = " . gettype($session['manualMode']));
        
        saveSession($playCode, $session);
        
        echo json_encode(['success' => true]);
    } else {
        echo json_encode(['success' => false]);
    }
}

function updateQuestions() {
    $playCode = $_POST['playCode'] ?? '';
    $questionsJson = $_POST['questions'] ?? '';
    $quizDataJson = $_POST['quizData'] ?? '';
    
    $session = loadSession($playCode);
    
    if ($session) {
        // Mettre à jour les questions sans toucher aux joueurs
        if ($questionsJson) {
            $questions = json_decode($questionsJson, true);
            $session['questions'] = $questions;
            // Mettre à jour aussi dans quizData pour cohérence
            if (!isset($session['quizData'])) {
                $session['quizData'] = [];
            }
            $session['quizData']['questions'] = $questions;
        }
        
        // Mettre à jour quizData si fourni (écrase la mise à jour précédente)
        if ($quizDataJson) {
            $session['quizData'] = json_decode($quizDataJson, true);
            // Synchroniser questions
            if (isset($session['quizData']['questions'])) {
                $session['questions'] = $session['quizData']['questions'];
            }
        }
        
        saveSession($playCode, $session);
        
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
    if ($session) {
        $session['paused'] = $paused === '1';
        saveSession($playCode, $session);
        echo json_encode(['success' => true]);
    }
}

function nextQuestion() {
    $playCode = $_POST['playCode'] ?? '';
    $questionIndex = intval($_POST['questionIndex'] ?? 0);
    $customTime = $_POST['customTime'] ?? null;
    
    error_log("NEXT_QUESTION: Reçu customTime brut = " . var_export($customTime, true));
    
    // Convertir en int si c'est une chaîne numérique, sinon null
    if ($customTime !== null && $customTime !== '' && $customTime !== 'null') {
        $customTime = intval($customTime);
        error_log("NEXT_QUESTION: customTime converti en int = $customTime");
    } else {
        $customTime = null;
        error_log("NEXT_QUESTION: customTime mis à null");
    }
    
    $session = loadSession($playCode);
    if ($session) {
        $session['currentQuestion'] = $questionIndex;
        $session['questionStartTime'] = time();
        
        // Stocker ou supprimer le temps personnalisé
        if ($customTime !== null) {
            $session['customTime'] = $customTime;
            error_log("NEXT_QUESTION: customTime stocké dans session = $customTime");
        } else {
            unset($session['customTime']);
            error_log("NEXT_QUESTION: customTime supprimé de la session");
        }
        
        // Réinitialiser le flag de complétion pour la nouvelle question
        $session['questionCompleted'] = false;
        unset($session['questionCompletedTime']);
        
        saveSession($playCode, $session);
        
        error_log("NEXT_QUESTION: Question $questionIndex lancée, customTime=" . ($customTime ?? 'none'));
        
        echo json_encode(['success' => true]);
    }
}

function endGame() {
    $playCode = $_POST['playCode'] ?? '';
    
    $session = loadSession($playCode);
    if ($session) {
        $session['state'] = 'finished';
        $session['endTime'] = time();
        $session['paused'] = false;  // Enlever la pause
        saveSession($playCode, $session);
        
        echo json_encode(['success' => true]);
    }
}

function cleanupSession() {
    $playCode = $_POST['playCode'] ?? '';
    
    if (empty($playCode)) {
        echo json_encode(['success' => false, 'message' => 'Code manquant']);
        return;
    }
    
    // Supprimer le fichier de session
    $sessionFile = SESSIONS_DIR . '/' . $playCode . '.json';
    if (file_exists($sessionFile)) {
        unlink($sessionFile);
        error_log("CLEANUP: Session $playCode supprimée");
    }
    
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

function loadSession($playCode) {
    // Convertir en majuscules pour éviter les problèmes de casse
    $playCode = strtoupper(trim($playCode));
    $file = SESSIONS_DIR . '/' . $playCode . '.json';
    if (file_exists($file)) {
        return json_decode(file_get_contents($file), true);
    }
    return null;
}

function saveSession($playCode, $session) {
    // Convertir en majuscules pour cohérence
    $playCode = strtoupper(trim($playCode));
    file_put_contents(SESSIONS_DIR . '/' . $playCode . '.json', json_encode($session));
}

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
    
    $found = false;
    foreach ($session['players'] as &$player) {
        if ($player['nickname'] === $nickname) {
            $oldScore = $player['score'];
            $player['score'] = $score;
            $found = true;
            error_log("UPDATE_SCORE: $nickname score $oldScore -> $score");
            break;
        }
    }
    unset($player); // Fermer la référence
    
    if (!$found) {
        error_log("UPDATE_SCORE: Joueur $nickname non trouvé");
    }
    
    saveSession($playCode, $session);
    echo json_encode(['success' => true]);
}

function removePlayer() {
    $playCode = $_POST['playCode'] ?? '';
    $nickname = $_POST['nickname'] ?? '';
    
    error_log("REMOVE_PLAYER: playCode=$playCode, nickname=$nickname");
    
    $session = loadSession($playCode);
    if (!$session) {
        echo json_encode(['success' => false]);
        return;
    }
    
    error_log("REMOVE_PLAYER: Avant - " . count($session['players']) . " joueurs");
    
    $session['players'] = array_values(array_filter($session['players'], function($player) use ($nickname) {
        $keep = $player['nickname'] !== $nickname;
        error_log("REMOVE_PLAYER: {$player['nickname']} - " . ($keep ? 'GARDER' : 'SUPPRIMER'));
        return $keep;
    }));
    
    error_log("REMOVE_PLAYER: Après - " . count($session['players']) . " joueurs");
    
    // Recalculer si tous les joueurs restants ont répondu à la question actuelle
    if (isset($session['currentQuestion']) && $session['currentQuestion'] >= 0 && $session['state'] === 'playing') {
        $questionIndex = $session['currentQuestion'];
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
        
        // Si après la suppression, tous les joueurs restants ont répondu, activer questionCompleted
        if ($allAnswered && $connectedPlayers > 0 && !isset($session['questionCompleted'])) {
            error_log("REMOVE_PLAYER: Tous les joueurs restants ont répondu Q$questionIndex, activation questionCompleted");
            $session['questionCompleted'] = true;
            $session['questionCompletedTime'] = time();
        }
    }
    
    saveSession($playCode, $session);
    echo json_encode(['success' => true]);
}

function forceQuestionComplete() {
    $playCode = $_POST['playCode'] ?? '';
    $questionIndex = intval($_POST['questionIndex'] ?? -1);
    
    error_log("FORCE_QUESTION_COMPLETE: playCode=$playCode, questionIndex=$questionIndex");
    
    $session = loadSession($playCode);
    if (!$session) {
        echo json_encode(['success' => false, 'message' => 'Session introuvable']);
        return;
    }
    
    // Forcer la question comme complétée
    $session['questionCompleted'] = true;
    $session['questionCompletedTime'] = time();
    
    error_log("FORCE_QUESTION_COMPLETE: Question $questionIndex marquée comme complétée");
    
    saveSession($playCode, $session);
    echo json_encode(['success' => true]);
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
    
    error_log("GET_CONTROL_STATE: Session trouvée, state=" . ($session['state'] ?? 'unknown'));
    
    // Récupérer TOUS les joueurs avec mise à jour du statut connected
    $allPlayers = $session['players'] ?? [];
    
    foreach ($allPlayers as &$player) {
        $timeSinceLastPing = time() - ($player['lastPing'] ?? 0);
        if ($timeSinceLastPing >= 60) {
            $player['connected'] = false;
        }
    }
    unset($player);
    
    $response = [
        'success' => true,
        'players' => array_values($allPlayers),
        'state' => $session['state'] ?? 'waiting',
        'currentQuestion' => $session['currentQuestion'] ?? -1,
        'paused' => $session['paused'] ?? false
    ];
    
    // Si des résultats sont disponibles
    if (isset($session['questionCompletedTime']) && isset($session['currentQuestion'])) {
        $response['resultsAvailable'] = true;
        $response['questionIndex'] = $session['currentQuestion'];
    }
    
    echo json_encode($response);
}
?>
