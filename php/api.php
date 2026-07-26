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
// CORS retiré : same-origin uniquement (l'app n'expose pas son API à des sites tiers).

// Anti-cache : les réponses de l'API (notamment check_game) ne doivent JAMAIS être mises
// en cache par le navigateur. Un « exists:false » transitoire resservi depuis le cache
// faisait croire à un « code invalide » jusqu'au rechargement de la page.
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

// Configuration
define('DATA_DIR', __DIR__ . '/data');
define('QUIZZES_DIR', DATA_DIR . '/quizzes');
define('SESSIONS_DIR', DATA_DIR . '/sessions');

// Store partagé : verrou de session séparé (CODE.lock) + écriture atomique —
// le même mécanisme que game.php/control.php (cf. en-tête de session_store.php).
require_once __DIR__ . '/session_store.php';

// Filet anti-500 : tout crash est tracé (errors-*.log) et converti en JSON dégradé
// HTTP 200. api.php gère déjà son propre ob_start (ligne 8) → on ne démarre pas un
// second tampon (false), on réutilise le sien pour jeter une sortie partielle.
qst_registerErrorNet(false);

// === Logging métriques (diagnostic) ===
// api.php n'était pas tracé : on était AVEUGLE sur les échecs de check_game/get_animals
// (cause probable des « code invalide »). On loggue chaque requête au MÊME format TSV
// que game.php (timestamp, ip, endpoint, code, nickname, http, durée_ms, details, ua),
// dans le même dossier (rotation 7 j assurée par cleanOldMetricsFiles de game.php).
$GLOBALS['__apiMetricStart'] = microtime(true);
register_shutdown_function(function() {
    $dir = __DIR__ . '/data/metrics';
    if (!is_dir($dir)) { @mkdir($dir, 0755, true); }
    if (!is_writable($dir)) return;
    $endpoint = $_GET['action'] ?? $_POST['action'] ?? 'unknown';
    $code = $_GET['code'] ?? $_POST['code'] ?? $_GET['playCode'] ?? $_POST['playCode'] ?? '';
    $http = http_response_code(); if ($http === false) $http = 200;
    $dur = (int) round((microtime(true) - ($GLOBALS['__apiMetricStart'] ?? microtime(true))) * 1000);
    $clean = function($v){ return str_replace(["\t", "\n", "\r"], ' ', (string)$v); };
    $line = implode("\t", [
        time(),
        $clean($_SERVER['REMOTE_ADDR'] ?? '?'),
        $clean($endpoint),
        $clean(substr((string)$code, 0, 16)),
        '',
        intval($http),
        intval($dur),
        'api',
        $clean(substr((string)($_SERVER['HTTP_USER_AGENT'] ?? '?'), 0, 30))
    ]) . "\n";
    @file_put_contents($dir . '/' . date('Y-m-d') . '.log', $line, FILE_APPEND);
});

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

/**
 * Valide un playCode (anti path traversal). Format : 3-12 chars [A-Z0-9].
 * Retourne le code normalisé ou null si invalide.
 */
function validatePlayCode($code) {
    $code = strtoupper(trim((string)$code));
    return preg_match('/^[A-Z0-9]{3,12}$/', $code) ? $code : null;
}

/**
 * Valide une imageUrl utilisée dans un quiz. Refuse les schémas dangereux
 * (javascript:, data:, vbscript:) qui permettraient un XSS au chargement.
 * Accepte : http://, https://, et chemins relatifs (sans ..).
 * Vide / null = OK (pas d'image).
 */
function validateImageUrl($url) {
    if ($url === null || $url === '') return true;
    if (!is_string($url)) return false;
    $url = trim($url);
    if ($url === '') return true;
    // Schémas dangereux explicitement bloqués
    if (preg_match('#^\s*(javascript|data|vbscript|file)\s*:#i', $url)) return false;
    // Schémas autorisés
    if (preg_match('#^https?://#i', $url)) {
        return filter_var($url, FILTER_VALIDATE_URL) !== false;
    }
    // Chemin relatif sans path traversal
    if (strpos($url, '..') !== false) return false;
    return preg_match('#^[a-zA-Z0-9_\-/.]+$#', $url) === 1;
}

/**
 * Valide récursivement les imageUrl dans toutes les questions d'un quiz.
 * Retourne true si toutes les URLs sont saines, false sinon.
 */
function validateQuizImages($quizData) {
    if (!is_array($quizData)) return true;
    $questions = $quizData['questions'] ?? [];
    foreach ($questions as $q) {
        if (isset($q['imageUrl']) && !validateImageUrl($q['imageUrl'])) {
            return false;
        }
    }
    return true;
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
        // Limite de taille : 2 MB max pour quizData (évite les DoS mémoire/disque)
        if (isset($_POST['quizData']) && strlen($_POST['quizData']) > 2 * 1024 * 1024) {
            http_response_code(413);
            sendJSON(['success' => false, 'message' => 'Quiz trop volumineux (max 2 Mo)']);
        }

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

        // Valider les imageUrl du quiz (anti-XSS via javascript:/data:)
        $parsedQuiz = json_decode($quizData, true);
        if (!validateQuizImages($parsedQuiz)) {
            sendJSON([
                'success' => false,
                'message' => 'URL d\'image invalide dans une des questions'
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
        
        $fileContent = json_decode(file_get_contents($filePath), true);
        
        // Détecter le format du fichier
        // Format avec métadonnées (sauvegardé via l'app) : contient 'data' et 'modifyCode'
        // Format brut (généré par IA ou exporté) : contient directement 'questions'
        
        if (isset($fileContent['data']) && isset($fileContent['data']['questions'])) {
            // Format avec métadonnées
            $quizData = $fileContent['data'];
            $playCode = $fileContent['playCode'] ?? '';
        } elseif (isset($fileContent['questions'])) {
            // Format brut - le fichier EST le quiz directement
            $quizData = $fileContent;
            $playCode = ''; // Pas de code de jeu prédéfini
        } else {
            sendJSON([
                'success' => false,
                'message' => 'Format de questionnaire invalide'
            ]);
            return;
        }
        
        sendJSON([
            'success' => true,
            'quiz' => $quizData,
            'playCode' => $playCode
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
            $content = json_decode(file_get_contents($file), true);
            
            if (!$content) {
                continue; // Fichier JSON invalide, on l'ignore
            }
            
            // Détecter le format du fichier
            // Format avec métadonnées (sauvegardé via l'app) : contient 'name', 'questionCount', 'lastModified'
            // Format brut (généré par IA) : contient 'name', 'questionsCount', 'createdAt', 'questions'
            
            if (isset($content['questionCount']) && isset($content['lastModified'])) {
                // Format avec métadonnées (ancien format de l'app)
                $quizzes[] = [
                    'name' => $content['name'] ?? basename($file, '.json'),
                    'questionCount' => $content['questionCount'],
                    'lastModified' => $content['lastModified']
                ];
            } elseif (isset($content['questions'])) {
                // Format brut (généré par IA ou exporté)
                $questionCount = isset($content['questionsCount']) ? $content['questionsCount'] : count($content['questions']);
                
                // Utiliser createdAt si disponible, sinon la date de modification du fichier
                if (isset($content['createdAt'])) {
                    $lastModified = strtotime($content['createdAt']);
                } else {
                    $lastModified = filemtime($file);
                }
                
                $quizzes[] = [
                    'name' => $content['name'] ?? basename($file, '.json'),
                    'questionCount' => $questionCount,
                    'lastModified' => $lastModified
                ];
            }
            // Si aucun format reconnu, on ignore le fichier
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
        $playCode = validatePlayCode($_GET['code'] ?? '');
        if ($playCode === null) {
            sendJSON([
                'success' => true,
                'exists' => false
            ]);
            return;
        }

        // Chercher dans les sessions actives (pas dans les quizzes sauvegardés)
        $sessionFile = __DIR__ . '/data/sessions/' . $playCode . '.json';
        
        if (file_exists($sessionFile)) {
            // Lecture sans verrou : si on tombe pile pendant une écriture in-place, le
            // JSON peut être tronqué (json_decode → null). On NE renvoie alors PAS
            // exists:false (ce serait un faux « code invalide ») : on signale "transient"
            // et le client réessaie (cf. retry dans auth.js joinGameWithCode).
            $raw = @file_get_contents($sessionFile);
            $session = ($raw !== false && $raw !== '') ? json_decode($raw, true) : null;
            if (!is_array($session)) {
                sendJSON(['success' => false, 'message' => 'Session en cours de lecture', 'retryable' => true]);
                return;
            }

            // Utiliser les questions limitées si elles existent, sinon les questions originales
            $questions = $session['questions'] ?? $session['quizData']['questions'] ?? [];

            sendJSON([
                'success' => true,
                'exists' => true,
                'quizName' => isset($session['quizData']['name']) ? $session['quizData']['name'] : 'Quiz',
                'totalQuestions' => count($questions),
                'customNicknames' => isset($session['customNicknames']) ? $session['customNicknames'] : false
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
    $playCode = validatePlayCode($_GET['code'] ?? '');
    if ($playCode === null) {
        sendJSON([
            'success' => false,
            'message' => 'Code de partie invalide'
        ]);
        return;
    }

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
    
    // VERROUILLAGE via le fichier de verrou séparé (CODE.lock) — même mécanisme que
    // game.php/control.php : l'écriture du .json est atomique (tmp+rename sur Linux),
    // le verrou ne vit donc plus sur le .json lui-même. Voir session_store.php.
    // Vérifier l'existence AVANT d'acquérir (sinon on créerait un .lock orphelin).
    if (!file_exists($sessionFile)) {
        sendJSON(['success' => false, 'message' => 'Code de partie invalide']);
        return;
    }
    $fp = qst_acquireSessionLock($playCode, 4);
    if (!$fp) {
        sendJSON(['success' => false, 'message' => 'Serveur occupé, réessayez']);
        return;
    }

    // Lire la session (lecture FRAÎCHE après acquisition du verrou)
    $content = @file_get_contents($sessionFile);
    $session = json_decode((string)$content, true);
    if (!is_array($session)) {
        qst_releaseSessionLock($fp);
        sendJSON(['success' => false, 'message' => 'Session illisible, réessayez']);
        return;
    }
    
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
            qst_releaseSessionLock($fp);

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
    
    // Écrire (atomique pour les lecteurs) et libérer le verrou
    qst_atomicWriteFile($sessionFile, json_encode($session, JSON_PRETTY_PRINT));
    qst_releaseSessionLock($fp);

    sendJSON([
        'success' => true,
        'animals' => $selected
    ]);
}
?>
