<?php
/**
 * Qwest — Page de tests serveur (prof)
 *
 * Placée à la RACINE (comme dashboard.php) car le dossier scripts/ est restreint au
 * réseau local par son .htaccess : cette page est le SEUL moyen de lancer les tests
 * et de lire leurs logs depuis l'extérieur (OVH mutualisé, sans SSH).
 *
 * - Auth : mot de passe prof (le même que l'appli), vérifié en SHA-256 côté serveur
 *   (hash_equals) — même niveau de protection que control.php / dashboard.php.
 * - Lance scripts/chaos_test.php par INCLUSION (pas de shell_exec : indisponible ou
 *   bridé sur certains mutualisés). Le test vise l'URL publique de CE site.
 * - Liste et affiche les logs TSV de scripts/logs/.
 */

set_time_limit(900);
@ini_set('max_execution_time', '900');
@ini_set('display_errors', '0');

// Ménage (serveur propre) : logs de test de plus de 7 jours supprimés à chaque visite.
foreach ((glob(__DIR__ . '/scripts/logs/*.log') ?: []) as $oldLog) {
    $mt = @filemtime($oldLog);
    if ($mt && (time() - $mt) > 7 * 86400) @unlink($oldLog);
}

// Hash prof lu dans control.php (source de vérité unique, comme dashboard.php)
function loadTeacherHash() {
    $f = __DIR__ . '/php/control.php';
    $content = @file_get_contents($f);
    if ($content && preg_match("/define\\('TEACHER_HASH',\\s*'([a-f0-9]{64})'\\)/", $content, $m)) {
        return $m[1];
    }
    return hash('sha256', 'prof123'); // repli
}
define('QWEST_TEACHER_HASH', loadTeacherHash());

function authedHash() {
    $h = $_POST['teacher_hash'] ?? '';
    if (is_string($h) && $h !== '' && hash_equals(QWEST_TEACHER_HASH, $h)) return $h;
    $p = $_POST['teacher_password'] ?? '';
    if (is_string($p) && $p !== '') {
        $computed = hash('sha256', $p);
        if (hash_equals(QWEST_TEACHER_HASH, $computed)) return $computed;
    }
    return null;
}

// URL publique de l'appli, déduite de la requête courante (pas de saisie → pas d'injection)
function selfBaseUrl() {
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
             || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $dir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    return ($https ? 'https' : 'http') . '://' . $host . $dir;
}

$action = $_POST['action'] ?? '';
$hash = authedHash();
$authError = ($action !== '' && $hash === null);

header('Content-Type: text/html; charset=utf-8');
?><!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Qwest — Tests serveur</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 980px; margin: 24px auto; padding: 0 16px; color: #222; background: #f7f8fa; }
  h1 { font-size: 22px; } h2 { font-size: 17px; margin-top: 28px; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 16px 18px; margin: 14px 0; box-shadow: 0 1px 4px rgba(0,0,0,.04); }
  input[type=password] { padding: 8px 10px; border: 1px solid #c9ced6; border-radius: 6px; font-size: 15px; }
  button { padding: 9px 16px; border: 0; border-radius: 7px; font-size: 15px; cursor: pointer; background: #4459d8; color: #fff; margin: 4px 6px 4px 0; }
  button.secondary { background: #6c7480; }
  pre { background: #101418; color: #d7e0ea; padding: 14px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.45; white-space: pre-wrap; }
  .warn { background: #fff6e5; border-left: 4px solid #ff9800; padding: 10px 14px; border-radius: 6px; }
  .err  { background: #ffe9e9; border-left: 4px solid #e53935; padding: 10px 14px; border-radius: 6px; }
  .loglist form { display: inline; }
  .loglist button { background: #eef1f6; color: #2b3440; border: 1px solid #d4dae3; font-size: 13px; padding: 6px 10px; }
  small { color: #667; }
</style>
</head>
<body>
<h1>🧪 Qwest — Tests serveur</h1>

<?php if ($authError): ?>
  <div class="err">❌ Mot de passe incorrect.</div>
<?php endif; ?>

<?php if ($hash === null): ?>
  <div class="card">
    <p>Entre le <b>mot de passe professeur</b> (le même que dans l'application) :</p>
    <form method="post">
      <input type="password" name="teacher_password" autofocus>
      <button type="submit">Entrer</button>
    </form>
  </div>
<?php else: ?>

  <?php if ($action === 'run'): ?>
    <div class="card">
      <h2>Résultat du test</h2>
      <pre><?php
        // Profils : rapide (~1 min 30), complet (~3 min) ou 3 classes simultanées (~3 min)
        $modes = [
            'quick'  => ['label' => 'rapide (~1 min 30)',
                         'args' => ['--players=10', '--questions=3', '--question-time=10', '--outage=25']],
            'full'   => ['label' => 'complet (~3 min)',
                         'args' => ['--players=12', '--questions=5', '--question-time=12', '--outage=60']],
            'triple' => ['label' => '3 classes simultanées (~3-4 min)',
                         'args' => ['--classes=3', '--players=8', '--players-side=6', '--questions=4', '--question-time=12', '--outage=30']],
        ];
        $mode = $_POST['mode'] ?? 'quick';
        if (!isset($modes[$mode])) $mode = 'quick';
        $base = selfBaseUrl();
        $GLOBALS['QWEST_TEST_ARGS'] = array_merge(["--base-url=$base"], $modes[$mode]['args']);
        define('QWEST_TESTS_WEB', true);
        while (ob_get_level()) { @ob_end_flush(); }
        @ob_implicit_flush(true);
        echo "Cible : $base\nMode : " . $modes[$mode]['label'] . "\n";
        echo "Patiente jusqu'au BILAN final, ne ferme pas la page...\n\n";
        @flush();
        include __DIR__ . '/scripts/chaos_test.php';
      ?></pre>
      <p><b>Lecture :</b> tout doit être ✅. Un ❌ = problème réel à signaler (le détail est dans le log ci-dessous).</p>
    </div>
  <?php endif; ?>

  <?php if ($action === 'log'):
      $name = $_POST['file'] ?? '';
      $safe = preg_match('/^[A-Za-z0-9_\-]+\.log$/', $name);
      $path = __DIR__ . '/scripts/logs/' . $name;
      if ($safe && is_file($path)): ?>
    <div class="card">
      <h2>📄 <?php echo htmlspecialchars($name); ?></h2>
      <pre><?php echo htmlspecialchars((string)@file_get_contents($path)); ?></pre>
    </div>
  <?php else: ?>
    <div class="err">Log introuvable.</div>
  <?php endif; endif; ?>

  <div class="card">
    <h2>▶️ Lancer un test</h2>
    <div class="warn">⚠️ Le test génère en 2-3 minutes l'équivalent du trafic d'une vraie séance
    (c'est voulu : il simule la classe entière, voire 3 classes). À lancer <b>hors heures de
    cours</b>, jamais pendant qu'une classe joue.</div>
    <p>Le test simule une classe de collège complète : double connexion, vol de pseudo, élève très lent,
       coupure réseau, triche, réponse dernière seconde… puis vérifie la synchro d'affichage et le score
       de chaque élève au point près. <b>Laisse la page ouverte jusqu'au BILAN.</b></p>
    <form method="post">
      <input type="hidden" name="teacher_hash" value="<?php echo htmlspecialchars($hash); ?>">
      <input type="hidden" name="action" value="run">
      <button name="mode" value="quick" type="submit">🚀 Test rapide (~1 min 30)</button>
      <button name="mode" value="full" type="submit" class="secondary">🔬 Test complet (~3 min)</button>
      <button name="mode" value="triple" type="submit" class="secondary">🏫 Test 3 classes simultanées (~3 min)</button>
    </form>
  </div>

  <div class="card loglist">
    <h2>📁 Logs des tests</h2>
    <?php
      $logs = glob(__DIR__ . '/scripts/logs/*.log') ?: [];
      usort($logs, function($a, $b) { return filemtime($b) - filemtime($a); });
      if (!$logs) echo '<p><small>Aucun log pour le moment — lance un test ci-dessus.</small></p>';
      foreach (array_slice($logs, 0, 15) as $f) {
          $n = basename($f);
          echo '<form method="post">'
             . '<input type="hidden" name="teacher_hash" value="' . htmlspecialchars($hash) . '">'
             . '<input type="hidden" name="action" value="log">'
             . '<input type="hidden" name="file" value="' . htmlspecialchars($n) . '">'
             . '<button type="submit">' . htmlspecialchars($n) . '</button> '
             . '</form> ';
      }
    ?>
    <p><small>Les fichiers sont sur le serveur dans <code>qwest/scripts/logs/</code> (aussi récupérables par FTP).</small></p>
  </div>

<?php endif; ?>
</body>
</html>
