<?php
// ============================================
// QWEST - API PRINCIPALE
// Description: Gestion des questionnaires (sauvegarde, chargement, vérification)
// ============================================

// Supprimer toute sortie avant le JSON
ob_start();
error_reporting(E_ALL);
ini_set('display_errors', 0); // Ne pas afficher les erreurs dans la sortie
ini_set('log_errors', 1);
ini_set('error_log', __DIR__ . '/error.log'); // Logger dans un fichier

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST');
header('Access-Control-Allow-Headers: Content-Type');

// Configuration
define('DATA_DIR', __DIR__ . '/data');
define('QUIZZES_DIR', DATA_DIR . '/quizzes');

// Fonction helper pour envoyer du JSON propre
function sendJSON($data) {
    ob_get_clean(); // Vider et récupérer le buffer
    ob_start(); // Redémarrer un nouveau buffer
    echo json_encode($data);
    ob_end_flush(); // Envoyer le buffer
    exit;
}

// Fonction pour nettoyer les noms de fichiers
function sanitizeFileName($name) {
    // Remplacer les caractères spéciaux par des underscores
    $name = preg_replace('/[^a-zA-Z0-9_\-]/', '_', $name);
    // Limiter la longueur
    $name = substr($name, 0, 100);
    return $name;
}

// Créer les dossiers si nécessaires
if (!file_exists(DATA_DIR)) {
    mkdir(DATA_DIR, 0755, true);
}
if (!file_exists(QUIZZES_DIR)) {
    mkdir(QUIZZES_DIR, 0755, true);
}

// Récupérer l'action
$action = isset($_GET['action']) ? $_GET['action'] : (isset($_POST['action']) ? $_POST['action'] : '');

// Router les actions
switch ($action) {
    case 'save_quiz':
        saveQuiz();
        break;
    
    case 'load_quiz':
        loadQuiz();
        break;
    
    case 'list_quizzes':
        listQuizzes();
        break;
    
    case 'check_quiz':
        checkQuizExists();
        break;
    
    case 'verify_modify_code':
        verifyModifyCode();
        break;
    
    case 'check_game':
        checkGameExists();
        break;
    
    case 'get_animals':
        getUniqueAnimals();
        break;
    
    default:
        sendJSON([
            'success' => false,
            'message' => 'Action non reconnue'
        ]);
}

// Script terminé
exit;

// ========================================
// FONCTIONS
// ========================================

/**
 * Sauvegarder un questionnaire
 */
function saveQuiz() {
    try {
        // Récupérer les données
        $quizName = isset($_POST['quizName']) ? trim($_POST['quizName']) : '';
        $modifyCode = isset($_POST['modifyCode']) ? trim($_POST['modifyCode']) : '';
        $playCode = isset($_POST['playCode']) ? trim($_POST['playCode']) : '';
        $quizData = isset($_POST['quizData']) ? $_POST['quizData'] : '';
        $captchaAnswer = isset($_POST['captchaAnswer']) ? intval($_POST['captchaAnswer']) : 0;
        $captchaExpected = isset($_POST['captchaExpected']) ? intval($_POST['captchaExpected']) : 0;
        
        // Validations
        if (empty($quizName) || empty($modifyCode) || empty($playCode) || empty($quizData)) {
            sendJSON([
                'success' => false,
                'message' => 'Données manquantes'
            ]);
        }
        
        // Vérifier le captcha
        if ($captchaAnswer !== $captchaExpected) {
            sendJSON([
                'success' => false,
                'message' => 'Captcha incorrect'
            ]);
        }
        
        // Nettoyer le nom du fichier
        $fileName = sanitizeFileName($quizName);
        $filePath = QUIZZES_DIR . '/' . $fileName . '.json';
        
        // Préparer les métadonnées
        $metadata = [
            'name' => $quizName,
            'modifyCode' => $modifyCode,
            'playCode' => $playCode,
            'data' => json_decode($quizData, true),
            'lastModified' => time(),
            'questionCount' => 0
        ];
        
        // Compter les questions
        if (isset($metadata['data']['questions'])) {
            $metadata['questionCount'] = count($metadata['data']['questions']);
        }
        
        // Sauvegarder
        file_put_contents($filePath, json_encode($metadata, JSON_PRETTY_PRINT));
        
        // Réponse succès
        sendJSON([
            'success' => true,
            'message' => 'Questionnaire sauvegardé avec succès !',
            'playCode' => $playCode,
            'quizName' => $quizName
        ]);
        
    } catch (Exception $e) {
        sendJSON([
            'success' => false,
            'message' => 'Erreur serveur : ' . $e->getMessage()
        ]);
    }
}

/**
 * Charger un questionnaire
 */
function loadQuiz() {
    try {
        $quizName = isset($_GET['name']) ? trim($_GET['name']) : '';
        
        if (empty($quizName)) {
            sendJSON([
                'success' => false,
                'message' => 'Nom du questionnaire manquant'
            ]);
            return;
        }
        
        $fileName = sanitizeFileName($quizName);
        $filePath = QUIZZES_DIR . '/' . $fileName . '.json';
        
        if (!file_exists($filePath)) {
            sendJSON([
                'success' => false,
                'message' => 'Questionnaire introuvable'
            ]);
            return;
        }
        
        $metadata = json_decode(file_get_contents($filePath), true);
        
        sendJSON([
            'success' => true,
            'quiz' => $metadata['data'],
            'playCode' => $metadata['playCode']
        ]);
        
    } catch (Exception $e) {
        sendJSON([
            'success' => false,
            'message' => 'Erreur de chargement : ' . $e->getMessage()
        ]);
    }
}

/**
 * Lister tous les questionnaires
 */
function listQuizzes() {
    try {
        $quizzes = [];
        $files = glob(QUIZZES_DIR . '/*.json');
        
        foreach ($files as $file) {
            $metadata = json_decode(file_get_contents($file), true);
            
            $quizzes[] = [
                'name' => $metadata['name'],
                'questionCount' => $metadata['questionCount'],
                'lastModified' => $metadata['lastModified']
            ];
        }
        
        // Trier par date de modification décroissante
        usort($quizzes, function($a, $b) {
            return $b['lastModified'] - $a['lastModified'];
        });
        
        sendJSON([
            'success' => true,
            'quizzes' => $quizzes
        ]);
        
    } catch (Exception $e) {
        sendJSON([
            'success' => false,
            'message' => 'Erreur de listage : ' . $e->getMessage()
        ]);
    }
}

/**
 * Vérifier si un questionnaire existe
 */
function checkQuizExists() {
    try {
        $quizName = isset($_GET['name']) ? trim($_GET['name']) : '';
        
        if (empty($quizName)) {
            sendJSON([
                'success' => true,
                'exists' => false
            ]);
            return;
        }
        
        $fileName = sanitizeFileName($quizName);
        $filePath = QUIZZES_DIR . '/' . $fileName . '.json';
        
        sendJSON([
            'success' => true,
            'exists' => file_exists($filePath)
        ]);
        
    } catch (Exception $e) {
        sendJSON([
            'success' => false,
            'message' => 'Erreur de vérification : ' . $e->getMessage()
        ]);
    }
}

/**
 * Vérifier le code de modification
 */
function verifyModifyCode() {
    try {
        $quizName = isset($_POST['quizName']) ? trim($_POST['quizName']) : '';
        $modifyCode = isset($_POST['modifyCode']) ? trim($_POST['modifyCode']) : '';
        
        if (empty($quizName) || empty($modifyCode)) {
            sendJSON([
                'success' => false,
                'message' => 'Données manquantes'
            ]);
            return;
        }
        
        $fileName = sanitizeFileName($quizName);
        $filePath = QUIZZES_DIR . '/' . $fileName . '.json';
        
        if (!file_exists($filePath)) {
            sendJSON([
                'success' => false,
                'message' => 'Questionnaire introuvable'
            ]);
            return;
        }
        
        $metadata = json_decode(file_get_contents($filePath), true);
        
        if ($metadata['modifyCode'] === $modifyCode) {
            sendJSON([
                'success' => true,
                'message' => 'Code valide'
            ]);
        } else {
            sendJSON([
                'success' => false,
                'message' => 'Code incorrect'
            ]);
        }
        
    } catch (Exception $e) {
        sendJSON([
            'success' => false,
            'message' => 'Erreur de vérification : ' . $e->getMessage()
        ]);
    }
}

/**
 * Vérifier si une partie existe (par code de jeu)
 */
function checkGameExists() {
    try {
        $playCode = isset($_GET['code']) ? trim($_GET['code']) : '';
        
        if (empty($playCode)) {
            sendJSON([
                'success' => true,
                'exists' => false
            ]);
            return;
        }
        
        // Normaliser en majuscules pour éviter les problèmes de casse
        $playCode = strtoupper($playCode);
        
        // Chercher dans les sessions actives (pas dans les quizzes sauvegardés)
        $sessionFile = __DIR__ . '/data/sessions/' . $playCode . '.json';
        
        if (file_exists($sessionFile)) {
            $session = json_decode(file_get_contents($sessionFile), true);
            
            // Utiliser les questions limitées si elles existent, sinon les questions originales
            $questions = $session['questions'] ?? $session['quizData']['questions'] ?? [];
            
            sendJSON([
                'success' => true,
                'exists' => true,
                'quizName' => isset($session['quizData']['name']) ? $session['quizData']['name'] : 'Quiz',
                'totalQuestions' => count($questions)
            ]);
            return;
        }
        
        // Aucune session trouvée avec ce code
        sendJSON([
            'success' => true,
            'exists' => false
        ]);
        
    } catch (Exception $e) {
        sendJSON([
            'success' => false,
            'message' => 'Erreur lors de la vérification'
        ]);
    }
}

/**
 * Obtenir 3 animaux uniques pour un joueur
 */
function getUniqueAnimals() {
    // Utiliser la constante définie au début du fichier
    $sessionsDir = __DIR__ . '/data/sessions';
    
    // Liste complète de 120 animaux UNIQUES
$ALL_ANIMALS = [
    // Mammifères terrestres (30)
    '🦁 Lion', '🐯 Tigre', '🐻 Ours', '🐼 Panda', '🦊 Renard',
    '🐺 Loup', '🦝 Raton laveur', '🐨 Koala', '🐹 Hamster', '🐰 Lapin',
    '🦔 Hérisson', '🐿️ Écureuil', '🦫 Castor', '🦘 Kangourou', '🦙 Lama',
    '🦒 Girafe', '🦏 Rhinocéros', '🦛 Hippopotame', '🐘 Éléphant', '🐆 Léopard',
    '🦓 Zèbre', '🦌 Cerf', '🐃 Buffle', '🐂 Bœuf', '🐄 Vache',
    '🐎 Cheval', '🦬 Bison', '🐖 Cochon', '🐏 Mouton', '🐐 Chèvre',
    
    // Petits mammifères (10)
    '🐁 Souris', '🐀 Rat', '🦡 Blaireau', '🦨 Mouffette', '🦦 Loutre',
    '🐕 Chien', '🐩 Caniche', '🐈 Chat', '🐈‍⬛ Chat noir', '🐇 Lapin blanc',
    
    // Créatures marines (20)
    '🐋 Baleine', '🐳 Cachalot', '🐬 Dauphin', '🦈 Requin', '🐙 Pieuvre',
    '🦑 Calmar', '🦀 Crabe', '🦞 Homard', '🐠 Poisson', '🐡 Poisson-globe',
    '🐟 Poisson tropical', '🦭 Phoque', '🐢 Tortue marine', '🦎 Lézard',
    '🦐 Crevette', '🦪 Huître', '🐚 Coquillage', '🦑 Seiche', '🐡 Fugu',
    '🐟 Poisson-clown',
    
    // Oiseaux (20)
    '🦅 Aigle', '🦉 Hibou', '🦚 Paon', '🦤 Dodo', '🐧 Pingouin',
    '🐦 Oiseau', '🐤 Poussin', '🐥 Caneton', '🦢 Cygne', '🕊️ Colombe',
    '🦃 Dinde', '🦜 Perroquet', '🦩 Flamant rose', '🐓 Coq', '🦆 Canard',
    '🦅 Faucon', '🦉 Chouette', '🐦‍⬛ Corbeau', '🦇 Chauve-souris', '🦜 Ara',
    
    // Insectes (15)
    '🐝 Abeille', '🐛 Chenille', '🦋 Papillon', '🐌 Escargot', '🐞 Coccinelle',
    '🦗 Criquet', '🕷️ Araignée', '🦂 Scorpion', '🦟 Moustique', '🪲 Scarabée',
    '🐜 Fourmi', '🪰 Mouche', '🦟 Libellule', '🪳 Cafard', '🐛 Ver',
    
    // Reptiles et amphibiens (10)
    '🐍 Serpent', '🦕 Brachiosaure', '🦖 T-Rex', '🐊 Crocodile', '🐸 Grenouille',
    '🦎 Gecko', '🐢 Tortue', '🐊 Alligator', '🦎 Caméléon', '🐸 Rainette',
    
    // Animaux polaires et arctiques (5)
    '🐻‍❄️ Ours polaire', '🦭 Morse', '🐧 Manchot', '🦦 Loutre de mer', '🦊 Renard polaire',
    
    // Animaux d'Afrique (10)
    '🦁 Lionne', '🦒 Girafon', '🦓 Zébreau', '🦏 Rhino', '🐘 Éléphanteau',
    '🦛 Hippo', '🐆 Guépard', '🦘 Wallaby', '🦙 Alpaga', '🐅 Panthère'
];
    $playCode = $_GET['code'] ?? '';
    
    if (empty($playCode)) {
        sendJSON([
            'success' => false,
            'message' => 'Code manquant'
        ]);
        return;
    }
    
    // Normaliser en majuscules pour cohérence
    $playCode = strtoupper(trim($playCode));
    
    $sessionFile = $sessionsDir . '/' . $playCode . '.json';
    
    if (!file_exists($sessionFile)) {
        sendJSON([
            'success' => false,
            'message' => 'Session introuvable'
        ]);
        return;
    }
    
    // Créer une empreinte unique du poste
    // Priorité : deviceId (depuis localStorage) > IP réelle (X-Forwarded-For) > IP directe
    $deviceId = $_GET['deviceId'] ?? null;
    
    if ($deviceId && strlen($deviceId) > 10) {
        // Utiliser le deviceId fourni par le client (le plus fiable)
        $deviceHash = md5($playCode . '|' . $deviceId);
    } else {
        // Fallback : utiliser l'IP
        // Essayer X-Forwarded-For d'abord (contient souvent l'IP interne via le proxy)
        $clientIP = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? 'unknown';
        // Si X-Forwarded-For contient plusieurs IPs, prendre la première (IP du client)
        if (strpos($clientIP, ',') !== false) {
            $clientIP = trim(explode(',', $clientIP)[0]);
        }
        $deviceHash = md5($playCode . '|' . $clientIP);
    }
    
    // VERROUILLAGE du fichier pour éviter les conflits de concurrence
    $fp = fopen($sessionFile, 'r+');
    if (!$fp) {
        sendJSON(['success' => false, 'message' => 'Erreur fichier']);
        return;
    }
    
    // Attendre le verrou exclusif (max 5 secondes)
    if (!flock($fp, LOCK_EX)) {
        fclose($fp);
        sendJSON(['success' => false, 'message' => 'Serveur occupé, réessayez']);
        return;
    }
    
    // Lire la session
    $content = stream_get_contents($fp);
    $session = json_decode($content, true);
    
    // Vérifier si ce poste a déjà des pseudos attribués pour cette partie
    $deviceAnimals = $session['deviceAnimals'] ?? [];
    
    if (isset($deviceAnimals[$deviceHash])) {
        // Ce poste a déjà des pseudos attribués -> les retourner
        $selected = $deviceAnimals[$deviceHash]['animals'];
        
        // Vérifier que ces pseudos ne sont pas déjà pris par quelqu'un d'autre
        $confirmedAnimals = [];
        if (isset($session['players']) && is_array($session['players'])) {
            foreach ($session['players'] as $player) {
                if (isset($player['nickname'])) {
                    $confirmedAnimals[] = $player['nickname'];
                }
            }
        }
        
        // Filtrer les pseudos déjà confirmés par d'autres
        $stillAvailable = array_values(array_diff($selected, $confirmedAnimals));
        
        if (count($stillAvailable) > 0) {
            // Au moins un pseudo est encore disponible
            flock($fp, LOCK_UN);
            fclose($fp);
            
            sendJSON([
                'success' => true,
                'animals' => $stillAvailable
            ]);
            return;
        }
        // Sinon, tous les pseudos ont été pris -> en attribuer de nouveaux
    }
    
    // Récupérer les animaux déjà CONFIRMÉS (joueurs inscrits)
    $confirmedAnimals = [];
    if (isset($session['players']) && is_array($session['players'])) {
        foreach ($session['players'] as $player) {
            if (isset($player['nickname'])) {
                $confirmedAnimals[] = $player['nickname'];
            }
        }
    }
    
    // Récupérer les réservations temporaires (propositions en attente d'autres postes)
    $pendingReservations = $session['pendingAnimals'] ?? [];
    $now = time();
    $RESERVATION_TIMEOUT = 60; // 60 secondes pour choisir
    
    // Nettoyer les réservations expirées
    $validReservations = [];
    foreach ($pendingReservations as $animal => $timestamp) {
        if (($now - $timestamp) < $RESERVATION_TIMEOUT) {
            $validReservations[$animal] = $timestamp;
        }
    }
    
    // Animaux indisponibles = confirmés + réservés temporairement par d'autres
    $unavailable = array_merge($confirmedAnimals, array_keys($validReservations));
    
    // Animaux disponibles
    $available = array_values(array_diff($ALL_ANIMALS, $unavailable));
    
    // Si moins de 3 disponibles, nettoyer les réservations et réessayer
    if (count($available) < 3) {
        $validReservations = []; // Libérer toutes les réservations
        $available = array_values(array_diff($ALL_ANIMALS, $confirmedAnimals));
        
        // Si toujours pas assez (120 joueurs!), réutiliser tout
        if (count($available) < 3) {
            $available = $ALL_ANIMALS;
        }
    }
    
    // Sélectionner 3 aléatoirement
    shuffle($available);
    $selected = array_slice($available, 0, 3);
    
    // Marquer comme réservés temporairement (avec timestamp)
    foreach ($selected as $animal) {
        $validReservations[$animal] = $now;
    }
    $session['pendingAnimals'] = $validReservations;
    
    // Enregistrer les pseudos attribués à ce poste
    $deviceAnimals[$deviceHash] = [
        'animals' => $selected,
        'timestamp' => $now
    ];
    $session['deviceAnimals'] = $deviceAnimals;
    
    // Écrire et libérer le verrou
    fseek($fp, 0);
    ftruncate($fp, 0);
    fwrite($fp, json_encode($session, JSON_PRETTY_PRINT));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    
    sendJSON([
        'success' => true,
        'animals' => $selected
    ]);
}
?>
