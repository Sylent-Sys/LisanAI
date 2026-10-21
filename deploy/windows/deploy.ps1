<#
.SYNOPSIS
  Deploy LisanAI (frontend + API in one Node process) to a Windows Server.

.DESCRIPTION
  Run on the server from the extracted release package, in an elevated
  Windows PowerShell 5.1+ session:

    powershell -ExecutionPolicy Bypass -File .\deploy\windows\deploy.ps1 -AllowFrom "<CIDR>"

  Layout under -InstallDir:
    releases\<timestamp>\   one folder per deploy (last 3 kept)
    current                 junction to the active release
    shared\.env             config + secrets, created on first run (never in a release)
    shared\data\            SQLite database, survives redeploys
    shared\backups\         database copy taken before every deploy
    logs\app.log            Node stdout/stderr
    start.cmd               supervisor loop run by the scheduled task

  The app runs as NT AUTHORITY\NETWORK SERVICE via a scheduled task that starts
  at boot. A failed health check rolls back to the previous release.
#>
param(
  [string]$InstallDir = "C:\apps\LisanAI",
  [int]$Port = 4173,
  # Inbound firewall scope, e.g. "10.0.0.0/8,172.16.0.0/12". Empty = no rule.
  [string]$AllowFrom = "",
  [string]$TaskName = "LisanAI"
)

$ErrorActionPreference = "Stop"

$PackageRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$ReleasesDir = Join-Path $InstallDir "releases"
$SharedDir = Join-Path $InstallDir "shared"
$DataDir = Join-Path $SharedDir "data"
$BackupDir = Join-Path $SharedDir "backups"
$LogDir = Join-Path $InstallDir "logs"
$EnvFile = Join-Path $SharedDir ".env"
$CurrentLink = Join-Path $InstallDir "current"
$StartCmd = Join-Path $InstallDir "start.cmd"
$LogFile = Join-Path $LogDir "app.log"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ReleaseDir = Join-Path $ReleasesDir $Stamp

# Well-known SIDs avoid localized account names.
$SidNetworkService = "*S-1-5-20"
$SidAdministrators = "*S-1-5-32-544"
$SidSystem = "*S-1-5-18"

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Jalankan PowerShell sebagai Administrator."
  }
}

function Get-NodePath {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) {
    throw "Node.js belum terpasang. Pasang Node.js 22 LTS (Windows x64 .msi), buka PowerShell baru, lalu ulangi."
  }
  $major = [int]((& $node.Source -v).TrimStart("v").Split(".")[0])
  if ($major -lt 22) { throw "Butuh Node.js 22 atau lebih baru (terpasang: v$major)." }
  return $node.Source
}

function Invoke-Native($file, [string[]]$arguments) {
  & $file @arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$file $($arguments -join ' ') gagal (exit $LASTEXITCODE)." }
}

function Write-Utf8NoBom($path, $text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))
}

function Read-EnvFile($path) {
  $values = @{}
  foreach ($line in Get-Content $path) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $values[$Matches[1]] = $Matches[2].Trim() }
  }
  return $values
}

function Get-ExampleValue($name) {
  $example = Join-Path $PackageRoot ".env.example"
  if (-not (Test-Path $example)) { return "" }
  $line = Get-Content $example | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  if ($line) { return $line.Substring($name.Length + 1).Trim() }
  return ""
}

function New-Secret {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function New-EnvFile {
  $dbPath = (Join-Path $DataDir "lisan_ai.db") -replace "\\", "/"
  $lines = @(
    "# LisanAI server config. Berisi secret: jangan di-commit atau dibagikan.",
    "NODE_ENV=production",
    "HOST=0.0.0.0",
    "PORT=$Port",
    "TURSO_DATABASE_URL=file:$dbPath",
    "TURSO_AUTH_TOKEN=",
    "CSRF_SECRET=$(New-Secret)",
    "HARNESS_PROVIDER=openrouter",
    "MAX_EVALUATION_RETRIES=1",
    "ENABLE_DEMO_SIMULATION=false",
    "# Isi dengan API key OpenRouter milik project.",
    "OPENROUTER_API_KEY=",
    "OPENROUTER_MODEL=$(Get-ExampleValue 'OPENROUTER_MODEL')",
    "OPENROUTER_FALLBACK_MODEL=$(Get-ExampleValue 'OPENROUTER_FALLBACK_MODEL')"
  )
  Write-Utf8NoBom $EnvFile (($lines -join "`n") + "`n")
  Invoke-Native "icacls.exe" @($EnvFile, "/inheritance:r", "/grant:r", "${SidAdministrators}:(F)", "${SidSystem}:(F)", "${SidNetworkService}:(R)")
}

function Stop-App {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName
  }
  # Stop the supervisor loop first so it cannot respawn node, then node itself.
  $pattern = [regex]::Escape($InstallDir)
  foreach ($name in @("cmd.exe", "node.exe")) {
    Get-CimInstance Win32_Process -Filter "Name='$name'" |
      Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
  }
}

function Set-CurrentRelease($target) {
  # rmdir removes only the junction; Remove-Item -Recurse in PS 5.1 would
  # delete the release it points to.
  if (Test-Path $CurrentLink) { cmd.exe /c rmdir "$CurrentLink" | Out-Null }
  cmd.exe /c mklink /J "$CurrentLink" "$target" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Gagal membuat junction $CurrentLink -> $target." }
}

function Test-AppHealthy($port) {
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/auth?action=me" -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}

Assert-Admin
$NodePath = Get-NodePath
Write-Step "Node.js: $NodePath ($(& $NodePath -v))"

Write-Step "Menyiapkan folder di $InstallDir"
foreach ($dir in @($ReleasesDir, $DataDir, $BackupDir, $LogDir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}
Invoke-Native "icacls.exe" @($InstallDir, "/grant", "${SidNetworkService}:(OI)(CI)RX")
Invoke-Native "icacls.exe" @($DataDir, "/grant", "${SidNetworkService}:(OI)(CI)M")
Invoke-Native "icacls.exe" @($LogDir, "/grant", "${SidNetworkService}:(OI)(CI)M")

if (-not (Test-Path $EnvFile)) {
  Write-Step "Membuat $EnvFile (CSRF_SECRET dibuat acak)"
  New-EnvFile
}
$EnvValues = Read-EnvFile $EnvFile
$apiKey = [string]$EnvValues["OPENROUTER_API_KEY"]
if ($EnvValues["HARNESS_PROVIDER"] -ne "mock" -and ($apiKey -eq "" -or $apiKey -like "sk-or-your-*")) {
  Write-Host ""
  Write-Host "OPENROUTER_API_KEY di $EnvFile masih kosong." -ForegroundColor Yellow
  Write-Host "Isi nilainya (notepad `"$EnvFile`"), lalu jalankan skrip ini lagi." -ForegroundColor Yellow
  exit 2
}
$AppPort = if ($EnvValues["PORT"]) { [int]$EnvValues["PORT"] } else { $Port }

Write-Step "Menyalin release ke $ReleaseDir"
robocopy.exe $PackageRoot $ReleaseDir /E /XD (Join-Path $PackageRoot ".git") /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy gagal (exit $LASTEXITCODE)." }

if (-not (Test-Path (Join-Path $ReleaseDir "node_modules"))) {
  Write-Step "Paket tanpa node_modules: npm ci --omit=dev"
  $npm = Join-Path (Split-Path $NodePath) "npm.cmd"
  Push-Location $ReleaseDir
  try { Invoke-Native $npm @("ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund") } finally { Pop-Location }
}

$Previous = $null
if (Test-Path $CurrentLink) { $Previous = [string]((Get-Item $CurrentLink).Target | Select-Object -First 1) }

Write-Step "Menghentikan aplikasi lama"
Stop-App

$dbFiles = Get-ChildItem $DataDir -Filter "lisan_ai.db*" -File -ErrorAction SilentlyContinue
if ($dbFiles) {
  Write-Step "Backup database ke $BackupDir"
  foreach ($file in $dbFiles) { Copy-Item $file.FullName (Join-Path $BackupDir "$Stamp-$($file.Name)") }
}

if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 20MB) {
  Move-Item $LogFile (Join-Path $LogDir "app-$Stamp.log")
}

Write-Step "Mengaktifkan release $Stamp"
Set-CurrentRelease $ReleaseDir

$entry = Join-Path $CurrentLink "local-server.js"
$startScript = @(
  "@echo off",
  "rem Generated by deploy.ps1. Restarts LisanAI if the Node process exits.",
  "cd /d `"$CurrentLink`"",
  ":loop",
  "`"$NodePath`" --env-file=`"$EnvFile`" `"$entry`" >> `"$LogFile`" 2>&1",
  "echo [%date% %time%] node exited with code %errorlevel%, restarting in 5s >> `"$LogFile`"",
  "ping -n 6 127.0.0.1 >nul",
  "goto loop"
)
[System.IO.File]::WriteAllText($StartCmd, ($startScript -join "`r`n") + "`r`n", [System.Text.Encoding]::ASCII)

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$StartCmd`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\NETWORK SERVICE" -LogonType ServiceAccount
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Step "Menjalankan aplikasi (task '$TaskName')"
Start-ScheduledTask -TaskName $TaskName

if (-not (Test-AppHealthy $AppPort)) {
  Write-Host "Health check gagal. Log terakhir:" -ForegroundColor Red
  if (Test-Path $LogFile) { Get-Content $LogFile -Tail 30 | Out-Host }
  if ($Previous -and (Test-Path $Previous)) {
    Write-Host "Rollback ke $Previous" -ForegroundColor Yellow
    Stop-App
    Set-CurrentRelease $Previous
    Start-ScheduledTask -TaskName $TaskName
  }
  exit 1
}

if ($AllowFrom) {
  $ruleName = "LisanAI TCP $AppPort"
  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $AppPort -RemoteAddress ($AllowFrom -split "," | ForEach-Object { $_.Trim() }) -Action Allow | Out-Null
  Write-Step "Firewall: TCP $AppPort dibuka untuk $AllowFrom"
} else {
  Write-Host "Tidak ada rule firewall dibuat (-AllowFrom kosong); aplikasi hanya bisa diakses dari server ini." -ForegroundColor Yellow
}

Get-ChildItem $ReleasesDir -Directory | Sort-Object Name -Descending | Select-Object -Skip 3 |
  Where-Object { $_.FullName -ne $ReleaseDir -and $_.FullName -ne $Previous } |
  ForEach-Object {
    $oldRelease = $_.FullName
    try { Remove-Item $oldRelease -Recurse -Force } catch { Write-Host "Gagal menghapus release lama ${oldRelease}: $_" -ForegroundColor Yellow }
  }

Write-Host ""
Write-Host "Deploy selesai: release $Stamp aktif di port $AppPort." -ForegroundColor Green
Write-Host "Log: $LogFile"
