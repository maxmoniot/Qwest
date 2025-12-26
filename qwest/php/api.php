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
        
        // Chercher dans les sessions actives (pas dans les quizzes sauvegardés)
        $sessionFile = __DIR__ . '/data/sessions/' . $playCode . '.json';
        
        if (file_exists($sessionFile)) {
            $session = json_decode(file_get_contents($sessionFile), true);
            
            sendJSON([
                'success' => true,
                'exists' => true,
                'quizName' => isset($session['quizData']['name']) ? $session['quizData']['name'] : 'Quiz',
                'totalQuestions' => isset($session['quizData']['questions']) ? count($session['quizData']['questions']) : 0
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
    define('SESSIONS_DIR', __DIR__ . '/data/sessions');
    
    // Liste complète de 120 animaux
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
    
    $sessionFile = SESSIONS_DIR . '/' . $playCode . '.json';
    
    if (!file_exists($sessionFile)) {
        sendJSON([
            'success' => false,
            'message' => 'Session introuvable'
        ]);
        return;
    }
    
    $session = json_decode(file_get_contents($sessionFile), true);
    $usedAnimals = $session['usedAnimals'] ?? [];
    
    // Animaux disponibles (pas encore utilisés)
    $available = array_values(array_diff($ALL_ANIMALS, $usedAnimals));
    
    // Si moins de 3 disponibles, réinitialiser
    if (count($available) < 3) {
        $usedAnimals = [];
        $available = $ALL_ANIMALS;
    }
    
    // Sélectionner 3 aléatoirement
    shuffle($available);
    $selected = array_slice($available, 0, 3);
    
    // Marquer comme utilisés
    $session['usedAnimals'] = array_merge($usedAnimals, $selected);
    file_put_contents($sessionFile, json_encode($session, JSON_PRETTY_PRINT));
    
    sendJSON([
        'success' => true,
        'animals' => $selected
    ]);
}
?>
