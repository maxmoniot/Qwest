# ============================================================
# Qwest — Banc d'essai « CLASSE RÉELLE » (temps réel, mauvaise connexion, NAT)
# ============================================================
# Enchaîne plusieurs scénarios de partie COMPLÈTE contre une cible (prod par défaut),
# en réutilisant le moteur chaos_test.php (élèves virtuels en parallèle = curl_multi,
# résilience identique au vrai client). Toutes les requêtes sortent par UNE SEULE IP
# (cette machine) → reproduit le NAT/IP partagée d'une classe de collège.
#
# Ce qui est reproduit fidèlement : IP de sortie partagée frappant le VRAI OVH, perte
# de paquets (--drop), latence/saturation de liaison (--latency), coupures (--outage),
# en VITESSE RÉELLE (questions de 20-22 s, jusqu'à 8 questions).
# Ce qui N'EST PAS reproductible d'ici : le filtrage d'URL spécifique du collège (proxy
# entre l'établissement et internet) → seul netcheck.html, lancé AU collège, le mesure.
#
# Usage :
#   powershell -ExecutionPolicy Bypass -File scripts\run_classroom_real.ps1
#   powershell ... -File scripts\run_classroom_real.ps1 -Base https://www.lejardindesoiseaux.com/qwest2
#
# Chaque scénario écrit son log TSV détaillé dans scripts/logs/chaos-*.log.
param(
  [string]$Base = 'https://www.lejardindesoiseaux.com/qwest2'
)
$php = 'C:\xampp\php\php.exe'
$script = Join-Path $PSScriptRoot 'chaos_test.php'

$scenarios = @(
  @{ name = 'S1 — baseline 1 classe (réseau correct)';
     args = @('--classes=1','--players=20','--questions=8','--question-time=20','--drop=5','--latency=200','--outage=45') },
  @{ name = 'S2 — 1 classe, TRÈS mauvaise connexion (mesure NET-IP)';
     args = @('--classes=1','--players=22','--questions=8','--question-time=22','--drop=25','--latency=1000','--outage=60') },
  @{ name = 'S3 — 2 classes simultanées, mauvaise connexion';
     args = @('--classes=2','--players=18','--players-side=14','--questions=6','--question-time=20','--drop=15','--latency=600','--outage=45') },
  @{ name = 'S4 — 3 classes simultanées, stress max';
     args = @('--classes=3','--players=16','--players-side=12','--questions=6','--question-time=20','--drop=20','--latency=700','--outage=45') }
)

Write-Host "Cible : $Base"
foreach ($s in $scenarios) {
  Write-Host "`n=================================================="
  Write-Host "  $($s.name)"
  Write-Host "==================================================`n"
  & $php $script "--base-url=$Base" @($s.args)
  Write-Host "`n--- pause 30 s (relâcher un éventuel throttle/ban d'IP entre scénarios) ---"
  Start-Sleep -Seconds 30
}
Write-Host "`nTerminé. Logs détaillés dans scripts/logs/chaos-*.log"
