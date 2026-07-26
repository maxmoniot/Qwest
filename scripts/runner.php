<?php
/**
 * Qwest — Backend du runner de tests web
 *
 * Reçoit en POST l'identifiant d'un script à lancer + ses paramètres,
 * exécute le script en CLI, capture stdout/stderr et le code de retour,
 * stocke le log dans scripts/logs/YYYY-MM-DD_HHMMSS_<script>.log,
 * retourne le contenu et l'URL du log.
 *
 * Sécurité : ce runner est volontairement local-only. Le .htaccess voisin
 * limite l'accès aux IPs locales et au réseau RFC1918. À NE PAS DÉPLOYER
 * en production OVH sans authentification supplémentaire.
 */

ini_set('display_errors', 0);
ini_set('log_errors', 1);
set_time_limit(900); // 15 minutes max — couvre les load_test longs
ini_set('max_execution_time', 900);

header('Content-Type: application/json; charset=utf-8');

$LOG_DIR = __DIR__ . '/logs';
if (!is_dir($LOG_DIR)) {
    @mkdir($LOG_DIR, 0755, true);
}
// Ménage : logs de test de plus de 7 jours supprimés (serveur propre).
foreach ((glob($LOG_DIR . '/*.log') ?: []) as $___oldLog) {
    $___mt = @filemtime($___oldLog);
    if ($___mt && (time() - $___mt) > 7 * 86400) @unlink($___oldLog);
}

// Auto-détection du binaire php CLI.
// IMPORTANT : sous Apache (mod_php), PHP_BINARY pointe sur httpd.exe — inutilisable
// pour lancer un script. On cherche donc explicitement php.exe / php.
function resolvePhpBin(): string {
    foreach (['C:\\xampp\\php\\php.exe', '/usr/bin/php', '/usr/local/bin/php'] as $p) {
        if (@is_executable($p)) return $p;
    }
    // En CLI seulement, PHP_BINARY est légitime
    if (php_sapi_name() === 'cli' && defined('PHP_BINARY') && @is_executable(PHP_BINARY)) {
        return PHP_BINARY;
    }
    return 'php';
}

// Whitelist stricte des scripts autorisés
$ALLOWED_SCRIPTS = [
    'check_server'     => 'check_server.php',
    'race_test'        => 'race_test.php',
    'idempotence_test' => 'idempotence_test.php',
    'load_test'        => 'load_test.php',
    'chaos_test'       => 'chaos_test.php',
];

function jsonResponse(array $data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['ok' => false, 'error' => 'POST attendu'], 405);
}

$scriptKey = $_POST['script'] ?? '';
if (!isset($ALLOWED_SCRIPTS[$scriptKey])) {
    jsonResponse(['ok' => false, 'error' => "Script non autorisé : $scriptKey"], 400);
}

$scriptFile = __DIR__ . DIRECTORY_SEPARATOR . $ALLOWED_SCRIPTS[$scriptKey];
if (!file_exists($scriptFile)) {
    jsonResponse(['ok' => false, 'error' => "Fichier introuvable : $scriptFile"], 500);
}

// Construire les arguments — uniquement des options déjà connues, valeurs assainies
$baseUrl = $_POST['base-url'] ?? 'http://localhost/qwest';
$playCode = strtoupper(trim($_POST['play-code'] ?? ''));
$players = (int) ($_POST['players'] ?? 20);
$duration = (int) ($_POST['duration'] ?? 60);
$scenario = $_POST['scenario'] ?? 'stable';
$autoStart = (int) ($_POST['auto-start'] ?? 0);
$questionTime = (int) ($_POST['question-time'] ?? 30);

// Bornage défensif
$players = max(1, min(50, $players));
$duration = max(10, min(600, $duration));
$questionTime = max(5, min(300, $questionTime));
$allowedScenarios = ['stable', 'slow', 'oscillating', 'last-second', 'interrupt', 'fast'];
if (!in_array($scenario, $allowedScenarios, true)) $scenario = 'stable';

// Validation stricte de baseUrl pour éviter une injection shell.
// escapeshellarg ne suffit PAS si l'URL contient des caractères qui peuvent être
// interprétés par un shell ou par curl (ex: $(...), backtick, pipe, redirection).
// On combine filter_var + rejet explicite des caractères dangereux.
$dangerous = ['$', '`', '|', ';', '&', '\\', "\n", "\r", '"', "'", '<', '>'];
foreach ($dangerous as $c) {
    if (strpos($baseUrl, $c) !== false) {
        jsonResponse(['ok' => false, 'error' => 'base-url contient un caractère interdit'], 400);
    }
}
if (filter_var($baseUrl, FILTER_VALIDATE_URL) === false) {
    jsonResponse(['ok' => false, 'error' => 'base-url invalide (URL non conforme)'], 400);
}
$scheme = parse_url($baseUrl, PHP_URL_SCHEME);
if ($scheme !== 'http' && $scheme !== 'https') {
    jsonResponse(['ok' => false, 'error' => 'base-url doit être http:// ou https://'], 400);
}
if ($playCode !== '' && !preg_match('/^[A-Z0-9]{3,12}$/', $playCode)) {
    jsonResponse(['ok' => false, 'error' => 'play-code invalide (A-Z 0-9, 3-12 car.)'], 400);
}

// Construire les arguments selon le script
$args = ['--base-url=' . $baseUrl];
switch ($scriptKey) {
    case 'check_server':
        if ($playCode !== '') $args[] = '--play-code=' . $playCode;
        break;
    case 'race_test':
        if ($playCode === '') jsonResponse(['ok' => false, 'error' => 'play-code requis'], 400);
        $args[] = '--play-code=' . $playCode;
        $args[] = '--players=' . $players;
        $args[] = '--auto-start=' . $autoStart;
        $args[] = '--question-time=' . $questionTime;
        break;
    case 'idempotence_test':
        if ($playCode === '') jsonResponse(['ok' => false, 'error' => 'play-code requis'], 400);
        $args[] = '--play-code=' . $playCode;
        break;
    case 'load_test':
        if ($playCode === '') jsonResponse(['ok' => false, 'error' => 'play-code requis'], 400);
        $args[] = '--play-code=' . $playCode;
        $args[] = '--players=' . $players;
        $args[] = '--duration=' . $duration;
        $args[] = '--scenario=' . $scenario;
        break;
    case 'chaos_test':
        // Autonome : crée et nettoie SES PROPRES sessions — pas de play-code requis.
        $chaosQuestions = max(2, min(8, (int) ($_POST['questions'] ?? 4)));
        $chaosOutage = max(20, min(120, (int) ($_POST['outage'] ?? 45)));
        $chaosClasses = max(1, min(3, (int) ($_POST['classes'] ?? 1)));
        $args[] = '--classes=' . $chaosClasses;
        $args[] = '--players=' . $players;
        $args[] = '--questions=' . $chaosQuestions;
        $args[] = '--question-time=' . max(8, $questionTime);
        $args[] = '--outage=' . $chaosOutage;
        break;
}

$phpBin = resolvePhpBin();
$cmdParts = [escapeshellarg($phpBin), escapeshellarg($scriptFile)];
foreach ($args as $a) $cmdParts[] = escapeshellarg($a);
$cmd = implode(' ', $cmdParts) . ' 2>&1';

$timestamp = date('Y-m-d_His');
$logName = $timestamp . '_' . $scriptKey . '.log';
$logPath = $LOG_DIR . DIRECTORY_SEPARATOR . $logName;

$header = "===========================================\n"
        . "Qwest — runner de test\n"
        . "Date    : " . date('Y-m-d H:i:s') . "\n"
        . "Script  : $scriptKey ({$ALLOWED_SCRIPTS[$scriptKey]})\n"
        . "Args    : " . implode(' ', $args) . "\n"
        . "Command : $cmd\n"
        . "===========================================\n\n";

$start = microtime(true);
$output = shell_exec($cmd);
$duration_ms = round((microtime(true) - $start) * 1000);

if ($output === null) $output = '(aucune sortie capturée — voir error_log Apache)';

$footer = "\n\n===========================================\n"
        . "Exécuté en " . $duration_ms . " ms\n"
        . "===========================================\n";

$fullLog = $header . $output . $footer;
file_put_contents($logPath, $fullLog);

// URL relative pour téléchargement (le runner.html est dans le même dossier)
$logUrl = 'logs/' . rawurlencode($logName);

jsonResponse([
    'ok' => true,
    'script' => $scriptKey,
    'logName' => $logName,
    'logUrl' => $logUrl,
    'durationMs' => $duration_ms,
    'output' => $fullLog,
]);
